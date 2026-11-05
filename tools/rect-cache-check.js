#!/usr/bin/env node
/*
 * LiquidTube rect-cache check — item 3.5.
 *
 * Proves that the two gesture paths stop asking the layout for a box on every
 * sample of a gesture, and that the picture they draw is unchanged.
 *
 *  1. `tilt.reads` — how many boxes the card tilt measures for one drag. It used
 *     to be one getBoundingClientRect per pointermove: a forced style flush per
 *     sample, on the main thread, while the finger is asking for frames. It is
 *     now one box per gesture.
 *
 *  2. `drag.reads` — the same for the tab strip, which `at()` measured on every
 *     pointermove of a dock drag.
 *
 *  3. `revalidate` — the cache must not outlive the layout it was computed
 *     against, and must not become a read per sample either. A scroll of the
 *     card's page and a resize of the window are the two things that can move a
 *     cached box without a gesture ending, so the check scrolls mid-tilt and
 *     resizes mid-drag: each must cost exactly one re-measure, and the samples
 *     around it must cost none. A build that never re-measures (`1` and `0`) is
 *     as wrong as one that measures every sample (`12`).
 *
 *  4. `faces` — the inline transforms and opacity of every card, thumbnail and
 *     shell layer at four scroll positions, plus the tilt and the lens after the
 *     gestures above. Two builds that produce the same array draw the same
 *     picture, so this check changes how the frame is computed, not what it
 *     looks like.
 *
 * The whole asset is loaded and executed for real (its own boot, its own fetch
 * path, its own listeners), so the counts are the ones the shipped code makes.
 * jsdom has no layout engine, so the boxes it would have computed are supplied
 * by the harness: a fixed 412x892 phone, cards 380x280 down the feed, the strip
 * at the bottom of the dock. Every other element answers 0x0, which is what an
 * unlaid-out element in this engine reports anyway. jsdom is a dev-only
 * dependency and is not shipped in the APK.
 *
 * Usage:  node tools/rect-cache-check.js <build-a.html> [build-b.html]
 *         (needs: npm i jsdom)
 */
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const ORIGIN = 'liquidtube.local';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const pad = n => String(n).padStart(2, '0');
const vids = Array.from({ length: 24 }, (_, i) => 'v' + pad(i + 1) + 'AAAAAAAA');
const CH = Array.from({ length: 6 }, (_, i) => 'UC' + i + 'xxxxxxxxxxxxxxxxxxxx');
const ago = h => new Date(Date.now() - h * 36e5).toISOString();
const F = {
  videos: { items: vids.map((id, i) => ({ id, snippet: { title: 'Video ' + i, channelTitle: 'Channel ' + (i % 6), channelId: CH[i % 6], publishedAt: ago(i + 1), categoryId: '10', thumbnails: { maxres: { url: 'https://i.ytimg.com/vi/' + id + '/maxresdefault.jpg' } } }, statistics: { viewCount: '1000' } })) },
  durations: { items: vids.map(id => ({ id, contentDetails: { duration: 'PT12M30S' } })) },
  channels: { items: CH.map((id, i) => ({ id, snippet: { title: 'Channel ' + i, customUrl: 'c' + i, publishedAt: '2015-04-02T10:00:00Z', thumbnails: { medium: { url: 'https://yt3.ggpht.com/a' + i + '.jpg' } } }, statistics: { subscriberCount: '1000', videoCount: '10', viewCount: '10000' }, contentDetails: { relatedPlaylists: { uploads: 'UU' + id.slice(2) } }, brandingSettings: { image: {}, channel: {} } })) },
  playlistItems: { items: vids.slice(0, 12).map((id, i) => ({ snippet: { title: 'P' + i, resourceId: { videoId: id }, publishedAt: ago(i * 24) }, contentDetails: { videoPublishedAt: ago(i * 24) } })) },
  search: { items: [] },
};
function apiBody(url) {
  const u = new URL(url), p = u.pathname;
  if (p.endsWith('/videos')) return (u.searchParams.get('part') || '').includes('contentDetails') ? F.durations : F.videos;
  if (p.endsWith('/channels')) return F.channels;
  if (p.endsWith('/playlistItems')) return F.playlistItems;
  if (p.endsWith('/search')) return F.search;
  return {};
}
const box = (left, top, width, height) => ({
  left, top, width, height, right: left + width, bottom: top + height, x: left, y: top,
  toJSON() { return this; },
});

