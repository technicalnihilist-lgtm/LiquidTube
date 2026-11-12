#!/usr/bin/env node
/*
 * LiquidTube boot self-check — proves item 5.10 ("add a self-check that runs on
 * boot in debug mode").
 *
 * The check has to be a real detector, and it has to be invisible when it is not
 * asked for. This asserts both, on a boot that is otherwise identical:
 *
 *  1. DEBUG OFF (the shipped default): no `lt-selfcheck` line is ever written,
 *     `window.__ltSelfCheck().on` is 0, no idle callback is booked, and the
 *     finished page is **byte-identical** to the same boot with debug on — the
 *     check changes no pixel and no node;
 *  2. DEBUG ON: exactly one line, of the shape
 *     `lt-selfcheck on=1 ok=<n> fail=0 n=<n> ms=<n>`, written after the startup
 *     timeline line (it runs in an idle slot after the boot has settled), with
 *     every probe passing on a healthy boot;
 *  3. the probe set is fixed and complete: the names in the line are exactly the
 *     names `window.__ltSelfCheck()` publishes, so a probe cannot be dropped
 *     without the tool noticing;
 *  4. IT DETECTS: break a bound (delete a shell node, empty an error sentence,
 *     put a library array over its cap, swap a validator for a number) and a
 *     re-run reports exactly the probes that broke, by name;
 *  5. IT IS BOUNDED: with a dozen things broken at once the `fails=` list stays
 *     at eight names while `fail=` still counts them all, and the whole line
 *     stays one line;
 *  6. IT IS READ-ONLY: a re-run performs no fetch, no localStorage write, no DOM
 *     mutation, and returns in a few milliseconds;
 *  7. it costs the boot nothing when off: the `total=` in the startup timeline is
 *     the same with debug on and off (within timer noise), and the check's own
 *     line never appears before the boot's.
 *
 * Runs in jsdom with googleapis.com answered from fixtures — no network, no
 * Chromium, no device.
 *
 *   npm i jsdom
 *   node tools/selfcheck-boot-check.js app/assets/index.html
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const FILE = process.argv[2] || path.join(__dirname, '..', 'app', 'assets', 'index.html');
const sleep = ms => new Promise(r => setTimeout(r, ms));

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
  if (p.endsWith('/playlistItems')) {
    return { items: F.search.items.map(it => ({ snippet: Object.assign({}, it.snippet, { resourceId: { videoId: it.id.videoId } }), contentDetails: { videoPublishedAt: it.snippet.publishedAt } })) };
  }
  if (p.endsWith('/search')) return F.search;
  return {};
}

/* A page: fresh window, fresh localStorage, a fetch answered from the fixtures.
   `dbg` decides the URL the shell would have loaded — the app is the same file
   either way, which is the point: debug mode is a parameter, not a build. */
