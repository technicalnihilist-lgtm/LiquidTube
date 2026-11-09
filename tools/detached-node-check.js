#!/usr/bin/env node
/*
 * LiquidTube detached-node check — item 4.7 ("verify no detached DOM nodes
 * after 20 tab switches").
 *
 * A tab switch in this build is a transform on three pages that are already in
 * the document: `render()` moves the strip's lens, slides the pages, flips
 * `inert` and calls `replay()`, and nothing is created or removed. So the
 * question this tool answers is not "how many nodes does a switch build" but
 * "what does a switch leave behind that the document no longer holds": a node
 * that has been replaced by an `innerHTML` write, or dropped by a re-render, but
 * is still reachable from a module-level array, a timer, or a closure — which is
 * a node the collector can never take back, and the one kind of leak a scroll
 * benchmark cannot see.
 *
 * It drives the real UI on a real browser with the API mocked and reports, per
 * build:
 *
 *   probe      the detector's own check: four nodes are created, removed and
 *              held, and must show up as detached; released, and must go. A run
 *              that reports zero proves nothing without this
 *   boot       detached DOM nodes reachable after the first paint has settled
 *              and a forced GC, with the JS heap beside it — the baseline
 *   rerender   five chip taps in the default configuration: each one replaces
 *              the feed's `innerHTML`, so every card the old feed held is
 *              detached. The frame pass follows, so none of them may be held
 *   switches   twenty tab switches, each one followed by a short scroll of the
 *              page it landed on (so the frame pass is exercised too), sampled
 *              at 10 and at 20 — with the live element count either side
 *   off        the same session with depth and parallax switched off through
 *              the settings sheet: `frameRun` returns before the frame cache is
 *              synced, so a mutation is the only thing that can let a replaced
 *              feed go. A full feed is put back, then replaced — one render
 *   names      what those detached nodes are, by node name — a card that keeps
 *              appearing here names the array that holds it
 *   end        detached nodes and heap once the player has been opened and
 *              closed and the library has been looked at
 *
 * Usage:
 *   npm i puppeteer-core                    # dev only, not shipped in the APK
 *   CHROME=/path/to/chrome node tools/detached-node-check.js <build-a.html> [build-b.html]
 * SWITCHES=20 (default) sets the session length; SETTLE=120 (ms) the pause
 * between a switch and the sample that follows it.
 * Exit code 1 when the build under test — the first file — fails any check.
 */
const path = require('path');
const puppeteer = require('puppeteer-core');

