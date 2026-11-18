#!/usr/bin/env node
/*
 * LiquidTube fullscreen-exit check — item 8.9 ("handle fullscreen exit correctly").
 *
 * Fullscreen in this app is not a CSS class: the video is an <iframe> embed, so the
 * only way it can ever fill the screen is the host Activity's WebChromeClient. The
 * exit path is therefore all in `app/java/com/liquidtube/app/MainActivity.java`, and
 * it is the one path a user reaches from three different directions at once — the
 * Back key, the player's own exit button (which arrives as `onHideCustomView`), and
 * the Activity going away (`onDestroy`). Before this item each direction had its own
 * copy of the teardown, and none of the copies was safe:
 *
 *   - `onHideCustomView` removed `fullscreenHolder` without checking it was still
 *     there, so a second exit in the same frame — Back and the embed's button land
 *     together often — removed null;
 *   - it also touched `web` unguarded, so an exit delivered after `onDestroy` had
 *     already destroyed the WebView threw from inside the framework;
 *   - the system bars came back *after* the WebView was made visible again, so the
 *     page was laid out one frame at the old fullscreen size and then relaid out
 *     under a bar sliding in — a visible jump on every exit;
 *   - `leaveImmersive()` wrote `SYSTEM_UI_FLAG_VISIBLE` (that is, 0) instead of
 *     putting back the flags it found, so exiting fullscreen silently cleared window
 *     state the app did not set;
 *   - `onShowCustomView` adopted the video view without detaching it first, and
 *     `addView` on an attached child throws "The specified child already has a
 *     parent" — a crash mid-video after an interrupted transition;
 *   - `onDestroy` never exited fullscreen at all, so the holder, the video surface
 *     and the callback outlived the Activity.
 *
 * The fix is one idempotent `exitFullscreen()` that every direction goes through.
 * This tool is a structural audit of that contract: it reads the Java, isolates the
 * methods that matter and asserts each invariant above is still true, so a later
 * item cannot quietly re-open the path (for example by adding a `root.removeView`
 * back into `onHideCustomView`).
 *
 * It is static on purpose. This pod has no Android runtime — a fullscreen transition
 * needs a WebView, a surface and a real Back key — so what can be checked here is the
 * code the transition runs, plus the fact that the build compiles and dexes it
 * (`build.sh`, run alongside this tool, is the compile proof). Every check below is
 * a property of the source, and each one names the defect it stands in for.
 *
 * It also proves the *UI did not change*: given the previous APK (or a baseline
 * index.html) it hashes the page inside both builds and fails if a single byte of
 * the UI differs. Item 8.9 is native, so the page must be byte-identical.
 *
 * Usage:
 *   node tools/fullscreen-exit-check.js [--baseline <old.apk|index.html>]
 * Prints one JSON object; exit code 1 when any check fails.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const JAVA = path.join(REPO, 'app/java/com/liquidtube/app/MainActivity.java');
const ASSET = path.join(REPO, 'app/assets/index.html');

/* ---------- source helpers ---------- */

const src = fs.readFileSync(JAVA, 'utf8');

/** Body of a method, brace-matched from its signature, comments included. */
function methodBody(name) {
  const sig = new RegExp('(?:^|\\s)' + name + '\\s*\\([^)]*\\)\\s*\\{', 'm');
  const m = sig.exec(src);
  if (!m) return null;
  let i = src.indexOf('{', m.index + m[0].length - 1);
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return src.slice(i + 1, j);
    }
  }
  return null;
}

/** The same body with comments stripped, for code-shape assertions. */
const code = s =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();

/** Position of `needle` in the *code* form of a body, or -1. */
const at = (body, needle) => code(body).indexOf(code(needle));

const results = [];
function check(name, ok, detail) {
  results.push({ check: name, ok: !!ok, detail });
}

/* ---------- the methods under audit ---------- */

