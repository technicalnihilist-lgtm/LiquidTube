#!/usr/bin/env node
/*
 * LiquidTube section-cache version check — proves item 4.9 ("clear the
 * shelf/section caches on version change").
 *
 * `lt_anime`, `lt_cartoon` and `lt_movies` hold the three Home sections (Anime,
 * Cartoon, Movies chips): the mapped list, the channel of every card and the
 * time it was written. They are read back for twelve hours and used to carry no
 * build stamp, so a launch right after an update could paint a section written
 * by the previous build — old entries, old card mapping — and skip the request
 * the new code wanted to make. The build under test writes `lt_cver` = CVER at
 * boot, drops the three section keys when the stamp it finds is different (a
 * first install: absent), and also stores `v:CVER` inside each section blob and
 * rejects it on read.
 *
 * Everything runs in jsdom with googleapis.com answered from fixtures — no
 * network, no device, deterministic. Per scenario the run reports what the boot
 * did (`purged`, the stamp, the keys left) and what the Anime chip then painted,
 * and whether it had to hit the API to do it:
 *
 *   cold        fresh install: nothing to purge, the stamp is written, the
 *               section is fetched once and cached with v:CVER
 *   same        relaunch of the same build: nothing purged, the cached section
 *               paints with zero API calls and the same titles as the fetch
 *   upgrade     stamp 7.44 + unstamped caches: all three purged, then refetched;
 *               no title from the old cache reaches the screen
 *   nostamp     caches present but no stamp key at all (upgrade where the key
 *               never existed): same purge
 *   wrongver    stamp matches but a section blob carries another v (a storage
 *               that refused the stamp write): the blob is ignored on read
 *   keep        the saved library, the last feed and the quota meter survive the
 *               purge and still paint after it
 *   errors      no console error and no unhandled rejection in any scenario
 *
 * Usage:
 *   npm i jsdom                              # dev only, not shipped in the APK
 *   node tools/cache-version-check.js app/assets/index.html [previous-build.html]
 * Exit code 1 when the build under test fails any check.
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const NEW_FILE = process.argv[2] || path.join(__dirname, '..', 'app/assets/index.html');
const OLD_FILE = process.argv[3] || '';
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
function ok(cond, what, detail) {
  if (cond) { pass++; console.log('  PASS  ' + what); }
  else { fail++; console.log('  FAIL  ' + what + (detail !== undefined ? '   [' + detail + ']' : '')); }
}
const pad = n => String(n).padStart(2, '0');
const pub = d => new Date(Date.UTC(2026, 9, 31) - d * 864e5).toISOString();
const CH_IDS = Array.from({ length: 6 }, (_, i) => 'UC' + i + 'xxxxxxxxxxxxxxxxxxxx');
const TREND = Array.from({ length: 24 }, (_, i) => 't' + pad(i + 1) + 'AAAAAAAA');
const OLD_TITLES = ['OLD CACHE ITEM one', 'OLD CACHE ITEM two', 'OLD CACHE ITEM three'];

const fixtures = () => ({
  trending: {
    items: TREND.map((id, i) => ({
      id,
      snippet: {
        title: 'Trending video number ' + (i + 1) + ' — लिक्विड',
        channelTitle: 'Channel ' + (i % 6),
        channelId: CH_IDS[i % 6],
        publishedAt: pub(i + 1),
        categoryId: ['10', '20', '24', '25', '27', '17'][i % 6],
      },
      statistics: { viewCount: String(1000 * (i + 1) * 7) },
    })),
  },
  channels: {
    items: CH_IDS.map((id, i) => ({
      id,
      snippet: { title: 'Channel ' + i, customUrl: 'channel' + i, publishedAt: '2015-04-02T10:00:00Z', country: 'IN', description: 'A sample channel.' },
      statistics: { subscriberCount: '1200000', videoCount: '480', viewCount: '91000000' },
      contentDetails: { relatedPlaylists: { uploads: 'UU' + i + 'xxxxxxxxxxxxxxxxxxxx' } },
      brandingSettings: { image: { bannerExternalUrl: '' }, channel: {} },
    })),
  },
});

const hashOf = t => { let h = 0; for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) >>> 0; return h; };
const setFor = (tag, n) => Array.from({ length: n }, (_, i) => tag + pad(i + 1) + 'DDDDDDDD');

function apiBody(env, url) {
  const u = new URL(url), p = u.pathname, F = env.F;
  if (p.endsWith('/videos')) {
    if ((u.searchParams.get('part') || '').includes('contentDetails')) {
      const want = String(u.searchParams.get('id') || '').split(',').filter(Boolean);
      return { items: want.map(id => ({ id, contentDetails: { duration: 'PT12M30S' } })) };
    }
    return F.trending;
  }
  if (p.endsWith('/channels')) {
    const want = String(u.searchParams.get('id') || '').split(',').filter(Boolean);
    const have = new Map(F.channels.items.map(c => [c.id, c]));
    return { items: want.map(id => have.get(id) || {
      id,
      snippet: { title: 'Channel ' + id.slice(2, 8), customUrl: 'c' + id.slice(2, 8), publishedAt: '2015-04-02T10:00:00Z', country: 'IN', description: 'A sample channel.' },
      statistics: { subscriberCount: '1000', videoCount: '10', viewCount: '10000' },
      contentDetails: { relatedPlaylists: { uploads: 'UU' + id.slice(2) } },
      brandingSettings: { image: { bannerExternalUrl: '' }, channel: {} },
    }) };
  }
  if (p.endsWith('/playlistItems')) {
    const tag = 'u' + String(hashOf('p' + (u.searchParams.get('playlistId') || '')) % 100000).padStart(5, '0');
    return {
      items: setFor(tag, 12).map((id, i) => ({
        snippet: { title: 'Upload video number ' + (i + 1) + ' — लिक्विड', resourceId: { videoId: id }, publishedAt: pub(i * 24) },
        contentDetails: { videoPublishedAt: pub(i * 24) },
      })),
    };
  }
  if (p.endsWith('/search')) {
    const tag = 'q' + String(hashOf('s' + (u.searchParams.get('q') || '')) % 100000).padStart(5, '0');
    return {
      items: setFor(tag, 20).map((id, i) => ({
        id: { videoId: id },
        snippet: { title: 'Result ' + (i + 1) + ' &amp; more', channelTitle: 'Channel ' + (i % 6), channelId: CH_IDS[i % 6], publishedAt: pub(i * 24) },
      })),
    };
  }
  return {};
}

function open(file, seed) {
  const HTML = fs.readFileSync(file, 'utf8');
  const env = { reqs: [], F: fixtures(), errors: [] };
  const mockFetch = async u => {
    u = String(u);
    env.reqs.push(u.replace(/([?&])key=[^&]*/, '$1key=<key>'));
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
const keys = env => { const o = {}; for (let i = 0; i < env.w.localStorage.length; i++) { const k = env.w.localStorage.key(i); o[k] = env.w.localStorage.getItem(k); } return o; };
const decode = (env, key) => env.w.eval('JSON.stringify(loadJSON(localStorage.getItem(' + JSON.stringify(key) + '),null))');
const cacheVer = env => env.w.eval('JSON.stringify(__ltCacheVer())');
const titles = env => Array.from(env.d.querySelectorAll('#feed .card .meta b')).map(b => b.textContent.trim());
const secReqs = env => env.reqs.filter(u => /\/playlistItems|\/search/.test(u));

