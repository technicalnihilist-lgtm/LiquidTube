#!/usr/bin/env node
/*
 * LiquidTube page-teardown check — item 4.3 ("remove listeners on teardown of
 * pages").
 *
 * The audit this tool automates says most of the build is already right: the tab
 * strip, the chip row, `#sg`, `#sheet`, `#shb` and the player's buttons are static
 * nodes, and every card, shelf and result is handled by delegation from one of
 * them or from `document`, so a tab switch adds no listener at all. What did not
 * hold is the player — the one surface that builds DOM per use. `mount()` attached
 * a `load` listener to the iframe it had just created and never removed it, and
 * `mount()` runs again on every play and every loop wrap, so N plays left N
 * handlers on N detached iframes; and the window `message` bridge behind Loop was
 * registered at parse time and parsed every message any frame ever posted, even
 * when no player had been opened. The sheet had the sibling problem without a
 * listener: its one asynchronous loader wrote into whatever sheet was on screen
 * when the answer landed.
 *
 * This tool drives the real UI on a real browser with the API mocked and reports,
 * per build:
 *
 *   boot        listeners the app owns at rest (registry live count) and the
 *               `message` listeners on `window` before any video has been opened
 *   playClose   twenty play/close cycles: registry live count and the real
 *               `message` listener count on `window` with the player open and
 *               after each close, and the growth in document listeners across
 *               the twenty cycles
 *   remount     eleven plays into an open player: iframes in the player and
 *               registry live count — two listeners, not 2N
 *   loop        Loop still works after the bridge moved: a synthetic
 *               onStateChange(0) from an allowed origin re-mounts the player
 *   sheetLate   a channel opened and replaced by Library while its uploads
 *               request is still on the wire: what the sheet says once that
 *               answer lands, and whether a pageerror was thrown at a `#chlist`
 *               that no longer exists
 *   end         registry live count and document listeners after the whole run
 *
 * Usage:
 *   npm i puppeteer-core                    # dev only, not shipped in the APK
 *   CHROME=/path/to/chrome node tools/page-teardown-check.js <build-a.html> [build-b.html]
 * Prints one JSON object per build; with two builds it also compares them.
 * Exit code 1 when the build under test — the first file — fails any check.
 */
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const ORIGIN = 'liquidtube.local';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64'
);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const CH_DELAY = +process.env.CH_DELAY || 800; // a channels answer that lands late
const pad = n => String(n).padStart(2, '0');
const vids = Array.from({ length: 24 }, (_, i) => 'v' + pad(i + 1) + 'AAAAAAAA');
const CH = Array.from({ length: 6 }, (_, i) => 'UC' + i + 'xxxxxxxxxxxxxxxxxxxx');
const ago = h => new Date(Date.now() - h * 36e5).toISOString();

/* Search results hang off their own channels, ones the feed never asks for, so a
   search can open a channel sheet whose `channels` call really has to leave. */
const SCH = Array.from({ length: 6 }, (_, i) => 'UCs' + i + 'yyyyyyyyyyyyyyyyyyy');

function searchFor(q) {
  return {
    items: Array.from({ length: 20 }, (_, i) => {
      const id = 'q' + pad(Math.abs(hash(q)) % 90) + 'v' + pad(i);
      return {
        id: { videoId: id },
        snippet: {
          title: 'Result ' + i,
          channelTitle: 'Channel s' + (i % 6),
          channelId: SCH[i % 6],
          publishedAt: ago(i + 1),
          thumbnails: { maxres: { url: 'https://i.ytimg.com/vi/' + id + '/maxresdefault.jpg' } },
        },
      };
    }),
  };
}
function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
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

/* A channel sheet's uploads answer can be held back, so the sheet it was opened
   for is replaced while that request is still on the wire. (The `channels` call
   cannot be held instead: `find()` awaits it before it paints, so the channel is
   always in `CH` by the time a result can be played.) */
let holdUploads = 0;

