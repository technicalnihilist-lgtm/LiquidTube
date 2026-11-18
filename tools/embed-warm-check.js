#!/usr/bin/env node
/*
 * LiquidTube embed-origin warmup check — item 8.8 ("preconnect to
 * youtube-nocookie.com on first play").
 *
 * The player talks to the third and last origin this app uses, and it was the
 * only one nothing warmed: `www.googleapis.com` and `i.ytimg.com` are preconnected
 * in the head (item 1.7), so the feed's fetch and the first thumbnails skip their
 * lookup and handshake, but `www.youtube-nocookie.com` was first contacted at the
 * instant a video was opened.
 *
 * What this tool checks, per build, in a real browser with real sockets:
 *
 *   host      exactly one pair of warm links — one `preconnect`, one
 *             `dns-prefetch` — and both for the host every embed URL is built
 *             from (`EMBED_ORIGIN`), so the warmed host cannot drift from the
 *             played one
 *   when      the `embedwarm` timeline mark exists, lands after the first frame
 *             (not on the boot's critical path) and before the first play
 *   once      a second and third play add no further links: the warm is
 *             idempotent, so a burst of taps issues nothing
 *   no-request  the warm sends no request: the embed origin accepts zero sockets
 *             between the first paint and the play (a preconnect is a hint, and
 *             this build does not turn it into traffic)
 *   unchanged the embed document's URL is byte-identical to the previous build's,
 *             one iframe is built, and the page's card count and scroll height are
 *             the same — no visual change
 *   timing    the embed navigation's own timing (connect, request wait) for both
 *             builds side by side, so a regression in first-play latency shows
 *
 * The harness serves the page and the embed origin over real HTTPS on real
 * sockets and puts a TCP shim in front of the embed origin that holds every new
 * socket for CONNECT_DELAY ms — a cold lookup plus a 100-200 ms RTT. The first
 * video is played ~700 ms after the feed paints, a real user's pace.
 *
 * A finding worth recording: Chrome 158 in this pod opens **no socket at all**
 * for `<link rel=preconnect>` to a cross-origin host (plain, `crossorigin` and
 * `use-credentials` alike), while a `preload` to the same host in the same
 * harness opens one — so the harness sees speculative traffic and the browser is
 * the part declining the hint. Chromium also pools sockets per network isolation
 * key, so a socket the top document opens is not the one a cross-origin iframe
 * navigates on. Both say the same thing: what this build can rely on is the
 * `dns-prefetch` half of the pair, and that is what the log claims — not a
 * handshake saving.
 *
 * Usage:
 *   npm i puppeteer-core                    # dev only, not shipped in the APK
 *   CHROME=/path/to/chrome node tools/embed-warm-check.js <build-a.html> [build-b.html] [connectDelayMs] [reps]
 * Prints one table and one JSON object; with two builds it compares them and
 * exits 1 when the build under test (the first file) fails a check.
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
const PLAY_AT = 700;                       // ms after the feed paints: the user's own pace
const EMBED_ORIGIN = 'https://www.youtube-nocookie.com';

const P_PAGE = 18473, P_API = 18474, P_EMB = 18475;   // real TLS servers
const P_EMB_SHIM = 19475;                             // delayed front for the embed

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64');

/* ---------- fixtures: same shape as tools/startup-bench.js ---------- */
const pad = n => String(n).padStart(2, '0');
const vids = Array.from({ length: 24 }, (_, i) => 'v' + pad(i + 1) + 'AAAAAAAA');
const CH_IDS = Array.from({ length: 6 }, (_, i) => 'UC' + i + 'xxxxxxxxxxxxxxxxxxxx');
const ago = h => new Date(Date.now() - h * 36e5).toISOString();

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
    return {
      items: CH_IDS.map((id, i) => ({
        id,
        snippet: {
          title: 'Channel ' + i, customUrl: 'channel' + i, publishedAt: '2019-04-02T10:00:00Z',
          country: 'IN', description: 'A channel',
          thumbnails: { medium: { url: 'https://yt3.googleusercontent.com/a' + i } },
        },
        statistics: { subscriberCount: String(1e5 * (i + 1)), videoCount: '120', viewCount: '9000000' },
        contentDetails: { relatedPlaylists: { uploads: 'UU' + i } },
        brandingSettings: { image: { bannerExternalUrl: '' }, channel: {} },
      })),
    };
  }
  if (p.endsWith('/playlistItems')) {
    return {
      items: vids.slice(0, 12).map((id, i) => ({
        snippet: {
          title: 'Upload ' + (i + 1), channelTitle: 'Channel ' + (i % 6),
          channelId: CH_IDS[i % 6], publishedAt: ago(i + 3),
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
          title: 'Result ' + (i + 1), channelTitle: 'Channel ' + (i % 6),
          channelId: CH_IDS[i % 6], publishedAt: ago(i + 2),
          thumbnails: { medium: { url: 'https://i.ytimg.com/vi/' + id + '/mqdefault.jpg' } },
        },
      })),
    };
  }
  return {};
}

