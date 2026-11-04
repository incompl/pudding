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

The exception is native UI that has no DOM to talk to — an alert — which is
driven through the accessibility tree after all. See [Native
dialogs](#native-dialogs).

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

Selectors are pure `#id` against the real DOM — never text/labels. The one
exception is `clickPanelButton`: a tag-operation panel's buttons carry no ids and
share two classes between them, so the label is all that tells them apart. It
throws naming the labels it did find, because the alternative — an index —
silently presses Discard when a label changes.

## Native dialogs

A flow gated by a native confirmation is drivable: `driver.answerDialogs("Ok" |
"Cancel" | null)` answers the app's message and confirm dialogs without one
appearing, and `driver.dialogs()` reads back the title, message and kind of each
one it answered. That matters because the harness has no way to dismiss an
NSAlert, and a modal left standing outlives the test that raised it.

It is answered at the IPC transport, which is lower than it looks like it should
be. The obvious seam — `window.__TAURI_INTERNALS__.invoke` — cannot be taken:
Tauri defines the internals object and every method on it with a bare
`Object.defineProperty`, so each is non-writable *and* non-configurable and
assigning to one throws `Attempted to assign to readonly property`. Underneath
it, on macOS, is the custom protocol: a `fetch` to `ipc://localhost/<command>`
whose response the IPC script turns back into the invoke's resolution.
`window.fetch` is an ordinary writable global, so the stub wraps it, answers
`plugin:dialog|message` from a synthetic `Response`, and passes everything else
straight through.

The app's own code is untouched by this, which is the point: the title and
message a test reads back are the ones the app really handed the plugin. A
`confirmFn` threaded through the app for the tests' benefit would instead weaken
the confirmations it exists to assert on.

It is installed only while a test asks for it, and it answers *every* message
dialog while it is — so assert on what `dialogs()` captured rather than assuming
which one was caught.

What the stub cannot tell you is that an alert appears at all, or that its own
buttons answer it. That is what `native-ui.ts` is for, and it is the mirror image
of the problem at the top of this file: an alert has no DOM, and it *is* in the
accessibility tree, so it is driven through System Events — read its title,
message and buttons, press one, or dismiss it with Escape. The plugin parents the
dialog to the webview window, so it comes up as a *sheet* and does not block the
main thread: the bridge stays live and a test can assert on the DOM underneath
while it is up. Address the app by `harness.pid`, never by process name — the
e2e bundle's executable is called `pudding` exactly like the shipping one.

Reading another process's UI needs two grants the developer has to give
(Automation → System Events for whatever runs the tests, and Accessibility for
System Events), so a suite built on it would not run on a fresh machine or in
CI. Exactly one test uses it, for the one claim nothing else can make, and
`unavailableReason()` is how it skips rather than fails where the grants are
missing. Keep it that way: everything else belongs on the bridge.

## The e2e build

Production CSP (`connect-src 'self' ipc: http://ipc.localhost`) blocks the
loopback WebSocket, and we don't weaken it. `src-tauri/tauri.e2e.conf.json`
overrides *only* the CSP to also allow `ws://127.0.0.1:*`, and `build:e2e`
builds a debug bundle with it merged in. Production builds are untouched.

`build:e2e` merges a second override, `src-tauri/tauri.e2e.bundle.conf.json`,
which gives the bundle its own name and identity (`Pudding E2E` /
`com.incompl.pudding.e2e`). That's not cosmetic: `tauri-plugin-single-instance`
keys on the bundle identifier, so a test bundle sharing the shipping one hands
its argv to whatever Pudding is already open and exits **0** without ever
dialing in — every test then fails with "app exited before connecting", naming
nothing. A separate identifier means the suite runs with your own Pudding open.
The identity lives in its own file rather than in the CSP override because
`drive.mjs --dev` merges that override too, and an identifier of its own would
hand interactive driving (and `pnpm caliper`) a fresh, empty app-data profile
instead of your configured library. The same split is why the screenshot runner
has `tauri.screenshots.conf.json` — the bundle it builds is isolated the same
way, one identifier further out.

The flip side: the suite's app-data profile is its own, so tests set up whatever
state they need (see the `PUDDING_E2E_DATA_DIR` env in `playlist-integrity`) and
never read your library. `pnpm drive --dev` keeps the shipping identifier, so it
still needs your own Pudding quit before it can launch.

## Running

```bash
pnpm build:e2e     # debug .app with the e2e CSP (rebuild after Rust/frontend changes)
pnpm test:e2e      # run the suite against that bundle
pnpm e2e           # both, in sequence
```

The harness spawns the built binary directly (so `PUDDING_E2E_PORT` reaches it)
and waits for the webview to connect. Overrides:

- `PUDDING_E2E_APP=/path/to/Pudding.app/Contents/MacOS/pudding` — drive a
  release bundle instead of the debug one. A bundle built without the identity
  override above is subject to the single-instance no-op described there.
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

Most suites launch the app once per file (`before`/`after`). A test about
something that happens *during* startup can't: the state has to be on disk before
`setup()` runs, and `setup()` runs once per process. `startPlanted` in
`tag-editing.ts` is the two halves apart — populate a throwaway profile, then
launch on it — and `metadata-recovery.test.ts` is the suite that needs it, with
its own launch per case. Pair it with `cleanPlants` on the way out: two of the
plant flags leave the filesystem refusing writes (`--stick` sets `uchg` on the
copy, `--lock-folder` takes the recovery directory to mode 500) and neither
yields to `fs.rm`, `force` or not.

## Website and documentation captures

`pnpm screenshots:update` reuses this harness and the existing screenshot library
generator to capture repeatable native app images. See
[the capture workflow](screenshots/README.md). The screenshot runner passes an
explicit bundle, an ephemeral port, and a fresh profile; ordinary e2e defaults
remain unchanged.
