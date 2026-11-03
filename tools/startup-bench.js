#!/usr/bin/env node
/*
 * LiquidTube startup bench — cold start to first paint.
 *
 * The whole UI is one HTML file served from the APK's assets into a WebView, so
 * the startup cost that we can actually move is the web layer: parse the shell,
 * paint it, fetch the feed, paint the feed. This script measures exactly that,
 * deterministically, without a device:
 *
 *   - the page is served under the same https origin the WebView uses
 *     (https://liquidtube.local/index.html), so localStorage and the app's own
 *     asset path behave like production;
 *   - googleapis.com is mocked with fixed fixtures and a configurable round trip,
 *     and every image is a 1x1 PNG, so the number never depends on the network;
 *   - the run is cold: fresh browser context, no cache, empty localStorage;
 *   - optional CPU throttling gives a device-class proxy (a mid-range Android
 *     phone is roughly the 4x column).
 *
 * Milestones reported (ms, from navigation start):
 *   FP     first paint of anything
 *   FCP    first contentful paint (the splash)
 *   DCL    DOMContentLoaded
 *   load   window load
 *   shell  #app gets .ready — splash starts leaving, the real shell is visible
 *   feed   first .card painted in #feed
 *
 * It also prints the app's own startup timeline (the `lt-startup ...` line the
 * build logs on every launch, see `window.__ltTimeline`): the cumulative ms of
 * every boot milestone plus the previous run's total, so a regression shows up as
 * a bigger number against the same line from the last run instead of being felt
 * later. Paste two runs side by side to compare.
 *
 * Usage:
 *   npm i puppeteer-core                     # dev only, not shipped in the APK
 *   node tools/startup-bench.js [repoDir] [apiDelayMs] [reps]
 *   CHROME=/path/to/chrome node tools/startup-bench.js
 *
 * Each profile runs `reps` times (default 3) after one discarded warm-up pass,
 * and the median is reported: a single cold run on a shared machine is far too
 * noisy to compare against.
 *
 * The native WebView construction time (a few hundred ms on a real device) is
 * NOT included; this measures the web layer only, which is the part we control.
 */
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const REPO = process.argv[2] || path.join(__dirname, '..');
const API_DELAY = +(process.argv[3] || 150); // simulated googleapis round trip (ms)
const REPS = Math.max(1, +(process.argv[4] || 3));
const ORIGIN = 'liquidtube.local';
const HTML = fs.readFileSync(path.join(REPO, 'app/assets/index.html'));

// 1x1 transparent PNG, stands in for every thumbnail and avatar
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64');

const pad = n => String(n).padStart(2, '0');
const vids = Array.from({ length: 24 }, (_, i) => 'v' + pad(i + 1) + 'AAAAAAAA');
const CH_IDS = Array.from({ length: 6 }, (_, i) => 'UC' + i + 'xxxxxxxxxxxxxxxxxxxx');
const ago = h => new Date(Date.now() - h * 36e5).toISOString();

function fixtures() {
  return {
    videos: {
      items: vids.map((id, i) => ({
        id,
        snippet: {
          title: 'Sample trending video number ' + (i + 1) + ' with a realistic title',
          channelTitle: 'Channel ' + (i % 6),
          channelId: CH_IDS[i % 6],
          publishedAt: ago(i + 1),
          categoryId: ['10', '20', '24', '25', '27', '17'][i % 6],
          thumbnails: { maxres: { url: 'https://i.ytimg.com/vi/' + id + '/maxresdefault.jpg' } },
        },
        statistics: { viewCount: String(1000 * (i + 1) * 7) },
      })),
    },
    durations: { items: vids.map(id => ({ id, contentDetails: { duration: 'PT12M30S' } })) },
    channels: {
      items: CH_IDS.concat(Array.from({ length: 6 }, (_, i) => 'UCs' + i + 'xxxxxxxxxxxxxxxxxxx'))
        .map((id, i) => ({
          id,
          snippet: {
            title: 'Channel ' + i,
            customUrl: 'channel' + i,
            publishedAt: '2015-04-02T10:00:00Z',
            country: 'IN',
            description: 'A sample channel used for benchmarking startup.',
            thumbnails: { medium: { url: 'https://yt3.ggpht.com/av' + i + '.jpg' } },
          },
          statistics: { subscriberCount: '1200000', videoCount: '480', viewCount: '91000000' },
          contentDetails: { relatedPlaylists: { uploads: 'UU' + i + 'xxxxxxxxxxxxxxxxxxxx' } },
          brandingSettings: { image: { bannerExternalUrl: '' }, channel: {} },
        })),
    },
    playlistItems: {
      items: vids.slice(0, 12).map((id, i) => ({
        snippet: { title: 'Playlist item ' + i, resourceId: { videoId: id }, publishedAt: ago(i * 24) },
        contentDetails: { videoPublishedAt: ago(i * 24) },
      })),
    },
    search: {
      items: vids.slice(0, 20).map((id, i) => ({
        id: { videoId: id },
        snippet: {
          title: 'Search result ' + i,
          channelTitle: 'Channel ' + (i % 6),
          channelId: CH_IDS[i % 6],
          publishedAt: ago(i * 24),
        },
      })),
    },
  };
}
const F = fixtures();

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

