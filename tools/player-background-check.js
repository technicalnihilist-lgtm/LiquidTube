#!/usr/bin/env node
/*
 * LiquidTube player-background check — item 8.10 ("free the player when the app
 * goes to background").
 *
 * A paused WebView stops painting but not decoding: a player left open when the
 * user switched apps kept its embed document, its <video>, its decoder, its
 * buffers and its audio route for as long as the app stayed away. The fix is to
 * give the frame back on the way out and rebuild it on the way in — same video,
 * same position, playing only if it was playing.
 *
 * What this tool measures, per build, in a real browser with the API mocked and
 * the embed served as a document that honours `autoplay`, `start` and the jsapi
 * commands it is sent:
 *
 *   boot      no iframe at rest, and a free asked for with nothing open is a
 *             no-op (the panel is not even mounted)
 *   open      one play: one iframe, autoplay=1, no start, the player playing
 *   free      background while playing: the frame is gone, the panel is still
 *             open, the video that was playing is remembered, and the position
 *             it had reached is in storage
 *   restore   the way back: one new iframe at that position, autoplay=1, told to
 *             play, and the player reports playing again
 *   paused    background while paused: remembered as paused
 *   restore2  the way back for that one: autoplay=0 at the same position, no
 *             play command — a rebuild must not turn a pause into a play
 *   hidden    the page's own `visibilitychange` does the same thing (the
 *             fallback a browser and a WebView both have)
 *   fullscreen the one case where the document goes hidden with the app still
 *             in front: the free is refused while `__ltFs` is up
 *   sheet     a sheet over the player: freed, and left free on the way back
 *             instead of being re-fetched for a surface nobody can see
 *   end       no iframe, no child frame and no page error after the whole run
 *
 * Usage:
 *   npm i puppeteer-core                    # dev only, not shipped in the APK
 *   CHROME=/path/to/chrome node tools/player-background-check.js <build-a.html> [build-b.html]
 * Prints one JSON object per build; with two builds it also compares them.
 * Exit code 1 when the build under test — the first file — fails any check.
 */
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const ORIGIN = 'liquidtube.local';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64'
);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const pad = n => String(n).padStart(2, '0');
const vids = Array.from({ length: 24 }, (_, i) => 'v' + pad(i + 1) + 'AAAAAAAA');
const CH = Array.from({ length: 6 }, (_, i) => 'UC' + i + 'xxxxxxxxxxxxxxxxxxxx');
const ago = h => new Date(Date.now() - h * 36e5).toISOString();

/* The embed, served as a real page. It honours the URL it was given — autoplay
   starts it, `start` is where its clock begins — and answers the jsapi commands
   it is sent, so "the video came back playing" and "it came back at 42 s" are
   measured at the player, not at the app's intent. Every command and state is
   reported to the parent as `LTEMBED:`. */
const EMBED_HTML = `<!doctype html><html><body><video id="v" muted playsinline></video>
<script>
  var playing=false, t=0, dur=600;
  var say=function(m){try{parent.postMessage('LTEMBED:'+m,'*')}catch(e){}};
  var js=function(o){try{parent.postMessage(JSON.stringify(o),'*')}catch(e){}};
  var url=new URL(location.href);
  var auto=url.searchParams.get('autoplay')==='1';
  t=+(url.searchParams.get('start')||0);
  var clock=function(){
    js({event:'onStateChange',info:playing?1:2});
    js({event:'infoDelivery',info:{currentTime:t,duration:dur,playerState:playing?1:2}});
  };
  addEventListener('message',function(e){
    var d=e.data;
    if(typeof d==='string'){try{d=JSON.parse(d)}catch(x){return}}
    if(!d)return;
    if(d.event==='listening'){say('ready');clock();return}
    if(d.event!=='command')return;
    if(d.func==='playVideo')playing=true;
    if(d.func==='pauseVideo')playing=false;
    if(d.func==='seekTo'){t=+(d.args&&d.args[0])||0}
    say('cmd:'+d.func);
    say('state:'+(playing?'playing':'paused'));
    clock();
  });
  addEventListener('pagehide',function(){say('pagehide')});
  if(auto)playing=true;
  say('autoplay:'+(auto?'1':'0'));
  say('start:'+t);
  setTimeout(clock,20);
</script></body></html>`;

