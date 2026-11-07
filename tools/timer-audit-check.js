#!/usr/bin/env node
/*
 * LiquidTube timer audit — item 4.1 ("audit every setInterval and clear it when
 * unused").
 *
 * The audit's first finding is that the build schedules **no `setInterval` at
 * all**: every repeating thing it does is a timer that re-arms itself, and there
 * is exactly one of those (the fling gate's idle check). So the item is really
 * about the other half of the sentence — a timer that outlives the work it was
 * armed for. Several did: the per-render depth kick, the chip swap, the search
 * caret, the card release and the boot hard stops were anonymous `setTimeout`s
 * with no handle, so a newer state could not cancel the older timer and a fast
 * enough user could have several pending at once.
 *
 * This tool counts timers on a real browser with the API mocked, and reports per
 * build:
 *
 *   intervals   how many `setInterval` calls the app made (0 is the point)
 *   rest        the timers still pending once boot has settled, by delay
 *   chipBurst   five taps along the chip row inside one swap window: timers
 *               created, feed renders actually written, frames requested. One
 *               timer and one render is the fixed shape
 *   tiltRegrip  a card touched again inside the 260 ms release window: is `.tilt`
 *               — its transition and its layer hint — still on the card 320 ms
 *               into the second gesture?
 *   searchCancel  the search panel cancelled 60 ms after opening: does the caret
 *               still land in the field that is no longer on screen?
 *   fling       timer arms of the fling gate while flinging, and arms after the
 *               document goes hidden (the only interval-shaped work in the app)
 *   session     twenty tab switches, chips, sheets, search and toasts, then the
 *               timers left pending: nothing may accumulate
 *
 * Usage:
 *   npm i puppeteer-core                    # dev only, not shipped in the APK
 *   CHROME=/path/to/chrome node tools/timer-audit-check.js <build-a.html> [build-b.html]
 * Prints one JSON object per build; with two builds it also compares them.
 * Exit code 1 when the build under test — the first file — fails any of the
 * checks above.
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
/* The settle before the at-rest reading: long enough for the deferred sheet's
   3 s one-shot and the boot log's 12 s last resort to have fired. SETTLE=900
   shortens it while iterating on the tool itself. */
const SETTLE = +process.env.SETTLE || 12500;
const pad = n => String(n).padStart(2, '0');
const vids = Array.from({ length: 24 }, (_, i) => 'v' + pad(i + 1) + 'AAAAAAAA');
const CH = Array.from({ length: 6 }, (_, i) => 'UC' + i + 'xxxxxxxxxxxxxxxxxxxx');
const ago = h => new Date(Date.now() - h * 36e5).toISOString();

const F = {
  videos: {
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
  },
  durations: { items: vids.map(id => ({ id, contentDetails: { duration: 'PT12M30S' } })) },
  channels: {
    items: CH.map((id, i) => ({
      id,
      snippet: {
        title: 'Channel ' + i,
        customUrl: 'c' + i,
        publishedAt: '2015-04-02T10:00:00Z',
        thumbnails: { medium: { url: 'https://yt3.ggpht.com/a' + i + '.jpg' } },
      },
      statistics: { subscriberCount: '1', videoCount: '1', viewCount: '1' },
      contentDetails: { relatedPlaylists: { uploads: 'UU' + id } },
      brandingSettings: { image: {}, channel: {} },
    })),
  },
  playlistItems: {
    items: vids.slice(0, 12).map((id, i) => ({
      snippet: { title: 'P' + i, resourceId: { videoId: id }, publishedAt: ago(i * 24) },
      contentDetails: { videoPublishedAt: ago(i * 24) },
    })),
  },
  search: { items: [] },
};
function chanAnswer(url, base) {
  const U = typeof url === 'string' ? new URL(url) : url;
  const want = String(U.searchParams.get('id') || '').split(',').filter(Boolean);
  if (!want.length) return base;
  const have = new Map(base.items.map(c => [c.id, c]));
  return {
    items: want.map(
      id =>
        have.get(id) || {
          id,
          snippet: {
            title: 'Channel ' + id.slice(2, 8),
            customUrl: 'c' + id.slice(2, 8),
            publishedAt: '2015-04-02T10:00:00Z',
            country: 'IN',
            description: 'A sample channel.',
            thumbnails: { medium: { url: 'https://yt3.ggpht.com/' + id + '.jpg' } },
          },
          statistics: { subscriberCount: '1000', videoCount: '10', viewCount: '10000' },
          contentDetails: { relatedPlaylists: { uploads: 'UU' + id.slice(2) } },
          brandingSettings: { image: { bannerExternalUrl: '' }, channel: {} },
        }
    ),
  };
}
function apiBody(url) {
  const u = new URL(url);
  const p = u.pathname;
  if (p.endsWith('/videos'))
    return (u.searchParams.get('part') || '').includes('contentDetails') ? F.durations : F.videos;
  if (p.endsWith('/channels')) return chanAnswer(u, F.channels);
  if (p.endsWith('/playlistItems')) return F.playlistItems;
  if (p.endsWith('/search')) return F.search;
  return {};
}

