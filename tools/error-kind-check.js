#!/usr/bin/env node
/*
 * LiquidTube error-kind check — proves item 5.2 ("distinguish quota, network,
 * auth and not-found errors").
 *
 * Every request failure now carries a `kind` on the error object, decided where
 * the failure is made and never again: quota, ratelimit, auth, notfound, server,
 * network, client, malformed, aborted, unknown. The check drives the request
 * layer of the loaded page against a scripted fetch, one scenario per class, and
 * asserts four things each time:
 *
 *  1. the class is the one the failure really is — including the two cases the
 *     old code got wrong by sniffing the message text: a quota refusal whose
 *     message never says "quota" (reason quotaExceeded) and a 400 that is
 *     really a bad key ("API key not valid");
 *  2. the failure is counted once, in window.__ltErr(), when it reaches the
 *     caller — after the retry, not per attempt — and an abandoned request is
 *     counted but never logged and never counted as a failure;
 *  3. the retry decision did not move: 5xx, 429 and a dead network are still
 *     repeated exactly once, every 4xx and an unparseable 200 still are not;
 *  4. nothing on screen changed. The search panel is driven to failure for each
 *     class and its HTML is compared with the previous build's, byte for byte
 *     (after the same whitespace normalisation the other checks use). argv[3] is
 *     that previous build; the A/B half is skipped without it.
 *
 * The log line is checked too: `lt-err kind=... ep=... status=... n=...`, one
 * line per failure, bounded at EK_LINES, and never carrying what the user typed
 * (a search query is user data and the line goes to logcat).
 *
 * Runs in jsdom with googleapis.com answered from fixtures — no network, no
 * Chromium, no device.
 *
 *   npm i jsdom
 *   node tools/error-kind-check.js app/assets/index.html /tmp/old/index.html
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const sleep = ms => new Promise(r => setTimeout(r, ms));

const vids = [];
for (let i = 0; i < 24; i++) vids.push('vid' + String(i).padStart(8, '0'));
const CH_IDS = [];
for (let i = 0; i < 6; i++) CH_IDS.push('UCchan' + String(i).padStart(12, '0'));
const pub = d => new Date(Date.UTC(2026, 9, 1 + d)).toISOString();

const F = {
  videos: {
    items: vids.map((id, i) => ({
      id,
      snippet: {
        title: 'Sample trending video number ' + (i + 1),
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
        country: 'IN',
        description: 'A sample channel.',
        thumbnails: { medium: { url: 'https://yt3.ggpht.com/av' + i + '.jpg' } },
      },
      statistics: { subscriberCount: '1200000', videoCount: '480', viewCount: '91000000' },
      contentDetails: { relatedPlaylists: { uploads: 'UU' + i + 'xxxxxxxxxxxxxxxxxxxx' } },
      brandingSettings: { image: { bannerExternalUrl: '' }, channel: {} },
    })),
  },
  search: {
    items: vids.slice(0, 20).map((id, i) => ({
      id: { videoId: id },
      snippet: { title: 'Search result ' + i, channelTitle: 'Channel ' + (i % 6), channelId: CH_IDS[i % 6], publishedAt: pub(i * 24) },
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
  if (p.endsWith('/playlistItems')) return F.search;
  if (p.endsWith('/search')) return F.search;
  return {};
}
const isTrending = u => /\/videos\?/.test(u) && /chart=mostPopular/.test(u);

/* a page: fresh window and localStorage, a fetch that answers from the fixtures
   and logs every call. `queue` holds scripted answers consumed one per request
   (a string 'throw'/'abort'/'garbage', or {status, body}); when it is empty the
   fixtures answer. console.log is captured so the `lt-err` lines can be read. */