const ORIGIN = 'liquidtube.local';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64'
);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SWITCHES = +process.env.SWITCHES || 20;
const SETTLE = +process.env.SETTLE || 120;
const pad = n => String(n).padStart(2, '0');
const vids = Array.from({ length: 24 }, (_, i) => 'v' + pad(i + 1) + 'AAAAAAAA');
const CH = Array.from({ length: 6 }, (_, i) => 'UC' + i + 'xxxxxxxxxxxxxxxxxxxx');
const ago = h => new Date(Date.now() - h * 36e5).toISOString();

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
  const errors = [];
  page.on('pageerror', e => errors.push(String(e.message || e)));
  page.on('console', m => {
    if (m.type() === 'error' && !/ytimg|ggpht|net::ERR/.test(m.text())) errors.push(m.text());
  });
  await page.setRequestInterception(true);
  page.on('request', req => {
    const u = req.url();
    if (u.startsWith('https://' + ORIGIN + '/index.html') || u === 'https://' + ORIGIN + '/') {
      const body = require('fs').readFileSync(file);
      return req.respond({ status: 200, contentType: 'text/html', body });
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

/* ---------- detached DOM nodes, from the DevTools DOM domain ----------
   `DOM.getDetachedDomNodes` is the call behind DevTools' "Detached elements"
   panel: Blink walks the DOM wrapper space after a GC and returns every tree that
   is no longer in a document but is still reachable from script, which is the
   only definition that matters here — a node the collector could not take. Each
   entry is one detached *tree* with its retained descendants, so the count that
   is reported is the number of nodes, not of trees: a feed of 30 cards dropped
   while something still points at one card is one tree and hundreds of nodes.
   The probe below proves the measurement is live before the session is measured
   with it: four nodes are created, removed and held, and must show up. */
async function snapshot(page) {
  const s = await page.target().createCDPSession();
  let trees = [];
  let supported = true;
  try {
    await s.send('HeapProfiler.enable');
    await s.send('HeapProfiler.collectGarbage');
  } catch (e) {}
  try {
    await s.send('DOM.enable');
    const r = await s.send('DOM.getDetachedDomNodes');
    trees = r.detachedNodes || [];
  } catch (e) {
    supported = false;
  }
  const m = await page.metrics();
  await s.detach();
  const byName = new Map();
  let nodes = 0;
  const walk = t => {
    nodes++;
    const n = t.nodeName || '?';
    byName.set(n, (byName.get(n) || 0) + 1);
    (t.children || []).forEach(walk);
  };
  trees.forEach(t => walk(t.treeNode));
  return {
    supported,
    trees: trees.length,
    detached: nodes,
    heapKB: Math.round((m.JSHeapUsedSize || 0) / 1024),
    documents: Math.round((m.Documents || 0)),
    names: [...byName.entries()].sort((a, b) => b[1] - a[1]),
  };
}

/* The detector's own check: hold four detached nodes, see them, let them go, see
   them gone. Without this a run that reports zero detached nodes proves nothing —
   a broken measurement and a clean build look exactly the same. */
async function probe(page) {
  const held = await page.evaluate(() => {
    const keep = [];
    for (let i = 0; i < 4; i++) {
      const d = document.createElement('div');
      d.innerHTML = '<b>probe</b>';
      document.body.appendChild(d);
      keep.push(d);
      document.body.removeChild(d);
    }
    window.__ltProbe = keep;
    return keep.length * 2; /* the div and its <b> */
  });
  const withHold = await snapshot(page);
  await page.evaluate(() => {
    window.__ltProbe = null;
  });
  const afterRelease = await snapshot(page);
  return { held, withHold, afterRelease };
}

/* Live elements, so a session that holds no detached node but grows the document
   is still visible as a difference. */
const liveCount = page =>
  page.evaluate(() => ({
    elements: document.getElementsByTagName('*').length,
    cards: document.querySelectorAll('.card').length,
    pages: document.querySelectorAll('.page').length,
    iframes: document.querySelectorAll('iframe').length,
  }));

/* One tab switch, the way a finger does it: press the strip, land on the next
   tab, then a short scroll of the page that came up. The scroll matters as much
   as the switch — it is what runs the frame pass that reads the card arrays, and
   a card array left pointing at a replaced feed is exactly the hold this item is
   about. */
async function switchTab(page, i) {
  await page.evaluate(n => {
    const t = document.querySelectorAll('#tabs .tab')[n % 3];
    if (t) t.click();
  }, i);
  await sleep(SETTLE);
  await page.evaluate(() => {
    const pg = [...document.querySelectorAll('.page')].find(p => !p.inert);
    if (pg) pg.scrollTop = (pg.scrollTop || 0) + 140;
    window.scrollTo(0, 0);
  });
  await sleep(80);
}

/* One chip tap: a different category each time, so each tap replaces the whole
   feed rather than re-selecting the one already on screen. This is the app's own
   re-render path — `list()` writes the feed's `innerHTML` and every card the
   previous feed held becomes detached. */
async function chip(page, i) {
  const before = await page.evaluate(() => domGen);
  await page.evaluate(n => {
    const b = document.querySelectorAll('#chips button');
    if (b.length) b[n % b.length].click();
  }, i);
  await sleep(450);
  const after = await page.evaluate(() => domGen);
  return after - before;
}

/* Both effects off, through the settings sheet, the way a user does it: the
   depth and parallax toggles are what `frameRun` checks before it syncs the
   frame cache, so with them off no frame ever empties the card arrays. */
async function effectsOff(page) {
  const state = () => page.evaluate(() => ({ depth: S.opt.depth, parallax: S.opt.parallax }));
  for (let attempt = 0; attempt < 3; attempt++) {
    const now = await state();
    if (now.depth === 0 && now.parallax === 0) return now;
    /* Nothing may be on screen when the library opens, or the click lands on the
       scrim of the sheet that is already there. */
    await page.evaluate(() => {
      const s = document.getElementById('scrim');
      if (s && s.classList.contains('on')) s.click();
    });
    await sleep(350);
    await page.evaluate(() => {
      const y = document.querySelector('[data-do="you"]');
      if (y) y.click();
    });
    await sleep(450);
    await page.evaluate(() => {
      const s = document.querySelector('[data-lib="settings"]');
      if (s) s.click();
    });
    await sleep(450);
    for (const k of ['depth', 'parallax']) {
      await page.evaluate(o => {
        const b = document.querySelector('[data-opt="' + o + '"]');
        if (b) b.click();
      }, k);
      await sleep(200);
    }
    await page.evaluate(() => {
      const s = document.getElementById('scrim');
      if (s) s.click();
    });
    await sleep(400);
  }
  return state();
}

async function run(browser, file) {
  const { page, errors } = await boot(browser, file);
  const out = { file: path.basename(file) };
  const ev = (fn, ...a) => page.evaluate(fn, ...a);

  out.probe = await probe(page);
  out.live0 = await liveCount(page);
  out.boot = await snapshot(page);

  /* A session is never only switches: a chip replaces the feed and the shelves
     are re-driven on a resume, so the re-render path is measured first, in the
     default configuration where a frame pass does follow it. */
  out.chips = 0;
  for (let i = 1; i <= 5; i++) out.chips += await chip(page, i);
  out.rerender = await snapshot(page);

  /* The live tree is compared across the switches only: the chip taps above
     changed the size of the feed on purpose, and a shorter feed is not a leak. */
  out.liveBefore = await liveCount(page);
  out.at10 = null;
  for (let i = 0; i < SWITCHES; i++) {
    await switchTab(page, i);
    if (i === 9) out.at10 = await snapshot(page);
  }
  out.live1 = await liveCount(page);
  out.at20 = await snapshot(page);

  /* The same session again with both effects off: the configuration in which
     `frameRun` returns before the cache is synced, so a mutation is the only
     thing that can let go of a replaced feed. */
  /* Put the big feed back first, so the re-render that the effects-off stage
     measures is a full one being replaced: the held tree is then a whole feed,
     which is the size of the thing this item is about. */
  await chip(page, 0);
  out.off = await effectsOff(page);
  out.chipsOff = await chip(page, 1);
  out.offRerender = await snapshot(page);
  for (let i = 0; i < SWITCHES; i++) await switchTab(page, i);
  out.offSwitches = await snapshot(page);

  /* The two surfaces a session builds and drops: the player (an iframe per
     play) and the library sheet. */
  out.played = await ev(() => {
    const c = document.querySelector('#feed .card');
    if (!c) return null;
    c.click();
    return c.dataset.v;
  });
  await sleep(600);
  await ev(() => {
    const b = document.getElementById('pclose');
    if (b) b.click();
  });
  await sleep(400);
  await ev(() => {
    const y = document.querySelector('[data-do="you"]');
    if (y) y.click();
  });
  await sleep(500);
  await ev(() => {
    const s = document.getElementById('scrim');
    if (s) s.click();
  });
  await sleep(400);
  out.live2 = await liveCount(page);
  out.end = await snapshot(page);
  out.errors = errors.slice(0, 6);
  await page.close();
  return out;
}

const fmt = o => (o == null ? '—' : String(o));
const grow = (a, b) => (a == null || b == null ? null : b - a);
const listNames = (s, n) =>
  !s || !s.names.length ? 'none' : s.names.slice(0, n).map(([k, v]) => k + ' ×' + v).join(', ');
const line = (label, s, extra) =>
  '  ' + label.padEnd(11) + 'detached ' + fmt(s.detached) + ' nodes in ' + s.trees +
  ' trees  heap ' + s.heapKB + ' KB' + (extra ? '  ' + extra : '');

function report(o) {
  console.log('\n== ' + o.file);
  console.log(
    '  probe      held ' + o.probe.held + ' nodes → detached ' + o.probe.withHold.detached +
      ' (' + listNames(o.probe.withHold, 3) + '), released → ' + o.probe.afterRelease.detached
  );
  console.log(line('boot', o.boot, 'documents ' + o.boot.documents));
  console.log(line('rerender', o.rerender, o.chips + ' renders'));
  console.log(line('at10', o.at10));
  console.log(line('at20', o.at20, 'growth ' + fmt(grow(o.boot.detached, o.at20.detached))));
  console.log('  names20    ' + listNames(o.at20, 8));
  console.log(
    '  live       elements ' + o.liveBefore.elements + ' → ' + o.live1.elements +
      '  cards ' + o.liveBefore.cards + ' → ' + o.live1.cards +
      '  pages ' + o.liveBefore.pages + ' → ' + o.live1.pages +
      '  (boot ' + o.live0.elements + ')'
  );
  console.log(
    '  effectsOff depth ' + o.off.depth + ' parallax ' + o.off.parallax +
      ', ' + o.chipsOff + ' renders'
  );
  console.log(line('offRe', o.offRerender));
  console.log(line('offSw', o.offSwitches));
  console.log('  namesOff   ' + listNames(o.offSwitches, 8));
  console.log(
    line('end', o.end, 'iframes ' + o.live2.iframes + '  cards ' + o.live2.cards)
  );
  console.log('  namesEnd   ' + listNames(o.end, 8));
  if (o.errors && o.errors.length) console.log('  errors     ' + o.errors.join(' | '));
}

(async () => {
  const files = process.argv.slice(2);
  if (!files.length) {
    console.error('usage: node tools/detached-node-check.js <build-a.html> [build-b.html]');
    process.exit(2);
  }
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME || '/usr/local/bin/chromium',
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--js-flags=--expose-gc', '--window-size=412,892'],
  });
  const results = [];
  for (const f of files) results.push(await run(browser, f));
  await browser.close();
  results.forEach(report);

  const a = results[0];
  const b = results[1] || null;
  console.log('\n== verdict (' + a.file + ')');
  const fail = [];
  const check = (ok, msg) => {
    console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + msg);
    if (!ok) fail.push(msg);
  };
  check(
    a.probe.withHold.detached >= a.probe.held && a.probe.afterRelease.detached === 0,
    'the detector sees a held tree and clears it (' + a.probe.withHold.detached + ' → ' + a.probe.afterRelease.detached + ')'
  );
  check(a.boot.detached === 0, 'boot holds no detached node (' + a.boot.detached + ')');
  check(a.rerender.detached === 0, 'five feed re-renders hold none (' + a.rerender.detached + ')');
  check(
    a.at20.detached <= a.boot.detached,
    'twenty switches hold no more than the boot (' + a.at20.detached + ' vs ' + a.boot.detached + ')'
  );
  check(
    a.live1.elements === a.liveBefore.elements,
    'twenty switches do not grow the live tree (' + a.liveBefore.elements + ' → ' + a.live1.elements + ')'
  );
  check(
    a.off.depth === 0 && a.off.parallax === 0,
    'both effects really went off (depth ' + a.off.depth + ', parallax ' + a.off.parallax + ')'
  );
  check(
    a.offRerender.detached === 0,
    'with both effects off, a re-rendered full feed is let go (' + a.offRerender.detached + ')'
  );
  check(
    a.offSwitches.detached === 0,
    'with both effects off, twenty switches hold nothing either (' + a.offSwitches.detached + ')'
  );
  check(a.end.detached === 0, 'the player and the library sheet leave none (' + a.end.detached + ')');
  check(a.live2.iframes === 0, 'no player iframe survives its close (' + a.live2.iframes + ')');
  check(!(a.errors && a.errors.length), 'no page errors (' + (a.errors || []).length + ')');
  if (b) {
    console.log(
      '  info  ' + b.file + ': boot ' + b.boot.detached + ', rerender ' + b.rerender.detached +
        ', at20 ' + b.at20.detached + ', offRe ' + b.offRerender.detached +
        ', offSw ' + b.offSwitches.detached + ', end ' + b.end.detached + ' detached; heap ' +
        b.boot.heapKB + ' → ' + b.at20.heapKB + ' KB'
    );
  }
  process.exit(fail.length ? 1 : 0);
})().catch(e => {
  console.error(e);
  process.exit(2);
});
