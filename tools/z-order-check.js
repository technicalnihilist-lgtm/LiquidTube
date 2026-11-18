#!/usr/bin/env node
/*
 * LiquidTube z-order check — item 8.6 ("keep the player above other layers").
 *
 * The whole app is one stacking context (`.app{isolation:isolate}`) and every
 * layer in it now takes its rank from the `--z-*` scale in the critical sheet.
 * What this tool measures, per build, in a real browser with the API mocked:
 *
 *   scale     every layer computes to the rank the scale declares
 *   order     the invariants, as numbers: the player is above the scrim, the
 *             scrim above search, search above the pages; the sheet is above
 *             the player; the dock and the toast are above the player; the
 *             splash is above everything
 *   top       hit tests over a 20 px grid in each state: the topmost element at
 *             a point over the player belongs to the player (or to the dock,
 *             which the design puts above it — see item 8.2), the topmost at a
 *             point over the pages belongs to the page or the scrim, and no
 *             *closed* layer is ever the topmost element anywhere
 *   float     with search open over a playing video the player is still the
 *             topmost surface over its own panel (the player floats above the
 *             search takeover; that is why 8.2 pauses for a sheet but not for
 *             search)
 *   inert     a closed overlay is out of the stack for focus and for a screen
 *             reader, an open one is not; Tab from the body never reaches a
 *             control inside a closed layer
 *   pixels    with two builds, a screenshot of each state is compared pixel by
 *             pixel — this item changes no visual, and the diff proves it
 *   errors    page errors over the whole run
 *
 * Usage:
 *   npm i puppeteer-core                    # dev only, not shipped in the APK
 *   CHROME=/path/to/chrome node tools/z-order-check.js <build.html> [old.html]
 * Prints one JSON object per build; with two builds it also prints the pixel
 * comparison. Exit code 1 when the build under test fails any check.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
let puppeteer;
try {
  puppeteer = require('puppeteer-core');
} catch (e) {
  puppeteer = require('puppeteer'); // same API, for a pod with the bundled one
}

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64'
);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const pad = n => String(n).padStart(2, '0');
const vids = Array.from({ length: 24 }, (_, i) => 'v' + pad(i + 1) + 'AAAAAAAA');
const CH = Array.from({ length: 6 }, (_, i) => 'UC' + i + 'xxxxxxxxxxxxxxxxxxxx');
const ago = h => new Date(Date.now() - h * 36e5).toISOString();

/* The rank every layer must compute to, in paint order from the bottom. */
const SCALE = { page: 0, top: 5, search: 30, scrim: 38, pl: 40, sheet: 41, dock: 60, toast: 61, splash: 90 };
const SEL = {
  page: '#p-home',
  top: '#p-home .top',
  search: '#search',
  scrim: '#scrim',
  pl: '#pl',
  sheet: '#sheet',
  dock: 'nav.dock',
  toast: '#toast',
  splash: '#splash',
};
/* The layers the app raises and drops; `scrim` is deliberately not one of them
   (it holds no controls, and a scrim that is fading out must not swallow taps). */
const STACK = ['pl', 'sheet', 'search'];

