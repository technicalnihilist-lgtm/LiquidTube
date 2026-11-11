#!/usr/bin/env node
/*
 * LiquidTube global-net check — proves item 5.4: an uncaught error and an
 * unhandled rejection are both logged in the app's own format, bounded, and
 * recovered from where recovery is possible.
 *
 * Everything runs in jsdom with googleapis.com answered from fixtures — no
 * network, no Chromium, no device — and every event is dispatched at the window
 * the way the engine dispatches it, so the handlers are exercised through the
 * same entry points a real throw reaches.
 *
 *  1. A clean boot costs nothing: the census is empty, no `lt-global` line is
 *     written, and the shell the app paints is byte-identical to the previous
 *     build's (the A/B half, when a previous build is given).
 *  2. One uncaught error → exactly one line, in the shape the item asks for:
 *     `lt-global kind=error where=index.html:213 msg=boom n=1`. The filename's
 *     query string never reaches the line, and the app keeps running.
 *  3. An error loop (the same site sixty times a second) is printed once and
 *     counted; distinct sites are capped; `dropped` says what was not printed.
 *  4. Message hygiene: newlines, a very long message and the page's own URL
 *     cannot break the one-line format or leak the URL.
 *  5. An AbortError is not a failure; a resource error (an <img> with no
 *     onerror) is not an uncaught error; neither moves a counter.
 *  6. An unhandled rejection → one `lt-global kind=reject` line, and the event
 *     is prevented, because the app has already reported it once.
 *  7. Recovery: a splash that is still up comes down, and a card caught mid-tilt
 *     is released instead of sitting at an angle until the next gesture.
 *  8. The shape of the source: both listeners are registered at parse time,
 *     before anything can throw, and the handler is re-entrancy guarded.
 *
 *   npm i jsdom
 *   node tools/global-error-check.js app/assets/index.html /tmp/old/index.html
 *
 * argv[2] is the build under test, argv[3] the previous build (optional; the A/B
 * half of part 1 is skipped without it).
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
  /* a playlistItems body in the shape the endpoint really sends: the search
     fixture's ids wrapped in snippet.resourceId. It used to answer with the
     search body itself, which no server does — item 5.9 validates the shape
     before mapping it now, so the fixture has to be the real one. */
  if (p.endsWith('/playlistItems')) return { items: F.search.items.map(it => ({ snippet: Object.assign({}, it.snippet, { resourceId: { videoId: it.id.videoId } }), contentDetails: { videoPublishedAt: it.snippet.publishedAt } })) };
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
  if (cond) { pass++; console.log('  PASS  ' + label); return true; }
  fails.push(label + (detail !== undefined ? ' — ' + detail : ''));
  console.log('  FAIL  ' + label + (detail !== undefined ? ' — ' + detail : ''));
  return false;
}
const glLines = env => env.log.filter(s => s.startsWith('lt-global'));
const census = env => env.w.__ltGlobal();
const fireErr = (env, o) => env.w.dispatchEvent(new env.w.ErrorEvent('error', {
  message: o.message || 'boom',
  filename: o.filename !== undefined ? o.filename : 'https://liquidtube.local/index.html',
  lineno: o.lineno || 1,
  colno: o.colno || 1,
  error: o.error || new Error(o.message || 'boom'),
}));
function fireRej(env, reason) {
  const ev = new env.w.Event('unhandledrejection', { cancelable: true });
  ev.reason = reason;
  env.w.dispatchEvent(ev);
  return ev;
}
async function boot(file, opts) {
  const env = open(file, opts);
  await waitFor(() => env.d.querySelectorAll('#feed .card').length > 0);
  await sleep(120);
  return env;
}

