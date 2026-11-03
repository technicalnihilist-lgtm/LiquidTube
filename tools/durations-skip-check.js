#!/usr/bin/env node
/*
 * LiquidTube duration-lookup check — proves item 2.6: a list whose items all
 * already have a duration costs no duration request, and an item the API has
 * already answered about without a duration is never asked about again.
 *
 * What is checked, all in jsdom with googleapis.com answered from fixed
 * fixtures — no network, no device, deterministic:
 *
 *  1. dropShorts() on a list that already holds every duration sends nothing
 *     (no request, and the call itself is skipped, not just its body).
 *  2. A warm start (the feed cache, which carries `dur`) sends no duration
 *     request at all.
 *  3. The channel sheet, opened twice, with two videos in the playlist the API
 *     never gives a duration for: one duration request, not one per open.
 *  4. The same query searched twice with two such videos in the results: one
 *     duration request, not two.
 *  5. A failed duration request marks nothing, so the next list asks again
 *     (retry-on-failure is not lost).
 *  6. The set of ids already answered is bounded.
 *  7. A duplicated id in a list is asked for once.
 *  8. Old build vs new: identical rendered surfaces (feed, channel sheet,
 *     search results) and no request that the old build did not also make.
 *
 *   npm i jsdom
 *   node tools/durations-skip-check.js app/assets/index.html /tmp/old/index.html
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
const TREND = Array.from({ length: 24 }, (_, i) => 't' + pad(i + 1) + 'AAAAAAAA');
const UPLOADS = Array.from({ length: 12 }, (_, i) => 'c' + pad(i + 1) + 'BBBBBBBB');
const HITS = Array.from({ length: 20 }, (_, i) => 's' + pad(i + 1) + 'CCCCCCCC');
const CH_IDS = Array.from({ length: 6 }, (_, i) => 'UC' + i + 'xxxxxxxxxxxxxxxxxxxx');
const pub = d => new Date(Date.UTC(2026, 9, 31) - d * 864e5).toISOString();
const title = (p, i) => p + ' video number ' + (i + 1) + ' with a realistic long title';

function fixtures() {
  return {
    trending: {
      items: TREND.map((id, i) => ({
        id,
        snippet: {
          title: title('Trending', i),
          channelTitle: 'Channel ' + (i % 6),
          channelId: CH_IDS[i % 6],
          publishedAt: pub(i + 1),
          categoryId: ['10', '20', '24', '25', '27', '17'][i % 6],
          thumbnails: { maxres: { url: 'https://i.ytimg.com/vi/' + id + '/maxresdefault.jpg' } },
        },
        statistics: { viewCount: String(1000 * (i + 1) * 7) },
      })),
    },
    channels: {
      items: CH_IDS.map((id, i) => ({
        id,
        snippet: {
          title: 'Channel ' + i,
          customUrl: 'channel' + i,
          publishedAt: '2015-04-02T10:00:00Z',
          country: ['IN', 'US', 'JP', 'DE', 'BR', 'FR'][i],
          description: 'A sample channel.',
          thumbnails: { medium: { url: 'https://yt3.ggpht.com/av' + i + '.jpg' } },
        },
        statistics: { subscriberCount: '1200000', videoCount: '480', viewCount: '91000000' },
        contentDetails: { relatedPlaylists: { uploads: 'UU' + i + 'xxxxxxxxxxxxxxxxxxxx' } },
        brandingSettings: { image: { bannerExternalUrl: '' }, channel: {} },
      })),
    },
  };
}

/* The API answers a `channels` call with the ids it was asked for, and with an
   empty `items` for an id it does not know. */
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

/* A response for `videos?part=contentDetails`: one entry per id the API is
   willing to describe, and nothing at all for the ids in env.dead — which is
   what it does for a video deleted or made private after it was listed. */
function durationsAnswer(env, want) {
  return { items: want.filter(id => !env.dead.has(id)).map(id => ({ id, contentDetails: { duration: 'PT12M30S' } })) };
}

/* Every playlist and every query has its own videos, as the real endpoint does:
   a playlist id hashes to its own set of uploads and a query to its own results,
   so a list is only ever measured once it is actually shown. */
