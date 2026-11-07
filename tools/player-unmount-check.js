#!/usr/bin/env node
/*
 * LiquidTube player-unmount check — item 4.4 ("null out iframe src on player
 * close to free the media pipeline").
 *
 * Closing the player used to be one line: empty `#pl .art`. That detaches the
 * embed, and a detached frame is not a stopped one — the <video> inside it keeps
 * its decoder, its audio route and its playing state until the renderer gets
 * round to collecting the frame. On a WebView that can be well after the panel
 * has slid away, which is how a closed video is still heard playing. The fix is
 * to navigate the frame off the embed (`about:blank`) before detaching it, so
 * the player document is unloaded and its media element dropped, and to drop the
 * `cur` reference with it.
 *
 * What this tool measures, per build, on a real browser with the API mocked and
 * the embed served as a real document that reports its own lifecycle:
 *
 *   boot       iframes in the player at rest
 *   close      one play/close: iframes left, `.art` children, the last `src` the
 *              iframe was given before it went (the mechanism under test), the
 *              embed document's own pagehide, and the child frames CDP still
 *              reports after the close
 *   afterClose the player's buttons with the player closed: Like on a closed
 *              player must not change the library count (that is `cur` being
 *              dropped, measured through the app's own UI)
 *   cycles     twenty play/close cycles: iframes and child frames left behind
 *   remount    eleven plays into an open player: one iframe, and every one of
 *              the ten it replaced was sent to `about:blank` first
 *   loop       Loop still re-mounts while open, and does not re-mount a player
 *              that has been closed
 *   channel    the Channel button still opens the right channel after the close
 *              (the id is read before `closeAll` drops `cur`)
 *   end        iframes, child frames and page errors after the whole run
 *
 * Usage:
 *   npm i puppeteer-core                    # dev only, not shipped in the APK
 *   CHROME=/path/to/chrome node tools/player-unmount-check.js <build-a.html> [build-b.html]
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

/* The embed, served as a real page so its lifecycle can be watched. It holds a
   <video> like the real player and reports when it is unloaded — that is the
   document the fix is supposed to end. */
