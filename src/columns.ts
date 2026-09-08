// Per-pane column customization.
//
// The design this implements, in three rules inherited from the existing rows:
//
//   1. Width decides, per pane. A pane past the 28rem container-query breakpoint
//      lays its chosen fields out as columns; below it the same fields fold back
//      into the inline `title · a · b · c` run. Neither pane consults the other,
//      and neither consults the viewport.
//   2. In column mode nothing is dropped; folded, the row stops at two fields.
//      A pane laying out columns never drops one however crowded it gets — they
//      just go thin and ellipsize ("you made the mess and you can unmake it").
//      Folded, though, the row is a single line, and a line carrying more than two
//      fields doesn't show a third: it truncates mid-word at the right edge, having
//      already spent the title's width on a field the reader never sees. So the
//      fold cuts at two deliberately, rather than letting the ellipsis cut at
//      random. In automatic mode the runtime sits the folded row out entirely: it
//      is an affordance a *wide* pane can afford, not one of the two fields a dense
//      row spends its line on, so it appears only in column mode however early it
//      falls in the set (see `col-auto` in styles.css). Fields the user picked are
//      taken literally instead — their first two are what the folded row shows,
//      the runtime among them if that is where they put it.
//   3. The user chooses *what*, the pane chooses *how*. There are no draggable
//      dividers and no per-column widths — a field carries a static grid weight
//      (see ColumnDef.weight) and the pane divides its width by those weights.
//
// State is per pane (library / queue), because the app already shipped two
// hard-coded field sets: the queue row composed the artist and deliberately never
// the album, while the leaf lists composed `artist · album`. Exposing that as two
// column lists rather than one global one keeps both defaults intact.
//
// Every offered field is read from the file itself — its tags (title, artist,
// album, album artist, duration) or its path (kind, location). A field Pudding
// doesn't index is not in the table at all: a column that can only ever be blank is
// worse than an absent one, and a column filled from anywhere but the file would be
// a column the user can't fix by fixing their tags.
//
// The track number is deliberately absent too, for the opposite reason: every row
// already carries a number in its gutter, in both panes and at every width, so a `#`
// column would be a second number beside the one that is always there.

import { signal, type Signal } from "@preact/signals-core";
import { h } from "./dom";
import type { SearchTrack, ContextMenuItem } from "./types";
import { app } from "./state";

export type ColumnPane = "library" | "queue";

export type ColumnId =
  | "title"
  | "artist"
  | "album"
  | "albumArtist"
  | "kind"
  | "duration"
  | "location";

export interface ColumnDef {
  id: ColumnId;
  label: string;
  // Share of the leftover width in column mode, as a grid `fr`. Text fields carry
  // a weight; `fixed` fields (the kind, the runtime) are sized to their content
  // instead, so they stay legible however many columns are crowded in beside them.
  weight: number;
  fixed?: boolean;
  // Right-aligned, tabular figures: times and counts read as a column of numbers.
  numeric?: boolean;
  get(t: SearchTrack): string;
  // Sort key. Strings sort case-insensitively; numbers sort numerically.
  key(t: SearchTrack): string | number;
}

function fmtTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) seconds = 0;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

// --- the field table --------------------------------------------------------
//
// Order here is column order on screen and item order in the `Columns ▸` menu.
// There is no reordering UI, deliberately: reordering columns is the other half
// of the draggable-divider problem — it hands the user a way to make the layout
// worse and forces headers to exist so the order is legible.
export const COLUMNS: ColumnDef[] = [
  {
    id: "title",
    label: "Title",
    weight: 2.4,
    get: (t) => t.title ?? basename(t.path),
    key: (t) => (t.title ?? basename(t.path)).toLowerCase(),
  },
  {
    id: "artist",
    label: "Artist",
    weight: 1.6,
    get: (t) => t.artist ?? "",
    key: (t) => (t.artist ?? "").toLowerCase(),
  },
  {
    id: "album",
    label: "Album",
    weight: 1.6,
    get: (t) => t.album ?? "",
    key: (t) => (t.album ?? "").toLowerCase(),
  },
  // The raw ALBUMARTIST tag, blank when the file has none — deliberately NOT the
  // albumArtist ?? artist coalesce the album grouping key uses (ALBUM_ARTIST_EXPR).
  // A column is an inspection surface: the reason to put this one up is to see which
  // files carry the tag, and a fallback erases exactly that. It would also disagree
  // with the metadata editor, whose Album Artist field shows the same raw tag and
  // whose empty box means "no tag" — a cell reading "Alice" over an empty editor
  // field invites the user to type it in and stamp a literal tag onto every file
  // that was fine without one.
  //
  // Blank here and a filled artist in the Albums view are not a contradiction: the
  // view answers "which album is this filed under", this answers "what does this
  // file say".
  {
    id: "albumArtist",
    label: "Album Artist",
    weight: 1.6,
    get: (t) => t.albumArtist ?? "",
    key: (t) => (t.albumArtist ?? "").toLowerCase(),
  },
  // The container, from the file's extension — the one field that is a fact about
  // the file rather than about its tags, and the reason it can never be blank.
  {
    id: "kind",
    label: "Kind",
    weight: 0,
    fixed: true,
    get: (t) => (basename(t.path).match(/\.([^.]+)$/)?.[1] ?? "").toUpperCase(),
    key: (t) => basename(t.path).match(/\.([^.]+)$/)?.[1]?.toLowerCase() ?? "",
  },
  {
    id: "duration",
    label: "Time",
    weight: 0,
    fixed: true,
    numeric: true,
    get: (t) => (t.duration != null && t.duration > 0 ? fmtTime(t.duration) : ""),
    key: (t) => t.duration ?? 0,
  },
  {
    id: "location",
    label: "Location",
    weight: 2.4,
    get: (t) => t.path,
    key: (t) => t.path.toLowerCase(),
  },
];