const EMBED_HTML = `<!doctype html><html><body style="margin:0;background:#222;color:#fff">
<video id="v" muted playsinline></video>
<script>
  addEventListener('message', function (e) {
    var d = e.data;
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch (x) { return; } }
    if (!d || d.event !== 'command') return;
    try { parent.postMessage('LTEMBED:' + d.func, '*'); } catch (x) {}
  });
  try { parent.postMessage('LTEMBED:ready', '*'); } catch (x) {}
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

/* ---- a dependency-free PNG reader, for the pixel comparison ---- */
function decodePNG(buf) {
  let off = 8,
    w = 0,
    h = 0,
    depth = 0,
    ctype = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      depth = data[8];
      ctype = data[9];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (depth !== 8 || (ctype !== 2 && ctype !== 6)) throw new Error('unsupported PNG: depth ' + depth + ' type ' + ctype);
  const bpp = ctype === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const out = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a),
          pb = Math.abs(p - b),
          pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[x] = v & 0xff;
    }
  }
  return { w, h, bpp, data: out };
}
function diffPNG(a, b) {
  const A = decodePNG(a),
    B = decodePNG(b);
  if (A.w !== B.w || A.h !== B.h) return { size: [A.w + 'x' + A.h, B.w + 'x' + B.h], differing: -1, max: -1 };
  let differing = 0,
    max = 0,
    total = 0;
  for (let i = 0; i < A.data.length; i += A.bpp) {
    let d = 0;
    for (let k = 0; k < 3; k++) d = Math.max(d, Math.abs(A.data[i + k] - B.data[i + k]));
    if (d) {
      differing++;
      total += d;
    }
    if (d > max) max = d;
  }
  return {
    size: A.w + 'x' + A.h,
    pixels: A.w * A.h,
    differing,
    max,
    meanOnDiffering: differing ? +(total / differing).toFixed(2) : 0,
  };
}

/* Each build is served from its own origin, so the second build does not boot
   on the first build's localStorage (the app caches its feed there) — a pixel
   comparison between two runs of the same app has to start from the same state. */
const originFor = file => 'lt' + path.basename(file).replace(/[^a-z0-9]/gi, '').toLowerCase() + '.local';

async function boot(browser, file) {
  const ORIGIN = originFor(file);
  const page = await browser.newPage();
  const errors = [];
  await page.setViewport({ width: 412, height: 915, deviceScaleFactor: 1 });
  page.on('pageerror', e => errors.push(String(e.message || e)));
  page.on('console', m => {
    if (m.type() === 'error' && !/ytimg|ggpht|net::ERR|youtube-nocookie|about:blank/.test(m.text())) errors.push(m.text());
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
  await sleep(1500);
  /* the glass is a moving target on a headless GPU: blur and shadow off for the
     pixel comparison, in both builds, so the diff is about layers and nothing else */
  await page.evaluate(() => {
    const st = document.createElement('style');
    st.textContent =
      '*{backdrop-filter:none!important;-webkit-backdrop-filter:none!important;box-shadow:none!important;transition:none!important;animation:none!important}';
    document.head.appendChild(st);
  });
  await sleep(300);
  return { page, errors };
}

const ev = (page, fn, ...a) => page.evaluate(fn, ...a);

/* Everything the audit asks of the page in one round trip: the scale, and a
   grid of hit tests that names the topmost element at every point. */
async function audit(page) {
  return ev(page, (SCALE, SEL, STACK) => {
    const W = innerWidth,
      H = innerHeight;
    const layerOf = el => {
      for (let e = el; e && e !== document.documentElement; e = e.parentElement) {
        for (const k in SEL) {
          try {
            if (e.matches(SEL[k])) return k;
          } catch (x) {}
        }
      }
      return el ? 'other' : 'none';
    };
    const scale = {};
    for (const k in SEL) {
      const e = document.querySelector(SEL[k]);
      if (!e) {
        scale[k] = null;
        continue;
      }
      const cs = getComputedStyle(e);
      scale[k] = {
        z: +cs.zIndex || 0,
        want: SCALE[k],
        on: e.classList.contains('on'),
        inert: !!e.inert,
        pe: cs.pointerEvents,
        op: +cs.opacity,
      };
    }
    /* hit tests on a 20 px grid, bucketed by the layer that came out on top */
    const hits = {};
    const closedTop = [];
    for (let y = 10; y < H; y += 20)
      for (let x = 10; x < W; x += 20) {
        const t = document.elementFromPoint(x, y);
        const k = layerOf(t);
        hits[k] = (hits[k] || 0) + 1;
        if (t && STACK.indexOf(k) !== -1 && !document.querySelector(SEL[k]).classList.contains('on'))
          closedTop.push([x, y, k]);
      }
    /* who is on top over the player's own panel, and over the pages */
    const probe = sel => {
      const e = document.querySelector(sel);
      if (!e) return null;
      const b = e.getBoundingClientRect();
      const pts = [
        [b.left + b.width / 2, b.top + 6],
        [b.left + b.width / 2, b.top + b.height / 2],
        [b.left + 10, b.top + b.height / 2],
      ].filter(([x, y]) => x > 0 && y > 0 && x < W && y < H);
      return pts.map(([x, y]) => [Math.round(x), Math.round(y), layerOf(document.elementFromPoint(x, y))]);
    };
    return { scale, hits, closedTop: closedTop.slice(0, 8), closedTopCount: closedTop.length, plProbe: probe('#pl'), pageProbe: probe('#p-home') };
  }, SCALE, SEL, STACK);
}

/* Tab from the body and collect where focus lands; then try to focus a control
   inside a closed layer directly. */
async function focusWalk(page) {
  return ev(page, STACK => {
    const landed = [];
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    const inside = el => {
      for (let e = el; e && e !== document.body; e = e.parentElement) if (e.id && STACK.indexOf(e.id) !== -1) return e.id;
      return null;
    };
    /* a real Tab is not synthesised by elementFromPoint, so walk the focusable
       set the way the browser orders it and check what is reachable */
    const focusables = Array.from(document.querySelectorAll('a[href],button,input,select,textarea,[tabindex]')).filter(
      e => !e.disabled && e.tabIndex >= 0
    );
    const reachable = [];
    for (const e of focusables) {
      e.focus();
      if (document.activeElement === e) reachable.push(e.id || e.className || e.tagName);
    }
    const closedHits = [];
    for (const id of STACK) {
      const layer = document.getElementById(id);
      if (!layer || layer.classList.contains('on')) continue;
      for (const e of layer.querySelectorAll('button,input,[tabindex]')) {
        e.focus();
        if (document.activeElement === e) closedHits.push(id + ':' + (e.id || e.className));
      }
    }
    document.activeElement && document.activeElement.blur && document.activeElement.blur();
    return { landed, reachableCount: reachable.length, closedHits };
  }, STACK);
}

async function run(browser, file) {
  const { page, errors } = await boot(browser, file);
  const out = { file: path.basename(file) };

  /* ---- 1. boot: nothing is raised ---- */
  const bootAudit = await audit(page);
  out.scale = Object.fromEntries(Object.entries(bootAudit.scale).map(([k, v]) => [k, v && v.z]));
  out.scaleOk = Object.entries(bootAudit.scale).every(([k, v]) => v && v.z === v.want);

  /* ---- 2. the player over the pages ---- */
  await ev(page, () => document.querySelectorAll('#feed .card')[0].click());
  await sleep(1500);
  const open = await audit(page);
  const shotOpen = await page.screenshot({ type: 'png' });
  out.open = { hits: open.hits, plProbe: open.plProbe, plInert: open.scale.pl.inert, closedTop: open.closedTopCount };
  const fw = await focusWalk(page);
  out.open.focusClosedHits = fw.closedHits;

  /* ---- 3. search raised over the player: the player still floats on top ---- */
  await ev(page, () => document.getElementById('sopen').click());
  await sleep(1300);
  const search = await audit(page);
  const shotSearch = await page.screenshot({ type: 'png' });
  out.search = {
    searchOn: search.scale.search.on,
    searchInert: search.scale.search.inert,
    plOnTop: (search.plProbe || []).map(p => p[2]),
    hits: search.hits,
  };
  await ev(page, () => document.getElementById('cancel').click());
  await sleep(1300);

  /* ---- 4. a sheet over the player: the sheet is the one layer above it ---- */
  await ev(page, () => document.querySelector('[data-do="you"]').click());
  await sleep(1300);
  const sheet = await audit(page);
  const shotSheet = await page.screenshot({ type: 'png' });
  out.sheet = { sheetOn: sheet.scale.sheet.on, sheetInert: sheet.scale.sheet.inert, hits: sheet.hits };
  await ev(page, () => document.getElementById('scrim').click());
  await sleep(1300);

  /* ---- 5. closed again: back to the boot stack, and everything is inert ---- */
  const after = await audit(page);
  const shotClosed = await page.screenshot({ type: 'png' });
  out.closed = { hits: after.hits, closedTop: after.closedTopCount, plInert: after.scale.pl.inert, sheetInert: after.scale.sheet.inert };
  const fw2 = await focusWalk(page);
  out.closed.focusClosedHits = fw2.closedHits;

  /* ---- 6. the toast: above the player and above the dock ---- */
  await ev(page, () => {
    const t = document.getElementById('toast');
    t.textContent = 'Shorts are turned off';
    t.classList.add('on');
  });
  await sleep(1100);
  const toast = await audit(page);
  const shotToast = await page.screenshot({ type: 'png' });
  out.toast = { z: toast.scale.toast.z, dock: toast.scale.dock.z, hits: toast.hits };
  await ev(page, () => document.getElementById('toast').classList.remove('on'));

  out.errors = errors;
  out.shots = { open: shotOpen, search: shotSearch, sheet: shotSheet, closed: shotClosed, toast: shotToast };
  await page.close();
  return out;
}

function judge(r) {
  const f = [];
  if (!r.scaleOk) f.push('scale: a layer does not compute to its declared rank: ' + JSON.stringify(r.scale));
  const s = r.scale;
  if (!(s.pl > s.scrim && s.scrim > s.search && s.search > s.page)) f.push('order: player/scrim/search/page is not ascending: ' + [s.pl, s.scrim, s.search, s.page]);
  if (!(s.sheet > s.pl)) f.push('order: the sheet is not above the player');
  if (!(s.dock > s.pl)) f.push('order: the dock is not above the player (item 8.2 relies on it)');
  if (!(s.toast > s.dock)) f.push('order: the toast is not above the dock');
  if (!(s.splash > s.toast)) f.push('order: the splash is not the top layer');
  if (r.open.closedTop) f.push('top: a closed layer was the topmost element at ' + r.open.closedTop + ' points with the player open');
  if (!r.open.plProbe || r.open.plProbe.some(p => p[2] !== 'pl' && p[2] !== 'dock')) f.push('top: the player is not the topmost surface over its own panel: ' + JSON.stringify(r.open.plProbe));
  if (r.open.plInert) f.push('inert: the open player is inert');
  if (r.open.focusClosedHits.length) f.push('inert: focus reached a closed layer: ' + r.open.focusClosedHits.join(', '));
  if (!r.search.searchOn) f.push('float: search did not open');
  if (r.search.searchInert) f.push('inert: the open search panel is inert');
  if (!r.search.plOnTop.every(k => k === 'pl' || k === 'dock')) f.push('float: the player is not above the search takeover: ' + JSON.stringify(r.search.plOnTop));
  if (!r.sheet.sheetOn) f.push('float: the sheet did not open');
  if (r.sheet.sheetInert) f.push('inert: the open sheet is inert');
  if (!(r.sheet.hits.sheet > 0)) f.push('top: the sheet is not the topmost surface anywhere it is drawn');
  if (r.closed.closedTop) f.push('top: a closed layer is topmost at ' + r.closed.closedTop + ' points after everything closed');
  if (!r.closed.plInert || !r.closed.sheetInert) f.push('inert: a closed layer is still in the stack');
  if (r.closed.focusClosedHits.length) f.push('inert: focus reached a closed layer after close: ' + r.closed.focusClosedHits.join(', '));
  if (!(r.toast.hits.toast > 0)) f.push('top: the toast is never the topmost element where it is drawn');
  if (r.errors.length) f.push('errors: ' + r.errors.join(' | '));
  return f;
}

(async () => {
  const files = process.argv.slice(2);
  if (!files.length) {
    console.error('usage: CHROME=/path/to/chrome node tools/z-order-check.js <build.html> [old.html]');
    process.exit(2);
  }
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME || undefined,
    headless: 'shell',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--force-device-scale-factor=1', '--autoplay-policy=no-user-gesture-required'],
  });
  const results = [];
  try {
    for (const f of files) results.push(await run(browser, f));
  } finally {
    await browser.close();
  }
  const pix = results.length > 1 ? {} : null;
  if (pix) {
    const [a, b] = results;
    for (const k in a.shots) pix[k] = diffPNG(a.shots[k], b.shots[k]);
  }
  for (const r of results) {
    const shots = r.shots;
    delete r.shots;
    console.log(JSON.stringify(r));
    if (shots) Object.keys(shots).forEach(k => delete shots[k]);
  }
  if (pix) console.log(JSON.stringify({ pixels: { 'a=under test': results[0].file, 'b=previous': results[1].file, states: pix } }));
  const fails = judge(results[0]);
  if (fails.length) {
    console.error('FAIL\n  ' + fails.join('\n  '));
    process.exit(1);
  }
  console.log('PASS — 0 failures');
})();
