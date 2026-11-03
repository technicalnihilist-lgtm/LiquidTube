#!/usr/bin/env node
/*
 * LiquidTube feed-cache bench — cold vs warm first paint of the feed.
 *
 * Item 1.9 caches the last trending feed in localStorage and paints it in the
 * stage-1 shell, before any request is made. This script measures whether that
 * actually happens, without a device:
 *
 *   cold  — empty localStorage: the shell paints skeletons, the feed arrives
 *           with the network. This is the Day 1 path and must not get slower.
 *   warm  — same origin, same profile, one navigation later: the shell paints
 *           real cards from the cache. Reports when the first .card appears
 *           relative to .ready, whether the feed was still refetched, and how
 *           many API calls the warm start needed.
 *
 * googleapis.com is mocked with fixed fixtures (150 ms round trip) and every
 * image as a 1x1 PNG, so the numbers do not depend on the network.
 *
 * Usage:
 *   npm i puppeteer-core                     # dev only, not shipped in the APK
 *   CHROME=/path/to/chrome node tools/feed-cache-bench.js [file] [reps] [cpuThrottle]
 *
 * Defaults: app/assets/index.html, 3 reps, no throttling (pass 4 for the
 * mid-range-phone profile used elsewhere in this schedule).
 */
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const FILE = process.argv[2] || path.join(__dirname, '..', 'app/assets/index.html');
const REPS = Math.max(1, +(process.argv[3] || 3));
const THROTTLE = +(process.argv[4] || 0);
const ORIGIN = 'liquidtube.local';
const HTML = fs.readFileSync(FILE);

// 1x1 transparent PNG, stands in for every thumbnail and avatar
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64');

const pad = n => String(n).padStart(2, '0');
const vids = Array.from({ length: 24 }, (_, i) => 'v' + pad(i + 1) + 'AAAAAAAA');
const CH_IDS = Array.from({ length: 6 }, (_, i) => 'UC' + i + 'xxxxxxxxxxxxxxxxxxxx');
const ago = h => new Date(Date.now() - h * 36e5).toISOString();

const F = {
  videos: {
    items: vids.map((id, i) => ({
      id,
      snippet: {
        title: 'Trending video number ' + (i + 1) + ' title',
        channelTitle: 'Channel ' + (i % 6),
        channelId: CH_IDS[i % 6],
        publishedAt: ago(10 + i),
        categoryId: String([10, 20, 17, 24, 25, 27][i % 6]),
      },
      statistics: { viewCount: String(100000 + i * 7331) },
    })),
  },
  durations: { items: vids.map(id => ({ id, contentDetails: { duration: 'PT12M30S' } })) },
  channels: {
    items: CH_IDS.map((id, i) => ({
      id,
      snippet: { title: 'Channel ' + i, customUrl: 'channel' + i, thumbnails: { medium: { url: 'https://yt3.ggpht.com/av' + i } }, publishedAt: '2019-01-01T00:00:00Z' },
      statistics: { subscriberCount: '1000', videoCount: '10', viewCount: '99999' },
      contentDetails: { relatedPlaylists: { uploads: 'UU' + i } },
    })),
  },
  search: { items: [] },
  playlist: { items: [] },
};

/* The API answers a `channels` call with the ids it was asked for, and with an
   empty `items` for an id it does not know. A mock that always answers with its
   whole channel list instead would let a one-id lookup hand back a different
   channel than the one asked for — something the real endpoint never does — so
   every harness echoes the requested ids here and synthesises the ones its
   fixture does not hold. */
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

// /channels carries part=contentDetails too, so it has to be matched first
const apiBody = u =>
  u.includes('/search') ? F.search :
  u.includes('/playlistItems') ? F.playlist :
  u.includes('/channels') ? chanAnswer(u, F.channels) :
  u.includes('contentDetails') ? F.durations : F.videos;

