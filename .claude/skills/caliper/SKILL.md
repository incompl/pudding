---
name: caliper
description: Measure and fix sub-pixel alignment between icons and type in Pudding's chrome, on the pixels macOS actually drew — real window capture, device-pixel units, verified DOM-to-pixel mapping. Use when a glyph doesn't sit right next to type, before changing any topbar icon's size or crop, or any time you are tempted to nudge something by a fraction of a pixel.
---

# Caliper

`scripts/caliper.mjs` drives the real app, captures the real window with
`screencapture`, and maps the real DOM onto those pixels. It reports where each
thing's ink actually landed, in **device rows**.

```bash
pnpm caliper                                   # topbar: measure + crops
pnpm caliper --selftest                        # prove the mapping before trusting it
pnpm caliper --try '#search-input{padding-top:4.7px}'   # A/B a fix in the real engine
pnpm caliper --probe '#time-current' --scan 34 --target 'elapsed=#time-current'
```

Output lands in `.caliper/` (gitignored). **Look at the crops** — the table and
the picture answer different questions.

## Why not a headless browser

Because it lies. This tool replaced `scripts/ruler.mjs`, which rendered
`index.html` + `styles.css` in headless Playwright WebKit. On 2026-09-07 the ruler
reported the search placeholder and the "Streams" tab label as pixel-identical
while the shipping app plainly had the placeholder a pixel low. Greg was right and
the tool was wrong.

Headless WebKit and the WKWebView we ship **disagree by a whole device pixel**.
Not layout, not fonts — computed boxes and canvas font metrics are byte-identical
between them. It is rasterizer rounding on a box that lands off the device grid:
`#search-input` is 28.375px tall, so centring it in the 33px bar puts its
content-box top at 10.5125px = 21.025 device px, and the two engines round that
hair in opposite directions. Elements on clean integer geometry (`.tab` labels,
`.mode-btn` icons) came out one device row *higher* in the real app; the search
field's contents did not move.

There is no headless mode here and there should not be one.

## Read the table

```
target         kind  ink       base  mass    off      css px
tab "Files"    text  26..46    45    37.15   probe    13.000..23.500
placeholder    text  27..47    46    39.27   +1       13.500..24.000   low
shuffle        icon  24..48    43    36.47   0.47     12.000..24.500
magnifier      icon  26..49    45    37.49   1.49     13.000..25.000   low
```

(A historical capture, kept because it shows both a clean row and a broken one.
The topbar measures clean today.)

- **Everything is device rows from the window's top.** CSS px is the trailing
  column, for talking to the stylesheet. The ruler reported CSS px first and a
  1-device-px error read as perfect agreement, because at dpr 2 the interesting
  differences live in the half-CSS-px its rounding threw away.
- **`base`** — the baseline shelf: the last row still carrying half the run's peak
  ink, where the letter bottoms sit. Two runs of type agree when their shelves
  land on the same row. This is the number that catches a pixel of drift.
- **`mass`** — the ink's intensity centroid.
- **`off`** — how far from where the row's type says it should be. For `text`
  that's baseline-to-baseline, an integer. For `icon` it's the centroid against
  the cap band's centre.

**Type and icons are judged by different numbers, and mixing them up produces
nonsense.** Type has a baseline; an icon does not, and asking where an icon's
"baseline" is picks whatever row its heaviest stroke fell on — an early version of
this table claimed the three mode icons disagreed by 3 device px when they are
identical art. Mark icons `icon:` in the target spec.

## The rules that actually matter

1. **Align glyphs to the cap band, not the line box.** Type does not centre in its
   own line box — descender room below the baseline exceeds the room above the cap
   top — so anything centred in a row reads *high*. In Pudding's topbar that gap is
   about a quarter of a CSS pixel — which is *smaller than a position can express*
   (rule 2), so it is bought with ink height and never with an offset. A
   `--cap-drop: 0.25px` variable used to exist for exactly this and has been
   deleted: measured, 0.25px and 0.50px rasterized byte-identically, both a full
   device pixel. It was not correcting the error, it was the error.

