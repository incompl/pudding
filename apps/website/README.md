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

The hero shows "Coming soon" while no prebuilt desktop release is available.
Replace it with a download button and link when releases are published.

## Hosting

The site is live at **https://puddingisgood.com**, hosted on Netlify, which
builds from this repository. That origin is the default `site` in
`astro.config.mjs`, so canonical and `og:url` tags are correct in every build,
including local ones — no host configuration is required.

The build settings live in the Netlify dashboard, not in this repository: the
build command runs `pnpm website:build` from the repository root and publishes
`apps/website/dist`.

`ASTRO_SITE` overrides the origin and `ASTRO_BASE` sets a path prefix, for a
preview deployment or a site served under a subdirectory. All local asset and
navigation links respect the base:

```sh
ASTRO_SITE=https://preview.example ASTRO_BASE=/pudding pnpm website:build
```

The privacy policy (`/privacy/`) and support page (`/support/`) are the URLs
given to App Store Connect, so their paths should not change without updating
the store listing and `Help ▸ Support` in the desktop app.
