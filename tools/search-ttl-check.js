#!/usr/bin/env node
/*
 * LiquidTube search-TTL check — proves item 7.3: the search panel keeps the
 * answer to a query for thirty minutes, and a repeat inside that window costs
 * nothing.
 *
 * What it holds the build to:
 *
 *   1. A first search costs one request and a hundred units, and paints the
 *      twenty cards it always did.
 *   2. The same query asked again five minutes later paints the same markup
 *      with **no request** and **no quota unit**, and paints it at once — no
 *      skeleton, because there is nothing to wait for.
 *   3. The same answer is reached through a different spelling of the same
 *      query ("  LoFi "), because the key is the query, normalised.
 *   4. It is still a hit at 29 minutes and a miss at 31: thirty minutes is the
 *      window, and an expired entry is dropped, not served.
 *   5. The cache is bounded: thirteen distinct queries keep twelve, the oldest
 *      *used* is the one that goes, and a query asked again stays.
 *   6. A failure is never kept — the retry asks again — and an empty answer is
 *      kept and repeated for free.
 *   7. Nothing is written to storage by a hit: the launch blob of item 7.2 is
 *      untouched, one key, same bytes.
 *   8. The panel's DOM is the panel it always was: same ids, same card count,
 *      same markup, no new element and no new string.
 *
 * jsdom + fixed fixtures, no network. Dev-only, not shipped in the APK.
 *
 *   NODE_PATH=/scratch/node_modules node tools/search-ttl-check.js \
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
const LATENCY = 40;                        // ms per request
const sleep = ms => new Promise(r => setTimeout(r, ms));
const MIN = 60e3;

const pad = n => String(n).padStart(2, '0');
const vids = Array.from({ length: 24 }, (_, i) => 'v' + pad(i + 1) + 'AAAAAAAA');
const CH_IDS = Array.from({ length: 6 }, (_, i) => 'UC' + i + 'xxxxxxxxxxxxxxxxxxxx');
const pub = d => new Date(Date.UTC(2026, 9, 31) - d * 864e5).toISOString();

/* the real endpoint honours maxResults (the panel asks for 20); the mock does
   too, so the page the panel draws is the page the API would send. A query that
   starts with "no-hits" matches nothing, which is how an empty answer is driven. */
const searchBody = (q, max) => ({
  items: /^no-hits/.test(q) ? [] : vids.slice(0, max || 20).map((id, i) => ({
    id: { videoId: id },
    snippet: {
      title: 'Result ' + i + ' for ' + q,
      channelTitle: 'Channel ' + (i % 6),
      channelId: CH_IDS[i % 6],
      publishedAt: pub(i * 24),
    },
  })),
});

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
        description: 'A sample channel.',
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
};

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
  if (p.endsWith('/search')) return searchBody(u.searchParams.get('q') || '', +(u.searchParams.get('maxResults') || 20));
  return {};
}

/* One window. `env.skew` ages the page's clock, which is how a test gets to
   minute 29 and minute 31 without waiting for them. */
