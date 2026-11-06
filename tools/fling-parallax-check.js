#!/usr/bin/env node
/*
 * LiquidTube fling-gate check — item 3.7.
 *
 * A fling is momentum: the finger is up and the page is still travelling. The
 * per-card parallax layer (one rect + one transform per thumbnail on screen) is
 * decoration that is invisible at that speed, so the build under test turns it
 * off while a fling is in progress and re-syncs it on a coarse cadence. This
 * tool measures, on a real browser with the API mocked:
 *
 *  1. `fling` — what the frames of a simulated fling actually cost: thumbnail
 *     rect reads, thumbnail style writes, card rect reads, card writes, shell
 *     writes, and how many frames ran. The build under test should read and
 *     write far fewer thumbnails and the same number of cards and shell layers.
 *
 *  2. `rest` — every thumbnail's inline transform once the fling has stopped.
 *     Two builds must agree exactly: the gate may skip frames, it may not leave
 *     the layer anywhere else than where it belongs.
 *
 *  3. `drag` — the same motion with a finger on the glass. A drag is not a
 *     fling, so the layer must run every frame and the two builds must match
 *     frame for frame.
 *
 *  4. `abrupt` — a fling that ends without a slow frame (it runs into a stop at
 *     speed). The idle timer has to close the gate and re-sync the layer with no
 *     further scrolling, or the thumbnails stay stale for good.
 *
 * The scroll script is stepped by fixed increments of one frame's worth of
 * travel, so both builds visit the same scroll positions in the same order and
 * their end states are comparable.
 *
 * Usage:
 *   npm i puppeteer-core                    # dev only, not shipped in the APK
 *   CHROME=/path/to/chrome node tools/fling-parallax-check.js <build-a.html> [build-b.html]
 * Prints one JSON object per build; with two builds it also compares them.
 */
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const ORIGIN = 'liquidtube.local';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const pad = n => String(n).padStart(2, '0');
const vids = Array.from({ length: 24 }, (_, i) => 'v' + pad(i + 1) + 'AAAAAAAA');
const CH = Array.from({ length: 6 }, (_, i) => 'UC' + i + 'xxxxxxxxxxxxxxxxxxxx');
const ago = h => new Date(Date.now() - h * 36e5).toISOString();
const F = {
  videos: { items: vids.map((id, i) => ({ id, snippet: { title: 'Video ' + i, channelTitle: 'Channel ' + (i % 6), channelId: CH[i % 6], publishedAt: ago(i + 1), categoryId: '10', thumbnails: { maxres: { url: 'https://i.ytimg.com/vi/' + id + '/maxresdefault.jpg' } } }, statistics: { viewCount: '1000' } })) },
  durations: { items: vids.map(id => ({ id, contentDetails: { duration: 'PT12M30S' } })) },
  channels: { items: CH.map((id, i) => ({ id, snippet: { title: 'Channel ' + i, customUrl: 'c' + i, publishedAt: '2015-04-02T10:00:00Z', thumbnails: { medium: { url: 'https://yt3.ggpht.com/a' + i + '.jpg' } } }, statistics: { subscriberCount: '1', videoCount: '1', viewCount: '1' }, contentDetails: { relatedPlaylists: { uploads: 'UU' + id } }, brandingSettings: { image: {}, channel: {} } })) },
  playlistItems: { items: vids.slice(0, 12).map((id, i) => ({ snippet: { title: 'P' + i, resourceId: { videoId: id }, publishedAt: ago(i * 24) }, contentDetails: { videoPublishedAt: ago(i * 24) } })) },
  search: { items: [] },
};
function chanAnswer(url, base) {
  const U = typeof url === 'string' ? new URL(url) : url;
  const want = String(U.searchParams.get('id') || '').split(',').filter(Boolean);
  if (!want.length) return base;
  const have = new Map(base.items.map(c => [c.id, c]));
  return {
    items: want.map(id => have.get(id) || {
      id,
      snippet: { title: 'Channel ' + id.slice(2, 8), customUrl: 'c' + id.slice(2, 8), publishedAt: '2015-04-02T10:00:00Z', country: 'IN', description: 'A sample channel.', thumbnails: { medium: { url: 'https://yt3.ggpht.com/' + id + '.jpg' } } },
      statistics: { subscriberCount: '1000', videoCount: '10', viewCount: '10000' },
      contentDetails: { relatedPlaylists: { uploads: 'UU' + id.slice(2) } },
      brandingSettings: { image: { bannerExternalUrl: '' }, channel: {} },
    }),
  };
}
function apiBody(url) {
  const u = new URL(url);
  const p = u.pathname;
  if (p.endsWith('/videos')) return (u.searchParams.get('part') || '').includes('contentDetails') ? F.durations : F.videos;
  if (p.endsWith('/channels')) return chanAnswer(u, F.channels);
  if (p.endsWith('/playlistItems')) return F.playlistItems;
  if (p.endsWith('/search')) return F.search;
  return {};
}