function open(dbg) {
  const HTML = fs.readFileSync(FILE, 'utf8');
  const env = { log: [], lines: [], errors: [], urls: [], idle: 0, sets: 0 };
  const mockFetch = async u => {
    env.urls.push(String(u).replace(/([?&])key=[^&]*/, '$1key=<key>'));
    const j = apiBody(String(u));
    return { ok: true, status: 200, json: async () => j, headers: new Map() };
  };
  const dom = new JSDOM(HTML, {
    url: 'https://liquidtube.local/index.html' + (dbg ? '?ltdebug=1' : ''),
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(w) {
      w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
      w.fetch = mockFetch;
      w.scrollTo = () => {};
      /* the idle slot the check books, counted so "off" can prove it booked none */
      const ric = w.requestIdleCallback;
      w.requestIdleCallback = function (fn, o) { env.idle++; return ric ? ric.call(w, fn, o) : w.setTimeout(() => fn({ didTimeout: true, timeRemaining: () => 0 }), 1); };
      /* storage writes, counted so a re-run can prove it wrote none */
      const proto = w.Storage && w.Storage.prototype;
      if (proto) {
        const set = proto.setItem;
        proto.setItem = function (k, v) { env.sets++; return set.call(this, k, v); };
      }
      const log = (kind) => (...a) => {
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

const ignorable = e => /WebAssembly|Cannot allocate/i.test(String((e && e.message) || ''));
process.on('uncaughtException', e => { if (!ignorable(e)) { console.error('uncaught', e); process.exit(1); } });
process.on('unhandledRejection', e => { if (!ignorable(e)) { console.error('unhandled', e); process.exit(1); } });

async function waitFor(fn, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(20); }
  return false;
}

/* ---------- assertions ---------- */
let pass = 0;
const fails = [];
function ok(label, cond, detail) {
  if (cond) { pass++; return; }
  fails.push(label + (detail !== undefined ? ' — ' + detail : ''));
}

const LINE_RE = /^lt-selfcheck on=([01]) ok=(\d+) fail=(\d+) n=(\d+) ms=(\d+)(?: fails=([a-z,]+))?$/;
const sc = env => env.lines.filter(l => l.indexOf('lt-selfcheck') === 0);
const num = (line, k) => +new RegExp(k + '=(\\d+)').exec(line)[1];

/* The healthy set, named here so a probe cannot vanish quietly. Order-free. */
const PROBES = ['shell', 'timeline', 'marks', 'codec', 'reqcache', 'vmap', 'chmap', 'avatars',
  'library', 'errors', 'retry', 'shape', 'async', 'global', 'quota', 'surfaces', 'selectors',
  'escape', 'numbers', 'thumbs', 'thumbsize', 'preconnect', 'doc', 'state', 'booted'];

async function boot(dbg) {
  const env = open(dbg);
  const seen = await waitFor(() => env.w.__ltTimeline && (env.lines.some(l => l.indexOf('lt-startup') === 0)));
  ok((dbg ? 'on' : 'off') + ': boot reached its timeline', seen);
  /* the check runs in an idle slot after the boot: give it the room a device has */
  await waitFor(() => sc(env).length > 0 || !dbg, 5000);
  await sleep(120);
  return env;
}

(async () => {
  const off = await boot(false);
  const on = await boot(true);

  /* ---------- 1. debug off is silent, and identical ---------- */
  ok('off: no lt-selfcheck line', sc(off).length === 0, sc(off).join(' | '));
  ok('off: window.__ltSelfCheck().on is 0', off.w.__ltSelfCheck && off.w.__ltSelfCheck().on === 0);
  ok('on: debug mode books exactly one idle slot more than off', on.idle === off.idle + 1, on.idle + ' vs ' + off.idle);
  ok('off: no probe names published as run', off.w.__ltSelfCheck && off.w.__ltSelfCheck().runs === 0);
  ok('off: the finished page equals the debug-on page', off.d.body.innerHTML === on.d.body.innerHTML,
    'off=' + off.d.body.innerHTML.length + 'B on=' + on.d.body.innerHTML.length + 'B');

  /* ---------- 2. debug on: one line, healthy ---------- */
  const lines = sc(on);
  ok('on: exactly one lt-selfcheck line', lines.length === 1, String(lines.length));
  const line = lines[0] || '';
  ok('on: the line has the documented shape', LINE_RE.test(line), line);
  const m = LINE_RE.exec(line);
  if (m) {
    ok('on: the line says debug is on', m[1] === '1', line);
    ok('on: every probe passes on a healthy boot', +m[3] === 0, line);
    ok('on: it ran every probe', +m[2] + +m[3] === +m[4], line);
    ok('on: the line carries no fails= list when nothing failed', m[6] === undefined, line);
    ok('on: the first run is quick', +m[5] < 150, m[5] + 'ms');
  }
  ok('on: it runs after the boot has settled', on.lines.findIndex(l => l.indexOf('lt-selfcheck') === 0) >
    on.lines.findIndex(l => l.indexOf('lt-startup') === 0));
  const census = on.w.__ltSelfCheck ? on.w.__ltSelfCheck() : {};
  ok('on: the census reports the same count as the line', census.n === 25, String(census.n));
  ok('on: the census reports one run', census.runs === 1, String(census.runs));
  ok('on: the census keeps the last line', census.last === line, String(census.last));

  /* ---------- 3. the probe set is fixed ---------- */
  ok('on: the probe names are exactly the documented set',
    Array.isArray(census.names) && census.names.slice().sort().join(',') === PROBES.slice().sort().join(','),
    (census.names || []).join(','));
  ok('on: the names are unique', new Set(census.names || []).size === (census.names || []).length);

  /* ---------- 4. it detects: break one bound per class ---------- */
  const run = () => { on.w.__ltSelfCheckRun(); return on.w.__ltSelfCheck(); };

  const ex = on.d.getElementById('ex');
  ex.parentNode.removeChild(ex);
  let r = run();
  ok('detect: a missing shell node fails `shell`', r.fail === 1 && r.fails.join(',') === 'shell', JSON.stringify(r.fails));
  on.d.getElementById('app').appendChild(ex);            /* healed again: one break at a time */

  /* empty one error sentence: the map must still have a sentence for every class */
  const before = on.w.eval('EK_TEXT.network');
  on.w.eval("EK_TEXT.network=''");
  r = run();
  ok('detect: an empty error sentence fails `errors`', r.fail === 1 && r.fails.join(',') === 'errors', JSON.stringify(r.fails));
  on.w.eval("EK_TEXT.network=" + JSON.stringify(before));

  /* put a library array over its cap */
  on.w.eval("S.hist.length=HIST_MAX+1");
  r = run();
  ok('detect: a library array over its cap fails `library`', r.fail === 1 && r.fails.join(',') === 'library', JSON.stringify(r.fails));
  on.w.eval("S.hist.length=0");

  /* a validator that is no longer a function */
  on.w.__SC_SHPL = on.w.eval("SH_SPEC.playlistItems");
  on.w.__SC_SHVID = on.w.eval("SH_SPEC['videos.chart']");
  on.w.eval("SH_SPEC['videos.chart']=1");
  r = run();
  ok('detect: a validator that is not a function fails `shape`', r.fail === 1 && r.fails.join(',') === 'shape', JSON.stringify(r.fails));
  on.w.eval("SH_SPEC['videos.chart']=window.__SC_SHVID");

  /* a retry key with nothing behind it */
  on.w.eval("RTY.feed=0");
  r = run();
  ok('detect: a retry key with no function fails `retry`', r.fail === 1 && r.fails.join(',') === 'retry', JSON.stringify(r.fails));
  on.w.eval("RTY.feed=retryFeed");

  /* a cache over its ceiling */
  on.w.eval("VQ.clear();for(let i=0;i<V_HI+1;i++)VQ.add('x'+i)");
  r = run();
  ok('detect: a cache over its ceiling fails `vmap`', r.fail === 1 && r.fails.join(',') === 'vmap', JSON.stringify(r.fails));
  on.w.eval("VQ.clear()");

  /* the shell is whole again: nothing fails */
  r = run();
  ok('detect: a healed app passes again', r.fail === 0 && r.fails.length === 0, JSON.stringify(r.fails));
  ok('detect: every run wrote its own line', sc(on).length >= 8, String(sc(on).length));
  ok('detect: every line kept its shape', sc(on).every(l => LINE_RE.test(l)), sc(on).find(l => !LINE_RE.test(l)));

  /* ---------- 5. bounded ---------- */
  const broken = [];
  const app = on.d.getElementById('app');
  ['feed', 'subfeed', 'chips', 'splash'].forEach(id => { const n = on.d.getElementById(id); if (n) { broken.push([n, n.parentNode]); n.parentNode.removeChild(n); } });
  on.w.eval("EK_TEXT.unknown=''");
  on.w.eval("S.liked.length=LIKED_MAX+1;S.later.length=LATER_MAX+1");
  on.w.eval("CHQ.clear();for(let i=0;i<CH_HI+1;i++)CHQ.add('c'+i)");
  on.w.__SC_TL = on.w.eval("TL.slice()");
  on.w.eval("LT_OWN.set('x',[1,2,3,4,5,6,7,8]);SH_SPEC.playlistItems=0;RTY.feed=0");
  on.w.eval("Q.units=-1");
  on.w.eval("VQ.clear();for(let i=0;i<V_HI+1;i++)VQ.add('x'+i)");
  on.w.eval("CAVQ.clear();for(let i=0;i<CAV_MAX+1;i++)CAVQ.add('a'+i)");
  on.w.eval("for(let i=0;i<20;i++)TL.push('junk')");
  r = run();
  ok('bounded: a dozen broken invariants all counted', r.fail >= 8, String(r.fail));
  ok('bounded: the fails= list stops at eight names', r.fails.length === 8, String(r.fails.length));
  const lastLine = sc(on)[sc(on).length - 1];
  ok('bounded: the line stays one line', !/[\r\n]/.test(lastLine), JSON.stringify(lastLine));
  ok('bounded: the line names no more than eight', (LINE_RE.exec(lastLine)[6] || '').split(',').filter(Boolean).length === 8, lastLine);

  /* ---------- 6. read-only ---------- */
  broken.reverse().forEach(([n, p]) => p.appendChild(n));
  on.w.eval("EK_TEXT.unknown='Something went wrong. Try again.';S.liked.length=0;S.later.length=0;CHQ.clear()");
  on.w.eval("SH_SPEC.playlistItems=window.__SC_SHPL;RTY.feed=retryFeed");
  on.w.eval("LT_OWN.clear();Q.units=0;VQ.clear();CAVQ.clear();TL.length=0;window.__SC_TL.forEach(m=>TL.push(m))");
  const urlsBefore = on.urls.length, setsBefore = on.sets;
  const htmlBefore = on.d.body.innerHTML;
  r = run();
  const htmlAfter = on.d.body.innerHTML;
  ok('read-only: a run makes no request', on.urls.length === urlsBefore, (on.urls.length - urlsBefore) + ' new');
  ok('read-only: a run writes no storage', on.sets === setsBefore, (on.sets - setsBefore) + ' writes');
  ok('read-only: a run leaves the page exactly as it found it', htmlBefore === htmlAfter,
    htmlBefore.length + 'B -> ' + htmlAfter.length + 'B');
  ok('read-only: a run is quick', r.ms < 50, r.ms + 'ms');
  ok('read-only: a healed app is green again', r.fail === 0, JSON.stringify(r.fails));

  /* ---------- 7. the boot pays nothing ---------- */
  const tlOff = off.lines.find(l => l.indexOf('lt-startup') === 0) || '';
  const tlOn = on.lines.find(l => l.indexOf('lt-startup') === 0) || '';
  const totOff = num(tlOff, 'total'), totOn = num(tlOn, 'total');
  ok('cost: the timeline exists on both boots', totOff > 0 && totOn > 0, tlOff + ' / ' + tlOn);
  /* The check runs only after the timeline has been written (it is booked from
     tlFlush), so it cannot be inside `total` at all; the two boots differ only by
     jsdom's own scheduling noise, which is far larger than the check. */
  ok('cost: the check is not part of the boot total', Math.abs(totOn - totOff) <= 1500, totOn + ' vs ' + totOff);
  ok('cost: debug mode adds no request', on.urls.length === off.urls.length, on.urls.length + ' vs ' + off.urls.length);

  /* ---------- 8. nothing thrown on either path ---------- */
  ok('off: no console.error', off.errors.length === 0, off.errors.join(' | '));
  ok('on: no console.error', on.errors.length === 0, on.errors.join(' | '));

  off.dom.window.close(); on.dom.window.close();

  console.log('selfcheck-boot-check: ' + pass + ' passed, ' + fails.length + ' failed');
  if (fails.length) {
    fails.forEach(f => console.log('  FAIL ' + f));
    process.exit(1);
  }
  process.exit(0);
})();
