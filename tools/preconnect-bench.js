#!/usr/bin/env node
/*
 * LiquidTube origin-warmup bench — what a boot-time preconnect actually buys.
 *
 * `tools/startup-bench.js` mocks every request inside the browser, so it cannot
 * see connection setup at all: DNS + TCP + TLS is exactly the cost a
 * `<link rel="preconnect">` removes, and intercepting the request hides it.
 * This bench serves the page and both remote origins over real HTTPS on real
 * sockets, and puts a delay in front of each remote origin that stalls the
 * handshake — the mobile reality of a cold DNS lookup and a 100-200 ms RTT.
 *
 *   page     https://liquidtube.local/index.html    (the build under test)
 *   api      https://www.googleapis.com/youtube/v3/ (fixtures, 150 ms think time)
 *   images   https://i.ytimg.com/vi/...             (1x1 PNG)
 *
 * Each remote origin sits behind a TCP shim that holds the socket for
 * CONNECT_DELAY ms before forwarding, so a connection established on demand
 * costs CONNECT_DELAY ms of the caller's critical path, and a connection
 * established ahead of time costs the caller nothing.
 *
 * Every run gets a brand-new browser: the browser process pools sockets per
 * origin and profile, so a connection left open by the previous run would be
 * reused and the cost this bench measures would disappear.
 *
 * Reported per build (ms from navigation start):
 *   shell   #app.ready — the shell is visible
 *   feed    first .card in #feed
 *   apiReq  the first googleapis request: fetchStart -> requestStart, i.e.
 *           everything the fetch waited for before its bytes left (0 means the
 *           connection was already established when the fetch was issued)
 *   apiDone the first googleapis request: responseEnd
 *   imgReq  the first thumbnail: fetchStart -> requestStart
 *
 * Usage:
 *   node tools/preconnect-bench.js <buildA.html> [buildB.html] [connectDelayMs] [reps]
 *     A is served at /index.html and B at /b/index.html, alternately in the same
 *     process so host drift cancels out.
 *
 * Needs: openssl on PATH, a Chrome/Chromium binary (CHROME=...), puppeteer-core.
 */
const fs = require('fs');
const https = require('https');
const net = require('net');
const path = require('path');
const { execFileSync } = require('child_process');
const puppeteer = require('puppeteer-core');

const BUILD_A = process.argv[2] || path.join(__dirname, '..', 'app/assets/index.html');
const BUILD_B = process.argv[3] || '';
const CONNECT_DELAY = +(process.argv[4] || 150);
const REPS = Math.max(1, +(process.argv[5] || 3));
const API_DELAY = 150;

const P_PAGE = 18443, P_API = 18444, P_IMG = 18445;      // real TLS servers
const P_API_SHIM = 19444, P_IMG_SHIM = 19445;            // delayed fronts

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64');

/* ---------- fixtures: same shape as tools/startup-bench.js ---------- */
const pad = n => String(n).padStart(2, '0');
const vids = Array.from({ length: 24 }, (_, i) => 'v' + pad(i + 1) + 'AAAAAAAA');
const CH_IDS = Array.from({ length: 6 }, (_, i) => 'UC' + i + 'xxxxxxxxxxxxxxxxxxxx');
const ago = h => new Date(Date.now() - h * 36e5).toISOString();

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
  const p = new URL(url).pathname;
  if (p.endsWith('/videos')) {
    if (/contentDetails/.test(url)) {
      return { items: vids.map(id => ({ id, contentDetails: { duration: 'PT12M30S' } })) };
    }
    return {
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
    };
  }
  if (p.endsWith('/channels')) {
    return chanAnswer(url, {
      items: CH_IDS.map((id, i) => ({
        id,
        snippet: {
          title: 'Channel ' + i,
          customUrl: 'channel' + i,
          publishedAt: '2019-04-02T10:00:00Z',
          country: 'IN',
          description: 'A channel',
          thumbnails: { medium: { url: 'https://yt3.googleusercontent.com/a' + i } },
        },
        statistics: { subscriberCount: String(1e5 * (i + 1)), videoCount: '120', viewCount: '9000000' },
        contentDetails: { relatedPlaylists: { uploads: 'UU' + i } },
        brandingSettings: { image: { bannerExternalUrl: '' }, channel: {} },
      })),
    });
  }
  if (p.endsWith('/playlistItems')) {
    return {
      items: vids.slice(0, 12).map((id, i) => ({
        snippet: {
          title: 'Upload ' + (i + 1),
          channelTitle: 'Channel ' + (i % 6),
          channelId: CH_IDS[i % 6],
          publishedAt: ago(i + 3),
          thumbnails: { medium: { url: 'https://i.ytimg.com/vi/' + id + '/mqdefault.jpg' } },
        },
        contentDetails: { videoId: id },
      })),
    };
  }
  if (p.endsWith('/search')) {
    return {
      items: vids.slice(0, 20).map((id, i) => ({
        id: { videoId: id },
        snippet: {
          title: 'Result ' + (i + 1),
          channelTitle: 'Channel ' + (i % 6),
          channelId: CH_IDS[i % 6],
          publishedAt: ago(i + 2),
          thumbnails: { medium: { url: 'https://i.ytimg.com/vi/' + id + '/mqdefault.jpg' } },
        },
      })),
    };
  }
  return {};
}

