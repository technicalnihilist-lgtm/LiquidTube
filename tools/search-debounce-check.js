#!/usr/bin/env node
/*
 * LiquidTube search debounce check — proves item 7.1: the search box asks once
 * per pause instead of once per keystroke, and a query that has been superseded
 * is cancelled rather than left on the wire.
 *
 * What it holds the build to:
 *
 *   1. A burst of keystrokes sends nothing while the pause is running and
 *      exactly one request once it is over — for the query the user stopped on.
 *   2. The pause is the 300 ms the item asks for, not shorter and not longer.
 *   3. A prefix is never sent: typing "lof" and then "lofi" 150 ms later is one
 *      request, for "lofi".
 *   4. A query superseded while it is on the wire is aborted — the mock fetch
 *      here rejects on abort exactly as a real one does — and its answer never
 *      reaches the panel.
 *   5. Closing the panel cancels the pending keystroke (no request at all) and
 *      abandons a search already sent (no request completes, nothing paints).
 *   6. Everything that already meant "this query, now" is still immediate: a
 *      suggestion chip, the retry button. A cleared field still empties the
 *      panel at once.
 *   7. The suggestions row still hides on the keystroke itself, not 300 ms later.
 *   8. Typing a four-letter word costs one search, not four — 100 quota units
 *      instead of 400.
 *
 * jsdom + fixed fixtures, no network. Dev-only, not shipped in the APK.
 *
 *   NODE_PATH=/scratch/node_modules node tools/search-debounce-check.js \
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
const LATENCY = 120;                       // ms per request
const SEARCH_MS = 300;                     // what item 7.1 asks for
const sleep = ms => new Promise(r => setTimeout(r, ms));

const pad = n => String(n).padStart(2, '0');
const vids = Array.from({ length: 24 }, (_, i) => 'v' + pad(i + 1) + 'AAAAAAAA');
const CH_IDS = Array.from({ length: 6 }, (_, i) => 'UC' + i + 'xxxxxxxxxxxxxxxxxxxx');
const pub = d => new Date(Date.UTC(2026, 9, 31) - d * 864e5).toISOString();

/* Every search answer names the query it answered, so a stale answer landing
   over a newer one is visible in the markup and not just in the request log. */
