# Pudding Mobile

Pudding's internet radio for iPhone: play, add, edit, reorder, remove and search
stations.

## Shape

- **A native SwiftUI app** (`ios/`). There's no Tauri or Rust on mobile.
  Desktop needs Rust for decoding local files, and the radio-only app doesn't.
- **Audio is AVPlayer** (`Player.swift`), on the system audio session, which
  gives background play, lock-screen controls, AirPlay and call interruptions.
- **Stations are app settings** stored natively, not a portable M3U file like
  desktop's stream list. A fresh install seeds them from desktop's defaults
  (`packages/lib/default-streams.m3u8`).

Libraries and frameworks get added when the code in hand needs them, not ahead
of time.

## Running

```sh
pnpm sim          # build and run in the iOS Simulator
```

Needs Xcode with an iOS simulator runtime (`xcodebuild -downloadPlatform iOS`).
`PUDDING_SIM=<name or UDID>` picks a specific simulator.

## How the pieces connect

- `ios/PuddingMobile/` is an Xcode folder-synced group: Swift files dropped in
  are compiled without editing `project.pbxproj`.
- The **Bundle default stations** phase copies
  `packages/lib/default-streams.m3u8` into the app for `Stations.swift` to seed
  from.
- `ios/Info.plist` holds only keys that build settings can't express. It's
  merged into the generated Info.plist.
