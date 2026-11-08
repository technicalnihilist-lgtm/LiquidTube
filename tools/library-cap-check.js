#!/usr/bin/env node
/*
 * LiquidTube saved-library check — item 4.5 ("cap the history/liked/later
 * arrays").
 *
 * `hist`, `liked` and `later` are the three lists the Library sheet draws. Only
 * history was trimmed (inline, in `play()`); liked and later had no ceiling, so
 * every heart and every save appended an id for the life of the install, and
 * every change rewrote all of it to localStorage. The build under test caps all
 * three (HIST_MAX 100, LIKED_MAX / LATER_MAX 500), keeps the newest entries,
 * applies the cap at the single writer (`toggle`) and again at boot, and exposes
 * window.__ltLibrary() so a run can see the lengths, the caps and both ends of
 * each list.
 *
 * This tool drives the real UI on a real browser with the API mocked and seeds a
 * library larger than every cap before the page loads, then reports, per build:
 *
 *   seed        the oversized blob written before boot (hist 300, liked 900,
 *               later 900 — what an unbounded build accumulates in a year)
 *   boot        the three lengths after load: must be at or under the caps
 *   kept        the first/last id of each list: the newest entries must be the
 *               ones that survived (k0899 last for liked, h000 first for history)
 *   like        heart a feed video, then read liked: must stay at LIKED_MAX and
 *               end with that video's id
 *   save        save the same video to Watch later: same rule for LATER_MAX
 *   play        open a feed video, then read history: at HIST_MAX, newest first
 *   unlike      un-heart it: the list must drop to LIKED_MAX - 1, so the cap did
 *               not break removal
 *   sheet       Library → Liked still opens and still holds a card for the video
 *   bytes       the saved blob's size before and after the session
 *
 * Usage:
 *   npm i puppeteer-core                    # dev only, not shipped in the APK
 *   CHROME=/path/to/chrome node tools/library-cap-check.js <build-a.html> [build-b.html]
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
const pad = n => String(n).padStart(3, '0');
const vids = Array.from({ length: 24 }, (_, i) => 'v' + pad(i + 1) + 'AAAAAAAA');
const CH = Array.from({ length: 6 }, (_, i) => 'UC' + i + 'xxxxxxxxxxxxxxxxxxxx');
const ago = h => new Date(Date.now() - h * 36e5).toISOString();

const SEED = {
  hist: Array.from({ length: 300 }, (_, i) => 'h' + pad(i)),
  liked: Array.from({ length: 900 }, (_, i) => 'k' + pad(i)),
  later: Array.from({ length: 900 }, (_, i) => 'l' + pad(i)),
};

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
function durationsFor(u) {
  const ids = String(u.searchParams.get('id') || '').split(',').filter(Boolean);
  return { items: ids.map(id => ({ id, contentDetails: { duration: 'PT12M30S' } })) };
}
function apiBody(url) {
  const u = new URL(url);
  const p = u.pathname;
  if (p.endsWith('/videos'))
    return (u.searchParams.get('part') || '').includes('contentDetails') ? durationsFor(u) : TRENDING;
  if (p.endsWith('/channels')) return { items: [] };
  if (p.endsWith('/playlistItems')) return { items: [] };
  if (p.endsWith('/search')) return { items: [] };
  return {};
}

async function boot(browser, file) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e.message || e)));
  page.on('console', m => {
    if (m.type() === 'error' && !/ytimg|ggpht|net::ERR/.test(m.text())) errors.push(m.text());
  });
  /* The seed is written before any of the page's own script runs, so the build
     under test has to trim it at boot — the same path a returning user with an
     old blob takes. */
  await page.evaluateOnNewDocument(seed => {
    try {
      localStorage.setItem('lt', JSON.stringify({ hist: seed.hist, liked: seed.liked, later: seed.later }));
    } catch (e) {}
  }, SEED);
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

