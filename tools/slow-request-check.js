#!/usr/bin/env node
/*
 * LiquidTube slow-request log check — proves item 2.10: a request slower than
 * 800 ms writes exactly one line naming its endpoint, the line is bounded and
 * carries no request parameters, and nothing a user can see changes.
 *
 * Four parts, none of them needing a device or a real browser:
 *
 *  1. The threshold, driven against a mocked wire: a page whose every request
 *     takes 900 ms logs every one of them; a page whose requests take 40 ms logs
 *     nothing. The boundary itself (800 = silent, 801 = logged) is checked by
 *     calling rqSlow() directly, which is the only way to hit it exactly.
 *  2. What a line says: the endpoint, and the two `videos` calls told apart; the
 *     attempt number and the status; err=net for a fetch that never answered and
 *     err=abort for a request whose page was left; no parameter, no query, no
 *     API key anywhere in the line; the `lt-` prefix MainActivity forwards.
 *  3. Bounds and bookkeeping: the line count is capped, the counter keeps
 *     counting past the cap, the per-endpoint table is capped, the worst
 *     offender is remembered, and a cache hit or a joined in-flight call adds
 *     nothing.
 *  4. Nothing visible changed: the app booted side by side with the previous
 *     build must render byte-identical markup, send the same requests, keep the
 *     same storage keys and log no error — plus the cost of the timing itself.
 *
 *   npm i jsdom
 *   node tools/slow-request-check.js app/assets/index.html /tmp/old/index.html
 *
 * argv[2] is the build under test, argv[3] the previous build to compare
 * against (optional; the A/B half is skipped without it).
 */
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const NEW_FILE = process.argv[2] || path.join(__dirname, '..', 'app/assets/index.html');
const OLD_FILE = process.argv[3] || '';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const pad = n => String(n).padStart(2, '0');
const vids = Array.from({ length: 24 }, (_, i) => 'v' + pad(i + 1) + 'AAAAAAAA');
const CH_IDS = Array.from({ length: 6 }, (_, i) => 'UC' + i + 'xxxxxxxxxxxxxxxxxxxx');
const pub = d => new Date(Date.UTC(2026, 9, 31) - d * 864e5).toISOString();

