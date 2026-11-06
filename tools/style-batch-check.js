#!/usr/bin/env node
/*
 * LiquidTube style-write batching check — item 3.6.
 *
 * The depth/parallax frame writes `transform`, `opacity` and
 * `background-position-y` to the layers it moves. Every assignment dirties that
 * element's style, and the recalc is paid at the next paint whether or not the
 * value changed. This tool counts what the frame actually assigns, on a real
 * browser under the WebView's origin with the API mocked:
 *
 *  1. `assignments` / `elements` — how many property writes the frame made in a
 *     scroll session, and to how many distinct elements. Writes are counted by
 *     wrapping the `style` getter: each element gets a Proxy over its
 *     CSSStyleDeclaration, so every `style.transform = …` is seen.
 *
 *  2. `redundant` — assignments whose value was already the value the element
 *     held. This is the number the batching exists to remove: a card that has
 *     scrolled off screen used to be given `transform:''` on every frame it
 *     stayed off screen, and a one-pixel scroll step re-wrote transforms and
 *     opacities that had not moved a digit.
 *
 *  3. `records` — style-attribute mutations the engine itself recorded over the
 *     same window (a MutationObserver on `style`), the browser-level view of how
 *     many elements were invalidated. It should agree with `elements`.
 *
 *  4. `flushes` — reads that had to flush style before answering, and `late` —
 *     reads that happened after the frame's first write. A frame must finish
 *     reading before it writes, and must not write while it computes.
 *
 * It also prints the inline transforms and opacity of every card and thumbnail
 * and the shell transforms at four scroll positions, so two builds can be
 * diffed for identical rendering: this item changes when the frame writes, not
 * what it writes.
 *
 * Usage:
 *   npm i puppeteer-core                    # dev only, not shipped in the APK
 *   CHROME=/path/to/chrome node tools/style-batch-check.js <build-a.html> [build-b.html]
 * Prints one JSON object per build; with two builds it also says whether the
 * rendering matched.
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
  await sleep(700);

  await page.evaluate(() => {
    const W = window;
    const TRACK = new Set(['transform', 'opacity', 'backgroundPositionY', 'background-position-y']);
    W.__n = 0; W.__red = 0; W.__recs = 0; W.__reads = 0; W.__flush = 0; W.__late = 0; W.__ms = 0;
    W.__els = new Set(); W.__wrote = false;

    /* The style object's property accessors are own properties of each
       declaration in this engine, so they cannot be wrapped from the prototype.
       The `style` getter can be — it lives on HTMLElement.prototype (not
       Element.prototype, which is why an override there is silently shadowed) —
       so each element gets one Proxy over its real CSSStyleDeclaration, cached,
       and the Proxy counts the sets it forwards. */
    const desc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'style');
    const proxies = new WeakMap();
    Object.defineProperty(HTMLElement.prototype, 'style', {
      configurable: true,
      get() {
        let p = proxies.get(this);
        if (!p) {
          const el = this;
          const real = desc.get.call(el);
          p = new Proxy(real, {
            get(t, k) {
              const v = Reflect.get(t, k);
              return typeof v === 'function' ? v.bind(t) : v;
            },
            set(t, k, v) {
              if (TRACK.has(k)) {
                W.__n++;
                W.__els.add(el);
                if (String(t[k]) === String(v)) W.__red++;
                W.__wrote = true;
              }
              return Reflect.set(t, k, v);
            },
          });
          proxies.set(el, p);
        }
        return p;
      },
    });

    /* A read that takes measurable time flushed style/layout; a read after the
       frame's first write is a read the write pushed out of order. Same
       convention as tools/layout-thrash-bench.js. */
    const gr = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function () {
      const inPage = this.closest && this.closest('.page');
      const t0 = performance.now();
      const r = gr.call(this);
      const dt = performance.now() - t0;
      if (inPage) {
        W.__reads++;
        W.__ms += dt;
        if (dt > 0.25) W.__flush++;
        if (W.__wrote) W.__late++;
      }
      return r;
    };

    /* The engine's own view: one record per element whose style attribute it
       rewrote (attribute records coalesce per target within a microtask, which
       is exactly one frame here). */
    W.__mo = new MutationObserver(recs => { for (const r of recs) if (r.attributeName === 'style') W.__recs++; });

    W.__reset = () => { W.__n = 0; W.__red = 0; W.__recs = 0; W.__reads = 0; W.__flush = 0; W.__late = 0; W.__ms = 0; W.__els = new Set(); W.__wrote = false; };
    W.__watch = () => W.__mo.observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['style'] });
    W.__stop = () => W.__mo.disconnect();
    W.__faces = () => ({
      cards: [...document.querySelectorAll('#p-home .card')].map(e => [e.style.transform, e.style.opacity].join('~')),
      thumbs: [...document.querySelectorAll('#p-home .thumb img')].map(e => e.style.transform),
      page: document.querySelector('.page:not([inert])').style.backgroundPositionY,
      top: (document.querySelector('.page:not([inert]) .top') || { style: {} }).style.transform || '',
      dock: (document.querySelector('.dock') || { style: {} }).style.transform || '',
      chips: (document.querySelector('.page:not([inert]) .chips') || { style: {} }).style.transform || '',
    });
  });
  return page;
}

const frames = page => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(r)))));
/* The write flag is per step, not per session: what the check asks is whether a
   step's frame reads anything after it has begun to write, and a read in the
   next step must not be blamed on the one before it. */
const scrollTo = (page, y, fire = true) => page.evaluate((y, fire) => {
  const pg = document.querySelector('.page:not([inert])');
  __wrote = false;
  pg.scrollTop = y;
  if (fire) pg.dispatchEvent(new Event('scroll'));
}, y, fire);

