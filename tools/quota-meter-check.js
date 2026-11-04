#!/usr/bin/env node
/*
 * LiquidTube quota-meter check — proves the internal quota meter (item 2.9)
 * counts what the API charges and nothing else, and that it changes nothing a
 * user can see.
 *
 * Three parts, none of them needing a device or a real browser:
 *
 *  1. The meter against the wire, by driving yt() directly in the loaded page:
 *     every request that leaves is counted once, at the endpoint's published
 *     cost; a cache hit, a joined in-flight call and a call refused before it
 *     was sent are free; a retry pays twice; a refusal is recorded.
 *  2. Persistence and the day boundary: the meter survives a restart, a stored
 *     meter from an earlier day is filed into a short history instead of being
 *     added to today's, and a corrupt value starts the day at zero rather than
 *     throwing.
 *  3. The app, booted side by side with the previous build: every rendered
 *     surface must come out byte-identical, the request log identical, the node
 *     count identical and the only new storage key the meter's own.
 *
 *   npm i jsdom
 *   node tools/quota-meter-check.js app/assets/index.html /tmp/old/index.html
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

/* the endpoint a URL was sent to, which is what the meter prices */
const endpointOf = url => {
  const p = new URL(url).pathname;
  const i = p.lastIndexOf('/');
  return p.slice(i + 1);
};
/* the API's published cost per call, restated here so the check does not just
   read the app's own table back to itself */
const COST = { search: 100, videos: 1, channels: 1, playlistItems: 1, playlists: 1 };
const costOf = url => (COST[endpointOf(url)] === undefined ? 1 : COST[endpointOf(url)]);
const wireCost = reqs => reqs.reduce((n, r) => n + costOf(r.url), 0);

/* one page: a fetch that answers from the fixtures after `latency` ms, honours
   an AbortSignal the way a real fetch does, and logs every URL it was asked
   for. `seed` pre-loads localStorage before any script runs, so a restart or a
   corrupt value can be set up exactly; `fail` makes the next response an API
   error, a quota refusal or a network throw. */
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

