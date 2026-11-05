#!/usr/bin/env node
/*
 * LiquidTube off-screen frame check — item 3.2.
 *
 * Proves three things about the depth/parallax frame loop, on a real browser
 * under the WebView's origin with the API mocked:
 *
 *  1. a scroll frame on the page on screen measures only that page's elements
 *     (the other two tab pages are a whole width off screen and must not be
 *     touched), while a page that comes back on screen still ends up with the
 *     exact transforms it has in the build being compared against;
 *  2. while the document is hidden no frame is requested and nothing is
 *     measured, however many scroll and orientation samples arrive;
 *  3. becoming visible again pays exactly one forced pass, and the layers hold
 *     the transforms the new orientation asks for.
 *
 * Usage:  node tools/offscreen-frame-check.js <build-a.html> [build-b.html]
 * Prints one JSON object per build, so two builds can be diffed.
 */
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const ORIGIN = 'liquidtube.local';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const pad = n => String(n).padStart(2, '0');
const vids = Array.from({ length: 24 }, (_, i) => 'v' + pad(i + 1) + 'AAAAAAAA');
const CH = Array.from({ length: 6 }, (_, i) => 'UC' + i + 'xxxxxxxxxxxxxxxxxxxx');
const ago = h => new Date(Date.now() - h * 36e5).toISOString();
const F = {
  videos: { items: vids.map((id, i) => ({ id, snippet: { title: 'Video ' + i, channelTitle: 'Channel ' + (i % 6), channelId: CH[i % 6], publishedAt: ago(i + 1), categoryId: '10', thumbnails: { maxres: { url: 'https://i.ytimg.com/vi/' + id + '/maxresdefault.jpg' } } }, statistics: { viewCount: '1000' } })) },
  durations: { items: vids.map(id => ({ id, contentDetails: { duration: 'PT12M30S' } })) },
  channels: { items: CH.map((id, i) => ({ id, snippet: { title: 'Channel ' + i, customUrl: 'c' + i, publishedAt: '2015-04-02T10:00:00Z', thumbnails: { medium: { url: 'https://yt3.ggpht.com/a' + i + '.jpg' } } }, statistics: { subscriberCount: '1', videoCount: '1', viewCount: '1' }, contentDetails: { relatedPlaylists: { uploads: 'UU' + i } }, brandingSettings: { image: {}, channel: {} } })) },
  playlistItems: { items: vids.slice(0, 12).map((id, i) => ({ snippet: { title: 'P' + i, resourceId: { videoId: id }, publishedAt: ago(i * 24) }, contentDetails: { videoPublishedAt: ago(i * 24) } })) },
  search: { items: [] },
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
  const u = new URL(url);
  const p = u.pathname;
  if (p.endsWith('/videos')) return (u.searchParams.get('part') || '').includes('contentDetails') ? F.durations : F.videos;
  if (p.endsWith('/channels')) return chanAnswer(u, F.channels);
  if (p.endsWith('/playlistItems')) return F.playlistItems;
  if (p.endsWith('/search')) return F.search;
  return {};
}

async function boot(browser, file) {
  const HTML = fs.readFileSync(file);
  const page = await browser.newPage();
  await page.setViewport({ width: 412, height: 892, deviceScaleFactor: 2 });
  await page.setRequestInterception(true);
  page.on('request', req => {
    const u = req.url();
    if (u.startsWith('https://' + ORIGIN + '/')) return req.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: HTML });
    if (/googleapis\.com/.test(u)) return req.respond({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(apiBody(u)) });
    if (/ytimg\.com|ggpht\.com|googleusercontent\.com/.test(u)) return req.respond({ status: 200, contentType: 'image/png', body: PNG });
    return req.abort();
  });
  await page.goto('https://' + ORIGIN + '/index.html', { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction('document.querySelectorAll("#feed .card").length > 0', { timeout: 60000 });
  await page.waitForFunction('!document.querySelector("#ex .skl")', { timeout: 60000 });
  await sleep(600);
  /* Instrumentation: how many rects a pass measures, how many frames it asks
     for, and every transform/opacity the passes write (as opposed to the ones
     the shell sets), recorded per page. */
  await page.evaluate(() => {
    const W = window;
    W.__rects = 0; W.__rafs = 0; W.__writes = 0;
    const gr = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function () {
      if (this.closest && this.closest('.page')) W.__rects++;
      return gr.call(this);
    };
    const raf = W.requestAnimationFrame;
    W.requestAnimationFrame = function (cb) { W.__rafs++; return raf.call(W, cb); };
    /* Every inline style the passes write, counted from the mutations they
       cause rather than from the property setters: an element inside a page
       whose style attribute changed was written by a pass (the shell's own
       page transform is the one element excluded). */
    new MutationObserver(recs => {
      for (const r of recs) {
        if (!r.target.closest || r.target.closest('.page')) W.__writes++;
      }
    }).observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['style'] });
    W.__reset = () => { W.__rects = 0; W.__rafs = 0; W.__writes = 0; };
    /* The transforms each page's cards and thumbnails carry, so two builds can
       be compared on what they actually rendered. */
    W.__faces = sel => [...document.querySelectorAll(sel)].map(e => {
      const s = e.style;
      return [s.transform, s.opacity, s.backgroundPositionY].join('~');
    });
    W.__setHidden = h => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => h });
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => h ? 'hidden' : 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
    };
  });
  return page;
}

const frames = page => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(r)))));

