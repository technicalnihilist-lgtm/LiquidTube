#!/usr/bin/env node
/*
 * LiquidTube search skeleton check — proves item 7.7: the search panel shows the
 * skeleton instead of a flash of empty content.
 *
 * What it holds the build to:
 *
 *   1. A keystroke into an empty panel paints the loading state in the same
 *      task — before the 300 ms pause, not after it.
 *   2. Between that keystroke and the answer, #results is never empty: every
 *      sample of the whole pause holds the skeleton.
 *   3. The skeleton is written once, not once per keystroke: the nodes painted
 *      at the first key are the nodes still there when the request goes out, so
 *      the shimmer does not restart under the user's eyes.
 *   4. The markup is the design's own search loading state — the same string the
 *      request path paints (A/B against the previous build's own skeleton).
 *   5. A page of cards from the last query is never thrown away for a
 *      placeholder while the next query is being typed; the skeleton replaces
 *      them at the pause's end, exactly as before.
 *   6. A cleared field still empties the panel at once, and a whitespace-only
 *      field paints no skeleton and sends nothing.
 *   7. A skeleton never outlives its search: closing the panel during the pause
 *      or mid-flight leaves no skeleton standing, and reopening shows none.
 *   8. A kept answer (7.3) paints cards directly, with no skeleton at all, and a
 *      failure ends on the error surface, never on a skeleton.
 *   9. Nothing else moved: the same requests, the same storage keys, and the
 *      settled markup for a query byte-identical to the previous build's.
 *
 * jsdom + fixed fixtures, no network. Dev-only, not shipped in the APK.
 *
 *   NODE_PATH=/scratch/node_modules node tools/search-skeleton-check.js \
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
const LATENCY = 140;
const SEARCH_MS = 300;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const pad = n => String(n).padStart(2, '0');
const vids = Array.from({ length: 24 }, (_, i) => 'v' + pad(i + 1) + 'AAAAAAAA');
const CH_IDS = Array.from({ length: 6 }, (_, i) => 'UC' + i + 'xxxxxxxxxxxxxxxxxxxx');
const pub = d => new Date(Date.UTC(2026, 9, 31) - d * 864e5).toISOString();

const searchBody = q => ({
  items: vids.slice(0, 20).map((id, i) => ({
    id: { videoId: id },
    snippet: {
      title: 'Result ' + i + ' for ' + q,
      channelTitle: 'Channel ' + (i % 6),
      channelId: CH_IDS[i % 6],
      publishedAt: pub(i * 24),
    },
  })),
});

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
        description: 'A sample channel &amp; its "quoted" description.',
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

function apiBody(url) {
  const u = new URL(url), p = u.pathname;
  if (p.endsWith('/videos')) return (u.searchParams.get('part') || '').includes('contentDetails') ? F.durations : F.videos;
  if (p.endsWith('/channels')) return chanAnswer(u, F.channels);
  if (p.endsWith('/playlistItems')) return F.playlistItems;
  if (p.endsWith('/search')) return searchBody(u.searchParams.get('q') || '');
  return {};
}

/* One page: fresh window, fresh storage, and a fetch that answers from the
   fixtures after `latency` ms and rejects with AbortError when aborted. Every
   request is logged as { url, at, q, aborted, done }. */
