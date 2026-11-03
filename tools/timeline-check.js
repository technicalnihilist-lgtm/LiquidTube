#!/usr/bin/env node
/* Verifies the startup timeline (item 1.10): the lt-startup line, cold/warm,
 * error paths, the bounded array, and the 9 s last-resort flush. */
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const FILE = process.argv[2] || '/scratch/repos/LiquidTube/app/assets/index.html';
const HTML = fs.readFileSync(FILE);
const ORIGIN = 'liquidtube.local';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const pad = n => String(n).padStart(2, '0');
const vids = Array.from({ length: 24 }, (_, i) => 'v' + pad(i + 1) + 'AAAAAAAA');
const CH = Array.from({ length: 6 }, (_, i) => 'UC' + i + 'xxxxxxxxxxxxxxxxxxxx');
const ago = h => new Date(Date.now() - h * 36e5).toISOString();
const F = {
  videos: { items: vids.map((id, i) => ({ id, snippet: { title: 'Video ' + i, channelTitle: 'Channel ' + (i % 6), channelId: CH[i % 6], publishedAt: ago(i + 1), categoryId: '10' }, statistics: { viewCount: '1000' } })) },
  durations: { items: vids.map(id => ({ id, contentDetails: { duration: 'PT12M30S' } })) },
  channels: { items: CH.map((id, i) => ({ id, snippet: { title: 'Channel ' + i, customUrl: 'c' + i, publishedAt: '2015-04-02T10:00:00Z', thumbnails: { medium: { url: 'https://yt3.ggpht.com/a' + i + '.jpg' } } }, statistics: { subscriberCount: '1', videoCount: '1', viewCount: '1' }, contentDetails: { relatedPlaylists: { uploads: 'UU' + i } }, brandingSettings: { image: {}, channel: {} } })) },
  playlistItems: { items: vids.slice(0, 12).map((id, i) => ({ snippet: { title: 'P' + i, resourceId: { videoId: id }, publishedAt: ago(i * 24) }, contentDetails: { videoPublishedAt: ago(i * 24) } })) },
  search: { items: [] },
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

function body(u) {
  const url = new URL(u), p = url.pathname;
  if (p.endsWith('/videos')) return (url.searchParams.get('part') || '').includes('contentDetails') ? F.durations : F.videos;
  if (p.endsWith('/channels')) return chanAnswer(url, F.channels);
  if (p.endsWith('/playlistItems')) return F.playlistItems;
  if (p.endsWith('/search')) return F.search;
  return {};
}

async function run(browser, opts = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width: 412, height: 892, deviceScaleFactor: 2 });
  const logs = [], errors = [];
  page.on('console', m => { logs.push(m.type() + ': ' + m.text()); if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  if (opts.noIdle) await page.evaluateOnNewDocument(() => { window.requestIdleCallback = function () {}; });
  if (opts.preload) await page.evaluateOnNewDocument(opts.preload);
  await page.setRequestInterception(true);
  page.on('request', req => {
    const u = req.url();
    if (u.startsWith('https://' + ORIGIN + '/')) return req.respond({ status: 200, contentType: 'text/html; charset=utf-8', headers: { 'Cache-Control': 'no-cache' }, body: HTML });
    if (/googleapis\.com/.test(u)) {
      if (opts.hangApi) return;                      // never answered: no feedpaint at all
      if (opts.apiFail) return req.respond({ status: 500, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ error: { message: 'boom' } }) });
      return req.respond({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(body(u)) });
    }
    if (/ytimg\.com|ggpht\.com|googleusercontent\.com/.test(u)) return req.respond({ status: 200, contentType: 'image/png', body: PNG });
    return req.abort();
  });
  await page.goto('https://' + ORIGIN + '/index.html', { waitUntil: 'load', timeout: 60000 });
  if (opts.offline) { await page.setOfflineMode(true); await page.reload({ waitUntil: 'load' }); }
  await page.waitForFunction('!!window.__ltTimeline', { timeout: opts.timeout || 20000 }).catch(() => {});
  const r = await page.evaluate(() => ({
    tl: window.__ltTimeline || '',
    boot: localStorage.getItem('lt_boot') || '',
    cards: document.querySelectorAll('#feed .card').length,
    ready: document.getElementById('app').classList.contains('ready'),
  }));
  await page.close();
  return Object.assign(r, { logs, errors });
}

(async () => {
  const browser = await puppeteer.launch({ executablePath: process.env.CHROME || '/usr/local/bin/google-chrome', args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--hide-scrollbars'] });
  const out = [];
  const say = (k, v) => { out.push(k + ': ' + v); };

  // 1 cold, 2 warm (same profile), 3 api 500, 4 no idle callback (last resort), 5 offline
  const cold = await run(browser);
  say('cold', cold.tl);
  say('cold console lt- lines', cold.logs.filter(l => l.includes('lt-')).length);
  say('cold lt_boot', cold.boot);
  say('cold cards', cold.cards);
  say('cold errors', JSON.stringify(cold.errors));

  const warm = await run(browser);
  say('warm', warm.tl);
  say('warm lt_boot', warm.boot);

  const fail = await run(browser, { apiFail: true });
  say('api500', fail.tl);
  say('api500 errors', JSON.stringify(fail.errors));

  const t0 = Date.now();
  const noIdle = await run(browser, { noIdle: true, timeout: 15000 });
  say('no-idle (9 s fallback, waited ' + (Date.now() - t0) + ' ms)', noIdle.tl);
  say('no-idle has input field', / input=/.test(noIdle.tl));
  say('no-idle has feedpaint field', / feedpaint=/.test(noIdle.tl));

  const off = await run(browser, { offline: true });
  say('offline', off.tl);

  const t1 = Date.now();
  const hang = await run(browser, { hangApi: true, timeout: 20000 });
  say('api hang (12 s deadline, waited ' + (Date.now() - t1) + ' ms)', hang.tl);

  // 6 bounded: force many marks and confirm the array cannot grow
  const page = await browser.newPage();
  await page.setRequestInterception(true);
  page.on('request', req => {
    const u = req.url();
    if (u.startsWith('https://' + ORIGIN + '/')) return req.respond({ status: 200, contentType: 'text/html', body: HTML });
    if (/googleapis\.com/.test(u)) return req.respond({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(body(u)) });
    if (/ytimg|ggpht|googleusercontent/.test(u)) return req.respond({ status: 200, contentType: 'image/png', body: PNG });
    return req.abort();
  });
  await page.goto('https://' + ORIGIN + '/index.html', { waitUntil: 'load' });
  await page.waitForFunction('!!window.__ltTimeline', { timeout: 20000 }).catch(() => {});
  say('marks emitted in one boot (cap is 16)', await page.evaluate(() => {
    for (let i = 0; i < 100; i++) window.dispatchEvent(new Event('resize'));
    return performance.getEntriesByType('mark').filter(m => m.name.indexOf('lt:') === 0).length;
  }));
  say('timeline is one line', await page.evaluate(() => (window.__ltTimeline || '').split('\n').length));
  say('timeline bytes', await page.evaluate(() => (window.__ltTimeline || '').length));
  await page.close();
  await browser.close();
  console.log(out.join('\n'));
})().catch(e => { console.error(e); process.exit(1); });
