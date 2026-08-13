---
name: drive
description: Drive the live Pudding app to test a change — play tracks, click the real UI, and read back real engine + DOM state. Use when asked to run, exercise, reproduce a bug in, or manually verify behavior in the actual app (not just typecheck/unit tests).
---

# Drive the Pudding app

Pudding is a Tauri app. Its WKWebView DOM is **not** in the macOS accessibility
tree, so native drivers (Appium/XCUITest) can't see it. Instead we talk to the
webview's built-in e2e bridge (`src/e2e-bridge.ts`) over a loopback WebSocket.

`e2e/drive.mjs` is a **persistent driver daemon**: it holds that bridge open and
exposes a small HTTP control API, so you drive the running app one command at a
time with `curl` and read live state back — real Rust engine, real audio, real
DOM. This is the convenient interactive path; `pnpm e2e` (batch `.test.ts`) is
for committed regression tests.

## Start it (once per session)

Run the daemon as a **background** Bash job, then poll until the webview dials in:

```bash
node e2e/drive.mjs --dev        # launches `tauri dev` (HMR) + attaches — best for frontend work
```

Then poll health (the app needs a few seconds; a cold Rust compile longer):

```bash
for i in $(seq 1 45); do
  curl -s --max-time 2 localhost:9011/health | grep -q '"connected":true' && { echo up; break; }
  sleep 2
done
```

`--dev` gives Vite HMR: after editing frontend TS the bridge reconnects on its
own — no rebuild, just drive again. For a Rust change or an exact-artifact check,
use `--bundle` instead (run `pnpm build:e2e` first to refresh the bundle).

## Drive it

Control API on `http://localhost:9011` (WS bridge on 9010):

```bash
curl -s localhost:9011/health                                   # {connected: bool}
curl -s localhost:9011/probe                                    # live playback/engine state (JSON)
curl -s 'localhost:9011/exists?selector=%23play-pause-btn'      # #id must be URL-encoded (%23 = #)
curl -s 'localhost:9011/click?selector=%23play-pause-btn'       # click a real DOM element
curl -s 'localhost:9011/text?selector=%23np-title'              # textContent
curl -s 'localhost:9011/action?name=playFile&arg=/abs/path.m4a' # a named frontend entry point
curl -s localhost:9011/cmd -d '{"cmd":"invoke","args":{"name":"some_tauri_cmd","payload":{}}}'
```

- **`/action`** triggers a real UI code path (registered in `maybeStartE2eBridge`
  near the bottom of `src/main.ts`) — prefer this over reaching past the UI.
  `arg` is parsed as JSON if it can be, else passed as a string. Current actions:
  `playFile`, `playPlaylist`, `playPaths`, `addToQueue`, `setAutoadvance`,
  `dragRow`. Add more there when a flow needs a real entry point.
- **`/probe`** returns the signals exposed by the probe in `main.ts`: `isPlaying`,
  `hasTrack`, `title`, `currentTime`, `duration`, `queuePlayingIndex`,
  `queueIsActivePool`, `queueLength`, `shuffle`, `repeat`, `autoadvance*`, etc.
- **`/cmd`** is the generic escape hatch for any bridge verb
  (`click|text|attr|prop|exists|invoke|action|probe`) with full args.

Assert by polling `/probe` (engine state settles asynchronously via `audio:*`
events → signals → DOM). Fixtures live in `e2e/fixtures/` (`tone*.m4a`).

## Stop it

Kill the background daemon job — its `--dev`/`--bundle` child process group
(vite, cargo, the app window) is torn down with it.

## Notes

- Selectors are pure `#id` against the real DOM — never text/labels.
- `curl -s localhost:9011/screenshot -o shot.png` grabs the screen, but macOS
  Screen Recording permission for the shell is usually **not** granted here, so
  it often fails ("could not create image from display"). The probe is the
  primary way to observe state — don't rely on screenshots.
- Ports override via `PUDDING_E2E_PORT` (WS, default 9010) and
  `PUDDING_DRIVE_PORT` (control, default WS+1).
