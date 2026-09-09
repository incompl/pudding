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
//   3. The user chooses *what*; the pane chooses *how* until they say otherwise.
//      A field carries a static grid weight (see ColumnDef.weight) and the pane
//      divides its width by those weights, so a set of columns lays itself out with
//      nothing to configure — and a pane the user never touches stays that way.
//      Dragging a header divider overrides the weight for the two columns it sits
//      between (see resizedWidths). The override is a *share*, not a pixel count:
//      the layout still spends the pane's whole width, so a resized table never
//      scrolls sideways, never leaves a gutter, and still reflows when the splitter
//      moves. Widths are per pane and persisted; `Reset column widths` hands the
//      pane back to the weights above.
//
// State is per pane (library / queue), because the app already shipped two
// hard-coded field sets: the queue row composed the artist and deliberately never
// the album, while the leaf lists composed `artist · album`. Exposing that as two
// column lists rather than one global one keeps both defaults intact.
//
// Every offered field is read from the file itself, and falls into one of three
// kinds:
//
//   - its tags: title, artist, album, album artist, disc, genre, year, gain
//   - its audio properties: duration, bit rate — present even on an untagged file,
//     which is why these two can't be blank the way a tag column can
//   - the filesystem: kind, location, date created, date modified
//
// A field Pudding doesn't index is not in the table at all: a column that can only
// ever be blank is worse than an absent one, and a column filled from anywhere but
// the file would be a column the user can't fix by fixing their tags. That rule is
// what rules out the fields other players offer here — play count, rating, date
// added, favourite. Pudding's database is a disposable cache of what the files say;
// it holds nothing of the user's own, so a column backed by one of those would be
// promising a memory the app doesn't have.
//
// The track number is absent for the opposite reason: every row already carries a
// number in its gutter, in both panes and at every width, so a `#` column would be
// a second number beside the one that is always there. Disc is offered because
// nothing draws that one.

import { signal, type Signal } from "@preact/signals-core";
import { h } from "./dom";
import type { SearchTrack, ContextMenuItem } from "./types";
import { app } from "./state";
import { showContextMenu } from "./context-menu";

export type ColumnPane = "library" | "queue";

export type ColumnId =
  | "title"
  | "artist"
  | "album"
  | "albumArtist"
  | "disc"
  | "genre"
  | "year"
  | "kind"
  | "duration"
  | "bitrate"
  | "gain"
  | "created"
  | "modified"
  | "location";

