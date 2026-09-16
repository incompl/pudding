// The right-pane list face + queue/playlist curation. renderQueue paints the
// list (queue or browsed playlist); the curation ops (reorder / remove / insert /
// append) funnel through applyCuration, which swaps the signal, reconciles the
// live engine pool, and autosaves playlist files. The "Add to queue" family
// (seed / arm / append / close / teardown) builds and dismantles the queue.

import { invoke } from "@tauri-apps/api/core";
import { signal } from "@preact/signals-core";
import { h, eqBars, append } from "./dom";
import type {
  Queue,
  SearchTrack,
  SearchFolder,
  TreeNode,
  ContextMenuItem,
  PlaylistData,
  PlaylistWriteRow,
} from "./types";
import {
  app,
  hasTrack,
  isStream,
  currentTime,
  duration,
  currentNodePath,
  currentStreamUrl,
  npTitle,
  npArtist,
  npAlbum,
  npAlbumArtist,
  queuePlayingIndex,
  fetchingPath,
  activeQueue,
  browsedPlaylist,
  listFaceOpen,
  shuffleMode,
  repeatMode,
  autoadvanceEnabled,
  isPlaylistSource,
  openActiveQueue,
  clearActiveQueue,
  showSourceList,
  dismissRightPanel,
  isPlayableRow,
} from "./state";
import {
  queueListEl,
  queueTitleEl,
  queueSubtitleEl,
  queueCloseBtn,
  queueRenameBtn,
} from "./dom-refs";
import { showContextMenu } from "./context-menu";
import { applyCellStatus, rowStatus } from "./row-status";
import {
  activeColumns,
  buildCells,
  buildHeaderCells,
  columnHeaders,
  columnsMenuItem,
  showColumnsMenuAt,
  gridTemplate,
  gridClasses,
  isSortedBy,
  nextSort,
  setColumnRepaint,
  sortTracks,
  QUEUE_CELLS,
  type ColumnId,
  type SortState,
} from "./columns";
import { windowedList, type WindowedList } from "./windowed-list";
import { attachRowReorder } from "./drag-drop";
import { engine } from "./engine-glue";
import { editMetadataItem } from "./editors";
import { findNode } from "./library";
import {
  syntheticParent,
  refillShuffleBag,
  resetShuffleState,
  playSingle,
  playPool,
  poolPaths,
  shuffled,
  rowPlayButton,
  playStream,
} from "./playback";
import {
  queueSel,
  openListTracks,
  selectedListTracks,
  playQueueTrack,
  commitBrowsedPlaylist,
  queueIsActivePool,
  trackCountSubtitle,
  addToPlaylistItem,
  showInFinderItem,
  toast,
  clearArt,
  UNTITLED_PLAYLIST_TITLE,
} from "./main";

// Renders the queue view's track list. Rebuilt whenever the queue or the
// playing row changes (both cheap: a queue is at most a few hundred rows).
// One uniform view for every queue regardless of how it was built — a queue is
// an arbitrary, possibly mixed-source list once you can Add to it from anywhere,
// so there's no per-kind header cover or per-kind row line. The playing row
// (queuePlayingIndex, which distinguishes duplicate rows) is highlighted and
// scrolled into view; clicking any row plays it within the queue.
// One-shot: the index a just-appended track wants brought into view. renderQueue
// consumes it so the re-render lands on the new row rather than the default
// scroll-to-playing (which sits earlier, and would otherwise hide the addition).

// The live window over the queue rows, and the (queue, isSource) it was built for.
// A play-advance re-enters renderQueue with the *same* queue object and only needs
// the playing highlight repainted + the playing row kept in view; tearing down and
// rebuilding the window there would lose the scroll position, so we detect that case
// and skip the rebuild (see renderQueue).
let queueWin: WindowedList | null = null;
let renderedQueue: Queue | null = null;
let renderedIsSource = false;

// --- columns (right pane) ---------------------------------------------------
//
// The queue's automatic set is what it shipped with: the title, the track's own
// artist, and the trailing runtime — deliberately never the album, since a queue
// is an arbitrary mixed-source list and the album repeats as noise more often than
// it distinguishes. The artist column is dropped when *no* row in the list carries
// one, so a list of untagged files gives its whole width to the titles instead of
// splitting it against a column of blanks.
function autoQueueColumns(tracks: SearchTrack[]): ColumnId[] {
  const anyArtist = tracks.some((t) => !t.missing && !!t.artist);
  return anyArtist ? ["title", "artist", "duration"] : ["title", "duration"];
}

// The queue has an *order*, not a sort: the list is the play order, and the user
// owns it. So a header click here is an edit — a one-shot reorder pushed through
// applyCuration, which means it autosaves a playlist, reconciles the live engine
// pool, and (crucially) lands on the existing ⌘Z stack like any other curation.
//
// The header still carries the same arrow the library's does, because the arrow
// says what the rows *are*, and after that edit they really are in that order.
// What it can't be here is a remembered click: the very next drag, add, remove or
// ⌘Z leaves the order something else, and none of those paths should have to know
// a header exists. So the click is remembered only as a candidate, and every paint
// re-derives whether it still holds (isSortedBy, one pass over the rows). The mark
// dies on its own the moment the order stops matching it.
let lastQueueSort: SortState = null;

// The arrow to draw over the queue's rows: the last click, but only while the rows
// are still in that order.
function queueSortMark(tracks: SearchTrack[]): SortState {
  return isSortedBy(tracks, lastQueueSort) ? lastQueueSort : null;
}

function sortQueueBy(id: ColumnId): void {
  const list = curatedList();
  if (!list) return;
  // Cycle from the mark the user can see, not from the last click: if the order
  // has drifted since (so the arrow is gone), clicking that header again means
  // "sort by this", ascending — the same thing it means on a header that was never
  // clicked at all.
  const next = nextSort(queueSortMark(list.tracks), id);
  lastQueueSort = next;
  // Third click: leave the order where the second click put it — but drop the
  // arrow, since the rows are now in an order the user owns rather than one the
  // header is claiming. Nothing else changed, so only the header needs repainting.
  if (!next) {
    repaintQueueList();
    return;
  }
  applyCuration(sortTracks(list.tracks, next));
}

// The header row, when the pane's headers are switched on. Built as a real
// .queue-row — same padding, same gutter width, same --cols template — so it lines
// up with the rows by construction rather than by a second set of matched numbers.
// It is display:none outside column mode, gated by the *same* container query as
// the columns, so a header can never appear above a folded row.
function buildQueueHeader(cols: ColumnId[], template: string, tracks: SearchTrack[]): HTMLElement {
  const cells = h("span", {
    class: "queue-text col-grid",
    style: { "--cols": template },
  });
  append(cells, buildHeaderCells("queue", cols, queueSortMark(tracks), sortQueueBy));
  return h(
    "li",
    {
      class: "queue-row colhead",
      // Right-clicking the header is the other way to reach the picker the row
      // menu carries under `Columns ▸` — the header is the columns, so it opens
      // them flat. Its own handler, not the row menu's: a header is not a track,
      // and Play / Add to queue would have nothing to act on.
      on: { contextmenu: (e) => showColumnsMenuAt(e, "queue", autoQueueColumns(tracks)) },
    },
    h("span", { class: "queue-num" }),
    cells,
  );
}

// view index → playable-pool index (queuePlayingIndex space, which excludes the
// rows the engine never sees), or -1 for a row that isn't in the pool at all — a
// missing file or a stream. Lets a row map its playing highlight and click back to
// its pool position without re-walking the list per row.
function buildViewToPool(tracks: SearchTrack[]): number[] {
  const map: number[] = [];
  let pool = 0;
  for (const t of tracks) {
    map.push(isPlayableRow(t) ? pool : -1);
    if (isPlayableRow(t)) pool++;
  }
  return map;
}

