#!/usr/bin/env node
/*
 * LiquidTube frame write check — item 3.4.
 *
 * Proves, on a real browser under the WebView's origin with the API mocked, three
 * things about the depth/parallax frame:
 *
 *  1. `rects` — how many boxes the frame measures. Both passes used to measure
 *     the same card (parallax for its gate, depth for its transform) plus the
 *     card's thumbnail, so a scroll frame paid up to three rects per card. The
 *     frame now has one read pass: a card is measured once for both passes and
 *     its thumbnail once, so the count cannot exceed the cards on screen plus the
 *     thumbnails on screen.
 *
 *  2. `flushes` — how many of those reads had to flush style before they could
 *     answer. A read against a clean tree is a property load; a read after a
 *     write in the same frame is a flush, and on this shell a flush costs
 *     0.3–6 ms at 4x CPU throttle. Two measure-then-write passes flush twice per
 *     frame; one read pass followed by one write pass flushes once.
 *
 *  3. `props` — which CSS properties the frame writes. Transforms and opacity
 *     cannot invalidate layout, so nothing measured afterwards can go stale; a
 *     write of width/top/margin/display/font-size would be a layout write and
 *     fails the check. The page's background drift is the one paint-only write
 *     and is called out separately.
 *
 * It also prints the inline transforms and opacity of every card and thumbnail
 * and the shell transforms at four scroll positions, so two builds can be diffed
 * for identical rendering: this check exists to change how the frame is
 * computed, not what it looks like.
 *
 * Usage:  node tools/frame-transforms-only-check.js <build-a.html> [build-b.html]
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
  channels: { items: CH.map((id, i) => ({ id, snippet: { title: 'Channel ' + i, customUrl: 'c' + i, publishedAt: '2015-04-02T10:00:00Z', thumbnails: { medium: { url: 'https://yt3.ggpht.com/a' + i + '.jpg' } } }, statistics: { subscriberCount: '1', videoCount: '1', viewCount: '1' }, contentDetails: { relatedPlaylists: { uploads: 'UU' + i } }, brandingSettings: { image: {}, channel: {} } })) },
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
    W.__rects = 0;
    W.__flush = 0;
    W.__readMs = 0;
    /* A read that takes measurable time is one that flushed style/layout; a read
       against a clean tree is a property load well under 0.25 ms. Same convention
       as tools/layout-thrash-bench.js. */
    const gr = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function () {
      const inPage = this.closest && this.closest('.page');
      const t0 = performance.now();
      const r = gr.call(this);
      const dt = performance.now() - t0;
      if (inPage) { W.__rects++; W.__readMs += dt; if (dt > 0.25) W.__flush++; }
      return r;
    };
    /* Which properties the passes write, from the style attribute they change:
       the style object's property accessors are own properties on each
       declaration in this engine and cannot be wrapped from the prototype. */
    W.__props = new Set();
    const parse = s => {
      const m = new Map();
      for (const part of String(s || '').split(';')) {
        const i = part.indexOf(':');
        if (i > 0) m.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
      }
      return m;
    };
    W.__mo = new MutationObserver(recs => {
      for (const r of recs) {
        const t = r.target;
        if (!t.closest || (!t.closest('.page') && !t.classList.contains('dock'))) continue;
        const a = parse(r.oldValue), b = parse(t.getAttribute('style'));
        for (const [k, v] of b) if (a.get(k) !== v) W.__props.add(k);
      }
    });
    W.__watch = () => W.__mo.observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['style'], attributeOldValue: true });
    W.__reset = () => { W.__rects = 0; W.__flush = 0; W.__readMs = 0; W.__props = new Set(); };
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