/* ---------- 1. a clean boot ---------- */
async function partClean() {
  console.log('\n1. a clean boot: no lines, no counters, no pixels');
  const env = await boot(NEW_FILE);
  const g = census(env);
  ok('the census is exposed', typeof env.w.__ltGlobal === 'function');
  ok('nothing counted', g.n === 0 && g.err === 0 && g.rej === 0, JSON.stringify({ n: g.n, err: g.err, rej: g.rej }));
  ok('no line written', glLines(env).length === 0, glLines(env).join(' | '));
  ok('no sites, no drops, no rescues', Object.keys(g.sites).length === 0 && g.dropped === 0 && g.rescued === 0);
  ok('last is null', g.last === null);
  ok('the feed still painted 24 cards', env.d.querySelectorAll('#feed .card').length === 24);
  ok('the splash left', env.d.getElementById('splash').classList.contains('out'));
  ok('the app is ready', env.d.getElementById('app').classList.contains('ready'));
  if (OLD_FILE) {
    const old = await boot(OLD_FILE);
    for (const sel of ['#feed', '#chips', '#ex', '#subfeed', '#splash', '#app']) {
      ok('the previous build paints the same ' + sel, snap(env, sel) === snap(old, sel));
    }
  } else {
    console.log('  SKIP  A/B against the previous build (no argv[3])');
  }
  env.dom.window.close();
}

/* ---------- 2. one uncaught error ---------- */
async function partOne() {
  console.log('\n2. one uncaught error: one line, and the app keeps running');
  const env = await boot(NEW_FILE);
  fireErr(env, { message: 'boom', filename: 'https://liquidtube.local/index.html?q=secret-query', lineno: 213, colno: 9 });
  await sleep(30);
  const lines = glLines(env);
  ok('exactly one line', lines.length === 1, lines.join(' | '));
  ok('the line is the documented shape',
    lines[0] === 'lt-global kind=error where=index.html:213 msg=boom n=1', lines[0]);
  ok('the query string is not in the line', !/secret-query/.test(lines[0] || ''));
  ok('the page URL is not in the line', !/liquidtube\.local/.test(lines[0] || ''));
  const g = census(env);
  ok('counted as an error', g.n === 1 && g.err === 1 && g.rej === 0, JSON.stringify(g));
  ok('one site, count 1', g.sites['error@index.html:213'] && g.sites['error@index.html:213'].n === 1);
  ok('last names the site', g.last && g.last.kind === 'error' && g.last.where === 'index.html:213' && g.last.msg === 'boom');
  ok('the feed is still there', env.d.querySelectorAll('#feed .card').length === 24);
  /* the app still answers a tap: the tab strip moves the active marker */
  const tabs = env.d.querySelectorAll('.tab');
  if (tabs.length > 1) {
    const before = [...tabs].findIndex(t => t.classList.contains('on'));
    tabs[1].dispatchEvent(new env.w.MouseEvent('click', { bubbles: true }));
    await sleep(60);
    const after = [...env.d.querySelectorAll('.tab')].findIndex(t => t.classList.contains('on'));
    ok('a tap after the error still works', after === 1, 'before ' + before + ' after ' + after);
  } else {
    console.log('  SKIP  tab strip (not found)');
  }
  env.dom.window.close();
}

/* ---------- 3. bounds ---------- */
async function partBounds() {
  console.log('\n3. bounds: an error loop cannot flood the log');
  let env = await boot(NEW_FILE);
  for (let i = 0; i < 60; i++) fireErr(env, { message: 'frame boom', lineno: 900 });
  await sleep(30);
  let g = census(env);
  ok('sixty throws, one line', glLines(env).length === 1, glLines(env).length + ' lines');
  ok('sixty counted', g.n === 60 && g.err === 60, JSON.stringify({ n: g.n, err: g.err }));
  ok('the site count is 60', g.sites['error@index.html:900'] && g.sites['error@index.html:900'].n === 60);
  ok('nothing dropped for a repeated site', g.dropped === 0);
  env.dom.window.close();

  env = await boot(NEW_FILE);
  for (let i = 0; i < 30; i++) fireErr(env, { message: 'site ' + i, lineno: 1000 + i });
  await sleep(30);
  g = census(env);
  const sites = Object.keys(g.sites).length;
  ok('at most 8 sites are remembered', sites <= 8, sites + ' sites');
  ok('at most 20 lines are written', glLines(env).length <= 20, glLines(env).length + ' lines');
  ok('the rest is counted, not printed', g.n === 30 && g.dropped >= 10, JSON.stringify({ n: g.n, dropped: g.dropped }));
  ok('every written line names a different site', new Set(glLines(env)).size === glLines(env).length);
  ok('every line ends with the running total', glLines(env).every(s => / n=\d+$/.test(s)));
  env.dom.window.close();
}

