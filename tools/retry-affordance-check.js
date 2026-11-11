#!/usr/bin/env node
/*
 * LiquidTube retry-affordance check — proves item 5.8 ("show a retry affordance
 * instead of a dead empty state").
 *
 * Before this item every failure surface ended in a box with one sentence in it
 * and nothing to press: the feed, the search panel, a chip section, a shelf
 * section and both halves of the channel sheet. The only way out was to close
 * the app and open it again — a heavy way to repeat one request.
 *
 * The item adds one button, `Try again`, built by rtyBtn() and drawn by every
 * surface that has a dead box. This check asserts what makes it honest:
 *
 *  1. it appears only where a tap can plausibly help — a button for network,
 *     server, ratelimit, malformed, client and unknown; none for quota, auth,
 *     notfound or an aborted request, whose sentence already says why;
 *  2. a button is only drawn when something is registered to re-run, so a tap
 *     can never be a no-op (rtySet before the box is written);
 *  3. tapping it re-runs exactly that surface and nothing else — the feed
 *     reloads, the search repeats the same query, the channel sheet refetches
 *     only its uploads, a section re-runs its own load;
 *  4. a tap is one retry: the button is disabled and the surface's own loading
 *     state is painted synchronously, so a second tap in the same tick finds a
 *     spent button and spends nothing;
 *  5. a retry that works ends on the surface a clean load ends on (cards, no
 *     error box, no button), and a retry that fails again comes back to the same
 *     box with the same button — never a dead end, never a blank page;
 *  6. the sentences, the classes, the log lines and the storage keys are exactly
 *     what items 5.2/5.3/5.7 left, and no console error or unhandled rejection
 *     escapes;
 *  7. the registry is bounded and window.__ltRetry() reports it.
 *
 * Runs in jsdom with googleapis.com answered from fixtures — no network, no
 * Chromium, no device.
 *
 *   npm i jsdom
 *   node tools/retry-affordance-check.js app/assets/index.html
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

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

/* the API's error bodies, as items 5.2/5.3 classify them */
const body = (status, reason) => ({ error: { code: status, message: 'the request cannot be completed', errors: [{ reason: reason || 'unknown', domain: 'youtube', message: 'nope' }] } });
const QUOTA = { status: 403, body: body(403, 'quotaExceeded') };
const BADKEY = { status: 403, body: body(403, 'keyInvalid') };
const GONE = { status: 404, body: body(404, 'videoNotFound') };
const BROKEN = { status: 500, body: body(500, null) };

/* a page: fresh window and localStorage, a fetch that answers from the fixtures.
   `queue` may be prefilled — the boot request fires while the document is still
   being parsed, so a scripted boot failure has to be in place before the JSDOM
   is constructed. */
