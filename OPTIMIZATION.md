# LiquidTube — 20-day optimisation schedule

**Rule for every run:** the UI does not change. No redesign, no new tabs, no visual changes.
Only: performance, fluidity, memory, correctness, resilience, accessibility and code health.
Every run must: pick the next unchecked item → implement → test → build → bump versionCode/versionName → push → tick it here.

Dates: **1 Nov 2026 → 20 Nov 2026**, 10 items a day (one item per scheduled run).

---

## Day 1 — Startup & first paint
- [x] 1.1 Measure cold start to first paint and record the number in the log below
- [x] 1.2 Inline critical CSS, defer the rest so the shell paints before styles finish
- [x] 1.3 Replace the 1100 ms artificial boot delay with a real "first frame ready" signal
- [x] 1.4 Render skeletons for the feed before the API call returns
- [x] 1.5 Parse the API key and constants once at boot, not per call
- [x] 1.6 Defer non-critical listeners (gyro, scroll) until after first paint
- [x] 1.7 Preconnect to googleapis.com and i.ytimg.com at boot
- [x] 1.8 Avoid layout thrash on boot: read/write DOM in separate passes
- [x] 1.9 Cache the last feed in localStorage and paint it instantly on reopen
- [x] 1.10 Log a startup timeline so regressions are visible

## Day 2 — Network & caching
- [x] 2.1 Add a request cache with TTL for every API call (not just shelves)
- [x] 2.2 Deduplicate in-flight requests to the same URL
- [x] 2.3 Add exponential backoff + single retry for 5xx and network errors
- [x] 2.4 Respect HTTP cache headers where the API sends them
- [x] 2.5 Batch `loadChannels` calls into groups of 50 consistently
- [x] 2.6 Skip `loadDurations` when every item already has a duration
- [x] 2.7 Abort stale requests when the user switches tabs
- [ ] 2.8 Compress the persisted state before writing to localStorage
- [ ] 2.9 Add a quota meter so search usage is visible internally
- [ ] 2.10 Log slow requests (>800 ms) with their endpoint

## Day 3 — Scroll performance
- [ ] 3.1 Throttle scroll work to one rAF and skip when nothing changed
- [ ] 3.2 Stop the depth/parallax loops when a page is not visible
- [ ] 3.3 Use `content-visibility:auto` on off-screen cards
- [ ] 3.4 Reduce per-frame work to transforms only (no layout reads in the loop)
- [ ] 3.5 Cache element rects per frame instead of per card
- [ ] 3.6 Batch style writes into a single pass
- [ ] 3.7 Disable parallax automatically while a fling is in progress
- [ ] 3.8 Add `will-change` only to elements that actually animate
- [ ] 3.9 Verify 60 fps on a 4x CPU-throttled profile
- [ ] 3.10 Remove the now-dead scroll handlers

## Day 4 — Memory & leaks
- [ ] 4.1 Audit every `setInterval` and clear it when unused
- [ ] 4.2 Bound the `V` video map so it cannot grow without limit
- [ ] 4.3 Remove listeners on teardown of pages
- [ ] 4.4 Null out iframe src on player close to free the media pipeline
- [ ] 4.5 Cap the history/liked/later arrays
- [ ] 4.6 Drop cached channel objects for channels no longer shown
- [ ] 4.7 Verify no detached DOM nodes after 20 tab switches
- [ ] 4.8 Check heap growth over a 10-minute scroll session
- [ ] 4.9 Clear the shelf/section caches on version change
- [ ] 4.10 Document the memory budget in this file

## Day 5 — Error handling
- [ ] 5.1 Wrap every async path in try/catch with a user-safe fallback
- [ ] 5.2 Distinguish quota, network, auth and not-found errors
- [ ] 5.3 Never render a raw API message into the UI
- [ ] 5.4 Add a global `error` + `unhandledrejection` handler that logs and recovers
- [ ] 5.5 Guard every `querySelector` result before use
- [ ] 5.6 Recover from a corrupted localStorage state without losing data
- [ ] 5.7 Retry the feed once automatically on failure
- [ ] 5.8 Show a retry affordance instead of a dead empty state
- [ ] 5.9 Validate every API response shape before mapping it
- [ ] 5.10 Add a self-check that runs on boot in debug mode

## Day 6 — Images
- [ ] 6.1 Lazy-load thumbnails with IntersectionObserver instead of `loading=lazy`
- [ ] 6.2 Decode thumbnails off the main thread (`decoding=async`)
- [ ] 6.3 Pick the smallest thumbnail that fits the card
- [ ] 6.4 Cache resolved thumbnail URLs per video id
- [ ] 6.5 Avoid re-requesting a failed thumbnail on every render
- [ ] 6.6 Add `srcset`/density handling for 2x screens
- [ ] 6.7 Fade images in only when decoded
- [ ] 6.8 Reserve space so images never shift layout
- [ ] 6.9 Drop the 1.14 scale when parallax is off (saves a compositing layer)
- [ ] 6.10 Measure image bytes per session

## Day 7 — Search & filters
- [ ] 7.1 Debounce search input (300 ms) and cancel superseded queries
- [ ] 7.2 Keep the last query and results when reopening search
- [ ] 7.3 Cache search results for 30 minutes
- [ ] 7.4 Filter results locally before rendering (no wasted DOM)
- [ ] 7.5 Fix chip switching when the feed is still loading
- [ ] 7.6 Keep the scroll position per chip
- [ ] 7.7 Show skeletons instead of a flash of empty content
- [ ] 7.8 Normalise Hindi/Devanagari queries
- [ ] 7.9 Handle empty results without a layout jump
- [ ] 7.10 Log query latency

## Day 8 — Player
- [ ] 8.1 Destroy and recreate the iframe only when the video actually changes
- [ ] 8.2 Pause playback when the sheet closes
- [ ] 8.3 Restore position when reopening the same video
- [ ] 8.4 Handle iframe load failures with a visible retry
- [ ] 8.5 Respect the loop setting through the jsapi channel only
- [ ] 8.6 Keep the player above other layers (z-order audit)
- [ ] 8.7 Avoid double `autoplay=1` when reusing the iframe
- [ ] 8.8 Preconnect to youtube-nocookie.com on first play
- [ ] 8.9 Handle fullscreen exit correctly
- [ ] 8.10 Free the player when the app goes to background

## Day 9 — Animation & fluidity
- [ ] 9.1 Audit every transition duration for consistency
- [ ] 9.2 Use transform/opacity only (no layout-triggering properties)
- [ ] 9.3 Respect `prefers-reduced-motion`
- [ ] 9.4 Drop the depth loop to 30 fps when the device is slow
- [ ] 9.5 Remove animation jank on sheet open/close
- [ ] 9.6 Make the lens follow the finger with no lag
- [ ] 9.7 Avoid animating box-shadow (expensive)
- [ ] 9.8 Stop animations when the tab is hidden
- [ ] 9.9 Verify no dropped frames during tab slides
- [ ] 9.10 Document the animation tokens

## Day 10 — Data & quota
- [ ] 10.1 Cut API units per cold start (measure, then reduce)
- [ ] 10.2 Prefer `playlistItems` over `search` everywhere possible
- [ ] 10.3 Persist every cache with a timestamp and validate on read
- [ ] 10.4 Add a 12-hour refresh policy for all cached lists
- [ ] 10.5 Skip refetching when the cached data is fresh
- [ ] 10.6 Merge duplicates across sections
- [ ] 10.7 Handle a revoked/invalid API key gracefully
- [ ] 10.8 Log units spent per session
- [ ] 10.9 Never call the API on a hidden tab
- [ ] 10.10 Document the quota budget

## Day 11 — Offline & degraded mode
- [ ] 11.1 Serve the last cached feed when offline
- [ ] 11.2 Detect offline/online and update the UI state internally
- [ ] 11.3 Queue nothing that cannot succeed offline
- [ ] 11.4 Show cached thumbnails from memory when offline
- [ ] 11.5 Fail fast instead of waiting 30 s on a dead network
- [ ] 11.6 Add a retry-on-reconnect hook
- [ ] 11.7 Keep navigation fully usable offline
- [ ] 11.8 Do not clear caches on transient failures
- [ ] 11.9 Test airplane-mode behaviour end to end
- [ ] 11.10 Document offline behaviour

