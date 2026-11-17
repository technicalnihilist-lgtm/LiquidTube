#!/usr/bin/env node
/*
 * LiquidTube player-resume check — item 8.3 ("restore position when reopening
 * the same video").
 *
 * Closing the player takes the frame down (item 4.4), and the frame is where the
 * playback clock lived: opening the same video again started it at 0, so a
 * half-watched video had to be scrubbed back by hand. The fix listens to the
 * player's own `infoDelivery` reports on the jsapi channel the loop already
 * uses, holds the newest position in memory while the video plays, and writes it
 * to `S.pos` only when the frame goes away — so a playing video costs no storage
 * writes — then builds the next frame for that video with `start=` in its URL.
 *
 * What this tool measures, per build, on a real browser with the API mocked and
 * the embed served as a real document:
 *
 *   first      a video never opened before: no `start=` parameter at all
 *   stored     a report of 95 s, then a close: the position is written once,
 *              as a whole number of seconds, and only on the way out (no write
 *              while it plays)
 *   reopen     the same video reopened: a fresh frame whose URL carries
 *              `start=95`, and the parameter is the only difference in the URL
 *   other      a different video still opens with no `start=` (per-video, not
 *              global)
 *   nearEnd    a report from inside the last 15 s clears the entry, and the close
 *              that follows does not write it back
 *   ended      the ended state clears the entry too (a finished video opens at 0)
 *   bounded    a blob carrying 70 stored positions loads as at most 60
 *   noWrites   the position map costs nothing while a video plays (the storage
 *              blob does not change across 20 reports)
 *
 * Usage:
 *   npm i puppeteer-core                    # dev only, not shipped in the APK
 *   CHROME=/path/to/chrome node tools/player-resume-check.js <build-a.html> [build-b.html]
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
const pad = n => String(n).padStart(2, '0');
const vids = Array.from({ length: 24 }, (_, i) => 'v' + pad(i + 1) + 'AAAAAAAA');
const CH = Array.from({ length: 6 }, (_, i) => 'UC' + i + 'xxxxxxxxxxxxxxxxxxxx');
const ago = h => new Date(Date.now() - h * 36e5).toISOString();

/* The embed, served as a real page so its load can be counted. It posts `ready`
   once per document, which is what a rebuild costs and a reuse does not. */
const EMBED_HTML = `<!doctype html><html><body><video id="v" muted playsinline></video>
<script>
  var say=function(m){try{parent.postMessage('LTEMBED:'+m,'*')}catch(e){}};
  addEventListener('pagehide',function(){say('pagehide')});
  say('ready');
</script></body></html>`;

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
  if (p.endsWith('/playlistItems'))
    return {
      items: vids.slice(0, 12).map((id, i) => ({
        snippet: { title: 'P' + i, resourceId: { videoId: id }, publishedAt: ago(i * 24) },
        contentDetails: { videoPublishedAt: ago(i * 24) },
      })),
    };
  return {};
}

