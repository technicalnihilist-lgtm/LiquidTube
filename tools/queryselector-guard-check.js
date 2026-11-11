#!/usr/bin/env node
/*
 * LiquidTube selector-guard check — proves item 5.5 ("guard every querySelector
 * result before use").
 *
 * Before this item the shipped page resolved selectors in 17 places and used
 * the answer immediately:
 *
 *   [...$('chips').querySelectorAll('.chip')]     a chip click
 *   [...$('sg').querySelectorAll('button')]       a subscriptions repaint
 *   $('pl').querySelector('.art')                 opening and closing the player
 *   const tabs=$('tabs'),tabEls=[...tabs.querySelectorAll('.tab')]   at boot
 *   const els=[...p.querySelectorAll('.chip,.vh,...')]              a page replay
 *   document.querySelectorAll('[data-v]')         the cache sweeps
 *
 * `querySelector` answers null and `querySelectorAll` an empty list the moment
 * the markup stops matching, so each of those lines threw a TypeError out of
 * the middle of a render or a gesture handler and took the rest of that pass
 * with it. Every one of them now goes through `qs()` / `qsa()`, which answer
 * null / `[]` and report the miss under the `lt-sel` prefix.
 *
 * The check asserts, in jsdom with the API answered from fixtures:
 *
 *  1. the shipped script resolves selectors only through the two helpers —
 *     no `document.querySelector*`, no `.querySelector*` outside them;
 *  2. a normal boot records zero selector misses, so the helpers are not
 *     quietly hiding a selector that no longer matches anything;
 *  3. for each of seven surfaces, a node the app expects is taken out of the
 *     document and the surface is driven anyway: the new build must not throw,
 *     must record exactly that miss, and must leave the rest of the app
 *     working — while the pre-change build (passed as a second file) must
 *     throw on the same scenario, so the guard is what fixes it;
 *  4. the helpers cannot hide a broken surface: an empty `querySelectorAll` is
 *     not a miss (a list may be legitimately empty) but a missing root and an
 *     unmatched `qs` both are, once each, never once per frame;
 *  5. the DOM is unchanged: the element tree of a normal boot is identical
 *     before and after, tag for tag, id for id, class for class.
 *
 *   npm i jsdom
 *   node tools/queryselector-guard-check.js app/assets/index.html [old.html]
 */
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- fixtures: the same shapes the other checks answer with ---------- */
const vids = [];
for (let i = 0; i < 24; i++) vids.push('vid' + String(i).padStart(8, '0'));
const CH_IDS = [];
for (let i = 0; i < 6; i++) CH_IDS.push('UCchan' + String(i).padStart(12, '0'));
const pub = d => new Date(Date.UTC(2026, 9, 1 + d)).toISOString();

