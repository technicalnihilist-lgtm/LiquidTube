#!/usr/bin/env node
/*
 * LiquidTube chip-switch check — proves item 7.5 ("fix chip switching when the
 * feed is still loading").
 *
 * The chip row was already cheap to tap, but what a tap *meant* depended on
 * whether the feed had landed. `chip()` filtered `feed()` when there was a feed to
 * filter and left the boot's skeletons alone when there was not; the boot's own
 * paintShell then drew `feed()` whole, with no idea which chip was lit. Two
 * surfaces were wrong because of it:
 *
 *   - a warm launch (last feed on screen, network answer still in flight) let the
 *     user tap a category, and the answer then replaced the filtered list with an
 *     unfiltered one under the same lit chip;
 *   - a section chip (Anime / Cartoon / Movies) could have its cards wiped by the
 *     trending list landing behind it, permanently, because the section's own
 *     paint had already happened.
 *
 * The launch that failed had a third problem: `[]` is falsy but an error is not an
 * empty list, so a chip tapped after a failed boot replaced the error box with
 * "Nothing in X right now." and took the only retry button away with it.
 *
 * What this tool holds the build to, in jsdom against fixtures (no network, no
 * device). The trending answer is held back for a fixed time so every scenario can
 * tap while the feed is genuinely in flight:
 *
 *  1. a category tapped during the load is honoured when the answer lands — the
 *     cards on screen are that category's, and the feed never showed an unfiltered
 *     list after the tap (a MutationObserver watches #feed from before the tap, so
 *     this is what the DOM saw, not what the code says);
 *  2. a run of taps inside the 140 ms swap draws the last chip's list once — not
 *     one list per tap, and not the unfiltered feed;
 *  3. a section chip keeps #feed while the trending list lands behind it: no
 *     trending card is ever painted over the section;
 *  4. a launch whose feed failed keeps the error box and its retry button when a
 *     chip is tapped;
 *  5. the settled behaviour is untouched: after a clean boot the same taps draw
 *     the same cards, in the same markup, as the previous build;
 *  6. no console error and no unhandled rejection anywhere, and the request log of
 *     a clean boot is unchanged.
 *
 *   npm i jsdom                                 # dev only, not shipped in the APK
 *   node tools/chip-switch-check.js app/assets/index.html [/tmp/old/index.html]
 *
 * argv[3] is optional: with a previous build the A/B assertions run against it and
 * must show the behaviour this item fixed.
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const NEW_FILE = process.argv[2] || path.join(__dirname, '..', 'app', 'assets', 'index.html');
const OLD_FILE = process.argv[3] || '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const pad = (n) => String(n).padStart(2, '0');
const vids = Array.from({ length: 24 }, (_, i) => 'v' + pad(i + 1) + 'AAAAAAAA');
const CH_IDS = Array.from({ length: 6 }, (_, i) => 'UC' + i + 'xxxxxxxxxxxxxxxxxxxx');
const pub = (d) => new Date(Date.UTC(2026, 9, 31) - d * 864e5).toISOString();
/* Five categories over 24 videos: Music 5, Gaming 5, Entertainment 5, News 5,
   Education 4 — every category chip the row can show has cards behind it. */
const CATS = ['10', '20', '24', '25', '27'];
const CATNAME = { 10: 'Music', 20: 'Gaming', 24: 'Entertainment', 25: 'News', 27: 'Education' };
const catOf = (i) => CATNAME[CATS[i % CATS.length]];
const MUSIC = () => vids.filter((_, i) => catOf(i) === 'Music');
const GAMING = () => vids.filter((_, i) => catOf(i) === 'Gaming');

