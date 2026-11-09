#!/usr/bin/env node
/*
 * LiquidTube heap-growth check — item 4.8 ("check heap growth over a 10-minute
 * scroll session").
 *
 * A scroll session is the one workload that runs the same code path tens of
 * thousands of times, so it is the workload that turns a per-frame allocation
 * into a leak: 60 frames a second for ten minutes is 36,000 passes through
 * `frameRun`, each one measuring the feed, queueing transforms and writing them.
 * The question this tool answers is whether anything the app holds grows with
 * that count — a cache keyed by an element, an array that is pushed to and never
 * emptied, a timer that re-arms itself and keeps the closure behind it.
 *
 * It drives the real UI in a real browser with the API mocked, and reports, per
 * build:
 *
 *   probe      the measurement's own check: 4 MB of retained arrays are
 *              allocated, must show up in the heap, released, must go. A run
 *              that reports a flat heap proves nothing without this
 *   boot       heap after the first paint has settled and a forced GC — the
 *              baseline, before any scrolling
 *   minute 1.. the heap, the live tree, the DOM node count and the size of every
 *              map and array the app keeps, sampled after a forced GC at the end
 *              of each simulated minute of scrolling
 *   alloc      the garbage rate: heap growth across 600 frames with no GC in
 *              between, divided by the frames. Not a leak — this is the churn a
 *              scavenge has to collect — but it is the number that says whether
 *              the frame path allocates at all
 *   end        heap and detached-node count once the session is over
 *
 * A 10-minute session is simulated, not slept through: the harness issues one
 * scroll step and one frame per step — 36,000 of them at 60 fps — and lets the
 * browser run them as fast as it will, so a run costs a few minutes of CPU
 * instead of ten minutes of wall clock. The app's own rAF callbacks (a scroll
 * event still asks for a frame the way it does on a device) run on top of that,
 * so the frame count the session ends on is higher than the one it drives. The first minute is
 * excluded from the verdict: the first frames of a session compile code and
 * build Blink's first-use style, layout and paint caches, which is a one-off
 * step, not a slope.
 *
 * Usage:
 *   npm i puppeteer-core                    # dev only, not shipped in the APK
 *   CHROME=/path/to/chrome node tools/heap-scroll-check.js <build-a.html> [build-b.html]
 * SESSION_MIN=10 (default) sets the simulated session length in minutes, FPS=60
 * the frames each of those minutes is worth, MAX_GROW_KB=128 the heap growth the
 * verdict allows from minute 1 to the last sample.
 * Exit code 1 when the build under test — the first file — fails any check.
 */
const path = require('path');
const fs = require('fs');
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

const SESSION_MIN = +process.env.SESSION_MIN || 10;
const FPS = +process.env.FPS || 60;
const MAX_GROW_KB = +process.env.MAX_GROW_KB || 128;

function searchFor(q) {
  return {
    items: Array.from({ length: 20 }, (_, i) => {
      const id = 'q' + pad((q || 'x').length) + 'v' + pad(i);
      return {
        id: { videoId: id },
        snippet: {
          title: 'Result ' + i,
          channelTitle: 'Channel ' + (i % 6),
          channelId: CH[i % 6],
          publishedAt: ago(i + 1),
          thumbnails: { maxres: { url: 'https://i.ytimg.com/vi/' + id + '/maxresdefault.jpg' } },
        },
      };
    }),
  };
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
  if (p.endsWith('/playlistItems')) return PLAYLIST;
  if (p.endsWith('/search')) return searchFor(u.searchParams.get('q') || '');
  return {};
}

