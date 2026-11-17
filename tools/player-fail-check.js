#!/usr/bin/env node
/*
 * LiquidTube player-fail check — item 8.4 ("handle iframe load failures with a
 * visible retry").
 *
 * Before this item the player had no failure state at all. `mount()` painted the
 * loader and an iframe; if the embed document never arrived — a dropped radio, a
 * captive portal, a host the network refuses — the loader hopped for ever behind
 * a frame showing the WebView's own error page, and the only way to try the video
 * again was to close the player and start over from the feed.
 *
 * The item arms one timer per frame that is loading and takes it off again as
 * soon as the player proves it is alive. This check asserts what makes that
 * honest, in jsdom with the API answered from fixtures and the frame simulated:
 *
 *   armed     a fresh frame waits PL_LOAD_MS (PL_OFF_MS when the device reports
 *             no connection), and a frame that is already playing owes no wait
 *   staged    the document's `load` advances the wait to PL_READY_MS — an error
 *             page fires `load` too, so the silence after it is what is caught
 *   alive     a jsapi message from the frame's own window clears the wait, and
 *             one from any other window does not
 *   failed    the wait running out draws the app's own `.empty` sentence and the
 *             `.opt glass` "Try again" pill inside `.art`, takes the dead frame
 *             down and registers the retry
 *   retry     the tap rebuilds the frame for that video — once, never twice —
 *             and a tap that lands after the user moved on mounts nothing
 *   quiet     closing the player, or reusing a frame, leaves no timer behind, a
 *             backgrounded timer re-arms instead of blaming the player, and a
 *             user who never plays runs none of this
 *   same      the happy path is byte-identical to the previous build: the same
 *             `.art` markup, the same `#pl` markup, the same `#feed`, and the
 *             same stylesheet once the one new rule is removed
 *
 * Usage:
 *   npm i jsdom                              # dev only, not shipped in the APK
 *   node tools/player-fail-check.js [build.html] [previous-build.html]
 * Exit code 1 when the build under test fails any check.
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
  playlist: {
    items: vids.slice(0, 10).map((id, i) => ({
      snippet: { resourceId: { videoId: id }, title: 'Uploaded video ' + (i + 1), channelTitle: 'Channel 0', publishedAt: pub(i + 1) },
      contentDetails: { videoPublishedAt: pub(i + 1) },
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
  if (p.endsWith('/playlistItems')) return F.playlist;
  if (p.endsWith('/search')) return F.search;
  return {};
}
const isTrending = u => /\/videos\?/.test(u) && /chart=mostPopular/.test(u);
const isSearch = u => /\/search\?/.test(u);
const isPlaylist = u => /\/playlistItems\?/.test(u);
const isChannels = u => /\/channels\?/.test(u);

/* the API's error bodies, as items 5.2/5.3 classify them */
const body = (status, reason) => ({ error: { code: status, message: 'the request cannot be completed', errors: [{ reason: reason || 'unknown', domain: 'youtube', message: 'nope' }] } });
const QUOTA = { status: 403, body: body(403, 'quotaExceeded') };
const BADKEY = { status: 403, body: body(403, 'keyInvalid') };
const GONE = { status: 404, body: body(404, 'videoNotFound') };
const BROKEN = { status: 500, body: body(500, null) };

/* a page: fresh window and localStorage, a fetch that answers from the fixtures.
   `queue` may be prefilled — the boot request fires while the document is still
   being parsed, so a scripted boot failure has to be in place before the JSDOM
   is constructed. */
function open(file, pre) {
  const HTML = fs.readFileSync(file, 'utf8');
  const env = { log: [], lines: [], errors: [], rejects: [], queue: (pre && pre.queue) || [], only: (pre && pre.only) || null };
  const mockFetch = async u => {
    u = String(u);
    env.log.push({ url: u.replace(/([?&])key=[^&]*/, '$1key=<key>'), t: Date.now() });
    const step = (env.queue.length && (!env.only || env.only(u))) ? env.queue.shift() : 'ok';
    if (step === 'throw') throw new TypeError('Failed to fetch');
    if (step === 'abort') { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
    if (typeof step === 'object') {
      return { ok: step.status >= 200 && step.status < 300, status: step.status, headers: new Map(), json: async () => step.body };
    }
    const j = apiBody(u);
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
      w.console.log = (...a) => { env.lines.push(a.map(x => (typeof x === 'string' ? x : String(x))).join(' ')); };
      w.console.info = () => {};
      w.console.warn = () => {};
      w.console.error = (...a) => { env.errors.push(a.map(x => String(x)).join(' ')); };
      w.addEventListener('unhandledrejection', e => env.rejects.push(e));
    },
  });
  env.w = dom.window;
  env.d = dom.window.document;
  env.dom = dom;
  return env;
}

