#!/usr/bin/env node
/*
 * LiquidTube embed-URL check — item 8.7 ("avoid double `autoplay=1` when reusing
 * the iframe").
 *
 * The player's URL was a hand-concatenated string inside `mount()`: the fixed
 * parameters as one literal, then `&cc_load_policy=1` and `&start=<n>` appended
 * when the options asked for them. Nothing appended `autoplay` there, but the
 * string had no guard against it — and a frame navigated with
 * `?autoplay=1&…&autoplay=1` is not cosmetic: the second one re-fetches the embed
 * document and restarts playback from a cold buffer, which is exactly the cost
 * item 8.1 exists to avoid. The fix composes the URL in one place, from one
 * ordered list, through an `add()` that refuses a key already written, and the
 * reuse branch of `mount()` returns before the only line that writes `src`.
 *
 * What this tool measures, per build, on a real browser with the API mocked and
 * the embed served as a real document that reports its own load:
 *
 *   census    `window.__ltEmbed()`: the URL with and without each optional
 *             parameter (cc, start, both), the count of `autoplay` in each (must
 *             be exactly 1) and the list of repeated keys (must be empty)
 *   fresh     one play: exactly one iframe, its URL carries one `autoplay`, one
 *             of every base parameter, and no repeated key
 *   reuse     the same video played again into the open player: the same element
 *             and no write to its `src` at all — so `autoplay` cannot be added a
 *             second time — and the embed document not fetched again
 *   other     a different video: a new frame whose URL also carries one
 *             `autoplay` and no repeated key
 *   cc        the same video with closed captions turned on: a new frame (the
 *             option is part of the frame key), `cc_load_policy` once,
 *             `autoplay` still once
 *   close     the player holds no frame
 *
 * Usage:
 *   npm i puppeteer-core                    # dev only, not shipped in the APK
 *   CHROME=/path/to/chrome node tools/embed-url-check.js <build-a.html> [build-b.html]
 * Prints one JSON object per build; with two builds it also compares them.
 * Exit code 1 when the build under test — the first file — fails any check.
 */
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const ORIGIN = 'liquidtube.local';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64'
);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const pad = n => String(n).padStart(2, '0');
const vids = Array.from({ length: 24 }, (_, i) => 'v' + pad(i + 1) + 'AAAAAAAA');
const CH = Array.from({ length: 6 }, (_, i) => 'UC' + i + 'xxxxxxxxxxxxxxxxxxxx');
const ago = h => new Date(Date.now() - h * 36e5).toISOString();

const EMBED_HTML = `<!doctype html><html><body><video id="v" muted playsinline></video>
<script>
  var say=function(m){try{parent.postMessage('LTEMBED:'+m,'*')}catch(e){}};
  addEventListener('pagehide',function(){say('pagehide')});
  say('ready');
</script></body></html>`;

const TRENDING = {
  items: vids.map((id, i) => ({
    id,
    snippet: {
      title: 'Video ' + i,
      channelTitle: 'Channel ' + (i % 6),
      channelId: CH[i % 6],
      publishedAt: ago(i + 1),
      categoryId: ['10', '20', '17', '24', '23', '27'][i % 6],
      thumbnails: { maxres: { url: 'https://i.ytimg.com/vi/' + id + '/maxresdefault.jpg' } },
    },
    statistics: { viewCount: '1000' },
  })),
};
function durationsFor(u) {
  const ids = String(u.searchParams.get('id') || '').split(',').filter(Boolean);
  return { items: ids.map(id => ({ id, contentDetails: { duration: 'PT12M30S' } })) };
}
function apiBody(url) {
  const u = new URL(url);
  const p = u.pathname;
  if (p.endsWith('/videos'))
    return (u.searchParams.get('part') || '').includes('contentDetails') ? durationsFor(u) : TRENDING;
  if (p.endsWith('/channels'))
    return {
      items: String(u.searchParams.get('id') || '')
        .split(',')
        .filter(Boolean)
        .map(id => ({
          id,
          snippet: { title: 'Channel ' + id.slice(2, 8), customUrl: 'c' + id.slice(2, 8), publishedAt: '2015-04-02T10:00:00Z', country: 'IN', thumbnails: { medium: { url: 'https://yt3.ggpht.com/' + id + '.jpg' } } },
          statistics: { subscriberCount: '1000', videoCount: '10', viewCount: '10000' },
          contentDetails: { relatedPlaylists: { uploads: 'UU' + id.slice(2) } },
          brandingSettings: { image: {}, channel: {} },
        })),
    };
  if (p.endsWith('/playlistItems'))
    return {
      items: vids.slice(0, 12).map((id, i) => ({
        snippet: { title: 'P' + i, resourceId: { videoId: id }, publishedAt: ago(i * 24) },
        contentDetails: { videoPublishedAt: ago(i * 24) },
      })),
    };
  return {};
}

