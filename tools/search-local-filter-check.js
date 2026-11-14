#!/usr/bin/env node
/*
 * LiquidTube local-search-filter check — proves item 7.4: a search answer is
 * filtered locally *before* a card is built, and a paint that would put the same
 * picture back rebuilds nothing.
 *
 * What it holds the build to:
 *
 *   1. An answer that carries a duplicate video, an entry with no id and an
 *      entry whose title is blank draws one card per real video — never two
 *      cards for one id, never a card with no name, never a card whose tap goes
 *      nowhere.
 *   2. No card node was ever *inserted* for a dropped entry: the panel did not
 *      build it and remove it, it never built it. A MutationObserver watches
 *      #results from before the search, so this is what the DOM saw, not what
 *      the code says.
 *   3. The filter runs before the work it can save: the `videos` duration call
 *      asks only about kept ids, once each, and the `channels` avatar call only
 *      about kept items' channels.
 *   4. The kept answer (7.3) and the launch blob (7.2) hold the cleaned list, so
 *      a paint from cache and a paint from the network are the same page.
 *   5. The same question answered again from the kept answer paints the same
 *      cards *without rebuilding them*: the element that was there is still
 *      there afterwards, and the panel counted the paint as skipped.
 *   6. A clean answer is untouched: twenty results still draw twenty cards, in
 *      the endpoint's order, with the same markup the previous build drew.
 *   7. The panel's DOM is the panel it always was: same ids, no new element, no
 *      new string, and an empty answer still says what it said.
 *   8. A failure still answers for itself with the app's own sentence and a
 *      retry (5.3, 5.8).
 *
 * jsdom + fixed fixtures, no network. Dev-only, not shipped in the APK.
 *
 *   NODE_PATH=/scratch/node_modules node tools/search-local-filter-check.js \
 *       app/assets/index.html /path/to/previous/index.html
 *
 * argv[2] is the build under test, argv[3] the previous build (optional; the A/B
 * half is skipped without it).
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const NEW_FILE = process.argv[2] || path.join(__dirname, '..', 'app/assets/index.html');
const OLD_FILE = process.argv[3] || '';
const LATENCY = 30;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const MIN = 60e3;

const pad = n => String(n).padStart(2, '0');
const vids = Array.from({ length: 20 }, (_, i) => 'v' + pad(i + 1) + 'AAAAAAAA');
const CH_IDS = Array.from({ length: 6 }, (_, i) => 'UC' + i + 'xxxxxxxxxxxxxxxxxxxx');
/* the messy page gets ids and channels of its own, so nothing about it is
   already known from the boot feed (durations, avatars, request cache) and every
   call it triggers is the panel's own */
const MVIDS = Array.from({ length: 16 }, (_, i) => 'm' + pad(i + 1) + 'BBBBBBBB');
const MCH = Array.from({ length: 6 }, (_, i) => 'MC' + i + 'yyyyyyyyyyyyyyyyyyyy');
const pub = d => new Date(Date.UTC(2026, 9, 31) - d * 864e5).toISOString();

const item = (id, title, i, ch) => ({
  id: id ? { videoId: id } : { kind: 'youtube#channel' },
  snippet: {
    title: title,
    channelTitle: 'Channel ' + (i % 6),
    channelId: (ch || CH_IDS)[i % 6],
    publishedAt: pub(i * 24),
  },
});

/* ---------- the clean page: what an ordinary query answers with ---------- */
const cleanBody = (q, max) => ({
  items: vids.slice(0, max || 20).map((id, i) => item(id, 'Result ' + i + ' for ' + q, i)),
});

/* ---------- the messy page ----------
 * The kinds of entry the item is about, in the places a real answer puts them:
 *
 *   · the same video twice — indexed twice, drawn twice, two taps to one video
 *   · a title that is only spaces — passes a "is there a title" check, is not a
 *     name a card can wear
 *   · no title at all, and no `id.videoId` at all — described, not openable
 *
 * The last two are also refused by the response shape check (5.9) before the
 * panel maps them, so the page exercises both layers: the shape check refuses
 * those two, `seaClean` refuses the blank title and the duplicate, and what is
 * left is the page. */
