#!/usr/bin/env node
/*
 * LiquidTube retry/backoff check — proves item 2.3: one retry with exponential
 * backoff for 5xx, 429 and network failures, and nothing else.
 *
 * Two halves, both without a device or a real browser:
 *
 *  1. The request layer, by calling yt() directly in the loaded page against a
 *     scripted fetch: a 5xx or a network throw is retried exactly once after a
 *     growing wait, a 4xx (quota, bad key, not-found) is never repeated, a
 *     second failure is handed to the caller, a retry that succeeds is cached,
 *     callers that joined an in-flight request share its retry, and an aborted
 *     request is not repeated.
 *  2. The app, booted with the trending call failing once and then answering,
 *     and booted with it failing twice: the first must end up with the same
 *     cards a clean boot paints, the second must show the same error surface
 *     the previous build shows.
 *
 * Runs in jsdom with googleapis.com answered from fixtures — no network, no
 * Chromium, deterministic apart from the measured backoff window.
 *
 *   npm i jsdom
 *   node tools/retry-backoff-check.js app/assets/index.html /tmp/old/index.html
 *
 * argv[2] is the build under test, argv[3] the previous build (optional; the
 * A/B half is skipped without it).
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

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
   empty `items` for an id it does not know. A mock that always answers with its
   whole channel list instead would let a one-id lookup hand back a different
   channel than the one asked for — something the real endpoint never does — so
   every harness echoes the requested ids here and synthesises the ones its
   fixture does not hold. */
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
  if (p.endsWith('/playlistItems')) return F.search;
  if (p.endsWith('/search')) return F.search;
  return {};
}
const isTrending = u => /\/videos\?/.test(u) && /chart=mostPopular/.test(u);

/* a page: fresh window and localStorage, a fetch that answers from the fixtures
   and logs every call. `queue` holds scripted answers consumed one per request;
   when it is empty the fixtures answer. `trendingQueue` does the same but only
   for the boot's chart request, so app-level failure injection does not depend
   on what else is on the wire. */