async function waitFor(fn, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(20); }
  return false;
}
const boot = async (file, pre) => {
  const env = open(file, pre);
  await waitFor(() => env.d.querySelectorAll('#feed .card').length > 0 || /class="empty"/.test(env.d.getElementById('feed').innerHTML), 20000);
  await sleep(150);
  return env;
};

/* ---------- assertions ---------- */
let pass = 0;
const fails = [];
function ok(label, cond, detail) {
  if (cond) { pass++; return; }
  fails.push(label + (detail !== undefined ? ' — ' + detail : ''));
}

const artOf = env => env.d.querySelector('#pl .art');
const frameIn = env => artOf(env) ? artOf(env).querySelector('iframe') : null;
const boxIn = env => artOf(env) ? artOf(env).querySelector('.empty') : null;
const rtyIn = env => artOf(env) ? artOf(env).querySelector('button.rty') : null;
const textOf = el => {
  if (!el) return '';
  const c = el.cloneNode(true);
  c.querySelectorAll('button').forEach(b => b.remove());
  c.querySelectorAll('br').forEach(b => b.replaceWith(' '));
  return c.textContent.replace(/\s+/g, ' ').trim();
};
const tap = (env, el) => { if (!el) return false; el.dispatchEvent(new env.w.MouseEvent('click', { bubbles: true, cancelable: true })); return true; };

/* The player's wait is the only timer this tool needs to move, and it is the
   only one the app arms in these flows — so the clock is replaced with a queue
   the test fires by hand. Nothing here sleeps for 12 s, and nothing in the app
   is changed to make the test possible. */
function clock(env) {
  const w = env.w, timers = [];
  const realST = w.setTimeout, realCT = w.clearTimeout;
  w.setTimeout = (fn, ms) => { const t = { fn, ms, cancelled: false }; timers.push(t); return t; };
  w.clearTimeout = id => { if (id && typeof id === 'object') id.cancelled = true; };
  const isWait = t => t.ms === 12000 || t.ms === 10000 || t.ms === 3500;
  return {
    timers,
    waits: () => timers.filter(isWait),
    pending: () => timers.filter(isWait).filter(t => !t.cancelled),
    fire(t) { if (!t || t.cancelled) return false; t.cancelled = true; t.fn(); return true; },
    fireAll() { timers.filter(t => !t.cancelled).forEach(t => { t.cancelled = true; t.fn(); }); },
    restore() { w.setTimeout = realST; w.clearTimeout = realCT; },
  };
}
/* A frame's own `load`, and a jsapi message from a given window. */
function loaded(env, f) { f.dispatchEvent(new env.w.Event('load')); }
function msg(env, f, data, opts) {
  const o = opts || {};
  const ev = new env.w.MessageEvent('message', {
    data: typeof data === 'string' ? data : JSON.stringify(data),
    origin: o.origin || 'https://www.youtube-nocookie.com',
    source: 'source' in o ? o.source : (f && f.contentWindow),
  });
  env.w.dispatchEvent(ev);
}
/* Boot, then open one video and hand back the fake clock. */
async function player(file, id, pre) {
  const env = await boot(file, pre);
  const c = clock(env);
  env.w.play(id);
  return { env, c };
}

