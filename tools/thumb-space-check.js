#!/usr/bin/env node
/*
 * LiquidTube thumbnail-space check — item 6.8.
 *
 * The claim of 6.8 is that a picture can no longer move the thing it sits in:
 * the box is the size it will finally be before the file is asked for, so a
 * thumbnail that arrives late, arrives small, or never arrives shifts nothing.
 * Three things make that true, and this asserts each of them on a real boot of
 * the app in jsdom, plus one Chromium pass if a browser is available.
 *
 *  1. THE RATIO IS IN THE MARKUP. Every picture the app writes carries its
 *     intrinsic size as `width`/`height` — thumbnails 320x180 (the 16:9 rung of
 *     6.3's ladder), shelf cards 1280x720, avatars the square the stylesheet
 *     gives them. The UA derives `aspect-ratio` from those two numbers, so the
 *     box is right in the frame the card is parsed, with no stylesheet at all.
 *  2. THE ELEMENT IS STILL BORN WITH NO PICTURE. `src` is absent, `data-l="0"`,
 *     `data-fd="0"` — 6.1's arming and 6.7's fade are untouched, and the picker
 *     (6.3) still writes the `src` and changes neither attribute.
 *  3. AN ENGINE WITHOUT `aspect-ratio` STILL RESERVES THE BOX. Chromium before
 *     88 — what an un-updated Android WebView on this app's minSdk 21 device is
 *     — has no height for `.thumb` or `.big`, so the picture is drawn into 0 px.
 *     The critical sheet carries the same geometry as padding behind
 *     `@supports not (aspect-ratio:16/9)`, and the percentages are derived here
 *     from the ratios the deferred sheet declares, so the two cannot drift.
 *  4. THE GUARD IS INERT WHERE IT IS NOT NEEDED. The block is `@supports not`,
 *     so an engine that has `aspect-ratio` matches none of it; the modern path
 *     is still the deferred sheet's `aspect-ratio:16/9` / `4/4.3`, unchanged.
 *  5. A CACHED FEED IS NOT PAINTED BEFORE THE SHEET THAT SIZES IT. On a warm
 *     boot the cached cards are inserted during the parse (1.9), and the sheet
 *     that gives them their geometry is asked for at that moment (`restWant`)
 *     and applied in the same parse pass — before the first frame — instead of
 *     in the idle slot, which is where the old build let a card be laid out at
 *     a third of its height and then jump.
 *  6. A COLD BOOT KEEPS ITS FIRST FRAME. With no cache the skeleton paints and
 *     nothing asks for the sheet, so 1.2's "the shell paints before the card
 *     CSS" is intact: the sheet is still applied in the idle slot, not in the
 *     parse.
 *  7. NOTHING ELSE MOVED. The card tree of this build and of an older one,
 *     with `width`/`height` taken out, is identical; no storage key is added or
 *     lost; the sheet is one `<style>` element and nothing is fetched for it.
 *  8. IN A REAL BROWSER. With `puppeteer-core` and a Chrome available, a warm
 *     boot's home-page layout shift is 0 — measured, not asserted from the
 *     source — and the first card is already at its settled height when it is
 *     first laid out.
 *
 * Runs in jsdom with googleapis answered from fixtures — no network, no device —
 * on the same harness as tools/thumb-fade-check.js.
 *
 *   npm i jsdom
 *   node tools/thumb-space-check.js app/assets/index.html [old-build.html]
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const FILE = process.argv[2] || path.join(__dirname, '..', 'app', 'assets', 'index.html');
const OLD = process.argv[3] || '';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const vids = [];
for (let i = 0; i < 24; i++) vids.push('vid' + String(i).padStart(8, '0'));
const CH_IDS = [];
for (let i = 0; i < 6; i++) CH_IDS.push('UCchan' + String(i).padStart(12, '0'));
const pub = d => new Date(Date.UTC(2026, 10, 1 + d)).toISOString();

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
        country: 'IN',
        description: 'A sample channel',
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
      snippet: { title: 'Search result ' + i, channelTitle: 'Channel ' + (i % 6), channelId: CH_IDS[i % 6], publishedAt: pub(i * 24) },
    })),
  },
};
function apiBody(url) {
  const u = new URL(url);
  const p = u.pathname;
  if (p.endsWith('/videos')) return (u.searchParams.get('part') || '').includes('contentDetails') ? F.durations : F.videos;
  if (p.endsWith('/channels')) return F.channels;
  if (p.endsWith('/playlistItems')) return F.playlistItems;
  if (p.endsWith('/search')) return F.search;
  return {};
}

/* One jsdom boot. `seed` is a localStorage image copied from an earlier boot,
   which is how the warm path is produced: the app reads it in stage 1. */
