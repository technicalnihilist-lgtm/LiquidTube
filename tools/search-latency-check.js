#!/usr/bin/env node
/*
 * LiquidTube search-latency check — proves item 7.10 ("log query latency").
 *
 * The search panel is the most expensive thing this app asks for, and until now
 * nothing about it was measured: the boot had a timeline (1.1) and a search had
 * no number at all. Every search that reaches the panel now leaves one line
 * under the prefix MainActivity forwards to logcat:
 *
 *   lt-search ms=612 net=298 wait=300 res=20 src=net ok=1 n=1
 *
 * What this tool holds the build to, in jsdom against fixtures (no network, no
 * device, 60 ms mocked round trip):
 *
 *  1. One typed query = one line, and the line's numbers are the search's own:
 *     `wait` is the 300 ms pause of 7.1, `net` is at least the mocked round trip,
 *     `ms` is the whole ask → paint and is never smaller than its parts, `res` is
 *     the twenty cards on screen, `src=net`, `ok=1`, `n=1`.
 *  2. A kept answer (7.3) is logged as what it was: `src=keep`, `net=0`, no
 *     request, and a wait far below the live one.
 *  3. A failed search is logged as a failure — `ok=0`, `res=0`, and `kind=` the
 *     class the panel already names (5.2) — not as a slow success.
 *  4. A search the user abandons is not a latency: closing the panel mid-flight
 *     logs no line and counts the abort, exactly as AbortError is not a failure.
 *  5. The log is bounded: thirty searches print twenty-four lines, `dropped`
 *     counts the rest, the sample ring stays inside its cap, and the counters
 *     keep counting every one of them.
 *  6. `window.__ltSearch()` is a census, not a write: no DOM, no storage, and the
 *     median it reports is one of its own samples.
 *  7. The panel is the panel it always was: same ids, same card count, same
 *     markup as the previous build, no new element and no new string on screen.
 *  8. The boot self-check of 5.10 carries the new invariant and still passes.
 *
 * jsdom + fixed fixtures, no network. Dev-only, not shipped in the APK.
 *
 *   NODE_PATH=/scratch/work/tooling/node_modules node tools/search-latency-check.js \
 *       app/assets/index.html /path/to/previous/index.html
 *
 * argv[2] is the build under test, argv[3] the previous build (optional; the A/B
 * half is skipped without it).
 */
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const NEW_FILE = process.argv[2] || path.join(__dirname, '..', 'app/assets/index.html');
const OLD_FILE = process.argv[3] || '';
const LATENCY = 60;                        // ms per request
const PAUSE = 300;                         // the search debounce (item 7.1)
const sleep = ms => new Promise(r => setTimeout(r, ms));

const pad = n => String(n).padStart(2, '0');
const vids = Array.from({ length: 24 }, (_, i) => 'v' + pad(i + 1) + 'AAAAAAAA');
const CH_IDS = Array.from({ length: 6 }, (_, i) => 'UC' + i + 'xxxxxxxxxxxxxxxxxxxx');
const pub = d => new Date(Date.UTC(2026, 9, 31) - d * 864e5).toISOString();

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

/* One window, and the console it writes to: `lt-search` lines are captured the
   way logcat would see them — what the page printed, not what the code says. */