const F = {
  videos: {
    items: vids.map((id, i) => ({
      id,
      snippet: {
        title: 'Sample trending video number ' + (i + 1) + ' with a realistic title',
        channelTitle: 'Channel ' + (i % 6),
        channelId: CH_IDS[i % 6],
        publishedAt: pub(i + 1),
        categoryId: CATS[i % CATS.length],
        thumbnails: { maxres: { url: 'https://i.ytimg.com/vi/' + id + '/maxresdefault.jpg' } },
      },
      statistics: { viewCount: String(1000 * (i + 1) * 7) },
    })),
  },
  channels: {
    items: CH_IDS.map((id, i) => ({
      id,
      snippet: {
        title: 'Channel ' + i, customUrl: 'channel' + i, publishedAt: '2015-04-02T10:00:00Z',
        country: 'IN', description: 'A sample channel.',
        thumbnails: { medium: { url: 'https://yt3.ggpht.com/av' + i + '.jpg' } },
      },
      statistics: { subscriberCount: '1200000', videoCount: '480', viewCount: '91000000' },
      contentDetails: { relatedPlaylists: { uploads: 'UU' + i + 'xxxxxxxxxxxxxxxxxxxx' } },
      brandingSettings: { image: { bannerExternalUrl: '' }, channel: {} },
    })),
  },
};

/* A section's uploads carry ids of their own (`u0…`, `u1…`), so "was a trending
   card painted over the section?" is a question about the ids in the DOM rather
   than a count that happens to differ. */
function plistAnswer(u) {
  const pl = String(u.searchParams.get('playlistId') || '');
  const tag = 'u' + (pl.slice(2, 3) || '0');
  return {
    items: Array.from({ length: 12 }, (_, i) => ({
      snippet: {
        title: 'Section video ' + (i + 1) + ' from ' + tag,
        resourceId: { videoId: tag + pad(i + 1) },
        channelTitle: 'Section channel',
        channelId: CH_IDS[0],
        publishedAt: pub(i + 3),
      },
      contentDetails: { videoPublishedAt: pub(i + 3) },
    })),
  };
}
const isSectionId = (id) => /^u/.test(String(id));

function chanAnswer(u) {
  const want = String(u.searchParams.get('id') || '').split(',').filter(Boolean);
  const have = new Map(F.channels.items.map((c) => [c.id, c]));
  return {
    items: want.map((id) => have.get(id) || {
      id,
      snippet: { title: 'Channel ' + id.slice(2, 8), customUrl: 'c' + id.slice(2, 8), publishedAt: '2015-04-02T10:00:00Z', country: 'IN', description: 'A sample channel.', thumbnails: { medium: { url: 'https://yt3.ggpht.com/' + id + '.jpg' } } },
      statistics: { subscriberCount: '1000', videoCount: '10', viewCount: '10000' },
      contentDetails: { relatedPlaylists: { uploads: 'UU' + id.slice(2) } },
      brandingSettings: { image: { bannerExternalUrl: '' }, channel: {} },
    }),
  };
}
/* durations answer about whatever ids are asked for, so a section's ids are
   measured too and none of them is treated as an unmeasured short. */
function durAnswer(u) {
  const ids = String(u.searchParams.get('id') || '').split(',').filter(Boolean);
  return { items: ids.map((id) => ({ id, contentDetails: { duration: 'PT12M30S' } })) };
}
function apiBody(u) {
  const p = u.pathname;
  if (p.endsWith('/videos')) return (u.searchParams.get('part') || '').includes('contentDetails') ? durAnswer(u) : F.videos;
  if (p.endsWith('/channels')) return chanAnswer(u);
  if (p.endsWith('/playlistItems')) return plistAnswer(u);
  if (p.endsWith('/search')) return { items: [] };
  return {};
}
const isTrending = (u) => /\/videos\?/.test(u) && /chart=mostPopular/.test(u);

/* the last feed the app would have written itself, in the shape readFeedCache
   accepts (plain JSON is a valid encoding: loadJSON only unpacks a prefixed one) */
function seedFeed() {
  return JSON.stringify({
    v: 1,
    at: Date.now() - 60000,
    chav: {},
    items: F.videos.items.map((it, i) => ({
      id: it.id, t: it.snippet.title, c: it.snippet.channelTitle, ch: it.snippet.channelId,
      views: it.statistics.viewCount, pub: it.snippet.publishedAt, cat: catOf(i), dur: 750,
    })),
  });
}

