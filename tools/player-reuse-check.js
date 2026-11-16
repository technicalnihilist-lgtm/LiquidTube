#!/usr/bin/env node
/*
 * LiquidTube player-reuse check — item 8.1 ("destroy and recreate the iframe
 * only when the video actually changes").
 *
 * `mount()` used to rebuild the player's iframe on every call. Two of those
 * calls did not change the video: a play of the video that was already open, and
 * — the one that happens for anyone with Loop on — the wrap at the end of every
 * video. Each rebuild re-fetches the embed document, re-initialises the player
 * and restarts playback from a cold buffer, which is a visible stall on the wrap
 * and a lost position on a re-play.
 *
 * The fix keys the live frame by the video id plus the embed options baked into
 * its URL. A play whose key matches keeps the frame and only rewires the
 * listeners; a loop wrap restarts it through the jsapi channel (`seekTo 0`,
 * `playVideo`) with a fallback timer that rebuilds the frame if the player never
 * answers, so Loop still wraps whatever the embed does.
 *
 * What this tool measures, per build, on a real browser with the API mocked and
 * the embed served as a real document that reports its own load:
 *
 *   boot      iframes in the player at rest
 *   first     one play: one iframe, the embed document loaded once
 *   same      the same video played again into the open player: the same iframe
 *             element, not navigated off the embed, and the embed document NOT
 *             re-fetched (no second `ready`)
 *   other     a different video: a new iframe, and the old one sent to
 *             `about:blank` first (that is item 4.4 still holding)
 *   loopKept  a loop wrap with a frame that answers: same element, the restart
 *             commands posted, and no rebuild after the fallback window
 *   loopFall  a loop wrap with a frame that never answers: same element at the
 *             wrap, then exactly one replacement after the fallback window —
 *             Loop still wraps
 *   close     the player holds no frame, and no child frame survives
 *
 * Usage:
 *   npm i puppeteer-core                    # dev only, not shipped in the APK
 *   CHROME=/path/to/chrome node tools/player-reuse-check.js <build-a.html> [build-b.html]
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

/* The embed, served as a real page so its load can be counted. It posts `ready`
   once per document, which is exactly what a rebuild costs and a reuse does not. */
