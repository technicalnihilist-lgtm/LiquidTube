#!/usr/bin/env node
/*
 * LiquidTube dead-scroll check — item 3.10 ("remove the now-dead scroll
 * handlers").
 *
 * Items 3.1 → 3.9 rebuilt the scroll path: one rAF for all of it, one read pass,
 * one write pass, a per-page skip, a fling gate, a will-change hint and a frame
 * cache that runs no selector query. Each of those replaced a handler, and the
 * handlers they replaced were still registered — the document still carried a
 * no-op `touchstart` probe, the tilt and the fling gate still registered two
 * listeners each on the same three pointer events, the resize still had two
 * listeners, and the capture-phase scroll listener still gave a frame to every
 * scroller in the app (chips, carousels, the sheet) even though a frame reads
 * nothing but the active page's own offset.
 *
 * This tool proves, on a real browser with the API mocked, that what is left is
 * exactly the set of handlers the path needs, and that the path still does its
 * job. Per build it reports:
 *
 *   listeners   every listener the app registers, by target and type — including
 *               the ones whose callback body is empty (`noop`), which is the
 *               class of handler this item exists to remove
 *   foreign     a horizontal scroll of the chip row and of a carousel: how many
 *               scroll events were dispatched and how many frames the app asked
 *               for. Nothing a pass writes is keyed off those scrollers, so the
 *               count must be 0
 *   page        a vertical scroll of the feed: frames requested, and how many
 *               thumbnails and cards the frame actually wrote — the layer has to
 *               still run, or "0 frames" above would be a removed feature
 *   rest        every inline transform, opacity and background offset of the
 *               feed, plus the scroll offset, once the scroll has stopped: two
 *               builds must agree exactly
 *   tilt        a touch drag across a card still tilts it (the merged pointer
 *               listener has to drive both readers)
 *   resize      one resize listener, and the shell still re-renders and re-runs
 *               its pass afterwards
 *   queries     selector queries run during a scroll session — 0
 *
 * Usage:
 *   npm i puppeteer-core                    # dev only, not shipped in the APK
 *   CHROME=/path/to/chrome node tools/dead-scroll-check.js <build-a.html> [build-b.html]
 * Prints one JSON object per build; with two builds it also compares them.
 * Exit code 1 when the build under test — the first file — fails any of the
 * checks above, or when the two builds render differently.
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
const F = {
  videos: {
    items: vids.map((id, i) => ({
      id,
      snippet: {
        title: 'Video ' + i,
        channelTitle: 'Channel ' + (i % 6),
        channelId: CH[i % 6],
        publishedAt: ago(i + 1),
        categoryId: '10',
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

/* The census has to be taken before the app's own scripts run, so the
   instrumentation goes in as an init script, not as an evaluate after load. */
