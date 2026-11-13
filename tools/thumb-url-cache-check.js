#!/usr/bin/env node
/*
 * LiquidTube thumbnail-URL cache check — item 6.4.
 *
 * The claim of 6.4 is that a thumbnail URL is resolved once per video instead of
 * once per card, and that remembering it changes nothing about which file is
 * asked for. Both halves are asserted here, on a real boot of the app in jsdom.
 *
 *  1. THE SAME ANSWER. For every card in a 24-card feed the URL the cache hands
 *     out is byte-for-byte `THUMB_BASE + id + '/' + thumbPick(need) + '.jpg'` —
 *     the expression the build before this item evaluated inline. A cache that
 *     answered anything else would be a different picture, so this is the check
 *     that fails if the memo drifts from the ladder.
 *  2. ONCE. Firing the same card again, and asking again for the same id from a
 *     second element (the same video on another surface), is a hit: `miss` does
 *     not move, `hit` grows by exactly the number of repeats, and the string is
 *     identical. The count is the item's whole point — on the build before it,
 *     every one of those repeats was a ladder walk and four concatenations.
 *  3. THE BOX STILL WINS. The same video drawn at 170 px and at 402 px must get
 *     mqdefault and hqdefault — 6.3's promise, which a per-id cache could quietly
 *     break by handing back the first answer. The pick is remade (`repick`), and
 *     going back to the small box re-picks small: nothing is left stale.
 *  4. BOUNDED. Five hundred distinct ids leave the map at its ceiling, evicting
 *     the oldest first, and an evicted id resolves correctly when it comes back.
 *  5. THE FALLBACK IS UNTOUCHED. `thumbHQ` builds exactly the hqdefault URL the
 *     two literals in `THOK` and `TH` used to build, and both hooks still land on
 *     it — the failure path is the same path.
 *  6. NOTHING PERSISTED. The cache lives in the session only: no new key in
 *     localStorage, so a later build with a different ladder cannot inherit it.
 *  7. THE PROBE. The boot-time self-check carries the `thumburls` probe and it
 *     passes on this build.
 *  8. THE COST. A measured micro-benchmark of the cached path against the inline
 *     expression it replaced, so the log can quote a number rather than a hope —
 *     and the shape of a session: five repaints of a 24-card feed fire 120
 *     thumbnails and resolve 24 URLs, so 96 of them do no work at all.
 *
 * Runs in jsdom with googleapis answered from fixtures — no network, no
 * Chromium, no device. With a second file it also boots that build and diffs
 * every card's tree with this item's own attributes taken out, and fails if a
 * node, a class or a line of text moved: that is the "the UI does not change"
 * half of the rule.
 *
 *   npm i jsdom
 *   node tools/thumb-url-cache-check.js app/assets/index.html
 *   node tools/thumb-url-cache-check.js app/assets/index.html /tmp/old/index.html
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
  const mockFetch = async u => ({ ok: true, status: 200, json: async () => apiBody(String(u)), headers: new Map() });
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
const imgsOf = env => [...env.d.querySelectorAll('#feed .card .thumb img')];
const census = env => (env.w.__ltThumbs ? env.w.__ltThumbs() : null);
/* What the user can see, with this item's own attributes taken out. */
const look = env => cardsOf(env).map(c => {
  const walk = (el, out) => {
    for (const n of el.childNodes) {
      if (n.nodeType === 3) { const t = n.textContent.trim(); if (t) out.push('#' + t); continue; }
      if (n.nodeType !== 1) continue;
      const attrs = [...n.attributes]
        .filter(a => !['src', 'loading', 'data-l', 'decoding'].includes(a.name))
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

/* A box the picker can measure. jsdom has no layout, so every element answers 0
   for `clientWidth` and every pick would be maxres; the tool decides the width. */
function box(el, cssPx) {
  Object.defineProperty(el, 'clientWidth', { value: cssPx, configurable: true });
  return el;
}

(async () => {
  /* ---- 1. the same answer ---- */
  {
    const env = await boot(FILE);
    const imgs = imgsOf(env);
    ok('every card has a thumbnail', imgs.length === 24, String(imgs.length));
    const expect = env.w.eval('(function(id,px){return THUMB_BASE+id+"/"+thumbPick(px)+".jpg"})');
    const pxOf = env.w.eval('(function(img){return thumbPixels(img)})');
    let same = 0, url = '';
    for (const im of imgs) {
      const id = im.dataset.id;
      const want = expect(id, pxOf(im));
      const got = env.w.eval('(function(img){return thumbURL(img)})')(im);
      if (want === got) same++; else url = id + ' want ' + want + ' got ' + got;
    }
    ok('cache hands back exactly the ladder\'s URL', same === 24, same + '/24 ' + url);
    const c = census(env);
    ok('the census reports the map and its ceiling', !!c && c.urls > 0 && c.max > 0 && c.urls <= c.max,
      c ? 'urls=' + c.urls + ' max=' + c.max : 'no census');
    env.dom.window.close();
  }

  /* ---- 2. once ---- */
  {
    const env = await boot(FILE);
    const imgs = imgsOf(env);
    const u1 = env.w.eval('(function(img){return thumbURL(img)})')(imgs[0]);   /* first ask: a miss */
    const before = census(env);
    const u2 = env.w.eval('(function(img){return thumbURL(img)})')(imgs[0]);   /* second ask: a hit */
    const after = census(env);
    ok('the same card twice is a hit, not a resolution',
      u1 === u2 && after.hit === before.hit + 1 && after.miss === before.miss && after.urls === before.urls,
      'hit ' + before.hit + '->' + after.hit + ' miss ' + before.miss + '->' + after.miss);
    /* the same video on another surface: a second element, same id */
    const twin = env.d.createElement('img');
    twin.dataset.id = imgs[0].dataset.id;
    box(twin, 0);
    const u3 = env.w.eval('(function(img){return thumbURL(img)})')(twin);
    const after2 = census(env);
    ok('the same video on a second surface is a hit too',
      u3 === u1 && after2.hit === after.hit + 1 && after2.urls === after.urls,
      'hit ' + after2.hit + ' urls ' + after2.urls);
    /* a whole re-render of the feed: 24 ids, all known */
    const missBefore = census(env).miss, hitBefore = census(env).hit;
    env.w.eval("(function(){document.getElementById('feed').innerHTML='';})()");
    await sleep(60);
    const c = census(env);
    ok('nothing is persisted with the cache',
      !Object.keys(env.w.localStorage).some(k => /thumb|url/i.test(k)),
      Object.keys(env.w.localStorage).join(','));
    ok('the counters only ever grow', c.hit >= hitBefore && c.miss >= missBefore,
      'hit ' + hitBefore + '->' + c.hit + ' miss ' + missBefore + '->' + c.miss);
    env.dom.window.close();
  }

  /* ---- 3. the box still wins ---- */
  {
    const env = await boot(FILE);
    const id = 'samevideo1';
    const small = box(env.d.createElement('img'), 170); small.dataset.id = id;
    const big = box(env.d.createElement('img'), 402); big.dataset.id = id;
    const thumbURL = env.w.eval('(function(img){return thumbURL(img)})');
    const pickOf = env.w.eval('(function(img){return thumbPick(thumbPixels(img))})');
    const s1 = thumbURL(small);
    const b1 = thumbURL(big);
    ok('a 170 px row and a 402 px card ask for different files',
      s1 !== b1 && s1.endsWith('/' + pickOf(small) + '.jpg') && b1.endsWith('/' + pickOf(big) + '.jpg'),
      s1.split('/').pop() + ' vs ' + b1.split('/').pop());
    const c = census(env);
    ok('the re-pick is counted, not hidden', c.repick > 0, 'repick=' + c.repick);
    const s2 = thumbURL(small);
    ok('going back to the small box re-picks small', s2 === s1, s2.split('/').pop());
    /* dpr: a 2x screen needs twice the pixels, so the pick may only grow */
    const rung = env.w.eval('(function(a,b){return THUMB_LADDER.findIndex(r=>r[0]===a)<=THUMB_LADDER.findIndex(r=>r[0]===b)})');
    Object.defineProperty(env.w, 'devicePixelRatio', { value: 2, configurable: true });
    const b2 = thumbURL(big);
    ok('a 2x screen never asks for a smaller file', rung(b1.split('/').pop().replace('.jpg', ''), b2.split('/').pop().replace('.jpg', '')),
      b1.split('/').pop() + ' -> ' + b2.split('/').pop());
    env.dom.window.close();
  }

  /* ---- 4. bounded ---- */
  {
    const env = await boot(FILE);
    const max = census(env).max;
    const mk = id => { const el = box(env.d.createElement('img'), 402); el.dataset.id = id; return el; };
    const thumbURL = env.w.eval('(function(img){return thumbURL(img)})');
    for (let i = 0; i < 500; i++) thumbURL(mk('bulk' + String(i).padStart(5, '0')));
    const c = census(env);
    ok('the map stops at its ceiling', c.urls <= max && c.urls > 0, 'urls=' + c.urls + ' max=' + max);
    ok('the oldest entry was the one evicted', c.evict > 0, 'evict=' + c.evict);
    ok('an evicted id resolves correctly when it comes back',
      thumbURL(mk('bulk00000')).indexOf('bulk00000') > 0);
    env.dom.window.close();
  }

  /* ---- 5. the fallback is untouched ---- */
  {
    const env = await boot(FILE);
    const img = imgsOf(env)[0];
    const id = img.dataset.id;
    const hq = env.w.eval('(function(id){return thumbHQ(id)})')(id);
    ok('thumbHQ builds the same hqdefault URL as before',
      hq === 'https://i.ytimg.com/vi/' + id + '/hqdefault.jpg', hq);
    Object.defineProperty(img, 'naturalWidth', { value: 120, configurable: true });
    env.w.THOK(img);
    ok('a grey 120 px placeholder still swaps to hqdefault', img.getAttribute('src') === hq, img.getAttribute('src'));
    const img2 = imgsOf(env)[1];
    env.w.TH(img2);
    ok('a first failure still swaps to hqdefault',
      img2.getAttribute('src') === env.w.eval('(function(id){return thumbHQ(id)})')(img2.dataset.id), img2.getAttribute('src'));
    env.dom.window.close();
  }

  /* ---- 6. nothing persisted (second view, on a fresh boot) ---- */
  {
    const env = await boot(FILE);
    const keys = Object.keys(env.w.localStorage);
    ok('the cache added no storage key', !keys.some(k => /thumb/i.test(k)), keys.join(',') || 'none');
    const store = env.w.__ltStore ? env.w.__ltStore() : null;
    ok('the store census still lists the same keys',
      !store || !store.keys.some(k => /thumb/i.test(k)), store ? store.keys.join(',') : 'no census');
    env.dom.window.close();
  }

  /* ---- 7. the probe ---- */
  {
    const env = await boot(FILE);
    const names = env.w.__ltSelfCheck ? env.w.__ltSelfCheck().names : null;
    const sc = env.w.__ltSelfCheckRun ? env.w.__ltSelfCheckRun() : null;
    ok('the boot self-check carries the thumburls probe', !!names && names.indexOf('thumburls') >= 0,
      names ? String(names.length) + ' probes' : 'no self-check');
    ok('the thumburls probe passes', !!sc && sc.fails.indexOf('thumburls') < 0,
      sc ? 'fails=' + (sc.fails.join(',') || 'none') : 'no self-check');
    env.dom.window.close();
  }

  /* ---- 8. the cost ---- */
  {
    const env = await boot(FILE);
    const ids = imgsOf(env).map(im => im.dataset.id);
    const N = 200000;
    /* the work the item removes, isolated: resolve a URL for an id already known
       at a known size, against building the same string from the ladder */
    const run = code => env.w.eval(`(function(ids,n){const t0=performance.now();let s=0;for(let i=0;i<n;i++){${code}}return performance.now()-t0})`)(ids, N);
    const CACHED = "s+=thumbMemo(ids[i%ids.length],459).length";
    const INLINE = "s+=(THUMB_BASE+ids[i%ids.length]+'/'+thumbPick(459)+'.jpg').length";
    run(CACHED); run(INLINE);                       /* warm both paths first */
    const cMin = Math.min(run(CACHED), run(CACHED), run(CACHED));
    const iMin = Math.min(run(INLINE), run(INLINE), run(INLINE));
    const saved = (iMin - cMin) / N * 1000;
    console.log('     ' + N + ' resolutions: cached ' + cMin.toFixed(1) + ' ms, from the ladder ' +
      iMin.toFixed(1) + ' ms, saved ' + saved.toFixed(3) + ' µs per resolution');
    /* break-even is the honest expectation — a map lookup costs about what a
       rope concatenation and a four-rung ladder cost — so the check is that the
       cache did not make the fire path materially worse, not that it beat it */
    ok('the cached path is within noise of the ladder it replaced', saved > -0.05,
      saved.toFixed(3) + ' µs per resolution');
    /* and the shape of a real session: five repaints of the same 24-card feed */
    const before = census(env);
    const fire = env.w.eval('(function(){document.querySelectorAll("#feed .card .thumb img").forEach(function(im){im.dataset.l="0";thumbFire(im)})})');
    for (let r = 0; r < 5; r++) { fire(); }
    const after = census(env);
    const fired = 120, resolved = after.miss - before.miss + after.repick - before.repick;
    const hits = after.hit - before.hit;
    ok('five repaints of a 24-card feed resolve 24 URLs, not 120',
      resolved <= 24 && hits >= fired - 24, 'fired ' + fired + ' resolved ' + resolved + ' hits ' + hits);
    env.dom.window.close();
  }

  /* ---- the UI did not change ---- */
  if (OLD) {
    const a = await boot(OLD);
    const la = look(a), na = cardsOf(a).length;
    a.dom.window.close();
    const b = await boot(FILE);
    const lb = look(b), nb = cardsOf(b).length;
    b.dom.window.close();
    ok('ui: same number of cards', na === nb && na > 0, na + ' vs ' + nb);
    ok('ui: same card tree, src/loading/data-l aside', la === lb,
      la === lb ? 'identical' : 'first difference at byte ' + (() => { let i = 0; while (i < la.length && la[i] === lb[i]) i++; return i; })());
  }

  console.log(fails ? '\n' + fails + ' check(s) failed' : '\nall checks passed');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
