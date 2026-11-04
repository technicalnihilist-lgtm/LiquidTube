#!/usr/bin/env node
/*
 * LiquidTube storage codec check — proves item 2.8: the persisted state and the
 * caches are compressed before they are written to localStorage, that the
 * compression is lossless, and that nothing else about storage or the UI moved.
 *
 * Everything runs in jsdom with googleapis.com answered from fixed fixtures —
 * no network, no device, deterministic. What is checked:
 *
 *   1. Codec round trip over a corpus: ASCII, Hindi, astral emoji, quotes,
 *      backslashes, entities, control characters, the empty string, and a
 *      200 KB pseudo-random payload that overflows the dictionary (the path
 *      where the encoder stops adding entries and the decoder must stop at
 *      exactly the same point).
 *   2. storeJSON leaves a value it cannot beat uncompressed, so nothing gets
 *      bigger; a value it can beat carries the 'z1:' prefix.
 *   3. Real payloads measured end to end in the app: the last feed, the state
 *      and a section cache, plain JSON vs what actually lands in storage.
 *   4. Old data still loads: a build that wrote plain JSON is read back
 *      byte-for-byte, and after the app saves once the value is compressed and
 *      decodes to the same object.
 *   5. Corruption and truncation of a compressed value fall back to defaults
 *      with no console error, exactly as a corrupt plain value did.
 *   6. The app's own save/load cycle survives a reload (like → save → reopen).
 *   7. Old build vs new: identical rendered surfaces and an identical request
 *      log, so the encoding change is invisible.
 *
 *   npm i jsdom
 *   node tools/storage-codec-check.js app/assets/index.html /tmp/old/index.html
 *
 * argv[2] is the build under test, argv[3] the previous build for the A/B half
 * (optional; that half is skipped without it).
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const NEW_FILE = process.argv[2] || path.join(__dirname, '..', 'app/assets/index.html');
const OLD_FILE = process.argv[3] || '';
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
function ok(cond, what, detail) {
  if (cond) { pass++; console.log('  PASS  ' + what); }
  else { fail++; console.log('  FAIL  ' + what + (detail !== undefined ? '   [' + detail + ']' : '')); }
}
const pad = n => String(n).padStart(2, '0');
const pub = d => new Date(Date.UTC(2026, 9, 31) - d * 864e5).toISOString();
const CH_IDS = Array.from({ length: 6 }, (_, i) => 'UC' + i + 'xxxxxxxxxxxxxxxxxxxx');
const TREND = Array.from({ length: 24 }, (_, i) => 't' + pad(i + 1) + 'AAAAAAAA');
const TITLES = [
  'Hindi title with Devanagari — लिक्विड ट्यूब का नया एपिसोड',
  'Emoji title 🎬🔥 and an astral one 𑗊',
  'Quotes "double" and \'single\' and a backslash \\ and </script>',
  'Ampersand &amp; entity &quot;kept&quot; as text',
  'Control chars: tab\there, newline\nhere',
  'Trending video number with a realistic long title',
];

function fixtures() {
  return {
    trending: {
      items: TREND.map((id, i) => ({
        id,
        snippet: {
          title: TITLES[i % TITLES.length] + ' ' + (i + 1),
          channelTitle: 'Channel ' + (i % 6),
          channelId: CH_IDS[i % 6],
          publishedAt: pub(i + 1),
          categoryId: ['10', '20', '24', '25', '27', '17'][i % 6],
        },
        statistics: { viewCount: String(1000 * (i + 1) * 7) },
      })),
    },
    channels: {
      items: CH_IDS.map((id, i) => ({
        id,
        snippet: {
          title: 'Channel ' + i, customUrl: 'channel' + i,
          publishedAt: '2015-04-02T10:00:00Z',
          country: ['IN', 'US', 'JP', 'DE', 'BR', 'FR'][i],
          description: 'A sample channel.',
        },
        statistics: { subscriberCount: '1200000', videoCount: '480', viewCount: '91000000' },
        contentDetails: { relatedPlaylists: { uploads: 'UU' + i + 'xxxxxxxxxxxxxxxxxxxx' } },
        brandingSettings: { image: { bannerExternalUrl: '' }, channel: {} },
      })),
    },
  };
}

const hashOf = t => { let h = 0; for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) >>> 0; return h; };
const setFor = (tag, n) => Array.from({ length: n }, (_, i) => tag + pad(i + 1) + 'DDDDDDDD');

function apiBody(env, url) {
  const u = new URL(url), p = u.pathname, F = env.F;
  if (p.endsWith('/videos')) {
    if ((u.searchParams.get('part') || '').includes('contentDetails')) {
      const want = String(u.searchParams.get('id') || '').split(',').filter(Boolean);
      return { items: want.map(id => ({ id, contentDetails: { duration: 'PT12M30S' } })) };
    }
    return F.trending;
  }
  if (p.endsWith('/channels')) {
    const want = String(u.searchParams.get('id') || '').split(',').filter(Boolean);
    const have = new Map(F.channels.items.map(c => [c.id, c]));
    return { items: want.map(id => have.get(id) || {
      id,
      snippet: { title: 'Channel ' + id.slice(2, 8), customUrl: 'c' + id.slice(2, 8), publishedAt: '2015-04-02T10:00:00Z', country: 'IN', description: 'A sample channel.' },
      statistics: { subscriberCount: '1000', videoCount: '10', viewCount: '10000' },
      contentDetails: { relatedPlaylists: { uploads: 'UU' + id.slice(2) } },
      brandingSettings: { image: { bannerExternalUrl: '' }, channel: {} },
    }) };
  }
  if (p.endsWith('/playlistItems')) {
    const tag = 'u' + String(hashOf('p' + (u.searchParams.get('playlistId') || '')) % 100000).padStart(5, '0');
    return {
      items: setFor(tag, 12).map((id, i) => ({
        snippet: { title: 'Upload video number ' + (i + 1) + ' — लिक्विड', resourceId: { videoId: id }, publishedAt: pub(i * 24) },
        contentDetails: { videoPublishedAt: pub(i * 24) },
      })),
    };
  }
  if (p.endsWith('/search')) {
    const tag = 'q' + String(hashOf('s' + (u.searchParams.get('q') || '')) % 100000).padStart(5, '0');
    return {
      items: setFor(tag, 20).map((id, i) => ({
        id: { videoId: id },
        snippet: { title: 'Result ' + (i + 1) + ' &amp; more', channelTitle: 'Channel ' + (i % 6), channelId: CH_IDS[i % 6], publishedAt: pub(i * 24) },
      })),
    };
  }
  return {};
}

function open(file, seed) {
  const HTML = fs.readFileSync(file, 'utf8');
  const env = { reqs: [], F: fixtures(), errors: [] };
  const mockFetch = async u => {
    u = String(u);
    env.reqs.push(u.replace(/([?&])key=[^&]*/, '$1key=<key>'));
    return { ok: true, status: 200, json: async () => apiBody(env, u) };
  };
  globalThis.fetch = mockFetch;
  const dom = new JSDOM(HTML, {
    url: 'https://liquidtube.local/index.html',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(w) {
      w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
      w.fetch = mockFetch;
      w.scrollTo = () => {};
      w.console.error = (...a) => { env.errors.push(a.join(' ')); };
      if (seed) { try { Object.keys(seed).forEach(k => w.localStorage.setItem(k, seed[k])); } catch (e) {} }
    },
  });
  env.w = dom.window;
  env.d = dom.window.document;
  env.dom = dom;
  return env;
}
const ignorable = e => /WebAssembly|Cannot allocate/i.test(String((e && e.message) || ''));
process.on('uncaughtException', e => { if (!ignorable(e)) { console.error('uncaught', e); process.exit(1); } });
process.on('unhandledRejection', e => { if (!ignorable(e)) { console.error('unhandled', e); process.exit(1); } });

