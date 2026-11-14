#!/usr/bin/env node
/*
 * LiquidTube search-reopen check — proves item 7.2: the last query and its
 * results are still there when the search panel is opened again, and a launch
 * no longer costs a search to get them back.
 *
 * What it holds the build to:
 *
 *   1. In-session, closing and reopening the panel keeps the query and the cards
 *      and sends nothing (the behaviour that already existed, not regressed).
 *   2. Across a launch (same localStorage, a fresh window) the panel opens with
 *      the last query in the field and the same twenty cards, with **no request**
 *      and **no quota unit** spent.
 *   3. The restored markup is the same markup the live search painted — the
 *      cards are the ones the app drew, not a re-invention of them.
 *   4. What is kept is one key, bounded to the panel's page size, compressed.
 *   5. An answer that was cleared, or that came from another build, or that is
 *      corrupt, is never painted over the user's own state.
 *   6. A shelf's View All still opens the panel for *its* query and searches at
 *      once: the cached answer is not flashed underneath it.
 *   7. A failed search does not overwrite the last good answer.
 *
 * jsdom + fixed fixtures, no network. Dev-only, not shipped in the APK.
 *
 *   NODE_PATH=/scratch/node_modules node tools/search-reopen-check.js \
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
const LATENCY = 60;                        // ms per request
const sleep = ms => new Promise(r => setTimeout(r, ms));

const pad = n => String(n).padStart(2, '0');
const vids = Array.from({ length: 24 }, (_, i) => 'v' + pad(i + 1) + 'AAAAAAAA');
const CH_IDS = Array.from({ length: 6 }, (_, i) => 'UC' + i + 'xxxxxxxxxxxxxxxxxxxx');
const pub = d => new Date(Date.UTC(2026, 9, 31) - d * 864e5).toISOString();

/* the real endpoint honours maxResults (the panel asks for 20); the mock does
   too, so the page the panel draws is the page the API would send */