function open(file) {
  const HTML = fs.readFileSync(file, 'utf8');
  const env = { log: [], queue: [], trendingQueue: [], bodies: {} };
  const res = (status, body, ok) => ({ ok, status, json: async () => body });
  const mockFetch = async u => {
    u = String(u);
    env.log.push({ url: u.replace(/([?&])key=[^&]*/, '$1key=<key>'), t: Date.now() });
    const q = isTrending(u) && env.trendingQueue.length ? env.trendingQueue : env.queue;
    const step = q.length ? q.shift() : 'ok';
    if (step === 'throw') throw new Error('network down');
    if (step === 'abort') { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
    if (step === 'garbage') return { ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); } };
    if (typeof step === 'object') {
      const body = step.body === 'html' ? null : step.body;
      return { ok: step.status >= 200 && step.status < 300, status: step.status, json: async () => { if (!body) throw new SyntaxError('Unexpected token <'); return body; } };
    }
    const j = apiBody(u);
    env.bodies[u] = j;
    return res(200, j, true);
  };
  const dom = new JSDOM(HTML, {
    url: 'https://liquidtube.local/index.html',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(w) {
      w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
      w.fetch = mockFetch;
      w.scrollTo = () => {};
    },
  });
  env.w = dom.window;
  env.d = dom.window.document;
  env.dom = dom;
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
function norm(h) {
  return String(h)
    .replace(/ class="ld"/g, '').replace(/ ld"/g, '"')
    .replace(/ data-f="1"/g, '')
    .replace(/ ?(?:transform|opacity|background-position-y):[^;"']*;?/g, '')
    .replace(/style="\s*"/g, '').replace(/\s{2,}/g, ' ').trim();
}
const snap = (env, sel, all) => all
  ? [...env.d.querySelectorAll(sel)].map(e => norm(e.outerHTML))
  : norm((env.d.querySelector(sel) || {}).innerHTML || '');

/* ---------- assertions ---------- */
let pass = 0;
const fails = [];
function ok(label, cond, detail) {
  if (cond) { pass++; return; }
  fails.push(label + (detail !== undefined ? ' — ' + detail : ''));
}
const near = (label, v, lo, hi) => ok(label, v >= lo && v <= hi, v + ' not in [' + lo + ',' + hi + ']');

/* the direct request-layer tests; each uses its own query so the cache cannot
   answer a later one */
async function requestLayer(file) {
  const env = open(file);
  const yt = env.w.yt;
  const RQ = env.w.__ltReqCache;
  await waitFor(() => env.d.querySelectorAll('#feed .card').length > 0);
  await sleep(200);
  let n = 0;
  const fresh = () => 'rt-' + (++n) + '-' + Math.random().toString(36).slice(2, 7);
  const before = () => env.log.length;
  const after = () => env.log.length;
  const reset = () => { env.queue = []; };

  /* the backoff curve itself: doubling, capped, jittered */
  const b = a => env.w.rqBackoff(a);
  near('backoff attempt 0 is one base step plus jitter', b(0), 500, 750);
  near('backoff attempt 1 doubles', b(1), 1000, 1500);
  near('backoff attempt 2 doubles again', b(2), 2000, 3000);
  near('backoff attempt 3 is capped', b(3), 4000, 6000);
  near('backoff attempt 9 stays capped', b(9), 4000, 6000);
  ok('backoff is monotonic', b(0) <= b(1) && b(1) <= b(2) && b(2) <= b(3));

  /* a 5xx is retried once, and the wait really happens */
  let s = before(), r0 = RQ();
  env.queue = [{ status: 500, body: { error: { message: 'Backend Error' } } }];
  let out = await yt('search', { part: 'snippet', q: fresh(), maxResults: 20 });
  let calls = env.log.slice(s);
  ok('500 then success makes two requests', calls.length === 2, calls.length);
  ok('500 then success resolves with the fixtures', (out.items || []).length === 20);
  const gap = calls[1].t - calls[0].t;
  near('the retry waited the backoff window', gap, 480, 900);
  let r1 = RQ();
  ok('the retry is counted', r1.retry - r0.retry === 1, r1.retry - r0.retry);
  ok('the retry that succeeded is counted', r1.retryOk - r0.retryOk === 1);
  ok('the request is off the wire afterwards', r1.fly === 0);
  reset();

  /* ... and its result is cached like any other success */
  s = before();
  out = await yt('search', { part: 'snippet', q: env.log[s - 1].url.match(/q=([^&]*)/)[1], maxResults: 20 });
  ok('a success after a retry is cached', after() === s, after() - s);
  reset();

  /* a network failure is retried too */
  s = before();
  env.queue = ['throw'];
  out = await yt('search', { part: 'snippet', q: fresh(), maxResults: 20 });
  ok('network throw then success makes two requests', after() - s === 2, after() - s);
  ok('network throw then success resolves', (out.items || []).length === 20);
  reset();

  /* a 429 is retried */
  s = before();
  env.queue = [{ status: 429, body: { error: { message: 'Rate Limit Exceeded' } } }];
  out = await yt('search', { part: 'snippet', q: fresh(), maxResults: 20 });
  ok('429 then success makes two requests', after() - s === 2, after() - s);
  reset();

  /* two failures: exactly one retry, then the failure reaches the caller */
  s = before(); r0 = RQ();
  env.queue = [{ status: 500, body: { error: { message: 'Backend Error' } } }, { status: 500, body: { error: { message: 'Backend Error' } } }];
  let err = null;
  try { await yt('search', { part: 'snippet', q: fresh(), maxResults: 20 }); } catch (e) { err = e; }
  ok('two 500s make exactly two requests', after() - s === 2, after() - s);
  ok('the failure is handed to the caller', !!err && err.message === 'Backend Error', err && err.message);
  r1 = RQ();
  ok('the failed retry is counted', r1.retryFail - r0.retryFail === 1);
  ok('a failure leaves nothing cached', r1.size === r0.size, r1.size - r0.size);
  /* the next call goes out again instead of serving the failure */
  s = before();
  out = await yt('search', { part: 'snippet', q: env.log[s - 1].url.match(/q=([^&]*)/)[1], maxResults: 20 });
  ok('the query is retried on the next call', after() - s === 1 && (out.items || []).length === 20);
  reset();

  /* a 4xx is an answer, never repeated */
  for (const [status, message, label] of [
    [403, 'The request cannot be completed because you have exceeded your quota.', 'quota'],
    [400, 'API key not valid. Please pass a valid API key.', 'bad key'],
    [404, 'videoNotFound', 'not found'],
  ]) {
    s = before(); r0 = RQ();
    env.queue = [{ status, body: { error: { message } } }];
    err = null;
    try { await yt('search', { part: 'snippet', q: fresh(), maxResults: 20 }); } catch (e) { err = e; }
    ok('a ' + status + ' (' + label + ') is sent once', after() - s === 1, after() - s);
    ok('a ' + status + ' (' + label + ') keeps its message', !!err && err.message === message, err && err.message);
    ok('a ' + status + ' (' + label + ') counts no retry', RQ().retry === r0.retry);
    reset();
  }

  /* an aborted request is not repeated */
  s = before();
  env.queue = ['abort'];
  err = null;
  try { await yt('search', { part: 'snippet', q: fresh(), maxResults: 20 }); } catch (e) { err = e; }
  ok('an AbortError is not retried', after() - s === 1, after() - s);
  ok('the AbortError reaches the caller', !!err && err.name === 'AbortError');
  reset();

  /* a 200 with a body that will not parse is a single attempt */
  s = before();
  env.queue = ['garbage'];
  err = null;
  try { await yt('search', { part: 'snippet', q: fresh(), maxResults: 20 }); } catch (e) { err = e; }
  ok('an unparseable 200 is not retried', after() - s === 1, after() - s);
  ok('the unparseable 200 fails', !!err, err && err.message);
  reset();

  /* a 5xx whose body will not parse is still a 5xx: retried */
  s = before();
  env.queue = [{ status: 503, body: 'html' }];
  out = await yt('search', { part: 'snippet', q: fresh(), maxResults: 20 });
  ok('a 503 with an HTML body is retried', after() - s === 2, after() - s);
  ok('a 503 with an HTML body recovers', (out.items || []).length === 20);
  reset();

  /* two callers that joined an in-flight request share its retry */
  s = before(); r0 = RQ();
  env.queue = [{ status: 500, body: { error: { message: 'Backend Error' } } }];
  const q = fresh();
  const [a, c] = await Promise.all([
    yt('search', { part: 'snippet', q, maxResults: 20 }),
    yt('search', { part: 'snippet', q, maxResults: 20 }),
  ]);
  ok('a joined request retries once in total', after() - s === 2, after() - s);
  ok('both joiners get the same response object', a === c);
  ok('the join is counted', RQ().join - r0.join === 1);
  ok('both joiners get the data', (a.items || []).length === 20 && (c.items || []).length === 20);
  reset();

  env.dom.window.close();
}

/* ---------- the app, booted with failures injected ---------- */
/* the boot's chart request is the first call, so it must be scripted before the
   page runs; this wraps open() with the queue already in place */
async function bootWith(file, trending) {
  const HTML = fs.readFileSync(file, 'utf8');
  const env = { log: [], queue: [], trendingQueue: (trending || []).slice(), bodies: {} };
  const mockFetch = async u => {
    u = String(u);
    env.log.push({ url: u.replace(/([?&])key=[^&]*/, '$1key=<key>'), t: Date.now() });
    const q = isTrending(u) && env.trendingQueue.length ? env.trendingQueue : env.queue;
    const step = q.length ? q.shift() : 'ok';
    if (step === 'throw') throw new Error('network down');
    if (typeof step === 'object') return { ok: false, status: step.status, json: async () => step.body };
    const j = apiBody(u);
    env.bodies[u] = j;
    return { ok: true, status: 200, json: async () => j };
  };
  const dom = new JSDOM(HTML, {
    url: 'https://liquidtube.local/index.html',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(w) {
      w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
      w.fetch = mockFetch;
      w.scrollTo = () => {};
    },
  });
  env.w = dom.window; env.d = dom.window.document; env.dom = dom;
  await waitFor(() => env.d.querySelectorAll('#feed .card').length > 0 || env.d.querySelector('#feed .empty'), 25000);
  await sleep(400);
  return env;
}

async function appLevel() {
  const clean = await bootWith(NEW_FILE, []);
  const cleanSnap = {
    chips: snap(clean, '#chips'), feed: snap(clean, '#feed .card', 1),
    ex: snap(clean, '#ex'), subs: snap(clean, '#sg'),
  };
  ok('a clean boot paints 24 cards', clean.d.querySelectorAll('#feed .card').length === 24);
  ok('a clean boot makes no extra request', clean.w.__ltReqCache().retry === 0, clean.w.__ltReqCache().retry);
  clean.dom.window.close();

  /* the chart fails once at boot, then answers: the user sees the feed, not an
     error, and pays one extra round trip plus the backoff */
  const once = await bootWith(NEW_FILE, [{ status: 500, body: { error: { message: 'Backend Error' } } }]);
  ok('a boot whose chart 500s once still paints 24 cards', once.d.querySelectorAll('#feed .card').length === 24, once.d.querySelectorAll('#feed .card').length);
  ok('a boot whose chart 500s once shows no error state', !once.d.querySelector('#feed .empty'));
  ok('the timeline does not record an error', once.w.__ltTimeline && /err=0/.test(once.w.__ltTimeline), once.w.__ltTimeline);
  ok('the chart was asked twice', once.log.filter(e => isTrending(e.url)).length === 2, once.log.filter(e => isTrending(e.url)).length);
  const onceSnap = {
    chips: snap(once, '#chips'), feed: snap(once, '#feed .card', 1),
    ex: snap(once, '#ex'), subs: snap(once, '#sg'),
  };
  ok('the recovered boot renders the clean boot’s markup', JSON.stringify(onceSnap) === JSON.stringify(cleanSnap));
  once.dom.window.close();

  /* the chart fails twice: one retry, then the same error surface as before */
  const dead = await bootWith(NEW_FILE, [
    { status: 500, body: { error: { message: 'Backend Error' } } },
    { status: 500, body: { error: { message: 'Backend Error' } } },
  ]);
  const deadText = (dead.d.querySelector('#feed') || {}).textContent || '';
  ok('a boot whose chart always 500s shows the error surface', /Could not load videos/.test(deadText), deadText.trim());
  ok('the error text is the API message, as before', /Backend Error/.test(deadText), deadText.trim());
  ok('the timeline records the error', dead.w.__ltTimeline && /err=1/.test(dead.w.__ltTimeline), dead.w.__ltTimeline);
  ok('the chart was asked exactly twice', dead.log.filter(e => isTrending(e.url)).length === 2, dead.log.filter(e => isTrending(e.url)).length);

  if (OLD_FILE) {
    const oldClean = await bootWith(OLD_FILE, []);
    const oldSnap = {
      chips: snap(oldClean, '#chips'), feed: snap(oldClean, '#feed .card', 1),
      ex: snap(oldClean, '#ex'), subs: snap(oldClean, '#sg'),
    };
    ok('the clean boot is byte-identical to the previous build', JSON.stringify(oldSnap) === JSON.stringify(cleanSnap));
    oldClean.dom.window.close();

    const oldDead = await bootWith(OLD_FILE, [
      { status: 500, body: { error: { message: 'Backend Error' } } },
    ]);
    const oldText = (oldDead.d.querySelector('#feed') || {}).textContent || '';
    ok('the error surface is the same as the previous build’s', oldText === deadText, JSON.stringify([oldText, deadText]));
    ok('the previous build asks the chart once', oldDead.log.filter(e => isTrending(e.url)).length === 1, oldDead.log.filter(e => isTrending(e.url)).length);
    oldDead.dom.window.close();
  }
  dead.dom.window.close();
}

(async () => {
  await requestLayer(NEW_FILE);
  await appLevel();
  console.log('retry/backoff check: ' + pass + ' passed, ' + fails.length + ' failed');
  for (const f of fails) console.log('  FAIL ' + f);
  process.exit(fails.length ? 1 : 0);
})();
