#!/usr/bin/env node
/*
 * LiquidTube layout-thrash bench — counts and times every layout-forcing DOM
 * read on the boot path (and while scrolling), so "read/write in separate
 * passes" can be checked instead of assumed.
 *
 * A "forced layout" is any DOM read that has to flush pending style/layout work
 * before it can answer. Chromium exposes no counter for that, so the read APIs
 * the app uses are wrapped: each call is timed, and a call that takes a
 * measurable amount of time is one that actually flushed (a read against a clean
 * tree is a property load, well under 0.25 ms; a flush on this shell costs
 * 0.3–6 ms at 4x CPU throttle). Both numbers are reported — the count, and the
 * time spent inside reads, which is the part the user feels.
 *
 * Two windows:
 *   boot       navigation start → the first feed card, plus the first
 *              depth/parallax pass that follows it (parse, skeleton shell, first
 *              frame, the feed landing, the first animation frame)
 *   interact   a scroll session and two tab switches after that
 *
 * Usage:
 *   npm i puppeteer-core                    # dev only, not shipped in the APK
 *   CHROME=/path/to/chrome node tools/layout-thrash-bench.js [file] [cpu] [reps]
 *   node tools/layout-thrash-bench.js app/assets/index.html 4 5
 *
 * It also prints an `equiv` block — the lens geometry for a set of tab positions
 * and the inline transforms of every card and thumbnail after a scroll — so two
 * builds can be diffed for identical rendering. Run it against both builds and
 * diff the JSON line.
 */
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const FILE = process.argv[2] || path.join(__dirname, '..', 'app/assets/index.html');
const CPU = Math.max(1, +(process.argv[3] || 4));
const REPS = Math.max(1, +(process.argv[4] || 5));
const ORIGIN = 'liquidtube.local';
const API_DELAY = 150;
const HTML = fs.readFileSync(FILE);

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64');

const pad = n => String(n).padStart(2, '0');
const vids = Array.from({ length: 24 }, (_, i) => 'v' + pad(i + 1) + 'AAAAAAAA');
const CH_IDS = Array.from({ length: 6 }, (_, i) => 'UC' + i + 'xxxxxxxxxxxxxxxxxxxx');
const ago = h => new Date(Date.now() - h * 36e5).toISOString();

// Same fixture shape as tools/startup-bench.js, so the two tools measure the
// same feed (24 cards, 6 channels, 3 shelves, 6 subscriptions).
/* The API answers a `channels` call with the ids it was asked for, and with an
   empty `items` for an id it does not know. A mock that always answers with its
   whole channel list instead would let a one-id lookup hand back a different
   channel than the one asked for — something the real endpoint never does — so
   every harness echoes the requested ids here and synthesises the ones its
   fixture does not hold. */
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
  if (p.endsWith('/videos')) {
    if ((u.searchParams.get('part') || '').includes('contentDetails')) {
      return { items: vids.map(id => ({ id, contentDetails: { duration: 'PT12M30S' } })) };
    }
    return {
      items: vids.map((id, i) => ({
        id,
        snippet: {
          title: 'Sample trending video number ' + (i + 1) + ' with a realistic title',
          channelTitle: 'Channel ' + (i % 6),
          channelId: CH_IDS[i % 6],
          publishedAt: ago(i + 1),
          categoryId: ['10', '20', '24', '25', '27', '17'][i % 6],
        },
        statistics: { viewCount: String(1000 * (i + 1) * 7) },
      })),
    };
  }
  if (p.endsWith('/channels')) {
    return chanAnswer(url, {
      items: CH_IDS.map((id, i) => ({
        id,
        snippet: {
          title: 'Channel ' + i,
          customUrl: 'channel' + i,
          publishedAt: '2015-04-02T10:00:00Z',
          country: 'IN',
          description: 'A sample channel used for benchmarking startup.',
          thumbnails: { medium: { url: 'https://yt3.ggpht.com/av' + i + '.jpg' } },
        },
        statistics: { subscriberCount: '1200000', videoCount: '480', viewCount: '91000000' },
        contentDetails: { relatedPlaylists: { uploads: 'UU' + i + 'xxxxxxxxxxxxxxxxxxxx' } },
        brandingSettings: { image: { bannerExternalUrl: '' }, channel: {} },
      })),
    });
  }
  if (p.endsWith('/playlistItems')) {
    return {
      items: vids.slice(0, 12).map((id, i) => ({
        snippet: { title: 'Playlist item ' + i, resourceId: { videoId: id }, publishedAt: ago(i * 24) },
        contentDetails: { videoPublishedAt: ago(i * 24) },
      })),
    };
  }
  if (p.endsWith('/search')) {
    return {
      items: vids.slice(0, 20).map((id, i) => ({
        id: { videoId: id },
        snippet: {
          title: 'Search result ' + i,
          channelTitle: 'Channel ' + (i % 6),
          channelId: CH_IDS[i % 6],
          publishedAt: ago(i * 24),
        },
      })),
    };
  }
  return {};
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Instrumentation: wrap every layout-forcing read the app can make. Each call is
// recorded with its timestamp; the phases are assigned afterwards from the app's
// own marks, because a headless page can report itself hidden and fire them all
// synchronously (the app then short-circuits its first-frame wait).
const INSTRUMENT = () => {
  const st = { reads: [], t0: performance.now() };
  window.__ltThrash = st;
  const now = () => performance.now();
  const rec = (label, t, dt) => { st.reads.push([t, dt, label]); };
  const wrapGet = (proto, name, label) => {
    const d = Object.getOwnPropertyDescriptor(proto, name);
    if (!d || !d.get) return;
    try {
      Object.defineProperty(proto, name, {
        configurable: true, enumerable: d.enumerable, set: d.set,
        get() { const t = now(); const v = d.get.call(this); rec(label || name, t, now() - t); return v; },
      });
    } catch (e) {}
  };
  // offsetWidth/Height live on HTMLElement, the client* and scroll* boxes on
  // Element; both are wrapped so nothing the app reads can slip through.
  for (const proto of [HTMLElement.prototype, Element.prototype]) {
    wrapGet(proto, 'offsetWidth');
    wrapGet(proto, 'offsetHeight');
    wrapGet(proto, 'clientWidth');
    wrapGet(proto, 'clientHeight');
    wrapGet(proto, 'scrollTop');
    wrapGet(proto, 'scrollLeft');
    wrapGet(proto, 'scrollHeight');
    wrapGet(proto, 'scrollWidth');
  }
  const gbcr = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function () {
    const t = now(); const v = gbcr.call(this); rec('gBCR', t, now() - t); return v;
  };
  const gcr = Element.prototype.getClientRects;
  Element.prototype.getClientRects = function () {
    const t = now(); const v = gcr.call(this); rec('gCR', t, now() - t); return v;
  };
  const gcs = window.getComputedStyle;
  window.getComputedStyle = function () {
    const t = now(); const v = gcs.apply(window, arguments); rec('gCS', t, now() - t); return v;
  };
};

