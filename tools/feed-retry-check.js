#!/usr/bin/env node
/*
 * LiquidTube feed-retry check — proves item 5.7 ("retry the feed once
 * automatically on failure").
 *
 * The feed had one chance per launch. rqFetch already repeats a single request
 * (2.3), but if that second request also failed the boot gave up and the page sat
 * on `Could not load videos.` until the app was reopened. 5.7 gives the feed one
 * more go, after a short wait, and only for the failures a second go can fix.
 *
 * What this check pins, all in jsdom against fixtures (no network, no device):
 *
 *  1. recovery — a trending call that fails once and then answers ends up with
 *     the same cards, in the same markup, as a clean boot: no error box, the feed
 *     cache written, the counters saying one retry happened and which class it
 *     answered;
 *  2. the classes that are retried (network, server, ratelimit, malformed) and
 *     the ones that are not (quota, auth, notfound, client, aborted), asserted by
 *     the number of requests that reach the wire — a quota failure must cost
 *     exactly the requests it costs today;
 *  3. the bound — at most one retry, so a boot that fails twice ends on the same
 *     error surface the previous build shows, and writes at most one log line;
 *  4. the wait — the retry comes ~900 ms after the attempt that failed, and the
 *     feed shows nothing new while it waits (skeletons or cached cards stay put,
 *     never a flash of the empty state);
 *  5. nothing else moves — the log line carries no request parameters and no API
 *     key, the storage keys are the ones a clean boot writes, no console error
 *     and no unhandled rejection is raised, and a boot whose first attempt
 *     succeeds sends exactly the requests the previous build sends.
 *
 *   npm i jsdom
 *   node tools/feed-retry-check.js app/assets/index.html [/tmp/old/index.html]
 *
 * argv[3] is optional: with a previous build the A/B assertions (same feed
 * markup, same error surface, same request count) run against it.
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const NEW_FILE = process.argv[2] || path.join(__dirname, '..', 'app', 'assets', 'index.html');
const OLD_FILE = process.argv[3] || '';
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
        title: 'Channel ' + i, customUrl: 'channel' + i, publishedAt: '2015-04-02T10:00:00Z',
        country: 'IN', description: 'A sample channel.',
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

/* a page: fresh window and localStorage, a fetch that answers from the fixtures.
   `queue` is prefilled — the boot request fires while the document is still being
   parsed, so a scripted boot failure has to be in place before the JSDOM exists. */