// Build one queue row (view index `i`), fresh, the way the window (re)mounts it as
// it scrolls. Reads the playing/selected state live at build time so a row scrolled
// into view after an advance or a cmd-click is already correct without waiting for a
// painter effect. `viewToPool` maps this row to its playable-pool index.
function buildQueueRow(
  queue: Queue,
  isSource: boolean,
  viewToPool: number[],
  cols: ColumnId[],
  template: string,
  i: number,
): HTMLElement {
  const t = queue.tracks[i];
  const rowPoolIdx = viewToPool[i];
  // A browsed playlist isn't the pool, so nothing in it is "playing".
  const playing = isSource ? queuePlayingIndex.peek() : null;
  const isPlaying = rowPoolIdx === playing;
  // The playing row keeps its index and just recolors to the accent (like the
  // tree's track rows), rather than swapping in a glyph. The number and the
  // hover play button share this one gutter cell (see CSS), so the button
  // lands exactly where the number was.
  const label = String(i + 1);
  const num = h(
    "span",
    { class: "queue-num" },
    h("span", {
      class: "queue-num-text",
      text: label,
      // 4+ digit numbers shrink to the 3-digit width so they stay centered
      // without overflowing (same rule as the Songs list — tabular digits are
      // equal width, so N digits fit 3 digits' width at scale 3/N).
      style: label.length > 3 ? { "font-size": `${3 / label.length}em` } : {},
    }),
  );
  // One cell per column, in the field table's order. The same DOM serves both
  // layouts: past the pane's 28rem breakpoint `.col-grid` becomes a grid and each
  // cell is a track; below it the cells fold back into one inline `title · a · b`
  // line via the `· ` separators in CSS. Either way the row is a single line, so
  // the windowed row geometry (each slot placed at i * rowHeight, from one probe
  // row) stays uniform.
  const text = h("span", {
    class: gridClasses("queue", "queue-text"),
    style: { "--cols": template },
  });
  append(text, buildCells(t, cols, QUEUE_CELLS));
  // The row's one aside — "(Missing file)" for a playlist row whose file is gone,
  // or a cloud file's "(Downloading...)" / "(Not downloaded)". Shared with the
  // left pane's two track lists, which draw the same marker from the same facts;
  // why it lives inside the title cell rather than in a column of its own is in
  // row-status.ts. A missing row is also dimmed and left without a click handler
  // below, so it reads as unavailable rather than dropped.
  applyCellStatus(text, rowStatus(t, fetchingPath.peek()));
  // Row remove (curation): strips this row from the list (and file, if a
  // playlist). Stops propagation so it never counts as a play/commit click.
  const remove = h("button", {
    class: "queue-remove",
    text: "✕",
    attrs: { type: "button", title: "Remove from list", "aria-label": "Remove from list" },
    on: {
      click: (e) => {
        e.stopPropagation();
        removeCuratedRow(i);
      },
    },
  });
  // The view index, so the reactive selection effect (and the drag-drop drop-index
  // math) can map back to the full list without relying on a unique path (duplicates
  // share one) — essential once the list is windowed and only a slice is mounted.
  const li = h("li", { class: "queue-row", data: { rowIndex: i } }, num, text, remove);
  if (isPlaying) li.classList.add("playing");
  // Multi-select background, reapplied on remount like .playing (the list selection
  // effect keeps it live between remounts as the window scrolls).
  if (isPlayableRow(t) && queueSel.signal.peek().has(t)) li.classList.add("selected");
  if (t.stream) {
    // A station row. It can't join the pool (the engine's queue holds files), but
    // it is perfectly playable on its own terms, so it keeps a play button and a
    // double-click — they just hand it to the stream path, which is lone playback
    // and takes the pane with it, exactly as playing a station from Streams does.
    li.classList.add("stream");
    const playRow = () => playStream({ name: t.title ?? t.path, url: t.path });
    num.appendChild(rowPlayButton(playRow));
    li.addEventListener("dblclick", playRow);
  } else if (t.missing) {
    li.classList.add("missing");
  } else {
    // Select-and-play, shared by the hover play button and a double-click. The
    // played row stays selected (matching the tree and Apple Music). Source
    // list: jump the pool to this row. Browsed playlist: commit it — play the
    // playlist from that track, making it the source.
    const playRow = () => {
      queueSel.single(t);
      if (isSource) playQueueTrack(rowPoolIdx);
      else commitBrowsedPlaylist(rowPoolIdx);
    };
    // The playing-row equalizer glyph, hidden until this row owns the playhead
    // (CSS keys off .queue-row.playing) and swapped for the pause button on hover.
    num.appendChild(eqBars());
    // Hover play button in the gutter, mirroring the tree's track rows (pause
    // on the row that owns the playhead — see rowPlayButton).
    num.appendChild(rowPlayButton(playRow));
    li.addEventListener("click", (e) => {
      app.lastSelectionPane = "list";
      // Cmd/Ctrl- and Shift-click build a selection; a plain click selects just
      // this row (and anchors a following Shift-range here). Play is the hover
      // button or a double-click, matching the tree.
      if (e.metaKey || e.ctrlKey) {
        queueSel.toggle(t);
        return;
      }
      if (e.shiftKey) {
        queueSel.rangeTo(t, openListTracks());
        return;
      }
      queueSel.single(t);
    });
    li.addEventListener("dblclick", playRow);
  }
  // Right-click a playable row to queue it, add it to a playlist, reveal it in
  // Finder, or (multi) remove it (a missing row has no real file to copy — or
  // to reveal — so it's skipped).
  // "Add to queue" leads, matching the tree track/folder menus.
  if (isPlayableRow(t)) {
    li.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      // Finder-style: right-clicking a row outside the selection makes it the
      // selection; inside a multi-selection it's kept. The verbs act on it.
      if (!queueSel.signal.peek().has(t)) queueSel.single(t);
      const sel = selectedListTracks();
      if (sel.length > 1) {
        void showContextMenu(e.clientX, e.clientY, [
          ...queueMenuItems((sink) => sink(sel), sel.length),
          addToPlaylistItem(() => sel),
          editMetadataItem(sel),
          {
            label: `Remove ${sel.length} from list`,
            action: () => removeCuratedTracks(sel),
          },
          showInFinderItem(sel[0].path),
          columnsMenuItem("queue", autoQueueColumns(queue.tracks)),
        ]);
      } else {
        void showContextMenu(e.clientX, e.clientY, [
          ...queueMenuItems((sink) => sink([t])),
          addToPlaylistItem(() => [t]),
          editMetadataItem([t]),
          showInFinderItem(t.path),
          // Right-clicking a row scopes the picker to that row's pane implicitly,
          // so it needs no "Queue ▸" label and no focused-pane guesswork.
          columnsMenuItem("queue", autoQueueColumns(queue.tracks)),
        ]);
      }
    });
  }
  attachRowReorder(li, t);
  return li;
}

// Renders the list face. `isSource` is true when the list is the playing
// source (the queue, or a played playlist) and false when it's a playlist being
// browsed while something else plays — a browse carries no playing-row highlight
// and its rows *commit* (play the playlist) rather than jumping the pool.
//
// The rows are windowed (src/windowed-list.ts): only the on-screen slice is mounted
// over a full-height spacer, so a queue/playlist of any length costs a screenful of
// DOM instead of a node per track. Native scroll is untouched (the spacer sizes the
// real #queue-list scroll pane). Per-row listeners are re-created on each remount
// (cheap at a screenful) rather than delegated — same trade the leaf lists make.
// The margin every reveal into this list has to clear. The column header is
// `position: sticky` at the top of the scroll box, so a row scrolled flush to the
// top lands *underneath* it — visible to the layout, invisible to the reader. Read
// off the DOM rather than passed down, because the reveals that need it come from
// four different places (a render, a play-advance, keyboard navigation) and only
// the list knows whether it currently has a header at all: offsetHeight is 0 when
// the header is switched off or folded away by a narrow pane, which is exactly the
// margin wanted then.
function stickyMargin(): number {
  return queueListEl.querySelector<HTMLElement>(".colhead")?.offsetHeight ?? 0;
}

