#!/usr/bin/env node
/*
 * LiquidTube will-change check — item 3.8.
 *
 * `will-change` is a promise about the near future, and a promise kept costs a
 * compositor layer for as long as it is kept. This tool measures whether the
 * promise is held only while something is actually moving:
 *
 *  1. `atRest` — every element whose computed `will-change` is not `auto`, and
 *     the compositor's layer tree (layer count, and the pixel area of the layers
 *     that draw content — the texture memory those layers hold), sampled with the
 *     app open and still.
 *
 *  2. `scroll` / `afterScroll` — the same two numbers while thirty scroll steps
 *     are running the depth/parallax frame, and again 400 ms after the last one.
 *     A build that hints only while animating must show the hint during the
 *     burst and no hint once the page has come to rest.
 *
 *  3. `tabSlide` / `afterTabSlide`, `tilt`, `overlay` — the other three things
 *     that animate: the pages during a tab change, the card under a finger, and
 *     the player sliding up. Each is sampled while it animates and after it has
 *     settled.
 *
 *  4. `faces` — the inline transform/opacity of every card, thumbnail and shell
 *     layer at four scroll positions, and the geometry and computed transform of
 *     the player at rest, so two builds can be diffed for identical rendering.
 *     A hint changes when the compositor promotes an element, never what is
 *     drawn; this is the check that it stayed that way.
 *
 * Usage:
 *   npm i puppeteer-core                    # dev only, not shipped in the APK
 *   CHROME=/path/to/chrome node tools/will-change-check.js <build-a.html> [build-b.html]
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

/* The compositor's own view of what is promoted. Chromium pushes the whole layer
   tree on `layerTreeDidChange` (including on enable) and only when something
   changes, so the newest event is the current tree: the listener installed at
   boot keeps the latest one, and a sample waits for a newer one (a state change
   always produces one) and falls back to the latest known tree if the tree has
   not changed since. `drawnPx` sums width*height of the layers that actually
   draw content — the textures those hints are holding. */
function tally(L) {
  const drawn = (L || []).filter(l => l.drawsContent && l.width > 0 && l.height > 0);
  return {
    layers: L ? L.length : null,
    drawn: drawn.length,
    drawnPx: drawn.reduce((s, l) => s + l.width * l.height, 0),
  };
}
function layers(ms = 900) {
  const page = this;
  const seq0 = page.__treeSeq;
  const t0 = Date.now();
  return new Promise(resolve => {
    const tick = () => {
      if (page.__treeSeq > seq0 || Date.now() - t0 > ms) resolve(tally(page.__tree));
      else setTimeout(tick, 40);
    };
    tick();
  });
}

/* Which of those layers belong to the elements this item is about. A layer entry
   carries the backend node id of the element it was created for, so the tree can
   be attributed: a page, a feed card, a thumbnail, or something else (the root,
   the viewport, an iframe, the dock). This is the number that says whether the
   hints are holding textures: a card's layer is its whole painted box, kept for
   as long as the hint is. */
async function owners(page) {
  const L = page.__tree || [];
  const ids = L.map(l => l.backendNodeId).filter(Boolean);
  const out = { page: 0, card: 0, thumb: 0, other: 0 };
  if (!ids.length) return out;
  let nodeIds = [];
  try {
    ({ nodeIds } = await page.__cdp.send('DOM.pushNodesByBackendIdsToFrontend', { backendNodeIds: ids }));
  } catch (e) { return out; }
  for (const id of nodeIds) {
    if (!id) { out.other++; continue; }
    try {
      const { node } = await page.__cdp.send('DOM.describeNode', { nodeId: id, depth: 0 });
      const attrs = node.attributes || [];
      const cls = attrs[attrs.indexOf('class') + 1] || '';
      const tag = String(node.nodeName || '').toLowerCase();
      if (tag === 'html' || tag === 'body' || !cls && tag !== 'img') out.other++;
      else if (/(^|\s)page(\s|$)/.test(cls)) out.page++;
      else if (/(^|\s)card(\s|$)/.test(cls)) out.card++;
      else if (tag === 'img') out.thumb++;
      else out.other++;
    } catch (e) { out.other++; }
  }
  return out;
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
  page.__cdp = await page.createCDPSession();
  page.__tree = null;
  page.__treeSeq = 0;
  page.__cdp.on('LayerTree.layerTreeDidChange', e => {
    if (e.layers) { page.__tree = e.layers; page.__treeSeq++; }
  });
  await page.__cdp.send('DOM.enable');
  await page.__cdp.send('DOM.getDocument');
  await page.__cdp.send('LayerTree.enable');
  return page;
}

