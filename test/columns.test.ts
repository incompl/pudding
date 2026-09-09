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
import { installFakeDom, type FakeEl } from "./fake-dom.ts";
import type { ContextMenuItem, SearchTrack } from "../src/types.ts";
import { app } from "../src/state.ts";
import {
  COLUMNS,
  activeColumns,
  librarySort,
  loadColumnPrefs,
  persist,
  buildCells,
  buildHeaderCells,
  columnHeaders,
  columnSets,
  columnWidths,
  columnsMenuItem,
  gridClasses,
  gridTemplate,
  isSortedBy,
  nextSort,
  resizedWidths,
  setColumnRoom,
  sortTracks,
  NAV_CELLS,
  type ColumnId,
  type ColumnWidths,
  type SortState,
} from "../src/columns.ts";

beforeEach(() => {
  installFakeDom();
  // Column sets are module-level signals; reset both panes so tests don't leak.
  columnSets.library.value = null;
  columnSets.queue.value = null;
  columnHeaders.library.value = false;
  columnHeaders.queue.value = false;
  columnWidths.library.value = {};
  columnWidths.queue.value = {};
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

test("text columns take fr weights, and never a ch minimum", () => {
  // The 0 minimum is the whole "you made the mess" policy: an over-full row gets
  // thin and ellipsizes instead of overflowing the pane. A ch minimum here would
  // reintroduce horizontal overflow, which the design rules out.
  assert.equal(
    gridTemplate(["title", "artist", "album"], []),
    "minmax(0, 2.4fr) minmax(0, 1.6fr) minmax(0, 1.6fr)",
  );
  assert.ok(!gridTemplate(["title", "artist", "album", "albumArtist"], []).includes("ch"));
});

test("a fixed column is sized by the list, so every row's grid agrees", () => {
  // The bug this rules out: each row is its own grid, so a max-content track was
  // measured against that row's own text — one 10:34 among a screenful of 4:14
  // laid its row out on column boundaries of its own, shifting the whole row.
  // Five characters of time, so five ch, for every row in the list.
  const ts = [track("/m/a.mp3", { duration: 254 }), track("/m/b.mp3", { duration: 634 })];
  assert.equal(gridTemplate(["title", "duration"], ts), "minmax(0, 2.4fr) 5ch");
  // ...and four when nothing in the list runs to ten minutes: the width follows the
  // list's own content, not a reserved worst case.
  assert.equal(gridTemplate(["title", "duration"], [ts[0]]), "minmax(0, 2.4fr) 4ch");
  // Letters run wider than the `0` the ch unit measures, so a text-valued fixed
  // column (the kind) counts them at more than one ch each.
  assert.equal(gridTemplate(["kind"], ts), "5ch");
  // No rows to measure at all: nothing can disagree, so the row sizes itself.
  assert.equal(gridTemplate(["title", "duration"]), "minmax(0, 2.4fr) max-content");
});

test("with the header up a fixed column also fits its own label", () => {
  // "Time" over a column of 4:14s is wider than the times are, and the header is a
  // third grid with a third set of contents — so the label (at the header's
  // smaller type) and the sort mark's reserved box are part of the same one width.
  const ts = [track("/m/a.mp3", { duration: 254 })];
  assert.equal(gridTemplate(["duration"], ts, true), "6ch");
  // The mark's space is held whether or not this is the sorted column, so clicking
  // a header re-sorts the rows without also moving the boundaries under them.
  assert.equal(gridTemplate(["duration"], ts, false), "4ch");
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
  const created = 1_700_000_000;
  const modified = 1_710_000_000;
  const t = track("/m/Album/02 Bee.flac", {
    title: "Bee",
    artist: "Alice",
    album: "Hive",
    albumArtist: "Various",
    disc: 1,
    genre: "Ambient",
    year: 1998,
    duration: 225,
    bitrate: 320,
    sampleRate: 44100,
    bitDepth: 24,
    gain: -7.89,
    created,
    modified,
  });
  const ids = COLUMNS.map((c) => c.id);
  // No track number: every row already shows one in its gutter, so a `#` column
  // would be a second number beside the one that is always there. Disc is here
  // because nothing else draws it.
  assert.deepEqual(ids, [
    "title",
    "artist",
    "album",
    "albumArtist",
    "disc",
    "genre",
    "year",
    "kind",
    "duration",
    "bitrate",
    "sampleRate",
    "bitDepth",
    "gain",
    "created",
    "modified",
    "location",
  ]);
  // The dates render in the runner's locale and zone, so the expectation is built
  // the same way the column builds it. What's being pinned here is that the cell
  // is a formatted local date rather than the raw epoch seconds.
  const asDate = (secs: number): string =>
    new Date(secs * 1000).toLocaleString(undefined, {
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  // Every field is non-empty for a fully-tagged file: nothing in the table is a
  // placeholder waiting on data Pudding doesn't have.
  const cells = buildCells(t, ids, NAV_CELLS);
  assert.deepEqual(
    cells.map((c) => c.textContent),
    [
      "Bee",
      "Alice",
      "Hive",
      "Various",
      "1",
      "Ambient",
      "1998",
      "FLAC",
      "3:45",
      "320 kbps",
      "44.1 kHz",
      "24 bit",
      "-7.89 dB",
      asDate(created),
      asDate(modified),
      "/m/Album/02 Bee.flac",
    ],
  );
  // And a file with nothing on it leaves them blank rather than inventing a value.
  // Kind and location survive because the frontend derives those from the path it
  // already has; every other column is carried from the scan, so a row that never
  // got one (an out-of-library playlist entry) draws an empty cell — which is the
  // honest answer, and for Gain it is the useful one.
  const bare = buildCells(track("/m/x.mp3"), ids, NAV_CELLS);
  assert.deepEqual(
    bare.map((c) => c.textContent),
    ["x.mp3", "", "", "", "", "", "", "MP3", "", "", "", "", "", "", "", "/m/x.mp3"],
  );
});

test("a date column sorts by its timestamp, not by the text in the cell", () => {
  // The cell is a locale-formatted date ("3/14/2024, 5:20 PM"), so a sort that
  // compared what it draws would order by month-as-typed and put every December
  // before every February. key() hands back the raw seconds for exactly this.
  const ts = [
    track("/m/b.mp3", { title: "Feb", created: Date.UTC(2024, 1, 20) / 1000 }),
    track("/m/a.mp3", { title: "Dec", created: Date.UTC(2023, 11, 5) / 1000 }),
    track("/m/c.mp3", { title: "Nov", created: Date.UTC(2024, 10, 1) / 1000 }),
  ];
  assert.deepEqual(
    sortTracks(ts, { id: "created", dir: 1 }).map((t) => t.title),
    ["Dec", "Feb", "Nov"],
  );
  // A row whose file has no creation time sinks rather than reading as the epoch,
  // which would file it in 1970 and bury the oldest real entries under it.
  const withBlank = [...ts, track("/m/d.mp3", { title: "None" })];
  assert.deepEqual(
    sortTracks(withBlank, { id: "created", dir: 1 }).map((t) => t.title),
    ["Dec", "Feb", "Nov", "None"],
  );
  assert.deepEqual(
    sortTracks(withBlank, { id: "created", dir: -1 }).map((t) => t.title),
    ["Nov", "Feb", "Dec", "None"],
  );
});

test("a signed numeric column is sized from its widest end, not its largest value", () => {
  // Gain's widest cell is its most negative one, and ReplayGain figures are usually
  // negative — so sizing a fixed column from the maximum key alone (which is what a
  // column of durations or years wants) would leave this one a character short and
  // ellipsize every long value in it.
  const ts = [
    track("/m/a.mp3", { gain: 2.5 }), // "+2.50 dB" — the largest value, 8 chars
    track("/m/b.mp3", { gain: -11.25 }), // "-11.25 dB" — the widest cell, 9 chars
  ];
  const width = (t: SearchTrack[]): string => gridTemplate(["gain"], t, false);
  assert.equal(width(ts), "9ch");
  // Order of the rows can't matter; the measurement is over the list, not the first
  // row it happens to meet.
  assert.equal(width([...ts].reverse()), "9ch");
  // And the ordinary all-positive case still measures from the top, as before.
  assert.equal(width([track("/m/c.mp3", { gain: 1.5 })]), "8ch");
});

test("a date column is sized by its format, not by a scan of the list", () => {
  // Every date cell is the same handful of numeric fields, so the column's width is
  // a property of the format and one synthetic worst case measures it exactly. That
  // it doesn't scan matters twice over: the old scan formatted every track on every
  // render (a per-repaint stall on a hundred-thousand-track Songs list), and it then
  // scaled the result by the proportional-text cap, sizing a column of digits ~50%
  // wider than its own content could ever be.
  const widest = new Date(2026, 11, 30, 22, 58).toLocaleString(undefined, {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).length;
  const width = (t: SearchTrack[]): string => gridTemplate(["modified"], t, false);
  // Jan 1st at 1am — the narrowest date there is — still gets the format's width:
  // the column can't shrink to fit the rows it happens to hold, or a later row
  // would ellipsize inside a grid the whole list already agreed on.
  const narrow = track("/m/a.mp3", { modified: new Date(2026, 0, 1, 1, 4).getTime() / 1000 });
  const wide = track("/m/b.mp3", { modified: new Date(2026, 11, 30, 22, 58).getTime() / 1000 });
  assert.equal(width([narrow]), `${widest}ch`);
  assert.equal(width([narrow, wide]), `${widest}ch`);
  // And the width is genuinely independent of the list, which is what makes the
  // measurement O(1): a big list costs exactly what a one-row list costs.
  assert.equal(width(Array.from({ length: 500 }, () => narrow)), `${widest}ch`);
});

test("sorting by a date sinks the undated rows, without formatting every row to ask", () => {
  // The blank test has to agree with the cell: a date column answers it from the
  // raw timestamp (there is no cheap way to ask a formatted field), so the two
  // definitions can drift apart. Missing, null and zero are the same thing here —
  // a file the scan found no timestamp for — and none of them is a date that ranks
  // before 1970.
  const dated = track("/m/b.mp3", { modified: new Date(2026, 0, 1).getTime() / 1000 });
  const older = track("/m/c.mp3", { modified: new Date(2020, 0, 1).getTime() / 1000 });
  const zero = track("/m/d.mp3", { modified: 0 });
  const none = track("/m/e.mp3");
  const paths = (dir: 1 | -1): string[] =>
    sortTracks([zero, dated, none, older], { id: "modified", dir }).map((t) => t.path);
  assert.deepEqual(paths(1), ["/m/c.mp3", "/m/b.mp3", "/m/d.mp3", "/m/e.mp3"]);
  // Blanks sink in *both* directions — they are the absence of a value, not a value
  // that outranks every date once the arrow flips.
  assert.deepEqual(paths(-1), ["/m/b.mp3", "/m/c.mp3", "/m/d.mp3", "/m/e.mp3"]);
  // The cells really are empty, so the sort and the column agree about which rows
  // are the blank ones.
  assert.equal(buildCells(zero, ["modified"], NAV_CELLS)[0].textContent, "");
  assert.equal(buildCells(none, ["modified"], NAV_CELLS)[0].textContent, "");
});

test("Gain shows the file's own figure, signed, and blank when the file has none", () => {
  // Same inspection rule as Album Artist below: this is the raw REPLAYGAIN_TRACK_GAIN
  // tag, not the multiplier playback computes from it. The blank cells are the point
  // — with ReplayGain on they are precisely the rows the setting cannot act on, which
  // nothing else in the app can show. So a missing tag must not render as "0.00 dB",
  // which would claim the file was scanned and found to need no adjustment.
  const read = (t: SearchTrack): string | null =>
    buildCells(t, ["gain"], NAV_CELLS)[0].textContent;
  assert.equal(read(track("/m/a.mp3", { gain: -7.89 })), "-7.89 dB");
  assert.equal(read(track("/m/b.mp3", { gain: 2.5 })), "+2.50 dB");
  // A file scanned as needing no change is a value, and reads as one.
  assert.equal(read(track("/m/c.mp3", { gain: 0 })), "+0.00 dB");
  assert.equal(read(track("/m/d.mp3")), "");
});

test("Sample Rate reads in kHz, and sorts as a number rather than as its text", () => {
  // The column exists to be scanned down for the boundary where the rate changes
  // — with "Match Device to File Sample Rate" on, that boundary is exactly where
  // the engine cannot join two tracks gaplessly. So the cell is written the way
  // sleeves and DACs write it, and the odd rates keep their real value instead of
  // being rounded into agreement with the common ones.
  const read = (t: SearchTrack): string | null =>
    buildCells(t, ["sampleRate"], NAV_CELLS)[0].textContent;
  assert.equal(read(track("/m/a.flac", { sampleRate: 44100 })), "44.1 kHz");
  // A whole number of kHz doesn't wear a decimal point it doesn't need.
  assert.equal(read(track("/m/b.flac", { sampleRate: 48000 })), "48 kHz");
  assert.equal(read(track("/m/c.flac", { sampleRate: 96000 })), "96 kHz");
  assert.equal(read(track("/m/d.flac", { sampleRate: 176400 })), "176.4 kHz");
  // Low rates stay exact rather than collapsing to "22 kHz".
  assert.equal(read(track("/m/e.m4a", { sampleRate: 22050 })), "22.05 kHz");
  // Never scanned (an out-of-library row), so nothing to say.
  assert.equal(read(track("/m/f.mp3")), "");

  // Sorted on the number, not the string: as text "192 kHz" sorts before
  // "44.1 kHz", which would file the highest rate in the library first and hide
  // the very grouping the column is up to show.
  const ts = [
    track("/m/1.flac", { title: "high", sampleRate: 192000 }),
    track("/m/2.flac", { title: "cd", sampleRate: 44100 }),
    track("/m/3.flac", { title: "dvd", sampleRate: 48000 }),
    track("/m/4.mp3", { title: "none" }),
  ];
  assert.deepEqual(
    sortTracks(ts, { id: "sampleRate", dir: 1 }).map((t) => t.title),
    ["cd", "dvd", "high", "none"],
  );
  // And the unscanned row sinks either way rather than reading as 0 Hz.
  assert.deepEqual(
    sortTracks(ts, { id: "sampleRate", dir: -1 }).map((t) => t.title),
    ["high", "dvd", "cd", "none"],
  );
});

test("Bit Depth stays blank on lossy files instead of inventing a 16", () => {
  // MP3 and AAC have no bit depth to report — the scanner gets None from the file,
  // not a zero — and the blank cell is the honest rendering of that. It is also the
  // useful one: an empty Bit Depth beside a filled Sample Rate is the column pair
  // saying "lossy", which nothing else in a list says.
  const read = (t: SearchTrack): string | null =>
    buildCells(t, ["bitDepth"], NAV_CELLS)[0].textContent;
  assert.equal(read(track("/m/a.flac", { bitDepth: 16 })), "16 bit");
  assert.equal(read(track("/m/b.flac", { bitDepth: 24 })), "24 bit");
  assert.equal(read(track("/m/c.mp3")), "");
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

test("blank cells sink to the end, whichever way the arrow points", () => {
  // An empty cell isn't a value that ranks above "A" or below "Z" — it's the
  // absence of one. The rows that answer the question come first in both
  // directions; the ones that don't sit at the end, out of the way.
  const ts = [
    track("/m/1.mp3", { title: "One", artist: null }),
    track("/m/2.mp3", { title: "Two", artist: "Bower" }),
    track("/m/3.mp3", { title: "Three", artist: "Aster" }),
    track("/m/4.mp3", { title: "Four", artist: "" }),
  ];
  const by = (dir: 1 | -1): (string | null | undefined)[] =>
    sortTracks(ts, { id: "artist", dir }).map((t) => t.artist);
  assert.deepEqual(by(1), ["Aster", "Bower", null, ""]);
  assert.deepEqual(by(-1), ["Bower", "Aster", null, ""]);
  // An untagged artist and an empty tag are the same blank cell, so they sort
  // together and keep the order they arrived in (the sort is stable).
  // A missing duration is blank too — the column draws nothing for it, so it
  // sinks like any other empty cell rather than ranking as a runtime of zero.
  const times = [
    track("/m/a.mp3", { duration: 0 }),
    track("/m/b.mp3", { duration: 250 }),
    track("/m/c.mp3", { duration: 100 }),
  ];
  assert.deepEqual(
    sortTracks(times, { id: "duration", dir: 1 }).map((t) => t.duration),
    [100, 250, 0],
  );
});

test("isSortedBy reads the order off the rows, not off the last click", () => {
  const asc = [
    track("/m/1.mp3", { album: "Aster" }),
    track("/m/2.mp3", { album: "Bower" }),
    track("/m/3.mp3", { album: "Cedar" }),
  ];
  assert.ok(isSortedBy(asc, { id: "album", dir: 1 }));
  assert.ok(!isSortedBy(asc, { id: "album", dir: -1 }));
  assert.ok(isSortedBy(asc.slice().reverse(), { id: "album", dir: -1 }));
  // The queue's mark dies on the drag that breaks the order — this is what the
  // right pane consults every paint instead of remembering the click.
  const dragged = [asc[2], asc[0], asc[1]];
  assert.ok(!isSortedBy(dragged, { id: "album", dir: 1 }));
  // Ties don't count against it: rows shuffled *within* one album are still in
  // album order.
  const tied = [
    track("/m/b.mp3", { album: "Aster", title: "Two" }),
    track("/m/a.mp3", { album: "Aster", title: "One" }),
    track("/m/c.mp3", { album: "Bower" }),
  ];
  assert.ok(isSortedBy(tied, { id: "album", dir: 1 }));
  // No sort, no mark — and a list too short to be out of order never claims one
  // on its own (there has to be a click to validate).
  assert.ok(!isSortedBy(asc, null));
  // The mark has to read blanks the way the sort writes them, or the arrow would
  // die on the very sort that produced the rows: blanks at the end are in order,
  // blanks above a filled cell are not — in both directions.
  const blanks = [track("/m/x.mp3", { album: "Aster" }), track("/m/y.mp3", { album: null })];
  assert.ok(isSortedBy(blanks, { id: "album", dir: 1 }));
  assert.ok(isSortedBy(blanks, { id: "album", dir: -1 }));
  assert.ok(!isSortedBy(blanks.slice().reverse(), { id: "album", dir: 1 }));
});

// A header cell's two parts, read off the fake DOM: the column's name, and the
// direction class on the sort mark (null when the column isn't the sorted one).
const label = (cell: HTMLElement) =>
  (cell as unknown as FakeEl).queryAll("colhead-label")[0]?.textContent;
const arrow = (cell: HTMLElement) => {
  const el = (cell as unknown as FakeEl).queryAll("colhead-arrow")[0];
  return el ? (el.className.includes("asc") ? "asc" : "desc") : null;
};

test("the sorted header carries the arrow, and only that header", () => {
  const cells = buildHeaderCells("library", ["title", "artist"], { id: "artist", dir: -1 }, null);
  // The label is a box of its own, so a header reads as its column's name whether
  // or not it is the sorted one — the direction rides a sibling element.
  assert.equal(label(cells[0]), "Title");
  assert.equal(label(cells[1]), "Artist");
  assert.equal(arrow(cells[0]), null);
  assert.equal(arrow(cells[1]), "desc");
  assert.ok(cells[1].className.includes("sorted"));
  assert.ok(!cells[0].className.includes("sorted"));
  // No handler passed (the header is decorative here) → not clickable.
  assert.ok(!cells[0].className.includes("sortable"));
  // Ascending points the other way, off the same one-token mark (CSS rotates it).
  const asc = buildHeaderCells("library", ["title"], { id: "title", dir: 1 }, null);
  assert.equal(arrow(asc[0]), "asc");
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

test("switching the header on asks the pane for the width column mode needs", () => {
  // Below the pane's fold gate the rows are one inline run and a header has
  // nothing to label, so the tick would be a switch with nothing behind it. The
  // pane's owner is asked for the room (main.ts moves the splitter); columns.ts
  // only knows that the request has to be made, and only in the on direction —
  // switching back off leaves the width the user has been reading at alone.
  let asked = 0;
  setColumnRoom("library", () => {
    asked++;
  });
  const build = picker("library", ["title", "artist"]);
  const header = (): MenuRow => build().find((i) => i.label === "Show header")!;
  header().action!();
  assert.equal(header().checked, true);
  assert.equal(asked, 1);
  header().action!();
  assert.equal(header().checked, false);
  assert.equal(asked, 1);
  setColumnRoom("library", () => {});
});

test("showing a field asks for width only when the fold would swallow it", () => {
  // Folded, the row stops at two fields — so ticking a third is as silent as the
  // header switch was, and asks the pane for the room. A field that lands in the
  // first two shows folded already, and is no reason to move a divider the user
  // placed; hiding one never is.
  let asked = 0;
  setColumnRoom("library", () => {
    asked++;
  });
  const build = picker("library", ["title"]);
  const run = (label: string): void => build().find((i) => i.label === label)!.action!();
  // Second field: visible folded, so the pane is left where it is.
  run("Artist");
  assert.deepEqual(columnSets.library.value, ["title", "artist"]);
  assert.equal(asked, 0);
  // Third: past the fold's cap, so the tick buys the width to show it.
  run("Album");
  assert.equal(asked, 1);
  // Hiding is the opposite request — a pane losing a column has no business
  // growing, wherever the field sat.
  run("Album");
  assert.deepEqual(columnSets.library.value, ["title", "artist"]);
  assert.equal(asked, 1);
  setColumnRoom("library", () => {});
});

// A store that lives in a Map — the two prefs functions only ever get/set/save,
// and what matters here is what survives the round trip, not where it lands.
function fakeStore(): { seed: (v: unknown) => void; saved: () => unknown } {
  const data = new Map<string, unknown>();
  app.store = {
    get: async (k: string) => data.get(k),
    set: async (k: string, v: unknown) => void data.set(k, v),
    save: async () => {},
  } as unknown as typeof app.store;
  return {
    seed: (v) => void data.set("columnPrefs", v),
    saved: () => data.get("columnPrefs"),
  };
}

test("both panes' columns, mode, header and the library sort survive a restart", async () => {
  // Everything the picker can change is per pane and sticky: the layout you left
  // is the one the next launch paints, without a flash of the automatic columns
  // (loadColumnPrefs is awaited before anything renders — see init).
  fakeStore();
  columnSets.library.value = ["title", "album", "duration"] as ColumnId[];
  columnHeaders.library.value = true;
  librarySort.value = { id: "album", dir: -1 };
  // The queue is left automatic, which is itself a setting: `null` has to come
  // back as null rather than as some materialised set.
  columnSets.queue.value = null;
  columnHeaders.queue.value = false;
  await persist();

  columnSets.library.value = null;
  columnSets.queue.value = ["title", "artist"] as ColumnId[];
  columnHeaders.library.value = false;
  librarySort.value = null;
  await loadColumnPrefs();

  assert.deepEqual(columnSets.library.value, ["title", "album", "duration"]);
  assert.equal(columnSets.queue.value, null);
  assert.equal(columnHeaders.library.value, true);
  assert.equal(columnHeaders.queue.value, false);
  assert.deepEqual(librarySort.value, { id: "album", dir: -1 });
  app.store = undefined as unknown as typeof app.store;
});

test("a stored layout from another build degrades instead of breaking", async () => {
  // Fields are stored as their ids, so a renamed or dropped field is a lookup
  // miss rather than a migration: it comes back as "that column is gone", with
  // the rest of the layout intact and the title still leading.
  const store = fakeStore();
  store.seed({
    library: ["album", "rating", "title"],
    queue: "not an array",
    libraryHeaders: true,
    librarySort: { id: "rating", dir: -1 },
  });
  await loadColumnPrefs();
  // Canonical table order, unknown id dropped, title kept.
  assert.deepEqual(columnSets.library.value, ["title", "album"]);
  // Nothing usable stored for the queue: automatic, the shipped default.
  assert.equal(columnSets.queue.value, null);
  // A sort naming a field this build doesn't have is no sort at all — the rows
  // must never claim an order they aren't in.
  assert.equal(librarySort.value, null);
  assert.equal(columnHeaders.library.value, true);
  app.store = undefined as unknown as typeof app.store;
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

// --- resizing ---------------------------------------------------------------
//
// The drag itself is pointer work over a laid-out grid and has to be judged in the
// app; what these cover is the arithmetic behind it — the part that decides whether
// a table can be dragged into a state the reader can't get out of. `startPx` here
// stands in for what trackWidths() reads off the live header, and `ch` for what
// chPx() measures, so a test is one drag at a known pane width.

// A 10px `0`, which makes every ch figure below readable as pixels ÷ 10.
const CH = 10;

test("a divider trades width between its own two columns and no others", () => {
  // The invariant the whole feature rests on: the boundary under the pointer is the
  // only one that moves. Everything else stays where the reader left it, and the
  // row's total is unchanged — so the table can't overflow the pane or leave a
  // gutter, however many times it's dragged.
  const ids: ColumnId[] = ["title", "artist", "album"];
  const { widths, px } = resizedWidths({}, ids, 0, [240, 160, 160], 40, CH);
  assert.deepEqual(px, [280, 120, 160]);
  // Weights come back on the scale of the table's own (2.4 + 1.6 + 1.6 = 5.6 over
  // 560px), so a column ticked on later lands at a sane width beside these.
  assert.deepEqual(widths, { title: 2.8, artist: 1.2, album: 1.6 });
  // Album never moved, and its weight says so: 160px of 560 is the 1.6 it started
  // with, to the digit.
  assert.equal(widths.album, 1.6);
});

test("a resized column is still a share of the pane, not a size", () => {
  // What the drag stores is an `fr`, so the dragged layout reflows with the
  // splitter exactly as an undragged one does — the reason a resized table has no
  // horizontal scrollbar and no dead space to explain.
  columnWidths.library.value = { title: 2.8, artist: 1.2 };
  assert.equal(
    gridTemplate(["title", "artist"], [], false, "library"),
    "minmax(0, 2.8fr) minmax(0, 1.2fr)",
  );
  // The `0` minimum survives the override: an over-full row still ellipsizes rather
  // than pushing past the pane.
  assert.ok(gridTemplate(["title", "artist"], [], false, "library").includes("minmax(0,"));
  // A pane with no widths of its own is untouched — and so is a caller that names
  // no pane at all.
  assert.equal(
    gridTemplate(["title", "artist"], [], false, "queue"),
    "minmax(0, 2.4fr) minmax(0, 1.6fr)",
  );
  assert.equal(gridTemplate(["title", "artist"]), "minmax(0, 2.4fr) minmax(0, 1.6fr)");
});

test("dragging a fixed column pins it in ch, and only the one that was dragged", () => {
  // Time and Kind normally fit the list (see gridTemplate). Dragging one is the
  // user saying they'd rather have the width — so it stops tracking the list and
  // stores a character count, which keeps it type-relative like the fitted one was.
  const ids: ColumnId[] = ["title", "kind", "duration"];
  const { widths } = resizedWidths({}, ids, 0, [400, 50, 50], -100, CH);
  assert.equal(widths.kind, 15);
  // The Time column is at neither end of the divider that moved, so it is left
  // fitting the list: pinning it here would be a change at a boundary the user
  // never touched.
  assert.equal(widths.duration, undefined);
  const ts = [track("/m/a.mp3", { duration: 634 })];
  columnWidths.library.value = widths;
  assert.equal(gridTemplate(ids, ts, false, "library"), "minmax(0, 2.4fr) 15ch 5ch");
});

test("a drag that changes the fr pool holds the columns it isn't touching still", () => {
  // Widening a fixed column takes that width out of the pool the text columns
  // divide, so leaving their weights alone would shrink all of them a little. Their
  // weights are rewritten from the final pixels instead, which is what keeps Album
  // at the 160px the reader is looking at.
  const ids: ColumnId[] = ["title", "album", "duration"];
  const { widths, px } = resizedWidths({}, ids, 1, [240, 160, 60], 20, CH);
  assert.deepEqual(px, [240, 180, 40]);
  // The pool the two text columns divide is 20px smaller than it was, and their
  // weights are restated against it: still totalling the table's own 2.4 + 1.6.
  assert.deepEqual(widths, { title: 2.286, album: 1.714, duration: 4 });
  assert.equal(round3(widths.title! + widths.album!), 4);
  // Which lands Title back on the 240px it was already at, rather than shaving it
  // to pay for a column at the other end of the row.
  const pool = 240 + 180;
  assert.equal(Math.round((widths.title! / 4) * pool), 240);
});

test("a column can't be dragged narrower than it can be read", () => {
  // A drag past the floor stops at it rather than collapsing a column to a sliver
  // with no divider left to grab — the one mess here that isn't self-evidently
  // undoable. Clamped from both ends, since the pair's total is fixed.
  const ids: ColumnId[] = ["title", "artist"];
  const far = resizedWidths({}, ids, 0, [200, 200], -1000, CH);
  assert.deepEqual(far.px, [30, 370]);
  const other = resizedWidths({}, ids, 0, [200, 200], 1000, CH);
  assert.deepEqual(other.px, [370, 30]);
  // A pair with no room for two floors splits what there is instead of refusing to
  // move at all.
  const tiny = resizedWidths({}, ids, 0, [20, 20], -1000, CH);
  assert.deepEqual(tiny.px, [20, 20]);
});

test("every header carries a divider except the last, which has nothing to trade with", () => {
  const cells = buildHeaderCells("library", ["title", "artist", "duration"], null, null);
  const grips = (c: HTMLElement): number => (c as unknown as FakeEl).queryAll("colhead-grip").length;
  assert.equal(grips(cells[0]), 1);
  assert.equal(grips(cells[1]), 1);
  assert.equal(grips(cells[2]), 0);
  // A one-column table has no boundary at all.
  assert.equal(grips(buildHeaderCells("queue", ["title"], null, null)[0]), 0);
});

test("dragged widths survive a restart, per pane", () => {
  // The whole point of dragging one: the layout you left is the one the next launch
  // paints. Kept per pane, like everything else the picker touches.
  const store = fakeStore();
  columnWidths.library.value = { title: 2.8, artist: 1.2 };
  columnWidths.queue.value = { duration: 6.5 };
  return persist().then(async () => {
    columnWidths.library.value = {};
    columnWidths.queue.value = {};
    await loadColumnPrefs();
    assert.deepEqual(columnWidths.library.value, { title: 2.8, artist: 1.2 });
    assert.deepEqual(columnWidths.queue.value, { duration: 6.5 });
    assert.ok(store.saved());
    app.store = undefined as unknown as typeof app.store;
  });
});

test("a stored width that isn't one is dropped, a column at a time", () => {
  // Same rule the field list follows: a bad entry degrades to "that column sizes
  // itself again", not to a broken template. A width has to be a positive finite
  // number, and small — anything past the cap would hand one column the pane and
  // ellipsize every other to nothing.
  const store = fakeStore();
  store.seed({
    libraryWidths: { title: 2.8, artist: 0, album: "wide", kind: 1e9, rating: 3, location: 1.1 },
  });
  return loadColumnPrefs().then(() => {
    assert.deepEqual(columnWidths.library.value, { title: 2.8, location: 1.1 });
    // Nothing stored for the queue at all: no widths, not a broken map.
    assert.deepEqual(columnWidths.queue.value, {});
    app.store = undefined as unknown as typeof app.store;
  });
});

test("the picker offers to reset widths only once there are widths to reset", () => {
  // The counterweight to a drag, so it appears when a drag has happened and not
  // before: a standing item would be one more line to read past on every open, in a
  // menu that is already a field list.
  const build = picker("library", ["title", "artist"]);
  const labels = (): (string | undefined)[] => build().map((i) => i.label);
  assert.ok(!labels().includes("Reset column widths"));
  columnWidths.library.value = { title: 2.8, artist: 1.2 };
  assert.ok(labels().includes("Reset column widths"));
  // It follows the two switches: they govern the layout, this undoes an edit to it.
  assert.deepEqual(labels().slice(0, 3), ["Auto columns", "Show header", "Reset column widths"]);
  build().find((i) => i.label === "Reset column widths")!.action!();
  assert.deepEqual(columnWidths.library.value, {});
  // Only this pane's. Widths are per pane like every other column setting.
  columnWidths.queue.value = { duration: 6 };
  build().find((i) => i.label === "Auto columns");
  assert.deepEqual(columnWidths.queue.value, { duration: 6 });
});

test("going back to automatic gives up the dragged widths too", () => {
  // "Automatic" is a claim about the whole layout: a pane still wearing hand-dragged
  // boundaries is not one the app is choosing for you.
  const build = picker("library", ["title", "artist"]);
  build().find((i) => i.label === "Album")!.action!();
  columnWidths.library.value = { title: 2.8, artist: 1.2 };
  build().find((i) => i.label === "Auto columns")!.action!();
  assert.equal(columnSets.library.value, null);
  assert.deepEqual(columnWidths.library.value, {});
});

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

// Keep the exported width map's shape honest: a partial record of known ids, so a
// stored layout can name any subset of the table and nothing else.
const _widthsShape: ColumnWidths = { title: 1, duration: 4 };
void _widthsShape;
