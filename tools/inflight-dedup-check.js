#!/usr/bin/env node
/*
 * LiquidTube in-flight dedup check — proves item 2.2: a second call for the same
 * query while the first is still on the wire shares that request instead of
 * sending another one.
 *
 * Two halves, both without a device or a real browser:
 *
 *  1. The dedup itself, by calling yt() directly inside the loaded page with a
 *     deliberately slow fetch so the calls really do overlap: one request for
 *     two callers, the same response object for both, three callers still one
 *     request, different queries still two, parameter order irrelevant, a
 *     failure shared and never cached, and no stale slot left behind that would
 *     block the retry.
 *  2. The app, driven with the same slow fetch so a double tap really overlaps:
 *     a chip tapped twice, "View All" pressed twice, the same query typed twice,
 *     a channel sheet opened twice — the request log must shrink while every
 *     rendered surface stays byte-identical to the previous build.
 *
 * jsdom + fixed fixtures, no network. Dev-only, not shipped in the APK.
 *
 *   NODE_PATH=/scratch/node_modules node tools/inflight-dedup-check.js \
 *       app/assets/index.html /path/to/previous/index.html
 *
 * argv[2] is the build under test, argv[3] the previous build (optional; the
 * A/B half is skipped without it).
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const NEW_FILE = process.argv[2] || path.join(__dirname, '..', 'app/assets/index.html');
const OLD_FILE = process.argv[3] || '';
const LATENCY = 120;                      // ms per request: long enough to overlap on purpose
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
  if (p.endsWith('/playlistItems')) return F.playlistItems;
  if (p.endsWith('/search')) return F.search;
  return {};
}

/* one page: fresh window, fresh localStorage, a fetch that answers from the
   fixtures above after `latency` ms and logs every URL it was asked for */
