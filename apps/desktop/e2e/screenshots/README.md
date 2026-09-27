# Repeatable website and documentation screenshots

From the repository root:

```sh
pnpm screenshots:update
pnpm screenshots:update -- --only mini
```

The command builds the screenshot app by default, then runs every selected recipe.
Use `--skip-build` to reuse the last **screenshot** bundle when iterating on recipes
only. Rebuild after any frontend or Rust change. `--help` lists the options.

## Requirements

- macOS, the normal Pudding build toolchain, a logged-in graphical desktop, and an
  audio output device (the real audio engine runs, with volume set to zero).
- A Retina display at 2x scale, with room for a 960 × 640 logical-pixel window.
  The runner checks the actual viewport scale and native capture dimensions.
- Screen & System Audio Recording permission for the terminal or host running
  the command. macOS may require relaunching that host after granting permission.
- Loopback networking for the e2e bridge and for the local radio station the
  streams scene plays. Restricted agent environments may need to run the command
  outside their execution sandbox. Nothing reaches the network beyond loopback:
  the other fixture stations are unreachable example URLs.

## How it works

The runner uses the existing `scripts/gen-screenshot-library.mjs` unchanged to
create the fictional library (30 tracks, six albums, and the Favorites and
Synthwave playlists). It builds `Pudding Screenshots.app` with the e2e
CSP and a separate application identifier, so the normal Pudding instance can
remain open. Each recipe launches its own instance on an ephemeral bridge port
with a fresh profile under `.screenshots/`. Settings, metadata DB, and the default
stream list all use that directory. The profile override is honored only in a
debug build launched with `PUDDING_E2E_PORT`.

The artists, albums and tracks in that library are invented; the cover art is
not. Every album carries one of the photographs tracked in `apps/desktop/images`,
because a synthesised pattern reads as filler at the size Now Playing gives it on
a website.

`scenes.mjs` is the manifest and recipe collection. Each recipe declares its
logical window size, setup function, and repository-relative destination paths.
It drives the same app actions as e2e tests, asserts the expected library and
playback state, waits for fonts/artwork and painting, disables CSS motion, and
requires two matching native captures. Each capture focuses the app so the native
window buttons have a consistent appearance; leave the pointer outside that
window while it runs to avoid hover effects. The normal session-restoration path
restores playback paused at exactly 0:42.
This avoids a timing race: seeking a live track intentionally resumes playback. Capture uses
the same native window ID and PNG utilities as `pnpm caliper`.

Every scene restores that same paused session and then sets up only what makes it
different, through two optional hooks: `settings` layers keys over
`initialSettings` (a theme, a hero view, where the Files panel is drilled to), and
`fixture` writes extra files before launch. Fixtures sit beside the library
folder, never inside it — a `.m3u8` under a library root would appear as another
playlist in every other scene's Files panel — and that keeps them on the one path
Settings is allowed to show (see below).

The desktop image serves the homepage, README, and the documentation's Layout
section. The mini image serves the README, the documentation's Mini player
section, and the website asset collection. Every other scene is either a
documentation image, writing only to `apps/website/src/assets`, or one of the
`store-*` App Store posters below. The documentation images share one
960 × 640 window so the images sit together on a page without one reading as a
different app; the mini player is the sole exception.

The desktop recipe shows the basic Files / Now Playing layout: it clears the
restored queue through the UI while keeping the track paused at 0:42, and checks
that no queue navigation remains. The Files panel sits on its index — the library
views plus the Playlists section, where the fixture library's Favorites and
Synthwave playlists appear. Shuffle, repeat, autoadvance, ReplayGain,
sample-rate matching, the equalizer, and the visualizer are disabled explicitly.
It is also the one scene that arrives on a different album (`HERO_ALBUM`), so the
homepage's artwork is not the cover every documentation image already carries:
the fixture library gives that one album its own photograph, and no other scene
features it. The `light` scene reuses the recipe under a light theme, on the
album the rest of the documentation shows.
Documentation references the website asset directly; it needs no extra copy.

The `columns` scene is the one that ships a layout rather than a view: a stored
splitter width and stored column prefs, both seeded through `settings` and both
read on launch by the same code a returning user's own layout arrives by. Its
window is the shared 960 × 640, so the widened Files panel has to fit a readable
table and a Now Playing pane at once — the seeded width is what the scene asserts
against the pane's 28rem column gate, since a width that fell short would capture
an ordinary narrow list with no header and say so nowhere.
The screenshot gallery page is still its existing placeholder.

## Mac App Store posters

