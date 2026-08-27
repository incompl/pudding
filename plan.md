# Splitting `src/main.ts` into modules

`src/main.ts` is ~6900 lines: 32 signals, 86 reassigned module-level `let`
bindings (incl. ~50 DOM element refs), ~180 functions. The functions are easy to
move; the obstacle is the shared mutable state everything reaches into.

## Progress (updated 2026-08-27)

**Foundational layer done — each commit typecheck + unit-test green:**

- `types.ts` — all 29 shared interfaces/types. `library-nav.ts` and the tests
  now import types from here, not `main.ts` (the old coupling is gone).
- `state.ts` — the 31 signals + the pure-signal helpers, **plus the `app` state
  object** (see below).
- `dom-refs.ts` — the 51 element refs + `bindDom()`. Realized as exported `let`s
  with live bindings (each ref is assigned exactly once, in `bindDom()`, so
  importers only ever read them — no `dom.` object / no read-site churn needed).
- `context-menu.ts` — the self-contained menu leaf; only `showContextMenu` public.

**The app-object migration is DONE** (the plan's hardest step): 25 cross-module
plumbing `let`s (272 references) now live as fields on `export const app` in
`state.ts`. This resolved the core live-binding obstacle, so the remaining
feature modules can be carved out with plain imports.

**Feature modules extracted — 10 commits, each typecheck + unit-test green
(one module per commit, verbatim relocation — no logic changes):**

- `drag-drop.ts` — pointer drag/ghost/drop curation.
- `engine-glue.ts` — the `GaplessEngine` handle (`export const engine`) + the
  System Now Playing bridge (push/tick + two effects). Read sites just import it.
- `search.ts` — the global search widget (`setupSearch`).
- `library.ts` — Files-tree build/reconcile/refresh, roots config, stream-list
  load/validate. (Owns `refreshStreams`; row *rendering* lives in the view modules.)
- `tree-view.ts` — library-tree row rendering + click/select/context wiring +
  `playSelectedRow`. (Data/refresh lifecycle stays in `library.ts`.)
- `editors.ts` — inline-editor form builder, right-pane editor face, track
  metadata editor, inline rename.
- `streams-view.ts` — Streams-tab row rendering + station add/edit/delete editors.
- `playback.ts` — playback core (feed engine, shuffle-bag/repeat advance,
  `handleEnded`/skip) + entry points (`playFile`/`playStream`/`playSearchTrack`/
  `playFolder`) + transport (play-pause/seek/volume). `setNowPlaying` lives here.
- `queue.ts` — right-pane list face (`renderQueue`), curation (applyCuration /
  reconcile / insert / remove / reorder), and the Add-to-queue family
  (seed/arm/append/close/teardown).
- `playlists.ts` — playlist data/IO + play/browse, the OS Playlist menu + client
  index, rename/delete, and the three `Add to playlist ▸` submenu ops
  (`newPlaylistWithTracks`/`addTracksToPlaylist`/`loadAllPlaylists`). The
  `KEY_RECENT_PLAYLISTS`/`RECENT_PLAYLISTS_MAX` store constants moved here too;
  `main.ts` imports the key to hydrate. Shared menu builders (`addToPlaylistItem`,
  `show*ContextMenu`) stayed in `main.ts` and call in. The queue↔playlists and
  editors↔playlists runtime cycles are ES-safe (playlists imports
  `insertCuratedTracks`/`appendToActivePool` from queue and `editInline` from
  editors; those modules import playlist fns back).

**Approach that worked (repeat for `playlists.ts`):** slice the function block(s)
to a scratch file with `scratchpad/slice.mjs`, prepend an import header, add
`export` to the block's funcs (over-exporting internals is harmless — `tsc`
`noUnusedLocals` doesn't flag unused *exports*), delete the range(s) from
`main.ts` with `scratchpad/delrange.mjs` (descending line order), then let
`pnpm typecheck` drive the wiring: TS2304 "cannot find name" ⇒ add an import;
TS6133/6196 "declared but never read" ⇒ drop a now-orphaned import. When a moved
function was imported by another module from `./main`, repoint that import to the
new module. Cross-module runtime cycles are fine (ES-safe); several exist already
(e.g. `queue`↔`main`, `playback`↔`engine-glue`).

`main.ts` is down from 6885 → **~2583 lines** (was 6311 at the start of this
pass). Working tree committed, `pnpm typecheck` + `pnpm test:unit` green.

**All planned feature modules are now extracted — the split the plan set out to
do is DONE.** What's left in `main.ts` is the deliberate end state (`init()` +
`setup*()` wiring + shared glue; see "Deliberately staying in `main.ts`" below).