/* ---------- 1. a frame that loads normally ---------- */
async function happy(file, quiet) {
  if (!quiet) console.log('\n1. a frame that loads normally');
  const { env, c } = await player(file, vids[0]);
  const f = frameIn(env);
  ok('a play builds one frame in .art', !!f, artOf(env) && artOf(env).innerHTML.slice(0, 120));
  ok('the loader is still under it', !!artOf(env).querySelector('.ldr.abs'));
  ok('nothing else is drawn in .art', !boxIn(env) && !rtyIn(env));
  const p = env.w.__ltPlayer();
  ok('window.__ltPlayer() is the player table', p && typeof p === 'object' && 'armed' in p, JSON.stringify(p));
  ok('the frame is waited on', p.armed === true, JSON.stringify(p));
  ok('the wait is the online load constant', c.pending().length === 1 && c.pending()[0].ms === 12000,
    c.pending().map(t => t.ms).join(','));
  ok('no retry is offered for a frame that is still loading', env.w.__ltRetry().keys.includes('player') === false,
    env.w.__ltRetry().keys.join(','));
  ok('nothing failed yet', p.fails === 0, String(p.fails));
  c.restore();
  return env;
}

/* ---------- 2. the document's load advances the wait ---------- */
async function staged(file) {
  console.log('\n2. the document arrived, the player has not answered yet');
  const { env, c } = await player(file, vids[0]);
  const f = frameIn(env);
  loaded(env, f);
  const p = c.pending();
  ok('the load stage is spent', c.waits().filter(t => t.ms === 12000).every(t => t.cancelled));
  ok('the ready stage is armed', p.length === 1 && p[0].ms === 10000, p.map(t => t.ms).join(','));
  ok('the frame is still waited on', env.w.__ltPlayer().armed === true);
  ok('a document that loaded draws no box', !boxIn(env));
  c.restore();
}

/* ---------- 3. the player answering is what clears the wait ---------- */
async function alive(file) {
  console.log('\n3. the player answers');
  const { env, c } = await player(file, vids[0]);
  const f = frameIn(env);
  loaded(env, f);
  msg(env, f, { event: 'onReady' });
  ok('a message from the frame clears the wait', env.w.__ltPlayer().armed === false);
  ok('no timer is left behind', c.pending().length === 0, c.pending().map(t => t.ms).join(','));
  msg(env, f, { event: 'infoDelivery', info: { currentTime: 12, duration: 750 } });
  ok('a later report costs no timer either', c.pending().length === 0 && env.w.__ltPlayer().armed === false);
  ok('the frame is still on screen', frameIn(env) === f && !boxIn(env));
  c.restore();
}

/* ---------- 4. a message from anywhere else proves nothing ---------- */
async function impostor(file) {
  console.log('\n4. a message from another window');
  const { env, c } = await player(file, vids[0]);
  const f = frameIn(env);
  loaded(env, f);
  msg(env, f, { event: 'onReady' }, { source: env.w });
  ok('the window itself does not clear the wait', env.w.__ltPlayer().armed === true);
  msg(env, f, { event: 'onReady' }, { source: null });
  ok('a message with no source does not clear it', env.w.__ltPlayer().armed === true);
  msg(env, f, { event: 'onReady' }, { origin: 'https://evil.example' });
  ok('a foreign origin does not clear it', env.w.__ltPlayer().armed === true);
  ok('the wait is still the ready stage', c.pending().length === 1 && c.pending()[0].ms === 10000);
  c.restore();
}

/* ---------- 5. the wait running out draws the way out ---------- */
async function failed(file) {
  console.log('\n5. a player that never starts');
  const { env, c } = await player(file, vids[0]);
  const f = frameIn(env);
  loaded(env, f);
  c.fire(c.pending()[0]);
  const box = boxIn(env);
  ok('a box is drawn in the frame\'s place', !!box);
  ok('the sentence is ours', textOf(box) === 'Could not load the player. Check your connection.', textOf(box));
  ok('the box is announced', box && box.getAttribute('role') === 'alert');
  ok('the dead frame is gone', !frameIn(env) && artOf(env).querySelectorAll('iframe').length === 0);
  ok('the loader is gone with it', !artOf(env).querySelector('.ldr.abs'));
  const b = rtyIn(env);
  ok('the way out is the app\'s own pill', !!b && b.className === 'opt glass rty' && b.getAttribute('data-r') === 'player',
    b && b.className);
  ok('the retry is registered', env.w.__ltRetry().keys.includes('player'), env.w.__ltRetry().keys.join(','));
  ok('the failure is counted', env.w.__ltPlayer().fails === 1, String(env.w.__ltPlayer().fails));
  ok('nothing is waited on any more', env.w.__ltPlayer().armed === false && c.pending().length === 0);
  ok('the panel still shows its title and buttons',
    !!env.d.getElementById('ptitle') && env.d.getElementById('ptitle').textContent.length > 0 &&
    !!env.d.getElementById('pclose'));
  c.restore();
  return env;
}

