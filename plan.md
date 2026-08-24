# Library navigator: implementing the browse-by views

Plan for turning the mock (`src/library-mock.ts`) into real Songs / Playlists /
Artists / Albums / Genres views under the Files tab, built on the core behavior
of the existing Browse (folder tree) page.

## Decisions since this plan (2026-08-25, branch `new-files-panel`)

Two things below are superseded by choices made after the plan was written:

- **Lens switching is not an in-pane root menu.** The six lenses (Browse / Songs /
  Playlists / Artists / Albums / Genres) are switched from the **OS "View" menu**
  (radio items, ⌘1–6), and the **Files tab label morphs** to the active lens as the
  in-window indicator ("Files" in Browse, the lens name otherwise). An in-pane
  icon "lens strip" was prototyped and **retired** — kept behind
  `USE_LENS_STRIP = false` in `src/library-nav.ts` for A/B only. The **Replace+back
  view stack and back header are still used for drill-downs** *within* a lens
  (artist → album → tracks), and tap-active-tab-to-home still resets to Browse.
  So wherever this plan says "root menu," read "View-menu lens selection."
- **Autoadvance is one global toggle**, not the two context toggles this plan
  assumes. The "Play semantics" cost center below is resolved accordingly
  (play-in-context, governed by the single global Autoadvance checkbox).

## Where things stand

