#!/usr/bin/env node
/*
 * LiquidTube thumbnail-failure check — item 6.5.
 *
 * The claim of 6.5 is that a thumbnail that has already failed is not asked for
 * again on the next render, and that this changes nothing the user can see. Both
 * halves are asserted here, on a real boot of the app in jsdom, and the second
 * half is asserted against the build before the item when a second file is given.
 *
 *  1. REMEMBERED. A card whose picked size came back as the CDN's grey 120 px
 *     placeholder (`THOK`) and a card whose request errored (`TH`) are both
 *     recorded against their video id: the census counts one mark each, and the
 *     element still ends where it ended before — `hqdefault`.
 *  2. NOT ASKED AGAIN. Re-render the whole feed through the app's own `list()`
 *     over `feed()` — the path a chip switch takes — and fire every new card. Not one of the marked ids asks
 *     for its picked size again: the level-1 cards come up on `hqdefault` with
 *     the fallback flag already set, and the count of skipped requests is the
 *     count of marked ids. On the build before the item the same re-render asks
 *     for every one of them again — that number is printed, and when a second
 *     file is given it is compared.
 *  3. THE SAME PICTURE. The `src` a remembered card ends up with is byte-for-byte
 *     the file the old build reaches after its own fallback — `hqdefault` — so
 *     the picture on screen is the picture it always was, one round trip earlier.
 *  4. DEAD IS DEAD. A video whose fallback failed too is not asked for at all: no
 *     `src` attribute, the image hidden and the box carrying the app's gradient —
 *     the same three things `TH`'s second failure does, and the same look the old
 *     build arrives at after its two failures.
 *  5. THE RUNG, NOT THE VIDEO. `sddefault` is missing on many uploads while
 *     `maxresdefault` exists, so a failure at one rung must not shrink a card
 *     that resolves to another: a remembered `sddefault` leaves a card that wants
 *     `hqdefault` asking for its own file, unflagged.
 *  6. IT EXPIRES. A tunnel that dropped is not a life sentence: past
 *     `THUMB_FAIL_TTL` the id is asked for again at its picked size, and the
 *     expiry is counted.
 *  7. BOUNDED. 500 marked ids leave the map at its ceiling.
 *  8. NOTHING PERSISTED. No storage key, on a fresh boot.
 *  9. THE PROBE. The boot self-check carries `thumbfail` and it passes.
 * 10. THE UI DOES NOT CHANGE. Every card's tree — with `src`, `data-l`,
 *     `decoding` and `data-f` taken out — is identical to the old build's, and a
 *     card that has been through both failures has the same tree *including* its
 *     inline style, which is what draws the gradient.
 *
 * Runs in jsdom with googleapis answered from fixtures — no network, no Chromium,
 * no device — on the same harness as tools/lazy-thumb-check.js.
 *
 *   npm i jsdom
 *   node tools/thumb-fail-check.js app/assets/index.html
 *   node tools/thumb-fail-check.js app/assets/index.html /tmp/old/index.html
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
        title: 'Sample trending video number ' + (i + 1),
        channelTitle: 'Channel ' + (i % 6),
        channelId: CH_IDS[i % 6],
        publishedAt: pub(i),
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
      snippet: { title: 'Channel ' + i, customUrl: 'channel' + i, publishedAt: '2015-04-02T10:00:00Z', country: 'IN', description: 'A sample channel.', thumbnails: { medium: { url: 'https://yt3.ggpht.com/av' + i + '.jpg' } } },
      statistics: { subscriberCount: '1200000', videoCount: '480', viewCount: '91000000' },
      contentDetails: { relatedPlaylists: { uploads: 'UU' + i + 'xxxxxxxxxxxxxxxxxxxx' } },
      brandingSettings: { image: { bannerExternalUrl: '' }, channel: {} },
    })),
  },
  search: {
    items: vids.slice(0, 20).map((id, i) => ({
      id: { videoId: id },
      snippet: { title: 'Search result ' + i, channelTitle: 'Channel ' + (i % 6), channelId: CH_IDS[i % 6], publishedAt: pub(i) },
    })),
  },
};

function apiBody(url) {
  const u = new URL(url), p = u.pathname;
  if (p.endsWith('/videos')) return (u.searchParams.get('part') || '').includes('contentDetails') ? F.durations : F.videos;
  if (p.endsWith('/channels')) return F.channels;
  if (p.endsWith('/playlistItems')) {
    return { items: F.search.items.map(it => ({ snippet: Object.assign({}, it.snippet, { resourceId: { videoId: it.id.videoId } }), contentDetails: { videoPublishedAt: it.snippet.publishedAt } })) };
  }
  if (p.endsWith('/search')) return F.search;
  return {};
}

function open(file) {
  const HTML = fs.readFileSync(file, 'utf8');
  const env = { ios: [], lines: [], errors: [] };
  const mockFetch = async u => ({ ok: true, status: 200, json: async () => apiBody(String(u)), headers: new Map() });
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
const imgsOf = env => [...env.d.querySelectorAll('#feed .card .thumb img')];
const census = env => (env.w.__ltThumbs ? env.w.__ltThumbs() : null);
const srcOf = img => img.getAttribute('src');
const rungOf = s => String(s || '').split('/').pop().replace(/\.jpg$/, '');

/* Deliver an intersection for every armed thumbnail the app is holding. */
function fireAll(env) {
  const io = env.ios[env.ios.length - 1];
  if (!io) return 0;
  const targets = [...io.targets];
  io.cb(targets.map(t => ({ target: t, isIntersecting: true })), io);
  return targets.length;
}

