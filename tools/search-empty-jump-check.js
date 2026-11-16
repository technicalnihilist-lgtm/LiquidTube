#!/usr/bin/env node
/*
 * LiquidTube search empty-answer check — proves item 7.9: an empty answer does
 * not jump the search panel's layout.
 *
 * What it holds the build to:
 *
 *   1. The answer box never collapses. The loading state stands at 348 px in
 *      this viewport (the loader and two shimmer blocks) and the empty answer
 *      used to be 96 px, so the panel's content box lost 252 px in the frame the
 *      answer arrived. The box the answer lands in is now never shorter than the
 *      state it replaced.
 *   2. Nothing moves vertically. The empty answer's element sits at the same
 *      offset the loading state's first node did.
 *   3. A short answer fills the panel and stops there: the panel is exactly
 *      unscrollable, so there is no void to drag and no way to scroll an answer
 *      out of view.
 *   4. An answer that replaces a scrolled page of results lands at the top of the
 *      panel in one step, deterministically (five runs, same offset), and is
 *      never painted outside the viewport on the way there.
 *   5. A cleared panel is not an answer: no floor is left behind, the
 *      suggestions row is back, and the panel is not scrollable over nothing.
 *   6. A tall answer clears the floor and is its own height again, and an answer
 *      of cards is never given a floor at all — #results carries the perspective
 *      the cards are tilted in, and its height is part of that geometry.
 *   7. A rotated panel drops the floor it was measured against, and the next
 *      answer measures the new panel.
 *   8. Nothing else moved (A/B against the previous build, when one is given):
 *      the settled markup of the skeleton, the empty answer, the error answer
 *      and a page of results is byte-identical, the empty answer's own element
 *      is the same size in the same place, the screenshots of all four states
 *      are identical bytes, the requests are the same and no storage key is
 *      added or lost.
 *
 * Real browser (puppeteer-core), API mocked from fixtures, no network.
 * Dev-only, not shipped in the APK.
 *
 *   NODE_PATH=/scratch/node_modules node tools/search-empty-jump-check.js \
 *       app/assets/index.html /path/to/previous/index.html
 *
 * argv[2] is the build under test, argv[3] the previous build (optional; the A/B
 * half is skipped without it).
 */
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const NEW_FILE = process.argv[2] || path.join(__dirname, '..', 'app/assets/index.html');
const OLD_FILE = process.argv[3] || '';
const ORIGIN = 'liquidtube.local';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const PAD = n => String(n).padStart(2, '0');
const VIDS = Array.from({ length: 24 }, (_, i) => 'v' + PAD(i + 1) + 'AAAAAAAA');
const CH_IDS = Array.from({ length: 6 }, (_, i) => 'UC' + i + 'xxxxxxxxxxxxxxxxxxxx');
const pub = d => new Date(Date.UTC(2026, 9, 31) - d * 864e5).toISOString();
// a real 1x1 PNG: the app measures thumbnails, so a stand-in has to decode
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

const F = {
  videos: { items: VIDS.map((id, i) => ({ id, snippet: { title: 'Trending ' + (i + 1), channelTitle: 'Channel ' + (i % 6), channelId: CH_IDS[i % 6], publishedAt: pub(i + 1), categoryId: ['10', '20', '24', '25', '27', '17'][i % 6], thumbnails: { maxres: { url: 'https://i.ytimg.com/vi/' + id + '/maxresdefault.jpg' } } }, statistics: { viewCount: String(1000 * (i + 1) * 7) } })) },
  durations: { items: VIDS.map(id => ({ id, contentDetails: { duration: 'PT12M30S' } })) },
  channels: { items: CH_IDS.map((id, i) => ({ id, snippet: { title: 'Channel ' + i, customUrl: 'channel' + i, publishedAt: '2015-04-02T10:00:00Z', country: 'IN', description: 'd', thumbnails: { medium: { url: 'https://yt3.ggpht.com/av' + i + '.jpg' } } }, statistics: { subscriberCount: '1200000', videoCount: '480', viewCount: '91000000' }, contentDetails: { relatedPlaylists: { uploads: 'UU' + i + 'xxxxxxxxxxxxxxxxxxxx' } }, brandingSettings: { image: { bannerExternalUrl: '' }, channel: {} } })) },
  playlistItems: { items: [] },
  one: { items: [{ id: { videoId: VIDS[0] }, snippet: { title: 'Only result', channelTitle: 'Channel 0', channelId: CH_IDS[0], publishedAt: pub(24) } }] },
  many: { items: VIDS.slice(0, 20).map((id, i) => ({ id: { videoId: id }, snippet: { title: 'Search result ' + i, channelTitle: 'Channel ' + (i % 6), channelId: CH_IDS[i % 6], publishedAt: pub(i * 24) } })) },
  none: { items: [] },
};