/* The census has to start before the app's own scripts run, so the wrappers go in
   as an init script. Everything the harness itself needs goes through the raw
   references kept on `__raw`, so no harness frame or harness timer is ever
   counted as the app's. */
function instrument() {
  const W = window;
  const live = new Map(); // id -> { kind, delay, at, where }
  const S = { set: 0, cleared: 0, intervals: 0, intervalsCleared: 0, fired: 0, raf: 0, byDelay: {} };
  const rawSet = W.setTimeout.bind(W);
  const rawClear = W.clearTimeout.bind(W);
  const rawRaf = W.requestAnimationFrame.bind(W);
  const rawCancel = W.cancelAnimationFrame.bind(W);
  W.__raw = { set: rawSet, clear: rawClear, raf: rawRaf, cancel: rawCancel };
  /* The frame the stack names is the caller's, not this wrapper's. */
  const where = () => {
    const l = String(new Error().stack || '').split('\n')[2] || '';
    const m = l.match(/at\s+([^\s(]+)/);
    return m ? m[1] : '?';
  };
  const note = (delay, fn) => {
    S.set++;
    const k = String(delay);
    S.byDelay[k] = (S.byDelay[k] || 0) + 1;
    return k;
  };
  W.setTimeout = function (fn, delay, ...rest) {
    const k = note(delay, fn);
    const id = rawSet(
      function () {
        live.delete(id);
        S.fired++;
        return typeof fn === 'function' ? fn.apply(this, arguments) : undefined;
      },
      delay,
      ...rest
    );
    live.set(id, { kind: 'timeout', delay: k, at: Date.now(), where: where() });
    return id;
  };
  W.clearTimeout = function (id) {
    if (live.has(id)) {
      live.delete(id);
      S.cleared++;
    }
    return rawClear(id);
  };
  /* The app schedules none of these; the wrapper exists so the audit can say so
     with a number instead of a grep. */
  const rawSetInterval = W.setInterval.bind(W);
  const rawClearInterval = W.clearInterval.bind(W);
  W.setInterval = function (fn, delay, ...rest) {
    S.intervals++;
    const k = String(delay);
    S.byDelay[k] = (S.byDelay[k] || 0) + 1;
    return rawSetInterval(fn, delay, ...rest);
  };
  W.clearInterval = function (id) {
    S.intervalsCleared++;
    return rawClearInterval(id);
  };
  /* Counted, never used: the app asks for its frames through the wrapper so a
     burst can be counted per action. */
  W.requestAnimationFrame = function (cb) {
    S.raf++;
    return rawRaf(cb);
  };
  W.cancelAnimationFrame = function (id) {
    return rawCancel(id);
  };

  /* Feed writes: a render replaces #feed's children, so a childList record is one
     render. Batched per task by the observer, which is exactly what a burst of
     separate timers produces one record each. */
  W.__feedWrites = 0;
  const arm = () => {
    const f = document.getElementById('feed');
    if (!f) return rawSet(arm, 10);
    new MutationObserver(rs => {
      W.__feedWrites += rs.filter(r => r.type === 'childList').length;
    }).observe(f, { childList: true });
  };
  arm();

  W.__stats = () => ({ ...S, live: live.size });
  W.__liveBy = d => [...live.values()].filter(t => t.delay === String(d)).length;
  W.__live = () =>
    [...live.values()].map(t => ({ delay: t.delay, where: t.where, age: Date.now() - t.at })).sort((a, b) => +b.delay - +a.delay);
  W.__reset = () => {
    S.set = 0;
    S.cleared = 0;
    S.fired = 0;
    S.raf = 0;
    S.byDelay = {};
    W.__feedWrites = 0;
  };
  W.__read = () => ({ set: S.set, cleared: S.cleared, fired: S.fired, raf: S.raf, byDelay: S.byDelay, feedWrites: W.__feedWrites, live: live.size });

  /* ---- the actions, all dispatched as the browser would deliver them ---- */
  const pg = () => document.querySelector('.page:not([inert])');
  /* The three custom chips (Anime/Cartoon/Movies) fetch a section instead of
     filtering what is already there, so a burst along them measures the network,
     not the swap. This taps the plain category chips, which is the path the swap
     timer belongs to. */
  W.__chipBurst = n => {
    const custom = ['Anime', 'Cartoon', 'Movies'];
    const chips = [...pg().querySelectorAll('.chips .chip')].filter(c => !custom.includes(c.textContent));
    const want = chips.slice(0, Math.min(n, chips.length));
    want.forEach(c => c.click());
    return want.length;
  };
  W.__tabs = n => {
    const t = [...document.querySelectorAll('#tabrow .tab')];
    for (let i = 0; i < n; i++) t[i % t.length].click();
    return t.length;
  };
  W.__toast = () => {
    /* The toast is reachable from the library sheet's actions; dispatching the
       click is enough to arm and re-arm its dismiss timer. */
    const b = document.querySelector('[data-lib="clear"]');
    if (b) {
      b.click();
      return true;
    }
    return false;
  };
  W.__sheet = open => {
    if (open) {
      const you = document.getElementById('you');
      if (you) {
        you.click();
        return document.getElementById('sheet').classList.contains('on');
      }
      return false;
    }
    document.getElementById('scrim').click();
    return !document.getElementById('sheet').classList.contains('on');
  };
  W.__search = cancelAfter => {
    document.getElementById('sopen').click();
    if (cancelAfter != null) {
      rawSet(() => document.getElementById('cancel').click(), cancelAfter);
    }
    return true;
  };
  W.__focusIs = () => {
    const a = document.activeElement;
    return a ? a.id || a.tagName.toLowerCase() : '';
  };
  W.__tiltRegrip = () => {
    const card = pg().querySelector('.card');
    const r = card.getBoundingClientRect();
    const ev = (type, x, y) =>
      card.dispatchEvent(
        new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: 'touch', clientX: x, clientY: y, pointerId: 1, isPrimary: true })
      );
    const x = r.left + r.width * 0.5, y = r.top + r.height * 0.5;
    ev('pointerdown', x, y);
    ev('pointermove', x + 8, y + 8);
    ev('pointerup', x + 8, y + 8);
    /* Re-grip inside the 260 ms release window and hold. */
    return new Promise(res => {
      rawSet(() => {
        ev('pointerdown', x, y);
        ev('pointermove', x + 12, y + 12);
        rawSet(() => {
          const held = card.classList.contains('tilt');
          ev('pointerup', x + 12, y + 12);
          res({ held, transform: /rotate/.test(card.style.transform || '') });
        }, 320);
      }, 100);
    });
  };
  /* A fling, and the document going hidden in the same evaluate so no round trip
     can land between the frame that opens the gate and the moment it is hidden.

     The gate opens on a frame that moved the page faster than FLING_IN px/s with
     no finger down, so this presses and releases a mouse pointer (which sets
     `pointerSeen` without counting a finger) and then steps the page far enough
     per frame that the speed is over the threshold however slow this pod's
     software rasterizer makes the frame. 140 ms is the gate's own idle delay, so
     a pending 140 ms timer *is* an open gate. */
  W.__flingAndHide = async (steps, step) => {
    /* The burst above leaves the feed filtered to one category, and a page with
       four cards on it has nowhere to fling. Back to `All` first. */
    const all = [...pg().querySelectorAll('.chips .chip')].find(c => c.textContent === 'All');
    if (all) {
      all.click();
      await new Promise(r => rawSet(r, 600));
    }
    const el = pg();
    const t = document.body;
    const down = new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse', clientX: 5, clientY: 5, pointerId: 2, isPrimary: true });
    const up = new PointerEvent('pointerup', { bubbles: true, pointerType: 'mouse', clientX: 5, clientY: 5, pointerId: 2, isPrimary: true });
    t.dispatchEvent(down);
    t.dispatchEvent(up);
    let gateBefore = 0;
    for (let i = 0; i < steps; i++) {
      el.scrollTop = el.scrollTop + step;
      el.dispatchEvent(new Event('scroll'));
      await new Promise(r => rawRaf(r));
      gateBefore = W.__liveBy(140);
      if (gateBefore) break;
    }
    const scrolled = Math.round(el.scrollTop);
    const a = W.__stats();
    W.__hide(true);
    const gateAfter = W.__liveBy(140);
    await new Promise(r => rawSet(r, 500));
    const b = W.__stats();
    return {
      scrolled,
      gateBefore,
      gateAfter,
      armsWhileVisible: a.byDelay['140'] || 0,
      armsHidden: (b.byDelay['140'] || 0) - (a.byDelay['140'] || 0),
      timersHidden: b.set - a.set,
    };
  };
  W.__hide = hidden => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => !!hidden });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
    document.dispatchEvent(new Event('visibilitychange'));
    return document.hidden;
  };
}

