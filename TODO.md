# TODO

## Mac App Store submission

Sandbox, entitlements, and bookmarked roots are done
(`apps/desktop/src-tauri/MAS-BUILD.md`); this is what is left.

### Distribution signing and packaging

- [ ] Register the explicit App ID `com.incompl.pudding` in the Apple Developer portal.
- [ ] Create a Mac App Store Connect provisioning profile for that App ID.
- [ ] Install a valid Mac App Distribution/Apple Distribution signing certificate on the release machine.
- [ ] Install a valid Mac Installer Distribution certificate on the release machine.
- [ ] Embed the provisioning profile as `Contents/embedded.provisionprofile` through the MAS Tauri configuration (`bundle.macOS.files`). (The distribution overlay is ready; add the account-specific profile.)
- [ ] Add `com.apple.application-identifier` and `com.apple.developer.team-identifier` to the distribution entitlements, using the real Team ID.
- [x] Update `apps/desktop/src-tauri/MAS-BUILD.md` to reflect Tauri's current provisioning-profile support and the complete release procedure.
- [ ] Produce a distribution-signed `.app`, package it as a signed `.pkg` with `productbuild`, and validate it before upload.
- [ ] Confirm that App Store Connect accepts the hardened-runtime signature (`flags=0x10002`) on the first upload.
- [ ] Run release builds from a clean checkout or clean Cargo target directory so stale generated Tauri paths cannot break the build.

### Bundle metadata and compatibility

- [x] Set `bundle.category` to `Music` in `apps/desktop/src-tauri/tauri.conf.json` and use the matching App Store Connect category.
- [x] Complete the export-compliance determination for the app's HTTPS/TLS use. Use the exempt standard-TLS declaration and exclude France from the initial storefronts.
- [x] If the app uses only exempt encryption, add `ITSAppUsesNonExemptEncryption = false` to `apps/desktop/src-tauri/Info.plist`.
- [x] Choose the supported Mac architecture policy: ship a universal Apple Silicon/Intel build.
- [x] Apple Silicon-only minimum-version work is not applicable to the universal build.
- [x] Use sequential integer build numbers, starting with `CFBundleVersion = 1`, and increment for every upload.

### In-app review readiness

- [x] Add a direct, easily accessible **Privacy Policy** item to the Help menu, linking to <https://puddingisgood.com/privacy/>.
- [x] Add a prominent **Choose Music Folder** action directly to the first-run empty state.
- [x] Surface the bundled, owned sample track as a **Play Sample** action on first run.
- [x] Decided against seeding radio stations on first run. It was the only item
      gated on a third party answering an email, and it bought little: the stream
      list is already created empty-but-valid, and the review notes already walk
      the reviewer through pasting a URL. Not worth the 2.1 exposure or the
      licensing dependency on the critical path.
- [x] Write App Review notes with explicit steps for testing local playback, radio URLs, tag editing, playlists, and sandbox folder access.
- [ ] Verify every external link from a clean release build. (All current endpoints returned HTTP 200 on 2026-09-17; the signed-build click test remains.)
- [ ] Run a final sandbox smoke test on the distribution-signed app, including bookmark restoration after relaunch.
- [ ] Run a final TestFlight pass on the latest supported macOS release and on every supported CPU architecture.

### Data safety and user messaging

- [ ] Journal each track's complete pre-write tag (every `items()` entry, plus
      the picture only when `picture_digest` says it changed) to the library DB
      before the first write of a batch, and offer Undo on the last N batches.
      Bounded by batch count, not by disk. Restore re-applies through
      `write_one_file`, so it inherits the staged-write atomicity and can never
      touch the audio stream. Rejected: whole-file backups — lofty rewrites the
      whole file, so a retained APFS clone holds the original's blocks alive and
      costs 2x per tagged file, and `clonefile` is same-volume only, which would
      force the copies to live inside the user's music folder.
- [ ] Validate staged audio before replacing the original: probe the staged file
      with symphonia (already a dependency) and pull one packet, immediately
      before the `fs::rename` in `write_one_file` — the same point
      `write_atomic_checked` exposes as `before_replace`. Probe only, never a full
      decode, or a 500-track batch becomes a full library decode. Validate
      *relatively*: symphonia is built here for mp3/aac/flac/alac/vorbis/isomp4/ogg
      while lofty also tags WAV, AIFF, APE and WavPack, so the rule is “if the
      original probed, the staged copy must probe too” — an absolute check would
      refuse to save tags on every format symphonia can't read.