/* a page: fresh window and localStorage, a fetch that answers from the fixtures.
   `delayFor` decides how long a request is held back (the trending answer, in every
   scenario below); `queue` is prefilled because the boot request fires while the
   document is still being parsed. */
function open(file, pre) {
  pre = pre || {};
  const HTML = fs.readFileSync(file, 'utf8');
  const env = {
    log: [], lines: [], errors: [], rejects: [], queue: pre.queue || [],
    only: pre.only || null, delayFor: pre.delayFor || null,
  };
  const mockFetch = async (u) => {
    u = String(u);
    env.log.push({ url: u.replace(/([?&])key=[^&]*/, '$1key=<key>'), t: Date.now() });
    if (env.delayFor) {
      const ms = env.delayFor(u);
      if (ms) await sleep(ms);
    }
    const step = (env.queue.length && (!env.only || env.only(u))) ? env.queue.shift() : 'ok';
    if (step === 'throw') throw new TypeError('Failed to fetch');
    if (step === 'abort') { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
    const j = apiBody(new URL(u));
    return { ok: true, status: 200, headers: new Map(), json: async () => j };
  };
  const dom = new JSDOM(HTML, {
    url: 'https://liquidtube.local/index.html',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(w) {
      w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
      w.fetch = mockFetch;
      w.scrollTo = () => {};
      if (pre.seed) { try { w.localStorage.setItem('lt_feed', pre.seed); } catch (e) {} }
      w.console.log = (...a) => { env.lines.push(a.map((x) => (typeof x === 'string' ? x : String(x))).join(' ')); };
      w.console.error = (...a) => { env.errors.push(a.map((x) => String(x)).join(' ')); };
      w.addEventListener('unhandledrejection', (e) => env.rejects.push(String((e && e.reason && e.reason.message) || e)));
    },
  });
  env.w = dom.window;
  env.d = dom.window.document;
  env.dom = dom;
  return env;
}
const ignorable = (e) => /WebAssembly|Cannot allocate/i.test(String((e && e.message) || e));
process.on('uncaughtException', (e) => { if (!ignorable(e)) { console.error('uncaught', e); process.exit(1); } });
process.on('unhandledRejection', (e) => { if (!ignorable(e)) { console.error('unhandledRejection', e); process.exit(1); } });

async function waitFor(fn, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(20); }
  return false;
}

let pass = 0;
const fails = [];
function ok(label, cond, detail) {
  if (cond) { pass++; return; }
  fails.push(label + (detail !== undefined ? ' — ' + detail : ''));
}

const clean = (s) => String(s).replace(/\s+/g, ' ').trim();
const feedBox = (env) => env.d.getElementById('feed');
const cardIds = (env) => [...env.d.querySelectorAll('#feed .card')].map((c) => c.dataset.v);
const litChip = (env) => { const b = env.d.querySelector('#chips .chip.on'); return b ? clean(b.textContent) : ''; };
const feedText = (env) => clean(feedBox(env).textContent);
const skelCount = (env) => env.d.querySelectorAll('#feed .skl').length;
const rtyCount = (env) => env.d.querySelectorAll('#feed .rty').length;
const chipNames = (env) => [...env.d.querySelectorAll('#chips .chip')].map((b) => clean(b.textContent));
/* the feed's markup without inline style: the depth frame writes transforms into
   the cards and which frame a read lands on is timing, not a change this item
   makes. Everything a card looks like comes from its classes. */
const feedHTML = (env) => {
  const c = feedBox(env).cloneNode(true);
  c.querySelectorAll('[style]').forEach((n) => n.removeAttribute('style'));
  return clean(c.innerHTML);
};
function tap(env, name) {
  const b = [...env.d.querySelectorAll('#chips .chip')].find((x) => clean(x.textContent) === name);
  if (!b) return false;
  b.click();
  return true;
}
/* every card node ever inserted into #feed, and every distinct list the feed
   showed, from before the tap: the record of what the page drew, not of what the
   code intended. */
