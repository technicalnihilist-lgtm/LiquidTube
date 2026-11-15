#!/usr/bin/env node
/*
 * LiquidTube search normalisation check — proves item 7.8: a Hindi/Devanagari
 * query is one query however it was spelled.
 *
 * What it holds the build to:
 *
 *   1. The rule itself, on the spellings that really differ: a danda, a stray
 *      zero-width joiner, a space a layout left between a letter and its matra,
 *      a precomposed nukta letter, Devanagari digits, a non-breaking space.
 *   2. What goes on the wire is the normalised string — and only that.
 *   3. The second spelling of the same question costs nothing: it is answered
 *      from the kept answers of 7.3, with no request and no quota unit.
 *   4. The field is never rewritten: the user's own spelling stays in the box.
 *   5. The kept-answer key is the normalised query, so two spellings are one
 *      entry, and the 64-character cap lands on a cluster boundary — never on a
 *      lone matra.
 *   6. A field holding nothing but invisible marks asks for nothing, sends
 *      nothing and paints no skeleton.
 *   7. Two spellings that mean two different words are still two queries: the
 *      anusvara and the anunasika are not merged.
 *   8. The launch blob of 7.2 stores the user's spelling, not the normalised
 *      one, so a restored panel shows what they typed.
 *   9. Nothing else moved: a Latin query is sent and painted exactly as before,
 *      and no console error is raised.
 *
 * jsdom + fixed fixtures, no network. Dev-only, not shipped in the APK.
 *
 *   NODE_PATH=/scratch/node_modules node tools/search-normalise-check.js \
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
const LATENCY = 60;
const SEARCH_MS = 300;
const KEY_MAX = 64;
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* the spellings this item is about */
const DANDA = '\u0964';                                  /* । */
const ZW = '\u200D\u200C\u200B';                         /* ZWJ, ZWNJ, ZWSP */
const NUK_PRE = '\u0958व्वाली';                          /* क़ precomposed (U+0958) */
const NUK_DEC = '\u0915\u093Cव्वाली';                    /* क + ़ (U+0915 U+093C) */
const RUPEE_Q = 'गाना २०२६';                            /* Devanagari digits */
const RUPEE_N = 'गाना 2026';
const GAP_Q = 'क ि';                                     /* a space between क and its ि */
const GAP_N = 'कि';
const ANU = 'हिंदी', ANU_N = 'हिन्दी';                    /* two words, deliberately not merged */
const MARK_END = /[\u0900-\u0903\u093A-\u094F\u0951-\u0957\u0962\u0963]$/;

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

function apiBody(url) {
  const u = new URL(url), p = u.pathname;
  if (p.endsWith('/videos')) return (u.searchParams.get('part') || '').includes('contentDetails') ? F.durations : F.videos;
  if (p.endsWith('/channels')) return chanAnswer(u, F.channels);
  if (p.endsWith('/playlistItems')) return F.playlistItems;
  if (p.endsWith('/search')) return searchBody(u.searchParams.get('q') || '');
  return {};
}

/* One page: fresh window, fresh storage, and a fetch that answers from the
   fixtures after `latency` ms. Every request is logged as { url, q, aborted }. */