export function renderQueue(queue: Queue | null, isSource: boolean): void {
  if (!queue) {
    queueListEl.replaceChildren();
    queueWin = null;
    renderedQueue = null;
    return;
  }
  const isPlaylist = isPlaylistSource(queue);
  // A real playlist is titled by its #PLAYLIST: name; every ephemeral queue is
  // simply "Queue" (the source name lives on the hero, not this list header).
  queueTitleEl.textContent = isPlaylist ? queue.title : "Queue";
  queueSubtitleEl.textContent = queue.subtitle ?? "";
  queueSubtitleEl.classList.toggle("hidden", !queue.subtitle);
  // Only the ephemeral queue offers teardown (Clear). A playlist has no
  // header teardown — deleting one is a tree action. A playlist instead offers an
  // inline rename: the title reads as clickable and reveals a pencil on hover; the
  // queue has no name to edit.
  queueCloseBtn.classList.toggle("hidden", isPlaylist);
  queueRenameBtn.classList.toggle("hidden", !isPlaylist);
  queueTitleEl.parentElement?.classList.toggle("renamable", isPlaylist);

  const viewToPool = buildViewToPool(queue.tracks);

  // A pending append/insert target wins over the playing row for the reveal, once
  // (and only when we're showing the queue it targeted — a browsed playlist has its
  // own, unrelated rows, so it never steals a queue append's scroll).
  const pending = isSource ? app.pendingQueueScrollIndex : null;
  app.pendingQueueScrollIndex = null;
  const playIdx = isSource ? queuePlayingIndex.peek() : null;
  const playingView = playIdx != null ? viewIndexOfPlayable(queue.tracks, playIdx) : -1;
  const revealTo = pending ?? (playingView >= 0 ? playingView : null);

  // Same list object as the last paint — a play-advance or a selection change, not a
  // content edit (every curation swaps in a new Queue object). Repaint the playing
  // highlight on the mounted rows and keep the playing row in view, without tearing
  // down the window (which would lose the scroll position and reflash the slice).
  if (
    queue === renderedQueue &&
    isSource === renderedIsSource &&
    queueWin &&
    queueListEl.contains(queueWin.el)
  ) {
    const fetching = fetchingPath.peek();
    queueListEl.querySelectorAll<HTMLElement>("li.queue-row:not(.colhead)").forEach((li) => {
      li.classList.toggle("playing", viewToPool[Number(li.dataset.rowIndex)] === playIdx);
      // The parked download moves from row to row as the queue plays, and this
      // is the repaint that already runs on every play-advance.
      const row = queue.tracks[Number(li.dataset.rowIndex)];
      const cell = li.querySelector<HTMLElement>(".queue-text");
      if (row && cell) applyCellStatus(cell, rowStatus(row, fetching));
    });
    if (revealTo != null) queueWin.revealIndex(revealTo, stickyMargin());
    return;
  }

  renderedQueue = queue;
  renderedIsSource = isSource;
  const cols = activeColumns("queue", autoQueueColumns(queue.tracks));
  // One template for the whole list, computed here rather than per row: a fixed
  // column's width is a fact about the list (see gridTemplate), and this is the
  // only place that sees all of it — the rows below are built one at a time, as
  // the window scrolls them in.
  const showHeader = columnHeaders.queue.peek();
  const template = gridTemplate(cols, queue.tracks, showHeader, "queue");
  // Row count, so the drag-drop drop-index math can resolve an insert-at-the-end
  // without every row being mounted (updateDropTarget reads it).
  queueListEl.dataset.rowCount = String(queue.tracks.length);
  queueListEl.replaceChildren();
  // A playlist with no rows at all. Say so in the pane: a blank list reads as a
  // load that failed, and this is the one case where the pane has nothing else to
  // show for itself — the file opened fine, it just holds no tracks. Only a
  // playlist can be looked at empty; clearing a queue tears the face down instead.
  if (isPlaylist && queue.tracks.length === 0) {
    queueWin = null;
    queueListEl.appendChild(
      h("li", { class: "empty-state", text: "This playlist is empty" }),
    );
    return;
  }
  // Sticky, inside #queue-list — which is the query container, so the header can
  // be gated by the same @container rule the columns are.
  const header = showHeader ? buildQueueHeader(cols, template, queue.tracks) : null;
  if (header) queueListEl.appendChild(header);

  const buildRow = (i: number): HTMLElement =>
    buildQueueRow(queue, isSource, viewToPool, cols, template, i);

  // Debug/e2e escape hatch: render every row eagerly (no measured-layout windowing)
  // so fake-DOM tests can assert on real rows. Mirrors renderLeafTrackList.
  if ((globalThis as { __noWindowing?: boolean }).__noWindowing) {
    queueWin = null;
    for (let i = 0; i < queue.tracks.length; i++) queueListEl.appendChild(buildRow(i));
    // Index among the *track* rows: the column header, when shown, is child 0.
    const rows = queueListEl.querySelectorAll<HTMLElement>("li.queue-row:not(.colhead)");
    const row = revealTo != null ? rows[revealTo] : undefined;
    if (row && typeof row.scrollIntoView === "function") row.scrollIntoView({ block: "nearest" });
    return;
  }

  const win = windowedList({ count: queue.tracks.length, renderRow: buildRow });
  queueWin = win;
  queueListEl.appendChild(win.el);
  // Mount the first slice synchronously (the pane is visible here), so the rows
  // exist on this same tick — no one-frame blank flash, and a click synthesized
  // straight after a render (curation, tests) finds its row.
  win.flush();
  // Reveal past the sticky header, so a scrolled-to row never lands under it.
  if (revealTo != null) win.revealIndex(revealTo, stickyMargin());
}

// Force a full rebuild of the list rows — the column set, header visibility, or
// sort changed, none of which any signal the render effect tracks. renderQueue
// short-circuits when handed the same Queue object, so clear that guard first.
export function repaintQueueList(): void {
  const q = renderedQueue;
  if (!q) return;
  const isSource = renderedIsSource;
  renderedQueue = null;
  renderQueue(q, isSource);
}

setColumnRepaint("queue", repaintQueueList);
// Scroll a row of the open list (queue or browsed playlist) into view by its
// view index — the equivalent of scrollIntoView({ block: "nearest" }). Backs
// keyboard list navigation, whose selection move must keep the focused row on
// screen (the selection-paint effect only repaints mounted rows). A no-op when
// the list is torn down (queueWin null).
export function revealQueueRow(viewIndex: number): void {
  queueWin?.revealIndex(viewIndex, stickyMargin());
}

// --- Curation (phase 3): reorder / remove / drag-in on the open list ---
//
// Edits act on the list currently shown — a browsed playlist if one is open, else
// the active queue. Three tiny operations (reorder, remove, insert) produce a new
// view-array and funnel through applyCuration, which updates the signal, autosaves
// the file (playlists only), and — when the edited list is the audible pool —
// reconciles playback so the playing track is undisturbed (or skipped, if it was
// the removed row). See playlist-plan.md "reconciling reorder/remove with live
// playback".

// The list a curation edit targets: the open browse if any, else the active queue.
export function curatedList(): Queue | null {
  return browsedPlaylist.value ?? activeQueue.value;
}