function open(file, seed) {
  const HTML = fs.readFileSync(file, 'utf8');
  const reqs = [];
  const env = { reqs, seed: seed || {}, fail: null, skew: 0 };
  const mockFetch = (u, init) => {
    const url = String(u);
    const rec = { url: url.replace(/([?&])key=[^&]*/, '$1key=<key>'), at: Date.now(), aborted: false, done: false, q: new URL(url).searchParams.get('q') };
    reqs.push(rec);
    return new Promise((res, rej) => {
      const t = setTimeout(() => {
        rec.done = true;
        if (env.fail === 'throw') return rej(new TypeError('Failed to fetch'));
        if (env.fail === 'error') return res({ ok: false, status: 500, json: async () => ({ error: { message: 'backend error' } }) });
        res({ ok: true, status: 200, headers: { get: () => null }, json: async () => apiBody(url) });
      }, LATENCY);
      const sig = init && init.signal;
      if (sig) {
        if (sig.aborted) { clearTimeout(t); const e = new Error('aborted'); e.name = 'AbortError'; rej(e); return; }
        sig.addEventListener('abort', () => {
          rec.aborted = true; clearTimeout(t);
          const e = new Error('aborted'); e.name = 'AbortError'; rej(e);
        });
      }
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
      w.Date.now = () => Date.now() + env.skew;      // lets a test age the cache
      for (const k in env.seed) { try { w.localStorage.setItem(k, env.seed[k]) } catch (e) {} }
    },
  });
  env.w = dom.window;
  env.d = dom.window.document;
  env.dom = dom;
  env.type = text => { const qi = env.d.getElementById('q'); qi.value = text; qi.dispatchEvent(new env.w.Event('input')); };
  env.storage = () => {
    const out = {};
    for (let i = 0; i < env.w.localStorage.length; i++) { const k = env.w.localStorage.key(i); out[k] = env.w.localStorage.getItem(k); }
    return out;
  };
  return env;
}
const ignorable = e => /WebAssembly|Cannot allocate/i.test(String((e && e.message) || ''));
process.on('uncaughtException', e => { if (!ignorable(e)) { console.error('uncaught', e); process.exit(1); } });
process.on('unhandledRejection', e => { if (!ignorable(e)) { console.error('unhandled', e); process.exit(1); } });

async function waitFor(fn, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(10); }
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
const cards = env => env.d.querySelectorAll('#results .card');
const searches = env => env.reqs.filter(r => /\/search\?/.test(r.url));
const units = env => env.w.__ltQuota().units;
const markup = env => norm(env.d.getElementById('results').innerHTML);
const skeleton = env => env.d.querySelectorAll('#results .skl').length;
const openPanel = async env => { env.d.getElementById('sopen').click(); await sleep(120); };
const closePanel = async env => { env.d.getElementById('cancel').click(); await sleep(60); };
const settled = env => cards(env).length > 0 && !env.d.querySelector('#results .skl');

async function boot(file, seed) {
  const env = open(file, seed);
  await waitFor(() => env.d.querySelectorAll('#feed .card').length > 0);
  await waitFor(() => !env.d.querySelector('#ex .skl'));
  await sleep(250);
  env.reqs.length = 0;
  return env;
}
/* one search, asked outright (a suggestion chip's path: no 300 ms pause), and
   settled. Returns what it cost. */
async function ask(env, q) {
  const s0 = searches(env).length, u0 = units(env);
  const t0 = Date.now();
  env.w.find();
  await waitFor(() => settled(env) || env.d.querySelector('#results .empty'), 8000);
  await sleep(30);
  return { reqs: searches(env).length - s0, units: units(env) - u0, ms: Date.now() - t0 };
}