const BY_ID = new Map<ColumnId, ColumnDef>(COLUMNS.map((c) => [c.id, c]));

// Sort the ids into the canonical COLUMNS order, and guarantee the title leads.
// Column order is a property of the field table, not of the order you ticked the
// boxes in — so two panes showing the same fields always agree on their order.
function canonical(ids: ColumnId[]): ColumnId[] {
  const set = new Set<ColumnId>(ids);
  set.add("title");
  return COLUMNS.filter((c) => set.has(c.id)).map((c) => c.id);
}

// --- per-pane state ---------------------------------------------------------
//
// `null` means automatic: the pane keeps the behavior it shipped with, where the
// row builder picks the fields per list (fieldVaries — drop anything constant
// down the list). Automatic survives until the user touches `Columns ▸`; from
// then on their set is taken literally, constant fields and all.
export type SortState = { id: ColumnId; dir: 1 | -1 } | null;

export const columnSets: Record<ColumnPane, Signal<ColumnId[] | null>> = {
  library: signal<ColumnId[] | null>(null),
  queue: signal<ColumnId[] | null>(null),
};

export const columnHeaders: Record<ColumnPane, Signal<boolean>> = {
  library: signal(false),
  queue: signal(false),
};

// Library only. A queue has an *order*, not a sort — sorting one is an edit (see
// sortQueueBy in queue.ts), so there is no sticky sort state to hold for it.
export const librarySort = signal<SortState>(null);

// The pane's live column set: the user's list if they've set one, else the
// automatic set the row builder computed for this particular list.
// Peeked, not read reactively: renderQueue runs inside a signals effect, and
// subscribing that effect to the column set would make every toggle repaint the
// pane twice (once through the effect, once through the explicit repaint below).
export function activeColumns(pane: ColumnPane, auto: ColumnId[]): ColumnId[] {
  const chosen = columnSets[pane].peek();
  return canonical(chosen ?? auto);
}

export function isAutomatic(pane: ColumnPane): boolean {
  return columnSets[pane].peek() === null;
}

// --- layout -----------------------------------------------------------------

// The grid track list for a column set, handed to the row (and the header row) as
// the `--cols` custom property. Two kinds of track:
//
//   minmax(0, Wfr) — text fields. The `0` minimum is the whole "you made the mess"
//     policy in one token: with a `ch` minimum the row would overflow its pane
//     once enough columns were added (and the only cures are a horizontal
//     scrollbar or dropping fields). With `0`, an over-full row just gets thin
//     and every cell ellipsizes — dense, legible, and obviously self-inflicted.
//   max-content — fixed fields (times, years, counts). Short and load-bearing;
//     squeezing "3:45" to "3…" saves nothing and costs everything.
export function gridTemplate(ids: ColumnId[]): string {
  return ids
    .map((id) => {
      const def = BY_ID.get(id);
      if (!def) return "minmax(0, 1fr)";
      return def.fixed ? "max-content" : `minmax(0, ${def.weight}fr)`;
    })
    .join(" ");
}

// --- rows -------------------------------------------------------------------

// The classes a pane puts on its cells, so the existing typographic rank (primary
// = --text, secondary = --text-dim) and the existing playing-row accent rules keep
// applying without either pane learning about the other's class names.
export interface CellClasses {
  primary: string;
  secondary: string;
}

export const QUEUE_CELLS: CellClasses = { primary: "queue-primary", secondary: "queue-secondary" };
export const NAV_CELLS: CellClasses = { primary: "nav-primary", secondary: "nav-secondary" };