// --- Curation undo/redo ---
//
// A bounded per-list snapshot stack layered *over* autosave (a playlist is its file,
// so undo can't replace the write — it re-issues an earlier one). Every curation
// funnels through applyCuration, which snapshots the pre-edit track array before the
// swap; ⌘Z re-applies the previous snapshot and ⌘⇧Z the undone one, both via
// applyCurationCore so the re-apply reconciles playback and re-saves the file exactly
// like a fresh edit — but *without* recording, so undo/redo walk one shared timeline.
//
// Stacks are keyed per list so ⌘Z acts on whatever list is on screen: a playlist by
// its file path (history survives closing and reopening the browse), the ephemeral
// queue by a lazily-stamped historyId (see Queue.historyId) that keeps one queue's
// timeline distinct from the next's. Snapshots hold the track *objects* by reference
// (cheap — no copies), preserving identity so a removed row's exact instance returns
// and reconcilePoolEdit re-finds the playing track across an undo.
const MAX_CURATION_UNDO = 100; // per list, snapshots (paths-by-reference, so light)
const MAX_CURATION_LISTS = 64; // distinct lists remembered before evicting the oldest

type CurationHistory = { undo: SearchTrack[][]; redo: SearchTrack[][] };
const curationHistories = new Map<string, CurationHistory>();
let curationIdSeq = 0;

// Bumped after every history mutation (push / pop / forget) so a signal effect can
// re-sync the Edit ▸ Undo/Redo menu state — the stacks themselves are plain Maps
// that no signal tracks. Switching the curated list is already tracked (canUndo
// reads the browsed/active-queue signals), so this only needs to cover in-place
// stack growth and shrinkage.
export const curationHistoryVersion = signal(0);
function bumpCurationHistory(): void {
  curationHistoryVersion.value++;
}

// The history-stack key for the list a curation targets, or null when there's no
// list, or (for an ephemeral queue) none has been assigned yet — a queue with no
// historyId has never been curated, so it has no history to read. Read-only; the
// key is minted lazily by recordCurationSnapshot, the sole history *creator*.
function curationKey(): string | null {
  const list = curatedList();
  if (!list) return null;
  if (list.sourcePath) return `pl:${list.sourcePath}`;
  return list.historyId ?? null;
}

// The history key for an edit that's about to record, minting an ephemeral queue's
// historyId on first need. Carried forward by applyCurationCore's `{...list}`
// spread, so every later edit of the same queue resolves the same key.
function curationKeyForRecord(): string | null {
  const list = curatedList();
  if (!list) return null;
  if (list.sourcePath) return `pl:${list.sourcePath}`;
  if (!list.historyId) list.historyId = `q:${++curationIdSeq}:${Date.now()}`;
  return list.historyId;
}

function historyFor(key: string): CurationHistory {
  let h = curationHistories.get(key);
  if (!h) {
    h = { undo: [], redo: [] };
    curationHistories.set(key, h);
    // Bound the number of remembered lists: drop the oldest-touched when over.
    if (curationHistories.size > MAX_CURATION_LISTS) {
      const oldest = curationHistories.keys().next().value;
      if (oldest !== undefined) curationHistories.delete(oldest);
    }
  }
  return h;
}

// Snapshot the curated list before a user edit overwrites it, and fork the timeline
// (drop the redo stack — a new edit invalidates any undone future). Bounded: the
// oldest snapshot falls off the front.
function recordCurationSnapshot(): void {
  const list = curatedList();
  const key = curationKeyForRecord();
  if (!list || !key) return;
  const h = historyFor(key);
  h.undo.push(list.tracks.slice());
  if (h.undo.length > MAX_CURATION_UNDO) h.undo.shift();
  h.redo.length = 0;
  bumpCurationHistory();
}

export function canUndoCuration(): boolean {
  const key = curationKey();
  return key != null && (curationHistories.get(key)?.undo.length ?? 0) > 0;
}

export function canRedoCuration(): boolean {
  const key = curationKey();
  return key != null && (curationHistories.get(key)?.redo.length ?? 0) > 0;
}

// ⌘Z: restore the curated list's previous snapshot, banking the current state for
// redo. Returns whether anything was undone (a no-op when the stack is empty).
export function undoCuration(): boolean {
  const list = curatedList();
  const key = curationKey();
  if (!list || !key) return false;
  const h = curationHistories.get(key);
  if (!h || h.undo.length === 0) return false;
  h.redo.push(list.tracks.slice());
  applyCurationCore(h.undo.pop()!);
  bumpCurationHistory();
  return true;
}

// ⌘⇧Z: re-apply the most recently undone snapshot, banking the current state back
// onto the undo stack.
export function redoCuration(): boolean {
  const list = curatedList();
  const key = curationKey();
  if (!list || !key) return false;
  const h = curationHistories.get(key);
  if (!h || h.redo.length === 0) return false;
  h.undo.push(list.tracks.slice());
  applyCurationCore(h.redo.pop()!);
  bumpCurationHistory();
  return true;
}

// Forget a playlist's undo history — its file was deleted, so a lingering snapshot
// must not be able to re-save (resurrect) it on a later undo.
export function forgetCurationHistory(sourcePath: string): void {
  if (curationHistories.delete(`pl:${sourcePath}`)) bumpCurationHistory();
}

// Map a playable-pool index (queuePlayingIndex, which excludes the rows the engine
// never sees — missing files and streams) back to its index in the full view
// array. Inverse of renderQueue's poolIdx walk.
export function viewIndexOfPlayable(tracks: SearchTrack[], playableIdx: number): number {
  let p = 0;
  for (let i = 0; i < tracks.length; i++) {
    if (!isPlayableRow(tracks[i])) continue;
    if (p === playableIdx) return i;
    p++;
  }
  return -1;
}

// The playing row's SearchTrack object in `list`, or null. Tracked by object
// identity (not path) so a reorder/remove follows the exact instance even when the
// list holds duplicate paths.
export function playingTrackObj(list: Queue): SearchTrack | null {
  const idx = queuePlayingIndex.value;
  if (idx == null) return null;
  const v = viewIndexOfPlayable(list.tracks, idx);
  return v >= 0 ? list.tracks[v] : null;
}

// --- Playlist file access ----------------------------------------------------
// Every read and write of a .m3u8 goes through this pair, for one reason: each has
// to record the file's resulting mtime. That registry is what lets an open
// playlist tell "another app rewrote this" from "we just saved it" — the whole
// basis of reloadChangedPlaylists.

// The mtime each playlist file carried the last time we read or wrote it. Keyed by
// path and never pruned: it holds a handful of numbers, and a stale entry is
// corrected by the next read of that file.
const seenMtime = new Map<string, number>();

// Record a file's mtime as one we've accounted for. A null/undefined stamp (the
// file is gone, or the stat failed) forgets it instead, so a playlist that comes
// back is re-read rather than compared against a stamp from its previous life.
export function notePlaylistMtime(path: string, mtime: number | null | undefined): void {
  if (typeof mtime === "number") seenMtime.set(path, mtime);
  else seenMtime.delete(path);
}

// Has this file moved since we last saw it? A path we've never recorded counts as
// changed — we have no basis to claim otherwise.
export function playlistChangedOnDisk(path: string, mtime: number): boolean {
  return seenMtime.get(path) !== mtime;
}

// Read a playlist file, noting its mtime. Throws like the raw invoke; every caller
// already has a story for a playlist that won't open.
export async function readPlaylist(path: string): Promise<PlaylistData> {
  const data = await invoke<PlaylistData>("read_playlist", { path });
  notePlaylistMtime(path, data.mtime);
  return data;
}

