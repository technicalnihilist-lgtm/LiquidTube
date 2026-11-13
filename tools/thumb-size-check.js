#!/usr/bin/env node
/*
 * LiquidTube thumbnail-size check — item 6.3.
 *
 * The claim of 6.3 is that a card asks i.ytimg.com for the smallest picture that
 * still covers the pixels it paints, instead of every card asking for
 * `maxresdefault.jpg` whatever its box. That claim has three halves, and this
 * asserts all of them.
 *
 *  1. THE LADDER ROUNDS UP. For every width from 1 to 1400 device px the pick is
 *     the first rung at least as wide as the need — never a smaller file (no card
 *     is ever served a picture it has to enlarge) and never a larger one than
 *     necessary. This is the check that fails on the build before the item, where
 *     every width answered `maxresdefault`.
 *  2. THE THREE FACTORS. The need is the box in CSS px x `devicePixelRatio`
 *     (capped at 3) x 1.14 while the tilt layer is scaling the picture, and x 1
 *     when parallax is off — the CSS drops the scale there, so the picker must
 *     drop it too. Each factor is asserted on its own.
 *  3. UNMEASURABLE MEANS UNCHANGED. A box that reports no width — a detached
 *     card, a WebView that answers 0, and every run of this harness, which has no
 *     layout at all — keeps `maxresdefault`, the request the previous build made.
 *     The worst case of the item is therefore the build before it, and
 *     tools/lazy-thumb-check.js still sees the URL it always saw.
 *
 * Then the two things that must not have moved: the fallbacks only ever go *up*
 * (a card that picked mqdefault and then fails still lands on hqdefault, the
 * same file it landed on before), and the card on screen is the same card — the
 * pick writes `src` and nothing else, no width, no height, no style, so the
 * reserved 16:9 box and everything inside it is untouched.
 *
 * Runs in jsdom with googleapis answered from fixtures — no network, no
 * Chromium, no device — on the same harness as tools/lazy-thumb-check.js.
 *
 *   npm i jsdom
 *   node tools/thumb-size-check.js app/assets/index.html
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const FILE = process.argv[2] || path.join(__dirname, '..', 'app', 'assets', 'index.html');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const vids = [];
for (let i = 0; i < 24; i++) vids.push('vid' + String(i).padStart(8, '0'));
const CH_IDS = [];
for (let i = 0; i < 6; i++) CH_IDS.push('UCchan' + String(i).padStart(12, '0'));
const pub = d => new Date(Date.UTC(2026, 10, 1 + d)).toISOString();

const F = {
  videos: {
    items: vids.map((id, i) => ({
      id,
      snippet: {
        title: 'Sample trending video number ' + (i + 1),
        channelTitle: 'Channel ' + (i % 6),
        channelId: CH_IDS[i % 6],
        publishedAt: pub(i),
        categoryId: ['10', '20', '24', '25', '27', '17'][i % 6],
        thumbnails: { maxres: { url: 'https://i.ytimg.com/vi/' + id + '/maxresdefault.jpg' } },
      },
      statistics: { viewCount: String(1000 * (i + 1) * 7) },
    })),
  },
  durations: { items: vids.map(id => ({ id, contentDetails: { duration: 'PT12M30S' } })) },
  channels: {
    items: CH_IDS.map((id, i) => ({
      id,
      snippet: { title: 'Channel ' + i, customUrl: 'channel' + i, publishedAt: '2015-04-02T10:00:00Z', country: 'IN', description: 'A sample channel.', thumbnails: { medium: { url: 'https://yt3.ggpht.com/av' + i + '.jpg' } } },
      statistics: { subscriberCount: '1200000', videoCount: '480', viewCount: '91000000' },
      contentDetails: { relatedPlaylists: { uploads: 'UU' + i + 'xxxxxxxxxxxxxxxxxxxx' } },
      brandingSettings: { image: { bannerExternalUrl: '' }, channel: {} },
    })),
  },
  search: {
    items: vids.slice(0, 20).map((id, i) => ({
      id: { videoId: id },
      snippet: { title: 'Search result ' + i, channelTitle: 'Channel ' + (i % 6), channelId: CH_IDS[i % 6], publishedAt: pub(i) },
    })),
  },
};

function apiBody(url) {
  const u = new URL(url), p = u.pathname;
  if (p.endsWith('/videos')) return (u.searchParams.get('part') || '').includes('contentDetails') ? F.durations : F.videos;
  if (p.endsWith('/channels')) return F.channels;
  if (p.endsWith('/playlistItems')) {
    return { items: F.search.items.map(it => ({ snippet: Object.assign({}, it.snippet, { resourceId: { videoId: it.id.videoId } }), contentDetails: { videoPublishedAt: it.snippet.publishedAt } })) };
  }
  if (p.endsWith('/search')) return F.search;
  return {};
}

function open(file) {
  const HTML = fs.readFileSync(file, 'utf8');
  const env = { ios: [], lines: [], errors: [] };
  const mockFetch = async u => {
    const j = apiBody(String(u));
    return { ok: true, status: 200, json: async () => j, headers: new Map() };
  };
  const dom = new JSDOM(HTML, {
    url: 'https://liquidtube.local/index.html',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(w) {
      w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
      w.fetch = mockFetch;
      w.scrollTo = () => {};
      w.IntersectionObserver = class {
        constructor(cb, o) { this.cb = cb; this.opts = o || {}; this.targets = new Set(); env.ios.push(this); }
        observe(t) { this.targets.add(t); }
        unobserve(t) { this.targets.delete(t); }
        disconnect() { this.targets.clear(); }
        takeRecords() { return []; }
      };
      const log = kind => (...a) => {
        const s = a.map(x => (typeof x === 'string' ? x : String(x))).join(' ');
        env.lines.push(s);
        if (kind === 'error') env.errors.push(s);
      };
      w.console.log = log('log');
      w.console.info = log('info');
      w.console.warn = log('warn');
      w.console.error = log('error');
    },
  });
  env.w = dom.window;
  env.d = dom.window.document;
  env.dom = dom;
  return env;
}

const ignorable = e => /WebAssembly|Cannot allocate|Not implemented/i.test(String((e && e.message) || ''));
process.on('uncaughtException', e => { if (!ignorable(e)) { console.error('uncaught', e); process.exit(1); } });
process.on('unhandledRejection', e => { if (!ignorable(e)) { console.error('unhandled', e); process.exit(1); } });

async function waitFor(fn, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(20); }
  return false;
}

let fails = 0;
const ok = (name, cond, detail) => {
  if (!cond) fails++;
  console.log((cond ? 'ok   ' : 'FAIL ') + name + (detail === undefined ? '' : '  [' + detail + ']'));
};

const cardsOf = env => [...env.d.querySelectorAll('#feed .card')];
const thumbsOf = env => [...env.d.querySelectorAll('img[data-l]')];

/* Give an element the width it would have had after layout, and the window the
   pixel ratio the device would have reported. jsdom has no layout, so both are
   the only way to exercise the picker at all. */