function open(file, latency) {
  const HTML = fs.readFileSync(file, 'utf8');
  const reqs = [];
  const env = { reqs, fail: null, latency };
  const mockFetch = async u => {
    u = String(u);
    reqs.push(u.replace(/([?&])key=[^&]*/, '$1key=<key>'));
    if (latency) await sleep(latency);
    if (env.fail === 'throw') throw new Error('network down');
    if (env.fail === 'error') return { ok: false, status: 500, json: async () => ({ error: { message: 'The request cannot be completed because you have exceeded your quota.' } }) };
    const j = apiBody(u);
    return { ok: true, status: 200, json: async () => j };
  };
  globalThis.fetch = mockFetch;
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
/* markup that depends on when a frame ran, not on what was rendered */
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

/* ---------- 1. the dedup, called directly ---------- */
async function unitTests(file) {
  const env = open(file, LATENCY);
  const w = env.w;
  await waitFor(() => env.d.querySelectorAll('#feed .card').length > 0);
  await waitFor(() => w.__ltReqCache && w.__ltReqCache().fly === 0);
  const R = [];
  const ok = (name, pass, detail) => R.push({ name, pass: !!pass, detail });
  if (typeof w.yt !== 'function') { ok('yt() reachable', false, typeof w.yt); return R; }
  const st = () => w.__ltReqCache();
  const q = 'dedup-' + Math.random().toString(36).slice(2);

  // 1. two concurrent calls for the same query: one request, one response object
  let n = env.reqs.length, s = st();
  const p1 = w.yt('search', { part: 'snippet', q });
  const p2 = w.yt('search', { part: 'snippet', q });
  const [r1, r2] = await Promise.all([p1, p2]);
  ok('two overlapping calls send one request', env.reqs.length === n + 1, 'requests ' + (env.reqs.length - n));
  ok('both callers get the same response object', r1 === r2 && r1 && Array.isArray(r1.items));
  ok('the join is counted, the miss is counted once', st().join === s.join + 1 && st().miss === s.miss + 1,
    'join ' + s.join + '→' + st().join + ', miss ' + s.miss + '→' + st().miss);
  ok('no slot is left on the wire after settling', st().fly === 0, 'fly ' + st().fly);
  const nAfter = env.reqs.length;
  const r3 = await w.yt('search', { part: 'snippet', q });
  ok('a later call is a cache hit, not a second request', env.reqs.length === nAfter && r3 === r1);

  // 2. three callers, still one request
  const q2 = q + '-three';
  n = env.reqs.length; s = st();
  const tri = await Promise.all([w.yt('search', { part: 'snippet', q: q2 }), w.yt('search', { part: 'snippet', q: q2 }), w.yt('search', { part: 'snippet', q: q2 })]);
  ok('three overlapping callers send one request', env.reqs.length === n + 1 && st().join === s.join + 2,
    'requests ' + (env.reqs.length - n) + ', joins ' + (st().join - s.join));
  ok('all three share one object', tri[0] === tri[1] && tri[1] === tri[2]);

  // 3. different queries still go out separately
  n = env.reqs.length;
  await Promise.all([w.yt('search', { part: 'snippet', q: q + '-a' }), w.yt('search', { part: 'snippet', q: q + '-b' })]);
  ok('different queries are not merged', env.reqs.length === n + 2, 'requests ' + (env.reqs.length - n));

  // 4. parameter order does not matter, and the API key is not part of the identity
  n = env.reqs.length; s = st();
  await Promise.all([w.yt('search', { q: q + '-order', part: 'snippet' }), w.yt('search', { part: 'snippet', q: q + '-order' })]);
  ok('parameter order does not split the in-flight entry', env.reqs.length === n + 1 && st().join === s.join + 1);
  ok('the request that was sent still carries the app key', /[?&]key=[^&]+/.test(env.reqs[env.reqs.length - 1]));

  // 5. a failure is shared, not cached, and does not block the retry
  env.fail = 'error';
  n = env.reqs.length;
  const fail = await Promise.all([
    w.yt('search', { part: 'snippet', q: q + '-fail' }).then(() => 'ok', () => 'err'),
    w.yt('search', { part: 'snippet', q: q + '-fail' }).then(() => 'ok', () => 'err'),
  ]);
  // since item 2.3 a 5xx is retried once, and the retry is part of the shared
  // promise: both callers still see one request (plus its retry), not two
  ok('an API error is shared by both callers', fail[0] === 'err' && fail[1] === 'err' && env.reqs.length === n + 2,
    fail.join('/') + ', requests ' + (env.reqs.length - n));
  ok('the failed slot is released', st().fly === 0, 'fly ' + st().fly);
  env.fail = null;
  n = env.reqs.length;
  const retry = await w.yt('search', { part: 'snippet', q: q + '-fail' }).then(() => 'ok', () => 'err');
  ok('the retry after a failure really goes out', retry === 'ok' && env.reqs.length === n + 1, 'requests ' + (env.reqs.length - n));

  env.fail = 'throw';
  n = env.reqs.length;
  const thr = await Promise.all([
    w.yt('search', { part: 'snippet', q: q + '-throw' }).then(() => 'ok', () => 'err'),
    w.yt('search', { part: 'snippet', q: q + '-throw' }).then(() => 'ok', () => 'err'),
  ]);
  ok('a network throw is shared and released', thr[0] === 'err' && thr[1] === 'err' && env.reqs.length === n + 2 && st().fly === 0,
    'requests ' + (env.reqs.length - n) + ', fly ' + st().fly);
  env.fail = null;

  // 6. the in-flight map cannot outlive the request, and one entry lands in the cache
  s = st();
  await w.yt('search', { part: 'snippet', q: q + '-size' });
  ok('a completed request leaves no in-flight entry', st().fly === 0);
  ok('a completed request leaves exactly one cache entry', st().size === Math.min(s.size + 1, st().max), 'size ' + s.size + '→' + st().size);

  // 7. the same query in a *different* endpoint is a different request
  n = env.reqs.length;
  await Promise.all([w.yt('search', { part: 'snippet', q: q + '-cross' }), w.yt('playlistItems', { part: 'snippet', playlistId: q + '-cross' })]);
  ok('the path is part of the in-flight identity', env.reqs.length === n + 2, 'requests ' + (env.reqs.length - n));

  env.dom.window.close();
  return R;
}

/* ---------- 2. the app, double-tapped, old vs new ---------- */
async function drive(file) {
  const env = open(file, LATENCY);
  const out = {};
  await waitFor(() => env.d.querySelectorAll('#feed .card').length > 0);
  await waitFor(() => !env.d.querySelector('#ex .skl'));
  await sleep(400);
  out.boot = { feed: snap(env, '#feed .card', 1), ex: snap(env, '#ex'), subs: snap(env, '#sg'), chips: snap(env, '#chips') };
  out.afterBoot = env.reqs.length;

  // a chip tapped twice while its section is still loading
  const anime = () => [...env.d.querySelectorAll('#chips .chip')].find(b => b.textContent === 'Anime');
  const before = env.reqs.length;
  anime().click();
  anime().click();
  await waitFor(() => env.d.querySelectorAll('#feed .card').length > 0);
  await sleep(400);
  out.chipDouble = snap(env, '#feed');
  out.chipDoubleReqs = env.reqs.length - before;
  out.chipDoubleLog = env.reqs.slice(before);
  env.d.querySelector('#chips .chip').click();          // back to All
  await sleep(200);

  // "View All" pressed twice before the shelf's search comes back
  const va = () => env.d.querySelector('[data-shelf="calm"]');
  const b2 = env.reqs.length;
  va().click();
  va().click();
  await waitFor(() => env.d.querySelectorAll('#results .card').length > 0);
  await sleep(400);
  out.viewAllDouble = snap(env, '#results .card', 1);
  out.viewAllDoubleReqs = env.reqs.length - b2;
  out.viewAllDoubleLog = env.reqs.slice(b2);
  env.d.getElementById('cancel').click();
  await sleep(200);

  // the same query typed twice inside one round trip
  env.d.getElementById('sopen').click();
  await sleep(120);
  const qi = env.d.getElementById('q');
  const b3 = env.reqs.length;
  qi.value = 'lofi';
  qi.dispatchEvent(new env.w.Event('input'));
  qi.dispatchEvent(new env.w.Event('input'));
  await waitFor(() => env.d.querySelectorAll('#results .card').length > 0);
  await sleep(400);
  out.typeDouble = snap(env, '#results .card', 1);
  out.typeDoubleReqs = env.reqs.length - b3;
  out.typeDoubleLog = env.reqs.slice(b3);
  env.d.getElementById('cancel').click();
  await sleep(200);

  // a channel sheet opened twice while the first is still fetching
  env.d.querySelector('#feed .card').click();
  await sleep(300);
  const b4 = env.reqs.length;
  env.d.getElementById('plk').click();
  env.d.getElementById('plk').click();
  await waitFor(() => env.d.querySelectorAll('#chlist .card').length > 0);
  await sleep(400);
  out.channelDouble = { head: env.d.getElementById('sht').textContent, body: snap(env, '#shb'), list: snap(env, '#chlist .card', 1) };
  out.channelDoubleReqs = env.reqs.length - b4;
  out.channelDoubleLog = env.reqs.slice(b4);
  env.d.getElementById('scrim').click();
  await sleep(200);

  out.requests = env.reqs.slice();
  out.reqCount = env.reqs.length;
  env.dom.window.close();
  return out;
}

(async () => {
  const units = await unitTests(NEW_FILE);
  const bad = units.filter(u => !u.pass);
  console.log('--- in-flight dedup (' + path.basename(NEW_FILE) + ') ---');
  units.forEach(u => console.log((u.pass ? 'ok   ' : 'FAIL ') + u.name + (u.detail !== undefined ? '  [' + u.detail + ']' : '')));

  let ab = null;
  if (OLD_FILE) {
    const nw = await drive(NEW_FILE);
    const od = await drive(OLD_FILE);
    const surfaces = ['boot', 'chipDouble', 'viewAllDouble', 'typeDouble', 'channelDouble'];
    const diffs = surfaces.filter(k => JSON.stringify(nw[k]) !== JSON.stringify(od[k]));
    const steps = ['chipDouble', 'viewAllDouble', 'typeDouble', 'channelDouble'];
    ab = {
      surfacesIdentical: diffs.length === 0,
      differingSurfaces: diffs,
      steps: steps.reduce((m, k) => (m[k] = { old: od[k + 'Reqs'], new: nw[k + 'Reqs'] }, m), {}),
      requests: { old: od.reqCount, new: nw.reqCount },
    };
    const tally = list => list.reduce((m, u) => (m[u] = (m[u] || 0) + 1, m), {});
    const tOld = tally(od.requests), tNew = tally(nw.requests);
    const extra = Object.keys(tNew).filter(u => tNew[u] > (tOld[u] || 0));
    ab.subset = { ok: extra.length === 0, extra };
    const units = list => list.reduce((n, u) => n + (/\/search\?/.test(u) ? 100 : 1), 0);
    ab.quota = { old: units(od.requests), new: units(nw.requests) };

    console.log('\n--- app, old vs new (each action performed twice, back to back) ---');
    console.log('surfaces identical: ' + ab.surfacesIdentical + (diffs.length ? ' (differ: ' + diffs.join(', ') + ')' : ' (' + surfaces.length + '/' + surfaces.length + ')'));
    steps.forEach(k => console.log('  double ' + k + ': old ' + od[k + 'Reqs'] + ' request(s) → new ' + nw[k + 'Reqs']));
    console.log('requests for the whole run: old ' + od.reqCount + ' → new ' + nw.reqCount);
    console.log('quota units for the whole run: old ' + ab.quota.old + ' → new ' + ab.quota.new);
    console.log('new log is a subset of the old one (nothing new, nothing altered): ' + ab.subset.ok + (extra.length ? ' extra: ' + extra.join(' | ') : ''));
  }
  const pass = bad.length === 0 && (!ab || (ab.surfacesIdentical && ab.subset.ok));
  console.log('\n' + (pass ? 'PASS' : 'FAIL') + (ab ? ' — dedup correct, no rendered surface changed' : ''));
  if (process.env.LT_JSON) fs.writeFileSync(process.env.LT_JSON, JSON.stringify({ units, ab }, null, 1));
  process.exit(pass ? 0 : 1);
})();