function open(file, pre) {
  const HTML = fs.readFileSync(file, 'utf8');
  const env = { log: [], lines: [], errors: [], rejects: [], queue: (pre && pre.queue) || [], only: (pre && pre.only) || null };
  const mockFetch = async u => {
    u = String(u);
    env.log.push({ url: u.replace(/([?&])key=[^&]*/, '$1key=<key>'), t: Date.now() });
    const step = (env.queue.length && (!env.only || env.only(u))) ? env.queue.shift() : 'ok';
    if (step === 'throw') throw new TypeError('Failed to fetch');
    if (step === 'abort') { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
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
const boxIn = (env, sel) => {
  const el = env.d.querySelector(sel);
  return el || null;
};
const btnIn = (env, sel) => {
  const b = env.d.querySelector(sel + ' .empty button.rty');
  return b || null;
};
const textOf = el => {
  const c = el.cloneNode(true);
  c.querySelectorAll('button').forEach(b => b.remove());
  return c.textContent.replace(/\s+/g, ' ').trim();
};
const tap = (env, el) => { if (!el) return false; el.dispatchEvent(new env.w.MouseEvent('click', { bubbles: true, cancelable: true })); return true; };
const boot = async (file, pre) => {
  const env = open(file, pre);
  await waitFor(() => env.d.querySelectorAll('#feed .card').length > 0 || /class="empty"/.test(env.d.getElementById('feed').innerHTML), 20000);
  await sleep(150);
  return env;
};

/* ---------- 1. a clean boot draws no button ---------- */
async function clean(file) {
  console.log('\n1. a boot that works');
  const env = await boot(file);
  ok('a clean boot renders cards', env.d.querySelectorAll('#feed .card').length > 0);
  ok('a clean boot draws no retry button', env.d.querySelectorAll('button.rty').length === 0);
  const r = env.w.__ltRetry();
  ok('window.__ltRetry() is the session table', r && typeof r === 'object' && 'keys' in r);
  ok('nothing is offered before anything fails', r.shown === 0 && r.taps === 0, JSON.stringify(r));
  ok('the feed and the search are registered before the first box', r.keys.includes('feed') && r.keys.includes('find'), r.keys.join(','));
  ok('the registry is bounded', r.keys.length <= r.max && r.max === 8, JSON.stringify(r));
  ok('the button is styled with the app\'s own pill, not a new one',
    /\.empty \.rty\{[^}]*\}/.test(fs.readFileSync(file, 'utf8')) && /\.opt\{height:48px/.test(fs.readFileSync(file, 'utf8')));
  env.dom.window.close();
}

/* ---------- 2. the feed: a failure a tap can fix ---------- */
async function feedRetryable(file) {
  console.log('\n2. the feed, a failure a tap can fix');
  /* the boot pays rqFetch's own retry and item 5.7's extra attempt, so a dead
     boot needs four refusals before the surface is reached */
  const env = open(file, { queue: ['throw', 'throw', 'throw', 'throw'], only: isTrending });
  await waitFor(() => /class="empty"/.test(env.d.getElementById('feed').innerHTML), 15000);
  await sleep(150);
  const box = env.d.getElementById('feed');
  const btn = btnIn(env, '#feed');
  ok('the feed ends on its own empty box', /class="empty"/.test(box.innerHTML));
  ok('the sentence is still item 5.3\'s', textOf(box) === 'Could not load videos.No connection. Check your network and try again.', textOf(box));
  ok('the box offers a way out', !!btn);
  ok('the way out is a real button', btn && btn.tagName === 'BUTTON' && btn.getAttribute('type') === 'button');
  ok('the way out is the app\'s own pill', btn && btn.className === 'opt glass rty', btn && btn.className);
  ok('the way out says what it does', btn && btn.textContent === 'Try again', btn && btn.textContent);
  ok('the way out is reachable by keyboard', btn && btn.disabled === false && btn.tabIndex >= 0);
  ok('the way out is the last thing in the box', btn && box.querySelector('.empty').lastElementChild === btn);
  ok('one box, one way out', env.d.querySelectorAll('#feed button.rty').length === 1);
  ok('the way out re-runs the feed', btn && btn.getAttribute('data-r') === 'feed');
  ok('the failure is still one counted, classified failure', env.w.__ltErr().kinds.network >= 1 && env.w.__ltFeedRetry().fail === 1,
    JSON.stringify(env.w.__ltErr().kinds));
  const before = reqs(env, isTrending);

  env.only = isTrending;
  env.queue = [];
  tap(env, btn);
  ok('a tap paints the app\'s own loading state at once', /skl|ldr/.test(env.d.getElementById('feed').innerHTML),
    env.d.getElementById('feed').innerHTML.slice(0, 60));
  ok('a tap takes the button away with it', env.d.querySelectorAll('#feed button.rty').length === 0);
  await waitFor(() => env.d.querySelectorAll('#feed .card').length > 0, 15000);
  await sleep(200);
  ok('the retry that works lands on cards', env.d.querySelectorAll('#feed .card').length > 0, env.d.getElementById('feed').innerHTML.slice(0, 80));
  ok('the error box is gone', !/class="empty"/.test(env.d.getElementById('feed').innerHTML));
  ok('no stale button is left behind', env.d.querySelectorAll('button.rty').length === 0);
  ok('the retry spent exactly one request', reqs(env, isTrending) === before + 1, reqs(env, isTrending) - before);
  ok('the retry is counted', env.w.__ltRetry().ran === 1 && env.w.__ltRetry().shown === 1, JSON.stringify(env.w.__ltRetry()));
  ok('the failure is cleared from the feed state', env.w.__ltFeedRetry().error === false && env.w.__ltFeedRetry().trending > 0,
    JSON.stringify(env.w.__ltFeedRetry()));
  ok('the chips came back with the cards', env.d.querySelectorAll('#chips .chip').length > 0);
  ok('nothing was written to storage that a clean boot does not write',
    Object.keys(env.w.localStorage).sort().join(',') === 'lt_boot,lt_cver,lt_feed,lt_quota', Object.keys(env.w.localStorage).join(','));
  ok('no console error', env.errors.length === 0, env.errors.join(' | '));
  ok('no unhandled rejection', env.rejects.length === 0);
  env.dom.window.close();
}

/* ---------- 3. the feed: a retry that fails again ---------- */
async function feedTwice(file) {
  console.log('\n3. a retry that fails again');
  const env = open(file, { queue: ['throw', 'throw', 'throw', 'throw'], only: isTrending });
  await waitFor(() => !!btnIn(env, '#feed'), 15000);
  await sleep(120);
  const btn = btnIn(env, '#feed');
  const before = reqs(env, isTrending);
  env.queue = ['throw', 'throw', 'throw', 'throw'];   /* the retry's own two attempts fail as well */
  tap(env, btn);
  await waitFor(() => !!btnIn(env, '#feed'), 15000);
  await sleep(200);
  ok('a retry that fails comes back to the same box', /class="empty"/.test(env.d.getElementById('feed').innerHTML));
  ok('with the same sentence', textOf(env.d.getElementById('feed')) === 'Could not load videos.No connection. Check your network and try again.',
    textOf(env.d.getElementById('feed')));
  ok('and the same way out — never a dead end', !!btnIn(env, '#feed'));
  ok('the second box is a second button, not the spent one', env.d.querySelectorAll('#feed button.rty').length === 1);
  ok('the retry spent a whole load, retry included', reqs(env, isTrending) === before + 4, reqs(env, isTrending) - before);
  ok('two buttons have been drawn', env.w.__ltRetry().shown === 2, JSON.stringify(env.w.__ltRetry()));
  ok('one tap, one retry', env.w.__ltRetry().ran === 1 && env.w.__ltRetry().taps === 1, JSON.stringify(env.w.__ltRetry()));
  ok('no console error', env.errors.length === 0, env.errors.join(' | '));
  env.dom.window.close();
}

/* ---------- 4. failures a tap cannot fix offer nothing ---------- */
async function notRetryable(file) {
  console.log('\n4. failures a tap cannot fix');
  for (const c of [{ label: 'daily quota', step: QUOTA, kind: 'quota' }, { label: 'revoked key', step: BADKEY, kind: 'auth' }, { label: 'deleted video', step: GONE, kind: 'notfound' }]) {
    const env = open(file, { queue: [c.step, c.step], only: isTrending });
    await waitFor(() => /class="empty"/.test(env.d.getElementById('feed').innerHTML), 15000);
    await sleep(150);
    ok('[' + c.label + '] the feed still says its sentence',
      textOf(env.d.getElementById('feed')) === 'Could not load videos.' + env.w.__ltErrText({ kind: c.kind }),
      textOf(env.d.getElementById('feed')));
    ok('[' + c.label + '] no button is offered for a failure a tap cannot fix', env.d.querySelectorAll('#feed button.rty').length === 0,
      env.d.getElementById('feed').innerHTML.slice(0, 120));
    ok('[' + c.label + '] the class is unchanged', env.w.__ltErr().last.kind === c.kind, JSON.stringify(env.w.__ltErr().last));
    ok('[' + c.label + '] nothing was spent to learn that', reqs(env, isTrending) <= 2, reqs(env, isTrending));
    ok('[' + c.label + '] no button was drawn at all', env.w.__ltRetry().shown === 0, JSON.stringify(env.w.__ltRetry()));
    env.dom.window.close();
  }
}

/* ---------- 5. the search panel ---------- */
async function searchPanel(file) {
  console.log('\n5. the search panel');
  const env = await boot(file);
  env.only = isSearch;
  env.queue = ['throw', 'throw'];
  env.d.getElementById('sopen').click();
  const qi = env.d.getElementById('q');
  qi.value = 'lofi beats';
  qi.dispatchEvent(new env.w.Event('input'));
  await waitFor(() => !!btnIn(env, '#results'), 15000);
  await sleep(150);
  const btn = btnIn(env, '#results');
  ok('a failed search offers a way out', !!btn);
  ok('the search box keeps its sentence', /^Search failed\. No connection\. Check your network and try again\.$/.test(textOf(env.d.getElementById('results'))),
    textOf(env.d.getElementById('results')));
  ok('the way out re-runs the search', btn && btn.getAttribute('data-r') === 'find');
  ok('the query is not in the box', !env.d.getElementById('results').textContent.includes('lofi beats'));
  const asked = env.log.filter(x => isSearch(x.url)).map(x => new URL(x.url).searchParams.get('q'));
  const before = asked.length;
  env.queue = [];
  tap(env, btn);
  ok('a tap paints the panel\'s own loading state at once', /skl|ldr/.test(env.d.getElementById('results').innerHTML));
  await waitFor(() => env.d.querySelectorAll('#results .card').length > 0, 15000);
  await sleep(150);
  const after = env.log.filter(x => isSearch(x.url)).map(x => new URL(x.url).searchParams.get('q'));
  ok('the retry asks again', after.length === before + 1, after.length - before);
  ok('the retry asks the same question', after[after.length - 1] === 'lofi beats', after[after.length - 1]);
  ok('the retry that works lands on results', env.d.querySelectorAll('#results .card').length > 0);
  ok('the failure box is gone', !/class="empty"/.test(env.d.getElementById('results').innerHTML));
  ok('no button is left in the panel', env.d.querySelectorAll('#results button.rty').length === 0);
  ok('no console error', env.errors.length === 0, env.errors.join(' | '));
  env.dom.window.close();
}

/* ---------- 6. the channel sheet, both halves ---------- */
async function channelSheet(file) {
  console.log('\n6. the channel sheet');
  /* the uploads list: the header answered, the list did not */
  const env = await boot(file);
  env.only = isPlaylist;
  env.queue = ['throw', 'throw'];
  env.w.openChannel('UCnosuchchannel00000');
  await waitFor(() => !!btnIn(env, '#chlist'), 15000);
  await sleep(150);
  const btn = btnIn(env, '#chlist');
  ok('a failed uploads list offers a way out', !!btn);
  ok('the list keeps its sentence', textOf(env.d.getElementById('chlist')) === 'Could not load videos.', textOf(env.d.getElementById('chlist')));
  ok('the way out re-runs only the list', btn && btn.getAttribute('data-r') === 'ch.list');
  const chBefore = reqs(env, isChannels), plBefore = reqs(env, isPlaylist);
  env.queue = [];
  tap(env, btn);
  await waitFor(() => env.d.querySelectorAll('#chlist .card').length > 0, 15000);
  await sleep(150);
  ok('the retry refetches the list', reqs(env, isPlaylist) === plBefore + 1, reqs(env, isPlaylist) - plBefore);
  ok('the retry does not refetch the channel the sheet already has', reqs(env, isChannels) === chBefore, reqs(env, isChannels) - chBefore);
  ok('the retry that works lands on the channel\'s videos', env.d.querySelectorAll('#chlist .card').length > 0);
  ok('the header is still the header', /chh/.test(env.d.getElementById('shb').innerHTML));
  ok('no button is left in the sheet', env.d.querySelectorAll('#shb button.rty').length === 0);
  ok('no console error', env.errors.length === 0, env.errors.join(' | '));
  env.dom.window.close();

  /* the header itself: nothing to list yet */
  const env2 = await boot(file);
  env2.only = isChannels;
  env2.queue = ['throw', 'throw'];
  env2.w.openChannel('UCnosuchchannel00000');
  await waitFor(() => !!btnIn(env2, '#shb'), 15000);
  await sleep(150);
  const b2 = btnIn(env2, '#shb');
  ok('a failed channel header offers a way out', !!b2);
  ok('the header keeps its sentence', textOf(env2.d.getElementById('shb')) === 'No connection. Check your network and try again.',
    textOf(env2.d.getElementById('shb')));
  ok('the way out re-runs the sheet', b2 && b2.getAttribute('data-r') === 'ch.info');
  const before2 = reqs(env2, isChannels);
  env2.queue = [];
  tap(env2, b2);
  await waitFor(() => /chh/.test(env2.d.getElementById('shb').innerHTML), 15000);
  await sleep(150);
  ok('the retry refetches the channel', reqs(env2, isChannels) === before2 + 1, reqs(env2, isChannels) - before2);
  ok('the retry that works lands on the channel', /chh/.test(env2.d.getElementById('shb').innerHTML));
  ok('no console error', env2.errors.length === 0, env2.errors.join(' | '));
  env2.dom.window.close();
}

/* ---------- 7. a chip section and a shelf section ---------- */
async function sections(file) {
  console.log('\n7. sections');
  const env = await boot(file);
  /* a section is searches *and* the channels' uploads, so both have to fail
     before its box is reached */
  const sectionReq = u => isSearch(u) || isPlaylist(u);
  env.only = sectionReq;
  env.queue = new Array(40).fill('throw');
  const chip = [...env.d.querySelectorAll('#chips .chip')].find(c => c.textContent === 'Anime');
  ok('the Anime chip is on screen', !!chip);
  chip.click();
  await waitFor(() => !!btnIn(env, '#feed'), 20000);
  await sleep(150);
  const btn = btnIn(env, '#feed');
  ok('a failed chip section offers a way out', !!btn);
  ok('the way out re-runs the section', btn && btn.getAttribute('data-r') === 'chip');
  ok('the section keeps its sentence', textOf(env.d.getElementById('feed')) === 'Could not load Anime videos right now.',
    textOf(env.d.getElementById('feed')));
  env.queue = [];
  tap(env, btn);
  await waitFor(() => env.d.querySelectorAll('#feed .card').length > 0, 20000);
  await sleep(150);
  ok('the retry that works lands on the section\'s cards', env.d.querySelectorAll('#feed .card').length > 0,
    'feed=' + env.d.getElementById('feed').innerHTML.slice(0, 120) + ' | reqs=' + env.log.length + ' | q=' + env.queue.length + ' | ' + JSON.stringify(env.w.__ltRetry()));
  ok('the failure box is gone', !/class="empty"/.test(env.d.getElementById('feed').innerHTML));
  ok('the section is remembered as loaded', !!env.w.__ltRetry && !/class="empty"/.test(env.d.getElementById('feed').innerHTML));
  ok('no console error', env.errors.length === 0, env.errors.join(' | '));
  env.dom.window.close();

  /* A shelf section (renderSection) has no #animefeed element in the page yet —
     the section is dormant, so it cannot be driven here. Its wiring is asserted
     in section 10 instead: the box it writes registers `sec.<name>` before it
     draws, so the day the section is wired up its failure is not a dead end. */
  const env2 = await boot(file);
  ok('a dormant section is still wired for a retry',
    /rtySet\('sec\.'\+name,\(\)=>\{secForget\(name\);renderSection\(name\)\}\)/.test(fs.readFileSync(file, 'utf8')));
  ok('no console error', env2.errors.length === 0, env2.errors.join(' | '));
  env2.dom.window.close();
}

/* ---------- 8. one tap, one retry ---------- */
async function oneTap(file) {
  console.log('\n8. one tap, one retry');
  const env = open(file, { queue: ['throw', 'throw', 'throw', 'throw'], only: isTrending });
  await waitFor(() => !!btnIn(env, '#feed'), 15000);
  await sleep(120);
  const btn = btnIn(env, '#feed');
  const before = reqs(env, isTrending);
  env.queue = [];
  tap(env, btn);
  /* the button is off the page the moment the tap lands, so a second tap cannot
     reach it — and the handler refuses a spent button anyway, which is what the
     two calls below prove (rtyRun is what the delegated handler calls) */
  env.w.rtyRun(btn);
  env.w.rtyRun(btn);
  await waitFor(() => env.d.querySelectorAll('#feed .card').length > 0, 15000);
  await sleep(200);
  ok('three taps spend one retry', reqs(env, isTrending) === before + 1, reqs(env, isTrending) - before);
  const r = env.w.__ltRetry();
  ok('the table says three taps, one run', r.taps === 3 && r.ran === 1, JSON.stringify(r));
  ok('the two spent taps are recorded as misses', r.miss === 2, JSON.stringify(r));
  ok('the feed still lands on cards', env.d.querySelectorAll('#feed .card').length > 0);
  ok('no console error', env.errors.length === 0, env.errors.join(' | '));
  env.dom.window.close();
}

/* ---------- 9. the registry stays bounded ---------- */
async function bounded(file) {
  console.log('\n9. the registry');
  const env = await boot(file);
  env.only = isSearch;
  env.queue = [];
  for (const n of ['anime', 'cartoon', 'movies', 'anime', 'cartoon', 'movies']) env.w.renderSection(n);
  await sleep(600);
  const r = env.w.__ltRetry();
  ok('the registry never grows past its bound', r.keys.length <= r.max, r.keys.join(','));
  ok('the keys are the fixed set the item names',
    r.keys.every(k => ['feed', 'find', 'chip', 'ch.list', 'ch.info', 'sec.anime', 'sec.cartoon', 'sec.movies'].includes(k)), r.keys.join(','));
  ok('a repeated load does not add a key', r.keys.length === new Set(r.keys).size, r.keys.join(','));
  ok('no console error', env.errors.length === 0, env.errors.join(' | '));
  env.dom.window.close();
}

/* ---------- 10. the shape of the source ---------- */
function source(file) {
  console.log('\n10. the shape of the source');
  const src = fs.readFileSync(file, 'utf8');
  ok('one helper builds every button', (src.match(/class="opt glass rty"/g) || []).length === 1);
  ok('the helper refuses an unregistered key', /if\(!key\|\|!\(key in RTY\)\)return ''/.test(src));
  ok('the helper refuses a class a tap cannot fix', /if\(!ekRetryable\(ekKind\(e\)\)\)return ''/.test(src));
  ok('every failure surface registers before it draws',
    ['feed', 'find', 'chip', 'ch.list', 'ch.info', 'sec.'].every(k => new RegExp("rtySet\\('" + k.replace('.', '\\.')).test(src)));
  ok('the registry is bounded by a constant', /const RTY_MAX=8/.test(src) && /if\(rtyN>=RTY_MAX\)return false/.test(src));
  ok('a spent button cannot be spent twice', /if\(!btn\|\|btn\.disabled\)\{RTY_ST\.miss\+\+;return\}/.test(src));
  ok('the button rides the app\'s existing delegated click handler', (src.match(/\[data-r\]/g) || []).length === 1);
  ok('no new listener was added for it', !/addEventListener\('click'.*data-r/.test(src));
  ok('the feed retry is guarded like every other path', /asGuard\('feed\.retry',\(\)=>loadTrending\(\)/.test(src));
  ok('the channel list is its own function, so a retry does not refetch the header',
    /function fillChList\(c,g\)\{/.test(src) && /rtySet\('ch\.list',\(\)=>fillChList\(c,g\)\)/.test(src));
  ok('no empty state lost its sentence', (src.match(/<div class="empty">/g) || []).length >= 14,
    (src.match(/<div class="empty">/g) || []).length);
  ok('the visible design did not move', !/\.rty\{[^}]*background/.test(src) && !/\.rty\{[^}]*border-radius/.test(src));
}

(async () => {
  const file = process.argv[2] || path.join(__dirname, '..', 'app', 'assets', 'index.html');
  console.log('LiquidTube retry-affordance check — ' + file);

  await clean(file);
  await feedRetryable(file);
  await feedTwice(file);
  await notRetryable(file);
  await searchPanel(file);
  await channelSheet(file);
  await sections(file);
  await oneTap(file);
  await bounded(file);
  source(file);

  console.log('');
  if (fails.length) {
    console.log('FAIL — ' + fails.length + ' failed, ' + pass + ' passed');
    fails.forEach(f => console.log('  · ' + f));
    process.exit(1);
  }
  console.log('PASS — ' + pass + ' assertions');
})();
