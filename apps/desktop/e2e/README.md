# e2e: dev-only test bridge

Full-stack e2e that drives the **real** app — real Rust audio engine, real
`cpal` output, real Now Playing, real DOM — and asserts the UI matches engine
state. It exists to catch playback-state-vs-UI mismatches, which neither
frontend-only tools (no real engine) nor native drivers can catch here.

## Why not a native driver (Appium/XCUITest)?

A Tauri app's WKWebView does **not** expose its DOM to the macOS accessibility
tree, so XCUITest/Appium mac2 can drive the native menu bar but see nothing
inside the webview. And even where web content is exposed, XCUITest forbids
selecting web elements by id (label/value only). So we talk to the webview
directly instead.

## How it works

```
 node test  <──WebSocket──>  webview (src/e2e-bridge.ts)  ──invoke/engine──>  Rust
 (harness.ts)                 real DOM + signals                              real audio
```

- The harness (`harness.ts`) is a WebSocket **server**; the webview can only
  dial out, so it's the client.
- On launch with `PUDDING_E2E_PORT` set (surfaced by the `e2e_port` Tauri
  command), `src/e2e-bridge.ts` connects back and services commands: query the
  DOM by `#id`, read live playback signals (`probe`), passthrough a Tauri
  command (`invoke`), or trigger a real frontend entry point (`action`).
- In normal runs `e2e_port` returns null and the bridge is completely inert.

Selectors are pure `#id` against the real DOM — never text/labels.

## The e2e build

Production CSP (`connect-src 'self' ipc: http://ipc.localhost`) blocks the
loopback WebSocket, and we don't weaken it. `src-tauri/tauri.e2e.conf.json`
overrides *only* the CSP to also allow `ws://127.0.0.1:*`, and `build:e2e`
builds a debug bundle with it merged in. Production builds are untouched.

## Running

```bash
pnpm build:e2e     # debug .app with the e2e CSP (rebuild after Rust/frontend changes)
pnpm test:e2e      # run the suite against that bundle
pnpm e2e           # both, in sequence
```

The harness spawns the built binary directly (so `PUDDING_E2E_PORT` reaches it)
and waits for the webview to connect. Overrides:

- `PUDDING_E2E_APP=/path/to/Pudding.app/Contents/MacOS/pudding` — drive a
  release bundle instead of the debug one.
- `PUDDING_E2E_NO_SPAWN=1` — don't launch; attach to an app you started with the
  same `PUDDING_E2E_PORT` (handy with `pnpm tauri dev`).
- `PUDDING_E2E_PORT` — WebSocket port (default 9010).

## Interactive driving (`drive.mjs`)

The suite above is batch (one `.test.ts` run per slow bundle build). For
*interactive* poking of a live app — play a track, click the real UI, read state
back one command at a time — use the persistent driver daemon:

```bash
pnpm drive              # = node e2e/drive.mjs --dev : tauri dev (HMR) + attach
# or: node e2e/drive.mjs --bundle   (drive the built .app; run build:e2e first)
# or: node e2e/drive.mjs            (attach to an app you started yourself)
```

It holds the same webview bridge open and exposes an HTTP control API on
`:9011`, so you drive with `curl`:

```bash
curl -s localhost:9011/health                                    # {connected: bool}
curl -s localhost:9011/probe                                     # live engine/UI state
curl -s 'localhost:9011/action?name=playFile&arg=/abs/tone.m4a'  # real UI entry point
curl -s 'localhost:9011/click?selector=%23play-pause-btn'        # click a #id (%23 = #)
curl -s localhost:9011/cmd -d '{"cmd":"invoke","args":{"name":"cmd","payload":{}}}'
```

With `--dev`, frontend edits hot-reload and the bridge reconnects — no rebuild.

## Fixtures

`fixtures/tone.m4a` — a ~5s stereo/44.1k AAC clip generated with macOS `say` +
`afconvert`. Stereo/44.1k matters: mono/22050 sources stall or panic the decode
pipeline (a real engine bug, separate from these tests).

## Adding a test

Use `#id` selectors and read state from `probe()`. To drive a UI flow, prefer a
real entry point via `action(...)` (registered in `maybeStartE2eBridge(...)` in
`src/main.ts`) over reaching past the UI with a raw `invoke`.