const F = {
  videos: {
    items: vids.map((id, i) => ({
      id,
      snippet: {
        title: 'Sample trending video number ' + (i + 1) + ' with a realistic title',
        channelTitle: 'Channel ' + (i % 6),
        channelId: CH_IDS[i % 6],
        publishedAt: pub(i + 1),
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
      snippet: {
        title: 'Channel ' + i,
        customUrl: 'channel' + i,
        publishedAt: '2015-04-02T10:00:00Z',
        country: ['IN', 'US', 'JP', 'DE', 'BR', 'FR'][i],
        description: 'A sample channel &amp; its "quoted" description.',
        thumbnails: { medium: { url: 'https://yt3.ggpht.com/av' + i + '.jpg' } },
      },
      statistics: { subscriberCount: '1200000', videoCount: '480', viewCount: '91000000' },
      contentDetails: { relatedPlaylists: { uploads: 'UU' + i + 'xxxxxxxxxxxxxxxxxxxx' } },
      brandingSettings: { image: { bannerExternalUrl: '' }, channel: {} },
    })),
  },
  playlistItems: {
    items: vids.slice(0, 12).map((id, i) => ({
      snippet: { title: 'Playlist item ' + i, resourceId: { videoId: id }, publishedAt: pub(i * 24) },
      contentDetails: { videoPublishedAt: pub(i * 24) },
    })),
  },
  search: {
    items: vids.slice(0, 20).map((id, i) => ({
      id: { videoId: id },
      snippet: {
        title: 'Search result ' + i + ' &amp; more',
        channelTitle: 'Channel ' + (i % 6),
        channelId: CH_IDS[i % 6],
        publishedAt: pub(i * 24),
      },
    })),
  },
};

/* The API answers a `channels` call with the ids it was asked for, and with an
   empty `items` for an id it does not know — a mock that always answers with
   its whole list would hand back a different channel than the one asked for. */
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
  const u = new URL(url), p = u.pathname;
  if (p.endsWith('/videos')) return (u.searchParams.get('part') || '').includes('contentDetails') ? F.durations : F.videos;
  if (p.endsWith('/channels')) return chanAnswer(u, F.channels);
  if (p.endsWith('/playlistItems')) return F.playlistItems;
  if (p.endsWith('/search')) return F.search;
  return {};
}
function open(file, opts = {}) {
  const HTML = fs.readFileSync(file, 'utf8');
  const reqs = [], logs = [], errs = [];
  const env = { reqs, logs, errs, w: null, d: null, dom: null };
  const latency = opts.latency === undefined ? 40 : opts.latency;
  let fail = opts.fail || null;
  env.setFail = f => { fail = f; };

  const mockFetch = (u, o) => {
    const rec = { url: String(u).replace(/([?&])key=[^&]*/, '$1key=<key>'), aborted: false };
    reqs.push(rec);
    const sig = o && o.signal;
    const f = fail; fail = null;                       /* one-shot, like a real flaky hop */
    return new Promise((res, rej) => {
      let t = null;
      const onAbort = () => {
        clearTimeout(t);
        rec.aborted = true;
        const e = new Error('The operation was aborted.');
        e.name = 'AbortError';
        rej(e);
      };
      if (sig && sig.aborted) { onAbort(); return; }
      if (sig) sig.addEventListener('abort', onAbort);
      t = setTimeout(() => {
        if (sig) sig.removeEventListener('abort', onAbort);
        if (f === 'throw') { rej(new Error('network down')); return; }
        if (f === 'error') {
          res({ ok: false, status: 500, headers: { get: () => '' }, json: async () => ({ error: { message: 'Backend Error' } }) });
          return;
        }
        if (f === 'quota') {
          res({ ok: false, status: 403, headers: { get: () => '' }, json: async () => ({ error: { code: 403, message: 'The request cannot be completed because you have exceeded your quota.' } }) });
          return;
        }
        res({ ok: true, status: 200, headers: { get: () => '' }, json: async () => apiBody(String(u)) });
      }, latency);
    });
  };
  globalThis.fetch = mockFetch;

  const vc = new VirtualConsole();
  vc.on('log', (...a) => logs.push(a.join(' ')));
  vc.on('warn', (...a) => logs.push(a.join(' ')));
  vc.on('error', (...a) => errs.push(a.join(' ')));
  vc.on('jsdomError', e => { if (!/WebAssembly|Cannot allocate/i.test(String(e && e.message))) errs.push(String(e && e.message)); });

  const dom = new JSDOM(HTML, {
    url: 'https://liquidtube.local/index.html',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(w) {
      w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
      w.fetch = mockFetch;
      w.scrollTo = () => {};
      if (opts.seed) {
        try { Object.keys(opts.seed).forEach(k => w.localStorage.setItem(k, opts.seed[k])); } catch (e) { env.seedErr = e; }
      }
      w.addEventListener('error', e => errs.push(String((e && e.message) || e)));
    },
  });
  env.w = dom.window;
  env.d = dom.window.document;
  env.dom = dom;
  PAGES.push(dom);                 /* closed once, at the end: a close mid-run trips the boot's own timers */
  env.dump = () => {
    const o = {};
    for (let i = 0; i < dom.window.localStorage.length; i++) {
      const k = dom.window.localStorage.key(i);
      o[k] = dom.window.localStorage.getItem(k);
    }
    return o;
  };
  return env;
}

/* jsdom on this pod cannot instantiate undici's llhttp wasm (real fetch is
   unusable here), and something inside jsdom still reaches for it once the page
   has settled. It has nothing to do with the app; ignore exactly that error. */
