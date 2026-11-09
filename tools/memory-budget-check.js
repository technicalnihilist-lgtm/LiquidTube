#!/usr/bin/env node
/*
 * LiquidTube memory-budget check — item 4.10 ("document the memory budget in
 * this file").
 *
 * Items 4.1–4.9 each closed one container that could grow without limit: the
 * timers, the `V` registry, the page listeners, the player iframe, the saved
 * library, the `CH` channel map, the detached trees, the shelf caches. What was
 * never written down is the number the whole app is allowed to occupy — the
 * budget a later item has to fit inside. This tool is that budget, executable:
 * it drives the real UI through the heaviest session a phone can produce, reads
 * the app's own containers and the browser's own counters, and fails when any of
 * them goes over the ceiling documented in OPTIMIZATION.md.
 *
 * The session, in order, on one page — the worst realistic case, because every
 * step leaves something behind:
 *
 *   boot      the feed is up and the first paint has settled
 *   library   play / like / save a card each, so history, liked and later are
 *             all non-empty (they are persisted on every change)
 *   searches  8 distinct searches, 20 results each — the registry and the
 *             request cache see the most ids they ever will
 *   sections  Anime, Movies and Cartoon, so all three shelf caches exist both
 *             in memory and in storage
 *   tabs      Explore and Subscriptions, so every page has been built once
 *
 * What it reports, per build:
 *
 *   heap      JS heap after a forced GC: at boot and after the session
 *   nodes     live DOM elements and JS listeners at the end of the session
 *   detached  detached DOM trees and nodes at the end of the session
 *   storage   every `lt*` key in localStorage, in bytes (UTF-16 code units × 2)
 *   maps      `V`, `CH`, the request cache, the three shelf lists and the saved
 *             library, each against the ceiling the app itself enforces
 *
 * Usage:
 *   npm i puppeteer-core                    # dev only, not shipped in the APK
 *   CHROME=/path/to/chrome node tools/memory-budget-check.js <build-a.html> [build-b.html]
 * Exit code 1 when the build under test — the first file — is over budget.
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
/* A real title, at a real length: 40–70 characters, a mix of Latin and
   Devanagari, an emoji and a pipe — the shape of the strings the app actually
   keeps per video, in `V`, in the shelf caches and in storage. A one-word
   fixture would make every byte count in this tool a lie. */
const TITLE = (i, kind) =>
  ['हिंदी कार्टून कहानी', 'Full Episode in Hindi', 'Anime Explained', 'Best of 2026'][i % 4] +
  ' | ' +
  kind +
  ' number ' + (i + 1) +
  ' 🎬 with a longer tail so the string is realistic';
const SEARCHES = +process.env.SEARCHES || 8;
const PER = 20; // results per search, as maxResults asks for

/* ---------- the budget ----------
   The ceilings documented in OPTIMIZATION.md, "Memory budget — Day 4, item
   4.10". They are a phone-sized envelope, not a target: a mid-range Android
   WebView has ~200 MB of address space for a tab and the process is killed well
   before that, so the app's own share has to stay a small fraction of it. Each
   number is the measured footprint with headroom for a longer session than this
   one — the tool fails only when a change actually moves the app into the next
   order of magnitude, not when a fixture happens to be a little bigger. */
const BUDGET = {
  heapBootMB: 3, // JS heap after the first paint settles (measured 1.0)
  heapSessionMB: 6, // JS heap at the end of the heaviest session (measured 1.3)
  nodes: 2000, // live DOM elements at the end of the session (measured 729)
  listeners: 600, // JS event listeners at the end of the session (measured 189)
  detachedNodes: 0, // detached DOM nodes held after the session (measured 0)
  storageKB: 64, // every lt* key in localStorage, total (measured 11)
  mapBytesKB: 512, // V + CH as JSON, in memory (measured 131)
};

/* A hash of the query, so eight distinct searches answer eight distinct sets of
   ids: the same twenty ids eight times would measure one search, not eight. */
