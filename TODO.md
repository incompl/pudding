### Virtualize lists

Keep large-library scrolling cheap without changing how scroll *feels* (native
inertia on a touchpad must be identical). Two separable projects hide here; do the
cheap one first and only reach for windowing when a real list gets huge.

#### Done — content-visibility (the cheap, zero-risk win)

`content-visibility: auto; contain-intrinsic-size: auto 2em;` on the two
large-library row surfaces:

- `.node-label` — folder tree + streams list (`src/styles.css`, ~L1988)
- `.nav-track-row` — nav leaf track lists from `renderLeafTrackList` (~L2886)

Every row stays in the DOM, so native scroll/inertia, `scrollIntoView` (reveal /
go-to-folder), scrollbar sizing, and drag geometry are all unchanged; the browser
just skips layout/paint for off-screen rows. `auto` seeds a 2em placeholder then
remembers each row's real measured height, so the scrollbar doesn't drift.

**Deliberately NOT applied to `.queue-row` / `.stream-row`.** `content-visibility`
forces paint containment even while on-screen, which would clip their drag
drop-line `::after` — it straddles the row boundary at `top/bottom: -1px`
(`src/styles.css` ~L1021), sitting 1px outside the box. Also skipped `.nav-row`:
it doubles as the sticky Browse back-bar, and containment can interfere with
`position: sticky`; those menu lists are short anyway.

What content-visibility does NOT fix: DOM node count, per-row listener count, and
initial build cost (`innerHTML = ""` then rebuild every row). Those only matter at
tens of thousands of rows — that's when the windowing project below earns its keep.

#### Not done — true windowing (only if a flat list gets huge)

Render just the visible window of rows over a full-height spacer; swap mounted rows
on scroll. Native scroll is preserved by construction (real scroll container +
correct total height); the only risk is blank rows on a fast fling, mitigated by
overscan + cheap per-row work.

LOE by list:

- **Queue / playlist** (`src/queue.ts`, `renderQueue` L85) — LOW. Fixed row height →
  `offset = index * rowHeight`. Rework the drop-line so the indicator doesn't depend
  on rows outside the window (compute the insertion gap from `scrollTop + pointerY`,
  not from DOM row geometry). Doing this here also unblocks content-visibility on the
  queue if we still want it.
- **Library nav leaf list** (`src/library-nav.ts`) — MEDIUM. Rows are near-uniform;
  the section headers (Albums / Tracks) that interleave need estimated heights or
  segmenting.
- **Folder tree** (`src/tree-view.ts`, `renderNode` L340) — HIGH. Recursive render
  must become: flatten the tree into a linear array of *visible* nodes (respecting
  `expanded`), carrying depth for indent, then window over that array. This is the
  real refactor.

Cross-cutting work windowing forces (all lists):

- **Event delegation** — move per-row listeners (click / dblclick / `pointerdown`
  drag / contextmenu, e.g. `src/queue.ts` L166/L201) to one container listener using
  `closest()` + `data-rowIndex`. Recycling churns per-row listeners otherwise. Good
  cleanup regardless.
- **`scrollIntoView` → offset math** — can't scroll to an unmounted row; reveal and
  scroll-to-playing become `scrollTop = index * rowHeight` (+ scroll-margin).
- **Drag-drop drop-index** — resolve insert position from `scrollTop + pointerY /
  rowHeight`, not from DOM rows, since off-window rows don't exist. Fiddliest piece.
- **Selection effects** — the reactive effects that reapply `.playing` / `.selected`
  on rebuild (`src/queue.ts` L173) must reapply on every scroll-driven remount and
  only touch mounted rows.

Reference: native players (iTunes, foobar2000) get this free from the OS table
control (NSTableView / virtual ListView) and keep the *tree* small while scale lives
in a flat uniform-height table. We're a WebView app (no free toolkit windowing), so
we mirror that shape: uniform row heights + content-visibility now, windowing on the
flat lists only if we commit to a large-library scale.