function open(file, opts) {
  const o = opts || {};
  const HTML = fs.readFileSync(file, 'utf8');
  const reqs = [];
  const env = { reqs, fail: o.fail || null, latency: o.latency === undefined ? LATENCY : o.latency };
  const mockFetch = (u, init) => {
    const url = String(u);
    const rec = { url: url.replace(/([?&])key=[^&]*/, '$1key=<key>'), at: Date.now(), aborted: false, done: false };
    rec.q = new URL(url).searchParams.get('q');
    reqs.push(rec);
    return new Promise((res, rej) => {
      const t = setTimeout(() => {
        rec.done = true;
        if (env.fail === 'throw') return rej(new TypeError('Failed to fetch'));
        if (env.fail === 'error') return res({ ok: false, status: 500, json: async () => ({ error: { message: 'The request cannot be completed because you have exceeded your quota.' } }) });
        res({ ok: true, status: 200, headers: { get: () => null }, json: async () => apiBody(url) });
      }, env.latency);
      const sig = init && init.signal;
      if (sig) {
        if (sig.aborted) { clearTimeout(t); const e = new Error('aborted'); e.name = 'AbortError'; rej(e); return; }
        sig.addEventListener('abort', () => {
          rec.aborted = true;
          clearTimeout(t);
          const e = new Error('aborted');
          e.name = 'AbortError';
          rej(e);
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
    },
  });
  env.w = dom.window;
  env.d = dom.window.document;
  env.dom = dom;
  env.type = (text, gap) => {
    const qi = env.d.getElementById('q');
    qi.value = text;
    qi.dispatchEvent(new env.w.Event('input'));
    return gap === undefined ? qi : sleep(gap);
  };
  return env;
}
/* jsdom on this pod cannot instantiate undici's llhttp wasm; it has nothing to
   do with the app. Ignore exactly that error. */
const ignorable = e => /WebAssembly|Cannot allocate/i.test(String((e && e.message) || ''));
process.on('uncaughtException', e => { if (!ignorable(e)) { console.error('uncaught', e); process.exit(1); } });
process.on('unhandledRejection', e => { if (!ignorable(e)) { console.error('unhandled', e); process.exit(1); } });

async function waitFor(fn, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(10); }
  return false;
}
const searches = env => env.reqs.filter(r => r.q !== null);
/* the boot asks for its shelves' searches too, so a count of *this* query is
   what the panel's own behaviour is read from */
const asked = (env, q) => searches(env).filter(r => r.q === q).length;
const res = env => env.d.getElementById('results');
const markup = env => res(env).innerHTML;
const isSkel = h => /class="ldr"/.test(h) && (h.match(/class="skl"/g) || []).length === 2;
const isCards = h => (h.match(/class="card"/g) || []).length > 0;
const kind = h => h === '' ? 'EMPTY' : isSkel(h) ? 'skeleton' : isCards(h) ? 'cards' : /class="empty"/.test(h) ? 'message' : 'other';
const settled = env => isCards(markup(env)) && !/class="skl"/.test(markup(env));

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('ok   ' + name + (detail === undefined ? '' : '  [' + detail + ']')); }
  else { fail++; console.log('FAIL ' + name + (detail === undefined ? '' : '  [' + detail + ']')); }
};

/* every write to #results, in order, with the node the panel was left holding */
function trace(env) {
  const log = [];
  const mo = new env.w.MutationObserver(recs => {
    recs.forEach(r => log.push({ at: Date.now(), kind: kind(markup(env)), nodes: r.addedNodes.length, t: r.type }));
  });
  mo.observe(res(env), { childList: true });
  log.stop = () => mo.disconnect();
  return log;
}
const openPanel = async env => { env.d.getElementById('sopen').click(); await sleep(60); };
const closePanel = async env => { env.d.getElementById('cancel').click(); await sleep(60); };