const searchBody = (q, max) => ({
  items: vids.slice(0, max || 20).map((id, i) => ({
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

/* One window. `seed` is the localStorage a launch starts with, so a second call
   to open() is the next launch of the app rather than a new machine. */
function open(file, seed, opts) {
  const o = opts || {};
  const HTML = fs.readFileSync(file, 'utf8');
  const reqs = [];
  const env = { reqs, seed: seed || {}, fail: o.fail || null };
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
/* the first place two renderings disagree, for the assertion that says they
   must not — a card-sized chunk either side of it, so the detail is readable */
function firstDiff(a, b) {
  const A = String(a).split('</button>'), B = String(b).split('</button>');
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    if (A[i] !== B[i]) {
      const x = A[i] || '', y = B[i] || '';
      let j = 0;
      while (j < x.length && j < y.length && x[j] === y[j]) j++;
      return 'card ' + i + ' @' + j + ' live…' + JSON.stringify(x.slice(j, j + 90)) + ' restored…' + JSON.stringify(y.slice(j, j + 90));
    }
  }
  return 'same chunks, different length';
}
const cards = env => env.d.querySelectorAll('#results .card');
const searches = env => env.reqs.filter(r => /\/search\?/.test(r.url));
const units = env => env.w.__ltQuota().units;
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
/* one settled search on a fresh launch, and the storage that launch leaves */
async function searchOnce(file, q) {
  const env = await boot(file);
  await openPanel(env);
  env.type(q);
  await sleep(360);
  await waitFor(() => settled(env), 8000);
  const markup = norm(env.d.getElementById('results').innerHTML);
  return { env, markup };
}

async function main(file, label) {
  const R = [];
  const ok = (name, pass, detail) => R.push({ name, pass: !!pass, detail });

  /* ---------- 1. in-session: unchanged ---------- */
  {
    const { env, markup } = await searchOnce(file, 'lofi');
    ok('a search settles on twenty cards', cards(env).length === 20, cards(env).length + ' card(s)');
    const before = searches(env).length;
    await closePanel(env);
    await openPanel(env);
    ok('closing and reopening keeps the query in the field', env.d.getElementById('q').value === 'lofi', JSON.stringify(env.d.getElementById('q').value));
    ok('and keeps the cards', cards(env).length === 20, cards(env).length + ' card(s)');
    ok('and sends nothing to get them back', searches(env).length === before, (searches(env).length - before) + ' new request(s)');
    ok('the reopened panel is the same markup', norm(env.d.getElementById('results').innerHTML) === markup);
    env.w.close();
  }

  /* ---------- 2. across a launch: the point of the item ---------- */
  let seed = null, liveMarkup = '';
  {
    const { env, markup } = await searchOnce(file, 'lofi beats');
    liveMarkup = markup;
    seed = env.storage();
    ok('the answer was kept for the next launch', !!seed.lt_search, Object.keys(seed).join(','));
    ok('it is one key, not a copy of the page', Object.keys(seed).filter(k => k === 'lt_search').length === 1);
    ok('it is compressed by the codec', /^z/.test(String(seed.lt_search || '').slice(0, 1)) || String(seed.lt_search || '').length < 4096, String(seed.lt_search || '').slice(0, 24) + '… (' + String(seed.lt_search || '').length + ' bytes)');
    const cached = env.w.__ltSearchCache().cached;
    ok('what is kept is the page that was drawn',
      cached && cached.items === 20, cached && cached.items + ' item(s) for a 20-item answer');
    ok('the stored query is the one asked', cached && cached.q === 'lofi beats', cached && cached.q);
    env.w.close();
  }
  {
    const env = await boot(file, seed);
    const u0 = units(env);
    await openPanel(env);
    await sleep(200);
    ok('a new launch opens the panel with the last query', env.d.getElementById('q').value === 'lofi beats', JSON.stringify(env.d.getElementById('q').value));
    ok('and with its results already drawn', cards(env).length === 20, cards(env).length + ' card(s)');
    ok('the suggestions row is hidden, as it is for any filled field', env.d.getElementById('sug').style.display === 'none', env.d.getElementById('sug').style.display);
    ok('it costs no request', searches(env).length === 0, searches(env).length + ' search request(s)');
    ok('and no quota unit', units(env) - u0 === 0, (units(env) - u0) + ' unit(s)');
    const gotMarkup = norm(env.d.getElementById('results').innerHTML);
    ok('the restored panel is byte-identical to the live one', gotMarkup === liveMarkup,
      gotMarkup === liveMarkup ? undefined : firstDiff(liveMarkup, gotMarkup));
    ok('the restored cards are the same twenty videos', (() => {
      const ids = [...cards(env)].map(c => c.dataset.v);
      return ids.length === 20 && ids[0] === vids[0] && ids[19] === vids[19];
    })(), [...cards(env)].slice(0, 2).map(c => c.dataset.v).join(','));
    ok('a card still opens the video it names', (() => {
      const c = cards(env)[3];
      return !!c && c.tagName === 'BUTTON' && c.dataset.v === vids[3];
    })());
    /* and from there it behaves like a typed panel: a new query still searches */
    env.type('calm piano');
    await sleep(360);
    await waitFor(() => /calm piano/.test(env.d.getElementById('results').innerHTML), 8000);
    ok('typing over a restored answer searches normally', searches(env).length === 1 && /Result 0 for calm piano/.test(env.d.getElementById('results').innerHTML), searches(env).length + ' request(s)');
    env.w.close();
  }

  /* ---------- 3. it never paints over the user's own state ---------- */
  {
    /* a cleared field stays cleared */
    const env = await boot(file, seed);
    await openPanel(env);
    await sleep(150);
    ok('a restored panel can be cleared', cards(env).length === 20);
    env.type('');
    await sleep(80);
    ok('clearing empties the panel', cards(env).length === 0, cards(env).length + ' card(s)');
    await closePanel(env);
    await openPanel(env);
    await sleep(150);
    ok('reopening after a clear does not resurrect the old answer', cards(env).length === 0 && env.d.getElementById('q').value === '', JSON.stringify(env.d.getElementById('q').value) + ' / ' + cards(env).length + ' card(s)');
    ok('and it sends nothing', searches(env).length === 0, searches(env).length + ' request(s)');
    env.w.close();
  }
  {
    /* a shelf's View All opens the panel for its own query */
    const env = await boot(file, seed);
    const sh = env.d.querySelector('[data-shelf]');
    ok('the feed still offers a shelf to open', !!sh, sh && sh.dataset.shelf);
    if (sh) {
      sh.click();
      await sleep(40);
      const during = norm(env.d.getElementById('results').innerHTML);
      ok('the shelf paints its own query, never the cached answer', !/for lofi beats/.test(during), during.slice(0, 60) + '…');
      ok('the field holds the shelf query, not the cached one', env.d.getElementById('q').value !== 'lofi beats', JSON.stringify(env.d.getElementById('q').value));
      await waitFor(() => settled(env), 8000);
      ok('and the shelf answer is the one drawn', cards(env).length > 0 && !/for lofi beats/.test(env.d.getElementById('results').innerHTML));
    }
    env.w.close();
  }
  {
    /* another build's blob, and a corrupt one */
    const foreign = Object.assign({}, seed);
    foreign.lt_search = JSON.stringify({ v: 0, q: 'old build', at: 1, items: [{ id: vids[0], t: 'stale', c: 'x', ch: CH_IDS[0] }] });
    const a = await boot(file, foreign);
    await openPanel(a);
    await sleep(200);
    ok('an entry written by another build is ignored', cards(a).length === 0 && a.d.getElementById('q').value === '', cards(a).length + ' card(s)');
    a.w.close();

    const broken = Object.assign({}, seed);
    broken.lt_search = '{not json at all';
    const b = await boot(file, broken);
    await openPanel(b);
    await sleep(200);
    ok('a corrupt entry is ignored, not thrown', cards(b).length === 0 && b.d.getElementById('q').value === '', cards(b).length + ' card(s)');
    ok('and the app still searches afterwards', (() => { b.type('telugu songs'); return true; })());
    await sleep(360);
    await waitFor(() => settled(b), 8000);
    ok('the search after a corrupt entry still lands', cards(b).length === 20, cards(b).length + ' card(s)');
    b.w.close();

    /* an entry that is longer than the panel's page is still bounded on the way
       back in: a hand-written 60-item blob restores SEA_MAX of them, not 60 */
    const huge = Object.assign({}, seed);
    huge.lt_search = JSON.stringify({
      v: 1, q: 'a very long answer', at: Date.now(),
      items: Array.from({ length: 60 }, (_, i) => ({ id: 'x' + String(i).padStart(2, '0') + 'ZZZZZZZZ', t: 'Item ' + i, c: 'Channel', ch: CH_IDS[i % 6], views: '', pub: pub(i), cat: 'Result' })),
    });
    const c = await boot(file, huge);
    await openPanel(c);
    await sleep(200);
    const cap = c.w.__ltSearchCache().max;
    ok('a 60-item entry restores the ceiling, not all 60', cards(c).length === cap && cap < 60, cards(c).length + ' of 60 restored, ceiling ' + cap);
    c.w.close();
  }

  /* ---------- 4. a failure does not overwrite the last good answer ---------- */
  {
    const env = await boot(file, seed);
    env.fail = 'error';
    await openPanel(env);
    await sleep(120);
    env.type('a query that fails');
    await sleep(360);
    await waitFor(() => /empty/.test(env.d.getElementById('results').innerHTML), 8000);
    ok('the failed search says so', /empty/.test(env.d.getElementById('results').innerHTML));
    const kept = env.w.__ltSearchCache().cached;
    ok('the last good answer is still what is kept', kept && kept.q === 'lofi beats' && kept.items === 20, kept && kept.q + ' / ' + (kept && kept.items));
    env.w.close();
  }

  /* ---------- 5. A/B against the previous build ---------- */
  if (OLD_FILE) {
    const oldSeed = await (async () => {
      const env = await boot(OLD_FILE);
      await openPanel(env);
      env.type('lofi beats');
      await sleep(360);
      await waitFor(() => env.d.querySelectorAll('#results .card').length > 0, 8000);
      const s = env.storage();
      env.w.close();
      return s;
    })();
    ok('the previous build kept no search at all', !oldSeed.lt_search, Object.keys(oldSeed).join(','));
    const env = await boot(OLD_FILE, oldSeed);
    const u0 = units(env);
    await openPanel(env);
    await sleep(250);
    const n = env.d.querySelectorAll('#results .card').length;
    ok('[old] a new launch opens the panel empty', n === 0 && env.d.getElementById('q').value === '', n + ' card(s)');
    env.type('lofi beats');
    await sleep(360);
    await waitFor(() => env.d.querySelectorAll('#results .card').length > 0, 8000);
    ok('[old] and the same query costs another search to get back', searches(env).length === 1 && units(env) - u0 === 100, searches(env).length + ' request(s), ' + (units(env) - u0) + ' unit(s)');
    env.w.close();
  }

  return { label, R };
}

(async () => {
  const out = [await main(NEW_FILE, 'new')];
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