function chanAnswer(url) {
  const want = String(new URL(url).searchParams.get('id') || '').split(',').filter(Boolean);
  const have = new Map(F.channels.items.map(c => [c.id, c]));
  return {
    items: want.map(id => have.get(id) || {
      id,
      snippet: { title: 'Channel ' + id.slice(2, 8), customUrl: 'c' + id.slice(2, 8), publishedAt: '2015-04-02T10:00:00Z', country: 'IN', description: 'x', thumbnails: { medium: { url: 'https://yt3.ggpht.com/' + id + '.jpg' } } },
      statistics: { subscriberCount: '1000', videoCount: '10', viewCount: '10000' },
      contentDetails: { relatedPlaylists: { uploads: 'UU' + id.slice(2) } },
      brandingSettings: { image: { bannerExternalUrl: '' }, channel: {} },
    }),
  };
}
/* One query word decides the answer, so the same page can be walked through
   every state without touching the fixtures: `none…` answers nothing, `err…`
   answers 500, `one…` answers a single result, anything else a page of twenty. */
function apiBody(url) {
  const u = new URL(url), p = u.pathname, q = u.searchParams.get('q') || '';
  if (p.endsWith('/videos')) return (u.searchParams.get('part') || '').includes('contentDetails') ? F.durations : F.videos;
  if (p.endsWith('/channels')) return chanAnswer(url);
  if (p.endsWith('/playlistItems')) return F.playlistItems;
  if (p.endsWith('/search')) return /^none/.test(q) ? F.none : /^one/.test(q) ? F.one : F.many;
  return {};
}

let ok = 0, bad = 0;
const say = (good, label, extra) => {
  if (good) ok++; else bad++;
  console.log((good ? 'ok   ' : 'FAIL ') + label + (extra ? '  [' + extra + ']' : ''));
};

