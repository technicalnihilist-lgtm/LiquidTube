#!/usr/bin/env node
/*
 * LiquidTube corrupted-state check — proves item 5.6 ("recover from a corrupted
 * localStorage state without losing data").
 *
 * `lt` is the whole of the user's own data: history, likes, later,
 * subscriptions and every setting. It used to be read with `loadJSON`, which
 * answers its fallback for anything it cannot parse — the right answer for a
 * cache, the wrong one for this key. A blob that lost a byte loaded as "this
 * user has nothing", and the next `save()` (one heart, one setting) wrote that
 * empty state back over the damaged copy, so the damage cost the library once
 * and the overwrite cost it for good.
 *
 * The build under test reads `lt` through `readKey`, which on a value that will
 * not parse — or parses to the wrong shape — does four things in order: it
 * writes the raw string, byte for byte, to `lt_rec_lt` as plain JSON before
 * anything can overwrite it; it salvages whatever of the value still reads
 * (longest decodable prefix of the codec, then every `"key": <value>` at depth
 * 1, each parsed on its own, with whole 11-character ids kept from a list that
 * will not parse); it merges the state field by field, by type; and if the
 * backup itself fails it holds the key so `save()` cannot write, retrying the
 * backup on the next save. `window.__ltRecover()` is the census this run reads.
 *
 * Everything runs in jsdom with googleapis.com answered from fixtures — no
 * network, no device, deterministic. Scenarios:
 *
 *   clean       a valid blob loads as before: nothing damaged, no slot, library
 *               intact, and a change made in the session survives a reload
 *   truncated   the compressed blob cut to 60 %: backed up byte-identical, the
 *               ids that still decode are the ones the library keeps, and the
 *               key on disk is still the damaged bytes after the boot
 *   garbage     a value with no valid code at all: backed up, defaults, the feed
 *               still paints, no console error
 *   halfjson    plain JSON cut inside a field: the complete fields are recovered
 *               (hist keeps both ids) and only the broken one is dropped
 *   shape       valid JSON of the wrong shape (`[1,2,3]`): treated as damage
 *   types       a blob whose fields have the wrong types: each good field is
 *               kept, each bad one falls back to its default
 *   quota       the backup cannot be written: the key is held, `save()` writes
 *               nothing, the damaged bytes stay on disk, and the next save after
 *               room appears backs up and writes normally
 *   slots       damage is bounded: at most 8 backup slots, and the first copy of
 *               a key is never replaced by a later one
 *   caches      a corrupt `lt_feed` / `lt_anime` is a cache miss, not data: no
 *               backup slot, no damage counted, and the feed still paints
 *   ui          the same markup as the previous build, and the same storage keys
 *
 * Usage:
 *   npm i jsdom                              # dev only, not shipped in the APK
 *   node tools/state-recovery-check.js app/assets/index.html [previous-build.html]
 * Exit code 1 when the build under test fails any check.
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
const pad = n => String(n).padStart(3, '0');
const pub = d => new Date(Date.UTC(2026, 10, 1) - d * 864e5).toISOString();
const CH_IDS = Array.from({ length: 6 }, (_, i) => 'UC' + i + 'xxxxxxxxxxxxxxxxxxxx');
const TREND = Array.from({ length: 24 }, (_, i) => 'v' + pad(i + 1) + 'AAAAAAAA');
const id = (p, n) => (p + pad(n) + 'ABCDEFGHIJ').slice(0, 11);   /* 11 chars, like a real id */

const fixtures = () => ({
  trending: {
    items: TREND.map((v, i) => ({
      id: v,
      snippet: {
        title: 'Trending video number ' + (i + 1) + ' — लिक्विड',
        channelTitle: 'Channel ' + (i % 6),
        channelId: CH_IDS[i % 6],
        publishedAt: pub(i + 1),
        categoryId: ['10', '20', '24', '25', '27', '17'][i % 6],
      },
      statistics: { viewCount: String(1000 * (i + 1) * 7) },
    })),
  },
  channels: { items: CH_IDS.map((c, i) => ({
    id: c,
    snippet: { title: 'Channel ' + i, customUrl: 'channel' + i, publishedAt: '2015-04-02T10:00:00Z', country: 'IN', description: 'A sample channel.' },
    statistics: { subscriberCount: '1200000', videoCount: '480', viewCount: '91000000' },
    contentDetails: { relatedPlaylists: { uploads: 'UU' + i + 'xxxxxxxxxxxxxxxxxxxx' } },
    brandingSettings: { image: { bannerExternalUrl: '' }, channel: {} },
  })) },
});