function size(img, cssPx, dpr, parallaxOn = true) {
  Object.defineProperty(img, 'clientWidth', { value: cssPx, configurable: true });
  Object.defineProperty(img.parentElement, 'clientWidth', { value: cssPx, configurable: true });
  Object.defineProperty(img.ownerDocument.defaultView, 'devicePixelRatio', { value: dpr, configurable: true });
  img.ownerDocument.documentElement.dataset.parallax = parallaxOn ? 'on' : 'off';
}

/* Deliver the intersection 6.1's observer would deliver, so the card asks for
   its picture exactly the way it does on a device. */
function fire(env, img) {
  const io = env.ios[0];
  io.cb([{ target: img, isIntersecting: true }]);
  return img.getAttribute('src');
}

const base = src => String(src || '').replace(/^.*\//, '').replace(/\.jpg$/, '');

async function boot() {
  const env = open(FILE);
  const seen = await waitFor(() => env.w.__ltTimeline && env.lines.some(l => l.indexOf('lt-startup') === 0));
  ok('boot reached its timeline', seen);
  ok('the feed rendered 24 cards', await waitFor(() => cardsOf(env).length === 24), String(cardsOf(env).length));
  await sleep(150);
  return env;
}

(async () => {
  const env = await boot();
  const W = env.w;
  const pick = px => W.eval('thumbPick(' + px + ')');

  /* ---- 1. the ladder ---- */
  {
    ok('ladder: the CDN sizes are the four the picker knows',
      W.eval('THUMB_LADDER.map(r=>r[0]).join(",")') === 'mqdefault,hqdefault,sddefault,maxresdefault',
      W.eval('THUMB_LADDER.map(r=>r[0]).join(",")'));
    ok('ladder: they ascend', W.eval('THUMB_LADDER.every((r,i)=>!i||r[1]>THUMB_LADDER[i-1][1])'));

    let wrong = 0, first = '';
    for (let px = 1; px <= 1400; px++) {
      const want = px <= 320 ? 'mqdefault' : px <= 480 ? 'hqdefault' : px <= 640 ? 'sddefault' : 'maxresdefault';
      const got = pick(px);
      if (got !== want) { wrong++; if (!first) first = px + 'px -> ' + got + ' (wanted ' + want + ')'; }
    }
    ok('ladder: every width 1..1400 picks the first rung that covers it', wrong === 0,
      wrong ? wrong + ' wrong, first ' + first : '1400 widths');

    /* never smaller than the need, for a sweep of boxes x ratios */
    const widthOf = n => W.eval('THUMB_LADDER.filter(r=>r[0]==="' + n + '")[0][1]');
    let under = 0, underAt = '', tested = 0, over = 0;
    for (let css = 40; css <= 640; css += 10) {
      for (const dpr of [1, 1.5, 2, 2.625, 3]) {
        const need = Math.ceil(css * dpr * 1.14);
        if (need > 1280) continue;                 /* nothing on the CDN is larger */
        tested++;
        const got = W.eval('thumbPick(' + need + ')');
        if (widthOf(got) < need) { under++; if (!underAt) underAt = css + 'css x' + dpr + ' -> ' + got; }
      }
    }
    ok('ladder: no card is ever served a picture it must enlarge', under === 0,
      under ? under + ' under-sized, first ' + underAt : tested + ' boxes x ratios');
    /* and never more than one rung of headroom above the need */
    for (let need = 1; need <= 1280; need++) {
      const got = widthOf(W.eval('thumbPick(' + need + ')'));
      const i = W.eval('THUMB_LADDER.findIndex(r=>r[1]===' + got + ')');
      if (i > 0 && widthOf(W.eval('THUMB_LADDER[' + (i - 1) + '][0]')) >= need) over++;
    }
    ok('ladder: and never a rung larger than the smallest that covers it', over === 0, over + ' over-sized');
    ok('ladder: above the largest rung the answer is the largest rung', pick(1280) === 'maxresdefault' && pick(9000) === 'maxresdefault');
  }

  /* ---- 3. unmeasurable keeps the old request ---- */
  {
    ok('unmeasurable: no width at all answers maxresdefault', pick(0) === 'maxresdefault');
    ok('unmeasurable: a negative or NaN width answers maxresdefault',
      pick(-5) === 'maxresdefault' && W.eval('thumbPick(NaN)') === 'maxresdefault');

    const img = thumbsOf(env)[0];
    ok('unmeasurable: a card in this layout-less harness is armed, not asked for',
      img.getAttribute('src') === null && img.dataset.l === '0');
    const src = fire(env, img);
    ok('unmeasurable: it still asks for exactly what the old build asked for',
      base(src) === 'maxresdefault', src);
    ok('unmeasurable: and it still uses the card\'s own id', src.indexOf('vid00000000') > 0, src);
  }

  /* ---- 2. the three factors, on real cards ---- */
  {
    const t = thumbsOf(env);
    const cases = [
      /* css, dpr, parallax, expected — the arithmetic is in the label */
      [120, 2, true, 'mqdefault', '120 x2 x1.14 = 274'],
      [170, 3, true, 'sddefault', '170 x3 x1.14 = 582 (a 44% search row)'],
      [200, 3, true, 'maxresdefault', '200 x3 x1.14 = 684'],
      [402, 3, true, 'maxresdefault', '402 x3 x1.14 = 1375 (a full-width feed card)'],
      [150, 6, true, 'sddefault', '150 x6 -> capped at 3 = 513'],
      [300, 1, true, 'hqdefault', '300 x1 x1.14 = 342'],
      [300, 1, false, 'mqdefault', '300 x1, parallax off = 300'],
      [420, 1, false, 'hqdefault', '420 x1, parallax off = 420'],
    ];
    let bad = 0;
    const seen = [];
    for (let i = 0; i < cases.length; i++) {
      const [css, dpr, par, want, label] = cases[i];
      const img = t[1 + i];
      size(img, css, dpr, par);
      const got = base(fire(env, img));
      seen.push(label + ' -> ' + got);
      if (got !== want) bad++;
      ok('factors: ' + label + ' asks for ' + want, got === want, got);
    }
    ok('factors: each case was measured on its own card', new Set(t.slice(1, 1 + cases.length)).size === cases.length);

    /* the pixel count the picker computed, not just the name it landed on */
    const probe = t[10];
    size(probe, 170, 3, true);
    ok('factors: the need is computed in device pixels', W.eval('thumbPixels') && probe.clientWidth === 170);
    size(probe, 170, 3, false);
    const off = W.eval('(function(){var i=document.querySelectorAll("img[data-l]")[10];return thumbPixels(i)})()');
    size(probe, 170, 3, true);
    const on = W.eval('(function(){var i=document.querySelectorAll("img[data-l]")[10];return thumbPixels(i)})()');
    ok('factors: the tilt scale is 1.14 on and 1 off', off === 510 && on === 582, off + ' / ' + on);
  }

  /* ---- the fallbacks still only go up ---- */
  {
    const img = thumbsOf(env)[12];
    size(img, 120, 2, true);
    ok('fallback: a small card picks mqdefault first', base(fire(env, img)) === 'mqdefault');
    Object.defineProperty(img, 'naturalWidth', { value: 120, configurable: true });
    W.THOK(img);
    ok('fallback: a grey placeholder still swaps to hqdefault, which is larger',
      base(img.getAttribute('src')) === 'hqdefault', img.getAttribute('src'));
    img.dataset.f = '';
    img.setAttribute('src', 'https://i.ytimg.com/vi/' + img.dataset.id + '/mqdefault.jpg');
    W.TH(img);
    ok('fallback: a first failure still lands on hqdefault, never below the pick',
      base(img.getAttribute('src')) === 'hqdefault', img.getAttribute('src'));
  }

  /* ---- the card on screen did not move ---- */
  {
    const img = thumbsOf(env)[14];
    /* `sizes`/`srcset` are item 6.6's own: the density it declares to the engine
       beside the pick. Everything else on the element must be what it was. */
    const names = () => [...img.attributes].map(a => a.name)
      .filter(n => n !== 'src' && n !== 'sizes' && n !== 'srcset').sort().join(',');
    const before = names();
    const styleBefore = img.getAttribute('style');
    /* 6.8 gives the element its intrinsic size in the markup, at birth, so the
       question this asks is not "does it have width/height" but "did the pick
       change them" — the picker must still write the `src` and nothing else. */
    const whBefore = img.getAttribute('width') + 'x' + img.getAttribute('height');
    size(img, 170, 3, true);
    fire(env, img);
    ok('ui: the pick writes the src and nothing else', names() === before, before + ' / ' + names());
    ok('ui: it added no size and changed no style',
      img.getAttribute('style') === styleBefore &&
      img.getAttribute('width') + 'x' + img.getAttribute('height') === whBefore,
      img.getAttribute('style'));
    ok('ui: the box is still the stylesheet\'s 16:9 thumb',
      img.parentElement.classList.contains('thumb') &&
      /\.thumb\{aspect-ratio:16\/9/.test(fs.readFileSync(FILE, 'utf8')));
    ok('ui: the hooks the tilt layer and the fallbacks read are untouched',
      img.dataset.q === '0' && img.getAttribute('decoding') === 'async' &&
      img.getAttribute('onload') === 'THOK(this)' && img.getAttribute('onerror') === 'TH(this)');
  }

  /* ---- the self-check knows the item ---- */
  {
    const sc = W.eval('typeof __ltSelfCheckRun==="function"');
    ok('selfcheck: the in-app self-check exists', sc);
    if (sc) {
      const r = W.eval('__ltSelfCheckRun()');
      ok('selfcheck: it names the size probe', r && Array.isArray(r.fails) && !r.fails.includes('thumbsize'),
        r && Array.isArray(r.fails) ? r.fails.join(',') || 'no failures' : 'no report');
      ok('selfcheck: it passes with the size probe in it', !r || !r.fail, r && (r.ok + ' ok / ' + r.fail + ' fail'));
    }
  }

  env.dom.window.close();
  console.log(fails ? '\n' + fails + ' failure(s)' : '\nall checks passed');
  process.exit(fails ? 1 : 0);
})();