- [ ] Move deleted playlists to Trash instead of permanently unlinking them
      (`playlist.rs`, the `remove_file` in `delete_playlist`). Deleting a playlist
      is the only irreversible destructive action in the app. No new dependency
      needed: objc2 is already in the tree for MediaPlayer, so
      `NSFileManager.trashItemAtURL:resultingItemURL:error:` is a short call and
      works under the sandbox for files we already have access to. Leave the
      `remove_file` in the rename path alone — that one is a move, not a delete.
- [x] Decided against a warning before metadata editing or batch edits. The count
      is already the confirmation and is on screen from the first frame (“Editing
      47 tracks”, see the heading in `editors.ts`); a count catches the error that
      actually happens — the wrong selection — where a generic risk warning only
      trains people to click through. Apple doesn't require it, the documentation
      already carries the honest version, and once the tag undo journal lands the
      warning would be warning about something reversible.
- [x] Audited user-facing copy for claims such as “completely safe” or “cannot
      damage your files” (2026-09-17: app strings, `index.html`, README, website
      content, review notes). No overclaim found; the metadata-editing section of
      the documentation is already hedged correctly. Re-grep before submission.

### App Store product assets

- [ ] Create at least one Mac App Store screenshot at an accepted 16:10 size: 1280x800, 1440x900, 2560x1600, or 2880x1800.
- [ ] Prefer a complete 5-7 screenshot set covering the library, search/navigation, queue/playlists, tag editing, radio, equalizer/visualizer, and mini player.
- [ ] Make the screenshots and description clearly communicate how Pudding differs from other music players (4.3) — not just the README.
- [ ] Confirm the final app icon renders correctly in the uploaded build and App Store Connect.

### App Store Connect

- [ ] Create the macOS app record before uploading the first build.
- [ ] Enter the app name, subtitle, description, keywords, copyright, SKU, primary language, and matching Music category.
- [ ] Complete the content-rights declaration.
- [ ] Complete Apple's current age-rating questionnaire.
- [ ] Declare **No data collected** under App Privacy while the app's current data practices remain unchanged.
- [ ] Enter the privacy policy URL: <https://puddingisgood.com/privacy/>.
- [ ] Enter the support URL and support email: <https://puddingisgood.com/support/> and `pudding@incompl.com`.
- [ ] Enter the marketing URL: <https://puddingisgood.com/>.
- [ ] Set pricing, tax category, storefront availability (exclude France initially), and release method.
- [ ] Complete and verify DSA trader status if distributing in the European Union.
- [ ] Enter complete App Review contact information and the detailed review notes.
- [ ] Upload the signed `.pkg`, resolve all processing warnings, and select the processed build for the version.
- [ ] Complete any export-compliance questions or attach required documentation.
- [ ] Optionally audit accessibility and publish accurate Accessibility Nutrition Labels.

## Desktop app fixes

Decided: files and folders opened from outside the library are not restored
across launches, so nothing outside a library root ever mints a bookmark.

- [ ] Re-eviction never restores “(Not downloaded)”: `downloadedPaths`
      (`apps/desktop/src/state.ts`) is add-only for the session, so a file the OS
      evicts back to the cloud after we downloaded it keeps its downloaded look
      until relaunch. Clear the whole set when a full scan completes rather than
      plumbing per-path re-eviction out of the scan's `was_dataless != dataless`
      refresh — the set exists only to override stale rows within a session, and
      after a scan the rows aren't stale. One line. The remaining race (a download
      completing mid-scan) is narrow and self-corrects on the next scan.
- [ ] Open Recent rows vanish under the cursor: `removeRecentItem` is called from
      every read-failure branch, so a row the user just clicked silently deletes
      itself with no explanation. The silence is the bug; the fix is a message,
      not a prune.
      Do NOT prune at hydrate on PermissionDenied, as previously written here:
      given the decision above, every out-of-library recent — the ⌘O and Finder
      “Open With” files the list exists for — comes back PermissionDenied on
      relaunch, so that rule would empty the list at every launch. The
      unplugged-drive case it meant to protect returns NotFound and survives by
      accident, not by design. Hydrate-time pruning also stats every path at
      launch, which can block on a sleeping network volume or spin up an external
      drive. It would also need error-kind plumbing that doesn't exist — the
      backend hands the frontend `e.to_string()`, so the kinds can't be told apart.
- [ ] Decide the question underneath that one: if out-of-library recents can never
      be reopened after relaunch, either opening a file should mint a bookmark
      (which contradicts the decision above) or those rows should draw as
      unreachable instead of pretending to be clickable.