function watchFeed(env) {
  const rec = { cards: 0, lists: [], ids: new Set() };
  const grab = () => {
    const ids = cardIds(env);
    const key = ids.join(',');
    if (!rec.lists.length || rec.lists[rec.lists.length - 1].key !== key) rec.lists.push({ key, ids, t: Date.now() });
    ids.forEach((id) => rec.ids.add(id));
  };
  const mo = new env.w.MutationObserver((muts) => {
    let touched = false;
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue;
        touched = true;
        if (n.classList && n.classList.contains('card')) rec.cards++;
        else if (n.querySelectorAll) rec.cards += n.querySelectorAll('.card').length;
      }
    }
    if (touched) grab();
  });
  mo.observe(feedBox(env), { childList: true, subtree: true });
  grab();
  rec.stop = () => mo.disconnect();
  rec.sizes = () => rec.lists.map((l) => l.ids.length);
  return rec;
}

const HOLD = 900;                              /* how long the trending answer is held back */
const holdTrending = (u) => (isTrending(u) ? HOLD : 0);
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/* 1: a category tapped during a warm launch, then the answer landing on top */
async function warmTap(file) {
  const env = open(file, { delayFor: holdTrending, seed: seedFeed() });
  await waitFor(() => cardIds(env).length > 0 && chipNames(env).includes('Music'), 8000);
  const before = { cards: cardIds(env).length, chips: chipNames(env) };
  const rec = watchFeed(env);
  const tapped = tap(env, 'Music');
  await sleep(300);                            /* the 140 ms swap has fired, the answer has not */
  const mid = { ids: cardIds(env), lit: litChip(env) };
  await waitFor(() => env.log.filter((e) => isTrending(e.url)).length > 0 && Date.now() - before.t > HOLD, 20000);
  await sleep(900);                            /* the answer lands and paints */
  const after = { ids: cardIds(env), lit: litChip(env), drawn: rec.cards, sizes: rec.sizes() };
  rec.stop();
  const errors = env.errors.slice(), rejects = env.rejects.slice();
  env.dom.window.close();
  return { before, tapped, mid, after, errors, rejects };
}

/* 2: a run of five taps inside the swap's window — the last one wins, once */
async function warmRun(file) {
  const env = open(file, { delayFor: holdTrending, seed: seedFeed() });
  await waitFor(() => cardIds(env).length > 0 && chipNames(env).includes('Gaming'), 8000);
  const rec = watchFeed(env);
  ['Music', 'Gaming', 'News', 'Entertainment', 'Gaming'].forEach((n) => tap(env, n));
  await sleep(300);
  const mid = { ids: cardIds(env), lit: litChip(env), sizes: rec.sizes() };
  await sleep(HOLD + 900);
  const after = { ids: cardIds(env), lit: litChip(env), drawn: rec.cards, sizes: rec.sizes() };
  rec.stop();
  const errors = env.errors.slice(), rejects = env.rejects.slice();
  env.dom.window.close();
  return { mid, after, errors, rejects };
}

/* 3: a section chip owns #feed while the trending list lands behind it */
async function sectionDuringLoad(file) {
  const env = open(file, { delayFor: holdTrending });
  await waitFor(() => chipNames(env).includes('Anime'), 5000);
  await sleep(100);
  const rec = watchFeed(env);
  const tapped = tap(env, 'Anime');
  await waitFor(() => cardIds(env).length > 0, 20000);
  await sleep(HOLD + 1200);                    /* long enough for the answer to land and paint */
  const ids = cardIds(env);
  const out = {
    tapped, lit: litChip(env), cards: ids.length,
    trending: ids.filter((id) => !isSectionId(id)),
    section: ids.filter(isSectionId).length,
    ever: [...rec.ids].filter((id) => !isSectionId(id)),
    sizes: rec.sizes(),
  };
  rec.stop();
  const errors = env.errors.slice(), rejects = env.rejects.slice();
  env.dom.window.close();
  return Object.assign(out, { errors, rejects });
}

