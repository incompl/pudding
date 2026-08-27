# Splitting `src/main.ts` into modules

`src/main.ts` is ~6900 lines: 32 signals, 86 reassigned module-level `let`
bindings (incl. ~50 DOM element refs), ~180 functions. The functions are easy to
move; the obstacle is the shared mutable state everything reaches into.

## Progress (updated 2026-08-27)

**Foundational layer done — 6 commits, each typecheck + unit-test green:**

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

`main.ts` is down from 6885 → ~6311 lines. Working tree committed, `pnpm
typecheck` + `pnpm test:unit` green.

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

Steps 4b + 5 + 6 below: engine-glue, drag-drop, playback, queue, playlists,
library, tree-view, streams-view, search, editors — then shrink `main.ts` to
`init()` + the `setup*()` wiring. All now mechanical relocation; extract one at a
time, typecheck + `test:unit` after each, commit per module.

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