/* ---------- servers ---------- */
const sleep = ms => new Promise(r => setTimeout(r, ms));
let CERT = null;

function cert() {
  if (CERT) return CERT;
  const dir = fs.mkdtempSync('/tmp/ltpc-');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem'), '-days', '2',
    '-subj', '/CN=liquidtube.local',
    '-addext', 'subjectAltName=DNS:liquidtube.local,DNS:www.googleapis.com,DNS:i.ytimg.com'],
  { stdio: 'ignore' });
  CERT = { key: fs.readFileSync(path.join(dir, 'k.pem')), cert: fs.readFileSync(path.join(dir, 'c.pem')) };
  return CERT;
}

function tlsServer(port, handler) {
  return new Promise(res => {
    const s = https.createServer(cert(), handler);
    s.listen(port, '127.0.0.1', () => res(s));
  });
}

/** Holds every new socket for `delay` ms before connecting it upstream. */
function delayShim(port, targetPort, delay) {
  return new Promise(res => {
    const s = net.createServer(client => {
      client.pause();
      setTimeout(() => {
        const up = net.connect(targetPort, '127.0.0.1');
        up.on('error', () => client.destroy());
        client.on('error', () => up.destroy());
        client.pipe(up); up.pipe(client);
        client.resume();
      }, delay);
    });
    s.listen(port, '127.0.0.1', () => res(s));
  });
}

/* ---------- one cold run, in its own browser ---------- */
async function run(build, cpu) {
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME || '/usr/local/bin/google-chrome',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--hide-scrollbars',
      // every origin here is local; a proxy from the environment would break them
      '--proxy-server=direct://', '--proxy-bypass-list=*',
      '--ignore-certificate-errors',
      '--host-resolver-rules=MAP liquidtube.local 127.0.0.1:' + P_PAGE +
      ',MAP www.googleapis.com 127.0.0.1:' + P_API_SHIM +
      ',MAP i.ytimg.com 127.0.0.1:' + P_IMG_SHIM],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 412, height: 892, deviceScaleFactor: 2 });
  if (cpu > 1) {
    const cdp = await page.target().createCDPSession();
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu });
  }
  await page.evaluateOnNewDocument(() => {
    window.__b = { shell: 0, feed: 0 };
    const probe = () => {
      const app = document.getElementById('app');
      const feed = document.getElementById('feed');
      if (app && !window.__b.shell && app.classList.contains('ready')) window.__b.shell = performance.now();
      if (feed && !window.__b.feed && feed.querySelector('.card')) window.__b.feed = performance.now();
      return !!(window.__b.shell && window.__b.feed);
    };
    const tick = () => { if (!probe()) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    const iv = setInterval(() => { if (probe()) clearInterval(iv); }, 8);
  });

  await page.goto('https://liquidtube.local:' + P_PAGE + build.path,
    { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction('window.__b.feed > 0', { timeout: 60000 });
  // thumbnails are loading=lazy, so give the first ones time to be requested
  await page.waitForFunction(
    "performance.getEntriesByType('resource').some(e => /ytimg/.test(e.name))",
    { timeout: 5000 }).catch(() => {});
  await sleep(250);

  const r = await page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0] || {};
    const marks = {};
    performance.getEntriesByType('mark').forEach(m => {
      if (m.name.indexOf('lt:') === 0) marks[m.name.slice(3)] = m.startTime;
    });
    const res = performance.getEntriesByType('resource').map(e => ({
      n: e.name, init: e.initiatorType,
      fs: e.fetchStart, ds: e.domainLookupStart, cs: e.connectStart,
      ce: e.connectEnd, ss: e.secureConnectionStart, rs: e.requestStart,
      re: e.responseEnd, nhp: e.nextHopProtocol,
    }));
    const api = res.filter(e => /googleapis/.test(e.n)).sort((a, b) => a.fs - b.fs)[0] || null;
    const imgs = res.filter(e => /ytimg/.test(e.n)).sort((a, b) => a.fs - b.fs);
    return {
      marks, dcl: nav.domContentLoadedEventEnd || 0, loadEnd: nav.loadEventEnd || 0,
      shell: window.__b.shell, feed: window.__b.feed,
      cards: document.querySelectorAll('#feed .card').length,
      api, imgFirst: imgs[0] || null, imgCount: imgs.length, all: res,
    };
  });
  await page.close();
  await browser.close();
  return r;
}

