#!/usr/bin/env node
/*
 * LiquidTube off-screen card check — item 3.3.
 *
 * Proves that `content-visibility:auto` on the feed cards really skips the ones
 * nobody can see, and that it skips them *without* changing what is on screen.
 * Run it against two builds and diff the JSON: the numbers that must match
 * (markup, visible geometry, scroll height) are printed first, the ones that
 * should improve (rendered cards per frame, layout/paint time while scrolling)
 * after them.
 *
 *   node tools/content-visibility-check.js app/assets/index.html
 *   node tools/content-visibility-check.js /tmp/old/index.html
 *
 * How "is this card rendered?" is answered without answering it the wrong way:
 * any query that would tell us directly (getBoundingClientRect, offsetHeight,
 * getAnimations on the card or a child, checkVisibility with
 * contentVisibilityAuto) forces the browser to render the skipped subtree, so
 * asking would destroy the thing being measured. Instead the tool appends a
 * one-pixel element with an infinite CSS animation to every card: CSS animations
 * inside skipped content do not run, so `document.getAnimations()` — a global
 * read that renders nothing — lists exactly the cards that are rendered. The
 * probe element is added by the tool in the browser only; the build is untouched.
 */
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const FILE = process.argv[2] || path.join(__dirname, '..', 'app/assets/index.html');
const HTML = fs.readFileSync(FILE);
const ORIGIN = 'liquidtube.local';
// A real 640x360 PNG, built here so the tool needs no binary fixture.
const PNG = (() => {
  const W = 640, H = 360, zlib = require('zlib');
  const crc = buf => {
    let c, t = [];
    for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    let x = 0xffffffff;
    for (const b of buf) x = t[(x ^ b) & 0xff] ^ (x >>> 8);
    return (x ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const row = Buffer.alloc(1 + W * 3);
  for (let x = 0; x < W; x++) { const o = 1 + x * 3; row[o] = 40; row[o + 1] = 44; row[o + 2] = 60; }
  const raw = Buffer.concat(Array.from({ length: H }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
})();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const pad = n => String(n).padStart(2, '0');
const vids = Array.from({ length: 24 }, (_, i) => 'v' + pad(i + 1) + 'AAAAAAAA');
const CH_IDS = Array.from({ length: 6 }, (_, i) => 'UC' + i + 'xxxxxxxxxxxxxxxxxxxx');
const pub = d => new Date(Date.UTC(2026, 9, 31) - d * 864e5).toISOString();
const item = i => ({
  id: vids[i % vids.length],
  snippet: {
    title: 'Video number ' + (i + 1) + ' about something long enough to wrap a line',
    channelId: CH_IDS[i % CH_IDS.length],
    channelTitle: 'Channel ' + (i % 6),
    publishedAt: pub(i),
  },
  statistics: { viewCount: String(1000 * (i + 1)) },
  contentDetails: { duration: 'PT4M' + pad(i) + 'S' },
});
const apiBody = u => {
  const p = u.split('googleapis.com')[1].split('?')[0];
  if (p.endsWith('/videos')) return { items: Array.from({ length: 24 }, (_, i) => item(i)) };
  if (p.endsWith('/channels')) return { items: CH_IDS.map((id, i) => ({ id, snippet: { title: 'Channel ' + i, thumbnails: { default: { url: 'https://ytimg.com/a.png' } } } })) };
  if (p.endsWith('/playlistItems')) return { items: Array.from({ length: 6 }, (_, i) => ({ snippet: { resourceId: { videoId: vids[i] } } })) };
  if (p.endsWith('/search')) return { items: [] };
  return {};
};

(async () => {
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME || '/usr/bin/google-chrome',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--hide-scrollbars'],
  });
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
  await sleep(1200);

  const cdp = await page.target().createCDPSession();
  await cdp.send('Performance.enable');
  const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));

  /* Style facts, plus the geometry of the cards the user can actually see. Read
     once, before the animation probes exist, so nothing here can render a card
     that would otherwise have been skipped. */
  const style = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('.card')];
    const cv = new Set(cards.map(c => getComputedStyle(c).contentVisibility));
    const cis = new Set(cards.map(c => getComputedStyle(c).containIntrinsicSize));
    const pg = document.querySelector('.page:not([inert])');
    const feed = document.getElementById('feed');
    const vis = [...document.querySelectorAll('#feed .card')]
      .map(c => c.getBoundingClientRect())
      .filter(r => r.bottom > 0 && r.top < innerHeight)
      .map(r => ({ top: +r.top.toFixed(1), h: +r.height.toFixed(1) }));
    return {
      cards: cards.length,
      contentVisibility: [...cv],
      containIntrinsicSize: [...cis],
      pageScrollHeight: pg ? pg.scrollHeight : null,
      feedScrollHeight: feed ? feed.scrollHeight : null,
      visibleCards: vis,
      docScrollHeight: document.documentElement.scrollHeight,
    };
  });

  /* Render counting. One probe element per card, one global read per sample. */
  await page.evaluate(() => {
    const st = document.createElement('style');
    st.textContent = '@keyframes ltcvprobe{to{opacity:.6}}';
    document.head.appendChild(st);
    document.querySelectorAll('.card').forEach((c, i) => {
      const p = document.createElement('i');
      p.className = 'lt-cv-probe';
      p.dataset.i = i;
      p.style.cssText = 'position:absolute;width:1px;height:1px;animation:ltcvprobe 3s linear infinite';
      c.appendChild(p);
    });
  });
  const sample = async label => {
    await sleep(120);
    const rendered = await page.evaluate(() => {
      const seen = new Set();
      for (const a of document.getAnimations()) {
        const t = a.effect && a.effect.target;
        if (t && t.classList && t.classList.contains('lt-cv-probe')) seen.add(+t.dataset.i);
      }
      const cards = document.querySelectorAll('.card').length;
      const pg = document.querySelector('.page:not([inert])');
      return { label: null, rendered: seen.size, cards, scrollTop: pg ? Math.round(pg.scrollTop) : null };
    });
    return Object.assign({ label }, rendered);
  };

  const frames = [];
  frames.push(await sample('top'));
  /* Scroll the feed in a few jumps; after each, one full frame pass of the app's
     own scroll work, then count what is rendered. */
  for (const frac of [0.25, 0.5, 0.75, 1]) {
    await page.evaluate(f => {
      const pg = document.querySelector('.page:not([inert])');
      pg.scrollTop = Math.round((pg.scrollHeight - innerHeight) * f);
      pg.dispatchEvent(new Event('scroll'));
    }, frac);
    await sleep(160);
    frames.push(await sample('scroll ' + Math.round(frac * 100) + '%'));
  }
  await page.evaluate(() => {
    const pg = document.querySelector('.page:not([inert])');
    pg.scrollTop = 0;
    pg.dispatchEvent(new Event('scroll'));
  });
  await sleep(160);
  frames.push(await sample('back to top'));

  /* Scroll cost: sixty small steps down the feed, measuring what the browser
     spent on style, layout and paint for them. */
  const before = await metrics();
  await page.evaluate(async () => {
    const pg = document.querySelector('.page:not([inert])');
    for (let i = 0; i < 60; i++) {
      pg.scrollTop = i * 40;
      pg.dispatchEvent(new Event('scroll'));
      await new Promise(r => requestAnimationFrame(r));
    }
  });
  const after = await metrics();
  const delta = k => +((after[k] || 0) - (before[k] || 0)).toFixed(4);

  console.log(JSON.stringify({
    file: path.relative(path.join(__dirname, '..'), FILE) || FILE,
    style,
    frames,
    maxRendered: Math.max(...frames.map(f => f.rendered)),
    minRendered: Math.min(...frames.map(f => f.rendered)),
    scrollCost: {
      layoutMs: delta('LayoutDuration') * 1000,
      styleMs: delta('RecalcStyleDuration') * 1000,
      taskMs: delta('TaskDuration') * 1000,
      layouts: delta('LayoutCount'),
      recalcStyles: delta('RecalcStyleCount'),
    },
  }, null, 1));
  await browser.close();
})();
