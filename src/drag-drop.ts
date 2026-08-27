// Pointer-based drag for curation: reorder a list row, or insert track(s)
// dragged in from the tree. Built on pointer events rather than HTML5
// drag-and-drop so it coexists with Tauri's native OS file-drop handler (the
// window keeps the default dragDropEnabled: true): that handler swallows HTML5
// dragstart/drop inside the webview but leaves pointer events untouched. Pointer
// events also sidestep WKWebView's unreliable dataTransfer — the payload simply
// lives in this closure.

import { invoke } from "@tauri-apps/api/core";
import { h } from "./dom";
import type { ActiveDrag, DragPayload, SearchTrack, Stream } from "./types";
import { queueListEl, streamsContainer, streamListPathInput } from "./dom-refs";
import { streamListWritable, app } from "./state";
import {
  queueSel,
  selectedListTracks,
  reorderCuratedTracks,
  insertCuratedTracks,
} from "./main";
import { refreshStreams } from "./library";

// A drag only *starts* once the pointer travels this many px from where it went
// down, so a plain click on a row still plays/commits it (no accidental reorder)
// and a click on a tree track still plays it.
const DRAG_THRESHOLD_PX = 5;

let activeDrag: ActiveDrag | null = null;

// Begin a tree-track drag (called from the tree on pointerdown). Carries the
// track(s) to insert; the drag only engages past the movement threshold. Drops
// land in the open queue/playlist list.
export function startTrackDrag(e: PointerEvent, tracks: SearchTrack[]): void {
  beginPointerDrag(e, { kind: "tracks", tracks }, null, queueListEl, "li.queue-row");
}

// Arm a drag from a pointerdown on a drag source (a list row, or a tree track).
// `listEl`/`rowSelector` name the list the drop resolves against.
function beginPointerDrag(
  e: PointerEvent,
  payload: DragPayload,
  sourceEl: HTMLElement | null,
  listEl: HTMLElement,
  rowSelector: string,
): void {
  if (e.button !== 0) return; // left button only
  activeDrag = {
    payload,
    sourceEl,
    listEl,
    rowSelector,
    startX: e.clientX,
    startY: e.clientY,
    started: false,
    dropAt: null,
  };
  // Kill text selection for the whole gesture from the outset — a pointer sweep
  // across rows would otherwise rubber-band-select their titles before the drag
  // threshold is even crossed. WKWebView doesn't reliably honor user-select:none
  // mid-gesture, so also cancel selectstart outright. Harmless on a plain click.
  document.body.classList.add("dragging-noselect");
  document.addEventListener("selectstart", preventSelectStart);
  window.addEventListener("pointermove", onDragPointerMove);
  window.addEventListener("pointerup", onDragPointerUp);
  window.addEventListener("pointercancel", onDragPointerCancel);
}

function onDragPointerMove(e: PointerEvent): void {
  const d = activeDrag;
  if (!d) return;
  if (!d.started) {
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (dx * dx + dy * dy < DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) return;
    d.started = true;
    if (d.sourceEl) d.sourceEl.classList.add("dragging");
    document.body.classList.add("reordering");
    // Drop any selection that slipped in before user-select:none took hold.
    window.getSelection()?.removeAllRanges();
    createDragGhost(d.payload);
  }
  moveDragGhost(e.clientX, e.clientY);
  d.dropAt = updateDropTarget(e.clientX, e.clientY);
}

function onDragPointerUp(): void {
  const d = activeDrag;
  endPointerDrag();
  if (!d || !d.started) return; // a click, not a drag — let the click handler run
  suppressNextClick();
  if (d.dropAt != null) applyDrop(d.payload, d.dropAt);
}

function onDragPointerCancel(): void {
  endPointerDrag();
}

// Block the browser from starting a text selection mid-drag (WKWebView ignores
// user-select:none once a selection is underway).
function preventSelectStart(e: Event): void {
  e.preventDefault();
}

// Tear down an in-progress drag: drop the window listeners, markers, and styling.
function endPointerDrag(): void {
  window.removeEventListener("pointermove", onDragPointerMove);
  window.removeEventListener("pointerup", onDragPointerUp);
  window.removeEventListener("pointercancel", onDragPointerCancel);
  document.removeEventListener("selectstart", preventSelectStart);
  if (activeDrag?.sourceEl) activeDrag.sourceEl.classList.remove("dragging");
  document.body.classList.remove("reordering", "dragging-noselect");
  clearDropMarkers();
  removeDragGhost();
  activeDrag = null;
}

// A floating badge that follows the pointer during a drag, showing how many
// tracks are in flight ("N tracks"). Purely cosmetic — the payload lives in the
// activeDrag closure, not the DOM — so it gives the gesture a visible object to
// carry rather than only the drop marker at the destination.
let dragGhostEl: HTMLElement | null = null;

