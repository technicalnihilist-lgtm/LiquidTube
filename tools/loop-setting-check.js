#!/usr/bin/env node
/*
 * LiquidTube loop-setting check — item 8.5 ("respect the loop setting through
 * the jsapi channel only").
 *
 * Before this item the Loop switch was a setting the player never heard about.
 * The wrap itself already ran off the player's own `onStateChange` (state 0 →
 * seek back to 0 and play), but the *setting* reached nothing: turning Loop on
 * with a video open changed nothing until the next video was opened, turning it
 * off left a wrap already on its way to rebuild the frame, and the only way to
 * have the embed know about Loop at all was a `loop=1&playlist=…` pair in the
 * URL — which is part of `frameKey`, so every toggle would have thrown the frame
 * away, refetched the embed document and restarted the video from a cold buffer
 * (exactly the cost item 8.1 exists to avoid).
 *
 * This check asserts what the item now guarantees, in jsdom with the API
 * answered from fixtures and the frame simulated:
 *
 *   channel   the setting is delivered as a `setLoop` command on the jsapi
 *             channel, and it is delivered on the player's first message back
 *             (a command posted to a player that is not ready is dropped)
 *   url       nothing about Loop is in the embed URL: no `loop=`, no `playlist=`
 *   toggle    switching Loop in Settings reaches the live player at once, and
 *             the frame is not rebuilt — same iframe, same src, same frameKey
 *   once      one post per change: further messages from the player, a reused
 *             frame, or the same setting again cost no post at all
 *   closed    a closed player forgets what it was told, and the next frame is
 *             told again; toggling with no player open posts nothing and throws
 *             nothing
 *   wrap      with Loop on, the end of a video wraps (seekTo 0, play); with Loop
 *             off it does not, and switching Loop off drops a wrap already armed
 *   same      the app looks exactly as it did: `#feed`, `#tabs`, `#sheet`, `.art`
 *             and `#pl` byte-identical, the stylesheet byte-identical, and the
 *             frame URL identical (this item adds no CSS and no markup)
 *
 * Usage:
 *   npm i jsdom                              # dev only, not shipped in the APK
 *   node tools/loop-setting-check.js [build.html] [previous-build.html]
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
};

function apiBody(url) {
  const u = new URL(url), p = u.pathname;
  if (p.endsWith('/videos')) return (u.searchParams.get('part') || '').includes('contentDetails') ? F.durations : F.videos;
  return {};
}

/* a page: fresh window and localStorage, a fetch that answers from the fixtures */
function open(file) {
  const HTML = fs.readFileSync(file, 'utf8');
  const env = { errors: [], rejects: [] };
  const mockFetch = async u => {
    u = String(u);
    return { ok: true, status: 200, json: async () => apiBody(u), headers: new Map() };
  };
  const dom = new JSDOM(HTML, {
    url: 'https://liquidtube.local/index.html',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(w) {
      w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
      w.fetch = mockFetch;
      w.scrollTo = () => {};
      w.console.log = () => {};
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
const boot = async file => {
  const env = open(file);
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
const tap = (env, el) => { if (!el) return false; el.dispatchEvent(new env.w.MouseEvent('click', { bubbles: true, cancelable: true })); return true; };

/* The player's timers are the only ones this tool needs to move (the 1.8 s wrap
   fallback and the 8.4 waits), so the clock is replaced with a queue the test
   fires by hand. Nothing here sleeps for 12 s, and nothing in the app is changed
   to make the test possible. */
function clock(env) {
  const w = env.w, timers = [];
  const realST = w.setTimeout, realCT = w.clearTimeout;
  w.setTimeout = (fn, ms) => { const t = { fn, ms, cancelled: false }; timers.push(t); return t; };
  w.clearTimeout = id => { if (id && typeof id === 'object') id.cancelled = true; };
  const isWrap = t => t.ms === 1800;
  return {
    timers,
    wraps: () => timers.filter(isWrap),
    pending: () => timers.filter(isWrap).filter(t => !t.cancelled),
    fire(t) { if (!t || t.cancelled) return false; t.cancelled = true; t.fn(); return true; },
    fireAll() { timers.filter(t => !t.cancelled).forEach(t => { t.cancelled = true; t.fn(); }); },
    restore() { w.setTimeout = realST; w.clearTimeout = realCT; },
  };
}

/* Every command the app posts into the frame's window, in order. The player is
   the only thing that receives these, so this is the channel itself. */
function spy(env) {
  const posts = [];
  const install = f => {
    if (!f || !f.contentWindow) return false;
    try {
      Object.defineProperty(f.contentWindow, 'postMessage', {
        configurable: true,
        value: d => { try { posts.push(JSON.parse(String(d))); } catch (e) { posts.push({ raw: String(d) }); } },
      });
      return true;
    } catch (e) { return false; }
  };
  return {
    posts,
    install,
    cmds: func => posts.filter(p => p && p.event === 'command' && p.func === func),
    clear() { posts.length = 0; },
  };
}

function msg(env, f, data) {
  env.w.dispatchEvent(new env.w.MessageEvent('message', {
    data: typeof data === 'string' ? data : JSON.stringify(data),
    origin: 'https://www.youtube-nocookie.com',
    source: f && f.contentWindow,
  }));
}

/* Boot, then open one video, with a spy on that frame's window. */
async function player(file, id) {
  const env = await boot(file);
  const c = clock(env);
  const s = spy(env);
  env.w.play(id);
  const f = frameIn(env);
  s.install(f);
  return { env, c, s, f };
}

/* Settings → Loop, through the app's own sheet, exactly as a finger would. */
function openSettings(env) {
  env.w.openLibrary();
  tap(env, env.d.querySelector('#shb [data-lib="settings"]'));
  return env.d.querySelector('#shb [data-opt="loop"]');
}

/* ---------- 1. the setting is delivered on the jsapi channel ---------- */
async function channel(file) {
  console.log('\n1. the setting reaches the player through the jsapi channel');
  const { env, c, s, f } = await player(file, vids[0]);
  ok('a play builds one frame', !!f);
  ok('nothing is posted into a frame that has not answered yet', s.cmds('setLoop').length === 0,
    JSON.stringify(s.posts));

  msg(env, f, { event: 'onReady' });
  const first = s.cmds('setLoop');
  ok('the player is told the setting as a setLoop command', first.length === 1, JSON.stringify(s.posts));
  ok('it is the app\'s own command envelope', first[0] && first[0].event === 'command' && Array.isArray(first[0].args),
    JSON.stringify(first[0]));
  ok('the default (Loop off) is sent as false', first[0] && first[0].args.length === 1 && first[0].args[0] === false,
    JSON.stringify(first[0] && first[0].args));
  ok('window.__ltLoop() is the loop table', typeof env.w.__ltLoop === 'function' && env.w.__ltLoop().sent === '0',
    JSON.stringify(env.w.__ltLoop()));
  ok('the frame is still on screen', frameIn(env) === f);
  c.restore();
}

/* ---------- 2. nothing about Loop is in the embed URL ---------- */
async function url(file) {
  console.log('\n2. the URL carries no loop parameter');
  const { env, c, s, f } = await player(file, vids[0]);
  const src = f.getAttribute('src');
  ok('no loop parameter', !/[?&]loop=/.test(src), src);
  ok('no playlist parameter', !/[?&]playlist=/.test(src), src);
  ok('the frame still asks for the jsapi channel', /[?&]enablejsapi=1/.test(src), src);
  ok('the video id is the one that was played', src.includes(vids[0]), src);
  msg(env, f, { event: 'onReady' });
  ok('delivering the setting does not touch the URL', f.getAttribute('src') === src);
  ok('and does not rebuild the frame', frameIn(env) === f && artOf(env).querySelectorAll('iframe').length === 1);
  ok('no seek, no play and no rebuild was needed', s.cmds('seekTo').length === 0 && s.cmds('playVideo').length === 0,
    JSON.stringify(s.posts));
  c.restore();
}

/* ---------- 3. the toggle reaches the live player at once ---------- */
async function toggle(file) {
  console.log('\n3. switching Loop with a video open');
  const { env, c, s, f } = await player(file, vids[0]);
  msg(env, f, { event: 'onReady' });
  const src = f.getAttribute('src');
  const before = s.cmds('setLoop').length;
  const b = openSettings(env);
  ok('the Settings sheet shows the Loop switch', !!b && b.getAttribute('data-opt') === 'loop');
  ok('it reads off, as the setting does', b && b.textContent === 'Loop: off', b && b.textContent);
  s.clear();
  tap(env, b);
  ok('the switch reads on', b.textContent === 'Loop: on', b.textContent);
  const on = s.cmds('setLoop');
  ok('the live player is told at once', on.length === 1 && on[0].args[0] === true, JSON.stringify(s.posts));
  ok('window.__ltLoop() records it', env.w.__ltLoop().sent === '1' && env.w.__ltLoop().setting === true,
    JSON.stringify(env.w.__ltLoop()));
  ok('the frame was not rebuilt', frameIn(env) === f && artOf(env).querySelectorAll('iframe').length === 1);
  ok('its URL did not change', frameIn(env).getAttribute('src') === src);
  ok('the video was not restarted to do it', s.cmds('seekTo').length === 0 && s.cmds('playVideo').length === 0,
    JSON.stringify(s.posts));
  ok('one post, on top of the one the frame already had', env.w.__ltLoop().posts === before + 1,
    env.w.__ltLoop().posts + ' vs ' + before);

  s.clear();
  tap(env, b);
  ok('switching it back off reads off', b.textContent === 'Loop: off', b.textContent);
  const off = s.cmds('setLoop');
  ok('and is delivered too', off.length === 1 && off[0].args[0] === false, JSON.stringify(s.posts));
  ok('still the same frame', frameIn(env) === f);
  c.restore();
}

/* ---------- 4. one post per change ---------- */
async function once(file) {
  console.log('\n4. nothing is posted twice');
  const { env, c, s, f } = await player(file, vids[0]);
  msg(env, f, { event: 'onReady' });
  ok('the first answer buys one post', s.cmds('setLoop').length === 1, JSON.stringify(s.posts));
  msg(env, f, { event: 'onReady' });
  msg(env, f, { event: 'infoDelivery', info: { currentTime: 4, duration: 750 } });
  msg(env, f, { event: 'onStateChange', info: 1 });
  msg(env, f, { event: 'onStateChange', info: 3 });
  ok('later messages buy none', s.cmds('setLoop').length === 1, JSON.stringify(s.cmds('setLoop')));
  ok('and the setting is still what was sent', env.w.__ltLoop().sent === '0');

  env.w.play(vids[0]);
  ok('the same video reuses the frame', frameIn(env) === f && artOf(env).querySelectorAll('iframe').length === 1);
  msg(env, f, { event: 'onReady' });
  ok('a reused frame is not told again', s.cmds('setLoop').length === 1, JSON.stringify(s.cmds('setLoop')));

  const b = openSettings(env);
  s.clear();
  tap(env, b); tap(env, b); tap(env, b);
  ok('three flips cost three posts, not four', s.cmds('setLoop').length === 3, JSON.stringify(s.cmds('setLoop')));
  ok('and the last one is the setting now', s.cmds('setLoop')[2].args[0] === true && env.w.__ltLoop().sent === '1',
    JSON.stringify(s.cmds('setLoop')));
  c.restore();
}

/* ---------- 5. a closed player, and no player at all ---------- */
async function closed(file) {
  console.log('\n5. what a closed player is told');
  const { env, c, s, f } = await player(file, vids[0]);
  msg(env, f, { event: 'onReady' });
  const b = openSettings(env);
  s.clear();
  tap(env, b);
  ok('Loop is on', env.w.__ltLoop().setting === true);
  env.w.closeAll();
  c.fireAll();                       /* the close is two ticks: pause, then the teardown (8.2) */
  ok('closing forgets what the frame was told', env.w.__ltLoop().sent === '', JSON.stringify(env.w.__ltLoop()));
  ok('the frame is gone', !frameIn(env));

  const s2 = spy(env);
  env.w.play(vids[0]);
  const f2 = frameIn(env);
  s2.install(f2);
  ok('the next play builds a new frame', !!f2 && f2 !== f);
  ok('nothing is posted to it before it answers', s2.cmds('setLoop').length === 0, JSON.stringify(s2.posts));
  msg(env, f2, { event: 'onReady' });
  const again = s2.cmds('setLoop');
  ok('the new frame is told the setting it is opened with', again.length === 1 && again[0].args[0] === true,
    JSON.stringify(s2.posts));
  c.restore();
}

async function noPlayer(file) {
  console.log('\n6. switching Loop with no video open');
  const env = await boot(file);
  const c = clock(env);
  const before = env.w.__ltLoop();
  ok('no player, nothing told', before.sent === '' && before.posts === 0, JSON.stringify(before));
  const b = openSettings(env);
  tap(env, b);
  ok('the setting still changes', env.w.__ltLoop().setting === true, JSON.stringify(env.w.__ltLoop()));
  ok('nothing is posted into nothing', env.w.__ltLoop().posts === 0, JSON.stringify(env.w.__ltLoop()));
  ok('the switch reads on', b.textContent === 'Loop: on', b.textContent);
  ok('no console error', env.errors.length === 0, env.errors.join(' | '));
  ok('no unhandled rejection', env.rejects.length === 0, env.rejects.map(String).join(' | '));
  c.restore();
}

/* ---------- 7. the wrap still runs off the player's own state ---------- */
async function wrap(file) {
  console.log('\n7. the end of a video');
  {
    const { env, c, s, f } = await player(file, vids[0]);
    msg(env, f, { event: 'onReady' });
    const b = openSettings(env);
    tap(env, b);                       /* Loop on */
    s.clear();
    msg(env, f, { event: 'onStateChange', info: 0 });
    const seek = s.cmds('seekTo');
    ok('the end wraps: seeked back to the start', seek.length === 1 && seek[0].args[0] === 0 && seek[0].args[1] === true,
      JSON.stringify(s.posts));
    ok('and played again', s.cmds('playVideo').length === 1, JSON.stringify(s.posts));
    ok('without rebuilding the frame', frameIn(env) === f);
    ok('the wrap fallback is armed', c.pending().length === 1 && c.pending()[0].ms === 1800,
      c.pending().map(t => t.ms).join(','));
    ok('the setting was not re-sent by the wrap', s.cmds('setLoop').length === 0, JSON.stringify(s.posts));
    c.restore();
  }
  {
    const { env, c, s, f } = await player(file, vids[0]);
    msg(env, f, { event: 'onReady' });
    s.clear();
    msg(env, f, { event: 'onStateChange', info: 0 });
    ok('with Loop off the end does not wrap', s.cmds('seekTo').length === 0 && s.cmds('playVideo').length === 0,
      JSON.stringify(s.posts));
    ok('and nothing is armed', c.pending().length === 0, c.pending().map(t => t.ms).join(','));
    ok('the frame is kept', frameIn(env) === f);
    c.restore();
  }
  {
    const { env, c, s, f } = await player(file, vids[0]);
    msg(env, f, { event: 'onReady' });
    const b = openSettings(env);
    tap(env, b);                       /* Loop on */
    msg(env, f, { event: 'onStateChange', info: 0 });
    ok('a wrap is on its way', c.pending().length === 1 && env.w.__ltLoop().guard === true);
    s.clear();
    tap(env, b);                       /* Loop off, inside the 1.8 s window */
    ok('switching Loop off drops it', env.w.__ltLoop().guard === false && c.pending().length === 0,
      c.pending().map(t => t.ms).join(','));
    c.fireAll();
    ok('no frame is rebuilt for a loop that was switched off', frameIn(env) === f,
      artOf(env).querySelectorAll('iframe').length + ' frames');
    ok('and the player is told', s.cmds('setLoop').length === 1 && s.cmds('setLoop')[0].args[0] === false,
      JSON.stringify(s.posts));
    c.restore();
  }
}

/* ---------- 8. nothing else moved ---------- */
async function same(file, prev) {
  console.log('\n8. nothing else moved');
  const A = await player(file, vids[2]);
  ok('no console error on the happy path', A.env.errors.length === 0, A.env.errors.join(' | '));
  ok('no unhandled rejection on the happy path', A.env.rejects.length === 0, A.env.rejects.map(String).join(' | '));
  A.c.restore();

  const src = fs.readFileSync(file, 'utf8');
  ok('the setting is one guarded post through cmdFrame',
    /if\(!cmdFrame\(f,'setLoop',\[on2\]\)\)return false;/.test(src));
  ok('the live player is told when the option is tapped', /if\(k==='loop'\)loopSync\(\)/.test(src));
  ok('the player is told when it first answers', /plAlive\(e\.source\);[\s\S]{0,200}loopSync\(\);/.test(src));
  ok('a closed frame forgets what it was told',
    /frameKey='';loopGuardOff\(\);plOff\(\);[\s\S]{0,160}loopKey='';/.test(src) &&
    /frameKey='';loopGuardOff\(\); {14}[\s\S]{0,120}loopKey='';/.test(src));
  const embed = (src.match(/box\.innerHTML=LDRABS\+'<iframe src="[\s\S]*?<\/iframe>';/) || [''])[0];
  ok('the embed URL is built without a loop parameter', embed.length > 0 && !/loop=/.test(embed) && !/playlist=/.test(embed),
    embed.slice(0, 160));
  ok('the frame key still holds only the id and captions', /function frameKeyOf\(id\)\{return id\+'\|'\+\(S\.opt\.cc\?'1':'0'\)\}/.test(src));

  if (!prev) { console.log('   (no previous build given: A/B skipped)'); return; }

  const env = await boot(file);
  const env2 = await boot(prev);
  ok('the feed is byte-identical', env.d.getElementById('feed').innerHTML === env2.d.getElementById('feed').innerHTML);
  ok('the tab strip is byte-identical', env.d.getElementById('tabs').innerHTML === env2.d.getElementById('tabs').innerHTML);
  ok('the sheet is byte-identical', env.d.getElementById('sheet').outerHTML === env2.d.getElementById('sheet').outerHTML);

  const cssOf = e => [...e.d.querySelectorAll('style')].map(s => s.textContent).join('\n');
  ok('the stylesheet is byte-identical', cssOf(env) === cssOf(env2));

  const play = async e => {
    const c = clock(e);
    e.w.play(vids[3]);
    const f = frameIn(e);
    const out = { art: artOf(e).innerHTML, pl: e.d.getElementById('pl').outerHTML, src: f && f.getAttribute('src') };
    c.restore();
    return out;
  };
  const x = await play(env);
  const y = await play(env2);
  ok('the frame\'s URL is identical', x.src === y.src, x.src + ' vs ' + y.src);
  ok('.art is byte-identical while a video loads', x.art === y.art);
  ok('the player panel is byte-identical', x.pl === y.pl);
  ok('the settings sheet is byte-identical', (() => {
    const h = e => { e.w.openLibrary(); return e.d.getElementById('shb').innerHTML; };
    return h(env) === h(env2);
  })());
  ok('the previous build has no loop table', typeof env2.w.__ltLoop === 'undefined');
}

(async () => {
  const file = process.argv[2] || path.join(__dirname, '..', 'app', 'assets', 'index.html');
  const prev = process.argv[3] || '';
  console.log('LiquidTube loop-setting check — ' + file);

  await channel(file);
  await url(file);
  await toggle(file);
  await once(file);
  await closed(file);
  await noPlayer(file);
  await wrap(file);
  await same(file, prev);

  console.log('');
  if (fails.length) {
    console.log('FAIL — ' + fails.length + ' failed, ' + pass + ' passed');
    fails.forEach(f => console.log('  · ' + f));
    process.exit(1);
  }
  console.log('PASS — ' + pass + ' assertions');
})();