/* 4: a launch whose feed failed keeps its way out when a chip is tapped */
async function failedFeed(file) {
  const env = open(file, { queue: ['throw', 'throw', 'throw', 'throw'], only: isTrending });
  const got = await waitFor(() => rtyCount(env) > 0, 20000);
  const box = { text: feedText(env), rty: rtyCount(env), chips: chipNames(env) };
  const tapped = tap(env, 'All');
  await sleep(400);
  const after = { text: feedText(env), rty: rtyCount(env), lit: litChip(env), cards: cardIds(env).length };
  const errors = env.errors.slice(), rejects = env.rejects.slice();
  env.dom.window.close();
  return { got, box, tapped, after, errors, rejects };
}

/* 5: the settled behaviour — same taps, same cards, same markup as before */
async function settled(file) {
  const env = open(file);
  await waitFor(() => cardIds(env).length > 0, 20000);
  await sleep(600);
  const all = { ids: cardIds(env), html: feedHTML(env), lit: litChip(env), reqs: env.log.length };
  tap(env, 'Music');
  await sleep(400);
  const music = { ids: cardIds(env), html: feedHTML(env), lit: litChip(env) };
  tap(env, 'All');
  await sleep(400);
  const back = { ids: cardIds(env), html: feedHTML(env), lit: litChip(env) };
  const errors = env.errors.slice(), rejects = env.rejects.slice();
  env.dom.window.close();
  return { all, music, back, errors, rejects };
}