/* ---------- 6. the tap rebuilds the frame, once ---------- */
async function retry(file) {
  console.log('\n6. the way out');
  const env = await failed(file);
  const b = rtyIn(env);
  tap(env, b);
  ok('the tap is spent at once', b.disabled === true);
  ok('the frame is rebuilt', !!frameIn(env) && frameIn(env).getAttribute('src').includes(vids[0]));
  ok('the box is gone', !boxIn(env));
  ok('the frame is waited on again', env.w.__ltPlayer().armed === true);
  const n = artOf(env).querySelectorAll('iframe').length;
  tap(env, b);
  ok('a second tap mounts nothing', artOf(env).querySelectorAll('iframe').length === n && n === 1, String(n));
  ok('a second tap draws no box', !boxIn(env));
}

/* ---------- 7. a tap that lands after the user moved on ---------- */
async function movedOn(file) {
  console.log('\n7. a tap that arrives too late');
  const env = await failed(file);
  const b = rtyIn(env);
  env.w.closeAll();
  tap(env, b);
  ok('a closed player is not re-mounted', artOf(env).querySelectorAll('iframe').length === 0);
  ok('and no box is drawn into it', !boxIn(env));
}

/* ---------- 8. the waits that must never fire ---------- */
async function quiet(file) {
  console.log('\n8. closing, reusing, and the background');
  {
    const { env, c } = await player(file, vids[0]);
    env.w.closeAll();
    ok('closing disarms the wait', env.w.__ltPlayer().armed === false);
    ok('closing leaves no timer', c.pending().length === 0, c.pending().map(t => t.ms).join(','));
    c.fireAll();
    ok('a stale timer cannot paint a box into a closed panel', !boxIn(env));
    c.restore();
  }
  {
    const { env, c } = await player(file, vids[0]);
    const f = frameIn(env);
    loaded(env, f);
    msg(env, f, { event: 'onReady' });
    env.w.play(vids[0]);
    ok('the same video reuses the frame', frameIn(env) === f && artOf(env).querySelectorAll('iframe').length === 1);
    ok('a reused frame owes no wait', env.w.__ltPlayer().armed === false && c.pending().length === 0);
    c.fireAll();
    ok('a reused frame draws no box', !boxIn(env));
    c.restore();
  }
  {
    const { env, c } = await player(file, vids[0]);
    loaded(env, frameIn(env));
    Object.defineProperty(env.d, 'hidden', { configurable: true, get: () => true });
    c.fire(c.pending()[0]);
    ok('a frozen background timer does not blame the player', !boxIn(env) && env.w.__ltPlayer().armed === true);
    ok('it re-arms instead', c.pending().length === 1 && c.pending()[0].ms === 10000, c.pending().map(t => t.ms).join(','));
    c.restore();
  }
}

/* ---------- 9. a user who never plays ---------- */
async function idle(file) {
  console.log('\n9. a session that never opens a video');
  const env = await boot(file);
  const c = clock(env);
  await sleep(120);
  ok('no wait is armed', env.w.__ltPlayer().armed === false && c.pending().length === 0);
  ok('no failure is counted', env.w.__ltPlayer().fails === 0);
  ok('the player box is untouched', artOf(env).children.length === 0, artOf(env).innerHTML.slice(0, 80));
  ok('no retry is registered', env.w.__ltRetry().keys.includes('player') === false, env.w.__ltRetry().keys.join(','));
  c.restore();
}

/* ---------- 10. the device reports no connection ---------- */
async function offline(file) {
  console.log('\n10. no connection');
  const env = await boot(file);
  Object.defineProperty(env.w.navigator, 'onLine', { configurable: true, get: () => false });
  const c = clock(env);
  env.w.play(vids[1]);
  ok('the offline wait is the short one', c.pending().length === 1 && c.pending()[0].ms === 3500,
    c.pending().map(t => t.ms).join(','));
  c.fire(c.pending()[0]);
  ok('it ends in the same box', !!boxIn(env) && !!rtyIn(env));
  c.restore();
}

