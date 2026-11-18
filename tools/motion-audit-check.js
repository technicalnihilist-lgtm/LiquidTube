#!/usr/bin/env node
/*
 * LiquidTube motion audit — item 9.1.
 *
 * Every duration in the app now comes from one scale, declared once in the
 * critical sheet as `--t-<ms>` custom properties. This tool is what keeps it
 * that way: it reads `app/assets/index.html`, finds every `transition`,
 * `transition-duration`, `animation` and `animation-duration` declaration in
 * both style blocks and in inline `style=""` attributes, and checks four
 * things.
 *
 *  1. `literals` — a duration written as a raw time instead of a token. The
 *     only literal allowed is `0s` (a zero-length duration is not motion).
 *  2. `undefined` — a `var(--t-…)` used somewhere but not declared in the
 *     scale, which silently resolves to nothing and drops the whole shorthand.
 *  3. `unused` — a step declared in the scale that nothing names any more. A
 *     scale that only grows is not a scale.
 *  4. `misnamed` — a token whose name and value disagree (`--t-250:300ms`),
 *     which makes the scale impossible to read at a glance.
 *
 * It also prints the scale and a histogram of how many declarations use each
 * step, so the next audit can see the shape of the motion system.
 *
 * Delays are out of scope on purpose: a stagger delay (`.05s`, `.12s`, `.24s`)
 * is choreography, not duration. A delay that must equal a duration uses the
 * same token, and is checked here like any other value.
 *
 * Usage:
 *   node tools/motion-audit-check.js [path/to/index.html]
 * Prints one JSON object. Exit code 0 when the audit is clean, 1 when it is not.
 */
const fs = require('fs');
const path = require('path');

const FILE = process.argv[2] || path.join(__dirname, '..', 'app', 'assets', 'index.html');
const src = fs.readFileSync(FILE, 'utf8');

const lineOf = idx => src.slice(0, idx).split('\n').length;

/* ---------- the scale ---------- */

const scale = new Map();   // name -> ms
const misnamed = [];
const TOKEN_DECL = /--t-([a-z0-9]+)\s*:\s*([\d.]+)(ms|s)\b/g;
let m;
while ((m = TOKEN_DECL.exec(src))) {
  const ms = Math.round(parseFloat(m[2]) * (m[3] === 's' ? 1000 : 1));
  if (String(ms) !== m[1]) {
    misnamed.push({ token: '--t-' + m[1], value: m[2] + m[3], line: lineOf(m.index) });
  }
  scale.set('--t-' + m[1], ms);
}

/* ---------- the declarations ---------- */

/* A declaration is `prop:value` inside CSS. Values stop at `;`, `}` or a
   newline, and an inline `style="…"` ends at the quote. Comments are stripped
   first so a sentence about a transition is not mistaken for one. */
const stripped = src.replace(/\/\*[\s\S]*?\*\//g, c => c.replace(/[^\n]/g, ' '));

const DECL = /(?<![\w-])(transition|animation)(-duration)?\s*:\s*([^;{}\n"]*)/g;
const TIME = /(\d*\.?\d+)(ms|s)\b/g;

const literals = [];
const used = new Map();       // token -> count
const undefinedTokens = [];
const declarations = [];

const splitTop = v => {
  const out = [];
  let depth = 0, cur = '';
  for (const ch of v) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out;
};

while ((m = DECL.exec(stripped))) {
  const prop = m[1] + (m[2] || '');
  const value = m[3].trim();
  if (!value || value === 'none' || value === 'inherit' || value === 'initial') continue;
  const line = lineOf(m.index);
  declarations.push({ prop, value, line });

  /* Durations and delays, structurally: an item is a list of space-separated
     components, and the first two components that are a time (a `var(--t-…)`
     token or a raw time) are the duration and then the delay. The duration must
     be a token; the delay may be either. */
  for (const item of splitTop(value)) {
    const parts = item.trim().split(/\s+/).filter(Boolean);
    let slot = 0;
    for (const part of parts) {
      const tok = /^var\((--t-[a-z0-9]+)\)$/.exec(part);
      TIME.lastIndex = 0;
      const lit = /^(\d*\.?\d+)(ms|s)$/.exec(part);
      if (!tok && !lit) continue;
      slot++;
      if (slot > 2) break;
      if (tok) {
        if (!scale.has(tok[1]) && !undefinedTokens.some(x => x.token === tok[1])) {
          undefinedTokens.push({ token: tok[1], line });
        }
        used.set(tok[1], (used.get(tok[1]) || 0) + 1);
        continue;
      }
      const ms = Math.round(parseFloat(lit[1]) * (lit[2] === 's' ? 1000 : 1));
      if (slot === 1 && ms > 0) {
        literals.push({ line, prop, duration: part, item: item.trim() });
      }
    }
  }
}

const unused = [...scale.keys()].filter(t => !used.has(t));

const histogram = [...used.entries()]
  .map(([token, count]) => ({ token, ms: scale.get(token), count }))
  .sort((a, b) => a.ms - b.ms);

const report = {
  file: path.relative(path.join(__dirname, '..'), FILE),
  scale: [...scale.entries()].map(([token, ms]) => ({ token, ms })).sort((a, b) => a.ms - b.ms),
  declarations: declarations.length,
  histogram,
  literals,
  undefined: undefinedTokens,
  unused,
  misnamed,
  ok: literals.length === 0 && undefinedTokens.length === 0 && unused.length === 0 && misnamed.length === 0,
};

console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);