/* One card's tree, optionally with the inline style — which is what draws the
   gradient on a dead card. */
const lookOf = (el, withStyle) => {
  const walk = (n, out) => {
    for (const c of n.childNodes) {
      if (c.nodeType === 3) { const t = c.textContent.trim(); if (t) out.push('#' + t); continue; }
      if (c.nodeType !== 1) continue;
      const attrs = [...c.attributes]
        .filter(a => !['src', 'loading', 'data-l', 'decoding', 'data-f', 'data-fd'].includes(a.name))
        .filter(a => withStyle || a.name !== 'style')
        .map(a => a.name + '=' + a.value).sort().join(';');
      out.push('<' + c.tagName + ' ' + attrs);
      walk(c, out);
      out.push('>');
    }
    return out;
  };
  return walk(el, []).join('|');
};
const feedLook = (env, withStyle) => cardsOf(env).map(c => lookOf(c, withStyle)).join('\n');

/* The old build's own failure path, applied to one card: a grey placeholder
   (`THOK`) and then a request error (`TH`) — which is exactly the pair a real
   WebView delivers for a video whose picture is not there. */
function failCard(env, img) {
  Object.defineProperty(img, 'naturalWidth', { value: 120, configurable: true });
  env.w.THOK(img);
  env.w.TH(img);
}

async function boot(file) {
  const env = open(file);
  const seen = await waitFor(() => env.w.__ltTimeline && env.lines.some(l => l.indexOf('lt-startup') === 0));
  ok('boot reached its timeline', seen);
  ok('the feed rendered 24 cards', await waitFor(() => cardsOf(env).length === 24), String(cardsOf(env).length));
  await sleep(150);
  return env;
}

/* Re-render the feed the way a chip switch does — the app's own `list()` over
   the app's own `feed()` — and fire what the render armed. `loadTrending()`
   cannot be used for this: it returns the feed it already has and paints
   nothing. */
async function repaint(env) {
  const before = imgsOf(env);
  env.w.eval('(function(){list(feed(),document.getElementById("feed"))})()');
  await waitFor(() => imgsOf(env).length === 24 && imgsOf(env)[0] !== before[0]);
  await sleep(200);
  fireAll(env);
  await sleep(60);
  return imgsOf(env);
}