function open(file, opts) {
  const o = opts || {};
  const HTML = fs.readFileSync(file, 'utf8');
  const reqs = [];
  const env = { reqs, errors: [], latency: o.latency === undefined ? LATENCY : o.latency };
  const mockFetch = (u, init) => {
    const url = String(u);
    const rec = { url: url.replace(/([?&])key=[^&]*/, '$1key=<key>'), at: Date.now(), aborted: false, done: false };
    rec.q = new URL(url).searchParams.get('q');
    reqs.push(rec);
    return new Promise((res, rej) => {
      const t = setTimeout(() => {
        rec.done = true;
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
      w.addEventListener('error', e => env.errors.push(String((e && e.message) || e)));
      w.addEventListener('unhandledrejection', e => env.errors.push('unhandled: ' + String((e && e.reason) || e)));
    },
  });
  env.w = dom.window;
  env.d = dom.window.document;
  env.dom = dom;
  env.type = text => {
    const qi = env.d.getElementById('q');
    qi.value = text;
    qi.dispatchEvent(new env.w.Event('input'));
    return qi;
  };
  env.field = () => env.d.getElementById('q').value;
  env.info = () => env.w.__ltSearchCache();
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
const asked = (env, q) => searches(env).filter(r => r.q === q).length;
const markup = env => env.d.getElementById('results').innerHTML;
const isCards = h => (h.match(/class="card"/g) || []).length > 0;
const isSkel = h => /class="ldr"/.test(h) && (h.match(/class="skl"/g) || []).length === 2;
const settled = env => isCards(markup(env)) && !/class="skl"/.test(markup(env));
const openPanel = async env => { env.d.getElementById('sopen').click(); await sleep(60); };

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('ok   ' + name + (detail === undefined ? '' : '  [' + detail + ']')); }
  else { fail++; console.log('FAIL ' + name + (detail === undefined ? '' : '  [' + detail + ']')); }
};
const show = s => JSON.stringify(s);
/* one search, typed and settled: the query that left, and the field after it */
async function ask(env, text) {
  const before = searches(env).length;
  env.type(text);
  await sleep(SEARCH_MS + env.latency + 260);
  const sent = searches(env).slice(before);
  return { n: sent.length, qs: sent.map(r => r.q), field: env.field(), cards: isCards(markup(env)) };
}

(async () => {
  /* ---------- 1–6: the spellings of one query ---------- */
  let env = open(NEW_FILE);
  await waitFor(() => env.d.querySelectorAll('#feed .card').length > 0, 8000);
  await openPanel(env);
  /* A build without the rule has no `norm` to ask, so the whole table below is
     read against its own "nothing happens" answer instead of crashing the run:
     pointed at the previous build, this file reports every spelling it gets
     wrong rather than stopping at the first. */
  const hasRule = !!(env.info().norm && typeof env.info().norm.q === 'function');
  const norm = hasRule ? env.info().norm.q : s => String(s == null ? '' : s).trim();
  ok('the build has the rule at all', hasRule, hasRule ? 'norm.q()' : 'no norm.q()');

  /* the rule, on its own, before any request is made */
  const table = [
    ['राम', 'राम', 'a plain query'],
    ['राम' + DANDA, 'राम', 'a trailing danda'],
    ['राम' + DANDA + ' सीता', 'राम सीता', 'a danda between two words'],
    ['  राम   सीता  ', 'राम सीता', 'runs of spaces'],
    ['राम\u00A0सीता', 'राम सीता', 'a non-breaking space'],
    ['राम\u3000सीता', 'राम सीता', 'an ideographic space'],
    ['राम' + ZW, 'राम', 'zero-width marks'],
    [GAP_Q, GAP_N, 'a space a layout left before the matra'],
    [NUK_PRE, NUK_DEC, 'a precomposed nukta letter'],
    [RUPEE_Q, RUPEE_N, 'Devanagari digits'],
    ['lofi  beats', 'lofi beats', 'a Latin query'],
    ['', '', 'an empty field'],
    [null, '', 'no query at all'],
    [ZW, '', 'nothing but invisible marks'],
  ];
  let bad = 0;
  for (const [input, want] of table) if (norm(input) !== want) { bad++; console.log('   rule: ' + show(input) + ' → ' + show(norm(input)) + ', wanted ' + show(want)); }
  ok('the rule maps every spelling of one query onto one string', bad === 0, table.length - bad + '/' + table.length);
  ok('two spellings of two different words are still two strings', norm(ANU) !== norm(ANU_N) && norm(ANU) === ANU && norm(ANU_N) === ANU_N,
    show(norm(ANU)) + ' vs ' + show(norm(ANU_N)));
  ok('a Latin query is untouched by the rule', norm('lofi beats') === 'lofi beats' && norm('  Lofi  ') === 'Lofi',
    show(norm('  Lofi  ')));

  /* the first spelling, typed: one request, in the normalised form */
  const RAW = 'राम' + DANDA, CANON = 'राम';
  let a = await ask(env, RAW);
  ok('typing a Devanagari query with a danda sends one search', a.n === 1, a.n + ' request(s)');
  ok('and what it sends is the normalised query, not the typed one', a.qs[0] === CANON, show(a.qs[0]));
  ok('nothing was sent with the danda still in it', asked(env, RAW) === 0, asked(env, RAW) + ' request(s)');
  ok('the field still holds exactly what the user typed', a.field === RAW, show(a.field));
  ok('and the answer is on screen', a.cards && /Result 0 for राम/.test(markup(env)), 'cards');

  /* the second spelling of the same question: no request at all */
  a = await ask(env, CANON);
  ok('the other spelling of the same query costs no request', a.n === 0, a.n + ' request(s)');
  ok('it is answered from the kept answers of 7.3', env.info().hit > 0 && a.cards, env.info().hit + ' hit(s)');
  ok('the two spellings are one entry in the kept answers', env.info().keys().filter(k => k === CANON).length === 1,
    show(env.info().keys()));

  /* a joiner a copy brought along is the same question again */
  a = await ask(env, CANON + ZW);
  ok('a query with a zero-width joiner in it is the same question', a.n === 0 && a.cards, a.n + ' request(s)');

  /* the invisible-only field asks for nothing at all */
  let n = searches(env).length;
  env.type(ZW);
  await sleep(60);
  ok('a field holding nothing but invisible marks paints no skeleton', !isSkel(markup(env)), isSkel(markup(env)) ? 'skeleton' : 'no skeleton');
  ok('and empties the panel, as a cleared field does', markup(env) === '', show(markup(env).slice(0, 30)));
  await sleep(SEARCH_MS + 200);
  ok('and sends nothing, not even after the pause', searches(env).length === n, (searches(env).length - n) + ' request(s)');

  /* the nukta, the digits and the gap: each is asked once, in one form */
  a = await ask(env, NUK_PRE);
  ok('a precomposed nukta letter is sent decomposed', a.n === 1 && a.qs[0] === NUK_DEC, show(a.qs[0]));
  a = await ask(env, NUK_DEC);
  ok('and the decomposed spelling of it is answered from that same answer', a.n === 0 && a.cards, a.n + ' request(s)');
  a = await ask(env, RUPEE_Q);
  ok('Devanagari digits are sent as ASCII digits', a.n === 1 && a.qs[0] === RUPEE_N, show(a.qs[0]));
  a = await ask(env, RUPEE_N);
  ok('the ASCII spelling of that number is the same question', a.n === 0 && a.cards, a.n + ' request(s)');
  a = await ask(env, GAP_Q);
  ok('a space before the matra is dropped from what is sent', a.n === 1 && a.qs[0] === GAP_N, show(a.qs[0]));

  /* the two words that are spelled differently on purpose stay two queries */
  a = await ask(env, ANU);
  const anuSent = a.qs[0];
  a = await ask(env, ANU_N);
  ok('the anusvara and the anunasika are not merged into one query', a.n === 1 && anuSent === ANU && a.qs[0] === ANU_N,
    show(anuSent) + ' then ' + show(a.qs[0]));

  /* ---------- 5: the capped key lands on a cluster boundary ---------- */
  const LONG = 'र'.repeat(62) + 'कि' + 'राम';            /* the 64th character is a matra */
  const before = env.info().keys();
  a = await ask(env, LONG);
  const after = env.info().keys().filter(k => before.indexOf(k) < 0);
  const key = after[0] || '';
  ok('a query longer than the key cap still makes one entry', after.length === 1, after.length + ' new key(s)');
  ok('the capped key is at most ' + KEY_MAX + ' characters', key.length <= KEY_MAX, key.length + ' characters');
  ok('and it does not end on a lone combining mark', key.length > 0 && !MARK_END.test(key), show(key.slice(-3)));
  ok('it ends on the cluster\'s base letter', key.slice(-1) === '\u0915', show(key.slice(-3)));

  /* ---------- 7–8: the launch blob keeps the user's spelling ---------- */
  const cached = env.info().cached;
  ok('the launch blob of 7.2 stores the query that was typed', cached && cached.q === LONG, cached && show(cached.q));
  ok('with the answer\'s cards', cached && cached.items === 20, cached && cached.items + ' item(s)');
  const counts = env.info().norm || { ask: 0, fix: 0 };
  ok('the counters the log reads are there', counts.ask >= 10 && counts.fix >= 5,
    'ask=' + counts.ask + ' fix=' + counts.fix);
  ok('no console error was raised', env.errors.length === 0, env.errors.slice(0, 2).join(' | ') || 'none');
  const newField = env.field();
  ok('and the field is still the user\'s own text after every one of those', newField === LONG, show(newField));
  env.dom.window.close();

  /* ---------- 9: nothing else moved ---------- */
  if (OLD_FILE) {
    const run = async file => {
      const e = open(file);
      await waitFor(() => e.d.querySelectorAll('#feed .card').length > 0, 8000);
      await openPanel(e);
      /* a Latin query is untouched by the item: same request, same markup */
      let n0 = searches(e).length;
      e.type('lofi');
      await waitFor(() => settled(e), 8000);
      await sleep(120);
      const latin = { q: (searches(e)[n0] || {}).q, settled: markup(e) };
      /* the two spellings, in the old build */
      const pre = e.info().keys();
      const first = await ask(e, RAW), second = await ask(e, CANON);
      const keys = e.info().keys().filter(k => pre.indexOf(k) < 0);
      await ask(e, LONG);
      const cut = e.info().keys().filter(k => pre.indexOf(k) < 0 && keys.indexOf(k) < 0)[0] || '';
      const out = {
        latin, first, second, keys, cut,
        requests: searches(e).map(r => r.q).join(' | '),
      };
      e.dom.window.close();
      return out;
    };
    const A = await run(NEW_FILE), B = await run(OLD_FILE);
    ok('A/B: a Latin query is sent as before', A.latin.q === B.latin.q && A.latin.q === 'lofi', show(A.latin.q) + ' vs ' + show(B.latin.q));
    ok('A/B: and paints the same cards', A.latin.settled === B.latin.settled && isCards(A.latin.settled), 'identical markup');
    ok('A/B: the old build sent the danda to the API', B.first.qs[0] === RAW, show(B.first.qs[0]));
    ok('A/B: and charged a second search for the other spelling', B.second.n === 1, B.second.n + ' request(s)');
    ok('A/B: where this build charges none', A.second.n === 0, A.second.n + ' request(s)');
    ok('A/B: the old build kept two entries for one question', B.keys.length === 2, B.keys.length + ' key(s): ' + B.keys.map(show).join(', '));
    ok('A/B: this build keeps one', A.keys.length === 1, A.keys.length + ' key(s)');
    ok('A/B: the old capped key ended on a lone matra', MARK_END.test(B.cut), show(B.cut.slice(-3)));
    ok('A/B: this one does not', B.cut !== A.cut && !MARK_END.test(A.cut), show(A.cut.slice(-3)));
    console.log('\n   old requests: ' + B.requests);
    console.log('   new requests: ' + A.requests);
  }

  console.log('\n' + pass + ' ok, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
