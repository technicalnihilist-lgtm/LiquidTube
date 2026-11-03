#!/usr/bin/env node
/*
 * LiquidTube stale-request abort check — proves item 2.7: a request that only
 * the page the user has left was waiting for is abandoned when the tab changes,
 * and nothing the user can see changes because of it.
 *
 * Three halves, all without a device or a real browser:
 *
 *  1. The request layer, called directly: a tagged request is aborted when its
 *     page is left (AbortError, no cache entry, no retry, no stale in-flight
 *     slot), an untagged request is never touched, a tagged request another page
 *     still owns survives, a tagged request an untagged caller joined survives,
 *     and the abort counter only moves when something really was aborted.
 *  2. The app, driven with a deliberately slow fetch so a tab switch really does
 *     land mid-request: leaving Explore while its shelves load aborts them and
 *     stops the request log growing; coming back re-drives exactly those shelves
 *     and they end up complete. Same for a chip section on Home.
 *  3. No UI change: the settled markup of every surface is byte-identical to the
 *     previous build, a tab switch with nothing in flight sends nothing and
 *     aborts nothing, and the normal boot/explore/subs/home walk is unchanged.
 *
 * jsdom + fixed fixtures, no network. Dev-only, not shipped in the APK.
 *
 *   NODE_PATH=/scratch/node_modules node tools/tab-abort-check.js \
 *       app/assets/index.html /path/to/previous/index.html
 *
 * argv[2] is the build under test, argv[3] the previous build (optional; the A/B
 * half is skipped without it).
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const NEW_FILE = process.argv[2] || path.join(__dirname, '..', 'app/assets/index.html');
const OLD_FILE = process.argv[3] || '';
const LATENCY = 150;                     // ms per request: long enough to switch tabs mid-flight
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
      snippet: { title: 'Playlist item ' + i + ' hindi full episode', resourceId: { videoId: id }, publishedAt: pub(i * 24) },
      contentDetails: { videoPublishedAt: pub(i * 24) },
    })),
  },
  search: {
    items: vids.slice(0, 20).map((id, i) => ({
      id: { videoId: id },
      snippet: {
        title: 'Search result ' + i + ' hindi full episode &amp; more',
        channelTitle: 'Channel ' + (i % 6),
        channelId: CH_IDS[i % 6],
        publishedAt: pub(i * 24),
      },
    })),
  },
};

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

function apiBody(url) {
  const u = new URL(url), p = u.pathname;
  if (p.endsWith('/videos')) return (u.searchParams.get('part') || '').includes('contentDetails') ? F.durations : F.videos;
  if (p.endsWith('/channels')) return chanAnswer(u, F.channels);
  if (p.endsWith('/playlistItems')) return F.playlistItems;
  if (p.endsWith('/search')) return F.search;
  return {};
}

/* one page: fresh window, fresh localStorage, a fetch that answers from the
   fixtures above after `latency` ms, honours an AbortSignal the way a real
   fetch does, and logs every URL it was asked for together with whether it was
   aborted before it answered. */
function open(file, latency = LATENCY, opts = {}) {
  const HTML = fs.readFileSync(file, 'utf8');
  const reqs = [];
  const env = { reqs, latency, w: null, d: null, dom: null, errors: [] };
  const mockFetch = (u, opts) => {
    const rec = { url: String(u).replace(/([?&])key=[^&]*/, '$1key=<key>'), aborted: false };
    reqs.push(rec);
    const sig = opts && opts.signal;
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
        res({ ok: true, status: 200, headers: { get: () => '' }, json: async () => apiBody(String(u)) });
      }, latency);
    });
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
      if (opts.noAbort) w.AbortController = undefined;   /* an engine without it, as on old WebViews */
      w.addEventListener('error', e => env.errors.push(String((e && e.message) || e)));
    },
  });
  env.w = dom.window;
  env.d = dom.window.document;
  env.dom = dom;
  env.aborted = () => reqs.filter(r => r.aborted).length;
  env.live = () => reqs.filter(r => !r.aborted).length;
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
    .replace(/ style="[^"]*"/g, '')      /* inline style = animation/depth state, never layout */
    .replace(/\s{2,}/g, ' ').trim();
}
const snap = (env, sel) => norm((env.d.querySelector(sel) || {}).innerHTML || '');