async function boot(browser, file) {
  const HTML = fs.readFileSync(file);
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e.message).slice(0, 160)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 160)); });
  await page.setViewport({ width: 412, height: 892, deviceScaleFactor: 2 });
  await page.setRequestInterception(true);
  page.on('request', req => {
    const u = req.url();
    if (u.startsWith('https://' + ORIGIN + '/')) return req.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: HTML });
    if (/googleapis\.com/.test(u)) return req.respond({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(apiBody(u)) });
    if (/ytimg\.com|ggpht\.com|googleusercontent\.com/.test(u)) return req.respond({ status: 200, contentType: 'image/png', body: PNG });
    return req.abort();
  });
  await page.goto('https://' + ORIGIN + '/index.html', { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction('document.querySelectorAll("#feed .card").length > 0', { timeout: 60000 });
  await page.waitForFunction('!document.querySelector("#ex .skl")', { timeout: 60000 });
  await sleep(600);
  /* Software rasterisation is what makes this page 3 fps in a headless browser,
     and a 3 fps frame cannot show what a fling costs on a device. Paint-only
     properties are neutralised so the frame rate is a device's: none of them
     affects layout, so every rect the passes measure and every element they walk
     is unchanged, and both builds get the same treatment. */
  await page.evaluate(() => {
    const st = document.createElement('style');
    st.textContent = '*{backdrop-filter:none!important;filter:none!important;box-shadow:none!important;text-shadow:none!important}.page{background-image:none!important}';
    document.head.appendChild(st);
  });
  await page.evaluate(() => {
    const W = window;
    const C = { thumb: 0, card: 0, shell: 0, frames: 0 };
    W.__c = C;
    const kind = el => {
      if (!el || !el.classList) return null;
      if (el.classList.contains('thumb')) return 'thumb';
      if (el.classList.contains('card')) return 'card';
      if (el.classList.contains('top') || el.classList.contains('chips') || el.classList.contains('dock') || el.classList.contains('page')) return 'shell';
      return null;
    };
    /* Rects, by what was measured. The thumbnail layer's read is the one on
       `.thumb` (the image's parent) — see the frame's read pass. */
    const gr = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function () {
      const k = kind(this);
      if (k) C[k]++;
      return gr.call(this);
    };
    /* Style writes, by what was written. A MutationObserver is the browser's own
       view of "this element's style attribute changed", which is the cost. */
    new MutationObserver(recs => {
      for (const r of recs) {
        const k = kind(r.target) || (r.target.parentElement ? kind(r.target.parentElement) : null);
        if (k) C[k + 'W'] = (C[k + 'W'] || 0) + 1;
      }
    }).observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['style'] });
    W.__resetC = () => { for (const k in C) C[k] = 0; };
    /* What every layer currently renders, so two builds can be compared. */
    W.__faces = () => {
      const pg = document.querySelector('.page:not([inert])');
      const s = e => (e ? [e.style.transform, e.style.opacity, e.style.backgroundPositionY].join('~') : '');
      /* `seen` marks the thumbnails whose card is on screen: those are the ones
         a difference is visible in. A card off screen keeps whatever inline
         transform it last had until the frame that brings it back, which
         rewrites it — `reveal` below is the check that it does. */
      const seen = [...pg.querySelectorAll('.thumb img')].map(i => {
        const c = i.closest('.card');
        if (!c) return false;
        const r = c.getBoundingClientRect();
        return r.bottom > -80 && r.top < innerHeight + 80;
      });
      return {
        seen,
        thumbs: [...pg.querySelectorAll('.thumb img')].map(s),
        cards: [...pg.querySelectorAll('.card')].map(s),
        shell: [s(pg), s(pg.querySelector('.top')), s(pg.querySelector('.chips')), s(document.querySelector('.dock'))],
        scrollTop: Math.round(pg.scrollTop * 100) / 100,
      };
    };
    /* A fling, stepped by fixed one-frame travel so both builds visit exactly the
       same scroll positions. `decel` is px/s per s; the loop stops at v0/… or
       when it has run `max` frames. `abrupt` ends the loop at high speed, which
       is the case the idle timer exists for. */
    W.__fling = (v0, decel, abrupt, max) => new Promise(res => {
      const pg = document.querySelector('.page:not([inert])');
      const dt = 1 / 60;
      let v = v0, i = 0;
      const trace = [];
      const step = () => {
        v = Math.max(0, v - decel * dt);
        pg.scrollTop = pg.scrollTop + v * dt;
        i++;
        trace.push(pg.scrollTop);
        if (i < (max || 400) && (abrupt ? v > 1500 : v > 40)) requestAnimationFrame(step);
        else {
          /* The two builds must be compared at the same sub-pixel offset: a
             fractional scrollTop of 6243.4 vs 6243.6 moves every rect by a
             fifth of a pixel and changes the depth transform in its last
             digit, which would read as a behavioural difference. */
          if (!abrupt) pg.scrollTop = Math.round(pg.scrollTop);
          /* One frame later, still inside the page: the pass for the last step
             has run by then, and a CDP round trip (~100 ms on a busy page) would
             let the idle timer's pass land before the sample is taken. */
          requestAnimationFrame(() => requestAnimationFrame(() =>
            res({ frames: i, px: Math.round(pg.scrollTop), exact: pg.scrollTop, trace, atStop: window.__faces() })));
        }
      };
      requestAnimationFrame(step);
    });
    W.__finger = on => {
      const ev = new Event(on ? 'touchstart' : 'touchend');
      Object.defineProperty(ev, 'touches', { value: on ? [{}] : [] });
      document.dispatchEvent(ev);
    };
  });
  return { page, errors };
}