### Decisions locked in (for the next session)

- **app-object + direct inter-module imports, NOT DI.** Confirmed as the chosen
  approach. Runtime-only call cycles between feature modules (e.g.
  queue↔drag-drop, engine↔playback) are ES-safe, so modules import each other
  directly. DI (the `library-nav.ts` pattern) is *not* used for the clusters.
- **Module-local state stays local, not on `app`.** Drag/stream-private lets
  (`activeDrag`, `dragGhostEl`, `renderedStreamMeta`, `streamMetaFadeTimer`) move
  *with* their module as a plain `let`; only genuinely cross-module plumbing is
  on `app`. Also still main-local for now: `normalSize`/`miniSize` (window),
  `toastTimer` (toast), `lastNonZeroVolume` (volume) — relocate with whatever
  owns them, or leave in the trimmed `main.ts`.
- **`paneView` and `queueIsActivePool` deliberately stayed in `main.ts`** — they
  call feature functions, and `state.ts` must stay dependency-light (types +
  signal/engine libs only, never a feature module).
- **`engine` is a `const`** (not a reassigned `let`), so it needs no `app` field:
  when `engine-glue.ts` is extracted it becomes `export const engine` there and
  is imported back — read sites don't change.

### Gotchas learned (extraction via script)

The scratchpad scripts worked well, but the `app`-rename (`\bNAME\b` →
`app.NAME`) needed two guards, both worth repeating for any future bulk rename:
- **String literals** matching a name get clobbered — critically the *persisted*
  store-key values (`KEY_LIBRARY_ROOTS = "libraryRoots"`) and import paths
  (`plugin-store`). Skip inside quotes.
- **Spread `...name`** looks like member access to a `(?<!\.)` lookbehind and is
  skipped — handle `...` explicitly.
- Verify afterward with a string-aware scan for `app.` leaking into any quoted
  string or comment.

### Remaining work

**None of the planned modules remain — `playlists.ts` was the last, and it is
extracted.** It was the most *scattered* cluster (no single contiguous block), so
it came out as six slices (`main.ts` ~713–848 / 850–905 / 917–1046 / 1088–1196 /
1303–1371 / 1478–1488), skipping `persistNavLocation` (nav), `playQueue`/
`commitBrowsedPlaylist` (queue-source glue), and the shared menu layer
(`showInFinderItem`/`addToPlaylistItem`/`trackContextItems`/
`searchItemTrackProvider`/`addProviderToQueue`/`show*ContextMenu`) — all of which
stayed in `main.ts`.

Any further work is optional: the `main.ts` residue below is the plan's intended
end state, not a pending module. If someone wants to keep splitting, the nav-bar +
album-art + shared-menu clusters are the natural next carve-outs, but none is
load-bearing for the boundary the plan established.

**Deliberately staying in `main.ts`** (the plan's target end state — `init()` +
`setup*()` wiring + the small shared glue that doesn't warrant its own module):
helpers (`formatRuntime`/`trackCountSubtitle`/`joinPath`/`debounce`/`setEmpty`/
`displayLabel`), file-tree multi-select + `makeTrackSelection`, the nav bar
(`nowPlayingLabel`/`upNextLabel`/`renderNavBar`/`toggleNavFace`) + `paneView`,
the queue-source glue `playQueue`/`commitBrowsedPlaylist`, `openArtistQueue`/
`openAlbumQueue`, the shared context-menu builders + `renderLeafTrackList`,
album art (`clearArt`/`loadArt`/`loadStreamArt`/`applyArt`), `toast`, all the
`setup*()` wiring, the `setupEffects()` block, and `init()`. These can be split
later if desired, but none is load-bearing for the module boundary the plan set
out to establish.

## The core obstacle: shared mutable `let` state

`import { rootNode }` gives a **read-only live binding** — any file that does
`rootNode = …` won't compile once `rootNode` lives in another module. Signals
don't have this problem (a `const x = signal()` is a stable reference mutated via
`.value`), but the 86 reassigned `let`s do. This drives the whole strategy.