// The one way a playlist file gets written. Each row carries its `#EXTINF` facts
// alongside its path: the library DB wins for tracks it knows, but a row from
// outside every library root has no other source of a title or runtime, and
// dropping them here is what used to strip a hand-made playlist of its metadata on
// its first reorder. Throws on failure; callers report.
export async function writePlaylist(
  path: string,
  name: string,
  tracks: PlaylistWriteRow[],
): Promise<void> {
  const mtime = await invoke<number | null>("write_playlist", {
    path,
    name,
    tracks: tracks.map((t) => ({ path: t.path, title: t.title, duration: t.duration })),
  });
  // Claim the stamp we just produced, or the watcher sees our own file land a beat
  // later, calls it an outside change, and reloads the pane out from under the
  // edit that caused it.
  notePlaylistMtime(path, mtime);
}

// Persist the open playlist after an edit. Every row is written (missing included)
// so the file round-trips.
export async function saveOpenPlaylist(path: string, name: string, tracks: SearchTrack[]): Promise<void> {
  try {
    await writePlaylist(path, name, tracks);
  } catch (e) {
    console.error("write_playlist (autosave) failed", path, e);
    toast("Couldn't save playlist");
  }
}

// Adopt rows re-read from disk into whichever open copies point at that file, and
// say whether anything open actually took them.
//
// Deliberately not applyCuration: that records an undo snapshot and autosaves, and
// neither belongs to a change we didn't make — ⌘Z would write the pre-reload rows
// straight back over the other app's edit. The stored curation history is dropped
// instead, since every snapshot in it describes a file that no longer exists.
export function adoptReloadedPlaylist(
  path: string,
  title: string,
  tracks: SearchTrack[],
): boolean {
  const browsed = browsedPlaylist.value;
  const active = activeQueue.value;
  const hitsBrowsed = browsed != null && browsed.sourcePath === path;
  const hitsActive = active != null && active.sourcePath === path;
  if (!hitsBrowsed && !hitsActive) return false;

  // The reload built fresh row objects, so the identity reconcilePoolEdit tracks
  // is gone and has to be re-established by path before the swap.
  const isPool = hitsActive && queueIsActivePool();
  const playingOld = isPool ? playingTrackObj(active!) : null;
  const playingNew = playingOld
    ? rematchPlaying(playingOld, queuePlayingIndex.value ?? 0, tracks)
    : null;

  const subtitle = trackCountSubtitle(tracks);
  if (hitsBrowsed) browsedPlaylist.value = { ...browsed!, title, tracks, subtitle };
  if (hitsActive) activeQueue.value = { ...active!, title, tracks, subtitle };

  if (isPool) {
    reconcilePoolEdit(tracks, playingNew);
    // The outside edit deleted the row we're sounding. Let it play out — an edit in
    // another app is no reason to cut the audio — but stop claiming a row, or the
    // highlight lands on whatever slid into that index.
    if (playingOld && !playingNew) queuePlayingIndex.value = null;
  }
  forgetCurationHistory(path);
  return true;
}

// The playing row, found again in a freshly read list. Matched by path, nearest to
// where it was: a playlist may hold the same file more than once, and snapping the
// highlight to the file's first copy would misreport what's sounding.
function rematchPlaying(
  playing: SearchTrack,
  oldIdx: number,
  tracks: SearchTrack[],
): SearchTrack | null {
  let best: SearchTrack | null = null;
  let bestDist = Infinity;
  let i = 0;
  for (const t of tracks) {
    if (!isPlayableRow(t)) continue;
    if (t.path === playing.path && Math.abs(i - oldIdx) < bestDist) {
      bestDist = Math.abs(i - oldIdx);
      best = t;
    }
    i++;
  }
  return best;
}

// Apply a new view-array to the open list: swap the signal, reconcile playback when
// it's the live pool, and autosave when it's a playlist file. The user-facing entry
// point — it records an undo snapshot of the pre-edit list first. Undo/redo re-enter
// through applyCurationCore instead, so a re-applied snapshot doesn't itself record.
export function applyCuration(newTracks: SearchTrack[]): void {
  recordCurationSnapshot();
  applyCurationCore(newTracks);
}

function applyCurationCore(newTracks: SearchTrack[]): void {
  const browsed = browsedPlaylist.value;
  const list = browsed ?? activeQueue.value;
  if (!list) return;
  // The edit touches the live engine pool when we're editing the active pool
  // directly (no browse open), or when the browsed playlist *is* the playing
  // pool — same source file, opened for a look while it plays. Without the
  // second case, curating a browsed copy of the playing playlist would write the
  // file but leave the engine order, gapless tail, and activeQueue.tracks stale.
  const active = activeQueue.value;
  const browsedIsActivePool =
    browsed !== null &&
    queueIsActivePool() &&
    active != null &&
    browsed.sourcePath != null &&
    browsed.sourcePath === active.sourcePath;
  const isPool = (browsed === null && queueIsActivePool()) || browsedIsActivePool;
  // Capture the playing instance (by ref) from the *old* array before the swap.
  const playingObj = isPool ? playingTrackObj(list) : null;

  const updated: Queue = {
    ...list,
    tracks: newTracks,
    subtitle: trackCountSubtitle(newTracks),
  };
  if (browsed) browsedPlaylist.value = updated;
  else activeQueue.value = updated;

  // When the browsed view is also the live pool, keep the active queue's rows in
  // sync (sharing the edited objects) so a later autosave/reconcile of the queue
  // can't ship the pre-edit list.
  if (browsedIsActivePool && active) {
    activeQueue.value = { ...active, tracks: newTracks, subtitle: updated.subtitle };
  }

  if (isPool) reconcilePoolEdit(newTracks, playingObj);

  if (isPlaylistSource(list) && list.sourcePath) {
    void saveOpenPlaylist(list.sourcePath, list.title, newTracks);
  }
}

// Reconcile the engine + pool state after the live pool's track list changed.
// currentParent.children is rebuilt from the new playable rows; the playing track
// is then either kept (playback undisturbed — indices refreshed, gapless tail
// rebuilt to match the new order) or, if it was the removed row, skipped past.
export function reconcilePoolEdit(newTracks: SearchTrack[], playingObj: SearchTrack | null): void {
  if (!app.currentParent) return;
  const playable = newTracks.filter(isPlayableRow);
  // Rebuild the synthetic parent's children in place (same path, so
  // queueIsActivePool stays true and the pane keeps rendering this pool).
  app.currentParent.children = syntheticParent(
    app.currentParent.path,
    app.currentParent.name,
    playable,
  ).children;
  const poolPathsNew = playable.map((t) => t.path);
  app.lastQueue = poolPathsNew;

  const oldPlayableIdx = queuePlayingIndex.value;
  // Nothing was playing (queue drained or never started): just refresh the pool.
  if (playingObj === null || oldPlayableIdx == null) return;

  const newPlayableIdx = playable.indexOf(playingObj);
  if (newPlayableIdx >= 0) {
    // The playing track survived. Keep it playing; refresh the row highlight and
    // resume index; rebuild the engine's gapless tail so the upcoming order
    // matches. Only straight-play-with-autoadvance holds a tail to fix — per-track
    // modes hand the engine one track at a time, so a reorder is inaudible there.
    queuePlayingIndex.value = newPlayableIdx;
    app.lastIndex = newPlayableIdx;
    if (shuffleMode.value) {
      // Drop any removed paths from the pending bag and the played-order history
      // (dup-lossy, acceptable) so neither advances into nor steps back to a row
      // the edit deleted.
      app.shuffleBag = app.shuffleBag.filter((p) => poolPathsNew.includes(p));
      app.shuffleHistory = app.shuffleHistory.filter((p) => poolPathsNew.includes(p));
    } else if (repeatMode.value !== "one" && autoadvanceEnabled() && !app.pendingResume) {
      // Rebuild the gapless tail: drop the stale upcoming tracks, then re-append
      // the new order. Chained so the append can't race ahead of the clear.
      //
      // Not while a restored session is still armed (pendingResume): that state
      // has a playhead — a highlighted row, a remembered position — but the engine
      // holds no track and its queue is empty, so there is no upcoming order to
      // fix. An append to a drained engine doesn't reorder anything, it *starts
      // playback* (see engine.append), which is how curating a just-launched queue
      // — a sort, a drag, a remove, a ⌘Z — used to blast audio on a launch the user
      // hadn't pressed play on. Nothing is lost by skipping it: the first play
      // seeds the engine from poolPaths() at app.lastIndex, and both were just
      // refreshed above, so it starts in the edited order at the same track.
      const tail = poolPathsNew.slice(newPlayableIdx + 1);
      void engine.clearUpcoming().then(() => engine.append(tail));
    }
    return;
  }

  // The playing row was removed → skip to whatever now occupies its slot (an
  // edit, not a stop). The engine is still sounding the removed track, so this
  // must actively start the replacement (or stop when there's nothing left).
  advanceAfterRemovedPlaying(poolPathsNew, oldPlayableIdx);
}