function open(file, seed) {
  const HTML = fs.readFileSync(file, 'utf8');
  const env = { ios: [], lines: [], errors: [], requests: 0 };
  const mockFetch = async u => {
    env.requests++;
    const j = apiBody(String(u));
    return { ok: true, status: 200, json: async () => j, headers: new Map() };
  };
  const dom = new JSDOM(HTML, {
    url: 'https://liquidtube.local/index.html',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(w) {
      w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
      w.fetch = mockFetch;
      w.scrollTo = () => {};
      w.IntersectionObserver = class {
        constructor(cb, o) { this.cb = cb; this.opts = o || {}; this.targets = new Set(); env.ios.push(this); }
        observe(t) { this.targets.add(t); }
        unobserve(t) { this.targets.delete(t); }
        disconnect() { this.targets.clear(); }
        takeRecords() { return []; }
      };
      const log = kind => (...a) => {
        const s = a.map(x => (typeof x === 'string' ? x : String(x))).join(' ');
        env.lines.push(s);
        if (kind === 'error') env.errors.push(s);
      };
      w.console.log = log('log');
      w.console.info = log('info');
      w.console.warn = log('warn');
      w.console.error = log('error');
      if (seed) for (const k in seed) { try { w.localStorage.setItem(k, seed[k]); } catch (e) {} }
    },
  });
  env.w = dom.window;
  env.d = dom.window.document;
  env.dom = dom;
  return env;
}

const ignorable = e => /WebAssembly|Cannot allocate|Not implemented/i.test(String((e && e.message) || ''));
process.on('uncaughtException', e => { if (!ignorable(e)) { console.error('uncaught', e); process.exit(1); } });
process.on('unhandledRejection', e => { if (!ignorable(e)) { console.error('unhandled', e); process.exit(1); } });

async function waitFor(fn, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(20); }
  return false;
}

let fails = 0;
const ok = (name, cond, detail) => {
  if (!cond) fails++;
  console.log((cond ? 'ok   ' : 'FAIL ') + name + (detail === undefined ? '' : '  [' + detail + ']'));
};

const cardsOf = env => [...env.d.querySelectorAll('#feed .card')];
const THUMBS = env => [...env.d.querySelectorAll('#feed .card img[data-l]')];

/* The critical sheet is the inline <style> in <head>; the deferred one is the
   inert `<script type="text/css">` block at the end of <body>. */
const critical = env => (env.d.querySelector('head style') || {}).textContent || '';
const deferredSrc = env => (env.d.getElementById('lt-css-deferred') || {}).textContent || '';
const applied = env => { const s = env.d.getElementById('lt-css-rest'); return s ? s.textContent : ''; };

/* `16/9` -> 56.25, `4/4.3` -> 107.5: the height of a box as a percentage of its
   width, which is what `padding-top` needs to reproduce `aspect-ratio`. */
const pct = ratio => {
  const [a, b] = ratio.split('/').map(Number);
  return +(100 * b / a).toFixed(4);
};

/* Every card's tree with the picture's own state taken out, plus (for the A/B)
   the two attributes this item adds. */