function apiBody(env, url) {
  const u = new URL(url), p = u.pathname, F = env.F;
  if (p.endsWith('/videos')) {
    if ((u.searchParams.get('part') || '').includes('contentDetails')) {
      const want = String(u.searchParams.get('id') || '').split(',').filter(Boolean);
      return { items: want.map(v => ({ id: v, contentDetails: { duration: 'PT12M30S' } })) };
    }
    return F.trending;
  }
  if (p.endsWith('/channels')) return F.channels;
  if (p.endsWith('/playlistItems') || p.endsWith('/search')) return { items: [] };
  return {};
}

/* Open the page with `seed` already in localStorage. `quota` makes every write
   to a backup slot throw, which is how a full disk and a private-mode WebView
   behave. `noRec` opens a build that has no recovery at all (the previous one),
   for the markup A/B. */
function open(file, seed, opts) {
  opts = opts || {};
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
      const set = w.Storage.prototype.setItem;
      w.__quota = !!opts.quota;
      w.Storage.prototype.setItem = function (k, v) {
        if (w.__quota && /^lt_rec_/.test(String(k))) {
          const e = new Error('QuotaExceededError: simulated');
          e.name = 'QuotaExceededError';
          throw e;
        }
        return set.call(this, k, v);
      };
      if (seed) { try { Object.keys(seed).forEach(k => w.localStorage.setItem(k, seed[k])); } catch (e) {} }
    },
  });
  env.w = dom.window;
  env.d = dom.window.document;
  return env;
}
const ignorable = e => /WebAssembly|Cannot allocate/i.test(String((e && e.message) || ''));
process.on('uncaughtException', e => { if (!ignorable(e)) { console.error('uncaught', e); process.exit(1); } });
process.on('unhandledRejection', e => { if (!ignorable(e)) { console.error('unhandled', e); process.exit(1); } });

async function waitFor(fn, ms = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(20); }
  return false;
}
const rec = env => JSON.parse(env.w.eval('JSON.stringify(__ltRecover())'));
const lib = env => JSON.parse(env.w.eval('JSON.stringify(__ltLibrary())'));
const optOf = env => JSON.parse(env.w.eval('JSON.stringify(S.opt)'));
const get = (env, k) => env.w.localStorage.getItem(k);
/* the screen, with the page's own <script> text taken out: the markup a user
   sees, not the source that produced it */
const uiHtml = env => {
  const c = env.d.body.cloneNode(true);
  c.querySelectorAll('script').forEach(s => s.remove());
  return c.innerHTML;
};
const slots = env => { const o = []; for (let i = 0; i < env.w.localStorage.length; i++) { const k = env.w.localStorage.key(i); if (k && k.indexOf('lt_rec_') === 0) o.push(k); } return o; };
/* every key on disk except `lt_boot`, which the startup timeline writes when the
   first frame carrying the feed is painted — asynchronously, so it is not a
   comparison of what a build persists but of when a frame landed. */
const allKeys = env => { const o = []; for (let i = 0; i < env.w.localStorage.length; i++) { const k = env.w.localStorage.key(i); if (k !== 'lt_boot') o.push(k); } return o.sort(); };
const booted = async env => await waitFor(() => env.d.querySelectorAll('#feed .card').length >= 20);
/* the app's own codec, so the blob under test is exactly what a real build wrote */
const pack = (env, o) => env.w.eval('storeJSON(' + JSON.stringify(o) + ')');