// Records the first frame that carries .ready and the first real card.
const probe = () => {
  window.__m = { ready: 0, card: 0 };
  const tick = () => {
    const app = document.getElementById('app');
    const feed = document.getElementById('feed');
    if (!window.__m.ready && app && app.classList.contains('ready')) window.__m.ready = performance.now();
    if (!window.__m.card && feed && feed.querySelector('.card')) window.__m.card = performance.now();
    if (!(window.__m.ready && window.__m.card)) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
};

const median = a => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const r = x => Math.round(x);

(async () => {
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME || '/usr/bin/google-chrome',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--hide-scrollbars'],
  });
  const cold = [], warm = [];
  let cache = null, warmReqs = null, warmFeedReqs = null;

  for (let rep = 0; rep < REPS; rep++) {
    const page = await browser.newPage();
    await page.setViewport({ width: 412, height: 892, deviceScaleFactor: 2 });
    const reqs = [];
    await page.setRequestInterception(true);
    page.on('request', req => {
      const u = req.url();
      if (u.startsWith('https://' + ORIGIN + '/')) return req.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: HTML });
      if (u.includes('googleapis.com')) {
        reqs.push(u);
        return setTimeout(() => req.respond({
          status: 200, contentType: 'application/json',
          headers: { 'Access-Control-Allow-Origin': '*' },
          body: JSON.stringify(apiBody(u)),
        }).catch(() => {}), 150);
      }
      if (/ytimg|ggpht|googleusercontent/.test(u)) return req.respond({ status: 200, contentType: 'image/png', body: PNG });
      return req.abort();
    });
    // clear once per page, not once per navigation: the warm run must inherit the cache
    await page.evaluateOnNewDocument('try{if(!sessionStorage.getItem("lt_cleared")){localStorage.clear();sessionStorage.setItem("lt_cleared","1")}}catch(e){}');
    await page.evaluateOnNewDocument(probe);
    await page.goto('https://' + ORIGIN + '/index.html', { waitUntil: 'domcontentloaded' });
    if (THROTTLE) {
      const cdp = await page.createCDPSession();
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
    }
    await page.waitForFunction('window.__m && window.__m.card > 0', { timeout: 60000 });
    await new Promise(res => setTimeout(res, 400));
    cold.push(await page.evaluate(() => ({ ...window.__m })));
    if (!cache) cache = await page.evaluate(() => {
      const raw = localStorage.getItem('lt_feed');
      if (!raw) return null;
      const c = JSON.parse(raw);
      return { bytes: raw.length, version: c.v, items: (c.items || []).length, avatars: Object.keys(c.chav || {}).length };
    });

    // warm run: same origin and profile, fresh navigation — the "reopen" case
    reqs.length = 0;
    await page.goto('https://' + ORIGIN + '/index.html', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction('window.__m && window.__m.card > 0', { timeout: 60000 });
    await new Promise(res => setTimeout(res, 400));
    warm.push(await page.evaluate(() => ({
      ...window.__m,
      cards: document.querySelectorAll('#feed .card').length,
      skeletons: document.querySelectorAll('#feed .skl').length,
      cached: performance.getEntriesByType('mark').some(m => m.name === 'lt:cache'),
    })));
    if (!warmReqs) { warmReqs = reqs.length; warmFeedReqs = reqs.filter(u => u.includes('mostPopular')).length; }
    await page.close();
  }
  await browser.close();

  console.log(JSON.stringify({
    file: path.basename(FILE),
    cpuThrottle: THROTTLE || 1,
    reps: REPS,
    cache,
    cold: { ready: r(median(cold.map(x => x.ready))), firstCard: r(median(cold.map(x => x.card))) },
    warm: {
      ready: r(median(warm.map(x => x.ready))),
      firstCard: r(median(warm.map(x => x.card))),
      paintedFromCache: warm[0].cached,
      cards: warm[0].cards,
      skeletons: warm[0].skeletons,
      apiCalls: warmReqs,
      feedRefetched: warmFeedReqs === 1,
    },
    raw: { cold: cold.map(x => ({ ready: r(x.ready), firstCard: r(x.card) })), warm: warm.map(x => ({ ready: r(x.ready), firstCard: r(x.card) })) },
  }, null, 1));
})();