// The playing row was removed from the live pool; move playback onward. Mirrors
// skipNext's mode branches, but the target is the track that *took* the removed
// slot (straight order), not slot+1.
export function advanceAfterRemovedPlaying(pool: string[], slot: number): void {
  // Same false premise as the tail rebuild above, reached the other way: a restored
  // session that was never played has a playhead — a highlighted row, a remembered
  // position — but no engine behind it, and that row has just been removed. Every
  // branch below actively starts audio, which on a launch the user hasn't pressed
  // play on is the same surprise. There is also nothing left to resume into, so
  // holding the arming would resume the wrong track at the removed one's offset.
  // Land on the resting state the ad-hoc queue already defines: no playhead, empty
  // hero, and the next play starts the queue from the top.
  if (app.pendingResume) {
    app.pendingResume = null;
    app.queueEnded = pool.length > 0;
    app.lastIndex = 0;
    stopAfterRemove();
    return;
  }
  if (pool.length === 0) {
    stopAfterRemove();
    return;
  }
  if (shuffleMode.value) {
    if (app.shuffleBag.length === 0) refillShuffleBag(null);
    const next = app.shuffleBag.shift();
    if (next) playSingle(next);
    else stopAfterRemove();
    return;
  }
  if (repeatMode.value === "one") {
    // Repeat-one can't loop a removed track: adopt the one now at the slot.
    const idx = slot < pool.length ? slot : 0;
    playSingle(pool[idx], idx);
    return;
  }
  const idx = slot < pool.length ? slot : repeatMode.value === "all" ? 0 : -1;
  if (idx < 0) {
    // Removed the last row while it played, no wrap: nothing follows.
    stopAfterRemove();
    return;
  }
  playPool(pool, idx);
}

// Removing the playing row left nothing to advance into: silence the engine and
// rest with no playhead. The (now shorter) list stays on screen.
export function stopAfterRemove(): void {
  queuePlayingIndex.value = null;
  currentNodePath.value = null;
  resetShuffleState();
  void engine.stop();
}

// Reorder the open list: move `moved` (one row, or a whole multi-selection) to
// sit before view index `to`, keeping the moved rows in their view order. A `to`
// past the end appends. By object identity, so duplicate paths keep their
// distinct rows and dropping onto the moving block itself is a no-op.
export function reorderCuratedTracks(moved: SearchTrack[], to: number): void {
  const list = curatedList();
  if (!list || moved.length === 0) return;
  const set = new Set(moved);
  // Anchor on the first row at or after `to` that isn't itself moving; drop
  // before it. With none (drop at the end, or inside the block's tail) append.
  let anchor: SearchTrack | null = null;
  for (let i = to; i < list.tracks.length; i++) {
    if (!set.has(list.tracks[i])) {
      anchor = list.tracks[i];
      break;
    }
  }
  const rest = list.tracks.filter((t) => !set.has(t));
  const block = list.tracks.filter((t) => set.has(t)); // in view order
  const insertAt = anchor ? rest.indexOf(anchor) : rest.length;
  const next = rest.slice();
  next.splice(insertAt, 0, ...block);
  if (next.every((t, i) => t === list.tracks[i])) return; // no-op drop
  applyCuration(next);
}

// Remove row `i` from the open list.
export function removeCuratedRow(i: number): void {
  const list = curatedList();
  if (!list || i < 0 || i >= list.tracks.length) return;
  const tracks = list.tracks.slice();
  tracks.splice(i, 1);
  applyCuration(tracks);
}

// Remove every selected row (by object identity, so duplicates and reorders
// resolve exactly) from the open list in a single curation edit.
export function removeCuratedTracks(objs: SearchTrack[]): void {
  const list = curatedList();
  if (!list || objs.length === 0) return;
  const drop = new Set(objs);
  const tracks = list.tracks.filter((t) => !drop.has(t));
  if (tracks.length === list.tracks.length) return;
  queueSel.clear();
  applyCuration(tracks);
}

// The row that should take the keyboard selection after `removed` is deleted from
// `list`, following the macOS convention: the row that slides up into the first
// deleted slot (the first survivor at or after it), or — if the tail was deleted —
// the last survivor before it. Null when the list is left empty. Keying on object
// identity, so non-contiguous multi-selections and duplicate paths resolve exactly.
export function fillRowAfterRemoval(
  list: SearchTrack[],
  removed: SearchTrack[],
): SearchTrack | null {
  const drop = new Set(removed);
  const firstIdx = list.findIndex((t) => drop.has(t));
  if (firstIdx === -1) return null;
  for (let i = firstIdx; i < list.length; i++) {
    if (!drop.has(list[i])) return list[i];
  }
  for (let i = firstIdx - 1; i >= 0; i--) {
    if (!drop.has(list[i])) return list[i];
  }
  return null;
}

// Insert tracks into the open list at `at` (drag-from-tree). Clamped to the list.
export function insertCuratedTracks(tracks: SearchTrack[], at: number): void {
  const list = curatedList();
  if (!list || tracks.length === 0) return;
  const next = list.tracks.slice();
  next.splice(Math.max(0, Math.min(at, next.length)), 0, ...tracks);
  applyCuration(next);
}

// Append tracks to the active pool when it's the target but *not* the visible
// list (a different playlist is browsed, so applyCuration would edit the wrong
// one). Mirrors applyCuration's pool path — update the signal, reconcile the
// engine when it's live, autosave the file — but aimed at the active pool
// regardless of what's browsed. The playing instance is captured from the old
// array and survives into `next` by reference, so reconcilePoolEdit re-finds it.
export function appendToActivePool(active: Queue, tracks: SearchTrack[]): void {
  const isPool = queueIsActivePool();
  const playingObj = isPool ? playingTrackObj(active) : null;
  const next = [...active.tracks, ...tracks];
  activeQueue.value = {
    ...active,
    tracks: next,
    subtitle: trackCountSubtitle(next),
  };
  if (isPool) reconcilePoolEdit(next, playingObj);
  if (active.sourcePath) void saveOpenPlaylist(active.sourcePath, active.title, next);
}

