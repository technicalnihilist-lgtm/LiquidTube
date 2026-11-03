#!/usr/bin/env node
/*
 * LiquidTube render snapshot — proves a refactor changed nothing visible.
 *
 * Loads one build of app/assets/index.html in a real browser under the WebView's
 * origin, with googleapis.com mocked from fixed fixtures, drives the app through
 * its main surfaces, and prints a JSON snapshot of everything it rendered plus
 * A/B timings of the pure helpers. Run it against two builds and diff the
 * snapshots: identical output means no UI change.
 *
 *   node tools/render-snapshot.js app/assets/index.html > a.json
 *   node tools/render-snapshot.js /tmp/old/index.html    > b.json
 *   diff a.json b.json
 */
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const FILE = process.argv[2] || path.join(__dirname, '..', 'app/assets/index.html');
const HTML = fs.readFileSync(FILE);
const ORIGIN = 'liquidtube.local';
// A real 640x360 PNG, built here so the tool needs no binary fixture: the app
// swaps a thumbnail for hqdefault when it loads smaller than 121 px wide, and a
// 1x1 stand-in would make the rendered markup depend on load timing.
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
// fixed dates, so two runs on the same day render identical "Nd ago" text
const pub = d => new Date(Date.UTC(2026, 9, 31) - d * 864e5).toISOString();

