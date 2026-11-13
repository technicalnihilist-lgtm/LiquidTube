#!/usr/bin/env node
/*
 * LiquidTube thumbnail-fade check — item 6.7.
 *
 * The claim of 6.7 is that a card's picture stops popping into place: the
 * element is held invisible until the engine has finished *decoding* the file
 * (`img.decode()`), and is then faded in over a box that was already the right
 * size. This asserts every half of that on a real boot of the app in jsdom.
 *
 *  1. BORN HIDDEN. Every thumbnail in the markup is `data-fd="0"` and carries no
 *     `src` — 6.1's arming is intact — so a card waiting for its picture is the
 *     empty reserved box it was before the item, not a blank white one.
 *  2. ONLY WHEN DECODED. With the engine's decode stubbed to a promise the test
 *     controls, a fired card stays `data-fd="0"` for as long as the promise is
 *     pending and flips to `1` only when it resolves. That is the whole item: the
 *     reveal is scheduled by decode, not by the fetch.
 *  3. A DECODE THAT REJECTS REVEALS NOTHING. A file that cannot be decoded is a
 *     file `TH` handles; the fade path must not show it and must not throw.
 *  4. NO DECODE MEANS NO CHANGE. An engine without `decode()` (a WebView older
 *     than Chromium 64, and jsdom itself) reveals at once, which is exactly the
 *     build before the item.
 *  5. THE FADE IS THE STYLESHEET'S. `data-fd="0"` is `opacity:0`; `data-fd="1"`
 *     is `opacity:1` with an `opacity` transition and the element's own
 *     `transform` transition beside it; with parallax off the transform
 *     transition stays suppressed and only the opacity one is kept. An `<img>`
 *     with no `data-fd` matches neither rule, so nothing else in the app changed.
 *  6. THE FALLBACK FADES TOO. `TH`'s swap to `hqdefault` goes through the same
 *     ask, so a card that fell back is held until *that* file decodes instead of
 *     showing a picture the engine has not finished with.
 *  7. ONE REVEAL PER ELEMENT, NO TIMER. A second ask for the same element writes
 *     `data-fd` once, and the fade path schedules no `setTimeout` at all — the
 *     promise is the whole schedule (4.1 removed per-render timers; a timer per
 *     image would be hundreds on a feed).
 *  8. THE CARD DID NOT MOVE. Every card's tree, with the picture-state attributes
 *     taken out, is identical to the build before the item when one is given.
 *  9. THE PROBE. The boot-time self-check carries the `thumbfade` probe and it
 *     passes on this build.
 *
 * Runs in jsdom with googleapis answered from fixtures — no network, no Chromium,
 * no device — on the same harness as tools/thumb-density-check.js.
 *
 *   npm i jsdom
 *   node tools/thumb-fade-check.js app/assets/index.html
 *   node tools/thumb-fade-check.js app/assets/index.html /tmp/old/index.html
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
  const env = { ios: [], lines: [], errors: [], timers: 0 };
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

/* Deliver the intersection 6.1's observer would deliver, so the card asks for
   its picture exactly the way it does on a device. */
function fire(env, img) {
  env.ios[0].cb([{ target: img, isIntersecting: true }]);
  return img;
}

/* A decode the test drives: the element stays hidden until `settle()` is called.
   `mode` is 'ok' or 'fail', which is the two shapes the engine can answer with. */
function stubDecode(img, mode = 'ok') {
  const box = { mode, settled: false, calls: 0 };
  box.promise = new Promise((res, rej) => { box.resolve = res; box.reject = rej; });
  box.settle = () => {
    if (box.settled) return box.promise;
    box.settled = true;
    if (mode === 'ok') box.resolve(); else box.reject(new Error('EncodingError'));
    return box.promise;
  };
  img.decode = () => { box.calls++; return box.promise; };
  return box;
}

/* Every card's tree with the picture's own state taken out — `src`, `data-l`,
   `data-f`, `data-fd`, `sizes`, `srcset` — so the "nothing visible moved" half of
   the rule is a real diff and not a memory of a screenshot. Same walk as
   tools/thumb-density-check.js. */
const SKIP_ATTR = ['src', 'loading', 'data-l', 'decoding', 'sizes', 'srcset', 'data-f', 'data-fd'];
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