/* One page, booted for real, with the rect of every element counted. */
async function boot(file) {
  const html = fs.readFileSync(file, 'utf8');
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => errors.push(String(e && e.message || e)));
  const reads = { card: 0, tabs: 0, thumb: 0, other: 0 };
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'https://' + ORIGIN + '/index.html',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(w) {
      /* The APIs the WebView has and this engine does not. */
      w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
      w.requestIdleCallback = cb => w.setTimeout(() => cb({ didTimeout: false, timeRemaining: () => 20 }), 0);
      w.cancelIdleCallback = id => w.clearTimeout(id);
      w.Element.prototype.scrollTo = function () {};
      w.Element.prototype.setPointerCapture = function () {};
      w.fetch = async url => {
        const body = apiBody(String(url));
        return { ok: true, status: 200, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) };
      };
      /* The layout jsdom does not have: a 412x892 phone, the feed's cards
         380x280 down the page, the tab strip in the dock. */
      w.Element.prototype.getBoundingClientRect = function () {
        const cl = this.classList;
        if (this.id === 'tabs') { reads.tabs++; return box(24, 812, 364, 56); }
        if (cl && cl.contains('card')) {
          reads.card++;
          const i = this.parentElement ? [...this.parentElement.children].indexOf(this) : 0;
          return box(16, 80 + i * 300, 380, 280);
        }
        if (cl && cl.contains('thumb')) { reads.thumb++; return box(24, 88, 364, 200); }
        if (cl && cl.contains('page')) return box(0, 0, 412, 892);
        reads.other++;
        return box(0, 0, 0, 0);
      };
    },
  });
  const w = dom.window, d = w.document;
  const waitFor = async (fn, ms = 15000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(25); }
    return false;
  };
  const booted = await waitFor(() => d.querySelectorAll('#feed .card').length > 0 && !d.querySelector('#ex .skl'));
  await sleep(400);                                  /* let the deferred sheet and the idle listeners land */
  return { dom, w, d, reads, errors, booted, waitFor };
}

function fire(w, el, type, props) {
  const e = new w.Event(type, { bubbles: true, cancelable: true });
  Object.assign(e, props);
  el.dispatchEvent(e);
}
const zero = r => { for (const k in r) r[k] = 0; };
const faces = (w, d) => ({
  cards: [...d.querySelectorAll('#p-home .card')].map(e => [e.style.transform, e.style.opacity].join('~')),
  thumbs: [...d.querySelectorAll('#p-home .thumb img')].map(e => e.style.transform),
  page: (d.querySelector('.page:not([inert])') || { style: {} }).style.backgroundPositionY || '',
  top: (d.querySelector('.page:not([inert]) .top') || { style: {} }).style.transform || '',
  dock: (d.querySelector('.dock') || { style: {} }).style.transform || '',
  chips: (d.querySelector('.page:not([inert]) .chips') || { style: {} }).style.transform || '',
  lens: (d.getElementById('lens') || { style: {} }).style.transform || '',
  pages: [...d.querySelectorAll('.page')].map(e => e.style.transform),
});

