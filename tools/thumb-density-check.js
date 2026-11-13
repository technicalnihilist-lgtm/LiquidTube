#!/usr/bin/env node
/*
 * LiquidTube thumbnail-density check — item 6.6.
 *
 * The claim of 6.6 is that a card no longer carries a single file but a *density
 * declaration*: the `src` 6.3's picker chose, and beside it a `sizes` and a
 * `srcset` from which the engine can compute — and re-compute — the same choice
 * by itself. This asserts every half of that on a real boot of the app in jsdom.
 *
 *  1. THE DECLARATION IS THE PICKER'S. For a sweep of boxes and pixel ratios the
 *     `sizes` the app writes is the box the picker measured (CSS px x the tilt
 *     scale, the ratio left out, so `sizes` x ratio is `thumbPixels`), and the
 *     candidate list starts at the rung the picker chose.
 *  2. NEVER SMALLER. Simulating the engine's own selection — required width =
 *     `sizes` x `devicePixelRatio`, the smallest candidate that covers it — every
 *     box x ratio lands on a file at least as large as `thumbPick` chose, and at
 *     most one rung above it. That is 6.3's promise held declaratively: the
 *     declaration can never cost a card its sharpness.
 *  3. THE CANDIDATES ARE THE CDN'S. Every candidate is a real ladder URL for the
 *     card's own video id, carries the ladder's own width, ascends, and appears
 *     once. Nothing is invented and nothing is below the pick.
 *  4. THE ORDER THAT AVOIDS A DOUBLE REQUEST. `sizes` is written before `srcset`
 *     and `srcset` before `src`, so an engine that honours width descriptors runs
 *     selection once, on the whole list, instead of starting the picked file and
 *     then replacing it. The attributes are asserted in that order.
 *  5. THE BOX THAT CHANGED AFTER THE FIRE — the reason the item exists. A card
 *     fired at 402 px and then rotated to 560 px still carries its candidates, and
 *     re-running the engine's selection at the new box asks for a larger file than
 *     the one it is holding, without the card being re-rendered or re-fired.
 *  6. UNMEASURABLE MEANS UNCHANGED. A box with no width — a detached card, a
 *     WebView that answers 0, and every run of this harness — gets no `sizes`, no
 *     `srcset` and exactly the `src` the build before the item wrote.
 *  7. THE FALLBACKS STILL LAND. `THOK` and `TH` take the candidates off before
 *     they set `hqdefault`, so the single file a fallback needs is the file that
 *     loads; the rung 6.5 records is still the picked rung, because `src` is still
 *     the pick.
 *  8. THE UI DID NOT MOVE. No width, no height, no style, no new element; the two
 *     new attributes are the item's own and nothing else changed on the card.
 *     With a second file it also diffs every card's tree with `sizes`/`srcset`
 *     taken out and fails if a node, a class or a line of text moved.
 *  9. THE PROBE, AND THE COST. The boot-time self-check carries the `thumbdensity`
 *     probe and it passes on this build; and the candidate list is measured, so the
 *     log can quote a number instead of a hope.
 *
 * Runs in jsdom with googleapis answered from fixtures — no network, no Chromium,
 * no device — on the same harness as tools/thumb-size-check.js.
 *
 *   npm i jsdom
 *   node tools/thumb-density-check.js app/assets/index.html
 *   node tools/thumb-density-check.js app/assets/index.html /tmp/old/index.html
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const FILE = process.argv[2] || path.join(__dirname, '..', 'app', 'assets', 'index.html');
const OLD = process.argv[3] || '';
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
const base = src => String(src || '').replace(/^.*\//, '').replace(/\.jpg$/, '');

/* Give an element the width it would have had after layout, and the window the
   pixel ratio the device would have reported. jsdom has no layout, so both are
   the only way to exercise any of this at all. */