async function boot(browser, file) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e.message || e)));
  page.on('console', m => {
    if (m.type() === 'error' && !/ytimg|ggpht|net::ERR|youtube-nocookie/.test(m.text())) errors.push(m.text());
  });
  await page.setRequestInterception(true);
  page.on('request', async req => {
    const u = req.url();
    if (u.startsWith('https://' + ORIGIN + '/index.html') || u === 'https://' + ORIGIN + '/') {
      return req.respond({ status: 200, contentType: 'text/html', body: fs.readFileSync(file) });
    }
    if (/googleapis\.com\/(youtube\/v3|youtubei)/.test(u)) {
      if (/\/playlistItems$/.test(new URL(u).pathname) && holdUploads > 0) await sleep(holdUploads);
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
     blurred full-screen panel cost hundreds of ms a frame, and no listener
     lifetime depends on it. */
  await page.evaluate(() => {
    const st = document.createElement('style');
    st.textContent = '*{backdrop-filter:none!important;filter:none!important;box-shadow:none!important}';
    document.head.appendChild(st);
  });
  return { page, errors };
}

/* The real listener table of an object, from the engine — not the app's own
   bookkeeping — so a registry that forgets to remove is caught either way. */
async function listenersOf(page, expression) {
  const s = await page.target().createCDPSession();
  try {
    const { result } = await s.send('Runtime.evaluate', { expression });
    if (!result || !result.objectId) return null;
    const { listeners } = await s.send('DOMDebugger.getEventListeners', { objectId: result.objectId });
    return listeners;
  } finally {
    await s.detach();
  }
}
const countType = (ls, type) => (ls || []).filter(l => l.type === type).length;

async function run(browser, file) {
  const { page, errors } = await boot(browser, file);
  const out = { file: path.basename(file) };
  const ev = (fn, ...a) => page.evaluate(fn, ...a);
  const surf = () => ev(() => (window.__ltSurfaces ? window.__ltSurfaces() : null));

  /* ---- boot ---- */
  const s0 = await surf();
  const winMsg0 = countType(await listenersOf(page, 'window'), 'message');
  out.boot = { live: s0 ? s0.live : null, windowMessage: winMsg0 };

  /* ---- twenty play/close cycles ---- */
  const docBefore = (await listenersOf(page, 'document')) || [];
  const cycles = [];
  for (let i = 0; i < 20; i++) {
    const open = await ev(n => {
      const cards = [...document.querySelectorAll('#feed .card')];
      const c = cards[n % cards.length];
      c.click();
      const s = window.__ltSurfaces ? window.__ltSurfaces() : null;
      return {
        on: document.getElementById('pl').classList.contains('on'),
        live: s ? s.live : null,
        iframes: document.querySelectorAll('#pl .art iframe').length,
      };
    }, i);
    const openMsg = countType(await listenersOf(page, 'window'), 'message');
    const closed = await ev(() => {
      document.getElementById('pclose').click();
      const s = window.__ltSurfaces ? window.__ltSurfaces() : null;
      return { on: document.getElementById('pl').classList.contains('on'), live: s ? s.live : null };
    });
    const closedMsg = countType(await listenersOf(page, 'window'), 'message');
    cycles.push({ open, openMsg, closed, closedMsg });
  }
  const docAfter = (await listenersOf(page, 'document')) || [];
  out.playClose = {
    cycles: cycles.length,
    liveOpen: [...new Set(cycles.map(c => c.open.live))],
    liveClosed: [...new Set(cycles.map(c => c.closed.live))],
    windowMessageOpen: [...new Set(cycles.map(c => c.openMsg))],
    windowMessageClosed: [...new Set(cycles.map(c => c.closedMsg))],
    iframesOpen: [...new Set(cycles.map(c => c.open.iframes))],
    documentListeners: { before: docBefore.length, after: docAfter.length },
  };

  /* ---- eleven plays into an open player ---- */
  out.remount = await ev(() => {
    const cards = [...document.querySelectorAll('#feed .card')];
    cards[0].click();
    for (let i = 1; i <= 10; i++) cards[i % cards.length].click();
    const s = window.__ltSurfaces ? window.__ltSurfaces() : null;
    const r = {
      iframes: document.querySelectorAll('#pl .art iframe').length,
      live: s ? s.live : null,
      owners: s ? s.owners : null,
    };
    document.getElementById('pclose').click();
    r.liveClosed = window.__ltSurfaces ? window.__ltSurfaces().live : null;
    return r;
  });

  /* ---- Loop still works after the bridge moved ---- */
  out.loop = await ev(() => {
    /* Settings is where Loop lives; it is a plain switch in the sheet. */
    document.querySelector('[data-do="you"]').click();
    document.querySelector('[data-lib="settings"]').click();
    document.querySelector('[data-opt="loop"]').click();
    document.getElementById('pclose').click();
    document.querySelectorAll('#feed .card')[0].click();
    const first = document.querySelector('#pl .art iframe');
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: 'https://www.youtube-nocookie.com',
        data: JSON.stringify({ event: 'onStateChange', info: 0 }),
      })
    );
    const second = document.querySelector('#pl .art iframe');
    const r = { remounted: !!first && !!second && first !== second, iframes: document.querySelectorAll('#pl .art iframe').length };
    document.getElementById('pclose').click();
    r.liveClosed = window.__ltSurfaces ? window.__ltSurfaces().live : null;
    return r;
  });
  await sleep(300);

  /* ---- a sheet torn down while its answer is still on the wire ---- */
  holdUploads = CH_DELAY;
  const errsBefore = errors.length;
  out.sheetLate = await ev(() => {
    /* A search result hangs off a channel the feed never asked for. */
    const q = document.getElementById('q');
    q.value = 'late sheet';
    q.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  });
  await page.waitForFunction('document.querySelectorAll("#results .card").length > 0', { timeout: 30000 });
  await ev(() => {
    document.querySelector('#results .card').click();
    document.getElementById('plk').click(); // Channel: closes the player, opens the channel sheet
  });
  await sleep(120);
  const opened = await ev(() => document.getElementById('sht').textContent);
  await ev(() => document.querySelector('[data-do="you"]').click()); // Library replaces the sheet mid-request
  await sleep(CH_DELAY + 900);
  out.sheetLate = await ev(() => ({
    title: document.getElementById('sht').textContent,
    libraryRows: document.querySelectorAll('#shb [data-lib]').length,
    channelHeader: document.querySelectorAll('#shb .chh').length,
    chlist: !!document.getElementById('chlist'),
    open: document.getElementById('sheet').classList.contains('on'),
  }));
  out.sheetLate.openedAs = opened;
  out.sheetLate.pageErrors = errors.length - errsBefore;
  await ev(() => document.getElementById('scrim').click());
  holdUploads = 0;
  await sleep(300);

  /* ---- end ---- */
  const s1 = await surf();
  const docEnd = (await listenersOf(page, 'document')) || [];
  out.end = { live: s1 ? s1.live : null, on: s1 ? s1.on : null, off: s1 ? s1.off : null, documentListeners: docEnd.length };
  out.pageErrors = errors;

  /* ---- verdict ---- */
  const fails = [];
  const ok = (cond, what) => { if (!cond) fails.push(what); };
  ok(out.boot.live === 0, 'boot: the app owns no surface listener at rest');
  ok(out.boot.windowMessage === 0, 'boot: no message bridge before a player is opened');
  ok(out.playClose.liveOpen.length === 1 && out.playClose.liveOpen[0] === 2, 'playClose: two listeners with the player open');
  ok(out.playClose.liveClosed.every(v => v === 0), 'playClose: none left after close');
  ok(out.playClose.windowMessageOpen.every(v => v === 1), 'playClose: one message bridge while open');
  ok(out.playClose.windowMessageClosed.every(v => v === 0), 'playClose: bridge removed on close');
  ok(out.playClose.iframesOpen.every(v => v === 1), 'playClose: one iframe in the player');
  ok(out.playClose.documentListeners.after === out.playClose.documentListeners.before, 'playClose: document listeners did not grow');
  ok(out.remount.iframes === 1 && out.remount.live === 2, 'remount: two listeners after eleven plays');
  ok(out.remount.liveClosed === 0, 'remount: none left after close');
  ok(out.loop.remounted, 'loop: the moved bridge still re-mounts the player');
  ok(out.loop.iframes === 1 && out.loop.liveClosed === 0, 'loop: one iframe, nothing left behind');
  ok(out.sheetLate.title === 'You', 'sheetLate: the late channel answer did not rename the sheet');
  ok(out.sheetLate.libraryRows > 0 && out.sheetLate.channelHeader === 0, 'sheetLate: the library sheet is intact');
  ok(out.sheetLate.pageErrors === 0, 'sheetLate: no error from a write into a torn-down sheet');
  ok(out.end.live === 0, 'end: no surface listener left registered');
  ok(out.end.documentListeners === docBefore.length, 'end: document listeners did not grow');
  ok(out.pageErrors.length === 0, 'no page errors at all');
  out.fails = fails;
  out.pass = fails.length === 0;
  await page.close();
  return out;
}