const TRENDING = {
  items: vids.map((id, i) => ({
    id,
    snippet: {
      title: 'Video ' + i,
      channelTitle: 'Channel ' + (i % 6),
      channelId: CH[i % 6],
      publishedAt: ago(i + 1),
      categoryId: ['10', '20', '17', '24', '23', '27'][i % 6],
      thumbnails: { maxres: { url: 'https://i.ytimg.com/vi/' + id + '/maxresdefault.jpg' } },
    },
    statistics: { viewCount: '1000' },
  })),
};
function durationsFor(u) {
  const ids = String(u.searchParams.get('id') || '').split(',').filter(Boolean);
  return { items: ids.map(id => ({ id, contentDetails: { duration: 'PT12M30S' } })) };
}
function chanAnswer(u) {
  const want = String(u.searchParams.get('id') || '').split(',').filter(Boolean);
  return {
    items: want.map(id => ({
      id,
      snippet: {
        title: 'Channel ' + id.slice(2, 8),
        customUrl: 'c' + id.slice(2, 8),
        publishedAt: '2015-04-02T10:00:00Z',
        country: 'IN',
        thumbnails: { medium: { url: 'https://yt3.ggpht.com/' + id + '.jpg' } },
      },
      statistics: { subscriberCount: '1000', videoCount: '10', viewCount: '10000' },
      contentDetails: { relatedPlaylists: { uploads: 'UU' + id.slice(2) } },
      brandingSettings: { image: {}, channel: {} },
    })),
  };
}
function apiBody(url) {
  const u = new URL(url);
  const p = u.pathname;
  if (p.endsWith('/videos'))
    return (u.searchParams.get('part') || '').includes('contentDetails') ? durationsFor(u) : TRENDING;
  if (p.endsWith('/channels')) return chanAnswer(u);
  if (p.endsWith('/playlistItems'))
    return { items: vids.slice(0, 12).map((id, i) => ({ snippet: { title: 'P' + i, resourceId: { videoId: id }, publishedAt: ago(i * 24) }, contentDetails: { videoPublishedAt: ago(i * 24) } })) };
  return {};
}

async function childFrames(page) {
  const s = await page.target().createCDPSession();
  try {
    const { frameTree } = await s.send('Page.getFrameTree');
    return (frameTree.childFrames || []).length;
  } finally {
    await s.detach();
  }
}

async function boot(browser, file) {
  const page = await browser.newPage();
  const errors = [];
  let embedFetches = 0;
  page.on('pageerror', e => errors.push(String(e.message || e)));
  page.on('console', m => {
    if (m.type() === 'error' && !/ytimg|ggpht|net::ERR|youtube-nocookie|about:blank/.test(m.text())) errors.push(m.text());
  });
  await page.setRequestInterception(true);
  page.on('request', req => {
    const u = req.url();
    if (u.startsWith('https://' + ORIGIN + '/index.html') || u === 'https://' + ORIGIN + '/')
      return req.respond({ status: 200, contentType: 'text/html', body: fs.readFileSync(file) });
    if (/youtube-nocookie\.com\/embed\//.test(u)) {
      embedFetches++;
      return req.respond({ status: 200, contentType: 'text/html', body: EMBED_HTML });
    }
    if (/googleapis\.com\/(youtube\/v3|youtubei)/.test(u))
      return req.respond({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify(apiBody(u)),
      });
    if (/ytimg\.com|ggpht\.com|googleusercontent\.com/.test(u)) return req.respond({ status: 200, contentType: 'image/png', body: PNG });
    return req.abort();
  });
  await page.goto('https://' + ORIGIN + '/index.html', { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction('document.querySelectorAll("#feed .card").length > 0', { timeout: 60000 });
  await page.evaluate(() => {
    window.__ltEmbed = [];
    window.addEventListener('message', e => {
      const d = e.data;
      if (typeof d === 'string' && d.indexOf('LTEMBED:') === 0) window.__ltEmbed.push(d.slice(8));
    });
    /* The page's own view of visibility, so the browser path can be driven from
       the test the way a backgrounded tab drives it. */
    window.__simHidden = false;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.__simHidden });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (window.__simHidden ? 'hidden' : 'visible') });
    window.__setHidden = v => {
      window.__simHidden = !!v;
      document.dispatchEvent(new Event('visibilitychange'));
    };
  });
  await sleep(800);
  await page.evaluate(() => {
    const st = document.createElement('style');
    st.textContent = '*{backdrop-filter:none!important;filter:none!important;box-shadow:none!important}';
    document.head.appendChild(st);
  });
  return { page, errors, fetches: () => embedFetches };
}

