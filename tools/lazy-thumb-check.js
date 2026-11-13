#!/usr/bin/env node
/*
 * LiquidTube thumbnail-lazy check — item 6.1.
 *
 * The claim of 6.1 is narrow, and it has to be proved on both sides of itself: a
 * card no longer asks for its picture when it is born, and it still gets the
 * same picture the moment it comes near the screen. This asserts nine things.
 *
 *  1. BORN UNARMED. `thumbImg(id)` returns an `<img>` with no `src`, no
 *     `loading` attribute and `data-l="0"`, and still carries the three hooks
 *     the rest of the app reads (`data-id`, `onload`, `onerror`) plus the tilt
 *     layer's `data-q`. This is the check that fails on the build before the
 *     item, where the `src` and the native `loading="lazy"` were in the markup.
 *  2. ONE OBSERVER. The whole app creates exactly one `IntersectionObserver`,
 *     with the app's own margin — not one per card, and not the WebView's
 *     distance. A feed render must not add a second.
 *  3. ARMED, NOT ASKED FOR. After a 24-card boot every thumbnail is observed
 *     and none has a `src`: nothing has been requested yet.
 *  4. LATE, NOT NEVER. Deliver an intersection for the first three cards and
 *     exactly those three get their maxres URL, flip to `data-l="1"` and are
 *     unobserved; the other twenty-one are untouched.
 *  5. ONCE. A stale intersection delivered for a card that already has its
 *     picture changes nothing and requests nothing twice.
 *  6. THE REST ARRIVES. Intersect the remaining cards: all twenty-four end up
 *     with their maxres URL and the observer holds nothing, so no scroll
 *     afterwards costs it any work.
 *  7. RELEASED. Re-render the feed and the observer holds the new cards only:
 *     every target is still connected, and the armed count is one feed, not two.
 *     A detached card is never kept alive by the observer.
 *  8. FALLS BACK. With `IntersectionObserver` deleted before the app's script
 *     runs, every card is armed at render and the app boots anyway — an old
 *     WebView gets exactly the build it had before this item.
 *  9. THE PICTURE ITSELF. `THOK` still swaps a 120 px `maxresdefault` to
 *     `hqdefault`, and `TH` still hides a card whose picture failed twice, so
 *     deferring the fetch did not break what ends up on screen.
 *
 * Runs in jsdom with googleapis answered from fixtures — no network, no
 * Chromium, no device — on the same harness as tools/selfcheck-boot-check.js.
 * Intersection is delivered by the tool, not by a layout engine, so every one of
 * the nine is a statement about the app's own code.
 *
 *   npm i jsdom
 *   node tools/lazy-thumb-check.js app/assets/index.html
 *   node tools/lazy-thumb-check.js app/assets/index.html /tmp/old/index.html
 *
 * With a second file it also boots that build and diffs what the user can see —
 * every card's tree with this item's own attributes taken out — and fails if a
 * node, a class or a line of text moved. That is the "the UI does not change"
 * half of the rule.
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

/* A page: fresh window, fresh storage, a fetch answered from the fixtures, and —
   unless `noIO` — an IntersectionObserver the tool drives. The stub records what
   it is told to watch and delivers nothing on its own, which is exactly what a
   test needs: the tool decides who comes into view. */
