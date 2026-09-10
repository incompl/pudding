# TODO

Mac App Store readiness. Sandbox, entitlements, and bookmarked roots are done
(`src-tauri/MAS-BUILD.md`); this is what is left.

## First run has nothing to play (2.1)

- [ ] Seed a few radio stations on first run — get a written OK by email, quote it in the review notes
- [ ] Bundle a short sample track we own, surfaced as "Play a sample" in the empty state
- [ ] Replace the empty-state sentence with a real first-run panel and a prominent "Choose your music folder" button
- [ ] Write the App Review Notes with explicit test steps

## Store metadata and signing

- [ ] Privacy policy URL (required even though we collect nothing)
- [ ] Support URL
- [ ] MAS signing: 3rd Party Mac Developer identity + embedded provisioning profile, which Tauri's bundler will not do for us
- [ ] Confirm App Store Connect accepts the hardened runtime flag (`flags=0x10002`) at the first upload
- [ ] Make sure the differentiation lands in the screenshots and description, not just the README (4.3)

## Smaller

Decided: files and folders opened from outside the library are not restored
across launches, so nothing outside a library root ever mints a bookmark.

- [ ] Re-eviction never restores "(Not downloaded)": `downloadedPaths` (src/state.ts) is add-only for the session, so a file the OS evicts back to the cloud after we downloaded it keeps its downloaded look until relaunch. Clear the path there on the scan's `was_dataless != dataless` refresh
- [ ] Drop unreachable Open Recent entries in `hydrateRecentItems` instead of letting them silently delete themselves on click — prune on PermissionDenied only, so an unplugged drive keeps its rows
