#!/usr/bin/env node
/*
 * LiquidTube parallax-scale check — item 6.9.
 *
 * The claim of 6.9 is that the tilt layer's `scale(1.14)` — and with it a
 * composited layer per thumbnail — exists only while the tilt layer does. Before
 * the item the scale was declared on every thumbnail unconditionally and
 * cancelled for the parallax-off state by a second rule with `!important`, and
 * the `will-change` promise was keyed on `data-anim` alone, which the depth pass
 * sets on every scroll whether or not parallax is on. So a user who had turned
 * parallax off still paid for a transform on every picture and still had every
 * picture on screen promoted to hold a texture the frame would never touch.
 *
 * This asserts the whole item, in two halves.
 *
 * A. THE STYLESHEET, read as text:
 *  1. `scale(1.14)` is declared only under `html[data-parallax=on]`; there is no
 *     unscoped `.thumb img{transform:...}` left to cancel.
 *  2. No `!important` cancellation rule exists at all — `html[data-parallax=off]
 *     .thumb img` is gone, so there are no longer two rules to keep in step.
 *  3. The fade is unchanged: `[data-fd="1"]` keeps `opacity:1` and its `opacity`
 *     transition, and the tilt layer's `.12s` transform transition is added back
 *     beside it only while the tilt layer exists.
 *  4. The thumbnail's `will-change` is declared under
 *     `html[data-anim=on][data-parallax=on]`; the card's hint is still keyed on
 *     `data-anim` alone, because the depth pass moves cards in both states.
 *  5. The frame writes `scale(THUMB_TILT)`, not a second copy of the number, so
 *     the CSS and the picker's `1.14` factor cannot drift apart.
 *
 * B. THE APP, booted in jsdom with the API answered from fixtures:
 *  6. With parallax on, every picture on screen is scaled 1.14 — the inline
 *     transform the frame writes, or the stylesheet's own scale before it does.
 *  7. Turning parallax off through the Settings button (the real path: `save()`
 *     then `applyParallax()`) leaves every picture with `transform:none` and no
 *     inline transform at all.
 *  8. With parallax off, a scroll burst — which still sets `data-anim` from the
 *     depth pass — writes no transform to any picture and promotes none of them:
 *     `will-change` stays `auto` on every thumbnail while the cards are hinted.
 *  9. Turning it back on restores both, so nothing was lost, only suspended.
 * 10. With a second build given, the four cascade states (parallax on/off x
 *     `data-fd="1"`/none) are compared against it: the on states must be
 *     identical, and the off states must both draw an untransformed box with only
 *     the opacity fade left. That is the "no UI change" half of the rule.
 *
 * Runs on the same jsdom harness as tools/thumb-fade-check.js — no network, no
 * Chromium, no device.
 *
 *   npm i jsdom
 *   node tools/parallax-scale-check.js app/assets/index.html
 *   node tools/parallax-scale-check.js app/assets/index.html /tmp/old/index.html
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
  const env = { lines: [], errors: [] };
  const mockFetch = async u => {
    const j = apiBody(String(u));
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
      w.IntersectionObserver = class {
        constructor(cb, o) { this.cb = cb; this.opts = o || {}; this.targets = new Set(); }
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

/* One declaration block, by exact selector. The rule text is compact and several
   rules share a tail (`.thumb img[data-fd="1"]` is also the tail of the
   parallax-scoped rule), so the match is anchored to the start of a rule: the
   beginning of the sheet, the end of the previous block, or a newline. */
function rule(sheets, sel) {
  const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp('(?:^|[}\\n])[ \\t]*' + esc + '\\s*\\{([^}]*)\\}').exec(sheets);
  return m ? m[1] : null;
}
const allSheets = d => [...d.querySelectorAll('style')].map(s => s.textContent).join('\n');

/* The cascade as the engine would apply it, for one element state. A thumbnail
   is built here rather than taken from the feed: the frame writes an inline
   transform to every picture it owns, and an inline value would answer instead of
   the stylesheet. This element belongs to no card, so only the rules speak. */
function cascade(env, parallax, fd) {
  const { w, d } = env;
  const html = d.documentElement;
  const keep = { p: html.getAttribute('data-parallax'), a: html.getAttribute('data-anim') };
  html.setAttribute('data-parallax', parallax);
  html.setAttribute('data-anim', 'on');            /* the frame's promise, at its strongest */
  const box = d.createElement('div');
  box.className = 'thumb';
  const img = d.createElement('img');
  if (fd) img.setAttribute('data-fd', fd);
  box.appendChild(img);
  d.body.appendChild(box);
  const cs = w.getComputedStyle(img);
  const out = { transform: cs.transform, transition: cs.transition, willChange: cs.willChange };
  box.remove();
  if (keep.p === null) html.removeAttribute('data-parallax'); else html.setAttribute('data-parallax', keep.p);
  if (keep.a === null) html.removeAttribute('data-anim'); else html.setAttribute('data-anim', keep.a);
  return out;
}

