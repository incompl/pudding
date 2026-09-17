# Mac App Store build

Pudding keeps direct-distribution builds unsandboxed. The App Store settings are
layered on only for MAS builds:

- `tauri.mas.conf.json` enables the sandbox entitlements and produces an `.app`.
- `tauri.mas.distribution.conf.json` embeds the local provisioning profile at
  `Contents/embedded.provisionprofile` using Tauri's supported
  `bundle.macOS.files` mapping.

The provisioning profile is deliberately not committed. Save the downloaded
Mac App Store Connect profile as `src-tauri/AppStore.provisionprofile`; that path
is ignored by Git.

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
5. Put the profile's App ID Prefix in `Entitlements.plist` as both:
   `com.apple.developer.team-identifier = TEAM_ID` and
   `com.apple.application-identifier = TEAM_ID.com.incompl.pudding`.
6. Install both Rust macOS targets used by the universal build:

   ```sh
   rustup target add aarch64-apple-darwin x86_64-apple-darwin
   ```

List the usable identities before building:

```sh
security find-identity -v -p codesigning
```

Tauri's current macOS bundler copies custom `bundle.macOS.files` into the app's
`Contents` directory. No manual post-bundle profile copy or re-sign step is
needed; doing either after Tauri signs would invalidate the signature.

## Build the upload artifact

Use a clean checkout or a fresh Cargo target directory for every upload. Pudding
uses sequential integer build numbers: `bundle.macOS.bundleVersion` starts at
`1` and must be incremented before every upload, including replacements for the
same marketing version. App Store Connect will reject a reused build number.

From the repository root:

```sh
APPLE_SIGNING_IDENTITY="Apple Distribution: YOUR NAME (TEAM_ID)" \
  pnpm build:mas:distribution
```

The distribution script targets `universal-apple-darwin`, merges both MAS
overlays, embeds the profile, signs with the distribution identity, and emits:

```text
apps/desktop/src-tauri/target/universal-apple-darwin/release/bundle/macos/Pudding.app
```

Set convenient shell variables for the following verification commands:

```sh
APP_PATH="apps/desktop/src-tauri/target/universal-apple-darwin/release/bundle/macos/Pudding.app"
PKG_PATH="apps/desktop/src-tauri/target/universal-apple-darwin/release/bundle/macos/Pudding.pkg"
```

Verify the bundle before packaging it:

```sh
test -f "$APP_PATH/Contents/embedded.provisionprofile"
codesign --verify --deep --strict --verbose=2 "$APP_PATH"
codesign -d --entitlements - "$APP_PATH"
codesign -dvvv "$APP_PATH"
lipo -archs "$APP_PATH/Contents/MacOS/pudding"
plutil -p "$APP_PATH/Contents/Info.plist"
```

The checks should show both `arm64` and `x86_64`, the sandbox/file/network
entitlements plus the application/team identifiers, `LSApplicationCategoryType`
set to Music, a unique `CFBundleVersion`, and the expected hardened-runtime
signature flags.

Package the app with the installer identity (not the application identity):

```sh
xcrun productbuild \
  --sign "Mac Installer Distribution: YOUR NAME (TEAM_ID)" \
  --component "$APP_PATH" /Applications \
  "$PKG_PATH"

pkgutil --check-signature "$PKG_PATH"
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