## Day 12 — Accessibility
- [ ] 12.1 Every icon button gets an aria-label
- [ ] 12.2 Focus order follows visual order
- [ ] 12.3 Contrast check on all text over glass
- [ ] 12.4 Respect system font scaling
- [ ] 12.5 Announce loading/error states to screen readers
- [ ] 12.6 Make touch targets at least 44 px
- [ ] 12.7 Support keyboard navigation on tabs
- [ ] 12.8 Do not trap focus in sheets
- [ ] 12.9 Reduced-motion support for every animation
- [ ] 12.10 Audit with TalkBack

## Day 13 — Storage & state
- [ ] 13.1 Version the persisted state schema
- [ ] 13.2 Migrate old state without data loss
- [ ] 13.3 Guard against localStorage quota errors
- [ ] 13.4 Compress large arrays before saving
- [ ] 13.5 Debounce writes (no write per keystroke)
- [ ] 13.6 Add a reset-to-defaults path
- [ ] 13.7 Validate types on read
- [ ] 13.8 Never store tokens or personal data
- [ ] 13.9 Cap total stored size
- [ ] 13.10 Document the state shape

## Day 14 — Battery & lifecycle
- [ ] 14.1 Stop the depth loop when the app is backgrounded
- [ ] 14.2 Pause the player on `onPause`
- [ ] 14.3 Unregister gyro when not visible
- [ ] 14.4 Batch wake-ups into a single timer
- [ ] 14.5 Avoid `setInterval` for animation
- [ ] 14.6 Measure battery drain over 10 minutes of scrolling
- [ ] 14.7 Reduce work on low-power mode
- [ ] 14.8 Handle configuration changes without reload
- [ ] 14.9 Save scroll position on pause
- [ ] 14.10 Document lifecycle behaviour

## Day 15 — Long lists
- [ ] 15.1 Cap the rendered cards per page
- [ ] 15.2 Add incremental rendering (render 12, then more on scroll)
- [ ] 15.3 Recycle cards instead of rebuilding
- [ ] 15.4 Keep scroll position stable when appending
- [ ] 15.5 Avoid re-rendering the whole list on a small change
- [ ] 15.6 Diff lists before replacing innerHTML
- [ ] 15.7 Test a 500-item channel
- [ ] 15.8 Measure render time for 100 cards
- [ ] 15.9 Drop the depth loop cost for large lists
- [ ] 15.10 Document list limits

## Day 16 — Layout stability
- [ ] 16.1 No layout shift when images load
- [ ] 16.2 Fixed heights for skeletons that match the real card
- [ ] 16.3 Avoid font swap shifts
- [ ] 16.4 Keep the dock from moving between pages
- [ ] 16.5 Stable scrollbars
- [ ] 16.6 Test long Hindi titles and wrapping
- [ ] 16.7 Test 320 px width
- [ ] 16.8 Test tablet and full-screen layouts
- [ ] 16.9 No horizontal overflow anywhere
- [ ] 16.10 Document the breakpoints

## Day 17 — WebView hardening
- [ ] 17.1 Verify the host allowlist covers every needed origin
- [ ] 17.2 Keep HTTPS-only and mixed-content blocking
- [ ] 17.3 Disable file access where not needed
- [ ] 17.4 Handle `onRenderProcessGone` without crashing
- [ ] 17.5 Handle back button inside the WebView
- [ ] 17.6 Guard against deep links
- [ ] 17.7 Verify no `addJavascriptInterface` exposure
- [ ] 17.8 Test on Android 5, 8, 12, 14
- [ ] 17.9 Review the manifest permissions
- [ ] 17.10 Document the security posture

## Day 18 — Diagnostics
- [ ] 18.1 Add an internal debug panel (hidden, off by default)
- [ ] 18.2 Log timings for every major action
- [ ] 18.3 Count API units per session
- [ ] 18.4 Record the last 20 errors in memory
- [ ] 18.5 Add a "copy diagnostics" action
- [ ] 18.6 Never log personal data
- [ ] 18.7 Keep the log size bounded
- [ ] 18.8 Add a version/build stamp visible in debug
- [ ] 18.9 Compare metrics against Day 1
- [ ] 18.10 Document the metrics

## Day 19 — Edge cases
- [ ] 19.1 No network at first launch
- [ ] 19.2 Empty subscriptions
- [ ] 19.3 Channel with no uploads
- [ ] 19.4 Deleted or private videos in a cached list
- [ ] 19.5 Very long channel names and handles
- [ ] 19.6 Emoji and RTL titles
- [ ] 19.7 Rapid tab switching
- [ ] 19.8 Double-tap on cards
- [ ] 19.9 Rotation during playback
- [ ] 19.10 Low storage and low memory devices

## Day 20 — Audit
- [ ] 20.1 Full regression pass on 3 screen sizes
- [ ] 20.2 Re-measure startup against Day 1
- [ ] 20.3 Re-measure scroll fps
- [ ] 20.4 Re-measure memory growth
- [ ] 20.5 Re-measure API units per session
- [ ] 20.6 Verify every fix from Day 1 is still in place
- [ ] 20.7 Trim dead code and unused CSS
- [ ] 20.8 Update the README with the numbers
- [ ] 20.9 Tag a final release with the summary
- [ ] 20.10 Write the next 20-day plan

---

## Startup baseline — Day 1, item 1.1

Measured on 1 Nov 2026 with `tools/startup-bench.js`, which is committed so every
later item (and 20.2) can be compared against the same number.

**What is measured.** The whole UI is one HTML file loaded from the APK assets into
the WebView, so the startup cost that can actually be moved is the web layer: parse
the shell → paint it → fetch the feed → paint the feed. The bench serves
`index.html` from the same `https://liquidtube.local/index.html` origin the WebView
uses, mocks `googleapis.com` with fixed fixtures (150 ms round trip) and every image
as a 1x1 PNG, and starts from an empty cache and an empty `localStorage`. It is
deterministic and needs no device. Native WebView construction (a few hundred ms on
a real phone) is **not** included — this is the web layer only.

**Milestones**, ms from navigation start:

| profile | first paint / FCP | DOMContentLoaded | shell visible (`.ready`) | first feed card |
|---|---|---|---|---|
| 1x, bench host (session A) | 1760 | 1524 | 2212 | 2212 |
| 1x, bench host (session B) | 2364 | 2348 | 3328 | 3328 |
| 4x CPU throttle (A) | 2636 | 4444 | 6000 | 6000 |
| 4x CPU throttle (B) | 3184 | 5327 | 6224 | 6224 |
| 6x CPU throttle (A) | 4168 | 6972 | 8452 | 8452 |
| 6x CPU throttle (B) | 4204 | 6795 | 9548 | 9548 |

Median of 5 cold runs per profile, two independent sessions. Run-to-run spread on
this shared host is about ±20%, so the 4x column is the one to quote: a mid-range
Android phone sits around there.

**Baseline numbers to beat.**

- Cold start → first paint: **2.6–3.2 s** at 4x CPU throttle (1.8–2.4 s unthrottled).
- Shell actually visible to the user: **6.0–6.2 s** at 4x.
- First feed card: the same instant as the shell, in every run.

**What the numbers say.**

1. `shell` and `feed` are identical in all six runs. The splash covers the whole
   app until the data arrives, so the first thing the user sees that is not a
   splash is gated on the network, not on rendering. Items 1.3 and 1.4 target this.
2. The gap from `DCL` to `shell` at 4x is 1.5–1.6 s, and it is entirely the
   `loadTrending → loadDurations → loadChannels` chain plus the fixed 1100 ms gate
   in `reveal()`. At 1x the gate is not even binding — the three sequential API
   calls cost more than the delay it was meant to hide.
3. First paint lags `DCL` by 0.2–0.9 s. That is the cost of parsing and styling the
   single 61 KB HTML file with its `backdrop-filter` glass layers before anything
   can be rastered. Item 1.2 targets this.

## Startup timeline — how to read it

Every launch writes one line, once the boot has settled. In the WebView it goes to
logcat (`adb logcat -s LiquidTube`); in a browser or the bench it is
`console.info` and `window.__ltTimeline`.

```
lt-startup shell=249 reveal=250 paint=1574 req=251 data=1959 feed=1983 feedpaint=3510 input=2412 total=3510 prev=0 warm=0 err=0
```

All values are ms from navigation start, cumulative.