async function run(browser, file) {
  const { page, errors, fetches } = await boot(browser, file);
  const out = { file: path.basename(file) };
  const ev = (fn, ...a) => page.evaluate(fn, ...a);
  const playCard = i => ev(n => document.querySelectorAll('#feed .card')[n].click(), i);
  const log = () => ev(() => (window.__ltEmbed || []).slice());
  /* A build without the probe answers the same shape with nothing in it, so a
     baseline is judged and reported instead of crashing the run. */
  const bg = () =>
    ev(() =>
      window.__ltBg
        ? window.__ltBg()
        : { held: null, fs: false, frees: 0, restores: 0, skips: 0, playing: false, key: '' }
    );
  const frame = () =>
    ev(() => {
      const f = document.querySelector('#pl .art iframe');
      if (!f) return null;
      let u = null;
      try { u = new URL(f.src); } catch (e) {}
      return {
        id: u ? (u.pathname.match(/\/embed\/([^/?]+)/) || [])[1] : null,
        autoplay: u ? u.searchParams.get('autoplay') : null,
        start: u ? u.searchParams.get('start') : null,
        dupes: u ? u.searchParams.getAll('autoplay').length : 0,
      };
    });
  const state = () =>
    ev(() => ({
      iframes: document.querySelectorAll('#pl .art iframe').length,
      plOn: document.getElementById('pl').classList.contains('on'),
      sheetOn: document.getElementById('sheet').classList.contains('on'),
      embed: (window.__ltEmbed || []).slice(),
    }));
  /* The player's own last word on whether it is playing. */
  const lastState = async () => {
    const l = await log();
    const s = l.filter(m => m.indexOf('state:') === 0).slice(-1)[0];
    return s || null;
  };
  /* Move the player's clock to a known position, the way a real video would. */
  const seek = (t) =>
    ev(n => {
      const f = document.querySelector('#pl .art iframe');
      if (!f) return false;
      f.contentWindow.postMessage(JSON.stringify({ event: 'command', func: 'seekTo', args: [n, true] }), '*');
      return true;
    }, t);
  const sayPaused = () =>
    ev(() =>
      window.dispatchEvent(
        new MessageEvent('message', {
          origin: 'https://www.youtube-nocookie.com',
          data: JSON.stringify({ event: 'onStateChange', info: 2 }),
        })
      )
    );

  /* ---- boot ---- */
  out.boot = {
    iframes: (await state()).iframes,
    freeWithNothingOpen: await ev(() => !!(window.__ltBgFree && window.__ltBgFree(1))),
    hasProbe: await ev(() => !!window.__ltBg),
  };

  /* ---- open: a playing video ---- */
  await playCard(0);
  await sleep(600);
  const opened = await state();
  out.open = { iframes: opened.iframes, url: await frame(), state: await lastState(), bg: await bg() };

  /* ---- the video reaches 42 s, then the app goes away ---- */
  await seek(42);
  await sleep(300);
  /* The clock is held in memory until the frame goes, so this is the live
     position, and it is storage that is read again after the free. */
  out.open.live = await ev(() => (window.__ltResume ? (window.__ltResume().live || {}).t ?? null : null));

  /* What the app asks the frame on the way out. The frame is unloaded in the
     same task, so the pause cannot be *heard* by the embed — the unload is the
     stop — but the order the app asks in is what is checked here. */
  await ev(() => {
    const f = document.querySelector('#pl .art iframe');
    window.__ltOut = [];
    if (f)
      Object.defineProperty(f, 'contentWindow', {
        configurable: true,
        get: () => ({ postMessage: m => window.__ltOut.push(JSON.parse(String(m)).func) }),
      });
  });
  out.free = {
    freed: await ev(() => !!(window.__ltBgFree && window.__ltBgFree(1))),
    ...(await state()),
    bg: await bg(),
  };
  out.free.asked = await ev(() => (window.__ltOut || []).slice());
  out.free.pausedBeforeUnload = out.free.asked.indexOf('mute') !== -1 && out.free.asked.indexOf('pauseVideo') !== -1;
  out.free.stored = await ev(
    id => (window.__ltResume ? window.__ltResume().stored[id] ?? null : null),
    out.open.url && out.open.url.id
  );

  /* ---- the way back: the same video, at 42 s, playing ---- */
  const beforeRestore = (await log()).length;
  out.restore = {
    restored: await ev(() => !!(window.__ltBgRestore && window.__ltBgRestore(1))),
    ...(await state()),
  };
  await sleep(600);
  out.restore.url = await frame();
  out.restore.state = await lastState();
  out.restore.bg = await bg();
  out.restore.after = (await log()).slice(beforeRestore);
  out.restore.embedFetches = fetches();

  /* ---- a video the user paused before leaving comes back paused ---- */
  await sayPaused();
  await sleep(100);
  out.paused = { playingBeforeFree: (await bg()).playing, freed: await ev(() => !!(window.__ltBgFree && window.__ltBgFree(1))) };
  out.paused.remembered = (await bg()).held ? (await bg()).held.playing : null;
  const beforeRestore2 = (await log()).length;
  out.restore2 = { restored: await ev(() => !!(window.__ltBgRestore && window.__ltBgRestore(1))) };
  await sleep(600);
  out.restore2.url = await frame();
  out.restore2.state = await lastState();
  out.restore2.after = (await log()).slice(beforeRestore2);

  /* ---- the page's own visibilitychange does the same thing ---- */
  const freesBefore = (await bg()).frees;
  await ev(() => window.__setHidden(true));
  await sleep(200);
  out.hidden = { iframes: (await state()).iframes, frees: (await bg()).frees - freesBefore, bg: await bg() };
  await ev(() => window.__setHidden(false));
  await sleep(600);
  out.hidden.after = { iframes: (await state()).iframes, url: await frame() };

  /* ---- fullscreen: the document is hidden but the user is watching ---- */
  const freesBeforeFs = (await bg()).frees;
  await ev(() => window.__ltFs && window.__ltFs(1));
  await ev(() => window.__setHidden(true));
  await sleep(200);
  out.fullscreen = {
    iframes: (await state()).iframes,
    frees: (await bg()).frees - freesBeforeFs,
    freed: await ev(() => !!(window.__ltBgFree && window.__ltBgFree(1))),
    fs: (await bg()).fs,
  };
  await ev(() => window.__ltFs && window.__ltFs(0));
  await ev(() => window.__setHidden(false));
  await sleep(600);
  out.fullscreen.after = { iframes: (await state()).iframes };

  /* ---- a sheet over the player: freed, and left free on the way back ---- */
  await ev(() => document.querySelector('[data-do="you"]').click());
  await sleep(300);
  const skipsBefore = (await bg()).skips;
  out.sheet = {
    covered: (await state()).sheetOn,
    freed: await ev(() => !!(window.__ltBgFree && window.__ltBgFree(1))),
    iframesAfterFree: (await state()).iframes,
    restored: await ev(() => !!(window.__ltBgRestore && window.__ltBgRestore(1))),
    iframesAfterRestore: (await state()).iframes,
    skips: (await bg()).skips - skipsBefore,
  };
  await ev(() => document.getElementById('scrim').click());
  await sleep(400);
  out.sheet.afterClose = { iframes: (await state()).iframes, plOn: (await state()).plOn };

  /* ---- end ---- */
  const end = await state();
  out.end = {
    iframes: end.iframes,
    childFrames: await childFrames(page),
    plOn: end.plOn,
    sheetOn: end.sheetOn,
    bg: await bg(),
    errors: errors.slice(0, 8),
  };
  await page.close();
  return out;
}