const frames = (page, n = 3) => page.evaluate(n => new Promise(r => {
  let i = 0;
  const step = () => (++i >= n ? r() : requestAnimationFrame(step));
  requestAnimationFrame(step);
}), n);

async function run(browser, file) {
  const { page, errors } = await boot(browser, file);
  const out = { file: path.basename(file) };

  /* ---- 0. a fling: finger down, lift, momentum ---- */
  await page.evaluate(() => { window.__finger(true); });
  await frames(page, 2);
  await page.evaluate(() => { window.__finger(false); window.__resetC(); });
  const fl = await page.evaluate(() => window.__fling(4200, 1300, false, 400));
  await frames(page, 3);
  await sleep(300);
  const fC = await page.evaluate(() => Object.assign({}, window.__c));
  out.fling = {
    frames: fl.frames,
    px: fl.px,
    thumbRects: fC.thumb,
    thumbWrites: fC.thumbW || 0,
    cardRects: fC.card,
    cardWrites: fC.cardW || 0,
    shellWrites: fC.shellW || 0,
  };
  out.rest = await page.evaluate(() => window.__faces());

  /* ---- 1. the same motion with the finger still on the glass ---- */
  await page.evaluate(() => { const pg = document.querySelector('.page:not([inert])'); pg.scrollTop = 0; });
  await frames(page, 3);
  await sleep(200);
  await page.evaluate(() => { window.__finger(true); });
  await frames(page, 2);
  await page.evaluate(() => { window.__resetC(); });
  const dg = await page.evaluate(() => window.__fling(4200, 1300, false, 400));
  await frames(page, 3);
  await sleep(200);
  const dC = await page.evaluate(() => Object.assign({}, window.__c));
  out.drag = {
    frames: dg.frames,
    px: dg.px,
    thumbRects: dC.thumb,
    thumbWrites: dC.thumbW || 0,
    cardRects: dC.card,
    shellWrites: dC.shellW || 0,
  };
  out.dragRest = await page.evaluate(() => window.__faces());
  await page.evaluate(() => { window.__finger(false); });
  await frames(page, 3);

  /* ---- 1b. what a skipped frame left behind, once it is on screen again ---- */
  await page.evaluate(() => { const pg = document.querySelector('.page:not([inert])'); pg.scrollTop = 1200; });
  await frames(page, 4);
  await sleep(300);
  out.reveal = await page.evaluate(() => window.__faces());

  /* ---- 2. flings that end at speed: nothing may stay stale ----
     Three of them, because whether the gate happens to be holding a stale layer
     when the fling stops depends on where in its re-sync cadence it stopped: one
     trial can land on a frame that had just been re-synced. Each trial is
     sampled at the stop, then again after the page has been still for 700 ms —
     no scroll in between, so the only thing that can run is the idle timer. */
  out.abrupt = [];
  const trials = [[5000, 900], [6000, 1500], [4500, 1200]];
  for (const [v0, decel] of trials) {
    await page.evaluate(() => { const pg = document.querySelector('.page:not([inert])'); pg.scrollTop = 0; });
    await frames(page, 3);
    await sleep(250);
    await page.evaluate(() => { window.__finger(true); });
    await frames(page, 2);
    await page.evaluate(() => { window.__finger(false); window.__resetC(); });
    const ab = await page.evaluate(([v0, decel]) => window.__fling(v0, decel, true, 400), [v0, decel]);
    const atStop = ab.atStop;
    const c = await page.evaluate(() => Object.assign({}, window.__c));
    await sleep(800);                     /* no scroll: only the idle timer runs */
    const settled = await page.evaluate(() => window.__faces());
    out.abrupt.push({
      v0, decel, frames: ab.frames, px: ab.px,
      thumbRects: c.thumb,
      atStop,
      settled,
      /* did the layer move between the stop and the idle pass? A build with no
         gate must answer 0 on every trial — it was exact at the stop already. */
      movedAtIdle: atStop.thumbs.filter((t, i) => t !== settled.thumbs[i]).length,
      onScreenAtStop: atStop.thumbs.filter((_, i) => atStop.seen[i]),
      onScreenSettled: settled.thumbs.filter((_, i) => settled.seen[i]),
    });
  }
  /* ---- 3. one fast frame, then nothing: the idle timer, on its own ----
     Two frames that move the page 400 px each are a fling of 25 000 px/s, so the
     thumbnail layer is skipped for the second — and then no scroll ever arrives
     again.
     What is checked is the invariant that matters: the layer is exact at rest
     with no further scrolling. In a browser that always sends one trailing
     scroll event the correction arrives on that frame (the gate closes on a
     velocity of zero); the idle timer is the fallback for a fling that ends
     without one, and it is what the `movedAtIdle` column would show if this
     browser had not sent that frame. */
  await page.evaluate(() => { const pg = document.querySelector('.page:not([inert])'); pg.scrollTop = 0; });
  await frames(page, 3);
  await sleep(250);
  await page.evaluate(() => { window.__finger(true); });
  await frames(page, 2);
  await page.evaluate(() => { window.__finger(false); window.__resetC(); });
  await frames(page, 2);
  /* Two of them: the first fast frame after an idle period is always re-synced
     (the layer is owed a pass, and its signature says so), so it takes a second
     gated frame — which the cadence is allowed to skip — to leave the layer
     stale and hand the repair to the idle timer. */
  const jumpAt = await page.evaluate(() => new Promise(res => {
    const pg = document.querySelector('.page:not([inert])');
    requestAnimationFrame(() => {
      pg.scrollTop = pg.scrollTop + 400;
      requestAnimationFrame(() => {
        pg.scrollTop = pg.scrollTop + 400;
        requestAnimationFrame(() => requestAnimationFrame(() => res(window.__faces())));
      });
    });
  }));
  const jumpC = await page.evaluate(() => Object.assign({}, window.__c));
  await sleep(900);                       /* nothing scrolls again */
  const jumpAfter = await page.evaluate(() => window.__faces());
  out.jump = {
    px: jumpAfter.scrollTop,
    atStop: jumpAt,
    after: jumpAfter,
    movedAtIdle: jumpAt.thumbs.filter((t, i) => t !== jumpAfter.thumbs[i]).length,
    thumbRects: jumpC.thumb, cardRects: jumpC.card, shellWrites: jumpC.shellW || 0,
    onScreenAtStop: jumpAt.thumbs.filter((_, i) => jumpAt.seen[i]),
    onScreenAfter: jumpAfter.thumbs.filter((_, i) => jumpAfter.seen[i]),
  };

  out.errors = errors;
  await page.close();
  return out;
}