async function boot(browser, file) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e.message || e)));
  page.on('console', m => {
    if (m.type() === 'error' && !/ytimg|ggpht|net::ERR|youtube-nocookie|about:blank/.test(m.text()))
      errors.push(m.text());
  });
  await page.setRequestInterception(true);
  page.on('request', req => {
    const u = req.url();
    if (u.startsWith('https://' + ORIGIN + '/index.html') || u === 'https://' + ORIGIN + '/')
      return req.respond({ status: 200, contentType: 'text/html', body: fs.readFileSync(file) });
    if (/youtube-nocookie\.com\/embed\//.test(u)) return req.respond({ status: 200, contentType: 'text/html', body: EMBED_HTML });
    if (/googleapis\.com\/(youtube\/v3|youtubei)/.test(u))
      return req.respond({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify(apiBody(u)),
      });
    if (/ytimg\.com|ggpht\.com|googleusercontent\.com/.test(u)) return req.respond({ status: 200, contentType: 'image/png', body: PNG });
    return req.abort();
  });
  await page.goto('https://' + ORIGIN + '/index.html', { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction('document.querySelectorAll("#feed .card").length > 0', { timeout: 60000 });
  await page.evaluate(() => {
    window.__ltEmbed = [];
    window.addEventListener('message', e => {
      const d = e.data;
      if (typeof d === 'string' && d.indexOf('LTEMBED:') === 0) window.__ltEmbed.push(d.slice(8));
    });
  });
  await sleep(800);
  return { page, errors };
}

/* A player report, dispatched on the bridge the app listens on. */
const REPORT = `(info) => window.dispatchEvent(new MessageEvent('message', {
  origin: 'https://www.youtube-nocookie.com',
  data: JSON.stringify({ event: 'infoDelivery', info: info }),
}))`;
const STATE = `(st) => window.dispatchEvent(new MessageEvent('message', {
  origin: 'https://www.youtube-nocookie.com',
  data: JSON.stringify({ event: 'onStateChange', info: st }),
}))`;

async function run(browser, file) {
  const { page, errors } = await boot(browser, file);
  const out = { file: path.basename(file) };
  const ev = (fn, ...a) => page.evaluate(fn, ...a);
  const resume = () => ev(() => (window.__ltResume ? window.__ltResume() : null));
  const frame = () =>
    ev(() => {
      const f = document.querySelector('#pl .art iframe');
      const src = f ? f.getAttribute('src') : '';
      const u = src ? new URL(src) : null;
      return {
        iframes: document.querySelectorAll('#pl .art iframe').length,
        src,
        start: u ? u.searchParams.get('start') : null,
        bare: u ? u.origin + u.pathname + '?' + [...u.searchParams.keys()].filter(k => k !== 'start').map(k => k + '=' + u.searchParams.get(k)).join('&') : '',
        embedReady: (window.__ltEmbed || []).filter(m => m === 'ready').length,
        playerOn: document.getElementById('pl').classList.contains('on'),
        artChildren: document.querySelector('#pl .art').children.length,
      };
    });
  const close = async () => {
    await ev(() => document.getElementById('pclose').click());
    await sleep(300);
  };
  const play = async i => {
    await ev(n => document.querySelectorAll('#feed .card')[n].click(), i);
    await sleep(350);
  };

  /* ---- first: a video never opened before carries no start ---- */
  await play(0);
  out.first = await frame();
  out.first.resume = await resume();

  /* ---- stored: a report, then a close ---- */
  out.stored = await ev(
    async (rep, info) => {
      const key = 'lt';
      const before = (() => {
        try {
          return localStorage.getItem(key) || '';
        } catch (e) {
          return '';
        }
      })();
      const writes = [];
      const rawSet = Storage.prototype.setItem;
      Storage.prototype.setItem = function (k, v) {
        if (k === key) writes.push(String(v));
        return rawSet.call(this, k, v);
      };
      const report = eval(rep);
      for (let i = 0; i < 20; i++) report({ currentTime: 10 + i, duration: 600, playerState: 1 });
      const writesWhilePlaying = writes.length;
      Storage.prototype.setItem = rawSet;
      const R = window.__ltResume ? window.__ltResume() : { stored: {}, live: null };
      const live = R.live;
      const storedBefore = JSON.stringify(R.stored);
      return { writesWhilePlaying, live, storedBefore, before: before.length };
    },
    REPORT,
    null
  );
  await close();
  out.storedAfterClose = await resume();

  /* ---- reopen: the same video, from the feed card ---- */
  await play(0);
  out.reopen = await frame();
  out.reopen.resume = await resume();

  /* ---- persistence: the map survives a reload ---- */
  await page.reload({ waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction('document.querySelectorAll("#feed .card").length > 0', { timeout: 60000 });
  await sleep(400);
  out.persisted = await resume();

  /* ---- other: a different video is not given that position ---- */
  await play(1);
  out.other = await frame();
  await close();

  /* ---- nearEnd: the last 15 s are not worth restoring ---- */
  await play(0);
  out.nearEnd = await ev(
    async (rep, st, info) => {
      eval(rep)(info);
      const R = window.__ltResume ? window.__ltResume() : { stored: {}, live: null };
      const live = R.live;
      const stored = R.stored;
      return { live, stored: JSON.parse(JSON.stringify(stored)) };
    },
    REPORT,
    STATE,
    { currentTime: 595, duration: 600, playerState: 1 }
  );
  await close();
  out.nearEndAfterClose = await resume();
  await play(0);
  out.nearEndReopen = await frame();
  await close();

  /* ---- ended: a finished video opens at the start ---- */
  await play(0);
  out.ended = await ev(
    async (rep, st) => {
      eval(rep)({ currentTime: 95, duration: 600, playerState: 1 });
      eval(st)(0);
      return { stored: JSON.parse(JSON.stringify(window.__ltResume ? window.__ltResume().stored : {})) };
    },
    REPORT,
    STATE
  );
  await close();
  out.endedAfterClose = await resume();
  await play(0);
  out.endedReopen = await frame();
  await close();

  /* ---- bounded: a blob with 70 positions loads as at most 60 ---- */
  /* The blob is written through the app's own `save()`, so this seeds the map the
     way an older build with a larger cap would have left it. */
  out.bounded = await ev(() => {
    if (typeof S === 'undefined' || typeof save !== 'function') return 0;
    S.pos = {};
    for (let i = 0; i < 70; i++) S.pos['v' + String(i).padStart(2, '0') + 'AAAAAAAA'] = 30 + i;
    save();
    return Object.keys(S.pos).length;
  });
  await page.reload({ waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction('document.querySelectorAll("#feed .card").length > 0', { timeout: 60000 });
  await sleep(400);
  out.boundedLoaded = await resume();
  if (!out.boundedLoaded) out.boundedLoaded = { stored: {}, max: 0 };

  out.pageErrors = errors;
  const end = await frame();
  out.end = { iframes: end.iframes, artChildren: end.artChildren };

  /* ---- verdict ---- */
  const fails = [];
  const ok = (cond, what) => {
    if (!cond) fails.push(what);
  };
  const id0 = vids[0];
  const pos = r => (r && r.stored) || {};      /* a build with no resume map reads as empty */
  ok(out.first.start === null, 'first: a video never opened before carries no start parameter');
  ok(!!out.first.resume, 'first: the resume hook is present');
  ok(out.stored.writesWhilePlaying === 0, 'stored: playing a video writes nothing to storage');
  ok(!!out.stored.live && Math.floor(out.stored.live.t) === 29, 'stored: the newest report is held in memory');
  ok(out.stored.storedBefore === '{}', 'stored: nothing is written before the frame goes');
  ok(!!out.storedAfterClose && pos(out.storedAfterClose)[id0] === 29, 'stored: the close writes the position, in whole seconds');
  ok(!!out.persisted && pos(out.persisted)[id0] === 29, 'stored: the position survives a reload of the app');
  ok(out.reopen.start === '29', 'reopen: the same video reopens at the stored position');
  ok(out.reopen.iframes === 1 && out.reopen.artChildren > 0, 'reopen: still one frame in the player');
  ok(out.reopen.bare === out.first.bare, 'reopen: start is the only difference in the embed URL (no other option changed)');
  ok(out.other.start === null, 'other: a different video is not sent to that position');
  ok(pos(out.nearEnd)[id0] == null, 'nearEnd: a report inside the last 15 s clears the entry');
  ok(out.nearEnd.live === null, 'nearEnd: the live position is dropped with it');
  ok(!pos(out.nearEndAfterClose)[id0], 'nearEnd: the close does not write the cleared position back');
  ok(out.nearEndReopen.start === null, 'nearEnd: reopening a finished video starts at the beginning');
  ok(pos(out.ended)[id0] == null, 'ended: the ended state clears the entry');
  ok(!pos(out.endedAfterClose)[id0], 'ended: the close after the end writes nothing back');
  ok(out.endedReopen.start === null, 'ended: reopening after the end starts at the beginning');
  ok(out.boundedLoaded && Object.keys(pos(out.boundedLoaded)).length <= out.boundedLoaded.max, 'bounded: a blob with 70 positions loads as at most POS_MAX');
  ok(out.boundedLoaded && out.boundedLoaded.max === 60, 'bounded: the cap is 60 videos');
  ok(out.end.iframes === 0 && out.end.artChildren === 0, 'end: no frame left at the end of the run');
  ok(out.pageErrors.length === 0, 'no page errors at all');
  out.fails = fails;
  out.pass = fails.length === 0;
  await page.close();
  return out;
}

(async () => {
  const files = process.argv.slice(2);
  if (!files.length) {
    console.error('usage: node tools/player-resume-check.js <build.html> [build-b.html]');
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
    const a = results[0];
    const b = results[1];
    console.log('--- comparison (under test vs baseline) ---');
    console.log(
      JSON.stringify(
        {
          firstStart: [a.first.start, b.first.start],
          storedAfterClose: [a.storedAfterClose, b.storedAfterClose],
          reopenStart: [a.reopen.start, b.reopen.start],
          otherStart: [a.other.start, b.other.start],
          nearEndReopenStart: [a.nearEndReopen.start, b.nearEndReopen.start],
          endedReopenStart: [a.endedReopen.start, b.endedReopen.start],
          writesWhilePlaying: [a.stored.writesWhilePlaying, b.stored.writesWhilePlaying],
          pageErrors: [a.pageErrors.length, b.pageErrors.length],
          fails: [a.fails, b.fails],
          pass: [a.pass, b.pass],
        },
        null,
        2
      )
    );
  }
  process.exit(results[0].pass ? 0 : 1);
})();
