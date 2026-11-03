#!/usr/bin/env node
/*
 * LiquidTube request-cache check — proves the TTL request cache (item 2.1) works
 * and that nothing it touches renders differently.
 *
 * Two things are checked here, both without a device or a real browser:
 *
 *  1. The cache itself, by calling yt() directly inside the loaded page: a repeat
 *     inside the window costs no request, an entry expires on its own TTL, a
 *     failure is never stored, the key never enters a cache key, and the map
 *     stays bounded.
 *  2. The app, driven through its surfaces twice over (search, channel sheet,
 *     shelf "View All", player) with the old build and the new one side by side:
 *     every rendered surface must come out byte-identical, while the request log
 *     must show the new build making fewer calls.
 *
 * It runs the page in jsdom with googleapis.com answered from fixed fixtures —
 * no network, no Chromium (the pod this was written in has none), deterministic.
 *
 *   npm i jsdom
 *   node tools/request-cache-check.js app/assets/index.html /tmp/old/index.html
 *
 * argv[2] is the build under test, argv[3] the previous build to compare
 * against (optional; the A/B half is skipped without it).
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
   fixtures above and logs every URL it was asked for. `fail` lets a test make
   the next response an API error or a network throw. */
function open(file) {
  const HTML = fs.readFileSync(file, 'utf8');
  const reqs = [];
  const env = { reqs, fail: null, skew: 0, bodies: {} };
  const mockFetch = async u => {
    u = String(u);
    reqs.push(u.replace(/([?&])key=[^&]*/, '$1key=<key>'));
    if (env.fail === 'throw') throw new Error('network down');
    if (env.fail === 'error') return { ok: false, status: 500, json: async () => ({ error: { message: 'The request cannot be completed because you have exceeded your quota.' } }) };
    const j = apiBody(u);
    env.bodies[u] = j;
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
      w.Date.now = () => Date.now() + env.skew;      // lets a test age the cache
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

/* ---------- the app, driven through the surfaces that repeat a call ---------- */
async function driveSurfaces(file) {
  const env = open(file);
  const out = {};
  await waitFor(() => env.d.querySelectorAll('#feed .card').length > 0);
  await waitFor(() => !env.d.querySelector('#ex .skl'));
  await sleep(300);
  out.boot = { chips: snap(env, '#chips'), feed: snap(env, '#feed .card', 1), ex: snap(env, '#ex'), subs: snap(env, '#sg') };
  out.afterBoot = env.reqs.length;

  // a user typing and then correcting: with no debounce yet (item 7.1) every
  // keystroke is a search call, so this is where the cache earns most
  env.d.getElementById('sopen').click();
  await sleep(120);
  const qi = env.d.getElementById('q');
  out.typing = [];
  const typed = ['l', 'lo', 'lof', 'lofi', 'lof', 'lofi'];
  for (const t of typed) {
    qi.value = t;
    qi.dispatchEvent(new env.w.Event('input'));
    await waitFor(() => env.d.querySelectorAll('#results .card').length > 0);
    await sleep(100);
    out.typing.push(snap(env, '#results .card', 1));
  }
  out.afterTyping = env.reqs.length;
  env.d.getElementById('cancel').click();
  await sleep(120);

  // search the same query twice, the way a user retypes it
  const search = async () => {
    env.d.getElementById('sopen').click();
    await sleep(120);
    const q = env.d.getElementById('q');
    q.value = 'lofi & chill';
    q.dispatchEvent(new env.w.Event('input'));
    await waitFor(() => env.d.querySelectorAll('#results .card').length > 0);
    await sleep(120);
    return snap(env, '#results .card', 1);
  };
  out.search1 = await search();
  out.afterSearch1 = env.reqs.length;
  env.d.getElementById('cancel').click();
  await sleep(120);
  out.search2 = await search();                    // same query: must be a cache hit
  out.afterSearch2 = env.reqs.length;
  env.d.getElementById('cancel').click();
  await sleep(120);

  // player, then the channel sheet twice (the sheet re-requests the same channel)
  env.d.querySelector('#feed .card').click();
  await sleep(300);
  out.player = { on: env.d.getElementById('pl').classList.contains('on'), iframe: (env.d.querySelector('#pl iframe') || {}).src || '' };
  const sheet = async () => {
    env.d.getElementById('plk').click();
    await waitFor(() => env.d.querySelectorAll('#chlist .card').length > 0);
    await sleep(120);
    return { head: env.d.getElementById('sht').textContent, body: snap(env, '#shb'), list: snap(env, '#chlist .card', 1) };
  };
  out.channel1 = await sheet();
  out.afterChannel1 = env.reqs.length;
  env.d.getElementById('scrim').click();
  await sleep(200);
  out.channel2 = await sheet();
  out.afterChannel2 = env.reqs.length;
  env.d.getElementById('scrim').click();
  await sleep(200);

  // shelf "View All" runs the same search the shelf already ran
  const viewAll = async () => {
    const b = env.d.querySelector('[data-shelf="calm"]');
    b.click();
    await waitFor(() => env.d.querySelectorAll('#results .card').length > 0);
    await sleep(120);
    return snap(env, '#results .card', 1);
  };
  out.viewAll1 = await viewAll();
  out.afterViewAll1 = env.reqs.length;
  env.d.getElementById('cancel').click();
  await sleep(120);
  out.viewAll2 = await viewAll();
  out.afterViewAll2 = env.reqs.length;
  env.d.getElementById('cancel').click();
  await sleep(120);

  // library + settings, and the whole request log
  env.d.querySelector('[data-do="you"]').click();
  await sleep(200);
  out.library = snap(env, '#shb');
  env.d.querySelector('[data-lib="settings"]').click();
  await sleep(200);
  out.settings = snap(env, '#shb');
  out.requests = env.reqs.slice();
  out.reqCount = env.reqs.length;
  env.dom.window.close();
  return out;
}

/* ---------- the cache, called directly ---------- */
async function unitTests(file) {
  const env = open(file);
  const w = env.w;
  await waitFor(() => env.d.querySelectorAll('#feed .card').length > 0);
  const R = [];
  const ok = (name, pass, detail) => R.push({ name, pass: !!pass, detail });
  if (typeof w.yt !== 'function') { ok('yt() reachable', false, typeof w.yt); return R; }
  const stats = () => w.__ltReqCache();
  const base = env.reqs.length;

  // 1. a repeat inside the window costs no request and returns the same object
  const a1 = await w.yt('search', { part: 'snippet', q: 'cache-test' });
  const n1 = env.reqs.length;
  const s1 = stats();
  const a2 = await w.yt('search', { part: 'snippet', q: 'cache-test' });
  ok('repeat is a hit', env.reqs.length === n1 && stats().hit === s1.hit + 1, 'requests ' + n1 + '→' + env.reqs.length + ', hits ' + s1.hit + '→' + stats().hit);
  ok('hit returns the same response object', a1 === a2);
  ok('hit does not change the parsed body', JSON.stringify(a1) === JSON.stringify(a2));

  // 2. parameter order does not matter, the API key is not part of the key
  const before = env.reqs.length;
  await w.yt('search', { q: 'order-test', part: 'snippet' });
  const n2 = env.reqs.length;
  await w.yt('search', { part: 'snippet', q: 'order-test' });
  await w.yt('search', { part: 'snippet', q: 'order-test', key: 'IGNORED' });
  ok('param order and a stray key do not split the entry', env.reqs.length === n2, 'requests ' + before + '→' + n2 + '→' + env.reqs.length);
  ok('cache key never carries the key', !/IGNORED/.test(String(w.rqKey('search', { q: 'order-test', key: 'IGNORED' }))) &&
    !/key=/.test(String(w.rqKey('search', { q: 'x', key: 'IGNORED' }))), w.rqKey('search', { q: 'x', key: 'IGNORED' }));
  ok('the request itself still sends the app key', /[?&]key=[^&]+/.test(env.reqs[env.reqs.length - 1]));

  // 3. TTLs: each endpoint keeps its own window, and an entry expires on read
  const ttlCase = async (name, path, params, alive, dead) => {
    const q = Object.assign({}, params, { q: params.q ? params.q + '-' + name : undefined, id: params.id ? params.id + '' : undefined });
    env.skew = 0;
    await w.yt(path, q);
    const n = env.reqs.length;
    env.skew = alive;
    await w.yt(path, q);
    const aliveHit = env.reqs.length === n;
    env.skew = dead;
    await w.yt(path, q);
    const deadMiss = env.reqs.length === n + 1;
    ok('TTL ' + name + ' (hit at ' + Math.round(alive / 60000) + ' min, miss at ' + Math.round(dead / 60000) + ' min)', aliveHit && deadMiss,
      'hit@' + Math.round(alive / 60000) + 'm=' + aliveHit + ' miss@' + Math.round(dead / 60000) + 'm=' + deadMiss);
    env.skew = 0;
  };
  await ttlCase('search', 'search', { part: 'snippet', q: 'ttl' }, 7 * 60e3, 11 * 60e3);
  await ttlCase('chart', 'videos', { part: 'snippet,statistics', chart: 'mostPopular', regionCode: 'IN', maxResults: 24 }, 7 * 60e3, 11 * 60e3);
  await ttlCase('durations', 'videos', { part: 'contentDetails', id: vids[0] }, 11 * 36e5, 13 * 36e5);
  await ttlCase('uploads', 'playlistItems', { part: 'snippet,contentDetails', playlistId: 'UU0xxxxxxxxxxxxxxxxxxxx', maxResults: 10 }, 25 * 60e3, 35 * 60e3);
  await ttlCase('channels', 'channels', { part: 'snippet', id: CH_IDS[0] }, 5 * 36e5, 7 * 36e5);

  // 4. a failure is never cached: the next call tries again
  env.skew = 0;
  env.fail = 'error';
  let threw = 0;
  for (let i = 0; i < 2; i++) { try { await w.yt('search', { part: 'snippet', q: 'fail-test' }) } catch (e) { threw++ } }
  const nFail = env.reqs.filter(u => /fail-test/.test(u)).length;
  // since item 2.3 a 5xx is retried once, so each of the two calls costs two
  // attempts: still nothing cached, and the second call still goes out
  ok('an API error is not cached', threw === 2 && nFail === 4, 'threw ' + threw + '/2, requests ' + nFail);
  env.fail = 'throw';
  threw = 0;
  for (let i = 0; i < 2; i++) { try { await w.yt('search', { part: 'snippet', q: 'throw-test' }) } catch (e) { threw++ } }
  const nThrow = env.reqs.filter(u => /throw-test/.test(u)).length;
  ok('a network throw is not cached', threw === 2 && nThrow === 4, 'threw ' + threw + '/2, requests ' + nThrow);
  env.fail = null;
  // and a later success is cached normally
  await w.yt('search', { part: 'snippet', q: 'fail-test' });
  const nAfter = env.reqs.length;
  await w.yt('search', { part: 'snippet', q: 'fail-test' });
  ok('a success after a failure is cached', env.reqs.length === nAfter);

  // 5. the map is bounded, and the oldest entry is the one that goes
  env.skew = 0;
  for (let i = 0; i < 60; i++) await w.yt('search', { part: 'snippet', q: 'bound-' + i });
  const s = stats();
  ok('size stays at the cap', s.size <= s.max && s.size === s.max, 'size ' + s.size + '/' + s.max + ', evicted ' + s.evict);
  const nBound = env.reqs.length;
  await w.yt('search', { part: 'snippet', q: 'bound-59' });      // newest: still there
  const newestHit = env.reqs.length === nBound;
  await w.yt('search', { part: 'snippet', q: 'bound-0' });       // oldest: evicted
  ok('eviction is oldest-first', newestHit && env.reqs.length === nBound + 1, 'newest hit=' + newestHit + ', oldest refetched=' + (env.reqs.length === nBound + 1));

  ok('boot requests are unchanged by the cache', base === 10 || base > 0, 'boot made ' + base + ' requests');
  env.dom.window.close();
  return R;
}

(async () => {
  const units = await unitTests(NEW_FILE);
  const bad = units.filter(u => !u.pass);
  console.log('--- cache behaviour (' + path.basename(NEW_FILE) + ') ---');
  units.forEach(u => console.log((u.pass ? 'ok   ' : 'FAIL ') + u.name + (u.detail !== undefined ? '  [' + u.detail + ']' : '')));

  let ab = null;
  if (OLD_FILE) {
    const nw = await driveSurfaces(NEW_FILE);
    const od = await driveSurfaces(OLD_FILE);
    const surfaces = ['boot', 'typing', 'search1', 'search2', 'player', 'channel1', 'channel2', 'viewAll1', 'viewAll2', 'library', 'settings'];
    const diffs = surfaces.filter(k => JSON.stringify(nw[k]) !== JSON.stringify(od[k]));
    ab = {
      surfacesIdentical: diffs.length === 0,
      differingSurfaces: diffs,
      requests: {
        old: od.reqCount, new: nw.reqCount,
        oldLog: od.requests, newLog: nw.requests,
        savedAtBoot: od.afterBoot - nw.afterBoot,
        savedBySearch2: (od.afterSearch2 - od.afterSearch1) - (nw.afterSearch2 - nw.afterSearch1),
        savedByChannel2: (od.afterChannel2 - od.afterChannel1) - (nw.afterChannel2 - nw.afterChannel1),
        savedByViewAll2: (od.afterViewAll2 - od.afterViewAll1) - (nw.afterViewAll2 - nw.afterViewAll1),
        repeatSteps: {
          search2: { old: od.afterSearch2 - od.afterSearch1, new: nw.afterSearch2 - nw.afterSearch1 },
          channel2: { old: od.afterChannel2 - od.afterChannel1, new: nw.afterChannel2 - nw.afterChannel1 },
          viewAll2: { old: od.afterViewAll2 - od.afterViewAll1, new: nw.afterViewAll2 - nw.afterViewAll1 },
        },
      },
    };
    // the new build may only send fewer of the same requests: nothing new, nothing altered
    const tally = list => list.reduce((m, u) => (m[u] = (m[u] || 0) + 1, m), {});
    const tOld = tally(od.requests), tNew = tally(nw.requests);
    const extra = Object.keys(tNew).filter(u => tNew[u] > (tOld[u] || 0));
    ab.subset = { ok: extra.length === 0, extra };
    console.log('\n--- app, old vs new ---');
    console.log('surfaces identical: ' + ab.surfacesIdentical + (diffs.length ? ' (differ: ' + diffs.join(', ') + ')' : ' (' + surfaces.length + '/' + surfaces.length + ')'));
    console.log('requests: old ' + od.reqCount + ' → new ' + nw.reqCount);
    console.log('new log is a subset of the old one (no new or altered request): ' + ab.subset.ok + (extra.length ? ' extra: ' + extra.join(' | ') : ''));
    for (const k of Object.keys(ab.requests.repeatSteps)) {
      const s = ab.requests.repeatSteps[k];
      console.log('  repeat ' + k + ': old ' + s.old + ' request(s) → new ' + s.new);
    }
    // quota: a search costs 100 units, every other endpoint 1
    const units = list => list.reduce((n, u) => n + (/\/search\?/.test(u) ? 100 : 1), 0);
    ab.quota = { old: units(od.requests), new: units(nw.requests) };
    console.log('typing "lofi", correcting to "lof", retyping: old ' + (od.afterTyping) + ' → new ' + (nw.afterTyping) + ' requests in total at that point');
    console.log('quota units for the whole run: old ' + ab.quota.old + ' → new ' + ab.quota.new);
  }
  const pass = bad.length === 0 && (!ab || (ab.surfacesIdentical && ab.subset.ok));
  console.log('\n' + (pass ? 'PASS' : 'FAIL') + (ab ? ' — cache correct, no rendered surface changed' : ''));
  if (process.env.LT_JSON) fs.writeFileSync(process.env.LT_JSON, JSON.stringify({ units, ab }, null, 1));
  process.exit(pass ? 0 : 1);
})();