const R = [];
const ok = (name, pass, detail) => R.push({ name, pass: !!pass, detail: detail === undefined ? '' : String(detail) });

const settled = async (env, ms = 20000) => {
  await waitFor(() => env.d.querySelectorAll('#feed .card').length > 0, ms);
  await waitFor(() => env.w.__ltReqCache && env.w.__ltReqCache().fly === 0, ms);
};

/* ---------- 1. the request layer, called directly ---------- */
/* rqAbandon(page) is the tab change: `page` is the tab the user is on now, and
   from then on only the pages in the wanted set (boot starts with Home and
   Explore, since the shell fills both) may have a request on the wire. */
async function unitTests(file) {
  const env = open(file, 200);
  const w = env.w;
  await settled(env);
  const st = () => w.__ltReqCache();
  if (typeof w.yt !== 'function' || typeof w.rqAbandon !== 'function') {
    ok('yt() and rqAbandon() reachable', false, typeof w.yt + '/' + typeof w.rqAbandon);
    return R;
  }
  const uq = () => 'abort-' + Math.random().toString(36).slice(2);

  // 1. at boot Home and Explore are both wanted: one request, two owners, and it
  //    lives while either of them is on screen
  let q = uq(), n = env.reqs.length;
  const p1a = w.yt('search', { part: 'snippet', q }, 'explore');
  await sleep(20);
  const p1b = w.yt('search', { part: 'snippet', q }, 'home');   // same key, second owner
  await sleep(20);
  ok('a request two pages own is sent once', env.reqs.length === n + 1, (env.reqs.length - n) + ' requests');
  w.rqAbandon('home');                                         // Home is the tab on screen now
  await sleep(30);
  ok('it is not aborted while one of its pages is on screen',
    env.reqs[n].aborted === false && st().fly === 1, 'aborted ' + env.reqs[n].aborted + ', fly ' + st().fly);
  w.rqAbandon('subs');
  const e1 = await Promise.all([p1a.then(j => j, e => e), p1b.then(j => j, e => e)]);
  ok('and is aborted once no page on screen wants it',
    e1[0] && e1[0].name === 'AbortError' && e1[1] && e1[1].name === 'AbortError' && env.reqs[n].aborted === true,
    e1[0] && e1[0].name);

  // 2. a tagged call for a page that is not on screen is refused, not sent
  n = env.reqs.length;
  const e2 = await w.yt('search', { part: 'snippet', q: uq() }, 'explore').then(() => null, e => e);
  ok('a tagged call for a page nobody is on is not sent at all',
    e2 && e2.name === 'AbortError' && env.reqs.length === n, e2 && e2.name + ', ' + (env.reqs.length - n) + ' requests');

  // 3. a request whose page is left is aborted on the wire
  q = uq(); n = env.reqs.length; let a = st().abort, r = st().retry;
  w.rqAbandon('explore');                                     // back to Explore, so it may load
  const p3 = w.yt('search', { part: 'snippet', q }, 'explore');
  await sleep(40);
  w.rqAbandon('subs');
  const e3 = await p3.then(() => null, e => e);
  ok('a request whose page is left rejects with AbortError', e3 && e3.name === 'AbortError', e3 && e3.name);
  ok('it was sent once and closed once', env.reqs.length === n + 1 && env.reqs[n].aborted === true,
    'requests ' + (env.reqs.length - n) + ', aborted ' + env.reqs[n].aborted);
  ok('the abort is counted', st().abort === a + 1, a + '→' + st().abort);
  ok('an abandoned request is not retried', st().retry === r, 'retry ' + r + '→' + st().retry);
  ok('it leaves no in-flight slot behind', st().fly === 0, 'fly ' + st().fly);

  // 4. nothing was cached, so a later call really goes out again
  w.rqAbandon('explore');
  n = env.reqs.length;
  const again = await w.yt('search', { part: 'snippet', q }, 'explore');
  ok('nothing was cached for the abandoned request', env.reqs.length === n + 1 && !!(again && again.items),
    'requests ' + (env.reqs.length - n));

  // 5. a request the page now on screen owns is kept
  q = uq(); n = env.reqs.length; a = st().abort;
  const p5 = w.yt('search', { part: 'snippet', q }, 'explore');
  await sleep(40);
  w.rqAbandon('explore');
  const r5 = await p5.then(j => j, e => e);
  ok('a request owned by the page now on screen survives', !!(r5 && r5.items), r5 && r5.name);
  ok('and is not counted as aborted', st().abort === a && env.reqs[n].aborted === false,
    'abort ' + a + '→' + st().abort);

  // 6. an untagged request is never abandoned
  q = uq(); n = env.reqs.length; a = st().abort;
  const p6 = w.yt('search', { part: 'snippet', q });
  await sleep(40);
  w.rqAbandon('explore');
  w.rqAbandon('subs');
  const r6 = await p6.then(j => j, e => e);
  ok('an untagged request survives any page switch', !!(r6 && r6.items), r6 && r6.name);
  ok('and is not counted as aborted', st().abort === a, 'abort ' + a + '→' + st().abort);

  // 7. a tagged request an untagged caller has joined is kept
  w.rqAbandon('explore');
  q = uq(); n = env.reqs.length;
  const p7a = w.yt('search', { part: 'snippet', q }, 'explore');
  await sleep(30);
  const p7b = w.yt('search', { part: 'snippet', q });          // joins, untagged
  await sleep(20);
  w.rqAbandon('subs');
  const r7 = await Promise.all([p7a.then(j => j, e => e), p7b.then(j => j, e => e)]);
  ok('a joined request is not abandoned under its joiners',
    !!(r7[0] && r7[0].items) && r7[0] === r7[1] && env.reqs.length === n + 1 && env.reqs[n].aborted === false,
    'requests ' + (env.reqs.length - n) + ', aborted ' + env.reqs[n].aborted);

  // 8. a sweep with nothing tagged on the wire does nothing at all
  a = st().abort; n = env.reqs.length;
  await sleep(250);
  w.rqAbandon('subs');
  w.rqAbandon('home');
  ok('a sweep with nothing tagged on the wire is a no-op',
    st().abort === a && env.reqs.length === n, 'abort ' + a + '→' + st().abort);

  // 9. after all that the layer still works: a fresh call is served and cached
  w.rqAbandon('explore');
  q = uq(); n = env.reqs.length;
  const first = await w.yt('search', { part: 'snippet', q }, 'explore');
  const second = await w.yt('search', { part: 'snippet', q }, 'explore');
  ok('the layer still caches normally afterwards',
    first === second && env.reqs.length === n + 1, 'requests ' + (env.reqs.length - n));

  env.dom.window.close();
  return R;
}