/* ---------- 11. nothing else moved ---------- */
async function same(file, prev) {
  console.log('\n11. nothing else moved');
  const A = await happy(file, 1);
  ok('no console error on the happy path', A.errors.length === 0, A.errors.join(' | '));
  ok('no unhandled rejection on the happy path', A.rejects.length === 0, A.rejects.map(String).join(' | '));

  const src = fs.readFileSync(file, 'utf8');
  ok('the constants are named where the item names them',
    /const PL_LOAD_MS=12000,PL_OFF_MS=3500,PL_READY_MS=10000;/.test(src));
  ok('mount arms the wait for the frame it built',
    /plArm\(f,plOnline\(\)\?PL_LOAD_MS:PL_OFF_MS\)/.test(src));
  ok('every teardown disarms',
    /frameKey='';loopGuardOff\(\);plOff\(\)/.test(src) && /function stopFrame\(\)\{\n  plOff\(\)/.test(src));
  ok('a reused frame disarms', /cmdFrame\(live,'playVideo',\[\]\);\n    plOff\(\)/.test(src));
  ok('the load handler advances the wait', /plLoaded\(f\)/.test(src));
  ok('the message bridge reports the frame alive', /plAlive\(e\.source\)/.test(src));
  ok('the box is the app\'s own empty state with a role',
    /a\.innerHTML='<div class="empty" role="alert">Could not load the player/.test(src));
  ok('the failure box is positioned, not a stray block',
    /\.art>\.empty\{position:absolute;inset:0/.test(src));

  if (!prev) { console.log('   (no previous build given: A/B skipped)'); return; }

  const env = await boot(file);
  const env2 = await boot(prev);
  ok('the feed is byte-identical', env.d.getElementById('feed').innerHTML === env2.d.getElementById('feed').innerHTML);
  ok('the tab strip is byte-identical', env.d.getElementById('tabs').innerHTML === env2.d.getElementById('tabs').innerHTML);
  ok('the sheet is byte-identical', env.d.getElementById('sheet').outerHTML === env2.d.getElementById('sheet').outerHTML);

  const cssOf = e => [...e.d.querySelectorAll('style')].map(s => s.textContent).join('\n');
  const strip = s => s.replace(/\/\* The one thing that is ever drawn inside[\s\S]*?\.art>\.empty\{[^}]*\}\n/, '');
  ok('the stylesheet is the old one plus exactly one rule',
    strip(cssOf(env)) === cssOf(env2) &&
    /\.art>\.empty\{position:absolute;inset:0;display:flex;flex-direction:column;justify-content:center;padding:0 16px\}/.test(cssOf(env)));

  const play = async (e, id) => {
    const c = clock(e);
    e.w.play(id);
    const f = frameIn(e);
    const out = { art: artOf(e).innerHTML, pl: e.d.getElementById('pl').outerHTML, src: f && f.getAttribute('src') };
    c.restore();
    return out;
  };
  const x = await play(env, vids[3]);
  const y = await play(env2, vids[3]);
  ok('the frame\'s URL is identical', x.src === y.src, x.src + ' vs ' + y.src);
  ok('.art is byte-identical while a video loads', x.art === y.art);
  ok('the player panel is byte-identical', x.pl === y.pl);
  ok('the previous build has no player table', typeof env2.w.__ltPlayer === 'undefined');
}

(async () => {
  const file = process.argv[2] || path.join(__dirname, '..', 'app', 'assets', 'index.html');
  const prev = process.argv[3] || '';
  console.log('LiquidTube player-fail check — ' + file);

  await happy(file);
  await staged(file);
  await alive(file);
  await impostor(file);
  await failed(file);
  await retry(file);
  await movedOn(file);
  await quiet(file);
  await idle(file);
  await offline(file);
  await same(file, prev);

  console.log('');
  if (fails.length) {
    console.log('FAIL — ' + fails.length + ' failed, ' + pass + ' passed');
    fails.forEach(f => console.log('  · ' + f));
    process.exit(1);
  }
  console.log('PASS — ' + pass + ' assertions');
})();
