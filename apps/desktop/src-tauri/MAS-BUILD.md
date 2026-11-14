# Mac App Store build

Pudding keeps direct-distribution builds unsandboxed. The App Store settings are
layered on only for MAS builds:

- `tauri.mas.conf.json` enables the sandbox entitlements and produces an `.app`.
- `tauri.mas.distribution.conf.json` embeds the local provisioning profile at
  `Contents/embedded.provisionprofile` using Tauri's supported
  `bundle.macOS.files` mapping, and signs with `Entitlements.distribution.plist`
  instead of `Entitlements.plist`.

Two files are deliberately not committed, because both are specific to one Apple
Developer account:

- `src-tauri/AppStore.provisionprofile` — save the downloaded Mac App Store
  Connect profile there.
- `src-tauri/Entitlements.distribution.plist` — generated on every distribution
  build by `tools/gen-distribution-entitlements.sh` from `Entitlements.plist`
  plus `$TEAM_ID`, which adds the two identifier entitlements below. Nothing
  hand-edits `Entitlements.plist`, so the sandbox entitlements keep one source
  and `tools/sandbox-check.sh` keeps testing the same list the store build signs.

## Local sandbox check

An unsigned app has no enforced entitlements. Ad-hoc signing is enough to test
the sandbox locally without distribution credentials:

```sh
APPLE_SIGNING_IDENTITY=- pnpm build:mas
```

Then run the focused entitlement test:

```sh
apps/desktop/tools/sandbox-check.sh
```

This is a development check only. An ad-hoc signature and a build without an
embedded distribution profile cannot be uploaded to App Store Connect.

## One-time distribution setup

1. Register the explicit App ID `com.incompl.pudding` in Apple Developer.
2. Create and download a **Mac App Store Connect** provisioning profile for that
   App ID and the application signing certificate. Save it at
   `apps/desktop/src-tauri/AppStore.provisionprofile`.
3. Install an **Apple Distribution** (or legacy **3rd Party Mac Developer
   Application**) certificate and private key in the release keychain.
4. Install a **Mac Installer Distribution** (or legacy **3rd Party Mac Developer
   Installer**) certificate and private key.
5. The profile's App ID Prefix is the 10-character Team ID. `pnpm release`
   reads it out of the profile, so it does not have to be set anywhere; the
   generator turns it into `com.apple.developer.team-identifier = TEAM_ID` and
   `com.apple.application-identifier = TEAM_ID.com.incompl.pudding`. To inspect
   the result without building, pass it explicitly:

   ```sh
   TEAM_ID=ABCDE12345 apps/desktop/tools/gen-distribution-entitlements.sh
   ```
6. Install both Rust macOS targets used by the universal build:

   ```sh
   rustup target add aarch64-apple-darwin x86_64-apple-darwin
   ```

`pnpm release` finds both certificates itself, scoped to the profile's team, and
refuses to guess if it finds none or more than one. To see what is installed:

```sh
security find-identity -v              # includes the installer certificate
security find-identity -v -p codesigning
```

## Build the upload artifact

```sh
pnpm release          # build, verify, package
pnpm release --bump   # increment the build number first (every upload)
pnpm release --clean  # discard the release target dirs first
```

`tools/release-build.sh` is the whole path: it checks the profile, derives
`$TEAM_ID` from it, finds the two signing certificates for that team, runs
`build:mas:distribution`, proves the result, and packages it. Nothing has to be
set in the environment — `TEAM_ID`, `APPLE_SIGNING_IDENTITY` and
`INSTALLER_SIGNING_IDENTITY` are honoured if set, and a `TEAM_ID` that disagrees
with the profile is an error rather than a silent override.

It verifies the app that was built rather than the config meant to produce it,
and fails on anything that would be rejected or would ship wrong: a missing or
stale `embedded.provisionprofile`, a signature from the wrong identity,
entitlements that differ from `Entitlements.plist` plus the two identifier keys
(a lost sandbox is called out on its own, being the one loss that would sign,
upload and run), a binary that is not both `arm64` and `x86_64`, a wrong
category or version, and any document type whose `LSHandlerRank` came out
`Default` — which would seize mp3 from Music on a user's first launch.