/* The embed document: it is the thing the player cannot start without, so it
   answers with a page that reports its own navigation timing and says hello the
   way the real embed does. Nothing here needs to be a video. */
const EMBED_HTML = `<!doctype html><html><body>
<script>
  window.__nav = (function(){
    var e = performance.getEntriesByType('navigation')[0] || {};
    return { fs:e.fetchStart, dls:e.domainLookupStart, dle:e.domainLookupEnd,
      cs:e.connectStart, ce:e.connectEnd, ss:e.secureConnectionStart,
      rs:e.requestStart, re:e.responseEnd, nhp:e.nextHopProtocol };
  })();
  try{ parent.postMessage(JSON.stringify({event:'listening'}), '*'); }catch(e){}
</script></body></html>`;

/* ---------- servers ---------- */
const sleep = ms => new Promise(r => setTimeout(r, ms));
let CERT = null;

function cert() {
  if (CERT) return CERT;
  const dir = fs.mkdtempSync('/tmp/ltwarm-');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem'), '-days', '2',
    '-subj', '/CN=liquidtube.local',
    '-addext', 'subjectAltName=DNS:liquidtube.local,DNS:www.googleapis.com,' +
      'DNS:i.ytimg.com,DNS:www.youtube-nocookie.com'],
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

/* Holds every new socket for `delay` ms before connecting it upstream, and
   counts them: the count is the only way to say *who* opened a connection to the
   embed origin — the warmup, or the iframe's navigation. */