/* Split the recorded reads into the two windows that matter: the boot session
   (navigation start → the first feed frame → the first depth/parallax pass) and
   the interaction session that follows. The split is a timestamp, not a counter
   reset, so a pass that lands while the harness is talking to the page cannot be
   lost or double counted. */
const BUCKET = () => {
  const st = window.__ltThrash;
  const t0 = st.t0 || 1e9;
  const marks = {};
  performance.getEntriesByType('mark').forEach(m => { if (m.name.indexOf('lt:') === 0) marks[m.name.slice(3)] = m.startTime; });
  const out = { boot: { n: 0, ms: 0, flush: 0 }, interact: { n: 0, ms: 0, flush: 0 }, where: {}, marks };
  for (const [t, dt, label] of st.reads) {
    const b = t < t0 ? out.boot : out.interact;
    b.n++; b.ms += dt; if (dt >= 0.25) b.flush++;
    if (t < t0) out.where[label] = (out.where[label] || 0) + 1;
  }
  return out;
};

async function measure(browser) {
  const page = await browser.newPage();
  await page.setViewport({ width: 412, height: 892, deviceScaleFactor: 2 });
  const cdp = await page.target().createCDPSession();
  if (CPU > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU });

  await page.evaluateOnNewDocument(INSTRUMENT);

  await page.setRequestInterception(true);
  page.on('request', async req => {
    const u = req.url();
    if (u.startsWith('https://' + ORIGIN + '/')) {
      return req.respond({
        status: 200, contentType: 'text/html; charset=utf-8',
        headers: { 'Cache-Control': 'no-cache' }, body: HTML,
      });
    }
    if (/googleapis\.com/.test(u)) {
      await sleep(API_DELAY);
      return req.respond({
        status: 200, contentType: 'application/json',
        headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(apiBody(u)),
      });
    }
    if (/ytimg\.com|ggpht\.com|googleusercontent\.com/.test(u)) {
      return req.respond({ status: 200, contentType: 'image/png', body: PNG });
    }
    return req.abort();
  });

  await page.goto('https://' + ORIGIN + '/index.html', { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(
    () => document.getElementById('feed') && document.getElementById('feed').querySelector('.card'),
    { timeout: 60000 });
  await sleep(400);            // let the first post-feed depth/parallax pass run

  // Interaction session: scroll the home page (drives the depth + parallax
  // passes) and switch tabs twice (drives the lens/replay restart).
  await page.evaluate(async () => {
    window.__ltThrash.t0 = performance.now();   // boot window ends here
    const home = document.getElementById('p-home');
    const frame = () => new Promise(r => requestAnimationFrame(r));
    for (const y of [200, 500, 900, 1400, 900, 500, 200, 0]) {
      home.scrollTop = y;
      await frame();
      await frame();
    }
    const tabs = document.getElementById('tabs');
    const rect = tabs.getBoundingClientRect();
    const tap = x => {
      const o = { bubbles: true, clientX: x, clientY: rect.top + rect.height / 2, pointerId: 1, pointerType: 'touch' };
      tabs.dispatchEvent(new PointerEvent('pointerdown', o));
      tabs.dispatchEvent(new PointerEvent('pointerup', o));
    };
    tap(rect.left + rect.width * 0.5);
    await frame(); await frame();
    tap(rect.left + rect.width * 0.17);
    await frame(); await frame();
  });
  await sleep(150);

  const both = await page.evaluate(BUCKET);

  // Equivalence block: geometry that must not move between builds.
  const equiv = await page.evaluate(async () => {
    // Freeze transitions and keyframes: the lens' jelly animation scales it, and a
    // measurement taken mid-animation says nothing about where it settles.
    const freeze = document.createElement('style');
    freeze.textContent = '*,*::before,*::after{transition:none!important;animation:none!important}' +
      'html{scroll-behavior:auto!important}';
    document.head.appendChild(freeze);
    const frame = () => new Promise(r => requestAnimationFrame(r));
    const lens = document.getElementById('lens');
    const tabs = document.getElementById('tabs');
    const out = { lens: [], cards: [], imgs: [] };
    for (const p of [0, 1, 2, 0.5, 1.5]) {
      go(p);
      await frame();
      out.lens.push({
        pos: p,
        // what the shell actually renders, independent of how it was expressed
        left: +lens.getBoundingClientRect().left.toFixed(3),
        width: +lens.getBoundingClientRect().width.toFixed(3),
        strip: +tabs.getBoundingClientRect().width.toFixed(3),
      });
    }
    go(0);
    const home = document.getElementById('p-home');
    // Set twice: a smooth scroll started by a tab tap can still be running and
    // would otherwise move the offset between the pass and the read.
    home.scrollTop = 640;
    await frame(); await frame();
    home.scrollTop = 640;
    await frame(); await frame();
    // Run one pass explicitly at the settled offset, so both builds are compared
    // on the same frame rather than on whatever the last scroll event left behind.
    // The inline transforms are cleared first: a pass leaves off-screen elements
    // untouched, so without this the snapshot would carry stale values written at
    // an earlier scroll offset.
    document.querySelectorAll('#feed .card,#feed .thumb img').forEach(e => { e.style.transform = ''; e.style.opacity = ''; });
    depthKick(); parallaxKick();
    await frame(); await frame();
    out.cards = [...document.querySelectorAll('#feed .card')].map(c => [c.style.transform, c.style.opacity]);
    out.imgs = [...document.querySelectorAll('#feed .thumb img')].map(i => i.style.transform);
    out.scroll = home.scrollTop;
    return out;
  });

  await page.close();
  return { both, equiv };
}

const median = a => {
  const s = a.slice().sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

(async () => {
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME || '/usr/bin/google-chrome',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--hide-scrollbars'],
  });

  await measure(browser);   // discarded warm-up

  const reps = [];
  for (let i = 0; i < REPS; i++) reps.push(await measure(browser));
  await browser.close();

  const pick = (phase, key) => median(reps.map(r => r.both[phase][key]));
  const r2 = n => +n.toFixed(2);
  const out = {
    file: path.basename(FILE),
    cpu: CPU,
    reps: REPS,
    boot: {
      reads: r2(pick('boot', 'n')),
      ms: r2(pick('boot', 'ms')),
      flushes: r2(pick('boot', 'flush')),
      where: reps[0].both.where,
    },
    interact: {
      reads: r2(pick('interact', 'n')),
      ms: r2(pick('interact', 'ms')),
      flushes: r2(pick('interact', 'flush')),
    },
    equiv: reps[0].equiv,
  };

  console.log('LiquidTube layout-thrash bench — ' + path.basename(FILE) +
              ', ' + CPU + 'x CPU throttle, median of ' + REPS + ' cold runs');
  console.log('');
  console.log('phase'.padEnd(12) + 'reads'.padStart(8) + 'forced'.padStart(9) + 'read ms'.padStart(10));
  for (const k of ['boot', 'interact']) {
    console.log(k.padEnd(12) + String(out[k].reads).padStart(8) +
                String(out[k].flushes).padStart(9) + String(out[k].ms).padStart(10));
  }
  console.log('');
  console.log('boot reads by API  ' + JSON.stringify(out.boot.where));
  console.log('marks (ms)         ' + JSON.stringify(Object.fromEntries(
    Object.entries(reps[0].both.marks || {}).map(([k, v]) => [k, Math.round(v)]))));
  console.log('');
  console.log('lens geometry');
  for (const l of out.equiv.lens) {
    console.log('  pos ' + String(l.pos).padEnd(4) + ' left ' + l.left + '  width ' + l.width +
                '  strip ' + l.strip);
  }
  console.log('scroll ' + out.equiv.scroll + ', cards ' + out.equiv.cards.length +
              ', thumbs ' + out.equiv.imgs.length);
  console.log('');
  console.log('EQUIV ' + JSON.stringify(out.equiv));
})().catch(e => { console.error(e); process.exit(1); });