function judge(o) {
  const fails = [];
  const ok = (c, m) => {
    if (!c) fails.push(m);
  };
  ok(o.boot.iframes === 0, 'boot: an iframe exists before any play');
  ok(o.boot.hasProbe, 'boot: window.__ltBg is missing (the background free is not in this build)');
  ok(o.boot.freeWithNothingOpen === false, 'boot: a free with no player open did something');
  ok(o.open.iframes === 1, 'open: not exactly one frame');
  ok(o.open.url && o.open.url.autoplay === '1', 'open: the first play is not autoplay=1');
  ok(o.open.url && o.open.url.start === null, 'open: a never-opened video was given a start');
  ok(o.open.live === 42, 'open: the position the player reported was not held');
  ok(o.free.stored === 42, 'free: the position the player had reached was not kept');
  ok(o.free.freed === true, 'free: the player was not freed on the way out');
  ok(o.free.iframes === 0, 'free: the frame is still there');
  ok(o.free.plOn === true, 'free: the player panel was closed instead of kept');
  ok(o.free.bg && o.free.bg.held && o.free.bg.held.playing === true, 'free: a playing video was not remembered as playing');
  ok(o.free.pausedBeforeUnload, 'free: the frame was unloaded without the player being asked to pause');
  ok(o.restore.restored === true, 'restore: the player was not rebuilt on the way back');
  ok(o.restore.iframes === 1, 'restore: not exactly one frame');
  ok(o.restore.url && o.restore.url.start === '42', 'restore: the frame did not open at the stored position');
  ok(o.restore.url && o.restore.url.autoplay === '1', 'restore: a video that was playing did not come back playing');
  ok(o.restore.url && o.restore.url.dupes === 1, 'restore: autoplay is written more than once in the URL');
  ok(o.restore.after.includes('cmd:playVideo'), 'restore: the rebuilt frame was never told to play');
  ok(o.restore.state === 'state:playing', 'restore: the player itself does not report playing');
  ok(o.paused.playingBeforeFree === false, 'paused: the player did not report itself paused');
  ok(o.paused.remembered === false, 'paused: a paused video was remembered as playing');
  ok(o.restore2.restored === true, 'restore2: the player was not rebuilt');
  ok(o.restore2.url && o.restore2.url.autoplay === '0', 'restore2: a paused video came back with autoplay=1');
  ok(o.restore2.url && o.restore2.url.start === '42', 'restore2: the frame did not open at the stored position');
  ok(!o.restore2.after.includes('cmd:playVideo'), 'restore2: a paused video was told to play');
  ok(o.restore2.state === 'state:paused', 'restore2: the player reports playing after a paused restore');
  ok(o.hidden.iframes === 0 && o.hidden.frees === 1, 'hidden: visibilitychange did not free the player');
  ok(o.hidden.after.iframes === 1, 'hidden: visibilitychange did not rebuild the player');
  ok(o.fullscreen.iframes === 1, 'fullscreen: the player was freed under a fullscreen video');
  ok(o.fullscreen.frees === 0 && o.fullscreen.freed === false, 'fullscreen: the free was not refused');
  ok(o.fullscreen.after.iframes === 1, 'fullscreen: the player did not survive fullscreen');
  ok(o.sheet.covered === true, 'sheet: the sheet did not open over the player');
  ok(o.sheet.freed === true && o.sheet.iframesAfterFree === 0, 'sheet: a covered player was not freed');
  ok(o.sheet.restored === false && o.sheet.iframesAfterRestore === 0, 'sheet: a covered player was re-fetched on the way back');
  ok(o.sheet.skips === 1, 'sheet: the skip was not counted');
  ok(o.sheet.afterClose.iframes === 0 && o.sheet.afterClose.plOn === false, 'sheet: the sheet close left the player behind');
  ok(o.end.iframes === 0 && o.end.childFrames === 0, 'end: something was left behind');
  ok(o.end.errors.length === 0, 'end: page errors');
  return fails;
}