export interface ColumnDef {
  id: ColumnId;
  label: string;
  // Share of the leftover width in column mode, as a grid `fr`. Text fields carry
  // a weight; `fixed` fields (the kind, the runtime) are sized to the widest value
  // in the *list* instead (see gridTemplate), so they stay legible however many
  // columns are crowded in beside them.
  weight: number;
  fixed?: boolean;
  // Right-aligned, tabular figures: times and counts read as a column of numbers.
  numeric?: boolean;
  get(t: SearchTrack): string;
  // Sort key. Strings sort case-insensitively; numbers sort numerically.
  key(t: SearchTrack): string | number;
  // Widest cell this column can ever render, for a `fixed` column whose width is a
  // property of its *format* rather than of the list. Constant cost: it replaces
  // the per-track scan in fixedWidth, which for a formatted field means a
  // per-track format call on every render. See the date columns.
  widest?(): string;
  // Is this track's cell empty? Defaults to `get(t) === ""`, which for a formatted
  // field means formatting every track just to ask — so a column with an
  // expensive `get` answers from the raw field instead. Must agree with `get`.
  blank?(t: SearchTrack): boolean;
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

// A file timestamp (unix seconds) as a short local date and time. Locale-formatted
// rather than ISO: this is a date the reader scans down a column, not a key they
// parse, and the rest of the app's dates are the system's too.
function fmtDate(seconds: number): string {
  return new Date(seconds * 1000).toLocaleString(undefined, {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

// A timestamp with every field of that format at its widest: a two-digit month and
// day, a four-digit year, a two-digit hour in both the 12- and 24-hour renderings
// (22 -> "10 PM" / "22"), and a minute that is always two digits. Formatting this
// one date measures the column exactly, whatever the reader's locale orders the
// fields into — see `widest` on the date columns below.
const WIDEST_DATE = new Date(2026, 11, 30, 22, 58).getTime() / 1000;

// A ReplayGain figure, with its unit and an explicit sign. Both are deliberate:
// headers are optional (see columnHeaders), so a bare "-7.89" in a column the reader
// hasn't labelled is a number with no meaning, and the sign is the whole point of
// the value — it says whether the file gets turned down or up.
function fmtGain(db: number): string {
  return `${db >= 0 ? "+" : ""}${db.toFixed(2)} dB`;
}

// --- the field table --------------------------------------------------------
//
// Order here is column order on screen and item order in the `Columns ▸` menu.
// There is no reordering UI, deliberately — and unlike widths, that isn't a gap.
// A column's *place* is a property of the field table, which is what lets two panes
// showing the same fields agree on their order and lets a field unticked and
// re-ticked come back where it was. A column's *width* is the opposite: it depends
// on the pane, the library, and what the user is reading for, which is precisely
// why that one is theirs to set and this one isn't.
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
  // Disc, not track. Every row already carries a number in its gutter, so a `#`
  // column would be a second number beside the one that is always there — but
  // nothing draws the disc, and on a multi-disc set it is the field that says why
  // two rows both call themselves track 1.
  {
    id: "disc",
    label: "Disc",
    weight: 0,
    fixed: true,
    numeric: true,
    get: (t) => (t.disc != null ? String(t.disc) : ""),
    key: (t) => t.disc ?? 0,
  },
  {
    id: "genre",
    label: "Genre",
    weight: 1.0,
    get: (t) => t.genre ?? "",
    key: (t) => (t.genre ?? "").toLowerCase(),
  },
  {
    id: "year",
    label: "Year",
    weight: 0,
    fixed: true,
    numeric: true,
    get: (t) => (t.year != null && t.year > 0 ? String(t.year) : ""),
    key: (t) => t.year ?? 0,
  },
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
  // Like Kind, a fact about the file rather than about its tags — read from the
  // audio properties, so it is there even when nothing else is. It is the column
  // that separates "this album is FLAC" from "this album is a good rip": Kind names
  // the container, this one says what is actually in it.
  {
    id: "bitrate",
    label: "Bit Rate",
    weight: 0,
    fixed: true,
    numeric: true,
    get: (t) => (t.bitrate != null && t.bitrate > 0 ? `${t.bitrate} kbps` : ""),
    key: (t) => t.bitrate ?? 0,
  },
  // The raw REPLAYGAIN_TRACK_GAIN tag, not the multiplier playback applies — the
  // same "what does this file say" rule as Album Artist above, and for the same
  // reason: the point of putting this column up is to find the files that carry no
  // gain tag, and anything derived would fill those cells in and hide them. It is
  // the only view Pudding has of an otherwise invisible input: with ReplayGain on,
  // a blank cell is exactly a row the setting cannot act on.
  {
    id: "gain",
    label: "Gain",
    weight: 0,
    fixed: true,
    numeric: true,
    get: (t) => (t.gain != null ? fmtGain(t.gain) : ""),
    key: (t) => t.gain ?? 0,
  },
  // Two file dates, and deliberately not one "Date Added": Pudding keeps no library
  // bookkeeping to back that name (the cache is disposable, the files are the truth),
  // so the honest columns are the ones the filesystem actually holds.
  //
  // Created is the better of the two for "what did I just add", because Pudding's own
  // metadata editor rewrites files and bumps their mtime — a tagging pass would
  // otherwise reshuffle a Modified sort into "files I recently edited". Modified is
  // kept because the two disagree in the other direction too: restoring a library
  // from a backup preserves mtime while resetting creation time.
  {
    id: "created",
    label: "Date Created",
    weight: 0,
    fixed: true,
    get: (t) => (t.created != null && t.created > 0 ? fmtDate(t.created) : ""),
    key: (t) => t.created ?? 0,
    widest: () => fmtDate(WIDEST_DATE),
    blank: (t) => !(t.created != null && t.created > 0),
  },
  {
    id: "modified",
    label: "Date Modified",
    weight: 0,
    fixed: true,
    get: (t) => (t.modified != null && t.modified > 0 ? fmtDate(t.modified) : ""),
    key: (t) => t.modified ?? 0,
    widest: () => fmtDate(WIDEST_DATE),
    blank: (t) => !(t.modified != null && t.modified > 0),
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

// Per-column width overrides, set by dragging a header divider. Sparse on purpose:
// an id absent here is a column still sized by rule 3, so a pane the user has never
// dragged in stores nothing at all and picks up any later change to the weights.
//
// One map, two units — each override is the number that column's own grid track
// already carries, so the whole of gridTemplate's width logic is `override ??
// compute it`:
//
//   text fields  → an `fr` weight, replacing ColumnDef.weight. A *share*, not a
//     size: the pane still divides its width by the weights, so a dragged table
//     reflows with the splitter exactly as an undragged one does.
//   fixed fields → a width in `ch`, replacing the measured fit. Still type-relative,
//     so a dragged Time column is the same number of characters wide at any font
//     size — and it stops tracking the list, which is the point of dragging it.
//
// Weights are renormalised on every drag so their total stays the total of the
// same columns' *default* weights (see resizedWidths). Nothing on screen depends on
// that — `fr` is relative — but it keeps a stored weight comparable to the table's,
// so a column ticked on later lands at a sane width beside the dragged ones instead
// of at a hundredth of one.
export type ColumnWidths = Partial<Record<ColumnId, number>>;

export const columnWidths: Record<ColumnPane, Signal<ColumnWidths>> = {
  library: signal<ColumnWidths>({}),
  queue: signal<ColumnWidths>({}),
};

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
// the `--cols` custom property. Computed once per list, not per row — see below
// for why the list is the only thing that may decide a track's width.
//
// Two kinds of track:
//
//   minmax(0, Wfr) — text fields. The `0` minimum is the whole "you made the mess"
//     policy in one token: with a `ch` minimum the row would overflow its pane
//     once enough columns were added (and the only cures are a horizontal
//     scrollbar or dropping fields). With `0`, an over-full row just gets thin
//     and every cell ellipsizes — dense, legible, and obviously self-inflicted.
//   <n>ch — fixed fields (times, kinds). Short and load-bearing; squeezing "3:45"
//     to "3…" saves nothing and costs everything, so these never take an fr share
//     and never shrink with the pane.
//
// The fixed track is a length rather than `max-content` because **every row is its
// own grid**. A max-content track is measured against the text of the row it is
// in, so a list holding one 10:34 beside a screenful of 4:14 lays that row out on
// its own column boundaries — the whole row's album and artist shifted left by the
// width of a digit. The header, a third grid with a third set of contents, is off
// by its own amount again. A track that is a function of the *list* is identical
// in all of them by construction, which is the only way separate grids can agree.
// A dragged column takes its stored override in place of the number it would have
// worked out for itself — the weight for a text field, the fitted `ch` for a fixed
// one — and the shape of its track is otherwise unchanged. So a resized text column
// is still `minmax(0, Nfr)`: it keeps the `0` minimum and keeps taking its share of
// the pane, which is what makes a dragged table reflow with the splitter and never
// overflow. `pane` is optional so a caller with no pane in hand (a test, a one-off
// measurement) gets the unmodified rule-3 layout.
export function gridTemplate(
  ids: ColumnId[],
  tracks: SearchTrack[] = [],
  withHeader = false,
  pane?: ColumnPane,
): string {
  const widths = pane ? columnWidths[pane].peek() : undefined;
  return ids
    .map((id) => {
      const def = BY_ID.get(id);
      if (!def) return "minmax(0, 1fr)";
      const set = widths?.[id];
      if (!def.fixed) return `minmax(0, ${set ?? def.weight}fr)`;
      if (set != null) return `${set}ch`;
      const ch = fixedWidth(def, tracks, withHeader);
      // No rows to measure (an empty list, or a caller that has none to hand):
      // fall back to the row's own content, which is what a single row wants
      // anyway and can't disagree with a list that isn't there.
      return ch > 0 ? `${ch}ch` : "max-content";
    })
    .join(" ");
}

// How wide a fixed column has to be, in `ch` — the advance of a `0`, so the answer
// scales with the type rather than pinning a pixel count.
//
// Widest of what the column must hold:
//   • the widest value in the list. Digits and colons never outrun a `0`, so for a
//     numeric field the character count is already an upper bound; letters do
//     (KIND's FLAC/WAV), so those count at CAP_CH.
//   • its own header label, when the header is up, at the header's smaller type,
//     plus the sort mark's box. The mark's space is reserved whether or not this
//     is the sorted column, so clicking a header re-sorts the rows without also
//     moving the column boundaries under them.
//
// Both estimates round *up*. A column an em too wide costs a sliver of gap in the
// shortest column on screen; one an em too narrow ellipsizes a time, which is the
// one thing a column of times cannot do.
const CAP_CH = 1.5; // a capital W over a 0
const LABEL_CH = 1.2; // mixed-case UI text, per character, over a 0
const HEAD_EM = 0.88; // .colhead-cell's font-size
const MARK_CH = 1.5; // the sort mark's box plus its gap

function fixedWidth(def: ColumnDef, tracks: SearchTrack[], withHeader: boolean): number {
  let content = 0;
  const first = tracks[0];
  if (def.widest) {
    // A column whose width is a fact about its format, not about the list: every
    // cell is the same handful of fields, so the widest one it can *ever* render
    // sizes it exactly, at the cost of a single format call. The numeric shortcut
    // below can't do this job for a date — formatted width isn't monotonic in the
    // timestamp ("12/31/2025, 10:00 PM" is wider than the later "1/1/2026, 1:00
    // AM"), so measuring the ends of the range would under-size the column and
    // ellipsize it, the one failure this measurement exists to prevent.
    //
    // Not scaled by CAP_CH: like the numeric branch, this is the real string, and
    // its content is digits and separators rather than the proportional text that
    // cap is there to cover.
    content = def.widest().length;
  } else if (def.numeric && first != null && typeof def.key(first) === "number") {
    // A numeric field's widest cell sits at one end of its range, so find both ends
    // by key and format just those two — one numeric compare per track, rather than
    // building a string for every row of a hundred-thousand-track Songs list on
    // every render.
    //
    // Both ends, not just the largest: Gain is signed, and its widest cell is the
    // most *negative* value ("-11.25 dB" over "+2.50 dB") — which is the common case,
    // since ReplayGain figures are usually negative. Measuring only the maximum
    // under-sizes that column, and a fixed column that comes out too narrow
    // ellipsizes, which is the one failure this measurement exists to prevent.
    let max = -Infinity;
    let min = Infinity;
    let hi: SearchTrack | null = null;
    let lo: SearchTrack | null = null;
    for (const t of tracks) {
      const k = def.key(t) as number;
      if (k > max) {
        max = k;
        hi = t;
      }
      if (k < min) {
        min = k;
        lo = t;
      }
    }
    content = Math.max(hi ? def.get(hi).length : 0, lo ? def.get(lo).length : 0);
  } else {
    for (const t of tracks) {
      const n = def.get(t).length;
      if (n > content) content = n;
    }
    content *= CAP_CH;
  }
  const head = withHeader ? def.label.length * LABEL_CH * HEAD_EM + MARK_CH : 0;
  return Math.ceil(Math.max(content, head));
}

// --- resizing ---------------------------------------------------------------
//
// A divider sits between two adjacent columns and trades width between exactly
// those two: the boundary you are holding is the only one that moves, and every
// other column stays where the reader left it. That also keeps the row's total
// width constant by construction — the one property everything else here rests on,
// since a table that can't change its own total can't overflow the pane, can't
// leave a gutter at the right edge, and needs no horizontal scrollbar to be honest
// (rule 2). It is why there is no divider after the last column: there would be
// nothing on the far side to take the width from.
//
// The result is written back as *shares* rather than pixels — see ColumnWidths.

// The narrowest a drag may leave a column: enough for a character and its ellipsis.
// Below that a column is no longer a thin column, it's a mistake with no visible
// handle left to undo it with — and unlike an over-full row, squeezing here isn't
// something the reader can see themselves doing.
const MIN_CH = 3;

function round(n: number, places: number): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

// Resolve one divider drag.
//
// Takes the track widths the grid was actually laid out at (px, read off the live
// header — the only honest source, since `fr` and `ch` both resolve against things
// this module can't compute) and returns both halves of the answer: the pixel
// widths to paint while the mouse is still down, and the overrides to store when it
// comes up. One function, so what the drag draws and what the drag saves cannot
// drift apart.
//
// Which columns end up with an override:
//   • every text column in the set, always. Their weights are rewritten from the
//     final pixels — which leaves an untouched one at exactly the weight it already
//     had when the pair was text-on-text, and is what *holds* it still when the
//     pair involved a fixed column and the fr pool therefore changed size.
//   • a fixed column only when the divider is one of its own. Pinning Time's width
//     because the user dragged Title/Artist would quietly stop it fitting the list,
//     which is a change nobody asked for at a divider they never touched.
export function resizedWidths(
  prev: ColumnWidths,
  ids: ColumnId[],
  index: number,
  startPx: readonly number[],
  dx: number,
  ch: number,
): { widths: ColumnWidths; px: number[] } {
  const px = startPx.slice();
  const pair = startPx[index] + startPx[index + 1];
  // Clamp to the floor from *both* ends: the pair's total is fixed, so holding the
  // left column above the minimum is the same act as holding the right one above
  // it. A pair too narrow to give both the floor splits what there is instead of
  // refusing to move at all.
  const min = Math.min(MIN_CH * ch, pair / 2);
  px[index] = Math.max(min, Math.min(pair - min, startPx[index] + dx));
  px[index + 1] = pair - px[index];

  const widths: ColumnWidths = { ...prev };
  let flexPx = 0;
  let flexWeight = 0;
  ids.forEach((id, i) => {
    const def = BY_ID.get(id);
    if (!def || def.fixed) return;
    flexPx += px[i];
    flexWeight += def.weight;
  });
  // Rescale so the stored weights total what the same columns' defaults total (see
  // ColumnWidths). `fr` is relative, so this changes nothing on screen.
  const scale = flexPx > 0 && flexWeight > 0 ? flexWeight / flexPx : 0;
  ids.forEach((id, i) => {
    const def = BY_ID.get(id);
    if (!def) return;
    if (def.fixed) {
      if (i === index || i === index + 1) widths[id] = round(px[i] / ch, 2);
    } else if (scale > 0) {
      widths[id] = round(px[i] * scale, 3);
    }
  });
  return { widths, px };
}

// The grid's used track widths, in px. Computed style resolves `fr` and `ch` for
// us, which is the whole reason a drag reads its starting point off the DOM rather
// than recomputing the template it wrote. Empty unless the element really is a laid
// out grid: below the fold gate the same node is inline text and its computed
// template is the unresolved `minmax(0, 2.4fr) ...` string, which is not a
// measurement and must never be mistaken for one.
function trackWidths(grid: HTMLElement): number[] {
  const parts = getComputedStyle(grid)
    .gridTemplateColumns.split(/\s+/)
    .filter(Boolean)
    .map(parseFloat);
  return parts.length > 0 && parts.every((n) => isFinite(n)) ? parts : [];
}

// The advance of a `0` at the grid's own type, measured rather than assumed —
// `ch` in the template resolves against this element's font, so this is the one
// number that converts between what the browser laid out and what gets stored.
// Absolutely positioned, so the probe never becomes a grid item and the row it is
// measured inside doesn't reflow around it.
function chPx(grid: HTMLElement): number {
  const probe = h("span", { class: "col-ch-probe" });
  grid.appendChild(probe);
  const w = probe.getBoundingClientRect().width;
  probe.remove();
  return w > 0 ? w : 8;
}

// Every grid in the pane — the header and each mounted row — so a drag can repaint
// them all directly. Live rows are not rebuilt while the mouse is down: a drag is a
// continuous gesture over a list that is not changing, and tearing the list down
// per mousemove would cost a full render of the pane per frame and drop the scroll
// position under the reader's cursor. The model is written once, on mouseup.
function paneGrids(pane: ColumnPane, header: HTMLElement): HTMLElement[] {
  const root = columnHost[pane]();
  if (!root) return [header];
  return [...root.querySelectorAll<HTMLElement>(".col-grid")];
}

function beginResize(e: MouseEvent, pane: ColumnPane, ids: ColumnId[], index: number): void {
  const grid = (e.currentTarget as HTMLElement).closest<HTMLElement>(".col-grid");
  if (!grid) return;
  const startPx = trackWidths(grid);
  if (startPx.length !== ids.length) return;
  e.preventDefault();
  e.stopPropagation();
  const ch = chPx(grid);
  const startX = e.clientX;
  const grip = e.currentTarget as HTMLElement;
  grip.classList.add("col-resizing");
  const grids = paneGrids(pane, grid);
  // The template every grid in the pane is currently wearing (they all wear the
  // same one), so a drag that ends where it started can hand it back — see onUp.
  const original = grid.style.getPropertyValue("--cols");
  const prev = columnWidths[pane].peek();
  let widths = prev;
  // Whether the boundary is anywhere but where it started, which is not the same
  // question as whether the mouse moved: a drag held past the floor, or dragged out
  // and back, ends with the columns exactly as they were.
  let moved = false;
  // The splitter's own drag class: same cursor held across the whole window, same
  // suppressed text selection, and it already means "a col-resize drag is in
  // progress" — which this is.
  document.body.classList.add("dragging");

  const onMove = (ev: MouseEvent): void => {
    const next = resizedWidths(prev, ids, index, startPx, ev.clientX - startX, ch);
    moved = next.px.some((w, i) => w !== startPx[i]);
    widths = next.widths;
    // Painted from the drag's own pixels rather than from the template the commit
    // will write. They agree — the commit is computed from these same pixels — but
    // the pixels are exact and need no second pass over the list to size the fixed
    // columns the drag isn't touching.
    const template = next.px.map((w) => `${w}px`).join(" ");
    for (const g of grids) g.style.setProperty("--cols", template);
  };

  const onUp = (): void => {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    document.body.classList.remove("dragging");
    grip.classList.remove("col-resizing");
    if (!moved) {
      // Nothing to save — and nothing to keep: the pane is still wearing the pixel
      // template the drag painted, which is the same layout but no longer a set of
      // shares, so it would sit frozen until the next rebuild instead of reflowing
      // with the splitter. Put the shares back.
      for (const g of grids) g.style.setProperty("--cols", original);
      return;
    }
    // A drag that ends inside the header cell it started in still fires a click on
    // that cell, and that cell sorts the list. Swallow exactly one, in the capture
    // phase so it never reaches the handler; the timeout is the case where no click
    // follows at all (a mouseup outside the window), so the guard can't sit armed
    // and eat the user's next real click on something else.
    const swallow = (ev: MouseEvent): void => {
      ev.stopPropagation();
      ev.preventDefault();
    };
    document.addEventListener("click", swallow, true);
    setTimeout(() => document.removeEventListener("click", swallow, true), 0);
    columnWidths[pane].value = widths;
    commit(pane);
  };

  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

// Give the two columns a divider sits between back to rule 3 — the system's
// double-click-the-divider gesture. Both sides, not just the left one: the divider
// is the boundary between a pair, and every other gesture on it (the drag above)
// treats that pair as the unit.
function resetPair(pane: ColumnPane, ids: ColumnId[], index: number): void {
  const widths = { ...columnWidths[pane].peek() };
  delete widths[ids[index]];
  delete widths[ids[index + 1]];
  columnWidths[pane].value = widths;
  commit(pane);
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
//
// Each header but the last also carries the divider on its trailing edge (see the
// resizing section). It rides the cell rather than sitting between cells because
// the grid has no gap element to hang it on — the gap is a gap — and because a
// divider belongs to a boundary, which is a fact about the cell it follows.
export function buildHeaderCells(
  pane: ColumnPane,
  ids: ColumnId[],
  sort: SortState,
  onClick: ((id: ColumnId) => void) | null,
): HTMLElement[] {
  return ids.map((id, i) => {
    const def = BY_ID.get(id);
    const classes = ["col-cell", "colhead-cell"];
    if (def?.numeric) classes.push("col-num");
    const sorted = sort != null && sort.id === id;
    if (sorted) classes.push("sorted");
    // The sort indicator is the system's: a small triangle on the sorted header,
    // point up for ascending. The mark is the whole signal — the label is not
    // tinted, lit, or weighted, since it is the only header carrying a glyph at
    // all (see .colhead-cell.sorted in styles.css for why the ink stays put).
    //
    // The triangle is a sibling element, not a glyph appended to the label, for
    // three reasons: a label narrower than its column ellipsizes *around* it
    // rather than eating it ("Album A…" with the mark still visible); it can be
    // sized and inked on its own (smaller and dimmer than the text, as the
    // system's is); and only the label carries the column's name, so a click
    // handler, a test, or a screen reader reads "Album", not "Album ▼".
    const label = def ? def.label : id;
    const el = h(
      "span",
      { class: classes.join(" "), data: { col: id } },
      h("span", { class: "colhead-label", text: label }),
      sorted &&
        h("span", {
          class: `colhead-arrow ${sort!.dir > 0 ? "asc" : "desc"}`,
          attrs: { "aria-hidden": "true" },
        }),
      i < ids.length - 1 &&
        h("span", {
          class: "colhead-grip",
          attrs: { "aria-hidden": "true" },
          on: {
            mousedown: (e) => beginResize(e, pane, ids, i),
            // A press that never became a drag is still a press on the divider, not
            // on the header behind it: swallow its click so grabbing a divider and
            // changing your mind doesn't re-sort the list.
            click: (e) => e.stopPropagation(),
            dblclick: (e) => {
              e.stopPropagation();
              resetPair(pane, ids, i);
            },
          },
        }),
    );
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

// A cell with nothing in it. Read off what the column *draws* rather than off the
// tag behind it, so the rule the user sees is the rule that runs: the rows with a
// blank there are the rows that sort together, whatever made them blank (no tag, an
// empty tag, a duration the file never reported).
function isBlank(def: ColumnDef, t: SearchTrack): boolean {
  return def.blank ? def.blank(t) : def.get(t) === "";
}

export function sortTracks(tracks: SearchTrack[], sort: SortState): SearchTrack[] {
  if (!sort) return tracks;
  const def = BY_ID.get(sort.id);
  if (!def) return tracks;
  // Decorated once per track rather than per comparison: key() and the blank test
  // then cost n calls instead of the 2n·log n a bare comparator would spend on
  // them — which is the difference between a sort and a stall on a Songs list.
  const rows = tracks.map((t) => ({ t, key: def.key(t), blank: isBlank(def, t) }));
  // Stable (Array.sort is stable), so re-sorting by a field with ties keeps the
  // previous order inside each tie — sorting by Album then Artist groups sensibly.
  rows.sort((a, b) => {
    // Blanks sink, in *both* directions. An empty cell isn't a value that ranks
    // above "A" or below "Z" — it's the absence of one, and a reader scanning a
    // sorted column wants the rows that answer the question first and the ones
    // that don't at the end, whichever way the arrow points. (The same rule a
    // spreadsheet applies to empty cells; reversing them to the top on the second
    // click would bury the A's under the tracks that have no artist at all.)
    if (a.blank !== b.blank) return a.blank ? 1 : -1;
    if (a.key === b.key) return 0;
    return (a.key < b.key ? -1 : 1) * sort.dir;
  });
  return rows.map((r) => r.t);
}

// Is this list already in the order `sort` describes?
//
// For the queue, which has no sticky sort: a header there is an *edit*, so the
// mark above it can't be a remembered click — a drag, an add, a remove or an undo
// leaves the remembered click describing an order the rows no longer have. So the
// queue's mark is derived from the rows instead, every paint: it is shown only
// while this says the rows really are in that order, which makes the arrow a claim
// about what is on screen rather than a memory of what was asked for.
//
// One pass, no allocation, and ties are ignored — a list sorted by album whose
// rows were then shuffled *within* one album is still sorted by album, and the
// mark should survive that as honestly as it dies on a cross-album drag.
export function isSortedBy(tracks: SearchTrack[], sort: SortState): boolean {
  if (!sort) return false;
  const def = BY_ID.get(sort.id);
  if (!def) return false;
  for (let i = 1; i < tracks.length; i++) {
    const prev = tracks[i - 1];
    const cur = tracks[i];
    // Blanks belong at the end, both directions (see sortTracks) — so a blank
    // above a filled cell is the one thing that breaks the order, and a blank
    // below one never does.
    const blankPrev = isBlank(def, prev);
    const blankCur = isBlank(def, cur);
    if (blankPrev || blankCur) {
      if (blankPrev && !blankCur) return false;
      continue;
    }
    const a = def.key(prev);
    const b = def.key(cur);
    if (a === b) continue;
    if ((a < b ? -1 : 1) * sort.dir > 0) return false;
  }
  return true;
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

// Widen the pane until column mode fits, registered the same way (main.ts owns the
// splitter). This module knows a pane can be too narrow for what was just asked of
// it; it deliberately doesn't know what a splitter is.
const makeRoom: Record<ColumnPane, () => void> = { library: () => {}, queue: () => {} };

export function setColumnRoom(pane: ColumnPane, fn: () => void): void {
  makeRoom[pane] = fn;
}

// The pane's list container, registered the same way again — a divider drag
// repaints every mounted row in the pane, and this module knows a pane has rows
// without knowing where either pane keeps them.
const columnHost: Record<ColumnPane, () => HTMLElement | null> = {
  library: () => null,
  queue: () => null,
};

export function setColumnHost(pane: ColumnPane, fn: () => HTMLElement | null): void {
  columnHost[pane] = fn;
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
  if (on) {
    // Dragged widths go with it. "Automatic" is a claim about the whole layout, not
    // just the field list — a pane still wearing a set of hand-dragged boundaries
    // isn't one the app is choosing for you.
    columnWidths[pane].value = {};
    if (pane === "library") librarySort.value = null;
  }
  commit(pane);
}

// Toggle one field in a pane's set. The first toggle is also what takes the pane
// out of automatic mode, and it does so by *materializing* whatever the automatic
// set currently resolves to — so ticking "Album" adds a column to the list you are
// already looking at rather than resetting you to some canned default.
function toggleColumn(pane: ColumnPane, id: ColumnId, auto: ColumnId[]): void {
  const current = columnSets[pane].peek() ?? auto;
  const set = new Set(canonical(current));
  const showing = !set.has(id);
  if (showing) set.add(id);
  else set.delete(id);
  set.add("title"); // the primary is not optional
  const next = canonical([...set]);
  columnSets[pane].value = next;
  // Ask the pane for the width when the fold would otherwise swallow the field
  // just ticked. Below the gate the row is a single line that stops at two fields
  // (see the dense cap), so a third one lands nowhere and the tick reads as a
  // switch with nothing behind it — the same silence the header switch had. A
  // field that *is* one of the first two shows folded already, so ticking it is
  // no reason to move a divider the user placed.
  //
  // Only on the way in. Hiding a field is the opposite request, and a pane you
  // are taking columns out of has no business growing.
  if (showing && next.indexOf(id) >= 2) makeRoom[pane]();
  commit(pane);
}

// The picker itself: the two switches, then a tick per field. Read at the moment
// the menu is raised rather than whenever the item was constructed, so every
// checkmark is live. A native menu dismisses on any click, so each tick costs a
// fresh right-click — the OS owns that, and it is how the system's own column
// pickers behave.
export function columnsMenuItems(pane: ColumnPane, auto: ColumnId[]): ContextMenuItem[] {
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
        const on = !columnHeaders[pane].peek();
        columnHeaders[pane].value = on;
        // A header only exists past the pane's fold gate, and below it the rows
        // are a single inline run with nothing to label — so a tick on a narrow
        // pane is a switch with nothing behind it. Give it the width instead:
        // asking for a header is asking for columns, and the width is the only
        // thing in the way. Switching it back off leaves the width alone, since
        // by then it's the width the user has been reading at.
        if (on) makeRoom[pane]();
        commit(pane);
      },
    },
    ...(Object.keys(columnWidths[pane].peek()).length > 0
      ? [
          // Only when there is something to undo. The gesture that makes widths is a
          // drag on a divider, and the one that unmakes a pair is a double-click on
          // the same divider — but a divider is only reachable with the header up,
          // and it can't say "all of them". So the menu carries the whole-pane undo,
          // and carries it only for a pane that has been dragged: an item that reads
          // as a standing option rather than as the counterweight to something the
          // user did is an item that has to be read past on every open.
          {
            label: "Reset column widths",
            action: () => {
              columnWidths[pane].value = {};
              commit(pane);
            },
          },
        ]
      : []),
    { separator: true },
    ...COLUMNS.map((c) => ({
      label: c.label,
      checked: shown.has(c.id),
      // The title is the row; there is no row without it.
      disabled: c.id === "title",
      action: () => toggleColumn(pane, c.id, auto),
    })),
  ];
}

// The `Columns ▸` submenu for a pane. Lives in the row context menu, so which
// pane it edits is implicit in what you right-clicked — no labeling needed and no
// focused-pane inference. (A View-menu mirror would need explicit
// `Columns ▸ Library ▸` / `Columns ▸ Queue ▸` submenus; that lives in the native
// menu bar, and the row menu is where the pane is unambiguous.)
export function columnsMenuItem(pane: ColumnPane, auto: ColumnId[]): ContextMenuItem {
  return { label: "Columns", submenu: () => columnsMenuItems(pane, auto) };
}

// Right-clicking a header *is* the request the `Columns ▸` submenu spells out, so
// the picker is popped flat rather than buried one level down under a lone item —
// the way the system's own list headers behave. Same pane, same live checkmarks;
// only the wrapper is gone.
export function showColumnsMenuAt(
  e: MouseEvent,
  pane: ColumnPane,
  auto: ColumnId[],
): void {
  e.preventDefault();
  e.stopPropagation();
  void showContextMenu(e.clientX, e.clientY, columnsMenuItems(pane, auto));
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
  libraryWidths?: ColumnWidths;
  queueWidths?: ColumnWidths;
}

export async function persist(): Promise<void> {
  if (!app.store) return;
  const prefs: StoredPrefs = {
    library: columnSets.library.peek(),
    queue: columnSets.queue.peek(),
    libraryHeaders: columnHeaders.library.peek(),
    queueHeaders: columnHeaders.queue.peek(),
    librarySort: librarySort.peek(),
    libraryWidths: columnWidths.library.peek(),
    queueWidths: columnWidths.queue.peek(),
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

// The same rule for widths, and one more: a width has to be a positive, finite
// number to be a width at all. Both units are small — an `fr` weight beside the
// table's 1.6s and 2.4s, or a `ch` count — so anything past CH_CAP is not a wide
// column, it is a corrupt store or an older build's units, and honouring it would
// hand one column the pane and ellipsize every other to nothing. Dropped
// individually, so one bad entry costs one column's width rather than the layout.
const CH_CAP = 200;

function sanitizeWidths(widths: ColumnWidths | undefined): ColumnWidths {
  const out: ColumnWidths = {};
  if (!widths || typeof widths !== "object") return out;
  for (const [id, n] of Object.entries(widths) as [ColumnId, unknown][]) {
    if (!BY_ID.has(id)) continue;
    if (typeof n !== "number" || !isFinite(n) || n <= 0 || n > CH_CAP) continue;
    out[id] = n;
  }
  return out;
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
    columnWidths.library.value = sanitizeWidths(prefs.libraryWidths);
    columnWidths.queue.value = sanitizeWidths(prefs.queueWidths);
    const s = prefs.librarySort;
    librarySort.value = s && BY_ID.has(s.id) ? { id: s.id, dir: s.dir === -1 ? -1 : 1 } : null;
  } catch (e) {
    console.error("column prefs load failed", e);
  }
}
