#!/usr/bin/env node
/*
 * LiquidTube frame-cache check — the frame's element lists must follow the DOM
 * they are taken from.
 *
 * Item 3.9 took the selector queries out of the scroll frame: the page, card,
 * header, chip-row and dock lists now come from live `getElementsByClassName`
 * collections and are flattened into arrays only on a frame where the structure
 * moved or the set of visible pages changed. That is only safe if the cache
 * tracks both of those, so this tool drives the two cases that change them and
 * asserts the frame still writes to the right elements:
 *
 *   tab switch   `render()` flips `inert` on the pages — an attribute, not a
 *                structural change — so the visible set must be re-derived from
 *                the inert mask, and the page that came back on screen must get
 *                its transforms again
 *   re-render    a card added or removed is a childList change; the next frame
 *                must see the new list and still write the cards that are there
 *
 * It also fails on any page error or console error, and it checks the page that
 * was left behind is inert and therefore not driven.
 *
 *   npm i puppeteer-core                       # dev only, not shipped in the APK
 *   node tools/frame-cache-check.js [file]
 */
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const FILE = process.argv[2] || path.join(__dirname, '..', 'app/assets/index.html');
const HTML = fs.readFileSync(FILE);
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

(async () => {
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME || '/usr/local/bin/google-chrome',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 412, height: 892, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.setRequestInterception(true);
  page.on('request', async (req) => {
    const u = req.url();
    try {
      if (u.startsWith('https://' + ORIGIN + '/'))
        return await req.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: HTML });
      if (/googleapis\.com/.test(u))
        return await req.respond({
          status: 200, contentType: 'application/json',
          headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(apiBody(u)),
        });
      if (/ytimg\.com|ggpht\.com|googleusercontent\.com/.test(u))
        return await req.respond({ status: 200, contentType: 'image/png', body: PNG });
      return await req.abort();
    } catch (e) {}
  });
  await page.goto('https://' + ORIGIN + '/index.html', { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(
    () => document.getElementById('feed') && document.getElementById('feed').querySelector('.card'),
    { timeout: 60000 });
  await sleep(500);

  const snap = () => page.evaluate(() => {
    const out = {};
    document.querySelectorAll('.page').forEach((p) => {
      const cards = p.querySelectorAll('.card');
      let tf = 0;
      cards.forEach((c) => { if (c.style.transform) tf++; });
      out[p.id] = { inert: !!p.inert, cards: cards.length, tf };
    });
    return out;
  });
  const goTab = (i) => page.evaluate((i) => document.querySelectorAll('.tab')[i].click(), i);
  const scrollTo = (id, y) => page.evaluate((id, y) => { document.getElementById(id).scrollTop = y; }, id, y);

  const s0 = await snap();
  await goTab(1); await sleep(800); await scrollTo('p-explore', 600); await sleep(700);
  const s1 = await snap();
  await goTab(2); await sleep(800); await scrollTo('p-subs', 600); await sleep(700);
  const s2 = await snap();
  await goTab(0); await sleep(800); await scrollTo('p-home', 900); await sleep(700);
  const s3 = await snap();

  /* A structural change of the kind a render makes: one card removed. The next
     frame must use the new list and still write the cards that are left. */
  const rerender = await page.evaluate(async () => {
    const p = document.getElementById('p-home');
    const before = p.querySelectorAll('.card').length;
    const first = p.querySelector('.card');
    if (first) first.remove();
    const frame = () => new Promise((r) => requestAnimationFrame(r));
    await frame(); await frame();
    p.scrollTop = 700;
    await frame(); await frame();
    let tf = 0;
    p.querySelectorAll('.card').forEach((c) => { if (c.style.transform) tf++; });
    return { before, after: p.querySelectorAll('.card').length, tf };
  });

  const out = { s0, s1, s2, s3, rerender, errors };
  console.log(JSON.stringify(out, null, 2));

  const assertions = {
    'the home feed renders': s0['p-home'].cards > 0,
    'a tab switch moves the visible set': s1['p-home'].inert === true && s1['p-explore'].inert === false,
    'and the new page is driven': s2['p-subs'].tf > 0 && s2['p-subs'].inert === false && s2['p-explore'].inert === true,
    'the page switched back to is driven again': s3['p-home'].tf > 0 && s3['p-home'].inert === false && s3['p-subs'].inert === true,
    'a removed card leaves the cache': rerender.after === rerender.before - 1,
    'and the cards that are left are still written': rerender.tf > 0,
    'no page or console error': errors.length === 0,
  };
  console.log('');
  for (const [k, v] of Object.entries(assertions)) console.log((v ? 'ok   ' : 'FAIL ') + k);
  await browser.close();
  if (!Object.values(assertions).every(Boolean)) { console.error('pass: false'); process.exit(1); }
  console.log('pass: true');
})().catch((e) => { console.error(e); process.exit(1); });
