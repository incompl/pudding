// The one aside a track row is allowed to wear: "(Missing file)", "(Stream)", a
// cloud glyph for a file still resting on the server, or a spinner for one whose
// bytes are on their way down.
//
// Shared by every pane that draws tracks — the queue/playlist list on the right,
// the library navigator's leaf lists and the browse tree on the left — because
// the fact is about the *file*, not about the list it happens to be sitting in.
// A track wearing the cloud in the queue is the same file, and the same 37-second
// wait, when it's a row in the album you're browsing; showing the warning in only
// one pane taught the user it wasn't there in the other.
//
// The marker rides *inside* the row's title rather than taking a column of its
// own: it is a fact about the row, not a value of any field, and the cell it
// would otherwise land in is whichever column happens to come second — the
// runtime, in an automatic set whose tracks carry no artist, which the folded
// row then hides outright, losing the marker entirely. Inside the title it
// survives every column set, both layouts and all three panes, and no column
// loses its value.
//
// It trails the title, in parens, rather than reading as one more
// middot-separated value. A title is a phrase, and a dim phrase after a middot
// is exactly what an artist or an album looks like here, so a track actually
// *called* "Missing File" made the row read as two values of the same kind.
// Brackets say "aside about the row above" in ordinary type, which no column
// value here is ever wearing. The two glyphs need none of that — a glyph is
// already nothing like a field value — so they wear no brackets and keep their
// words for the tooltip and the accessibility tree instead (see paintStatus).

import { h, append, setText } from "./dom";
import { isNotDownloaded } from "./state";

// What a row is holding, as far as its marker is concerned. Deliberately not
// SearchTrack: a browse-tree node is a different shape that happens to carry the
// same two flags, and this is the whole of what the marker reads.
export interface StatusRow {
  path: string;
  missing?: boolean;
  notDownloaded?: boolean;
  stream?: boolean;
}

// One row's marker: the words it says, and whether those words are drawn or stand
// in for a glyph.
//
// The words are not optional even when nothing draws them. A wordless marker still
// has to answer a pointer and a screen reader, and keeping the phrase here — beside
// the ones that are drawn — is what stops the glyph's meaning from living only in a
// stylesheet.
export interface RowStatus {
  // Drawn as-is for the parenthesized markers; for the two glyphs it is the
  // tooltip and the accessible name, where brackets would read as punctuation
  // nobody asked for.
  label: string;
  // Draw a glyph in place of the words: the cloud for a file that is resting on
  // the server, the spinner for one whose bytes are on their way down. See
  // .row-status-cloud / .row-status-spinner, which share a box so a row flipping
  // from one to the other does not jump.
  glyph?: "cloud" | "spinner";
}

// The marker for one row, or null for the ordinary case.
//
// Three states, one slot, in priority order — a row can only be one of these at
// a time, and the order is the order of what the user can do about it. Missing
// wins because there is nothing to download. Downloading wins over not
// downloaded because it is the same fact with the wait already underway.
//
// Only "(Missing file)" makes the row unplayable; the other two are cloud files
// that play fine, after a wait. So missing is the one that gets words: it is a
// statement about why this row is not like the others, and the reader can do
// something about it.
//
// The two cloud states are wordless, and are the same glyph in two conditions —
// resting, and turning. That pairing is the point. They are one fact at two
// moments ("this file is not on the disk" / "...and it is coming now"), so
// showing them as a glyph and a phrase made the second look like a different
// kind of event rather than the first one progressing. Wordless also fixes what
// the words cost on a library kept entirely in the cloud, where every row was
// repeating the same sentence.
export function rowStatus(t: StatusRow, fetching: string | null): RowStatus | null {
  // A station in a playlist. Not a fault like the other three — the row plays,
  // just not as part of the list it sits in — but it is the same kind of
  // statement, and the same slot is where the user is already looking for it.
  if (t.stream) return { label: "(Stream)" };
  if (t.missing) return { label: "(Missing file)" };
  if (fetching === t.path) return { label: "Downloading", glyph: "spinner" };
  // `notDownloaded` is a copy of a scan-cache flag taken when the row was built,
  // and a download that has landed since is the later fact about the same file.
  if (isNotDownloaded(t)) return { label: "Not downloaded", glyph: "cloud" };
  return null;
}

