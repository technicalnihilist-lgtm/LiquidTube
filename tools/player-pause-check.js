#!/usr/bin/env node
/*
 * LiquidTube player-pause check — item 8.2 ("pause playback when the sheet
 * closes").
 *
 * Two ways the player lost the screen without being stopped:
 *
 *   close  Detaching the frame frees the media pipeline, but only once the
 *          `about:blank` navigation commits; until then the <video> inside the
 *          frame keeps its audio route, so a closed video could still be heard
 *          for a moment after the panel had gone.
 *   cover  The top-bar avatar and the dock sit above the player panel, so the
 *          library, Notifications and Create raised a sheet over a video that
 *          went on playing behind it — sound with nothing on screen to pause it,
 *          and the sheet's own close (`closeAll`) then destroyed the player the
 *          user could no longer see.
 *
 * The fix is to post `mute` + `pauseVideo` to the live frame in the same task as
 * the gesture, through the jsapi channel the player already answers on, and to
 * ask a reused frame to play again when the user plays into it. What this tool
 * measures, per build, in a real browser with the API mocked and the embed
 * served as a document that reports every command it receives:
 *
 *   boot     iframes and commands at rest
 *   open     one play: one iframe, no pause asked of it
 *   cover    a sheet over the open player: the player is still mounted (the
 *            feature is not removed) and the frame was told to mute and pause
 *   close    the sheet's own close (scrim): no iframe left, and the pause went
 *            out before the embed was unloaded
 *   button   the player's Close button: same, in the same task as the tap
 *   replay   the same video played again from a card in that sheet: the frame is
 *            reused, re-fetched zero times, and told to unmute and play
 *   loop     Loop still wraps through the jsapi channel with the frame kept
 *   end      iframes, child frames and page errors after the whole run
 *
 * Usage:
 *   npm i puppeteer-core                    # dev only, not shipped in the APK
 *   CHROME=/path/to/chrome node tools/player-pause-check.js <build-a.html> [build-b.html]
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

/* The embed, served as a real page. It holds a <video> like the real player,
   answers the jsapi commands it is sent and reports each one to the parent, so
   "the player was paused" is measured at the player, not at the app's intent. */
