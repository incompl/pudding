// The one aside a track row is allowed to wear: "(Missing file)",
// "(Downloading...)" or "(Not downloaded)".
//
// Shared by every pane that draws tracks — the queue/playlist list on the right,
// the library navigator's leaf lists and the browse tree on the left — because
// the fact is about the *file*, not about the list it happens to be sitting in.
// A track that says "(Not downloaded)" in the queue is the same file, and the
// same 37-second wait, when it's a row in the album you're browsing; showing the
// warning in only one pane taught the user it wasn't there in the other.
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
// value here is ever wearing.

import { h, append } from "./dom";
import { isNotDownloaded } from "./state";

// What a row is holding, as far as its marker is concerned. Deliberately not
// SearchTrack: a browse-tree node is a different shape that happens to carry the
// same two flags, and this is the whole of what the marker reads.
export interface StatusRow {
  path: string;
  missing?: boolean;
  notDownloaded?: boolean;
}

// The marker for one row, or null for the ordinary case.
//
// Three states, one slot, in priority order — a row can only be one of these at
// a time, and the order is the order of what the user can do about it. Missing
// wins because there is nothing to download. Downloading wins over not
// downloaded because it is the same fact with the wait already underway.
//
// Only "(Missing file)" makes the row unplayable; the other two are cloud files
// that play fine, after a wait. They wear the same dim parenthetical because
// they are the same kind of statement — why this row is not like the others —
// and telling the user "not downloaded" in a louder voice than "missing" would
// have the emphasis exactly backwards.
export function rowStatus(t: StatusRow, fetching: string | null): string | null {
  if (t.missing) return "(Missing file)";
  if (fetching === t.path) return "(Downloading...)";
  // `notDownloaded` is a copy of a scan-cache flag taken when the row was built,
  // and a download that has landed since is the later fact about the same file.
  if (isNotDownloaded(t)) return "(Not downloaded)";
  return null;
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
export function applyCellStatus(host: HTMLElement, status: string | null): void {
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
    existing.textContent = status;
    return;
  }
  const label = primary.textContent ?? "";
  primary.dataset.plain = label;
  primary.textContent = "";
  primary.classList.add("has-status");
  append(primary, [
    h("span", { class: "row-title-text", text: label }),
    h("span", { class: "row-status", text: status }),
  ]);
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
export function applyInlineStatus(host: HTMLElement, status: string | null): void {
  const existing = host.querySelector<HTMLElement>(":scope > .row-status");
  if (status === null) {
    existing?.remove();
    return;
  }
  if (existing) {
    existing.textContent = status;
    return;
  }
  host.appendChild(h("span", { class: "row-status", text: status }));
}