/* ---------- 1. the meter against the wire ---------- */
async function unitTests(file) {
  const env = open(file);
  const w = env.w;
  await settled(env);
  if (typeof w.__ltQuota !== 'function') {
    ok('window.__ltQuota() is reachable', false, typeof w.__ltQuota);
    return;
  }
  const q = () => w.__ltQuota();

  // shape
  const s0 = q();
  ok('the meter is one object with a fixed shape',
    ['day', 'units', 'requests', 'refused', 'limit', 'left', 'pct', 'endpoints', 'history', 'saved']
      .every(k => k in s0), Object.keys(s0).join(','));
  ok('it reports the local calendar day', s0.day === localDay(), s0.day + ' vs ' + localDay());
  ok('the limit is the API default of 10,000 units', s0.limit === 10000, s0.limit);

  // counting matches the wire
  const bootUnits = wireCost(env.reqs), bootReqs = env.reqs.length;
  ok('every request that left is counted once, at its endpoint cost',
    q().units === bootUnits && q().requests === bootReqs,
    'meter ' + q().units + '/' + q().requests + ', wire ' + bootUnits + '/' + bootReqs);
  ok('a `search` is priced at 100 units and a read at 1',
    (q().endpoints.search ? q().endpoints.search.units / q().endpoints.search.requests : 100) === 100 &&
    (q().endpoints.videos ? q().endpoints.videos.units / q().endpoints.videos.requests : 1) === 1,
    JSON.stringify(q().endpoints));
  ok('left and pct follow the total', q().left === 10000 - q().units && q().pct === Math.round(q().units / 10) / 10,
    q().left + ' / ' + q().pct + '%');

  // a cache hit is free
  let n = env.reqs.length, u = q().units;
  await w.yt('search', { part: 'snippet', q: 'meter-hit' });
  const afterOne = q().units;
  await w.yt('search', { part: 'snippet', q: 'meter-hit' });
  ok('a search costs 100 units the first time', afterOne - u === 100 && env.reqs.length - n === 1, (afterOne - u) + ' units');
  ok('a cache hit costs nothing and counts no request',
    q().units === afterOne && q().requests === bootReqs + 1, (q().units - afterOne) + ' units, ' + (q().requests - bootReqs - 1) + ' extra');

  // a joined in-flight call is free
  n = env.reqs.length; u = q().units;
  const key = 'meter-join';
  const [j1, j2] = await Promise.all([
    w.yt('search', { part: 'snippet', q: key }),
    w.yt('search', { part: 'snippet', q: key }),
  ]);
  ok('two callers of one in-flight request share one charge',
    env.reqs.length - n === 1 && q().units - u === 100 && j1 === j2,
    (env.reqs.length - n) + ' requests, ' + (q().units - u) + ' units');

  // a call refused before it was sent is free
  n = env.reqs.length; u = q().units;
  w.rqAbandon('subs');                                  /* the user is on Subscriptions */
  const e1 = await w.yt('search', { part: 'snippet', q: 'meter-unsent' }, 'explore').then(() => null, e => e);
  ok('a tagged call for a page nobody is on is not charged',
    e1 && e1.name === 'AbortError' && env.reqs.length === n && q().units === u,
    (e1 && e1.name) + ', ' + (env.reqs.length - n) + ' requests, ' + (q().units - u) + ' units');
  w.rqAbandon('home');

  // a retry is a second request on the wire, so it pays twice
  n = env.reqs.length; u = q().units;
  env.setFail('error');
  await w.yt('search', { part: 'snippet', q: 'meter-retry' });
  ok('a retried request is charged for both attempts',
    env.reqs.length - n === 2 && q().units - u === 200,
    (env.reqs.length - n) + ' requests, ' + (q().units - u) + ' units');

  // a refusal is recorded, and is not retried
  n = env.reqs.length; u = q().units;
  const refusedBefore = q().refused;
  env.setFail('quota');
  const e2 = await w.yt('search', { part: 'snippet', q: 'meter-quota' }).then(() => null, e => e);
  ok('a quota refusal is recorded once and not retried',
    !!e2 && q().refused === refusedBefore + 1 && env.reqs.length - n === 1 && q().units - u === 100,
    'refused ' + q().refused + ', ' + (env.reqs.length - n) + ' requests');

  // the meter is visible internally: one lt-quota line per search, on the
  // prefix MainActivity forwards to logcat
  const lines = env.logs.filter(l => l.indexOf('lt-quota') === 0);
  ok('a search writes one `lt-quota` line, on the logcat prefix',
    lines.length > 0 && lines.every(l => l.indexOf('lt-quota ') === 0), lines.length + ' lines: ' + (lines[0] || ''));
  ok('the refusal line says the key is out of quota',
    lines.some(l => /out of quota/.test(l)), lines.filter(l => /out of quota/.test(l))[0] || '');
  ok('nothing was written to the console as an error', env.errs.length === 0, env.errs.join(' | '));

  // nothing on screen: no node, class or attribute came from the meter
  const meterNodes = [...env.d.querySelectorAll('*')].filter(e =>
    /quota/i.test(e.id || '') || /quota/i.test(e.className || '') || /quota/i.test(e.getAttribute && (e.getAttribute('data-quota') || '')));
  ok('the meter adds no element and no class to the page', meterNodes.length === 0, meterNodes.length + ' nodes');

  // the meter is saved on its timer, not on every call
  ok('the meter is not written synchronously on each request', q().saved === false, 'saved=' + q().saved);
  await sleep(1300);
  const raw = env.w.localStorage.getItem('lt_quota');
  ok('it is persisted shortly after, through the shared codec',
    !!raw && (raw.slice(0, 3) === 'z1:' || raw.charAt(0) === '{'), raw ? raw.slice(0, 12) + '…' : 'nothing stored');
  ok('the timer reports the write as done', q().saved === true, 'saved=' + q().saved);

  // and a restart reads it back
  const dump = env.dump();
  const unitsBefore = q().units, reqsBefore = q().requests;
  const env2 = open(file, { seed: dump });
  const w2 = env2.w;
  await waitFor(() => w2.__ltQuota);
  const s2 = w2.__ltQuota();
  ok('a restart continues today’s total instead of starting over',
    s2.units - unitsBefore === wireCost(env2.reqs) && s2.requests - reqsBefore === env2.reqs.length && s2.day === localDay(),
    s2.units + '/' + s2.requests + ' after ' + unitsBefore + '/' + reqsBefore + ' + this boot');
  ok('a restart does not file today as history', s2.history.length === 0, JSON.stringify(s2.history));

}