const EMBED_HTML = `<!doctype html><html><body><video id="v" muted playsinline></video>
<script>
  var playing=false;
  var say=function(m){try{parent.postMessage('LTEMBED:'+m,'*')}catch(e){}};
  addEventListener('message',function(e){
    var d=e.data;
    if(typeof d==='string'){try{d=JSON.parse(d)}catch(x){return}}
    if(!d||d.event!=='command')return;
    if(d.func==='playVideo')playing=true;
    if(d.func==='pauseVideo')playing=false;
    say('cmd:'+d.func);
    say('state:'+(playing?'playing':'paused'));
  });
  addEventListener('pagehide',function(){say('pagehide')});
  say('ready');
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
  const state = () =>
    ev(() => ({
      iframes: document.querySelectorAll('#pl .art iframe').length,
      plOn: document.getElementById('pl').classList.contains('on'),
      sheetOn: document.getElementById('sheet').classList.contains('on'),
      embed: (window.__ltEmbed || []).slice(),
    }));


  /* ---- boot ---- */
  out.boot = { iframes: (await state()).iframes, embed: (await log()).slice() };

  /* ---- open: nothing is paused while the player is on screen ---- */
  await playCard(0);
  await sleep(500);
  const opened = await state();
  out.open = {
    iframes: opened.iframes,
    plOn: opened.plOn,
    pauseAsked: opened.embed.filter(m => m === 'cmd:pauseVideo').length,
    state: opened.embed.filter(m => m.indexOf('state:') === 0).slice(-1)[0] || null,
  };

  /* ---- cover: a sheet over the open player ---- */
  await ev(() => document.querySelector('[data-do="you"]').click());
  await sleep(300);
  const covered = await state();
  out.cover = {
    sheetOn: covered.sheetOn,
    plOn: covered.plOn,
    iframes: covered.iframes,
    muted: covered.embed.filter(m => m === 'cmd:mute').length,
    paused: covered.embed.filter(m => m === 'cmd:pauseVideo').length,
    state: covered.embed.filter(m => m.indexOf('state:') === 0).slice(-1)[0] || null,
    unloaded: covered.embed.filter(m => m === 'pagehide' || m === 'unload').length,
  };

  /* ---- close: the sheet's own close takes the player down, silent ---- */
  const beforeScrim = (await log()).length;
  await ev(() => document.getElementById('scrim').click());
  await sleep(400);
  const closed = await state();
  out.close = {
    plOn: closed.plOn,
    sheetOn: closed.sheetOn,
    iframes: closed.iframes,
    after: closed.embed.slice(beforeScrim),
    pausedBeforeUnload:
      closed.embed.slice(beforeScrim).indexOf('cmd:pauseVideo') !== -1 &&
      closed.embed.slice(beforeScrim).indexOf('cmd:pauseVideo') < closed.embed.slice(beforeScrim).indexOf('pagehide'),
    mutedBeforeUnload:
      closed.embed.slice(beforeScrim).indexOf('cmd:mute') !== -1 &&
      closed.embed.slice(beforeScrim).indexOf('cmd:mute') < closed.embed.slice(beforeScrim).indexOf('pagehide'),
  };

  /* ---- button: the player's own Close ---- */
  await playCard(1);
  await sleep(500);
  const beforeBtn = (await log()).length;
  await ev(() => document.getElementById('pclose').click());
  await sleep(400);
  const btnClosed = await state();
  out.button = {
    iframes: btnClosed.iframes,
    plOn: btnClosed.plOn,
    after: btnClosed.embed.slice(beforeBtn),
    pausedBeforeUnload:
      btnClosed.embed.slice(beforeBtn).indexOf('cmd:pauseVideo') !== -1 &&
      btnClosed.embed.slice(beforeBtn).indexOf('cmd:pauseVideo') < btnClosed.embed.slice(beforeBtn).indexOf('pagehide'),
  };

  /* ---- replay: the same video played again from a card in the sheet ---- */
  await playCard(2);
  await sleep(500);
  const fetchesBefore = fetches();
  const replayStep = await ev(() => {
    const before = document.querySelector('#pl .art iframe');
    if (before) before.__ltMark = 'replay';
    const openId = before ? (before.src.match(/\/embed\/([^?]+)/) || [])[1] : null;
    document.querySelector('[data-do="you"]').click();
    document.querySelector('[data-lib="hist"]').click();
    const at = (window.__ltEmbed || []).length;
    const card = document.querySelector('#shb [data-v]');
    window.__ltReplayAt = at;
    window.__ltReplayCard = card && card.getAttribute('data-v') === openId;
    if (card) card.click();
    const after = document.querySelector('#pl .art iframe');
    return {
      cardFound: !!card,
      cardIsOpenVideo: !!window.__ltReplayCard,
      reused: !!before && before === after && after.__ltMark === 'replay',
      iframes: document.querySelectorAll('#pl .art iframe').length,
      plOn: document.getElementById('pl').classList.contains('on'),
      sheetOn: document.getElementById('sheet').classList.contains('on'),
    };
  });
  await sleep(400);                             /* the frame answers on its own task */
  out.replay = replayStep;
  out.replay.after = await ev(() => (window.__ltEmbed || []).slice(window.__ltReplayAt));
  out.replay.embedFetches = fetches() - fetchesBefore;

  /* ---- loop: a wrap still goes through the jsapi channel ---- */
  await ev(() => {
    document.querySelector('[data-do="you"]').click();
    document.querySelector('[data-lib="settings"]').click();
    document.querySelector('[data-opt="loop"]').click();
    document.getElementById('scrim').click();
  });
  await sleep(200);
  await playCard(3);
  await sleep(400);
  out.loop = await ev(() => {
    const first = document.querySelector('#pl .art iframe');
    const cmds = [];
    if (first)
      Object.defineProperty(first, 'contentWindow', {
        configurable: true,
        get: () => ({ postMessage: m => cmds.push(String(m)) }),
      });
    const say = info =>
      window.dispatchEvent(
        new MessageEvent('message', {
          origin: 'https://www.youtube-nocookie.com',
          data: JSON.stringify({ event: 'onStateChange', info: info }),
        })
      );
    say(0);                                     /* the video ended */
    const afterWrap = document.querySelector('#pl .art iframe');
    const r = {
      reused: !!first && first === afterWrap,
      iframes: document.querySelectorAll('#pl .art iframe').length,
      funcs: cmds.filter(m => m.indexOf('"command"') !== -1).map(m => JSON.parse(m).func),
    };
    say(1);                                     /* running again */
    return r;
  });
  await sleep(2100);                            /* past the fallback window */
  out.loop.iframesAfterWindow = await ev(() => document.querySelectorAll('#pl .art iframe').length);
  /* Loop back off, so the build is left as it was found. */
  await ev(() => {
    document.getElementById('pclose').click();
    document.querySelector('[data-do="you"]').click();
    document.querySelector('[data-lib="settings"]').click();
    document.querySelector('[data-opt="loop"]').click();
    document.getElementById('scrim').click();
  });
  await sleep(300);

  /* ---- end ---- */
  const end = await state();
  out.end = {
    iframes: end.iframes,
    childFrames: await childFrames(page),
    plOn: end.plOn,
    sheetOn: end.sheetOn,
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
  ok(o.boot.iframes === 0, 'boot: no iframe at rest');
  ok(o.open.iframes === 1, 'open: one iframe for one play');
  ok(o.open.pauseAsked === 0, 'open: a playing video is not paused by the app');
  ok(o.cover.sheetOn && o.cover.plOn, 'cover: the sheet opens over the player and the player stays mounted');
  ok(o.cover.iframes === 1, 'cover: the frame is still there');
  ok(o.cover.muted >= 1 && o.cover.paused >= 1, 'cover: the covered player was told to mute and pause');
  ok(o.cover.state === 'state:paused', 'cover: the player itself reports paused');
  ok(o.cover.unloaded === 0, 'cover: the frame was not torn down by a sheet');
  ok(!o.close.plOn && !o.close.sheetOn, 'close: the sheet close closes both surfaces');
  ok(o.close.iframes === 0, 'close: no iframe left behind');
  ok(o.close.pausedBeforeUnload && o.close.mutedBeforeUnload, 'close: the player was muted and paused before the embed was unloaded');
  ok(o.button.iframes === 0, 'button: no iframe left behind');
  ok(o.button.pausedBeforeUnload, 'button: the player was paused before the embed was unloaded');
  ok(o.replay.cardFound && o.replay.cardIsOpenVideo, 'replay: the open video is in the library list');
  ok(o.replay.reused, 'replay: the same frame is reused');
  ok(o.replay.iframes === 1, 'replay: one iframe');
  ok(o.replay.embedFetches === 0, 'replay: the embed was not fetched again');
  ok(o.replay.after.includes('cmd:playVideo'), 'replay: the reused frame was told to play');
  ok(o.replay.after.includes('state:playing'), 'replay: the player itself reports playing');
  ok(o.loop.reused, 'loop: a wrap keeps the frame');
  ok(o.loop.funcs.includes('seekTo') && o.loop.funcs.includes('playVideo'), 'loop: the wrap seeks to 0 and plays');
  ok(o.loop.iframesAfterWindow === 1, 'loop: the frame is not replaced after the fallback window');
  ok(o.end.iframes === 0 && o.end.childFrames === 0, 'end: nothing left behind');
  ok(o.end.errors.length === 0, 'end: no page errors');
  return fails;
}

(async () => {
  const files = process.argv.slice(2).filter(a => !a.startsWith('-'));
  if (!files.length) {
    console.error('usage: CHROME=/path/to/chrome node tools/player-pause-check.js <build.html> [old.html]');
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
  for (const r of results) console.log(JSON.stringify(r));
  if (results.length > 1) {
    const [a, b] = results;
    console.log(
      JSON.stringify({
        compare: {
          'a=under test': a.file,
          'b=previous': b.file,
          pauseOnCover: [a.cover.paused, b.cover.paused],
          pauseOnClose: [idx2(a.close.after, 'cmd:pauseVideo'), idx2(b.close.after, 'cmd:pauseVideo')],
          replayPlayAsked: [a.replay.after.includes('cmd:playVideo'), b.replay.after.includes('cmd:playVideo')],
        },
      })
    );
  }
  const fails = judge(results[0]);
  if (fails.length) {
    console.error('FAIL\n  ' + fails.join('\n  '));
    process.exit(1);
  }
  console.log('PASS — ' + fails.length + ' failures');
})();

function idx2(arr, v) {
  return (arr || []).indexOf(v);
}