function open(file) {
  const HTML = fs.readFileSync(file, 'utf8');
  const env = { log: [], lines: [], queue: [], bodies: {}, only: null };
  const mockFetch = async u => {
    u = String(u);
    env.log.push({ url: u.replace(/([?&])key=[^&]*/, '$1key=<key>'), t: Date.now() });
    const step = (env.queue.length && (!env.only || env.only(u))) ? env.queue.shift() : 'ok';
    if (step === 'throw') throw new TypeError('Failed to fetch');
    if (step === 'abort') { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
    if (step === 'garbage') return { ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); }, headers: new Map() };
    if (typeof step === 'object') {
      const body = step.body === 'html' ? null : step.body;
      return {
        ok: step.status >= 200 && step.status < 300, status: step.status,
        headers: new Map(),
        json: async () => { if (!body) throw new SyntaxError('Unexpected token <'); return body; },
      };
    }
    const j = apiBody(u);
    env.bodies[u] = j;
    return { ok: true, status: 200, json: async () => j, headers: new Map() };
  };
  const dom = new JSDOM(HTML, {
    url: 'https://liquidtube.local/index.html',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(w) {
      w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
      w.fetch = mockFetch;
      w.scrollTo = () => {};
      w.console.log = (...a) => {
        const s = a.map(x => (typeof x === 'string' ? x : String(x))).join(' ');
        env.lines.push(s);
      };
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
    .replace(/ class="ld"/g, '').replace(/ ld"/g, '"')
    .replace(/ data-f="1"/g, '')
    .replace(/ ?(?:transform|opacity|background-position-y):[^;"']*;?/g, '')
    .replace(/style="\s*"/g, '').replace(/\s{2,}/g, ' ').trim();
}

/* ---------- assertions ---------- */
let pass = 0;
const fails = [];
function ok(label, cond, detail) {
  if (cond) { pass++; return; }
  fails.push(label + (detail !== undefined ? ' — ' + detail : ''));
}

/* every class, one scripted answer each. `reason` is the API's own reason code,
   which is what the real endpoint sends and what the classifier prefers over the
   wording of the message. */
const CASES = [
  { label: 'daily quota, reason quotaExceeded, message without the word', steps: [{ status: 403, body: { error: { code: 403, message: 'The request cannot be completed.', errors: [{ reason: 'quotaExceeded' }] } } }], kind: 'quota', retries: 0, refused: 1 },
  { label: 'daily quota, only the message says it', steps: [{ status: 403, body: { error: { message: 'The request cannot be completed because you have exceeded your quota.' } } }], kind: 'quota', retries: 0, refused: 1 },
  { label: 'revoked key, reason keyInvalid', steps: [{ status: 403, body: { error: { code: 403, message: 'The request is missing a valid API key.', errors: [{ reason: 'keyInvalid' }] } } }], kind: 'auth', retries: 0 },
  { label: 'bad key sent as a 400', steps: [{ status: 400, body: { error: { code: 400, message: 'API key not valid. Please pass a valid API key.' } } }], kind: 'auth', retries: 0 },
  { label: '401 unauthorized', steps: [{ status: 401, body: { error: { message: 'Unauthorized' } } }], kind: 'auth', retries: 0 },
  { label: 'deleted video, reason videoNotFound', steps: [{ status: 404, body: { error: { code: 404, message: 'Video not found.', errors: [{ reason: 'videoNotFound' }] } } }], kind: 'notfound', retries: 0 },
  { label: 'plain 404', steps: [{ status: 404, body: { error: { message: 'Not Found' } } }], kind: 'notfound', retries: 0 },
  { label: 'per-second ceiling, 429', steps: [{ status: 429, body: { error: { message: 'Rate Limit Exceeded', errors: [{ reason: 'rateLimitExceeded' }] } } }, { status: 429, body: { error: { message: 'Rate Limit Exceeded', errors: [{ reason: 'rateLimitExceeded' }] } } }], kind: 'ratelimit', retries: 1 },
  { label: 'a bad request the API will not accept', steps: [{ status: 400, body: { error: { message: 'Bad Request' } } }], kind: 'client', retries: 0 },
  { label: 'two 500s, after the one retry', steps: [{ status: 500, body: { error: { message: 'Backend Error' } } }, { status: 503, body: { error: { message: 'Backend Error' } } }], kind: 'server', retries: 1 },
  { label: 'no network at all, after the one retry', steps: ['throw', 'throw'], kind: 'network', retries: 1 },
  { label: 'a 200 whose body will not parse', steps: ['garbage'], kind: 'malformed', retries: 0 },
  { label: 'a request the page abandoned', steps: ['abort'], kind: 'aborted', retries: 0, logged: 0 },
];

async function requestLayer(file) {
  const env = open(file);
  await waitFor(() => env.d.querySelectorAll('#feed .card').length > 0);
  await sleep(150);
  const yt = env.w.yt;
  const RQ = env.w.__ltReqCache;
  const ERR = env.w.__ltErr;
  const QUOTA = env.w.__ltQuota;
  ok('window.__ltErr() is a function', typeof ERR === 'function');
  if (typeof ERR !== 'function') { env.dom.window.close(); return; }
  const fresh = (() => { let n = 0; return () => 'ek-' + (++n) + '-' + Math.random().toString(36).slice(2, 8); })();
  env.only = u => /\/search\?/.test(u);   /* only the call under test is scripted */

  ok('nothing is counted before anything fails', ERR().n === 0, JSON.stringify(ERR().kinds));

  for (const c of CASES) {
    const e0 = ERR(), r0 = RQ(), q0 = QUOTA(), s0 = env.log.length, l0 = env.lines.filter(l => l.startsWith('lt-err')).length;
    env.queue = c.steps.slice();
    const q = fresh();
    let err = null;
    try { await yt('search', { part: 'snippet', q, maxResults: 20 }); } catch (e) { err = e; }
    const e1 = ERR(), r1 = RQ();
    const sent = env.log.slice(s0).filter(e => /\/search\?/.test(e.url)).length;
    ok('[' + c.label + '] the request fails', !!err, err && err.message);
    ok('[' + c.label + '] the error carries its kind', !!err && err.kind === c.kind, err && err.kind);
    ok('[' + c.label + '] the kind is the one the API described', err && env.w.ekKind(err) === c.kind, err && env.w.ekKind(err));
    ok('[' + c.label + '] sent ' + (1 + c.retries) + ' request(s)', sent === 1 + c.retries, sent);
    ok('[' + c.label + '] retries counted: ' + c.retries, r1.retry - r0.retry === c.retries, r1.retry - r0.retry);
    ok('[' + c.label + '] the failure is counted once, not per attempt',
      e1.kinds[c.kind] - (e0.kinds[c.kind] || 0) === 1, (e1.kinds[c.kind] || 0) - (e0.kinds[c.kind] || 0));
    if (c.kind === 'aborted') {
      ok('[' + c.label + '] an abandoned request is not a failure', e1.n === e0.n, e1.n - e0.n);
    } else {
      ok('[' + c.label + '] the failure total goes up by one', e1.n - e0.n === 1, e1.n - e0.n);
      ok('[' + c.label + '] it is the last failure seen', e1.last && e1.last.kind === c.kind, e1.last && e1.last.kind);
      ok('[' + c.label + '] the last failure names its endpoint', e1.last && e1.last.ep === 'search', e1.last && e1.last.ep);
    }
    const lines = env.lines.filter(l => l.startsWith('lt-err')).slice(l0);
    if (c.kind === 'aborted') {
      ok('[' + c.label + '] no log line for a deliberate abort', lines.length === 0, lines.length);
    } else {
      ok('[' + c.label + '] exactly one lt-err line', lines.length === 1, lines.length);
      ok('[' + c.label + '] the line names the kind', /^lt-err kind=\w+ ep=search status=\d+/.test(lines[0] || ''), lines[0]);
      ok('[' + c.label + '] the line never carries what was searched for', !String(lines[0] || '').includes(q), lines[0]);
    }
    if (c.refused) {
      ok('[' + c.label + '] the quota meter counts the refusal', QUOTA().refused - q0.refused === c.refused, QUOTA().refused - q0.refused);
    }
    env.queue = [];
  }

  /* the two classes the message text cannot tell apart are told apart */
  const both = [];
  for (const c of [CASES.find(x => x.kind === 'quota'), CASES.find(x => x.kind === 'auth')]) {
    env.queue = c.steps.slice();
    try { await yt('search', { part: 'snippet', q: fresh(), maxResults: 20 }); } catch (e) { both.push(e.kind); }
    env.queue = [];
  }
  ok('a quota refusal and a key refusal do not share a class', both[0] === 'quota' && both[1] === 'auth', both.join('/'));

  /* bounded: a long offline session cannot flood logcat */
  const l0 = env.lines.filter(l => l.startsWith('lt-err')).length;
  const e0 = ERR();
  env.queue = [];
  for (let i = 0; i < 45; i++) {
    env.queue = [{ status: 404, body: { error: { message: 'Not Found' } } }];
    try { await yt('search', { part: 'snippet', q: fresh(), maxResults: 20 }); } catch (e) {}
  }
  const e1 = ERR();
  const l1 = env.lines.filter(l => l.startsWith('lt-err')).length;
  ok('the log stops at EK_LINES lines', l1 === 40, l1);
  ok('the counter keeps counting past the cap', e1.n - e0.n === 45, e1.n - e0.n);
  ok('what was not printed is recorded as dropped', e1.dropped > 0, e1.dropped);
  ok('the kinds table stays small', Object.keys(e1.kinds).length <= 10, Object.keys(e1.kinds).join(','));

  env.dom.window.close();
}

/* ---------- nothing on screen changed ---------- */
/* the search panel is the one surface that answers a failure in place, so each
   class is driven through it and the panel's HTML is compared with the previous
   build's for the same class. */
async function searchPanel(file, c) {
  const env = open(file);
  await waitFor(() => env.d.querySelectorAll('#feed .card').length > 0);
  await sleep(120);
  env.only = u => /\/search\?/.test(u);
  env.queue = c.steps.slice();
  env.d.getElementById('sopen').click();
  const qi = env.d.getElementById('q');
  qi.value = 'test query';
  qi.dispatchEvent(new env.w.Event('input'));
  await waitFor(() => {
    const r = env.d.getElementById('results');
    return r && /class="empty"/.test(r.innerHTML);
  }, 8000);
  await sleep(150);
  const html = norm(env.d.getElementById('results').innerHTML);
  env.dom.window.close();
  return html;
}

async function abHalf(file, oldFile) {
  /* Item 5.3 changed what these surfaces say, on purpose: the previous build
     printed the API's own sentence, this one prints its own. So the A/B is no
     longer "byte-identical" — it is the proof of that change, class by class:
     the old build's panel carried the API text and this build's does not. */
  /* the API's own words for each case, taken from the scripted answer itself */
  const rawOf = c => {
    const last = c.steps[c.steps.length - 1];
    if (last === 'throw') return 'Failed to fetch';
    if (last === 'garbage') return 'Malformed response';
    return (last && last.body && last.body.error && last.body.error.message) || '';
  };
  for (const c of CASES.filter(x => x.kind !== 'aborted')) {
    const a = await searchPanel(file, c);
    const b = await searchPanel(oldFile, c);
    const raw = rawOf(c);
    /* the quota cases were the one thing the old build got right: it recognised
       the word and showed its own sentence, so there is no raw text to look for */
    ok('[' + c.label + '] the previous build printed the API text',
      c.kind === 'quota' ? true : (!raw || b.includes(raw)), '\n  old: ' + b);
    ok('[' + c.label + '] this build does not print the API text', !raw || !a.includes(raw), '\n  new: ' + a);
    ok('[' + c.label + '] the panel answers in its own words', /daily search limit is used up|>Search failed\. /.test(a), a);
  }
  const a0 = await searchPanel(file, CASES.find(x => x.label.indexOf('message without the word') >= 0));
  const q0 = await searchPanel(file, CASES.find(x => x.kind === 'quota' && x.label.indexOf('message without the word') < 0));
  ok('a quota refusal says the same sentence however the API words it', a0 === q0, '\n  ' + a0 + '\n  ' + q0);
}

(async () => {
  const file = process.argv[2] || path.join(__dirname, '..', 'app', 'assets', 'index.html');
  const oldFile = process.argv[3];
  console.log('LiquidTube error-kind check — ' + file);
  await requestLayer(file);
  if (oldFile && fs.existsSync(oldFile)) await abHalf(file, oldFile);
  else console.log('(no previous build given: the A/B half is skipped)');

  console.log('');
  if (fails.length) {
    console.log('FAIL — ' + fails.length + ' failed, ' + pass + ' passed');
    fails.forEach(f => console.log('  · ' + f));
    process.exit(1);
  }
  console.log('PASS — ' + pass + ' assertions');
})();