// The classes for a row's cell container: the pane's own host class, the grid hook,
// and — while the pane is still choosing its own fields — `col-auto`. That last one
// keeps the runtime out of the folded row (it belongs to the wide pane, which has
// the room for it), so the pane's mode has to reach the DOM somewhere. It rides the
// container rather than the cells: both folded-row rules are about the row, not
// about any one field, and a row-level fact belongs on the row.
export function gridClasses(pane: ColumnPane, host: string): string {
  return isAutomatic(pane) ? `${host} col-grid col-auto` : `${host} col-grid`;
}

// Build one row's cells. The same DOM serves both layouts: in column mode the
// parent is a grid and each cell is a track; below the breakpoint the parent is
// plain inline text and the `· ` separators on the secondary cells (::before, in
// CSS) fold them back into one line. Nothing is added or removed at the
// breakpoint, which is why the switch is pure CSS and costs no JS at all.
//
// Which cells the folded row actually *shows* is not decided here: the two-field
// cap (and automatic mode's runtime exemption) is a CSS rule keyed off the
// container's classes — see gridClasses and the dense cap in styles.css. Every
// cell is built either way, so the switch stays pure CSS and the cap can lift on a
// resize without rebuilding a row.
export function buildCells(
  t: SearchTrack,
  ids: ColumnId[],
  cls: CellClasses,
): HTMLElement[] {
  return ids.map((id) => {
    const def = BY_ID.get(id);
    const isTitle = id === "title";
    const classes = ["col-cell", isTitle ? cls.primary : cls.secondary];
    if (def?.numeric) classes.push("col-num");
    // Keep the legacy hook class on the runtime cell: the playing-row tint and the
    // hover-swap with the queue's ✕ are already written against `.row-dur`.
    if (id === "duration") classes.push("row-dur");
    return h("span", {
      class: classes.join(" "),
      text: def ? def.get(t) : "",
      data: { col: id },
    });
  });
}

// --- headers ----------------------------------------------------------------

// The header row is built from the same ids and the same `--cols` template as the
// rows, inside the same row shell (same padding, same gutter width), so the two
// line up by construction rather than by two sets of matched numbers.
//
// It is `display: none` outside column mode — gated by the *same* container query
// as the columns — so a header can never appear above a folded row, which is the
// one thing that would make it a lie.
export function buildHeaderCells(
  ids: ColumnId[],
  sort: SortState,
  onClick: ((id: ColumnId) => void) | null,
): HTMLElement[] {
  return ids.map((id) => {
    const def = BY_ID.get(id);
    const classes = ["col-cell", "colhead-cell"];
    if (def?.numeric) classes.push("col-num");
    const sorted = sort != null && sort.id === id;
    if (sorted) classes.push("sorted");
    // The sort indicator is a caret plus a lift to full --text. Deliberately NOT
    // the accent: accent text already means "this is open in the right pane"
    // everywhere else in the app, and a sorted header is not that.
    const label = def ? def.label : id;
    const el = h("span", {
      class: classes.join(" "),
      text: sorted ? `${label} ${sort!.dir > 0 ? "▲" : "▼"}` : label,
      data: { col: id },
    });
    if (onClick) {
      el.classList.add("sortable");
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        onClick(id);
      });
    }
    return el;
  });
}

// --- sorting ----------------------------------------------------------------

export function sortTracks(tracks: SearchTrack[], sort: SortState): SearchTrack[] {
  if (!sort) return tracks;
  const def = BY_ID.get(sort.id);
  if (!def) return tracks;
  // Stable (Array.sort is stable), so re-sorting by a field with ties keeps the
  // previous order inside each tie — sorting by Album then Artist groups sensibly.
  return tracks.slice().sort((a, b) => {
    const ka = def.key(a);
    const kb = def.key(b);
    if (ka === kb) return 0;
    return (ka < kb ? -1 : 1) * sort.dir;
  });
}

// Advance a header click: unsorted → ascending → descending → unsorted.
export function nextSort(current: SortState, id: ColumnId): SortState {
  if (!current || current.id !== id) return { id, dir: 1 };
  if (current.dir === 1) return { id, dir: -1 };
  return null;
}

// --- the menu ---------------------------------------------------------------

// Re-render hooks, registered by each pane's owner (main.ts / queue.ts) so this
// module stays a leaf and doesn't import either of them.
const repaint: Record<ColumnPane, () => void> = { library: () => {}, queue: () => {} };

export function setColumnRepaint(pane: ColumnPane, fn: () => void): void {
  repaint[pane] = fn;
}

function commit(pane: ColumnPane): void {
  void persist();
  repaint[pane]();
}