2. **Fix the ink height, not the position.** WebKit snaps layout offsets to the
   device grid, so at 2x a `top: 0.25px` correction renders as 0.5px and overshoots
   by exactly the error it was meant to remove. An icon whose ink is an *even*
   number of device px can only ever centre on x.500 or x.000 — never the x.750
   where the cap band is. 12.5px is an odd 25 and lands on the band exactly. **A
   positional nudge on a topbar glyph is almost always the wrong fix**; see the
   recipe on `.mode-btn svg` in `src/styles.css`. This is also why the icon
   tolerance is 0.75 device px: a residual near 0.5 is the grid, not a defect.

   The worked case is the search magnifier. It sat +1.03 low for a while and the
   comment above it blamed its lopsided mass. It was the `calc(50% + …)` nudge in
   its own rule: deleting it moved the glyph up exactly one device row, to +0.06,
   and changed nothing else in the bar. **When a glyph is off by about a device
   pixel, look for a correction already applied to it before adding another.**

3. **Normalise ink, not viewBox.** Lucide art fills a different amount of its 24x24
   box per icon, so equal `width` gives unequal optical size. Every topbar glyph is
   cropped to its own art — the arithmetic is in the topbar icon recipe comment on
   `.mode-btn svg`. Run it before adding an icon up there; do not copy a 24x24
   viewBox from elsewhere in the file.

## It refuses rather than guesses

The ruler's real sin was answering confidently for pixels it had never seen. This
aborts instead of printing a number when:

- a calibration marker is missing, or comes back the wrong size (something is
  covering it, so the capture cannot be mapped to the DOM);
- the implied scale disagrees with the DOM's `devicePixelRatio` (a scaled display
  mode means what is on screen is resampled, and sub-pixel work tuned there would
  not describe what you see);
- two consecutive captures differ (something is still animating — stop playback,
  the visualizer and marquee both run).

If it aborts, fix the cause. Do not work around it.

`--selftest` verifies the DOM-to-pixel mapping against a landmark whose truth is
known independently: the active tab's accent underline must measure 2 CSS px tall
with its left and right edges exactly on the tab's box. Run it if a result
surprises you.

## Anything, not just the topbar

Defaults describe the topbar because that is where this work keeps landing, but
nothing is topbar-specific. `--probe` picks the type that sets the guides,
`--target` picks what is measured against them, `--scan` is the row height:

```bash
pnpm caliper --probe '#time-current' --scan 34 \
  --target 'elapsed=#time-current' --target 'prev=icon:#prev-btn'
```

A target is `label=selector`, where the selector may be prefixed `icon:` or
`text:` (default text) and may carry a band — `'magnifier=icon:#search-input[5:20]'`,
x offsets in CSS px from the element's left edge — for an element that paints two
things which must be judged separately. All targets must live in the probe's row;
one from another row is skipped with a warning rather than measured against the
wrong guides. Hidden targets drop out quietly, so one list can name elements from
states that never coexist.

## Notes

- It attaches to a running app if there is one and launches `e2e/drive.mjs --dev`
  otherwise, so leave the daemon up while iterating — repeat runs then cost
  seconds. `--attach` refuses to launch one.
- **Killing the daemon orphans its children.** The app, vite and tauri keep
  running, the app stays pointed at the dead socket, and the next daemon waits
  forever for a webview that can never dial in. Caliper detects this (a daemon
  answering `connected:false`) and tells you what to clear instead of hanging.
  Note `pkill -f 'e2e/drive.mjs'` alone is NOT reliable — the daemon has survived
  plain SIGTERM here more than once. What works:

  ```bash
  lsof -t -iTCP:9010,9011,1420 -sTCP:LISTEN | xargs kill -9
  pkill -9 -f 'target/debug/pudding'; pkill -9 -f 'tauri.js dev'
  ```
- Needs macOS Screen Recording permission for whatever runs it, and the host app
  must be relaunched after granting it.
- `--try` injects CSS into the running app, measures, and reports the change in
  device rows. Real engine, no rebuild. It removes everything it injected on the
  way out, including after an abort.
- A change smaller than half a device pixel legitimately moves nothing. That is
  information, not a failure.