(async () => {
  const files = process.argv.slice(2);
  if (!files.length) { console.error('usage: node tools/fling-parallax-check.js <build-a.html> [build-b.html]'); process.exit(2); }
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME || '/usr/bin/google-chrome',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--hide-scrollbars'],
  });
  const results = [];
  for (const f of files) results.push(await run(browser, f));
  await browser.close();

  const onScreen = f => f.thumbs.filter((_, i) => f.seen[i]);
  const offScreen = f => f.thumbs.filter((_, i) => !f.seen[i]);
  /* Two runs of the *same* build do not agree to the digit: the page is laid out
     on a fractional scroll offset and a card can sit half a pixel apart between
     two browser pages, which moves a depth transform's last decimal and a
     thumbnail offset by a few hundredths of a percent. So rendering is compared
     on the numbers, with a tolerance of 0.15 in their own units (0.15 % of a
     thumbnail, 0.15 px of translate, 0.002 of scale/opacity) — well under a
     visible amount, and an order of magnitude above the run-to-run noise. The
     noise floor is printed by running the tool with one file twice. */
  const TOL = 0.15;
  const nums = v => (String(v).match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
  const diff = (a = [], b = []) => {
    if (a.length !== b.length) return { mismatch: a.length + ' vs ' + b.length };
    let over = 0, worst = 0;
    for (let i = 0; i < a.length; i++) {
      const x = nums(a[i]), y = nums(b[i]);
      if (x.length !== y.length) { over++; continue; }
      let d = 0;
      for (let j = 0; j < x.length; j++) d = Math.max(d, Math.abs(x[j] - y[j]));
      if (d > TOL) over++;
      worst = Math.max(worst, d);
    }
    return { over: over, of: a.length, worst: +worst.toFixed(3) };
  };
  const ok = d => d.over === 0;
  const pct = (a, b) => (a ? Math.round((1 - b / a) * 100) + '% fewer' : '');

  if (results.length === 2) {
    const [A, B] = results;
    const same = A.fling.px === B.fling.px && A.drag.px === B.drag.px && A.abrupt.px === B.abrupt.px;
    const cmp = {
      'fling — thumb rect reads': A.fling.thumbRects + ' → ' + B.fling.thumbRects + '  (' + pct(A.fling.thumbRects, B.fling.thumbRects) + ')',
      'fling — thumb style writes': A.fling.thumbWrites + ' → ' + B.fling.thumbWrites + '  (' + pct(A.fling.thumbWrites, B.fling.thumbWrites) + ')',
      'fling — card rect reads (depth pass, not gated)': A.fling.cardRects + ' → ' + B.fling.cardRects,
      'fling — card writes (depth pass, not gated)': A.fling.cardWrites + ' → ' + B.fling.cardWrites,
      'fling — shell writes (backdrop never frozen)': A.fling.shellWrites + ' → ' + B.fling.shellWrites,
      'fling — frames': A.fling.frames + ' → ' + B.fling.frames,
      'same scroll positions': same,
      'rest: thumbnails on screen': JSON.stringify(diff(onScreen(A.rest), onScreen(B.rest))),
      'rest: cards': JSON.stringify(diff(A.rest.cards, B.rest.cards)),
      'rest: shell': JSON.stringify(diff(A.rest.shell, B.rest.shell)),
      'rest: thumbnails off screen (not rendered until scrolled back)': JSON.stringify(diff(offScreen(A.rest), offScreen(B.rest))),
      'reveal: thumbnails identical once back on screen': JSON.stringify(diff(onScreen(A.reveal), onScreen(B.reveal))),
      'drag: thumbnails (a drag is never gated)': JSON.stringify(diff(onScreen(A.dragRest), onScreen(B.dragRest))),
      'drag: cards': JSON.stringify(diff(A.dragRest.cards, B.dragRest.cards)),
      'drag: thumb rect reads (unchanged)': A.drag.thumbRects + ' → ' + B.drag.thumbRects,
      'abrupt stop: settled with no further scroll, per trial':
        A.abrupt.map((t, i) => JSON.stringify(diff(t.onScreenSettled, B.abrupt[i].onScreenSettled))).join(' '),
      'abrupt stop: thumbnails that moved on the idle pass':
        A.abrupt.map(t => t.movedAtIdle).join(',') + ' → ' + B.abrupt.map(t => t.movedAtIdle).join(','),
      'abrupt stop: thumb rect reads during the fling':
        A.abrupt.map(t => t.thumbRects).join(',') + ' → ' + B.abrupt.map(t => t.thumbRects).join(','),
      'idle timer: thumb rect reads / card reads / shell writes':
        [A.jump.thumbRects, A.jump.cardRects, A.jump.shellWrites].join('/') + ' → ' +
        [B.jump.thumbRects, B.jump.cardRects, B.jump.shellWrites].join('/'),
      'idle timer: thumbnails that moved on the idle pass': A.jump.movedAtIdle + ' → ' + B.jump.movedAtIdle,
      'idle timer: settled with no further scroll': JSON.stringify(diff(A.jump.onScreenAfter, B.jump.onScreenAfter)),
      'idle timer: was it stale at the stop?': JSON.stringify(diff(A.jump.onScreenAtStop, B.jump.onScreenAtStop)),
      'abrupt stop: same scroll offsets':
        A.abrupt.every((t, i) => t.px === B.abrupt[i].px),
      'console errors': JSON.stringify([A.errors.length, B.errors.length]),
    };
    console.log('\n=== comparison (rendering tolerance ' + TOL + ') ===');
    for (const k in cmp) console.log(k.padEnd(56), cmp[k]);
    const pass =
      B.fling.thumbRects < A.fling.thumbRects * 0.5 &&
      B.fling.thumbWrites < A.fling.thumbWrites * 0.5 &&
      Math.abs(B.fling.cardRects - A.fling.cardRects) <= 5 * 24 &&
      Math.abs(B.fling.shellWrites - A.fling.shellWrites) <= 2 &&
      same &&
      ok(diff(onScreen(A.rest), onScreen(B.rest))) &&
      ok(diff(A.rest.cards, B.rest.cards)) &&
      ok(diff(A.rest.shell, B.rest.shell)) &&
      ok(diff(onScreen(A.reveal), onScreen(B.reveal))) &&
      ok(diff(onScreen(A.dragRest), onScreen(B.dragRest))) &&
      Math.abs(A.drag.thumbRects - B.drag.thumbRects) <= 5 &&
      A.abrupt.every((t, i) => ok(diff(t.onScreenSettled, B.abrupt[i].onScreenSettled))) &&
      A.abrupt.every((t, i) => t.px === B.abrupt[i].px) &&
      A.abrupt.every(t => t.movedAtIdle === 0) &&
      ok(diff(A.jump.onScreenAfter, B.jump.onScreenAfter)) &&
      A.errors.length === 0 && B.errors.length === 0;
    console.log('\npass:', pass);
  }
})();
