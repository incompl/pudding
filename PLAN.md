# Cryo Pudding — Plan

Personal media player. Tauri-based. Plays local MP3s from a folder tree and remote MP3 Icecast streams from a manifest.

This plan covers **architecture, libraries, and incremental phases**. It is not a per-line spec.

## Stack

- **Tauri v2** — desktop shell.
- **Frontend: TypeScript + Vite + vanilla DOM.** No UI framework. Tauri's `create-tauri-app` "Vanilla TS" template.
- **Backend: Rust.** Filesystem reads only. No audio crates, no metadata parsing.
- **Playback: HTML5 `<audio>` element.** Webview decodes MP3 natively. Same element for local files and remote streams.
- **Local file URLs:** Tauri's `convertFileSrc()` + asset protocol, with library root added to the asset scope at runtime.
- **Persistence: `tauri-plugin-store`.** Stores library root path + manifest path in the OS app config dir.

## Architecture

### Rust commands

Keep the Rust surface tiny:

- `list_dir(path: String) -> { folders: Vec<String>, files: Vec<String> }`
  Lists one directory level. Filters files to `.mp3` (case-insensitive). Sorted alphabetically. Called lazily as folders expand.
- `read_manifest(path: String) -> Vec<{ name: String, url: String }>`
  Reads + parses the manifest JSON. Returns the list. Errors surface inline in the Settings panel next to the manifest path field; not fatal.

That's it. No watchers, no indexing, no playback control in Rust.

### Frontend state

In-memory only. No frontend state library. Roughly:

- `config`: `{ libraryRoot: string, manifestPath: string }` — loaded from store on boot, written back on change.
- `nowPlaying`: `{ kind: 'file' | 'stream', name: string, src: string } | null`.
- Folder tree state: expanded paths held in a `Set<string>`; children fetched on expand and cached on the in-memory tree node.

### Layout

- **Top bar:** two text fields — `libraryRoot` and `manifestPath`. Editing either writes to store, re-applies asset scope (for `libraryRoot`), and refreshes the dependent panel. To be replaced with a better Settings UI later.
- **Two-pane horizontal split below:**
  - **Left panel:** stacked vertically
    - Folder tree (rooted at `libraryRoot`, lazy-expand)
    - Streams list (flat, from manifest)
  - **Right panel:** Now Playing
    - Track/stream name
    - `<audio controls>` element (native controls = play/pause/seek/volume for free)

No styling beyond browser defaults in MVP.

### Manifest format

JSON file on disk, path stored in config:

```json
[
  { "name": "SomaFM Groove Salad", "url": "https://ice5.somafm.com/groovesalad-128-mp3" },
  { "name": "NightRide FM",        "url": "https://stream.nightride.fm/nightride.mp3" }
]
```

Flat list. No grouping, no extra fields. Both target streams are direct MP3 Icecast — `<audio>` handles them natively.

### Config / persistence

`tauri-plugin-store` writes a JSON file under the OS app config dir. Two keys:

- `libraryRoot: string`
- `manifestPath: string`

First run: both top-bar fields are empty. User pastes/types the paths in; on blur (or debounced change), values are written to store and the rest of the UI updates. No first-run modal.

### Asset scope

Tauri restricts which filesystem paths the webview can load via `asset://`. After the user picks a library root, the app calls `app.asset_protocol_scope().allow_directory(&path, true)` to whitelist it at runtime. Without this, local file playback will 403.

Requirements:
- `tauri = { features = ["protocol-asset"] }` in `Cargo.toml`.
- `security.assetProtocol.enable = true` in `tauri.conf.json`.

Asset scope is **in-memory only** — additions don't persist across restarts. On every boot, after loading config, re-apply scope for the saved `libraryRoot` before any UI loads file URLs.

Note: the asset protocol scope is separate from `tauri-plugin-fs`'s scope (different instances of the same `FsScope` type). We don't need `tauri-plugin-fs` for `<audio>` playback.

## Phases

Implement in this order. Each phase ends in something runnable.

### Phase 0 — Scaffold

- `pnpm create tauri-app` → Vanilla TS template.
- Verify `pnpm tauri dev` launches an empty window.
- Add plugin: `tauri-plugin-store`.
- Enable `protocol-asset` Cargo feature on `tauri`; set `security.assetProtocol.enable = true` in `tauri.conf.json`.
- Register plugins in `lib.rs` and frontend.

### Phase 1 — Local playback, hardcoded path

- Implement `list_dir` Rust command.
- Render a folder tree from a **hardcoded** library root.
- Click file → set `<audio>` src via `convertFileSrc()` → play.
- Asset scope: add the hardcoded root to the allowed scope.
- Goal: prove the playback pipeline end-to-end before touching config UI.

### Phase 2 — Manifest streams

- Implement `read_manifest` Rust command.
- Hardcode manifest path. Render streams list.
- Click stream → set `<audio>` src to URL → play.
- Goal: confirm SomaFM + NightRide.fm play in-webview with no extra deps.

### Phase 3 — Persisted config + first-run picker

- Wire up `tauri-plugin-store`. Load config on boot.
- Add the top-bar text fields for `libraryRoot` and `manifestPath`, prefilled from store.
- On field change (blur/debounced): write to store, refresh the dependent panel.
- Switch from hardcoded paths to config values.
- Extend asset scope on every boot (re-apply saved `libraryRoot`) and whenever the user changes the `libraryRoot` field.

### Phase 4 — Now Playing pane

- Right pane: show current item name + `<audio controls>`.
- Single `<audio>` element reused for both files and streams.
- Reset src on selection change.

### Phase 5 — Polish (still no design)

- Empty-state messages (no library set, no manifest, empty folder).
- Inline validation: invalid library root or manifest path → red border on the field. Manifest parse errors → red border on the manifest path field + error text shown below it.
- Loading indicator while `list_dir` runs (probably unnecessary but cheap).

## Explicitly out of scope (MVP)

Playlists, queue, shuffle/repeat, library scan/index, ID3/metadata, search, keyboard shortcuts, theming, multi-window, persisted playback position, PLS/M3U resolution, HLS/DASH, AAC-specific handling, multiple library roots, watching the filesystem for changes.

## Open items

- None right now. Revisit PLS/M3U if you later want to paste playlist URLs into the manifest instead of resolving direct stream URLs yourself.