// Insert `tracks` into the active queue at view index `at`, reconciling the live
// engine pool (gapless tail / shuffle bag) when the queue is what's playing.
// Mirrors appendToActivePool but at a position — the insert behind "Play next",
// which drops the tracks right after the playing row. Aimed at the active queue
// regardless of what's browsed, so it never edits a merely-looked-at playlist.
export function insertIntoActiveQueueAt(tracks: SearchTrack[], at: number): void {
  const active = activeQueue.value;
  if (!active || tracks.length === 0) return;
  const isPool = queueIsActivePool();
  const playingObj = isPool ? playingTrackObj(active) : null;
  const next = active.tracks.slice();
  next.splice(Math.max(0, Math.min(at, next.length)), 0, ...tracks);
  // Bring the first inserted row into view on the coming re-render.
  app.pendingQueueScrollIndex = at;
  activeQueue.value = { ...active, tracks: next, subtitle: trackCountSubtitle(next) };
  if (isPool) reconcilePoolEdit(next, playingObj);
  if (active.sourcePath) void saveOpenPlaylist(active.sourcePath, active.title, next);
}
// --- Building the queue: Create queue / Play next / Add to queue ---
//
// The queue is explicit: it exists only once the user deliberately builds one, and
// holds only what they put in it (playing a folder track still auto-continues under
// the hood, but that never presents as a queue). Three verbs build and grow it, split
// by whether a *real* queue already exists (noRealQueue): with none, the sole gesture
// is "Create queue" — a fresh queue of exactly the selection, at rest (it does not
// auto-play; press play to start it from the top), dragging in nothing else. Once a
// queue exists, "Play next" inserts after the playing
// row and "Add to queue" appends to the tail; both are play-later, never interrupting
// the audible track. addToQueue and playNext both funnel the no-real-queue case
// through createQueue, so every caller — menus, keyboard, scripting — agrees.
//
// The visible queue and the engine's queue are kept in step: the engine plays a
// flat path list, while the frontend resolves per-track metadata (row highlight,
// now-playing on auto-advance) through currentParent.children — so appended
// tracks must land in both. currentParent.children is also the shuffle/repeat
// pool (poolPaths), so they join that too.

export function trackToNode(t: SearchTrack): TreeNode {
  return {
    path: t.path,
    name: t.path.split(/[\\/]/).pop() ?? t.path,
    title: t.title,
    artist: t.artist,
    album: t.album,
    albumArtist: null,
    disc: null,
    track: null,
    isFolder: false,
    loaded: true,
    expanded: false,
    children: [],
  };
}

export function nodeToTrack(n: TreeNode): SearchTrack {
  return {
    path: n.path,
    title: n.title,
    artist: n.artist,
    album: n.album,
    albumArtist: n.albumArtist,
    disc: n.disc,
    year: n.year,
    genre: n.genre,
    duration: n.duration,
    bitrate: n.bitrate,
    sampleRate: n.sampleRate,
    bitDepth: n.bitDepth,
    gain: n.gain,
    created: n.created,
    modified: n.modified,
    notDownloaded: n.notDownloaded,
  };
}

export function appendTracksToActiveQueue(tracks: SearchTrack[]): void {
  const q = activeQueue.value;
  if (!q || tracks.length === 0) return;
  const paths = tracks.map((t) => t.path);

  // Sync the engine only when the queue is the pool that's actually playing. A
  // stashed queue (a folder/stream/lone track is the pool) grows as data alone —
  // its tracks reach the engine only when the user later plays from the queue,
  // which rebuilds the pool from these same tracks (playQueueTrack).
  if (queueIsActivePool()) {
    // Grow the playback pool: onAdvance/siblingByPath and poolPaths read
    // currentParent.children, so appended tracks live there to resolve on
    // auto-advance and to join shuffle/repeat.
    if (app.currentParent) app.currentParent.children.push(...tracks.map(trackToNode));
    app.lastQueue = [...app.lastQueue, ...paths];

    if (app.queueEnded) {
      // The queue rests with no playhead — drained at its end, or armed from
      // silence by "Add to queue" without auto-playing. Appends grow the pool
      // (done above) but never start playback: "Add to queue" is play-later, so
      // the queue stays at rest and the play button starts it from the top.
    } else if (!shuffleMode.value && repeatMode.value !== "one" && autoadvanceEnabled()) {
      // Straight play with autoadvance on: the engine holds the whole queue and
      // auto-advances gaplessly, so append natively — the new tracks play on
      // uninterrupted. With autoadvance off the engine holds only the current
      // track; the appends stay pool-only (reachable by a manual skip) and never
      // enter the engine, so playback still stops at the current track's end.
      void engine.append(paths);
    } else if (shuffleMode.value) {
      // Shuffle hands the engine one track at a time (handleEnded picks the next
      // from the bag), so route the new tracks through the pending bag.
      app.shuffleBag.push(...shuffled(paths));
    }
    // repeat-one: nothing to enqueue now; the appended tracks joined the pool for
    // when repeat-one is turned off.
  }

  // Bring the first appended row into view on the coming re-render (else the
  // list would snap back to the playing row and hide the addition below the fold).
  app.pendingQueueScrollIndex = q.tracks.length;
  // Reassign to re-render the list + count.
  const combined = [...q.tracks, ...tracks];
  openActiveQueue({
    ...q,
    tracks: combined,
    subtitle: trackCountSubtitle(combined),
  });
}

// True when there's no *real* queue for the placement verbs to act on — either
// nothing is the pool, or the pool is a playlist (a playlist is never a queue). In
// this state the only queue gesture is to create one from scratch (createQueue).
function noRealQueue(): boolean {
  const q = activeQueue.value;
  return q == null || isPlaylistSource(q);
}

// The single entry point behind "Add to queue". It only ever appends —
// play-later, never interrupting the audible track. With a real queue it appends to
// its tail. With none (nothing playing, or a playlist as the pool — a playlist is
// never a queue) there is nothing to append to, so it defers to createQueue: a fresh
// queue of exactly these tracks, at rest (no auto-play). Routing the no-real-queue case
// here (rather than at each menu) keeps every caller — menus, keyboard, scripting —
// consistent with the "Create queue" gesture.
//
// Feedback is the queue itself: every add reveals the list face (showSourceList)
// so the appended rows are visible, rather than flashing a toast.
export function addToQueue(tracks: SearchTrack[]): void {
  if (tracks.length === 0) return;
  if (noRealQueue()) {
    createQueue(tracks);
    return;
  }
  // Every add reveals the list face, so a queued-behind panel would hide the
  // result — snap back to the pane.
  dismissRightPanel();
  appendTracksToActiveQueue(tracks);
  showSourceList();
}

// The single entry point behind "Play next". With a real queue it inserts the tracks
// right after the currently playing row so they sound as soon as the current track
// ends (with no playhead — a resting queue — at the top). With no real queue there's
// no "next" to speak of, so it defers to createQueue exactly as addToQueue does.
export function playNext(tracks: SearchTrack[]): void {
  if (tracks.length === 0) return;
  if (noRealQueue()) {
    createQueue(tracks);
    return;
  }
  dismissRightPanel();
  const q = activeQueue.value!;
  // Insert right after the playing row; with no playhead (queue at rest) at the top.
  const playing = queuePlayingIndex.value;
  const at = playing != null ? viewIndexOfPlayable(q.tracks, playing) + 1 : 0;
  // Shuffle advances from the bag, not list order, so front-load the bag to make
  // the inserts truly play next; reconcilePoolEdit keeps them (they join the new
  // pool). Straight play needs no bag work — reconcilePoolEdit rebuilds the gapless
  // tail from the new order, and the inserts now head it.
  if (queueIsActivePool() && shuffleMode.value && playing != null) {
    app.shuffleBag.unshift(...tracks.map((t) => t.path));
  }
  insertIntoActiveQueueAt(tracks, at);
  showSourceList();
}