The mock is a **pure layout prototype**: a self-contained Replace+back nav stack
over fabricated data, with no play, no selection, no context menus, no real
queries. The navigation shell itself (drill-down view stack, back header,
Esc/Backspace pop, tap-active-tab-to-home) is genuinely reusable — that part is
basically done. (Top-level lens *selection* is now the OS View menu, not the
mock's root menu — see the decisions note above.)

The real behavior it must inherit from Browse lives in `src/main.ts`:
`playTreeTrack` / `playSearchTrack`, `addToQueue`, `playQueue`,
`openArtistQueue` / `openAlbumQueue` (main.ts:3318-3359), the context-menu
builder + `addToPlaylistItem`, tree vs. list selection, and drag-to-playlist.

Backend: `artist_tracks`, `album_tracks`, `folder_tracks` already exist
(lib.rs:1193-1363) but are keyed to a specific artist/album. The **search**
variants are query-filtered; there are **no "list everything" commands** yet.

## Per-view effort

| View | Backend | Frontend | Effort |
|---|---|---|---|
| **Browse** | reuses folder tree | already wired in the mock | done (0) |
| **Playlists** | `list_all_playlists` exists | wire drill list to existing open/play-playlist; playlist detail = track rows | S–M |
| **Artists** | new `list_all_artists` (distinct + album count) — trivial | artists → artist detail (albums) → album detail; reuse `openArtistQueue` / `openAlbumQueue` | M |
| **Albums** | new `list_all_albums` (distinct album+album_artist) — trivial | mostly reuses the album-detail view from Artists | S–M |
| **Songs** | new `list_all_songs` — trivial query, but returns the *whole library* | rows + play/queue/context/selection; **needs virtualization** for large libraries | M (perf risk) |
| **Genres** | **no `genre` column exists** — schema change + tag read + rescan + new queries | genres → artists → album → tracks | M–L |

## The three real cost centers

1. **Shared row behavior (do once, biggest single chunk).** Every leaf list —
   Songs, playlist tracks, album tracks — needs the same treatment: single-click
   select / double-click play, right-click menu (Play / Add to queue / Add to
   playlist ▸ / go to artist·album), and drag-to-playlist. This should be one
   shared helper the navigator rows call, not re-implemented per view. Subtlety:
   the app already has **two** selection systems (tree `selectedTracks` and
   right-pane `listSelection`) — the navigator is a third surface, and we should
   reuse one rather than invent a third.

2. **Genres = a data-model change, not just a view.** No genre is stored today
   (schema at lib.rs:223, no genre in `Tags`). We'd add a `genre` column, read
   `tag.genre()`, bump `SCHEMA_VERSION` (which force-drops+rescans the whole
   library on next launch), and add list/drill queries. Everything else reuses
   `artist_tracks`. It's the one view that touches Rust + a migration.

3. **"Play" semantics per view (design, not code). — RESOLVED.** A leaf track in
   an album view plays the list **in context** (as a `queue:` pool from that
   track, gapless auto-advance), not one-off. This is what the shared leaf-row
   helper already encodes. With autoadvance now a **single global toggle** (not
   per-context), there's no longer a per-view autoadvance-interaction question to
   settle here — every lens's play flows or stops by the one setting.

## Phases

Each phase is a self-contained, independently reviewable chunk — sized to land in
one focused session, with its own clear "done when" so it can be verified before
the next begins. Phases are ordered by dependency: 1 and 2 are the spine;
3–6 build on them and are largely parallelizable; 7 is optional.

### Phase 1 — Nav shell (foundation, no data yet)

Promote the mock's Replace+back navigator from `src/library-mock.ts` into real
`src/main.ts` code, wired to the real Files pane. Keep Browse (folder tree)
working exactly as today; the other five lenses render as **stubs** with empty
"coming soon" bodies. (As built, lenses are selected from the OS View menu rather
than a root menu — see the decisions note.)

- Move view-stack / back-header / Esc-Backspace-pop / tap-active-tab-to-home out
  of the mock and into the app's own render path.
- **Merge the keydown handler, don't just relocate it.** The mock wins Esc/
  Backspace via a *capture-phase* listener specifically to beat the app's
  Backspace = remove-track handler (library-mock.ts:593). Once both live in the
  app, don't leave two capture handlers racing — make one coordinated handler
  that checks navigator state first (drilled in → pop) and only falls through to
  remove-track when at root. This is the one non-trivial part of Phase 1.
- Delete the mock file, its import, `#library-mock`, and the mock CSS block once
  the shell lives in the app (see Revert notes).
- **Done when:** each lens renders (Browse as before, the rest as stubs), lenses
  drill in and back out cleanly, and Backspace still removes queue tracks at the
  lens root while popping the navigator when drilled in. Nothing plays yet.

### Phase 2 — Shared leaf-row helper + `list_all_*` commands (foundation)

The reusable spine every later phase depends on.

- Backend: add `list_all_songs`, `list_all_artists` (distinct + album count),
  `list_all_albums` (distinct album + album_artist). Trivial variations of the
  existing `search_*` queries with the filter removed — and they can **return the
  same result types** (`SearchResult` / `ArtistResult` / `AlbumResult`) the
  frontend already consumes, so no new TS plumbing.
  - **Album key must match the drill-through.** Group `list_all_albums` by the
    existing `ALBUM_ARTIST_EXPR` (`COALESCE(NULLIF(album_artist,''), artist, '')`,
    lib.rs:1233), not raw `album_artist` — that's the key `openAlbumQueue(album,
    albumArtist)` already expects. Grouping on the raw column silently mismatches
    tracks whose album_artist is empty.
- Frontend: one shared leaf-row builder used by every track list — single-click
  select / double-click play, right-click menu (Play / Add to queue / Add to
  playlist ▸ / go to artist·album), drag-to-playlist. Reuse an existing
  selection system rather than inventing a third surface.
- The **"Play" semantics decision** is settled (play-in-context; single global
  autoadvance — see cost center 3); the helper encodes it.
- **Done when:** a throwaway test list of tracks plays, queues, context-menus,
  and selects correctly through the shared helper.

### Phase 3 — Artists (proof-of-concept view)

Best first real view: its drill-down queries (`artist_tracks`, `album_tracks`)
already exist, so it exercises the whole foundation end to end.

- artists list → artist detail (albums) → album detail (tracks), reusing
  `openArtistQueue` / `openAlbumQueue` and the Phase 2 leaf-row helper.
- **Done when:** you can browse artists → album → play a track, with working
  context menus.

### Phase 4 — Albums

- albums list → album detail, reusing the album-detail view built in Phase 3.
- **Done when:** albums browse and play; album detail is shared code with Artists.

### Phase 5 — Playlists

- Wire the drill list to the existing open/play-playlist paths; playlist detail
  is a track list via the Phase 2 helper. `list_all_playlists` already exists.
- **Done when:** playlists list, open, play, and their tracks behave like Browse.

### Phase 6 — Songs

- `list_all_songs` (from Phase 2) → flat all-tracks list via the leaf-row helper.
- **No existing virtualization to lean on.** The right-pane search list renders
  all rows directly and only escapes the problem because search is query-filtered;
  there's no windowing pattern anywhere in the app to copy. So Songs is the first
  unbounded list, and Phase 7's virtualization is net-new work, not a reuse.
- **Done when:** the full library lists and plays. Watch scroll performance on a
  large library — if janky, that's Phase 7.

### Phase 7 — Genres (data-model change) + Songs virtualization

The only phase touching Rust schema, plus the deferred perf work.

- **Genres — CUT (2026-08-25).** Built end to end (schema `genre` column,
  `tag.genre()`, `SCHEMA_VERSION` bump, `list_all_genres` + `genre_artists`,
  genres → artists → album → tracks views) then **removed entirely**, including the
  pre-existing stub lens. Reason: genre is a sparse tag in the wild (a real 253-track
  library here had **zero** tagged files — Bandcamp/purchased MP3s routinely omit
  it), so the lens was a permanently-empty row against the compact-UI principle. All
  Genres code (Rust + TS + CSS) and the schema change were reverted; the lens set is
  now Browse / Songs / Artists / Albums. If a future library warrants it, re-add as a
  **self-hiding** lens (show only when `list_all_genres` is non-empty).
- **Songs virtualization — DEFERRED (2026-08-25).** Gated on *observed* jank, not
  done speculatively: `renderLeafTrackList` is shared by Songs + album detail and
  its rowIndex-based selection painter (main.ts) assumes every row is in the DOM,
  so windowing is an invasive shared-code change. Measure scroll on a real large
  library first; only then virtualize.
- **Done when:** ~~genres browse end to end after a rescan~~ (cut). Songs
  virtualization remains open, pending a confirmed jank measurement.

**Rough total: ~5–7 focused days** across the seven phases.

## Caveats

- Genres is the only view needing a Rust/schema change and a forced rescan.
- Songs' scale is the main perf unknown (virtualization) — and it's net-new work,
  no existing windowing to reuse.
- The leaf-row / selection behavior is where the design care goes — build it once,
  share it everywhere. Reuse an existing selection system (tree `selectedTracks`
  or right-pane `listSelection`) rather than adding a third surface.
- The Phase 1 keydown merge (navigator pop vs. Backspace = remove-track) is the
  spot most likely to cause regressions if rushed. (The Phase 2 "Play" semantics
  decision that used to sit here is now resolved — see the decisions note.)

## Revert notes (mock cleanup, when replacing)

To retire the mock: delete `src/library-mock.ts`, remove its import in
`src/main.ts`, remove `#library-mock` from `index.html`, and remove the marked
block in `src/styles.css`.