function instrument() {
  const W = window;
  const reg = [];
  const C = { raf: 0, qs: 0, qsa: 0 };
  W.__lt = { reg, C };
  const compact = s => String(s).replace(/\s+/g, '');
  /* A listener whose whole body is empty does nothing for any event it is given:
     that is the shape of a probe left behind by an earlier refactor. */
  const isNoop = fn => {
    const s = compact(fn);
    return /^(?:function[^(]*\([^)]*\)|\([^)]*\)=>|[A-Za-z_$][\w$]*=>)\{\}$/.test(s);
  };
  const nameOf = t =>
    t === document ? 'document' : t === window ? 'window' : (t.id ? '#' + t.id : t.className ? '.' + String(t.className).split(' ')[0] : t.tagName || 'node');
  const orig = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (type, fn, opts) {
    const o = (typeof opts === 'object' && opts) || {};
    if (typeof fn === 'function') {
      reg.push({ target: nameOf(this), type, capture: !!o.capture, passive: !!o.passive, noop: isNoop(fn) });
    }
    return orig.call(this, type, fn, opts);
  };
  const raf = W.requestAnimationFrame.bind(W);
  /* The harness's own frames are not the app's: they go through the unwrapped
     reference, so a counter of 0 means the app asked for no frame. */
  W.__raf0 = raf;
  W.requestAnimationFrame = cb => {
    C.raf++;
    return raf(cb);
  };
  for (const [proto, keys] of [
    [Document.prototype, ['qs', 'qsa']],
    [Element.prototype, ['qs', 'qsa']],
  ]) {
    const q = proto.querySelector;
    const qa = proto.querySelectorAll;
    proto.querySelector = function (s) {
      C[keys[0]]++;
      return q.call(this, s);
    };
    proto.querySelectorAll = function (s) {
      C[keys[1]]++;
      return qa.call(this, s);
    };
  }
  /* What every layer renders, so two builds can be compared element for
     element. */
  W.__faces = () => {
    const pg = document.querySelector('.page:not([inert])');
    const s = e => (e ? [e.style.transform, e.style.opacity, e.style.backgroundPositionY].join('~') : '');
    return {
      thumbs: [...pg.querySelectorAll('.thumb img')].map(s),
      cards: [...pg.querySelectorAll('.card')].map(s),
      shell: [s(pg), s(pg.querySelector('.top')), s(pg.querySelector('.chips')), s(document.querySelector('.dock'))],
      scrollTop: Math.round(pg.scrollTop * 100) / 100,
    };
  };
  W.__census = () => {
    const per = {};
    for (const r of reg) {
      const k = r.target + ':' + r.type + (r.capture ? ':capture' : '');
      per[k] = (per[k] || 0) + 1;
    }
    return { per, noop: reg.filter(r => r.noop), total: reg.length };
  };
  W.__resetC = () => {
    C.raf = 0;
    C.qs = 0;
    C.qsa = 0;
  };
  W.__readC = () => ({ raf: C.raf, qs: C.qs, qsa: C.qsa });
  /* One scroll event on an arbitrary scroller, exactly as the browser would
     deliver it: the document's capture listener sees the target it came from. */
  W.__scrollOn = sel => {
    const el = document.querySelector(sel);
    if (!el) return false;
    el.scrollLeft = (el.scrollLeft || 0) + 40;
    el.dispatchEvent(new Event('scroll'));
    return true;
  };
  W.__scrollPage = step => {
    const pg = W.__pgEl || (W.__pgEl = document.querySelector('.page:not([inert])'));
    pg.scrollTop = pg.scrollTop + step;
    pg.dispatchEvent(new Event('scroll'));
    return pg.scrollTop;
  };
  W.__tilt = () => {
    const card = document.querySelector('.page:not([inert]) .card');
    if (!card) return null;
    const r = card.getBoundingClientRect();
    const ev = (type, x, y) =>
      card.dispatchEvent(
        new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: 'touch', clientX: x, clientY: y, pointerId: 1, isPrimary: true })
      );
    ev('pointerdown', r.left + r.width * 0.3, r.top + r.height * 0.3);
    ev('pointermove', r.left + r.width * 0.7, r.top + r.height * 0.7);
    const tf = card.style.transform;
    ev('pointerup', r.left + r.width * 0.7, r.top + r.height * 0.7);
    return { transform: tf, tilted: /rotate/.test(tf) };
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
  await sleep(800);
  /* The pod rasterizes in software, so a full-screen gradient repaint costs
     hundreds of ms a frame. Paint-only properties are neutralised so the page
     runs at a device's cadence: none of them affects layout, so every rect the
     passes measure and every element they write is unchanged, and both builds
     get the same treatment. */
  await page.evaluate(() => {
    const st = document.createElement('style');
    st.textContent =
      '*{backdrop-filter:none!important;filter:none!important;box-shadow:none!important;text-shadow:none!important}.page{background-image:none!important}';
    document.head.appendChild(st);
  });
  return { page, errors };
}

/* The harness's own frames use the unwrapped rAF, so they never land in the
   app's counter. */
const frames = (page, n = 3) =>
  page.evaluate(
    n =>
      new Promise(r => {
        const raf = window.__raf0 || window.requestAnimationFrame.bind(window);
        let i = 0;
        const step = () => (++i >= n ? r() : raf(step));
        raf(step);
      }),
    n
  );