async function waitFor(fn, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(20); }
  return false;
}
function norm(h) {
  return String(h)
    .replace(/ class="ld"/g, '').replace(/ ld"/g, '')
    .replace(/ data-f="1"/g, '')
    .replace(/ ?(?:transform|opacity|background-position-y):[^;"']*;?/g, '')
    .replace(/style="\s*"/g, '').replace(/\s{2,}/g, ' ').trim();
}
const snap = (env, sel) => norm((env.d.querySelector(sel) || {}).innerHTML || '');
function dump(w) {
  const o = {};
  for (let i = 0; i < w.localStorage.length; i++) { const k = w.localStorage.key(i); o[k] = w.localStorage.getItem(k); }
  return o;
}
/* the app's own decode, so the test never re-implements the format it checks */
const decode = (env, key) => env.w.eval('JSON.stringify(loadJSON(localStorage.getItem(' + JSON.stringify(key) + '),null))');
const u8 = s => Buffer.byteLength(s, 'utf8');

async function main() {
  /* ---------- 1. codec round trip ---------- */
  console.log('\n1. codec round trip');
  const env0 = open(NEW_FILE);
  await waitFor(() => env0.d.querySelector('#feed .card'));
  env0.w.__rt = s => env0.w.lzwUnpack(env0.w.lzwPack(s)) === s;
  const corpus = [
    '', 'a', '{}', '{"a":1}', 'लिक्विड ट्यूब', '🎬🔥𑗊', 'quote"back\\slash', '\u0000\u0001\u001f',
    JSON.stringify({ v: 1, items: TREND.map((id, i) => ({ id, t: TITLES[i % TITLES.length] })) }),
    'x'.repeat(50000),
  ];
  let allSame = true, worst = null;
  for (const s of corpus) {
    const same = env0.w.__rt(s);
    if (!same) { allSame = false; worst = s.slice(0, 40); }
  }
  ok(allSame, 'every corpus string survives pack → unpack unchanged', worst);
  // a payload that overflows the dictionary: 200 KB of pseudo-random ASCII
  let seed = 12345, big = '';
  for (let i = 0; i < 200000; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; big += String.fromCharCode(32 + (seed % 95)); }
  const bigSame = env0.w.__rt(big);
  ok(bigSame, '200 KB incompressible payload round-trips (dictionary full path)');
  ok(env0.w.lzwUnpack(env0.w.lzwPack(big)).length === big.length, 'and comes back the same length');

  /* ---------- 2. only compress when it wins ---------- */
  console.log('\n2. storeJSON policy');
  env0.w.__store = o => env0.w.storeJSON(o);
  ok(env0.w.__store({ a: 1 }).slice(0, 3) !== 'z1:', 'a tiny object is stored as plain JSON, unchanged');
  const sample = { items: TREND.map(id => ({ id, t: 'Trending video number with a realistic long title', c: 'Channel 1' })) };
  const prefixed = env0.w.__store(sample);
  const plainLen = JSON.stringify(sample).length;
  ok(prefixed.slice(0, 3) === 'z1:', 'a real payload carries the z1: prefix');
  ok(prefixed.length < plainLen, 'and is smaller than its plain JSON (' + plainLen + ' → ' + prefixed.length + ' chars)');

  /* ---------- 3. real payloads, measured in the app ---------- */
  console.log('\n3. what actually lands in storage');
  const env1 = open(NEW_FILE);
  await waitFor(() => env1.d.querySelectorAll('#feed .card').length >= 20, 25000);
  await sleep(150);
  const feedRaw = env1.w.localStorage.getItem('lt_feed');
  const feedPlain = decode(env1, 'lt_feed');
  ok(!!feedRaw && feedRaw.slice(0, 3) === 'z1:', 'the feed cache is stored compressed');
  const savedPct = 100 - (u8(feedRaw) / u8(feedPlain)) * 100;
  console.log('        feed cache: ' + u8(feedPlain) + ' B plain → ' + u8(feedRaw) + ' B stored (' + savedPct.toFixed(1) + ' % smaller, ' +
    JSON.parse(feedPlain).items.length + ' items, ' + Object.keys(JSON.parse(feedPlain).chav || {}).length + ' avatars)');
  ok(savedPct >= 30, 'the feed cache is at least 30 % smaller (' + savedPct.toFixed(1) + ' %)');
  ok(JSON.parse(feedPlain).items.length === 24, 'and still holds all 24 items');

  env1.w.eval('toggle(S.liked,"t01AAAAAAAA");toggle(S.hist,"t02AAAAAAAA");save()');
  const stateRaw = env1.w.localStorage.getItem('lt');
  const statePlain = decode(env1, 'lt');
  console.log('        state:      ' + u8(statePlain) + ' B plain → ' + u8(stateRaw) + ' B stored (' +
    (100 - (u8(stateRaw) / u8(statePlain)) * 100).toFixed(1) + ' % smaller)');
  ok(JSON.parse(statePlain).liked.length === 1 && JSON.parse(statePlain).hist.length === 1, 'the state round-trips its arrays');
  ok(JSON.parse(statePlain).opt && JSON.parse(statePlain).opt.pdepth === 65, 'and its options block');

  /* a section cache, filled by loading a section (what the Anime chip does) */
  env1.w.eval('loadSection("anime")');
  const gotShelf = await waitFor(() => env1.w.localStorage.getItem('lt_anime'), 25000);
  if (gotShelf) {
    const secRaw = env1.w.localStorage.getItem('lt_anime');
    const secPlain = decode(env1, 'lt_anime');
    const pct = 100 - (u8(secRaw) / u8(secPlain)) * 100;
    console.log('        section:    ' + u8(secPlain) + ' B plain → ' + u8(secRaw) + ' B stored (' + pct.toFixed(1) + ' % smaller)');
    ok(secRaw.slice(0, 3) === 'z1:' && pct >= 20, 'the section cache is compressed too (' + pct.toFixed(1) + ' %)');
    ok(JSON.parse(secPlain).items.length > 0, 'and keeps its items');
  } else ok(false, 'a section cache was written', 'lt_anime missing');

  /* ---------- 4. old plain data still loads ---------- */
  console.log('\n4. data written by the previous build');
  const legacyState = JSON.stringify({
    liked: ['t03AAAAAAAA'], subs: ['UC0xxxxxxxxxxxxxxxxxxxx'], later: ['t04AAAAAAAA'], hist: ['t05AAAAAAAA'],
    vd: {}, pl: {}, cats: {}, opt: { cc: 1, loop: 1, auto: 0, fill: 0, cmt: 0, ds: 0, sg: 0, depth: 0, parallax: 0, pdepth: 80, glass: 70, layout: 'phone' },
  });
  const legacyFeed = JSON.stringify({
    v: 1, at: Date.now(), chav: { [CH_IDS[0]]: 'https://yt3.ggpht.com/av0.jpg' },
    items: TREND.slice(0, 24).map((id, i) => ({ id, t: TITLES[i % TITLES.length], c: 'Channel ' + (i % 6), ch: CH_IDS[i % 6], views: '1000', pub: pub(i), cat: 'All', dur: 750 })),
  });
  const env2 = open(NEW_FILE, { lt: legacyState, lt_feed: legacyFeed });
  const painted = await waitFor(() => env2.d.querySelectorAll('#feed .card').length >= 20, 25000);
  ok(painted, 'a plain-JSON feed cache from the old build still paints the feed');
  ok(env2.w.eval('S.liked.join(",")') === 't03AAAAAAAA', 'a plain-JSON state still restores liked');
  ok(env2.w.eval('S.opt.pdepth') === 80 && env2.w.eval('S.opt.glass') === 70, 'and its options');
  ok(env2.w.eval('S.subs.length') === 1, 'and its subscriptions');
  const warmReqs = env2.reqs.filter(u => u.includes('mostPopular')).length;
  ok(warmReqs === 1, 'the feed is still refetched on a warm start (cache is a paint source)', warmReqs);
  const noDur = env2.reqs.filter(u => /\/videos\?/.test(u) && /contentDetails/.test(u)).length;
  ok(noDur === 0, 'and a cached duration still skips the duration call', noDur);
  env2.w.eval('save()');
  const reRaw = env2.w.localStorage.getItem('lt');
  ok(reRaw.slice(0, 3) === 'z1:', 'one save rewrites the state compressed');
  const reObj = JSON.parse(decode(env2, 'lt'));
  ok(JSON.stringify(reObj) === JSON.stringify(JSON.parse(legacyState)), 'and decodes to exactly the object that was there');

  /* ---------- 5. corrupt compressed values ---------- */
  console.log('\n5. corrupt or truncated values');
  const bad = ['z1:', 'z1:\u0000\u0001\u0002', 'z1:' + 'A'.repeat(40), '{not json', 'null', '[]', '5'];
  let badOk = true, badDetail = '';
  for (const v of bad) {
    const e = open(NEW_FILE, { lt: v, lt_feed: v, lt_anime: v });
    const up = await waitFor(() => e.d.querySelector('.card, .skl'), 25000);
    if (!up || e.errors.length) { badOk = false; badDetail = JSON.stringify(v).slice(0, 20) + ' errors=' + e.errors.length; }
    if (e.w.eval('S.opt.pdepth') !== 65) { badOk = false; badDetail = 'options not defaulted for ' + JSON.stringify(v).slice(0, 20); }
  }
  ok(badOk, 'every corrupt value falls back to defaults with no console error', badDetail);

  /* ---------- 6. save → reopen ---------- */
  console.log('\n6. save, reopen, still there');
  const env3 = open(NEW_FILE);
  await waitFor(() => env3.d.querySelector('#feed .card'), 25000);
  env3.w.eval('toggle(S.liked,"t07AAAAAAAA");toggle(S.later,"t08AAAAAAAA");save()');
  const carried = dump(env3.w);
  const env4 = open(NEW_FILE, carried);
  await waitFor(() => env4.d.querySelector('#feed .card'), 25000);
  ok(env4.w.eval('S.liked.join(",")') === 't07AAAAAAAA', 'a like survives a compressed save and a reopen');
  ok(env4.w.eval('S.later.join(",")') === 't08AAAAAAAA', 'and the watch-later entry');
  ok(env4.d.querySelectorAll('#feed .card').length >= 20, 'and the feed paints from the compressed cache');
  ok(env4.errors.length === 0, 'with no console error', env4.errors.join(' | '));

  /* ---------- 7. old build vs new build ---------- */
  if (OLD_FILE) {
    console.log('\n7. old build vs new build');
    const surfaces = ['#chips', '#feed', '#ex', '#sg', '#subfeed'];
    const run = async file => {
      const e = open(file);
      await waitFor(() => e.d.querySelectorAll('#feed .card').length >= 20, 25000);
      await sleep(400);
      const s = {};
      surfaces.forEach(sel => { s[sel] = snap(e, sel); });
      const out = { s, reqs: e.reqs.slice(), errors: e.errors.slice(), w: e.w };
      return out;
    };
    const A = await run(OLD_FILE), B = await run(NEW_FILE);
    surfaces.forEach(sel => ok(A.s[sel] === B.s[sel], 'surface ' + sel + ' is byte-identical',
      A.s[sel] === B.s[sel] ? undefined : 'old ' + A.s[sel].length + ' B vs new ' + B.s[sel].length + ' B'));
    ok(JSON.stringify(A.reqs) === JSON.stringify(B.reqs), 'the request log is identical',
      A.reqs.length + ' vs ' + B.reqs.length);
    const oldRaw = A.w.localStorage.getItem('lt_feed');
    const newRaw = B.w.localStorage.getItem('lt_feed');
    ok(oldRaw.slice(0, 3) !== 'z1:' && newRaw.slice(0, 3) === 'z1:', 'old build stores plain, new build stores compressed');
    ok(JSON.parse(decode(B, 'lt_feed')).items.length === 24, 'and the new blob still decodes to 24 items');
  } else {
    console.log('\n7. old build vs new build — skipped (no second build given)');
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
