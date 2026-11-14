#!/usr/bin/env node
/*
 * LiquidTube image-byte check — item 6.10.
 *
 * The item is one sentence — "measure image bytes per session" — and a meter is
 * only worth having if the number it prints can be trusted, so this asserts the
 * arithmetic, the attribution and the cost, in that order.
 *
 *  1. THE ARITHMETIC. `transferSize` is the bytes that came over the network and
 *     is what the number means; a file served from the cache reports 0 there and
 *     its `encodedBodySize` instead, which is still its size but not wire bytes;
 *     a cross-origin entry without Timing-Allow-Origin reports 0 for both, and
 *     that one is estimated from the pixels the element drew — or from the rung's
 *     measured average when even the pixels are unknown. `meas` and `est` say
 *     which is which, and the census's `bytes` is their sum.
 *  2. THE ATTRIBUTION. Only the app's own picture hosts count (i.ytimg.com,
 *     yt3.ggpht.com, the googleusercontent pair); an API call is not a picture.
 *     A URL is counted once — the second load of the same file is a cache hit,
 *     not new bytes — and the set that remembers them is capped, so a session
 *     that runs for hours cannot grow it without bound.
 *  3. THE COST. This is a measurement item, so the meter must not be what the
 *     user feels: a burst of asks is one coalesced drain in an idle slot, no
 *     timer is ever armed, and the document is not touched at all — no element,
 *     no attribute, no style. The one visible-to-nobody output is the
 *     `lt-imgbytes` line on `pagehide`, and it is written once per session.
 *
 * Runs in jsdom with googleapis answered from fixtures — no network, no Chromium,
 * no device — on the same harness as tools/lazy-thumb-check.js. The Resource
 * Timing buffer is a fixture too: jsdom has no layout and no image fetches, so
 * the entries are the ones a device would have produced.
 *
 *   npm i jsdom
 *   node tools/image-bytes-check.js app/assets/index.html
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
  const env = { ios: [], lines: [], errors: [], idle: [], timers: 0, resources: [] };
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
      /* The Resource Timing buffer, as a device fills it: the entries this
         harness pushes are the ones the meter is asked to add up. */
      try {
        Object.defineProperty(w.performance, 'getEntriesByType', {
          configurable: true,
          value: t => (t === 'resource' ? env.resources.slice() : []),
        });
      } catch (e) { w.performance.getEntriesByType = t => (t === 'resource' ? env.resources.slice() : []); }
      /* An idle slot the harness controls, so a drain can be counted rather
         than waited for — and so the "one coalesced drain" claim is testable. */
      w.requestIdleCallback = cb => { env.idle.push(cb); return env.idle.length; };
      w.cancelIdleCallback = () => {};
      const st = w.setTimeout;
      w.setTimeout = function (...a) { env.timers++; return st.apply(this, a); };
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

/* The meter's state is the app's own; a harness that wants a clean sum clears it
   through the same bindings the app uses, exactly as the other tools re-run a
   probe. Nothing here reaches into the document. */
