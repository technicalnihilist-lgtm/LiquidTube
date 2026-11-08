#!/usr/bin/env node
/*
 * LiquidTube channel-map check — item 4.6 ("drop cached channel objects for
 * channels no longer shown").
 *
 * `CH` is the id → channel map: title, handle, counts, description, banner,
 * trailer and uploads playlist per channel. Nothing ever took an entry out, so a
 * session that looked at a few hundred channels kept every one of those objects
 * until the WebView was destroyed. The build under test keeps CHQ (the same ids
 * in recency order) and trims the least-recently-used entries past CH_HI back to
 * CH_MAX, never dropping a channel something live still points at, and keeping
 * the newest CH_GUARD entries untouched so a batch that has just landed is
 * always readable by the caller that asked for it.
 *
 * This tool drives the real UI on a real browser with the API mocked and reports,
 * per build:
 *
 *   boot        channels resolved and pinned once the first paint has settled
 *   searches    how many searches ran, each answering 20 videos from 20 distinct
 *               channels, so the session really does visit hundreds of channels
 *   after       map size after them: must stay at or below CH_HI
 *   evicted     entries dropped, and how many trims did it
 *   pinned      the channels a live list still points at — feed, sections,
 *               shelves, library, cards on screen, the selected subs channel —
 *               and whether every one of them still resolves (a pin that does
 *               not resolve is a blank avatar or a "Channel" label)
 *   subs        the subs row after the session: the same number of avatar images
 *               as before it, and the selected chip still names its channel
 *   faces       every card still shows a channel avatar, feed and results alike,
 *               including cards whose channel object was evicted (the avatar is
 *               kept, the object is not)
 *   sheet       a feed video's channel sheet and a session video's channel sheet
 *               both still resolve — the full object is refetched when dropped
 *   heapKB      JS heap after a forced GC, so two builds can be compared
 *
 * Usage:
 *   npm i puppeteer-core                    # dev only, not shipped in the APK
 *   CHROME=/path/to/chrome node tools/chmap-bound-check.js <build-a.html> [build-b.html]
 * SEARCHES=60 (default) sets the session length.
 * Exit code 1 when the build under test — the first file — fails any check.
 */
const path = require('path');
const puppeteer = require('puppeteer-core');

const ORIGIN = 'liquidtube.local';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64'
);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SEARCHES = +process.env.SEARCHES || 60;
const PER = 20; // results per search, as maxResults asks for
const pad = n => String(n).padStart(2, '0');
const vids = Array.from({ length: 24 }, (_, i) => 'v' + pad(i + 1) + 'AAAAAAAA');
const CH = Array.from({ length: 6 }, (_, i) => 'UC' + i + 'xxxxxxxxxxxxxxxxxxxx');
const ago = h => new Date(Date.now() - h * 36e5).toISOString();

/* One search's worth of results, stable per query: the same q always answers with
   the same ids, the way the API does. Every result of query n carries a channel
   no other query uses, so n searches resolve 20n channels and nothing else. */
const seenQ = new Map();
const chOf = (n, i) => 'UCq' + pad(n) + 'c' + pad(i) + 'xxxxxxxx';
function searchFor(q) {
  if (!seenQ.has(q)) seenQ.set(q, seenQ.size);
  const n = seenQ.get(q);
  return {
    items: Array.from({ length: PER }, (_, i) => {
      const id = 'q' + pad(n) + 'v' + pad(i);
      return {
        id: { videoId: id },
        snippet: {
          title: 'Result ' + n + ' ' + i,
          channelTitle: 'Channel ' + n + '-' + i,
          channelId: chOf(n, i),
          publishedAt: ago(i + 1),
          thumbnails: { maxres: { url: 'https://i.ytimg.com/vi/' + id + '/maxresdefault.jpg' } },
        },
      };
    }),
  };
}
function durationsFor(u) {
  const ids = String(u.searchParams.get('id') || '').split(',').filter(Boolean);
  return { items: ids.map(id => ({ id, contentDetails: { duration: 'PT12M30S' } })) };
}
const TRENDING = {
  items: vids.map((id, i) => ({
    id,
    snippet: {
      title: 'Video ' + i,
      channelTitle: 'Channel ' + (i % 6),
      channelId: CH[i % 6],
      publishedAt: ago(i + 1),
      categoryId: ['10', '20', '17', '24', '23', '27'][i % 6],
      thumbnails: { maxres: { url: 'https://i.ytimg.com/vi/' + id + '/maxresdefault.jpg' } },
    },
    statistics: { viewCount: '1000' },
  })),
};
const PLAYLIST = {
  items: vids.slice(0, 12).map((id, i) => ({
    snippet: { title: 'P' + i, resourceId: { videoId: id }, publishedAt: ago(i * 24) },
    contentDetails: { videoPublishedAt: ago(i * 24) },
  })),
};
function chanAnswer(u) {
  const want = String(u.searchParams.get('id') || '').split(',').filter(Boolean);
  return {
    items: want.map(id => ({
      id,
      snippet: {
        title: 'Channel ' + id.slice(2, 10),
        customUrl: 'c' + id.slice(2, 10),
        publishedAt: '2015-04-02T10:00:00Z',
        country: 'IN',
        thumbnails: { medium: { url: 'https://yt3.ggpht.com/' + id + '.jpg' } },
      },
      statistics: { subscriberCount: '1000', videoCount: '10', viewCount: '10000' },
      contentDetails: { relatedPlaylists: { uploads: 'UU' + id.slice(2) } },
      brandingSettings: { image: {}, channel: {} },
    })),
  };
}
function apiBody(url) {
  const u = new URL(url);
  const p = u.pathname;
  if (p.endsWith('/videos'))
    return (u.searchParams.get('part') || '').includes('contentDetails') ? durationsFor(u) : TRENDING;
  if (p.endsWith('/channels')) return chanAnswer(u);
  if (p.endsWith('/playlistItems')) return PLAYLIST;
  if (p.endsWith('/search')) return searchFor(u.searchParams.get('q') || '');
  return {};
}

