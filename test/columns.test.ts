// Unit tests for the per-pane column model (src/columns.ts) — the half of the
// column feature that isn't visual. What the rows *look* like at a given pane
// width is a CSS container query and has to be judged by eye; what fields a pane
// resolves, in what order, with what cell text, and what the picker offers are
// plain functions, and those are what regress silently.
//
// columns.ts touches `document` only inside its builders, so a fake DOM installed
// per test is enough — no Tauri, no app build, no browser. persist() no-ops while
// app.store is unset, so nothing here writes to disk.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fake-dom.ts";
import type { ContextMenuItem, SearchTrack } from "../src/types.ts";
import {
  COLUMNS,
  activeColumns,
  librarySort,
  buildCells,
  buildHeaderCells,
  columnSets,
  columnsMenuItem,
  gridClasses,
  gridTemplate,
  nextSort,
  sortTracks,
  NAV_CELLS,
  type ColumnId,
  type SortState,
} from "../src/columns.ts";

beforeEach(() => {
  installFakeDom();
  // Column sets are module-level signals; reset both panes so tests don't leak.
  columnSets.library.value = null;
  columnSets.queue.value = null;
  librarySort.value = null;
});

function track(path: string, extra: Partial<SearchTrack> = {}): SearchTrack {
  return {
    path,
    title: path.split("/").pop() ?? path,
    artist: null,
    album: null,
    albumArtist: null,
    ...extra,
  };
}

const colsOf = (els: HTMLElement[]): (string | null)[] =>
  els.map((e) => e.getAttribute("data-col"));

test("text columns take fr weights; fixed columns take max-content", () => {
  // The 0 minimum is the whole "you made the mess" policy: an over-full row gets
  // thin and ellipsizes instead of overflowing the pane. A ch minimum here would
  // reintroduce horizontal overflow, which the design rules out.
  assert.equal(
    gridTemplate(["title", "artist", "duration"]),
    "minmax(0, 2.4fr) minmax(0, 1.6fr) max-content",
  );
  assert.ok(!gridTemplate(["title", "artist", "album", "albumArtist", "kind"]).includes("ch"));
});

test("a pane's set is canonicalised to table order and always keeps the title", () => {
  // Column order is a property of the field table, not of the order the boxes were
  // ticked in, so two panes showing the same fields always agree on their order.
  assert.deepEqual(activeColumns("library", ["duration", "artist"]), [
    "title",
    "artist",
    "duration",
  ]);
  columnSets.queue.value = ["duration", "album"] as ColumnId[];
  assert.deepEqual(activeColumns("queue", ["title"]), ["title", "album", "duration"]);
});

test("the panes hold independent sets", () => {
  columnSets.library.value = ["title", "album"] as ColumnId[];
  assert.deepEqual(activeColumns("library", ["title", "artist"]), ["title", "album"]);
  // The queue is untouched and still resolves its own automatic set.
  assert.deepEqual(activeColumns("queue", ["title", "artist", "duration"]), [
    "title",
    "artist",
    "duration",
  ]);
});

test("a row emits exactly one cell per column, in order, including empty ones", () => {
  const t = track("/m/a.flac", { artist: "Alice", duration: 225 });
  const cells = buildCells(t, ["title", "artist", "album", "duration"], NAV_CELLS);
  assert.deepEqual(colsOf(cells), ["title", "artist", "album", "duration"]);
  assert.equal(cells[0].textContent, "a.flac");
  assert.equal(cells[1].textContent, "Alice");
  // A column the row has no value for holds its track and stays blank rather than
  // collapsing — otherwise the rows below would stop lining up.
  assert.equal(cells[2].textContent, "");
  assert.equal(cells[3].textContent, "3:45");
});