const MESSY_ITEMS = () => [
  item(MVIDS[0], 'First result', 0, MCH),
  item(MVIDS[1], 'Second result', 1, MCH),
  item(MVIDS[0], 'First result', 0, MCH),          /* the same video again */
  item(MVIDS[2], 'Fourth result', 2, MCH),
  item(MVIDS[3], 'Fifth result', 3, MCH),
  item(MVIDS[4], undefined, 4, MCH),               /* no title at all */
  item(MVIDS[5], '   ', 5, MCH),                   /* a title of spaces is no title */
  item(MVIDS[6], 'Eighth result', 6, MCH),
  item(MVIDS[7], 'Ninth result', 7, MCH),
  item(null, 'Tenth result', 8, MCH),              /* no id.videoId */
  item(MVIDS[8], 'Eleventh result', 9, MCH),
  item(MVIDS[9], 'Twelfth result', 10, MCH),
  item(MVIDS[10], 'Thirteenth result', 11, MCH),
  item(MVIDS[11], 'Fourteenth result', 12, MCH),
  item(MVIDS[12], 'Fifteenth result', 13, MCH),
  item(MVIDS[13], 'Sixteenth result', 14, MCH),
  item(MVIDS[14], 'Seventeenth result', 15, MCH),
  item(MVIDS[15], 'Eighteenth result', 16, MCH),
];
/* what a card can be drawn from: an id, and a title that is not blank — the
   first of each id, in the endpoint's own order */
const MESSY_WANT = (() => {
  const out = [], seen = new Set();
  for (const it of MESSY_ITEMS()) {
    const id = it.id && it.id.videoId;
    const t = String(it.snippet.title == null ? '' : it.snippet.title).trim();
    if (!id || !t || seen.has(id)) continue;
    seen.add(id); out.push(id);
  }
  return out;
})();
const messyBody = () => ({ items: MESSY_ITEMS() });

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
        description: 'A sample channel.',
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
};

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

function apiBody(url, env) {
  const u = new URL(url), p = u.pathname;
  if (p.endsWith('/videos')) return (u.searchParams.get('part') || '').includes('contentDetails') ? F.durations : F.videos;
  if (p.endsWith('/channels')) return chanAnswer(u, F.channels);
  if (p.endsWith('/playlistItems')) return F.playlistItems;
  if (p.endsWith('/search')) {
    const q = u.searchParams.get('q') || '', max = +(u.searchParams.get('maxResults') || 20);
    if (/^no-hits/.test(q)) return { items: [] };
    if (env && env.messy) return messyBody();
    return cleanBody(q, max);
  }
  return {};
}

/* the ids a `videos`/`channels` request asked about, from its URL */
const idsOf = rec => String(new URL(rec.url).searchParams.get('id') || '').split(',').filter(Boolean);

function open(file, seed) {
  const HTML = fs.readFileSync(file, 'utf8');
  const reqs = [];
  const env = { reqs, seed: seed || {}, fail: null, skew: 0, messy: false };
  const mockFetch = (u, init) => {
    const url = String(u);
    const rec = { url: url.replace(/([?&])key=[^&]*/, '$1key=<key>'), at: Date.now(), aborted: false, done: false, q: new URL(url).searchParams.get('q') };
    reqs.push(rec);
    return new Promise((res, rej) => {
      const t = setTimeout(() => {
        rec.done = true;
        if (env.fail === 'throw') return rej(new TypeError('Failed to fetch'));
        if (env.fail === 'error') return res({ ok: false, status: 500, json: async () => ({ error: { message: 'backend error' } }) });
        res({ ok: true, status: 200, headers: { get: () => null }, json: async () => apiBody(url, env) });
      }, LATENCY);
      const sig = init && init.signal;
      if (sig) {
        if (sig.aborted) { clearTimeout(t); const e = new Error('aborted'); e.name = 'AbortError'; rej(e); return; }
        sig.addEventListener('abort', () => {
          rec.aborted = true; clearTimeout(t);
          const e = new Error('aborted'); e.name = 'AbortError'; rej(e);
        });
      }
    });
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
      w.Date.now = () => Date.now() + env.skew;
      for (const k in env.seed) { try { w.localStorage.setItem(k, env.seed[k]) } catch (e) {} }
    },
  });
  env.w = dom.window;
  env.d = dom.window.document;
  env.dom = dom;
  env.storage = () => {
    const out = {};
    for (let i = 0; i < env.w.localStorage.length; i++) { const k = env.w.localStorage.key(i); out[k] = env.w.localStorage.getItem(k); }
    return out;
  };
  return env;
}
const ignorable = e => /WebAssembly|Cannot allocate/i.test(String((e && e.message) || ''));
process.on('uncaughtException', e => { if (!ignorable(e)) { console.error('uncaught', e); process.exit(1); } });
process.on('unhandledRejection', e => { if (!ignorable(e)) { console.error('unhandled', e); process.exit(1); } });

