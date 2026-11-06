#!/usr/bin/env node
/*
 * LiquidTube frame-cost bench — what one scroll frame costs the main thread,
 * measured with the compositor out of the way.
 *
 * `tools/scroll-fps-bench.js` reports the frame's cost inside a real scroll, but
 * in a pod with no GPU the software raster of a full-screen gradient sits on the
 * same main thread and the spread between two runs of the same build is wider
 * than most changes. This tool takes the raster out of the picture: it steps the
 * scroll position and calls the frame's entry point directly, N times, and
 * reports the distribution of that call alone. Nothing is scheduled, nothing is
 * painted between the calls, so the number is the frame's own script + layout.
 *
 * It is an A/B tool: give it two builds and it interleaves them (round-robin, so
 * a drifting pod cannot favour one), and prints one line per run.
 *
 *   npm i puppeteer-core                     # dev only, not shipped in the APK
 *   node tools/frame-cost-bench.js before.html after.html
 *   ROUNDS=3 N=200 CPU=4 node tools/frame-cost-bench.js a.html b.html
 *
 * Env: N frames per run (default 200), ROUNDS per build (default 3), CPU throttle
 * (default 4), CHROME path.
 *
 * Exit code 1 if the two builds differ by more than the run-to-run spread of the
 * same build (i.e. a regression this tool can actually resolve).
 */
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const A = process.argv[2];
const B = process.argv[3];
if (!A || !B) {
  console.error('usage: node tools/frame-cost-bench.js <build-a.html> <build-b.html>');
  process.exit(2);
}
const N = Math.max(20, +(process.env.N || 200));
const ROUNDS = Math.max(1, +(process.env.ROUNDS || 3));
const CPU = Math.max(1, +(process.env.CPU || 4));
const ORIGIN = 'liquidtube.local';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64'
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const vids = Array.from({ length: 24 }, (_, i) => 'v' + String(i + 1).padStart(2, '0') + 'AAAAAAAA');
const apiBody = (u) => {
  const p = new URL(u).pathname;
  if (p.endsWith('/videos')) {
    if ((new URL(u).searchParams.get('part') || '').includes('contentDetails'))
      return { items: vids.map((id) => ({ id, contentDetails: { duration: 'PT12M30S' } })) };
    return {
      items: vids.map((id, i) => ({
        id,
        snippet: {
          title: 'Sample trending video number ' + (i + 1),
          channelTitle: 'Channel ' + (i % 6),
          publishedAt: new Date(Date.now() - (i + 1) * 36e5).toISOString(),
        },
        statistics: { viewCount: '1000' },
      })),
    };
  }
  return { items: [] };
};

async function run(browser, file, label) {
  const HTML = fs.readFileSync(file);
  const page = await browser.newPage();
  await page.setViewport({ width: 412, height: 892, deviceScaleFactor: 1 });
  const cdp = await page.target().createCDPSession();
  if (CPU > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU });
  await page.setRequestInterception(true);
  page.on('request', async (req) => {
    const u = req.url();
    try {
      if (u.startsWith('https://' + ORIGIN + '/'))
        return await req.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: HTML });
      if (/googleapis\.com/.test(u)) {
        await sleep(150);
        return await req.respond({
          status: 200, contentType: 'application/json',
          headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(apiBody(u)),
        });
      }
      if (/ytimg\.com|ggpht\.com|googleusercontent\.com/.test(u))
        return await req.respond({ status: 200, contentType: 'image/png', body: PNG });
      return await req.abort();
    } catch (e) {}
  });
  await page.goto('https://' + ORIGIN + '/index.html', { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(
    () => document.getElementById('feed') && document.getElementById('feed').querySelector('.card'),
    { timeout: 60000 });
  await sleep(600);
  const r = await page.evaluate(async (n) => {
    const home = document.getElementById('p-home');
    const frame = () => new Promise((res) => requestAnimationFrame(res));
    home.scrollTop = 0;
    await frame(); await frame();
    const max = Math.max(1, home.scrollHeight - home.clientHeight);
    const T = [];
    for (let i = 0; i < n; i++) {
      /* A step the frame cannot mistake for the previous one: it must run its
         passes on every call. */
      home.scrollTop = ((i % 100) / 100) * max;
      const t = performance.now();
      window.frameRun();
      T.push(performance.now() - t);
    }
    T.sort((x, y) => x - y);
    const p = (q) => T[Math.min(T.length - 1, Math.floor(q * T.length))];
    return { p50: +p(0.5).toFixed(2), p95: +p(0.95).toFixed(2), max: +T[T.length - 1].toFixed(2), n: T.length };
  }, N);
  await page.close();
  return { label, file, ...r };
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME || '/usr/local/bin/google-chrome',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars'],
  });
  const runs = [];
  for (let i = 0; i < ROUNDS; i++) {
    runs.push(await run(browser, A, 'A ' + path.basename(A)));
    runs.push(await run(browser, B, 'B ' + path.basename(B)));
  }
  await browser.close();
  console.log('frame cost per direct frameRun() call — ' + CPU + 'x CPU throttle, ' + N + ' frames, ' +
    ROUNDS + ' rounds, interleaved');
  for (const r of runs) console.log(r.label.padEnd(28) + 'p50 ' + String(r.p50).padStart(6) +
    '  p95 ' + String(r.p95).padStart(6) + '  max ' + String(r.max).padStart(6) + '  (n ' + r.n + ')');
  const med = (k, l) => {
    const v = runs.filter((r) => r.label[0] === l).map((r) => r[k]).sort((x, y) => x - y);
    return v[Math.floor(v.length / 2)];
  };
  const spread = (k, l) => {
    const v = runs.filter((r) => r.label[0] === l).map((r) => r[k]);
    return Math.max.apply(null, v) - Math.min.apply(null, v);
  };
  const d50 = med('p50', 'B') - med('p50', 'A'), d95 = med('p95', 'B') - med('p95', 'A');
  console.log('');
  console.log('median of medians  p50 ' + med('p50', 'A') + ' → ' + med('p50', 'B') + ' ms (' +
    (d50 > 0 ? '+' : '') + d50.toFixed(2) + ')   p95 ' + med('p95', 'A') + ' → ' + med('p95', 'B') +
    ' ms (' + (d95 > 0 ? '+' : '') + d95.toFixed(2) + ')');
  console.log('run-to-run spread  A ' + spread('p50', 'A').toFixed(2) + '/' + spread('p95', 'A').toFixed(2) +
    '   B ' + spread('p50', 'B').toFixed(2) + '/' + spread('p95', 'B').toFixed(2) + ' ms (p50/p95)');
  if (d50 > spread('p50', 'A') || d95 > spread('p95', 'A')) {
    console.error('FAIL: build B is slower than build A by more than A\'s own run-to-run spread');
    process.exit(1);
  }
})().catch((e) => { console.error(e); process.exit(1); });