async function boot(browser, file) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e.message || e)));
  page.on('console', m => {
    if (m.type() === 'error' && !/ytimg|ggpht|net::ERR/.test(m.text())) errors.push(m.text());
  });
  await page.setRequestInterception(true);
  page.on('request', req => {
    const u = req.url();
    if (u.startsWith('https://' + ORIGIN + '/index.html') || u === 'https://' + ORIGIN + '/') {
      const body = require('fs').readFileSync(file);
      return req.respond({ status: 200, contentType: 'text/html', body });
    }
    if (/googleapis\.com\/(youtube\/v3|youtubei)/.test(u)) {
      return req.respond({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify(apiBody(u)),
      });
    }
    if (/ytimg\.com|ggpht\.com|googleusercontent\.com/.test(u))
      return req.respond({ status: 200, contentType: 'image/png', body: PNG });
    return req.abort();
  });
  await page.goto('https://' + ORIGIN + '/index.html', { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction('document.querySelectorAll("#feed .card").length > 0', { timeout: 60000 });
  await sleep(800);
  await page.evaluate(() => {
    const st = document.createElement('style');
    st.textContent = '*{backdrop-filter:none!important;filter:none!important;box-shadow:none!important}';
    document.head.appendChild(st);
  });
  return { page, errors };
}

const cdp = async page => await page.target().createCDPSession();
async function heapKB(page) {
  const s = await cdp(page);
  try {
    await s.send('HeapProfiler.collectGarbage');
  } catch (e) {}
  const m = await page.metrics();
  await s.detach();
  return Math.round((m.JSHeapUsedSize || 0) / 1024);
}

async function run(browser, file) {
  const { page, errors } = await boot(browser, file);
  const out = { file: path.basename(file) };
  const ev = (fn, ...a) => page.evaluate(fn, ...a);
  const cq = async () => await ev(() => {
    if (!window.__ltChanQueue) return null;
    const q = window.__ltChanQueue();
    return { batch: q.batch, ids: q.ids, join: q.join, err: q.err, queued: q.queued, sent: q.sent,
      cached: q.cached === undefined ? null : q.cached, max: q.max, hi: q.hi,
      trims: q.trims, evicted: q.evicted, pinned: q.pinned || [] };
  });
  const hasOf = async ids => await ev(q => {
    const f = window.__ltChanQueue;
    if (!f || typeof f().has !== 'function') return null;
    return f().has(q);
  }, ids);

  const boot0 = await cq();
  out.boot = boot0 ? { cached: boot0.cached, pinned: boot0.pinned.length } : { cached: null, pinned: null };
  if (boot0 && boot0.cached === null) out.legacy = true;   /* a build before item 4.6 */
  /* The subs row as it paints on boot: the avatars it shows and the chip names. */
  const subsBefore = await ev(() => ({
    chips: [...document.querySelectorAll('#sg button')].map(b => b.textContent.trim()),
    faces: document.querySelectorAll('#sg button img').length,
  }));

  /* The session: distinct searches, 20 new channels each. */
  for (let i = 0; i < SEARCHES; i++) {
    await ev(q2 => {
      const el = document.getElementById('q');
      el.value = q2;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, 'session query ' + i);
    await page.waitForFunction(
      n => document.querySelectorAll('#results .card').length >= n,
      { timeout: 30000 },
      PER
    );
  }
  out.searches = { count: SEARCHES, channels: SEARCHES * PER };

  const after = await cq();
  out.after = after ? { cached: after.cached, max: after.max, hi: after.hi } : { cached: null };
  out.evicted = after ? { trims: after.trims, evicted: after.evicted } : null;
  const pinned = after ? after.pinned : [];
  const pinnedHas = after ? (await hasOf(pinned)) || [] : [];
  out.pinned = {
    count: pinned.length,
    resolved: pinnedHas.filter(Boolean).length,
    asked: pinnedHas.length,
  };

  /* The subs row and the feed after the session: same chips, same faces. */
  const subsAfter = await ev(() => ({
    chips: [...document.querySelectorAll('#sg button')].map(b => b.textContent.trim()),
    faces: document.querySelectorAll('#sg button img').length,
  }));
  out.subs = {
    chips: subsAfter.chips.length === subsBefore.chips.length,
    faces: subsAfter.faces === subsBefore.faces,
    before: subsBefore.faces,
    after: subsAfter.faces,
  };
  /* Selecting a chip still names its channel, and the list behind it still draws. */
  out.select = await ev(() => {
    const b = document.querySelector('#sg button');
    if (!b) return { title: null, cards: 0 };
    b.click();
    return { title: document.getElementById('subh').textContent, cards: document.querySelectorAll('#subfeed .card').length };
  });
  await sleep(300);

  /* Every card still shows a channel face — feed cards and the search results on
     screen — even though most of the session's channel objects have been dropped:
     the avatar is what the card needs, and the avatar is kept. */
  out.faces = await ev(() => {
    const count = sel => document.querySelectorAll(sel).length;
    return {
      feedCards: count('#feed .card'),
      feedFaces: count('#feed .card .meta img.av'),
      resultCards: count('#results .card'),
      resultFaces: count('#results .card .meta img.av'),
    };
  });

  /* A feed video opens, and its channel sheet still resolves — the sheet asks for
     the full object, which is refetched when the map no longer holds it. */
  out.sheet = await ev(() => {
    const c = document.querySelector('#feed .card');
    if (!c) return { opened: false, face: false, title: '' };
    c.click();
    document.getElementById('plk').click();
    return { opened: document.getElementById('pl').classList.contains('on') };
  });
  await sleep(900);
  out.sheet = Object.assign(out.sheet || {}, await ev(() => ({
    face: !!document.querySelector('#shb .chh img'),
    title: (document.getElementById('sht') || {}).textContent || '',
    body: (document.getElementById('shb') || {}).innerHTML.length > 0,
  })));
  await ev(() => { document.getElementById('sheet').classList.remove('on'); document.getElementById('pclose').click(); });
  await sleep(400);

  /* The same for a video from the newest search: its channel was resolved during
     the session, and most of those objects are gone by now. */
  out.sheetNew = await ev(() => {
    const c = document.querySelector('#results .card');
    if (!c) return { opened: false };
    c.click();
    document.getElementById('plk').click();
    return { opened: document.getElementById('pl').classList.contains('on') };
  });
  await sleep(900);
  out.sheetNew = Object.assign(out.sheetNew || {}, await ev(() => ({
    face: !!document.querySelector('#shb .chh img'),
    title: (document.getElementById('sht') || {}).textContent || '',
    body: (document.getElementById('shb') || {}).innerHTML.length > 0,
  })));
  await ev(() => { document.getElementById('sheet').classList.remove('on'); document.getElementById('pclose').click(); });
  await sleep(400);

  out.heapKB = await heapKB(page);
  out.errors = errors.slice(0, 5);
  await page.close();
  return out;
}

function judge(r) {
  const bad = [];
  if (r.legacy) return ['build has no bounded channel map (pre-4.6)'];
  if (!(r.after && r.after.cached !== null)) bad.push('no channel map in the build');
  else if (r.after.cached > r.after.hi) bad.push('map ' + r.after.cached + ' over the high-water mark ' + r.after.hi);
  if (r.evicted && r.evicted.evicted === 0) bad.push('nothing was ever dropped: the map is still open');
  if (r.pinned && r.pinned.resolved !== r.pinned.asked) bad.push('a pinned channel does not resolve');
  if (r.subs && (!r.subs.chips || !r.subs.faces)) bad.push('the subs row changed after the session');
  if (r.select && !/Channel|Latest/.test(String(r.select.title))) bad.push('the selected chip lost its name');
  if (r.faces && r.faces.feedFaces !== r.faces.feedCards) bad.push('a feed card lost its channel face');
  if (r.faces && r.faces.resultFaces !== r.faces.resultCards) bad.push('a result card lost its channel face');
  if (r.sheet && (!r.sheet.body || !r.sheet.face)) bad.push('the channel sheet of a feed video did not resolve');
  if (r.sheetNew && (!r.sheetNew.body || !r.sheetNew.face)) bad.push('the channel sheet of a session video did not resolve');
  if (r.errors && r.errors.length) bad.push('page errors: ' + r.errors.join(' | '));
  return bad;
}

(async () => {
  const files = process.argv.slice(2).filter(Boolean);
  if (!files.length) {
    console.error('usage: node tools/chmap-bound-check.js <build.html> [build-b.html]');
    process.exit(2);
  }
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME || '/usr/local/bin/chromium',
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
  let failed = false;
  try {
    for (let i = 0; i < files.length; i++) {
      const r = await run(browser, files[i]);
      const bad = judge(r);
      if (i === 0 && bad.length) failed = true;
      console.log(JSON.stringify(Object.assign({ ok: !bad.length, fail: bad }, r), null, 2));
    }
  } finally {
    await browser.close();
  }
  process.exit(failed ? 1 : 0);
})();