**Decision: convert to signals + a shared state object** (chosen approach). Fits
the existing reactive style; avoids DI dependency objects ballooning. The
compiler flags every missed rewrite, so migration is self-checking.

### Rule of thumb for each `let`

- **Reactive state the UI reflects** (`rootNode` drives the tree, `libraryRoots`,
  `recentPlaylists`, `playlistIndex`) → **signals**. If an `effect()` or a render
  reads it, it benefits from being a signal anyway.
- **Plumbing — "current value, no reactivity"** (`store`, `engine`, `lastQueue`,
  `lastIndex`, `queueEnded`, `shuffleBag`, `artRequestId`, drag state) → fields on
  a plain exported object (`app.queueEnded = true`). No `.value` ceremony where
  reactivity buys nothing.
- **DOM refs** (~50 `let …El`) → their own `dom-refs.ts` object populated once by
  a `bindDom()` call at startup. Import `dom.playPauseBtn` etc. Never signals.

## Proposed module layout

```
src/
  types.ts          types/interfaces only — kills the current main→types coupling
  state.ts          all signals + derived (computed) signals + the `app` state object
  dom-refs.ts       the ~50 element refs + a bindDom() that queries them once
  context-menu.ts   menu infra (build/show/position/hide) — self-contained
  drag-drop.ts      pointer drag/ghost/drop (~lines 2179-2410)
  engine-glue.ts    GaplessEngine setup + pushNowPlaying/pushPlayback ticks
  playback.ts       playSingle/playPool/feedEngine/handleEnded/skip*, shuffle bag
  queue.ts          renderQueue + curation (applyCuration, reconcile, insert/remove/reorder)
  playlists.ts      playlist data/IO, recent playlists, menu ops, save/move/rename
  library.ts        tree build/refresh/reconcile, roots config, streams refresh
  tree-view.ts      renderNode/renderTree/onNodeClick + inline metadata editor
  streams-view.ts   renderStreams + station editors
  search.ts         setupSearch + search rendering
  editors.ts        buildInlineEditor / editInline / pane editor
  main.ts           init() + setup*() wiring, top-level event/menu listeners (~600 lines)
```

Precedent: `library-nav.ts` was already split off using dependency injection
(`LibraryNavDeps`) and imports shared types from `main.ts`. Step 1 below lets it
import from `types.ts` instead.

## Extraction order (safest first — each step compiles/runs on its own)

1. **`types.ts`** — pure move, zero logic. Immediately lets `library-nav.ts` stop
   importing types from `main.ts`. Lowest risk, high payoff.
2. **`state.ts`** — the 32 signals + computed, plus the `app` state object for the
   non-reactive `let`s. Everything else imports from here.
3. **`dom-refs.ts`** — mechanical: move the refs + a `bindDom()`.
4. **Leaf features, narrow surface** — `context-menu.ts`, `drag-drop.ts`,
   `engine-glue.ts`. Barely touch shared state.
5. **Big feature clusters** — `playback.ts`, `queue.ts`, `playlists.ts`,
   `library.ts`, `tree-view.ts`, `streams-view.ts`, `search.ts`. One at a time;
   each just needs imports from `state`/`types`/`dom-refs`.
6. **`main.ts`** shrinks to `init()` + the `setup*()` wiring and top-level listeners.

Suggested first chunk: steps 1–2 (`types.ts` + `state.ts`). Reversible and
high-signal — if the `app`-object feel is wrong, almost nothing has been touched.

## Watch-items

- **Circular imports.** Keep `state.ts` dependency-light: it should import only
  `types.ts` + the signal/engine libs, never a feature module. Once `state.ts`
  holds `engine` and a feature imports both, cycles become easy to introduce.
- **Verification.** Typecheck / run after each step. Converting `let`s to
  signals/`app` fields makes the compiler catch every missed live-binding rewrite.