const SKIP_ATTR = ['src', 'loading', 'data-l', 'decoding', 'sizes', 'srcset', 'data-f', 'data-fd', 'width', 'height'];
function treeOf(doc) {
  return [...doc.querySelectorAll('#feed .card')].map(c => {
    const walk = (el, out) => {
      for (const n of el.childNodes) {
        if (n.nodeType === 3) { const t = n.textContent.trim(); if (t) out.push('#' + t); continue; }
        if (n.nodeType !== 1) continue;
        const attrs = [...n.attributes].filter(a => !SKIP_ATTR.includes(a.name))
          .map(a => a.name + '=' + a.value).sort().join(';');
        out.push('<' + n.tagName + ' ' + attrs);
        walk(n, out);
        out.push('>');
      }
      return out;
    };
    return walk(c, []).join('|');
  }).join('\n');
}

(async () => {
  /* ---- 1..4: the source, on a cold boot ---- */
  const cold = open(FILE);
  const appliedAtParse = !!cold.d.getElementById('lt-css-rest');
  const cardsAtParse = cardsOf(cold).length;
  const feedAtParse = cold.d.getElementById('feed').innerHTML;
  const booted = await waitFor(() => cold.w.__ltTimeline && cold.lines.some(l => l.indexOf('lt-startup') === 0));
  ok('boot reached its timeline', booted);
  ok('the feed rendered 24 cards', await waitFor(() => cardsOf(cold).length === 24), String(cardsOf(cold).length));
  await sleep(120);

  {
    const markup = cold.w.eval('thumbImg("abc")');
    ok('markup: a thumbnail declares its own 16:9 size',
      /width="320"/.test(markup) && /height="180"/.test(markup), markup);
    ok('markup: and is still born with no src (6.1 intact)', !/\ssrc=/.test(markup));
    ok('markup: and still born hidden (6.7 intact)', /data-fd="0"/.test(markup) && /data-l="0"/.test(markup));
    const imgs = THUMBS(cold);
    ok('markup: every thumbnail in the feed carries the same two numbers',
      imgs.length === 24 && imgs.every(i => i.getAttribute('width') === '320' && i.getAttribute('height') === '180'),
      imgs.length + ' thumbs');
    const av = [...cold.d.querySelectorAll('#feed .card .meta img.av')];
    ok('markup: an avatar is the square its box is',
      av.length > 0 && av.every(i => i.getAttribute('width') === '36' && i.getAttribute('height') === '36'),
      av.length + ' avatars');
    const big = [...cold.d.querySelectorAll('#ex .big img')];
    ok('markup: a shelf card declares the frame it paints',
      big.length > 0 && big.every(i => i.getAttribute('width') === '1280' && i.getAttribute('height') === '720'),
      big.length + ' shelf cards');
    const sg = [...cold.d.querySelectorAll('#sg button img')];
    ok('markup: a channel row avatar is the square its box is',
      sg.length > 0 && sg.every(i => i.getAttribute('width') === '58' && i.getAttribute('height') === '58'),
      sg.length + ' channel rows');
  }

  /* ---- 3: the reservation for engines without `aspect-ratio` ---- */
  {
    const crit = critical(cold);
    const rest = deferredSrc(cold);
    const mThumb = /\.thumb\{[^}]*aspect-ratio:([\d.]+\/[\d.]+)/.exec(rest);
    const mBig = /\.big\{[^}]*aspect-ratio:([\d.]+\/[\d.]+)/.exec(rest);
    ok('sheet: the deferred sheet still declares .thumb\'s ratio', !!mThumb, mThumb && mThumb[1]);
    ok('sheet: and .big\'s', !!mBig, mBig && mBig[1]);
    ok('fallback: the critical sheet carries it behind @supports not',
      /@supports not \(aspect-ratio:16\/9\)\{/.test(crit));
    const want = pct(mThumb[1]), wantBig = pct(mBig[1]);
    const block = (/@supports not \(aspect-ratio:16\/9\)\{([\s\S]*?)\n\}/.exec(crit) || [])[1] || '';
    ok('fallback: .thumb is padded to exactly the ratio the sheet uses',
      new RegExp('\\.thumb\\{[^}]*padding-top:' + want + '%').test(block), want + '%');
    ok('fallback: .big is padded to exactly the ratio the sheet uses',
      new RegExp('\\.big\\{[^}]*padding-top:' + wantBig + '%').test(block), wantBig + '%');
    ok('fallback: the picture is taken out of the flow inside the reserved box',
      /\.thumb img\{[^}]*position:absolute/.test(block) && /\.big img\{[^}]*position:absolute/.test(block));
    ok('fallback: it is a reservation, not a decoration — no colour, no radius, no shadow',
      !/border-radius|box-shadow|background|color/.test(block));
    ok('guard: the block matches nothing where aspect-ratio exists (it is @supports not)',
      (crit.match(/@supports not \(aspect-ratio/g) || []).length === 1);
  }

  /* ---- 6: the cold path keeps 1.2's first frame ---- */
  {
    ok('cold: no card was on screen during the parse', cardsAtParse === 0, String(cardsAtParse));
    ok('cold: nothing asked for the deferred sheet during the parse', !appliedAtParse);
    ok('cold: the skeleton is what the first frame holds',
      /class="skl"/.test(feedAtParse) && !/class="card"/.test(feedAtParse));
    ok('cold: the sheet still arrives, in the idle slot', await waitFor(() => !!cold.d.getElementById('lt-css-rest')), 'lt-css-rest');
    ok('cold: and it is the whole deferred sheet',
      applied(cold).length === deferredSrc(cold).length, applied(cold).length + '/' + deferredSrc(cold).length + ' bytes');
  }

  /* ---- 5: the warm path never paints a card before its geometry ---- */
  const seed = {};
  try {
    for (let i = 0; i < cold.w.localStorage.length; i++) {
      const k = cold.w.localStorage.key(i);
      seed[k] = cold.w.localStorage.getItem(k);
    }
  } catch (e) {}
  ok('warm: the boot left a feed cache to read', !!seed['lt_feed'], Object.keys(seed).join(','));
  const warm = open(FILE, seed);
  const warmApplied = !!warm.d.getElementById('lt-css-rest');
  const warmCards = cardsOf(warm).length;
  const warmWant = warm.w.__ltRestWant;
  await waitFor(() => warm.w.__ltTimeline && warm.lines.some(l => l.indexOf('lt-startup') === 0));
  await sleep(120);
  {
    ok('warm: the cached feed is painted during the parse (1.9 intact)', warmCards === 24, String(warmCards));
    ok('warm: that paint asked for the sheet that sizes it', warmWant === 1, 'want=' + warmWant);
    ok('warm: and the sheet is in the CSSOM by the end of the parse, not on a timer',
      warmApplied && applied(warm).length === deferredSrc(warm).length,
      applied(warm).length + ' bytes');
    ok('warm: one <style> for it, so nothing was applied twice',
      warm.d.querySelectorAll('#lt-css-rest').length === 1 &&
      warm.d.querySelectorAll('style').length === cold.d.querySelectorAll('style').length);
    ok('warm: the geometry is the stylesheet\'s, both sheets present',
      /aspect-ratio:16\/9/.test(applied(warm)) && /\.thumb\{[^}]*border-radius/.test(applied(warm)));
    const marks = warm.lines.find(l => l.indexOf('lt-startup') === 0) || '';
    ok('warm: the startup line still reports a cache paint', /cache=/.test(marks), marks.slice(0, 60));
  }

  /* ---- 7: nothing else moved ---- */
  {
    const before = cold.w.eval('JSON.stringify(window.__ltStore().keys)');
    const after = warm.w.eval('JSON.stringify(window.__ltStore().keys)');
    ok('store: the warm boot adds no key and loses none', before === after, before);
    ok('store: the key set is the one 6.8 found', before === JSON.stringify(['lt', 'lt_feed', 'lt_anime', 'lt_cartoon', 'lt_movies', 'lt_quota', 'lt_cver']));
    ok('boot: no console error on either path', cold.errors.length === 0 && warm.errors.length === 0,
      cold.errors.concat(warm.errors).join(' / '));
    const pick = THUMBS(cold)[0];
    const wh = pick.getAttribute('width') + 'x' + pick.getAttribute('height');
    cold.w.eval('window.__t=' + JSON.stringify(pick.dataset.id));
    const fired = THUMBS(cold)[0];
    cold.ios[0].cb([{ target: fired, isIntersecting: true }]);
    ok('ui: asking for the picture changes neither number',
      fired.getAttribute('width') + 'x' + fired.getAttribute('height') === wh, wh);
    if (OLD) {
      const old = open(OLD);
      await waitFor(() => cardsOf(old).length === 24);
      await sleep(120);
      ok('ab: the older build had no intrinsic size on a thumbnail',
        !old.d.querySelector('#feed .card .thumb img').hasAttribute('width'));
      ok('ab: with width/height taken out, the cards are the same tree',
        treeOf(old.d) === treeOf(cold.d));
    } else {
      console.log('skip ab: no older build given');
    }
  }

  /* ---- 8: in a real browser, the shift is gone ---- */
  let puppeteer = null;
  try { puppeteer = require('puppeteer-core'); } catch (e) { puppeteer = null; }
  const CHROME = process.env.CHROME || ['/usr/local/bin/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(p => fs.existsSync(p));
  if (puppeteer && CHROME) {
    const HTML = fs.readFileSync(FILE);
    const ORIGIN = 'liquidtube.local';
    const PNG = (() => {
      const W = 640, H = 360, zlib = require('zlib');
      const crc = buf => { let c, t = []; for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } let x = 0xffffffff; for (const b of buf) x = t[(x ^ b) & 0xff] ^ (x >>> 8); return (x ^ 0xffffffff) >>> 0; };
      const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, 'ascii'), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
      const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
      const raw = Buffer.alloc((W * 3 + 1) * H, 0x66);
      return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
    })();
    const PROBE = `
      window.__ls = 0;
      new PerformanceObserver(l => { for (const e of l.getEntries()) {
        if (e.hadRecentInput) continue;
        const home = (e.sources || []).some(s => s.node && (s.node.nodeType === 1 ? s.node : s.node.parentElement) &&
          (s.node.nodeType === 1 ? s.node : s.node.parentElement).closest && (s.node.nodeType === 1 ? s.node : s.node.parentElement).closest('#p-home'));
        if (home) window.__ls += e.value;
      } }).observe({ type: 'layout-shift', buffered: true });`;
    const browser = await puppeteer.launch({ executablePath: CHROME, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--hide-scrollbars'] });
    const page = await browser.newPage();
    await page.setViewport({ width: 412, height: 892, deviceScaleFactor: 2 });
    await page.evaluateOnNewDocument(PROBE);
    await page.setRequestInterception(true);
    page.on('request', req => {
      const u = req.url();
      if (u.startsWith('https://' + ORIGIN + '/')) return req.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: HTML });
      if (/googleapis\.com/.test(u)) return req.respond({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(apiBody(u)) });
      if (/ytimg\.com|ggpht\.com|googleusercontent\.com/.test(u)) return req.respond({ status: 200, contentType: 'image/png', body: PNG });
      return req.abort();
    });
    const boot = async () => {
      await page.goto('https://' + ORIGIN + '/index.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForFunction('document.querySelectorAll("#feed .card").length > 0', { timeout: 60000 });
      await sleep(2000);
      return page.evaluate(() => {
        const c = document.querySelector('#feed .card');
        return { cls: +window.__ls.toFixed(4), h: Math.round(c.getBoundingClientRect().height), cards: document.querySelectorAll('#feed .card').length };
      });
    };
    const first = await boot();               /* cold: fills the cache */
    const warmRun = await boot();             /* warm: the path this item is about */
    await browser.close();
    ok('browser: the warm boot paints 24 cards at their settled height',
      warmRun.cards === 24 && warmRun.h === first.h, warmRun.h + ' vs ' + first.h);
    ok('browser: the warm boot shifts the home page by nothing',
      warmRun.cls === 0, 'cls=' + warmRun.cls);
  } else {
    console.log('skip browser: no puppeteer-core or Chrome available');
  }

  console.log('');
  console.log(fails ? fails + ' check(s) failed' : 'all checks passed');
  process.exit(fails ? 1 : 0);
})();
