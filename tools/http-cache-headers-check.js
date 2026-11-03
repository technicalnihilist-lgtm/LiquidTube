#!/usr/bin/env node
/*
 * LiquidTube HTTP cache-header check — proves item 2.4: a caching header on a
 * response is honoured, and a response with none (which is what the live
 * endpoint sends) behaves exactly as it did before.
 *
 * What is checked, all in jsdom with googleapis.com answered from fixed
 * fixtures — no network, no device, deterministic:
 *
 *  1. The header reader, through yt() on the loaded page: max-age, s-maxage,
 *     Age, Expires/Date, Pragma, no-store and no-cache each move the entry's
 *     window the way HTTP says they should; a header can only shorten the
 *     endpoint table's window, never extend it; a malformed value is ignored;
 *     a response with no Headers object at all falls back to the table.
 *  2. The exact header set the live endpoint returns today (no caching header,
 *     and CORS exposing only vary, content-encoding, date, server and
 *     content-length) changes nothing: same TTLs, same hits, same requests.
 *  3. The old build and the new one driven through the app side by side with
 *     those live headers: identical request log, identical rendered surfaces.
 *  4. The cost of the reader on the boot path.
 *
 *   npm i jsdom
 *   node tools/http-cache-headers-check.js app/assets/index.html /tmp/old/index.html
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

/* A Headers look-alike: case-insensitive get, like the real one. */
function hdrs(obj) {
  const m = {};
  Object.keys(obj || {}).forEach(k => { m[k.toLowerCase()] = String(obj[k]); });
  return { get(k) { const v = m[String(k).toLowerCase()]; return v === undefined ? null : v; }, _m: m };
}

/* The header set the live endpoint answers with today, recorded from
   https://www.googleapis.com/youtube/v3/videos?... with an Origin header:
     content-type: application/json; charset=UTF-8
     vary: Origin / X-Origin / Referer
     content-encoding: gzip
     date: <now>
     server: scaffolding on HTTPServer2
     content-length: 1699
     access-control-allow-origin: https://liquidtube.local
     access-control-expose-headers: vary,vary,vary,content-encoding,date,server,content-length
   i.e. nothing about caching, and nothing about caching readable by JS. */
function liveHeaders() {
  return hdrs({
    'content-type': 'application/json; charset=UTF-8',
    vary: 'Origin',
    'content-encoding': 'gzip',
    date: new Date().toUTCString(),
    server: 'scaffolding on HTTPServer2',
    'content-length': '1699',
    'access-control-allow-origin': 'https://liquidtube.local',
    'access-control-expose-headers': 'vary,vary,vary,content-encoding,date,server,content-length',
  });
}

/* one page: fresh window, fresh localStorage, a fetch that answers from the
   fixtures and attaches whatever headers the current test asked for. */
function open(file) {
  const HTML = fs.readFileSync(file, 'utf8');
  const env = { reqs: [], hdr: liveHeaders(), headersMode: 'live', fail: null, skew: 0 };
  const mockFetch = async u => {
    u = String(u);
    env.reqs.push(u.replace(/([?&])key=[^&]*/, '$1key=<key>'));
    if (env.fail === 'throw') throw new Error('network down');
    if (env.fail === 'error') {
      const h = typeof env.hdr === 'function' ? env.hdr() : env.hdr;
      return { ok: false, status: 500, headers: h, json: async () => ({ error: { message: 'The request cannot be completed because you have exceeded your quota.' } }) };
    }
    const j = apiBody(u);
    const h = typeof env.hdr === 'function' ? env.hdr() : env.hdr;
    const r = { ok: true, status: 200, json: async () => j };
    if (h) r.headers = h;                    /* undefined = the old mock shape: no Headers at all */
    return r;
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
      w.Date.now = () => Date.now() + env.skew;   /* lets a test age the cache */
    },
  });
  env.w = dom.window;
  env.d = dom.window.document;
  env.dom = dom;
  return env;
}
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
    .replace(/ class="ld"/g, '').replace(/ ld"/g, '')
    .replace(/ data-f="1"/g, '')
    .replace(/ ?(?:transform|opacity|background-position-y):[^;"']*;?/g, '')
    .replace(/style="\s*"/g, '').replace(/\s{2,}/g, ' ').trim();
}
const snap = (env, sel, all) => all
  ? [...env.d.querySelectorAll(sel)].map(e => norm(e.outerHTML))
  : norm((env.d.querySelector(sel) || {}).innerHTML || '');

/* ---------- assertions ---------- */
let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (extra === undefined ? '' : '  (' + extra + ')')); }
}
const TTL = { search: 600e3, chart: 600e3, uploads: 1800e3, channel: 21600e3, dur: 43200e3 };