/* ---------- 2. the app: a tab switch really does abandon the work ---------- */
async function exploreAbort(file, tagged) {
  const env = open(file);
  const w = env.w;
  /* switch the moment the two search-backed shelves are on the wire, so both
     builds are compared at exactly the same point in the chain */
  await waitFor(() => env.reqs.some(r => r.url.indexOf('calm+relaxing') >= 0));
  const atBoot = env.reqs.length;
  if (tagged) ok('Explore starts its shelves at boot', atBoot > 0, atBoot + ' requests');

  w.go(2);                                              // Home → Subscriptions, mid-shelf-load
  await sleep(120);
  const aborted = env.aborted();
  const logAtSwitch = env.reqs.length;
  if (tagged) {
    ok('leaving Explore aborts the requests only it was waiting for', aborted > 0, aborted + ' aborted');
    ok('the abort counter agrees', w.__ltReqCache().abort >= aborted, w.__ltReqCache().abort);
    ok('nothing Explore was loading reached its carousels',
      env.d.querySelectorAll('#ex .big').length === 0,
      env.d.querySelectorAll('#ex .big').length + ' carousel cards');
  }
  await sleep(900);                                     // long enough for an un-aborted chain to keep going
  const afterSwitch = env.reqs.length - logAtSwitch;
  if (tagged) ok('the request log stops growing after the switch',
    afterSwitch === 0, afterSwitch + ' new requests');

  w.go(1);                                              // back to Explore
  const full = await waitFor(() => [...env.d.querySelectorAll('#ex .car')].every(c => c.querySelectorAll('.big').length === 6), 20000);
  ok('coming back re-drives exactly those shelves and they complete', full,
    [...env.d.querySelectorAll('#ex .car')].map(c => c.querySelectorAll('.big').length).join('/'));
  if (tagged) {
    ok('all three shelves are filled again after the resume',
      env.d.querySelectorAll('#ex .big').length === 18,
      env.d.querySelectorAll('#ex .big').length + ' carousel cards');
    ok('no request is left on the wire', w.__ltReqCache().fly === 0, w.__ltReqCache().fly);
  }
  const markup = snap(env, '#ex');
  const out = { markup, errors: env.errors.slice(), sent: env.reqs.length, aborted: env.aborted(), afterSwitch, onResume: env.reqs.length - logAtSwitch - afterSwitch };
  env.dom.window.close();
  return out;
}