const SHIM = { conns: 0 };
function delayShim(port, targetPort, delay) {
  return new Promise(res => {
    const s = net.createServer(client => {
      SHIM.conns++;
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
async function run(build) {
  SHIM.conns = 0;
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME || '/usr/local/bin/google-chrome',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--hide-scrollbars',
      '--proxy-server=direct://', '--proxy-bypass-list=*',
      '--ignore-certificate-errors',
      '--host-resolver-rules=MAP liquidtube.local 127.0.0.1:' + P_PAGE +
      ',MAP www.googleapis.com 127.0.0.1:' + P_API +
      ',MAP i.ytimg.com 127.0.0.1:' + P_PAGE +
      ',MAP www.youtube-nocookie.com 127.0.0.1:' + P_EMB_SHIM],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 412, height: 892, deviceScaleFactor: 2 });

  await page.goto('https://liquidtube.local:' + P_PAGE + build.path,
    { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction("document.querySelector('#feed .card')", { timeout: 60000 });
  /* The user's own pace: the feed is on screen and the first play comes a beat
     later, which is the window a warmup has to be useful in. */
  await sleep(PLAY_AT);

  const before = await page.evaluate(() => {
    const marks = {};
    performance.getEntriesByType('mark').forEach(m => {
      if (m.name.indexOf('lt:') === 0) marks[m.name.slice(3)] = Math.round(m.startTime);
    });
    const warm = Array.prototype.slice.call(
      document.querySelectorAll('link[data-warm="embed"]'))
      .map(l => ({ rel: l.rel, href: l.getAttribute('href') }));
    const allPre = Array.prototype.slice.call(document.querySelectorAll('link[rel="preconnect"]'))
      .map(l => l.getAttribute('href'));
    const card = document.querySelector('#feed .card');
    return {
      warm, allPre, warmAt: marks.embedwarm || 0, marks,
      id: card ? card.dataset.v : '',
      cards: document.querySelectorAll('#feed .card').length,
      height: document.documentElement.scrollHeight,
    };
  });

  const socksWarm = SHIM.conns;              /* sockets the warmup opened, if any */
  const tPlay = await page.evaluate(id => {
    const t = performance.now();
    try { play(id); } catch (e) { return { t, err: String(e && e.message) }; }
    return { t };
  }, before.id);

  /* Wait for the embed frame's document to have run, then read its own
     navigation timing from inside the frame, where the cross-origin boundary
     does not zero it. */
  let nav = null;
  for (let i = 0; i < 60 && !nav; i++) {
    await sleep(100);
    for (const f of page.frames()) {
      if (!/youtube-nocookie/.test(f.url())) continue;
      try { nav = await f.evaluate(() => window.__nav || null); } catch (e) { /* still navigating */ }
      if (nav) break;
    }
  }
  const socksNav = SHIM.conns - socksWarm;

  /* Two more plays: the warm must not answer a second or third time. */
  const after = await page.evaluate(ids => {
    ids.forEach(id => { try { play(id); } catch (e) { /* reported by the caller */ } });
    const warm = Array.prototype.slice.call(
      document.querySelectorAll('link[data-warm="embed"]'))
      .map(l => ({ rel: l.rel, href: l.getAttribute('href') }));
    const f = document.querySelector('#pl iframe');
    return {
      warm, warmAfterPlays: warm.length,
      frames: document.querySelectorAll('#pl iframe').length,
      src: f ? f.getAttribute('src') : '',
      cards: document.querySelectorAll('#feed .card').length,
      height: document.documentElement.scrollHeight,
    };
  }, [before.id, before.id].map((v, i) => (i === 0 ? v : (vids[1] || v))));

  await page.close();
  await browser.close();
  return { before, after, tPlay, nav, socksWarm, socksNav };
}

/* ---------- main ---------- */
(async () => {
  const builds = [{ name: 'A', file: BUILD_A, html: fs.readFileSync(BUILD_A), path: '/index.html' }];
  if (BUILD_B) {
    builds.push({ name: 'B', file: BUILD_B, html: fs.readFileSync(BUILD_B), path: '/b/index.html' });
  }

  await tlsServer(P_PAGE, (req, res) => {
    if (/^\/vi\//.test(req.url) || /ytimg|ggpht/.test(req.url)) {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=600' });
      return res.end(PNG);
    }
    const want = /^\/b\//.test(req.url) && builds[1] ? builds[1] : builds[0];
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(want.html);
  });
  await tlsServer(P_API, (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*',
      'Timing-Allow-Origin': '*',
    });
    res.end(JSON.stringify(apiBody('https://www.googleapis.com' + req.url)));
  });
  await tlsServer(P_EMB, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(EMBED_HTML);
  });
  await delayShim(P_EMB_SHIM, P_EMB, CONNECT_DELAY);

  const median = a => {
    const s = a.slice().sort((x, y) => x - y);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  const d = v => (v == null || isNaN(v)) ? null : Math.max(0, Math.round(v));
  const out = builds.map(b => ({ name: b.name, file: path.basename(b.file), runs: [] }));

  await run(builds[0]);                       // one discarded warm-up

  for (let i = 0; i < REPS; i++) {
    for (let k = 0; k < builds.length; k++) {
      const idx = i % 2 === 0 ? k : builds.length - 1 - k;
      out[idx].runs.push(await run(builds[idx]));
    }
  }

  const f = n => String(n == null ? '-' : Math.round(n)).padStart(8);
  const pre = r => r.before.warm.filter(l => l.rel === 'preconnect').length;
  const dns = r => r.before.warm.filter(l => l.rel === 'dns-prefetch').length;

  console.log('LiquidTube embed-origin warmup check — ' + CONNECT_DELAY +
    ' ms simulated cold connection to ' + EMBED_ORIGIN + ', first play ' + PLAY_AT +
    ' ms after the feed paints, ' + REPS + ' interleaved runs per build');
  console.log('');
  console.log('build'.padEnd(20) + 'warmAt'.padStart(8) + 'playAt'.padStart(8) +
    'links'.padStart(7) + 'links2'.padStart(8) + 'sockW'.padStart(7) +
    'sockN'.padStart(7) + 'conn'.padStart(8) + 'wait'.padStart(8) + 'cards'.padStart(7));
  for (const b of out) {
    const pick = k => median(b.runs.map(k).filter(v => v != null && !isNaN(v)));
    console.log((b.name + ' ' + b.file).slice(0, 19).padEnd(20) +
      f(pick(r => r.before.warmAt || null)) +
      f(pick(r => r.tPlay.t)) +
      f(pick(r => r.before.warm.length)) +
      f(pick(r => r.after.warmAfterPlays)) +
      f(pick(r => r.socksWarm)) +
      f(pick(r => r.socksNav)) +
      f(pick(r => r.nav ? d(r.nav.ce - r.nav.cs) : null)) +
      f(pick(r => r.nav ? d(r.nav.rs - r.nav.fs) : null)) +
      f(pick(r => r.before.cards)));
  }
  console.log('');
  console.log('links    = warm links the document holds before the first play (1 preconnect + 1 dns-prefetch)');
  console.log('links2   = the same count after two more plays: the warm answers once');
  console.log('sockW    = sockets the embed origin accepted between the first paint and the play');
  console.log('           (0 = the warm sends no request)');
  console.log('sockN    = sockets it accepted for the play itself (1 = the navigation opened its own)');
  console.log('conn     = the embed document\'s own connect time, measured inside the iframe');
  console.log('wait     = requestStart - fetchStart: what the navigation waited for');
  console.log('');

  const host = r => r.before.warm.every(l => l.href === EMBED_ORIGIN);
  const checks = out.map(b => {
    const r = b.runs;
    return {
      build: b.name + ' ' + b.file,
      onePair: r.every(x => pre(x) === 1 && dns(x) === 1),
      rightHost: r.every(host),
      warmMarked: r.every(x => x.before.warmAt > 0),
      afterFirstFrame: r.every(x => x.before.marks.feedpaint == null ||
        x.before.warmAt >= x.before.marks.feedpaint),
      beforePlay: r.every(x => x.before.warmAt > 0 && x.before.warmAt < x.tPlay.t),
      once: r.every(x => x.after.warmAfterPlays === (x.before.warm.length)),
      noRequest: r.every(x => x.socksWarm === 0),
      oneFrame: r.every(x => x.after.frames === 1),
      sameSrc: r[0].after.src,
      sameCards: r.every(x => x.before.cards === r[0].before.cards &&
        x.after.cards === r[0].before.cards),
      sameHeight: r.every(x => x.before.height === r[0].before.height),
      nav: r.map(x => x.nav && {
        conn: d(x.nav.ce - x.nav.cs), wait: d(x.nav.rs - x.nav.fs),
        nhp: x.nav.nhp,
      }),
    };
  });

  for (const c of checks) {
    const bad = ['onePair', 'rightHost', 'warmMarked', 'afterFirstFrame', 'beforePlay',
      'once', 'noRequest', 'oneFrame', 'sameCards', 'sameHeight'].filter(k => !c[k]);
    console.log((c.build + ' ').padEnd(40) + (bad.length ? 'FAIL ' + bad.join(',') : 'ok'));
  }
  console.log('');

  if (checks[1]) {
    const a = checks[0], b = checks[1];
    console.log('embed src identical: ' + (a.sameSrc === b.sameSrc));
    const wa = median(a.nav.filter(Boolean).map(n => n.wait));
    const wb = median(b.nav.filter(Boolean).map(n => n.wait));
    const ca = median(a.nav.filter(Boolean).map(n => n.conn));
    const cb = median(b.nav.filter(Boolean).map(n => n.conn));
    console.log('first-play embed wait  A ' + Math.round(wa) + ' ms -> B ' + Math.round(wb) +
      ' ms | connect A ' + Math.round(ca) + ' ms -> B ' + Math.round(cb) + ' ms');
    console.log('(unchanged is the expected result: this harness\'s Chrome honours neither');
    console.log(' hint for a cross-origin host — see the header — so the pair cannot show a');
    console.log(' handshake saving here, and must not show a regression either)');
    console.log('');
  }
  console.log('JSON ' + JSON.stringify({ delay: CONNECT_DELAY, checks }));
  const failed = checks[0] && ['onePair', 'rightHost', 'warmMarked', 'afterFirstFrame',
    'beforePlay', 'once', 'noRequest', 'oneFrame', 'sameCards', 'sameHeight']
    .some(k => !checks[0][k]);
  process.exit(failed ? 1 : 0);
})();