const F = {
  videos: {
    items: vids.map((id, i) => ({
      id,
      snippet: {
        title: 'Sample trending video number ' + (i + 1) + ' with a realistic title',
        channelTitle: 'Channel ' + (i % 6),
        channelId: CH_IDS[i % 6],
        publishedAt: pub(i + 1),
        categoryId: ['10', '20', '24', '25', '27', '17'][i % 6],
        thumbnails: { maxres: { url: 'https://i.ytimg.com/vi/' + id + '/maxresdefault.jpg' } },
      },
      statistics: { viewCount: String(1000 * (i + 1) * 7) },
    })),
  },
  durations: { items: vids.map(id => ({ id, contentDetails: { duration: 'PT12M30S' } })) },
  channels: {
    items: CH_IDS.map((id, i) => ({
      id,
      snippet: {
        title: 'Channel ' + i,
        customUrl: 'channel' + i,
        publishedAt: '2015-04-02T10:00:00Z',
        country: ['IN', 'US', 'JP', 'DE', 'BR', 'FR'][i],
        description: 'A sample channel &amp; its "quoted" description.',
        thumbnails: { medium: { url: 'https://yt3.ggpht.com/av' + i + '.jpg' } },
      },
      statistics: { subscriberCount: '1200000', videoCount: '480', viewCount: '91000000' },
      contentDetails: { relatedPlaylists: { uploads: 'UU' + i + 'xxxxxxxxxxxxxxxxxxxx' } },
      brandingSettings: { image: { bannerExternalUrl: '' }, channel: {} },
    })),
  },
  playlistItems: {
    items: vids.slice(0, 12).map((id, i) => ({
      snippet: { title: 'Playlist item ' + i, resourceId: { videoId: id }, publishedAt: pub(i * 24) },
      contentDetails: { videoPublishedAt: pub(i * 24) },
    })),
  },
  search: {
    items: vids.slice(0, 20).map((id, i) => ({
      id: { videoId: id },
      snippet: {
        title: 'Search result ' + i + ' &amp; more',
        channelTitle: 'Channel ' + (i % 6),
        channelId: CH_IDS[i % 6],
        publishedAt: pub(i * 24),
      },
    })),
  },
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

(async () => {
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME || '/usr/bin/google-chrome',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--hide-scrollbars'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 412, height: 892, deviceScaleFactor: 2 });

  const requests = [];
  await page.setRequestInterception(true);
  page.on('request', req => {
    const u = req.url();
    if (u.startsWith('https://' + ORIGIN + '/')) {
      return req.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: HTML });
    }
    if (/googleapis\.com/.test(u)) {
      requests.push(u.replace(/([?&])key=[^&]*/, '$1key=<key>'));
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
  await page.waitForFunction('document.querySelectorAll("#feed .card").length > 0', { timeout: 60000 });
  await page.waitForFunction('!document.querySelector("#ex .skl")', { timeout: 60000 });
  await sleep(600);                        // let the deferred sheet and the reveal animations settle

  // markup that depends on when a frame ran, not on what was rendered: the class
  // the load listener adds, the thumbnail fallback flag, and the transform/opacity
  // the depth and parallax loops write inline. Everything else is compared verbatim.
  await page.evaluate(() => {
    const norm = h => String(h)
      .replace(/ class="ld"/g, '')
      .replace(/ ld"/g, '"')
      .replace(/ data-f="1"/g, '')
      .replace(/ ?(?:transform|opacity|background-position-y):[^;"']*;?/g, '')
      .replace(/style="\s*"/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
    window.__norm = norm;
    window.__snap = (sel, all) => all
      ? [...document.querySelectorAll(sel)].map(e => norm(e.outerHTML))
      : norm((document.querySelector(sel) || {}).innerHTML || '');
  });

  const boot = await page.evaluate(() => ({
    chips: __snap('#chips'),
    feed: __snap('#feed .card', 1),
    ex: __snap('#ex'),
    subs: __snap('#sg'),
    subfeed: __snap('#subfeed .card', 1),
    cardStyle: (() => {
      const c = document.querySelector('#feed .card');
      const t = c.querySelector('.thumb');
      const s = getComputedStyle(c), st = getComputedStyle(t);
      return [s.margin, s.borderRadius, s.width, st.borderRadius, st.aspectRatio,
        getComputedStyle(document.querySelector('#feed .card .meta')).transform].join(' | ');
    })(),
  }));

  // search
  await page.click('#sopen');
  await sleep(350);
  await page.evaluate(() => {
    const q = document.getElementById('q');
    q.value = 'lofi & chill';
    q.dispatchEvent(new Event('input'));
  });
  await page.waitForFunction('document.querySelectorAll("#results .card").length > 0', { timeout: 30000 });
  await sleep(200);
  const search = await page.evaluate(() => ({
    results: __snap('#results .card', 1),
    sugHidden: document.getElementById('sug').style.display,
  }));
  await page.click('#cancel');
  await sleep(300);

  // player, then the channel sheet behind it (region name + joined date + counts)
  await page.evaluate(() => document.querySelector('#feed .card').click());
  await sleep(500);
  const player = await page.evaluate(() => ({
    on: document.getElementById('pl').classList.contains('on'),
    iframe: (document.querySelector('#pl iframe') || {}).src || '',
    title: document.getElementById('ptitle').textContent,
    meta: document.getElementById('pmeta').textContent,
    art: __snap('#pl .art'),
  }));
  await page.evaluate(() => document.getElementById('plk').click());
  await page.waitForFunction('document.querySelectorAll("#chlist .card").length > 0', { timeout: 30000 });
  await sleep(200);
  const channel = await page.evaluate(() => ({
    head: document.getElementById('sht').textContent,
    body: __snap('#shb'),
    list: __snap('#chlist .card', 1),
  }));

  // library + settings
  await page.evaluate(() => document.getElementById('scrim').click());
  await sleep(400);
  await page.evaluate(() => document.querySelector('[data-do="you"]').click());
  await sleep(300);
  const library = await page.evaluate(() => __snap('#shb'));
  await page.evaluate(() => document.querySelector('[data-lib="settings"]').click());
  await sleep(300);
  const settings = await page.evaluate(() => __snap('#shb'));
  await page.evaluate(() => document.getElementById('scrim').click());
  await sleep(300);

  // ---- A/B timings: the old inline literals vs the new boot-time constants,
  // interleaved in one page so both see the same JIT and CPU state.
  // Timings are taken with every animation and transition off: the app's own
  // reveal/rise/sheet transitions otherwise run during the measurement and swamp
  // sub-microsecond helpers with compositor and GC noise.
  await page.evaluate(() => new Promise(res => {
    const st = document.createElement('style');
    st.textContent = '*,*::before,*::after{animation:none!important;transition:none!important}';
    document.head.appendChild(st);
    setTimeout(res, 400);
  }));

  const timing = await page.evaluate(() => {
    // string building only (no DOM, no layout): what a feed render costs in JS
    const med = x => x.slice().sort((p, q) => p - q)[Math.floor(x.length / 2)];
    const bench = fn => { const out = []; for (let r = 0; r < 2; r++) fn(); for (let r = 0; r < 7; r++) out.push(fn()); return +med(out).toFixed(1); };
    const render = {
      cards24: bench(() => {
        const t0 = performance.now();
        for (let i = 0; i < 20; i++) feed().map(cardOf).join('');
        return (performance.now() - t0) / 20 * 1000;
      }),
    };

    // the A/B half only makes sense on the build that has the new constants
    if (typeof dfmt !== 'function' || typeof PLAY_IC === 'undefined') return { render };
    const oldEsc = t => String(t == null ? '' : t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const oldDec = t => String(t == null ? '' : t).replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    const oldCname = cc => { try { return new Intl.DisplayNames(['en'], { type: 'region' }).of(cc) || cc; } catch (e) { return cc; } };
    const oldDf = d => d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
    const oldIcon = () => ic('home').replace(/<svg[\s\S]*<\/svg>/, '<svg viewBox="0 0 24 24"><path d="M7 4v16l13-8z"/></svg>');

    const titles = [];
    for (let i = 0; i < 400; i++) titles.push('Video "' + i + '" & <friends> — 50% off & more');
    // awkward input for the escape/decoder paths: astral pairs, entities, quotes, empties
    titles.push('🎵🔥 शीर्षक & "quoted" <b>bold</b>', '&amp;&lt;&gt;&quot;&#39;', "it's & 'that'",
      '', 'plain', '&amp;amp;', '\u0000\u001f', '👨‍👩‍👧‍👦 family & friends', '<', '>', '"', '&');
    const durs = [];
    for (let i = 0; i < 400; i++) durs.push('PT' + (i % 3) + 'H' + (i % 59) + 'M' + (i % 59) + 'S');
    const codes = ['IN', 'US', 'JP', 'DE', 'BR', 'FR', 'GB', 'KR', 'ES', 'IT', 'MX', 'ID'];
    const dates = [];
    for (let i = 0; i < 40; i++) dates.push(new Date(Date.UTC(2015, 0, 1) + i * 864e5 * 30));

    const time = (fn, n) => {
      const t0 = performance.now();
      for (let i = 0; i < n; i++) fn(i);
      return (performance.now() - t0) / n * 1000;   // µs per call
    };
    const pair = (a, b, n) => {   // warmed up, then 7 rounds alternating which side goes first
      for (let r = 0; r < 2; r++) { time(a, n); time(b, n); }
      const A = [], B = [];
      for (let r = 0; r < 7; r++) {
        if (r % 2) { B.push(time(b, n)); A.push(time(a, n)); }
        else { A.push(time(a, n)); B.push(time(b, n)); }
      }
      const med = x => x.slice().sort((p, q) => p - q)[3];
      return { old: +med(A).toFixed(3), new: +med(B).toFixed(3) };
    };

    const out = {};
    out.esc = pair(i => oldEsc(titles[i % 400]), i => esc(titles[i % 400]), 20000);
    out.dec = pair(i => oldDec(titles[i % 400]), i => dec(titles[i % 400]), 20000);
    out.region = pair(i => oldCname(codes[i % 12]), i => cname(codes[i % 12]), 500);
    out.date = pair(i => oldDf(dates[i % 40]), i => dfmt(dates[i % 40]), 500);
    out.icon = pair(() => oldIcon(), () => PLAY_IC, 2000);

    // correctness: the new helpers must agree with the old ones character for character
    const same = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; };
    out.correct = {
      esc: same(titles.map(oldEsc), titles.map(t => esc(t))),
      dec: same(titles.map(oldDec), titles.map(t => dec(t))),
      region: same(codes.map(oldCname), codes.map(c => cname(c))),
      regionUnknown: same(['ZZ', 'QQ', '', 'in'].map(oldCname), ['ZZ', 'QQ', '', 'in'].map(c => cname(c))),
      date: same(dates.map(oldDf), dates.map(d => dfmt(d))),
      icon: oldIcon() === PLAY_IC,
      iso: same(durs.map(d => { const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(d); return m ? (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0) : 0; }), durs.map(iso2sec)),
    };
    out.render = render;
    return out;
  });

  console.log(JSON.stringify({ file: path.basename(FILE), requests, boot, search, player, channel, library, settings, timing }, null, 1));
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