// Paint a marker span, whether it was just built or is being reused across a
// change of state — the same file goes cloud → spinner → gone as the engine works
// through a queue of cloud files, in a span the row keeps throughout. So every
// attribute the shapes disagree about is set *or* cleared here; a one-way set
// would leave a glyph's tooltip hanging off a worded marker, or spin a cloud.
//
// Through setText rather than textContent, because this runs on live rows under
// the pointer: assigning textContent swaps out the text node, and WebKit drops a
// click whose press and release land on different nodes (see setText).
function paintStatus(el: HTMLElement, status: RowStatus): void {
  const glyph = status.glyph;
  el.classList.toggle("row-status-cloud", glyph === "cloud");
  el.classList.toggle("row-status-spinner", glyph === "spinner");
  setText(el, glyph ? "" : status.label);
  if (glyph) {
    // role=img so the empty span is read as the thing it depicts rather than
    // skipped as decoration, and title so the pointer gets the same words.
    el.setAttribute("role", "img");
    el.setAttribute("aria-label", status.label);
    el.setAttribute("title", status.label);
  } else {
    el.removeAttribute("role");
    el.removeAttribute("aria-label");
    el.removeAttribute("title");
  }
}

// A marker span for a row being built.
function statusSpan(status: RowStatus): HTMLElement {
  const el = h("span", { class: "row-status" });
  paintStatus(el, status);
  return el;
}

// Put `status` in (or take it out of) a *column* row — the queue/playlist list and
// the navigator's leaf lists, whose cells buildCells made and whose title cell
// therefore holds one plain string. Idempotent, because it runs twice: once as the
// row is built, and again on the mounted rows whenever the download the engine is
// parked on changes — the ordinary row keeps its plain inline text, so nothing but
// a marked row pays for the split.
//
// `host` is the row's cell container; the marker lands in whichever cell is the
// title, found by the id buildCells stamped on it rather than by either pane's
// class name (`.queue-primary` / `.nav-primary`), so one function serves both.
export function applyCellStatus(host: HTMLElement, status: RowStatus | null): void {
  const primary = host.querySelector<HTMLElement>('[data-col="title"]') ?? host;
  const existing = primary.querySelector<HTMLElement>(".row-status");
  if (status === null) {
    if (!existing) return;
    // Restore the exact text buildCells produced. Stashed rather than rebuilt
    // from the track: folded, this cell is several fields joined with middots,
    // and only the cell itself knows which.
    primary.textContent = primary.dataset.plain ?? "";
    delete primary.dataset.plain;
    primary.classList.remove("has-status");
    return;
  }
  if (existing) {
    paintStatus(existing, status);
    return;
  }
  const label = primary.textContent ?? "";
  primary.dataset.plain = label;
  primary.textContent = "";
  primary.classList.add("has-status");
  append(primary, [h("span", { class: "row-title-text", text: label }), statusSpan(status)]);
}

// The other shape: a host that already holds element children — the browse tree's
// `.label-text`, which is a title span plus an optional artist span. Appending is
// all that's needed there, and it is all that's *allowed*: the split above rebuilds
// the host's text content, which would take the artist span with it.
//
// The tree row keeps the marker inline, so a long title can push it off the end
// under the line's single trailing ellipsis. That is the folded row's behaviour
// exactly (see .row-title-text, which is column mode only) — the tree row *is* a
// folded row, one run of inline text at every pane width — and the alternative,
// a flex split, would need the title and the artist to clip as one box, which
// inline text already does for free.
export function applyInlineStatus(host: HTMLElement, status: RowStatus | null): void {
  const existing = host.querySelector<HTMLElement>(":scope > .row-status");
  if (status === null) {
    existing?.remove();
    return;
  }
  if (existing) {
    paintStatus(existing, status);
    return;
  }
  host.appendChild(statusSpan(status));
}