function open(file, pre) {
  const HTML = fs.readFileSync(file, 'utf8');
  const env = {
    log: [], lines: [], errors: [], rejects: [], queue: (pre && pre.queue) || [],
    only: (pre && pre.only) || null,
  };
  const mockFetch = async u => {
    u = String(u);
    env.log.push({ url: u.replace(/([?&])key=[^&]*/, '$1key=<key>'), t: Date.now() });
    const step = (env.queue.length && (!env.only || env.only(u))) ? env.queue.shift() : 'ok';
    if (step === 'throw') throw new TypeError('Failed to fetch');
    if (step === 'abort') { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
    if (step === 'garbage') return { ok: true, status: 200, headers: new Map(), json: async () => { throw new SyntaxError('Unexpected token <'); } };
    if (typeof step === 'object') {
      const body = step.body === 'html' ? null : step.body;
      return {
        ok: step.status >= 200 && step.status < 300, status: step.status, headers: new Map(),
        json: async () => { if (!body) throw new SyntaxError('Unexpected token <'); return body; },
      };
    }
    const j = apiBody(u);
    return { ok: true, status: 200, headers: new Map(), json: async () => j };
  };
  const dom = new JSDOM(HTML, {
    url: 'https://liquidtube.local/index.html',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(w) {
      w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
      w.fetch = mockFetch;
      w.scrollTo = () => {};
      w.console.log = (...a) => { env.lines.push(a.map(x => (typeof x === 'string' ? x : String(x))).join(' ')); };
      w.console.error = (...a) => { env.errors.push(a.map(x => String(x)).join(' ')); };
      w.addEventListener('unhandledrejection', e => env.rejects.push(String((e && e.reason && e.reason.message) || e)));
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

let pass = 0;
const fails = [];
function ok(label, cond, detail) {
  if (cond) { pass++; return; }
  fails.push(label + (detail !== undefined ? ' — ' + detail : ''));
}

const clean = s => String(s).replace(/\s+/g, ' ').trim();
/* the depth frame writes inline transforms into the cards, and which frame the
   read lands on depends on the host — so the markup is compared without inline
   style, which this item does not touch. Everything a card looks like comes from
   its classes; the same normalisation is used by the full-DOM A/B. */
const feedHTML = env => {
  const box = env.d.getElementById('feed');
  if (!box) return '';
  const c = box.cloneNode(true);
  c.querySelectorAll('[style]').forEach(n => n.removeAttribute('style'));
  return clean(c.innerHTML);
};
const cards = env => env.d.querySelectorAll('#feed .card').length;
const trendingReqs = env => env.log.filter(e => isTrending(e.url));
const retryLines = env => env.lines.filter(l => l.startsWith('lt-feedretry'));
const storeKeys = env => {
  const k = [];
  for (let i = 0; i < env.w.localStorage.length; i++) k.push(env.w.localStorage.key(i));
  return k.sort();
};
/* lt_quota (2.9) is flushed by the quota meter on its own schedule, so whether
   it is there when the snapshot is taken is timing, not a change: it is left out
   of every key comparison, and no other key is allowed to appear. */
const stableKeys = keys => keys.filter(k => k !== 'lt_quota');
const counts = env => {
  try { return env.w.__ltFeedRetry(); } catch (e) { return null; }
};

/* every class, with the answers that produce it. `steps` is what the wire does
   for one feed attempt; a request layer retry (2.3) needs its own step each time,
   which is why the retried classes are queued in pairs. */
const SENT = 'ZZSENTINELZZ';
const body = (status, reason) => ({
  error: { code: status, message: SENT, errors: [{ reason: reason || SENT, domain: SENT, message: SENT }] },
});
const RECOVER = [
  { label: 'server', steps: [{ status: 500, body: body(500) }, { status: 503, body: body(503) }], kind: 'server' },
  { label: 'network', steps: ['throw', 'throw'], kind: 'network' },
  { label: 'ratelimit', steps: [{ status: 429, body: body(429, 'rateLimitExceeded') }, { status: 429, body: body(429, 'rateLimitExceeded') }], kind: 'ratelimit' },
  { label: 'malformed', steps: ['garbage'], kind: 'malformed' },
];
const NORETRY = [
  { label: 'quota', steps: [{ status: 403, body: body(403, 'quotaExceeded') }], kind: 'quota' },
  { label: 'auth', steps: [{ status: 401, body: body(401) }], kind: 'auth' },
  { label: 'notfound', steps: [{ status: 404, body: body(404, 'videoNotFound') }], kind: 'notfound' },
  { label: 'client', steps: [{ status: 400, body: body(400) }], kind: 'client' },
  { label: 'aborted', steps: ['abort'], kind: 'aborted' },
];

/* ---------- 1. a clean boot: no retry, no line, no cost ---------- */
async function cleanBoot(file) {
  const env = open(file);
  await waitFor(() => cards(env) > 0);
  await sleep(500);
  const r = {
    html: feedHTML(env), cards: cards(env), reqs: env.log.length,
    trending: trendingReqs(env).length, lines: retryLines(env).length,
    keys: storeKeys(env), counts: counts(env), errors: env.errors.slice(), rejects: env.rejects.slice(),
  };
  env.dom.window.close();
  return r;
}

/* ---------- 2. the failure classes ---------- */
async function recoverCase(file, c) {
  const env = open(file, { queue: c.steps.slice(), only: isTrending });
  /* while the retry waits, the feed must not flash its empty state */
  let sawEmpty = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) {
    const f = env.d.getElementById('feed');
    if (f && /class="empty"/.test(f.innerHTML)) { sawEmpty = true; break; }
    if (cards(env) > 0) break;
    await sleep(15);
  }
  await waitFor(() => cards(env) > 0, 15000);
  await sleep(200);
  const req = trendingReqs(env);
  const gaps = [];
  for (let i = 1; i < req.length; i++) gaps.push(req[i].t - req[i - 1].t);
  const r = {
    html: feedHTML(env), cards: cards(env), trending: req.length, sawEmpty,
    gap: gaps.length ? Math.max(...gaps) : 0,
    lines: retryLines(env), counts: counts(env), keys: storeKeys(env),
    empty: /class="empty"/.test(feedHTML(env)),
    errors: env.errors.slice(), rejects: env.rejects.slice(),
  };
  env.dom.window.close();
  return r;
}

async function noRetryCase(file, c) {
  const env = open(file, { queue: c.steps.slice(), only: isTrending });
  await waitFor(() => /class="empty"/.test(feedHTML(env)), 15000);
  await sleep(250);
  const r = {
    html: feedHTML(env), text: clean(env.d.getElementById('feed').textContent),
    trending: trendingReqs(env).length, lines: retryLines(env), counts: counts(env),
  };
  env.dom.window.close();
  return r;
}

/* a boot that fails twice: the retry is spent, the error surface is the one the
   app already had */
async function doubleFailure(file) {
  const steps = [];
  for (let i = 0; i < 4; i++) steps.push({ status: 500, body: body(500) });   /* 2 attempts × (request + its own retry) */
  const env = open(file, { queue: steps, only: isTrending });
  await waitFor(() => /class="empty"/.test(feedHTML(env)), 20000);
  await sleep(300);
  const r = {
    html: feedHTML(env), text: clean(env.d.getElementById('feed').textContent),
    trending: trendingReqs(env).length, lines: retryLines(env), counts: counts(env),
    cards: cards(env), errors: env.errors.slice(), rejects: env.rejects.slice(),
  };
  env.dom.window.close();
  return r;
}

(async () => {
  console.log('LiquidTube feed-retry check — ' + NEW_FILE);
  if (OLD_FILE) console.log('  A/B against ' + OLD_FILE);

  const base = await cleanBoot(NEW_FILE);
  const oldBase = OLD_FILE ? await cleanBoot(OLD_FILE) : null;

  /* the counters exist and are bounded */
  ok('window.__ltFeedRetry() is exposed', !!base.counts);
  if (base.counts) {
    ok('at most one retry', base.counts.max === 1, base.counts.max);
    ok('the wait is the documented 900 ms', base.counts.delay === 900, base.counts.delay);
    ok('a clean boot attempts once', base.counts.attempts === 1, base.counts.attempts);
    ok('a clean boot never retries', base.counts.retries === 0, base.counts.retries);
    ok('a clean boot ends with a feed and no error', base.counts.error === false && base.counts.trending === 24, JSON.stringify(base.counts));
  }
  ok('a clean boot paints 24 cards', base.cards === 24, base.cards);
  ok('a clean boot writes no retry line', base.lines === 0, base.lines);
  ok('a clean boot raises no console error', base.errors.length === 0, base.errors.join(' | '));
  ok('a clean boot leaves no unhandled rejection', base.rejects.length === 0, base.rejects.join(' | '));

  if (oldBase) {
    ok('[A/B] a clean boot paints the same feed markup as the previous build', base.html === oldBase.html, base.html.slice(0, 160));
    ok('[A/B] a clean boot sends the same number of requests', base.reqs === oldBase.reqs, base.reqs + ' vs ' + oldBase.reqs);
    ok('[A/B] a clean boot writes the same storage keys',
      stableKeys(base.keys).join(',') === stableKeys(oldBase.keys).join(','),
      base.keys.join(',') + ' vs ' + oldBase.keys.join(','));
  }

  /* ---------- recovery ---------- */
  for (const c of RECOVER) {
    const r = await recoverCase(NEW_FILE, c);
    ok('[' + c.label + '] the boot recovers into cards', r.cards === 24, r.cards);
    ok('[' + c.label + '] the recovered feed is the clean boot\'s markup', r.html === base.html, r.html.slice(0, 160));
    ok('[' + c.label + '] no error box is left behind', !r.empty, r.html.slice(0, 160));
    ok('[' + c.label + '] the empty state never flashes while it waits', !r.sawEmpty);
    ok('[' + c.label + '] exactly one retry happened', r.counts && r.counts.retries === 1 && r.counts.attempts === 2, JSON.stringify(r.counts));
    ok('[' + c.label + '] the retry is recorded as the success it was', r.counts && r.counts.ok === 1 && r.counts.fail === 0, JSON.stringify(r.counts));
    ok('[' + c.label + '] the counters name the class that failed', r.counts && r.counts.kind === c.kind, r.counts && r.counts.kind);
    ok('[' + c.label + '] the retry waits about 900 ms', r.gap >= 880 && r.gap < 2000, r.gap);
    ok('[' + c.label + '] exactly one retry line is written', r.lines.length === 1, r.lines.join(' | '));
    ok('[' + c.label + '] the line says the retry worked', /^lt-feedretry attempt=1 ok=1 kind=[a-z]+ ms=\d+$/.test(r.lines[0] || ''), r.lines[0]);
    ok('[' + c.label + '] the line carries no request parameters or key', !/[?&]/.test(r.lines[0] || '') && !/key=/.test(r.lines[0] || ''), r.lines[0]);
    ok('[' + c.label + '] the recovered boot writes the feed cache', r.keys.includes('lt_feed'), r.keys.join(','));
    /* no key appears that a clean boot does not already use. `lt_quota` (2.9) is
       the one allowed extra: the failed attempt is a request, and the meter
       flushes its count then, so it can land earlier than in a clean boot. */
    const known = new Set(base.keys);
    ok('[' + c.label + '] the recovered boot writes no new storage key',
      r.keys.every(k => known.has(k)), r.keys.join(',') + ' vs ' + base.keys.join(','));
    ok('[' + c.label + '] recovery raises no console error', r.errors.length === 0, r.errors.join(' | '));
    ok('[' + c.label + '] recovery leaves no unhandled rejection', r.rejects.length === 0, r.rejects.join(' | '));
    /* the request the retry spends is the one that failed, not the whole chain */
    if (c.label === 'malformed') ok('[malformed] the retry costs one request', r.trending === 2, r.trending);
  }

  /* ---------- the classes that are not retried ---------- */
  for (const c of NORETRY) {
    const r = await noRetryCase(NEW_FILE, c);
    ok('[' + c.label + '] is not retried at the feed level', r.counts && r.counts.retries === 0, JSON.stringify(r.counts));
    ok('[' + c.label + '] is counted as skipped', r.counts && r.counts.skip === 1, JSON.stringify(r.counts));
    ok('[' + c.label + '] writes no retry line', r.lines.length === 0, r.lines.join(' | '));
    ok('[' + c.label + '] keeps the empty state the app already had', /^Could not load videos\./.test(r.text), r.text);
    ok('[' + c.label + '] shows a sentence, never the API text', !r.html.includes(SENT), r.html.slice(0, 120));
  }
  /* the one that must be cheapest: a spent quota costs one request, as before */
  const quota = await noRetryCase(NEW_FILE, NORETRY[0]);
  ok('[quota] costs exactly one request', quota.trending === 1, quota.trending);

  /* ---------- the bound ---------- */
  const dbl = await doubleFailure(NEW_FILE);
  ok('a boot that fails twice ends on the error surface', /^Could not load videos\./.test(dbl.text), dbl.text);
  ok('a boot that fails twice paints no cards', dbl.cards === 0, dbl.cards);
  ok('a boot that fails twice spent its one retry', dbl.counts && dbl.counts.attempts === 2 && dbl.counts.retries === 1 && dbl.counts.fail === 1, JSON.stringify(dbl.counts));
  ok('a boot that fails twice sends no more than 4 trending requests', dbl.trending === 4, dbl.trending);
  ok('a boot that fails twice writes one line, not two', dbl.lines.length === 1, dbl.lines.join(' | '));
  ok('that line says the retry did not help', /^lt-feedretry attempt=1 ok=0 kind=server ms=\d+$/.test(dbl.lines[0] || ''), dbl.lines[0]);
  ok('a boot that fails twice raises no console error', dbl.errors.length === 0, dbl.errors.join(' | '));
  ok('a boot that fails twice leaves no unhandled rejection', dbl.rejects.length === 0, dbl.rejects.join(' | '));
  if (OLD_FILE) {
    const oldDbl = await doubleFailure(OLD_FILE);
    ok('[A/B] a double failure shows the same surface as the previous build', dbl.html === oldDbl.html, dbl.html + ' vs ' + oldDbl.html);
    ok('[A/B] the previous build spent fewer requests, as expected', oldDbl.trending === 2, oldDbl.trending);
  }

  console.log('');
  if (fails.length) {
    console.log('FAIL — ' + fails.length + ' failed, ' + pass + ' passed');
    fails.forEach(f => console.log('  · ' + f));
    process.exit(1);
  }
  console.log('PASS — ' + pass + ' assertions');
})();