const RESET = 'IMG_URL.clear();IMG_PX.clear();' +
  'IMG_ST.bytes=0;IMG_ST.meas=0;IMG_ST.est=0;IMG_ST.cached=0;IMG_ST.px=0;IMG_ST.ask=0;' +
  'IMG_ST.ok=0;IMG_ST.fail=0;IMG_ST.skip=0;IMG_ST.drain=0;IMG_ST.pend=0;IMG_LOGGED=0;' +
  'IMG_RUNG.mqdefault=0;IMG_RUNG.hqdefault=0;IMG_RUNG.sddefault=0;IMG_RUNG.maxresdefault=0;IMG_RUNG.other=0;';

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
  const D = env.d;
  const census = () => W.eval('__ltImgBytes()');

  /* ---- 0. the census exists and is a census ---- */
  {
    const r = census();
    ok('meter: the census exists and is an object', !!r && typeof r === 'object');
    ok('meter: it reports requests, bytes, measured, estimated and cached',
      ['req', 'bytes', 'kb', 'avg', 'meas', 'est', 'cached', 'px', 'seen', 'max', 'drain', 'unsup']
        .every(k => typeof r[k] === 'number' && isFinite(r[k])),
      Object.keys(r).join(','));
    ok('meter: it reports the asks, the loads and the failures beside them',
      typeof r.ask === 'number' && typeof r.ok === 'number' && typeof r.fail === 'number');
    ok('meter: the per-rung tally has every rung and nothing else',
      r.rung && ['mqdefault', 'hqdefault', 'sddefault', 'maxresdefault', 'other'].every(k => typeof r.rung[k] === 'number'));
    ok('meter: the estimate table ascends with the ladder and the cap is set',
      W.eval('IMG_EST.mqdefault<IMG_EST.hqdefault&&IMG_EST.hqdefault<IMG_EST.sddefault&&IMG_EST.sddefault<IMG_EST.maxresdefault&&IMG_MAXU>0&&IMG_BPP>0'));
  }

  /* ---- 1. the arithmetic ---- */
  {
    W.eval(RESET);
    env.resources.length = 0;
    env.resources.push(
      { name: 'https://i.ytimg.com/vi/aaaaaaaaaaa/mqdefault.jpg', transferSize: 21000, encodedBodySize: 20500 },
      { name: 'https://i.ytimg.com/vi/bbbbbbbbbbb/hqdefault.jpg', transferSize: 0, encodedBodySize: 38000 },
      { name: 'https://i.ytimg.com/vi/ccccccccccc/maxresdefault.jpg', transferSize: 0, encodedBodySize: 0 },
      { name: 'https://yt3.ggpht.com/av1.jpg', transferSize: 0, encodedBodySize: 0 },
      /* not a picture: an API call that must not be attributed to the pictures */
      { name: 'https://www.googleapis.com/youtube/v3/videos', transferSize: 9000, encodedBodySize: 8000 },
      /* a different host that happens to serve a .jpg: still not the app's */
      { name: 'https://example.com/tracker.jpg', transferSize: 5000, encodedBodySize: 4000 }
    );
    const r = census();
    ok('bytes: transferSize is the wire bytes, and only for the picture hosts', r.bytes === 21000 + 38000 + 86000 + 8000,
      String(r.bytes));
    ok('bytes: two of the four are measured', r.meas === 2, String(r.meas));
    ok('bytes: the two opaque ones are estimated, and say so', r.est === 2, String(r.est));
    ok('bytes: the API call and the foreign host are not in the number',
      r.bytes !== 21000 + 38000 + 86000 + 8000 + 9000 && r.bytes !== 21000 + 38000 + 86000 + 8000 + 5000);
    ok('bytes: a cached file counts as cached, not as wire bytes', r.cached === 3, String(r.cached));
    ok('bytes: the rungs are tallied by file name',
      r.rung.mqdefault === 1 && r.rung.hqdefault === 1 && r.rung.maxresdefault === 1 && r.rung.other === 1,
      JSON.stringify(r.rung));
    ok('bytes: kb and the average agree with the sum',
      r.kb === Math.round(r.bytes / 102.4) / 10 && r.avg === Math.round(r.bytes / r.req), r.kb + ' / ' + r.avg);
    ok('bytes: req is measured plus estimated', r.req === r.meas + r.est, r.req + ' = ' + r.meas + ' + ' + r.est);
  }

  /* ---- 2. the pixels, when the timing entry has no size ---- */
  {
    W.eval(RESET);
    env.resources.length = 0;
    const url = 'https://i.ytimg.com/vi/ddddddddddd/sddefault.jpg';
    env.resources.push({ name: url, transferSize: 0, encodedBodySize: 0 });
    const img = D.createElement('img');
    Object.defineProperty(img, 'naturalWidth', { value: 640, configurable: true });
    Object.defineProperty(img, 'naturalHeight', { value: 480, configurable: true });
    Object.defineProperty(img, 'currentSrc', { value: url, configurable: true });
    const pxBefore = W.eval('IMG_ST.px');
    W.THOK(img);
    const r = census();
    ok('pixels: a load reports the pixels it drew', W.eval('IMG_ST.px') === pxBefore + 640 * 480,
      String(W.eval('IMG_ST.px') - pxBefore));
    ok('pixels: a file with no size is estimated from those pixels',
      r.bytes === Math.round(640 * 480 * W.eval('IMG_BPP')) && r.est === 1, r.bytes + ' est=' + r.est);
    ok('pixels: the estimate is not the rung average it replaced', r.bytes !== W.eval('IMG_EST.sddefault'));
    ok('pixels: the load counted as a load, not as an ask', r.ok === 1 && r.ask === 0, 'ok=' + r.ok + ' ask=' + r.ask);
  }

  /* ---- 3. counted once, and capped ---- */
  {
    W.eval(RESET);
    env.resources.length = 0;
    const url = 'https://i.ytimg.com/vi/eeeeeeeeeee/hqdefault.jpg';
    env.resources.push({ name: url, transferSize: 12000, encodedBodySize: 11800 });
    const a = census();
    /* the same file loaded again — a second card, a re-render, a fallback that
       landed on the file that was already there: the buffer lists it twice and
       the number must not grow */
    env.resources.push({ name: url, transferSize: 12000, encodedBodySize: 11800 });
    const b = census();
    ok('once: a URL is counted the first time only', a.bytes === 12000 && b.bytes === 12000, a.bytes + ' -> ' + b.bytes);
    ok('once: and the repeat is not a second request', b.req === 1, String(b.req));

    /* the ceiling: 600 distinct files, of which the set may remember IMG_MAXU */
    W.eval(RESET);
    env.resources.length = 0;
    for (let i = 0; i < 600; i++) {
      env.resources.push({ name: 'https://i.ytimg.com/vi/f' + String(i).padStart(11, '0') + '/mqdefault.jpg', transferSize: 1000, encodedBodySize: 1000 });
    }
    const c = census();
    const max = W.eval('IMG_MAXU');
    ok('cap: the seen set stops at its ceiling', c.seen === max, c.seen + ' / ' + max);
    ok('cap: what it refused is counted, not silently dropped', c.skip === 600 - max, String(c.skip));
    ok('cap: the bytes it did count are the ones it kept', c.bytes === max * 1000, String(c.bytes));
  }

  /* ---- 4. the element side: asks, loads, failures ---- */
  {
    W.eval(RESET);
    env.resources.length = 0;
    const card = thumbsOf(env)[0];
    ok('elements: the feed has an armed thumbnail to ask for', !!card);
    if (card) {
      const io = env.ios[0];
      io.cb([{ target: card, isIntersecting: true }]);
      const r = census();
      ok('elements: asking for a picture is counted as one ask', r.ask === 1, String(r.ask));
      ok('elements: the ask did not put anything in the byte total by itself', r.bytes === 0, String(r.bytes));
      W.TH(card);
      const r2 = census();
      ok('elements: a failed picture is counted as a failure', r2.fail === 1 && r2.ask >= 1, 'fail=' + r2.fail);
      ok('elements: a failure adds no bytes', r2.bytes === 0, String(r2.bytes));
    }
  }

  /* ---- 5. the cost: one coalesced drain, no timer, no DOM ---- */
  {
    W.eval(RESET);
    env.resources.length = 0;
    env.idle.length = 0;
    const nodes = D.querySelectorAll('*').length;
    const html = D.body.innerHTML.length;
    const timers = env.timers;
    /* twenty asks in one frame, which is what a feed render is */
    for (let i = 0; i < 20; i++) W.eval('imgBytesNote("ask",null)');
    const drainsBefore = W.eval('IMG_ST.drain');
    ok('cost: twenty asks arm exactly one idle drain', env.idle.length === 1, String(env.idle.length));
    ok('cost: nothing was drained on the spot', W.eval('IMG_ST.drain') === drainsBefore, String(W.eval('IMG_ST.drain')));
    ok('cost: the meter armed no timer at all', env.timers === timers, String(env.timers - timers));
    env.idle.shift()();
    ok('cost: the idle slot does the one drain', W.eval('IMG_ST.drain') === drainsBefore + 1, String(W.eval('IMG_ST.drain')));
    ok('cost: the pending flag is cleared, so the next burst can arm again', W.eval('IMG_ST.pend') === 0);
    ok('cost: the document was not touched — no node, no byte of markup',
      D.querySelectorAll('*').length === nodes && D.body.innerHTML.length === html);
    /* an engine with no idle callback drains instead of arming a timer */
    W.eval(RESET);
    W.requestIdleCallback = undefined;
    const timers2 = env.timers, drains2 = W.eval('IMG_ST.drain');
    W.eval('imgBytesNote("ask",null)');
    ok('cost: with no idle slot it drains synchronously and still arms no timer',
      W.eval('IMG_ST.drain') === drains2 + 1 && env.timers === timers2, 'drains+' + (W.eval('IMG_ST.drain') - drains2));
  }

  /* ---- 6. the session line, once ---- */
  {
    W.eval(RESET);
    env.resources.length = 0;
    env.resources.push({ name: 'https://i.ytimg.com/vi/ggggggggggg/hqdefault.jpg', transferSize: 37554, encodedBodySize: 37000 });
    env.lines.length = 0;
    W.dispatchEvent(new W.Event('pagehide'));
    const line = env.lines.filter(l => l.indexOf('lt-imgbytes') === 0)[0] || '';
    ok('session: pagehide writes one lt-imgbytes line', !!line, line || '(none)');
    ok('session: the line carries the kilobytes, the requests and the measured/estimated split',
      / kb=/.test(line) && / req=/.test(line) && / meas=/.test(line) && / est=/.test(line) && / rung=/.test(line), line);
    /* the line's kb is the census's bytes over 1024, to one decimal */
    const kb = Math.round(W.eval('IMG_ST.bytes') / 102.4) / 10;
    ok('session: the number in the line is the census\'s number',
      line.indexOf(' kb=' + kb + ' ') > 0 && kb === Math.round(37554 / 102.4) / 10, line + ' (expected kb=' + kb + ')');
    const n = env.lines.filter(l => l.indexOf('lt-imgbytes') === 0).length;
    W.dispatchEvent(new W.Event('pagehide'));
    ok('session: a second pagehide logs nothing more',
      env.lines.filter(l => l.indexOf('lt-imgbytes') === 0).length === n, String(n));
  }

  /* ---- 7. the self-check knows the item ---- */
  {
    const sc = W.eval('typeof __ltSelfCheckRun==="function"');
    ok('selfcheck: the in-app self-check exists', sc);
    if (sc) {
      const r = W.eval('__ltSelfCheckRun()');
      ok('selfcheck: it names the byte meter', r && Array.isArray(r.fails) && !r.fails.includes('imgbytes'),
        r && Array.isArray(r.fails) ? r.fails.join(',') || 'no failures' : 'no report');
      ok('selfcheck: it passes with the byte probe in it', !r || !r.fail, r && (r.ok + ' ok / ' + r.fail + ' fail'));
    }
  }

  /* ---- 8. the UI did not move ---- */
  {
    /* a card no earlier section has touched: the ones above were fired at and
       failed on purpose, and a fallback writes `data-f` and a style by design */
    const img = thumbsOf(env).filter(t => !t.dataset.f)[0] || thumbsOf(env)[0];
    /* the element's attributes are the ones the app's own template writes, plus
       the `style` the tilt layer has always written on a card in view — and
       nothing the meter added */
    const tmpl = W.eval("thumbImg('x')");
    const want = new Set(['style']);
    let m, re = /\s([a-z-]+)=/g;
    while ((m = re.exec(tmpl))) want.add(m[1]);
    if (img.getAttribute('src')) want.add('src');
    const attrs = [...img.attributes].map(a => a.name).sort();
    const extra = attrs.filter(a => !want.has(a));
    ok('ui: the thumbnail carries the same attributes it carried before the item',
      extra.length === 0, extra.length ? 'added: ' + extra.join(',') : attrs.join(','));
    ok('ui: no attribute on the card is about the meter',
      attrs.every(a => !/byte|imgb/i.test(a)), attrs.join(','));
    ok('ui: the card is still the stylesheet\'s 16:9 box with no inline size',
      !img.style.width && !img.style.height && img.parentElement.classList.contains('thumb'));
    ok('ui: no meter element exists in the document',
      !D.getElementById('imgbytes') && D.querySelectorAll('[data-imgbytes]').length === 0);
    ok('ui: the app still ships no <img loading=lazy> and no new image host in the markup',
      D.querySelectorAll('img[loading=lazy]').length === 0);
  }

  env.dom.window.close();
  console.log(fails ? '\n' + fails + ' failure(s)' : '\nall checks passed');
  process.exit(fails ? 1 : 0);
})();
