#!/usr/bin/env node
/*
 * LiquidTube video-registry check — item 4.2 ("bound the `V` video map so it
 * cannot grow without limit").
 *
 * `V` is the id → video map every list and the player read by id. It had no
 * ceiling: each search, shelf, home section and channel sheet added entries and
 * nothing removed one, so a session kept every video it had ever shown until the
 * WebView was destroyed. The build under test keeps VQ (the same ids in recency
 * order) and trims the least-recently-used entries past V_HI back down to V_MAX,
 * never dropping an id something live still points at.
 *
 * This tool drives the real UI on a real browser with the API mocked and reports,
 * per build:
 *
 *   boot        registry size and pinned count once the first paint has settled
 *   searches    how many distinct searches were run and how many ids they added
 *   after       registry size after them: must stay at or below V_HI
 *   evicted     entries dropped, and how many trims did it
 *   pinned      the ids a live list still points at — feed, sections, shelves,
 *               history and the cards on screen — and whether every one of them
 *               still resolves (a pin that does not resolve is a dead card)
 *   openNew     a card from the newest search still opens the player
 *   openFeed    a card in the feed still opens the player
 *   openHist    a video played before the searches, opened again from
 *               Library → History afterwards: the id had been pushed out of the
 *               registry long before, and the pin is what keeps it playable
 *   heapKB      JS heap after a forced GC, so two builds can be compared
 *
 * Usage:
 *   npm i puppeteer-core                    # dev only, not shipped in the APK
 *   CHROME=/path/to/chrome node tools/vmap-bound-check.js <build-a.html> [build-b.html]
 * SEARCHES=120 (default) sets the session length; 20 ids come back per search.
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
const SEARCHES = +process.env.SEARCHES || 120;
const PER = 20; // results per search, as maxResults asks for
const pad = n => String(n).padStart(2, '0');
const vids = Array.from({ length: 24 }, (_, i) => 'v' + pad(i + 1) + 'AAAAAAAA');
const CH = Array.from({ length: 6 }, (_, i) => 'UC' + i + 'xxxxxxxxxxxxxxxxxxxx');
const ago = h => new Date(Date.now() - h * 36e5).toISOString();

/* One search's worth of results, stable per query: the same q always answers with
   the same ids, the way the API does, so a repeated search cannot look like new
   work. */