async function open(file, browser, opts = {}) {
  const html = fs.readFileSync(file);
  const page = await browser.newPage();
  await page.setViewport({ width: 412, height: 892, deviceScaleFactor: 1 });
  const requests = [];
  await page.setRequestInterception(true);
  page.on('request', req => {
    const u = req.url();
    if (u.startsWith('https://' + ORIGIN + '/')) return req.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: html });
    if (/googleapis\.com/.test(u)) {
      requests.push(u.replace(/([?&])key=[^&]*/, '$1key=<key>'));
      if (/\/search\?/.test(u) && /q=err/.test(u)) {
        return req.respond({ status: 500, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ error: { code: 500, message: 'backendError' } }) });
      }
      return req.respond({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(apiBody(u)) });
    }
    if (/ytimg\.com|ggpht\.com|googleusercontent\.com/.test(u)) return req.respond({ status: 200, contentType: 'image/png', body: PNG });
    return req.abort();
  });
  page.on('pageerror', e => { if (opts.strict) { bad++; console.log('FAIL page error  [' + e.message + ']'); } });
  await page.goto('https://' + ORIGIN + '/index.html', { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction('document.querySelectorAll("#feed .card").length > 0', { timeout: 60000 });
  await sleep(400);
  return { page, requests };
}

const type = (page, v) => page.evaluate(v => {
  const q = document.getElementById('q');
  q.value = v;
  q.dispatchEvent(new Event('input', { bubbles: true }));
}, v);

const geom = page => page.evaluate(() => {
  const s = document.getElementById('search'), r = document.getElementById('results');
  const sr = s.getBoundingClientRect(), rr = r.getBoundingClientRect();
  const f = r.firstElementChild, fr = f ? f.getBoundingClientRect() : null;
  const api = window.__ltSearchCache ? window.__ltSearchCache() : null;
  return {
    boxH: Math.round(rr.height),
    boxTop: Math.round(rr.top - sr.top),
    firstCls: f ? f.className : '',
    firstTop: fr ? Math.round(fr.top - sr.top) : null,
    firstH: fr ? Math.round(fr.height) : null,
    scrollTop: Math.round(s.scrollTop),
    scrollable: s.scrollHeight - s.clientHeight,
    minH: r.style.minHeight || '',
    floor: api && api.box ? api.box.floor() : null,
    room: api && api.box ? api.box.room() : null,
    sug: getComputedStyle(document.getElementById('sug')).display,
    txt: (r.textContent || '').trim().slice(0, 40),
    paints: api ? api.filter.paint : null,
    floors: api ? api.filter.floor : null,
    keys: (() => { try { return Object.keys(localStorage).sort(); } catch (e) { return []; } })(),
  };
});

/* Samples the panel every frame: the answer's own top/height, the panel's
   offset, and how much of the answer is inside the viewport. */
const SAMPLER = `
window.__samples = [];
window.__startSample = () => {
  const s = document.getElementById('search'), r = document.getElementById('results');
  window.__samples = [];
  const t0 = performance.now();
  const tick = () => {
    const sr = s.getBoundingClientRect(), f = r.firstElementChild;
    const fr = f ? f.getBoundingClientRect() : null;
    window.__samples.push({
      t: Math.round(performance.now() - t0),
      st: Math.round(s.scrollTop),
      boxH: Math.round(r.getBoundingClientRect().height),
      cls: f ? f.className : '',
      firstTop: fr ? Math.round(fr.top - sr.top) : null,
      firstH: fr ? Math.round(fr.height) : null,
      seen: fr ? Math.round(Math.max(0, Math.min(sr.bottom, fr.bottom) - Math.max(sr.top, fr.top))) : 0,
    });
    if (window.__samples.length < 240) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
};`;

(async () => {
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME || '/usr/local/bin/chromium',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--hide-scrollbars'],
  });

  /* ---------------- geometry: the build under test ---------------- */
  const { page } = await open(NEW_FILE, browser, { strict: true });
  await page.evaluate(SAMPLER);
  await page.evaluate(() => document.getElementById('sopen').click());
  await sleep(900);

  const opened = await geom(page);
  say(opened.sug === 'flex', 'the panel opens on its suggestions row', 'sug=' + opened.sug);

  // 1/2. fresh query, no results: the skeleton, then the empty answer
  await type(page, 'nonematches');
  await sleep(120);
  const skel = await geom(page);
  say(skel.firstCls === 'ldr' && skel.boxH > 300, 'the pause holds the loading state', 'box=' + skel.boxH + 'px');
  await sleep(1400);
  const empty = await geom(page);
  say(empty.txt.indexOf('No videos match that') === 0, 'the answer is the empty sentence', empty.txt);
  say(empty.boxH >= skel.boxH, 'the answer box does not collapse (1)', 'skeleton ' + skel.boxH + 'px -> answer ' + empty.boxH + 'px');
  say(empty.boxTop === skel.boxTop, 'the answer lands where the loading state stood (2)', skel.boxTop + ' -> ' + empty.boxTop);
  say(empty.firstTop === skel.firstTop, 'and its element starts at the same offset (2)', skel.firstTop + ' -> ' + empty.firstTop);
  say(empty.boxH === empty.room, 'a short answer fills the panel and stops (3)', 'box=' + empty.boxH + ' room=' + empty.room);
  say(empty.scrollable <= 0, 'the panel has no void to scroll (3)', 'scrollable=' + empty.scrollable + 'px');
  say(empty.scrollTop === 0, 'and it is at the top (3)', 'scrollTop=' + empty.scrollTop);
  say(empty.floor > 0, 'the floor is the mechanism (3)', 'floor=' + empty.floor + 'px');

  // 4. a scrolled page of results, then the cached empty answer (no skeleton at all)
  await type(page, 'aaawide');
  await sleep(1500);
  const wide = await geom(page);
  say(wide.minH === '', 'a page of results is its own height (6)', 'box=' + wide.boxH);
  await page.evaluate(() => { document.getElementById('search').scrollTop = 600; });
  await page.evaluate(() => window.__startSample());
  await type(page, 'nonematches');
  await sleep(1200);
  const jump = await page.evaluate(() => window.__samples);
  const shown = jump.filter(f => f.cls === 'empty');
  const seen = shown.map(f => f.seen);
  say(shown.length > 0, 'the empty answer was painted', shown.length + ' frames');
  say(seen.length > 0 && Math.min.apply(null, seen) === shown[0].firstH,
    'the answer is never painted outside the viewport (4)',
    'min visible ' + (seen.length ? Math.min.apply(null, seen) : 'n/a') + 'px of ' + (shown[0] ? shown[0].firstH : 'n/a') + 'px');
  const steps = [];
  for (let i = 1; i < jump.length; i++) if (jump[i].st !== jump[i - 1].st) steps.push(jump[i - 1].st + '->' + jump[i].st);
  say(steps.length === 1 && steps[0] === '600->0', 'the panel lands at the top in one step (4)', steps.join(' '));
  const afterJump = await geom(page);
  say(afterJump.scrollTop === 0 && afterJump.scrollable <= 0, 'and stays there, with nothing to scroll (4)', 'scrollTop=' + afterJump.scrollTop + ' scrollable=' + afterJump.scrollable);

  const landings = [];
  for (let i = 0; i < 4; i++) {
    await type(page, 'aaawide'); await sleep(1200);
    await page.evaluate(() => { document.getElementById('search').scrollTop = 600; });
    await type(page, 'nonematches'); await sleep(400);
    landings.push((await geom(page)).scrollTop);
  }
  say(landings.every(v => v === 0), 'the landing offset is the app\'s, not the clamp\'s (4)', 'runs ' + JSON.stringify(landings));

  // 5. clearing the field hands the box back
  await type(page, '');
  await sleep(200);
  const cleared = await geom(page);
  say(cleared.minH === '' && cleared.boxH === 0, 'a cleared panel keeps no floor (5)', 'minH="' + cleared.minH + '" box=' + cleared.boxH);
  say(cleared.sug === 'flex', 'and the suggestions row is back (5)', 'sug=' + cleared.sug);
  say(cleared.scrollable <= 0, 'the panel is not scrollable over nothing (5)', 'scrollable=' + cleared.scrollable);

  // 6. a tall answer clears the floor
  await type(page, 'aaawide');
  await sleep(1500);
  const tall = await geom(page);
  say(tall.minH === '' && tall.boxH > 4000, 'a tall answer is its own height (6)', 'minH="' + tall.minH + '" box=' + tall.boxH);
  say(tall.scrollable > 0, 'and it scrolls (6)', 'scrollable=' + tall.scrollable);

  // 6b. one result: its own height, no floor (the box is the cards' perspective)
  await type(page, 'onehit');
  await sleep(1500);
  const one = await geom(page);
  say(one.minH === '' && one.boxH < one.room, 'an answer of cards keeps its own height (6)', 'minH="' + one.minH + '" box=' + one.boxH + ' room=' + one.room);

  // 7. rotation: the floor goes with the panel it was measured on
  await type(page, 'nonematches');
  await sleep(1400);
  const beforeRotate = await geom(page);
  say(beforeRotate.floor > 0, 'the floor is set before the rotation (7)', 'floor=' + beforeRotate.floor + 'px');
  await page.setViewport({ width: 892, height: 412, deviceScaleFactor: 1 });
  await sleep(500);
  const rotated = await geom(page);
  say(rotated.minH === '' || rotated.scrollable <= 0, 'a rotation drops the stale floor (7)', 'minH="' + rotated.minH + '" scrollable=' + rotated.scrollable);
  await type(page, 'aaawide'); await sleep(1400);
  await type(page, 'nonematches'); await sleep(1400);
  const rerotate = await geom(page);
  say(rerotate.boxH === rerotate.room && rerotate.scrollable <= 0, 'the next answer measures the new panel (7)', 'box=' + rerotate.boxH + ' room=' + rerotate.room);
  await page.setViewport({ width: 412, height: 892, deviceScaleFactor: 1 });
  await sleep(400);

  const newKeys = (await geom(page)).keys;
  const newReqs = [];
  const newPaints = (await geom(page)).paints;
  await page.close();

  /* ---------------- A/B: nothing visible moved ---------------- */
  if (OLD_FILE) {
    const stateOf = async (file) => {
      const { page: p, requests } = await open(file, browser);
      await p.evaluate(() => document.getElementById('sopen').click());
      await sleep(900);
      const out = {};
      // the skeleton, mid-pause
      await type(p, 'aaawide'); await sleep(100);
      out.skeleton = await p.evaluate(() => document.getElementById('results').innerHTML);
      await sleep(1500);
      out.many = await p.evaluate(() => document.getElementById('results').innerHTML);
      // a scroll offset, then the empty answer
      await p.evaluate(() => { document.getElementById('search').scrollTop = 600; });
      await type(p, 'nonematches'); await sleep(1300);
      out.empty = await p.evaluate(() => document.getElementById('results').innerHTML);
      out.emptyRect = await p.evaluate(() => {
        const f = document.querySelector('#results .empty');
        const r = f.getBoundingClientRect();
        return [Math.round(r.top), Math.round(r.height), Math.round(r.width)];
      });
      // the error answer
      await type(p, 'errhere'); await sleep(2000);
      out.error = await p.evaluate(() => document.getElementById('results').innerHTML);
      // a single result
      await type(p, 'onehit'); await sleep(1500);
      out.one = await p.evaluate(() => document.getElementById('results').innerHTML);
      out.keys = await p.evaluate(() => { try { return Object.keys(localStorage).sort(); } catch (e) { return []; } });
      out.requests = requests.slice().sort();
      // screenshots of each state, animations frozen so two runs of the same
      // build are the same picture
      out.shots = {};
      for (const [name, q, wait] of [['skeleton', 'aaawide', 100], ['empty', 'nonematches', 1400], ['error', 'errhere', 2100], ['many', 'aaawide', 1500], ['one', 'onehit', 1500]]) {
        await type(p, q);
        await sleep(wait);
        await p.evaluate(() => {
          const st = document.createElement('style');
          st.id = 'lt-freeze';
          st.textContent = '*,*::before,*::after{animation:none!important;transition:none!important}';
          document.head.appendChild(st);
          const qi = document.getElementById('q');
          if (qi) qi.blur();
        });
        await sleep(120);
        out.shots[name] = (await p.screenshot({ encoding: 'base64' }));
        await p.evaluate(() => { const s = document.getElementById('lt-freeze'); if (s) s.remove(); });
      }
      await p.close();
      return out;
    };
    const A = await stateOf(NEW_FILE), B = await stateOf(OLD_FILE);
    for (const k of ['skeleton', 'many', 'empty', 'error', 'one']) {
      say(A[k] === B[k], 'A/B: the ' + k + ' markup is byte-identical', A[k] === B[k] ? '' : 'new ' + A[k].length + ' vs old ' + B[k].length + ' chars');
    }
    say(JSON.stringify(A.emptyRect) === JSON.stringify(B.emptyRect), 'A/B: the empty answer\'s own element is the same size in the same place', JSON.stringify(A.emptyRect) + ' vs ' + JSON.stringify(B.emptyRect));
    say(JSON.stringify(A.keys) === JSON.stringify(B.keys), 'A/B: no storage key added or lost', A.keys.join(','));
    say(JSON.stringify(A.requests) === JSON.stringify(B.requests), 'A/B: the same requests', A.requests.length + ' vs ' + B.requests.length);
    const same = Object.keys(A.shots).filter(k => A.shots[k] === B.shots[k]);
    say(same.length === Object.keys(A.shots).length, 'A/B: every state screenshots to the same bytes — 0 differing pixels', same.length + '/' + Object.keys(A.shots).length + ' identical (' + Object.keys(A.shots).join(', ') + ')');
    for (const k of Object.keys(A.shots)) if (A.shots[k] !== B.shots[k]) console.log('       differs: ' + k + ' (new ' + A.shots[k].length + ' vs old ' + B.shots[k].length + ' base64 bytes)');
  } else {
    console.log('     (A/B half skipped: no previous build given)');
  }

  await browser.close();
  console.log('\n' + ok + ' ok, ' + bad + ' failed');
  process.exit(bad ? 1 : 0);
})().catch(e => { console.error('FAIL ' + e.message); process.exit(1); });