const ignorable = e => /WebAssembly|Cannot allocate/i.test(String((e && e.message) || ''));
process.on('uncaughtException', e => { if (!ignorable(e)) { console.error('uncaught', e); process.exit(1); } });
process.on('unhandledRejection', e => { if (!ignorable(e)) { console.error('unhandled', e); process.exit(1); } });

async function waitFor(fn, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(20); }
  return false;
}

/* markup that depends on when a frame ran, not on what was rendered */
function norm(h) {
  return String(h)
    .replace(/ class="ld"/g, '').replace(/ ld"/g, '"')
    .replace(/ data-f="1"/g, '')
    .replace(/ ?(?:transform|opacity|background-position-y):[^;"']*;?/g, '')
    .replace(/style="\s*"/g, '').replace(/\s{2,}/g, ' ').trim();
}
const snap = (env, sel) => norm((env.d.querySelector(sel) || {}).innerHTML || '');

const PAGES = [];
const R = [];
const ok = (name, pass, detail) => R.push({ name, pass: !!pass, detail: detail === undefined ? '' : String(detail) });
const localDay = (t = Date.now()) => { const d = new Date(t); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
const dayAgo = n => localDay(Date.now() - n * 864e5);

const settled = async env => {
  await waitFor(() => env.d.querySelectorAll('#feed .card').length > 0);
  await waitFor(() => env.w.__ltReqCache && env.w.__ltReqCache().fly === 0);
  await sleep(150);
};
/* ---------- what the page wrote ---------- */
const slowLines = env => env.logs.filter(l => l.indexOf('lt-slow ') === 0);
const parse = line => {
  const o = {};
  String(line).replace(/^lt-slow /, '').split(' ').forEach(p => {
    const i = p.indexOf('=');
    if (i > 0) o[p.slice(0, i)] = p.slice(i + 1);
  });
  return o;
};
/* rqSlow and rqAbandon are function declarations at the top level of the page's
   classic script, so they are properties of the window; the fallback is for an
   engine that scopes them differently. */
const call = (w, fn, ...args) =>
  (typeof w[fn] === 'function'
    ? w[fn](...args)
    : w.eval(fn + '(' + args.map(a => JSON.stringify(a)).join(',') + ')'));

const SHAPE = /^lt-slow ep=[A-Za-z.]+ ms=\d+ attempt=\d+ status=\d+( err=[a-z]+)? n=\d+$/;

/* ---------- 1. the threshold against a mocked wire ---------- */
async function wireTests(file) {
  // a slow wire: every request crosses the threshold
  const slow = open(file, { latency: 900 });
  await settled(slow);
  const L = slowLines(slow).map(parse);
  const s = slow.w.__ltSlow();
  ok('a 900 ms wire writes one line per request', L.length === slow.reqs.length,
    L.length + ' lines, ' + slow.reqs.length + ' requests');
  ok('every line names an endpoint', L.every(l => l.ep && l.ep.length > 0), L.map(l => l.ep).join(','));
  ok('every line carries the duration it actually took',
    L.every(l => +l.ms > 800 && +l.ms < 3000), L.map(l => l.ms).join(','));
  ok('every line is the documented shape, one line each',
    L.every(l => SHAPE.test('lt-slow ' + Object.keys(l).map(k => k + '=' + l[k]).join(' '))),
    slowLines(slow)[0] || '(none)');
  ok('the counter agrees with the lines written', s.count === L.length && s.lines === L.length,
    s.count + ' counted, ' + s.lines + ' lines');
  ok('the threshold reported is the item’s 800 ms', s.threshold === 800, s.threshold);
  ok('the two `videos` calls are told apart (chart vs durations)',
    L.some(l => l.ep === 'videos.chart') && L.some(l => l.ep === 'videos.dur'),
    [...new Set(L.map(l => l.ep))].join(','));
  const key = slow.w.eval('APIKEY');
  ok('no line carries a parameter, a query or the API key',
    slowLines(slow).every(l => l.indexOf('key=') < 0 && l.indexOf('&') < 0 && l.indexOf('?') < 0 &&
      l.indexOf(key) < 0), 'key ' + key.length + ' chars, never in a line');
  ok('the line keeps the `lt-` prefix MainActivity forwards to logcat',
    slowLines(slow).every(l => l.indexOf('lt-') === 0), slowLines(slow)[0] || '(none)');
  ok('the slow page still rendered its feed', slow.d.querySelectorAll('#feed .card').length > 0,
    slow.d.querySelectorAll('#feed .card').length + ' cards');
  ok('a slow boot logs no error', slow.errs.length === 0, slow.errs.join(' | '));

  // a fast wire: nothing at all
  const fast = open(file, { latency: 40 });
  await settled(fast);
  ok('a 40 ms wire writes no line at all', slowLines(fast).length === 0, slowLines(fast).length + ' lines');
  ok('a fast boot counts nothing as slow', fast.w.__ltSlow().count === 0, fast.w.__ltSlow().count);
  ok('a fast boot logs no error either', fast.errs.length === 0, fast.errs.join(' | '));

  return { slow, fast };
}

/* ---------- 2. the boundary, exactly ---------- */
function boundaryTests(env) {
  const w = env.w;
  let c = w.__ltSlow().count;
  call(w, 'rqSlow', 'videos.chart', 800, 0, 200, '');
  ok('800 ms exactly is not logged (the item says "more than 800")', w.__ltSlow().count === c,
    w.__ltSlow().count - c + ' counted');
  call(w, 'rqSlow', 'videos.chart', 801, 0, 200, '');
  ok('801 ms is logged', w.__ltSlow().count === c + 1, w.__ltSlow().count - c);
  ok('and it wrote exactly one line', slowLines(env).length === 1, slowLines(env).length);
  ok('the line reads exactly as documented',
    slowLines(env)[0] === 'lt-slow ep=videos.chart ms=801 attempt=0 status=200 n=1',
    slowLines(env)[0]);
  call(w, 'rqSlow', 'videos.chart', 0, 0, 200, '');
  ok('a zero duration is not a slow request', w.__ltSlow().count === c + 1, w.__ltSlow().count - c - 1);
}

/* ---------- 3. bookkeeping: totals, worst, bounds ---------- */
function bookkeepingTests(env) {
  const w = env.w;
  const before = w.__ltSlow();
  call(w, 'rqSlow', 'search', 900, 0, 200, '');
  call(w, 'rqSlow', 'search', 1200, 0, 200, '');
  call(w, 'rqSlow', 'search', 2000, 0, 200, '');
  call(w, 'rqSlow', 'playlistItems', 1500, 0, 200, '');
  const s = w.__ltSlow();
  ok('per endpoint: three searches counted', s.endpoints.search && s.endpoints.search.n === 3,
    JSON.stringify(s.endpoints.search));
  ok('per endpoint: the durations are summed', s.endpoints.search && s.endpoints.search.ms === 4100,
    s.endpoints.search && s.endpoints.search.ms);
  ok('per endpoint: the worst of that endpoint is kept', s.endpoints.search && s.endpoints.search.worst === 2000,
    s.endpoints.search && s.endpoints.search.worst);
  ok('the worst offender overall is remembered with its endpoint', s.worst === 2000 && s.worstEp === 'search',
    s.worst + ' ms on ' + s.worstEp);
  ok('a second endpoint keeps its own line of the table',
    s.endpoints.playlistItems && s.endpoints.playlistItems.n === 1, JSON.stringify(s.endpoints.playlistItems));

  // the line cap: logcat must not be floodable by a long offline session
  const b = w.__ltSlow();
  for (let i = 0; i < 60; i++) call(w, 'rqSlow', 'channels', 900, 0, 200, '');
  const a = w.__ltSlow();
  ok('lines stop at the cap', a.lines === 40, a.lines);
  ok('everything past the cap is still counted', a.count - b.count === 60, a.count - b.count);
  ok('the number of lines not printed is recorded',
    a.dropped === 60 - (40 - b.lines), a.dropped + ' dropped, ' + b.lines + ' printed before');
  ok('the log really holds only the cap',
    slowLines(env).length === 40, slowLines(env).length + ' lines in the log');

  // the endpoint table is bounded too
  for (let i = 0; i < 20; i++) call(w, 'rqSlow', 'ep' + i, 900, 0, 200, '');
  ok('the per-endpoint table is capped', Object.keys(w.__ltSlow().endpoints).length <= 12,
    Object.keys(w.__ltSlow().endpoints).length + ' endpoints');
  ok('a capped-away endpoint is still counted in the total',
    w.__ltSlow().count === a.count + 20, w.__ltSlow().count - a.count);
}

/* ---------- 4. attempts, failures, aborts, and what is free ---------- */
async function pathTests(file) {
  const env = open(file, { latency: 900 });
  const w = env.w;
  await settled(env);
  const at = () => slowLines(env).length;

  // a 500 that the retry rescues: two attempts, two lines
  let n = at(), r = env.reqs.length;
  env.setFail('error');
  await w.yt('search', { part: 'snippet', q: 'slow-retry-500' });
  const two = slowLines(env).slice(n).map(parse);
  ok('a retried request logs both attempts, numbered',
    two.length === 2 && two[0].attempt === '0' && two[1].attempt === '1',
    two.map(l => l.attempt + '/' + l.status).join(' '));
  ok('the failed attempt carries the status it got',
    two.length === 2 && two[0].status === '500' && two[1].status === '200',
    two.map(l => l.status).join(','));
  ok('a retried request is still one request more, not two',
    env.reqs.length - r === 2, env.reqs.length - r + ' requests');

  // a fetch that never got a response: status 0, err=net
  n = at(); env.setFail('throw');
  await w.yt('search', { part: 'snippet', q: 'slow-net' });
  const net = slowLines(env).slice(n).map(parse);
  ok('a fetch that never answered is logged as err=net with status=0',
    net.length === 2 && net[0].status === '0' && net[0].err === 'net' && net[1].status === '200',
    net.map(l => l.status + '/' + (l.err || 'ok')).join(' '));

  // a request whose page was left: err=abort, and not mistaken for an answer
  n = at();
  const p = w.yt('search', { part: 'snippet', q: 'slow-abort' }, 'explore');
  await sleep(850);
  w.rqAbandon('home');
  try { await p; } catch (e) { /* the abort is the point */ }
  const ab = slowLines(env).slice(n).map(parse);
  ok('a request abandoned with its page is logged as err=abort',
    ab.length === 1 && ab[0].err === 'abort' && +ab[0].ms > 800,
    ab.map(l => l.ms + '/' + l.err).join(' '));

  // a joined in-flight call: one request, one line
  n = at(); r = env.reqs.length;
  await Promise.all([
    w.yt('search', { part: 'snippet', q: 'slow-join' }),
    w.yt('search', { part: 'snippet', q: 'slow-join' }),
  ]);
  ok('two callers of one in-flight request write one line, not two',
    at() === n + 1 && env.reqs.length === r + 1, (at() - n) + ' lines, ' + (env.reqs.length - r) + ' requests');

  // a cache hit: no request, no line
  n = at(); r = env.reqs.length;
  await w.yt('search', { part: 'snippet', q: 'slow-join' });
  ok('a cache hit writes no line and sends no request', at() === n && env.reqs.length === r,
    (at() - n) + ' lines, ' + (env.reqs.length - r) + ' requests');
  ok('the slow path left the request counters alone',
    w.__ltReqCache().hit > 0 && w.__ltReqCache().fly === 0, JSON.stringify(w.__ltReqCache()));
  return env;
}

/* ---------- 5. the cost of the timing itself ---------- */
function costTests(env) {
  const [clock, fast] = env.w.eval(`(function(){
    var N=200000,i,t0,t1;
    t0=performance.now();for(i=0;i<N;i++)rqNow();t1=performance.now();
    var a=(t1-t0)/N*1000;
    t0=performance.now();for(i=0;i<N;i++)rqSlow('videos.chart',10,0,200,'');t1=performance.now();
    return [a,(t1-t0)/N*1000];
  })()`);
  /* jsdom's performance.now is itself the expensive part of this measurement, so
     the bar is a few microseconds rather than the tens of nanoseconds a real
     engine spends — either way it is nothing against an 800 ms threshold. */
  ok('the clock read costs a few microseconds at most', clock < 5, clock.toFixed(3) + ' µs (jsdom clock)');
  ok('the fast path (a request under the threshold) costs a few microseconds at most',
    fast < 5, fast.toFixed(3) + ' µs');
  console.log('  cost: rqNow ' + clock.toFixed(3) + ' µs, fast path ' + fast.toFixed(3) +
    ' µs per request attempt (two clock reads + one comparison)');
}

/* ---------- 6. nothing visible changed ---------- */
async function abTests(newFile, oldFile) {
  const drive = async file => {
    const env = open(file, { latency: 40 });
    await settled(env);
    await sleep(1400);            /* the quota meter writes on its own 1 s timer */
    return {
      chips: snap(env, '#chips'), feed: snap(env, '#feed'), ex: snap(env, '#ex'),
      sg: snap(env, '#sg'), subfeed: snap(env, '#subfeed'),
      nodes: env.d.querySelectorAll('*').length,
      reqs: env.reqs.map(r => r.url).slice().sort(),
      keys: Object.keys(env.dump()).sort(),
      errs: env.errs.length,
      slow: slowLines(env).length,
    };
  };
  const A = await drive(oldFile), B = await drive(newFile);
  const same = k => ok('A/B ' + k + ' is byte-identical to the previous build', A[k] === B[k],
    A[k] === B[k] ? '' : 'differs (' + String(A[k]).length + ' vs ' + String(B[k]).length + ' chars)');
  same('chips'); same('feed'); same('ex'); same('sg'); same('subfeed');
  ok('A/B the DOM has exactly the same number of nodes', A.nodes === B.nodes, A.nodes + ' vs ' + B.nodes);
  ok('A/B the same requests are sent, in the same set', JSON.stringify(A.reqs) === JSON.stringify(B.reqs),
    A.reqs.length + ' vs ' + B.reqs.length + ' requests');
  const added = B.keys.filter(k => A.keys.indexOf(k) < 0);
  const lost = A.keys.filter(k => B.keys.indexOf(k) < 0);
  ok('A/B no storage key was added or lost', added.length === 0 && lost.length === 0,
    'added ' + added.join(',') + '; lost ' + lost.join(','));
  ok('A/B no console error in either build', A.errs === 0 && B.errs === 0, A.errs + ' / ' + B.errs);
  ok('A/B a fast wire logs nothing new', B.slow === 0, B.slow + ' lt-slow lines');
}

(async () => {
  const { slow, fast } = await wireTests(NEW_FILE);
  boundaryTests(fast);
  bookkeepingTests(fast);
  await pathTests(NEW_FILE);
  costTests(open(NEW_FILE, { latency: 40 }));
  if (OLD_FILE) await abTests(NEW_FILE, OLD_FILE);
  else console.log('(no previous build given: the A/B half is skipped)');

  PAGES.forEach(d => { try { d.window.close(); } catch (e) {} });
  let pass = 0;
  for (const r of R) {
    if (r.pass) pass++;
    console.log((r.pass ? 'PASS  ' : 'FAIL  ') + r.name + (r.detail ? '   [' + r.detail + ']' : ''));
  }
  console.log('\n' + pass + '/' + R.length + ' assertions passed');
  process.exit(pass === R.length ? 0 : 1);
})();