/* ---------- main ---------- */
(async () => {
  const builds = [{ name: 'A', file: BUILD_A, html: fs.readFileSync(BUILD_A), path: '/index.html' }];
  if (BUILD_B) {
    builds.push({ name: 'B', file: BUILD_B, html: fs.readFileSync(BUILD_B), path: '/b/index.html' });
  }

  // /index.html serves build A, /b/index.html serves build B
  await tlsServer(P_PAGE, (req, res) => {
    const want = /^\/b\//.test(req.url) && builds[1] ? builds[1] : builds[0];
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(want.html);
  });
  await tlsServer(P_API, async (req, res) => {
    await sleep(API_DELAY);
    // Timing-Allow-Origin is what lets the page see connect/request timings at
    // all; without it every cross-origin timing attribute is zeroed.
    res.writeHead(200, {
      'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*',
      'Timing-Allow-Origin': '*',
    });
    res.end(JSON.stringify(apiBody('https://www.googleapis.com' + req.url)));
  });
  await tlsServer(P_IMG, (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'image/png', 'Cache-Control': 'max-age=600', 'Timing-Allow-Origin': '*',
    });
    res.end(PNG);
  });
  await delayShim(P_API_SHIM, P_API, CONNECT_DELAY);
  await delayShim(P_IMG_SHIM, P_IMG, CONNECT_DELAY);

  const median = a => {
    const s = a.slice().sort((x, y) => x - y);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  const out = builds.map(b => ({ name: b.name, file: path.basename(b.file), runs: [] }));

  // one discarded warm-up so the first measured run does not pay for a cold page cache
  await run(builds[0], 1);

  for (let i = 0; i < REPS; i++) {
    for (let k = 0; k < builds.length; k++) {
      // alternate the order so one build never always runs in the same slot
      const idx = i % 2 === 0 ? k : builds.length - 1 - k;
      out[idx].runs.push(await run(builds[idx], 4));
    }
  }

  const f = n => String(Math.round(n)).padStart(8);
  console.log('LiquidTube origin-warmup bench — ' + CONNECT_DELAY + ' ms simulated cold connection, ' +
    'API think time ' + API_DELAY + ' ms, 4x CPU throttle, ' + REPS + ' interleaved runs per build');
  console.log('');
  console.log('build'.padEnd(14) + 'shell'.padStart(8) + 'feed'.padStart(8) +
    'apiReq'.padStart(8) + 'apiDone'.padStart(8) + 'imgReq'.padStart(8) + 'cards'.padStart(6));
  for (const b of out) {
    const pick = fn => median(b.runs.map(fn).filter(v => v != null && !isNaN(v)));
    console.log((b.name + ' ' + b.file).slice(0, 13).padEnd(14) +
      f(pick(r => r.shell)) + f(pick(r => r.feed)) +
      f(pick(r => r.api ? r.api.rs - r.api.fs : null)) +
      f(pick(r => r.api ? r.api.re : null)) +
      f(pick(r => r.imgFirst ? r.imgFirst.rs - r.imgFirst.fs : null)) +
      String(b.runs[0].cards).padStart(6));
  }
  console.log('');
  console.log('apiReq  = first API fetch: fetchStart -> requestStart (what the fetch waited for');
  console.log('          before its bytes left; ~0 means the socket was already open)');
  console.log('imgReq  = first thumbnail: fetchStart -> requestStart');
  console.log('');
  if (process.env.DUMP) console.log('RES ' + JSON.stringify(out[0].runs[0].all, null, 1));
  console.log('JSON ' + JSON.stringify(out.map(b => ({
    name: b.name, file: b.file,
    shell: Math.round(median(b.runs.map(r => r.shell))),
    feed: Math.round(median(b.runs.map(r => r.feed))),
    api: b.runs.map(r => r.api && {
      pre: Math.round(r.api.rs - r.api.fs), done: Math.round(r.api.re),
      conn: Math.round(r.api.ce - r.api.cs), nhp: r.api.nhp,
    }),
    img: b.runs.map(r => r.imgFirst && {
      pre: Math.round(r.imgFirst.rs - r.imgFirst.fs), start: Math.round(r.imgFirst.fs),
    }),
    cards: b.runs.map(r => r.cards),
  }))));
  // the fixture servers are still listening, so end the process explicitly
  process.exit(0);
})();