// Switch a pane between automatic and a literal set — the two directions of the
// `Auto columns` checkbox.
//
// Turning it *off* materializes whatever the automatic set currently resolves to,
// so unticking it changes nothing on screen: it hands the user the list they were
// already looking at to edit, rather than a canned default. Turning it back *on*
// discards their set (and, for the library, the sticky sort that only exists once
// a header is up), restoring the per-list behavior the pane shipped with.
function setAutomatic(pane: ColumnPane, on: boolean, auto: ColumnId[]): void {
  columnSets[pane].value = on ? null : canonical(auto);
  if (on && pane === "library") librarySort.value = null;
  commit(pane);
}

// Toggle one field in a pane's set. The first toggle is also what takes the pane
// out of automatic mode, and it does so by *materializing* whatever the automatic
// set currently resolves to — so ticking "Album" adds a column to the list you are
// already looking at rather than resetting you to some canned default.
function toggleColumn(pane: ColumnPane, id: ColumnId, auto: ColumnId[]): void {
  const current = columnSets[pane].peek() ?? auto;
  const set = new Set(canonical(current));
  if (set.has(id)) set.delete(id);
  else set.add(id);
  set.add("title"); // the primary is not optional
  columnSets[pane].value = canonical([...set]);
  commit(pane);
}

// The `Columns ▸` submenu for a pane. Lives in the row context menu, so which
// pane it edits is implicit in what you right-clicked — no labeling needed and no
// focused-pane inference. (A View-menu mirror would need explicit
// `Columns ▸ Library ▸` / `Columns ▸ Queue ▸` submenus; that lives in the native
// menu bar, and the row menu is where the pane is unambiguous.)
export function columnsMenuItem(pane: ColumnPane, auto: ColumnId[]): ContextMenuItem {
  // A thunk, so every checkmark is read at the moment the menu is raised rather
  // than whenever this item was constructed. A native menu dismisses on any
  // click, so each tick costs a fresh right-click — the OS owns that, and it is
  // how the system's own column pickers behave.
  const build = (): ContextMenuItem[] => {
    const shown = new Set(activeColumns(pane, auto));
    // The two switches lead, above the fields. Neither is a field to tick: one
    // decides whether the pane picks its own fields per list, the other whether the
    // columns are labelled at all. Both govern the whole list below them, and a
    // list that long is far too long to bury either under — buried, they read as
    // missing.
    const automatic = isAutomatic(pane);
    return [
      {
        label: "Auto columns",
        checked: automatic,
        action: () => setAutomatic(pane, !automatic, auto),
      },
      {
        label: "Show header",
        checked: columnHeaders[pane].peek(),
        action: () => {
          columnHeaders[pane].value = !columnHeaders[pane].peek();
          commit(pane);
        },
      },
      { separator: true },
      ...COLUMNS.map((c) => ({
        label: c.label,
        checked: shown.has(c.id),
        // The title is the row; there is no row without it.
        disabled: c.id === "title",
        action: () => toggleColumn(pane, c.id, auto),
      })),
    ];
  };
  return { label: "Columns", submenu: build };
}

// --- persistence ------------------------------------------------------------
//
// Stored as explicit field-id arrays rather than as an encoded layout, so a later
// field rename or reorder is a lookup miss (dropped silently by `canonical`)
// instead of a migration.
const KEY = "columnPrefs";

interface StoredPrefs {
  library?: ColumnId[] | null;
  queue?: ColumnId[] | null;
  libraryHeaders?: boolean;
  queueHeaders?: boolean;
  librarySort?: SortState;
}

export async function persist(): Promise<void> {
  if (!app.store) return;
  const prefs: StoredPrefs = {
    library: columnSets.library.peek(),
    queue: columnSets.queue.peek(),
    libraryHeaders: columnHeaders.library.peek(),
    queueHeaders: columnHeaders.queue.peek(),
    librarySort: librarySort.peek(),
  };
  try {
    await app.store.set(KEY, prefs);
    await app.store.save();
  } catch (e) {
    console.error("column prefs save failed", e);
  }
}

// Drop ids this build no longer knows about, so a downgrade (or a renamed field)
// degrades to "that column is gone" rather than to a broken grid template.
function sanitize(ids: ColumnId[] | null | undefined): ColumnId[] | null {
  if (!Array.isArray(ids)) return null;
  const known = ids.filter((id) => BY_ID.has(id));
  return canonical(known);
}

export async function loadColumnPrefs(): Promise<void> {
  if (!app.store) return;
  try {
    const prefs = await app.store.get<StoredPrefs>(KEY);
    if (!prefs) return;
    columnSets.library.value = sanitize(prefs.library);
    columnSets.queue.value = sanitize(prefs.queue);
    columnHeaders.library.value = prefs.libraryHeaders === true;
    columnHeaders.queue.value = prefs.queueHeaders === true;
    const s = prefs.librarySort;
    librarySort.value = s && BY_ID.has(s.id) ? { id: s.id, dir: s.dir === -1 ? -1 : 1 } : null;
  } catch (e) {
    console.error("column prefs load failed", e);
  }
}