test("the folded row's cap is CSS, so every cell is built at every width", () => {
  // The cap ("two fields, then stop") and automatic mode's runtime exemption are
  // both CSS rules keyed off the container. Nothing is left out of the DOM, which is
  // what lets the cap lift on a pane resize without rebuilding a row.
  const t = track("/m/a.flac", { artist: "Alice", album: "Hive", duration: 225 });
  const cells = buildCells(t, ["title", "artist", "album", "duration"], NAV_CELLS);
  assert.deepEqual(colsOf(cells), ["title", "artist", "album", "duration"]);
  // The runtime keeps its legacy hook class: the playing-row tint and the hover-swap
  // with the queue's ✕ are already written against `.row-dur`.
  assert.ok(cells[3].className.includes("row-dur"));
});

test("the cell container carries the pane's mode, which is what sits the runtime out", () => {
  // The cap is a rule about the row, so the mode rides the container rather than any
  // one cell. In automatic mode the folded row has no runtime at all; once the user
  // has picked the fields, their first two are what it shows — runtime included if
  // that is where they put it.
  assert.equal(gridClasses("queue", "queue-text"), "queue-text col-grid col-auto");
  columnSets.queue.value = ["title", "artist", "duration"] as ColumnId[];
  assert.equal(gridClasses("queue", "queue-text"), "queue-text col-grid");
  assert.equal(gridClasses("library", "nav-cell"), "nav-cell col-grid col-auto");
});

test("every offered field reads from the file, and none is fabricated", () => {
  // The guard on the whole table: a column must be something the user could change
  // by retagging the file (or by moving it). A field with no backing — a play count,
  // a rating, a comment Pudding doesn't index — is not offered at all, because a
  // column that can only ever be blank is worse than an absent one.
  const t = track("/m/Album/02 Bee.flac", {
    title: "Bee",
    artist: "Alice",
    album: "Hive",
    albumArtist: "Various",
    duration: 225,
  });
  const ids = COLUMNS.map((c) => c.id);
  // No track number: every row already shows one in its gutter, so a `#` column
  // would be a second number beside the one that is always there.
  assert.deepEqual(ids, [
    "title",
    "artist",
    "album",
    "albumArtist",
    "kind",
    "duration",
    "location",
  ]);
  // Every field is non-empty for a fully-tagged file: nothing in the table is a
  // placeholder waiting on data Pudding doesn't have.
  const cells = buildCells(t, ids, NAV_CELLS);
  assert.deepEqual(
    cells.map((c) => c.textContent),
    ["Bee", "Alice", "Hive", "Various", "FLAC", "3:45", "/m/Album/02 Bee.flac"],
  );
  // And an untagged file leaves them blank rather than inventing a value — the
  // kind and location come from the path, so those two still read.
  const bare = buildCells(track("/m/x.mp3"), ids, NAV_CELLS);
  assert.deepEqual(
    bare.map((c) => c.textContent),
    ["x.mp3", "", "", "", "MP3", "", "/m/x.mp3"],
  );
});

test("Album Artist shows the raw tag, and stays blank rather than inheriting", () => {
  // The column is an inspection surface: putting it up is how you find the files
  // that carry no ALBUMARTIST, so coalescing to the track artist (as the album
  // grouping key does) would erase the very thing it's there to show — and would
  // disagree with the metadata editor, where an empty field means "no tag".
  const read = (t: SearchTrack): string | null =>
    buildCells(t, ["albumArtist"], NAV_CELLS)[0].textContent;
  assert.equal(read(track("/m/a.mp3", { artist: "Alice", albumArtist: "Various" })), "Various");
  assert.equal(read(track("/m/a.mp3", { artist: "Alice" })), "");
});

test("sort cycles ascending, descending, off", () => {
  const ts = [
    track("/m/c.mp3", { title: "Cee" }),
    track("/m/a.mp3", { title: "Aye" }),
    track("/m/b.mp3", { title: "Bee" }),
  ];
  let s: SortState = nextSort(null, "title");
  assert.deepEqual(sortTracks(ts, s).map((t) => t.title), ["Aye", "Bee", "Cee"]);
  s = nextSort(s, "title");
  assert.deepEqual(sortTracks(ts, s).map((t) => t.title), ["Cee", "Bee", "Aye"]);
  assert.equal(nextSort(s, "title"), null);
  // No sort leaves the list exactly as handed over — the same array, untouched.
  assert.equal(sortTracks(ts, null), ts);
});