(async () => {
  const warm = await warmTap(NEW_FILE);
  const run = await warmRun(NEW_FILE);
  const sec = await sectionDuringLoad(NEW_FILE);
  const failed = await failedFeed(NEW_FILE);
  const set = await settled(NEW_FILE);

  const old = OLD_FILE ? {
    warm: await warmTap(OLD_FILE),
    run: await warmRun(OLD_FILE),
    sec: await sectionDuringLoad(OLD_FILE),
    failed: await failedFeed(OLD_FILE),
    settled: await settled(OLD_FILE),
  } : null;

  /* ---- 1. a category tapped during the load is honoured ---- */
  ok('a warm launch shows the last feed with the whole chip row', warm.before.cards === vids.length && warm.before.chips.includes('Music'),
    JSON.stringify({ cards: warm.before.cards, chips: warm.before.chips }));
  ok('the tap filters the cards that are already on screen', warm.tapped && same(warm.mid.ids, MUSIC()) && warm.mid.lit === 'Music',
    warm.mid.ids.length + ' cards under "' + warm.mid.lit + '"');
  ok('the answer that lands keeps that category', same(warm.after.ids, MUSIC()) && warm.after.lit === 'Music',
    warm.after.ids.length + ' cards under "' + warm.after.lit + '"');
  ok('the feed never shows an unfiltered list after the tap', warm.after.sizes.slice(1).every((n) => n === MUSIC().length),
    JSON.stringify(warm.after.sizes));
  /* two paints happen after the tap — the swap's and the landing answer's — and
     both are the same category, so no card of any other category is ever built */
  ok('no other category\'s card is inserted after the tap', warm.after.drawn === 2 * MUSIC().length,
    warm.after.drawn + ' card nodes drawn');

  /* ---- 2. a run of taps draws one list, once ---- */
  ok('a run of taps ends on the last chip tapped', run.mid.lit === 'Gaming' && run.after.lit === 'Gaming', run.after.lit);
  ok('and draws that chip\'s list', same(run.mid.ids, GAMING()) && same(run.after.ids, GAMING()),
    run.after.ids.length + ' cards, wanted ' + GAMING().length);
  ok('once, not once per tap', run.after.sizes.slice(1).every((n) => n === GAMING().length),
    JSON.stringify(run.after.sizes));

  /* ---- 3. a section chip keeps the feed ---- */
  ok('a section chip tapped during the load keeps the feed', sec.tapped && sec.section > 0 && sec.lit === 'Anime',
    JSON.stringify({ cards: sec.cards, section: sec.section, lit: sec.lit }));
  ok('no trending card is painted over it', sec.trending.length === 0 && sec.ever.length === 0,
    JSON.stringify({ now: sec.trending.slice(0, 3), ever: sec.ever.slice(0, 3) }));

  /* ---- 4. a failed launch keeps its way out ---- */
  ok('a failed feed shows the error box and its retry button', failed.got && failed.box.rty === 1, JSON.stringify(failed.box));
  ok('a chip tapped then keeps that button', failed.tapped && failed.after.rty === 1 && /Could not load videos\./.test(failed.after.text),
    JSON.stringify(failed.after));

  /* ---- 5. the settled behaviour is untouched ---- */
  ok('a clean boot paints every video', set.all.ids.length === vids.length && set.all.lit === 'All', String(set.all.ids.length));
  ok('a settled tap filters to that category', same(set.music.ids, MUSIC()) && set.music.lit === 'Music', String(set.music.ids.length));
  ok('All puts the whole feed back, in the same markup', same(set.back.ids, vids) && set.back.html === set.all.html && set.back.lit === 'All',
    String(set.back.ids.length));

  /* ---- 6. nothing else moves ---- */
  const errs = [...warm.errors, ...run.errors, ...sec.errors, ...failed.errors, ...set.errors];
  const rejs = [...warm.rejects, ...run.rejects, ...sec.rejects, ...failed.rejects, ...set.rejects];
  ok('no page or console error', errs.length === 0, JSON.stringify(errs.slice(0, 3)));
  ok('no unhandled rejection', rejs.length === 0, JSON.stringify(rejs.slice(0, 3)));

  /* ---- A/B: the previous build showed the behaviour this item fixes ---- */
  if (old) {
    ok('A/B: the old build painted an unfiltered list under the tapped chip',
      !same(old.warm.after.ids, MUSIC()) && old.warm.after.ids.length === vids.length,
      old.warm.after.ids.length + ' cards under "' + old.warm.after.lit + '"');
    ok('A/B: the old build lost the run of taps to the landing answer',
      old.run.after.ids.length === vids.length, String(old.run.after.ids.length));
    ok('A/B: the old build lost a section chip to the trending list',
      old.sec.trending.length > 0, JSON.stringify({ cards: old.sec.cards, trending: old.sec.trending.length }));
    ok('A/B: the old build dropped the retry button on a chip tap',
      old.failed.after.rty === 0, JSON.stringify(old.failed.after));
    ok('A/B: the settled lists are the same markup as the old build',
      old.settled.all.html === set.all.html && old.settled.music.html === set.music.html &&
      old.settled.back.html === set.back.html,
      'all ' + (old.settled.all.html === set.all.html) + ' music ' + (old.settled.music.html === set.music.html) +
      ' back ' + (old.settled.back.html === set.back.html));
    ok('A/B: a clean boot sends the same requests as the old build',
      old.settled.all.reqs === set.all.reqs, old.settled.all.reqs + ' vs ' + set.all.reqs);
  }

  console.log(JSON.stringify({
    new: {
      warm: { before: warm.before.cards, mid: { n: warm.mid.ids.length, lit: warm.mid.lit }, after: { n: warm.after.ids.length, lit: warm.after.lit, drawn: warm.after.drawn, sizes: warm.after.sizes } },
      run: { lit: run.after.lit, n: run.after.ids.length, sizes: run.after.sizes },
      section: { cards: sec.cards, section: sec.section, trending: sec.trending.length },
      failed: failed.after,
    },
    old: old ? {
      warm: { n: old.warm.after.ids.length, lit: old.warm.after.lit, sizes: old.warm.after.sizes },
      run: { n: old.run.after.ids.length, sizes: old.run.after.sizes },
      section: { cards: old.sec.cards, trending: old.sec.trending.length },
      failed: old.failed.after,
    } : null,
  }, null, 2));
  console.log('');
  fails.forEach((f) => console.log('FAIL ' + f));
  console.log(pass + ' ok, ' + fails.length + ' failed');
  if (fails.length) { console.error('pass: false'); process.exit(1); }
  console.log('pass: true');
})().catch((e) => { console.error(e); process.exit(1); });