/* A URL is clean when `autoplay` is there exactly once and no key repeats. */
function audit(u) {
  const q = String(u).split('?')[1] || '';
  const pairs = q.split('&').filter(Boolean);
  const keys = pairs.map(p => p.split('=')[0]);
  const seen = Object.create(null);
  const dupes = [];
  keys.forEach(k => {
    if (seen[k]) dupes.push(k);
    seen[k] = 1;
  });
  return {
    url: u,
    params: keys,
    autoplay: keys.filter(k => k === 'autoplay').length,
    dupes,
    clean: keys.filter(k => k === 'autoplay').length === 1 && dupes.length === 0,
  };
}

async function boot(browser, file) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e.message || e)));
  page.on('console', m => {
    if (m.type() === 'error' && !/ytimg|ggpht|net::ERR|youtube-nocookie|about:blank/.test(m.text()))
      errors.push(m.text());
  });
  await page.setRequestInterception(true);
  page.on('request', req => {
    const u = req.url();
    if (u.startsWith('https://' + ORIGIN + '/index.html') || u === 'https://' + ORIGIN + '/')
      return req.respond({ status: 200, contentType: 'text/html', body: fs.readFileSync(file) });
    if (/youtube-nocookie\.com\/embed\//.test(u))
      return req.respond({ status: 200, contentType: 'text/html', body: EMBED_HTML });
    if (/googleapis\.com\/(youtube\/v3|youtubei)/.test(u))
      return req.respond({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify(apiBody(u)),
      });
    if (/ytimg\.com|ggpht\.com|googleusercontent\.com/.test(u))
      return req.respond({ status: 200, contentType: 'image/png', body: PNG });
    return req.abort();
  });
  await page.goto('https://' + ORIGIN + '/index.html', { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction('document.querySelectorAll("#feed .card").length > 0', { timeout: 60000 });
  await page.evaluate(() => {
    window.__ltReady = [];
    window.addEventListener('message', e => {
      const d = e.data;
      if (typeof d === 'string' && d.indexOf('LTEMBED:') === 0) window.__ltReady.push(d.slice(8));
    });
  });
  await sleep(700);
  await page.evaluate(() => {
    const st = document.createElement('style');
    st.textContent = '*{backdrop-filter:none!important;filter:none!important;box-shadow:none!important}';
    document.head.appendChild(st);
  });
  return { page, errors };
}

async function run(browser, file) {
  const { page, errors } = await boot(browser, file);
  const out = { file: path.basename(file) };
  const ev = (fn, ...a) => page.evaluate(fn, ...a);
  const frame = () =>
    ev(() => {
      const f = document.querySelector('#pl .art iframe');
      return f ? f.getAttribute('src') || '' : '';
    });
  const readyCount = () => ev(() => (window.__ltReady || []).filter(m => m === 'ready').length);

  /* ---- boot ---- */
  out.boot = { iframes: await ev(() => document.querySelectorAll('#pl .art iframe').length) };

  /* ---- the builder's own census ---- */
  out.census = await ev(() => (typeof window.__ltEmbed === 'function' ? window.__ltEmbed() : null));
  if (out.census) {
    out.census.ok = ['plain', 'cc', 'resume', 'both'].every(k => out.census[k] && out.census[k].dupes.length === 0 && out.census[k].autoplay === 1);
  }

  /* ---- one play ---- */
  await ev(() => document.querySelectorAll('#feed .card')[0].click());
  await sleep(400);
  out.fresh = audit(await frame());
  out.fresh.iframes = await ev(() => document.querySelectorAll('#pl .art iframe').length);

  /* ---- the same video again, player open ---- */
  out.reuse = await ev(async () => {
    const art = document.querySelector('#pl .art');
    const first = document.querySelector('#pl .art iframe');
    const seen = [];
    const mo = new MutationObserver(ms => {
      for (const m of ms) if (m.type === 'attributes' && m.attributeName === 'src') seen.push(m.target.getAttribute('src'));
    });
    mo.observe(art, { subtree: true, attributes: true, attributeFilter: ['src'] });
    const before = (window.__ltReady || []).filter(m => m === 'ready').length;
    document.querySelectorAll('#feed .card')[0].click();
    for (const m of mo.takeRecords()) if (m.type === 'attributes' && m.attributeName === 'src') seen.push(m.target.getAttribute('src'));
    mo.disconnect();
    const second = document.querySelector('#pl .art iframe');
    return {
      reused: !!first && first === second,
      srcWrites: seen.length,
      src: second ? second.getAttribute('src') || '' : '',
      readyDelta: (window.__ltReady || []).filter(m => m === 'ready').length - before,
    };
  });
  out.reuse.audit = audit(out.reuse.src);
  delete out.reuse.src;
  await sleep(200);
  out.reuse.readyAfter = await readyCount();

  /* ---- a different video ---- */
  await ev(() => document.querySelectorAll('#feed .card')[1].click());
  await sleep(400);
  out.other = audit(await frame());

  /* ---- the same video with captions on ---- */
  /* Captions are part of the frame key, so turning them on must rebuild the
     frame — with `cc_load_policy` once and `autoplay` still once. The option is
     set through the app's own stored state and the build re-booted on it, which
     is what the settings row does to that state. */
  await ev(() => {
    let raw = {};
    try {
      raw = JSON.parse(localStorage.getItem('lt') || '{}');
    } catch (e) {
      raw = {};
    }
    raw.opt = raw.opt || {};
    raw.opt.cc = 1;
    localStorage.setItem('lt', JSON.stringify(raw));
  });
  await page.reload({ waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction('document.querySelectorAll("#feed .card").length > 0', { timeout: 60000 });
  await sleep(600);
  await ev(() => document.querySelectorAll('#feed .card')[0].click());
  await sleep(450);
  out.cc = audit(await frame());
  out.cc.ccOnce = out.cc.params.filter(k => k === 'cc_load_policy').length;
  out.cc.iframes = await ev(() => document.querySelectorAll('#pl .art iframe').length);

  /* ---- close ---- */
  await ev(() => {
    const b = document.getElementById('pclose');
    if (b) b.click();
  });
  await sleep(400);
  out.close = { iframes: await ev(() => document.querySelectorAll('#pl .art iframe').length) };

  out.pageErrors = errors;
  const fails = [];
  const need = (cond, name) => {
    if (!cond) fails.push(name);
  };
  need(out.boot.iframes === 0, 'boot: a frame exists before any play');
  need(!!out.census, 'census: window.__ltEmbed is missing (the URL builder is not in this build)');
  if (out.census) need(out.census.ok, 'census: a URL carries autoplay twice or repeats a key');
  need(out.fresh.iframes === 1, 'fresh: not exactly one frame');
  need(out.fresh.clean, 'fresh: URL is not clean (autoplay twice or a repeated key)');
  need(out.reuse.reused, 'reuse: the frame was replaced for the same video');
  need(out.reuse.srcWrites === 0, 'reuse: the frame was navigated (src written) on reuse');
  need(out.reuse.readyDelta === 0, 'reuse: the embed document was fetched again on reuse');
  need(out.reuse.audit.clean, 'reuse: URL is not clean');
  need(out.other.clean, 'other: URL is not clean');
  need(out.cc.iframes === 1, 'cc: not exactly one frame');
  need(out.cc.ccOnce === 1, 'cc: cc_load_policy is missing from the URL');
  need(out.cc.clean, 'cc: URL is not clean (autoplay twice or a repeated key)');
  need(out.close.iframes === 0, 'close: the player still holds a frame');
  need(errors.length === 0, 'pageErrors: the run raised an error');

  out.fails = fails;
  out.pass = fails.length === 0;
  await page.close();
  return out;
}

(async () => {
  const files = process.argv.slice(2);
  if (!files.length) {
    console.error('usage: node tools/embed-url-check.js <build-a.html> [build-b.html]');
    process.exit(2);
  }
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME || '/usr/bin/google-chrome',
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--force-device-scale-factor=1'],
  });
  const results = [];
  try {
    for (const f of files) {
      const r = await run(browser, f);
      results.push(r);
      console.log(JSON.stringify(r, null, 2));
    }
  } finally {
    await browser.close();
  }
  if (results.length > 1) {
    const a = results[0];
    const b = results[1];
    console.log('--- comparison (under test vs baseline) ---');
    console.log(
      JSON.stringify(
        {
          autoplayCountFresh: [a.fresh.autoplay, b.fresh.autoplay],
          dupesFresh: [a.fresh.dupes, b.fresh.dupes],
          reuseSrcWrites: [a.reuse.srcWrites, b.reuse.srcWrites],
          reuseEmbedRefetched: [a.reuse.readyDelta, b.reuse.readyDelta],
          census: [!!a.census, !!b.census],
          pageErrors: [a.pageErrors.length, b.pageErrors.length],
          fails: [a.fails, b.fails],
          pass: [a.pass, b.pass],
        },
        null,
        2
      )
    );
  }
  process.exit(results[0].pass ? 0 : 1);
})();
