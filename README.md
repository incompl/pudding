# Pudding

Independent music apps. Oldschool taste, newschool features.

- **[Pudding Desktop](apps/desktop/README.md)** — the macOS music player for local files and internet radio, built with Tauri, Rust, and TypeScript.
- **[Website](apps/website/README.md)** — the static Astro site introducing Pudding, live at [puddingisgood.com](https://puddingisgood.com).
- **Pudding Mobile** — planned as a separate radio-focused app with its own mobile UI. Its stack is undecided; there is no mobile implementation yet.

## Repository layout

```text
apps/
  desktop/    Desktop source, Rust crate, tests, scripts, and build configuration
  website/    Astro pages, styles, assets, and build configuration
```

Add `apps/mobile/` when development starts. Add `packages/<name>/` when there is
concrete code or data to share. Applications may consume shared packages but
should not import another application's source. Each app owns its dependencies,
UI, tests, and build output. Native mobile tooling can coexist with the JavaScript
workspace; choosing pnpm does not choose the mobile stack.

The root is a private pnpm workspace with one JavaScript lockfile. The desktop
Rust crate keeps its own Cargo manifest and lockfile under `apps/desktop/src-tauri`.

## Development

Use Node.js 24 (see `.node-version`) and pnpm 10.20.0 (pinned in `package.json`).
Desktop builds also need Rust and the platform prerequisites for Tauri.

```sh
pnpm install
pnpm website:dev       # Static site at http://localhost:4321
pnpm desktop:dev       # Native desktop app with frontend hot reload
```

Run these from the repository root:

| Command | Purpose |
| --- | --- |
| `pnpm desktop:dev` | Start the desktop app through Tauri |
| `pnpm desktop:build` | Build and bundle the desktop app |
| `pnpm desktop:test` | Typecheck and run desktop frontend unit tests |
| `pnpm website:dev` | Start the Astro development server |
| `pnpm website:check` | Check Astro and TypeScript |
| `pnpm website:build` | Generate the static site in `apps/website/dist/` |
| `pnpm website:preview` | Serve the built site locally |
| `pnpm check` | Check both applications' frontend types |

Existing root commands such as `pnpm dev`, `pnpm build`, `pnpm tauri dev`,
`pnpm build:mas`, `pnpm e2e`, `pnpm drive`, and `pnpm caliper` still forward to
Desktop. In particular, `pnpm dev` starts only the desktop Vite server and
`pnpm build` builds only its frontend; the `desktop:*` commands above launch or
bundle the native app. Extra arguments are forwarded to the desktop package.

For direct script or Cargo commands, change to `apps/desktop` first. For example:

```sh
cd apps/desktop
cargo test --manifest-path src-tauri/Cargo.toml --lib
```

CI runs desktop frontend unit tests and the website check/build in separate jobs.
Native desktop builds and UI tests use the workflow documented in the
[desktop guide](apps/desktop/README.md) and [E2E guide](apps/desktop/e2e/README.md).

## Licensing

See [LICENSE](LICENSE) and [NOTICE](NOTICE). Desktop's Help > Licenses is generated
from its own production dependency graphs by
`apps/desktop/scripts/gen-licenses.mjs`. Website dependencies do not enter the
desktop license list.