async function boot(browser, file) {
  const page = await browser.newPage();
  await page.setViewport({ width: 360, height: 640 });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e.message || e)));
  page.on('console', m => {
    if (m.type() === 'error' && !/ytimg|ggpht|net::ERR/.test(m.text())) errors.push(m.text());
  });
  await page.setRequestInterception(true);
  page.on('request', req => {
    const u = req.url();
    if (u.startsWith('https://' + ORIGIN + '/index.html') || u === 'https://' + ORIGIN + '/') {
      return req.respond({ status: 200, contentType: 'text/html', body: fs.readFileSync(file) });
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
  await sleep(900);
  await page.evaluate(() => {
    const st = document.createElement('style');
    st.textContent = '*{backdrop-filter:none!important;filter:none!important;box-shadow:none!important}';
    document.head.appendChild(st);
  });
  return { page, errors };
}

/* ---------- the measurement ----------
   `collectGarbage` twice: the first pass can leave a second wave of weak
   references dying, and a single pass reports a heap that a leak-free build has
   already half-released. The number that is compared is `JSHeapUsedSize` after
   both. The sizes beside it are the app's own containers, read from the page:
   they are what a leak in this build would grow, and they are cheap enough to
   read every minute. */
async function collect(cdp) {
  await cdp.send('HeapProfiler.collectGarbage');
  await cdp.send('HeapProfiler.collectGarbage');
}
async function sample(page, cdp) {
  await collect(cdp);
  const m = await page.metrics();
  const app = await page.evaluate(() => ({
    elements: document.getElementsByTagName('*').length,
    cards: document.querySelectorAll('.card').length,
    pages: document.querySelectorAll('.page').length,
    imgs: document.images.length,
    v: typeof V !== 'undefined' ? Object.keys(V).length : -1,
    ch: typeof CH !== 'undefined' ? Object.keys(CH).length : -1,
    rq: typeof RQ !== 'undefined' ? RQ.size : -1,
    rqi: typeof RQI !== 'undefined' ? RQI.size : -1,
    chq: typeof CHQ !== 'undefined' ? CHQ.size : -1,
    vq: typeof VQ !== 'undefined' ? VQ.size : -1,
    cavq: typeof CAVQ !== 'undefined' ? CAVQ.size : -1,
    durNone: typeof DUR_NONE !== 'undefined' ? DUR_NONE.size : -1,
    tl: typeof TL !== 'undefined' ? TL.length : -1,
    fall: typeof F_ALL !== 'undefined' ? F_ALL.length : -1,
    hist: typeof S !== 'undefined' ? S.hist.length : -1,
    liked: typeof S !== 'undefined' ? S.liked.length : -1,
    later: typeof S !== 'undefined' ? S.later.length : -1,
    vd: typeof S !== 'undefined' ? Object.keys(S.vd).length : -1,
    frames: typeof framesRun !== 'undefined' ? framesRun : -1,
  }));
  return {
    heapKB: Math.round(m.JSHeapUsedSize / 1024),
    nodes: m.Nodes,
    docs: m.Documents,
    listeners: m.JSEventListeners,
    ...app,
  };
}

/* The measurement's own check, on the same code path as the session: 4 MB of
   retained arrays must be visible in the heap, and must be gone once released. */
async function probe(page, cdp) {
  const before = await sample(page, cdp);
  /* Plain objects and arrays, because they are the only shape that is certain to
     land on the counted heap: a typed array's bytes are external memory, and a
     large string is not in `JSHeapUsedSize` either, so a probe built from either
     would report the same number whether or not the measurement works. 50,000 of
     these is ~4 MB. */
  await page.evaluate(() => {
    const keep = [];
    for (let i = 0; i < 50000; i++) keep.push({ a: i, b: 'p' + i, c: [i, i + 1] });
    window.__ltHeapProbe = keep;
    return keep.length;
  });
  const withHold = await sample(page, cdp);
  await page.evaluate(() => {
    window.__ltHeapProbe = null;
  });
  const afterRelease = await sample(page, cdp);
  return { before, withHold, afterRelease };
}

/* One simulated minute: FPS scroll steps down the active page and back, each one
   followed by the frame it would have asked for through rAF. The scroll is set
   on the page's own scroller, so the app's real capture-phase listener hears it
   and the real `frameRun` does the work — the harness never calls a pass that a
   user's scroll would not. The loop yields every 64 frames so timers, the
   MutationObserver and the garbage collector all get their turn. */
async function minute(page, frames) {
  return page.evaluate(async n => {
    const pg = [...document.querySelectorAll('.page')].find(p => !p.inert);
    if (!pg) return { error: 'no active page' };
    let dir = 1;
    let y = pg.scrollTop;
    const t = performance.now();
    for (let i = 0; i < n; i++) {
      /* One frame per scroll step, exactly as a device runs it: the scroll event
         of the previous step has already asked for a frame through `frameKick`,
         so that request is dropped here and the frame is run once, by hand. Two
         frames per step would double the session's work and halve nothing but
         the harness's own speed. */
      if (frameRaf) { cancelAnimationFrame(frameRaf); frameRaf = 0; }
      y += dir * (12 + (i % 5) * 2);
      const max = Math.max(0, pg.scrollHeight - pg.clientHeight);
      if (y >= max) { y = max; dir = -1; } else if (y <= 0) { y = 0; dir = 1; }
      pg.scrollTop = y;
      /* a tilt sample every half second, the way a hand holding the phone sends
         one: it is what moves the shell and the thumbnail layers off the scroll
         offset, and it is the second input the frame pass reads */
      if (i % 30 === 0) {
        try {
          const g = Math.sin(i / 30) * 0.6;
          window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', { gamma: g, beta: 45 + g * 10 }));
        } catch (e) {}
      }
      frameRun();
      /* The yield lets timers, the MutationObserver and the collector run — and
         with them the frame the scroll event queued a moment ago, which would be
         a second `frameRun` for the same step. It is dropped here for the same
         reason as the one above: one step, one frame. */
      if ((i & 63) === 63) {
        if (frameRaf) { cancelAnimationFrame(frameRaf); frameRaf = 0; }
        await new Promise(r => setTimeout(r, 0));
      }
    }
    return { ms: Math.round(performance.now() - t) };
  }, frames);
}

/* Garbage per frame: 400 frames with no GC in between, so the heap growth is
   what the frame path allocated and dropped, not what it kept. */
async function allocRate(page, cdp) {
  await collect(cdp);
  const a = (await page.metrics()).JSHeapUsedSize;
  const frames = 400;
  await minute(page, frames);
  const b = (await page.metrics()).JSHeapUsedSize;
  await collect(cdp);
  return { frames, kbPerFrame: +(((b - a) / 1024) / frames).toFixed(2) };
}

async function run(browser, file) {
  const { page, errors } = await boot(browser, file);
  const cdp = await page.target().createCDPSession();
  await cdp.send('HeapProfiler.enable');
  const out = { file: path.basename(file), min: [] };

  out.probe = await probe(page, cdp);
  out.boot = await sample(page, cdp);
  out.alloc = await allocRate(page, cdp);

  for (let m = 1; m <= SESSION_MIN; m++) {
    const r = await minute(page, FPS * 60);
    if (r.error) { out.error = r.error; break; }
    const s = await sample(page, cdp);
    s.minute = m;
    s.frameMs = r.ms;
    out.min.push(s);
  }
  out.end = await sample(page, cdp);
  out.errors = errors.slice(0, 6);
  await cdp.detach();
  await page.close();
  return out;
}

const fmt = n => (n == null ? '—' : String(n));
const kb = n => (n >= 0 ? '+' : '') + n + ' KB';

function report(o) {
  console.log('\n== ' + o.file);
  const p = o.probe;
  console.log(
    '  probe      ' + p.before.heapKB + ' KB → hold 4 MB → ' + p.withHold.heapKB +
      ' KB → release → ' + p.afterRelease.heapKB + ' KB  (Δ ' +
      kb(p.withHold.heapKB - p.before.heapKB) + ' / ' +
      kb(p.afterRelease.heapKB - p.before.heapKB) + ')'
  );
  console.log('  boot       ' + o.boot.heapKB + ' KB  nodes ' + o.boot.nodes + '  elements ' + o.boot.elements);
  console.log('  alloc      ' + o.alloc.kbPerFrame + ' KB/frame over ' + o.alloc.frames + ' frames');
  console.log('  minute   heap     Δmin1   nodes  elements  cards  imgs   V   CH   RQ  CHQ   VQ  F_ALL');
  o.min.forEach(s => {
    const d = o.min.length ? s.heapKB - o.min[0].heapKB : 0;
    console.log(
      '  ' + String(s.minute).padStart(6) + '  ' + String(s.heapKB).padStart(6) + '  ' +
      String(kb(d)).padStart(6) + '  ' + String(s.nodes).padStart(6) + '  ' +
      String(s.elements).padStart(8) + '  ' + String(s.cards).padStart(5) + '  ' +
      String(s.imgs).padStart(4) + '  ' + String(s.v).padStart(3) + '  ' +
      String(s.ch).padStart(3) + '  ' + String(s.rq).padStart(3) + '  ' +
      String(s.chq).padStart(4) + '  ' + String(s.vq).padStart(4) + '  ' +
      String(s.fall).padStart(6)
    );
  });
  console.log('  end        ' + o.end.heapKB + ' KB  nodes ' + o.end.nodes +
    '  app frames ' + o.end.frames.toLocaleString('en-US'));
  if (o.error) console.log('  error      ' + o.error);
  if (o.errors && o.errors.length) console.log('  errors     ' + o.errors.join(' | '));
}

(async () => {
  const files = process.argv.slice(2);
  if (!files.length) {
    console.error('usage: node tools/heap-scroll-check.js <build-a.html> [build-b.html]');
    process.exit(2);
  }
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME || '/usr/local/bin/chromium',
    headless: true,
    /* A 360x640 viewport: the smallest phone this app is likely to run on, and
       the one where a scroll frame costs the least. The session is measured at
       the size that makes the frame cheapest, so a run fits in the time a single
       command is allowed — the heap question does not depend on the viewport. */
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--js-flags=--expose-gc', '--window-size=360,640'],
  });
  const results = [];
  for (const f of files) results.push(await run(browser, f));
  await browser.close();
  results.forEach(report);

  const a = results[0];
  const b = results[1] || null;
  const first = a.min[0];
  const last = a.min[a.min.length - 1];
  console.log('\n== verdict (' + a.file + ', ' + SESSION_MIN + ' min, ' +
    (SESSION_MIN * FPS * 60).toLocaleString('en-US') + ' frames)');
  const fail = [];
  const check = (ok, msg) => {
    console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + msg);
    if (!ok) fail.push(msg);
  };
  check(
    a.probe.withHold.heapKB - a.probe.before.heapKB >= 3000 &&
      a.probe.afterRelease.heapKB - a.probe.before.heapKB <= 256,
    'the measurement sees 4 MB held and released (' +
      kb(a.probe.withHold.heapKB - a.probe.before.heapKB) + ' → ' +
      kb(a.probe.afterRelease.heapKB - a.probe.before.heapKB) + ')'
  );
  check(!a.error, 'the session ran to the end (' + (a.error || 'ok') + ')');
  check(a.min.length === SESSION_MIN, 'every minute was sampled (' + a.min.length + '/' + SESSION_MIN + ')');
  check(
    last.heapKB - first.heapKB <= MAX_GROW_KB,
    'heap grows no more than ' + MAX_GROW_KB + ' KB from minute 1 to minute ' +
      SESSION_MIN + ' (' + kb(last.heapKB - first.heapKB) + ')'
  );
  const worst = a.min.slice(1).reduce((w, s, i) => {
    const d = s.heapKB - a.min[i].heapKB;
    return d > w.d ? { d, m: s.minute } : w;
  }, { d: 0, m: 1 });
  check(worst.d <= 64, 'no minute adds more than 64 KB (' + kb(worst.d) + ' at minute ' + worst.m + ')');
  check(
    a.min.every(s => s.elements === first.elements && s.cards === first.cards),
    'the live tree never grows (' + first.elements + ' elements, ' + first.cards + ' cards throughout)'
  );
  check(
    a.min.every(s => s.v === first.v && s.ch === first.ch && s.rq === first.rq &&
      s.chq === first.chq && s.vq === first.vq),
    'every app map holds its size (V ' + first.v + ', CH ' + first.ch + ', RQ ' + first.rq +
      ', CHQ ' + first.chq + ', VQ ' + first.vq + ')'
  );
  check(a.end.docs === 1, 'one document for the whole session (' + a.end.docs + ')');
  check(!(a.errors && a.errors.length), 'no page errors (' + (a.errors || []).length + ')');
  if (b) {
    const bf = b.min[0], bl = b.min[b.min.length - 1];
    console.log(
      '  info  ' + b.file + ': heap ' + b.boot.heapKB + ' → ' + bf.heapKB + ' → ' + bl.heapKB +
        ' KB, alloc ' + b.alloc.kbPerFrame + ' KB/frame, nodes ' + b.end.nodes
    );
  }
  process.exit(fail.length ? 1 : 0);
})().catch(e => {
  console.error(e);
  process.exit(2);
});