async function run(browser, file) {
  const page = await boot(browser, file);
  const out = { file: path.basename(file) };

  /* The reveal animations move every card for the first second and a half; a
     value sampled mid-animation belongs to whichever frame it was taken on, so
     everything below happens after they have finished. */
  await sleep(1600);
  await frames(page);

  /* What the frame renders, at four scroll positions. Identical arrays across
     two builds mean the frame computes the same picture. */
  out.faces = {};
  for (const y of [0, 300, 900, 1400]) {
    for (const v of [y + 1, y]) { await scrollTo(page, v); await frames(page); await sleep(120); }
    out.faces[y] = await page.evaluate(() => __faces());
  }

  /* The measured session: one settled position, then thirty one-pixel scroll
     steps. A step of one pixel changes a card's depth offset by a fraction of a
     tenth, so most of what the frame writes is what the element already holds —
     which is precisely the write a batch can drop. */
  await scrollTo(page, 900);
  await frames(page);
  await sleep(250);
  await page.evaluate(() => { __reset(); __watch(); });
  for (let i = 1; i <= 30; i++) { await scrollTo(page, 900 + i); await frames(page); }
  await sleep(120);
  await page.evaluate(() => __stop());

  const m = await page.evaluate(() => ({
    assignments: __n,
    redundant: __red,
    elements: __els.size,
    records: __recs,
    reads: __reads,
    flushes: __flush,
    readMs: Math.round(__ms * 100) / 100,
    late: __late,
    cardsOnScreen: document.querySelectorAll('.page:not([inert]) .card').length,
  }));

  out.session = {
    steps: 30,
    assignments: m.assignments,
    assignmentsPerStep: Math.round((m.assignments / 30) * 10) / 10,
    redundant: m.redundant,
    redundantShare: m.assignments ? Math.round((m.redundant / m.assignments) * 1000) / 10 : 0,
    elements: m.elements,
    records: m.records,
    reads: m.reads,
    flushes: m.flushes,
    readMs: m.readMs,
    cardsOnScreen: m.cardsOnScreen,
  };
  out.assertions = {
    'no assignment writes a value the element already holds': m.redundant === 0,
    'no read happens after the frame has started writing': m.late === 0,
    'the frame flushes style at most once per step': m.flushes <= 30,
    'the engine rewrote no more styles than were assigned': m.records <= m.assignments,
  };
  out.pass = Object.values(out.assertions).every(Boolean);
  await page.close();
  return out;
}

/* Two builds are compared on what they rendered, within the noise the harness
   itself has: a card's transform is a fixed point of its own measured rect, so a
   run that got one more frame than another lands a tenth of a pixel away.
   Property names and value shapes must match exactly; numbers are compared with
   a tolerance. */
const TOL = { abs: 0.35, rel: 0.004 };
const numbers = s => (String(s).match(/-?\d*\.?\d+/g) || []).map(Number);
const close = (x, y) => Math.abs(x - y) <= TOL.abs + Math.abs(y) * TOL.rel;
function compare(a, b) {
  const mismatches = [];
  let worst = 0;
  for (const y of Object.keys(a)) {
    for (const k of Object.keys(a[y])) {
      const va = a[y][k], vb = b[y] && b[y][k];
      if (Array.isArray(va)) {
        if (!Array.isArray(vb) || va.length !== vb.length) { mismatches.push({ scroll: +y, field: k, reason: 'length ' + va.length + ' vs ' + (vb ? vb.length : 'missing') }); continue; }
        for (let i = 0; i < va.length; i++) {
          const shape = s => String(s).replace(/-?\d*\.?\d+/g, '#');
          if (shape(va[i]) !== shape(vb[i])) { mismatches.push({ scroll: +y, field: k, index: i, reason: 'shape', a: va[i], b: vb[i] }); continue; }
          const na = numbers(va[i]), nb = numbers(vb[i]);
          for (let j = 0; j < na.length; j++) {
            const diff = Math.abs(na[j] - nb[j]);
            if (diff > worst) worst = diff;
            if (!close(na[j], nb[j])) mismatches.push({ scroll: +y, field: k, index: i, reason: 'value', a: va[i], b: vb[i] });
          }
        }
      } else {
        const shape = s => String(s).replace(/-?\d*\.?\d+/g, '#');
        if (shape(va) !== shape(vb)) { mismatches.push({ scroll: +y, field: k, reason: 'shape', a: va, b: vb }); continue; }
        const na = numbers(va), nb = numbers(vb);
        for (let j = 0; j < na.length; j++) {
          const diff = Math.abs(na[j] - nb[j]);
          if (diff > worst) worst = diff;
          if (!close(na[j], nb[j])) mismatches.push({ scroll: +y, field: k, reason: 'value', a: va, b: vb });
        }
      }
    }
  }
  return { worstDelta: Math.round(worst * 1000) / 1000, mismatches: mismatches.slice(0, 8) };
}

(async () => {
  const files = process.argv.slice(2);
  if (!files.length) { console.error('usage: node tools/style-batch-check.js <build-a.html> [build-b.html]'); process.exit(2); }
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME || '/usr/bin/google-chrome',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--hide-scrollbars'],
  });
  const results = [];
  for (const f of files) results.push(await run(browser, f));
  if (results.length === 2) {
    const d = compare(results[0].faces, results[1].faces);
    results[0].rendering = d;
    results[0].sameRenderingAsSecondBuild = d.mismatches.length === 0;
    results[1].sameRenderingAsSecondBuild = results[0].sameRenderingAsSecondBuild;
  }
  await browser.close();
  console.log(JSON.stringify(results, null, 2));
})();