/* the same walk with nothing in flight: no abort, no extra request */
async function quietSwitch(file) {
  const env = open(file, 0);
  const w = env.w;
  await settled(env);
  await waitFor(() => [...env.d.querySelectorAll('#ex .car')].every(c => c.querySelectorAll('.big').length === 6));
  const n = env.reqs.length, a = w.__ltReqCache().abort;
  const before = { feed: snap(env, '#feed'), ex: snap(env, '#ex'), sg: snap(env, '#sg'), sub: snap(env, '#subfeed'), chips: snap(env, '#chips') };
  w.go(1); await sleep(60);
  w.go(2); await sleep(60);
  w.go(0); await sleep(60);
  w.go(1); await sleep(60);
  w.go(0); await sleep(200);
  ok('a tab walk with nothing in flight aborts nothing', w.__ltReqCache().abort === a, a + '→' + w.__ltReqCache().abort);
  ok('and sends nothing new', env.reqs.length === n, (env.reqs.length - n) + ' new requests');
  const after = { feed: snap(env, '#feed'), ex: snap(env, '#ex'), sg: snap(env, '#sg'), sub: snap(env, '#subfeed'), chips: snap(env, '#chips') };
  ok('and leaves every surface exactly as it was',
    Object.keys(before).every(k => before[k] === after[k]),
    Object.keys(before).filter(k => before[k] !== after[k]).join(',') || 'all identical');
  const out = { before, after };
  env.dom.window.close();
  return out;
}

/* ---------- 3. a chip section abandoned by a page switch comes back ---------- */
async function sectionAbort(file, tagged) {
  const env = open(file);
  const w = env.w;
  await settled(env);
  w.chip('Anime');                                      // 4 channels + durations + maybe a search
  await sleep(220);                                     // mid-load
  const a = tagged ? w.__ltReqCache().abort : 0;
  const atLeave = env.reqs.length;
  w.go(1);                                              // leave Home
  await sleep(160);
  const whileAway = env.reqs.length - atLeave;
  if (tagged) ok('leaving Home aborts the section it was loading', w.__ltReqCache().abort > a,
    a + '→' + w.__ltReqCache().abort);
  ok('the feed keeps its skeletons, it does not flash an error',
    env.d.querySelectorAll('#feed .card').length === 0 && !/Could not load/.test(env.d.getElementById('feed').innerHTML),
    env.d.getElementById('feed').innerHTML.slice(0, 60));
  w.go(0);                                              // back to Home
  const landed = await waitFor(() => env.d.querySelectorAll('#feed .card').length > 0, 20000);
  ok('coming back re-runs the section and it lands', landed,
    env.d.querySelectorAll('#feed .card').length + ' cards');
  ok('and it is not an error surface', !/Could not load/.test(env.d.getElementById('feed').innerHTML));
  const markup = snap(env, '#feed');
  const out = { markup, errors: env.errors.slice(), atLeave, whileAway, aborted: env.aborted(), sent: env.reqs.length };
  env.dom.window.close();
  return out;
}

/* ---------- 3b. an engine without AbortController behaves exactly as before ---------- */
async function noAbortEngine(file) {
  const env = open(file, LATENCY, { noAbort: true });
  const w = env.w;
  await waitFor(() => env.d.querySelectorAll('#feed .card').length > 0);
  w.go(2);                                              // leave while the shelves are on the wire
  await sleep(200);
  ok('without AbortController nothing is aborted', env.aborted() === 0 && w.__ltReqCache().abort === 0,
    env.aborted() + ' aborted, counter ' + w.__ltReqCache().abort);
  w.go(1);
  const full = await waitFor(() => env.d.querySelectorAll('#ex .big').length === 18, 20000);
  ok('and the shelves still fill in as they always did', full,
    env.d.querySelectorAll('#ex .big').length + ' carousel cards');
  ok('no console error without AbortController', env.errors.length === 0, env.errors.join(' | '));
  env.dom.window.close();
}