test("the sorted header carries the caret, and only that header", () => {
  const cells = buildHeaderCells(["title", "artist"], { id: "artist", dir: -1 }, null);
  assert.equal(cells[0].textContent, "Title");
  assert.equal(cells[1].textContent, "Artist ▼");
  assert.ok(cells[1].className.includes("sorted"));
  assert.ok(!cells[0].className.includes("sorted"));
  // No handler passed (the header is decorative here) → not clickable.
  assert.ok(!cells[0].className.includes("sortable"));
});

// The picker's submenu is a thunk (rebuilt against live state on every open and
// every toggle), so a test drives it by calling that thunk rather than reading a
// fixed array.
type MenuRow = { label?: string; checked?: boolean; disabled?: boolean; action?: () => void };

function picker(pane: "library" | "queue", auto: ColumnId[]): () => MenuRow[] {
  const item: ContextMenuItem = columnsMenuItem(pane, auto);
  assert.ok("submenu" in item && typeof item.submenu === "function");
  const build = item.submenu as () => ContextMenuItem[];
  return () => build() as MenuRow[];
}

test("the picker is a live thunk: a toggle redraws its own checkmark", () => {
  const build = picker("library", ["title", "artist"]);
  const byLabel = (label: string): MenuRow | undefined =>
    build().find((i) => i.label === label);

  assert.equal(byLabel("Album")?.checked, false);
  byLabel("Album")!.action!();
  assert.equal(byLabel("Album")?.checked, true);
  // The first toggle materialises the automatic set rather than resetting to a
  // canned default — you add a column to the list you were already looking at.
  assert.deepEqual(columnSets.library.value, ["title", "artist", "album"]);
});

test("the two switches lead the picker, above the field list", () => {
  // Placement is the point: both govern the whole list below them, and a list that
  // long is far too long to bury either under — buried, they read as missing.
  const build = picker("queue", ["title", "artist", "duration"]);
  assert.deepEqual(build().slice(0, 2).map((i) => i.label), ["Auto columns", "Show header"]);
  assert.equal(build()[2].label, undefined); // the separator below them
  assert.equal(build()[1].checked, false);
  build()[1].action!();
  assert.equal(build()[1].checked, true);
});

test("'Auto columns' is checked until the pane is given its own set", () => {
  const build = picker("library", ["title", "artist"]);
  const auto = (): MenuRow => build()[0];
  const run = (label: string): void => build().find((i) => i.label === label)!.action!();
  assert.equal(auto().checked, true);
  // Ticking a field is itself a departure from automatic, so the switch follows.
  run("Album");
  assert.equal(auto().checked, false);
  // Ticking it back on discards the pane's set and its sticky sort.
  librarySort.value = { id: "album", dir: 1 };
  run("Auto columns");
  assert.equal(columnSets.library.value, null);
  assert.equal(librarySort.value, null);
  assert.equal(auto().checked, true);
});

test("switching automatic off materialises the set the pane was already showing", () => {
  // Unticking it must change nothing on screen: it hands over the list you were
  // looking at to edit, not a canned default.
  const build = picker("library", ["title", "artist", "duration"]);
  build()[0].action!();
  assert.equal(build()[0].checked, false);
  assert.deepEqual(columnSets.library.value, ["title", "artist", "duration"]);
});

test("the title is offered checked, but not switchable off", () => {
  const build = picker("queue", ["title"]);
  const title = build().find((i) => i.label === "Title");
  assert.equal(title?.checked, true);
  assert.equal(title?.disabled, true);
});

test("the picker offers every field in the table, and nothing else", () => {
  const build = picker("queue", ["title"]);
  // Past the two switches and their separator, the rows are the field table in its
  // own order — so the menu can't drift from what a row can actually show.
  assert.deepEqual(
    build().slice(3).map((i) => i.label),
    COLUMNS.map((c) => c.label),
  );
});