/* ---------- 4. message hygiene ---------- */
async function partMsg() {
  console.log('\n4. message hygiene: one line, cut short, no URL');
  const env = await boot(NEW_FILE);
  const long = 'first line\nsecond line\twith tabs ' + 'x'.repeat(400);
  fireErr(env, { message: long, filename: 'https://liquidtube.local/index.html', lineno: 42 });
  await sleep(30);
  const line = glLines(env)[0] || '';
  const msg = (line.match(/ msg=(.*) n=\d+$/) || [])[1] || '';
  ok('one line only', glLines(env).length === 1);
  ok('no newline in the line', !/[\n\r\t]/.test(line), JSON.stringify(line));
  ok('the message is cut at 120 + ...', msg.length <= 123 && msg.endsWith('...'), msg.length + ' chars');
  ok('the message still starts with the real text', msg.startsWith('first line second line with tabs xxx'));
  ok('the URL is not in the line', !/liquidtube\.local/.test(line));
  ok('the line is under 200 characters', line.length < 200, line.length + ' chars');
  /* a throw that carries no message at all still writes a usable line */
  env.w.dispatchEvent(new env.w.ErrorEvent('error', { message: '', filename: 'https://liquidtube.local/index.html', lineno: 43 }));
  await sleep(20);
  ok('an empty message still logs a line',
    glLines(env)[1] === 'lt-global kind=error where=index.html:43 msg=unknown n=2', glLines(env)[1]);
  env.dom.window.close();
}

/* ---------- 5. what is not a failure ---------- */
async function partNot() {
  console.log('\n5. not a failure: AbortError, and a resource that failed to load');
  const env = await boot(NEW_FILE);
  const abort = new env.w.Error('aborted');
  abort.name = 'AbortError';
  const ev = fireRej(env, abort);
  await sleep(20);
  let g = census(env);
  ok('an AbortError is not counted', g.n === 0 && g.rej === 0, JSON.stringify(g));
  ok('an AbortError writes no line', glLines(env).length === 0);
  ok('an AbortError is still prevented', ev.defaultPrevented === true);
  /* an <img> with no onerror: the page has its own path for it (item 6.5) */
  const img = env.d.createElement('img');
  img.src = 'https://i.ytimg.com/vi/nope/maxresdefault.jpg';
  env.d.getElementById('feed').appendChild(img);
  img.dispatchEvent(new env.w.Event('error', { bubbles: true }));
  await sleep(20);
  g = census(env);
  ok('a resource error is not an uncaught error', g.n === 0 && g.err === 0, JSON.stringify(g));
  ok('a resource error writes no line', glLines(env).length === 0);
  env.dom.window.close();
}

/* ---------- 6. an unhandled rejection ---------- */
async function partRej() {
  console.log('\n6. an unhandled rejection: logged once, and prevented');
  const env = await boot(NEW_FILE);
  const r = new env.w.Error('promise boom');
  r.stack = 'Error: promise boom\n    at play (https://liquidtube.local/index.html:1418:31)';
  const ev = fireRej(env, r);
  await sleep(20);
  const lines = glLines(env);
  ok('exactly one line', lines.length === 1, lines.join(' | '));
  ok('the line is the documented shape',
    lines[0] === 'lt-global kind=reject where=index.html:1418 msg=promise boom n=1', lines[0]);
  const g = census(env);
  ok('counted as a rejection', g.n === 1 && g.rej === 1 && g.err === 0, JSON.stringify(g));
  ok('the event is prevented', ev.defaultPrevented === true);
  /* a rejection with no stack still names something */
  const bare = new env.w.Error('no stack here');
  bare.stack = '';
  fireRej(env, bare);
  await sleep(20);
  ok('a stackless rejection logs where=promise', glLines(env)[1] === 'lt-global kind=reject where=promise msg=no stack here n=2', glLines(env)[1]);
  env.dom.window.close();
}