async function run(browser, file) {
  const { page, errors } = await boot(browser, file);
  const census = await page.evaluate(() => window.__census());

  /* 1. A scroll of a scroller that no pass reads. Dispatched one at a time, with
        the frames in between drained, so each event is its own chance to request
        one: an app that kicks on it asks for exactly as many frames as there
        were events. */
  const foreign = { events: 0, raf: 0 };
  await page.evaluate(() => window.__resetC());
  for (const sel of ['.page:not([inert]) .chips', '.page:not([inert]) .car', '#sg']) {
    for (let i = 0; i < 4; i++) {
      const ok = await page.evaluate(s => window.__scrollOn(s), sel);
      if (ok) foreign.events++;
      await frames(page, 2);
    }
  }
  foreign.raf = (await page.evaluate(() => window.__readC())).raf;

  /* 2. A vertical scroll of the feed — the one scroller the passes are keyed
        off. The layer has to run: frames requested, and thumbnails and cards
        actually written. */
  const pageScroll = { events: 0, raf: 0, qs: 0, qsa: 0 };
  const before = await page.evaluate(() => window.__faces());
  /* Counters start after the snapshot and after the harness has cached the page
     element: the session must be counted for the app's queries only. */
  await page.evaluate(() => {
    window.__pgEl = document.querySelector('.page:not([inert])');
    window.__resetC();
  });
  for (let i = 0; i < 6; i++) {
    await page.evaluate(() => window.__scrollPage(180));
    pageScroll.events++;
    await frames(page, 2);
  }
  const c2 = await page.evaluate(() => window.__readC());
  pageScroll.raf = c2.raf;
  pageScroll.qs = c2.qs;
  pageScroll.qsa = c2.qsa;
  /* Settle on an exact offset with the fling gate closed before anything is
     compared: a stepped scroll leaves the gate open on its last frame, and the
     thumbnail layer's re-sync lands a frame or two later — two builds compared
     mid-fling would differ in the last digit of a percentage, which is a
     timing artefact and not a behavioural one. */
  await page.evaluate(() => {
    const pg = window.__pgEl;
    pg.scrollTop = Math.round(pg.scrollTop);
    pg.dispatchEvent(new Event('scroll'));
  });
  await sleep(450);
  await frames(page, 3);
  const after = await page.evaluate(() => window.__faces());
  pageScroll.thumbsWritten = after.thumbs.filter((v, i) => v !== before.thumbs[i]).length;
  pageScroll.cardsWritten = after.cards.filter((v, i) => v !== before.cards[i]).length;
  pageScroll.shellWritten = after.shell.filter((v, i) => v !== before.shell[i]).length;

  /* 3. The tilt, through the merged pointer listener: the fling gate and the
        card tilt are both driven from one registration per event now. */
  const tilt = await page.evaluate(() => window.__tilt());
  /* tiltEnd drops the class after 260 ms; the depth pass skips a card that is
     still under the finger, so the settle is what makes the at-rest state
     comparable. */
  await sleep(400);
  await frames(page, 2);
  const animOn = await page.evaluate(() => document.documentElement.dataset.anim === 'on');

  /* 4. Resize: one listener, and the shell still re-renders and re-runs. */
  await page.evaluate(() => window.__resetC());
  await page.evaluate(() => dispatchEvent(new Event('resize')));
  await frames(page, 3);
  await sleep(350);
  await frames(page, 3);
  const resizeRaf = (await page.evaluate(() => window.__readC())).raf;
  const rest = await page.evaluate(() => window.__faces());

  await page.close();
  return {
    file: path.basename(file),
    listeners: census,
    foreign,
    page: pageScroll,
    tilt,
    resize: { raf: resizeRaf },
    rest,
    animHint: animOn,
    errors,
  };
}

/* Two builds have to render the same thing, but not to the same last digit: a
   rect measured a frame apart in a headless, software-rastered browser moves by
   a hundredth of a percent, and the same build run twice differs by that much
   (measured — see the log). Every number inside the transform strings is
   compared, and the state is "the same" when no number moved more than TOL, in
   the units the transform uses (px for a translate, % for a thumbnail offset, a
   bare number for an opacity or a scale). */