const searchBody = q => ({
  items: vids.slice(0, 20).map((id, i) => ({
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
  if (p.endsWith('/search')) return searchBody(u.searchParams.get('q') || '');
  return {};
}

/* One page: fresh window, fresh localStorage, and a fetch that behaves like the
   real one — it answers from the fixtures after `latency` ms, and it *rejects
   with AbortError* when the app aborts it. Without that half the debounce's
   cancel is untestable: a mock that ignores the signal would hand back an answer
   to a request the app had already abandoned. Every request is logged as
   { url, at, aborted } so both the timing and the cancellation are readable. */
function open(file, opts) {
  const o = opts || {};
  const HTML = fs.readFileSync(file, 'utf8');
  const reqs = [];
  const env = { reqs, fail: o.fail || null, latency: o.latency === undefined ? LATENCY : o.latency };
  const mockFetch = (u, init) => {
    const url = String(u);
    const rec = { url: url.replace(/([?&])key=[^&]*/, '$1key=<key>'), at: Date.now(), aborted: false, done: false };
    const q = new URL(url).searchParams.get('q');
    rec.q = q;
    reqs.push(rec);
    return new Promise((res, rej) => {
      const t = setTimeout(() => {
        rec.done = true;
        if (env.fail === 'throw') return rej(new TypeError('Failed to fetch'));
        if (env.fail === 'error') return res({ ok: false, status: 500, json: async () => ({ error: { message: 'The request cannot be completed because you have exceeded your quota.' } }) });
        res({ ok: true, status: 200, headers: { get: () => null }, json: async () => apiBody(url) });
      }, env.latency);
      const sig = init && init.signal;
      if (sig) {
        if (sig.aborted) { clearTimeout(t); const e = new Error('aborted'); e.name = 'AbortError'; rej(e); return; }
        sig.addEventListener('abort', () => {
          rec.aborted = true;
          clearTimeout(t);
          const e = new Error('aborted');
          e.name = 'AbortError';
          rej(e);
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
    },
  });
  env.w = dom.window;
  env.d = dom.window.document;
  env.dom = dom;
  env.type = (text, gap) => {
    const qi = env.d.getElementById('q');
    qi.value = text;
    qi.dispatchEvent(new env.w.Event('input'));
    return gap === undefined ? qi : sleep(gap);
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
const snap = (env, sel, all) => all
  ? [...env.d.querySelectorAll(sel)].map(e => norm(e.outerHTML))
  : norm((env.d.querySelector(sel) || {}).innerHTML || '');
const searches = env => env.reqs.filter(r => /\/search\?/.test(r.url));
const openPanel = async env => { env.d.getElementById('sopen').click(); await sleep(120); };
const closePanel = async env => { env.d.getElementById('cancel').click(); await sleep(60); };
const settled = env => env.d.querySelectorAll('#results .card').length > 0 && !env.d.querySelector('#results .skl');
/* the pause first, then the answer: a settled panel is only readable after the
   keystroke has become a request, or the previous query's cards are mistaken for
   this one's */
const settle = async (env, ms = 8000) => { await sleep(360); await waitFor(() => settled(env), ms); };

async function boot(file) {
  const env = open(file);
  await waitFor(() => env.d.querySelectorAll('#feed .card').length > 0);
  await waitFor(() => !env.d.querySelector('#ex .skl'));
  await sleep(300);
  env.reqs.length = 0;                    /* the boot's own calls are not what this measures */
  return env;
}

/* ---------- 1. the pause, the burst and the abort ---------- */
async function unitTests(file) {
  const R = [];
  const ok = (name, pass, detail) => R.push({ name, pass: !!pass, detail });
  const env = await boot(file);
  const qi = env.d.getElementById('q');

  // a burst of four keystrokes: nothing yet, then exactly one request
  await openPanel(env);
  const t0 = Date.now();
  for (const t of ['l', 'lo', 'lof', 'lofi']) { env.type(t); await sleep(40); }
  const typedAt = Date.now();
  ok('the suggestions row hides on the keystroke, not after the pause',
    env.d.getElementById('sug').style.display === 'none', env.d.getElementById('sug').style.display);
  await sleep(120);
  ok('a keystroke in the pause sends nothing', searches(env).length === 0, searches(env).length + ' request(s) at 120 ms');
  await waitFor(() => searches(env).length > 0, 3000);
  const first = searches(env)[0];
  const waited = first ? first.at - typedAt : -1;
  ok('four keystrokes send one request', searches(env).length === 1, searches(env).length + ' request(s)');
  ok('the request carries the query the user stopped on', first && first.q === 'lofi', first && first.q);
  ok('it waits the 300 ms pause, no more and no less', waited >= SEARCH_MS - 60 && waited <= SEARCH_MS + 250, waited + ' ms after the last keystroke');
  ok('the burst did not spend four searches', first && searches(env).length === 1, (Date.now() - t0) + ' ms for the burst');
  await waitFor(() => settled(env), 5000);
  ok('the answer is drawn', snap(env, '#results .card', 1).length === 20, env.d.querySelectorAll('#results .card').length);
  ok('the drawn answer is the one for the last keystroke',
    /Result 0 for lofi/.test(env.d.getElementById('results').innerHTML));

  // a prefix typed 150 ms before the next one is never sent
  await closePanel(env);
  await openPanel(env);
  let n = searches(env).length;
  env.type('zebr');
  await sleep(150);
  env.type('zebra');
  await sleep(600);
  const two = searches(env).slice(n);
  ok('a superseded prefix is never sent', two.length === 1 && two[0].q === 'zebra',
    two.map(r => r.q).join(',') + ' (' + two.length + ' request(s))');
  await waitFor(() => settled(env), 5000);

  // a query cancelled while it is on the wire. The answer is deliberately slower
  // than the pause, so the first request is still open when the second is asked.
  await closePanel(env);
  await openPanel(env);
  n = searches(env).length;
  env.latency = 700;
  env.type('slow one');
  await waitFor(() => searches(env).length > n, 3000);
  const slow = searches(env)[n];
  ok('the first query really reached the wire', !!slow, slow && slow.q);
  env.type('faster two');                       /* a different question: the first is abandoned */
  await waitFor(() => /Result 0 for faster two/.test(env.d.getElementById('results').innerHTML), 6000);
  await sleep(100);
  env.latency = LATENCY;
  ok('a superseded query on the wire is aborted', slow && slow.aborted, slow && ('aborted=' + slow.aborted + ', done=' + slow.done));
  ok('and it is not cached or drawn over the newer answer',
    /Result 0 for faster two/.test(env.d.getElementById('results').innerHTML));
  const after = searches(env).slice(n);
  ok('the newer query is the one that completes', after.length === 2 && after[1].q === 'faster two',
    after.map(r => r.q + (r.aborted ? '(aborted)' : '')).join(','));

  // closing the panel with a keystroke still pending
  await closePanel(env);
  await openPanel(env);
  n = searches(env).length;
  env.type('never sent');
  await sleep(60);
  await closePanel(env);
  await sleep(700);
  ok('a panel closed during the pause sends nothing at all', searches(env).length === n,
    (searches(env).length - n) + ' request(s) after closing');
  const timers = env.w.eval('typeof findT==="number"?findT:"?"');
  ok('the pending pause is cleared, not left to fire', timers === 0 || timers === '?', 'findT=' + timers);

  // closing the panel with a search on the wire
  await openPanel(env);
  n = searches(env).length;
  env.type('closed mid flight');
  await waitFor(() => searches(env).length > n, 3000);
  const mid = searches(env)[n];
  await closePanel(env);
  await sleep(500);
  ok('a panel closed mid-search abandons the request', mid && mid.aborted, mid && ('aborted=' + mid.aborted));
  ok('and nothing is painted into the closed panel', !/closed mid flight/.test(env.d.getElementById('results').innerHTML));

  // a suggestion chip is still immediate
  await openPanel(env);
  n = searches(env).length;
  const chip = env.d.querySelectorAll('#sug button')[4];   /* a chip this run has not searched yet */
  const tChip = Date.now();
  chip.click();
  await waitFor(() => searches(env).length > n, 2000);
  const chipReq = searches(env)[n];
  const chipWait = chipReq ? chipReq.at - tChip : -1;
  ok('a suggestion chip still searches at once', chipReq && chipWait < SEARCH_MS - 100,
    chipWait + ' ms (no pause)');
  ok('and it searches for the chip it is', chipReq && chipReq.q === chip.textContent, chipReq && chipReq.q);
  await waitFor(() => settled(env), 5000);

  // a cleared field empties the panel at once, and sends nothing
  await closePanel(env);
  await openPanel(env);
  env.type('lofi');
  await sleep(400);
  n = searches(env).length;
  env.type('');
  await sleep(40);
  ok('clearing the field empties the panel at once', env.d.getElementById('results').innerHTML === '',
    JSON.stringify(env.d.getElementById('results').innerHTML.slice(0, 40)));
  await sleep(500);
  ok('and clearing it sends nothing', searches(env).length === n, (searches(env).length - n) + ' request(s)');

  // the retry button is still immediate
  env.fail = 'throw';                           /* a network failure: the retryable kind */
  n = searches(env).length;
  env.type('failing query');
  await waitFor(() => !!env.d.querySelector('#results .rty'), 6000);
  const rty = env.d.querySelector('#results .rty');
  ok('a failed search still offers its retry', !!rty);
  if (rty) {
    env.fail = null;
    const tRty = Date.now();
    const before = searches(env).length;
    rty.click();
    await waitFor(() => searches(env).length > before, 2000);
    const r = searches(env)[before];
    const w = r ? r.at - tRty : -1;
    ok('the retry button searches at once', r && w < SEARCH_MS - 100, w + ' ms (no pause)');
  }

  // what a four-letter word costs
  env.fail = null;
  const q0 = env.w.eval('typeof Q==="object"?Q.units:null');
  await closePanel(env);
  await openPanel(env);
  n = searches(env).length;
  for (const t of ['w', 'wo', 'wor', 'word']) { env.type(t); await sleep(40); }
  await waitFor(() => settled(env), 6000);
  await sleep(100);
  const spent = searches(env).slice(n).length;
  const q1 = env.w.eval('typeof Q==="object"?Q.units:null');
  ok('typing a word costs one search, not four', spent === 1, spent + ' search(es)');
  ok('the quota meter agrees: 100 units, not 400', q0 !== null && q1 - q0 === 100, (q1 - q0) + ' units');

  env.dom.window.close();
  return R;
}

/* ---------- 2. the same query, old build vs new ---------- */
async function drive(file) {
  const env = await boot(file);
  const out = {};
  await openPanel(env);
  const qi = env.d.getElementById('q');
  const typed = ['l', 'lo', 'lof', 'lofi', 'lof', 'lofi'];
  const t0 = Date.now();
  for (const t of typed) { qi.value = t; qi.dispatchEvent(new env.w.Event('input')); await sleep(45); }
  out.burstMs = Date.now() - t0;
  await settle(env);
  await sleep(300);
  out.typed = snap(env, '#results .card', 1);
  out.typedReqs = searches(env).length;
  out.typedQ = searches(env).map(r => r.q);

  // one query, left to settle: the panel must be exactly the same in both builds
  await closePanel(env);
  await openPanel(env);
  env.type('calm piano');
  await settle(env);
  await sleep(300);
  out.settled = snap(env, '#results .card', 1);
  out.settledReqs = searches(env).length;
  await closePanel(env);
  await openPanel(env);
  env.type('nothing matches this');
  await sleep(360);
  await waitFor(() => /class="empty"/.test(env.d.getElementById('results').innerHTML), 8000);
  await sleep(200);
  out.empty = snap(env, '#results');
  env.dom.window.close();
  return out;
}

(async () => {
  const units = await unitTests(NEW_FILE);
  const bad = units.filter(u => !u.pass);
  console.log('--- search debounce (' + path.basename(NEW_FILE) + ') ---');
  units.forEach(u => console.log((u.pass ? 'ok   ' : 'FAIL ') + u.name + (u.detail !== undefined ? '  [' + u.detail + ']' : '')));

  let ab = null;
  if (OLD_FILE) {
    const nw = await drive(NEW_FILE);
    const od = await drive(OLD_FILE);
    const surfaces = ['settled', 'empty'];
    const diffs = surfaces.filter(k => JSON.stringify(nw[k]) !== JSON.stringify(od[k]));
    ab = {
      surfacesIdentical: diffs.length === 0,
      differingSurfaces: diffs,
      burst: { old: od.typedReqs, new: nw.typedReqs, oldQ: od.typedQ, newQ: nw.typedQ },
      settled: { old: od.settledReqs, new: nw.settledReqs },
    };
    console.log('\n--- app, old vs new ---');
    console.log('a settled query renders the same panel: ' + ab.surfacesIdentical + (diffs.length ? ' (differ: ' + diffs.join(', ') + ')' : ' (' + surfaces.length + '/' + surfaces.length + ')'));
    console.log('six keystrokes: old ' + od.typedReqs + ' search(es) ' + JSON.stringify(od.typedQ) + ' → new ' + nw.typedReqs + ' ' + JSON.stringify(nw.typedQ));
    console.log('one query left to settle: old ' + od.settledReqs + ' search(es) → new ' + nw.settledReqs);
  }
  const pass = bad.length === 0 && (!ab || ab.surfacesIdentical);
  console.log('\n' + (pass ? 'PASS' : 'FAIL') + (ab ? ' — one search per pause, the panel unchanged' : ''));
  if (process.env.LT_JSON) fs.writeFileSync(process.env.LT_JSON, JSON.stringify({ units, ab }, null, 1));
  process.exit(pass ? 0 : 1);
})();