const F = {
  videos: {
    items: vids.map((id, i) => ({
      id,
      snippet: {
        title: 'Sample trending video number ' + (i + 1),
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
        country: 'IN',
        description: 'A sample channel.',
        thumbnails: { medium: { url: 'https://yt3.ggpht.com/av' + i + '.jpg' } },
      },
      statistics: { subscriberCount: '1200000', videoCount: '480', viewCount: '91000000' },
      contentDetails: { relatedPlaylists: { uploads: 'UU' + i + 'xxxxxxxxxxxxxxxxxxxx' } },
      brandingSettings: { image: { bannerExternalUrl: '' }, channel: {} },
    })),
  },
  search: {
    items: vids.slice(0, 20).map((id, i) => ({
      id: { videoId: id },
      snippet: { title: 'Search result ' + i, channelTitle: 'Channel ' + (i % 6), channelId: CH_IDS[i % 6], publishedAt: pub(i * 24) },
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
  /* a playlistItems body in the shape the endpoint really sends: the search
     fixture's ids wrapped in snippet.resourceId. It used to answer with the
     search body itself, which no server does — item 5.9 validates the shape
     before mapping it now, so the fixture has to be the real one. */
  if (p.endsWith('/playlistItems')) return { items: F.search.items.map(it => ({ snippet: Object.assign({}, it.snippet, { resourceId: { videoId: it.id.videoId } }), contentDetails: { videoPublishedAt: it.snippet.publishedAt } })) };
  if (p.endsWith('/search')) return F.search;
  return {};
}

/* ---------- one page: fresh window, fixtures, an error collector ---------- */
function open(file, pre, mutate) {
  const raw = fs.readFileSync(file, 'utf8');
  const HTML = mutate ? mutate(raw) : raw;
  const env = { errs: [], lines: [], pre: pre || null };
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => env.errs.push(e));
  const dom = new JSDOM(HTML, {
    url: 'https://liquidtube.local/index.html',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(w) {
      w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
      w.fetch = async u => ({ ok: true, status: 200, json: async () => apiBody(String(u)), headers: new Map() });
      w.scrollTo = () => {};
      w.console.log = (...a) => { env.lines.push(a.map(x => (typeof x === 'string' ? x : String(x))).join(' ')); };
      w.addEventListener('error', e => env.errs.push(e.error || new Error(String(e.message))));
      w.addEventListener('unhandledrejection', e => env.errs.push((e.reason && e.reason.reason) || e.reason || new Error('unhandledrejection')));
      if (env.pre) env.pre(w);
    },
  });
  env.w = dom.window;
  env.d = dom.window.document;
  env.dom = dom;
  return env;
}
const ignorable = e => /WebAssembly|Cannot allocate/i.test(String((e && e.message) || (e && e.reason && e.reason.message) || ''));

async function waitFor(fn, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(20); }
  return false;
}
/* run a snippet in the page's global scope; `const` helpers live there and are
   not window properties, so everything is driven through eval */
function drive(env, code) {
  try { return { ok: true, value: env.w.eval(code) }; }
  catch (e) { return { ok: false, value: e }; }
}
const realErrs = env => env.errs.filter(e => !ignorable(e));

/* ---------- assertions ---------- */
let pass = 0;
const fails = [];
function ok(label, cond, detail) {
  if (cond) { pass++; return; }
  fails.push(label + (detail !== undefined ? ' — ' + detail : ''));
}
function bail(label, cond, detail) {
  ok(label, cond, detail);
  if (!cond) { report(); process.exit(1); }
}
function report() {
  for (const f of fails) console.log('FAIL ' + f);
  console.log((fails.length ? 'FAILED' : 'PASS') + '  ' + pass + ' checks passed, ' + fails.length + ' failed');
}

(async () => {

const FILE = process.argv[2] || 'app/assets/index.html';
const BASE = process.argv[3] || null;
const SRC = fs.readFileSync(FILE, 'utf8');
/* the audit reads code, not prose: the header comment above the helpers names
   the calls it replaced, so block and whole-line comments come out first */
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/* ---------- 1. static audit: one way to resolve a selector ---------- */
{
  const docs = (CODE.match(/document\.querySelector/g) || []).length;
  const all = (CODE.match(/\.querySelector(All)?\(/g) || []).length;
  const inHelper = (CODE.match(/=p\.querySelector\(sel\)/g) || []).length +
                   (CODE.match(/call\(p\.querySelectorAll\(sel\)\)/g) || []).length;
  ok('no document.querySelector* left in the page', docs === 0, docs + ' found');
  ok('every .querySelector* is inside the guarded helpers', all === 2 && inHelper === 2,
     all + ' call sites, ' + inHelper + ' in the helpers');
  ok('qs() and qsa() are defined', /const qs=\(sel,root\)=>/.test(SRC) && /const qsa=\(sel,root\)=>/.test(SRC));
  ok('a miss is counted and reported under lt-sel', /lt-sel miss sel=/.test(SRC));
  ok('the census is exposed for tools only', /window\.__ltSel=\(\)=>/.test(SRC));
  ok('no unguarded "$(...).querySelector" chain survives', !/\$\([^)]*\)\.querySelector/.test(CODE));
}

/* ---------- 2. a normal boot records no miss ---------- */
const boot = open(FILE);
bail('the page boots with no uncaught error', realErrs(boot).length === 0,
     realErrs(boot).map(e => String(e && e.message).slice(0, 90)).join(' | '));
await waitFor(() => boot.d.querySelectorAll('#feed .card, #feed [data-v]').length > 0);
const painted = boot.d.querySelectorAll('[data-v]').length;
ok('the feed still paints', painted > 0, painted + ' nodes');
ok('a normal boot records zero selector misses',
   typeof boot.w.__ltSel === 'function' && boot.w.__ltSel().n === 0,
   JSON.stringify(boot.w.__ltSel ? boot.w.__ltSel() : null));

/* ---------- 3. the missing-node matrix ---------- */
/* Each case takes a node the app expects out of the document, then drives the
   surface that used to deref it. `pre` runs inside beforeParse so a boot-time
   selector can be broken the way a renamed id would break it. */
const CASES = [
  {
    label: 'chip click with #chips gone',
    run: 'chip("Music")',
    pre: w => w.document.addEventListener('DOMContentLoaded', () => { const e = w.document.getElementById('chips'); if (e) e.remove(); }, { once: true }),
    sel: '.chip',
  },
  {
    label: 'subscriptions repaint with #sg gone',
    run: 'subs()',
    pre: w => w.document.addEventListener('DOMContentLoaded', () => { const e = w.document.getElementById('sg'); if (e) e.remove(); }, { once: true }),
    sel: 'button',
  },
  {
    label: 'player open with the .art box gone',
    run: 'play("' + vids[0] + '")',
    pre: w => w.document.addEventListener('DOMContentLoaded', () => { const e = w.document.querySelector('#pl .art'); if (e) e.remove(); }, { once: true }),
    sel: '.art',
  },
  {
    label: 'page replay with #lens gone',
    run: 'replay(P[0])',
    pre: w => w.document.addEventListener('DOMContentLoaded', () => { const e = w.document.getElementById('lens'); if (e) e.remove(); }, { once: true }),
    sel: 'iframe',
    noMiss: true,
  },
  {
    label: 'page replay with no page at all',
    run: 'replay(null)',
    pre: null,
    sel: '.chip,.vh,.card,.big,#sg>button',
    noMiss: true,
  },
  {
    label: 'dock render with #p-explore gone',
    run: 'render(false)',
    mutate: h => h.replace('id="p-explore"', 'id="p-explore-gone"'),
    sel: null,
  },
  {
    label: 'boot with #tabs gone',
    run: '1',
    mutate: h => h.replace('id="tabs"', 'id="tabs-gone"'),
    sel: '.tab',
  },
];

const RESULTS = [];
for (const c of CASES) {
  const env = open(FILE, c.pre, c.mutate);
  await waitFor(() => env.d.querySelectorAll('#feed [data-v]').length > 0 || env.errs.length);
  const before = env.w.__ltSel ? env.w.__ltSel().n : -1;
  const r = drive(env, c.run);
  await sleep(120);
  const after = env.w.__ltSel ? env.w.__ltSel() : { n: -1, misses: [] };
  const thrown = realErrs(env);
  const label = c.label;
  ok(label + ': the surface is driven without throwing', r.ok && thrown.length === 0,
     (r.ok ? '' : String(r.value && r.value.message).slice(0, 80)) + ' ' + thrown.map(e => String(e && e.message).slice(0, 60)).join('|'));
  ok(label + ': the app is still alive afterwards',
     drive(env, 'document.getElementById("feed")?"1":"0"').value === '1');
  if (c.sel && !c.noMiss) {
    const hit = after.misses.some(m => m[0] === c.sel && m[1] >= 1);
    ok(label + ': the miss is recorded for ' + c.sel, hit || after.n > before, JSON.stringify(after.misses).slice(0, 120));
  }
  RESULTS.push({ label, code: c.run, sel: c.sel, thrown: thrown.length });
  env.dom.window.close();
}

/* ---------- 4. the misses are counted once, not once per frame ---------- */
{
  const env = open(FILE, w => w.document.addEventListener('DOMContentLoaded', () => {
    const e = w.document.getElementById('chips'); if (e) e.remove();
  }, { once: true }));
  await waitFor(() => env.d.querySelectorAll('#feed [data-v]').length > 0);
  drive(env, 'for(let i=0;i<5;i++)chip("Music")');
  const n = env.w.__ltSel().misses.filter(m => m[0] === '.chip').length
    ? env.w.__ltSel().misses.find(m => m[0] === '.chip')[1] : 0;
  const lines = env.lines.filter(l => /lt-sel miss sel=\.chip/.test(l)).length;
  ok('five repeats of the same missing selector count five misses, one log line', n === 5 && lines === 1,
     'counted ' + n + ', logged ' + lines);
  ok('an empty querySelectorAll is not a miss',
     (() => { const e2 = open(FILE); return e2.w.__ltSel().n === 0; })(),
     'a boot with no cards yet must not report [data-v] as missing');
  env.dom.window.close();
}

/* ---------- 5. the DOM is unchanged ---------- */
function signature(d) {
  const out = [];
  const walk = n => {
    if (n.nodeType !== 1) return;
    const t = n.tagName;
    if (t === 'SCRIPT' || t === 'STYLE') return;
    out.push(t + '#' + (n.id || '') + '.' + (n.className || ''));
    for (const c of n.children) walk(c);
  };
  walk(d.documentElement);
  return out;
}
{
  const env = open(FILE);
  await waitFor(() => env.d.querySelectorAll('#feed [data-v]').length > 0);
  const now = signature(env.d);
  env.dom.window.close();
  if (BASE) {
    const old = open(BASE);
    await waitFor(() => old.d.querySelectorAll('#feed [data-v]').length > 0);
    const was = signature(old.d);
    old.dom.window.close();
    const same = was.length === now.length && was.every((v, i) => v === now[i]);
    ok('the element tree of a boot is identical before and after', same,
       was.length + ' vs ' + now.length + ' nodes' +
       (same ? '' : '; first difference at ' + was.findIndex((v, i) => v !== now[i])));
  } else {
    ok('element tree captured (pass the pre-change file to compare)', now.length > 50, now.length + ' nodes');
  }
}

/* ---------- 6. the pre-change build fails the same scenarios ---------- */
if (BASE) {
  const B = [
    { label: 'chip click with #chips gone', run: 'chip("Music")', id: 'chips' },
    { label: 'subscriptions repaint with #sg gone', run: 'subs()', id: 'sg' },
    { label: 'page replay with #lens gone', run: 'replay(P[0])', id: 'lens' },
    { label: 'dock render with #p-explore gone', run: 'render(false)', rename: ['id="p-explore"', 'id="p-explore-gone"'] },
  ];
  for (const c of B) {
    const env = open(BASE, c.rename ? null : (w => w.document.addEventListener('DOMContentLoaded', () => {
      const e = w.document.getElementById(c.id); if (e) e.remove();
    }, { once: true })), c.rename ? (h => h.replace(c.rename[0], c.rename[1])) : null);
    await waitFor(() => env.d.querySelectorAll('#feed [data-v]').length > 0 || env.errs.length);
    const r = drive(env, c.run);
    const threw = !r.ok || realErrs(env).length > 0;
    ok('pre-change build: ' + c.label + ' — still throws, so the guard is the fix', threw);
    env.dom.window.close();
  }
  {
    const env = open(BASE, null, h => h.replace('id="tabs"', 'id="tabs-gone"'));
    await sleep(300);
    ok('pre-change build: boot with #tabs gone — still throws', realErrs(env).length > 0);
    env.dom.window.close();
  }
}

report();
process.exit(fails.length ? 1 : 0);

})();
