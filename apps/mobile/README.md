# Pudding Mobile

Pudding's internet radio for iPhone: play, add, edit, reorder, remove and search
stations.

## Shape

- **UI is HTML/CSS/TypeScript** (`src/`, built by Vite), written in the same
  vanilla-DOM style as desktop so the two can share assets.
- **The shell is a thin native Swift app** (`ios/`): one `WKWebView`, plus small
  native pieces for whatever the web layer can't do well. There's no Tauri or
  Rust on mobile. Desktop needs Rust for decoding local files, and the radio-only
  app doesn't.
- **Audio will be native** (`AVPlayer`), not `<audio>` in the web view, because
  background play, lock-screen controls, AirPlay and call interruptions all need
  the system audio session.
- **Stations are app settings** stored natively, not a portable M3U file like
  desktop's stream list.

Libraries and frameworks get added when the code in hand needs them, not ahead
of time.

## Running

```sh
pnpm sim          # build the web layer, bundle it, run in the iOS Simulator
pnpm dev          # Vite dev server on :5174, then in another terminal:
pnpm sim:dev      # run the app against the dev server (reload to see edits)
```

Needs Xcode with an iOS simulator runtime (`xcodebuild -downloadPlatform iOS`).
`PUDDING_SIM=<name or UDID>` picks a specific simulator. Debug builds are
inspectable from Safari ▸ Develop ▸ Simulator.

## How the pieces connect

- `ios/PuddingMobile/` is an Xcode folder-synced group: Swift files dropped in
  are compiled without editing `project.pbxproj`.
- The **Bundle web build** phase copies `dist/` into the app as `web/`, and
  `BundleSchemeHandler` serves it at `pudding://app/`. A custom scheme rather
  than `file://`, because WebKit gives `file://` pages an opaque origin and
  Vite's module scripts then fail CORS.
- `ios/Info.plist` holds only keys that build settings can't express. It's
  merged into the generated Info.plist.