async function run(file) {
  const { dom, w, d, reads, errors, booted, waitFor } = await boot(file);
  const out = { file: path.basename(file), booted };

  /* ---- the picture, at four scroll positions ---- */
  out.faces = {};
  for (const y of [0, 300, 900, 1400]) {
    for (const v of [y + 1, y]) {                     /* off and back: forces the pass against the settled layout */
      const pg = d.querySelector('.page:not([inert])');
      pg.scrollTop = v;
      pg.dispatchEvent(new w.Event('scroll', { bubbles: true }));
      await sleep(60);
    }
    out.faces[y] = faces(w, d);
  }

  const card = d.querySelector('#feed .card');

  /* ---- tilt: one drag, twelve samples ---- */
  zero(reads);
  fire(w, card, 'pointerdown', { pointerType: 'touch', clientX: 200, clientY: 200, pointerId: 1 });
  const tilt = [];
  for (let i = 0; i < 12; i++) {
    fire(w, card, 'pointermove', { pointerType: 'touch', clientX: 150 + i * 10, clientY: 150 + i * 4, pointerId: 1 });
    tilt.push(card.style.transform);
  }
  fire(w, card, 'pointerup', { pointerType: 'touch', clientX: 260, clientY: 200, pointerId: 1 });
  out.tilt = { moves: 12, reads: reads.card, transforms: tilt };

  /* ---- revalidation: the box must not outlive its layout ---- */
  zero(reads);
  fire(w, card, 'pointerdown', { pointerType: 'touch', clientX: 200, clientY: 200, pointerId: 3 });
  for (let i = 0; i < 6; i++) fire(w, card, 'pointermove', { pointerType: 'touch', clientX: 150 + i * 10, clientY: 150, pointerId: 3 });
  const pg = d.querySelector('.page:not([inert])');
  pg.scrollTop = 240;                                 /* the card moved under the finger */
  pg.dispatchEvent(new w.Event('scroll', { bubbles: true }));
  for (let i = 0; i < 6; i++) fire(w, card, 'pointermove', { pointerType: 'touch', clientX: 150 + i * 10, clientY: 150, pointerId: 3 });
  fire(w, card, 'pointerup', { pointerType: 'touch', clientX: 150, clientY: 150, pointerId: 3 });
  out.revalidate = { scrollMidTilt: reads.card };
  await sleep(60);

  /* ---- dock drag: one drag, twelve samples ---- */
  const tabs = d.getElementById('tabs');
  zero(reads);
  fire(w, tabs, 'pointerdown', { clientX: 100, clientY: 830, pointerId: 2 });
  for (let i = 0; i < 12; i++) fire(w, tabs, 'pointermove', { clientX: 100 + i * 20, clientY: 830, pointerId: 2 });
  fire(w, tabs, 'pointerup', { clientX: 340, clientY: 830, pointerId: 2 });
  out.drag = { moves: 12, reads: reads.tabs };
  await sleep(80);

  /* ---- the same drag with the window resized in the middle: one extra box ---- */
  zero(reads);
  fire(w, tabs, 'pointerdown', { clientX: 300, clientY: 830, pointerId: 4 });
  for (let i = 0; i < 6; i++) fire(w, tabs, 'pointermove', { clientX: 300 - i * 20, clientY: 830, pointerId: 4 });
  const beforeResize = reads.tabs;
  w.dispatchEvent(new w.Event('resize'));
  for (let i = 6; i < 12; i++) fire(w, tabs, 'pointermove', { clientX: 300 - i * 20, clientY: 830, pointerId: 4 });
  fire(w, tabs, 'pointerup', { clientX: 80, clientY: 830, pointerId: 4 });
  out.revalidate.resizeMidDrag = reads.tabs;
  out.revalidate.beforeResize = beforeResize;
  await sleep(80);
  out.faces.tilt = tilt[tilt.length - 1];
  out.faces.lens = (d.getElementById('lens') || { style: {} }).style.transform || '';
  out.faces.pagesAfterDrag = [...d.querySelectorAll('.page')].map(e => e.style.transform);

  out.errors = errors.slice(0, 4);
  dom.window.close();
  return out;
}

(async () => {
  const files = process.argv.slice(2);
  if (!files.length) {
    console.error('usage: node tools/rect-cache-check.js <build-a.html> [build-b.html]');
    process.exit(2);
  }
  const res = [];
  for (const f of files) res.push(await run(f));
  for (const r of res) console.log(JSON.stringify(r));

  const verdict = { tilt: [], drag: [], revalidate: [], same: null, errors: 0 };
  for (const r of res) {
    verdict.tilt.push({ file: r.file, moves: r.tilt.moves, reads: r.tilt.reads });
    verdict.drag.push({ file: r.file, moves: r.drag.moves, reads: r.drag.reads });
    verdict.revalidate.push({ file: r.file, scrollMidTilt: r.revalidate.scrollMidTilt, resizeMidDrag: r.revalidate.resizeMidDrag });
    verdict.errors += r.errors.length;
  }
  if (res.length === 2) {
    const a = JSON.stringify(res[0].faces), b = JSON.stringify(res[1].faces);
    verdict.same = a === b;
    if (!verdict.same) {
      /* Name the first field that differs, so a mismatch is actionable. */
      for (const k of Object.keys(res[0].faces)) {
        if (JSON.stringify(res[0].faces[k]) !== JSON.stringify(res[1].faces[k])) { verdict.firstDiff = k; break; }
      }
    }
  }
  /* The build under test is the last one named; an earlier one is the baseline
     it is compared against, and is expected to fail these counts. */
  const last = res[res.length - 1];
  verdict.tested = last.file;
  verdict.ok = last.errors.length === 0 &&
    last.tilt.reads === 1 && last.drag.reads <= 1 &&
    last.revalidate.scrollMidTilt === 2 && last.revalidate.resizeMidDrag === 1 &&
    (verdict.same === null || verdict.same === true);
  console.log(JSON.stringify({ verdict }));
  process.exit(verdict.ok ? 0 : 1);
})();