/* Every element that is carrying a hint right now, named the way a CSS rule
   would name it, plus the two numbers the layer tree gives. */
const snapshot = page => page.evaluate(() => {
  const name = el => {
    let s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    const c = typeof el.className === 'string' ? el.className.trim() : '';
    if (c) s += '.' + c.split(/\s+/).join('.');
    return s;
  };
  const hinted = [];
  const all = document.querySelectorAll('*');
  for (let i = 0; i < all.length; i++) {
    const v = getComputedStyle(all[i]).willChange;
    if (v && v !== 'auto') hinted.push({ el: name(all[i]), v });
  }
  const tally = {};
  for (const h of hinted) tally[h.el] = (tally[h.el] || 0) + 1;
  return {
    hintedCount: hinted.length,
    hintedBySelector: tally,
    pages: [...document.querySelectorAll('.page')].map(p => getComputedStyle(p).willChange),
    cards: [...document.querySelectorAll('.card')].map(c => getComputedStyle(c).willChange).filter(v => v !== 'auto').length,
    thumbs: [...document.querySelectorAll('.thumb img')].map(c => getComputedStyle(c).willChange).filter(v => v !== 'auto').length,
    player: getComputedStyle(document.getElementById('pl')).willChange,
    sheet: getComputedStyle(document.getElementById('sheet')).willChange,
    htmlAnim: document.documentElement.getAttribute('data-anim'),
  };
});

const frames = page => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(r)))));
const scrollTo = (page, y) => page.evaluate(y => {
  const pg = document.querySelector('.page:not([inert])');
  pg.scrollTop = y;
  pg.dispatchEvent(new Event('scroll'));
}, y);

/* The state of the hint at the moment the depth/parallax frame turns it on. */
const probe = page => page.evaluate(() => new Promise(res => {
  const read = () => {
    const c = [...document.querySelectorAll('.card')].filter(e => getComputedStyle(e).willChange !== 'auto').length;
    const t = [...document.querySelectorAll('.thumb img')].filter(e => getComputedStyle(e).willChange !== 'auto').length;
    return { cardHinted: c, thumbHinted: t, cards: document.querySelectorAll('.card').length, thumbs: document.querySelectorAll('.thumb img').length };
  };
  const mo = new MutationObserver(() => {
    if (document.documentElement.getAttribute('data-anim') !== 'on') return;
    mo.disconnect();
    res({ seen: true, ...read() });
  });
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-anim'] });
  const pg = document.querySelector('.page:not([inert])');
  pg.scrollTop = 901;
  pg.dispatchEvent(new Event('scroll'));
  setTimeout(() => { mo.disconnect(); res({ seen: false, ...read() }); }, 4000);
}));

/* What the build renders, so two builds can be compared. Same convention as
   tools/style-batch-check.js: the inline transforms and opacities the frame
   writes, plus the settled geometry of the player. */
const faces = page => page.evaluate(() => {
  const pl = document.getElementById('pl');
  const box = e => { const r = e.getBoundingClientRect(); return [r.left, r.top, r.width, r.height].map(n => Math.round(n * 100) / 100); };
  return {
    cards: [...document.querySelectorAll('#p-home .card')].map(e => [e.style.transform, e.style.opacity].join('~')),
    thumbs: [...document.querySelectorAll('#p-home .thumb img')].map(e => e.style.transform),
    page: document.querySelector('.page:not([inert])').style.backgroundPositionY,
    top: (document.querySelector('.page:not([inert]) .top') || { style: {} }).style.transform || '',
    dock: (document.querySelector('.dock') || { style: {} }).style.transform || '',
    chips: (document.querySelector('.page:not([inert]) .chips') || { style: {} }).style.transform || '',
    player: { box: box(pl), transform: getComputedStyle(pl).transform, kids: [...pl.children].map(box) },
  };
});

