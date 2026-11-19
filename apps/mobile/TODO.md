# Pudding Mobile TODO

From the first full review (2026-11-18). Ordered by how likely each is to bite.

## Bugs

- [ ] **No resume after a call or Siri (probable).** `Player.timeControlChanged`
      turns any `.paused` into `stop()`. On an interruption the system pauses
      AVPlayer and posts the interruption notification; both hop to the main
      actor in no guaranteed order. If the pause lands first, `interrupted(.began)`
      sees `.stopped`, `wasPlaying` is false, and nothing resumes. The same race
      can hide a stream error: `stop()` clears `itemStatus` before the failed-item
      callback, so the station shows plain stopped. Fix: handle headphones
      unplugged through `AVAudioSession.routeChangeNotification`
      (`.oldDeviceUnavailable`) and stop inferring it from `.paused`. Verify on a
      device: play, trigger Siri or call the phone.
- [ ] **Store can lose the player.** `StationStore.init()` sets
      `Player.shared.onChange`, and `@State var store = StationStore()` re-runs
      that init whenever `StationList` is re-created (only the first instance is
      kept). A throwaway store overwrites `onChange` with a dead weak ref and the
      real one stops updating. Latent today (root view). Fix: make `Player`
      `@Observable` and read `Player.shared.state` directly; drop `onChange`.
- [ ] **Decode failure wipes stations.** `Stations.load()` reseeds and saves
      defaults when decoding fails, so a future required field on `Station`
      replaces everyone's list. Reseed only when the key is missing; on a decode
      failure, leave the stored data alone.
- [ ] **Stale item failure can kill the next station.** The `itemStatus`
      observer hops to `fail()` without checking the item is still current.
      Guard with `player.currentItem === item`, like `streamTitle` checks
      `self.stream === source`.

## Improvements

- [ ] **Give audio back to other apps.** `stop()` never calls
      `setActive(false, options: .notifyOthersOnDeactivation)`, so a paused
      podcast doesn't resume when the radio stops.
- [ ] **http stations.** `StationForm` accepts `http://`, then ATS blocks it
      with Apple's error text. Under the https-only decision, either reject http
      in the form with a clear message or translate the ATS error.
- [ ] **Playlist fetch timeout.** `StreamURL.resolve` uses
      `URLSession.shared` (60s default), so a slow .pls host shows
      "Connecting…" for a minute. Use ~10s.
- [ ] **Station identity in one place.** The name + URL match is repeated in
      `StationRow.isActive`, `StationStore.open` and `StationStore.update`;
      put it in a helper on `Station`.
- [ ] **Accessibility.** Rows use `.onTapGesture`, so VoiceOver doesn't call
      them buttons (`.accessibilityAddTraits(.isButton)`). Fonts are fixed
      `.system(size:)`, so Dynamic Type doesn't scale anything; decide whether
      that's deliberate.
- [ ] **App icon.** No asset catalog or icon yet; needed before TestFlight.

## Minor

- [ ] `ImageCache` keeps full-size logos in an unbounded `NSCache` and refetches
      failed URLs on every row appearance. Fine at ~20 stations.
- [ ] Now Playing's edge swipe fires on a threshold rather than tracking the
      finger, so it feels unlike the system back gesture.