/* ---------- 4. steady state, against the previous build ---------- */
async function surfaces(file) {
  const env = open(file, 0);
  const w = env.w;
  await settled(env);
  await waitFor(() => [...env.d.querySelectorAll('#ex .car')].every(c => c.querySelectorAll('.big').length === 6));
  const out = {
    boot: { chips: snap(env, '#chips'), feed: snap(env, '#feed'), ex: snap(env, '#ex'), sg: snap(env, '#sg'), sub: snap(env, '#subfeed') },
    reqs: env.reqs.map(r => r.url),
    aborts: env.aborted(),
  };
  w.chip('Anime');
  await waitFor(() => env.d.querySelectorAll('#feed .card').length > 0);
  out.anime = snap(env, '#feed');
  w.chip('All');
  await sleep(300);
  out.back = snap(env, '#feed');
  w.go(1); await sleep(120); out.ex = snap(env, '#ex');
  w.go(2); await sleep(120); out.sg = snap(env, '#sg') + '|' + snap(env, '#subfeed');
  w.go(0); await sleep(120); out.home = snap(env, '#feed');
  out.errors = env.errors.slice();
  env.dom.window.close();
  return out;
}

(async () => {
  console.log('== 1. request layer');
  await unitTests(NEW_FILE);

  console.log('== 2. Explore: aborted on leave, re-driven on return');
  const ex = await exploreAbort(NEW_FILE, true);
  ok('no console error during the Explore walk', ex.errors.length === 0, ex.errors.join(' | '));

  console.log('== 3. Home: a chip section abandoned by a page switch');
  const sec = await sectionAbort(NEW_FILE, true);
  ok('no console error during the section walk', sec.errors.length === 0, sec.errors.join(' | '));

  console.log('== 3b. no AbortController');
  await noAbortEngine(NEW_FILE);

  console.log('== 4. quiet tab walk');
  await quietSwitch(NEW_FILE);

  console.log('== 5. steady state vs the previous build');
  const sum = (t, x) => console.log('   ' + t + ': ' + x.sent + ' requests in the walk, ' + x.aborted + ' aborted on the switch, '
    + x.afterSwitch + ' sent while away, ' + x.onResume + ' sent on return');
  const NEW = await surfaces(NEW_FILE);
  ok('no console error in the steady-state walk', NEW.errors.length === 0, NEW.errors.join(' | '));
  ok('a plain session aborts nothing', NEW.aborts === 0, NEW.aborts + ' aborted');
  if (OLD_FILE) {
    const OLD = await surfaces(OLD_FILE);
    const same = (k) => JSON.stringify(NEW[k]) === JSON.stringify(OLD[k]);
    ['boot', 'anime', 'back', 'ex', 'sg', 'home'].forEach(k => ok('surface "' + k + '" is identical to the previous build', same(k)));
    ok('the request log is unchanged', JSON.stringify(NEW.reqs) === JSON.stringify(OLD.reqs),
      NEW.reqs.length + ' vs ' + OLD.reqs.length + ' requests');
    ok('the old build aborts nothing either (it has no abort)', OLD.aborts === 0, OLD.aborts);
    const ox = await exploreAbort(OLD_FILE, false);
    sum('previous build', ox); sum('this build', ex);
    ok('Explore ends up identical after the abort/resume walk', ox.markup === ex.markup);
    const os = await sectionAbort(OLD_FILE, false);
    const ssum = (t, x) => console.log('   ' + t + ' (section walk): ' + x.atLeave + ' requests before leaving Home, '
      + x.whileAway + ' sent while away, ' + x.aborted + ' aborted, ' + x.sent + ' in the whole walk');
    ssum('previous build', os); ssum('this build', sec);
    ok('the Anime section ends up identical after the abort/resume walk', os.markup === sec.markup);
  } else {
    sum('this build', ex);
    console.log('   (no previous build given: A/B skipped)');
  }

  const pass = R.filter(r => r.pass).length;
  R.forEach(r => console.log((r.pass ? '  PASS  ' : '  FAIL  ') + r.name + (r.detail ? '  [' + r.detail + ']' : '')));
  console.log('\n' + pass + '/' + R.length + ' assertions passed');
  process.exit(pass === R.length ? 0 : 1);
})();