const EMBED_HTML = `<!doctype html><html><body><video id="v" muted playsinline></video>
<script>
  var say=function(m){try{parent.postMessage('LTEMBED:'+m,'*')}catch(e){}};
  addEventListener('pagehide',function(){say('pagehide')});
  addEventListener('unload',function(){say('unload')});
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

/* The child frames Chromium still holds, from the browser side rather than from
   the page's own bookkeeping. */
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
  const embed = [];
  page.on('pageerror', e => errors.push(String(e.message || e)));
  page.on('console', m => {
    if (m.type() === 'error' && !/ytimg|ggpht|net::ERR|youtube-nocookie|about:blank/.test(m.text())) errors.push(m.text());
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
  /* Watch what the embed document itself says about being unloaded. */
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
  return { page, errors, embed };
}

async function run(browser, file) {
  const { page, errors } = await boot(browser, file);
  const out = { file: path.basename(file) };
  const ev = (fn, ...a) => page.evaluate(fn, ...a);
  const playCard = i => ev(n => document.querySelectorAll('#feed .card')[n].click(), i);
  const closePlayer = () => ev(() => document.getElementById('pclose').click());
  const state = () =>
    ev(() => ({
      iframes: document.querySelectorAll('#pl .art iframe').length,
      artChildren: document.querySelector('#pl .art').children.length,
      on: document.getElementById('pl').classList.contains('on'),
      embed: (window.__ltEmbed || []).slice(),
    }));

  /* ---- boot ---- */
  out.boot = await state();
  out.boot.childFrames = await childFrames(page);

  /* ---- one play, then close ---- */
  await playCard(0);
  await sleep(400);
  const open = await state();
  out.close = { iframesOpen: open.iframes, childFramesOpen: await childFrames(page), embedOnOpen: open.embed.slice() };
  /* Watch the iframe's own `src` while it goes: attribute records are delivered
     even for a node that is removed in the same task. */
  out.close.srcAtTeardown = await ev(() => {
    const seen = [];
    const art = document.querySelector('#pl .art');
    const mo = new MutationObserver(ms => {
      for (const m of ms) if (m.type === 'attributes' && m.attributeName === 'src') seen.push(m.target.getAttribute('src'));
    });
    mo.observe(art, { subtree: true, attributes: true, attributeFilter: ['src'] });
    document.getElementById('pclose').click();
    /* `takeRecords()` and not `disconnect()`: the records of a node removed in
       this same task are only queued for the microtask checkpoint, and a
       disconnect would throw them away. */
    for (const m of mo.takeRecords()) if (m.type === 'attributes' && m.attributeName === 'src') seen.push(m.target.getAttribute('src'));
    mo.disconnect();
    return seen;
  });
  await sleep(300);
  const closed = await state();
  out.close.iframesClosed = closed.iframes;
  out.close.artChildrenClosed = closed.artChildren;
  out.close.onClosed = closed.on;
  out.close.childFramesClosed = await childFrames(page);
  out.close.embedOnClose = closed.embed.slice();

  /* ---- the player's buttons with the player closed ---- */
  /* `cur` is dropped on close, so Like must be a no-op; if it still held the
     video, the library would gain one. Measured through the app's own UI. */
  out.afterClose = await ev(() => {
    document.getElementById('ppp').click();
    document.querySelector('[data-do="you"]').click();
    const row = document.querySelector('#shb [data-lib="liked"]');
    const r = { likedRow: row ? row.textContent.trim() : null };
    document.getElementById('scrim').click();
    return r;
  });
  await sleep(200);

  /* ---- twenty play/close cycles ---- */
  for (let i = 0; i < 20; i++) {
    await playCard(i);
    await closePlayer();
  }
  await sleep(300);
  const cycled = await state();
  out.cycles = { cycles: 20, iframesLeft: cycled.iframes, childFramesLeft: await childFrames(page) };

  /* ---- eleven plays into an open player ---- */
  out.remount = await ev(() => {
    const seen = [];
    const art = document.querySelector('#pl .art');
    const mo = new MutationObserver(ms => {
      for (const m of ms) if (m.type === 'attributes' && m.attributeName === 'src') seen.push(m.target.getAttribute('src'));
    });
    mo.observe(art, { subtree: true, attributes: true, attributeFilter: ['src'] });
    const cards = [...document.querySelectorAll('#feed .card')];
    cards[0].click();
    for (let i = 1; i <= 10; i++) cards[i % cards.length].click();
    for (const m of mo.takeRecords()) if (m.type === 'attributes' && m.attributeName === 'src') seen.push(m.target.getAttribute('src'));
    mo.disconnect();
    const r = {
      iframes: document.querySelectorAll('#pl .art iframe').length,
      blanked: seen.filter(s => s === 'about:blank').length,
      srcs: [...new Set(seen)],
    };
    document.getElementById('pclose').click();
    return r;
  });
  await sleep(300);
  out.remount.childFramesClosed = await childFrames(page);

  /* ---- Loop ---- */
  out.loop = await ev(() => {
    document.querySelector('[data-do="you"]').click();
    document.querySelector('[data-lib="settings"]').click();
    document.querySelector('[data-opt="loop"]').click();
    document.getElementById('scrim').click();
    const cards = [...document.querySelectorAll('#feed .card')];
    cards[0].click();
    const first = document.querySelector('#pl .art iframe');
    const msg = () =>
      window.dispatchEvent(
        new MessageEvent('message', {
          origin: 'https://www.youtube-nocookie.com',
          data: JSON.stringify({ event: 'onStateChange', info: 0 }),
        })
      );
    msg();
    const second = document.querySelector('#pl .art iframe');
    const r = {
      remounted: !!first && !!second && first !== second,
      iframes: document.querySelectorAll('#pl .art iframe').length,
    };
    document.getElementById('pclose').click();
    /* A closed player has no bridge and no `cur`: the same message must not
       bring a frame back. */
    msg();
    r.iframesAfterCloseMsg = document.querySelectorAll('#pl .art iframe').length;
    document.querySelector('[data-do="you"]').click();
    document.querySelector('[data-lib="settings"]').click();
    document.querySelector('[data-opt="loop"]').click(); // loop back off
    document.getElementById('scrim').click();
    return r;
  });
  await sleep(300);

  /* ---- the Channel button, whose id must be read before the close ---- */
  await playCard(0);
  await sleep(200);
  out.channel = await ev(() => {
    const before = document.getElementById('pl').classList.contains('on');
    document.getElementById('plk').click();
    return {
      playerWasOpen: before,
      playerClosed: !document.getElementById('pl').classList.contains('on'),
      sheetOpen: document.getElementById('sheet').classList.contains('on'),
      iframes: document.querySelectorAll('#pl .art iframe').length,
    };
  });
  await sleep(600);
  out.channel.title = await ev(() => document.getElementById('sht').textContent);
  await ev(() => document.getElementById('scrim').click());
  await sleep(200);

  /* ---- end ---- */
  const end = await state();
  out.end = { iframes: end.iframes, childFrames: await childFrames(page) };
  out.pageErrors = errors;
  out.end.pageErrors = errors.length;

  /* ---- verdict ---- */
  const fails = [];
  const ok = (cond, what) => {
    if (!cond) fails.push(what);
  };
  ok(out.boot.iframes === 0 && out.boot.childFrames === 0, 'boot: no frame before a video is played');
  ok(out.close.iframesOpen === 1 && out.close.childFramesOpen === 1, 'close: one frame while the player is open');
  ok(out.close.embedOnOpen.includes('ready'), 'close: the embed document really loaded');
  ok(out.close.srcAtTeardown[out.close.srcAtTeardown.length - 1] === 'about:blank', 'close: the frame is navigated off the embed before it is detached');
  ok(out.close.iframesClosed === 0 && out.close.artChildrenClosed === 0, 'close: the player holds no frame after the close');
  ok(out.close.childFramesClosed === 0, 'close: no child frame survives the close');
  ok(out.close.embedOnClose.includes('pagehide'), 'close: the player document is unloaded, not just dropped');
  ok(out.close.onClosed === false, 'close: the player is off screen');
  ok(/^Liked · 0$/.test(String(out.afterClose.likedRow)), 'afterClose: Like on a closed player does nothing (cur was dropped)');
  ok(out.cycles.iframesLeft === 0 && out.cycles.childFramesLeft === 0, 'cycles: twenty play/close cycles leave no frame');
  ok(out.remount.iframes === 1, 'remount: eleven plays leave one iframe');
  ok(out.remount.blanked === 10, 'remount: every replaced frame was sent to about:blank first');
  ok(out.remount.childFramesClosed === 0, 'remount: no child frame survives the close');
  ok(out.loop.remounted && out.loop.iframes === 1, 'loop: the bridge still re-mounts the player');
  ok(out.loop.iframesAfterCloseMsg === 0, 'loop: a closed player is not re-mounted by a late message');
  ok(out.channel.playerWasOpen && out.channel.playerClosed && out.channel.sheetOpen, 'channel: the Channel button still closes the player and opens the sheet');
  ok(out.channel.iframes === 0, 'channel: the frame went with the player');
  ok(/^Channel /.test(String(out.channel.title)), 'channel: the sheet opened the channel the video was from');
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
    console.error('usage: node tools/player-unmount-check.js <build.html> [build-b.html]');
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
          srcAtTeardown: [a.close.srcAtTeardown, b.close.srcAtTeardown],
          embedPagehide: [a.close.embedOnClose.includes('pagehide'), b.close.embedOnClose.includes('pagehide')],
          childFramesClosed: [a.close.childFramesClosed, b.close.childFramesClosed],
          remountBlanked: [a.remount.blanked, b.remount.blanked],
          likedAfterClose: [a.afterClose.likedRow, b.afterClose.likedRow],
          channel: [a.channel, b.channel],
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