async function waitFor(fn, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(10); }
  return false;
}
function norm(h) {
  return String(h)
    .replace(/ class="ld"/g, '').replace(/ ld"/g, '"')
    .replace(/ data-f="1"/g, '')
    .replace(/ ?(?:transform|opacity|background-position-y):[^;"']*;?/g, '')
    .replace(/style="\s*"/g, '').replace(/\s{2,}/g, ' ').trim();
}
const cards = env => env.d.querySelectorAll('#results .card');
const cardIds = env => [...cards(env)].map(c => c.getAttribute('data-v'));
const searches = env => env.reqs.filter(r => /\/search\?/.test(r.url));
const units = env => env.w.__ltQuota().units;
const markup = env => norm(env.d.getElementById('results').innerHTML);
const filt = env => env.w.__ltSearchCache().filter;

async function boot(file, seed) {
  const env = open(file, seed);
  await waitFor(() => env.d.querySelectorAll('#feed .card').length > 0);
  await waitFor(() => !env.d.querySelector('#ex .skl'));
  await sleep(220);
  env.reqs.length = 0;
  return env;
}
/* one search, asked outright (a suggestion chip's path: no 300 ms pause), waited
   out properly: a new request is followed to its answer, a kept answer is
   already on screen when find() returns, and either way the skeleton has to be
   gone before the DOM is read. */
async function ask(env, q) {
  const s0 = searches(env).length, u0 = units(env);
  env.w.find();
  await waitFor(() => searches(env).length > s0, 1200);
  const mine = searches(env).slice(s0);
  if (mine.length) await waitFor(() => mine.every(r => r.done || r.aborted), 8000);
  await waitFor(() => !env.d.querySelector('#results .skl'), 8000);
  await sleep(80);
  return { reqs: searches(env).length - s0, units: units(env) - u0 };
}
/* every card node the panel ever inserted, watched from before the search */
function watch(env) {
  const seen = [];
  const mo = new env.w.MutationObserver(list => {
    for (const m of list) for (const n of m.addedNodes) {
      if (n.nodeType !== 1) continue;
      if (n.classList && n.classList.contains('card')) seen.push(n.getAttribute('data-v'));
      else if (n.querySelectorAll) for (const c of n.querySelectorAll('.card')) seen.push(c.getAttribute('data-v'));
    }
  });
  mo.observe(env.d.getElementById('results'), { childList: true, subtree: false });
  return { seen, stop: () => mo.disconnect() };
}

async function main(file, label, old) {
  const R = [];
  const ok = (name, pass, detail) => R.push({ name, pass: !!pass, detail });

  /* ---------- 1. the messy answer: one card per real video ---------- */
  const env = await boot(file);
  env.messy = true;
  const idsBefore = [...env.d.querySelectorAll('#search [id]')].map(e => e.id).sort().join(',');
  env.d.getElementById('sopen').click();
  await sleep(120);
  const w = watch(env);
  env.d.getElementById('q').value = 'messy';
  const cost = await ask(env, 'messy');
  const got = cardIds(env);
  const want = MESSY_WANT;

  /* a hundred for the search itself, plus the one-unit duration and channel
     lookups the kept page triggers */
  ok('the search really was a search', cost.reqs === 1 && cost.units >= 100 && cost.units <= 103,
    cost.reqs + ' request(s), ' + cost.units + ' unit(s)');
  ok('one card per real video', got.length === want.length, got.length + ' card(s), ' + want.length + ' distinct videos');
  ok('the duplicate video is drawn once', got.filter(id => id === MVIDS[0]).length === 1, got.filter(id => id === MVIDS[0]).length + ' card(s) for ' + MVIDS[0]);
  ok('no card for the entry with no id, none for a blank title',
    !got.includes(MVIDS[5]) && got.length === new Set(got).size && !got.includes(null),
    'ids: ' + got.filter(x => !x).length + ' empty, ' + (got.length - new Set(got).size) + ' repeated');
  ok('the order is the endpoint\'s order', got.join(',') === want.join(','), got.slice(0, 4).join(' ') + ' …');
  ok('no card says "undefined"', !/undefined/.test(env.d.getElementById('results').innerHTML), /undefined/.test(env.d.getElementById('results').innerHTML) ? 'found' : 'clean');
  ok('every card has a name', [...cards(env)].every(c => ((c.querySelector('b') || {}).textContent || '').trim()),
    [...cards(env)].filter(c => !((c.querySelector('b') || {}).textContent || '').trim()).length + ' nameless');

  /* ---------- 2. nothing was built and thrown away ---------- */
  w.stop();
  const inserted = w.seen.filter(Boolean);
  ok('no card node was ever built for a dropped entry', inserted.length === got.length && inserted.join(',') === got.join(','),
    inserted.length + ' node(s) inserted, ' + got.length + ' card(s) kept');
  ok('the filter counted what it dropped', filt(env).dup === 1 && filt(env).void === 1,
    'dup=' + filt(env).dup + ' void=' + filt(env).void + ' of ' + filt(env).raw + ' mapped');

  /* ---------- 3. the filter runs before the work it can save ---------- */
  const durReq = env.reqs.filter(r => /\/videos\?/.test(r.url) && /contentDetails/.test(r.url));
  const durIds = durReq.length ? idsOf(durReq[durReq.length - 1]) : [];
  ok('the duration call asks only about kept videos', durIds.length > 0 && durIds.every(id => want.includes(id)),
    durIds.length + ' id(s) asked, ' + want.length + ' kept');
  ok('and never twice for one video', durIds.length === new Set(durIds).size, durIds.length + ' id(s), ' + new Set(durIds).size + ' distinct');
  const chReq = env.reqs.filter(r => /\/channels\?/.test(r.url));
  const chIds = chReq.flatMap(idsOf);
  ok('the avatar call asks only about kept videos\' channels', chIds.length > 0 && chIds.every(id => MCH.includes(id)),
    chIds.length + ' channel(s) asked, all in the page');

  /* ---------- 4. the caches hold the cleaned list ---------- */
  const kept = env.w.__ltSearchCache().cached;
  ok('the kept answer (7.3) holds the cleaned page', kept && kept.items === want.length, kept ? kept.items + ' item(s)' : 'no kept answer');
  /* read through the page's own reader: the blob is compressed on write (2.8) */
  const blob = env.w.readSearchCache ? env.w.readSearchCache() : null;
  ok('the launch blob (7.2) holds the cleaned page', blob && blob.items.length === want.length, blob ? blob.items.length + ' item(s)' : 'no blob');
  ok('and neither holds the duplicate', !!blob && blob.items.filter(i => i.id === MVIDS[0]).length === 1,
    blob ? blob.items.filter(i => i.id === MVIDS[0]).length + ' entry/entries for ' + MVIDS[0] : '-');

  /* ---------- 5. the same answer again rebuilds nothing ---------- */
  const firstCard = cards(env)[0];
  const paintsBefore = filt(env).paint, sameBefore = filt(env).same;
  env.skew = 5 * MIN;                        /* inside the thirty minutes: the kept answer */
  const again = await ask(env, 'messy');
  ok('the repeat was answered from the kept answer', again.reqs === 0, again.reqs + ' request(s)');
  ok('the same page was painted without rebuilding it', firstCard === cards(env)[0] && filt(env).same === sameBefore + 1,
    'same element: ' + (firstCard === cards(env)[0]) + ', skipped paints: ' + (filt(env).same - sameBefore));
  ok('and the DOM write count did not move', filt(env).paint === paintsBefore, (filt(env).paint - paintsBefore) + ' new write(s)');
  ok('the cards on screen are unchanged', cardIds(env).join(',') === want.join(','), cardIds(env).length + ' card(s)');

  /* a live re-ask past the window buys the same page again: a skeleton, then the
     same cards — rebuilt, because the skeleton was there in between, but the page
     that lands is the page that was there */
  env.skew = 31 * MIN;
  const live = await ask(env, 'messy');
  ok('a live re-ask past the window still draws the cleaned page', live.reqs === 1 && cardIds(env).join(',') === want.join(','),
    live.reqs + ' request(s), ' + cardIds(env).length + ' card(s)');

  /* ---------- 6. a clean answer is untouched ---------- */
  env.skew = 0;
  env.messy = false;
  env.d.getElementById('q').value = 'lofi';    /* a new question: the field is what find() reads */
  const droppedBefore = { dup: filt(env).dup, void: filt(env).void };
  const cleanAsk = await ask(env, 'lofi');
  const cleanIds = cardIds(env);
  const cleanMarkup = markup(env);           /* the clean page, kept for the A/B half */
  ok('a clean answer still draws twenty cards', cleanIds.length === 20, cleanIds.length + ' card(s)');
  ok('all distinct, in order', cleanIds.join(',') === vids.join(','), cleanIds.slice(0, 3).join(' ') + ' …');
  ok('the filter dropped nothing from it', filt(env).dup === droppedBefore.dup && filt(env).void === droppedBefore.void,
    '+' + (filt(env).dup - droppedBefore.dup) + ' dup, +' + (filt(env).void - droppedBefore.void) + ' void');
  ok('and it cost one search', cleanAsk.reqs === 1, cleanAsk.reqs + ' request(s)');

  /* ---------- 7. the panel is the panel it always was ---------- */
  ok('no element was added to #search', [...env.d.querySelectorAll('#search [id]')].map(e => e.id).sort().join(',') === idsBefore, idsBefore);
  const c0 = cards(env)[0];
  ok('the cards carry the markup they always did',
    !!c0 && c0.tagName === 'BUTTON' && c0.className === 'card' && c0.getAttribute('data-v') === vids[0] &&
    !!c0.querySelector('.thumb img[src^="https://i.ytimg.com/vi/"][decoding="async"]') &&
    !!c0.querySelector('.meta b') && !!c0.querySelector('.meta span'),
    c0 ? c0.outerHTML.slice(0, 90) : 'no card');

  /* an empty answer still says what it said, and does not rebuild on a repeat */
  env.d.getElementById('q').value = '';
  env.w.find();
  await sleep(60);
  ok('a cleared field leaves the panel empty', cards(env).length === 0 && !env.d.getElementById('results').firstChild, cards(env).length + ' card(s)');
  env.d.getElementById('q').value = 'no-hits here';
  const e1 = await ask(env, 'no-hits here');
  const emptyMarkup = markup(env);
  const e2 = await ask(env, 'no-hits here');
  ok('an empty answer says so', /No videos match that/.test(emptyMarkup) && cards(env).length === 0, emptyMarkup.slice(0, 40));
  ok('and a repeat costs nothing', e1.reqs === 1 && e2.reqs === 0, e2.reqs + ' request(s) on the repeat');

  /* ---------- 8. a failure still answers for itself ---------- */
  env.fail = 'error';
  env.d.getElementById('q').value = 'failing';
  await ask(env, 'failing');
  ok('a failure still shows the app\'s own sentence and a retry',
    /Search failed/.test(markup(env)) && !!env.d.querySelector('#results [data-r]'), markup(env).slice(0, 60));
  env.fail = null;

  /* ---------- 9. A/B against the previous build, when one is given ---------- */
  if (old) {
    const oldEnv = await boot(old);
    oldEnv.messy = true;
    oldEnv.d.getElementById('sopen').click();
    await sleep(120);
    oldEnv.d.getElementById('q').value = 'messy';
    await ask(oldEnv, 'messy');
    const oldIds = cardIds(oldEnv);
    ok('the previous build drew the duplicate and the blank-title card',
      oldIds.length > want.length || oldIds.filter(id => id === MVIDS[0]).length > 1,
      'old: ' + oldIds.length + ' card(s), new: ' + want.length);
    const oldClean = await boot(old);
    oldClean.d.getElementById('q').value = 'lofi';
    await ask(oldClean, 'lofi');
    const same = norm(oldClean.d.getElementById('results').innerHTML) === cleanMarkup;
    ok('a clean answer draws the same markup as the previous build', same, same ? 'identical, card for card' : 'differs');
  }

  /* ---------- report ---------- */
  const bad = R.filter(r => !r.pass);
  console.log('\n  LiquidTube local search filter (item 7.4) — ' + label + '\n');
  for (const r of R) console.log('   ' + (r.pass ? 'PASS' : 'FAIL') + '  ' + r.name + (r.detail ? '  [' + r.detail + ']' : ''));
  console.log('\n  ' + (R.length - bad.length) + '/' + R.length + ' checks passed\n');
  process.exit(bad.length ? 1 : 0);
}

const label = path.basename(path.dirname(path.dirname(NEW_FILE)));
main(NEW_FILE, label, OLD_FILE).catch(e => { console.error(e); process.exit(1); });