async function run(browser, file) {
  const page = await boot(browser, file);
  const L = async () => {
    /* A screenshot forces a frame, and therefore a commit: the layer tree that
       comes back with it is the tree as it stands now, not one from an earlier
       state that happened to be pushed. */
    try { await page.screenshot({ encoding: 'base64' }); } catch (e) {}
    const t = await layers.call(page);
    return { ...t, owners: await owners(page) };
  };
  const out = { file: path.basename(file) };

  /* The reveal animations move every card for the first second and a half. */
  await sleep(1700);
  await frames(page);
  await sleep(200);

  /* ---- 1. at rest ---- */
  out.atRest = { ...(await snapshot(page)), ...(await L()) };

  /* ---- 2. a scroll burst, and the rest after it ----
     The hint is sampled from a MutationObserver on the attribute that carries it,
     which fires as a microtask the instant the frame sets it: sampling after a
     fixed sleep would be racing the idle timer that takes it off again, and the
     answer would depend on how fast this harness happened to run the frame. */
  out.scroll = { ...(await probe(page)), ...(await L()) };
  for (let i = 2; i <= 30; i++) { await scrollTo(page, 900 + i); await frames(page); }
  await sleep(500);
  out.afterScroll = { ...(await snapshot(page)), ...(await L()) };
  /* The compositor frees a layer it no longer needs on its own schedule, not on
     the frame the hint is withdrawn, so the tree is sampled again once it has had
     time to catch up. */
  await sleep(2200);
  out.afterScrollSettled = await L();

  /* ---- 3. a tab change: the pages slide for .95 s ---- */
  await page.evaluate(() => { const t = document.querySelector('#tabrow .tab[data-i="1"]'); t.click(); });
  await frames(page);
  out.tabSlide = await snapshot(page);
  await sleep(1300);
  out.afterTabSlide = await snapshot(page);
  await page.evaluate(() => { document.querySelector('#tabrow .tab[data-i="0"]').click(); });
  await sleep(1300);

  /* ---- 4. a card under a finger ---- */
  await scrollTo(page, 300);
  await frames(page);
  await sleep(200);
  const tilt = await page.evaluate(() => {
    const card = document.querySelector('#p-home .card');
    const r = card.getBoundingClientRect();
    const ev = (t, x, y) => card.dispatchEvent(new PointerEvent(t, { bubbles: true, pointerType: 'touch', pointerId: 1, clientX: x, clientY: y }));
    ev('pointerdown', r.left + r.width / 2, r.top + r.height / 2);
    ev('pointermove', r.left + r.width * 0.8, r.top + r.height * 0.3);
    const el = document.querySelector('.card.tilt');
    const held = el ? getComputedStyle(el).willChange : null;
    ev('pointerup', r.left + r.width * 0.8, r.top + r.height * 0.3);
    return { tiltClass: !!el, willChange: held, cards: document.querySelectorAll('.card.tilt').length };
  });
  out.tilt = tilt;
  await sleep(400);
  out.afterTilt = await page.evaluate(() => ({
    tiltCards: document.querySelectorAll('.card.tilt').length,
    hinted: [...document.querySelectorAll('.card')].filter(c => getComputedStyle(c).willChange !== 'auto').length,
  }));

  /* ---- 5. the player sliding up ---- */
  await page.evaluate(() => play(Object.keys(V)[0]));
  await frames(page);
  out.overlay = await page.evaluate(() => ({
    player: getComputedStyle(document.getElementById('pl')).willChange,
    scrim: getComputedStyle(document.getElementById('scrim')).willChange,
    open: document.getElementById('pl').classList.contains('on'),
  }));
  await sleep(1400);
  out.overlayAtRest = await page.evaluate(() => ({
    player: getComputedStyle(document.getElementById('pl')).willChange,
    scrim: getComputedStyle(document.getElementById('scrim')).willChange,
    scrimOpacity: getComputedStyle(document.getElementById('scrim')).opacity,
  }));
  out.playerFace = await page.evaluate(() => {
    const pl = document.getElementById('pl');
    const box = e => { const r = e.getBoundingClientRect(); return [r.left, r.top, r.width, r.height].map(n => Math.round(n * 100) / 100); };
    return { box: box(pl), transform: getComputedStyle(pl).transform, kids: [...pl.children].map(box) };
  });
  await page.evaluate(() => closeAll());
  await sleep(1200);

  /* ---- 6. what it renders, at four scroll positions ---- */
  out.faces = {};
  for (const y of [0, 300, 900, 1400]) {
    for (const v of [y + 1, y]) { await scrollTo(page, v); await frames(page); await sleep(120); }
    out.faces[y] = await faces(page);
  }

  const m = out;
  out.assertions = {
    'nothing carries a layer hint while the app is at rest': m.atRest.hintedCount === 0,
    'the frame holds the hint while it is writing transforms': m.scroll.thumbs > 0 && m.scroll.cards > 0,
    'the hint is given back once the scroll has settled': m.afterScroll.hintedCount === 0,
    'a tab change hints the pages while they slide': m.tabSlide.pages.every(v => v !== 'auto'),
    'and takes the hint off once they have landed': m.afterTabSlide.pages.every(v => v === 'auto'),
    'the tilted card carries the hint': m.tilt.tiltClass && m.tilt.willChange === 'transform',
    'and loses it when the finger is lifted': m.afterTilt.hinted === 0,
    'the player is hinted while it slides up': m.overlay.player === 'transform' && m.overlay.scrim === 'opacity',
    'and holds no hint once it is open and still': m.overlayAtRest.player === 'auto' && m.overlayAtRest.scrim === 'auto',
  };
  out.pass = Object.values(out.assertions).every(Boolean);
  await page.close();
  return out;
}