/* ---------- 2. the day boundary and bad data ---------- */
async function storageTests(file) {
  // yesterday's meter is filed, not added
  const seed = {
    lt_quota: JSON.stringify({ day: dayAgo(1), units: 4200, req: 31, refused: 2, warn: 1, ep: { search: { u: 4100, r: 11 }, videos: { u: 100, r: 20 } }, hist: [] }),
  };
  let env = open(file, { seed });
  await settled(env);
  let s = env.w.__ltQuota();
  const bootUnits = wireCost(env.reqs);
  ok('a meter from yesterday starts today at zero, plus only today’s own work',
    s.units === bootUnits && s.day === localDay(), s.units + ' vs ' + bootUnits + ' today');
  ok('yesterday is kept as history with its own total',
    s.history.length === 1 && s.history[0].day === dayAgo(1) && s.history[0].units === 4200,
    JSON.stringify(s.history));
  ok('yesterday’s refusal count does not carry into today', s.refused === 0, s.refused);
  ok('yesterday’s endpoints do not carry into today', !s.endpoints.search || s.endpoints.search.units < 4100, JSON.stringify(s.endpoints));

  // the history and the endpoint map stay bounded
  const bigHist = [];
  for (let i = 1; i <= 20; i++) bigHist.push({ d: dayAgo(i + 1), u: i * 10, r: i });
  const ep = {};
  for (let i = 0; i < 20; i++) ep['ep' + i] = { u: i, r: i };
  env = open(file, { seed: { lt_quota: JSON.stringify({ day: dayAgo(1), units: 5, req: 1, ep, hist: bigHist }) } });
  await settled(env);
  s = env.w.__ltQuota();
  const days = s.history.map(h => h.day);
  ok('the history is capped, oldest dropped', s.history.length === 7 &&
    s.history[6].day === dayAgo(1) && new Set(days).size === 7,
    s.history.length + ' entries, newest ' + (s.history[6] || {}).day + ', oldest ' + (s.history[0] || {}).day);
  ok('the endpoint map is capped', Object.keys(s.endpoints).length <= 12, Object.keys(s.endpoints).length + ' endpoints');

  // negative and non-numeric values cannot poison a total
  env = open(file, { seed: { lt_quota: JSON.stringify({ day: localDay(), units: -50, req: -3, refused: -1, ep: { search: { u: -100, r: -2 } }, hist: [{ d: 'x', u: -1 }] }) } });
  await settled(env);
  s = env.w.__ltQuota();
  ok('a negative stored total is read as zero, never subtracted from today',
    s.units === wireCost(env.reqs) && s.units >= 0 && s.left === 10000 - s.units,
    s.units + ' vs ' + wireCost(env.reqs));
  ok('a negative refusal count is read as zero', s.refused === 0, s.refused);

  // corrupt values: a fresh meter, no throw, no console error
  const corrupt = ['z1:', 'z1:garbage', '{"units":', 'null', '[]', '5', '', 'not json at all'];
  for (const c of corrupt) {
    env = open(file, { seed: { lt_quota: c } });
    await settled(env);
    s = env.w && env.w.__ltQuota ? env.w.__ltQuota() : null;
    ok('a corrupt meter (' + JSON.stringify(c.slice(0, 10)) + ') starts the day clean, without an error',
      !!s && s.day === localDay() && s.units === wireCost(env.reqs) && env.errs.length === 0,
      s ? s.units + ' units, ' + env.errs.length + ' errors' : 'no meter');
    }
}

/* ---------- 3. nothing visible changed ---------- */
async function abTests(newFile, oldFile) {
  const drive = async file => {
    const env = open(file);
    await settled(env);
    await sleep(1300);            /* the meter writes on its own timer, not per request */
    const out = {
      chips: snap(env, '#chips'), feed: snap(env, '#feed'), ex: snap(env, '#ex'),
      sg: snap(env, '#sg'), subfeed: snap(env, '#subfeed'),
      nodes: env.d.querySelectorAll('*').length,
      reqs: env.reqs.map(r => r.url).slice().sort(),
      keys: Object.keys(env.dump()).sort(),
    };
      return out;
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
  ok('A/B the only new storage key is the meter’s own, and none was lost',
    added.length === 1 && added[0] === 'lt_quota' && lost.length === 0, 'added ' + added.join(',') + '; lost ' + lost.join(','));
}

(async () => {
  await unitTests(NEW_FILE);
  await storageTests(NEW_FILE);
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