function qh(q) {
  let h = 0;
  for (let i = 0; i < q.length; i++) h = (h * 31 + q.charCodeAt(i)) >>> 0;
  return ('0000000' + h.toString(36)).slice(-7);
}
function searchFor(q) {
  return {
    items: Array.from({ length: PER }, (_, i) => {
      const id = 'q' + qh(q || 'x') + pad(i);
      return {
        id: { videoId: id },
        snippet: {
          title: TITLE(i, 'search result'),
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
      title: TITLE(i, 'trending video'),
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
    snippet: { title: TITLE(i, 'playlist item'), resourceId: { videoId: id }, publishedAt: ago(i * 24) },
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
  /* Same paint neutralisation as the other tools: software rasterisation makes a
     blurred full-screen panel cost hundreds of ms a frame, and the budget is a
     question about what the app retains, not about how fast the host paints. */
  await page.evaluate(() => {
    const st = document.createElement('style');
    st.textContent = '*{backdrop-filter:none!important;filter:none!important;box-shadow:none!important}';
    document.head.appendChild(st);
  });
  return { page, errors };
}

/* ---------- the measurement ----------
   Two forced collections: the first can leave a second wave of weak references
   dying, and a single pass reports a heap a leak-free build has already half
   released. `JSHeapUsedSize` after both is the number the budget is about. */
async function collect(cdp) {
  await cdp.send('HeapProfiler.collectGarbage');
  await cdp.send('HeapProfiler.collectGarbage');
}
async function detached(cdp) {
  try {
    await cdp.send('DOM.enable');
    const r = await cdp.send('DOM.getDetachedDomNodes');
    const trees = r.detachedNodes || [];
    return { trees: trees.length, nodes: trees.reduce((n, t) => n + (t.retainedNodeCount || 0), 0) };
  } catch (e) {
    return { trees: -1, nodes: -1 };
  }
}
async function sample(page, cdp) {
  await collect(cdp);
  const m = await page.metrics();
  const app = await page.evaluate(() => {
    const bytes = o => {
      try {
        return JSON.stringify(o || null).length * 2;
      } catch (e) {
        return -1;
      }
    };
    let storage = 0;
    const keys = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        const v = localStorage.getItem(k) || '';
        storage += (k.length + v.length) * 2;
        keys.push({ k, bytes: (k.length + v.length) * 2 });
      }
    } catch (e) {}
    keys.sort((a, b) => b.bytes - a.bytes);
    /* The app's containers are top-level `const`s in the page's script, so they
       are bindings in the global lexical scope: a bare name resolves, a
       `window[...]` lookup does not. `g()` reads one without throwing when the
       build under test does not have it. */
    const g = (fn, dflt) => {
      try {
        const v = fn();
        return v === undefined ? dflt : v;
      } catch (e) {
        return dflt;
      }
    };
    const secItems = ['anime', 'cartoon', 'movies'].reduce(
      (n, k) => n + g(() => SEC[k].length, 0),
      0
    );
    return {
      elements: document.getElementsByTagName('*').length,
      cards: document.querySelectorAll('.card').length,
      imgs: document.images.length,
      v: g(() => Object.keys(V).length, -1),
      vMax: g(() => V_MAX, -1),
      vHi: g(() => V_HI, -1),
      ch: g(() => Object.keys(CH).length, -1),
      chMax: g(() => CH_MAX, -1),
      rq: g(() => RQ.size, -1),
      rqMax: g(() => RQ_MAX, -1),
      secItems,
      shelfItems: g(() => Object.keys(SHELF).reduce((n, k) => n + SHELF[k].length, 0), 0),
      sec: { anime: g(() => SEC.anime.length, 0), cartoon: g(() => SEC.cartoon.length, 0), movies: g(() => SEC.movies.length, 0) },
      hist: g(() => S.hist.length, -1),
      liked: g(() => S.liked.length, -1),
      later: g(() => S.later.length, -1),
      histMax: g(() => HIST_MAX, -1),
      likedMax: g(() => LIKED_MAX, -1),
      laterMax: g(() => LATER_MAX, -1),
      vd: g(() => Object.keys(S.vd || {}).length, -1),
      durNone: g(() => DUR_NONE.size, -1),
      mapBytes: g(() => bytes(V), 0) + g(() => bytes(CH), 0),
      feedBytes: g(() => bytes(FEED.trending), 0),
      storage,
      storageKeys: keys.slice(0, 8),
    };
  });
  return {
    heapKB: Math.round(m.JSHeapUsedSize / 1024),
    nodes: m.Nodes,
    docs: m.Documents,
    listeners: m.JSEventListeners,
    ...app,
  };
}

/* The heaviest realistic session. Every step is a real gesture on the real UI —
   the tool never calls a loader the user could not reach — because a budget
   measured by calling functions directly is a budget for a session nobody has. */
/* The measurement's own check, on the same heap the budget is read from: 8 MB of
   retained objects must show up as a rise, and must be gone once released. A run
   that reports a flat, small heap proves nothing about the app unless the tool
   can show it would have seen a big one. Plain objects and arrays only: a typed
   array's bytes are external memory and a long string is not in `JSHeapUsedSize`
   either, so a probe built from either would report the same number whether or
   not the measurement works. 100,000 of these is ~8 MB. */
async function probe(page, cdp) {
  const before = await sample(page, cdp);
  await page.evaluate(() => {
    const keep = [];
    for (let i = 0; i < 100000; i++) keep.push({ a: i, b: 'p' + i, c: [i, i + 1] });
    window.__ltMemProbe = keep;
    return keep.length;
  });
  const held = await sample(page, cdp);
  await page.evaluate(() => {
    window.__ltMemProbe = null;
  });
  const after = await sample(page, cdp);
  return {
    beforeKB: before.heapKB,
    heldKB: held.heapKB,
    afterKB: after.heapKB,
    riseKB: held.heapKB - before.heapKB,
    backKB: after.heapKB - before.heapKB,
  };
}

async function session(page) {
  const ev = (fn, ...a) => page.evaluate(fn, ...a);
  const steps = {};

  /* 1. library: one card played, one liked, one saved — three separate videos,
        so all three saved lists carry an entry and the state is rewritten. */
  steps.play = await ev(() => {
    const cards = [...document.querySelectorAll('#feed .card')];
    if (!cards.length) return null;
    const id = cards[0].dataset.v;
    cards[0].click();
    return id;
  });
  await sleep(600);
  steps.like = await ev(() => {
    const b = document.getElementById('ppp');
    if (b) b.click();
    const id = document.querySelector('#feed .card') && document.querySelector('#feed .card').dataset.v;
    return id;
  });
  await sleep(250);
  steps.save = await ev(() => {
    const b = document.getElementById('psave');
    if (b) b.click();
    return true;
  });
  await sleep(250);
  await ev(() => document.getElementById('pclose').click());
  await sleep(400);

  /* 2. searches: distinct queries, so every one answers 20 ids the registry has
        never seen and the request cache fills up. */
  for (let i = 0; i < SEARCHES; i++) {
    const q = 'budget query ' + i;
    await ev(q2 => {
      const el = document.getElementById('q');
      if (!el) return;
      el.value = q2;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, q);
    await page.waitForFunction(n => document.querySelectorAll('#results .card').length >= n, { timeout: 30000 }, PER);
  }
  steps.searches = SEARCHES;
  await ev(() => {
    const c = document.getElementById('cancel');
    if (c) c.click();
  });
  await sleep(400);

  /* 3. the three top chips that are really sections: Anime, Movies, Cartoon.
        Each one loads its own list, its own shelf cache and its own storage
        entry, and all three stay in `SEC` for the rest of the session. */
  steps.sections = [];
  for (const name of ['Anime', 'Movies', 'Cartoon']) {
    const ok = await ev(n => {
      const b = [...document.querySelectorAll('#chips .chip')].find(x => x.textContent === n);
      if (!b) return false;
      b.click();
      return true;
    }, name);
    if (!ok) continue;
    try {
      await page.waitForFunction(
        () => {
          const f = document.getElementById('feed');
          return f && (f.querySelectorAll('.card').length > 0 || f.querySelector('.empty'));
        },
        { timeout: 25000 }
      );
    } catch (e) {}
    await sleep(500);
    steps.sections.push(name);
  }
  await ev(() => {
    const b = [...document.querySelectorAll('#chips .chip')].find(x => x.textContent === 'All');
    if (b) b.click();
  });
  await sleep(500);

  /* 4. Explore, which paints all three shelves, then Subscriptions, then Home:
        every page the dock can reach has now been built once. */
  steps.pages = [];
  for (const n of ['Explore', 'Subscriptions', 'Home']) {
    const ok = await ev(name => {
      const t = [...document.querySelectorAll('#tabrow .tab')].find(b => b.textContent === name);
      if (!t) return false;
      t.click();
      return true;
    }, n);
    if (ok) steps.pages.push(n);
    await sleep(900);
  }
  return steps;
}

async function run(browser, file) {
  const { page, errors } = await boot(browser, file);
  const cdp = await page.target().createCDPSession();
  await cdp.send('HeapProfiler.enable');
  const out = { file: path.basename(file) };

  out.probe = await probe(page, cdp);
  out.boot = await sample(page, cdp);
  out.steps = await session(page);
  out.end = await sample(page, cdp);
  out.detached = await detached(cdp);
  out.errors = errors.slice(0, 6);
  await page.close();
  return out;
}

function over(label, value, ceiling, unit) {
  return value > ceiling ? label + ' ' + value + unit + ' over ' + ceiling + unit : null;
}

function verdict(r) {
  const fails = [];
  const b = r.boot;
  const e = r.end;
  const push = x => {
    if (x) fails.push(x);
  };
  push(over('boot heap', Math.round(b.heapKB / 1024), BUDGET.heapBootMB, ' MB'));
  push(over('session heap', Math.round(e.heapKB / 1024), BUDGET.heapSessionMB, ' MB'));
  push(over('live elements', e.elements, BUDGET.nodes, ''));
  push(over('JS listeners', e.listeners, BUDGET.listeners, ''));
  push(over('detached nodes', r.detached.nodes, BUDGET.detachedNodes, ''));
  push(over('localStorage', Math.round(e.storage / 1024), BUDGET.storageKB, ' KB'));
  push(over('V+CH as JSON', Math.round(e.mapBytes / 1024), BUDGET.mapBytesKB, ' KB'));
  /* The app's own ceilings are the budget for the containers that have one: a
     session that leaves a map above its own cap has a bug, not a budget. */
  if (e.v > e.vHi) fails.push('V holds ' + e.v + ' entries, above its ceiling of ' + e.vHi);
  if (e.ch > e.chMax) fails.push('CH holds ' + e.ch + ' channels, above its ceiling of ' + e.chMax);
  if (e.rq > e.rqMax) fails.push('the request cache holds ' + e.rq + ', above its ceiling of ' + e.rqMax);
  if (e.hist > e.histMax) fails.push('history holds ' + e.hist + ', above its ceiling of ' + e.histMax);
  if (e.liked > e.likedMax) fails.push('liked holds ' + e.liked + ', above its ceiling of ' + e.likedMax);
  if (e.later > e.laterMax) fails.push('later holds ' + e.later + ', above its ceiling of ' + e.laterMax);
  if (e.storageKeys.length && e.storageKeys[0].bytes > BUDGET.storageKB * 1024)
    fails.push('one storage key is over the whole storage budget: ' + e.storageKeys[0].k);
  /* The probe: 8 MB held must be visible, and must be released. Without it a
     PASS only means the tool looked, not that it could see. */
  if (!r.probe || r.probe.riseKB < 5000) fails.push('the heap probe saw only +' + (r.probe ? r.probe.riseKB : 0) + ' KB of 8 MB held');
  if (r.probe && r.probe.backKB > 600) fails.push('the heap probe left ' + r.probe.backKB + ' KB behind after release');
  if (r.errors.length) fails.push('console/page errors: ' + r.errors.join(' | '));
  return { ok: fails.length === 0, fails };
}

const mb = kb => (kb / 1024).toFixed(1) + ' MB';
const kb = n => Math.round(n) + ' KB';

function report(r) {
  const b = r.boot;
  const e = r.end;
  const row = (label, value, ceiling, ok) =>
    '  ' + label.padEnd(22) + String(value).padStart(12) + String(ceiling).padStart(14) + '   ' + (ok ? 'ok' : 'OVER');
  console.log('\n' + r.file + ' — memory budget (Day 4, item 4.10)');
  console.log('  ' + 'measure'.padEnd(22) + 'measured'.padStart(12) + 'budget'.padStart(14));
  console.log(row('heap at boot', mb(b.heapKB), BUDGET.heapBootMB + ' MB', b.heapKB / 1024 <= BUDGET.heapBootMB));
  console.log(row('heap after session', mb(e.heapKB), BUDGET.heapSessionMB + ' MB', e.heapKB / 1024 <= BUDGET.heapSessionMB));
  console.log(row('live elements', e.elements, BUDGET.nodes, e.elements <= BUDGET.nodes));
  console.log(row('JS listeners', e.listeners, BUDGET.listeners, e.listeners <= BUDGET.listeners));
  console.log(row('detached nodes', r.detached.nodes, BUDGET.detachedNodes, r.detached.nodes <= BUDGET.detachedNodes));
  console.log(row('localStorage', kb(e.storage / 1024), BUDGET.storageKB + ' KB', e.storage / 1024 <= BUDGET.storageKB));
  console.log(row('V + CH as JSON', kb(e.mapBytes / 1024), BUDGET.mapBytesKB + ' KB', e.mapBytes / 1024 <= BUDGET.mapBytesKB));
  console.log(
    '  containers: V ' + e.v + '/' + e.vHi + ', CH ' + e.ch + '/' + e.chMax + ', RQ ' + e.rq + '/' + e.rqMax +
      ', shelf items ' + e.secItems + ' (' + e.sec.anime + '/' + e.sec.movies + '/' + e.sec.cartoon + ')' +
      ', explore shelves ' + e.shelfItems + ', hist/liked/later ' + e.hist + '/' + e.liked + '/' + e.later +
      ', S.vd ' + e.vd + ', DUR_NONE ' + e.durNone
  );
  console.log(
    '  storage keys: ' + e.storageKeys.map(k => k.k + ' ' + kb(k.bytes / 1024)).join(', ')
  );
  console.log('  heap at boot ' + mb(b.heapKB) + ' → after session ' + mb(e.heapKB) + ' (+' + mb(e.heapKB - b.heapKB) + ')');
  console.log(
    '  probe: 8 MB held read as +' + kb(r.probe.riseKB) + ', ' + kb(Math.abs(r.probe.backKB)) + ' ' +
      (r.probe.backKB >= 0 ? 'still held' : 'released past the baseline') + ' after release'
  );
  if (r.errors.length) console.log('  errors: ' + r.errors.join(' | '));
  console.log('  verdict: ' + (r.verdict.ok ? 'PASS' : 'FAIL — ' + r.verdict.fails.join('; ')));
}

(async () => {
  const files = process.argv.slice(2);
  if (!files.length) {
    console.error('usage: node tools/memory-budget-check.js <build-a.html> [build-b.html]');
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
      report(r);
    }
  } finally {
    await browser.close();
  }
  process.exit(out[0] && out[0].verdict.ok ? 0 : 1);
})();