const seenQ = new Map();
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
          channelTitle: 'Channel ' + (i % 6),
          channelId: CH[i % 6],
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
        title: 'Channel ' + id.slice(2, 8),
        customUrl: 'c' + id.slice(2, 8),
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
  /* Same paint neutralisation as the other tools: software rasterisation makes a
     blurred full-screen panel cost hundreds of ms a frame, and neither build's
     registry is affected by it. */
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
  const vm = async ids => await ev(q => (window.__ltVmap ? window.__ltVmap(q) : null), ids);

  const boot0 = await vm([]);
  out.boot = boot0 ? { size: boot0.size, pins: boot0.pins } : { size: null, pins: null };

  /* 1. Play a feed card, so its id is in the saved library before the session. */
  out.played = await ev(() => {
    const c = document.querySelector('#feed .card');
    if (!c) return null;
    c.click();
    return c.dataset.v;
  });
  await sleep(500);
  await ev(() => document.getElementById('pclose').click());
  await sleep(300);

  /* 2. The session: distinct searches, each answering 20 ids. */
  let added = 0;
  for (let i = 0; i < SEARCHES; i++) {
    const q = 'session query ' + i;
    added += PER;
    await ev(q2 => {
      const el = document.getElementById('q');
      el.value = q2;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, q);
    await page.waitForFunction(
      n => document.querySelectorAll('#results .card').length >= n,
      { timeout: 30000 },
      PER
    );
  }
  out.searches = { count: SEARCHES, added };
  const lastQ = 'session query ' + (SEARCHES - 1);
  const lastIds = await ev(() => [...document.querySelectorAll('#results .card')].map(c => c.dataset.v));
  const feedIds = await ev(() => [...document.querySelectorAll('#feed .card')].map(c => c.dataset.v));

  const after = await vm([...lastIds, ...feedIds, out.played]);
  out.after = after ? { size: after.size, max: after.max, hi: after.hi } : { size: null };
  out.evicted = after ? { trims: after.trims, evicted: after.evicted } : null;
  out.pinned = after
    ? {
        count: after.pins,
        // every id a live list points at must still resolve, or a card is dead
        resolved: after.has.filter(Boolean).length,
        asked: after.has.length,
      }
    : { count: null, resolved: null, asked: null };

  /* 3. A card from the newest search still opens the player. */
  out.openNew = await ev(() => {
    const c = document.querySelector('#results .card');
    if (!c) return { id: null, opened: false };
    const id = c.dataset.v;
    c.click();
    const on = document.getElementById('pl').classList.contains('on');
    const f = document.querySelector('#pl iframe');
    const src = f ? f.getAttribute('src') : '';
    document.getElementById('pclose').click();
    return { id, opened: on && src.includes(id) };
  });
  await sleep(400);

  /* 4. A card in the feed still opens the player. */
  out.openFeed = await ev(() => {
    const c = document.querySelector('#feed .card');
    if (!c) return { id: null, opened: false };
    const id = c.dataset.v;
    c.click();
    const on = document.getElementById('pl').classList.contains('on');
    const f = document.querySelector('#pl iframe');
    const src = f ? f.getAttribute('src') : '';
    document.getElementById('pclose').click();
    return { id, opened: on && src.includes(id) };
  });
  await sleep(400);

  /* 5. The video played before the session, opened again from History. Its
        registry entry is long gone; the library pin is what makes the card work. */
  out.openHist = await ev(() => {
    document.getElementById('you').click();
    const h = document.querySelector('[data-lib="hist"]');
    if (!h) return { id: null, opened: false, cards: 0 };
    h.click();
    const cards = document.querySelectorAll('#shb [data-v]');
    if (!cards.length) return { id: null, opened: false, cards: 0 };
    const c = cards[0];
    const id = c.dataset.v;
    c.click();
    const on = document.getElementById('pl').classList.contains('on');
    const f = document.querySelector('#pl iframe');
    const src = f ? f.getAttribute('src') : '';
    document.getElementById('pclose').click();
    document.getElementById('scrim').click();
    return { id, opened: on && src.includes(id), cards: cards.length };
  });
  await sleep(400);

  /* 6. A repeated search adds no new id (the same query answers the same videos).
        Only the bounded build can say this; an unbounded one has no hook to read. */
  const pre = await vm([]);
  const before = pre ? pre.size : null;
  await ev(q2 => {
    const el = document.getElementById('q');
    el.value = q2;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, lastQ);
  await sleep(600);
  const post = await vm([]);
  const again = post ? post.size : null;
  out.repeat = { before, after: again, grew: before === null ? null : again - before };

  out.heapKB = await heapKB(page);
  await page.close();
  out.errors = errors;
  return out;
}

function verdict(r) {
  const fails = [];
  if (r.after.size === null) fails.push('window.__ltVmap is missing: the registry is unbounded in this build');
  else {
    if (r.after.size > r.after.hi) fails.push('registry grew to ' + r.after.size + ' entries (ceiling ' + r.after.hi + ')');
    if (!r.evicted.evicted) fails.push('nothing was ever evicted');
  }
  if (r.pinned.asked && r.pinned.resolved !== r.pinned.asked)
    fails.push(r.pinned.asked - r.pinned.resolved + ' pinned id(s) no longer resolve');
  if (!r.openNew.opened) fails.push('a card from the newest search did not open the player');
  if (!r.openFeed.opened) fails.push('a card in the feed did not open the player');
  if (!r.openHist.opened) fails.push('a video in History did not open the player after the session');
  if (r.repeat.grew > 0) fails.push('a repeated search grew the registry by ' + r.repeat.grew);
  if (r.heapKB === null) fails.push('the heap could not be read');
  if (r.errors.length) fails.push('console/page errors: ' + r.errors.join(' | '));
  return { ok: fails.length === 0, fails };
}

(async () => {
  const files = process.argv.slice(2);
  if (!files.length) {
    console.error('usage: node tools/vmap-bound-check.js <build-a.html> [build-b.html]');
    process.exit(2);
  }
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME || '/usr/bin/google-chrome',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--force-device-scale-factor=2'],
  });
  const out = [];
  try {
    for (const f of files) {
      const r = await run(browser, f);
      r.verdict = verdict(r);
      out.push(r);
      console.log(JSON.stringify(r));
    }
    if (out.length > 1) {
      const [a, b] = out;
      console.log(
        JSON.stringify({
          compare: {
            sizeAfter: [a.after.size, b.after.size],
            evicted: [a.evicted && a.evicted.evicted, b.evicted && b.evicted.evicted],
            openHist: [a.openHist.opened, b.openHist.opened],
            heapKB: [a.heapKB, b.heapKB],
          },
          a: a.verdict,
          b: b.verdict,
        })
      );
    }
  } finally {
    await browser.close();
  }
  process.exit(out[0] && out[0].verdict.ok ? 0 : 1);
})();
