# Pudding website

A static Astro site using TypeScript and plain CSS. It has no backend, client UI
framework, external fonts, or analytics. Building it requires only Node.js and
pnpm, not the desktop Rust toolchain.

From the repository root:

```sh
pnpm install
pnpm website:dev
pnpm website:check
pnpm website:build
pnpm website:preview
```

The development server defaults to `http://localhost:4321`. The build output is
`apps/website/dist/`, which can be uploaded to any static host.

## Editing

- `src/pages/index.astro` contains the home page.
- `src/pages/documentation.astro` and `support.astro` are standalone pages.
- `src/pages/privacy.astro` contains the app privacy policy, linked from every footer.
- `src/layouts/Page.astro` contains document metadata and the shared page shell.
- `src/styles/global.css` contains responsive styles.
- `src/assets/desktop.png` and `mini.png` are snapshots of the app screenshots, processed by Astro.
- `public/favicon.svg` is a snapshot of the existing Pudding logo.

These brand assets are copied deliberately so the site has no build dependency
on another app's source. Refresh them when the product artwork changes. A shared
asset package can be introduced when that becomes useful.

The page links to build instructions while no prebuilt desktop release is
available. Update that copy and link when downloads are published.

## Hosting

Set `ASTRO_SITE` to the public origin to emit canonical URLs. Set `ASTRO_BASE` if
the site lives under a path; all local asset and navigation links respect it.
For GitHub project Pages:

```sh
ASTRO_SITE=https://incompl.github.io ASTRO_BASE=/pudding pnpm website:build
ASTRO_SITE=https://incompl.github.io ASTRO_BASE=/pudding pnpm website:preview
```

For a custom domain, set `ASTRO_SITE` to that origin and leave `ASTRO_BASE` unset.
The default development configuration serves at `/` without a canonical URL.

The **Deploy website** GitHub Actions workflow is manual: enable GitHub Pages
with **GitHub Actions** as its source in the repository settings, then run the
workflow. It reads the origin and base path from the Pages configuration,
checks and builds only this workspace package, and publishes its output.
Ordinary pushes and pull requests only run CI; they do not publish the site.
