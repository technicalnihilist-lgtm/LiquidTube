#!/usr/bin/env node
/*
 * LiquidTube channel-batch check — proves item 2.5: every `channels` lookup goes
 * through one queue, is cut into groups of 50, and each id is asked for once.
 *
 * Two halves, both without a device or a real browser:
 *
 *  1. The queue itself, by calling loadChannels()/ensureChannel() directly in
 *     the loaded page against a fixture server whose delay and failures this
 *     file controls: group sizes and ceilings, one request per id, concurrent
 *     callers merged into the same groups, groups released independently, a
 *     failure confined to its own group, and ensureChannel's error message and
 *     attempt count unchanged.
 *  2. The app, driven through its surfaces with the old build and the new one
 *     side by side: every rendered surface must come out byte-identical.
 *
 *   npm i jsdom
 *   node tools/channel-batch-check.js app/assets/index.html /tmp/old/index.html
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

/* a channel id this file invents: unique, and long enough to look real */
const mk = (n, tag) => Array.from({ length: n }, (_, i) => 'UC' + tag + pad(i) + 'xxxxxxxxxxxxxxxx');
const chan = (id, i) => ({
  id,
  snippet: {
    title: 'Channel ' + (i === undefined ? id.slice(2, 8) : i),
    customUrl: 'c' + (i === undefined ? id.slice(2, 8) : i),
    publishedAt: '2015-04-02T10:00:00Z',
    country: 'IN',
    description: 'A sample channel &amp; its description.',
    thumbnails: { medium: { url: 'https://yt3.ggpht.com/' + id + '.jpg' } },
  },
  statistics: { subscriberCount: '1000', videoCount: '10', viewCount: '10000' },
  contentDetails: { relatedPlaylists: { uploads: 'UU' + id.slice(2) } },
  brandingSettings: { image: { bannerExternalUrl: '' }, channel: {} },
});

const FEED = {
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
};
const DURATIONS = { items: vids.map(id => ({ id, contentDetails: { duration: 'PT12M30S' } })) };
const UPLOADS = {
  items: vids.slice(0, 12).map((id, i) => ({
    snippet: { title: 'Playlist item ' + i, resourceId: { videoId: id }, publishedAt: pub(i * 24) },
    contentDetails: { videoPublishedAt: pub(i * 24) },
  })),
};
const searchFor = q => {
  const rot = String(q || '').length % 6;      /* a different query, a different order */
  return {
    items: vids.slice(0, 20).map((id, i) => ({
      id: { videoId: id },
      snippet: {
        title: 'Search result ' + i + ' &amp; more',
        channelTitle: 'Channel ' + ((i + rot) % 6),
        channelId: CH_IDS[(i + rot) % 6],
        publishedAt: pub(i * 24),
      },
    })),
  };
};

/* The API answers a `channels` call with exactly the ids it was asked for, and
   with an empty `items` for an id it does not know — so the fixture does too. */
function body(U, empty) {
  const p = U.pathname;
  if (p.endsWith('/channels')) {
    const want = String(U.searchParams.get('id') || '').split(',').filter(Boolean);
    return { items: want.filter(id => !empty || !empty.has(id)).map(id => chan(id, CH_IDS.indexOf(id) >= 0 ? CH_IDS.indexOf(id) : undefined)) };
  }
  if (p.endsWith('/videos')) return (U.searchParams.get('part') || '').includes('contentDetails') ? DURATIONS : FEED;
  if (p.endsWith('/playlistItems')) return UPLOADS;
  if (p.endsWith('/search')) return searchFor(U.searchParams.get('q'));
  return {};
}

/* one page. `delayFor(rec, n)` and `failFor(rec, n)` let a test slow a single
   request down or fail it; `empty` is the set of ids the fixture does not know. */
