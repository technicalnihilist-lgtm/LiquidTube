#!/usr/bin/env node
/*
 * LiquidTube error-text check — proves item 5.3 ("never render a raw API message
 * into the UI").
 *
 * Three surfaces used to print the API's own sentence straight into the page:
 * the search panel (`Search failed. ` + e.message), the feed's empty state
 * (`Could not load videos.` + e.message) and the channel sheet. That text names
 * quotas, keys and status codes, and it is the one string on screen the app does
 * not control — it comes from the server.
 *
 * The check drives each of those surfaces to failure with a **sentinel** planted
 * in the API's message and asserts:
 *
 *  1. the sentinel never reaches the DOM — not the message, not the reason code,
 *     not the status line, on any surface, for any class;
 *  2. each class shows its own sentence, and the sentence shown is exactly the
 *     one ekText() maps that class to (so the mapping cannot silently drift);
 *  3. the surface keeps its shape: still a single `div.empty` in the same place,
 *     with the same frame around it (`Search failed. `, `Could not load videos.`,
 *     and the quota line the search panel already used);
 *  4. the sentences are constants — no digits, no URLs, no interpolated user
 *     input — and every class has one, so a new class cannot fall through to a
 *     blank box;
 *  5. the failure is still classified and still logged (item 5.2 is intact):
 *     one `lt-err` line per failure, naming the kind, never the query.
 *
 * Runs in jsdom with googleapis.com answered from fixtures — no network, no
 * Chromium, no device.
 *
 *   npm i jsdom
 *   node tools/error-text-check.js app/assets/index.html
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

/* The sentinel is planted in every field of the API's error body a naive handler
   might print: the message, the reason and the domain. It must never be seen. */
const SENT = 'ZZSENTINELZZ';
const sentinelBody = (status, reason) => ({
  error: {
    code: status,
    message: SENT + ' the request cannot be completed ' + SENT,
    errors: reason ? [{ reason: reason, domain: SENT, message: SENT }] : [{ reason: SENT, domain: SENT, message: SENT }],
  },
});

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
  /* a playlistItems body in the shape the endpoint really sends: the search
     fixture's ids wrapped in snippet.resourceId. It used to answer with the
     search body itself, which no server does — item 5.9 validates the shape
     before mapping it now, so the fixture has to be the real one. */
  if (p.endsWith('/playlistItems')) return { items: F.search.items.map(it => ({ snippet: Object.assign({}, it.snippet, { resourceId: { videoId: it.id.videoId } }), contentDetails: { videoPublishedAt: it.snippet.publishedAt } })) };
  if (p.endsWith('/search')) return F.search;
  return {};
}
const isTrending = u => /\/videos\?/.test(u) && /chart=mostPopular/.test(u);

/* a page: fresh window and localStorage, a fetch that answers from the fixtures.
   `queue` may be prefilled — the boot request fires while the document is still
   being parsed, so a scripted boot failure has to be in place before the JSDOM
   is constructed. */