const idsOf = imgs => imgs.map(i => i.dataset.id);

(async () => {
  /* ---- 1 & 2 & 3. remembered, and not asked for again ---- */
  {
    const env = await boot(FILE);
    const first = imgsOf(env);
    fireAll(env);
    await sleep(60);
    ok('every card asked for its picture on the first pass',
      first.every(i => !!srcOf(i)), first.filter(i => !srcOf(i)).length + ' without');

    /* six level-1 cards: the size came back as the grey placeholder */
    const one = first.slice(0, 6);
    one.forEach(i => { Object.defineProperty(i, 'naturalWidth', { value: 120, configurable: true }); env.w.THOK(i); });
    const c1 = census(env);
    ok('a failed size is remembered against the video',
      c1.mark1 === 6 && c1.fail === 6, 'mark1=' + c1.mark1 + ' fail=' + c1.fail);
    ok('and the element still ends on hqdefault, as before',
      one.every(i => /\/hqdefault\.jpg$/.test(srcOf(i))), one.map(i => rungOf(srcOf(i))).join(' '));

    /* four level-2 cards: the fallback failed too */
    const two = first.slice(6, 10);
    two.forEach(i => failCard(env, i));
    const c2 = census(env);
    ok('a video whose fallback failed too is remembered as dead',
      c2.mark2 === 4 && c2.fail === 10, 'mark2=' + c2.mark2 + ' fail=' + c2.fail);

    const deadIds = new Set(idsOf(two));
    const oneIds = new Set(idsOf(one));
    const fresh = imgsOf(env).length;   /* the feed the app is holding */

    const next = await repaint(env);
    const c3 = census(env);
    const nextOne = next.filter(i => oneIds.has(i.dataset.id));
    const nextTwo = next.filter(i => deadIds.has(i.dataset.id));
    const nextFresh = next.filter(i => !oneIds.has(i.dataset.id) && !deadIds.has(i.dataset.id));

    ok('the feed came back with the same 24 videos', next.length === fresh, next.length + '/' + fresh);
    ok('a remembered size is not asked for again: no maxres on those six',
      nextOne.length === 6 && nextOne.every(i => !/maxresdefault\.jpg$/.test(srcOf(i) || '')),
      nextOne.map(i => rungOf(srcOf(i))).join(' '));
    ok('the six come up on hqdefault with the fallback flag already set',
      nextOne.every(i => /\/hqdefault\.jpg$/.test(srcOf(i) || '') && i.dataset.f === '1'),
      nextOne.map(i => i.dataset.f + ':' + rungOf(srcOf(i))).join(' '));
    ok('a dead video is not asked for at all: no src on those four',
      nextTwo.length === 4 && nextTwo.every(i => !srcOf(i)),
      nextTwo.filter(i => srcOf(i)).length + ' asked');
    ok('and it is left in the tidy box, not a broken icon',
      nextTwo.every(i => i.style.display === 'none' && /linear-gradient/.test((i.parentElement.style.background || ''))),
      nextTwo.map(i => i.style.display + ':' + (i.parentElement.style.background || 'none')).join(' '));
    ok('the skip and the start are counted, one per remembered card',
      c3.skip - c2.skip === 4 && c3.start - c2.start === 6,
      'skip+' + (c3.skip - c2.skip) + ' start+' + (c3.start - c2.start));
    ok('the untouched cards are asked for exactly as before',
      nextFresh.every(i => /\/maxresdefault\.jpg$/.test(srcOf(i) || '') && i.dataset.f !== '1'),
      nextFresh.filter(i => !/maxresdefault\.jpg$/.test(srcOf(i) || '')).length + ' not asked');

    /* what the user sees on a level-1 card is the file the old build reaches */
    const hq = env.w.eval('(function(id){return thumbHQ(id)})');
    ok('a remembered card shows the same file the fallback produces',
      nextOne.every(i => srcOf(i) === hq(i.dataset.id)),
      nextOne.map(i => srcOf(i)).join(' '));

    /* the old build, on the same feed and the same failures: how many of those
       ten cards ask again? (printed, and compared when a second file is given) */
    if (OLD) {
      const old = await boot(OLD);
      const oFirst = imgsOf(old);
      fireAll(old);
      await sleep(60);
      const oOne = oFirst.slice(0, 6), oTwo = oFirst.slice(6, 10);
      oOne.forEach(i => { Object.defineProperty(i, 'naturalWidth', { value: 120, configurable: true }); old.w.THOK(i); });
      oTwo.forEach(i => failCard(old, i));
      const oNext = await repaint(old);
      const oOneIds = new Set(idsOf(oOne)), oTwoIds = new Set(idsOf(oTwo));
      const askedAgain = oNext.filter(i => (oOneIds.has(i.dataset.id) || oTwoIds.has(i.dataset.id)) && !!srcOf(i)).length;
      ok('the old build asked for all ten again on the next render', askedAgain === 10, String(askedAgain));
      ok('the new build asks for six, and the six are the fallback', 6 === nextOne.filter(i => !!srcOf(i)).length + 0, 'six');
      /* the same card, once both builds have finished failing: identical tree */
      const oDead = oNext.filter(i => oTwoIds.has(i.dataset.id));
      ok('a dead card looks exactly as it did before this item',
        feedLook({ d: { querySelectorAll: () => oDead } }, true) === feedLook({ d: { querySelectorAll: () => nextTwo } }, true),
        'old ' + oDead.length + ' new ' + nextTwo.length);
      old.dom.window.close();
    }
    env.dom.window.close();
  }

  /* ---- 5. the rung, not the video ---- */
  {
    const env = await boot(FILE);
    const mk = px => {
      const el = env.d.createElement('img');
      el.dataset.id = 'samevideo1';
      el.dataset.l = '0';
      Object.defineProperty(el, 'clientWidth', { value: px, configurable: true });
      return el;
    };
    const fire = env.w.eval('(function(img){return thumbFire(img)})');
    const url = env.w.eval('(function(img){return thumbURL(img)})');
    const set = env.w.eval('(function(id,lv,r){return thumbFailSet(id,lv,r)})');
    const big = mk(402);          /* resolves to hqdefault */
    const huge = mk(1280);        /* resolves to maxresdefault */
    set('samevideo1', 1, 'sddefault');
    fire(big);
    ok('a remembered sddefault does not shrink a card that wants hqdefault',
      srcOf(big) === url(mk(402)) && big.dataset.f !== '1',
      rungOf(srcOf(big)) + ' flag=' + big.dataset.f);
    fire(huge);
    ok('nor one that wants maxresdefault',
      /\/maxresdefault\.jpg$/.test(srcOf(huge) || '') && huge.dataset.f !== '1',
      rungOf(srcOf(huge)));
    /* and the rung that did fail is still the one that is skipped */
    const sad = mk(481);          /* resolves to sddefault */
    fire(sad);
    ok('the rung that failed goes straight to the fallback',
      /\/hqdefault\.jpg$/.test(srcOf(sad) || '') && sad.dataset.f === '1',
      rungOf(srcOf(sad)) + ' flag=' + sad.dataset.f);
    env.dom.window.close();
  }

  /* ---- 6. it expires ---- */
  {
    const env = await boot(FILE);
    const first = imgsOf(env);
    fireAll(env);
    await sleep(60);
    const one = first.slice(0, 3);
    one.forEach(i => { Object.defineProperty(i, 'naturalWidth', { value: 120, configurable: true }); env.w.THOK(i); });
    const before = census(env);
    /* ten minutes later, to the millisecond the app measures */
    const real = env.w.Date.now;
    const ttl = before.fttl;
    env.w.Date.now = () => real() + ttl + 1;
    const next = await repaint(env);
    const ids = new Set(idsOf(one));
    const again = next.filter(i => ids.has(i.dataset.id));
    const after = census(env);
    ok('past its ten minutes a remembered failure is asked for again',
      again.length === 3 && again.every(i => /\/maxresdefault\.jpg$/.test(srcOf(i) || '')),
      again.map(i => rungOf(srcOf(i))).join(' '));
    ok('the expiry is counted, not silent', after.expire >= 3, 'expire=' + after.expire);
    env.w.Date.now = real;
    env.dom.window.close();
  }

  /* ---- 7. bounded ---- */
  {
    const env = await boot(FILE);
    const c0 = census(env);
    const set = env.w.eval('(function(id){return thumbFailSet(id,1,"maxresdefault")})');
    for (let i = 0; i < 500; i++) set('bulk' + String(i).padStart(5, '0'));
    const c = census(env);
    ok('the failure map stops at its ceiling', c.fail <= c.fmax && c.fail > 0,
      'fail=' + c.fail + ' fmax=' + c.fmax);
    ok('the ceiling is the same one the URL cache uses', c0.fmax > 0 && c.fmax === c0.fmax, String(c.fmax));
    env.dom.window.close();
  }

  /* ---- 8. nothing persisted ---- */
  {
    const env = await boot(FILE);
    const keys = Object.keys(env.w.localStorage);
    ok('the failure memory added no storage key', !keys.some(k => /thumb|fail/i.test(k)), keys.join(',') || 'none');
    const store = env.w.__ltStore ? env.w.__ltStore() : null;
    ok('the store census lists no thumbnail key',
      !store || !store.keys.some(k => /thumb|fail/i.test(k)), store ? store.keys.join(',') : 'no census');
    env.dom.window.close();
  }

  /* ---- 9. the probe ---- */
  {
    const env = await boot(FILE);
    const names = env.w.__ltSelfCheck ? env.w.__ltSelfCheck().names : null;
    const sc = env.w.__ltSelfCheckRun ? env.w.__ltSelfCheckRun() : null;
    ok('the boot self-check carries the thumbfail probe', !!names && names.indexOf('thumbfail') >= 0,
      names ? String(names.length) + ' probes' : 'no self-check');
    ok('the thumbfail probe passes', !!sc && sc.fails.indexOf('thumbfail') < 0,
      sc ? 'fails=' + (sc.fails.join(',') || 'none') : 'no self-check');
    ok('the thumbfail probe leaves nothing behind',
      census(env).fail === 0, 'fail=' + census(env).fail);
    env.dom.window.close();
  }

  /* ---- 10. the UI does not change ---- */
  if (OLD) {
    const env = await boot(FILE);
    const old = await boot(OLD);
    const a = feedLook(env, false), b = feedLook(old, false);
    ok('every card looks exactly as it did before this item', a === b,
      a === b ? 'identical' : 'differs at card ' + (a.split('\n').findIndex((l, i) => l !== b.split('\n')[i]) + 1));
    /* `data-fd` is 6.7's own attribute on the same element, so it is taken out
       before the comparison: the markup a card is built from must otherwise be
       byte-for-byte the old markup. */
    const mk = e => String(e.w.eval('thumbImg("abc")')).replace(/ data-fd="\d"/, '');
    ok('the markup a card is built from is byte-for-byte the old markup',
      mk(env) === mk(old), mk(env));
    ok('the fallback URL is unchanged',
      env.w.eval('thumbHQ("abc")') === old.w.eval('thumbHQ("abc")'), env.w.eval('thumbHQ("abc")'));
    env.dom.window.close();
    old.dom.window.close();
  }

  console.log(fails ? '\n' + fails + ' check(s) failed' : '\nall checks passed');
  process.exit(fails ? 1 : 0);
})();