async function boot(file) {
  const env = open(file);
  const seen = await waitFor(() => env.w.__ltTimeline && env.lines.some(l => l.indexOf('lt-startup') === 0));
  ok('boot reached its timeline', seen);
  ok('the feed rendered 24 cards', await waitFor(() => cardsOf(env).length === 24), String(cardsOf(env).length));
  await sleep(150);
  return env;
}

(async () => {
  const env = await boot(FILE);
  const W = env.w;
  const census = () => W.eval('window.__ltThumbs()');

  /* ---- 1. born hidden ---- */
  {
    const markup = W.eval('thumbImg("abc")');
    ok('markup: a thumbnail is born data-fd="0"', /data-fd="0"/.test(markup), markup);
    ok('markup: and still born with no src (6.1 intact)', !/\ssrc=/.test(markup));
    const armed = thumbsOf(env);
    const inFeed = [...env.d.querySelectorAll('#feed .card img[data-l]')];
    ok('markup: every armed thumbnail is hidden until it is asked for',
      armed.length >= 24 && inFeed.length === 24 && armed.every(i => i.dataset.fd === '0'),
      armed.length + ' armed, ' + inFeed.length + ' in the feed');
    ok('markup: and none of them is holding a picture yet',
      armed.every(i => !i.getAttribute('src')));
  }

  /* ---- 2. only when decoded ---- */
  {
    const img = thumbsOf(env)[2];
    const box = stubDecode(img, 'ok');
    fire(env, img);
    await sleep(30);
    ok('decode: the card asked for its picture', !!img.getAttribute('src') && img.dataset.l === '1', img.getAttribute('src'));
    ok('decode: decode() was called exactly once for it', box.calls === 1, String(box.calls));
    ok('decode: and the picture is still hidden while the decode is pending', img.dataset.fd === '0', img.dataset.fd);
    box.settle();
    ok('decode: the picture is shown when — and only when — the decode resolves',
      await waitFor(() => img.dataset.fd === '1'), img.dataset.fd);
    ok('decode: the reveal wrote the state once', box.calls === 1);
  }

  /* ---- 3. a decode that rejects reveals nothing ---- */
  {
    const img = thumbsOf(env)[3];
    const box = stubDecode(img, 'fail');
    fire(env, img);
    await sleep(20);
    box.settle();
    await sleep(60);
    ok('reject: a file that cannot be decoded is not revealed', img.dataset.fd === '0', img.dataset.fd);
    ok('reject: and the fade path did not throw', env.errors.filter(e => /decode|fade|thumb/i.test(e)).length === 0,
      env.errors.join(' | '));
  }

  /* ---- 4. no decode means no change ---- */
  {
    const img = thumbsOf(env)[4];
    img.decode = undefined;                 /* a WebView older than Chromium 64 */
    fire(env, img);
    ok('fallback: an engine with no decode() reveals at once — the build before the item',
      img.dataset.fd === '1', img.dataset.fd);
  }

  /* ---- 5. the fade is the stylesheet's ---- */
  {
    const sheets = [...env.d.querySelectorAll('style')].map(s => s.textContent).join('\n');
    ok('css: data-fd="0" is held at opacity:0',
      /\.thumb img\[data-fd="0"\]\s*\{\s*opacity:0\s*\}/.test(sheets));
    const shown = /\.thumb img\[data-fd="1"\]\s*\{([^}]*)\}/.exec(sheets);
    ok('css: data-fd="1" is opacity:1 with an opacity transition',
      !!shown && /opacity:1/.test(shown[1]) && /opacity \.26s ease/.test(shown[1]), shown ? shown[1] : 'missing');
    ok('css: and it carries the element\'s own transform transition beside it',
      !!shown && /transform \.12s linear/.test(shown[1]));
    const off = /html\[data-parallax=off\] \.thumb img\[data-fd="1"\]\s*\{([^}]*)\}/.exec(sheets);
    ok('css: with parallax off the transform transition stays suppressed and the fade is kept',
      !!off && /opacity \.26s ease/.test(off[1]) && !/transform \.12s/.test(off[1]), off ? off[1] : 'missing');
    ok('css: the base rules still suppress the transform transition with parallax off',
      /html\[data-parallax=off\] \.thumb img\{transform:none!important;transition:none\}/.test(sheets));
    ok('css: an img with no data-fd matches neither fade rule',
      /\.thumb img\[data-fd="0"\]/.test(sheets) && !/\.thumb img\s*\{\s*opacity:0/.test(sheets));
    ok('css: the box is still the stylesheet\'s aspect-ratio (6.8)',
      /\.thumb\{aspect-ratio:16\/9/.test(sheets));
  }

  /* ---- 6. the fallback fades too ---- */
  {
    const img = thumbsOf(env)[5];
    const first = stubDecode(img, 'fail');
    fire(env, img);
    await sleep(20);
    first.settle();                          /* the picked file will not decode */
    await sleep(40);
    W.eval('TH(' + 'document.querySelectorAll("img[data-l]")[5])');   /* TH's first-failure path */
    const second = stubDecode(img, 'ok');
    W.eval('thumbFade(document.querySelectorAll("img[data-l]")[5])');
    await sleep(20);
    ok('fallback: the swap to hqdefault is held until that file decodes too', img.dataset.fd === '0', img.dataset.fd);
    second.settle();
    ok('fallback: and then it fades in like the pick', await waitFor(() => img.dataset.fd === '1'), img.dataset.fd);
    ok('fallback: on the fallback file', /hqdefault\.jpg$/.test(img.getAttribute('src') || ''), img.getAttribute('src'));
  }

  /* ---- 7. one reveal per element, and no timer ---- */
  {
    const img = thumbsOf(env)[6];
    const box = stubDecode(img, 'ok');
    const before = census();
    fire(env, img);
    box.settle();
    await waitFor(() => img.dataset.fd === '1');
    const after = census();
    const asks = after.fask - before.fask;
    const reveals = after.fade - before.fade;
    ok('cost: one ask and one reveal for one card', asks === 1 && reveals === 1, asks + ' asks, ' + reveals + ' reveals');
    const second = W.eval('(function(i){var a=THUMB_FD.ask,r=THUMB_FD.reveal;thumbFade(i);return [THUMB_FD.ask-a,THUMB_FD.reveal-r]})' +
      '(document.querySelectorAll("img[data-l]")[6])');
    ok('cost: a second ask on the same element cannot reveal it twice', second[1] === 0, second.join('/'));
    const timers = W.eval('(function(){var n=0,o=window.setTimeout;window.setTimeout=function(){n++;return o.apply(this,arguments)};' +
      'var i=document.createElement("img");i.dataset.fd="0";thumbFade(i);thumbShow(i);window.setTimeout=o;return n})()');
    ok('cost: the fade path schedules no timer at all', timers === 0, String(timers));
    ok('cost: the census reports the three outcomes', typeof census().fade === 'number' && typeof census().finstant === 'number' && typeof census().flost === 'number',
      JSON.stringify({ fade: census().fade, fask: census().fask, finstant: census().finstant, flost: census().flost }));
    ok('cost: nothing accumulated in any thumbnail map',
      census().urls <= census().max && census().fail <= census().fmax);
  }

  /* ---- 8. the card did not move ---- */
  if (OLD) {
    const oldEnv = await boot(OLD);
    const a = treeOf(env.d), b = treeOf(oldEnv.d);
    ok('ui: every feed card is the same tree as the build before the item, picture state aside',
      a === b, a === b ? '' : 'differs');
    oldEnv.dom.window.close();
  } else {
    console.log('skip  ui: no second build given (pass the previous index.html as argv[3] to diff)');
  }

  /* ---- 9. the probe ---- */
  {
    const probe = W.eval('(function(){try{var p=SC.filter(function(x){return x[0]==="thumbfade"})[0];return p?!!p[1]():false}catch(e){return false}})()');
    ok('probe: the boot self-check carries a passing thumbfade probe', probe === true);
    const names = W.eval('window.__ltSelfCheck&&window.__ltSelfCheck().names||[]');
    ok('probe: and it is published with the rest', Array.isArray(names) && names.indexOf('thumbfade') >= 0, (names || []).join(','));
  }

  console.log(fails ? '\n' + fails + ' FAILED' : '\nall checks passed');
  process.exit(fails ? 1 : 0);
})();