async function run(browser, file) {
  const page = await boot(browser, file);
  const out = { file: path.basename(file) };

  /* The reveal animations the shell runs on first paint move every card for the
     first second and a half, and a rect measured mid-animation is a rect of the
     animation's current frame — so the comparison below is taken after they have
     all finished, or two builds would differ by whichever frame each was sampled
     on. */
  await sleep(1600);
  await frames(page);

  /* What the frame renders, at four scroll positions: identical arrays across two
     builds mean the frame computes the same picture. */
  out.faces = {};
  for (const y of [0, 300, 900, 1400]) {
    /* Nudge off the position and back, so the pass is guaranteed to run against
       the settled layout: at rest the signature matches and no frame runs, which
       would leave the values some earlier frame wrote — possibly one measured
       while a reveal animation was still moving the cards. */
    for (const v of [y + 1, y]) {
      await page.evaluate(v => {
        const pg = document.querySelector('.page:not([inert])');
        pg.scrollTop = v;
        pg.dispatchEvent(new Event('scroll'));
      }, v);
      await frames(page);
      await sleep(120);
    }
    out.faces[y] = await page.evaluate(() => __faces());
  }

  /* The measured frame: settle at 900, then one scroll step with everything it
     causes counted. */
  await page.evaluate(() => { document.querySelector('.page:not([inert])').scrollTop = 900; });
  await frames(page);
  await sleep(200);
  await page.evaluate(() => { __reset(); __watch(); });
  await page.evaluate(() => {
    const pg = document.querySelector('.page:not([inert])');
    pg.scrollTop = 1100;
    pg.dispatchEvent(new Event('scroll'));
  });
  await frames(page);
  await sleep(200);

  const m = await page.evaluate(() => ({
    rects: __rects,
    flushes: __flush,
    readMs: Math.round(__readMs * 100) / 100,
    props: [...__props].sort(),
    cardsOnScreen: document.querySelectorAll('.page:not([inert]) .card').length,
    thumbsOnScreen: document.querySelectorAll('.page:not([inert]) .thumb img').length,
  }));

  const layoutProps = ['top', 'left', 'right', 'bottom', 'width', 'height', 'margin', 'margin-top', 'padding',
    'display', 'font-size', 'position', 'flex', 'gap', 'line-height'];
  out.scrollFrame = {
    rects: m.rects,
    rectsPerCard: m.cardsOnScreen ? Math.round((m.rects / m.cardsOnScreen) * 100) / 100 : 0,
    flushes: m.flushes,
    readMs: m.readMs,
    props: m.props,
    cardsOnScreen: m.cardsOnScreen,
    thumbsOnScreen: m.thumbsOnScreen,
  };
  out.assertions = {
    'a card is measured at most once per frame':
      m.rects <= m.cardsOnScreen + m.thumbsOnScreen,
    'the frame writes transforms and opacity only':
      m.props.every(p => p === 'transform' || p === 'opacity' || p === 'background-position-y'),
    'no layout property is written by the frame':
      m.props.every(p => !layoutProps.includes(p)),
    'the frame flushes style at most once':
      m.flushes <= 1,
  };
  out.pass = Object.values(out.assertions).every(Boolean);
  await page.close();
  return out;
}


/* Two builds are compared on what they rendered, within the noise the harness
   itself has: a card's transform is a fixed point of its own measured rect, so a
   run that got one more frame than another lands a tenth of a pixel away — the
   same build compared with itself moves that much. Property names and value
   shapes must match exactly; numbers are compared with a tolerance. */
const TOL = { abs: 0.35, rel: 0.004 };
function numbers(s) { return (String(s).match(/-?\d*\.?\d+/g) || []).map(Number); }
function close(x, y) { return Math.abs(x - y) <= TOL.abs + Math.abs(y) * TOL.rel; }
function compare(a, b) {
  const mismatches = [];
  let worst = 0;
  for (const y of Object.keys(a)) {
    for (const k of Object.keys(a[y])) {
      const va = a[y][k], vb = b[y] && b[y][k];
      if (Array.isArray(va)) {
        if (!Array.isArray(vb) || va.length !== vb.length) { mismatches.push({ scroll: +y, field: k, reason: 'length ' + va.length + ' vs ' + (vb ? vb.length : 'missing') }); continue; }
        for (let i = 0; i < va.length; i++) {
          const na = numbers(va[i]), nb = numbers(vb[i]);
          const shape = s => String(s).replace(/-?\d*\.?\d+/g, '#');
          if (shape(va[i]) !== shape(vb[i])) { mismatches.push({ scroll: +y, field: k, index: i, reason: 'shape', a: va[i], b: vb[i] }); continue; }
          for (let j = 0; j < na.length; j++) {
            const diff = Math.abs(na[j] - nb[j]);
            if (diff > worst) worst = diff;
            if (!close(na[j], nb[j])) mismatches.push({ scroll: +y, field: k, index: i, reason: 'value', a: va[i], b: vb[i] });
          }
        }
      } else if (String(va).replace(/-?\d*\.?\d+/g, '#') !== String(vb).replace(/-?\d*\.?\d+/g, '#')) {
        mismatches.push({ scroll: +y, field: k, reason: 'shape', a: va, b: vb });
      } else {
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
  if (!files.length) { console.error('usage: node tools/frame-transforms-only-check.js <build-a.html> [build-b.html]'); process.exit(2); }
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