// "Create queue": the sole no-queue menu gesture. Builds a fresh queue of exactly
// the selection and shows it *at rest* — it does NOT auto-play. Unlike addToQueue /
// playNext it never seeds from the currently playing track, nor detaches a playing
// playlist into the queue, so the new queue holds only what the user picked — no
// surprise row 1, no inherited playlist tail ("extra stuff").
//
// The queue is installed as a resting pool: the engine is silenced and holds no
// track, so nothing sounds until the user presses play — which restarts the queue
// from the top (the queueEnded branch of togglePlayPause), exactly as a queue
// drained at its end does. Whatever was playing is stopped (this queue is now the
// pool); a played playlist left behind is untouched on disk. Once the queue exists,
// the placement verbs (Play next / Add to queue) take over.
export function createQueue(tracks: SearchTrack[]): void {
  if (tracks.length === 0) return;
  dismissRightPanel();
  // The engine pool is playable rows only (missing files and stream rows stay in
  // the view but never reach the engine), mirroring playQueue.
  const playable = tracks.filter(isPlayableRow);
  if (playable.length === 0) return;
  const queue: Queue = {
    kind: "playlist",
    title: UNTITLED_PLAYLIST_TITLE,
    subtitle: trackCountSubtitle(tracks),
    tracks,
  };
  // Non-reactive playback vars first, so the reactive writes below fire their
  // effects against a fully installed context (as teardownPlaybackToEmpty does).
  // A synthetic `queue:` parent makes queueIsActivePool() true and seeds the engine
  // on the first play; queueEnded arms the resting-restart-from-top on that play.
  app.currentParent = syntheticParent(`queue:adhoc:${Date.now()}`, queue.title, playable);
  app.lastQueue = playable.map((t) => t.path);
  app.lastIndex = 0;
  app.pendingQueueIndex = null;
  app.pendingResume = null;
  resetShuffleState();
  app.queueEnded = true;
  openActiveQueue(queue);
  // A resting queue has no playhead: rows show, none highlighted, hero is empty.
  queuePlayingIndex.value = null;
  currentNodePath.value = null;
  currentStreamUrl.value = null;
  isStream.value = false;
  currentTime.value = 0;
  duration.value = 0;
  hasTrack.value = false;
  npTitle.value = "";
  npArtist.value = null;
  npAlbum.value = null;
  npAlbumArtist.value = null;
  clearArt();
  // Show the queue list (the point of Create queue), not the empty hero, and drop
  // any browse so the queue is what the list face reveals.
  browsedPlaylist.value = null;
  listFaceOpen.value = true;
  void engine.stop();
}

// The queue verbs for a right-click menu, adaptive to whether a *real* queue exists.
// "Play next" (insert after the playing row) and "Add to queue" (append) are only
// offered for an actual, ephemeral queue — the one pool that is itself a queue. Every
// other pool reads as the "no queue" case, where there's nothing to add *to* and the
// sole gesture is "Create queue", which builds a fresh queue from just the selection:
//   - No pool at all (a folder / single track / silence): no queue to place into.
//   - A *playlist* is the pool: a playlist is never a queue, so it's the no-queue
//     case too (noRealQueue) — one consistent, grokkable gesture. Once the queue
//     exists the two distinct verbs return.
// `run` is the call site's track plumbing: it resolves the target tracks (some sites
// query them lazily) and hands them to whichever terminal verb the chosen item picks
// — createQueue, playNext, or addToQueue. `count` (>1) pluralizes the labels.
export function queueMenuItems(
  run: (sink: (tracks: SearchTrack[]) => void) => void,
  count = 1,
): ContextMenuItem[] {
  if (noRealQueue()) {
    return [{ label: "Create queue", action: () => run(createQueue) }];
  }
  return [
    { label: count > 1 ? `Play ${count} next` : "Play next", action: () => run(playNext) },
    { label: count > 1 ? `Add ${count} to queue` : "Add to queue", action: () => run(addToQueue) },
  ];
}

// "Close queue": always dismisses the explicit queue, but is a list action, not a
// transport one. If a folder, stream, or lone track is playing (the queue merely
// stashed), Close drops the stash and leaves that playback untouched. When the
// queue is the audible pool, closing the list does NOT stop the music: the
// current track keeps playing, detached into a lone now-playing track (the tail
// is severed so it doesn't flow into the now-gone rest of the queue). Only a
// queue that has already drained — resting with no playhead — has nothing to keep
// playing, so closing it tears down to the empty hero.
export function closeQueue(): void {
  if (!queueIsActivePool()) {
    // A stashed queue that isn't the audible pool: closing just drops the list,
    // leaving whatever's playing untouched.
    clearActiveQueue();
    queuePlayingIndex.value = null;
    listFaceOpen.value = false;
    return;
  }

  const current = currentNodePath.value;
  if (current && !app.queueEnded) {
    // The queue is gone but its current track keeps playing — hand it back to
    // the file browser as its context. Drop the engine's gapless tail so the
    // vanished queue's rows don't play on; straight-play autoadvance resumes at
    // this track's end via handleEnded. The now-playing card and playback are
    // untouched.
    app.pendingQueueIndex = null;
    resetShuffleState();
    if (!shuffleMode.value && repeatMode.value !== "one") void engine.clearUpcoming();
    // If the track's home folder is loaded in the tree, rebind playback to it
    // so Next/Prev walk the album (its siblings) and autoadvance flows on — the
    // "final panel becomes the context" behavior. Otherwise (a search/external
    // track, or an unloaded folder) there's no context to return to, so it
    // detaches as a lone track: the pool is just this track and Next is a no-op.
    // This rebinds currentParent (non-reactive) *before* the reactive list-state
    // writes below, so the transport effect they fire recomputes Next/Prev's
    // enabled state against the rebound folder — poolPaths reads currentParent,
    // which no signal tracks, so the effect only sees it if it runs afterward.
    const home = app.rootNode ? findNode(app.rootNode, current) : null;
    if (home) {
      app.currentParent = home.parent;
      const pool = poolPaths();
      app.lastQueue = pool;
      app.lastIndex = Math.max(0, pool.indexOf(current));
    } else {
      app.currentParent = null;
      app.lastQueue = [current];
      app.lastIndex = 0;
    }
    clearActiveQueue();
    queuePlayingIndex.value = null;
    listFaceOpen.value = false;
    return;
  }

  // The queue already drained (rests with no playhead): nothing to keep playing,
  // so tear playback fully down (native Stop) and return to a clean empty hero.
  teardownPlaybackToEmpty();
}

// Full playback teardown (native Stop): silence the engine, drop the queue, and
// return to a clean empty hero with no playhead. Non-reactive playback vars go
// first so the reactive writes below fire their effects against a fully cleared
// context. Used by Close on a drained queue and by deleting the playing playlist.
export function teardownPlaybackToEmpty(): void {
  app.currentParent = null;
  app.queueEnded = false;
  app.lastQueue = [];
  app.lastIndex = 0;
  app.pendingQueueIndex = null;
  resetShuffleState();
  clearActiveQueue();
  queuePlayingIndex.value = null;
  listFaceOpen.value = false;
  currentNodePath.value = null;
  currentStreamUrl.value = null;
  isStream.value = false;
  currentTime.value = 0;
  duration.value = 0;
  hasTrack.value = false;
  npTitle.value = "";
  npArtist.value = null;
  npAlbum.value = null;
  npAlbumArtist.value = null;
  clearArt();
  void engine.stop();
}

// `sink` is the terminal verb — addToQueue (default) for "Add to queue", playNext
// for "Play next" — so both share the snapshot guard below.
export async function addFolderToQueue(
  folder: SearchFolder,
  sink: (tracks: SearchTrack[]) => void = addToQueue,
): Promise<void> {
  // Snapshot before the await; if queue or current track changes during the
  // scan the user navigated away — append to the wrong destination instead of
  // silently merging into whatever opened in the meantime.
  const queueBefore = activeQueue.value;
  const pathBefore = currentNodePath.value;
  try {
    const tracks = await invoke<SearchTrack[]>("folder_tracks", { path: folder.path });
    if (activeQueue.value !== queueBefore) return;
    if (!queueBefore && currentNodePath.value !== pathBefore) return;
    sink(tracks);
  } catch (e) {
    console.error("folder_tracks failed", folder.path, e);
  }
}