/* Drive one call and report the entry's TTL as the cache stored it. We read it
   back through the cache itself: a second call at +0 must hit (0 requests) and
   the same call at an age the test picks must miss (1 request), which is the
   only thing the app actually promises. */
async function window_ (env, path, params, headerFn, ages) {
  env.hdr = headerFn;
  const base = env.reqs.length;
  await env.w.yt(path, params);
  const afterFirst = env.reqs.length - base;
  const out = { first: afterFirst, hits: [], misses: [] };
  for (const age of ages) {
    env.skew = age;
    const before = env.reqs.length;
    await env.w.yt(path, params);
    const sent = env.reqs.length - before;
    if (sent === 0) out.hits.push(age); else out.misses.push(age);
  }
  env.skew = 0;
  return out;
}

async function main() {
  const env = open(NEW_FILE);
  await waitFor(() => env.d.querySelectorAll('#feed .card').length > 0);
  await waitFor(() => !env.d.querySelector('#ex .skl'));
  await sleep(300);
  console.log('\n# boot done, ' + env.reqs.length + ' requests, cache ' + JSON.stringify(env.w.__ltReqCache()));

  let n = 0;
  const uniq = () => 'hdr-probe-' + (++n);
  const S = () => ({ q: uniq(), part: 'snippet', type: 'video' });
  const C = () => ({ part: 'snippet', id: uniq() });
  const U = () => ({ part: 'snippet', playlistId: uniq() });

  /* --- 1. the live header set says nothing: the endpoint table decides --- */
  console.log('\n## live headers (no caching header, none exposed)');
  {
    const st0 = env.w.__ltReqCache();
    const r = await window_(env, 'search', S(), liveHeaders, [0, 540e3, 660e3]);
    ok(r.first === 1, 'search with live headers is fetched once', r.first);
    ok(r.hits.length === 2 && r.hits[0] === 0 && r.hits[1] === 540e3, 'still a hit at +0 and at +9 min (10 min window kept)', JSON.stringify(r));
    ok(r.misses.length === 1 && r.misses[0] === 660e3, 'a miss at +11 min', JSON.stringify(r));
    const st1 = env.w.__ltReqCache();
    ok(st1.hdr === st0.hdr && st1.keep === st0.keep, 'no header-derived window, nothing dropped', JSON.stringify([st0, st1]));
    ok(st1.hit > st0.hit, 'and it was served from the cache', st1.hit - st0.hit);
  }

  /* --- 2. max-age shortens --- */
  console.log('\n## Cache-Control: max-age');
  {
    const r = await window_(env, 'search', S(), () => hdrs({ 'cache-control': 'public, max-age=2' }), [0, 1500, 2500]);
    ok(r.hits.includes(0) && r.hits.includes(1500) && r.misses.includes(2500), 'max-age=2 wins over the 10 min table', JSON.stringify(r));
  }
  {
    const r = await window_(env, 'channels', C(), () => hdrs({ 'cache-control': 'max-age=120' }), [0, 60e3, 130e3]);
    ok(r.hits.includes(60e3) && r.misses.includes(130e3), 'max-age=120 shortens a 6 h channel window', JSON.stringify(r));
  }
  /* --- 3. and never lengthens --- */
  {
    const r = await window_(env, 'search', S(), () => hdrs({ 'cache-control': 'max-age=86400' }), [540e3, 660e3]);
    ok(r.hits.includes(540e3) && r.misses.includes(660e3), 'max-age=86400 does NOT extend a search past 10 min', JSON.stringify(r));
  }
  {
    const r = await window_(env, 'channels', C(), () => hdrs({ 'cache-control': 'max-age=86400' }), [5 * 36e5, 7 * 36e5]);
    ok(r.hits.includes(5 * 36e5) && r.misses.includes(7 * 36e5), 'a day-long max-age does NOT extend a channel past 6 h', JSON.stringify(r));
  }
  /* --- 4. s-maxage, when there is no max-age --- */
  {
    const r = await window_(env, 'playlistItems', U(), () => hdrs({ 'cache-control': 's-maxage=120' }), [60e3, 130e3]);
    ok(r.hits.includes(60e3) && r.misses.includes(130e3), 's-maxage=120 is used when max-age is absent', JSON.stringify(r));
  }
  /* --- 5. Age is time already spent --- */
  {
    const r = await window_(env, 'search', S(), () => hdrs({ 'cache-control': 'max-age=600', age: '500' }), [90e3, 110e3]);
    ok(r.hits.includes(90e3) && r.misses.includes(110e3), 'Age: 500 leaves 100 s of a max-age=600', JSON.stringify(r));
  }
  /* --- 6. Expires/Date, for a server that only sends the old pair --- */
  {
    const fn = () => { const now = Date.now() + env.skew; return hdrs({ date: new Date(now).toUTCString(), expires: new Date(now + 30e3).toUTCString() }); };
    const r = await window_(env, 'search', S(), fn, [20e3, 40e3]);
    ok(r.hits.includes(20e3) && r.misses.includes(40e3), 'Expires +30 s gives a 30 s window', JSON.stringify(r));
  }
  {
    const fn = () => { const now = Date.now() + env.skew; return hdrs({ date: new Date(now).toUTCString(), expires: new Date(now - 5e3).toUTCString() }); };
    const r = await window_(env, 'search', S(), fn, [0]);
    ok(r.misses.includes(0), 'an Expires in the past is not kept at all', JSON.stringify(r));
  }
  /* --- 7. do-not-keep --- */
  console.log('\n## do not keep it');
  for (const [label, h] of [
    ['no-store', () => hdrs({ 'cache-control': 'no-store' })],
    ['no-cache', () => hdrs({ 'cache-control': 'no-cache' })],
    ['no-cache beside max-age=600', () => hdrs({ 'cache-control': 'no-cache, max-age=600' })],
    ['max-age=0', () => hdrs({ 'cache-control': 'max-age=0' })],
    ['Pragma: no-cache alone', () => hdrs({ pragma: 'no-cache' })],
  ]) {
    const st0 = env.w.__ltReqCache();
    const r = await window_(env, 'search', S(), h, [0]);
    ok(r.misses.includes(0), label + ': the next call goes out again', JSON.stringify(r));
    const dropped = r.first + r.misses.length;          /* every response here was not kept */
    ok(env.w.__ltReqCache().keep === st0.keep + dropped, label + ': counted as not kept', env.w.__ltReqCache().keep - st0.keep);
  }
  /* --- 8. malformed and absent --- */
  console.log('\n## malformed / absent');
  {
    const r = await window_(env, 'search', S(), () => hdrs({ 'cache-control': 'max-age=abc' }), [540e3, 660e3]);
    ok(r.hits.includes(540e3) && r.misses.includes(660e3), 'max-age=abc is ignored, the table decides', JSON.stringify(r));
  }
  {
    const r = await window_(env, 'search', S(), () => hdrs({ 'cache-control': 'max-age=-5' }), [540e3]);
    ok(r.hits.includes(540e3), 'a negative max-age is ignored', JSON.stringify(r));
  }
  {
    const r = await window_(env, 'search', S(), () => null, [540e3, 660e3]);
    ok(r.hits.includes(540e3) && r.misses.includes(660e3), 'a response with no Headers object falls back to the table', JSON.stringify(r));
  }
  {
    const r = await window_(env, 'videos', { part: 'contentDetails', id: uniq() }, () => hdrs({ 'cache-control': 'max-age=5' }), [3000, 6000]);
    ok(r.hits.includes(3000) && r.misses.includes(6000), 'durations still honour a short max-age', JSON.stringify(r));
  }
  /* --- 9. a failure is still a failure --- */
  console.log('\n## failure path unchanged');
  {
    env.hdr = () => hdrs({ 'cache-control': 'max-age=600' });
    env.fail = 'error';
    const before = env.reqs.length;
    let threw = null;
    try { await env.w.yt('search', S()); } catch (e) { threw = e; }
    const sent = env.reqs.length - before;
    env.fail = null;
    ok(!!threw && /quota/i.test(threw.message), 'a 500 still reaches the caller with the API message', threw && threw.message);
    ok(sent === 2, 'a 500 is still retried exactly once, headers notwithstanding', sent);
    const before2 = env.reqs.length;
    await env.w.yt('search', { q: 'hdr-after-failure', part: 'snippet', type: 'video' });
    ok(env.reqs.length - before2 === 1, 'and nothing from the failure was cached', env.reqs.length - before2);
  }
  /* --- 10. joined callers still share a no-store response --- */
  console.log('\n## joins still work');
  {
    env.hdr = () => hdrs({ 'cache-control': 'no-store' });
    const p = { q: uniq(), part: 'snippet', type: 'video' };
    const before = env.reqs.length;
    const [a, b] = await Promise.all([env.w.yt('search', p), env.w.yt('search', p)]);
    ok(env.reqs.length - before === 1, 'two overlapping callers make one request', env.reqs.length - before);
    ok(a === b, 'and share one response object');
  }

  /* --- 11. what the reader costs --- */
  console.log('\n## cost');
  {
    const fn = env.w.rqHdrFresh, H = liveHeaders();
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < 20000; i++) fn(H, Date.now());
    const per = Number(process.hrtime.bigint() - t0) / 20000 / 1000;
    ok(per < 50, 'rqHdrFresh on the live header set costs ' + per.toFixed(2) + ' µs per response', per);
  }

  /* ---------- A/B: the app, with the live headers, old build vs new ---------- */
  if (OLD_FILE) {
    console.log('\n## A/B against the previous build (live header set)');
    const drive = async file => {
      const e = open(file);
      const out = {};
      await waitFor(() => e.d.querySelectorAll('#feed .card').length > 0);
      await waitFor(() => !e.d.querySelector('#ex .skl'));
      await sleep(400);
      out.boot = { chips: snap(e, '#chips'), feed: snap(e, '#feed .card', 1), ex: snap(e, '#ex'), subs: snap(e, '#sg') };
      out.bootReqs = e.reqs.slice();
      e.d.getElementById('sopen').click();
      await sleep(150);
      const q = e.d.getElementById('q');
      q.value = 'lofi & chill';
      q.dispatchEvent(new e.w.Event('input'));
      await waitFor(() => e.d.querySelectorAll('#results .card').length > 0);
      await sleep(200);
      out.search = snap(e, '#results .card', 1);
      out.searchReqs = e.reqs.slice();
      e.d.getElementById('cancel').click();
      await sleep(150);
      const first = e.d.querySelector('#feed .card');
      if (first) { first.click(); await sleep(300); out.player = snap(e, '#pl'); e.d.getElementById('pclose') && e.d.getElementById('pclose').click(); await sleep(150); }
      out.allReqs = e.reqs.slice();
      out.cache = e.w.__ltReqCache();
      return out;
    };
    const A = await drive(OLD_FILE), B = await drive(NEW_FILE);
    ok(JSON.stringify(A.boot) === JSON.stringify(B.boot), 'boot surfaces identical');
    ok(JSON.stringify(A.search) === JSON.stringify(B.search), 'search results identical');
    ok(JSON.stringify(A.player) === JSON.stringify(B.player), 'player identical');
    // since item 2.5 the channel lookups are cut into groups on the next
    // microtask, so a shelf's channel call can leave after the searches the same
    // tick started — the same requests, in a slightly different order
    const sorted = l => l.slice().sort();
    ok(JSON.stringify(sorted(A.allReqs)) === JSON.stringify(sorted(B.allReqs)), 'the same requests go out (' + A.allReqs.length + ' vs ' + B.allReqs.length + ')');
    ok(A.cache.hit === B.cache.hit && A.cache.miss === B.cache.miss, 'same hits and misses', JSON.stringify([A.cache, B.cache]));
    ok(B.cache.hdr === 0 && B.cache.keep === 0, 'live headers never shorten and never drop', JSON.stringify(B.cache));
  }

  console.log('\n' + pass + '/' + (pass + fail) + ' assertions passed');
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