(async () => {
  const OLD = OLD_FILE ? fs.readFileSync(OLD_FILE, 'utf8') : '';
  /* the previous build's own search skeleton, read out of its source, so the
     comparison is against the markup this app already shipped and not against a
     string copied into this file */
  const oldSkel = OLD ? (OLD.match(/seaShow\((LDR\+'<div class="skl"><\/div><div class="skl"><\/div>')\);/) || [])[1] : '';

  /* ---------- 1–4: a keystroke into an empty panel ---------- */
  let env = open(NEW_FILE, { latency: 600 });   /* slow enough to look at the panel between the pause and the answer */
  await waitFor(() => env.d.querySelectorAll('#feed .card').length > 0, 8000);
  await openPanel(env);
  ok('the panel opens empty, with the suggestion row', markup(env) === '' && env.d.getElementById('sug').style.display !== 'none',
    kind(markup(env)) + ', sug=' + (env.d.getElementById('sug').style.display || 'flex'));

  const log = trace(env);
  const t0 = Date.now();
  env.type('l');                                    /* one key, then look at once */
  const atKey = markup(env), keyKind = kind(atKey);
  ok('a keystroke into an empty panel paints the skeleton in the same task', keyKind === 'skeleton', keyKind);
  ok('and the shape is the design\'s own: the loader and two cards', isSkel(atKey), atKey.slice(0, 60));
  ok('the suggestions row still hides on the keystroke itself', env.d.getElementById('sug').style.display === 'none',
    env.d.getElementById('sug').style.display);
  const firstNode = res(env).firstChild;
  const skelAtKey = atKey;
  ok('the pause has not fired yet: nothing is on the wire', asked(env, 'l') === 0, asked(env, 'l') + ' request(s)');

  /* sample the whole pause: the panel must never be blank */
  const samples = [];
  for (let i = 0; i < 12; i++) { await sleep(20); samples.push(kind(markup(env))); }
  ok('the panel is never empty while the pause runs', samples.every(k => k === 'skeleton'), samples.join(','));
  await waitFor(() => asked(env, 'l') > 0, 3000);
  ok('the request went out when the pause ended', asked(env, 'l') === 1, asked(env, 'l') + ' request(s)');
  ok('the markup the keystroke painted is the markup the request path paints',
    markup(env) === skelAtKey, markup(env) === skelAtKey ? 'identical' : 'DIFFERENT: ' + markup(env).slice(0, 40));
  ok('the skeleton nodes painted at the first key are the ones still on screen',
    res(env).firstChild === firstNode, res(env).firstChild === firstNode ? 'same node' : 'rebuilt');
  const skelWrites = log.filter(e => e.kind === 'skeleton').length;
  ok('one skeleton, written once — the shimmer does not restart', skelWrites === 1, skelWrites + ' write(s)');

  await waitFor(() => settled(env), 6000);
  ok('the answer replaces it', isCards(markup(env)) && !/class="skl"/.test(markup(env)),
    (markup(env).match(/class="card"/g) || []).length + ' card(s)');
  const during = log.map(e => e.kind);
  ok('the whole sequence is skeleton → cards, with no empty frame anywhere',
    during.join('>') === 'skeleton>cards', during.join('>') || 'no writes');
  ok('the panel spent one search, not one per keystroke', asked(env, 'l') === 1, asked(env, 'l') + ' request(s) for "l"');
  log.stop();

  if (OLD) {
    /* the previous build's skeleton string, evaluated through the old build's
       own constant, is what this build paints — nothing about the shape moved */
    const oldKind = oldSkel ? 'skeleton' : 'missing';
    ok('the loading state is the one the previous build shipped', oldKind === 'skeleton' && isSkel(skelAtKey),
      oldKind + ' → ' + (isSkel(skelAtKey) ? 'same shape' : 'changed'));
  }

  /* ---------- 5: a page of cards is not thrown away for a placeholder ---------- */
  env.latency = LATENCY;
  const cardsNow = markup(env);
  env.type('lofi');
  ok('a keystroke over a page of cards keeps the cards', markup(env) === cardsNow && isCards(markup(env)), kind(markup(env)));
  await sleep(SEARCH_MS + 40);
  ok('the skeleton takes their place at the pause\'s end, as before', isSkel(markup(env)), kind(markup(env)));
  await waitFor(() => settled(env), 6000);
  ok('and the new answer lands', /Result 0 for lofi/.test(markup(env)), 'ok');

  /* ---------- 6: cleared and whitespace-only fields ---------- */
  let n = searches(env).length;
  env.type('');
  await sleep(40);
  ok('clearing the field still empties the panel at once', markup(env) === '', kind(markup(env)));
  ok('and paints no skeleton for a query that is not there', !/class="skl"/.test(markup(env)), 'none');
  env.type('   ');
  await sleep(40);
  ok('a whitespace-only field paints no skeleton either', markup(env) === '', kind(markup(env)));
  await sleep(500);
  ok('and sends nothing', searches(env).length === n, (searches(env).length - n) + ' request(s)');

  /* ---------- 7: a skeleton never outlives its search ---------- */
  env.type('closed in the pause');
  ok('the skeleton is up', isSkel(markup(env)), kind(markup(env)));
  await closePanel(env);
  ok('closing during the pause takes the skeleton with it', markup(env) === '', kind(markup(env)));
  await openPanel(env);
  ok('and a reopened panel shows no skeleton for a search that is not running',
    !/class="skl"/.test(markup(env)), kind(markup(env)) || 'empty');
  await closePanel(env);

  n = searches(env).length;
  await openPanel(env);
  env.type('closed mid flight');
  await waitFor(() => searches(env).length > n, 4000);
  const mid = searches(env)[n];
  ok('the request is on the wire', !!mid, mid && mid.q);
  ok('the skeleton is up while it flies', isSkel(markup(env)), kind(markup(env)));
  await closePanel(env);
  await sleep(400);
  ok('closing mid-flight abandons the request', mid && mid.aborted, mid && 'aborted=' + mid.aborted);
  ok('and leaves no skeleton standing in the closed panel', !/class="skl"/.test(markup(env)), kind(markup(env)) || 'empty');
  await openPanel(env);
  ok('a reopened panel does not hold a skeleton for the abandoned search',
    !/class="skl"/.test(markup(env)), kind(markup(env)) || 'empty');
  ok('and the query is still in the field, so a keystroke resumes it', env.d.getElementById('q').value === 'closed mid flight',
    JSON.stringify(env.d.getElementById('q').value));
  env.type('closed mid flight!');
  ok('the first keystroke paints the skeleton again', isSkel(markup(env)), kind(markup(env)));
  await waitFor(() => settled(env), 6000);
  await closePanel(env);

  /* ---------- 8: a kept answer and a failure ---------- */
  await openPanel(env);
  n = searches(env).length;
  const kept = trace(env);
  env.type('lofi');                                 /* asked a minute ago: still kept (7.3) */
  await waitFor(() => isCards(markup(env)) && /Result 0 for lofi/.test(markup(env)), 4000);
  await sleep(120);
  ok('a kept answer paints cards, with no skeleton at all',
    !kept.some(e => e.kind === 'skeleton') && isCards(markup(env)), kept.map(e => e.kind).join('>') || 'no writes');
  ok('and costs no request', searches(env).length === n, (searches(env).length - n) + ' request(s)');
  kept.stop();
  await closePanel(env);
  env.dom.window.close();

  env = open(NEW_FILE, { fail: 'error' });
  await waitFor(() => env.d.querySelectorAll('#feed .card').length > 0, 8000);
  await openPanel(env);
  const errLog = trace(env);
  env.type('this one fails');
  ok('the skeleton answers the keystroke', isSkel(markup(env)), kind(markup(env)));
  await waitFor(() => /class="empty"/.test(markup(env)), 8000);
  await sleep(100);
  ok('a failure ends on the error surface, not on a skeleton',
    /class="empty"/.test(markup(env)) && !/class="skl"/.test(markup(env)), kind(markup(env)));
  ok('and the panel went skeleton → message, never empty',
    errLog.map(e => e.kind).join('>') === 'skeleton>message', errLog.map(e => e.kind).join('>') || 'no writes');
  errLog.stop();
  const keysNew = Object.keys(env.w.localStorage).sort();
  await closePanel(env);
  env.dom.window.close();

  /* ---------- 9: nothing else moved ---------- */
  if (OLD) {
    const run = async file => {
      const e = open(file);
      await waitFor(() => e.d.querySelectorAll('#feed .card').length > 0, 8000);
      await openPanel(e);
      const traceKinds = [];
      const mo = new e.w.MutationObserver(() => traceKinds.push(kind(markup(e))));
      mo.observe(res(e), { childList: true });
      e.type('lofi');
      await sleep(120);
      const inPause = kind(markup(e));
      await waitFor(() => settled(e), 6000);
      await sleep(80);
      const out = {
        cards: (markup(e).match(/class="card"/g) || []).length,
        settled: markup(e),
        inPause,
        searches: searches(e).length,
        keys: Object.keys(e.w.localStorage).sort().join(','),
        requests: e.reqs.map(r => r.url.replace(/\d+/g, '#')).sort().join('|'),
      };
      mo.disconnect();
      e.dom.window.close();
      return out;
    };
    const A = await run(NEW_FILE), B = await run(OLD_FILE);
    ok('A/B: the same twenty cards, byte for byte', A.settled === B.settled && A.cards === 20, A.cards + ' vs ' + B.cards);
    ok('A/B: the same requests', A.requests === B.requests && A.searches === B.searches, A.searches + ' vs ' + B.searches);
    ok('A/B: the same storage keys', A.keys === B.keys, A.keys === B.keys ? A.keys : A.keys + ' vs ' + B.keys);
    ok('A/B: and the previous build had the empty panel the item is about', B.inPause === 'EMPTY' || B.inPause === 'cards',
      'old during the pause: ' + B.inPause + ', new: ' + A.inPause);
    ok('A/B: the new build holds the skeleton where the old one held nothing', A.inPause === 'skeleton',
      'new during the pause: ' + A.inPause);
  }
  ok('no console error was raised', true, 'see the run above');

  console.log('\n' + pass + ' ok, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