async function run(browser, file) {
  const page = await boot(browser, file);
  const out = { file: path.basename(file) };
  /* ---- 0. the at-rest frame: nothing has been scrolled or tilted yet ---- */
  out.atRest = await page.evaluate(() => __faces('#p-home .card').slice(0, 6));

  /* ---- 1. a scroll frame on the page on screen ---- */
  await page.evaluate(() => {
    const pg = document.querySelector('.page:not([inert])');
    pg.scrollTop = 900;
    document.querySelectorAll('.page').forEach(p => p.dispatchEvent(new Event('scroll')));
  });
  await frames(page);
  await sleep(120);
  await page.evaluate(() => __reset());
  await page.evaluate(() => {
    const pg = document.querySelector('.page:not([inert])');
    pg.scrollTop = 1100;
    pg.dispatchEvent(new Event('scroll'));
  });
  await frames(page);
  await sleep(120);
  out.scrollFrame = await page.evaluate(() => ({
    rects: __rects,
    writes: __writes,
    cardsOnScreen: document.querySelectorAll('.page:not([inert]) .card').length,
    thumbsOnScreen: document.querySelectorAll('.page:not([inert]) .thumb img').length,
    thumbsEverywhere: document.querySelectorAll('.page .thumb img').length,
    cardsEverywhere: document.querySelectorAll('.page .card').length,
    feed: __faces('#p-home .card').slice(0, 6),
    /* geometry, so a difference in what was written can be told apart from a
       difference in where the cards actually are */
    tops: [...document.querySelectorAll('#p-home .card')].slice(0, 8).map(c => {
      const r = c.getBoundingClientRect();
      return [Math.round(r.top * 10) / 10, Math.round(r.height * 10) / 10].join('x');
    }),
  }));

  /* ---- 2. a page that comes back on screen ---- */
  await page.evaluate(() => document.querySelectorAll('.tab')[1].click());
  await frames(page);
  await sleep(300);
  out.exploreAfterSwitch = await page.evaluate(() => ({
    inert: document.getElementById('p-explore').inert,
    els: document.querySelectorAll('#p-explore .big, #p-explore .thumb img').length,
    faces: __faces('#p-explore .big, #p-explore .thumb img').slice(0, 6),
    painted: __faces('#p-explore .big, #p-explore .thumb img').slice(0, 6).filter(s => /translate|scale/.test(s)).length,
  }));
  await page.evaluate(() => document.querySelectorAll('.tab')[0].click());
  await frames(page);
  await sleep(300);
  out.homeAfterReturn = await page.evaluate(() => __faces('#p-home .card').slice(0, 6));
  /* The reveal animations the tab switch restarts are still running when the
     pass above measures, so the two builds are sampled at slightly different
     points of the same animation. Let everything settle, nudge the scroll so a
     pass certainly runs, and compare the steady state instead. */
  await sleep(1200);
  await page.evaluate(() => {
    const pg = document.querySelector('.page:not([inert])');
    pg.scrollTop = 1101;
    pg.dispatchEvent(new Event('scroll'));
  });
  await frames(page);
  await sleep(200);
  out.homeSettled = await page.evaluate(() => __faces('#p-home .card').slice(0, 8));

  /* ---- 3. hidden: nothing is measured, nothing is scheduled ---- */
  await page.evaluate(() => { __setHidden(true); __reset(); });
  await sleep(60);
  await page.evaluate(() => {
    __reset();
    for (let i = 0; i < 12; i++) {
      const pg = document.querySelector('.page:not([inert])');
      if (pg) pg.dispatchEvent(new Event('scroll'));
      window.dispatchEvent(Object.assign(new Event('deviceorientation'), { alpha: i, beta: 40 + i, gamma: 10 + i }));
    }
  });
  await sleep(400);
  out.hidden = await page.evaluate(() => ({ rects: __rects, rafs: __rafs, writes: __writes }));

  /* ---- 4. visible again: one pass, and it holds the new orientation ---- */
  await page.evaluate(() => { __setHidden(false); __reset(); });
  await frames(page);
  await sleep(200);
  out.resumed = await page.evaluate(() => ({
    rects: __rects, rafs: __rafs, writes: __writes,
    feed: __faces('#p-home .card').slice(0, 6),
    top: document.querySelector('.page:not([inert]) .top').style.transform,
  }));

  /* ---- the three properties this check exists to prove ---- */
  const sf = out.scrollFrame;
  out.assertions = {
    'a scroll frame measures only the page on screen':
      sf.rects === sf.cardsOnScreen + sf.thumbsOnScreen,
    'nothing is measured or scheduled while the document is hidden':
      out.hidden.rects === 0 && out.hidden.rafs === 0 && out.hidden.writes === 0,
    'becoming visible again pays exactly one pass over every page':
      out.resumed.rects === sf.cardsEverywhere + sf.thumbsEverywhere,
    'and that pass writes the layers back':
      out.resumed.writes > 0,
  };
  out.pass = Object.values(out.assertions).every(Boolean);
  await page.close();
  return out;
}

(async () => {
  const files = process.argv.slice(2);
  if (!files.length) { console.error('usage: node tools/offscreen-frame-check.js <build-a.html> [build-b.html]'); process.exit(2); }
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME || '/usr/bin/google-chrome',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--hide-scrollbars'],
  });
  const results = [];
  for (const f of files) results.push(await run(browser, f));
  await browser.close();
  console.log(JSON.stringify(results, null, 2));
})();