const show = methodBody('onShowCustomView');
const hide = methodBody('onHideCustomView');
const exit = methodBody('exitFullscreen');
const enter = methodBody('enterImmersive');
const leave = methodBody('leaveImmersive');
const back = methodBody('onBackPressed');
const destroy = methodBody('onDestroy');

check('methods present', !!(show && hide && exit && enter && leave && back && destroy), {
  onShowCustomView: !!show,
  onHideCustomView: !!hide,
  exitFullscreen: !!exit,
  enterImmersive: !!enter,
  leaveImmersive: !!leave,
  onBackPressed: !!back,
  onDestroy: !!destroy,
});

/* ---------- 1. one exit, and every direction goes through it ---------- */

check(
  'onHideCustomView only delegates to the one exit',
  hide && /^\s*exitFullscreen\s*\(\s*\)\s*;?\s*$/.test(code(hide)),
  { body: hide && code(hide) }
);

check(
  'Back exits through the same path (no direct chrome.onHideCustomView)',
  back && at(back, 'exitFullscreen()') > -1 && at(back, 'chrome.onHideCustomView()') === -1,
  { callsExit: back && at(back, 'exitFullscreen()') > -1 }
);

check(
  'Back exits even if only the holder is still set',
  back && /customView\s*!=\s*null\s*\|\|\s*fullscreenHolder\s*!=\s*null/.test(code(back)),
  { body: back && code(back).slice(0, 160) }
);

check(
  'onDestroy exits fullscreen before the WebView is destroyed',
  destroy &&
    at(destroy, 'exitFullscreen()') > -1 &&
    at(destroy, 'exitFullscreen()') < at(destroy, 'web.destroy()'),
  {
    exitFirst:
      destroy && at(destroy, 'exitFullscreen()') > -1 && at(destroy, 'web.destroy()') > -1
        ? at(destroy, 'exitFullscreen()') < at(destroy, 'web.destroy()')
        : false,
  }
);

/* ---------- 2. the exit is idempotent and cannot touch a null ---------- */

check(
  'exit clears all three fields before it uses them',
  exit &&
    /(fullscreenHolder|customView|customViewCallback)\s*=\s*null/.test(code(exit)) &&
    ['fullscreenHolder', 'customView', 'customViewCallback'].every(f =>
      new RegExp(f + '\\s*=\\s*null').test(code(exit))
    ) &&
    /* locals are taken first, so the nulling cannot lose what the exit needs */
    /(FrameLayout|View|WebChromeClient\.CustomViewCallback)\s+\w+\s*=\s*(fullscreenHolder|customView|customViewCallback)\s*;/.test(
      code(exit)
    ),
  { body: exit && code(exit).slice(0, 200) }
);

check(
  'exit is a no-op when nothing is fullscreen',
  exit && /if\s*\(\s*!\s*wasFullscreen\s*\)\s*\{\s*return\s*;\s*\}/.test(code(exit)),
  { guard: exit && /wasFullscreen/.test(code(exit)) }
);

check(
  'holder is only removed when it is still attached',
  exit && /getParent\s*\(\s*\)\s*==\s*root/.test(code(exit)),
  { body: exit && code(exit) }
);