const EMBED_HTML = `<!doctype html><html><body><video id="v" muted playsinline></video>
<script>
  var say=function(m){try{parent.postMessage('LTEMBED:'+m,'*')}catch(e){}};
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
    return {
      items: vids.slice(0, 12).map((id, i) => ({
        snippet: { title: 'P' + i, resourceId: { videoId: id }, publishedAt: ago(i * 24) },
        contentDetails: { videoPublishedAt: ago(i * 24) },
      })),
    };
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
  page.on('pageerror', e => errors.push(String(e.message || e)));
  page.on('console', m => {
    if (m.type() === 'error' && !/ytimg|ggpht|net::ERR|youtube-nocookie|about:blank/.test(m.text()))
      errors.push(m.text());
  });
  await page.setRequestInterception(true);
  page.on('request', req => {
    const u = req.url();
    if (u.startsWith('https://' + ORIGIN + '/index.html') || u === 'https://' + ORIGIN + '/')
      return req.respond({ status: 200, contentType: 'text/html', body: fs.readFileSync(file) });
    if (/youtube-nocookie\.com\/embed\//.test(u)) return req.respond({ status: 200, contentType: 'text/html', body: EMBED_HTML });
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
  return { page, errors };
}

async function run(browser, file) {
  const { page, errors } = await boot(browser, file);
  const out = { file: path.basename(file) };
  const ev = (fn, ...a) => page.evaluate(fn, ...a);
  const state = () =>
    ev(() => ({
      iframes: document.querySelectorAll('#pl .art iframe').length,
      ready: (window.__ltEmbed || []).filter(m => m === 'ready').length,
      src: (document.querySelector('#pl .art iframe') || {}).src || '',
    }));

  /* ---- boot ---- */
  out.boot = await state();

  /* ---- one play ---- */
  await ev(() => document.querySelectorAll('#feed .card')[0].click());
  await sleep(400);
  out.first = await state();
  out.first.childFrames = await childFrames(page);

  /* ---- the same video again, player open ---- */
  /* The card is clicked again, which runs the app's own play path with the id it
     is already showing. Nothing about the video changed, so nothing about the
     frame may change either: same element, not navigated off the embed, and the
     embed document not fetched a second time. */
  out.same = await ev(async () => {
    const art = document.querySelector('#pl .art');
    const first = document.querySelector('#pl .art iframe');
    const seen = [];
    const mo = new MutationObserver(ms => {
      for (const m of ms) if (m.type === 'attributes' && m.attributeName === 'src') seen.push(m.target.getAttribute('src'));
    });
    mo.observe(art, { subtree: true, attributes: true, attributeFilter: ['src'] });
    const readyBefore = (window.__ltEmbed || []).filter(m => m === 'ready').length;
    document.querySelectorAll('#feed .card')[0].click();
    for (const m of mo.takeRecords()) if (m.type === 'attributes' && m.attributeName === 'src') seen.push(m.target.getAttribute('src'));
    mo.disconnect();
    const second = document.querySelector('#pl .art iframe');
    return {
      reused: !!first && first === second,
      iframes: document.querySelectorAll('#pl .art iframe').length,
      srcWrites: seen,
      readyDelta: (window.__ltEmbed || []).filter(m => m === 'ready').length - readyBefore,
      playerOn: document.getElementById('pl').classList.contains('on'),
      loaderInArt: !!art.querySelector('.ldr'),
    };
  });
  await sleep(300);
  out.same.readyAfter = (await state()).ready;

  /* ---- a different video ---- */
  out.other = await ev(() => {
    const art = document.querySelector('#pl .art');
    const first = document.querySelector('#pl .art iframe');
    const seen = [];
    const mo = new MutationObserver(ms => {
      for (const m of ms) if (m.type === 'attributes' && m.attributeName === 'src') seen.push(m.target.getAttribute('src'));
    });
    mo.observe(art, { subtree: true, attributes: true, attributeFilter: ['src'] });
    document.querySelectorAll('#feed .card')[1].click();
    for (const m of mo.takeRecords()) if (m.type === 'attributes' && m.attributeName === 'src') seen.push(m.target.getAttribute('src'));
    mo.disconnect();
    const second = document.querySelector('#pl .art iframe');
    return {
      replaced: !!first && !!second && first !== second,
      blanked: seen.filter(s => s === 'about:blank').length,
      iframes: document.querySelectorAll('#pl .art iframe').length,
      src: second ? second.getAttribute('src') : '',
    };
  });
  await sleep(300);
  await ev(() => document.getElementById('pclose').click());
  await sleep(300);

  /* ---- Loop: a wrap with a frame that answers ---- */
  await ev(() => {
    document.querySelector('[data-do="you"]').click();
    document.querySelector('[data-lib="settings"]').click();
    document.querySelector('[data-opt="loop"]').click();
    document.getElementById('scrim').click();
  });
  await sleep(200);
  out.loopKept = await ev(() => {
    document.querySelectorAll('#feed .card')[0].click();
    const first = document.querySelector('#pl .art iframe');
    const cmds = [];
    /* The wrap is a message to the frame, so the frame's `contentWindow` is
       replaced with a recorder for this step and every command the app posts is
       kept. A real player answers with a state change, which is dispatched below
       through the same bridge the app listens on. */
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
    const readyBefore = (window.__ltEmbed || []).filter(m => m === 'ready').length;
    say(0);                                     /* the video ended */
    const afterWrap = document.querySelector('#pl .art iframe');
    const r = {
      reused: !!first && first === afterWrap,
      iframes: document.querySelectorAll('#pl .art iframe').length,
      cmds: cmds.filter(m => m.indexOf('"command"') !== -1).map(m => JSON.parse(m)),
      loopOn: typeof S !== 'undefined' ? !!S.opt.loop : null,
      readyBefore: readyBefore,
    };
    r.readyDelta = (window.__ltEmbed || []).filter(m => m === 'ready').length - readyBefore;
    say(1);                                     /* the player is running again */
    return r;
  });
  /* Past the fallback window: the frame that answered must not be replaced. */
  await sleep(2100);
  out.loopKept.iframesAfterWindow = await ev(() => document.querySelectorAll('#pl .art iframe').length);
  out.loopKept.sameAfterWindow = await ev(() => {
    const f = document.querySelector('#pl .art iframe');
    return !!f && f.src.indexOf('/embed/') !== -1 && f.src.indexOf('v01AAAAAAAA') !== -1;
  });

  /* ---- Loop: a wrap with a frame that never answers ---- */
  out.loopFall = await ev(() => {
    const first = document.querySelector('#pl .art iframe');
    /* Marked so the element after the fallback window can be told apart from
       this one without depending on `src`, which is the same video either way. */
    if (first) first.__ltMark = 'wrap';
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: 'https://www.youtube-nocookie.com',
        data: JSON.stringify({ event: 'onStateChange', info: 0 }),
      })
    );
    const afterWrap = document.querySelector('#pl .art iframe');
    return {
      reused: !!first && first === afterWrap,
      iframesAtWrap: document.querySelectorAll('#pl .art iframe').length,
    };
  });
  await sleep(2100);                            /* the fallback window */
  out.loopFall.iframesAfterWindow = await ev(() => document.querySelectorAll('#pl .art iframe').length);
  out.loopFall.rebuilt = await ev(() => {
    const f = document.querySelector('#pl .art iframe');
    return !!f && f.__ltMark !== 'wrap' && f.src.indexOf('/embed/') !== -1 && f.src.indexOf('v01AAAAAAAA') !== -1;
  });

  /* ---- close ---- */
  await ev(() => document.getElementById('pclose').click());
  await sleep(400);
  const end = await state();
  out.close = { iframes: end.iframes, artChildren: await ev(() => document.querySelector('#pl .art').children.length) };
  out.close.childFrames = await childFrames(page);

  /* ---- loop back off, so the build is left as it was found ---- */
  await ev(() => {
    document.querySelector('[data-do="you"]').click();
    document.querySelector('[data-lib="settings"]').click();
    document.querySelector('[data-opt="loop"]').click();
    document.getElementById('scrim').click();
  });
  await sleep(200);

  out.pageErrors = errors;
  out.end = { iframes: end.iframes, childFrames: await childFrames(page) };

  /* ---- verdict ---- */
  const fails = [];
  const ok = (cond, what) => {
    if (!cond) fails.push(what);
  };
  const funcs = (out.loopKept.cmds || []).map(c => c.func);
  const seek = (out.loopKept.cmds || []).find(c => c.func === 'seekTo');
  ok(out.boot.iframes === 0, 'boot: no frame before a video is played');
  ok(out.first.iframes === 1 && out.first.childFrames === 1, 'first: one play gives one frame');
  ok(out.first.ready === 1, 'first: the embed document loaded');
  ok(/\/embed\/v01AAAAAAAA/.test(out.first.src), 'first: the frame holds the video that was played');
  ok(out.same.reused, 'same: re-playing the video that is open keeps its iframe');
  ok(out.same.iframes === 1, 'same: still one iframe');
  ok(out.same.srcWrites.length === 0, 'same: the live frame is never navigated off the embed');
  ok(out.same.readyDelta === 0, 'same: the embed document is not fetched again');
  ok(out.same.playerOn, 'same: the player stayed open');
  ok(out.other.replaced, 'other: a different video gets a new iframe');
  ok(out.other.blanked === 1, 'other: the old frame is sent to about:blank first (item 4.4)');
  ok(out.other.iframes === 1, 'other: still one iframe');
  ok(/\/embed\/v02AAAAAAAA/.test(out.other.src), 'other: the new frame holds the new video');
  ok(out.loopKept.reused, 'loopKept: a wrap keeps the frame that is playing');
  ok(out.loopKept.iframes === 1, 'loopKept: a wrap leaves one iframe');
  ok(funcs.includes('seekTo') && funcs.includes('playVideo'), 'loopKept: the wrap seeks to 0 and plays through the jsapi channel');
  ok(!!seek && Array.isArray(seek.args) && seek.args[0] === 0, 'loopKept: the seek really goes back to the start');
  ok(out.loopKept.loopOn, 'loopKept: Loop was on for the wrap');
  ok(out.loopKept.readyDelta === 0, 'loopKept: the wrap does not re-fetch the embed document');
  ok(out.loopKept.iframesAfterWindow === 1, 'loopKept: no rebuild once the player answered');
  ok(out.loopKept.sameAfterWindow, 'loopKept: the same frame is still showing the video');
  ok(out.loopFall.reused, 'loopFall: a wrap still starts by keeping the frame');
  ok(out.loopFall.iframesAfterWindow === 1, 'loopFall: the fallback leaves exactly one iframe');
  ok(out.loopFall.rebuilt, 'loopFall: a player that never answered still gets a fresh frame, so Loop wraps');
  ok(out.close.iframes === 0 && out.close.artChildren === 0, 'close: the player holds no frame after the close');
  ok(out.close.childFrames === 0, 'close: no child frame survives the close');
  ok(out.end.iframes === 0 && out.end.childFrames === 0, 'end: no frame left at the end of the run');
  ok(out.pageErrors.length === 0, 'no page errors at all');
  out.fails = fails;
  out.pass = fails.length === 0;
  await page.close();
  return out;
}

(async () => {
  const files = process.argv.slice(2);
  if (!files.length) {
    console.error('usage: node tools/player-reuse-check.js <build.html> [build-b.html]');
    process.exit(2);
  }
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME || '/usr/bin/google-chrome',
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--force-device-scale-factor=1'],
  });
  const results = [];
  try {
    for (const f of files) {
      const r = await run(browser, f);
      results.push(r);
      console.log(JSON.stringify(r, null, 2));
    }
  } finally {
    await browser.close();
  }
  if (results.length > 1) {
    const a = results[0];
    const b = results[1];
    console.log('--- comparison (under test vs baseline) ---');
    console.log(
      JSON.stringify(
        {
          sameReused: [a.same.reused, b.same.reused],
          sameEmbedRefetched: [a.same.readyDelta, b.same.readyDelta],
          otherReplaced: [a.other.replaced, b.other.replaced],
          loopReused: [a.loopKept.reused, b.loopKept.reused],
          loopEmbedRefetched: [a.loopKept.readyDelta, b.loopKept.readyDelta],
          loopFallbackRebuilt: [a.loopFall.rebuilt, b.loopFall.rebuilt],
          pageErrors: [a.pageErrors.length, b.pageErrors.length],
          fails: [a.fails, b.fails],
          pass: [a.pass, b.pass],
        },
        null,
        2
      )
    );
  }
  process.exit(results[0].pass ? 0 : 1);
})();
