// The right-pane list face + queue/playlist curation. renderQueue paints the
// list (queue or browsed playlist); the curation ops (reorder / remove / insert /
// append) funnel through applyCuration, which swaps the signal, reconciles the
// live engine pool, and autosaves playlist files. The "Add to queue" family
// (seed / arm / append / close / teardown) builds and dismantles the queue.

import { invoke } from "@tauri-apps/api/core";
import { h } from "./dom";
import type { Queue, SearchTrack, SearchFolder, TreeNode } from "./types";
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
  queuePlayingIndex,
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
} from "./state";
import {
  queueListEl,
  queueTitleEl,
  queueSubtitleEl,
  queueCloseBtn,
  queueRenameBtn,
} from "./dom-refs";
import { showContextMenu } from "./context-menu";
import { attachRowReorder } from "./drag-drop";
import { engine } from "./engine-glue";
import { editMetadataItem } from "./editors";
import { findNode } from "./library";
import {
  syntheticParent,
  refillShuffleBag,
  playSingle,
  playPool,
  poolPaths,
  shuffled,
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
  playQueue,
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

// Renders the list face. `isSource` is true when the list is the playing
// source (the queue, or a played playlist) and false when it's a playlist being
// browsed while something else plays — a browse carries no playing-row highlight
// and its rows *commit* (play the playlist) rather than jumping the pool.
export function renderQueue(queue: Queue | null, isSource: boolean): void {
  if (!queue) {
    queueListEl.innerHTML = "";
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

  // A browsed playlist isn't the pool, so nothing in it is "playing".
  const playing = isSource ? queuePlayingIndex.value : null;
  // A pending append target wins over the playing row for this render only, and
  // only when we're actually showing the queue it was appended to (a browsed
  // playlist has its own, unrelated rows).
  const scrollTo = isSource ? app.pendingQueueScrollIndex : null;
  app.pendingQueueScrollIndex = null;
  queueListEl.innerHTML = "";
  let activeRow: HTMLElement | null = null;
  let scrollRow: HTMLElement | null = null;
  // `playing` (queuePlayingIndex) indexes the *playable* pool, which excludes
  // missing rows; the view keeps them (marked, unplayable). Walk a parallel pool
  // index so the right row highlights and a click maps back to its pool position.
  let poolIdx = 0;
  queue.tracks.forEach((t, i) => {
    const rowPoolIdx = t.missing ? -1 : poolIdx;
    if (!t.missing) poolIdx++;
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
    // A missing playlist row is shown but can't be played: dim it, label it, and
    // skip the click handler so it reads as unavailable rather than dropped.
    const secondaryText = t.missing ? "Missing file" : (t.artist ?? t.album ?? "");
    const text = h(
      "span",
      { class: "queue-text" },
      h("span", {
        class: "queue-primary",
        text: t.title ?? (t.path.split(/[\\/]/).pop() ?? t.path),
      }),
      secondaryText && h("span", { class: "queue-secondary", text: secondaryText }),
    );
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
    // The view index, so the reactive selection effect can map its object-keyed
    // set back to rows without a unique path (duplicates share one).
    const li = h("li", { class: "queue-row", data: { rowIndex: i } }, num, text, remove);
    if (isPlaying) {
      li.classList.add("playing");
      activeRow = li;
    }
    // Multi-select background, reapplied on rebuild like .playing (the list
    // selection effect keeps it live between rebuilds).
    if (!t.missing && queueSel.signal.peek().has(t)) li.classList.add("selected");
    if (i === scrollTo) scrollRow = li;
    if (t.missing) {
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
      // Hover play button in the gutter, mirroring the tree's track rows. Swallows
      // the click so the row's select-on-click doesn't also fire.
      num.appendChild(
        h("button", {
          class: "row-play",
          attrs: { type: "button", "aria-label": "Play" },
          on: {
            click: (e) => {
              e.stopPropagation();
              playRow();
            },
          },
        }),
      );
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
    // Right-click a playable row to queue it, add it to a playlist, or (multi)
    // remove it (a missing row has no real file to copy, so it's skipped).
    // "Add to queue" leads, matching the tree track/folder menus.
    if (!t.missing) {
      li.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        // Finder-style: right-clicking a row outside the selection makes it the
        // selection; inside a multi-selection it's kept. The verbs act on it.
        if (!queueSel.signal.peek().has(t)) queueSel.single(t);
        const sel = selectedListTracks();
        if (sel.length > 1) {
          showContextMenu(e.clientX, e.clientY, [
            { label: `Add ${sel.length} to queue`, action: () => addToQueue(sel) },
            addToPlaylistItem(() => sel),
            {
              label: `Remove ${sel.length} from list`,
              action: () => removeCuratedTracks(sel),
            },
          ]);
        } else {
          showContextMenu(e.clientX, e.clientY, [
            { label: "Add to queue", action: () => addToQueue([t]) },
            addToPlaylistItem(() => [t]),
            editMetadataItem(t.path),
          ]);
        }
      });
    }
    attachRowReorder(li, t);
    queueListEl.appendChild(li);
  });
  const target = (scrollRow ?? activeRow) as HTMLElement | null;
  if (target) target.scrollIntoView({ block: "nearest" });
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

// Map a playable-pool index (queuePlayingIndex, which excludes missing rows) back
// to its index in the full view array. Inverse of renderQueue's poolIdx walk.
export function viewIndexOfPlayable(tracks: SearchTrack[], playableIdx: number): number {
  let p = 0;
  for (let i = 0; i < tracks.length; i++) {
    if (tracks[i].missing) continue;
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

// Persist the open playlist after an edit. Every row is written (missing included)
// so the file round-trips; paths only — metadata is re-resolved from the DB on read.
export async function saveOpenPlaylist(path: string, name: string, tracks: SearchTrack[]): Promise<void> {
  try {
    await invoke("write_playlist", { path, name, tracks: tracks.map((t) => t.path) });
  } catch (e) {
    console.error("write_playlist (autosave) failed", path, e);
    toast("Couldn't save playlist");
  }
}

// Apply a new view-array to the open list: swap the signal, reconcile playback when
// it's the live pool, and autosave when it's a playlist file.
export function applyCuration(newTracks: SearchTrack[]): void {
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
  const playable = newTracks.filter((t) => !t.missing);
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
      // Drop any removed paths from the pending bag (dup-lossy, acceptable).
      app.shuffleBag = app.shuffleBag.filter((p) => poolPathsNew.includes(p));
    } else if (repeatMode.value !== "one" && autoadvanceEnabled()) {
      // Rebuild the gapless tail: drop the stale upcoming tracks, then re-append
      // the new order. Chained so the append can't race ahead of the clear.
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
  app.shuffleBag = [];
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
// --- Add to queue ---
//
// The queue is explicit: it exists only once the user deliberately builds one,
// and holds only what they put in it (playing a folder track still auto-continues
// under the hood, but that never presents as a queue). There are exactly two
// verbs: "Play X" (folder/album/artist) replaces and plays now, while
// "Add to queue" only ever appends — play-later, never interrupting the audible
// track. That symmetry is why a track has no "Play" menu item of its own (a
// left-click already plays it) and no "start queue" verb: the sole way to build
// an explicit queue by hand is to Add to queue.
//
// Adding when no queue exists yet: if a track is playing (implicit folder
// continuation), seed a queue from just that one track — the song the user can
// already hear, so row 1 is never a surprise — and append after it, severing the
// folder tail so only explicitly-queued tracks follow (seedQueueFromCurrent). If
// nothing is playing, the append starts a fresh queue that plays at once.
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
  return { path: n.path, title: n.title, artist: n.artist, album: n.album };
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

// Promotes the track currently playing (via implicit folder continuation) into a
// one-row explicit queue, so a following append has a coherent row 1 and playback
// continues uninterrupted. Only the audible track is captured — never the rest of
// the folder — and the folder tail is severed (clearUpcoming) so nothing but the
// explicit queue follows it. Metadata comes from the playing node when we can
// find it, else the now-playing signals.
export function seedQueueFromCurrent(): void {
  const path = currentNodePath.value;
  if (!path) return;
  const cur = app.currentParent?.children.find((c) => c.path === path);
  const track: SearchTrack = cur
    ? nodeToTrack(cur)
    : { path, title: npTitle.value || null, artist: npArtist.value, album: npAlbum.value };
  const title = UNTITLED_PLAYLIST_TITLE;
  app.currentParent = syntheticParent(`queue:current:${Date.now()}`, title, [track]);
  app.lastQueue = [path];
  app.lastIndex = 0;
  // The audible track is now the queue's row 0 and keeps playing (no new engine
  // play fires here), so highlight it directly rather than waiting on onAdvance.
  queuePlayingIndex.value = 0;
  app.shuffleBag = [];
  // Straight play holds the whole folder in the engine for gapless auto-advance;
  // drop that tail so the current track is the queue's last entry until the
  // append extends it. (Per-track modes already hold only the current track.)
  if (!shuffleMode.value && repeatMode.value !== "one") void engine.clearUpcoming();
  openActiveQueue({
    kind: "playlist",
    title,
    subtitle: trackCountSubtitle([track]),
    tracks: [track],
  });
}

// Build a queue from `tracks` as the active pool but at rest — no playhead, the
// engine untouched — so "Add to queue" from silence keeps its play-later promise
// instead of startling the user with playback. The queue rests exactly as a
// drained one does (queueEnded set, currentNodePath/queuePlayingIndex null), so
// the play button starts it from the top (see togglePlayPause).
export function armQueueAtRest(tracks: SearchTrack[]): void {
  const playable = tracks.filter((t) => !t.missing);
  if (playable.length === 0) return;
  app.currentParent = syntheticParent(
    `queue:adhoc:${Date.now()}`,
    UNTITLED_PLAYLIST_TITLE,
    playable,
  );
  app.lastQueue = playable.map((t) => t.path);
  app.lastIndex = 0;
  app.queueEnded = true;
  queuePlayingIndex.value = null;
  currentNodePath.value = null;
  app.shuffleBag = [];
  browsedPlaylist.value = null;
  openActiveQueue({
    kind: "playlist",
    title: UNTITLED_PLAYLIST_TITLE,
    subtitle: trackCountSubtitle(tracks),
    tracks,
  });
  listFaceOpen.value = true;
}

// The single entry point behind "Add to queue". It only ever appends —
// play-later, never interrupting the audible track. With a queue open it appends
// to it. With none, it seeds a queue from the currently playing track first
// (seedQueueFromCurrent) and appends after it; from silence it arms a fresh queue
// at rest (armQueueAtRest) without playing, so the play button — not the add —
// starts it. A live stream is the one exception: nothing can follow it, so the
// add starts the queue now.
//
// Feedback is the queue itself: every add reveals the list face (showSourceList)
// so the appended rows are visible, rather than flashing a toast.
export function addToQueue(tracks: SearchTrack[]): void {
  if (tracks.length === 0) return;
  // Every add reveals the list face, so a queued-behind panel would hide the
  // result — snap back to the pane.
  dismissRightPanel();
  if (!activeQueue.value) {
    if (hasTrack.value && currentNodePath.value && !isStream.value) {
      seedQueueFromCurrent();
    } else if (!hasTrack.value) {
      // True silence: honor "Add to queue" as play-later by arming the queue at
      // rest rather than playing it now. It becomes the active pool with no
      // playhead (like a drained queue); the play button starts it from the top.
      armQueueAtRest(tracks);
      return;
    } else {
      // A live stream (or a lone track with no queueable context) is playing:
      // there's nothing for the queue to follow, so this add starts it now.
      playQueue(
        {
          kind: "playlist",
          title: UNTITLED_PLAYLIST_TITLE,
          subtitle: trackCountSubtitle(tracks),
          tracks,
        },
        `queue:adhoc:${Date.now()}`,
      );
      return;
    }
  }
  // "Add to queue" is a queue verb, never a playlist edit: if the active pool is a
  // playing playlist, adding to the queue detaches the pool from its .m3u8 first —
  // this append and every later curation then stay in memory and the file on disk
  // is left as it was. The queue and a playlist are never the same thing.
  detachActivePoolFromPlaylist();
  appendTracksToActiveQueue(tracks);
  showSourceList();
}

// Sever the active pool from its backing playlist file so queue operations can't
// modify it: it becomes a plain, ephemeral "Queue" (no sourcePath) holding the
// same tracks. isPlaylistSource keys off sourcePath alone, so dropping it turns
// off autosave, drops the tree's playing-playlist highlight, and retitles the
// list/hero to "Queue" — all reactively. The engine, playing index, currentParent,
// and the track objects are untouched (same synthetic pool, same rows), so
// playback continues uninterrupted. A no-op unless the pool is a playlist source.
export function detachActivePoolFromPlaylist(): void {
  const q = activeQueue.value;
  if (!isPlaylistSource(q)) return;
  activeQueue.value = {
    kind: q!.kind,
    title: "Queue",
    subtitle: q!.subtitle,
    tracks: q!.tracks,
    // sourcePath deliberately omitted — a queue is never a playlist file.
  };
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
    app.shuffleBag = [];
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
  app.shuffleBag = [];
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
  clearArt();
  void engine.stop();
}

export async function addFolderToQueue(folder: SearchFolder): Promise<void> {
  // Snapshot before the await; if queue or current track changes during the
  // scan the user navigated away — append to the wrong destination instead of
  // silently merging into whatever opened in the meantime.
  const queueBefore = activeQueue.value;
  const pathBefore = currentNodePath.value;
  try {
    const tracks = await invoke<SearchTrack[]>("folder_tracks", { path: folder.path });
    if (activeQueue.value !== queueBefore) return;
    if (!queueBefore && currentNodePath.value !== pathBefore) return;
    addToQueue(tracks);
  } catch (e) {
    console.error("folder_tracks failed", folder.path, e);
  }
}