const thumbs = env => [...env.d.querySelectorAll('.thumb img')];
const hinted = env => thumbs(env).filter(i => env.w.getComputedStyle(i).willChange !== 'auto').length;
const inline = env => thumbs(env).filter(i => i.style.transform).length;

/* Scroll the active page and let the frame run. The frame is keyed off the page's
   own scrollTop and the event, exactly as the scroll listener reads it. */
async function scroll(env, y) {
  const pg = env.d.querySelector('.page:not([inert])') || env.d.querySelector('.page');
  pg.scrollTop = y;
  pg.dispatchEvent(new env.w.Event('scroll'));
  await sleep(260);
}

/* Turn parallax off/on the way a user does: open Settings and press the button.
   That path is `save()` plus `applyParallax()`, which is the code that owns the
   attribute and the cleanup of the transforms already written. */
async function setParallax(env, on) {
  const { w, d } = env;
  w.sheet('Settings', w.settingsHTML(), 0);
  const btn = d.querySelector('[data-opt="parallax"]');
  const now = /Parallax: on$/.test(btn.textContent.trim());
  if (now !== on) btn.click();
  await sleep(60);
  w.closeAll();
  await sleep(60);
  return d.documentElement.getAttribute('data-parallax');
}

async function boot(file) {
  const env = open(file);
  const seen = await waitFor(() => env.lines.some(l => l.indexOf('lt-startup') === 0));
  ok('boot reached its timeline', seen);
  const n = await waitFor(() => env.d.querySelectorAll('#feed .card').length === 24);
  ok('the feed rendered 24 cards', n, String(env.d.querySelectorAll('#feed .card').length));
  await sleep(250);
  return env;
}