const TOL = 0.2;
function restClose(a, b) {
  const num = s => (String(s).match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
  const flat = st => [...st.thumbs, ...st.cards, ...st.shell].map(num);
  const A = flat(a), B = flat(b);
  const over = [];
  let worst = 0;
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    const x = A[i] || [], y = B[i] || [];
    if (x.length !== y.length) {
      over.push(i);
      continue;
    }
    for (let j = 0; j < x.length; j++) {
      const d = Math.abs(x[j] - y[j]);
      if (d > worst) worst = Math.round(d * 100) / 100;
      if (d > TOL) over.push(i);
    }
  }
  return { ok: over.length === 0 && a.scrollTop === b.scrollTop, worst, over };
}

function verdict(r) {
  const fails = [];
  const doc = r.listeners.per;
  if (r.listeners.noop.length) fails.push('no-op listener(s) registered: ' + r.listeners.noop.map(l => l.target + ':' + l.type).join(', '));
  for (const t of ['scroll', 'resize', 'pointerdown', 'pointerup', 'pointercancel', 'pointermove']) {
    const key = 'document:' + t;
    const n = (doc[key] || 0) + (doc[key + ':capture'] || 0) + ((r.listeners.per['window:' + t] || 0));
    const want = t === 'scroll' ? 1 : 1;
    if (n !== want) fails.push(`${t}: ${n} document/window listener(s), expected ${want}`);
  }
  if (r.foreign.events > 0 && r.foreign.raf !== 0) fails.push('a scroll of a scroller no pass reads requested ' + r.foreign.raf + ' frame(s)');
  if (r.page.events > 0 && r.page.raf === 0) fails.push('a page scroll requested no frame');
  if (r.page.thumbsWritten === 0) fails.push('a page scroll wrote no thumbnail');
  if (r.page.cardsWritten === 0) fails.push('a page scroll wrote no card');
  if (r.page.qs || r.page.qsa) fails.push('a scroll session ran ' + (r.page.qs + r.page.qsa) + ' selector quer(ies)');
  if (!r.tilt || !r.tilt.tilted) fails.push('a touch drag did not tilt the card');
  if (r.resize.raf === 0) fails.push('a resize requested no frame');
  if (r.errors.length) fails.push('page errors: ' + r.errors.join(' | '));
  return fails;
}

(async () => {
  const files = process.argv.slice(2);
  if (!files.length) files.push(path.join(__dirname, '..', 'app', 'assets', 'index.html'));
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME || '/usr/local/bin/google-chrome',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--force-device-scale-factor=1'],
  });
  const out = [];
  let bad = 0;
  try {
    for (const f of files) {
      const r = await run(browser, f);
      r.fails = verdict(r);
      /* Only the build under test gates the exit code: a second file is the
         reference, and the point of running it is usually that it fails. */
      if (r.fails.length && out.length === 0) bad++;
      out.push(r);
      console.log(JSON.stringify(r, null, 1));
    }
    if (out.length > 1) {
      const same = restClose(out[0].rest, out[1].rest);
      console.log(
        JSON.stringify(
          {
            compare: {
              restSame: same,
              listeners: out.map(o => ({ file: o.file, total: o.listeners.total, noop: o.listeners.noop.length })),
              foreignRaf: out.map(o => o.foreign.raf),
              pageRaf: out.map(o => o.page.raf),
              thumbsWritten: out.map(o => o.page.thumbsWritten),
              cardsWritten: out.map(o => o.page.cardsWritten),
              restWorstDelta: same.worst,
              restOver: same.over.length,
            },
          },
          null,
          1
        )
      );
      if (!same.ok) {
        console.log('rest state differs between the builds: ' + same.worst + ' worst delta over ' + same.over.length + ' element(s)');
        bad++;
      }
    }
  } finally {
    await browser.close();
  }
  process.exit(bad ? 1 : 0);
})().catch(e => {
  console.error(e);
  process.exit(2);
});