async function main(file, label, old) {
  const R = [];
  const ok = (name, pass, detail) => R.push({ name, pass: !!pass, detail });

  /* ---------- 1. the first search, and the panel it always was ---------- */
  const env = await boot(file);
  const baseUnits = units(env);            /* boot itself spends on the feed */
  const idsBefore = [...env.d.querySelectorAll('#search [id]')].map(e => e.id).sort().join(',');
  await openPanel(env);
  env.type('lofi');
  await sleep(360);
  await waitFor(() => settled(env), 8000);
  const liveMarkup = markup(env);
  ok('a first search paints twenty cards', cards(env).length === 20, cards(env).length + ' card(s)');
  ok('and costs one search and a hundred units', searches(env).length === 1 && units(env) - baseUnits === 100, searches(env).length + ' request(s), ' + (units(env) - baseUnits) + ' unit(s)');
  ok('the answer was kept for the session', env.w.__ltSearchCache().queries === 1 && env.w.__ltSearchCache().saved === 1,
    'queries=' + env.w.__ltSearchCache().queries + ' saved=' + env.w.__ltSearchCache().saved);
  ok('the window is thirty minutes', env.w.__ltSearchCache().ttl === 30 * MIN, Math.round(env.w.__ltSearchCache().ttl / MIN) + ' min');

  /* ---------- 2. the same query again, five minutes later ---------- */
  env.skew = 5 * MIN;
  const before2 = env.reqs.length;
  env.w.find();
  ok('a repeat paints without a skeleton', skeleton(env) === 0 && cards(env).length === 20, skeleton(env) + ' skeleton(s), ' + cards(env).length + ' card(s)');
  await sleep(120);
  ok('a repeat inside the window sends nothing', env.reqs.length === before2, (env.reqs.length - before2) + ' new request(s)');
  ok('and costs no quota unit', units(env) - baseUnits === 100, (units(env) - baseUnits) + ' unit(s) for two asks');
  ok('the kept answer is the same markup, card for card', markup(env) === liveMarkup, markup(env) === liveMarkup ? 'identical' : 'differs');
  ok('the hit is counted', env.w.__ltSearchCache().hit === 1, 'hit=' + env.w.__ltSearchCache().hit);

  /* ---------- 3. the same question, spelled differently ---------- */
  const before3 = env.reqs.length;
  env.w.document.getElementById('q').value = '  LoFi ';
  env.w.find();
  await sleep(120);
  ok('case and stray spaces are the same question', env.reqs.length === before3 && cards(env).length === 20,
    (env.reqs.length - before3) + ' request(s), ' + cards(env).length + ' card(s)');
  ok('and paint the same cards', markup(env) === liveMarkup);

  /* ---------- 3b. past the request cache's ten minutes, still a hit ---------- */
  env.skew = 15 * MIN;
  const before3b = searches(env).length, u3b = units(env);
  env.w.find();
  await sleep(150);
  ok('a hit at 15 minutes, where the request cache has expired', searches(env).length === before3b && units(env) === u3b,
    (searches(env).length - before3b) + ' request(s), ' + (units(env) - u3b) + ' unit(s)');

  /* ---------- 4. the window: a hit at 29 minutes, a miss at 31 ---------- */
  env.skew = 29 * MIN;
  const before4 = env.reqs.length;
  env.w.find();
  await sleep(120);
  ok('still a hit at 29 minutes', env.reqs.length === before4, (env.reqs.length - before4) + ' request(s)');
  env.skew = 31 * MIN;
  const before5 = searches(env).length, u5 = units(env);
  env.w.find();
  await waitFor(() => settled(env), 8000);
  await sleep(30);
  ok('a miss at 31 minutes, as a search', searches(env).length === before5 + 1 && units(env) - u5 === 100,
    (searches(env).length - before5) + ' request(s), ' + (units(env) - u5) + ' unit(s)');
  ok('the expired entry was dropped, not served', env.w.__ltSearchCache().stale >= 1, 'stale=' + env.w.__ltSearchCache().stale);

  /* ---------- 5. bounded: twelve queries, oldest used out ---------- */
  env.skew = 0;
  const cap = env.w.__ltSearchCache().qmax;
  for (let i = 0; i <= cap; i++) {
    env.d.getElementById('q').value = 'bound-' + i;
    await ask(env, 'bound-' + i);
  }
  const size = env.w.__ltSearchCache().queries;
  ok('the cache is bounded at ' + cap + ' queries', size <= cap, size + ' entries');
  const keys = env.w.__ltSearchCache().keys();
  ok('the newest query is kept', keys[keys.length - 1] === 'bound-' + cap, keys.slice(-2).join(' / '));
  ok('the oldest is gone', !keys.includes('bound-0'), keys[0]);
  /* eleven minutes on, so the request cache (ten) cannot answer it either:
     what is asked now has to be bought, unless the query cache kept it */
  env.skew = 11 * MIN;
  env.d.getElementById('q').value = 'bound-0';
  const reAsk = await ask(env, 'bound-0');
  ok('an evicted query is searched again', reAsk.reqs === 1 && reAsk.units === 100, reAsk.reqs + ' request(s), ' + reAsk.units + ' unit(s)');
  env.d.getElementById('q').value = 'bound-' + cap;
  const still = await ask(env, 'bound-' + cap);
  ok('a query asked again stays a hit', still.reqs === 0, still.reqs + ' request(s)');

  /* ---------- 6. failures are not kept, empty answers are ---------- */
  env.skew = 0;
  env.fail = 'error';
  env.d.getElementById('q').value = 'failing-query';
  await ask(env, 'failing-query');
  env.fail = null;
  const afterFail = await ask(env, 'failing-query');
  ok('a failed search is not kept: the retry asks again', afterFail.reqs === 1, afterFail.reqs + ' request(s)');
  env.d.getElementById('q').value = 'no-hits here';
  const empty1 = await ask(env, 'no-hits here');
  const emptyMarkup = markup(env);
  ok('an empty answer is painted, and says so', /No videos match that/.test(emptyMarkup) && cards(env).length === 0, emptyMarkup.slice(0, 40));
  const empty2 = await ask(env, 'no-hits here');
  ok('and is repeated for free', empty1.reqs === 1 && empty2.reqs === 0 && markup(env) === emptyMarkup, empty2.reqs + ' request(s) on the repeat');

  /* ---------- 7. a hit writes nothing ---------- */
  env.d.getElementById('q').value = 'bound-' + cap;     /* the newest kept query: a hit */
  const blobBefore = String(env.storage().lt_search || '');
  const keysBefore = Object.keys(env.storage()).sort().join(',');
  const hitAsk = await ask(env, 'bound-' + cap);
  ok('the ask really was a hit', hitAsk.reqs === 0, hitAsk.reqs + ' request(s)');
  ok('a hit leaves the launch blob untouched', String(env.storage().lt_search || '') === blobBefore, blobBefore.length + ' bytes');
  ok('and adds no key of its own', Object.keys(env.storage()).sort().join(',') === keysBefore, keysBefore);
  ok('the launch blob is still one key', Object.keys(env.storage()).filter(k => k === 'lt_search').length === 1);

  /* ---------- 8. the panel is the panel it was ---------- */
  const idsAfter = [...env.d.querySelectorAll('#search [id]')].map(e => e.id).sort().join(',');
  ok('the panel has the same ids it had', idsAfter === idsBefore, idsAfter);
  ok('the cards are the same twenty, with avatars', cards(env).length === 20 && env.d.querySelectorAll('#results .card img.av').length === 20,
    cards(env).length + ' cards, ' + env.d.querySelectorAll('#results .card img.av').length + ' avatar(s)');
  env.w.close();

  /* ---------- 9. A/B: what the previous build cost for the same repeat ---------- */
  if (old) {
    const o = await boot(old);
    await openPanel(o);
    o.type('lofi');
    await sleep(360);
    await waitFor(() => settled(o), 8000);
    o.skew = 15 * MIN;
    const u0 = units(o), n0 = searches(o).length;
    o.w.find();
    await waitFor(() => settled(o), 8000);
    await sleep(30);
    ok('[old] the same repeat after ten minutes costs another search', searches(o).length === n0 + 1 && units(o) - u0 === 100,
      (searches(o).length - n0) + ' request(s), ' + (units(o) - u0) + ' unit(s)');
    o.w.close();
  }

  return { label, R };
}

(async () => {
  const out = [await main(NEW_FILE, 'new', OLD_FILE)];
  let failed = 0;
  for (const { label, R } of out) {
    console.log('# ' + label);
    for (const r of R) {
      console.log((r.pass ? 'ok   ' : 'FAIL ') + r.name + (r.detail !== undefined ? '  [' + r.detail + ']' : ''));
      if (!r.pass) failed++;
    }
  }
  console.log('');
  console.log(failed ? 'FAIL — ' + failed + ' assertion(s)' : 'PASS — ' + out[0].R.length + ' assertions');
  process.exit(failed ? 1 : 0);
})();