function open(file, opts) {
  const o = opts || {};
  const HTML = fs.readFileSync(file, 'utf8');
  const reqs = [], lines = [], errors = [];
  const env = { reqs, lines, errors, fail: null };
  const vc = new VirtualConsole();
  vc.on('info', m => lines.push(String(m)));
  vc.on('log', m => lines.push(String(m)));
  vc.on('error', m => errors.push(String(m)));
  vc.on('jsdomError', e => { if (!/WebAssembly|Cannot allocate/i.test(String(e && e.message))) errors.push(String(e && e.message)); });
  const mockFetch = (u, init) => {
    const url = String(u);
    const rec = { url: url.replace(/([?&])key=[^&]*/, '$1key=<key>'), aborted: false, done: false, q: new URL(url).searchParams.get('q') };
    reqs.push(rec);
    return new Promise((res, rej) => {
      const t = setTimeout(() => {
        rec.done = true;
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
    url: 'https://liquidtube.local/index.html' + (o.debug ? '?ltdebug=1' : ''),
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(w) {
      w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
      w.fetch = mockFetch;
      w.scrollTo = () => {};
    },
  });
  env.w = dom.window;
  env.d = dom.window.document;
  env.dom = dom;
  env.type = text => { const qi = env.d.getElementById('q'); qi.value = text; qi.dispatchEvent(new env.w.Event('input')); };
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
function norm(h) {
  return String(h)
    .replace(/ class="ld"/g, '').replace(/ ld"/g, '"')
    .replace(/ data-f="1"/g, '')
    .replace(/ ?(?:transform|opacity|background-position-y):[^;"']*;?/g, '')
    .replace(/style="\s*"/g, '').replace(/\s{2,}/g, ' ').trim();
}

const cards = env => env.d.querySelectorAll('#results .card');
const searches = env => env.reqs.filter(r => /\/search\?/.test(r.url));
const markup = env => norm(env.d.getElementById('results').innerHTML);
const lat = env => env.w.__ltSearch();
const lines = env => env.lines.filter(l => l.indexOf('lt-search ') === 0);
/* "lt-search ms=612 net=298 wait=300 res=20 src=net ok=1 n=1" → an object */
function parse(line) {
  const o = {};
  line.replace(/^lt-search /, '').split(' ').forEach(kv => {
    const i = kv.indexOf('=');
    if (i > 0) o[kv.slice(0, i)] = kv.slice(i + 1);
  });
  return o;
}
const settled = env => cards(env).length > 0 && !env.d.querySelector('#results .skl');

async function boot(file, opts) {
  const env = open(file, opts);
  await waitFor(() => env.d.querySelectorAll('#feed .card').length > 0);
  await waitFor(() => !env.d.querySelector('#ex .skl'));
  await sleep(250);
  env.reqs.length = 0;
  env.lines.length = 0;
  return env;
}
const openPanel = async env => { env.d.getElementById('sopen').click(); await sleep(120); };

async function main(file, label, old) {
  const R = [];
  const ok = (name, pass, detail) => R.push({ name, pass: !!pass, detail });

  /* ---------- 1. one typed query, one line, and it is that search's own ---------- */
  const env = await boot(file);
  const idsBefore = [...env.d.querySelectorAll('#search [id]')].map(e => e.id).sort().join(',');
  await openPanel(env);
  env.type('lofi');
  await waitFor(() => settled(env), 8000);
  await sleep(60);
  const L = lines(env);
  ok('a typed query leaves exactly one line', L.length === 1, L.length + ' line(s): ' + JSON.stringify(L));
  const l1 = parse(L[0] || '');
  const ms1 = +l1.ms, net1 = +l1.net, wait1 = +l1.wait;
  ok('the line has every documented key', ['ms', 'net', 'wait', 'res', 'src', 'ok', 'n'].every(k => k in l1), JSON.stringify(l1));
  ok('src=net and ok=1 for a live search', l1.src === 'net' && l1.ok === '1', 'src=' + l1.src + ' ok=' + l1.ok);
  ok('res is the twenty cards on screen', +l1.res === 20 && cards(env).length === 20, 'res=' + l1.res + ' cards=' + cards(env).length);
  ok('wait is the 300 ms pause', wait1 >= PAUSE - 40 && wait1 <= PAUSE + 260, 'wait=' + wait1 + 'ms');
  ok('net is at least the round trip', net1 >= LATENCY - 5, 'net=' + net1 + 'ms (mock ' + LATENCY + 'ms)');
  ok('ms is the whole wait, never smaller than its parts', ms1 >= net1 + wait1 - 2 && ms1 >= PAUSE, 'ms=' + ms1 + ' net=' + net1 + ' wait=' + wait1);
  ok('n counts this launch\'s searches', l1.n === '1', 'n=' + l1.n);
  ok('the census agrees with the line', lat(env).n === 1 && lat(env).ok === 1 && lat(env).samples.length === 1 && lat(env).last.ms === ms1,
    JSON.stringify({ n: lat(env).n, ok: lat(env).ok, samples: lat(env).samples.length, last: lat(env).last }));

  /* ---------- 2. a kept answer is logged as what it was ---------- */
  const liveMarkup = markup(env);
  const nodes1 = env.d.querySelectorAll('#search *').length;   /* the panel as the answer left it, for the A/B below */
  const before2 = searches(env).length;
  env.w.find();
  await sleep(150);
  const L2 = lines(env);
  const l2 = parse(L2[1] || '');
  ok('a repeat leaves a second line', L2.length === 2, L2.length + ' line(s)');
  ok('a kept answer is src=keep with no request leg', l2.src === 'keep' && +l2.net === 0 && l2.ok === '1', JSON.stringify(l2));
  ok('and sends nothing', searches(env).length === before2, (searches(env).length - before2) + ' request(s)');
  ok('and is faster than the live one', +l2.ms < ms1 && +l2.ms <= 120, 'keep ms=' + l2.ms + ' vs live ms=' + ms1);
  ok('and paints the same twenty cards', +l2.res === 20 && markup(env) === liveMarkup, 'res=' + l2.res);
  ok('the keep is counted apart from the misses', lat(env).keep === 1 && lat(env).n === 2, 'keep=' + lat(env).keep + ' n=' + lat(env).n);

  /* ---------- 3. a failure is a failure, with its class ---------- */
  env.fail = 'error';
  env.d.getElementById('q').value = 'boom-now';
  env.w.find();
  await waitFor(() => !!env.d.querySelector('#results .empty'), 8000);
  await sleep(60);
  const l3 = parse(lines(env)[2] || '');
  ok('a failed search logs ok=0 with its class', l3.ok === '0' && l3.kind === 'server' && +l3.res === 0, JSON.stringify(l3));
  ok('and still carries a real wait', +l3.ms >= LATENCY - 5 && +l3.net >= LATENCY - 5, 'ms=' + l3.ms + ' net=' + l3.net);
  ok('the failure is counted', lat(env).fail === 1 && lat(env).n === 3, 'fail=' + lat(env).fail + ' n=' + lat(env).n);
  env.fail = null;

  /* ---------- 4. an abandoned search is not a latency ---------- */
  const before4 = lines(env).length, ab0 = lat(env).abort, n0 = lat(env).n;
  env.type('abandon-me');
  await sleep(PAUSE + 40);                       /* the request is out */
  const flying = searches(env).some(r => r.q === 'abandon-me' && !r.done);
  env.d.getElementById('cancel').click();        /* the panel closes mid-flight */
  await sleep(LATENCY + 120);
  ok('the abandoned request was really in flight', flying, 'in flight: ' + flying);
  ok('an abandoned search logs no line', lines(env).length === before4, (lines(env).length - before4) + ' new line(s)');
  ok('but is counted as an abort', lat(env).abort === ab0 + 1 && lat(env).n === n0, 'abort=' + lat(env).abort + ' n=' + lat(env).n);

  /* ---------- 5. bounded: thirty searches, twenty-four lines ---------- */
  const env5 = await boot(file);
  await openPanel(env5);
  for (let i = 0; i < 30; i++) {
    env5.d.getElementById('q').value = 'bound-' + i;
    env5.w.find();
    await waitFor(() => settled(env5) || env5.d.querySelector('#results .empty'), 8000);
  }
  await sleep(120);
  const s5 = lat(env5);
  ok('thirty searches print twenty-four lines', lines(env5).length === 24 && s5.lineCap === 24, lines(env5).length + ' line(s), cap ' + s5.lineCap);
  ok('the rest are counted as dropped', s5.dropped === 6, 'dropped=' + s5.dropped);
  ok('every search is still counted', s5.n === 30 && s5.ok === 30, 'n=' + s5.n + ' ok=' + s5.ok);
  ok('the sample ring stays inside its cap', s5.samples.length === s5.cap && s5.cap === 12, s5.samples.length + '/' + s5.cap);
  ok('the median is one of the samples', s5.samples.some(x => x.ms === s5.p50) && s5.p50 <= s5.max, 'p50=' + s5.p50 + ' max=' + s5.max);
  ok('the census reads nothing it does not own', (() => {
    const a = env5.w.localStorage.length;
    env5.w.__ltSearch(); env5.w.__ltSearch();
    return env5.w.localStorage.length === a && !env5.d.querySelector('[data-lt-search]');
  })(), 'no storage, no element');

  /* ---------- 6. the boot self-check carries the new invariant ---------- */
  const env6 = await boot(file, { debug: true });
  await waitFor(() => env6.w.__ltSelfCheck && env6.w.__ltSelfCheck().runs > 0, 15000);
  const sc = env6.w.__ltSelfCheck();
  ok('the self-check knows the search-latency invariant', sc.names.includes('searchlat'), sc.names.length + ' probes');
  ok('and nothing in it fails', sc.fail === 0, 'fail=' + sc.fail + ' ' + sc.fails.join(','));

  /* ---------- 7. the panel is the panel it always was ---------- */
  ok('the panel keeps every id it had', [...env.d.querySelectorAll('#search [id]')].map(e => e.id).sort().join(',') === idsBefore,
    [...env.d.querySelectorAll('#search [id]')].map(e => e.id).join(','));
  ok('no element was added to the panel', !env.d.querySelector('[data-lt-search]') &&
    env.d.querySelectorAll('#search > *').length === 3 && env.d.querySelectorAll('#search [id]').length === 4,
    env.d.querySelectorAll('#search *').length + ' node(s), ' + env.d.querySelectorAll('#search > *').length + ' top level');
  ok('no console error anywhere', env.errors.length === 0 && env5.errors.length === 0 && env6.errors.length === 0,
    [env.errors[0], env5.errors[0], env6.errors[0]].filter(Boolean).join(' | ') || 'none');

  if (old) {
    const prev = await boot(old);
    await openPanel(prev);
    prev.type('lofi');
    await waitFor(() => settled(prev), 8000);
    await sleep(60);
    ok('A/B: the answer is the same markup as the previous build', markup(prev) === liveMarkup,
      markup(prev) === liveMarkup ? 'identical' : 'differs');
    ok('A/B: the previous build logged nothing of the sort', lines(prev).length === 0, lines(prev).length + ' line(s)');
    ok('A/B: the panel holds the same number of nodes', prev.d.querySelectorAll('#search *').length === nodes1,
      prev.d.querySelectorAll('#search *').length + ' vs ' + nodes1);
    ok('A/B: the panel nodes are the same', [...prev.d.querySelectorAll('#search [id]')].map(e => e.id).sort().join(',') === idsBefore,
      [...prev.d.querySelectorAll('#search [id]')].map(e => e.id).join(','));
  } else {
    ok('A/B skipped: no previous build given', true, 'argv[3] empty');
  }

  /* ---------- report ---------- */
  const pass = R.filter(r => r.pass).length;
  R.forEach(r => console.log((r.pass ? 'PASS ' : 'FAIL ') + r.name + (r.detail ? '  [' + r.detail + ']' : '')));
  console.log('\n' + label + ': ' + pass + '/' + R.length + ' assertions pass');
  if (pass !== R.length) process.exit(1);
}

main(NEW_FILE, 'search-latency', OLD_FILE).then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
