#!/usr/bin/env node
/*
 * LiquidTube async-guard check — proves item 5.1: every async path is wrapped in
 * try/catch with a user-safe fallback, and no promise rejection is left for
 * nobody to handle.
 *
 * Five parts, all in jsdom with googleapis.com answered from fixtures — no
 * network, no Chromium, no device:
 *
 *  1. The net itself. asGuard / asWatch / asSafe are called directly and asked
 *     the questions the item makes them answer: a synchronous throw, an async
 *     rejection, an AbortError (which is not a failure), a value that comes back
 *     fine, the fallback a caller is handed, the counter, the log line's shape,
 *     and both bounds — at most AS_LINES lines and at most AS_MAXW sites, with
 *     the counters still counting past them.
 *  2. A clean boot. The net costs nothing when nothing fails: 24 cards painted,
 *     `caught` 0, `guards` >= 3 (the boot chain, the first-frame signal, the
 *     channel flush), and the same #feed / #chips / #ex / #subfeed markup the
 *     previous build paints — the item adds no pixels.
 *  3. A real path that used to reject. #pmeta is made to disappear between
 *     play() writing it and the channel lookup redrawing it, which is exactly
 *     what a handler that throws looks like from the app's side. The new build
 *     counts it at `play.channel`, logs it, leaves the player open and keeps the
 *     feed; the previous build leaves an unhandled rejection behind — so a PASS
 *     here is a difference that was measured, not a claim.
 *  4. A boot where every request fails. The shelves, the feed and the sections
 *     all fail: each one is counted at its own site, the app still reveals, the
 *     feed still shows its own empty state, and the tabs still move.
 *  5. The shape of the source, for the paths a harness cannot reach: the last
 *     bare `.then` is wrapped, renderSection no longer rethrows, bindInput runs
 *     through bindInputSafe, and the deferred-CSS apply() cannot throw.
 *
 *   npm i jsdom
 *   node tools/async-guard-check.js app/assets/index.html /tmp/old/index.html
 *
 * argv[2] is the build under test, argv[3] the previous build (optional; the A/B
 * halves of 2 and 3 are skipped without it).
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const NEW_FILE = process.argv[2] || path.join(__dirname, '..', 'app/assets/index.html');
const OLD_FILE = process.argv[3] || '';
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- fixtures (the same shapes the real endpoints send) ---------- */
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
  search: {
    items: vids.slice(0, 20).map((id, i) => ({
      id: { videoId: id },
      snippet: {
        title: 'Search result ' + i + ' &amp; more',
        channelTitle: 'Channel ' + (i % 6),
        channelId: CH_IDS[i % 6],
        publishedAt: pub(i * 24),
      },
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

/* ---------- one page ---------- */
function open(file, opts) {
  opts = opts || {};
  const HTML = fs.readFileSync(file, 'utf8');
  const env = { log: [], lines: [], requests: 0, bodies: {} };
  const res = (status, body, ok) => ({ ok, status, json: async () => body });
  const mockFetch = async u => {
    u = String(u);
    env.requests++;
    if (opts.failAll) throw new Error('network down');
    const j = apiBody(u);
    env.bodies[u] = j;
    return res(200, j, true);
  };
  const dom = new JSDOM(HTML, {
    url: 'https://liquidtube.local/index.html',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(w) {
      w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
      w.fetch = mockFetch;
      w.scrollTo = () => {};
      /* The page's own console is the logcat sink on a device; capture it here so
         the line the net writes can be read back. */
      w.console.log = (...a) => { const s = a.map(String).join(' '); env.log.push(s); if (s.startsWith('lt-async')) env.lines.push(s); };
      w.console.info = () => {};
      w.console.warn = () => {};
      /* An element that is asked for by id can be made to disappear, which is the
         cheapest honest way to make a render handler throw where it really would:
         the DOM a long session leaves behind is not always the DOM the code was
         written against. */
      const orig = w.document.getElementById.bind(w.document);
      w.__gone = null;
      w.document.getElementById = id => (w.__gone && id === w.__gone) ? null : orig(id);
    },
  });
  env.w = dom.window;
  env.d = dom.window.document;
  env.dom = dom;
  return env;
}

/* jsdom on this pod cannot instantiate undici's llhttp wasm, and something inside
   jsdom still reaches for it once a page has settled. Nothing to do with the app;
   ignore exactly that. Everything else is a real uncaught error and fails. */
const ignorable = e => /WebAssembly|Cannot allocate/i.test(String((e && e.message) || ''));
const rejections = [];
process.on('uncaughtException', e => { if (!ignorable(e)) { rejections.push({ kind: 'uncaught', e }); } });
process.on('unhandledRejection', e => { if (!ignorable(e)) { rejections.push({ kind: 'rejection', e }); } });

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
const snap = (env, sel) => norm((env.d.querySelector(sel) || {}).innerHTML || '');

/* ---------- assertions ---------- */
let pass = 0;
const fails = [];
function ok(label, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + label); return; }
  fails.push(label + (detail !== undefined ? ' — ' + detail : ''));
  console.log('  FAIL  ' + label + (detail !== undefined ? ' — ' + detail : ''));
}

/* ---------- 1. the net itself ---------- */
async function partGuard(file) {
  console.log('\n1. the net: asGuard / asWatch / asSafe');
  const env = open(file);
  const w = env.w;
  await waitFor(() => env.d.querySelectorAll('#feed .card').length > 0);
  await sleep(150);
  const A = () => w.__ltAsync();
  ok('__ltAsync() is exposed and shaped', A() && typeof A().caught === 'number' && typeof A().sites === 'object');
  ok('a clean boot caught nothing', A().caught === 0, 'caught=' + A().caught + ' ' + JSON.stringify(A().sites));
  ok('the boot path is guarded (guards >= 3)', A().guards >= 3, 'guards=' + A().guards);

  const base = A().caught;
  const v = await w.asGuard('t.sync', () => { throw new Error('boom'); }, 7);
  ok('a synchronous throw returns the fallback', v === 7, String(v));
  ok('  …and is counted', A().caught === base + 1, A().caught);
  ok('  …and is filed under its site', A().sites['t.sync'] === 1, JSON.stringify(A().sites['t.sync']));
  const line = env.lines[env.lines.length - 1] || '';
  ok('  …and writes one lt-async line', /^lt-async where=t\.sync err=boom n=\d+$/.test(line), line);
  ok('  …with no argument or URL in it', !/https?:|key=|id=/.test(line), line);

  const v2 = await w.asGuard('t.async', async () => { throw new Error('late'); }, 'fb');
  ok('an async rejection returns the fallback', v2 === 'fb', String(v2));

  const before = A().caught, lines = env.lines.length;
  const v3 = await w.asGuard('t.abort', () => { const e = new Error('Request abandoned'); e.name = 'AbortError'; throw e; }, 'ab');
  ok('an AbortError still returns the fallback', v3 === 'ab', String(v3));
  ok('  …but is not counted as a failure', A().caught === before, A().caught - before);
  ok('  …and is not logged', env.lines.length === lines, env.lines.length - lines);

  const v4 = await w.asGuard('t.ok', () => 5, 'fb');
  ok('a value that comes back fine is passed through', v4 === 5, String(v4));
  const v5 = await w.asGuard('t.promise', () => Promise.resolve('p'), 'fb');
  ok('a resolved promise is passed through', v5 === 'p', String(v5));
  ok('  …and neither is counted', A().caught === before, A().caught - before);
  const v6 = await w.asGuard('t.nofb', () => { throw new Error('x'); });
  ok('no fallback given reads as undefined, not a rejection', v6 === undefined, String(v6));

  const v7 = await w.asWatch('t.watch', Promise.reject(new Error('w')), 'wfb');
  ok('asWatch turns a rejection already on the wire into its fallback', v7 === 'wfb', String(v7));
  ok('  …and counts it', A().sites['t.watch'] === 1, JSON.stringify(A().sites['t.watch']));
  w.asSafe('t.handled', new Error('answered by its own empty state'));
  ok('asSafe records a failure a caller already answered for', A().sites['t.handled'] === 1);

  /* both bounds */
  const c0 = A().caught, l0 = env.lines.length;
  for (let i = 0; i < 40; i++) w.asSafe('t.flood', new Error('flood ' + i));
  const a = A();
  ok('40 failures all counted', a.caught === c0 + 40, a.caught - c0);
  ok('  …the log stops at AS_LINES (20)', env.lines.length - l0 <= 20, env.lines.length - l0);
  ok('  …and the rest are counted as dropped', a.dropped >= 20, 'dropped=' + a.dropped);
  for (let i = 0; i < 30; i++) w.asSafe('t.site' + i, new Error('s'));
  ok('the site table stops at AS_MAXW (12)', Object.keys(A().sites).length <= 12, Object.keys(A().sites).length);
  ok('  …while the count keeps counting', A().caught > c0 + 40, A().caught);
  ok('no rejection escaped the whole of part 1', rejections.length === 0, JSON.stringify(rejections.map(r => String(r.e && r.e.message))));
  env.dom.window.close();
}

/* ---------- 2. a clean boot ---------- */
async function partClean(file, label) {
  console.log('\n2. a clean boot' + (label ? ' (' + label + ')' : '') + ': the net costs nothing when nothing fails');
  const env = open(file);
  const net = typeof env.w.__ltAsync === 'function';
  await waitFor(() => env.d.querySelectorAll('#feed .card').length > 0);
  await sleep(400);
  const a = net ? env.w.__ltAsync() : null;
  ok('24 cards painted', env.d.querySelectorAll('#feed .card').length === 24, env.d.querySelectorAll('#feed .card').length);
  if (net) {
    ok('nothing was caught', a.caught === 0, 'caught=' + a.caught + ' ' + JSON.stringify(a.sites));
    ok('no lt-async line was written', env.lines.length === 0, env.lines.join(' | '));
  }
  ok('the splash left', env.d.getElementById('splash').classList.contains('out'));
  ok('the shell is ready', env.d.getElementById('app').classList.contains('ready'));
  ok('no rejection escaped the boot', rejections.length === 0, JSON.stringify(rejections.map(r => String(r.e && r.e.message))));
  return env;
}

/* ---------- 3. a real path that used to reject ---------- */
async function partPlay(file, label) {
  console.log('\n3. a render handler that throws (' + label + ')');
  const env = open(file);
  const w = env.w;
  await waitFor(() => env.d.querySelectorAll('#feed .card').length > 0);
  await sleep(300);
  const a0 = w.__ltAsync ? w.__ltAsync() : { caught: 0, sites: {} };
  const card = env.d.querySelector('#feed .card');
  const id = card && card.dataset.v;
  ok('a card to open', !!id, String(id));
  rejections.length = 0;
  const mark = w.__ltAsync ? w.__ltAsync().caught : 0;
  card.click();
  /* #pmeta exists for play()'s own write and is gone for the redraw the channel
     lookup schedules a microtask later — the exact moment a handler that trusts
     the DOM throws. */
  w.__gone = 'pmeta';
  await sleep(300);
  const caughtNow = w.__ltAsync ? w.__ltAsync().caught - mark : 0;
  const rej = rejections.length;
  ok('the player still opened', env.d.getElementById('pl').classList.contains('on'), env.d.getElementById('pl').className);
  ok('  …with the title it was given', (env.d.getElementById('ptitle').textContent || '').length > 0);
  ok('the feed is still painted', env.d.querySelectorAll('#feed .card').length === 24, env.d.querySelectorAll('#feed .card').length);
  ok('nothing on screen says anything about it', !/boom|undefined|null|Error/.test(env.d.getElementById('pl').textContent || ''));
  env.dom.window.close();
  return { caught: caughtNow, rejections: rej, sites: w.__ltAsync ? w.__ltAsync().sites : {}, base: a0 };
}

/* ---------- 4. every request fails ---------- */
async function partFailAll(file) {
  console.log('\n4. a boot where every request fails');
  rejections.length = 0;
  const env = open(file, { failAll: true });
  await waitFor(() => env.d.getElementById('splash').classList.contains('out'), 9000);
  /* the feed fails, then each of the three shelves fails, and each pays the one
     retry with its backoff — so the last failure lands well after the splash */
  await waitFor(() => (env.w.__ltAsync().sites['shelf.aimusic'] || 0) >= 1, 12000);
  await sleep(400);
  const a = env.w.__ltAsync();
  ok('the splash still left', env.d.getElementById('splash').classList.contains('out'));
  ok('the feed shows its own empty state', /Could not load videos/.test(snap(env, '#feed')), snap(env, '#feed').slice(0, 90));
  ok('each shelf failure is counted at its own site',
    ['shelf.multiai', 'shelf.calm', 'shelf.aimusic'].every(s => (a.sites[s] || 0) >= 1),
    JSON.stringify(a.sites));
  ok('the failures are logged, bounded', env.lines.length > 0 && env.lines.length <= 20, env.lines.length);
  ok('no rejection escaped a total outage', rejections.length === 0, JSON.stringify(rejections.map(r => String(r.e && r.e.message))));
  /* the app is still alive: a tab still moves and still paints */
  env.d.querySelectorAll('#tabrow .tab')[1].click();
  await sleep(120);
  ok('the tabs still work after a total outage', !env.d.getElementById('p-explore').inert);
  ok('explore still holds its carousels', env.d.querySelectorAll('#ex .car').length === 3, env.d.querySelectorAll('#ex .car').length);
  env.dom.window.close();
}

/* ---------- 5. the shape of the source ---------- */
function partSource(file) {
  console.log('\n5. the shape of the source');
  const src = fs.readFileSync(file, 'utf8');
  ok('the net exists', /function asGuard\(/.test(src) && /function asWatch\(/.test(src) && /function asSafe\(/.test(src));
  ok('window.__ltAsync() exists', /window\.__ltAsync=/.test(src));
  ok('renderSection no longer rethrows', !/catch\(e\)\{if\(e&&e\.name==='AbortError'\)return;throw e\}/.test(src)
    && /asSafe\('section\.render\.'\+name,e\)/.test(src));
  ok('the last bare .then in play() is wrapped', /asWatch\('play\.channel',loadChannels\(\[v\.ch\]\)\.then\(/.test(src));
  ok('the boot chain is one guarded promise', /asGuard\('boot\.feed',\(\)=>loadTrending\(\)/.test(src));
  ok('paintShell records what it swallows', /catch\(e\)\{asSafe\('boot\.paint',e\)\}/.test(src));
  ok('bindInput runs through bindInputSafe', /requestIdleCallback\(bindInputSafe,/.test(src) && /setTimeout\(bindInputSafe,0\)/.test(src));
  ok('the first-frame signal is guarded', /asGuard\('boot\.firstframe',\(\)=>window\.__ltFirstFrame\(\)\)\.then\(scheduleInput\)/.test(src));
  ok('the channel flush is guarded', /asWatch\('channels\.flush',Promise\.all\(run\)\)/.test(src));
  ok('the deferred-CSS apply() cannot throw', /function apply\(\)\{if\(done\)return;done=1;try\{/.test(src));
  const bare = bareThen(src);
  ok('every .then( in the app is followed by a handler or a guard', bare.length === 0, bare.join(' ; '));
  if (OLD_FILE) {
    const oldBare = bareThen(fs.readFileSync(OLD_FILE, 'utf8'));
    ok('the previous build had ' + oldBare.length + ' handler-free .then chains, this one has none', oldBare.length >= 3 && bare.length === 0,
      oldBare.map(b => b.slice(0, 40)).join(' | '));
  }
  /* No new user-facing text: every fallback the item adds reuses a sentence the
     app already shows, so the set of empty-state strings must be identical.
     Item 5.3 is the one deliberate exception — a failure's empty state may take
     its words from ekText(), which is where the app's own error sentences live,
     instead of printing the API's message. So a string that was not there before
     is allowed only if it reads its text from ekText(). */
  const a = emptyStates(src), b = emptyStates(fs.readFileSync(OLD_FILE || file, 'utf8'));
  const added = a.filter(s => b.indexOf(s) < 0);
  ok('no new empty-state text was introduced, except from ekText()', added.every(s => /ekText\(/.test(s)),
    added.join(' | ') || 'count ' + a.length + ' vs ' + b.length);
}
function emptyStates(src) {
  /* Item 5.8 appends the way out of the box to the same state. A button is a
     control, not a sentence, so a state's own words are compared with the call
     taken off — and the quote it leaves behind normalised away, because the call
     sits in the middle of a concatenation and its removal shifts the `+` around
     the closing quote. This check is about text; the button's text is asserted
     by tools/retry-affordance-check.js. */
  const norm = s => s.replace(/\+?rtyBtn\([^)]*\)\+?/g, '').replace(/\+\s*'/g, "'").replace(/''+/g, "'").replace(/'$/, '').trim();
  return [...new Set((src.match(/<div class="empty">[^<]*/g) || []).map(norm))].sort();
}

/* A `.then(` whose promise has no rejection handler at all: not `.catch`-ed on
   the same chain, not handed to asWatch/asGuard, and not given a second
   argument. That is the shape of a hole — a rejection nothing is listening for —
   so the count must be zero.

   Three sites are handler-free on purpose and are named here rather than waved
   through, because each is answered for somewhere the scanner cannot see:

     chGroup(...).then(step)      a chFlush runner step; its promise is the
                                  Promise.all(run) that asWatch('channels.flush')
                                  holds, and chGroup answers its own waiters
                                  instead of rejecting.
     return dropShorts(items).then(...)  returned out of an outer .then handler
                                  whose own .catch is two lines below it.
     Promise.resolve().then(chFlush)  the merge-window scheduler; chFlush is
                                  synchronous and cannot reject.
     asGuard('boot.firstframe',...).then(scheduleInput)  the .then is applied to
                                  the promise asGuard already returned, which
                                  cannot reject.

   The scan runs over a masked copy of the page — string literals, template
   literals and comments blanked, length preserved — so a `(` inside a string
   cannot throw the bracket matching off and a `.then` inside a comment is not
   counted. */
const THEN_OK = [
  /chGroup\(ids\.slice\(at,at\+CH_BATCH\)\)\.then\(step\)/,
  /^return dropShorts\(items\)\.then\(clean=>\{/,
  /Promise\.resolve\(\)\.then\(chFlush\)/,
  /asGuard\('boot\.firstframe',\(\)=>window\.__ltFirstFrame\(\)\)\.then\(scheduleInput\)/,
];
function maskSrc(src) {
  const out = src.split('');
  const blank = (a, b) => { for (let k = a; k < b; k++) if (out[k] !== '\n') out[k] = ' '; };
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { const j = src.indexOf('\n', i); const e = j < 0 ? n : j; blank(i, e); i = e; continue; }
    if (c === '/' && src[i + 1] === '*') { const j = src.indexOf('*/', i + 2); const e = j < 0 ? n : j + 2; blank(i, e); i = e; continue; }
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < n) { if (src[j] === '\\') { j += 2; continue; } if (src[j] === c) { j++; break; } j++; }
      blank(i + 1, j - 1); i = j; continue;
    }
    i++;
  }
  return out.join('');
}
function matchParen(m, open) {
  let d = 0;
  for (let k = open; k < m.length; k++) {
    const c = m[k];
    if (c === '(') d++;
    else if (c === ')') { d--; if (!d) return k; }
  }
  return -1;
}
/* Is this expression an argument of an asWatch( / asGuard( call? Walk outwards
   through the enclosing brackets until the statement ends. */
function enclosedByNet(m, pos) {
  let d = 0;
  for (let k = pos - 1; k >= 0; k--) {
    const c = m[k];
    if (c === ')' || c === ']' || c === '}') { d++; continue; }
    if (c === '(' || c === '[' || c === '{') {
      if (d > 0) { d--; continue; }
      if (/(?:asWatch|asGuard)\s*$/.test(m.slice(Math.max(0, k - 12), k))) return true;
      continue;                                  /* keep walking out: we are inside its arguments */
    }
    if (d === 0 && (c === ';' || c === '}')) break;
  }
  return false;
}
function bareThen(src) {
  const m = maskSrc(src), lines = src.split('\n');
  const lineOf = pos => m.slice(0, pos).split('\n').length;
  const sites = [];
  const re = /\.then\s*\(/g;
  let mm;
  while ((mm = re.exec(m))) {
    const open = m.indexOf('(', mm.index);
    const close = matchParen(m, open);
    if (close < 0) continue;
    let d = 0, commas = 0;                       /* .then(ok, fail) has its own handler */
    for (let k = open + 1; k < close; k++) {
      const c = m[k];
      if (c === '(' || c === '[' || c === '{') d++;
      else if (c === ')' || c === ']' || c === '}') d--;
      else if (c === ',' && d === 0) commas++;
    }
    if (commas >= 1) continue;
    let after = close + 1;
    while (after < m.length && /\s/.test(m[after])) after++;
    if (m.startsWith('.catch', after)) continue;
    if (enclosedByNet(m, mm.index)) continue;
    const line = lines[lineOf(mm.index) - 1].trim();
    if (THEN_OK.some(r => r.test(line))) continue;
    sites.push(lineOf(mm.index) + ': ' + line.slice(0, 90));
  }
  return sites;
}
function countBareThen(src) { return bareThen(src).length; }

/* ---------- main ---------- */
(async () => {
  console.log('build under test: ' + NEW_FILE);
  if (OLD_FILE) console.log('previous build:   ' + OLD_FILE);
  await partGuard(NEW_FILE);
  const clean = await partClean(NEW_FILE, 'this build');
  const newSnap = { feed: snap(clean, '#feed'), chips: snap(clean, '#chips'), ex: snap(clean, '#ex'), subs: snap(clean, '#subfeed') };
  const newPlay = await partPlay(NEW_FILE, 'this build');
  console.log('  → this build: caught=' + newPlay.caught + ' at ' + JSON.stringify(Object.keys(newPlay.sites).filter(k => k.startsWith('play.'))) + ', unhandled=' + newPlay.rejections);
  ok('the new build counts the handler throw at play.channel', newPlay.caught >= 1 && (newPlay.sites['play.channel'] || 0) >= 1,
    JSON.stringify(newPlay.sites));
  ok('  …and leaves no unhandled rejection behind', newPlay.rejections === 0, newPlay.rejections);

  if (OLD_FILE) {
    const oldClean = await partClean(OLD_FILE, 'previous build');
    const oldSnap = { feed: snap(oldClean, '#feed'), chips: snap(oldClean, '#chips'), ex: snap(oldClean, '#ex'), subs: snap(oldClean, '#subfeed') };
    oldClean.dom.window.close();
    ['feed', 'chips', 'ex', 'subs'].forEach(k => ok('UI unchanged: #' + (k === 'ex' ? 'ex' : k === 'subs' ? 'subfeed' : k) + ' markup is identical',
      newSnap[k] === oldSnap[k], (newSnap[k] || '').slice(0, 60) + ' vs ' + (oldSnap[k] || '').slice(0, 60)));
    const oldPlay = await partPlay(OLD_FILE, 'previous build');
    console.log('  → previous build: unhandled=' + oldPlay.rejections + ' (no net to count it)');
    ok('the previous build leaks the same throw as an unhandled rejection', oldPlay.rejections >= 1, oldPlay.rejections);
  }
  clean.dom.window.close();
  await partFailAll(NEW_FILE);
  partSource(NEW_FILE);

  console.log('\n' + pass + ' passed, ' + fails.length + ' failed');
  if (fails.length) { fails.forEach(f => console.log('  ! ' + f)); process.exit(1); }
})().catch(e => { console.error('\nharness error: ' + (e && e.stack || e)); process.exit(2); });