| field | meaning |
|---|---|
| `shell` | the skeleton shell is in the DOM (stage 1 done) |
| `cache` | the cached feed was painted before the first frame (only on a warm start) |
| `reveal` | the splash starts leaving |
| `paint` | that first frame was actually painted |
| `req` | the first API call left the app |
| `data` | the feed came back |
| `feed` | the cards are in the DOM |
| `feedpaint` | the frame carrying the cards was painted — the end of the boot |
| `input` | the deferred listeners (gyro, scroll, tilt) are attached; absent if it landed after `feedpaint` |
| `total` | the largest milestone above, i.e. when the boot finished |
| `prev` / `vs_prev` | the previous launch's `total` and the difference: positive is slower |
| `warm` | 1 when this launch painted the cached feed |
| `err` | 1 when the feed came back as an error |
| `partial` | 1 when the 12 s deadline wrote the line before the boot finished |

The array that feeds it is capped at 16 marks (a boot emits 9), the line is ~150
bytes, and the only thing written to storage is `lt_boot` (`{v:1,t,at}`, ~45 bytes)
so the next launch can print `prev`/`vs_prev`.

---

## Log

| Date | Item | Result |
|---|---|---|
| — | schedule created | 200 items queued, 10 per day |
| 1 Nov 2026 | 1.1 Measure cold start to first paint | Baseline recorded above: cold start → first paint **2.6–3.2 s at 4x CPU throttle** (1.8–2.4 s unthrottled), shell visible at 6.0–6.2 s, first feed card at the same instant as the shell. Added `tools/startup-bench.js` (puppeteer-core, dev-only, not shipped in the APK) so every later item is compared against the same measurement. No UI change. v7.7 (versionCode 32) |
| 1 Nov 2026 | 1.2 Inline critical CSS, defer the rest | Split the single 21 KB sheet into **10.4 KB critical** (variables, resets, glass, page/top bar/logo, chips, dock/tabs/lens, splash, loader, skeletons, `img` reveal, reduced-motion, layout switch, `.ready` rules) and **10.6 KB deferred** (cards, carousels, `#search`, `#scrim`, player and sheet, `#toast`, results, settings rows, per-item animation delays). The deferred sheet is kept as an inert `<script type="text/css">` data block at the end of `<body>` — outside the CSSOM — and applied in the first idle slot after `DOMContentLoaded`, with `reveal()` as the hard fallback and a 3 s timer as the last resort, so the splash and shell never wait on it. Verified equivalent: the applied sheets expose the same 220 rules, and 45 sampled elements (shell, card, thumb, meta, dock, lens, tab, search, sheet, player, toast, scrim, settings — light and dark) have identical computed styles; 30 cards, 10 chips, no console errors. Startup A/B with the `tools/startup-bench.js` fixtures, both builds interleaved in one browser (8–12 reps each): first paint **2836 ms vs 3192 ms at 4x CPU throttle (−11 %)** in the best run, all other runs inside the ±6 % noise floor measured by running one build against itself; shell unchanged. No UI change. v7.8 (versionCode 33) |
| 1 Nov 2026 | 1.3 Real "first frame ready" signal instead of the 1100 ms boot delay | The fixed `Math.max(0,1100-(now-T0))` wait after `loadTrending` is gone. Boot is now: feed resolves → `mark('lt:data')` → deferred sheet applied → `paintShell()` (chips, feed, explore, subs) → `reveal()`, all in one task so the first frame the user sees already carries the content, then `firstFrame()` (two rAFs, a 400 ms timer and a hidden-document check as fallbacks) resolves once that frame has actually been painted and records `lt:paint`. The splash therefore leaves when the content behind it exists, not when a timer expires; the 7 s hard stop, and the same reveal for the error paths, are kept, and `reveal()` is now idempotent. Added `lt:data` / `lt:reveal` / `lt:paint` performance marks and `window.__ltFirstFrame` for the later timeline and diagnostics items. `tools/startup-bench.js` now samples its milestones from both a frame callback and an 8 ms timer (a starved rAF on a throttled run could previously report a milestone as a missing 0) and prints the app's own marks. Measured with the bench, old and new interleaved, median of 3: with the default 150 ms mocked round trip the shell is unchanged at 1x (1288 → 1285 ms) and at 4x CPU throttle (3692 → 3687 ms) — the old floor was not binding there; with a 40 ms round trip, where the floor was binding, first shell drops from **1466 → 1102 ms at 1x (−25 %)**. Failure paths reveal immediately instead of idling: API 500 1461 → 1262 ms, offline 1300 → 1021 ms, and a 3 s-per-call feed still falls back to the 7 s hard stop. Verified: 24 cards, 10 chips, deferred sheet applied before the first paint (card margin 14px, thumb 193 px), no console errors, and a pixel diff of the settled shell against the previous build shows 27 differing pixels at a maximum channel delta of 3/255 (antialiasing only) — no UI change. `build.sh` now takes versionCode and versionName from `AndroidManifest.xml` instead of hardcoding 1 / 1.0, so the APK matches the manifest it ships with. v7.9 (versionCode 34) |
| 1 Nov 2026 | 1.4 Render skeletons for the feed before the API call returns | Boot is now two stages. Stage 1 needs no network: `paintSkeleton()` writes the loading state the app already ships — the chip row (`All`, `Anime`, `Cartoon`, `Movies`, i.e. the four chips that are always first, so the visible ones never move when the rest arrive), the three `#feed` skeletons behind the loader dots, the carousel placeholders in Explore (now shared with `renderExplore()` through `shelfSkeleton()`) and skeletons in Subscriptions — then `reveal()` leaves the splash on the first frame the app can actually paint, and `firstFrame()` reports it. It starts no request of its own, so the API traffic is exactly what it was. Stage 2 is unchanged: `loadTrending` lands, `paintShell()` swaps the skeletons for cards in place. Because the deferred sheet is what positions the overlays, `#search/#pl/#sheet/#scrim/#toast` painted as bare flow text in those first frames — a critical `:not(.on)` rule (absolute, opacity 0, no pointer events) hides them until the deferred sheet lands, and they are only ever shown by `.on`, so nothing visible changes. Tapping a chip while the feed is still in flight now keeps the skeletons instead of flashing "Nothing in All right now". Timeline marks are now `lt:shell → lt:reveal → lt:paint` (the skeleton frame) `→ lt:data → lt:feed → lt:feedpaint`. Measured with the `tools/startup-bench.js` fixtures, old and new interleaved in one browser (6 pairs at 4x CPU throttle, 6 at 1x, 150 ms mocked round trip): shell visible **4572 → 3064 ms at 4x (−33 %)** and **1469 → 719 ms at 1x (−51 %)**; first feed card unchanged within the ±20 % host noise (4686 vs 4572 ms at 4x, 1313 vs 1469 at 1x) because it is still gated on the same `loadTrending → loadDurations → loadChannels` chain, which Day 2 targets. A 6x-throttle probe (4–5 runs per build) confirmed the shimmer of the off-screen skeletons is not what costs frames there: removing all `.skl` animation moved the median by ~50 ms. Verified: at `.ready` the feed holds 3 skeletons, 0 cards and 0 completed API responses; after data, 24 cards, 10 chips, 18 Explore cards, 6 Subscriptions cards, no skeletons left; the settled shell is pixel-identical to the previous build (25 differing pixels, max channel delta 2/255); tabs, search (20 results), player, library and settings all exercised with no console errors; the 500 and offline paths still reveal (485 / 206 ms) with the same error state. No UI change. v7.10 (versionCode 35) |
| 1 Nov 2026 | 1.5 Parse the API key and constants once at boot, not per call | Every literal that used to be rebuilt on each call now exists once, in a boot-time block next to `APIKEY`: the API, thumbnail and embed URL prefixes, the escape table and its regex, the five entity-decoder patterns, the duration / shorts / private-video / quota / YouTube-origin / Hindi patterns, the chips base list, the prebuilt Explore play icon and the `prefers-color-scheme` query. `yt()` appends the key to a fresh `URLSearchParams` instead of merging a params object per call; `cname()` and the channel sheet's joined date build their `Intl` formatter once, lazily on first use and memoised per country code, instead of constructing one on every call; `applyGlass()` and `toggleTheme()` share one media query through `isDark()`. Added `tools/render-snapshot.js`, which boots a build against fixed fixtures, drives feed, chips, Explore, Subscriptions, search, player, channel sheet, library and settings, and prints normalised markup plus A/B timings, so this and every later refactor can be diffed instead of eyeballed. Measured in Chromium (the WebView's engine family) with animations off, old and new interleaved in one page, median of 7, three independent runs: region name **18–23 µs → ~0 µs per call**, channel-sheet date **407–416 µs → 2.0–2.4 µs per call**, Explore play icon **0.45 µs → 0 per card**; `esc`/`dec` stay inside noise (1.05–1.5 vs 0.95–1.39 µs, 0.88–1.0 vs 0.74–0.97 µs). Verified: all seven snapshot surfaces are byte-identical to the previous build across three runs (24 cards, 10 chips, 3 shelves, 6 subscription avatars, 20 search results, player iframe and src, full channel sheet, library, settings), both from the working tree and from the committed asset; the API request log is identical, so the key and parameters go out exactly as before; `esc`, `dec`, `cname`, the date formatter, the play icon and `iso2sec` agree with the old implementations character for character over a corpus including astral emoji, entities, quotes and empty strings; `tools/startup-bench.js` puts startup inside host noise (4x CPU: shell 3252 vs 3345 ms, first feed card 4418 vs 4559 ms, median of 3). A single-pass `esc` was tried and dropped: it measured faster in a blank page but slower inside the app, so the regex form stays. No UI change. v7.11 (versionCode 36). The APK was built and verified (169,526 bytes, `assets/index.html` md5-matches the source), but it could not be committed in this run: the session's GitHub access is read-only for git (push 403) and for binary content through the API, so the tracked `LiquidTube.apk` is still the v7.10 build and needs a rebuild plus commit from a session with write access. |
| 2 Nov 2026 | 1.6 Defer non-critical listeners (gyro, scroll) until after first paint | Seven listeners that cannot affect anything the user sees before the first frame are now attached from `bindInput()`, which runs in the first idle slot after `firstFrame()` resolves: `deviceorientation`, the capture-phase `scroll` that drives the parallax and depth passes, the `resize` that re-drives them, and the four document-level `pointer*` listeners behind the card tilt. The anonymous gyro handler became a named `onOrient` so it can be referenced, and the attach is guarded by an `inputBound` flag and recorded as a new `lt:input` mark (`lt:paint → lt:input`). Everything that is needed on the first paint or the first interaction stays bound at parse time and is unchanged: `click`, the image `load`/`error` capture pair, the player's `message` bridge, the no-op `touchstart`, the tab strip's own pointer listeners and the layout `resize`. Why those seven: on a real phone subscribing to `deviceorientation` starts the sensor pipeline delivering samples at ~60 Hz, a single scroll event runs a full pass that does `querySelectorAll` plus a `getBoundingClientRect` per thumb and per card, and a document-level `pointermove` fires for every touch — all of it previously able to land while the splash was still up. Verified the set is exactly equivalent: instrumenting `EventTarget.prototype.addEventListener` and diffing old against new gives the identical 12 registrations (`click`, `message`, `touchstart` and the tab strip's four plus layout `resize` still before `lt:paint`; the seven above now all after it, `lt:input` at 1784 ms against `lt:paint` at 782 ms). Behaviour after the deferral checked in a real browser: scroll still drives the thumbnail parallax (`translate3d(0%, 3.67%, 0) scale(1.14)`) and the page background offset, still applies the depth transform to cards (`translateZ(-17.3px) scale(0.971)`), a synthetic `deviceorientation` still drifts the dock, `pointerdown`/`pointermove` still add `.tilt` and write the rotate transform and `pointerup` still clears it, and `resize` still re-drives the pass — every value matching the previous build to the last decimal. If the page had already been scrolled in the gap the depth state is synced once on attach, guarded on a non-zero `scrollTop` so the at-rest frame is untouched (with nothing scrolled no scroll event fired before either). `tools/render-snapshot.js` reports the boot, search, player, channel-sheet, library and settings markup plus the API request log **byte-identical** to the previous build; only its micro-benchmark timings moved, which is host noise. End-to-end startup is inside noise and I am not claiming a win from it: the committed bench scattered 1904–2415 ms shell at 4x for the old build against 1890–3731 ms for the new one across interleaved runs, and a tighter two-build harness revealed a ~560 ms *position* effect (the second page in each pair was slower whichever build it was) that swamps any real difference. What the change removes is real but small on a desktop Chromium: one full parallax+depth pass on the 30-card bench feed measures 0.6 ms median, 34 ms at p95 when it forces the first layout, at 4x CPU throttle, and the seven registrations themselves round to 0 ms (p95 0.1 ms). The gain is on the device, where the sensor subscription and the pre-paint scroll work are what it takes off the critical path. Also rebuilt `LiquidTube.apk` and committed it this run, which catches up the v7.11 build that the previous run could not push. No UI change. v7.12 (versionCode 37) |
| 2 Nov 2026 | 1.7 Preconnect to googleapis.com and i.ytimg.com at boot | The head now carries four resource hints, above the `<style>` so the preload scanner sees them before the 21 KB sheet and the 61 KB of markup are parsed: `dns-prefetch` for both hosts first (for engines that skip preconnect), then `<link rel="preconnect" href="https://www.googleapis.com" crossorigin>` — a CORS socket, because the feed is a `fetch` with the default `same-origin` credentials, i.e. anonymous cross-origin — and `<link rel="preconnect" href="https://i.ytimg.com">`, a plain socket, because thumbnails are `<img>` requests. Neither hint sends a request, so the app's traffic is unchanged and neither can reach the WebView's `shouldInterceptRequest`; both hosts are already on `ALLOWED_HOSTS`. Added `tools/preconnect-bench.js`, because `tools/startup-bench.js` mocks every request inside the browser and therefore cannot see connection setup at all: it serves the page and both remote origins over real HTTPS on real sockets, puts a TCP shim in front of each remote origin that holds the socket for a configurable delay before forwarding (simulating a cold DNS lookup plus RTT), gives every run a fresh browser so a pooled socket cannot hide the cost, and serves `Timing-Allow-Origin` so the page can read the connect/request breakdown. With a 150 ms simulated connection and 150 ms API think time at 4x CPU throttle, the current build pays **213 ms (API) and 268 ms (first thumbnail)** of connection setup on the critical path — that is the cost this item targets. **What I could not show, and am not claiming:** the sandbox's Chrome for Testing 153 (headless) does not act on `rel=preconnect` at all. A minimal page that preconnects to a local TLS origin and then does nothing never opens a socket: checked with and without puppeteer's `--disable-background-networking`, with and without `crossorigin`, from a `.local` origin and from a plain one, page visible and focused, and with the hint pointing at a bare `127.0.0.1:port` so no resolver rule was involved. So the 213/268 ms above is what a cold start costs, not a measured saving: in this environment old and new are indistinguishable (`apiReq` 225 vs 186 ms, `feed` 3990 vs 4250 ms, both inside host noise). The hint is standard Chromium preload-scanner behaviour and Chromium gates it on the network-prediction setting, which headless leaves off; whether the Android WebView's own prescient-networking path honours it is exactly what the committed bench now answers on a device or a headful Chrome, in one command. Verified as a pure hint with no side effects: `tools/render-snapshot.js` reports the boot, search, player, channel-sheet, library and settings markup and the API request log **identical** to the previous build (only the file name and the micro-benchmark timings differ), and `tools/startup-bench.js` puts startup inside host noise (4x CPU: shell 2762 → 3041 ms, first feed card 4303 → 4209 ms, median of 2). No UI change. v7.13 (versionCode 38) |
| 2 Nov 2026 | 1.8 Avoid layout thrash on boot: read/write DOM in separate passes | The boot path and the two animation passes it starts are now read-then-write. `render()` no longer measures anything: the lens position used to read `tabs.clientWidth` on every call — one forced layout on the boot path before the shell had ever been laid out, and one per drag frame afterwards — and is now a percentage of the lens's own width, which is exactly `calc((100% - 10px)/3)` of the strip, so it lands on the same pixel without a read. `replay()` restarts the jelly and the staggered rise animations with one flush for the whole batch instead of one for the lens plus one per element (nine forced layouts on a tab switch become one). `parallaxScroll()` and `depthScroll()` — the first depth frame after boot and every scroll frame — now measure every rect into a buffer and then write every transform, so the frame lays out once instead of once per card; the buffer keeps the two reasons to skip a card apart (off screen → transform cleared, under the finger → left as the tilt wrote it). Added `tools/layout-thrash-bench.js`, which wraps every layout-forcing read (`offset*`, `client*`, `scroll*`, `getBoundingClientRect`, `getClientRects`, `getComputedStyle`) and reports, per window, how many reads happened, how many of them actually forced a flush, and how long was spent inside them. Measured with it at 4x CPU throttle, median of 5 cold runs. Boot window (parse → first feed card → first depth pass): **34 reads / 6 forced flushes / 1473 ms inside reads → 62 reads / 2 forced / 286 ms**. Interaction window (eight scroll steps plus two tab switches): **521 reads / 68 forced / 902 ms → 493 / 20 / 500 ms — forced flushes down 71 %, time inside layout reads down 45 %**. What I am not claiming: on the boot path the layout itself still has to happen, so the 1473 → 286 ms is the browser doing it in the frame that paints instead of mid-script, not work that vanished; `tools/startup-bench.js` puts startup inside the host's ±20 % noise (4x first feed card 4410 → 4405 ms, 6x 6226 → 5318 ms, 1x 1486 → 1362 ms, median of 2). Verified no UI change: screenshots of home (top), home scrolled to 640 px, Explore, Subscriptions and the Movies chip are **pixel-identical to the previous build — 0 differing pixels on all five**; `tools/render-snapshot.js` reports the boot, search, player, channel-sheet, library and settings markup and the 9-request API log **identical**; the lens geometry for pos 0, 0.5, 1, 1.5 and 2 differs by at most 0.011 CSS px (Chromium rounds the lens width to 1/64 px — 0.02 device px at DPR 2), and the inline transforms of all 24 cards and 24 thumbnails after a scroll pass are **byte-identical**; the animation-restart state after a tab switch (lens `jelly`, per-element `rise` delays 0…385 ms) matches the old build across six runs, with the only variation being a run where Explore's shelves had not loaded yet, which the old build showed too. No UI change. v7.14 (versionCode 39) |
| 2 Nov 2026 | 1.9 Cache the last feed in localStorage and paint it instantly on reopen | The trending feed is now persisted and painted before the first request. `loadTrending` writes `lt_feed` (`{v:1, at, chav, items}`) once the channels have resolved, so the payload carries exactly what a card needs — `id, t, c, ch, views, pub, cat, dur` — plus the six channel avatars; 24 items come to **4.4–4.8 KB**. Boot reads it once, in one `JSON.parse`, before the first frame: the items go through `vObj` (so a cached card is clickable and opens the player exactly as a fetched one does) and the avatars land in a small `CAV` map, which `cardOf` falls back to — deliberately *not* in `CH`, so `loadChannels` and `ensureChannel` keep fetching full channel objects and channel data never goes stale. `FEED.cached` is a paint source only: `FEED.trending` stays `null`, so `loadTrending` still runs and the `mostPopular` request is still made on every launch. `paintSkeleton()` paints the cards and the full chip row when a cache exists and the three skeletons plus the four base chips when it does not, and `chip()` now checks `FEED.cached` too, so tapping a chip before the feed lands keeps the cached cards instead of flashing skeletons. `vObj` also restores `dur`, which means `dropShorts → loadDurations` finds nothing missing on a warm start and skips its call entirely: **7 → 6 API calls**. Added `tools/feed-cache-bench.js` (puppeteer-core, dev-only, not shipped) which runs the same fixture-mocked page cold and then warm in one profile and reports the first `.card` against `.ready`, the cache size, and whether the feed was still refetched. Median of 3, 150 ms mocked round trip: warm first feed card **1123 → 508 ms at 1x (−55 %)** and **2284 → 1030 ms at 4x CPU throttle (−55 %)**; in every new-build run the first card lands on the same frame as the shell (0–3 ms apart) where it previously trailed the shell by 429–1590 ms. Cold start is unchanged and was not made slower: 1790 → 1570 ms at 1x and 2996 → 2739 ms at 4x, both inside this host's ±20 % spread, and identical by construction since no cache means the old code path. Verified: `tools/render-snapshot.js` output identical for every surface (requests, boot, search, player, channel, library, settings) on a cold start; the cached paint's card markup is byte-identical to the markup the fresh feed paints a moment later, so there is no flicker; a cold start still paints 3 feed skeletons, 4 chips and 6 Explore skeletons; and a garbage entry, a wrong version, `items:'nope'`, `[null,null,{noid}]`, `[]`, a `setItem` that throws `QuotaExceededError` and an API 500 all fall back to the previous behaviour with no console error. With a cache present but the API down the existing error surface is kept unchanged — serving the cache offline is item 11.1, not this one. No UI change. v7.15 (versionCode 40) |
| 2 Nov 2026 | 1.10 Log a startup timeline so regressions are visible | Every boot now writes **one line** — `lt-startup shell=… reveal=… paint=… req=… data=… feed=… feedpaint=… input=… total=… prev=… vs_prev=… warm=… err=…` — with the cumulative ms of each milestone, so a regression is a bigger number against the same line from the previous launch instead of something felt later. The marks the earlier items added are now collected: `mark()` pushes `[name, ms]` into a fixed-size array (**capped at 16 entries**; a boot emits 9), still emits the `performance.mark` for devtools, and the array holds two numbers per mark — no DOM, no request, no storage while booting. Added `lt:req`, marked from `yt()` on the first call only, so the line separates JS work (`paint → req`) from network (`req → data`). The line is written the moment `lt:feedpaint` lands (that is the end of the boot), includes `input` when it got there first, and a **12 s deadline** writes a `partial=1` line for a boot that never reaches it — the timer is cleared on the normal path, so nothing is left running. `total` is the largest milestone, and the previous launch's `total` is kept in one small versioned key (`lt_boot`, `{v:1,t,at}`, ~45 bytes, guarded) to print `prev` and a signed `vs_prev`. The line is 153–154 bytes, stays on `window.__ltTimeline`, and reaches a device because `MainActivity`'s `WebChromeClient` now overrides `onConsoleMessage` and forwards **only messages starting with `lt-`** to logcat under the tag `LiquidTube` (`adb logcat -s LiquidTube`) — everything else the page, an embed or a third-party script prints is dropped, so nothing else can enter the log. `tools/startup-bench.js` now waits for and prints the timeline for each profile and carries it in its JSON. Verified across every boot path with a new committed harness, `tools/timeline-check.js` (puppeteer-core, dev-only, not shipped in the APK): cold (`warm=0 err=0`, one console line, 24 cards, **no console errors**), warm (`cache`/`warm=1`, `vs_prev` present), API 500 (`err=1`, line still written, same error surface as before), a hung API (no `feedpaint` at all → `partial=1` at the 12 s deadline), and a page with `requestIdleCallback` stubbed out (`feedpaint` written, `input` correctly absent). First attempt flushed once *both* `feedpaint` and `input` had landed, which the bench showed truncating the line at 4x/6x CPU throttle where the 9 s fallback beat `feedpaint` (4x `feedpaint` lands at ~15 s on this host) — hence the flush condition is now `feedpaint` and the deadline 12 s. No UI change: `tools/render-snapshot.js` reports the requests, boot, search, player, channel, library and settings surfaces **identical**, and screenshots of home, home scrolled to 640 px and Explore with animations frozen are **0 differing pixels** (an old-build repeat run is also 0 px; the 8 px offsets seen before freezing animations were frame-timing noise, not a layout change). Startup is unchanged within this host's noise (single runs, loaded pod: 1x shell 387 → 251 ms, 4x 7261 → 6322 ms, against the ±20 % spread recorded for 1.1). v7.16 (versionCode 41), APK 173,622 bytes, `assets/index.html` md5-matches the source. |
| 2 Nov 2026 | 2.1 Add a request cache with TTL for every API call | Every call already funnelled through `yt()`, so the cache sits there and covers all five endpoints at once: key = path + the sorted parameters with `key` left out (so parameter order and a stray `key` cannot split an entry, and the API key never enters a cache key), value = the parsed response plus its own TTL. TTLs by endpoint: `channels` 6 h, `videos` with `part=contentDetails` 12 h (a duration never changes), the `mostPopular` chart 10 min, `playlistItems` 30 min, `search` 10 min, 10 min for anything new. Only a success is stored — an `error` body and a thrown network failure both leave no entry, so the next call retries instead of serving the failure — and the `Map` is capped at **48 entries, oldest insertion out**, so a session of distinct queries cannot grow it. The stored object is handed straight to the caller, which only ever maps or filters `items` into objects of its own. Added `tools/request-cache-check.js` (jsdom + fixed fixtures, dev-only, not shipped): it calls `yt()` directly for the cache's own behaviour and drives the whole app twice over for the A/B. Verified, 17/17 assertions: a repeat inside the window costs no request and returns the same object; parameter order and a stray `key` hit the same entry while the request still carries the app key; each endpoint expires on its own window (search and chart hit at 7 min and miss at 11, durations hit at 11 h and miss at 13, uploads 25/35 min, channels 5 h/7 h); an API error and a network throw are each retried twice; a success after a failure is cached; the map sits at 48/48 after 60 distinct queries with 27 evictions, newest still hit, oldest refetched. Measured on the driven run (boot, six keystrokes, the same search twice, player, channel sheet twice, shelf "View All" twice, library, settings): **19 → 14 requests**, and in quota terms **1207 → 806 units (−33 %)** — a `search` is 100 units, everything else 1. The repeats are where it shows: second identical search **1 → 0 requests**, channel sheet reopened **1 → 0**, "View All" on a shelf that already searched **1 → 0**, and typing `lofi`, correcting to `lof`, retyping `lofi` **6 calls → 4**. Two identical calls made concurrently still both go out — that is the in-flight dedup of 2.2, not this item. **No UI change:** the 11 driven surfaces (boot chips/feed/Explore/Subs, the six typing snapshots, search results, player, channel sheet twice, View All results twice, library, settings) are **byte-identical** between the old and the new build, and the new request log is a **strict subset** of the old one — no new or altered request. **What I could not run:** this pod has no usable browser (both bundled Chromium builds die on launch with SIGTRAP, and Node's own `fetch` cannot allocate undici's llhttp wasm), so the repo's puppeteer tools — `startup-bench`, `render-snapshot`, `feed-cache-bench`, `timeline-check` — did not run this time, and the jsdom harness compares markup but cannot compute styles. The diff is confined to one JS block; no CSS, markup or element was touched, and a cold boot is unchanged by construction since an empty cache always misses. v7.17 (versionCode 42), APK 173,622 bytes, `assets/index.html` md5-matches the source (`950e64db…`). |
| 2 Nov 2026 | 2.2 Deduplicate in-flight requests to the same URL | A second call for the same query while the first is still on the wire now **joins that request** instead of sending another one. `yt()` already keyed every call (`rqKey`: path + sorted parameters, `key` excluded), so the same key now indexes a second, tiny map — `RQI`, key -> the promise of the request that is in flight — checked between the cache lookup and the send. A hit in the cache still answers from memory and costs nothing; a hit in `RQI` returns the very promise the first caller is waiting on, so both callers get the same parsed response object (exactly what a cache hit already handed out, and every call site only reads `items`), and only one round trip, one quota unit, one JSON parse happens. The slot is released by `p.then(clear,clear)` on settle, success or failure, so nothing can go stale and block a later call: a success has already been written to `RQ` by the time the slot is cleared, which makes the next call an ordinary cache hit, and a failure leaves no entry anywhere, which keeps 2.1's retry-on-failure behaviour intact. The round trip moved into `rqFetch()` so the slot can be registered before the first `await` — an async function never throws synchronously, so `RQI.set` always happens before anything can clear it. Counters are exposed on `window.__ltReqCache()` as `join` (requests served by joining) and `fly` (currently on the wire), next to the existing `hit`/`miss`/`evict`/`size`. Added `tools/inflight-dedup-check.js` (jsdom + fixed fixtures, dev-only, not shipped in the APK), which makes every request take 120 ms so calls really do overlap. Verified, **17/17 assertions**: two overlapping calls send one request and get the same object; three overlapping callers are still one request with two joins; different queries, a different endpoint and a different path each still go out separately; parameter order does not split the entry; a 500 and a network throw are both shared by the waiting callers, released, not cached, and the retry really goes out; a completed request leaves `fly` at 0 and exactly one cache entry. Measured on the driven app (every action performed twice, back to back, 120 ms per request): a chip double-tapped while its section loads **10 → 5 requests**, "View All" pressed twice **2 → 1**, the same query typed twice **2 → 1**, a channel sheet opened twice **2 → 1**; the whole run **23 → 15 requests** and **617 → 411 quota units (−33 %)**. **No UI change:** the five driven surfaces (boot, chip double-tap, View All results, search results, channel sheet) are **byte-identical** to the previous build, and the new request log is a **strict subset** of the old one — nothing new, nothing altered. `tools/request-cache-check.js` still passes **17/17** with all **11/11** surfaces identical and an unchanged request log (14 → 14, 806 units), because that harness drives the app one action at a time and never overlaps — the dedup only takes effect when two calls really are concurrent. Note on the build: this pod ships no JDK and no Android SDK, so `build.sh` was run against a JDK 17 (Ubuntu debs, invoked through the pod's newer glibc loader) and Android build-tools 34.0.0 / platform android-34 downloaded from `dl.google.com`; `build.sh` itself is unchanged and its output is the APK below. v7.18 (versionCode 43), APK 173,622 bytes, `assets/index.html` md5-matches the source (`1982f3e0…`), signed with the project key. |
| 2 Nov 2026 | 2.3 Add exponential backoff + single retry for 5xx and network errors | A failed request is now tried once more, after a wait, before the failure reaches the caller — and only when the failure is transient. The round trip split into `rqOnce()` (one attempt: fetch, parse, turn the status, the body and the API's own message into an `Error` carrying `status`) and `rqFetch()`, which loops: on a failure `rqWorthRetry()` decides. **Retried:** 5xx, 429, and a fetch that never got a response at all (offline, DNS, reset connection, TLS) — no status means the network, not the API. **Never retried:** any other 4xx (a revoked key, a quota refusal, a not-found are answers, not glitches), an `AbortError` (cancelled on purpose), and a 200 whose body will not parse. The wait is exponential with jitter — `min(4000, 500·2^attempt)` plus up to 50 % — so calls that failed together do not come back in lockstep, and `RQ_RETRY_MAX=1` caps a request at two attempts in total (worst case ~0.75 s of waiting, not a retry storm). The retry lives **inside the in-flight promise**, so the callers that joined a request (item 2.2) also wait for its retry and still share one result and one cache entry, and only a success is written to `RQ`: a failure still leaves nothing behind, so the next call goes out again. Errors keep the API's own message, so every error surface reads exactly as before; `__ltReqCache()` gained `retry` / `retryOk` / `retryFail`. **Measured:** on an idle page the gap between the two attempts is **549–747 ms over 5 samples (median 652)**, and the harness asserts the 480–900 ms window; the backoff curve itself is checked at attempts 0–3 and 9 (500–750, 1000–1500, 2000–3000, 4000–6000, still capped). **What I am not claiming:** during a cold boot in jsdom the same gap stretched to **1.9–2.3 s** (3 runs) because this pod starves timers while the page is parsing, so no device wall-clock number is quoted for the boot path; what is certain is that the second attempt leaves with the same URL, key and parameters. Before this item a single 500 on the chart left the feed in its error state for the whole session — `loadTrending` returns early on `FEED.trending` being an empty array, so nothing ever tried again. Verified with a new committed harness, `tools/retry-backoff-check.js` (jsdom + scripted fixtures, dev-only, not shipped in the APK): **54/54 assertions** — 500→ok, network-throw→ok and 429→ok each cost exactly two requests and resolve; two 500s cost exactly two and hand the failure to the caller with its message, count `retryFail` and cache nothing (the next call goes out and succeeds); a 403 quota, a 400 bad key and a 404 are each sent **once** with their message intact; an `AbortError` and an unparseable 200 are each sent once; a 503 with an HTML body is still retried and recovers; a success after a retry is cached (0 requests next time); two callers that joined an in-flight request share its retry (2 requests, one object, one join). App-level: a boot whose chart 500s once still paints **24 cards** with `err=0` in the timeline, asks the chart exactly twice, and renders **markup identical to a clean boot** (chips, feed card, Explore, Subscriptions); a boot whose chart always 500s shows the **same error surface text as the previous build** and asks exactly twice. `tools/request-cache-check.js` **17/17** with all **11/11** surfaces identical and an unchanged request log (14 → 14, 806 units); `tools/inflight-dedup-check.js` **17/17** with **5/5** surfaces identical (15 → 15, 411 units). Both harnesses had their failure-path request counts updated from one attempt to two, which is the behaviour this item changes. The diff is one JS block plus those two expectations: no CSS, markup or element touched, so no UI change. The pod has no usable browser, so the puppeteer tools (`startup-bench`, `render-snapshot`) did not run; markup identity is proven by the jsdom harnesses instead. v7.19 (versionCode 44), APK 173,622 bytes, `assets/index.html` md5-matches the source (`ba08a61d…`). Note on the signature: the project keystore is gitignored and is not in this pod, so `build.sh` generated a fresh one — the APK's cert SHA-1 is `c56b092f…`, which matches neither the README's documented `D5:3F:A0:…` nor the previously tracked APK's `0abd0c97…`. If the API key is restricted to a certificate, it needs the new SHA-1 (or the real keystore restored via `KS=`). |
| 3 Nov 2026 | 2.4 Respect HTTP cache headers where the API sends them | **The API sends none, and the ones it does send are invisible to JS.** Probed the live endpoint twice from this pod (`GET /youtube/v3/videos?part=snippet&chart=mostPopular&regionCode=IN&maxResults=1`, once with an `Origin` header): the response carries `content-type`, `vary` ×3, `content-encoding`, `date`, `server`, `content-length`, `access-control-allow-origin`, `access-control-expose-headers`, `alt-svc` — **no `Cache-Control`, no `Expires`, no `Age`, no `ETag`, no `Last-Modified`** — and `access-control-expose-headers` lists only `vary, content-encoding, date, server, content-length`, so even a caching header the server did send would be unreadable by the page. The item as written therefore has nothing to honour on this endpoint; what it can do is honour a caching header *when* one exists (a CDN or proxy in front, another endpoint, a future change) without letting it damage the windows item 2.1 chose, and that is what landed. `rqHdrFresh()` reads `Cache-Control` (`max-age`, `s-maxage`, `no-cache`, `no-store`), `Pragma: no-cache` when there is no `Cache-Control`, and the older `Expires`/`Date` pair; it subtracts `Age` (time already spent in a cache) and an older `Date` (time already spent on the wire) and returns the window. Two limits keep it safe: a header may only **shorten** the endpoint table's window, never extend it, so a server saying `max-age=86400` cannot make a search result or the trending chart a day stale; and a response that says do not keep it (`no-store`, `no-cache`, `max-age=0`, an `Expires` in the past) is not stored at all — the callers that joined it still get it. `rqOnce()` now hands back the response's `Headers` beside the body, and `__ltReqCache()` gained `hdr` (windows that came from a response) and `keep` (responses the server said not to keep). **No UI change and no change on device today:** with the live header set every call keeps exactly the window 2.1 gave it. Added `tools/http-cache-headers-check.js` (jsdom + fixed fixtures, dev-only, not shipped in the APK): **39/39 assertions** — with the live header set a search still hits at +9 min and misses at +11 min and neither counter moves; `max-age=2` wins over the 10 min table and `max-age=120` shortens a 6 h channel; `max-age=86400` extends neither a search nor a channel; `s-maxage` is used only when `max-age` is absent; `Age: 500` leaves 100 s of a `max-age=600`; `Expires`+`Date` gives the 30 s it promises and an `Expires` in the past is not kept; `no-store`, `no-cache`, `no-cache` beside `max-age=600`, `max-age=0` and `Pragma: no-cache` each leave nothing behind and are counted in `keep`; `max-age=abc` and a negative value are ignored; a response with no `Headers` object at all falls back to the table; a 500 with headers still reaches the caller with the API message after exactly two attempts and caches nothing; two overlapping callers on a `no-store` response still share one request and one object. **No regression:** the same harness's A/B (boot, search, player, live header set) reports the request log **identical (8 vs 8)**, every surface byte-identical and the same hits and misses; `request-cache-check` **11/11 surfaces identical, 14 → 14 requests, 806 → 806 quota units**; `inflight-dedup-check` **5/5 identical, 15 → 15 requests**; `retry-backoff-check` **51/51** on the new build and **51/51** on the previous one — its two A/B assertions encode a pre-2.3 baseline and fail against v7.19 whether or not this change is present, so they are not this item. Cost of the reader: **1.46 µs per response** on the live header set, i.e. nothing next to a round trip. v7.20 (versionCode 45), APK 177,718 bytes, `assets/index.html` md5-matches the source (`5f4aefa5…`), verified v1+v2+v3. The build pod holds no keystore of the project's, so `build.sh` generated a fresh one as it does in every pod: the committed APK's certificate differs from the previous one (SHA-256 `819054b5…` vs `65c5416b…`), a property of the repo's signing setup, not of this change. |
| 3 Nov 2026 | 2.5 Batch `loadChannels` calls into groups of 50 consistently | **Every `channels` lookup now goes through one queue.** Before, `loadChannels` cut its ids into 50s but sent them one after another and only skipped ids already in `CH` at the moment of the call, while `ensureChannel` bypassed it completely with its own one-id request — so two surfaces wanting the same channel at the same time sent it twice, and a set of more than 50 channels waited for each group in turn. Now `chWant()` puts the ids in `CH_Q` (id → its waiters) and schedules one flush on the **next microtask**, so every caller in the same task contributes to the same set; `chFlush()` takes the ids no group already carries (`CH_SENT` — that is what stops an id being sent twice when a second flush runs while the first is still on the wire), cuts them into **groups of 50** (`CH_BATCH`, the API's ceiling) and runs up to **4 groups at once** (`CH_PAR`). A group releases its own waiters the moment its own response lands, so a waiter never waits for the groups behind it; a failed group's error reaches that group's waiters and nobody else, which is what keeps `ensureChannel`'s message (rendered as `e.message` in the channel sheet) and its attempt count (403 once, 500 twice through the retry of 2.3) exactly as they were. `loadChannels` still swallows a failure. Counters on `window.__ltChanQueue()`: `batch`, `ids`, `join`, `err`, `queued`, `sent`. Added `tools/channel-batch-check.js` (jsdom, dev-only, not shipped): **30/30 assertions** — 120 ids → **3 requests of 50/50/20 covering 120 unique ids**; 51 → 50+1; a call with repeated ids sends each id once; two overlapping callers in one task merge into **one** request; `ensureChannel` joins a queued id instead of sending it again; ids already in `CH` cost nothing; an unknown id still throws `Channel not found` in one request; a 403 keeps the API message and is sent once; a 500 is sent twice; `loadChannels` still swallows a failure; groups go out together (**3 in flight at once, 89–103 ms wall for three 80 ms groups** against ≥240 ms one after another); a group is released **480 ms before** a slow group in front of it; of 60 ids where the 50-group is refused and the 10-group succeeds, the failed group leaves nothing behind and the other is **filled 10/10**. **App level:** two chips tapped back to back while the feed loads make **10 → 9 channel requests** — the two sections' single-channel lookups become one 2-id call. **No UI change:** `channel-batch-check` reports the boot, search, player, channel sheet, View All, library and settings surfaces **identical (7/7)** with the new request log a subset of the old; `request-cache-check` **11/11 surfaces identical, 14 → 14 requests, 806 → 806 quota units**; `inflight-dedup-check` **5/5, 18 → 18, 414 → 414**; `http-cache-headers-check` **39/39** with the **same 8 requests in a slightly different order** — a shelf's channel call can now leave after the searches the same tick started, because the flush is a microtask — so that harness compares the log as a multiset now; `retry-backoff-check` **52/2**, the same two assertions its own **old-vs-old baseline** fails, which the 2.4 run already recorded. Startup is unchanged within this pod's noise (jsdom `feedpaint` median 317 → 298 ms over 6 interleaved boots, the first boot of each series dominating), and the boot path gains one microtask and no request. **Fixture fix in the harnesses:** all ten tools that mock googleapis answered **any** `channels` id with the whole channel list, so a one-id lookup handed back a different channel than the one asked for — something the real endpoint never does — which is what made the Explore shelf render through the wrong channel in the mock; each harness now echoes the ids it was asked for (`chanAnswer`), and the old and new builds render identically under it. This pod has no browser, so the puppeteer tools (`startup-bench`, `render-snapshot`, `feed-cache-bench`, `timeline-check`, `layout-thrash-bench`, `preconnect-bench`) were updated but could not be run. v7.21 (versionCode 46), APK 177,718 bytes, `assets/index.html` md5-matches the source (`475d1e4e…`), verified v1+v2+v3. Build note: this pod caps virtual memory at 1.5 GB, so d8's default `-Xmx2G` aborts — the build ran with `_JAVA_OPTIONS="-Xmx512m -Xss512k -XX:MaxMetaspaceSize=160m -XX:ReservedCodeCacheSize=32m"` against a JDK 17 and build-tools 34.0.0 / platform-34 from `dl.google.com`; `build.sh` itself is unchanged. The pod holds no keystore of the project's, so `build.sh` generated a fresh one: certificate SHA-256 `9dcffacc…`. |
| 3 Nov 2026 | 2.6 Skip `loadDurations` when every item already has a duration | The guard added in 1.9 already returned early *inside* `loadDurations` when a list held no unknown item, so the request was never sent — but the call itself still happened on every render path, and an item the API would never describe was re-asked on every render for the whole session. Three things change. **(a) The skip moved to the caller:** `dropShorts()` asks `list.some(durUnknown)` and only awaits `loadDurations` when something is really missing, so a list that already carries a duration for each item costs no promise, no microtask and no request — the common case on a warm start and on every re-render. **(b) An answer is remembered:** the ids a successful `videos?part=contentDetails` response came back *without* a duration for (a video deleted or made private after it was listed, an item with no `contentDetails`) go into a session-scoped `DUR_NONE` set capped at 200 ids, oldest out, and are never asked about again. That is what stops the loop: a channel sheet holding two such videos used to send the same request on every open. Only an answer teaches us that — a failed request marks nothing, so retry-on-failure is unchanged. **(c) Smaller hygiene:** ids are de-duplicated before the request, and an item with no id no longer reaches the URL (it used to be able to put `undefined` in the `id` parameter). `V[id].dur` is written exactly as before (`iso2sec` of any duration the response does carry, `0` included), so nothing about which cards are shown, dropped as Shorts or cached changes. Added `tools/durations-skip-check.js` (jsdom + fixed fixtures, dev-only, not shipped) and `window.__ltDurations()` (`calls`/`skipped`/`none`/`known`) next to the other debug counters. **Verified, 44/44 assertions:** a list already holding every duration sends nothing and is counted as skipped; a known 30 s item is still dropped with no request; a warm start asks for no duration for any of the 24 feed items; the channel sheet opened twice with two unmeasurable videos sends **1 duration request, not 2** (asking for all 12 ids, 10 of which come back measured, and remembering the other 2); the same query searched twice **1, not 2**; a duration request that fails twice marks nothing and the next list asks again, then it is remembered and never asked again; 300 unmeasurable ids leave the set at exactly 200; a repeated id is asked for once; a missing id never reaches the URL; no console errors. **Measured, old build against new over the same driven actions** (cold boot, channel sheet opened twice, same query searched twice): duration requests **8 → 6** and all requests **16 → 14**; a cold boot is unchanged at 4 duration requests because those four lists genuinely have unknown items (the feed plus each Explore shelf), which is the honest half of this item — the saving is on the repeats. **No UI change:** the feed, the channel sheet (both opens) and the search results are **byte-identical** to the previous build, and the new request log is an ordered subset of the old one — nothing new, nothing altered. `tools/request-cache-check.js` (39/39 assertions in `http-cache-headers-check`, and request-cache/inflight-dedup both PASS with unchanged surfaces and an unchanged request log), `tools/channel-batch-check.js` (29/30) and `tools/retry-backoff-check.js` (52/54) were re-run: the two failures in each are **pre-existing** — running the old build against itself reproduces them exactly — and unrelated to this change. This pod has no browser, so the puppeteer tools were not run. v7.22 (versionCode 47), APK 177,718 bytes, `assets/index.html` md5-matches the source (`defbf7ca…`), verified v1+v2+v3. Build note: the pod caps virtual memory at 1.5 GB, so `d8`'s `-Xmx2G` and `apksigner`'s `-Xmx1024M` defaults abort; the build ran against a JDK 17 and build-tools 34.0.0 / platform-34 from `dl.google.com` with both launchers' default heap lowered (SDK scripts only — `build.sh` itself is unchanged). The pod holds no keystore of the project's, so `build.sh` generated a fresh one: certificate SHA-256 `1037de65…`. |
| 3 Nov 2026 | 2.7 Abort stale requests when the user switches tabs | A request can now belong to a page, and a page that is not the tab on screen holds no request. `yt(path, params, own)` takes an optional owner — the tab whose DOM the answer is rendered into — and `rqAbandon()` (called from `render()` through the new `pageSwitch()`) narrows the set of pages the app is filling to the tab the user is on: every request on the wire whose owner is outside that set, and that no page inside it is waiting for either, is aborted through an `AbortController`, so the connection closes, the body is never parsed, nothing is cached and no quota is spent on a list nobody is looking at. A tagged call for a page outside the set is not even sent, which is what stops a half-finished chain (a shelf that was waiting on a shared channel lookup, a section between two channels) from firing one more request for a tab the user left. **Tagged:** the two search-backed shelves and the channel shelf's `playlistItems` in Explore (`loadShelf`), and a chip section's four `playlistItems` plus its fallback `search` on Home (`loadSection`, whose per-channel `catch` now rethrows an `AbortError` instead of swallowing it, and which checks `pageWanted('home')` between channels). **Never touched:** anything untagged — the feed, the channel queue, durations, the search box, the player — a request an untagged caller has joined (it is no longer one page's private work), and a request the page on screen is waiting for. Coming back re-drives exactly what never landed (`exploreResume` re-runs only the shelves missing from `SHELF`, guarded by a new `SHELF_BUSY` set so a shelf already on the wire is never started twice; `homeResume` re-runs the pending chip section), so the visible result is unchanged — the abort path leaves the placeholder/skeletons in place instead of blanking the carousel or flashing an error. `window.__ltReqCache()` gained `abort`. Added `tools/tab-abort-check.js` (jsdom + fixed fixtures, dev-only, not shipped in the APK; its mock `fetch` honours `AbortSignal` the way a real one does and logs whether each request was closed before it answered). **Verified, 53/53 assertions:** a request whose page is left rejects with `AbortError`, is counted once, is **not** retried, leaves no in-flight slot and nothing cached (so a later call really goes out again); a tagged call for a page nobody is on is refused without sending anything; an untagged request survives every switch; a request the page on screen owns survives; a request an untagged caller joined is kept; at boot, where Home and Explore are both wanted, a request two pages own is sent once and lives until neither page is on screen; a sweep with nothing tagged on the wire is a no-op; the layer still caches normally afterwards. **App-level, switching at the exact moment the two shelf searches are on the wire:** leaving Explore aborts both, **0 requests sent while away** (previous build: 1), nothing reaches the carousels, and returning fills all three shelves again (18 carousel cards, identical markup to the previous build); tapping Anime and leaving Home aborts the section (**0 requests sent while away**, previous build: 1), the feed keeps its skeletons instead of flashing "Could not load", and returning lands the same 12 cards, byte-identical to the previous build's. **Measured over the whole Explore walk** (boot → leave mid-shelf-load → return): previous build 7 requests, 0 aborted, 1 sent while away, 0 on return; this build 9 requests, **2 aborted**, 0 while away, 3 on return — the honest trade is that an abandoned request is re-sent if the user comes back (two `search` calls, 100 units each, when they return to Explore), against spending the network and quota of the rest of the chain for a tab nobody is on. **No UI change:** a tab walk with nothing in flight aborts nothing, sends nothing new and leaves every surface (`#chips`, `#feed`, `#ex`, `#sg`, `#subfeed`) exactly as it was; the settled markup of boot, the Anime section, the All chip, Explore, Subscriptions and Home is **byte-identical to the previous build** with an unchanged 7-request log and 0 aborts in a plain session. **Fallback checked:** with `AbortController` removed from the window (an old WebView) nothing is aborted, the shelves still fill in as they always did and there are no console errors — the tagging is inert. Regression harnesses re-run: `request-cache-check` PASS (11/11 surfaces, log 806 units both builds), `inflight-dedup-check` PASS (log a subset of the old one, 414 units both), `http-cache-headers-check` 39/39, `durations-skip-check` 36/36 with the A/B half skipped (its A/B assertions need a pre-2.6 build and fail against the current one, old against old the same way), `channel-batch-check` 29/30 and `retry-backoff-check` 52/54 — both reproducing identically with the previous build against itself, so pre-existing. No browser on this pod, so the puppeteer tools were not run. v7.23 (versionCode 48), APK 181,814 bytes, `assets/index.html` md5-matches the source (`e70ec3ae…`), verified v1+v2+v3. Build note: the pod has no JDK or Android SDK, so `build.sh` ran against Temurin JDK 17 from `api.adoptium.net` and build-tools 34.0.0 / platform android-34 fetched directly from `dl.google.com` (`sdkmanager` cannot fetch its manifest here), with `d8`'s and `apksigner`'s default heap lowered to 512 MB in the SDK launchers only — `build.sh` itself is unchanged. The pod holds no keystore of the project's, so `build.sh` generated a fresh one: certificate SHA-256 `4ec51050…`. |
