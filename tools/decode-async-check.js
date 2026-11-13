#!/usr/bin/env node
/*
 * LiquidTube thumbnail-decode check — item 6.2.
 *
 * The claim of 6.2 is that a thumbnail's decode no longer runs on the thread
 * that is drawing the scroll. `decoding="async"` is the only way the markup can
 * say that, so this asserts the attribute is present on every thumbnail the app
 * can build, that it survives the two `src` swaps the fallback makes, that it
 * did not spread to the small avatars it was deliberately kept off, and — the
 * other half of the rule — that nothing the user can see moved.
 *
 *  1. THE HINT IS THERE. `thumbImg(id)` returns an `<img>` carrying
 *     `decoding="async"`, exactly once. This is the check that fails on the
 *     build before the item.
 *  2. 6.1 IS INTACT. The same markup still has no `src` and no native
 *     `loading`, still carries `data-id`, `data-q`, `data-l`, `onload`→`THOK`
 *     and `onerror`→`TH`: an async decode must not have cost the arming or the
 *     fallback that the last item put there.
 *  3. EVERY CARD. After a 24-card boot every thumbnail in the document — the
 *     feed and the six in the dormant shelf — reports `img.decoding === 'async'`
 *     and the attribute on the element, and none of them has a `src`: the hint
 *     is about decoding, it does not start a fetch.
 *  4. THE OTHER BUILDER. `fillShelf` builds the carousel's own `<img>` by hand,
 *     not through `thumbImg`, so it is checked separately: its images carry the
 *     attribute too.
 *  5. IT SURVIVES THE SWAPS. Fire a card (6.1's `thumbFire` sets the maxres
 *     URL), then deliver the 120 px `maxresdefault` that makes `THOK` swap to
 *     `hqdefault`, then fail twice so `TH` hides the card. The element still
 *     says `async` at every step, so the fallback pictures decode off the main
 *     thread as well.
 *  6. NOT ON THE AVATARS. The 24–40 px channel avatars in the cards have no
 *     `decoding`: the item stayed on the thumbnails, as it was scoped to.
 *  7. A PURE HINT. Nothing in the app reads `decoding` — no `.decoding`, no
 *     `getAttribute('decoding')`, no branch on it — so a WebView that ignores
 *     the attribute runs exactly the code it ran before, and the hint can never
 *     gate a render.
 *  8. RE-RENDER. A second feed render is built by the same markup, so it carries
 *     the attribute on every card and the document still holds one per
 *     thumbnail, not two.
 *  9. THE UI DID NOT MOVE. With a second file (the build before this item) it
 *     boots both and diffs every card's tree with the attributes this item and
 *     the last one own (`src`, `loading`, `data-l`, `decoding`) taken out, and
 *     fails if a node, a class or a line of text moved.
 *
 * Runs in jsdom with googleapis answered from fixtures — no network, no
 * Chromium, no device — on the same harness as tools/lazy-thumb-check.js.
 *
 *   npm i jsdom
 *   node tools/decode-async-check.js app/assets/index.html
 *   node tools/decode-async-check.js app/assets/index.html /tmp/old/index.html
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
const avatarsOf = env => [...env.d.querySelectorAll('#feed .card .av')].filter(n => n.tagName === 'IMG');

/* What the user can see, with the attributes this item and the last one own
   taken out: none of them draws anything. */
const look = env => cardsOf(env).map(c => {
  const walk = (el, out) => {
    for (const n of el.childNodes) {
      if (n.nodeType === 3) { const t = n.textContent.trim(); if (t) out.push('#' + t); continue; }
      if (n.nodeType !== 1) continue;
      const attrs = [...n.attributes]
        .filter(a => !['src', 'loading', 'data-l', 'decoding', 'data-fd'].includes(a.name))
        .map(a => a.name + '=' + a.value).sort().join(';');
      out.push('<' + n.tagName + ' ' + attrs);
      walk(n, out);
      out.push('>');
    }
    return out;
  };
  return walk(c, []).join('|');
}).join('\n');

async function boot(file) {
  const env = open(file);
  const seen = await waitFor(() => env.w.__ltTimeline && env.lines.some(l => l.indexOf('lt-startup') === 0));
  ok('boot reached its timeline', seen);
  ok('the feed rendered 24 cards', await waitFor(() => cardsOf(env).length === 24), String(cardsOf(env).length));
  await sleep(150);
  return env;
}

