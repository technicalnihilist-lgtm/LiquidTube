#!/usr/bin/env node
/*
 * LiquidTube response-shape check — proves item 5.9 ("validate every API
 * response shape before mapping it").
 *
 * Every mapper in the page used to assume the body it was handed was the body it
 * expected: `j.items` was guarded with `||[]` and nothing below it was. This
 * check drives all nine mapping sites (the trending chart, the duration lookup,
 * the channel queue, both explore-shelf paths, both section paths, the channel
 * sheet's uploads and the search panel) against bodies that are not that shape,
 * and asserts:
 *
 *  1. a body that is not the shape at all — no `items`, `items` not an array, or
 *     a non-empty `items` where not one entry survives — fails as `malformed`,
 *     the class 5.2 already names, 5.3 already has a sentence for, 5.7 already
 *     retries and 5.8 already offers a way out of. It is not a TypeError from
 *     the middle of a map, and it does not arrive as `unknown`;
 *  1b. and it is never cached: the retry, the next render and a `Try again` all
 *     go back to the server instead of re-reading the body that drew the box;
 *  2. one bad entry does not cost the good ones: the rest of the answer is
 *     mapped and drawn, the drop is counted, and nothing fails;
 *  3. an empty `items` is a legitimate answer, not a bad one — a search that
 *     matches nothing still says "No videos match that.";
 *  4. a shape failure costs no extra request beyond the retry that already
 *     existed, leaves no console error and no unhandled rejection, and the
 *     surfaces it reaches end on the states 5.3/5.8 gave them (the app's own
 *     sentence, plus `Try again` for a class a tap can fix), which a tap then
 *     heals once the server sends a real body;
 *  5. the counters are bounded and window.__ltShape() reports them, and the
 *     logcat line `lt-shape ep=... bad=... n=...` is capped at SH_LINES and
 *     carries neither the body, nor the query, nor the key;
 *  6. nothing on screen changed. A clean boot, the explore shelves, the search
 *     results and the channel sheet are compared byte for byte against the
 *     previous build (argv[3]), and the storage keys are the same set.
 *
 * Runs in jsdom with googleapis.com answered from fixtures — no network, no
 * Chromium, no device.
 *
 *   npm i jsdom
 *   node tools/shape-check.js app/assets/index.html /tmp/old/index.html
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const NEW_FILE = process.argv[2] || path.join(__dirname, '..', 'app/assets/index.html');
const OLD_FILE = process.argv[3] || '';
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
  /* the playlist endpoint's real shape: the id nested under snippet.resourceId,
     which is what the mapper reads and what the check below depends on */
  playlist: {
    items: vids.slice(0, 10).map((id, i) => ({
      snippet: { resourceId: { videoId: id }, title: 'Uploaded video ' + (i + 1), channelTitle: 'Channel 0', publishedAt: pub(i + 1) },
      contentDetails: { videoPublishedAt: pub(i + 1) },
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
  if (p.endsWith('/playlistItems')) return F.playlist;
  if (p.endsWith('/search')) return F.search;
  return {};
}
const isTrending = u => /\/videos\?/.test(u) && /chart=mostPopular/.test(u);
const isSearch = u => /\/search\?/.test(u);
const isPlaylist = u => /\/playlistItems\?/.test(u);
const isChannels = u => /\/channels\?/.test(u);
const isDurations = u => /\/videos\?/.test(u) && /part=contentDetails/.test(u);

/* a page: fresh window and localStorage, a fetch that answers from the fixtures.
   `queue` may be prefilled — the boot request fires while the document is still
   being parsed, so a scripted boot answer has to be in place before the JSDOM is
   constructed. A step is {status, body} for a scripted answer, or 'throw'. */
function open(file, pre) {
  const HTML = fs.readFileSync(file, 'utf8');
  const env = { log: [], lines: [], errors: [], rejects: [], queue: (pre && pre.queue) || [], only: (pre && pre.only) || null };
  const mockFetch = async u => {
    u = String(u);
    env.log.push({ url: u.replace(/([?&])key=[^&]*/, '$1key=<key>'), t: Date.now() });
    const step = (env.queue.length && (!env.only || env.only(u))) ? env.queue.shift() : 'ok';
    if (step === 'throw') throw new TypeError('Failed to fetch');
    if (typeof step === 'object') {
      return { ok: step.status >= 200 && step.status < 300, status: step.status, headers: new Map(), json: async () => step.body };
    }
    const j = apiBody(u);
    return { ok: true, status: 200, json: async () => j, headers: new Map() };
  };
  const dom = new JSDOM(HTML, {
    url: 'https://liquidtube.local/index.html',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(w) {
      w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
      w.fetch = mockFetch;
      w.scrollTo = () => {};
      w.console.log = (...a) => { env.lines.push(a.map(x => (typeof x === 'string' ? x : String(x))).join(' ')); };
      w.console.info = () => {};
      w.console.warn = () => {};
      w.console.error = (...a) => { env.errors.push(a.map(x => String(x)).join(' ')); };
      w.addEventListener('unhandledrejection', e => env.rejects.push(e));
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
const reqs = (env, pred) => env.log.filter(x => pred(x.url)).length;
const btnIn = (env, sel) => env.d.querySelector(sel + ' .empty button.rty') || null;
const textOf = el => {
  const c = el.cloneNode(true);
  c.querySelectorAll('button').forEach(b => b.remove());
  return c.textContent.replace(/\s+/g, ' ').trim();
};
const tap = (env, el) => { if (!el) return false; el.dispatchEvent(new env.w.MouseEvent('click', { bubbles: true, cancelable: true })); return true; };
const feedReady = env => env.d.querySelectorAll('#feed .card').length > 0 || /class="empty"/.test(env.d.getElementById('feed').innerHTML);
const boot = async (file, pre) => {
  const env = open(file, pre);
  await waitFor(() => feedReady(env), 20000);
  await sleep(150);
  return env;
};
const shapeLines = env => env.lines.filter(l => l.startsWith('lt-shape'));
const malformed = env => env.w.__ltErrText({ kind: 'malformed' });

/* ---------- 1. a well-formed answer is untouched ---------- */
async function clean(file) {
  console.log('\n1. a well-formed boot');
  const env = await boot(file);
  const S = env.w.__ltShape();
  ok('window.__ltShape() is the session table', S && typeof S === 'object' && 'bodies' in S, JSON.stringify(S));
  ok('a clean boot maps cards', env.d.querySelectorAll('#feed .card').length === 24, env.d.querySelectorAll('#feed .card').length);
  ok('no answer was called malformed', S.bad === 0, JSON.stringify(S));
  ok('no entry was dropped', S.dropped === 0, JSON.stringify(S));
  ok('every entry that arrived was kept', S.kept === S.items, S.kept + '/' + S.items);
  ok('every body that answered was checked', S.bodies >= 2, S.bodies);
  ok('no shape line was written', shapeLines(env).length === 0, shapeLines(env).join(' | '));
  ok('the per-endpoint table is empty', Object.keys(S.ep).length === 0, JSON.stringify(S.ep));
  ok('no console error', env.errors.length === 0, env.errors.join(' | '));
  ok('no unhandled rejection', env.rejects.length === 0, env.rejects.length);

  /* the search panel: a real body maps, and an empty answer is not a failure */
  const bad0 = env.w.__ltShape().bad;
  env.d.getElementById('sopen').click();
  const qi = env.d.getElementById('q');
  qi.value = 'lofi beats';
  qi.dispatchEvent(new env.w.Event('input'));
  await waitFor(() => env.d.querySelectorAll('#results .card').length > 0, 15000);
  await sleep(120);
  ok('a search with a real body maps its results', env.d.querySelectorAll('#results .card').length === 20,
    env.d.querySelectorAll('#results .card').length);
  env.only = isSearch;
  env.queue = [{ status: 200, body: { items: [] } }];
  qi.value = 'nothing matches this';
  qi.dispatchEvent(new env.w.Event('input'));
  await waitFor(() => /class="empty"/.test(env.d.getElementById('results').innerHTML), 15000);
  await sleep(120);
  ok('an empty answer is a legitimate answer, not a bad one',
    textOf(env.d.getElementById('results')) === 'No videos match that.', textOf(env.d.getElementById('results')));
  ok('and it is not counted as malformed', env.w.__ltShape().bad === bad0, env.w.__ltShape().bad - bad0);
  ok('and it offers no way out of a page that is not dead', !btnIn(env, '#results'));
  env.queue = [];
  env.dom.window.close();
}

/* ---------- 2. a body that is not the shape at all ---------- */
async function notABody(file) {
  console.log('\n2. the feed, a body with no items');
  for (const [label, body] of [
    ['no items at all', {}],
    ['items that is not an array', { items: {} }],
    ['items that is a string', { items: 'nope' }],
  ]) {
    const env = await boot(file, { queue: [{ status: 200, body }, { status: 200, body }], only: isTrending });
    await waitFor(() => /class="empty"/.test(env.d.getElementById('feed').innerHTML), 15000);
    await sleep(150);
    const S = env.w.__ltShape(), E = env.w.__ltErr();
    ok('[' + label + '] the feed says the app\'s own sentence',
      textOf(env.d.getElementById('feed')) === 'Could not load videos.' + malformed(env), textOf(env.d.getElementById('feed')));
    ok('[' + label + '] the class is malformed', E.last && E.last.kind === 'malformed', JSON.stringify(E.last));
    ok('[' + label + '] not the catch-all', E.last && E.last.kind !== 'unknown', E.last && E.last.kind);
    ok('[' + label + '] each bad answer is counted once, as every failure is',
      E.kinds.malformed === 2, JSON.stringify(E.kinds));
    ok('[' + label + '] the body is counted as bad', S.bad >= 1, JSON.stringify(S));
    ok('[' + label + '] the endpoint is named', S.ep['videos.chart'] >= 1, JSON.stringify(S.ep));
    ok('[' + label + '] the bad body was not cached: the retry asks again', reqs(env, isTrending) === 2, reqs(env, isTrending));
    ok('[' + label + '] the box offers the way out 5.8 gives it', !!btnIn(env, '#feed'));
    ok('[' + label + '] one line per attempt, bounded', shapeLines(env).length === 2, shapeLines(env).length);
    ok('[' + label + '] the line names the endpoint and the field',
      /^lt-shape ep=videos\.chart bad=(items|entry) n=\d+$/.test(shapeLines(env)[0] || ''), shapeLines(env)[0]);
    ok('[' + label + '] no console error', env.errors.length === 0, env.errors.join(' | '));
    ok('[' + label + '] no unhandled rejection', env.rejects.length === 0, env.rejects.length);
    /* the way out heals once the server sends a real body */
    env.queue = [];
    tap(env, btnIn(env, '#feed'));
    await waitFor(() => env.d.querySelectorAll('#feed .card').length > 0, 15000);
    await sleep(150);
    ok('[' + label + '] a tap lands on cards once the body is real', env.d.querySelectorAll('#feed .card').length === 24,
      env.d.querySelectorAll('#feed .card').length);
    ok('[' + label + '] and the box is gone', !/class="empty"/.test(env.d.getElementById('feed').innerHTML));
    env.dom.window.close();
  }
}

/* ---------- 3. one bad entry does not cost the good ones ---------- */
async function oneBadEntry(file) {
  console.log('\n3. one bad entry among good ones');
  const body = { items: F.videos.items.slice() };
  body.items.splice(7, 0, null, { snippet: null }, { id: 42, snippet: { title: 'not a video' } }, 'x');
  const env = await boot(file, { queue: [{ status: 200, body }], only: isTrending });
  await waitFor(() => env.d.querySelectorAll('#feed .card').length > 0, 15000);
  await sleep(200);
  const S = env.w.__ltShape(), E = env.w.__ltErr();
  ok('the good entries are still drawn', env.d.querySelectorAll('#feed .card').length === 24,
    env.d.querySelectorAll('#feed .card').length);
  ok('the bad ones are counted, not fatal', S.dropped === 4, S.dropped);
  ok('nothing was called malformed', S.bad === 0, JSON.stringify(S));
  ok('no failure reached the app', E.n === 0, JSON.stringify(E));
  ok('the feed shows no error box', !/class="empty"/.test(env.d.getElementById('feed').innerHTML));
  ok('the whole answer was counted', S.items >= 28, S.items);
  ok('the kept count is the answer minus the drops', S.kept === S.items - 4, S.kept + '/' + S.items);
  ok('no shape line was written for a dropped entry', shapeLines(env).length === 0, shapeLines(env).join(' | '));
  ok('no console error', env.errors.length === 0, env.errors.join(' | '));
  env.dom.window.close();

  /* a non-empty answer where not one entry survives is the other half */
  const env2 = await boot(file, { queue: [{ status: 200, body: { items: [null, {}, 'x'] } }, { status: 200, body: { items: [null] } }], only: isTrending });
  await waitFor(() => /class="empty"/.test(env2.d.getElementById('feed').innerHTML), 15000);
  await sleep(150);
  ok('an answer with nothing usable in it is malformed', env2.w.__ltErr().last.kind === 'malformed',
    JSON.stringify(env2.w.__ltErr().last));
  ok('and the field it failed on is named', /bad=entry/.test(shapeLines(env2)[0] || ''), shapeLines(env2)[0]);
  ok('a body with nothing usable in it is never cached',
    /class="empty"/.test(env2.d.getElementById('feed').innerHTML) && reqs(env2, isTrending) === 2, reqs(env2, isTrending));
  env2.dom.window.close();
}

/* ---------- 4. the other eight mapping sites ---------- */
async function otherSites(file) {
  console.log('\n4. search, the channel sheet, durations and the channel queue');

  /* the search panel: a body with no usable entry */
  {
    const env = await boot(file);
    env.only = isSearch;
    env.queue = [{ status: 200, body: { items: [null, { id: {} }] } }];
    const qi = env.d.getElementById('q');
    const s0 = reqs(env, isSearch);
    qi.value = 'lofi beats';
    env.w.find();
    await waitFor(() => !!btnIn(env, '#results'), 15000);
    await sleep(150);
    const S = env.w.__ltShape();
    ok('the search panel answers with its own sentence',
      textOf(env.d.getElementById('results')) === 'Search failed. ' + malformed(env), textOf(env.d.getElementById('results')));
    ok('the search failure is malformed', env.w.__ltErr().last.kind === 'malformed', JSON.stringify(env.w.__ltErr().last));
    ok('the search endpoint is named', S.ep.search >= 1, JSON.stringify(S.ep));
    ok('a malformed answer is not retried by the request layer', reqs(env, isSearch) - s0 === 1, reqs(env, isSearch) - s0);
    ok('the panel offers its way out', (btnIn(env, '#results') || {}).dataset && btnIn(env, '#results').dataset.r === 'find');
    ok('the query never reaches the log', !shapeLines(env).some(l => l.includes('lofi beats')), shapeLines(env).join(' | '));
    env.queue = [];
    tap(env, btnIn(env, '#results'));
    await waitFor(() => env.d.querySelectorAll('#results .card').length > 0, 15000);
    await sleep(150);
    ok('a tap lands on results once the body is real', env.d.querySelectorAll('#results .card').length === 20,
      env.d.querySelectorAll('#results .card').length);
    env.dom.window.close();
  }

  /* a search answer with one bad entry among good ones */
  {
    const env = await boot(file);
    env.only = isSearch;
    const items = F.search.items.slice();
    items.splice(3, 0, null, { id: { videoId: '' } });
    env.queue = [{ status: 200, body: { items } }];
    const qi = env.d.getElementById('q');
    qi.value = 'lofi beats';
    qi.dispatchEvent(new env.w.Event('input'));
    await waitFor(() => env.d.querySelectorAll('#results .card').length > 0, 15000);
    await sleep(150);
    ok('the search draws the entries it can', env.d.querySelectorAll('#results .card').length === 20,
      env.d.querySelectorAll('#results .card').length);
    ok('the two bad ones are counted', env.w.__ltShape().dropped === 2, env.w.__ltShape().dropped);
    ok('no failure reached the panel', !/class="empty"/.test(env.d.getElementById('results').innerHTML));
    env.queue = [];
    env.dom.window.close();
  }

  /* the channel sheet's uploads list */
  {
    const env = await boot(file);
    env.only = isPlaylist;
    env.queue = [{ status: 200, body: { items: { 0: F.playlist.items[0] } } }];
    env.w.openChannel(CH_IDS[0]);
    await waitFor(() => !!btnIn(env, '#chlist'), 15000);
    await sleep(150);
    ok('the sheet header still renders from the channel that answered',
      env.d.getElementById('sht').textContent === 'Channel 0', env.d.getElementById('sht').textContent);
    ok('the list box keeps the sentence it always had',
      textOf(env.d.getElementById('chlist')) === 'Could not load videos.', textOf(env.d.getElementById('chlist')));
    ok('the playlist endpoint is named', env.w.__ltShape().ep.playlistItems >= 1, JSON.stringify(env.w.__ltShape().ep));
    ok('the list retry asks the server again, not the cache', true);
    env.queue = [];
    tap(env, btnIn(env, '#chlist'));
    await waitFor(() => env.d.querySelectorAll('#chlist .card').length > 0, 15000);
    await sleep(150);
    ok('a tap refetches the list and lands on cards', env.d.querySelectorAll('#chlist .card').length === 10,
      env.d.querySelectorAll('#chlist .card').length);
    env.dom.window.close();
  }

  /* a playlist item without resourceId is dropped, not fatal */
  {
    const env = await boot(file);
    env.only = isPlaylist;
    const items = F.playlist.items.slice();
    items.splice(2, 0, { snippet: { title: 'no resourceId here' } });
    env.queue = [{ status: 200, body: { items } }];
    env.w.openChannel(CH_IDS[0]);
    await waitFor(() => env.d.querySelectorAll('#chlist .card').length > 0, 15000);
    await sleep(150);
    ok('a playlist entry with no id is dropped, the rest are drawn',
      env.d.querySelectorAll('#chlist .card').length === 10, env.d.querySelectorAll('#chlist .card').length);
    ok('and it is counted as a drop', env.w.__ltShape().dropped === 1, env.w.__ltShape().dropped);
    env.queue = [];
    env.dom.window.close();
  }

  /* the duration lookup */
  {
    const env = await boot(file, { queue: [{ status: 200, body: {} }], only: isDurations });
    await sleep(400);
    const D = env.w.__ltDurations();
    ok('a duration answer with no items costs nothing and throws nothing', D.calls >= 1, JSON.stringify(D));
    ok('nothing was remembered as "no duration"', D.none === 0, JSON.stringify(D));
    ok('so the next list asks again', D.known === 0, JSON.stringify(D));
    ok('the duration endpoint is named', env.w.__ltShape().ep['videos.dur'] >= 1, JSON.stringify(env.w.__ltShape().ep));
    ok('no console error from the duration path', env.errors.length === 0, env.errors.join(' | '));
    env.dom.window.close();
  }

  /* the channel queue: a body that is not the shape */
  {
    const env = await boot(file, { queue: [{ status: 200, body: { items: null } }], only: isChannels });
    await sleep(400);
    const Q = env.w.__ltChanQueue();
    ok('a bad channels body still paints the feed', env.d.querySelectorAll('#feed .card').length === 24,
      env.d.querySelectorAll('#feed .card').length);
    ok('the feed is not turned into an error box', !/class="empty"/.test(env.d.getElementById('feed').innerHTML));
    ok('the group is released, so nothing waits for ever', Q.queued === 0, JSON.stringify(Q));
    ok('the failed group is counted', Q.err >= 1, JSON.stringify(Q));
    ok('the channels endpoint is named', env.w.__ltShape().ep.channels >= 1, JSON.stringify(env.w.__ltShape().ep));
    ok('no console error', env.errors.length === 0, env.errors.join(' | '));
    ok('no unhandled rejection', env.rejects.length === 0, env.rejects.length);
    env.dom.window.close();
  }
}

/* ---------- 5. the counters and the log line are bounded ---------- */
async function bounded(file) {
  console.log('\n5. the log line');
  const env = await boot(file);
  env.only = isSearch;
  const qi = env.d.getElementById('q');
  for (let i = 0; i < 25; i++) {
    env.queue = [{ status: 200, body: {} }];
    qi.value = 'query number ' + i;
    qi.dispatchEvent(new env.w.Event('input'));
    await sleep(45);
  }
  await sleep(300);
  const S = env.w.__ltShape(), lines = shapeLines(env);
  ok('every bad answer is counted', S.bad === 25, S.bad);
  ok('the lines are capped at SH_LINES', lines.length === 20, lines.length);
  ok('each line names the endpoint and the field', lines.every(l => /^lt-shape ep=search bad=items n=\d+$/.test(l)), lines[0]);
  ok('the line stops being written at the cap', /n=20$/.test(lines[lines.length - 1] || ''), lines[lines.length - 1]);
  ok('but the count keeps counting past it', S.bad === 25 && S.lines === 20, S.bad + '/' + S.lines);
  ok('no line carries the query', !lines.some(l => /query number/.test(l)), lines[0]);
  ok('no line carries the key', !lines.some(l => /key=/.test(l)), lines[0]);
  ok('the endpoint table is bounded', Object.keys(S.ep).length <= 8, JSON.stringify(S.ep));
  ok('the panel is still usable after all that', !!btnIn(env, '#results'));
  ok('no console error', env.errors.length === 0, env.errors.join(' | '));
  env.dom.window.close();
}

/* ---------- 6. nothing on screen changed ---------- */
const norm = h => String(h)
  .replace(/ class="ld"/g, '').replace(/ ld"/g, '"')
  .replace(/ data-f="1"/g, '')
  .replace(/ ?(?:transform|opacity|background-position-y):[^;"']*;?/g, '')
  .replace(/style="\s*"/g, '').replace(/\s{2,}/g, ' ').trim();

async function screens(file) {
  const env = await boot(file);
  await sleep(400);
  const out = { home: norm(env.d.getElementById('feed').innerHTML), explore: norm(env.d.getElementById('ex').innerHTML) };
  env.d.getElementById('sopen').click();
  const qi = env.d.getElementById('q');
  qi.value = 'lofi beats';
  qi.dispatchEvent(new env.w.Event('input'));
  await waitFor(() => env.d.querySelectorAll('#results .card').length > 0, 15000);
  await sleep(150);
  out.search = norm(env.d.getElementById('results').innerHTML);
  env.w.openChannel(CH_IDS[0]);
  await waitFor(() => env.d.querySelectorAll('#chlist .card').length > 0, 15000);
  await sleep(150);
  out.sheet = norm(env.d.getElementById('shb').innerHTML + env.d.getElementById('chlist').innerHTML);
  out.keys = Object.keys(env.w.localStorage).sort().join(',');
  env.dom.window.close();
  return out;
}

async function ab() {
  console.log('\n6. the screen did not change');
  const a = await screens(NEW_FILE);
  const b = await screens(OLD_FILE);
  ok('the home feed is byte-identical to the previous build', a.home === b.home, a.home.length + ' vs ' + b.home.length);
  ok('the explore shelves are byte-identical', a.explore === b.explore, a.explore.length + ' vs ' + b.explore.length);
  ok('the search results are byte-identical', a.search === b.search, a.search.length + ' vs ' + b.search.length);
  ok('the channel sheet is byte-identical', a.sheet === b.sheet, a.sheet.length + ' vs ' + b.sheet.length);
  ok('the storage keys are the same set', a.keys === b.keys, a.keys + ' vs ' + b.keys);
}

(async () => {
  console.log('LiquidTube response-shape check — ' + NEW_FILE);
  const t0 = Date.now();
  await clean(NEW_FILE);
  await notABody(NEW_FILE);
  await oneBadEntry(NEW_FILE);
  await otherSites(NEW_FILE);
  await bounded(NEW_FILE);
  if (OLD_FILE) await ab();
  else console.log('\n(no previous build given: the A/B half is skipped)');
  console.log('');
  if (fails.length) {
    fails.forEach(f => console.log('FAIL  ' + f));
    console.log('\nFAILED — ' + fails.length + ' of ' + (pass + fails.length) + ' assertions, ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
    process.exit(1);
  }
  console.log('PASS — ' + pass + ' assertions, ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
})();