/* ---------- 7. recovery ---------- */
async function partRecover() {
  console.log('\n7. recovery: the splash comes down, a stranded tilt is released');
  const env = await boot(NEW_FILE);
  /* The exact state the recovery reads: the splash still up over a painted shell. */
  const sp = env.d.getElementById('splash'), ap = env.d.getElementById('app');
  sp.classList.remove('out'); ap.classList.remove('ready');
  fireErr(env, { message: 'boot boom', lineno: 2001 });
  await sleep(30);
  ok('the splash came down', sp.classList.contains('out'));
  ok('the app is ready', ap.classList.contains('ready'));
  ok('the rescue is counted', census(env).rescued === 1, JSON.stringify(census(env)));
  ok('and the error is still logged', glLines(env).length === 1);
  /* A second error has nothing left to rescue. */
  fireErr(env, { message: 'later boom', lineno: 2002 });
  await sleep(20);
  ok('nothing left to rescue the second time', census(env).rescued === 1);

  /* A card caught mid-tilt: the card must not stay at an angle. */
  const card = env.d.querySelector('#feed .card');
  card.getBoundingClientRect = () => ({ left: 0, top: 0, width: 300, height: 200, right: 300, bottom: 200, x: 0, y: 0 });
  card.dispatchEvent(new env.w.MouseEvent('pointerdown', { bubbles: true, clientX: 10, clientY: 10 }));
  env.d.dispatchEvent(new env.w.MouseEvent('pointermove', { bubbles: true, clientX: 260, clientY: 190 }));
  await sleep(10);
  const tilted = /rotateX/.test(card.style.transform) && card.classList.contains('tilt');
  ok('the tilt really started', tilted, JSON.stringify(card.style.transform));
  fireErr(env, { message: 'gesture boom', lineno: 2003 });
  await sleep(20);
  ok('the card is back at rest', card.style.transform === '', JSON.stringify(card.style.transform));
  ok('the rescue is counted again', census(env).rescued === 2, JSON.stringify(census(env)));
  await sleep(320);
  ok('the tilt layer hint is gone', !card.classList.contains('tilt'));
  env.dom.window.close();
}

/* ---------- 8. the shape of the source ---------- */
function partSource() {
  console.log('\n8. the shape of the source');
  const src = fs.readFileSync(NEW_FILE, 'utf8');
  const script = (src.match(/<script>([\s\S]*?)<\/script>/) || [])[1] || '';
  ok('window error listener is registered', /window\.addEventListener\('error'/.test(script));
  ok('window unhandledrejection listener is registered', /window\.addEventListener\('unhandledrejection'/.test(script));
  const iErr = script.indexOf("window.addEventListener('error'");
  const iBoot = script.indexOf('paintSkeleton();');
  ok('both listeners are registered before the boot paints', iErr > 0 && iBoot > iErr, iErr + ' < ' + iBoot);
  ok('the handler is re-entrancy guarded', /if\(glIn\)return;/.test(script));
  ok('the recovery cannot throw out of the handler',
    /try\{GL_ST\.rescued\+=glRecover\(\);glRecord\(kind,where,msg\)\}catch\(e\)\{\}/.test(script));
  ok('the line goes out under the lt- prefix', /'lt-global kind='\+kind/.test(script));
  ok('the line never carries a URL', !/console\.log\('lt-global[^']*location/.test(script));
  ok('no CSS was added by this item', !/#lt-global|\.lt-global/.test(src));
}

/* ---------- run ---------- */
(async () => {
  await partClean();
  await partOne();
  await partBounds();
  await partMsg();
  await partNot();
  await partRej();
  await partRecover();
  partSource();
  await sleep(50);
  console.log('\n' + pass + '/' + (pass + fails.length) + ' assertions passed');
  if (fails.length) {
    console.log('failed:');
    fails.forEach(f => console.log('  - ' + f));
  }
  const ignorable = e => /WebAssembly|Cannot allocate/i.test(String((e && e.message) || ''));
  const real = rejections.filter(r => !ignorable(r.e));
  if (real.length) {
    console.log('\nuncaught in the harness (' + real.length + '):');
    real.slice(0, 5).forEach(r => console.log('  ' + r.kind + ': ' + String(r.e && r.e.message)));
  }
  process.exit(fails.length || real.length ? 1 : 0);
})();