const setFor = (tag, n, pad2) => Array.from({ length: n }, (_, i) => tag + pad2(i + 1) + 'DDDDDDDD');
const hashOf = t => { let h = 0; for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) >>> 0; return h; };
function uploadsFor(playlistId) {
  const tag = 'u' + String(hashOf('p' + playlistId) % 100000).padStart(5, '0');
  return {
    items: setFor(tag, 12, pad).map((id, i) => ({
      snippet: { title: title('Upload', i), resourceId: { videoId: id }, publishedAt: pub(i * 24) },
      contentDetails: { videoPublishedAt: pub(i * 24) },
    })),
  };
}
function searchFor(q) {
  const tag = 'q' + String(hashOf('s' + q) % 100000).padStart(5, '0');
  return {
    items: setFor(tag, 20, pad).map((id, i) => ({
      id: { videoId: id },
      snippet: {
        title: title('Result', i) + ' &amp; more',
        channelTitle: 'Channel ' + (i % 6),
        channelId: CH_IDS[i % 6],
        publishedAt: pub(i * 24),
      },
    })),
  };
}

function apiBody(env, url) {
  const u = new URL(url), p = u.pathname, F = env.F;
  if (p.endsWith('/videos')) {
    if ((u.searchParams.get('part') || '').includes('contentDetails')) {
      return durationsAnswer(env, String(u.searchParams.get('id') || '').split(',').filter(Boolean));
    }
    return F.trending;
  }
  if (p.endsWith('/channels')) return chanAnswer(u, F.channels);
  if (p.endsWith('/playlistItems')) return uploadsFor(u.searchParams.get('playlistId') || '');
  if (p.endsWith('/search')) return searchFor(u.searchParams.get('q') || '');
  return {};
}

const isDurReq = u => /\/videos\?/.test(u) && /part=contentDetails/.test(u);

/* one page: fresh window, fresh localStorage (optionally pre-seeded), a fetch
   that answers from the fixtures. */
function open(file, seed) {
  const HTML = fs.readFileSync(file, 'utf8');
  const env = { reqs: [], dead: new Set(), failDur: 0, F: fixtures(), errors: [] };
  const mockFetch = async u => {
    u = String(u);
    env.reqs.push(u.replace(/([?&])key=[^&]*/, '$1key=<key>'));
    if (isDurReq(u) && env.failDur > 0) {
      env.failDur--;
      throw new Error('network down');
    }
    return { ok: true, status: 200, json: async () => apiBody(env, u) };
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
      w.console.error = (...a) => { env.errors.push(a.join(' ')); };
      if (seed) { try { Object.keys(seed).forEach(k => w.localStorage.setItem(k, seed[k])); } catch (e) {} }
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
const snap = (env, sel) => norm((env.d.querySelector(sel) || {}).innerHTML || '');
const durReqs = env => env.reqs.filter(isDurReq);
const durIds = u => new URL(u).searchParams.get('id').split(',');

async function boot(env) {
  await waitFor(() => env.d.querySelectorAll('#feed .card').length > 0);
  await waitFor(() => !env.d.querySelector('#ex .skl'));
  await sleep(250);
}
async function openChan(env, i) {
  const before = env.reqs.length;
  env.w.openChannel(CH_IDS[i]);
  await waitFor(() => env.d.querySelector('#chlist .card') || env.d.querySelector('#chlist .empty'));
  await sleep(150);
  return env.reqs.length - before;
}
async function search(env, q) {
  env.d.getElementById('q').value = q;
  env.w.find();
  await waitFor(() => env.d.querySelector('#results .card') || env.d.querySelector('#results .empty'));
  await sleep(150);
}

/* ---------- assertions ---------- */
let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (extra === undefined ? '' : '  (' + extra + ')')); }
}