async function main() {
  const base = open(NEW_FILE);
  ok(await booted(base), 'the build under test boots and paints the feed');
  ok(rec(base).damaged === 0, 'a first launch damages nothing', JSON.stringify(rec(base).keys));

  /* ---------- 1. clean ---------- */
  console.log('\n1. clean — a valid blob loads exactly as before');
  const cleanState = { hist: [id('h', 1), id('h', 2)], liked: [id('k', 1)], later: [id('l', 1)], subs: [CH_IDS[0]], vd: { [id('h', 1)]: { t: 'A title' } }, opt: { cc: 1, glass: 70, layout: 'phone' } };
  const cleanBlob = pack(base, cleanState);
  ok(/^z1:/.test(cleanBlob), 'the state blob under test is compressed (' + cleanBlob.length + ' chars)');
  const c1 = open(NEW_FILE, { lt: cleanBlob });
  ok(await booted(c1), 'it boots with the seeded blob');
  const r1 = rec(c1), l1 = lib(c1), o1 = optOf(c1);
  ok(r1.damaged === 0 && r1.backed === 0, 'nothing is counted as damaged', JSON.stringify(r1));
  ok(slots(c1).length === 0, 'no backup slot is written', slots(c1).join(','));
  ok(l1.hist === 2 && l1.liked === 1 && l1.later === 1, 'the library loads whole', JSON.stringify(l1));
  ok(o1.cc === 1 && o1.glass === 70, 'the settings load whole', JSON.stringify({ cc: o1.cc, glass: o1.glass }));
  ok(c1.errors.length === 0, 'no console error', c1.errors.join(' | '));
  /* the state still round-trips through the codec: change it, reload the keys */
  c1.w.eval('toggle(S.liked,' + JSON.stringify(id('k', 2)) + ')');
  const afterLike = get(c1, 'lt');
  ok(/^z1:/.test(afterLike) && afterLike !== cleanBlob, 'a like rewrites the blob, still compressed');
  const keys1 = {}; allKeys(c1).forEach(k => { keys1[k] = get(c1, k); });
  const c2 = open(NEW_FILE, keys1);
  ok(await booted(c2), 'the reload boots');
  ok(lib(c2).liked === 2, 'the like survived the reload', lib(c2).liked);

  /* ---------- 2. truncated ---------- */
  console.log('\n2. truncated — the compressed blob cut at 60 %');
  const big = { hist: Array.from({ length: 60 }, (_, i) => id('h', i)), liked: Array.from({ length: 40 }, (_, i) => id('k', i)), later: Array.from({ length: 30 }, (_, i) => id('l', i)), opt: { cc: 0, glass: 45, layout: 'phone' } };
  const bigBlob = pack(base, big);
  const cut = bigBlob.slice(0, Math.floor(bigBlob.length * 0.6));
  ok(cut.length < bigBlob.length && cut.length > 100, 'the damaged copy is ' + cut.length + ' of ' + bigBlob.length + ' chars');
  const t1 = open(NEW_FILE, { lt: cut });
  ok(await booted(t1), 'it boots on the damaged blob');
  const rt = rec(t1), lt1 = lib(t1);
  ok(rt.damaged === 1 && rt.backed === 1, 'the damage is seen and backed up', JSON.stringify({ d: rt.damaged, b: rt.backed }));
  ok(slots(t1).join(',') === 'lt_rec_lt', 'the backup lives in lt_rec_lt', slots(t1).join(','));
  const slot = JSON.parse(get(t1, 'lt_rec_lt'));
  ok(slot.raw === cut, 'the backup is the damaged bytes, byte for byte (' + slot.raw.length + ' chars)');
  ok(slot.why === 'parse' && slot.key === 'lt' && typeof slot.at === 'number', 'the slot records what it is', JSON.stringify({ why: slot.why, key: slot.key }));
  ok(!/^z1:/.test(get(t1, 'lt_rec_lt')), 'the backup is plain JSON, not through the codec');
  ok(get(t1, 'lt') === cut, 'the key on disk is still the damaged bytes after the boot');
  const kept = lt1.hist + lt1.liked + lt1.later;
  ok(rt.salvaged === 1 && kept > 0, 'what still decodes is salvaged (' + kept + ' ids kept)', JSON.stringify({ salvaged: rt.salvaged, kept }));
  const all = new Set([].concat(big.hist, big.liked, big.later));
  const list = JSON.parse(t1.w.eval('JSON.stringify([].concat(S.hist,S.liked,S.later))'));
  ok(list.every(x => all.has(x)), 'every kept id was in the original state, none invented');
  ok(list.every(x => /^[A-Za-z0-9_-]{11}$/.test(x)), 'every kept id is a whole id');
  ok(t1.errors.length === 0, 'no console error', t1.errors.join(' | '));

  /* ---------- 3. garbage ---------- */
  console.log('\n3. garbage — a value with no valid code in it');
  const junk = 'z1:a' + String.fromCharCode(0x400) + String.fromCharCode(0x401) + '\u0007\u0000';
  const g1 = open(NEW_FILE, { lt: junk });
  ok(await booted(g1), 'the feed still paints on a junk blob');
  const rg = rec(g1);
  ok(rg.damaged === 1 && rg.failed === 1 && rg.salvaged === 0, 'nothing is salvaged and it says so', JSON.stringify(rg));
  ok(JSON.parse(get(g1, 'lt_rec_lt')).raw === junk, 'the junk is backed up untouched');
  ok(lib(g1).hist === 0 && optOf(g1).glass === 45, 'the app runs on its defaults');
  ok(g1.errors.length === 0, 'no console error', g1.errors.join(' | '));

  /* ---------- 4. half-written plain JSON ---------- */
  console.log('\n4. halfjson — plain JSON cut inside a field');
  const half = '{"hist":[' + JSON.stringify(id('h', 1)) + ',' + JSON.stringify(id('h', 2)) + '],"liked":[' + JSON.stringify(id('k', 1)).slice(0, 6);
  const h1 = open(NEW_FILE, { lt: half });
  ok(await booted(h1), 'it boots on the half-written blob');
  const rh = rec(h1), lh = lib(h1);
  ok(rh.damaged === 1 && rh.salvaged === 1, 'the blob is salvaged', JSON.stringify(rh));
  ok(lh.hist === 2, 'the complete field is recovered whole (hist 2)', lh.hist);
  ok(JSON.parse(get(h1, 'lt_rec_lt')).raw === half, 'the half-written copy is kept');
  ok(h1.errors.length === 0, 'no console error', h1.errors.join(' | '));

  /* ---------- 5. valid JSON, wrong shape ---------- */
  console.log('\n5. shape — valid JSON of the wrong shape');
  const s1 = open(NEW_FILE, { lt: '[1,2,3]' });
  ok(await booted(s1), 'it boots');
  const rs = rec(s1);
  ok(rs.damaged === 1 && rs.backed === 1, 'a value of the wrong shape counts as damage', JSON.stringify(rs));
  ok(JSON.parse(get(s1, 'lt_rec_lt')).raw === '[1,2,3]', 'and is backed up');
  ok(lib(s1).hist === 0, 'the app runs on defaults');
  const s2 = open(NEW_FILE, { lt: '"just a string"' });
  ok(await booted(s2), 'a scalar value boots too');
  ok(rec(s2).damaged === 1, 'and is treated as damage', rec(s2).damaged);

  /* ---------- 6. field types ---------- */
  console.log('\n6. types — fields in the wrong shape');
  const typed = JSON.stringify({ hist: [id('h', 1), 5, null, { a: 1 }], liked: 'nope', later: [id('l', 1)], subs: 7, opt: { cc: 1, glass: 'x', layout: 7, pdepth: 80 } });
  const y1 = open(NEW_FILE, { lt: typed });
  ok(await booted(y1), 'it boots');
  const ly = lib(y1), oy = optOf(y1);
  ok(rec(y1).damaged === 0, 'a blob that parses is not damage', rec(y1).damaged);
  ok(ly.hist === 1 && ly.liked === 0 && ly.later === 1, 'only the well-shaped lists survive', JSON.stringify({ h: ly.hist, k: ly.liked, l: ly.later }));
  ok(oy.cc === 1 && oy.glass === 45 && oy.layout === 'phone' && oy.pdepth === 80, 'each setting is taken only in its own type', JSON.stringify({ cc: oy.cc, glass: oy.glass, layout: oy.layout, pdepth: oy.pdepth }));
  ok(y1.errors.length === 0, 'no console error', y1.errors.join(' | '));

  /* ---------- 7. no room for the backup ---------- */
  console.log('\n7. quota — the backup cannot be written');
  const q1 = open(NEW_FILE, { lt: cut }, { quota: true });
  ok(await booted(q1), 'it boots with the backup refused');
  const rq = rec(q1);
  ok(rq.damaged === 1 && rq.backed === 0 && rq.held === 1, 'the key is held instead', JSON.stringify(rq));
  ok(rq.hold.join(',') === 'lt', 'the hold names the key', rq.hold.join(','));
  ok(slots(q1).length === 0, 'no slot was written');
  ok(get(q1, 'lt') === cut, 'the damaged bytes are still on disk');
  const likedBefore = lib(q1).liked;
  const fresh = 'z999ABCDEFG';                             /* not in the salvaged state */
  q1.w.eval('toggle(S.liked,' + JSON.stringify(fresh) + ')');
  ok(get(q1, 'lt') === cut, 'a change made while held does not overwrite them');
  q1.w.__quota = false;                                    /* room appears */
  q1.w.eval('save()');
  const rq2 = rec(q1);
  ok(rq2.hold.length === 0 && slots(q1).length === 1, 'the next save backs up and releases the hold', JSON.stringify(rq2));
  ok(JSON.parse(get(q1, 'lt_rec_lt')).raw === cut, 'the backup that landed is the damaged copy');
  const written = JSON.parse(q1.w.eval('JSON.stringify(loadJSON(localStorage.getItem("lt"),null))'));
  ok(written.liked.indexOf(fresh) >= 0, 'and the state is written normally again');

  /* ---------- 8. bounded damage ---------- */
  console.log('\n8. slots — damage is bounded');
  const b1 = open(NEW_FILE);
  ok(await booted(b1), 'a clean boot for the slot test');
  b1.w.eval('quarantine("lt","first","parse")');
  b1.w.eval('quarantine("lt","second","parse")');
  ok(JSON.parse(get(b1, 'lt_rec_lt')).raw === 'first', 'the first damaged copy is the one kept');
  for (let i = 0; i < 12; i++) b1.w.eval('quarantine(' + JSON.stringify('k' + i) + ',' + JSON.stringify('raw' + i) + ',"parse")');
  ok(slots(b1).length <= 8, 'at most 8 backup slots exist (' + slots(b1).length + ')', slots(b1).join(','));
  ok(JSON.parse(get(b1, 'lt_rec_k11')).raw === 'raw11', 'the newest damage is kept');
  ok(slots(b1).indexOf('lt_rec_lt') < 0, 'the oldest slot is the one evicted when the cap is reached');
  b1.w.eval('quarantine("k5","raw5-again","parse")');
  ok(JSON.parse(get(b1, 'lt_rec_k5')).raw === 'raw5', 'a later copy of an already-backed-up key never replaces the first');

  /* ---------- 9. caches are not data ---------- */
  console.log('\n9. caches — a corrupt cache is a miss, not data');
  const k1 = open(NEW_FILE, { lt_feed: 'z1:\u00ff\u00ff', lt_anime: '{"at":1,"items":[', lt_quota: 'not json' });
  ok(await booted(k1), 'the feed paints with three corrupt caches');
  ok(rec(k1).damaged === 0, 'no damage is counted for a cache', rec(k1).damaged);
  ok(slots(k1).length === 0, 'and no backup slot is spent on one', slots(k1).join(','));
  ok(k1.errors.length === 0, 'no console error', k1.errors.join(' | '));

  /* ---------- 10. the UI does not move ---------- */
  console.log('\n10. ui — the same screen and the same keys');
  const uiState = { hist: [id('h', 1)], liked: [id('k', 1)], later: [], opt: { cc: 0, glass: 45, layout: 'phone' } };
  const a = open(NEW_FILE, { lt: pack(base, uiState) });
  await booted(a);
  const nodesA = a.d.querySelectorAll('*').length, feedA = a.d.querySelector('#feed').innerHTML;
  const chipsA = Array.from(a.d.querySelectorAll('.chip')).map(c => c.textContent.trim()).join('|');
  const bodyA = uiHtml(a);
  /* the two sheets that draw the state, so a recovered state cannot change how
     they look either */
  const libA = (a.w.eval('openLibrary()'), a.d.querySelector('#sheet').outerHTML);
  const setA = (a.w.eval('sheet("Settings",settingsHTML(),0)'), a.d.querySelector('#sheet').outerHTML);
  if (OLD_FILE) {
    const o = open(OLD_FILE, { lt: pack(base, uiState) });
    ok(await booted(o), 'the previous build boots on the same seed');
    ok(o.d.querySelector('#feed').innerHTML === feedA, 'the feed markup is byte-identical to the previous build');
    ok(o.d.querySelectorAll('*').length === nodesA, 'the node count is identical (' + nodesA + ')');
    ok(Array.from(o.d.querySelectorAll('.chip')).map(c => c.textContent.trim()).join('|') === chipsA, 'the chips are identical');
    ok(allKeys(o).join(',') === allKeys(a).join(','), 'the same storage keys are written', 'new ' + allKeys(a).join(',') + ' / old ' + allKeys(o).join(','));
    ok(o.d.querySelectorAll('#dock .tab').length === a.d.querySelectorAll('#dock .tab').length, 'the dock has the same tabs');
    ok(uiHtml(o) === bodyA, 'the whole booted screen is byte-identical (' + bodyA.length + ' chars of markup)');
    ok((o.w.eval('openLibrary()'), o.d.querySelector('#sheet').outerHTML) === libA, 'the library sheet is byte-identical');
    ok((o.w.eval('sheet("Settings",settingsHTML(),0)'), o.d.querySelector('#sheet').outerHTML) === setA, 'the settings sheet is byte-identical');
  } else {
    console.log('  (no previous build given: the A/B markup comparison is skipped)');
  }
  ok(!a.d.querySelector('[class*=recov],[id*=recov],[class*=corrupt],[id*=corrupt]'), 'no element was added to the screen');

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