function createDragGhost(p: DragPayload): void {
  const n = p.kind === "stream" ? 0 : p.tracks.length;
  const el = h("div", {
    class: "drag-ghost",
    text: p.kind === "stream" ? p.stream.name : `${n} track${n === 1 ? "" : "s"}`,
  });
  document.body.appendChild(el);
  dragGhostEl = el;
}

// Position the badge just below-right of the pointer so it doesn't sit under the
// cursor or eat elementFromPoint hit-tests (it's also pointer-events:none).
function moveDragGhost(x: number, y: number): void {
  if (!dragGhostEl) return;
  dragGhostEl.style.left = `${x}px`;
  dragGhostEl.style.top = `${y}px`;
}

function removeDragGhost(): void {
  dragGhostEl?.remove();
  dragGhostEl = null;
}

// A real drag ends with a click (pointerup over the row); swallow that one click
// so the drag doesn't also play/commit the row. Cleared shortly after in case no
// click fires (e.g. the pointer released off the row).
function suppressNextClick(): void {
  const stop = (ev: Event) => ev.stopPropagation();
  window.addEventListener("click", stop, { capture: true, once: true });
  setTimeout(() => window.removeEventListener("click", stop, true), 300);
}

// Hit-test the pointer against the open list and paint the drop marker. Returns
// the view index an insert would land at: before the row under the pointer (top
// half) or after it (bottom half); the end of the list when the pointer is over
// the list's empty area past the last row (or an empty list); null when the
// pointer is off the list entirely, which cancels the drop.
function updateDropTarget(x: number, y: number): number | null {
  clearDropMarkers();
  const d = activeDrag;
  if (!d) return null;
  const rows = Array.from(d.listEl.querySelectorAll<HTMLElement>(d.rowSelector));
  const el = document.elementFromPoint(x, y) as HTMLElement | null;
  const row = el?.closest(d.rowSelector) as HTMLElement | null;
  if (row && d.listEl.contains(row)) {
    const rect = row.getBoundingClientRect();
    const before = y < rect.top + rect.height / 2;
    row.classList.add(before ? "drop-before" : "drop-after");
    return rows.indexOf(row) + (before ? 0 : 1);
  }
  // Off the rows: an insert at the end while still within the list box, else cancel.
  const box = d.listEl.getBoundingClientRect();
  const inside = x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
  return inside ? rows.length : null;
}

function clearDropMarkers(): void {
  activeDrag?.listEl
    .querySelectorAll(".drop-before, .drop-after")
    .forEach((el) => el.classList.remove("drop-before", "drop-after"));
}

// Resolve a drop at view index `at`: an internal reorder, an insert of track(s)
// dragged in from the tree, or a station reorder in the stream list.
function applyDrop(p: DragPayload, at: number): void {
  if (p.kind === "reorder") reorderCuratedTracks(p.tracks, at);
  else if (p.kind === "tracks") insertCuratedTracks(p.tracks, at);
  else void reorderStream(p.stream, at);
}

// Make a list row a drag source for reorder. A pointerdown on the row's remove
// button is ignored so the ✕ stays a plain click. The row is also a drop target
// for tree-track inserts, resolved by pointer hit-testing in updateDropTarget.
export function attachRowReorder(li: HTMLElement, track: SearchTrack): void {
  li.addEventListener("pointerdown", (e) => {
    if ((e.target as HTMLElement).closest(".queue-remove")) return;
    // Dragging a selected row carries the whole selection (in view order); a row
    // outside the selection carries just itself. Mirrors the tree drag so a
    // multi-selection reorders as one block instead of only the grabbed row.
    const sel = queueSel.signal.peek();
    const tracks = sel.has(track) && sel.size > 1 ? selectedListTracks() : [track];
    beginPointerDrag(e, { kind: "reorder", tracks }, li, queueListEl, "li.queue-row");
  });
}

// Make a stream row a drag source for reordering the (writable, local) stream
// list. A pointerdown on the hover play button is ignored so it stays a plain
// click; the drop persists straight to the .m3u8 via move_stream + refresh.
export function attachStreamReorder(li: HTMLElement, stream: Stream): void {
  li.addEventListener("pointerdown", (e) => {
    if (!streamListWritable.value) return;
    if ((e.target as HTMLElement).closest(".row-play")) return;
    beginPointerDrag(e, { kind: "stream", stream }, li, streamsContainer, "li.stream-row");
  });
}

// Move a dragged station to view index `to` (insert-before) and persist the new
// order to the stream list file, then re-render. The station's live index is
// resolved against allStreams at drop time; a no-op move is skipped so it doesn't
// rewrite the file needlessly.
async function reorderStream(stream: Stream, to: number): Promise<void> {
  if (!streamListWritable.value) return;
  const from = app.allStreams.indexOf(stream);
  if (from < 0 || to === from || to === from + 1) return;
  try {
    await invoke("move_stream", { path: streamListPathInput.value, from, to });
  } catch (e) {
    console.error("move_stream failed", e);
    return;
  }
  await refreshStreams(streamListPathInput.value);
}
