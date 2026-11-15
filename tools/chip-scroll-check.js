#!/usr/bin/env node
/*
 * LiquidTube per-chip scroll check — proves item 7.6 ("keep the scroll position
 * per chip").
 *
 * A chip swaps the contents of #feed inside the one Home page, so the page
 * scroller kept whatever offset it happened to hold. Every chip with fewer cards
 * than the one being left clamped that offset, and coming back to the chip the
 * user had been reading landed them at the top of it — the list was rebuilt
 * correctly and then thrown away by the position. The chip row was therefore the
 * one navigation in the app that cost a scroll.
 *
 * What this tool holds the build to, in jsdom against fixtures (no network, no
 * device). jsdom has no layout, so the page scroller is given one here: the
 * scroller's scrollHeight is derived from the cards it actually holds and
 * scrollTop clamps against it exactly as a real scroller would. That clamping is
 * the whole point of the item — an offset restored before the list is in the DOM
 * is an offset the browser throws away.
 *
 *  1. a chip is left deep in a long list, a short chip is visited, and the long
 *     chip is returned to at the offset it was left at;
 *  2. a second chip keeps its own offset — the memory is per chip, not one
 *     offset shared by the row;
 *  3. a chip that cannot hold the remembered offset (fewer cards) clamps, and the
 *     chip that can hold it still lands where it was left;
 *  4. a section chip (Anime) — the asynchronous path, where the feed is dropped
 *     to skeletons before the list arrives — restores on arrival too;
 *  5. a second tap inside the 140 ms swap (the chip that never painted) files no
 *     offset under the chip it passed through;
 *  6. a chip left at the top remembers nothing and lands at the top;
 *  7. nothing else moves: the cards, the lit chip and the markup of a settled
 *     switch are what they were before, and no console error or unhandled
 *     rejection is raised anywhere;
 *  8. with a previous build on the command line, the same taps are shown to lose
 *     the position there (the A/B, so the item is a fix and not a restatement).
 *
 *   npm i jsdom                                 # dev only, not shipped in the APK
 *   node tools/chip-scroll-check.js app/assets/index.html [/tmp/old/index.html]
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
   Education 4 — so a chip switch is always a switch to a list of a different
   length, which is what makes a shared offset clamp. */
const CATS = ['10', '20', '24', '25', '27'];
const CATNAME = { 10: 'Music', 20: 'Gaming', 24: 'Entertainment', 25: 'News', 27: 'Education' };
const catOf = (i) => CATNAME[CATS[i % CATS.length]];

/* the fake scroller: one card is 120 px, the page has 400 px of chrome above and
   below, the viewport is 768 px — so 24 cards can scroll 2512 px and a 5-card
   chip can scroll 232 px, and a 1200 px offset cannot survive in the second. */
const ROW = 120, CHROME = 400, VIEW = 768;
const cardCount = (el) => (el.querySelectorAll ? el.querySelectorAll('.card').length : 0);

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

/* a page: fresh window and localStorage, a fetch that answers from the fixtures,
   and a scroller that behaves like one. */