(async () => {
  const files = process.argv.slice(2).filter(a => !a.startsWith('-'));
  if (!files.length) {
    console.error('usage: CHROME=/path/to/chrome node tools/player-background-check.js <build.html> [old.html]');
    process.exit(2);
  }
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME || undefined,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'],
  });
  const results = [];
  try {
    for (const f of files) results.push(await run(browser, f));
  } finally {
    await browser.close();
  }
  for (const r of results) {
    r.fails = judge(r);
    r.pass = r.fails.length === 0;
    console.log(JSON.stringify(r));
  }
  if (results.length > 1) {
    const [a, b] = results;
    console.log(
      JSON.stringify({
        compare: {
          underTest: a.file,
          baseline: b.file,
          iframesAtRest: [a.boot.iframes, b.boot.iframes],
          freedOnBackground: [a.free.iframes, b.free.iframes],
          restoredOnReturn: [a.restore.iframes, b.restore.iframes],
          pausedComesBackPaused: [a.restore2.url && a.restore2.url.autoplay, b.restore2.url && b.restore2.url.autoplay],
          fullscreenSurvives: [a.fullscreen.after.iframes, b.fullscreen.after.iframes],
        },
      })
    );
  }
  if (!results[0].pass) process.exit(1);
})().catch(e => {
  console.error(e);
  process.exit(2);
});