async function main() {
  /* ---------- the new build ---------- */
  console.log('# new build: ' + NEW_FILE);
  const env = open(NEW_FILE);
  await boot(env);
  ok(env.d.querySelectorAll('#feed .card').length > 0, 'boot renders the feed');
  const feedSnap = snap(env, '#feed');
  const bootDur = durReqs(env).length;
  /* the feed and each Explore shelf is its own list, so a cold boot asks once
     per list that has unknown items — never twice for the same id */
  ok(bootDur >= 1, 'a cold boot asks for durations, once per list shown', bootDur);
  const allAsked = [].concat(...durReqs(env).map(durIds));
  ok(new Set(allAsked).size === allAsked.length, 'and no id is asked for twice across those lists', allAsked.length + ' ids');
  ok(env.w.__ltDurations().calls === bootDur, '__ltDurations().calls matches the request count', JSON.stringify(env.w.__ltDurations()));

  /* --- 1. a list that already has every duration sends nothing --- */
  console.log('\n## 1. list already measured');
  {
    const n0 = env.reqs.length, st0 = env.w.__ltDurations();
    const out = await env.w.dropShorts([
      { id: 'a1', t: 'Long one', dur: 900 },
      { id: 'a2', t: 'Long two', dur: 3600 },
    ]);
    const st1 = env.w.__ltDurations();
    ok(env.reqs.length === n0, 'no request at all', env.reqs.length - n0);
    ok(st1.calls === st0.calls, 'loadDurations was not entered', st1.calls - st0.calls);
    ok(st1.skipped === st0.skipped + 1, 'counted as skipped', st1.skipped - st0.skipped);
    ok(out.length === 2, 'and both items are still returned', out.length);
  }
  /* a short one is still dropped without asking anything */
  {
    const n0 = env.reqs.length;
    const out = await env.w.dropShorts([
      { id: 'a1', t: 'Long one', dur: 900 },
      { id: 'a3', t: 'Short one', dur: 30 },
    ]);
    ok(env.reqs.length === n0, 'a known short is dropped with no request', env.reqs.length - n0);
    ok(out.length === 1 && out[0].id === 'a1', 'and only the long one survives', out.map(v => v.id).join(','));
  }

  /* --- 2. a warm start sends no duration request --- */
  console.log('\n## 2. warm start (feed cache carries dur)');
  {
    const cache = {};
    for (let i = 0; i < env.w.localStorage.length; i++) {
      const k = env.w.localStorage.key(i);
      cache[k] = env.w.localStorage.getItem(k);
    }
    ok(!!cache.lt_feed, 'the feed cache exists', Object.keys(cache).join(','));
    const warm = open(NEW_FILE, cache);
    await boot(warm);
    ok(warm.d.querySelectorAll('#feed .card').length > 0, 'warm boot paints cards from the cache');
    const asked = [].concat(...durReqs(warm).map(durIds));
    const trend = asked.filter(id => TREND.includes(id));
    ok(trend.length === 0, 'and asks for no duration for a feed item (all 24 carry one)', trend.length);
    ok(warm.w.__ltDurations().skipped >= 1, 'the feed list is skipped, not asked',
      JSON.stringify(warm.w.__ltDurations()) + ' asked ' + asked.length);
    warm.dom.window.close();
  }

  /* --- 3. the channel sheet, opened twice, with two unmeasurable videos --- */
  console.log('\n## 3. channel sheet opened twice (2 videos the API never measures)');
  let chanSnap = '';
  {
    const up0 = setFor('u' + String(hashOf('p' + ('UU' + CH_IDS[0].slice(2))) % 100000).padStart(5, '0'), 12, pad);
    env.dead.add(up0[3]);
    env.dead.add(up0[7]);
    const n0 = durReqs(env).length;
    await openChan(env, 0);
    chanSnap = snap(env, '#chlist');
    const after1 = durReqs(env).length;
    ok(after1 === n0 + 1, 'the first open asks once', after1 - n0);
    const asked = durIds(durReqs(env)[durReqs(env).length - 1]).sort();
    ok(asked.length === 12 && up0.every(id => asked.includes(id)),
      'asking for the whole upload list (10 of them come back measured)', asked.length);
    ok(env.w.__ltDurations().known === 2, 'both are remembered as unmeasurable', env.w.__ltDurations().known);
    ok(env.d.querySelectorAll('#chlist .card').length === 12, 'all 12 uploads are rendered', env.d.querySelectorAll('#chlist .card').length);

    const sent = await openChan(env, 0);
    const after2 = durReqs(env).length;
    ok(after2 === after1, 'the second open asks nothing at all', after2 - after1);
    ok(sent === 0, 'and sends no request of any kind (playlist cached)', sent);
    ok(snap(env, '#chlist') === chanSnap, 'the sheet renders byte-identically on the second open');
  }

  /* --- 4. the same query twice, with two unmeasurable results --- */
  console.log('\n## 4. the same search twice (2 unmeasurable results)');
  {
    const q0 = setFor('q' + String(hashOf('s' + 'lofi beats') % 100000).padStart(5, '0'), 20, pad);
    env.dead.add(q0[5]);
    env.dead.add(q0[9]);
    const n0 = durReqs(env).length;
    await search(env, 'lofi beats');
    const after1 = durReqs(env).length;
    ok(after1 === n0 + 1, 'the first search asks once', after1 - n0);
    const asked = durIds(durReqs(env)[durReqs(env).length - 1]).sort();
    ok(asked.length === 20 && q0.every(id => asked.includes(id)),
      'asking for the whole result list (18 of them come back measured)', asked.length);
    await search(env, 'lofi beats');
    const after2 = durReqs(env).length;
    ok(after2 === after1, 'the repeat asks nothing', after2 - after1);
    ok(env.d.querySelectorAll('#results .card').length === 20, 'all 20 results are still rendered', env.d.querySelectorAll('#results .card').length);
  }
  /* the app-driven run so far: the two builds are compared over exactly these
     actions, before the synthetic calls below */
  const appNew = env.reqs.slice(), appNewDur = durReqs(env).length;

  /* --- 5. a failed request marks nothing, so the next list asks again --- */
  console.log('\n## 5. a failed duration request is retried');
  {
    const dead = 'zzDEADFAIL000000001';
    env.dead.add(dead);
    env.failDur = 2;                       /* both attempts of the request fail */
    const before = env.w.__ltDurations();
    await env.w.dropShorts([{ id: dead, t: 'Long', dur: null }]);
    const mid = env.w.__ltDurations();
    ok(mid.calls === before.calls + 1, 'one loadDurations call', mid.calls - before.calls);
    ok(mid.known === before.known, 'nothing marked from a failure', mid.known - before.known);
    await env.w.dropShorts([{ id: dead, t: 'Long', dur: null }]);
    const after = env.w.__ltDurations();
    ok(after.calls === mid.calls + 1, 'the next list asks again', after.calls - mid.calls);
    ok(after.known === mid.known + 1, 'and this time the answer is remembered', after.known - mid.known);
    await env.w.dropShorts([{ id: dead, t: 'Long', dur: null }]);
    ok(env.w.__ltDurations().calls === after.calls, 'and then it is never asked again', env.w.__ltDurations().calls - after.calls);
  }

  /* --- 6. the remembered set is bounded --- */
  console.log('\n## 6. bounded');
  {
    for (let g = 0; g < 6; g++) {
      const list = Array.from({ length: 50 }, (_, i) => ({ id: 'bulk' + g + '-' + pad(i), t: 'Long', dur: null }));
      list.forEach(v => env.dead.add(v.id));
      await env.w.loadDurations(list);
    }
    const st = env.w.__ltDurations();
    ok(st.known === 200, 'the set stops at 200 ids', st.known);
    ok(st.none >= 300, 'while every unmeasurable id was still counted', st.none);
  }

  /* --- 7. a duplicated id is asked for once --- */
  console.log('\n## 7. duplicated ids');
  {
    const n0 = env.reqs.length;
    await env.w.loadDurations([
      { id: 'dupAAAAAAAAAAAAAAA1', t: 'A', dur: null },
      { id: 'dupAAAAAAAAAAAAAAA1', t: 'A', dur: null },
      { id: 'dupAAAAAAAAAAAAAAA1', t: 'A', dur: null },
      { id: 'dupAAAAAAAAAAAAAAA2', t: 'B', dur: null },
    ]);
    const asked = durIds(durReqs(env)[durReqs(env).length - 1]);
    ok(env.reqs.length === n0 + 1, 'one request', env.reqs.length - n0);
    ok(asked.join(',') === 'dupAAAAAAAAAAAAAAA1,dupAAAAAAAAAAAAAAA2', 'with each id once', asked.join(','));
  }

  /* --- 8. an item with no id is not asked about --- */
  console.log('\n## 8. no id');
  {
    const n0 = env.reqs.length;
    await env.w.loadDurations([{ t: 'no id here', dur: null }, { id: '', t: 'empty id', dur: null }]);
    ok(env.reqs.length === n0, 'a missing id never reaches the URL', env.reqs.length - n0);
  }

  const newSnaps = { feed: feedSnap, chlist: chanSnap, results: snap(env, '#results') };
  ok(env.errors.length === 0, 'no console errors', env.errors.slice(0, 2).join(' | '));

  /* ---------- the old build, same script ---------- */
  if (!OLD_FILE) {
    console.log('\n# no previous build given: A/B half skipped');
  } else {
    console.log('\n# old build: ' + OLD_FILE);
    const old = open(OLD_FILE);
    await boot(old);
    ok(old.w.__ltDurations === undefined, 'the old build has no duration counters (as expected)');
    const oldBoot = durReqs(old).length;
    console.log('  old cold boot duration requests: ' + oldBoot + ', new ' + bootDur);
    const oldFeedSnap = snap(old, '#feed');

    /* the same dead videos, the same two opens */
    const oup0 = setFor('u' + String(hashOf('p' + ('UU' + CH_IDS[0].slice(2))) % 100000).padStart(5, '0'), 12, pad);
    old.dead.add(oup0[3]);
    old.dead.add(oup0[7]);
    const o0 = durReqs(old).length;
    await openChan(old, 0);
    const o1 = durReqs(old).length;
    const oldChanSnap = snap(old, '#chlist');
    await openChan(old, 0);
    const o2 = durReqs(old).length;
    ok(o2 - o1 === 1, 'old build: the second open asks again', o2 - o1);
    console.log('  channel sheet opened twice: old ' + (o2 - o0) + ' duration requests, new 1');

    const oq0 = setFor('q' + String(hashOf('s' + 'lofi beats') % 100000).padStart(5, '0'), 20, pad);
    old.dead.add(oq0[5]);
    old.dead.add(oq0[9]);
    const s0 = durReqs(old).length;
    await search(old, 'lofi beats');
    const s1 = durReqs(old).length;
    await search(old, 'lofi beats');
    const s2 = durReqs(old).length;
    console.log('  same query searched twice: old ' + (s2 - s0) + ' duration requests, new 1');
    ok(s1 - s0 === 1 && s2 - s1 === 1, 'old build: the repeat search asks again', (s2 - s0));

    const appOld = old.reqs.slice(), appOldDur = durReqs(old).length;

    ok(oldChanSnap === newSnaps.chlist, 'channel sheet markup is byte-identical to the old build');
    ok(snap(old, '#results') === newSnaps.results, 'search results markup is byte-identical');
    ok(oldFeedSnap === newSnaps.feed, 'feed markup is byte-identical');

    /* no request the old build did not also make, in the same order */
    let i = 0;
    const extra = [];
    for (const u of appNew) {
      const j = appOld.indexOf(u, i);
      if (j === -1) extra.push(u); else i = j + 1;
    }
    ok(extra.length === 0, 'every new-build request also went out in the old build, same order', extra.slice(0, 3).join(' | '));
    ok(appNewDur < appOldDur, 'new build sends fewer duration requests over the same actions',
      appNewDur + ' vs ' + appOldDur);
    console.log('\n  same actions, duration requests: old ' + appOldDur + ', new ' + appNewDur);
    console.log('  same actions, all requests: old ' + appOld.length + ', new ' + appNew.length);
    old.dom.window.close();
  }

  console.log('\n' + pass + '/' + (pass + fail) + ' assertions passed');
  env.dom.window.close();
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
