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
- [ ] 1.7 Preconnect to googleapis.com and i.ytimg.com at boot
- [ ] 1.8 Avoid layout thrash on boot: read/write DOM in separate passes
- [ ] 1.9 Cache the last feed in localStorage and paint it instantly on reopen
- [ ] 1.10 Log a startup timeline so regressions are visible

## Day 2 — Network & caching
- [ ] 2.1 Add a request cache with TTL for every API call (not just shelves)
- [ ] 2.2 Deduplicate in-flight requests to the same URL
- [ ] 2.3 Add exponential backoff + single retry for 5xx and network errors
- [ ] 2.4 Respect HTTP cache headers where the API sends them
- [ ] 2.5 Batch `loadChannels` calls into groups of 50 consistently
- [ ] 2.6 Skip `loadDurations` when every item already has a duration
- [ ] 2.7 Abort stale requests when the user switches tabs
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