(async () => {
  /* ---- 1, 2. the markup ---- */
  {
    const env = await boot(FILE);
    const m = env.w.eval("thumbImg('abc')");
    ok('markup: the thumbnail asks for an async decode', /decoding="async"/.test(m), m);
    ok('markup: said once, not twice', (m.match(/decoding=/g) || []).length === 1, m);
    ok('markup: 6.1 intact — born without a src', !/\ssrc=/.test(m), m);
    ok('markup: 6.1 intact — no native loading', !/loading=/.test(m), m);
    ok('markup: 6.1 intact — the arming state is data-l="0"', /data-l="0"/.test(m));
    ok('markup: the hooks the rest of the app reads are still there',
      /data-id="abc"/.test(m) && /data-q="0"/.test(m) && /onload="THOK\(this\)"/.test(m) && /onerror="TH\(this\)"/.test(m));

    /* ---- 3. every thumbnail in the document ---- */
    const all = thumbsOf(env);
    ok('boot: the feed and the dormant shelf are both covered', all.length === 30, String(all.length));
    ok('boot: every thumbnail says async on the element', all.every(i => i.getAttribute('decoding') === 'async'),
      all.filter(i => i.getAttribute('decoding') !== 'async').length + ' without it');
    /* jsdom does not implement the `decoding` IDL attribute; where a WebView
       does, it reflects the content attribute and must agree with it. */
    const hasProp = 'decoding' in env.w.HTMLImageElement.prototype;
    ok('boot: where the property exists it reflects the attribute',
      !hasProp || all.every(i => i.decoding === 'async'),
      hasProp ? 'reflected' : 'this DOM has no decoding property');
    ok('boot: none of them started a fetch for it', all.every(i => i.getAttribute('src') === null),
      all.filter(i => i.getAttribute('src') !== null).length + ' with src');
    const dec = [...env.d.querySelectorAll('img[decoding]')];
    const bigs = [...env.d.querySelectorAll('.big img')];
    ok('boot: the carousel images are thumbnails too', bigs.length === 12, String(bigs.length));
    ok('boot: the only images carrying it are video thumbnails',
      dec.length === all.length + bigs.length && dec.every(i => i.hasAttribute('data-l') || i.closest('.big')),
      dec.length + ' vs ' + (all.length + bigs.length));

    /* ---- 6. not on the avatars ---- */
    const av = avatarsOf(env);
    ok('scope: the cards do carry avatars to check', av.length > 0, String(av.length));
    ok('scope: no avatar was given an async decode', av.every(i => i.getAttribute('decoding') === null),
      av.filter(i => i.getAttribute('decoding') !== null).length + ' with it');

    /* ---- 5. it survives both swaps ---- */
    const io = env.ios[0];
    const first = all.find(i => i.closest('#feed'));
    if (io && first) {
      io.cb([{ target: first, isIntersecting: true }]);
      ok('swap: firing the card gives it the maxres picture',
        /maxresdefault\.jpg$/.test(first.getAttribute('src') || ''), first.getAttribute('src'));
      ok('swap: and it is still an async decode', first.getAttribute('decoding') === 'async');
      Object.defineProperty(first, 'naturalWidth', { value: 120, configurable: true });
      env.w.THOK(first);
      ok('swap: the 120 px fallback to hqdefault keeps it',
        /hqdefault\.jpg$/.test(first.getAttribute('src') || '') && first.getAttribute('decoding') === 'async',
        first.getAttribute('src'));
      env.w.TH(first);
      env.w.TH(first);
      ok('swap: a twice-failed picture is hidden and still says async',
        first.style.display === 'none' && first.getAttribute('decoding') === 'async', first.style.display);
    } else {
      ok('swap: the build has an observer and a feed card to fire', false);
    }

    /* ---- 4. the carousel's own builder ---- */
    const car = env.d.createElement('div');
    car.id = 'car-probe';
    env.d.body.appendChild(car);
    env.w.eval("fillShelf({id:'probe',title:'Probe'},[{id:'vid00000000',t:'One',c:'C'},{id:'vid00000001',t:'Two',c:'C'}])");
    const big = [...car.querySelectorAll('img')];
    ok('shelf: fillShelf built its own images', big.length === 2, String(big.length));
    ok('shelf: they carry the async decode too', big.every(i => i.getAttribute('decoding') === 'async'),
      big.map(i => i.getAttribute('decoding')).join(','));
    ok('shelf: and they still carry their own src', big.every(i => /hqdefault\.jpg$/.test(i.getAttribute('src') || '')));

    /* ---- 8. a re-render ---- */
    const beforeImgs = thumbsOf(env);
    const before = beforeImgs.length;
    env.w.eval('loadTrending()');
    await waitFor(() => thumbsOf(env).length === 24 && thumbsOf(env)[0] !== beforeImgs[0]);
    await sleep(250);
    const after = thumbsOf(env);
    ok('re-render: the feed is rebuilt', cardsOf(env).length === 24, String(cardsOf(env).length));
    ok('re-render: every new card asks for an async decode',
      after.filter(i => i.closest('#feed')).every(i => i.getAttribute('decoding') === 'async'));
    ok('re-render: one per thumbnail, not two', after.length === 30, before + ' -> ' + after.length);
    env.dom.window.close();
  }

  /* ---- 7. a pure hint: nothing branches on it ---- */
  {
    const src = fs.readFileSync(FILE, 'utf8');
    ok('hint: no code reads the property', !/\.decoding\b/.test(src));
    ok('hint: no code reads the attribute', !/getAttribute\(\s*['"]decoding/.test(src) && !/dataset\.decoding/.test(src));
    /* `<img>` written bare is prose in a comment, not markup: only a literal
       with an attribute in it can be an image the app builds. */
    const lits = src.match(/<img[^>]+>/g) || [];
    const withD = lits.filter(s => /decoding="async"/.test(s));
    const withoutD = lits.filter(s => !/decoding="async"/.test(s));
    ok('hint: both video-thumbnail builders write it', withD.length === 2, String(withD.length));
    ok('hint: the only images without it are the small avatars',
      withoutD.length === 3 && withoutD.every(s => /class="av"|esc\(c\.av\)/.test(s)),
      withoutD.length + ' others');
  }

  /* ---- 9. the UI did not move ---- */
  if (OLD) {
    const a = await boot(FILE);
    const la = look(a);
    a.dom.window.close();
    const b = await boot(OLD);
    const lb = look(b);
    b.dom.window.close();
    ok('ui: the previous build rendered the same cards', la.length > 0 && lb.length > 0, la.length + ' / ' + lb.length);
    ok('ui: same card tree, src/loading/data-l/decoding aside', la === lb,
      la === lb ? 'identical' : 'differs at ' + firstDiff(la, lb));
  }

  console.log(fails ? '\n' + fails + ' failure(s)' : '\nall checks passed');
  process.exit(fails ? 1 : 0);
})();

function firstDiff(a, b) {
  const x = a.split('\n'), y = b.split('\n');
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (x[i] !== y[i]) return 'card ' + (i + 1);
  }
  return 'an unknown place';
}