function size(img, cssPx, dpr, parallaxOn = true) {
  Object.defineProperty(img, 'clientWidth', { value: cssPx, configurable: true });
  Object.defineProperty(img.parentElement, 'clientWidth', { value: cssPx, configurable: true });
  Object.defineProperty(img.ownerDocument.defaultView, 'devicePixelRatio', { value: dpr, configurable: true });
  img.ownerDocument.documentElement.dataset.parallax = parallaxOn ? 'on' : 'off';
}

/* Deliver the intersection 6.1's observer would deliver, so the card asks for
   its picture exactly the way it does on a device. */
function fire(env, img) {
  env.ios[0].cb([{ target: img, isIntersecting: true }]);
  return img;
}

/* The candidates on an element, as {url, width} pairs, in the order written. */
function candidates(img) {
  return String(img.getAttribute('srcset') || '').split(',').map(s => s.trim()).filter(Boolean).map(s => {
    const m = /^(\S+)\s+(\d+)w$/.exec(s);
    return m ? { url: m[1], width: +m[2] } : { url: s, width: 0 };
  });
}

/* What a Chromium-shaped engine does with `sizes` x ratio: the required width is
   the density the picture has to cover, and the choice is the smallest candidate
   that covers it (or the largest, if none does). */
function select(cands, sizesPx, dpr) {
  if (!cands.length) return null;
  const need = parseFloat(sizesPx) * dpr;
  let best = cands[0];
  for (const c of cands) if (c.width >= need) { best = c; break; }
  const covering = cands.filter(c => c.width >= need);
  return covering.length ? covering[0] : cands[cands.length - 1];
}

async function boot(file) {
  const env = open(file);
  const seen = await waitFor(() => env.w.__ltTimeline && env.lines.some(l => l.indexOf('lt-startup') === 0));
  ok('boot reached its timeline', seen);
  ok('the feed rendered 24 cards', await waitFor(() => cardsOf(env).length === 24), String(cardsOf(env).length));
  await sleep(150);
  return env;
}

/* Every card's tree with this item's own attributes taken out — `sizes` and
   `srcset` — and with the attributes that are the picture's state rather than the
   card's, so the "nothing visible moved" half of the rule is a real diff and not
   a memory of a screenshot. Same walk as tools/thumb-url-cache-check.js. */
const SKIP_ATTR = ['src', 'loading', 'data-l', 'decoding', 'sizes', 'srcset'];
function treeOf(doc) {
  return [...doc.querySelectorAll('#feed .card')].map(c => {
    const walk = (el, out) => {
      for (const n of el.childNodes) {
        if (n.nodeType === 3) { const t = n.textContent.trim(); if (t) out.push('#' + t); continue; }
        if (n.nodeType !== 1) continue;
        const attrs = [...n.attributes].filter(a => !SKIP_ATTR.includes(a.name))
          .map(a => a.name + '=' + a.value).sort().join(';');
        out.push('<' + n.tagName + ' ' + attrs);
        walk(n, out);
        out.push('>');
      }
      return out;
    };
    return walk(c, []).join('|');
  }).join('\n');
}