/* an unstamped section blob, exactly what the previous build wrote */
function oldSection(items, at) {
  return JSON.stringify({ at: at || Date.now(), items });
}
function stampedSection(v, items) {
  return JSON.stringify({ v, at: Date.now(), items });
}
const ITEM = (id, t, ch) => ({ id, t, c: 'Channel 0', ch: ch || CH_IDS[0], pub: pub(3), cat: 'Anime' });

async function chipAnime(env) {
  env.w.eval('chip("Anime")');
  const painted = await waitFor(() => env.d.querySelectorAll('#feed .card').length > 0, 25000);
  await sleep(80);
  return painted;
}

async function main() {
  const base = open(NEW_FILE);
  await waitFor(() => base.d.querySelector('#feed .card'), 25000);
  const CVER = JSON.parse(cacheVer(base)).ver;
  const CKEY = JSON.parse(cacheVer(base)).key;
  console.log('\nsection-cache version under test: ' + CVER + ' (stamp key ' + CKEY + ')');

  /* ---------- 1. cold install ---------- */
  console.log('\n1. cold install — nothing cached, nothing to drop');
  const cold = open(NEW_FILE);
  await waitFor(() => cold.d.querySelectorAll('#feed .card').length >= 20, 25000);
  let cv = JSON.parse(cacheVer(cold));
  ok(cv.purged === 0, 'a first launch purges nothing (no section cache exists)', cv.purged);
  ok(cv.stamp === CVER, 'and writes the stamp: ' + CVER, cv.stamp);
  ok(cv.present.length === 0, 'no section key is left behind', cv.present.join(','));
  ok(await chipAnime(cold), 'the Anime chip paints');
  const coldTitles = titles(cold);
  ok(coldTitles.length > 0, 'with cards (' + coldTitles.length + ')');
  await waitFor(() => cold.w.localStorage.getItem('lt_anime'), 25000);
  const coldSec = JSON.parse(decode(cold, 'lt_anime') || 'null');
  ok(!!coldSec && coldSec.v === CVER, 'the section it wrote carries v:' + CVER, coldSec && coldSec.v);
  ok(secReqs(cold).length > 0, 'and it was fetched from the API (' + secReqs(cold).length + ' calls)');

  /* ---------- 2. same build, relaunch ---------- */
  console.log('\n2. same build relaunch — the cache is kept and still paints');
  const sameSeed = { [CKEY]: CVER, lt_anime: stampedSection(CVER, coldSec.items) };
  const same = open(NEW_FILE, sameSeed);
  await waitFor(() => same.d.querySelectorAll('#feed .card').length >= 20, 25000);
  cv = JSON.parse(cacheVer(same));
  ok(cv.purged === 0, 'nothing is purged', cv.purged);
  ok(cv.present.join() === 'lt_anime', 'the section cache survives', cv.present.join(','));
  const before = secReqs(same).length;
  ok(await chipAnime(same), 'the Anime chip paints');
  ok(secReqs(same).length === before, 'with no section request at all (' + (secReqs(same).length - before) + ' sent)');
  const sameTitles = titles(same);
  ok(sameTitles.length === coldTitles.length, 'and the same number of cards as the fetch (' + sameTitles.length + ' vs ' + coldTitles.length + ')');
  ok(sameTitles.every((t, i) => t === coldTitles[i]), 'with the same titles in the same order');
  ok(JSON.parse(cacheVer(same)).stamp === CVER, 'the stamp is left as it was');

  /* ---------- 3. upgrade from another version ---------- */
  console.log('\n3. upgrade — a section written by another build is dropped');
  const oldItems = OLD_TITLES.map((t, i) => ITEM('o' + pad(i) + 'AAAAAAAA', t));
  const upgrade = open(NEW_FILE, {
    [CKEY]: '7.44',
    lt_anime: oldSection(oldItems),
    lt_cartoon: oldSection(oldItems),
    lt_movies: oldSection(oldItems),
  });
  await waitFor(() => upgrade.d.querySelectorAll('#feed .card').length >= 20, 25000);
  cv = JSON.parse(cacheVer(upgrade));
  ok(cv.purged === 3, 'all three section keys are purged', cv.purged);
  ok(cv.present.length === 0, 'and none is left in storage', cv.present.join(','));
  ok(cv.stamp === CVER, 'the stamp moves to ' + CVER, cv.stamp);
  const upKeys = keys(upgrade);
  ok(!upKeys.lt_anime && !upKeys.lt_cartoon && !upKeys.lt_movies, 'the three keys are gone from localStorage', Object.keys(upKeys).join(','));
  ok(await chipAnime(upgrade), 'the Anime chip still paints after the purge');
  const upTitles = titles(upgrade);
  ok(upTitles.length > 0 && !upTitles.some(t => /OLD CACHE ITEM/.test(t)), 'no title from the old cache reaches the screen', upTitles.slice(0, 2).join(' | '));
  ok(secReqs(upgrade).length > 0, 'the section is refetched (' + secReqs(upgrade).length + ' calls)');
  await waitFor(() => upgrade.w.localStorage.getItem('lt_anime'), 25000);
  const upSec = JSON.parse(decode(upgrade, 'lt_anime') || 'null');
  ok(!!upSec && upSec.v === CVER, 'and rewritten with the new stamp', upSec && upSec.v);

  /* ---------- 4. caches but no stamp key at all ---------- */
  console.log('\n4. no stamp key — the same rule applies');
  const nostamp = open(NEW_FILE, { lt_anime: oldSection(oldItems), lt_cartoon: oldSection(oldItems) });
  await waitFor(() => nostamp.d.querySelectorAll('#feed .card').length >= 20, 25000);
  cv = JSON.parse(cacheVer(nostamp));
  ok(cv.purged === 2, 'both unstamped caches are purged', cv.purged);
  ok(cv.stamp === CVER, 'the stamp is written', cv.stamp);

  /* ---------- 5. stamp matches, blob does not ---------- */
  console.log('\n5. stamp matches but the blob carries another v — the blob is rejected');
  const wrong = open(NEW_FILE, { [CKEY]: CVER, lt_anime: stampedSection('7.44', oldItems) });
  await waitFor(() => wrong.d.querySelectorAll('#feed .card').length >= 20, 25000);
  cv = JSON.parse(cacheVer(wrong));
  ok(cv.purged === 0, 'the sweep has nothing to do: the stamp matches', cv.purged);
  const wBefore = secReqs(wrong).length;
  ok(await chipAnime(wrong), 'the Anime chip paints');
  const wTitles = titles(wrong);
  ok(!wTitles.some(t => /OLD CACHE ITEM/.test(t)), 'the v:7.44 blob is not used', wTitles.slice(0, 2).join(' | '));
  ok(secReqs(wrong).length > wBefore, 'it is fetched instead (' + (secReqs(wrong).length - wBefore) + ' calls)');

  /* ---------- 6. user data survives ---------- */
  console.log('\n6. the purge touches the caches only');
  const legacyState = JSON.stringify({
    liked: ['t03AAAAAAAA'], subs: [CH_IDS[0]], later: ['t04AAAAAAAA'], hist: ['t05AAAAAAAA'],
    vd: {}, pl: {}, cats: {}, opt: { cc: 1, loop: 1, auto: 0, fill: 0, cmt: 0, ds: 0, sg: 0, depth: 0, parallax: 0, pdepth: 80, glass: 70, layout: 'phone' },
  });
  const legacyFeed = JSON.stringify({
    v: 1, at: Date.now(), chav: { [CH_IDS[0]]: 'https://yt3.ggpht.com/av0.jpg' },
    items: TREND.slice(0, 24).map((id, i) => ({ id, t: 'Cached feed title ' + (i + 1), c: 'Channel ' + (i % 6), ch: CH_IDS[i % 6], views: '1000', pub: pub(i), cat: 'All', dur: 750 })),
  });
  const quota = JSON.stringify({ at: Date.now(), n: 42, ep: { search: 7 } });
  const keep = open(NEW_FILE, {
    lt: legacyState, lt_feed: legacyFeed, lt_quota: quota,
    [CKEY]: '7.44', lt_anime: oldSection(oldItems), lt_cartoon: oldSection(oldItems), lt_movies: oldSection(oldItems),
  });
  const keptFeed = await waitFor(() => keep.d.querySelectorAll('#feed .card').length >= 20, 25000);
  cv = JSON.parse(cacheVer(keep));
  ok(cv.purged === 3, 'the three caches are purged', cv.purged);
  ok(keptFeed, 'the last feed still paints from its cache');
  ok(keep.w.eval('S.liked.join(",")') === 't03AAAAAAAA', 'the saved library still restores liked');
  ok(keep.w.eval('S.opt.pdepth') === 80 && keep.w.eval('S.opt.glass') === 70, 'and the saved options');
  ok(!!keep.w.localStorage.getItem('lt_feed'), 'the last-feed cache is untouched');
  ok(!!keep.w.localStorage.getItem('lt_quota'), 'the quota meter is untouched');
  ok(keep.w.localStorage.getItem('lt_shorts') === null, 'the retired shorts key is still cleared');

  /* ---------- 7. no errors, and the previous build for contrast ---------- */
  console.log('\n7. errors and the previous build');
  const noisy = [cold, same, upgrade, nostamp, wrong, keep].filter(e => e.errors.length);
  ok(!noisy.length, 'no console error in any scenario', noisy.map(e => e.errors[0]).join(' | '));
  if (OLD_FILE) {
    const oldEnv = open(OLD_FILE, { lt_anime: oldSection(oldItems), lt_cartoon: oldSection(oldItems), lt_movies: oldSection(oldItems) });
    await waitFor(() => oldEnv.d.querySelectorAll('#feed .card').length >= 20, 25000);
    const had = keys(oldEnv);
    ok(!!had.lt_anime, 'the previous build keeps a section cache written by anyone (no stamp)', Object.keys(had).join(','));
    ok(!had[CKEY], 'and knows nothing of the stamp key');
    const paintedOld = await chipAnime(oldEnv);
    const t = titles(oldEnv);
    ok(paintedOld && t.some(x => /OLD CACHE ITEM/.test(x)), 'so it paints the old build\'s entries', t.slice(0, 2).join(' | '));
    ok(t.length === oldItems.length, 'straight from that cache (' + t.length + ' cards)');
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