function open(file, pre) {
  pre = pre || {};
  const HTML = fs.readFileSync(file, 'utf8');
  const env = { log: [], lines: [], errors: [], rejects: [] };
  const mockFetch = async (u) => {
    u = String(u);
    env.log.push(u.replace(/([?&])key=[^&]*/, '$1key=<key>'));
    if (pre.delayFor) {
      const ms = pre.delayFor(u);
      if (ms) await sleep(ms);
    }
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
      /* the layout jsdom does not do: a scroller that has a height and clamps */
      const st = new WeakMap();
      Object.defineProperty(w.Element.prototype, 'scrollHeight', {
        configurable: true,
        get() {
          if (!this.classList || !this.classList.contains('page')) return 0;
          return cardCount(this) * ROW + CHROME;
        },
      });
      Object.defineProperty(w.Element.prototype, 'clientHeight', {
        configurable: true,
        get() { return this.classList && this.classList.contains('page') ? VIEW : 0; },
      });
      /* A real scroller clamps twice: when an offset is written, and again when
         the content shrinks under it (the layout pass that follows a shorter
         list). Both are modelled, because a build that restores an offset before
         the list is in the DOM only fails the second one. */
      Object.defineProperty(w.Element.prototype, 'scrollTop', {
        configurable: true,
        get() {
          const max = Math.max(0, this.scrollHeight - this.clientHeight);
          const held = st.get(this) || 0;
          const y = Math.min(held, max);
          if (y !== held) st.set(this, y);
          return y;
        },
        set(v) {
          const max = Math.max(0, this.scrollHeight - this.clientHeight);
          const y = Math.max(0, Math.min(Math.round(Number(v) || 0), max));
          st.set(this, y);
        },
      });
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
const homePage = (env) => env.d.getElementById('p-home');
const cardIds = (env) => [...env.d.querySelectorAll('#feed .card')].map((c) => c.dataset.v);
const litChip = (env) => { const b = env.d.querySelector('#chips .chip.on'); return b ? clean(b.textContent) : ''; };
const chipNames = (env) => [...env.d.querySelectorAll('#chips .chip')].map((b) => clean(b.textContent));
const st = (env) => homePage(env).scrollTop;
const maxSt = (env) => Math.max(0, homePage(env).scrollHeight - homePage(env).clientHeight);
/* What a settled list is: the cards, their order and their text. Not the inline
   style (the depth frame writes transforms into the cards, and which frame a read
   lands on is timing) and not the thumbnail's src (a lazy thumb swaps its
   placeholder for the decoded image on its own schedule). */
const feedShape = (env) => cardIds(env).join(',') + ' | ' + clean(feedBox(env).textContent);
function tap(env, name) {
  const b = [...env.d.querySelectorAll('#chips .chip')].find((x) => clean(x.textContent) === name);
  if (!b) return false;
  b.click();
  return true;
}
function scrollTo(env, y) {
  const pg = homePage(env);
  pg.scrollTop = y;
  return pg.scrollTop;                        /* what the scroller could actually hold */
}

const HOLD = 900;
const holdTrending = (u) => (isTrending(u) ? HOLD : 0);

/* a warm launch with the feed on screen and every category chip in the row */
async function boot(file) {
  const env = open(file, { delayFor: holdTrending, seed: seedFeed() });
  await waitFor(() => cardIds(env).length > 0 && chipNames(env).includes('Music'), 10000);
  await sleep(120);
  return env;
}

/* 1 + 2 + 3: leave a long chip deep, visit a short one, come back */
async function roundTrip(file) {
  const env = await boot(file);
  const before = { cards: cardIds(env).length, shape: feedShape(env) };
  const deep = scrollTo(env, 1200);
  tap(env, 'Music');
  await sleep(300);
  const music = { ids: cardIds(env), lit: litChip(env), st: st(env), max: maxSt(env) };
  const musicDeep = scrollTo(env, 200);
  tap(env, 'Gaming');
  await sleep(300);
  const gaming = { st: st(env), max: maxSt(env) };
  tap(env, 'Music');                          /* back to the chip left at 200 */
  await sleep(300);
  const backMusic = { st: st(env), lit: litChip(env), ids: cardIds(env) };
  tap(env, 'All');                            /* back to the chip left at 1200 */
  await sleep(300);
  const backAll = { st: st(env), lit: litChip(env), ids: cardIds(env), shape: feedShape(env) };
  const errors = env.errors.slice(), rejects = env.rejects.slice();
  env.dom.window.close();
  return { before, deep, music, musicDeep, gaming, backMusic, backAll, errors, rejects };
}

/* 4: the section chip's asynchronous path */
async function sectionTrip(file) {
  const env = await boot(file);
  const deep = scrollTo(env, 2400);
  tap(env, 'Anime');
  await waitFor(() => cardIds(env).length > 0 && cardIds(env).every((id) => /^u/.test(id)), 10000);
  await sleep(150);
  const anime = { st: st(env), max: maxSt(env), cards: cardIds(env).length };
  tap(env, 'All');
  await sleep(300);
  const backAll = { st: st(env), ids: cardIds(env) };
  const errors = env.errors.slice(), rejects = env.rejects.slice();
  env.dom.window.close();
  return { deep, anime, backAll, errors, rejects };
}

/* 5: a tap that never painted must not file an offset under the chip it passed */
async function quickRun(file) {
  const env = await boot(file);
  tap(env, 'Music');
  await sleep(300);
  const musicSt = scrollTo(env, 200);
  tap(env, 'All');                            /* Music's list is still on screen … */
  tap(env, 'Gaming');                         /* … and never painted for All */
  await sleep(400);
  const after = { st: st(env), lit: litChip(env), ids: cardIds(env) };
  tap(env, 'Music');                          /* Music's own offset must be intact */
  await sleep(300);
  const backMusic = { st: st(env), ids: cardIds(env) };
  const errors = env.errors.slice(), rejects = env.rejects.slice();
  env.dom.window.close();
  return { musicSt, after, backMusic, errors, rejects };
}

/* 6: a chip left at the top remembers nothing */
async function topTrip(file) {
  const env = await boot(file);
  const atTop = st(env);
  tap(env, 'News');                           /* never scrolled */
  await sleep(300);
  const news = st(env);
  tap(env, 'All');
  await sleep(300);
  const backAll = st(env);
  const errors = env.errors.slice(), rejects = env.rejects.slice();
  env.dom.window.close();
  return { atTop, news, backAll, errors, rejects };
}

/* 8: the A/B — the previous build, same taps */
async function oldTrip(file) {
  const env = await boot(file);
  scrollTo(env, 1200);
  tap(env, 'Music');
  await sleep(300);
  tap(env, 'All');
  await sleep(300);
  const backAll = st(env);
  env.dom.window.close();
  return { backAll };
}

(async () => {
  const r = await roundTrip(NEW_FILE);

  /* 1 — a long chip comes back at the offset it was left at */
  ok('1 the scroller could hold the deep offset', r.deep === 1200, 'held ' + r.deep);
  ok('1 the short chip is what the tap asked for', r.music.lit === 'Music' && r.music.ids.length === 5,
    r.music.lit + ' / ' + r.music.ids.length + ' cards');
  ok('1 the short chip clamps the offset it cannot hold', r.music.st <= r.music.max && r.music.max < 1200,
    'st ' + r.music.st + ' max ' + r.music.max);
  ok('1 the chip left deep is returned to deep', r.backAll.st === 1200, 'landed at ' + r.backAll.st);
  ok('1 … with its own cards, once', r.backAll.ids.length === r.before.cards && r.backAll.lit === 'All',
    r.backAll.ids.length + ' cards, lit ' + r.backAll.lit);

  /* 2 — the memory is per chip */
  ok('2 the second chip could hold its own offset', r.musicDeep === 200, 'held ' + r.musicDeep);
  ok('2 the third chip starts at the top', r.gaming.st === 0, 'started at ' + r.gaming.st);
  ok('2 each chip returns to its own offset', r.backMusic.st === 200 && r.backMusic.ids.length === 5,
    'Music landed at ' + r.backMusic.st);

  /* 7 — nothing else moved */
  ok('7 a settled switch draws the same list, in the same order, as before',
    r.backAll.shape === r.before.shape, r.backAll.shape.slice(0, 160) + ' …');
  ok('7 no console error', r.errors.length === 0, r.errors.join(' | '));
  ok('7 no unhandled rejection', r.rejects.length === 0, r.rejects.join(' | '));

  const s = await sectionTrip(NEW_FILE);
  /* 4 — the asynchronous section path */
  ok('4 the section chip loaded its own cards', s.anime.cards >= 12, s.anime.cards + ' cards');
  ok('4 a fresh section chip starts at its own top', s.anime.st === 0, 'started at ' + s.anime.st);
  ok('4 All is restored after a section chip', s.backAll.st === 2400, 'landed at ' + s.backAll.st);
  ok('4 no console error on the section path', s.errors.length === 0, s.errors.join(' | '));
  ok('4 no unhandled rejection on the section path', s.rejects.length === 0, s.rejects.join(' | '));

  const q = await quickRun(NEW_FILE);
  /* 5 — a tap that never painted files nothing */
  ok('5 the run of taps landed on the last chip', q.after.lit === 'Gaming' && q.after.ids.length === 5,
    q.after.lit + ' / ' + q.after.ids.length + ' cards');
  ok('5 the skipped chip is not given the previous offset', q.after.st === 0, 'Gaming started at ' + q.after.st);
  ok('5 the chip passed through keeps its own offset', q.backMusic.st === 200, 'Music landed at ' + q.backMusic.st);
  ok('5 no console error in the quick run', q.errors.length === 0, q.errors.join(' | '));
  ok('5 no unhandled rejection in the quick run', q.rejects.length === 0, q.rejects.join(' | '));

  const t = await topTrip(NEW_FILE);
  /* 6 — the top is the top */
  ok('6 a chip never scrolled starts at the top', t.news === 0, 'started at ' + t.news);
  ok('6 and All is still at the top', t.backAll === 0, 'landed at ' + t.backAll);
  ok('6 no console error in the top run', t.errors.length === 0, t.errors.join(' | '));

  /* 8 — the A/B, when a previous build is given */
  if (OLD_FILE) {
    const o = await oldTrip(OLD_FILE);
    ok('8 the previous build loses the offset (so this is a fix)', o.backAll !== 1200,
      'the old build already kept it, at ' + o.backAll);
    console.log('A/B: old build returned to ' + o.backAll + ' px, new build to ' + r.backAll.st + ' px');
  }

  if (fails.length) {
    console.error('FAIL (' + fails.length + ' of ' + (pass + fails.length) + ')');
    fails.forEach((f) => console.error('  ✗ ' + f));
    process.exit(1);
  }
  console.log('chip-scroll-check: ' + pass + ' assertions passed');
  if (!OLD_FILE) console.log('(no previous build given: the A/B was skipped)');
})();