function apiBody(url) {
  const u = new URL(url);
  const p = u.pathname;
  if (p.endsWith('/videos')) {
    return (u.searchParams.get('part') || '').includes('contentDetails') ? F.durations : F.videos;
  }
  if (p.endsWith('/channels')) return chanAnswer(u, F.channels);
  if (p.endsWith('/playlistItems')) return F.playlistItems;
  if (p.endsWith('/search')) return F.search;
  return {};
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function measure(browser, cpu, label) {
  const page = await browser.newPage();
  await page.setViewport({ width: 412, height: 892, deviceScaleFactor: 2 });

  if (cpu > 1) {
    const cdp = await page.target().createCDPSession();
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu });
  }

  // frame-aligned sampling of the two milestones the app itself owns
  await page.evaluateOnNewDocument(() => {
    window.__b = { shell: 0, feed: 0, cards: 0 };
    // One probe, sampled from both a frame callback and a timer. The rAF sample is
    // the accurate one; the timer is the fallback for a run where frames stall
    // (a throttled, busy main thread can starve rAF for a second or more) so a
    // milestone is never reported as a missing 0. First observation wins.
    const probe = () => {
      const app = document.getElementById('app');
      const feed = document.getElementById('feed');
      if (app && !window.__b.shell && app.classList.contains('ready')) {
        window.__b.shell = performance.now();
      }
      if (feed && !window.__b.feed && feed.querySelector('.card')) {
        window.__b.feed = performance.now();
        window.__b.cards = feed.querySelectorAll('.card').length;
      }
      return !!(window.__b.shell && window.__b.feed);
    };
    const tick = () => { if (!probe()) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    const iv = setInterval(() => { if (probe()) clearInterval(iv); }, 8);
  });

  await page.setRequestInterception(true);
  page.on('request', async req => {
    const u = req.url();
    if (u.startsWith('https://' + ORIGIN + '/')) {
      return req.respond({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        headers: { 'Cache-Control': 'no-cache' },
        body: HTML,
      });
    }
    if (/googleapis\.com/.test(u)) {
      if (API_DELAY) await sleep(API_DELAY);
      return req.respond({
        status: 200,
        contentType: 'application/json',
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify(apiBody(u)),
      });
    }
    if (/ytimg\.com|ggpht\.com|googleusercontent\.com/.test(u)) {
      return req.respond({ status: 200, contentType: 'image/png', body: PNG });
    }
    return req.abort();
  });

  await page.goto('https://' + ORIGIN + '/index.html', { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction('window.__b.feed > 0', { timeout: 60000 });
  // the app writes its timeline once the boot has settled; wait for it so the line
  // is complete, but never let a missing one fail the measurement
  await page.waitForFunction('!!window.__ltTimeline', { timeout: 5000 }).catch(() => {});
  await sleep(120);

  const r = await page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0] || {};
    const paints = {};
    performance.getEntriesByType('paint').forEach(p => (paints[p.name] = p.startTime));
    const b = window.__b;
    const marks = {};
    performance.getEntriesByType('mark').forEach(m => {
      if (m.name.indexOf('lt:') === 0) marks[m.name.slice(3)] = m.startTime;
    });
    return Object.assign({ marks }, {
      fp: paints['first-paint'] || 0,
      fcp: paints['first-contentful-paint'] || 0,
      dcl: nav.domContentLoadedEventEnd || 0,
      loadEnd: nav.loadEventEnd || 0,
      shell: b.shell,
      feed: b.feed,
      cards: b.cards,
      tl: window.__ltTimeline || '',
    });
  });
  await page.close();
  return Object.assign({ label, cpu }, r);
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME || '/usr/bin/google-chrome',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--hide-scrollbars'],
  });

  const PROFILES = [[1, '1x (bench host)'], [4, '4x CPU throttle'], [6, '6x CPU throttle']];
  const median = a => {
    const s = a.slice().sort((x, y) => x - y);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };

  // one discarded warm-up so the first profile does not pay for browser start-up
  await measure(browser, 1, 'warm-up');

  const results = [];
  for (const [cpu, label] of PROFILES) {
    const reps = [];
    for (let i = 0; i < REPS; i++) reps.push(await measure(browser, cpu, label));
    results.push({
      label,
      cpu,
      cards: reps[0].cards,
      fp: median(reps.map(r => r.fp)),
      fcp: median(reps.map(r => r.fcp)),
      dcl: median(reps.map(r => r.dcl)),
      loadEnd: median(reps.map(r => r.loadEnd)),
      shell: median(reps.map(r => r.shell)),
      feed: median(reps.map(r => r.feed)),
      marks: reps[0].marks || {},
      tl: reps.map(r => r.tl).filter(Boolean),
    });
  }
  await browser.close();

  const f = n => n.toFixed(0).padStart(9);
  console.log('LiquidTube startup bench — cold cache, mocked API (' + API_DELAY +
              ' ms round trip), median of ' + REPS);
  console.log('');
  console.log('profile'.padEnd(18) + 'FP'.padStart(9) + 'FCP'.padStart(9) + 'DCL'.padStart(9) +
              'load'.padStart(9) + 'shell'.padStart(9) + 'feed'.padStart(9) + 'cards'.padStart(7));
  for (const r of results) {
    console.log(r.label.padEnd(18) + f(r.fp) + f(r.fcp) + f(r.dcl) + f(r.loadEnd) +
                f(r.shell) + f(r.feed) + String(r.cards).padStart(7));
  }
  console.log('');
  console.log('app timeline, lt-startup line as the build logs it (first rep of each profile):');
  for (const r of results) {
    console.log('  ' + r.label.padEnd(16) + (r.tl[0] || '(none)'));
  }
  console.log('');
  console.log('JSON ' + JSON.stringify(results.map(r => ({
    cpu: r.cpu, fp: Math.round(r.fp), fcp: Math.round(r.fcp), dcl: Math.round(r.dcl),
    load: Math.round(r.loadEnd), shell: Math.round(r.shell), feed: Math.round(r.feed),
    marks: Object.fromEntries(Object.entries(r.marks).map(([k, v]) => [k, Math.round(v)])),
    timeline: r.tl[0] || '',
  }))));
})().catch(e => {
  console.error(e);
  process.exit(1);
});