The `store-*` scenes are the only ones whose published image is not a capture.
An App Store screenshot has to be one of Apple's accepted 16:10 sizes and has to
say what the app is — Apple reads the screenshots, not the README, when it judges
differentiation — so `poster.mjs` composes each one: a captioned 2560 × 1600
frame it renders in WebKit, with the scene's own native capture laid into it at
1:1 device pixels. Nothing here resizes the app. The chrome is rendered in sRGB
and converted into Display P3 to meet the capture, which keeps its own profile
chunks, so the app's raster reaches the store exactly as macOS drew it.

Two things Apple's specification insists on are asserted before a poster is
written, because App Store Connect would otherwise reject the upload long after
this run reported success: the image is exactly 2560 × 1600, and it carries **no
alpha channel** (`encodePNG`'s `rgb` option writes colour type 2). Every pixel is
opaque by construction; the rule is about the channel existing at all.

The set is ordered, and the numbers in the destination filenames are that order:
`01-library` is the app at rest — the Files index beside Now Playing, nothing
switched on — because it answers "what is this", and `02-sizes` follows it to
answer what that one provokes. `03-tags`, `04-playlists`, `05-themes`,
`06-search` and `07-equalizer` are one feature apiece. Renumbering a poster means renaming
its file only: a scene's id strips the number prefix, so `store-sizes` is
`store-sizes` wherever it sits in the set.

A poster is made of one window or several. A window is a whole app launch —
that's what a scene is — so a store scene declares its windows as `panels`, each
a complete recipe with its own size, settings and fixtures, and the runner
captures them the way it captures anything else. `poster.layout` then places them
by their panel id, in CSS px of the poster's own 1280 × 800 frame, painted in the
order listed. A poster with one panel and no layout centres it instead.

Two posters are multi-window, and they are opposites. `store-sizes` holds the
appearance still and varies the window: the mini player over Zen Mode with the
visualizer in a narrow left column, and beside them a tall two-pane window with
the Songs table in it, running the poster's whole height. Its three sizes
(`SIZE_WINDOWS` in `scenes.mjs`) are chosen against the app's own breakpoint —
over 600 × 360 the window keeps both panes, under it the topbar and Files panel
go and the hero folds into a bar — and they are fitted to the layout beside them,
so moving one means checking the other: the two stacked windows share a width
because they share a column, and their heights plus the gutter are the tall
window's height. The tall window seeds the same column set as the `columns`
documentation image (`songsTable` is what both column scenes are built from) at a
divider fitted to its own width, which still has to clear the pane's 28rem column
gate. The headline is the one part
of a poster a browser lays out, so what it does with the band above the topmost
window is measured at compose time rather than assumed. Every poster centres its
headline's line box in that band — 120px tall where a single window sits in
`BOX`, taller where a layout raises the top row — which is what gives the same
margin above the headline as below it whichever poster it is, and centres the
line box rather than the ink so copy with a descender sits where copy without one
does. A headline one word too long grows a line, eating that band from both ends;
the compose step fails when either margin drops under `CAPTION_CLEARANCE`.

`store-themes` does the reverse: one window size, four appearances, and every
other thing a capture could differ by held still — same album, same playhead,
same 560 × 292 window — so the only thing four captures disagree about is colour.
`THEME_FACES` names them, two dark and two light, laid out as a checkerboard so
neither mode owns a row or a column. A theme in this app is an accent pair
layered on the mode's neutrals (see `theme.ts`), which is why the poster shows
two accents against each ground rather than one of each. Each face asserts what
reached `<html>` rather than what was asked for: `applyTheme` writes the mode to
`data-mode` and the accent pair to inline custom properties, so the recipe reads
those back and fails on a window painted anything but its own hex — the whole
claim of the image is four distinguishable colours, and two that drifted together
would say the opposite.

That window sits under the breakpoint because four two-pane windows cannot fit
the frame at 1:1: over 600 × 360 two rows need 722px of height before any gap,
and the caption leaves 657. Nothing here is ever scaled to make an arrangement
work, so the arrangement gives way instead.

Zen Mode fades its transport out after a couple of idle seconds and only a real
mouse move brings it back — and captures are taken with the pointer outside the
window. So the `zenMode` bridge action pins that auto-hide open (`zenIdlePinned`
in main.ts) for the rest of the session, the way `captureStill` stops the
visualizer's loop for good, and the recipe asserts the controls are still there.
The visualizer panel of `store-sizes` is the only place in the suite that enters
Zen Mode at all; the documentation visualizer scene shows it inside the ordinary
window.

A window sized by hand can break its hero in two measurable ways, so neither is
left to the eye: the art can overflow a window too narrow to hold it beside the
text, and a title too long for what is left starts a marquee, which freezes
mid-travel with the text half gone. The `store-themes` faces check both, plus
that the Files panel really is gone — a window that crept back over the
breakpoint would capture a layout the grid has no room for.

## Two things every scene has to respect

**No machine-specific paths.** These images ship on a public website. Settings is
the only surface that shows an absolute path — its library-folder rows and its
stream list — and the panel is shorter than the pane it sits in, so no framing or
scrolling can leave those rows out. The fixtures they name therefore live in
`/Users/Shared/Pudding Screenshots` instead of under the run directory: a
location that reads the same on every Mac, with no home directory or checkout in
it. The `themes` scene (the Settings picker, not the `store-themes` poster)
reads the panel's input values back through the
`panelPaths` bridge action and fails unless every path on screen is under that
directory — including the stream list, which otherwise defaults to a file inside
the scene's own profile. Any new scene that opens Settings needs the same check
and the fixture stream list (`withStreams`).

The runner generates that directory and removes it afterwards. It refuses to
delete anything there it did not create, so a run stops rather than touching a
folder of that name that turns out to be someone's own.

**Playback stays where the recipe means it to be.** The runner re-asserts the
scene's expected playback state just before the shutter, and every scene but one
expects the restored session still paused at 0:42 (`restoredSession` in
`scenes.mjs`). So a recipe must reach its state without starting playback —
which is why the playlist scene opens Favorites through the single-click browse
path rather than playing it, and the queue scene builds a queue around the
already paused track. A scene that genuinely needs playback declares its own
expectation through the recipe's `playback` hook, as the streams scene does.

## The streams scene

Everything that makes the transport read as radio rather than a file — the LIVE
indicator where the seek row sits, no prev/next, the ICY song title under the
station name, the station's own artwork — is state only a live connection
produces. So the runner broadcasts one: `station.mjs` serves an Icecast-shaped
response on an ephemeral loopback port, typed `audio/mpeg` and carrying
`icy-name` plus `icy-metaint`, whose body interleaves a metadata block into the
audio every 8192 bytes. The engine reaches it through `icy.rs` exactly the way it
reaches a real station, and the fixture stream list points one station at it (and
carries its art on the usual `tvg-logo` attribute). The other four stay example
URLs nothing dials.

The station's art is another tracked photograph, served under its own extension
and content type. It is deliberately not the album covers' pixel size:
`naturalWidth` is the only thing the scene can use to tell the station's own art
apart from a cover left over from the paused track, so if either image is
replaced the two sizes have to stay different.

The audio is the app's own bundled `pudding sample.mp3`, tags stripped off both
ends so its frame region loops end to end. None of it reaches a pixel — every
scene runs at volume 0 — and the one skipped packet per lap (the bit reservoir
does not survive the seam) is what `decode_and_push` already treats as
recoverable. The loopback URL and its ephemeral port never reach a pixel either:
the list shows station names, and Now Playing shows the fetched image.

This is the one scene that is deliberately playing at the shutter, so it declares
`playback: liveStream` instead of the shared paused expectation. Nothing on
screen is moving: a stream has no timeline, so there is no playhead, clock or
seek bar to disagree between the two native captures, and the LIVE indicator's
pulse is cancelled at the shutter (see Holding the window still). The recipe
waits for the in-band title to arrive before the shutter rather than only for
audio, so the captures can't straddle its fade-in.

## Holding the window still

A capture is only accepted once two consecutive native captures of the window
agree, so anything in motion at the shutter stalls the scene. Two mechanisms hold
it still, and they are not interchangeable.

`FREEZE_CSS` (capture.mjs) is injected once per scene and turns off transitions
and animations through the cascade. It is the cheap, broad one, and it is also
the one that quietly misses things: it can only reach what the cascade reaches,
and it gives no sign when it fails. The LIVE indicator was the case that proved
this — a `live-pulse` that kept running through `animation: none !important`
right up to the shutter.

So before every shutter the runner also calls the bridge's `freeze` command,
which walks `document.getAnimations()` and cancels what it finds. That list is
the engine's own: CSS animations, transitions already in flight, and anything
script started, whatever property each one targets. Cancelling drops the effect,
so each element falls back to its cascaded value rather than holding an arbitrary
frame. It runs on every attempt rather than once, because cancelling an animation
does not stop the cascade from starting it again.

`freeze` reports what it cancelled, and an unsettled capture puts that in the
error alongside the differing region and the frames themselves
(`<scene>-unsettled-{a,b,diff}.png`). The message distinguishes the two cases
worth telling apart: something was still animating and is named, or nothing was,
in which case the motion is not a CSS animation at all and the hunt belongs
somewhere else — a canvas, a timer writing inline styles, or below the web layer.
Reach for that report before reasoning about the pixels. Over a dark background a
colour interpolating toward grey and a fading opacity are both multiplicative and
look alike, which is exactly how this one stayed misdiagnosed.

One thing neither freeze can reach: **the text caret in a focused input**. The
`search` scene focuses the search field, so its caret blinks right through both,
and a capture settles on whichever phase two consecutive shutters happen to
share. `FREEZE_CSS` carries a `caret-color: transparent !important` rule that
looks like it covers this and does not — measured against this WKWebView it is a
silent no-op, applied universally, scoped to `#search-input`, as `rgba(0,0,0,0)`,
and injected before the field takes focus. (A control rule on the same element in
the same run does apply, so the stylesheet is reaching it; `caret-color`
specifically is ignored.) Nothing depends on that phase today, since the capture
is published rather than compared — but a scene that focuses a text field cannot
be made pixel-reproducible, and that is worth knowing before anything is built on
the assumption that it can.

## The visualizer scene

The visualizer is a live canvas, so freezing CSS does not hold it still. It
exposes `captureStill` (src/visualizer.ts), reached through the `visualizerStill`
bridge action: it stops the rAF loop, swaps a seeded PRNG in for `Math.random`,
reseeds the star field, pins the color drift, feeds a synthetic waveform in place
of the silent audio tap, and composes a fixed number of fixed-length frames by
hand. The loop does not resume, so the two native captures agree. Frames are
composed by the same `step(dt)` the live loop calls, so the still can't drift
away from what the visualizer actually looks like.

## Updating and reviewing

All selected recipes must capture successfully before the runner updates any
tracked images. One capture is copied to every destination in its recipe. If its
decoded pixels match the existing image, the existing file is left untouched,
so PNG metadata alone doesn't cause churn.

Each run prints a `.screenshots/run-…/review.html` path. Open it to compare the
previous image, captured image, and a pixel difference image. `report.json`
records destinations, dimensions, display scale, macOS version, and playback
state. Per-recipe app logs are alongside it. Successful runs remove the fixture
directory and the per-scene profiles; a failed run leaves both for diagnosis, and
the next run clears the fixture directory before generating it again.

There is deliberately no check mode. A `--check` flag used to re-capture every
scene and fail on any pixel difference, as a guard against publishing a stale
image — a thing that never once happened, while the flag's own failures were
routinely noise: the search field's caret blinks and no freeze stops it
(see *Holding the window still*), and a red run meant "an image is stale **or**
the caret blinked". It also could never run on the Ubuntu CI jobs, needing a
Retina display, audio out, screen-capture permission and this machine's shared
fixture directory — so it was a manual gate that only fired when you already had
the screenshots in mind. Updating is cheap and deterministic, so run it and let
`git diff` tell you what moved; that is the same signal, whenever you want it.

Review and commit image updates alongside the UI change, then run
`pnpm website:check` and `pnpm website:build`. Use the same macOS version and
display setup between runs: OS rasterization changes can legitimately change
pixels, and will show up as churn in `git diff`.

A lock prevents overlapping capture runs. After an uncatchable crash, check the
PID in `.screenshots/run.lock` and remove the lock only when that process has
exited. Do not run a manually launched copy of `Pudding Screenshots.app` during a
capture run (its single-instance behavior would prevent the runner connecting).

## Adding a scene

Add a recipe to `scenes.mjs` with a unique ID and explicit destinations, then
reference one of those assets from the relevant Markdown or Astro page. Each
recipe starts fresh: set up all of its own state rather than depending on the
previous scene. Prefer existing UI entry points; add a narrow named action to
the e2e bridge when needed.

A scene captures one window, because it launches one app. A published image that
needs more than one window is a poster with several `panels` — see Mac App Store
posters above — not a scene that resizes itself between shutters. Use readiness predicates rather than long sleeps.

Anything else that animates on a canvas needs the same treatment as the
visualizer above: a hook that composes a fixed frame and leaves the loop stopped.
Neither freeze below stops canvas animation.

Native menus are out of reach. Context menus and the menu bar are real AppKit
windows, and the runner captures a single window by ID, so a scene that opens one
captures the app without it. Documenting a menu-driven feature needs a
screen-region capture path that does not exist yet.