function open(file, opts = {}) {
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
      if (!opts.noIO) {
        w.IntersectionObserver = class {
          constructor(cb, o) { this.cb = cb; this.opts = o || {}; this.targets = new Set(); env.ios.push(this); }
          observe(t) { this.targets.add(t); }
          unobserve(t) { this.targets.delete(t); }
          disconnect() { this.targets.clear(); }
          takeRecords() { return []; }
        };
      }
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
let HAS_IO = false;   /* whether the build under test created the observer at all */
const ok = (name, cond, detail) => {
  if (!cond) fails++;
  console.log((cond ? 'ok   ' : 'FAIL ') + name + (detail === undefined ? '' : '  [' + detail + ']'));
};

const cardsOf = env => [...env.d.querySelectorAll('#feed .card')];
const imgsOf = env => [...env.d.querySelectorAll('#feed .card .thumb img')];
const thumbsOf = env => [...env.d.querySelectorAll('img[data-l]')];
const census = env => (env.w.__ltThumbs ? env.w.__ltThumbs() : null);
/* What the user can see, with this item's own attributes taken out. */
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

async function boot(file, opts) {
  const env = open(file, opts);
  const seen = await waitFor(() => env.w.__ltTimeline && env.lines.some(l => l.indexOf('lt-startup') === 0));
  ok('boot reached its timeline', seen);
  ok('the feed rendered 24 cards', await waitFor(() => cardsOf(env).length === 24), String(cardsOf(env).length));
  await sleep(150);
  return env;
}

(async () => {
  /* ---- 1. born unarmed, hooks intact ---- */
  {
    const env = await boot(FILE);
    const m = env.w.eval("thumbImg('abc')");
    ok('markup: no src at birth', !/\ssrc=/.test(m), m);
    ok('markup: no native loading=lazy', !/loading=/.test(m), m);
    ok('markup: the armed state is data-l="0"', /data-l="0"/.test(m), m);
    ok('markup: fallback hooks kept', /data-id="abc"/.test(m) && /onload="THOK\(this\)"/.test(m) && /onerror="TH\(this\)"/.test(m));
    ok('markup: tilt hook kept', /data-q="0"/.test(m));

    /* ---- 2. one observer, the app's margin ---- */
    ok('observer: exactly one is created', env.ios.length === 1, String(env.ios.length));
    const io = env.ios[0];
    HAS_IO = env.ios.length === 1;
    ok("observer: the distance is the app's own", io && io.opts.rootMargin === '800px 0px', io && io.opts.rootMargin);

    /* ---- 3. armed, not asked for ---- */
    const all = thumbsOf(env);
    const tgt = io ? io.targets.size : 0;
    ok('boot: every thumbnail is in a card and observed',
      all.length === 30 && tgt === all.length && all.every(i => i.closest('.card')),
      tgt + '/' + all.length);
    ok('boot: the feed and the dormant shelf are both covered',
      imgsOf(env).length === 24 && all.length - imgsOf(env).length === 6,
      imgsOf(env).length + ' + ' + (all.length - imgsOf(env).length));
    ok('boot: no thumbnail has a src', all.every(i => i.getAttribute('src') === null),
      all.filter(i => i.getAttribute('src') !== null).length + ' with src');
    ok('boot: every thumbnail is armed', all.every(i => i.dataset.l === '0'));
    ok('boot: the census agrees', census(env) && census(env).live === all.length, JSON.stringify(census(env)));
    ok('boot: one render did not create a second observer', env.ios.length === 1, String(env.ios.length));
    env.dom.window.close();
  }

  if (!HAS_IO) {
    /* a build with no observer cannot answer any of the next three claims;
       say so once instead of throwing on the first one */
    ok('late / once / released: needs the observer this build does not have', false);
  } else {
    /* ---- 4-6. late, once, and then never again ---- */
    {
      const env = await boot(FILE);
      const io = env.ios[0];
      const all = thumbsOf(env);
      const feed = imgsOf(env);

      const first3 = feed.slice(0, 3);
      io.cb(first3.map(t => ({ target: t, isIntersecting: true })), io);
      ok('near: the three that came into view have their maxres',
        first3.every(i => i.getAttribute('src') === 'https://i.ytimg.com/vi/' + i.dataset.id + '/maxresdefault.jpg'),
        first3.map(i => i.getAttribute('src')).join(' '));
      ok('near: they are marked asked for', first3.every(i => i.dataset.l === '1'));
      ok('near: they are unobserved, so a scroll costs them nothing', first3.every(i => !io.targets.has(i)));
      ok('near: nothing else was asked for',
        all.filter(i => first3.indexOf(i) < 0).every(i => i.getAttribute('src') === null && io.targets.has(i)),
        all.filter(i => i.getAttribute('src') !== null).length + ' asked');
      ok('near: the census counts the waiters only', census(env).live === all.length - 3, JSON.stringify(census(env)));

      io.cb([{ target: first3[0], isIntersecting: true }], io);
      ok('again: a stale intersection changes nothing',
        first3[0].getAttribute('src') === 'https://i.ytimg.com/vi/' + first3[0].dataset.id + '/maxresdefault.jpg' &&
        census(env).live === all.length - 3, JSON.stringify(census(env)));

      io.cb([...io.targets].map(t => ({ target: t, isIntersecting: true })), io);
      ok('all: every card has its maxres',
        all.every(i => i.getAttribute('src') === 'https://i.ytimg.com/vi/' + i.dataset.id + '/maxresdefault.jpg'),
        all.filter(i => i.getAttribute('src') === null).length + ' without');
      ok('all: the observer holds nothing', io.targets.size === 0, String(io.targets.size));
      ok('all: nothing is left armed', census(env).live === 0, JSON.stringify(census(env)));
      ok('all: an out-of-view entry is ignored', (() => {
        const img = imgsOf(env)[5];
        const before = img.getAttribute('src');
        io.cb([{ target: img, isIntersecting: false }], io);
        return img.getAttribute('src') === before;
      })());
      env.dom.window.close();
    }

    /* ---- 7. a replaced feed is released ---- */
    {
      const env = await boot(FILE);
      const io = env.ios[0];
      const before = thumbsOf(env);
      const armedBefore = census(env).live;
      env.w.eval('loadTrending()');
      await waitFor(() => imgsOf(env).length === 24 && imgsOf(env)[0] !== before[0]);
      await sleep(250);
      const after = thumbsOf(env);
      ok('re-render: the new feed is observed', after.length === 30 && io.targets.size === 30, io.targets.size + '/' + after.length);
      ok('re-render: every target is still in the document', [...io.targets].every(t => t.isConnected),
        [...io.targets].filter(t => !t.isConnected).length + ' detached');
      ok('re-render: one feed is armed, not two', census(env).live === armedBefore, census(env).live + ' vs ' + armedBefore);
      ok('re-render: the detached feed is not still watched',
        before.filter(i => !i.isConnected && io.targets.has(i)).length === 0,
        before.filter(i => !i.isConnected).length + ' detached');
      env.dom.window.close();
    }
  }

  /* ---- 8. the fallback an old WebView gets ---- */
  {
    const env = await boot(FILE, { noIO: true });
    const oi = thumbsOf(env);
    ok('no IntersectionObserver: none is created', env.ios.length === 0 && !!census(env) && census(env).io === false, JSON.stringify(census(env)));
    ok('no IntersectionObserver: every card is asked for at render',
      oi.length === 30 && oi.every(i => i.getAttribute('src') === 'https://i.ytimg.com/vi/' + i.dataset.id + '/maxresdefault.jpg'),
      oi.filter(i => i.getAttribute('src')).length + '/' + oi.length);
    ok('no IntersectionObserver: the app still boots clean', env.errors.length === 0, env.errors.join(' '));
    env.dom.window.close();
  }

  /* ---- 9. the picture itself ---- */
  {
    const env = await boot(FILE);
    const img = imgsOf(env)[0];
    const fire = env.w.eval("typeof thumbFire === 'function'");
    if (fire) env.w.eval("thumbFire(document.querySelector('#feed .card .thumb img'))");
    ok('fallback: an armed card is asked for by hand too',
      fire && /maxresdefault\.jpg$/.test(img.getAttribute('src')), fire ? img.getAttribute('src') : 'no thumbFire');
    Object.defineProperty(img, 'naturalWidth', { value: 121, configurable: true });
    env.w.THOK(img);
    ok('fallback: a 120 px maxres swaps to hqdefault', /\/hqdefault\.jpg$/.test(img.getAttribute('src')), img.getAttribute('src'));
    Object.defineProperty(img, 'naturalWidth', { value: 120, configurable: true });
    env.w.TH(img);   /* first failure: swap to hqdefault */
    env.w.TH(img);   /* second failure: tidy card, never a broken icon */
    ok('fallback: a twice-failed picture is hidden, not left broken',
      img.style.display === 'none' && /linear-gradient/.test(img.parentElement.style.background),
      img.style.display + ' ' + img.parentElement.style.background);
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