The first run on a machine raises a keychain prompt for each signing key, one
for the application certificate and one for the installer certificate. Answer
both with **Always Allow**, not Allow: plain Allow authorises a single use and
prompts again on the next build. An unanswered prompt does not fail — signing
blocks inside CMS with no message and no timeout, which looks exactly like a
slow link step, and stays that way if the dialog was dismissed or the
SecurityAgent drawing it got orphaned (`pkill -9 SecurityAgent` clears that;
macOS respawns it). The script probes both keys before building so this surfaces
in the first seconds rather than after a full universal compile. To authorise
the keys once, without any prompt, run this yourself — it asks for the login
keychain password:

```sh
security set-key-partition-list \
  -S apple-tool:,apple:,codesign: -s \
  ~/Library/Keychains/login.keychain-db
```

Use a clean checkout or `--clean` for every upload. Pudding uses sequential
integer build numbers: `bundle.macOS.bundleVersion` starts at `1` and must be
incremented before every upload, including replacements for the same marketing
version. App Store Connect will reject a reused build number. `--bump`
increments it; commit that change with the release.

The outputs are:

```text
apps/desktop/src-tauri/target/universal-apple-darwin/release/bundle/macos/Pudding.app
apps/desktop/src-tauri/target/universal-apple-darwin/release/bundle/macos/Pudding.pkg
```

The `.pkg` is signed with the installer identity, not the application identity.
Tauri's current macOS bundler copies custom `bundle.macOS.files` into the app's
`Contents` directory, so no manual post-bundle profile copy or re-sign step is
needed; doing either after Tauri signs would invalidate the signature.

To inspect a built app by hand:

```sh
APP_PATH="apps/desktop/src-tauri/target/universal-apple-darwin/release/bundle/macos/Pudding.app"
codesign -dvvv "$APP_PATH"
codesign -d --entitlements - --xml "$APP_PATH" | plutil -p -
lipo -archs "$APP_PATH/Contents/MacOS/pudding"
plutil -p "$APP_PATH/Contents/Info.plist"
```

Upload the signed package with Transporter or `xcrun altool`, wait for processing,
then select the processed build in App Store Connect. On the first upload, record
whether App Store Connect accepts the hardened-runtime signature or reports a
validation warning.

For the initial release, exclude France from storefront availability. Pudding's
only encryption is published, industry-standard TLS for user-directed HTTPS
connections, implemented by the bundled Rust TLS provider. The app declares
`ITSAppUsesNonExemptEncryption = false`; excluding France avoids the separate
French declaration Apple lists for standard encryption implemented outside the
Apple operating system. Revisit the declaration before enabling France.

## Release smoke test

Test the exact distribution-signed app before upload:

Install the package the way the store would, rather than copying the app by
hand (`pnpm release --install` does this, and asks for sudo):

```sh
sudo installer -store -pkg \
  apps/desktop/src-tauri/target/universal-apple-darwin/release/bundle/macos/Pudding.pkg \
  -target /
```

Then work through section 15 of `apps/desktop/test-plan.md`:

1. Launch with a fresh app-data container.
2. Play the bundled sample.
3. Choose a music folder and confirm it scans.
4. Play a local track, edit tags, and create/edit a playlist.
5. Add and play a radio URL.
6. Quit and relaunch; confirm the chosen folder is still readable through its
   restored security-scoped bookmark.
7. Repeat on every CPU architecture and supported macOS release, then run the
   same pass against the processed TestFlight build.

References: [Tauri App Store guide](https://v2.tauri.app/distribute/app-store/)
and [Tauri macOS bundle files](https://v2.tauri.app/distribute/macos-application-bundle/#adding-custom-files).