/* Two builds are compared on what they rendered, within the noise the harness
   itself has: a card's transform is a fixed point of its own measured rect, so a
   run that got one more frame than another lands a tenth of a pixel away. */
const TOL = { abs: 0.35, rel: 0.004 };
const numbers = s => (String(s).match(/-?\d*\.?\d+/g) || []).map(Number);
const close = (x, y) => Math.abs(x - y) <= TOL.abs + Math.abs(y) * TOL.rel;
const shape = s => String(s).replace(/-?\d*\.?\d+/g, '#');
function diffValue(a, b, where, mismatches, worst) {
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) { mismatches.push({ where, reason: 'length ' + a.length + ' vs ' + (b ? b.length : 'missing') }); return worst; }
    for (let i = 0; i < a.length; i++) worst = diffValue(a[i], b[i], where + '[' + i + ']', mismatches, worst);
    return worst;
  }
  if (a && typeof a === 'object') {
    for (const k of Object.keys(a)) worst = diffValue(a[k], b && b[k], where + '.' + k, mismatches, worst);
    return worst;
  }
  if (shape(a) !== shape(b)) { mismatches.push({ where, reason: 'shape', a, b }); return worst; }
  const na = numbers(a), nb = numbers(b);
  for (let j = 0; j < na.length; j++) {
    const d = Math.abs(na[j] - nb[j]);
    if (d > worst) worst = d;
    if (!close(na[j], nb[j])) mismatches.push({ where, reason: 'value', a, b });
  }
  return worst;
}
function compare(a, b) {
  const mismatches = [];
  const worst = diffValue(a, b, 'faces', mismatches, 0);
  return { worstDelta: Math.round(worst * 1000) / 1000, mismatches: mismatches.slice(0, 8) };
}

(async () => {
  const files = process.argv.slice(2);
  if (!files.length) { console.error('usage: node tools/will-change-check.js <build-a.html> [build-b.html]'); process.exit(2); }
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME || '/usr/bin/google-chrome',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--hide-scrollbars'],
  });
  const results = [];
  for (const f of files) results.push(await run(browser, f));
  if (results.length === 2) {
    const d = compare(
      { faces: results[0].faces, player: results[0].playerFace },
      { faces: results[1].faces, player: results[1].playerFace }
    );
    results[0].rendering = d;
    results[0].sameRenderingAsSecondBuild = d.mismatches.length === 0;
    results[1].sameRenderingAsSecondBuild = results[0].sameRenderingAsSecondBuild;
  }
  await browser.close();
  console.log(JSON.stringify(results, null, 2));
})();