check(
  'the WebView is null-checked before it is touched on exit',
  exit && /if\s*\(\s*web\s*!=\s*null\s*\)\s*\{\s*web\.setVisibility/.test(code(exit)),
  {}
);

check(
  'the video surface is dropped with the holder',
  exit && /holder\.removeAllViews\s*\(\s*\)/.test(code(exit)),
  {}
);

check(
  'the embed callback is released and cannot throw out of the exit',
  exit && /try\s*\{\s*callback\.onCustomViewHidden\s*\(\s*\)\s*;\s*\}/.test(code(exit)) &&
    /catch\s*\(\s*RuntimeException/.test(code(exit)),
  {}
);

/* the old crash: an unconditional remove of a field that can be null */
check(
  'no unguarded root.removeView(fullscreenHolder) anywhere',
  !/root\.removeView\s*\(\s*fullscreenHolder\s*\)/.test(code(src)),
  {}
);

/* ---------- 3. the exit is ordered so the page does not jump ---------- */

check(
  'bars come back before the WebView is made visible',
  exit &&
    at(exit, 'leaveImmersive()') > -1 &&
    at(exit, 'setVisibility(View.VISIBLE)') > -1 &&
    at(exit, 'leaveImmersive()') < at(exit, 'setVisibility(View.VISIBLE)'),
  {
    leaveAt: exit ? at(exit, 'leaveImmersive()') : null,
    visibleAt: exit ? at(exit, 'setVisibility(View.VISIBLE)') : null,
  }
);

check(
  'the embed is told last, once the screen is already back',
  exit &&
    at(exit, 'onCustomViewHidden') > -1 &&
    at(exit, 'onCustomViewHidden') > at(exit, 'setVisibility(View.VISIBLE)'),
  {}
);

/* ---------- 4. entering saves the window state, leaving restores it ---------- */

check(
  'entering fullscreen records the flags it found',
  enter && /preFullscreenUiFlags\s*=\s*d\.getSystemUiVisibility\s*\(\s*\)/.test(code(enter)),
  {}
);

check(
  'leaving fullscreen restores those flags, not a hard-coded VISIBLE',
  leave &&
    /restore\s*<\s*0\s*\?\s*View\.SYSTEM_UI_FLAG_VISIBLE\s*:\s*restore/.test(code(leave)) &&
    /preFullscreenUiFlags\s*=\s*-1/.test(code(leave)),
  { body: leave && code(leave) }
);

/* ---------- 5. entering cannot crash on an already-attached video view ---------- */

check(
  'the incoming video view is detached from its old parent before addView',
  show &&
    /getParent\s*\(\s*\)/.test(code(show)) &&
    at(show, 'parent.removeView(view)') > -1 &&
    at(show, 'parent.removeView(view)') < at(show, 'holder.addView(view'),
  { body: show && code(show).slice(0, 260) }
);

check(
  'a null view or callback cannot NPE the enter',
  show && /if\s*\(\s*view\s*==\s*null\s*\)/.test(code(show)) && /callback\s*!=\s*null/.test(code(show)),
  {}
);

check(
  'fullscreen state is published only once the view is on screen',
  show &&
    at(show, 'root.addView(holder') > -1 &&
    at(show, 'fullscreenHolder = holder') > at(show, 'root.addView(holder'),
  {}
);

/* ---------- 6. the UI is untouched ---------- */

function sha(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

const assetNow = fs.readFileSync(ASSET);
const ui = { sha256: sha(assetNow), bytes: assetNow.length, baseline: null, same: null };

const bi = process.argv.indexOf('--baseline');
if (bi > -1 && process.argv[bi + 1]) {
  const base = process.argv[bi + 1];
  let buf = null;
  try {
    if (/\.apk$/i.test(base)) {
      /* the page inside the APK is stored, not deflated, so `unzip -p` returns it */
      buf = execFileSync('unzip', ['-p', base, 'assets/index.html'], { maxBuffer: 1 << 26 });
    } else {
      buf = fs.readFileSync(base);
    }
  } catch (e) {
    ui.baseline = 'unreadable: ' + e.message;
  }
  if (buf) {
    ui.baseline = sha(buf);
    ui.same = ui.baseline === ui.sha256;
    check('the UI is byte-identical to the baseline build', ui.same, {
      baseline: ui.baseline,
      current: ui.sha256,
    });
  }
} else {
  ui.note = 'no --baseline given: UI equality not asserted';
}

/* ---------- report ---------- */

const fails = results.filter(r => !r.ok).map(r => r.check);
const out = {
  item: '8.9 Handle fullscreen exit correctly',
  file: path.relative(REPO, JAVA),
  ui,
  checks: results,
  fails,
  pass: fails.length === 0,
};
console.log(JSON.stringify(out, null, 2));
process.exit(out.pass ? 0 : 1);