function open(file, opts) {
  opts = opts || {};
  const HTML = fs.readFileSync(file, 'utf8');
  const env = { reqs: [], log: [], delay: opts.delay || 0, delayFor: null, failFor: null, empty: opts.empty || null, inFlight: 0, maxInFlight: 0 };
  const mockFetch = async u => {
    u = String(u);
    const U = new URL(u);
    const ids = String(U.searchParams.get('id') || '').split(',').filter(Boolean);
    const rec = { url: u.replace(/([?&])key=[^&]*/, '$1key=<key>'), path: U.pathname, ids, at: Date.now() };
    env.reqs.push(rec.url);
    env.log.push(rec);
    env.inFlight++;
    env.maxInFlight = Math.max(env.maxInFlight, env.inFlight);
    try {
      const n = env.log.length - 1;
      const ms = env.delayFor ? env.delayFor(rec, n) : env.delay;
      if (ms) await sleep(ms);
      if (env.failFor) {
        const f = env.failFor(rec, n);
        if (f === 'throw') throw new Error('network down');
        if (f) return { ok: false, status: f, json: async () => ({ error: { message: f === 403 ? 'The request cannot be completed because you have exceeded your quota.' : 'HTTP ' + f } }) };
      }
      const j = body(U, env.empty);
      return { ok: true, status: 200, json: async () => j };
    } finally { env.inFlight--; }
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
  env.ch = () => env.w.eval('CH');
  env.stat = () => (env.w.__ltChanQueue ? env.w.__ltChanQueue() : null);
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
    .replace(/ class="ld"/g, '').replace(/ ld"/g, '"')
    .replace(/ data-f="1"/g, '')
    .replace(/ ?(?:transform|opacity|background-position-y):[^;"']*;?/g, '')
    .replace(/style="\s*"/g, '').replace(/\s{2,}/g, ' ').trim();
}
const snap = (env, sel, all) => all
  ? [...env.d.querySelectorAll(sel)].map(e => norm(e.outerHTML))
  : norm((env.d.querySelector(sel) || {}).innerHTML || '');

let pass = 0, bad = 0;
function ok(name, cond, detail) {
  if (cond) pass++; else bad++;
  console.log((cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined ? '  [' + detail + ']' : ''));
}

/* the channel requests this page made, oldest first */
const chReqs = env => env.log.filter(r => r.path.endsWith('/channels'));

/* ---------- 1. the queue ---------- */
async function unitTests(file) {
  const env = open(file);
  await waitFor(() => env.d.querySelectorAll('#feed .card').length > 0);
  await sleep(200);
  const boot = chReqs(env).length;
  const w = env.w;

  // a big call is cut into groups of 50, in order, with no id twice
  let base = chReqs(env).length;
  const big = mk(120, 'a');
  await w.loadChannels(big);
  let got = chReqs(env).slice(base);
  const flat = got.flatMap(r => r.ids);
  ok('120 ids go out as groups of 50', got.length === 3 && got.map(r => r.ids.length).join(',') === '50,50,20', got.map(r => r.ids.length).join(','));
  ok('the groups cover every id exactly once', flat.length === 120 && new Set(flat).size === 120, flat.length + ' ids, ' + new Set(flat).size + ' unique');
  ok('no group exceeds the 50-id ceiling', got.every(r => r.ids.length <= 50), Math.max(...got.map(r => r.ids.length)) + ' max');
  ok('every id landed in CH', big.every(id => env.ch()[id] && env.ch()[id].up !== undefined));

  // 51 ids is two groups, not one of 51
  base = chReqs(env).length;
  await w.loadChannels(mk(51, 'c'));
  got = chReqs(env).slice(base);
  ok('51 ids go out as 50 + 1', got.length === 2 && got[0].ids.length === 50 && got[1].ids.length === 1, got.map(r => r.ids.length).join('+'));

  // the same ids twice in one call: one request, each id once
  base = chReqs(env).length;
  const d1 = mk(60, 'd');
  await w.loadChannels(d1.concat(d1));
  got = chReqs(env).slice(base);
  ok('a call with repeated ids sends each id once', got.length === 2 && got.flatMap(r => r.ids).length === 60, got.length + ' requests, ' + got.flatMap(r => r.ids).length + ' ids');

  // two callers in the same task share their groups
  base = chReqs(env).length;
  const e1 = mk(15, 'e'), e2 = mk(15, 'f').concat(e1.slice(0, 5));
  await Promise.all([w.loadChannels(e1), w.loadChannels(e2)]);
  got = chReqs(env).slice(base);
  const eIds = got.flatMap(r => r.ids);
  ok('two overlapping callers in one task merge into one group', got.length === 1 && eIds.length === 30, got.length + ' request(s), ' + eIds.length + ' ids');
  ok('the merged group carries no duplicate id', new Set(eIds).size === eIds.length, eIds.length + ' ids, ' + new Set(eIds).size + ' unique');

  // an id already queued is joined, not asked for again
  base = chReqs(env).length;
  const g1 = mk(5, 'g');
  const [lc, ec] = await Promise.all([w.loadChannels(g1), w.ensureChannel(g1[0])]);
  got = chReqs(env).slice(base);
  ok('ensureChannel joins a queued id instead of sending it again', got.length === 1 && ec.id === g1[0], got.length + ' request(s)');
  ok('loadChannels resolved after CH was filled', g1.every(id => !!env.ch()[id]));

  // a second loadChannels for ids already in CH costs nothing
  base = chReqs(env).length;
  await w.loadChannels(g1);
  ok('ids already in CH are not requested again', chReqs(env).length === base, (chReqs(env).length - base) + ' request(s)');

  // an unknown id: ensureChannel says so, once
  base = chReqs(env).length;
  env.empty = new Set(['UCzzzzzzzzzzzzzzzzzzzzzzzz']);
  let msg = '';
  try { await w.ensureChannel('UCzzzzzzzzzzzzzzzzzzzzzzzz'); } catch (e) { msg = e.message; }
  ok('an unknown channel still throws Channel not found', msg === 'Channel not found', msg);
  ok('an unknown channel costs one request', chReqs(env).length - base === 1, (chReqs(env).length - base) + ' request(s)');
  env.empty = null;

  // a quota refusal keeps the API's own message, and is not retried
  base = chReqs(env).length;
  env.failFor = r => (r.path.endsWith('/channels') ? 403 : null);
  msg = '';
  try { await w.ensureChannel(mk(1, 'h')[0]); } catch (e) { msg = e.message; }
  ok('ensureChannel passes the API message through', /quota/.test(msg), msg);
  ok('a 403 is sent once', chReqs(env).length - base === 1, (chReqs(env).length - base) + ' request(s)');

  // a 5xx is retried once, as it was before
  base = chReqs(env).length;
  env.failFor = r => (r.path.endsWith('/channels') ? 500 : null);
  msg = '';
  try { await w.ensureChannel(mk(1, 'i')[0]); } catch (e) { msg = e.message; }
  ok('a 500 is retried once, then reported', chReqs(env).length - base === 2 && /500/.test(msg), (chReqs(env).length - base) + ' attempts, ' + msg);
  env.failFor = null;

  // loadChannels still swallows a failure
  base = chReqs(env).length;
  env.failFor = r => (r.path.endsWith('/channels') ? 403 : null);
  let threw = false;
  try { await w.loadChannels(mk(3, 'j')); } catch (e) { threw = true; }
  ok('loadChannels still swallows a failure', !threw);
  env.failFor = null;

  ok('the boot made its channel calls through the same queue', boot >= 1 && env.stat().batch >= boot, boot + ' at boot, ' + env.stat().batch + ' batches total');
  env.dom.window.close();

  /* groups go out together, and one slow group does not hold the others */
  const env2 = open(file, { delay: 80 });
  await waitFor(() => env2.d.querySelectorAll('#feed .card').length > 0);
  await sleep(200);
  env2.maxInFlight = 0;
  const t0 = Date.now();
  await env2.w.loadChannels(mk(120, 'k'));
  const dt = Date.now() - t0;
  ok('groups run concurrently', env2.maxInFlight >= 2, env2.maxInFlight + ' in flight at once');
  ok('120 ids cost one round trip, not three', dt < 80 * 2.5, dt + ' ms for 3 groups of 80 ms');
  env2.dom.window.close();

  const env3 = open(file);
  await waitFor(() => env3.d.querySelectorAll('#feed .card').length > 0);
  await sleep(200);
  let slow = 0;                                  /* the boot's own calls are not slowed */
  env3.delayFor = r => (r.path.endsWith('/channels') ? (slow++ === 0 ? 500 : 20) : 0);
  const m = mk(120, 'm');
  const at = [];
  const all = env3.w.loadChannels(m).then(() => at.push(['all', Date.now()]));
  const one = env3.w.loadChannels([m[110]]).then(() => at.push(['one', Date.now()]));
  await Promise.all([all, one]);
  const tAll = at.find(a => a[0] === 'all')[1], tOne = at.find(a => a[0] === 'one')[1];
  ok('a group is released when its own response lands', tOne < tAll - 100, 'its group ' + (tAll - tOne) + ' ms before the slow one');
  env3.dom.window.close();

  /* a failure in one group does not take the other down */
  const env4 = open(file);
  await waitFor(() => env4.d.querySelectorAll('#feed .card').length > 0);
  await sleep(200);
  const base4 = chReqs(env4).length;
  env4.failFor = r => (r.path.endsWith('/channels') && r.ids.length === 50 ? 403 : null);
  const n4 = mk(60, 'n');
  await env4.w.loadChannels(n4);
  const got4 = chReqs(env4).slice(base4);
  const ch4 = env4.ch();
  ok('60 ids still go out as 50 + 10', got4.length === 2 && got4.map(r => r.ids.length).join('+') === '50+10', got4.map(r => r.ids.length).join('+'));
  ok('the failed group leaves no channel behind', n4.slice(0, 50).every(id => !ch4[id]));
  ok('the group that succeeded is filled anyway', n4.slice(50).every(id => !!ch4[id]), n4.slice(50).filter(id => ch4[id]).length + '/10');
  ok('the failure is counted once', env4.stat().err === 1, 'err=' + env4.stat().err);
  ok('no id is ever asked for twice in one call', got4.flatMap(r => r.ids).length === new Set(got4.flatMap(r => r.ids)).size);
  env4.dom.window.close();
}

/* ---------- 2. two surfaces asking at once ----------
   The realistic case: two chips are tapped back to back while the feed is still
   loading, so two sections want the same six channels, each in the order its own
   results came in. Slow every request down so the two really do overlap. */
async function driveRace(file) {
  const env = open(file, { delay: 150 });
  await waitFor(() => env.d.querySelectorAll('#chips .chip').length > 0);
  for (const name of ['Anime', 'Cartoon']) {
    const b = [...env.d.querySelectorAll('#chips .chip')].find(x => x.textContent === name);
    if (b) b.click();
  }
  await waitFor(() => env.d.querySelectorAll('#feed .card').length > 0);
  await sleep(600);
  const chans = env.log.filter(r => r.path.endsWith('/channels'));
  const ids = chans.flatMap(r => r.ids);
  const out = { requests: chans.length, ids: ids.length, unique: new Set(ids).size, log: chans.map(r => r.ids.join(',')) };
  env.dom.window.close();
  return out;
}

/* ---------- 2. the app, old vs new ---------- */
async function driveSurfaces(file) {
  const env = open(file);
  const out = {};
  await waitFor(() => env.d.querySelectorAll('#feed .card').length > 0);
  await waitFor(() => !env.d.querySelector('#ex .skl'));
  await sleep(300);
  out.boot = { chips: snap(env, '#chips'), feed: snap(env, '#feed .card', 1), ex: snap(env, '#ex'), subs: snap(env, '#sg'), subfeed: snap(env, '#subfeed') };
  out.afterBoot = env.reqs.length;

  env.d.getElementById('sopen').click();
  await sleep(120);
  const q = env.d.getElementById('q');
  q.value = 'lofi & chill';
  q.dispatchEvent(new env.w.Event('input'));
  await waitFor(() => env.d.querySelectorAll('#results .card').length > 0);
  await sleep(120);
  out.search = snap(env, '#results .card', 1);
  env.d.getElementById('cancel').click();
  await sleep(120);

  env.d.querySelector('#feed .card').click();
  await sleep(300);
  out.player = { on: env.d.getElementById('pl').classList.contains('on'), iframe: (env.d.querySelector('#pl iframe') || {}).src || '' };
  env.d.getElementById('plk').click();
  await waitFor(() => env.d.querySelectorAll('#chlist .card').length > 0);
  await sleep(120);
  out.channel = { head: env.d.getElementById('sht').textContent, body: snap(env, '#shb'), list: snap(env, '#chlist .card', 1) };
  env.d.getElementById('scrim').click();
  await sleep(200);

  const b = env.d.querySelector('[data-shelf="calm"]');
  b.click();
  await waitFor(() => env.d.querySelectorAll('#results .card').length > 0);
  await sleep(120);
  out.viewAll = snap(env, '#results .card', 1);
  env.d.getElementById('cancel').click();
  await sleep(120);

  env.d.querySelector('[data-do="you"]').click();
  await sleep(200);
  out.library = snap(env, '#shb');
  env.d.querySelector('[data-lib="settings"]').click();
  await sleep(200);
  out.settings = snap(env, '#shb');
  out.requests = env.reqs.slice();
  out.reqCount = env.reqs.length;
  out.batches = env.stat() || { batch: 0, ids: 0 };
  env.dom.window.close();
  return out;
}

(async () => {
  console.log('--- channel queue (' + path.basename(NEW_FILE) + ') ---');
  await unitTests(NEW_FILE);

  if (OLD_FILE) {
    const raceNew = await driveRace(NEW_FILE);
    const raceOld = await driveRace(OLD_FILE);
    console.log('\n--- chip tapped while the feed loads ---');
    console.log('channels requests: old ' + raceOld.requests + ' → new ' + raceNew.requests + ' (ids sent old ' + raceOld.ids + ' → new ' + raceNew.ids + ')');
    ok('a channel wanted by two surfaces at once is sent once', raceNew.requests < raceOld.requests, raceNew.requests + ' vs ' + raceOld.requests + ' requests, ' + raceNew.ids + ' vs ' + raceOld.ids + ' ids');
    ok('no id is sent twice in that overlap', raceNew.unique === raceNew.ids, raceNew.unique + '/' + raceNew.ids);

    const nw = await driveSurfaces(NEW_FILE);
    const od = await driveSurfaces(OLD_FILE);
    const surfaces = ['boot', 'search', 'player', 'channel', 'viewAll', 'library', 'settings'];
    const diffs = surfaces.filter(k => JSON.stringify(nw[k]) !== JSON.stringify(od[k]));
    const tally = list => list.reduce((m, u) => (m[u] = (m[u] || 0) + 1, m), {});
    const tOld = tally(od.requests), tNew = tally(nw.requests);
    const extra = Object.keys(tNew).filter(u => tNew[u] > (tOld[u] || 0));
    console.log('\n--- app, old vs new ---');
    console.log('surfaces identical: ' + (diffs.length === 0 ? 'true (' + surfaces.length + '/' + surfaces.length + ')' : 'false (differ: ' + diffs.join(', ') + ')'));
    console.log('requests: old ' + od.reqCount + ' → new ' + nw.reqCount);
    console.log('new log is a subset of the old one: ' + (extra.length === 0));
    if (nw.batches.batch) console.log('channel batches: new ' + nw.batches.batch + ', ids sent ' + nw.batches.ids + ', joined ' + nw.batches.join + ', failed groups ' + nw.batches.err);
    ok('no rendered surface changed', diffs.length === 0, diffs.join(', ') || surfaces.length + '/' + surfaces.length);
    ok('no new or altered request', extra.length === 0, extra.join(' '));
  }

  console.log('\n' + (bad === 0 ? 'PASS' : 'FAIL') + ' — ' + pass + '/' + (pass + bad) + ' assertions');
  process.exit(bad === 0 ? 0 : 1);
})();
