# The sandboxed (Mac App Store) build

`tauri.conf.json` is deliberately **not** sandboxed. `pnpm dev`, `pnpm tauri dev`
and a plain `tauri build` all produce an unsandboxed app, which is what direct
distribution wants: the sandbox is a store requirement, not a security feature we
owe users who downloaded a release from GitHub, and turning it on there would cost
them file access in exchange for nothing.

The sandbox is an overlay instead:

```sh
APPLE_SIGNING_IDENTITY=- pnpm build:mas
```

`src-tauri/tauri.mas.conf.json` adds `bundle.macOS.entitlements`, pointing at
`src-tauri/Entitlements.plist`, and narrows the bundle targets to `app` (a `.dmg`
is meaningless for the store; the store artifact is a `.pkg` built from the `.app`
with `productbuild`).

## Why the signing identity is not in the config

Entitlements are code-signature flags. An unsigned bundle carries none of them, so
**an unsigned MAS build is not sandboxed** — it will run, and it will look like it
works, which is the failure mode to watch for. `APPLE_SIGNING_IDENTITY=-` signs
ad-hoc, which is enough to make the kernel enforce the sandbox locally and is the
cheapest way to actually try the sandboxed app on this machine.

A real submission uses a `3rd Party Mac Developer Application` identity and needs a
provisioning profile embedded at `Contents/embedded.provisionprofile`. Tauri's
bundler does not do that step; see the signing bullet in `TODO.md`.

## Verifying

`tools/sandbox-check.sh` is the real test. It signs a small bundle with these same
entitlements, proves the sandbox is enforcing, and then proves each entitlement is
load-bearing by stripping it and showing the corresponding capability disappear.

To confirm the shipped app got them:

```sh
codesign -d --entitlements - "src-tauri/target/release/bundle/macos/Pudding.app"
```

If that prints nothing, the build was not signed and nothing above applies.