(async () => {
  const env = await boot(FILE);
  const sheets = allSheets(env.d);

  /* ---- A. the stylesheet ---- */
  {
    const base = rule(sheets, '.thumb img');
    const on = rule(sheets, 'html[data-parallax=on] .thumb img');
    ok('css: the tilt scale is declared under the parallax switch, not on every picture',
      !!on && /transform:scale\(1\.14\)/.test(on), on);
    ok('css: and there is no unscoped .thumb img{transform} left to cancel', !base || !/transform:scale/.test(base), base);

    ok('css: no !important cancellation rule survives for the picture',
      !/html\[data-parallax=off\] \.thumb img\s*\{/.test(sheets) &&
      !/transform:none!important/.test(rule(sheets, '.thumb img') || ''));

    const fade = rule(sheets, '.thumb img[data-fd="1"]');
    const fadeOn = rule(sheets, 'html[data-parallax=on] .thumb img[data-fd="1"]');
    ok('css: the fade is still opacity:1 with an opacity transition',
      !!fade && /opacity:1/.test(fade) && /transition:opacity \.26s ease/.test(fade), fade);
    ok('css: and the tilt layer\'s transform transition rides beside it only when the tilt layer exists',
      !!fadeOn && /transform \.12s linear/.test(fadeOn) && /opacity \.26s ease/.test(fadeOn), fadeOn);
    ok('css: the fade rule itself carries no transform transition', !!fade && !/transform \.12s/.test(fade), fade);

    ok('css: the picture is promoted only while both the frame and the tilt layer are running',
      !!rule(sheets, 'html[data-anim=on][data-parallax=on] .thumb img') &&
      /will-change:transform/.test(rule(sheets, 'html[data-anim=on][data-parallax=on] .thumb img')));
    ok('css: the card keeps its hint from the frame alone — the depth pass moves it in both states',
      !!rule(sheets, 'html[data-anim=on] .card') && !/\.thumb img/.test(rule(sheets, 'html[data-anim=on] .card')));

    /* The frame's own write, taken as the body of `thumbQueue`: the number lives
       in one place (`THUMB_TILT`) and the pass that draws the tilt layer reads
       it, so the CSS and the picker cannot drift from it. */
    const src = fs.readFileSync(FILE, 'utf8');
    const body = (/function thumbQueue\(k\)\{([\s\S]*?)\n\}/.exec(src) || ['', ''])[1];
    ok('code: the frame writes scale(THUMB_TILT), the same constant the picker uses',
      /scale\(\$\{THUMB_TILT\}\)/.test(body) && !/1\.14/.test(body), body.trim().split('\n').pop().trim());
  }

  /* ---- B. the app ---- */
  {
    ok('app: parallax is on at boot', env.d.documentElement.getAttribute('data-parallax') === 'on');
    const all = thumbs(env);
    ok('app: every picture on screen is drawn at the tilt scale',
      all.length >= 24 && all.every(i => /scale\(1\.14\)/.test(env.w.getComputedStyle(i).transform)),
      all.length + ' pictures');
    await scroll(env, 400);
    ok('app: and the frame writes the same scale inline', inline(env) > 0, inline(env) + ' written');
  }

  {
    ok('off: the setting takes the attribute off', (await setParallax(env, false)) === 'off');
    ok('off: every picture is an untransformed box',
      thumbs(env).every(i => env.w.getComputedStyle(i).transform === 'none'),
      thumbs(env).map(i => env.w.getComputedStyle(i).transform).filter(t => t !== 'none').slice(0, 3).join(' | '));
    ok('off: and the transforms the frame had already written are cleared',
      inline(env) === 0, inline(env) + ' left');

    await scroll(env, 700);
    ok('off: a scroll still runs the depth pass (the hint is up)', env.d.documentElement.getAttribute('data-anim') === 'on',
      String(env.d.documentElement.getAttribute('data-anim')));
    ok('off: but it writes no transform to any picture', inline(env) === 0, inline(env) + ' written');
    ok('off: and it promotes no picture — no texture held for a layer that never moves',
      hinted(env) === 0, hinted(env) + ' hinted');
    ok('off: the cards are still hinted, so the depth pass is untouched',
      [...env.d.querySelectorAll('.card')].filter(c => env.w.getComputedStyle(c).willChange !== 'auto').length > 0);
    /* A decoded picture is `data-fd="1"`, which is the rule the fade is written
       with. Nothing in this harness delivers an intersection, so the state is put
       on a real picture for the length of one read and taken back off. jsdom
       answers an *unset* `transition` with whatever it saw last, so the assertion
       is on the fade's own declaration and not on the whole string. */
    const faded = thumbs(env)[0];
    const was = faded.getAttribute('data-fd');
    faded.setAttribute('data-fd', '1');
    const tr = env.w.getComputedStyle(faded).transition;
    if (was === null) faded.removeAttribute('data-fd'); else faded.setAttribute('data-fd', was);
    ok('off: the fade is untouched — a decoded picture still carries the opacity transition',
      /opacity \.26s ease/.test(tr) && !/transform \.12s/.test(tr), tr);
  }

  {
    ok('on again: the switch comes back', (await setParallax(env, true)) === 'on');
    await scroll(env, 900);
    ok('on again: the frame writes the scale to the pictures once more',
      thumbs(env).some(i => /scale\(1\.14\)/.test(i.style.transform)), inline(env) + ' written');
    ok('on again: and promotes them while it does', hinted(env) > 0, hinted(env) + ' hinted');
  }

  /* ---- 10. the same rendering, state by state ---- */
  const table = e => ({
    'on / data-fd=1': cascade(e, 'on', '1'),
    'on / no data-fd': cascade(e, 'on', ''),
    'off / data-fd=1': cascade(e, 'off', '1'),
    'off / no data-fd': cascade(e, 'off', ''),
  });
  const mine = table(env);
  console.log('# cascade', JSON.stringify(mine, null, 1));

  ok('cascade: parallax on draws the picture at 1.14 with the tilt transition',
    mine['on / data-fd=1'].transform === 'scale(1.14)' &&
    /transform \.12s linear/.test(mine['on / data-fd=1'].transition) &&
    mine['on / no data-fd'].transform === 'scale(1.14)');
  ok('cascade: parallax off draws it untransformed with no transform transition',
    mine['off / data-fd=1'].transform === 'none' && mine['off / no data-fd'].transform === 'none' &&
    !/transform \.12s/.test(mine['off / data-fd=1'].transition) && !/transform \.12s/.test(mine['off / no data-fd'].transition));
  ok('cascade: the opacity fade survives in both states',
    /opacity \.26s ease/.test(mine['on / data-fd=1'].transition) && /opacity \.26s ease/.test(mine['off / data-fd=1'].transition));
  ok('cascade: a picture is promoted only with parallax on',
    mine['on / data-fd=1'].willChange === 'transform' && mine['off / data-fd=1'].willChange === 'auto' &&
    mine['off / no data-fd'].willChange === 'auto');

  if (!OLD) {
    console.log('skip  ui: no second build given (pass the previous index.html as argv[3] to diff)');
  } else {
    const old = table(await boot(OLD));
    ok('ui: the parallax-on rendering is identical to the build before the item',
      JSON.stringify([old['on / data-fd=1'], old['on / no data-fd']]) ===
      JSON.stringify([mine['on / data-fd=1'], mine['on / no data-fd']]),
      JSON.stringify(old['on / data-fd=1']) + ' vs ' + JSON.stringify(mine['on / data-fd=1']));
    ok('ui: and the parallax-off box is the same untransformed box the old !important rule drew',
      old['off / data-fd=1'].transform === mine['off / data-fd=1'].transform &&
      old['off / no data-fd'].transform === mine['off / no data-fd'].transform);
    ok('ui: the old build really did hold the promise off-state (this is the bug, measured)',
      old['off / data-fd=1'].willChange === 'transform', old['off / data-fd=1'].willChange);
  }

  console.log(fails ? '\n' + fails + ' check(s) failed' : '\nall checks passed');
  process.exit(fails ? 1 : 0);
})();