async function run(browser, file) {
  const { page, errors } = await boot(browser, file);
  const out = { file: path.basename(file) };
  const ev = (fn, ...a) => page.evaluate(fn, ...a);
  const lib = async () => await ev(() => (window.__ltLibrary ? window.__ltLibrary() : null));

  out.seed = { hist: SEED.hist.length, liked: SEED.liked.length, later: SEED.later.length };

  const b = await lib();
  if (!b) {
    out.boot = null;
    out.errors = errors;
    await page.close();
    return out;
  }
  out.boot = { hist: b.hist, liked: b.liked, later: b.later, max: b.max, bytes: b.bytes };
  out.kept = { first: b.first, last: b.last };

  /* Heart and save a feed video. Its id is appended, which is where a cap has to
     bite: the list was already at its ceiling from the seed. */
  out.like = await ev(() => {
    const c = document.querySelector('#feed .card');
    if (!c) return null;
    const id = c.dataset.v;
    c.click();
    const like = document.getElementById('ppp');
    if (like.textContent === 'Liked') like.click(); // start from a known state
    like.click();
    const label = like.textContent;
    const r = window.__ltLibrary();
    return { id, label, len: r.liked, last: r.last.liked };
  });
  await sleep(300);

  out.save = await ev(() => {
    const save = document.getElementById('psave');
    save.click();
    const r = window.__ltLibrary();
    return { len: r.later, last: r.last.later };
  });
  await sleep(300);

  /* Close the player, then read history: play() unshifts the id it opened. */
  out.play = await ev(() => {
    document.getElementById('pclose').click();
    const r = window.__ltLibrary();
    return { len: r.hist, first: r.first.hist };
  });
  await sleep(400);

  /* Library → Liked: the sheet still opens and the video just hearted is in it. */
  out.sheet = await ev(() => {
    document.getElementById('you').click();
    const row = document.querySelector('[data-lib="liked"]');
    if (!row) return { opened: false, cards: 0, has: false };
    row.click();
    const cards = document.querySelectorAll('#shb [data-v]');
    const ids = [...cards].map(c => c.dataset.v);
    const id = window.__ltLibrary().last.liked;
    document.getElementById('scrim').click();
    return { opened: cards.length > 0, cards: cards.length, has: ids.includes(id) };
  });
  await sleep(300);

  /* Un-heart from the player: removal still works with the cap in place. */
  out.unlike = await ev(() => {
    const c = document.querySelector('#feed .card');
    if (!c) return null;
    c.click();
    const like = document.getElementById('ppp');
    const before = window.__ltLibrary().liked;
    if (like.textContent === 'Liked') like.click();
    const r = window.__ltLibrary();
    document.getElementById('pclose').click();
    return { before, after: r.liked };
  });
  await sleep(300);

  out.bytes = (await lib()).bytes;
  await page.close();
  out.errors = errors;
  return out;
}

function verdict(r) {
  const fails = [];
  if (!r.boot) {
    fails.push('window.__ltLibrary is missing: the library lists are unbounded in this build');
    return { ok: false, fails };
  }
  if (r.boot.hist > r.boot.max.hist) fails.push('history loaded at ' + r.boot.hist + ' (cap ' + r.boot.max.hist + ')');
  if (r.boot.liked > r.boot.max.liked) fails.push('liked loaded at ' + r.boot.liked + ' (cap ' + r.boot.max.liked + ')');
  if (r.boot.later > r.boot.max.later) fails.push('later loaded at ' + r.boot.later + ' (cap ' + r.boot.max.later + ')');
  if (r.kept.last.liked !== SEED.liked[SEED.liked.length - 1])
    fails.push('liked kept the wrong end: last is ' + r.kept.last.liked + ', newest seed is ' + SEED.liked[SEED.liked.length - 1]);
  if (r.kept.first.hist !== SEED.hist[0])
    fails.push('history kept the wrong end: first is ' + r.kept.first.hist + ', newest seed is ' + SEED.hist[0]);
  if (!r.like) fails.push('no feed card to heart');
  else {
    if (r.like.len > r.boot.max.liked) fails.push('liking grew the list to ' + r.like.len + ' (cap ' + r.boot.max.liked + ')');
    if (r.like.last !== r.like.id) fails.push('the video just hearted is not the newest entry (' + r.like.last + ')');
    if (r.like.label !== 'Liked') fails.push('the Like button did not read Liked after a heart');
  }
  if (!r.save) fails.push('no save button');
  else {
    if (r.save.len > r.boot.max.later) fails.push('saving grew the list to ' + r.save.len + ' (cap ' + r.boot.max.later + ')');
    if (r.save.last !== r.like.id) fails.push('the video just saved is not the newest Watch later entry');
  }
  if (r.play.len > r.boot.max.hist) fails.push('playing grew history to ' + r.play.len + ' (cap ' + r.boot.max.hist + ')');
  if (r.play.first !== r.like.id) fails.push('the video just played is not the newest history entry');
  if (!r.sheet.opened) fails.push('Library → Liked no longer lists anything');
  else if (!r.sheet.has) fails.push('the video just hearted is missing from Library → Liked');
  if (!r.unlike) fails.push('could not re-open the player to un-heart');
  else if (r.unlike.after !== r.unlike.before - 1)
    fails.push('un-hearting went from ' + r.unlike.before + ' to ' + r.unlike.after);
  if (r.errors.length) fails.push('console/page errors: ' + r.errors.join(' | '));
  return { ok: fails.length === 0, fails };
}

(async () => {
  const files = process.argv.slice(2);
  if (!files.length) {
    console.error('usage: node tools/library-cap-check.js <build-a.html> [build-b.html]');
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
            boot: [a.boot && [a.boot.hist, a.boot.liked, a.boot.later], b.boot && [b.boot.hist, b.boot.liked, b.boot.later]],
            bytes: [a.bytes, b.bytes],
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