(async () => {
  const env = await boot(FILE);
  const W = env.w;
  const ladder = () => W.eval('THUMB_LADDER.map(r=>r[0]+" "+r[1])');
  const widthOf = n => W.eval('THUMB_LADDER.filter(r=>r[0]==="' + n + '")[0][1]');
  const rungIndex = n => W.eval('THUMB_LADDER.findIndex(r=>r[0]==="' + n + '")');

  /* ---- 1. the declaration is the picker's ---- */
  {
    ok('ladder: still the four CDN rungs', ladder().join(',') === 'mqdefault 320,hqdefault 480,sddefault 640,maxresdefault 1280', ladder().join(','));

    const t = thumbsOf(env);
    const cases = [
      [120, 2, true, 'mqdefault'],
      [170, 3, true, 'sddefault'],
      [402, 3, true, 'maxresdefault'],
      [300, 1, false, 'mqdefault'],
    ];
    let bad = 0;
    for (let i = 0; i < cases.length; i++) {
      const [css, dpr, par, want] = cases[i];
      const img = t[1 + i];
      size(img, css, dpr, par);
      fire(env, img);
      const sizes = img.getAttribute('sizes');
      const tilt = par ? 1.14 : 1;
      const wantSizes = Math.ceil(css * tilt) + 'px';
      if (sizes !== wantSizes) bad++;
      ok('declaration: ' + css + 'px x' + dpr + (par ? '' : ' (parallax off)') + ' declares sizes=' + wantSizes,
        sizes === wantSizes, String(sizes));
      const cands = candidates(img);
      ok('declaration: its candidates start at the rung the picker chose (' + want + ')',
        cands.length > 0 && base(cands[0].url) === want, cands.map(c => base(c.url)).join(','));
      ok('declaration: and its src is still that same file', base(img.getAttribute('src')) === want, img.getAttribute('src'));
    }
    ok('declaration: each case was measured on its own card', bad === 0);
  }

  /* ---- 2. never smaller: the engine's choice against the picker's ---- */
  {
    let under = 0, over = 0, tested = 0, firstUnder = '', firstOver = '', upAt = '';
    for (let css = 40; css <= 640; css += 10) {
      for (const dpr of [1, 1.5, 2, 2.625, 3]) {
        for (const par of [true, false]) {
          const need = Math.ceil(css * dpr * (par ? 1.14 : 1));
          if (need > 1280) continue;
          const pick = W.eval('thumbPick(' + need + ')');
          const cands = W.eval('(function(){var s=thumbSrcset("vid00000000",THUMB_BASE+"vid00000000/"+thumbPick(' + need + ')+".jpg");' +
            'return s.split(", ").map(function(x){var p=x.split(" ");return {url:p[0],width:+String(p[1]).replace("w","")}})})()');
          const sizes = Math.ceil(css * (par ? 1.14 : 1)) + 'px';
          const sel = select(cands, sizes, dpr);
          tested++;
          if (sel.width < need) { under++; if (!firstUnder) firstUnder = css + 'css x' + dpr + ' -> ' + base(sel.url) + ' for ' + need; }
          if (sel.width !== widthOf(pick)) {
            over++;
            if (!upAt) upAt = css + 'css x' + dpr + (par ? '' : ' no-tilt') + ' -> ' + base(sel.url) + ' for ' + need + 'px (pick ' + pick + ')';
            if (rungIndex(base(sel.url)) - rungIndex(pick) > 1) firstOver = upAt;
          }
        }
      }
    }
    ok('engine: no box x ratio is ever handed a file smaller than the picker chose', under === 0,
      under ? under + ' under-sized, first ' + firstUnder : tested + ' boxes x ratios x parallax' + (upAt ? ', one rung up at ' + upAt : ''));
    ok('engine: and none is handed more than one rung above it', !firstOver, firstOver || over + ' of ' + tested + ' picked one rung up');
  }

  /* ---- 3. the candidates are the CDN's ---- */
  {
    const img = thumbsOf(env)[8];
    size(img, 170, 2, true);
    fire(env, img);
    const id = img.dataset.id;
    const cands = candidates(img);
    ok('candidates: every one is a ladder URL for this card\'s own video',
      cands.length > 0 && cands.every(c => c.url === 'https://i.ytimg.com/vi/' + id + '/' + base(c.url) + '.jpg' && widthOf(base(c.url)) > 0),
      cands.map(c => base(c.url)).join(','));
    ok('candidates: each carries the ladder\'s own width',
      cands.every(c => widthOf(base(c.url)) === c.width), cands.map(c => c.width).join(','));
    ok('candidates: they ascend', cands.every((c, i) => !i || c.width > cands[i - 1].width));
    ok('candidates: no rung appears twice', new Set(cands.map(c => c.url)).size === cands.length);
    ok('candidates: nothing below the pick is declared',
      cands[0].width === widthOf(base(img.getAttribute('src'))), cands[0].width + ' vs ' + widthOf(base(img.getAttribute('src'))));
  }

  /* ---- 4. the order that avoids a double request ---- */
  {
    const img = thumbsOf(env)[16];
    size(img, 300, 2, true);
    fire(env, img);
    const names = [...img.attributes].map(a => a.name);
    const iSizes = names.indexOf('sizes'), iSet = names.indexOf('srcset'), iSrc = names.indexOf('src');
    ok('order: sizes is written before srcset, and srcset before src',
      iSizes >= 0 && iSet > iSizes && iSrc > iSet, names.join(','));
    ok('order: the declaration is on the element the app already had, not a new one',
      img.parentElement.classList.contains('thumb') && img.tagName === 'IMG');
  }

  /* ---- 5. the box that changed after the fire ---- */
  {
    const img = thumbsOf(env)[18];
    size(img, 170, 1, true);
    fire(env, img);
    const before = base(img.getAttribute('src'));
    const cands = candidates(img);
    const held = select(cands, img.getAttribute('sizes'), 1);
    /* the phone is rotated: the card is now 560 px wide. Nothing re-renders it,
       nothing re-fires it — only the engine's own selection runs again. */
    const sizesAfter = Math.ceil(560 * 1.14) + 'px';
    const rotated = select(cands, sizesAfter, 1);
    ok('rotation: the card was holding a file for a 170 px box', held.width === widthOf(before), before);
    ok('rotation: the candidates it still carries cover the 560 px box',
      rotated.width > held.width && rotated.width >= Math.ceil(560 * 1 * 1.14),
      base(rotated.url) + ' ' + rotated.width + 'w for ' + Math.ceil(560 * 1 * 1.14) + 'px');
    ok('rotation: nothing had to re-fire the card to get there', img.dataset.l === '1');
    ok('rotation: and the element still has the declaration after the fire', img.hasAttribute('srcset'));
  }

  /* ---- 6. unmeasurable means unchanged ---- */
  {
    const img = thumbsOf(env)[20];
    ok('unmeasurable: a card in this layout-less harness is armed, not asked for',
      img.getAttribute('src') === null && img.dataset.l === '0');
    fire(env, img);
    ok('unmeasurable: it asks for exactly what the old build asked for',
      base(img.getAttribute('src')) === 'maxresdefault', img.getAttribute('src'));
    ok('unmeasurable: and declares no density at all',
      !img.hasAttribute('srcset') && !img.hasAttribute('sizes'));
    ok('unmeasurable: a box that answers 0 is the same', W.eval('thumbSizes(document.createElement("img"))') === '');
  }

  /* ---- 7. the fallbacks still land ---- */
  {
    const img = thumbsOf(env)[22];
    size(img, 300, 2, true);
    fire(env, img);
    const picked = base(img.getAttribute('src'));
    ok('fallback: the card fired with a declaration', img.hasAttribute('srcset'), img.getAttribute('srcset'));
    Object.defineProperty(img, 'naturalWidth', { value: 120, configurable: true });
    W.THOK(img);
    ok('fallback: a grey placeholder swaps to hqdefault and takes the candidates off',
      base(img.getAttribute('src')) === 'hqdefault' && !img.hasAttribute('srcset') && !img.hasAttribute('sizes'),
      img.getAttribute('src') + ' / ' + img.getAttribute('srcset'));
    ok('fallback: 6.5 still records the rung the picker chose',
      W.eval('(function(){var e=thumbFailGet("' + img.dataset.id + '");return e?e.rung:"none"})()') === picked,
      W.eval('(function(){var e=thumbFailGet("' + img.dataset.id + '");return e?e.rung:"none"})()'));

    const b = thumbsOf(env)[23];
    size(b, 300, 2, true);
    fire(env, b);
    b.dataset.f = '';
    W.TH(b);
    ok('fallback: a first failure lands on hqdefault with no candidates left',
      base(b.getAttribute('src')) === 'hqdefault' && !b.hasAttribute('srcset'), b.getAttribute('src'));

    const c = thumbsOf(env)[19];
    size(c, 300, 2, true);
    fire(env, c);
    c.dataset.f = '1';
    W.TH(c);
    ok('fallback: a second failure is still the tidy gradient', c.style.display === 'none');
  }

  /* ---- 8. the UI did not move ---- */
  {
    const img = thumbsOf(env)[15];
    const styleBefore = img.getAttribute('style');
    const attrsBefore = [...img.attributes].map(a => a.name).filter(n => n !== 'src' && n !== 'sizes' && n !== 'srcset').sort().join(',');
    size(img, 300, 2, true);
    fire(env, img);
    const attrsAfter = [...img.attributes].map(a => a.name).filter(n => n !== 'src' && n !== 'sizes' && n !== 'srcset').sort().join(',');
    ok('ui: the declaration writes its two attributes and nothing else', attrsAfter === attrsBefore, attrsBefore + ' / ' + attrsAfter);
    ok('ui: no size, no style, no new element',
      img.getAttribute('style') === styleBefore && !img.hasAttribute('width') && !img.hasAttribute('height'));
    ok('ui: the hooks the tilt layer and the fallbacks read are untouched',
      img.dataset.q === '0' && img.dataset.l === '1' && img.getAttribute('decoding') === 'async' &&
      img.getAttribute('onload') === 'THOK(this)' && img.getAttribute('onerror') === 'TH(this)');
    ok('ui: the box is still the stylesheet\'s 16:9 thumb',
      img.parentElement.classList.contains('thumb') && /\.thumb\{aspect-ratio:16\/9/.test(fs.readFileSync(FILE, 'utf8')));

    if (OLD) {
      /* fresh boots of both builds: this run has already fired cards and taken
         one through both failures, which is not the page either build paints. */
      const old = await boot(OLD);
      const fresh = await boot(FILE);
      const a = treeOf(fresh.d), b = treeOf(old.d), n = cardsOf(fresh).length;
      fresh.dom.window.close(); old.dom.window.close();
      const at = (() => { let i = 0; while (i < a.length && a[i] === b[i]) i++; return i; })();
      ok('ui: every card\'s tree is identical with this item\'s attributes taken out', a === b,
        a === b ? 'identical, ' + n + ' cards' : 'first difference at byte ' + at + ': ' + a.slice(at, at + 60) + ' vs ' + b.slice(at, at + 60));
    } else {
      ok('ui: (no second build given, so the tree diff is skipped)', true);
    }
  }

  /* ---- 9. the probe, and the cost ---- */
  {
    const names = W.eval('__ltSelfCheck().names.join(",")');
    ok('selfcheck: the density probe is in the boot check', names.split(',').indexOf('thumbdensity') >= 0, names);
    const r = W.eval('__ltSelfCheckRun()');
    ok('selfcheck: it passes', r.fail === 0, r.fails.join(',') || 'no failures');
    const census = W.__ltThumbs();
    ok('census: the probe reports what it declared and what it took off',
      census.dens > 0 && census.dclear > 0, census.dens + ' declared, ' + census.dclear + ' cleared');

    const bench = W.eval(`(function(){
      var id='vid00000000',u=THUMB_BASE+id+'/hqdefault.jpg',n=20000,i,t0,t1;
      for(i=0;i<2000;i++)thumbSrcset(id,u);
      t0=performance.now();for(i=0;i<n;i++)thumbSrcset(id,u);t1=performance.now();
      return (t1-t0)/n*1000;
    })()`);
    ok('cost: a candidate list costs a few microseconds, once per card', bench < 20, bench.toFixed(3) + ' µs per fire');
    ok('cost: nothing is remembered — the list is built per fire, from the ladder',
      W.eval('Array.from(THUMB_RES.values()).every(function(e){return Object.keys(e).sort().join()==="need,url"})') === true,
      W.eval('THUMB_RES.size') + ' memo entries, none of them carrying a candidate list');
  }

  console.log(fails ? '\n' + fails + ' check(s) failed' : '\nall checks passed');
  process.exit(fails ? 1 : 0);
})();