function open(file, pre) {
  const HTML = fs.readFileSync(file, 'utf8');
  const env = { log: [], lines: [], queue: (pre && pre.queue) || [], bodies: {}, only: (pre && pre.only) || null };
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

/* ---------- assertions ---------- */
let pass = 0;
const fails = [];
function ok(label, cond, detail) {
  if (cond) { pass++; return; }
  fails.push(label + (detail !== undefined ? ' — ' + detail : ''));
}

/* Item 5.8 puts a way out of the dead box: a `Try again` button, offered only
   for the classes a tap can plausibly fix. It is not part of the sentence, so
   every text assertion below reads the box without it and every shape assertion
   strips it — what the box *says* must not move, and whether it offers a way out
   is asserted separately. */
const RETRY_KINDS = ['network', 'server', 'ratelimit', 'malformed', 'client', 'unknown'];
const BTN_RE = /<button type="button" class="opt glass rty" data-r="[a-z.]+">Try again<\/button>/;
function readBox(el) {
  const btn = el.querySelector('button.rty');
  const copy = el.cloneNode(true);
  copy.querySelectorAll('button').forEach(b => b.remove());
  const html = el.innerHTML.replace(/\s+/g, ' ');
  return { html, shape: html.replace(BTN_RE, ''), text: copy.textContent.replace(/\s+/g, ' ').trim(), btn: btn ? btn.getAttribute('data-r') : null };
}

/* every class, with the API answer that produces it. `kind` is the class 5.2
   assigns; `frame` is the surface's own wording, which must survive. */
const CASES = [
  { label: 'daily quota', steps: [{ status: 403, body: sentinelBody(403, 'quotaExceeded') }], kind: 'quota' },
  { label: 'revoked key', steps: [{ status: 403, body: sentinelBody(403, 'keyInvalid') }], kind: 'auth' },
  { label: '401 unauthorized', steps: [{ status: 401, body: sentinelBody(401, null) }], kind: 'auth' },
  { label: 'deleted video', steps: [{ status: 404, body: sentinelBody(404, 'videoNotFound') }], kind: 'notfound' },
  { label: 'per-second ceiling', steps: [{ status: 429, body: sentinelBody(429, 'rateLimitExceeded') }, { status: 429, body: sentinelBody(429, 'rateLimitExceeded') }], kind: 'ratelimit' },
  { label: 'bad request', steps: [{ status: 400, body: sentinelBody(400, null) }], kind: 'client' },
  { label: 'two 500s', steps: [{ status: 500, body: sentinelBody(500, null) }, { status: 503, body: sentinelBody(503, null) }], kind: 'server' },
  { label: 'no network', steps: ['throw', 'throw'], kind: 'network' },
  { label: 'unparseable 200', steps: ['garbage'], kind: 'malformed' },
];

const KINDS = ['quota', 'ratelimit', 'auth', 'notfound', 'server', 'network', 'client', 'malformed', 'aborted', 'unknown'];

/* the sentences, mirrored here so a change to one has to be made in two places
   on purpose — the same way the other checks pin what is on screen. */
const WANT = {
  quota: "YouTube's daily limit is used up. Try again tomorrow.",
  ratelimit: 'Too many requests just now. Try again in a moment.',
  auth: 'This app can no longer reach YouTube. Please update it.',
  notfound: 'That is no longer available.',
  server: 'YouTube is having trouble. Try again in a moment.',
  network: 'No connection. Check your network and try again.',
  client: 'YouTube would not accept that request. Try again.',
  malformed: 'YouTube sent an unexpected answer. Try again.',
  aborted: 'Cancelled.',
  unknown: 'Something went wrong. Try again.',
};

/* ---------- 1. the sentences themselves ---------- */
function sentences(env) {
  const ekText = env.w.__ltErrText;
  ok('window.__ltErrText is a function', typeof ekText === 'function');
  if (typeof ekText !== 'function') return;
  for (const k of KINDS) {
    const s = ekText({ kind: k });
    ok('[' + k + '] has a sentence', typeof s === 'string' && s.length > 0, s);
    ok('[' + k + '] is the sentence the check pins', s === WANT[k], s);
    ok('[' + k + '] is short enough for the toast-sized box', String(s).length <= 72, String(s).length);
    ok('[' + k + '] carries no number', !/\d/.test(String(s)), s);
    ok('[' + k + '] carries no URL or markup', !/https?:|www\.|[<>]/.test(String(s)), s);
    ok('[' + k + '] is a sentence, not a fragment', /[.!?]$/.test(String(s)), s);
  }
  /* the same failure, classified from its raw parts, gets the same sentence —
     so nothing depends on where the error object was built */
  ok('a raw 403 quotaExceeded gets the quota sentence',
    ekText({ status: 403, reason: 'quotaExceeded', message: SENT }) === WANT.quota);
  ok('a raw bad key gets the key sentence',
    ekText({ status: 400, message: 'API key not valid. Please pass a valid API key.' }) === WANT.auth);
  ok('a raw offline TypeError gets the network sentence',
    ekText(new TypeError('Failed to fetch')) === WANT.network);
  /* nothing at all still says something */
  ok('an empty failure still says something', ekText(null) === WANT.unknown, ekText(null));
  ok('an unrecognised failure still says something', ekText({ status: 418, message: SENT }) === WANT.client, ekText({ status: 418 }));
}

/* ---------- 2. the search panel ---------- */
async function searchPanel(file, c, opts) {
  const env = open(file);
  await waitFor(() => env.d.querySelectorAll('#feed .card').length > 0);
  await sleep(120);
  const ekText = env.w.__ltErrText;
  env.only = u => /\/search\?/.test(u);
  env.queue = c.steps.slice();
  env.d.getElementById('sopen').click();
  const qi = env.d.getElementById('q');
  qi.value = (opts && opts.q) || 'test query';
  qi.dispatchEvent(new env.w.Event('input'));
  await waitFor(() => {
    const r = env.d.getElementById('results');
    return r && /class="empty"/.test(r.innerHTML);
  }, 8000);
  await sleep(150);
  const r = readBox(env.d.getElementById('results'));
  const lines = env.lines.filter(l => l.startsWith('lt-err')).length;
  env.dom.window.close();
  return { html: r.html, shape: r.shape, text: r.text, btn: r.btn, lines, ekText };
}

async function searchSurface(file) {
  for (const c of CASES) {
    const r = await searchPanel(file, c);
    const want = c.kind === 'quota'
      ? "YouTube's daily search limit is used up."     /* the line the panel already showed */
      : 'Search failed. ' + WANT[c.kind];
    ok('[' + c.label + '] the panel never shows the API text', !r.html.includes(SENT), r.html);
    ok('[' + c.label + '] the panel shows the sentence for its class', r.text === want, '\n  got: ' + r.text + '\n  want: ' + want);
    ok('[' + c.label + '] the panel keeps its empty state', /^<div class="empty">[^<]*<\/div>$/.test(r.shape), r.shape);
    ok('[' + c.label + '] the panel offers a way out only where a tap can help',
      (r.btn !== null) === RETRY_KINDS.includes(c.kind), String(r.btn));
    ok('[' + c.label + '] the way out re-runs the search', r.btn === null || r.btn === 'find', String(r.btn));
    ok('[' + c.label + '] one failure is still logged once', r.lines >= 1, r.lines);
  }
  /* the query is user data: it is never in the DOM of the failure state and
     never in the log line */
  const r = await searchPanel(file, CASES[0], { q: 'my private search' });
  ok('a failed search does not echo what was typed into the empty state', !r.text.includes('my private search'), r.text);
}

/* ---------- 3. the feed ---------- */
/* The feed gets the request layer's retry (2.3) and then item 5.7's one extra
   attempt, so a scripted failure has to refuse twice as many times as it would
   for a single request before the surface can be reached: the failure is the
   point of this check, not how many attempts it took to accept it. */
const feedSteps = c => c.steps.concat(c.steps);
async function feedSurface(file) {
  for (const c of [CASES[0], CASES.find(x => x.kind === 'network'), CASES.find(x => x.kind === 'server')]) {
    const env = open(file, { queue: feedSteps(c), only: isTrending });
    await waitFor(() => {
      const f = env.d.getElementById('feed');
      return f && /class="empty"/.test(f.innerHTML);
    }, 12000);
    await sleep(150);
    const r = readBox(env.d.getElementById('feed'));
    ok('[' + c.label + ', feed] the feed never shows the API text', !r.html.includes(SENT), r.html);
    ok('[' + c.label + ', feed] the feed shows the sentence for its class',
      r.text === 'Could not load videos.' + WANT[c.kind], '\n  got: ' + r.text);
    ok('[' + c.label + ', feed] the feed keeps its two-line empty state',
      /^<div class="empty">Could not load videos\.<br>[^<]*<\/div>$/.test(r.shape), r.shape);
    ok('[' + c.label + ', feed] the feed offers a way out only where a tap can help',
      (r.btn !== null) === RETRY_KINDS.includes(c.kind), String(r.btn));
    ok('[' + c.label + ', feed] the way out re-runs the feed', r.btn === null || r.btn === 'feed', String(r.btn));
    env.dom.window.close();
  }
}

/* ---------- 4. the channel sheet ---------- */
async function channelSurface(file) {
  const env = open(file);
  await waitFor(() => env.d.querySelectorAll('#feed .card').length > 0);
  await sleep(150);
  env.only = u => /\/channels\?/.test(u);
  for (const c of [CASES.find(x => x.kind === 'notfound'), CASES.find(x => x.kind === 'auth')]) {
    env.queue = c.steps.slice();
    env.w.openChannel('UCnosuchchannel00000');
    await waitFor(() => {
      const b = env.d.getElementById('shb');
      return b && /class="empty"/.test(b.innerHTML);
    }, 8000);
    await sleep(150);
    const r = readBox(env.d.getElementById('shb'));
    ok('[' + c.label + ', channel] the sheet never shows the API text', !r.html.includes(SENT), r.html);
    ok('[' + c.label + ', channel] the sheet shows the sentence for its class', r.text === WANT[c.kind], '\n  got: ' + r.text);
    ok('[' + c.label + ', channel] the sheet keeps its empty state',
      /^<div class="empty">[^<]*<\/div>$/.test(r.shape), r.shape);
    ok('[' + c.label + ', channel] the sheet offers a way out only where a tap can help',
      (r.btn !== null) === RETRY_KINDS.includes(c.kind), String(r.btn));
    env.queue = [];
  }
  env.dom.window.close();
}

/* ---------- 5. nothing else on the page picked the text up ---------- */
async function wholePage(file) {
  const env = open(file, { queue: CASES[0].steps.slice(), only: isTrending });
  await waitFor(() => /class="empty"/.test(env.d.getElementById('feed').innerHTML), 12000);
  await sleep(150);
  /* the page's own source is not "on screen": only what the user can read counts,
     so the script and style blocks are dropped before the text is read */
  const copy = env.d.body.cloneNode(true);
  copy.querySelectorAll('script,style').forEach(n => n.remove());
  const body = copy.textContent;
  ok('the API message is nowhere in the rendered page', !body.includes(SENT));
  ok('the API reason code is nowhere in the rendered page', !/quotaExceeded|keyInvalid/.test(body));
  ok('no raw status line is on screen', !/HTTP\s*(4|5)\d\d/.test(body), (body.match(/HTTP\s*\d+/g) || []).join(','));
  env.dom.window.close();
}

(async () => {
  const file = process.argv[2] || path.join(__dirname, '..', 'app', 'assets', 'index.html');
  console.log('LiquidTube error-text check — ' + file);

  const base = open(file);
  await waitFor(() => base.d.querySelectorAll('#feed .card').length > 0);
  await sleep(120);
  sentences(base);
  base.dom.window.close();

  await searchSurface(file);
  await feedSurface(file);
  await channelSurface(file);
  await wholePage(file);

  console.log('');
  if (fails.length) {
    console.log('FAIL — ' + fails.length + ' failed, ' + pass + ' passed');
    fails.forEach(f => console.log('  · ' + f));
    process.exit(1);
  }
  console.log('PASS — ' + pass + ' assertions');
})();