async function boot(browser, file) {
  const HTML = fs.readFileSync(file);
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e.message).slice(0, 160)));
  page.on('console', m => {
    if (m.type() === 'error') errors.push(m.text().slice(0, 160));
  });
  await page.setViewport({ width: 412, height: 892, deviceScaleFactor: 2 });
  await page.evaluateOnNewDocument(instrument);
  await page.setRequestInterception(true);
  page.on('request', req => {
    const u = req.url();
    if (u.startsWith('https://' + ORIGIN + '/'))
      return req.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: HTML });
    if (/googleapis\.com/.test(u))
      return req.respond({
        status: 200,
        contentType: 'application/json',
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify(apiBody(u)),
      });
    if (/ytimg\.com|ggpht\.com|googleusercontent\.com/.test(u)) return req.respond({ status: 200, contentType: 'image/png', body: PNG });
    return req.abort();
  });
  await page.goto('https://' + ORIGIN + '/index.html', { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction('document.querySelectorAll("#feed .card").length > 0', { timeout: 60000 });
  await page.waitForFunction('!document.querySelector("#ex .skl")', { timeout: 60000 });
  await sleep(600);
  /* Software rasterization makes a full-screen gradient repaint cost hundreds of
     ms a frame; neutralising paint-only properties lets the page run at a
     device's cadence. Neither build's timers are affected. */
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
  const ev = (fn, ...args) => page.evaluate(fn, ...args);

  out.intervals = (await ev(() => window.__stats())).intervals;

  /* Let every boot timer that is meant to fire do so: the deferred sheet's 3 s
     one-shot and the boot log's 12 s last resort are the two long ones, so a 13 s
     settle separates "still owed" from "left behind". */
  await sleep(SETTLE);
  const restStats = await ev(() => window.__stats());
  out.rest = { live: restStats.live, list: await ev(() => window.__live()) };

  /* 1. Five taps along the chip row inside one 140 ms swap window. */
  await ev(() => window.__reset());
  const taps = await ev(() => window.__chipBurst(5));
  await sleep(700);
  const burst = await ev(() => window.__read());
  out.chipBurst = { taps, timers: burst.set, cleared: burst.cleared, feedWrites: burst.feedWrites, frames: burst.raf, byDelay: burst.byDelay };

  /* 2. A card re-gripped inside its release window. */
  out.tiltRegrip = await ev(() => window.__tiltRegrip());
  await sleep(400);

  /* 3. The search panel cancelled 60 ms after it opened. */
  await ev(() => window.__search(60));
  await sleep(600);
  out.searchCancel = { focus: await ev(() => window.__focusIs()) };
  /* 4. …and the same panel left open, so the caret still arrives when it should. */
  await ev(() => window.__search(null));
  await sleep(500);
  out.searchOpen = { focus: await ev(() => window.__focusIs()) };
  await ev(() => document.getElementById('cancel').click());
  await sleep(300);

  /* 5. The fling gate: armed while flinging, and gone the moment the document
        goes hidden. 140 ms is the gate's own idle delay. */
  await ev(() => window.__reset());
  out.fling = await ev(() => window.__flingAndHide(6, 1200));
  await ev(() => window.__hide(false));
  await sleep(400);

  /* 6. A session: twenty tab switches, chips, a sheet, a toast, a search. Nothing
        may be left pending afterwards that was not pending at rest. */
  await ev(() => window.__reset());
  const session = { switches: 0, chips: 0, sheets: 0, toasts: 0 };
  for (let i = 0; i < 20; i++) {
    session.switches += await ev(() => window.__tabs(1));
    if (i % 4 === 0) session.chips += await ev(() => window.__chipBurst(1));
    if (i % 5 === 0) {
      await ev(() => window.__sheet(true));
      session.sheets++;
      await ev(() => window.__toast());
      await ev(() => window.__sheet(false));
      session.toasts++;
    }
    await sleep(20);
  }
  await ev(() => window.__sheet(false));
  /* Longer than the toast's own 2.2 s dismiss: a toast armed by the last action
     is work that is still owed, not a timer left behind. */
  await sleep(2600);
  const end = await ev(() => window.__read());
  out.session = { ...session, timers: end.set, fired: end.fired, live: end.live, list: await ev(() => window.__live()) };

  await page.close();
  out.errors = errors;
  return out;
}

function verdict(r) {
  const fails = [];
  if (r.intervals !== 0) fails.push('setInterval call(s) in the app: ' + r.intervals);
  if (r.rest.live !== 0) fails.push('timer(s) still pending at rest: ' + JSON.stringify(r.rest.list));
  if (r.chipBurst.feedWrites > 1) fails.push('five chip taps wrote the feed ' + r.chipBurst.feedWrites + ' times (want 1)');
  const d = r.chipBurst.byDelay || {};
  /* The swap arms one timer per tap either way — the difference is that the
     superseded ones are cancelled, so only the last can fire. */
  if ((d['60'] || 0) > 1) fails.push('the chip row armed ' + d['60'] + ' depth kicks (want 1)');
  if (r.chipBurst.cleared < r.chipBurst.taps - 1)
    fails.push('superseded chip swaps were not cancelled: ' + r.chipBurst.cleared + ' of ' + (r.chipBurst.taps - 1) + ' cleared');
  if (!r.tiltRegrip.held) fails.push('a card re-gripped inside its release window lost .tilt mid-drag');
  if (r.searchCancel.focus === 'q') fails.push('the search caret was placed after the panel was closed');
  if (r.searchOpen.focus !== 'q') fails.push('the search caret never arrived in an open panel');
  if (r.fling.gateBefore < 1) fails.push('the fling gate never armed (the fling did not register)');
  if (r.fling.gateAfter !== 0) fails.push('the fling gate was still armed after the document went hidden');
  if (r.fling.armsHidden !== 0) fails.push('the fling gate re-armed ' + r.fling.armsHidden + ' time(s) after the document went hidden');
  if (r.session.live > r.rest.live) fails.push('timers accumulated over the session: ' + JSON.stringify(r.session.list));
  if (r.errors.length) fails.push('console/page errors: ' + r.errors.join(' | '));
  return { ok: fails.length === 0, fails };
}

(async () => {
  const files = process.argv.slice(2);
  if (!files.length) {
    console.error('usage: node tools/timer-audit-check.js <build-a.html> [build-b.html]');
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
      const cmp = {
        intervals: [a.intervals, b.intervals],
        rest: [a.rest.live, b.rest.live],
        chipBurst: [a.chipBurst, b.chipBurst],
        tiltRegrip: [a.tiltRegrip.held, b.tiltRegrip.held],
        searchCancelFocus: [a.searchCancel.focus, b.searchCancel.focus],
        flingGateAfterHide: [a.fling.gateAfter, b.fling.gateAfter],
        flingArmsHidden: [a.fling.armsHidden, b.fling.armsHidden],
        sessionLive: [a.session.live, b.session.live],
      };
      console.log(JSON.stringify({ compare: cmp, a: a.verdict, b: b.verdict }));
    }
  } finally {
    await browser.close();
  }
  process.exit(out[0] && out[0].verdict.ok ? 0 : 1);
})();