(async () => {
  const files = process.argv.slice(2);
  if (!files.length) {
    console.error('usage: node tools/page-teardown-check.js <build.html> [build-b.html]');
    process.exit(2);
  }
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME || '/usr/bin/google-chrome',
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--force-device-scale-factor=1'],
  });
  const results = [];
  try {
    for (const f of files) {
      const r = await run(browser, f);
      results.push(r);
      console.log(JSON.stringify(r, null, 2));
    }
  } finally {
    await browser.close();
  }
  if (results.length > 1) {
    const a = results[0], b = results[1];
    console.log('--- comparison (under test vs baseline) ---');
    console.log(JSON.stringify({
      liveOpen: [a.playClose.liveOpen, b.playClose.liveOpen],
      liveClosed: [a.playClose.liveClosed, b.playClose.liveClosed],
      windowMessageBoot: [a.boot.windowMessage, b.boot.windowMessage],
      windowMessageOpen: [a.playClose.windowMessageOpen, b.playClose.windowMessageOpen],
      windowMessageClosed: [a.playClose.windowMessageClosed, b.playClose.windowMessageClosed],
      documentListeners: [a.playClose.documentListeners, b.playClose.documentListeners],
      remountLive: [a.remount.live, b.remount.live],
      sheetLate: [a.sheetLate, b.sheetLate],
      pageErrors: [a.pageErrors.length, b.pageErrors.length],
      pass: [a.pass, b.pass],
    }, null, 2));
  }
  process.exit(results[0].pass ? 0 : 1);
})();
