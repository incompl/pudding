# Repeatable website and documentation screenshots

From the repository root:

```sh
pnpm screenshots:update
pnpm screenshots:update -- --only mini
pnpm screenshots:check
```

Both commands build the screenshot app by default, then run every selected recipe.
Use `--skip-build` to reuse the last **screenshot** bundle when iterating on recipes
only. Rebuild after any frontend or Rust change. `--help` lists the options.

## Requirements

- macOS, the normal Pudding build toolchain, a logged-in graphical desktop, and an
  audio output device (the real audio engine runs, with volume set to zero).
- A Retina display at 2x scale, with room for a 960 × 640 logical-pixel window.
  The runner checks the actual viewport scale and native capture dimensions.
- Screen & System Audio Recording permission for the terminal or host running
  the command. macOS may require relaunching that host after granting permission.
- Loopback networking for the e2e bridge. Restricted agent environments may need
  to run the command outside their execution sandbox.

## How it works

The runner uses the existing `scripts/gen-screenshot-library.mjs` unchanged to
create the fictional library. It builds `Pudding Screenshots.app` with the e2e
CSP and a separate application identifier, so the normal Pudding instance can
remain open. Each recipe launches its own instance on an ephemeral bridge port
with a fresh profile under `.screenshots/`. Settings, metadata DB, and the default
stream list all use that directory. The profile override is honored only in a
debug build launched with `PUDDING_E2E_PORT`.

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

The desktop image serves the homepage, README, and the documentation's Layout
section. The mini image serves the README and the website asset collection.
The desktop recipe shows the basic Files / Now Playing layout: it clears the
restored queue through the UI while keeping the track paused at 0:42, and checks
that no queue navigation remains. Shuffle, repeat, autoadvance, ReplayGain,
sample-rate matching, the equalizer, and the visualizer are disabled explicitly.
Documentation references the website asset directly; it needs no extra copy.
The screenshot gallery page is still its existing placeholder.

## Updating and reviewing

All selected recipes must capture successfully before the runner updates any
tracked images. One capture is copied to every destination in its recipe. If its
decoded pixels match the existing image, the existing file is left untouched,
so PNG metadata alone doesn't cause churn.

Each run prints a `.screenshots/run-…/review.html` path. Open it to compare the
previous image, captured image, and a pixel difference image. `report.json`
records destinations, dimensions, display scale, macOS version, and playback
state. Per-recipe app logs are alongside it. Successful runs remove their
fixture audio and profiles; failed runs retain them for diagnosis.

`pnpm screenshots:check` never updates tracked images. It exits with status 1
for missing or changed images (or a capture failure), and status 0 when every
selected destination matches. Use the same macOS version and display setup for
exact comparisons; OS rasterization changes can legitimately change pixels.
This command is intended for local use or a dedicated Mac with a graphical
session, not the existing Ubuntu CI jobs. Review and commit image updates
alongside the UI change, then run `pnpm website:check` and `pnpm website:build`.

A lock prevents overlapping capture runs. After an uncatchable crash, check the
PID in `.screenshots/run.lock` and remove the lock only when that process has
exited. Do not run a manually launched copy of `Pudding Screenshots.app` during a
capture run (its single-instance behavior would prevent the runner connecting).

## Adding a scene

Add a recipe to `scenes.mjs` with a unique ID and explicit destinations, then
reference one of those assets from the relevant Markdown or Astro page. Each
recipe starts fresh: set up all of its own state rather than depending on the
previous scene. Prefer existing UI entry points; add a narrow named action to
the e2e bridge when needed. Use readiness predicates rather than long sleeps.

Animated visualizer scenes need a deterministic frame hook before they can join
this suite; CSS freezing alone does not stop canvas animation.
