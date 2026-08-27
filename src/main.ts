import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  getCurrentWindow,
  LogicalSize,
  PhysicalPosition,
} from "@tauri-apps/api/window";
import { load } from "@tauri-apps/plugin-store";
import { confirm, open, save } from "@tauri-apps/plugin-dialog";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { signal, computed, effect } from "@preact/signals-core";
import { engine } from "./engine-glue";
import { h } from "./dom";
import { maybeStartE2eBridge } from "./e2e-bridge";
import { initLibraryNav, popNavToRoot, refreshNavPlaylists, renderNav, type NavStep } from "./library-nav";
import type {
  TrackMeta,
  TreeNode,
  Stream,
  SearchTrack,
  SearchFolder,
  SearchArtist,
  SearchAlbum,
  SearchItem,
  Queue,
  ScanResult,
  RepeatMode,
  TrackSelection,
  ContextMenuItem,
  NavState,
  PaneView,
  PlaylistData,
  RecentPlaylist,
  PlaylistRef,
  TrackProvider,
  LeafListContext,
} from "./types";
import {
  hasTrack,
  npTitle,
  npArtist,
  npAlbum,
  npArt,
  npStreamMeta,
  isStream,
  isPlaying,
  currentTime,
  duration,
  volume,
  volumePopoverOpen,
  currentNodePath,
  currentStreamUrl,
  selectedStreamUrl,
  settingsOpen,
  activeTab,
  activeQueue,
  browsedPlaylist,
  listFaceOpen,
  queuePlayingIndex,
  shuffleMode,
  repeatMode,
  autoadvance,
  libraryRootSet,
  streamListPathValid,
  streamListPathSet,
  streamListWritable,
  libraryHasContent,
  treeSelection,
  paneEditor,
  openActiveQueue,
  clearActiveQueue,
  isPlaylistSource,
  openPlaylistPath,
  showListFace,
  showHeroFace,
  showSourceList,
  resetToLonePlayback,
  autoadvanceEnabled,
} from "./state";
import {
  bindDom,
  nowPlayingTitleEl,
  nowPlayingTitleInner,
  nowPlayingArtistEl,
  nowPlayingArtistInner,
  nowPlayingAlbumEl,
  nowPlayingAlbumInner,
  navBarTextEl,
  navBarBtnEl,
  navBarAltBtnEl,
  nowPlayingStreamMetaEl,
  streamMetaSongEl,
  streamMetaSongInner,
  streamMetaArtistEl,
  streamMetaArtistInner,
  liveIndicatorEl,
  nowPlayingArtEl,
  nowPlayingEmptyEl,
  playPauseBtn,
  prevBtn,
  nextBtn,
  seekBar,
  timeCurrentEl,
  timeRemainingEl,
  volumeControlEl,
  volumeBtn,
  volumePopover,
  volumeBar,
  streamsContainer,
  libraryRootAddBtn,
  streamListPathInput,
  streamListPathBrowseBtn,
  miniplayerBtn,
  settingsBackBtn,
  playbackModesEl,
  modeShuffleBtn,
  modeRepeatBtn,
  searchEl,
  nowPlayingPanel,
  settingsPanel,
  splitterEl,
  queueTitleEl,
  queueSubtitleEl,
  queueListEl,
  queueCloseBtn,
  queueRenameBtn,
  toastEl,
} from "./dom-refs";
import { showContextMenu } from "./context-menu";
import { startTrackDrag, attachRowReorder } from "./drag-drop";
import { setupSearch } from "./search";
import {
  refreshTree,
  findNode,
  refreshLibrary,
  setLibraryRoots,
  renderLibraryRootRows,
  setStreamListPath,
  browseLibraryRoot,
  browseStreamListPath,
  refreshStreams,
} from "./library";
import {
  fetchChildren,
  playSelectedRow,
} from "./tree-view";
import {
  closePaneEditor,
  editMetadataItem,
  editInline,
  startTitleEdit,
} from "./editors";
import { openAddStationEditor } from "./streams-view";
import { app } from "./state";

const STORE_FILE = "settings.json";
export const KEY_LIBRARY_ROOTS = "libraryRoots";
// Value stays "manifestPath" (the pre-rename key) so existing saved settings survive.
export const KEY_STREAM_LIST_PATH = "manifestPath";
const KEY_SPLITTER_WIDTH = "splitterWidth";
const KEY_VOLUME = "volume";
// Window size is remembered per layout mode so the double-click toggle can
// restore the size you last used in the *other* mode.
const KEY_WINDOW_SIZE_NORMAL = "windowSizeNormal";
const KEY_WINDOW_SIZE_MINI = "windowSizeMini";
const KEY_WINDOW_POSITION = "windowPosition";
// Autoadvance: one global preference (does playback flow track-to-track, or stop
// after each?). Lives in the OS Playback menu, not the app UI. Was once split by
// context (file tree vs. playlists), but that context turned into six library
// lenses + playlists; a single global toggle keeps the behavior predictable
// without any "which context am I in?" reasoning. KEY_AUTOADVANCE_FILES is read
// once at load to migrate the old browsing setting; the new key supersedes both.
const KEY_AUTOADVANCE = "autoadvance";
const KEY_AUTOADVANCE_FILES = "autoadvanceFiles"; // legacy, migrated on load
// Playback modes remembered across launches, like every mainstream player.
const KEY_SHUFFLE = "shuffleMode";
const KEY_REPEAT = "repeatMode";

// Recently opened playlists for the OS "Open Recent ▸" submenu (most-recent
// first, capped). Persisted so the list survives restarts.
const KEY_RECENT_PLAYLISTS = "recentPlaylists";
const RECENT_PLAYLISTS_MAX = 10;

// The user's last place in the Files-tab navigator (the serialized drill stack),
// restored on launch so browse/songs/artists/albums drill-downs survive a restart.
const KEY_NAV_LOCATION = "navLocation";

// The open sidebar tab (Files/Streams), restored on launch so a Streams-focused
// user isn't bounced back to Files every start.
const KEY_ACTIVE_TAB = "activeTab";

// Below this logical (CSS-px) height the layout collapses to the mini player.
// Mirrors the `max-height` breakpoint in styles.css — keep the two in sync.
const MINI_MAX_HEIGHT = 480;
const DEFAULT_NORMAL_SIZE = { width: 800, height: 600 };
const DEFAULT_MINI_SIZE = { width: 367, height: 168 };



// Header for a queue the user builds by hand (Add to queue), as opposed to one
// opened from a fixed source (Play artist/album/folder). Deliberately NOT named
// after any track: the contents change as more are added, so a track-derived
// title would drift. Placeholder framing ("Untitled") anticipates saving it as a
// named playlist later.
const UNTITLED_PLAYLIST_TITLE = "Untitled";

// Human runtime for a queue/playlist total. Rounds to whole minutes past a
// minute ("1 hr 32 min", "47 min"); a sub-minute total (a single short track)
// shows seconds so it isn't misreported as "0 min".
function formatRuntime(seconds: number): string {
  const total = Math.round(seconds);
  if (total < 60) return `${total} sec`;
  const mins = Math.round(total / 60);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h} hr` : `${h} hr ${m} min`;
}

// The subtitle under a queue/playlist header: the track count, plus the summed
// runtime when durations are known ("24 tracks, 1 hr 32 min"). The runtime is
// omitted entirely if no row carries a duration (e.g. an all-out-of-library
// playlist), so the count never sits beside a bogus "0 min".
function trackCountSubtitle(tracks: SearchTrack[]): string {
  const n = tracks.length;
  const count = `${n} track${n === 1 ? "" : "s"}`;
  let secs = 0;
  for (const t of tracks) if (t.duration) secs += t.duration;
  return secs > 0 ? `${count}, ${formatRuntime(secs)}` : count;
}



// A queue is the engine's active pool iff currentParent is one of the synthetic
// `queue:` parents (real folders are filesystem paths). Distinguishes "the queue
// is playing / rests at its end" from "a queue is merely stashed while a folder,
// stream, or lone track plays".
export function queueIsActivePool(): boolean {
  return app.currentParent?.path.startsWith("queue:") ?? false;
}


// --- Helpers ---

export function displayLabel(node: TreeNode): string {
  if (node.isFolder) return node.name;
  if (node.title) {
    return node.artist ? `${node.artist} - ${node.title}` : node.title;
  }
  return node.name;
}

export function joinPath(parent: string, child: string): string {
  return parent.endsWith("/") ? parent + child : parent + "/" + child;
}

export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number): (...args: A) => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (...args: A) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

function formatTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) seconds = 0;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function isTextInputTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.tagName === "TEXTAREA" || target.isContentEditable) return true;
  if (target instanceof HTMLInputElement) {
    const type = target.type.toLowerCase();
    return type === "text" || type === "search" || type === "url" ||
      type === "email" || type === "password" || type === "tel" || type === "number";
  }
  return false;
}

export function setEmpty(container: HTMLElement, message: string, kind: "empty" | "loading" = "empty"): void {
  container.innerHTML = "";
  container.appendChild(
    h("div", {
      class: kind === "loading" ? "loading-state" : "empty-state",
      text: message,
    }),
  );
}

// --- Module state (non-reactive) ---


// The configured library folders (source of truth). The tree is built from
// these: one root shows its contents at top level; two or more each show as a
// top-level folder under a synthetic virtual rootNode (see refreshTree). Edited
// by the Settings library-roots rows.

// Library folders whose list_dir failed (missing / unreadable). Their Settings
// rows show the .invalid outline. Recomputed by refreshTree; read by
// renderLibraryRootRows. Not reactive — refreshTree re-renders the rows itself.

// The configured library folders, as an array. rootNode.path is a per-node
// concept (empty for the virtual root), so anything that means "the library
// root(s)" — playlist scanning, default save dir, search context — reads this.
export function libraryRootPaths(): string[] {
  return app.libraryRoots;
}

// --- File-tree multi-select ---
//
// A set of selected *track* paths (files only — folders and playlists are
// sources, not selectable rows). Cmd/Ctrl-click toggles a track; Shift-click
// extends a contiguous range from the anchor over the visible track order; a
// plain click plays and drops the selection down to a bare (unhighlighted)
// anchor. So the highlight only ever shows a *deliberate* selection: a size-1
// set exists solely as the anchor and does nothing the click itself didn't, so
// it isn't drawn. The track context-menu verbs (Add to queue / Add to playlist)
// act on the whole selection when non-empty. Reactive so a `.selected` row
// highlight tracks it (see the selection effect and renderNode).
// The pivot a Shift-click ranges from — the last track any click touched
// (including a plain play-click, so click A then Shift-click B selects A..B).

// Track nodes in render order. `visibleOnly` descends into expanded folders alone
// (matching what renderNode paints) for Shift-range selection; false walks every
// loaded folder so a selection survives a folder collapse. Folders and playlists
// are skipped — only files are selectable.
function collectTrackNodes(visibleOnly: boolean): TreeNode[] {
  const out: TreeNode[] = [];
  const walk = (node: TreeNode): void => {
    for (const child of node.children) {
      if (child.isFolder) {
        if (child.loaded && (child.expanded || !visibleOnly)) walk(child);
      } else if (!child.isPlaylist) {
        out.push(child);
      }
    }
  };
  if (app.rootNode) walk(app.rootNode);
  return out;
}

// The current selection resolved to tracks, in tree order (hidden-but-selected
// rows under a collapsed folder included). What the context-menu verbs act on.
export function selectedTracks(): SearchTrack[] {
  const sel = treeSelection.value;
  if (sel.size === 0) return [];
  return collectTrackNodes(false)
    .filter((n) => sel.has(n.path))
    .map(nodeToTrack);
}

function clearTreeSelection(): void {
  app.selectionAnchor = null;
  if (treeSelection.peek().size === 0) return;
  treeSelection.value = new Set();
}

// Drop the row (queue/navigator) selections so the tree is the only highlighted
// surface — the tree's half of the one-selection-at-a-time rule the row panes keep
// among themselves (see queueSel / navSel). Called by every tree selecting action.
function clearRowSelections(): void {
  queueSel.clear();
  navSel.clear();
}

// Plain click: select just this row and anchor a following Shift-range here.
// Replaces any prior multi-select with the single clicked track.
export function selectTreeSingle(path: string): void {
  clearRowSelections();
  treeSelection.value = new Set([path]);
  app.selectionAnchor = path;
}

// Cmd/Ctrl-click: add or remove one track, and re-anchor the range here.
export function toggleTreeSelection(path: string): void {
  clearRowSelections();
  const next = new Set(treeSelection.peek());
  if (next.has(path)) next.delete(path);
  else next.add(path);
  treeSelection.value = next;
  app.selectionAnchor = path;
}

// Shift-click: replace the selection with the contiguous range from the anchor to
// `path` over the visible track order. With no live anchor, this click becomes it.
// Shift-clicking a track that's already selected deselects just it, so a range can
// be trimmed a track at a time.
export function selectTreeRangeTo(path: string): void {
  clearRowSelections();
  const sel = treeSelection.peek();
  if (sel.has(path)) {
    const next = new Set(sel);
    next.delete(path);
    treeSelection.value = next;
    app.selectionAnchor = path;
    return;
  }
  const order = collectTrackNodes(true).map((n) => n.path);
  const to = order.indexOf(path);
  if (to === -1) return;
  const anchor =
    app.selectionAnchor && order.includes(app.selectionAnchor) ? app.selectionAnchor : path;
  app.selectionAnchor = anchor;
  const from = order.indexOf(anchor);
  const [lo, hi] = from <= to ? [from, to] : [to, from];
  treeSelection.value = new Set(order.slice(lo, hi + 1));
}


// `onSelect` fires just before any selecting action (single / toggle / range) —
// but not clear or resolve — so a pane can drop the *other* panes' selections and
// keep the highlight on one surface at a time (see the queueSel / navSel wiring).
function makeTrackSelection(onSelect: () => void = () => {}): TrackSelection {
  const sel = signal<Set<SearchTrack>>(new Set());
  let anchor: SearchTrack | null = null;
  return {
    signal: sel,
    anchor: () => anchor,
    resolveIn(tracks) {
      const s = sel.value;
      if (s.size === 0) return [];
      return tracks.filter((t) => s.has(t) && !t.missing);
    },
    clear() {
      anchor = null;
      if (sel.peek().size === 0) return;
      sel.value = new Set();
    },
    single(t) {
      onSelect();
      sel.value = new Set([t]);
      anchor = t;
    },
    toggle(t) {
      onSelect();
      const next = new Set(sel.peek());
      if (next.has(t)) next.delete(t);
      else next.add(t);
      sel.value = next;
      anchor = t;
    },
    rangeTo(t, tracks) {
      onSelect();
      const s = sel.peek();
      if (s.has(t)) {
        const next = new Set(s);
        next.delete(t);
        sel.value = next;
        anchor = t;
        return;
      }
      const to = tracks.indexOf(t);
      if (to === -1) return;
      const a = anchor && tracks.includes(anchor) ? anchor : t;
      anchor = a;
      const from = tracks.indexOf(a);
      const [lo, hi] = from <= to ? [from, to] : [to, from];
      const next = new Set<SearchTrack>();
      for (let i = lo; i <= hi; i++) if (!tracks[i].missing) next.add(tracks[i]);
      sel.value = next;
    },
  };
}

// The right-pane queue/browsed-playlist selection and the Files-tab navigator's
// leaf-list (Songs, …) selection — separate Sets so they never mirror each other
// (a queued track is the same object as its Songs row), but mutually exclusive:
// selecting in one drops the other's (and the tree's) highlight, so exactly one
// surface is ever selected. The forward refs resolve at call time (both consts
// exist before any click fires). clearTreeSelection covers the third surface.
export const queueSel: TrackSelection = makeTrackSelection(() => {
  navSel.clear();
  clearTreeSelection();
});
const navSel: TrackSelection = makeTrackSelection(() => {
  queueSel.clear();
  clearTreeSelection();
});

// The pane whose selection a keyboard Enter should play — set by the click that
// last touched a selection in the tree, the list, or the streams pane. Enter is a
// commit for the same row a click now merely selects, so it needs to know which
// of the (independently selectable) panes the user last acted in.

function openListTracks(): SearchTrack[] {
  return (browsedPlaylist.value ?? activeQueue.value)?.tracks ?? [];
}

// The queue selection resolved to rows still in the open queue/playlist list.
export function selectedListTracks(): SearchTrack[] {
  return queueSel.resolveIn(openListTracks());
}
// Last stream list streams loaded by refreshStreams, kept so search can filter
// them without re-reading the stream list on every keystroke.
// Stream list name of the currently playing stream, shown as the now-playing
// station line. Kept separately from currentStreamUrl because ICY metadata
// events re-render the now-playing panel after the fact.
// Album-folder context for the currently playing track. Held so an
// auto-advance event from the engine can look up the matching TreeNode (for
// the row highlight + now-playing UI) via siblingByPath. Null while playing
// a stream, a search hit, or an external file — those have no album context.
// Last queue + index handed to the engine. Held so play-after-queue-ended
// restarts from the same track the user last heard (the existing UX: hit play
// after the album finishes → resume from the last track).
// The queue-row index the *next* engine play should land on, consumed by the
// following onAdvance to set queuePlayingIndex. Set right before every play that
// starts or jumps within the queue pool; left null for gapless auto-advance,
// which onAdvance treats as "the next row down" (so duplicate rows are tracked
// positionally, matching the engine's sequential advance).
// True once the engine has played through the queue's last track. Cleared on
// the next Play (file selection, seek, or restart-from-end via play button).

// Upcoming tracks for shuffle playback: a shuffled permutation of the album
// pool, consumed one entry per queue-ended. Draining it to empty means the
// shuffle cycle is done (stop when repeat is off, reshuffle when repeat all).
// Filled when shuffle turns on or a shuffled album starts; cleared for straight
// play so a stale order can't leak into the next album.

// Some stations relay scraped playlists and broadcast titles that were never
// cleaned for ICY: HTML entities still encoded ("&#23665;" for 山) and the
// whole string wrapped in the source's quoting ("'Artist - Song'"). Decoded
// by hand rather than via DOMParser/innerHTML so a literal "<" in a title
// can't be eaten as a tag. Unknown entities pass through unchanged.
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

export function cleanStreamText(raw: string): string {
  let s = raw.replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, body) => {
    if (body.startsWith("#")) {
      const hex = body[1] === "x" || body[1] === "X";
      const cp = parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? m;
  });
  s = s.trim();
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

// Library-file lookup for the engine's track-changed events. Auto-advance
// stays within the current album folder, so currentParent's children are the
// universe; external/streamed playback has no parent and never advances.
export function siblingByPath(path: string): TreeNode | null {
  if (!app.currentParent) return null;
  return (
    app.currentParent.children.find((c) => !c.isFolder && c.path === path) ?? null
  );
}

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

// "<artist> – <title>" for the current track (title alone when the artist is
// unknown), used as the nav bar's playing context.
function nowPlayingLabel(): string {
  let t = npTitle.value;
  let a = npArtist.value;
  // Radio: once the station sends ICY metadata, name the current song/artist
  // rather than the bare station name, falling back to the station on the title
  // line. Mirrors pushNowPlayingMeta so the nav bar and OS widget agree.
  if (isStream.value && npStreamMeta.value) {
    t = npStreamMeta.value.song;
    a = npStreamMeta.value.artist ?? npTitle.value;
  }
  return a ? `${a} – ${t}` : t;
}

// The next track in straight-play order as "<artist> – <title>", or null when
// it can't be named (shuffle is nondeterministic; repeat-one loops in place —
// both handled by the caller). Under repeat-all the last track wraps to the
// first. Best-effort — it feeds the hero-face "Up Next" hint, not playback.
function upNextLabel(): string | null {
  if (shuffleMode.value || repeatMode.value === "one") return null;
  const pool = poolPaths();
  const curIdx = queueIsActivePool() && queuePlayingIndex.value != null
    ? queuePlayingIndex.value
    : pool.indexOf(currentNodePath.value ?? "");
  let nextIdx = curIdx + 1;
  if (nextIdx >= pool.length) {
    if (repeatMode.value !== "all") return null; // genuine end
    nextIdx = 0; // wrap
  }
  const nextPath = pool[nextIdx];
  if (curIdx < 0 || !nextPath) return null;
  const t = (activeQueue.value?.tracks ?? []).find((x) => x.path === nextPath)
    ?? app.currentParent?.children.find((c) => c.path === nextPath);
  if (!t) return null;
  const title = t.title ?? (nextPath.split(/[\\/]/).pop() ?? nextPath);
  return t.artist ? `${t.artist} – ${title}` : title;
}


export const paneView = computed<PaneView>(() => {
  const browsed = browsedPlaylist.value;
  const list = browsed ?? activeQueue.value;
  const isSource = browsed === null;
  const showList = listFaceOpen.value;
  if (!list) return { list: null, isSource, showList: false, nav: null };

  let nav: NavState;
  if (showList) {
    if (hasTrack.value) {
      // A queue that ran to its end rests as the pool with no playing row — that's
      // "End of queue" (no track to name). (queuePlayingIndex is the reactive tell:
      // set while a row plays/pauses, null once the queue drains.)
      const drained = queueIsActivePool() && queuePlayingIndex.value === null;
      // Browsing a playlist while a *different* source plays: offer a jump
      // straight to that source's list alongside the hero flip. Suppressed when
      // the browsed playlist is itself the playing source (same file) — that
      // button would just point back at the list you're already viewing.
      const active = activeQueue.value;
      const source =
        browsed !== null && active && active.sourcePath !== browsed.sourcePath
          ? active
          : null;
      nav = {
        // Keep naming the current track even while paused — the transport
        // controls already show the paused state, so the useful thing to show
        // is *what* is paused. Only a drained queue has no track to name.
        text: drained ? "End of queue" : nowPlayingLabel(),
        button: "Now Playing",
        altButton: source
          ? isPlaylistSource(source)
            ? "Show Playlist"
            : "Show Queue"
          : null,
      };
    } else {
      // Browsing a list with nothing playing: no source to name, nowhere to flip
      // to. The bar has no job, so drop it entirely (null nav hides .has-nav) —
      // the list face still owns the pane.
      return { list, isSource, showList, nav: null };
    }
  } else {
    const sourceName = isPlaylistSource(list) ? list.title : "Queue";
    const button = isPlaylistSource(list) ? "Show Playlist" : "Show Queue";
    // Describe what's coming. Shuffle and repeat-one have no single "next track"
    // to name — say what mode is running over the source instead. Otherwise name
    // the next track (repeat-all wraps), and only a genuine end reads "End of
    // queue" — or "End of playlist" when the source is a playlist, which is not a
    // queue.
    let text: string;
    if (!hasTrack.value || (!hasNextTrack() && repeatMode.value !== "one")) {
      text = isPlaylistSource(list) ? "End of playlist" : "End of queue";
    } else if (shuffleMode.value) {
      text = `Shuffling ${sourceName}`;
    } else if (repeatMode.value === "one") {
      text = "Repeating this track";
    } else {
      const next = upNextLabel();
      text = next ? `Up Next: ${next}` : "Up Next";
    }
    nav = { text, button, altButton: null };
  }
  return { list, isSource, showList, nav };
});

// Paint the nav bar from the derived view. Nothing to reconcile: text and button
// are already resolved in paneView.
function renderNavBar(): void {
  const nav = paneView.value.nav;
  if (!nav) return; // no list → nav hidden via .has-nav
  navBarTextEl.textContent = nav.text;
  navBarBtnEl.textContent = nav.button ?? "";
  navBarBtnEl.classList.toggle("hidden", nav.button === null);
  navBarAltBtnEl.textContent = nav.altButton ?? "";
  navBarAltBtnEl.classList.toggle("hidden", nav.altButton === null);
}

// The nav bar's face-swap button: to the hero from the list, to the list from
// the hero.
function toggleNavFace(): void {
  if (listFaceOpen.value) showHeroFace();
  else showListFace();
}

// --- Playback ---

export function setNowPlaying(
  title: string,
  artist: string | null,
  album: string | null,
): void {
  hasTrack.value = true;
  npTitle.value = title;
  npArtist.value = artist;
  npAlbum.value = album;
}

// Idle play, cold start: "start the library" by playing the first song. For a
// folder that's its first track — the same as clicking that track in the tree
// (the album auto-continues under the hood, no queue view), not the whole folder
// as an explicit playlist. A loose top-level file plays on its own. This keeps
// the idle play button ready-to-go rather than a dead disabled control.
async function startLibrary(): Promise<void> {
  const root = app.rootNode;
  const first = root?.children[0];
  if (!root || !first) return;
  // Idle play starts a lone track (album continuation) — the hero, no list.
  resetToLonePlayback();
  if (!first.isFolder) {
    playFile(first, root);
    return;
  }
  await fetchChildren(first);
  const track = first.children.find((c) => !c.isFolder);
  if (track) playFile(track, first);
}

function togglePlayPause(): void {
  // A queue resting with no playhead — drained at its end, or armed from silence
  // by "Add to queue" without auto-playing — starts from the top. This is checked
  // before the idle-play fallback so an armed queue (hasTrack still false, nothing
  // ever played) starts itself rather than the whole library.
  if (app.queueEnded && app.lastQueue.length > 0) {
    app.queueEnded = false;
    if (queueIsActivePool()) {
      // The queue rests with no playhead, so play restarts it from the top rather
      // than resuming any one track. (activeQueue can now be set while a folder
      // plays with the queue merely stashed — the pool, not its mere existence,
      // is what decides this.)
      const pool = poolPaths();
      app.lastQueue = pool;
      app.lastIndex = 0;
      app.pendingQueueIndex = 0;
      currentNodePath.value = pool[0] ?? null;
      feedEngine(pool, 0);
    } else {
      // Implicit folder continuation: the album played through and stopped, so
      // play restarts it from the start of the folder — matching how a queue pool
      // and the navigator's leaf lists restart from their top rather than resuming
      // the track you happened to start on.
      app.lastIndex = 0;
      currentNodePath.value = app.lastQueue[0] ?? null;
      feedEngine(app.lastQueue, 0);
    }
    return;
  }
  if (!hasTrack.value) {
    void startLibrary();
    return;
  }
  // Streams also route through togglePause: the engine implements live-radio
  // semantics natively (pause disconnects, resume rejoins the live edge).
  void engine.togglePause();
}

const persistVolume = debounce(async (v: number) => {
  await app.store.set(KEY_VOLUME, v);
  await app.store.save();
}, 200);

// Most recent non-muted volume, restored when unmuting via the volume button.
let lastNonZeroVolume = 1;

function setVolume(v: number): void {
  const clamped = Math.max(0, Math.min(1, v));
  if (clamped > 0) lastNonZeroVolume = clamped;
  if (clamped === volume.value) return;
  volume.value = clamped;
  persistVolume(clamped);
}

function seekBy(seconds: number): void {
  if (isStream.value) return;
  app.queueEnded = false;
  void engine.seekBy(seconds);
}

function seekTo(seconds: number): void {
  if (isStream.value) return;
  app.queueEnded = false;
  void engine.seekTo(seconds);
}

// The tracks eligible for shuffle/repeat advancement. Inside an album that's
// the folder's tracks in listing order; a search hit or external file has no
// album context, so the pool is just that single track.
function poolPaths(): string[] {
  if (app.currentParent) {
    return app.currentParent.children.filter((c) => !c.isFolder).map((c) => c.path);
  }
  if (currentNodePath.value) return [currentNodePath.value];
  // Search hit or external file: no album context, so the queue itself is the
  // pool (a single track). Lets repeat still loop it.
  return app.lastQueue;
}

function shuffled<T>(items: T[]): T[] {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// (Re)fill the shuffle bag with the pool minus the current track, so the next
// pick is never an immediate repeat. A single-track pool has nothing else to
// pick, so it falls back to looping that track.
function refillShuffleBag(current: string | null): void {
  const pool = poolPaths();
  const rest = pool.filter((p) => p !== current);
  app.shuffleBag = shuffled(rest.length ? rest : pool);
}

// Hand the engine a single track and remember it as the queue, so play-after-end
// and the play button restart the right thing. UI (row highlight, now-playing,
// art) follows from the engine's track-changed → onAdvance for album tracks;
// for a lone search/external track it's already correct (same track).
function playSingle(path: string, queueIndex?: number): void {
  app.queueEnded = false;
  app.lastQueue = [path];
  app.lastIndex = 0;
  currentTime.value = 0;
  // Shuffle / repeat-one hand the engine one track at a time; when that track is
  // a queue row, mark which one so onAdvance highlights it. Callers pass the
  // positional index when known (e.g. repeat-one looping row 3 of a duplicate-
  // heavy queue) so the correct instance is highlighted rather than the first match.
  if (queueIsActivePool()) {
    if (queueIndex != null) {
      app.pendingQueueIndex = queueIndex;
    } else {
      const found = app.currentParent?.children.findIndex((c) => c.path === path) ?? -1;
      app.pendingQueueIndex = found >= 0 ? found : null;
    }
  }
  void engine.play([path], 0);
}

// Hand the engine a straight-play list positioned at `idx`. With autoadvance on
// (the default) the whole list goes across so the engine advances gaplessly; with
// it off, only the one track is handed over — the engine then drains after it and
// handleEnded stops, giving "one track, then stop" without any engine change. The
// full list still lives in lastQueue/poolPaths so a manual skip can move on.
function feedEngine(list: string[], idx: number): void {
  if (autoadvanceEnabled()) void engine.play(list, idx);
  else void engine.play([list[idx]], 0);
}

// Hand the engine a pool starting at `idx` and remember it (the shared body of
// straight-play advance, repeat-all wrap, and manual skip). When the pool is the
// queue, `idx` is also the row to highlight next.
function playPool(pool: string[], idx: number): void {
  app.queueEnded = false;
  app.lastQueue = pool;
  app.lastIndex = idx;
  if (queueIsActivePool()) app.pendingQueueIndex = idx;
  feedEngine(pool, idx);
}

// Playback has run to the end with nothing left to advance to. A visible queue
// rests with no playhead — the finished rows stay on screen, but nothing is
// "current", so pressing play restarts it from the top (see togglePlayPause).
// Implicit folder continuation keeps its row highlighted so play resumes the
// track that just finished.
function stopAtQueueEnd(): void {
  app.queueEnded = true;
  // A drained queue rests with no playhead (rows stay, none highlighted); folder
  // autoplay instead keeps its row so play resumes the finished track. The two
  // never hand off: playback outside the queue stops at the folder's end rather
  // than flowing into any stashed queue.
  if (queueIsActivePool()) {
    currentNodePath.value = null;
    queuePlayingIndex.value = null;
  }
}

// Decide what to play when the engine drains its queue. This is the sole
// advancement point: straight play only reaches it at album end (the engine
// auto-advances the rest gaplessly), while shuffle and repeat-one reach it after
// every track because they're queued one at a time.
export function handleEnded(): void {
  const mode = repeatMode.value;
  // currentNodePath is null for an external file; fall back to the queue so
  // repeat still identifies the track to loop.
  const current = currentNodePath.value ?? app.lastQueue[app.lastIndex] ?? null;

  // Repeat-one loops the finished track regardless of shuffle.
  if (mode === "one" && current) {
    playSingle(current, queueIsActivePool() ? (queuePlayingIndex.value ?? undefined) : undefined);
    return;
  }

  // Autoadvance off for this context: stop instead of moving to the next track.
  // This overrides shuffle and repeat-all (both advance to a *different* track);
  // repeat-one above still loops, since it never advances off the current track.
  if (!autoadvanceEnabled()) {
    stopAtQueueEnd();
    return;
  }

  if (shuffleMode.value) {
    if (app.shuffleBag.length === 0) {
      // Cycle exhausted: reshuffle and keep going when repeating, else stop.
      if (mode !== "all") {
        stopAtQueueEnd();
        return;
      }
      refillShuffleBag(current);
    }
    const next = app.shuffleBag.shift();
    if (next) playSingle(next);
    else stopAtQueueEnd();
    return;
  }

  // Straight play. Continue in listing order from the finished track; this
  // matters when shuffle was turned off mid-album (single-track queue) — resume
  // the album in order rather than stopping.
  const pool = poolPaths();
  // In the queue pool, use the live row index (same as skipNext) so a duplicate
  // track at a later row resolves to the correct instance rather than the first
  // path match, which would cause the queue to loop from the middle instead of stop.
  const curIdx = queueIsActivePool() && queuePlayingIndex.value != null
    ? queuePlayingIndex.value
    : pool.indexOf(current ?? "");
  const nextIdx = curIdx + 1;
  if (curIdx >= 0 && nextIdx < pool.length) {
    playPool(pool, nextIdx);
    return;
  }
  // End of the album.
  if (mode === "all" && pool.length > 0) {
    playPool(pool, 0);
    return;
  }
  stopAtQueueEnd();
}

// User-initiated skip, driven by the OS Now Playing widget / media keys (there
// is no in-app skip button). Reuses the same pool / shuffle-bag advancement as
// handleEnded, but a manual next overrides repeat-one (skip, don't re-loop).
function skipNext(): void {
  if (isStream.value) return;
  const current = currentNodePath.value ?? app.lastQueue[app.lastIndex] ?? null;

  if (shuffleMode.value) {
    if (app.shuffleBag.length === 0) refillShuffleBag(current);
    const next = app.shuffleBag.shift();
    if (next) playSingle(next);
    return;
  }

  const pool = poolPaths();
  // In the queue pool, trust the live row index (positional, so a duplicated
  // track resolves to the instance actually playing) over a path lookup, which
  // would find the first copy. Elsewhere the path is unambiguous.
  const curIdx = queueIsActivePool() && queuePlayingIndex.value != null
    ? queuePlayingIndex.value
    : pool.indexOf(current ?? "");
  const nextIdx = curIdx + 1;
  if (curIdx >= 0 && nextIdx < pool.length) {
    playPool(pool, nextIdx);
  } else if (repeatMode.value === "all" && pool.length > 0) {
    // Wrap to the album start; without repeat-all a next past the end is a no-op.
    playPool(pool, 0);
  }
}

// Previous: within the first few seconds of a track it steps back a track,
// otherwise it restarts the current one — the near-universal transport
// convention. Shuffle keeps no back-history, so it just restarts.
function skipPrev(): void {
  if (isStream.value) return;
  if (currentTime.value > 3 || shuffleMode.value) {
    void engine.seekTo(0);
    return;
  }
  const current = currentNodePath.value ?? app.lastQueue[app.lastIndex] ?? null;
  const pool = poolPaths();
  // Prefer the live row index in the queue pool so a duplicated track steps back
  // from the instance actually playing, not the first path match (see skipNext).
  const curIdx = queueIsActivePool() && queuePlayingIndex.value != null
    ? queuePlayingIndex.value
    : pool.indexOf(current ?? "");
  const prevIdx = curIdx - 1;
  if (prevIdx >= 0) {
    playPool(pool, prevIdx);
  } else {
    void engine.seekTo(0);
  }
}

// Whether a manual Next would land on another track — drives only the Next
// button's enabled state (skipNext stays the sole mover). Mirrors skipNext's
// branches: shuffle always has a next (the bag refills), straight play does
// until the pool's last track unless repeat-all wraps. Streams and an idle or
// drained player have nothing ahead. Prev needs no such check: it always
// restarts or steps back, so it's live whenever a non-stream track is loaded.
function hasNextTrack(): boolean {
  if (!hasTrack.value || isStream.value) return false;
  if (shuffleMode.value) return true;
  const pool = poolPaths();
  if (pool.length === 0) return false;
  if (repeatMode.value === "all") return true;
  const current = currentNodePath.value ?? app.lastQueue[app.lastIndex] ?? null;
  // In the queue pool, trust the live row index (positional) so a duplicated
  // track resolves to the instance playing, matching skipNext.
  const curIdx = queueIsActivePool() && queuePlayingIndex.value != null
    ? queuePlayingIndex.value
    : pool.indexOf(current ?? "");
  return curIdx >= 0 && curIdx + 1 < pool.length;
}

// `startIndex` pins the position to start at within `parent`'s tracks; callers
// that click a specific queue row pass it so a duplicated track resolves to the
// clicked instance rather than the first path match. Omitted for folder/tree
// clicks, where the node's path is unambiguous within its folder.
export function playFile(node: TreeNode, parent: TreeNode, startIndex?: number): void {
  app.currentParent = parent;
  currentNodePath.value = node.path;
  currentStreamUrl.value = null;
  isStream.value = false;
  // Playing a folder track leaves any built queue stashed; drop the live-row
  // highlight so it doesn't linger (as playStream does). A queue-row click sets
  // currentParent to the synthetic queue, where the index is restored via
  // pendingQueueIndex below and onTrackChange — so only clear off-queue. Without
  // this, replaying the same file the queue was on wouldn't change any reactive
  // dep, so the highlight effect wouldn't re-run and would keep the stale accent.
  if (!queueIsActivePool()) queuePlayingIndex.value = null;
  currentTime.value = 0;
  duration.value = 0;
  app.queueEnded = false;
  setNowPlaying(node.title ?? node.name, node.artist, node.album);
  void loadArt(node.path);
  const siblings = parent.children.filter((c) => !c.isFolder);
  const tracks = siblings.map((c) => c.path);
  if (repeatMode.value === "one") {
    // Loop this track; the album never enters the queue.
    app.shuffleBag = [];
    playSingle(node.path, startIndex);
  } else if (shuffleMode.value) {
    // One track at a time, next picked at each queue-ended. Seed the bag with
    // the rest of the album so a repeat-off cycle plays every track once.
    refillShuffleBag(node.path);
    playSingle(node.path, startIndex);
  } else {
    // Straight play. With autoadvance on, queue the rest of the album so the
    // engine auto-advances gaplessly (it treats this list as the complete queue,
    // replaced when another file is clicked); with it off, feedEngine hands over
    // only this track so playback stops at its end.
    app.shuffleBag = [];
    const idx = startIndex ?? Math.max(
      0,
      siblings.findIndex((c) => c.path === node.path),
    );
    app.lastQueue = tracks;
    app.lastIndex = idx;
    if (queueIsActivePool()) app.pendingQueueIndex = idx;
    feedEngine(tracks, idx);
  }
}

export function playStream(stream: Stream): void {
  // A stream is lone playback: dismiss any open queue/playlist and land on the
  // hero (its own face, no nav bar). Null the highlight (streams emit no
  // track-changed, so onAdvance won't).
  resetToLonePlayback();
  queuePlayingIndex.value = null;
  app.currentParent = null;
  currentNodePath.value = null;
  currentStreamUrl.value = stream.url;
  // The played station is also the selected row, so selection follows playback
  // (matching a played tree track) rather than leaving a stale prior highlight.
  selectedStreamUrl.value = stream.url;
  app.currentStreamName = stream.name;
  isStream.value = true;
  currentTime.value = 0;
  duration.value = 0;
  app.queueEnded = false;
  app.lastQueue = [];
  app.shuffleBag = [];
  // Station name until the first ICY title arrives (or forever, for stations
  // that don't send titles).
  setNowPlaying(stream.name, null, null);
  npStreamMeta.value = null;
  void engine.playStream(stream.url);
  // Stream list station art shows in the same spot as album art. Like loadArt,
  // the previous art stays up until the new image is ready (a failed or absent
  // fetch resolves to null, which clears it); stations without an image clear
  // immediately.
  if (stream.image) {
    void loadStreamArt(stream.image);
  } else {
    clearArt();
  }
}

// Plays a library file picked from the search dropdown. currentParent stays
// null so there's no album auto-advance (a search hit isn't a folder context);
// setting currentNodePath still lights up the row if that folder is expanded in
// the tree. The native engine opens the file directly — no prepare step needed.
export function playSearchTrack(t: SearchTrack): void {
  // A lone search hit is lone playback: dismiss any open queue/playlist and land
  // on the hero. currentParent is null so onAdvance won't touch the highlight.
  resetToLonePlayback();
  queuePlayingIndex.value = null;
  app.currentParent = null;
  currentNodePath.value = t.path;
  currentStreamUrl.value = null;
  isStream.value = false;
  currentTime.value = 0;
  duration.value = 0;
  app.queueEnded = false;
  app.lastQueue = [t.path];
  app.lastIndex = 0;
  app.shuffleBag = [];
  const fallbackName = t.path.split(/[\\/]/).pop() ?? t.path;
  setNowPlaying(t.title ?? fallbackName, t.artist, t.album);
  void loadArt(t.path);
  void engine.play([t.path], 0);
}

// Plays a folder chosen from the search dropdown. Fetches every track under it
// and plays them as an ad-hoc album via a synthetic parent node that stands in
// for a real tree folder, so all the existing album machinery works unchanged:
// gapless straight-through play, now-playing updates on auto-advance (onAdvance
// → siblingByPath find the child in currentParent), and shuffle/repeat. The
// node isn't part of the real tree; a later library rescan re-binds currentParent
// to the matching tree folder by path if one is loaded. Shuffle starts on a
// random track (playFile shuffles the rest); straight play starts on the first.
// A stand-in tree folder wrapping an ad-hoc track list (a searched folder, or
// an artist/album queue), so all the album machinery works unchanged: gapless
// straight-through play, now-playing on auto-advance (onAdvance → siblingByPath
// finds the child in currentParent), and shuffle/repeat. `path` is synthetic for
// artist/album queues (see openArtistQueue/openAlbumQueue), which is why the
// rescan re-bind is suppressed while a queue is active.
function syntheticParent(
  path: string,
  name: string,
  tracks: SearchTrack[],
): TreeNode {
  return {
    path,
    name,
    title: null,
    artist: null,
    album: null,
    albumArtist: null,
    disc: null,
    track: null,
    isFolder: true,
    loaded: true,
    expanded: false,
    children: tracks.map((t) => ({
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
    })),
  };
}

export async function playFolder(folder: SearchFolder): Promise<void> {
  let tracks: SearchTrack[];
  try {
    tracks = await invoke<SearchTrack[]>("folder_tracks", { path: folder.path });
  } catch (e) {
    console.error("folder_tracks failed", folder.path, e);
    return;
  }
  if (tracks.length === 0) return;
  // A folder is a queue the user chose to play — show it as one (list view),
  // instead of the old "secret queue" that played but stayed on the card. A
  // folder can span albums (recursive flatten), so it's text-only like an
  // artist queue, keyed on the folder path.
  playQueue(
    {
      kind: "folder",
      title: folder.name,
      subtitle: trackCountSubtitle(tracks),
      tracks,
    },
    `queue:folder:${folder.path}`,
  );
}


// The playable rows of a playlist as SearchTracks (dropping missing files),
// ready for the queue/engine machinery.
export function playlistPlayableTracks(data: PlaylistData): SearchTrack[] {
  return data.tracks
    .filter((t) => !t.missing)
    .map((t) => ({
      path: t.path,
      title: t.title,
      artist: t.artist,
      album: t.album,
      duration: t.duration,
    }));
}

// Every row of a playlist as SearchTracks — including missing files, carried
// through with their `missing` flag so the browse view can show them (marked,
// unplayable) rather than silently dropping them. Playback paths use
// playlistPlayableTracks instead, keeping the engine's pool free of dangling
// files. See playlist-plan.md "Missing / dangling tracks".
function playlistViewTracks(data: PlaylistData): SearchTrack[] {
  return data.tracks.map((t) => ({
    path: t.path,
    title: t.title,
    artist: t.artist,
    album: t.album,
    missing: t.missing,
    duration: t.duration,
  }));
}

// Playlist rows use single-click = browse, double-click = play. A short timer
// disambiguates so the browse fires only when no second click follows.
// A playlist is a container, like a folder: single-click opens it (browse), just
// as clicking a folder shows its contents rather than playing them. We act on the
// first click immediately — no click/double-click disambiguation timer — because
// browsing is non-destructive, so there's nothing to lose by opening the pane
// right away. A double-click then upgrades to Play (its opening browse is
// harmless and idempotent; the play follows). This keeps the frequent action
// (open) instant and free of the latency a timer would impose.
export function attachPlaylistClicks(label: HTMLElement, node: TreeNode): void {
  label.addEventListener("click", () => void browsePlaylist(node));
  label.addEventListener("dblclick", () => void playPlaylist(node));
}

// Double-click / "Play": play the playlist from its first track. A playlist
// plays like a folder — autoadvance/shuffle/repeat-all apply — via the queue
// machinery under a `queue:playlist:` synthetic path (so it reads the Playlists
// autoadvance context). It becomes the playing source (playQueue shows the list
// face titled by its name, distinct from an ephemeral "Queue").
export async function playPlaylist(node: TreeNode): Promise<void> {
  await playPlaylistPath(node.path);
}

// Play a playlist by file path (tree double-click / "Play", or a search hit).
// Shows it as the playing source (its own list face titled by its name, distinct
// from an ephemeral "Queue").
export async function playPlaylistPath(path: string): Promise<void> {
  let data: PlaylistData;
  try {
    data = await invoke<PlaylistData>("read_playlist", { path });
  } catch (e) {
    // The file is gone (moved/deleted outside the app). Self-heal: tell the
    // user and drop it from the recents so the dead entry stops reappearing.
    console.error("read_playlist failed", path, e);
    removeRecentPlaylist(path);
    toast("Playlist no longer available");
    return;
  }
  // Show every row (missing included, marked/unplayable) while playing the
  // playable ones — playQueue filters missing out of the engine pool. Bail only
  // when nothing is playable, so an all-dangling playlist doesn't open a dead queue.
  const tracks = playlistViewTracks(data);
  if (tracks.every((t) => t.missing)) return;
  playQueue(
    {
      kind: "playlist",
      title: data.name,
      subtitle: trackCountSubtitle(tracks),
      tracks,
      sourcePath: data.path,
    },
    `queue:playlist:${path}`,
  );
  addRecentPlaylist(data.path, data.name);
}

// Single-click: browse the playlist (view its tracks) without changing what's
// playing. It becomes the open playlist on the list face; whatever was playing
// keeps playing underneath (see browsedPlaylist / paneView).
async function browsePlaylist(node: TreeNode): Promise<void> {
  await browsePlaylistPath(node.path);
}

// Browse a playlist by file path (tree single-click, OS Open…, Open Recent).
// Reads and shows it as the open playlist without changing playback, and
// records it as recent.
async function browsePlaylistPath(path: string): Promise<void> {
  let data: PlaylistData;
  try {
    data = await invoke<PlaylistData>("read_playlist", { path });
  } catch (e) {
    // The file is gone (moved/deleted outside the app). Self-heal: tell the
    // user and drop it from the recents so the dead entry stops reappearing.
    console.error("read_playlist failed", path, e);
    removeRecentPlaylist(path);
    toast("Playlist no longer available");
    return;
  }
  // Browse shows every row, missing files included (marked, unplayable) — so a
  // playlist whose files can't be resolved doesn't collapse to near-nothing.
  // Playback (playPlaylist / Add to queue) still filters missing.
  const tracks = playlistViewTracks(data);
  browsedPlaylist.value = {
    kind: "playlist",
    title: data.name,
    subtitle: trackCountSubtitle(tracks),
    tracks,
    sourcePath: data.path,
  };
  listFaceOpen.value = true;
  addRecentPlaylist(data.path, data.name);
}

export async function addPlaylistToQueue(node: TreeNode): Promise<void> {
  const queueBefore = activeQueue.value;
  const pathBefore = currentNodePath.value;
  try {
    const data = await invoke<PlaylistData>("read_playlist", { path: node.path });
    if (activeQueue.value !== queueBefore) return;
    if (!queueBefore && currentNodePath.value !== pathBefore) return;
    addToQueue(playlistPlayableTracks(data));
  } catch (e) {
    console.error("read_playlist failed", node.path, e);
    toast("Playlist no longer available");
  }
}

// --- OS Playlist menu ---
// The Playlist menu (New / Open… / Open Recent ▸ / Save Queue as Playlist / Move) is
// built in Rust and relays intents here; the frontend owns the dialogs, file
// writes, and the recents list (persisted in the settings store, mirrored into
// the native Open Recent submenu via set_recent_playlists).



// --- Playlist index (phase 4) ---
// Every `.m3u/.m3u8` under the library root — path + display name — backing the
// "Add to playlist ▸" submenu and searchable playlists. Built from Rust's
// `list_all_playlists` and kept fresh by the filesystem watcher (refreshLibrary
// runs on every library change, our own writes included). Read synchronously
// when a context menu is built, so the submenu reflects the current library.


export async function refreshPlaylistIndex(): Promise<void> {
  const roots = libraryRootPaths();
  if (roots.length === 0) {
    app.playlistIndex = [];
    refreshNavPlaylists();
    return;
  }
  try {
    // list_all_playlists is keyed to one root (it walks that tree), so scan each
    // configured folder and merge into a single index.
    const perRoot = await Promise.all(
      roots.map((root) => invoke<PlaylistRef[]>("list_all_playlists", { root })),
    );
    app.playlistIndex = perRoot.flat();
  } catch (e) {
    console.error("list_all_playlists failed", e);
  }
  // Keep the navigator's root-menu playlist list in step with the index.
  refreshNavPlaylists();
}

// The filename stem (no extension) — the display name for a freshly saved file
// before it carries a #PLAYLIST: directive of its own.
function playlistNameFromPath(path: string): string {
  const base = path.split("/").pop() ?? path;
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  return stem || "Untitled";
}

// Default directory for a save dialog: the first library folder when set, else
// let the OS pick. Used so New / Save-as land in the library by default.
function defaultPlaylistDir(): string | null {
  return libraryRootPaths()[0] ?? null;
}

async function persistRecentPlaylists(): Promise<void> {
  await app.store.set(KEY_RECENT_PLAYLISTS, app.recentPlaylists);
  await app.store.save();
}

// Save the navigator's current place so it's restored on the next launch. The
// navigator calls this (fire-and-forget) on every drill / back / pop; writes are
// at click frequency, so no debounce is needed.
function persistNavLocation(steps: NavStep[]): void {
  void (async () => {
    await app.store.set(KEY_NAV_LOCATION, steps);
    await app.store.save();
  })();
}

// Push a playlist to the front of the recents (most-recent first, deduped by
// path, capped), persist, and rebuild the native Open Recent submenu.
function addRecentPlaylist(path: string, name: string): void {
  app.recentPlaylists = [
    { path, name },
    ...app.recentPlaylists.filter((r) => r.path !== path),
  ].slice(0, RECENT_PLAYLISTS_MAX);
  void persistRecentPlaylists();
  syncRecentPlaylistsMenu();
}

function removeRecentPlaylist(path: string): void {
  app.recentPlaylists = app.recentPlaylists.filter((r) => r.path !== path);
  void persistRecentPlaylists();
  syncRecentPlaylistsMenu();
}

function syncRecentPlaylistsMenu(): void {
  void invoke("set_recent_playlists", { items: app.recentPlaylists });
}

// New Playlist…: save dialog → write an empty .m3u8 → open it ready to fill.
async function menuNewPlaylist(): Promise<void> {
  const dir = defaultPlaylistDir();
  const path = await save({
    title: "New Playlist",
    defaultPath: dir ? `${dir}/Untitled.m3u8` : "Untitled.m3u8",
    filters: [{ name: "Playlist", extensions: ["m3u8"] }],
  });
  if (!path) return;
  const name = playlistNameFromPath(path);
  try {
    await invoke("write_playlist", { path, name, tracks: [] });
  } catch (e) {
    console.error("write_playlist failed", path, e);
    return;
  }
  await refreshLibrary();
  await browsePlaylistPath(path);
}

// Open…: native dialog filtered to playlists; may live outside the library.
async function menuOpenPlaylist(): Promise<void> {
  const selected = await open({
    directory: false,
    multiple: false,
    defaultPath: defaultPlaylistDir() ?? undefined,
    filters: [{ name: "Playlist", extensions: ["m3u", "m3u8"] }],
  });
  if (typeof selected === "string") await browsePlaylistPath(selected);
}

// Save Queue as Playlist (⌘S): convert the ephemeral queue into an autosaving
// playlist source. Guarded to an ephemeral queue that's the active pool (the menu
// item is also disabled otherwise); the native path picker chooses the file.
async function menuSavePlaylist(): Promise<void> {
  if (!queueCanSaveAsPlaylist()) return;
  const dir = defaultPlaylistDir();
  const path = await save({
    title: "Save Queue as Playlist",
    defaultPath: dir ? `${dir}/Untitled.m3u8` : "Untitled.m3u8",
    filters: [{ name: "Playlist", extensions: ["m3u8"] }],
  });
  if (!path) return;
  await saveQueueAsPlaylist(path);
}

// True when the active pool is an ephemeral queue that can be promoted to a file
// (not already a playlist source). Gates both the menu item and the save flow.
function queueCanSaveAsPlaylist(): boolean {
  const q = activeQueue.value;
  return !!q && !isPlaylistSource(q) && queueIsActivePool();
}

// Write the live queue to `path`, then repoint it at that file so it becomes an
// autosaving playlist source: from here on curations flow to disk (saveOpenPlaylist
// keys off sourcePath). kind is already "playlist"; we adopt the saved name too.
// Guard against a queue swap during the write. The browse at the end opens with
// the same sourcePath, so the two are recognised as one pool rather than diverging.
async function saveQueueAsPlaylist(path: string): Promise<void> {
  const q = activeQueue.value;
  if (!q || isPlaylistSource(q) || !queueIsActivePool()) return;
  const name = playlistNameFromPath(path);
  try {
    await invoke("write_playlist", { path, name, tracks: q.tracks.map((t) => t.path) });
  } catch (e) {
    console.error("write_playlist failed", path, e);
    return;
  }
  if (activeQueue.value === q) {
    activeQueue.value = { ...q, title: name, sourcePath: path };
  }
  toast(`Saved playlist "${name}"`);
  await refreshLibrary();
  await browsePlaylistPath(path);
}

// Move Playlist File…: relocate the open playlist on disk (rewriting relative
// paths against the new location), then re-open it there.
async function menuMovePlaylist(): Promise<void> {
  const src = openPlaylistPath();
  if (!src) {
    toast("Open a playlist to move it");
    return;
  }
  const dest = await save({
    title: "Move Playlist File",
    defaultPath: src,
    filters: [{ name: "Playlist", extensions: ["m3u8"] }],
  });
  if (!dest || dest === src) return;
  try {
    await invoke("move_playlist", { oldPath: src, newPath: dest });
  } catch (e) {
    console.error("move_playlist failed", src, dest, e);
    toast("Couldn't move playlist");
    return;
  }
  // Redirect the playing source (if it's the moved playlist) at its new path, so a
  // later curation autosaves to the new location instead of resurrecting the old
  // one. The browse is re-opened at dest below; this covers the playing copy, which
  // browsePlaylistPath doesn't touch.
  const active = activeQueue.value;
  if (isPlaylistSource(active) && active!.sourcePath === src) {
    activeQueue.value = { ...active!, sourcePath: dest };
  }
  removeRecentPlaylist(src);
  await refreshLibrary();
  await browsePlaylistPath(dest);
}

// Opens a queue in the right pane and starts it. Playback reuses the album path
// via a synthetic parent (so shuffle/repeat/gapless all work); the queue view is
// what makes it visible. Under shuffle we start on a random track (matching
// playFolder) so replaying the same artist/album doesn't always open on track 1;
// straight play starts on the first track, the page's natural order. Either way
// the view keeps natural order and just highlights the playing row. The synthetic
// path is unique per queue and never a real tree path, so the rescan re-bind
// (suppressed while activeQueue is set) can't repoint currentParent at a folder.
function playQueue(queue: Queue, syntheticPath: string, startIndex?: number): void {
  // The engine pool is the playable rows only; any missing rows stay in the view
  // (openActiveQueue keeps queue.tracks intact) but never reach the engine, so
  // gapless never stalls on a dangling file. renderQueue bridges the two index
  // spaces. For non-playlist queues nothing is missing, so pool === view.
  const playable = queue.tracks.filter((t) => !t.missing);
  if (playable.length === 0) return;
  const parent = syntheticParent(syntheticPath, queue.title, playable);
  // A given start row (a browsed playlist committed from a row) wins; otherwise
  // shuffle opens on a random track and straight play on the first.
  const startAt = startIndex != null
    ? startIndex
    : shuffleMode.value
      ? Math.floor(Math.random() * parent.children.length)
      : 0;
  playFile(parent.children[startAt], parent, startAt);
  openActiveQueue(queue);
  // Every explicit Play verb presents its list; committing to play also
  // abandons any prior browse (this queue is now the source).
  browsedPlaylist.value = null;
  listFaceOpen.value = true;
}

// Play a browsed playlist starting at a given row — the commit that turns a
// browse into the playing source. Reuses the same synthetic path as double-
// click Play so it reads the Playlists autoadvance context.
export function commitBrowsedPlaylist(startIndex: number): void {
  const q = browsedPlaylist.value;
  if (!q?.sourcePath) return;
  playQueue(q, `queue:playlist:${q.sourcePath}`, startIndex);
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
function viewIndexOfPlayable(tracks: SearchTrack[], playableIdx: number): number {
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
function playingTrackObj(list: Queue): SearchTrack | null {
  const idx = queuePlayingIndex.value;
  if (idx == null) return null;
  const v = viewIndexOfPlayable(list.tracks, idx);
  return v >= 0 ? list.tracks[v] : null;
}

// Persist the open playlist after an edit. Every row is written (missing included)
// so the file round-trips; paths only — metadata is re-resolved from the DB on read.
async function saveOpenPlaylist(path: string, name: string, tracks: SearchTrack[]): Promise<void> {
  try {
    await invoke("write_playlist", { path, name, tracks: tracks.map((t) => t.path) });
  } catch (e) {
    console.error("write_playlist (autosave) failed", path, e);
    toast("Couldn't save playlist");
  }
}

// Apply a new view-array to the open list: swap the signal, reconcile playback when
// it's the live pool, and autosave when it's a playlist file.
function applyCuration(newTracks: SearchTrack[]): void {
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
function reconcilePoolEdit(newTracks: SearchTrack[], playingObj: SearchTrack | null): void {
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
function advanceAfterRemovedPlaying(pool: string[], slot: number): void {
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
function stopAfterRemove(): void {
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
function removeCuratedRow(i: number): void {
  const list = curatedList();
  if (!list || i < 0 || i >= list.tracks.length) return;
  const tracks = list.tracks.slice();
  tracks.splice(i, 1);
  applyCuration(tracks);
}

// Remove every selected row (by object identity, so duplicates and reorders
// resolve exactly) from the open list in a single curation edit.
function removeCuratedTracks(objs: SearchTrack[]): void {
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
function fillRowAfterRemoval(
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
function appendToActivePool(active: Queue, tracks: SearchTrack[]): void {
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

// --- Rename / delete (phase 3) ---

// Rename the open playlist from the header pencil. The `#PLAYLIST:` directive is
// the only thing that changes — the file never moves — so this rewrites the
// directive + rows in place and refreshes the tree label. Guards an empty name to
// the placeholder (never a nameless playlist).
export async function renameOpenPlaylist(input: string): Promise<void> {
  const list = curatedList();
  if (!list?.sourcePath) return;
  const path = list.sourcePath;
  const name = input.trim() || UNTITLED_PLAYLIST_TITLE;
  if (name === list.title) return;
  // Update whichever open copies point at this file so the header/tree agree
  // without a re-read.
  const retitle = (q: Queue | null): Queue | null =>
    q && q.sourcePath === path ? { ...q, title: name } : q;
  browsedPlaylist.value = retitle(browsedPlaylist.value);
  activeQueue.value = retitle(activeQueue.value);
  try {
    await invoke("write_playlist", { path, name, tracks: list.tracks.map((t) => t.path) });
  } catch (e) {
    console.error("write_playlist (rename) failed", path, e);
    toast("Couldn't rename playlist");
    return;
  }
  addRecentPlaylist(path, name);
  await refreshLibrary();
}

// Rename a playlist from its tree row (context menu → Rename). Runs after the edit
// input has already closed (see editInline.finish), so a renderTree here is safe —
// no live input to tear out. It optimistically retitles the row in place to avoid
// a flash of the old name, writes the directive, then refreshes so the row re-sorts
// to its new alphabetical slot; refreshLibrary follows it there (pendingReveal).
async function renameTreePlaylist(node: TreeNode, label: HTMLElement, raw: string): Promise<void> {
  const name = raw.trim() || UNTITLED_PLAYLIST_TITLE;
  if (name === node.name) return;
  const path = node.path;
  // Optimistic in-place update: the node model and the row's own text, so the new
  // name shows immediately in the row's current position until the refresh re-sorts.
  node.name = name;
  const textEl = label.querySelector(".label-text");
  if (textEl) textEl.textContent = name;
  // Keep any open copies (browsed / active queue) titled in agreement without a re-read.
  const retitle = (q: Queue | null): Queue | null =>
    q && q.sourcePath === path ? { ...q, title: name } : q;
  browsedPlaylist.value = retitle(browsedPlaylist.value);
  activeQueue.value = retitle(activeQueue.value);
  try {
    await invoke("rename_playlist", { path, name });
  } catch (e) {
    console.error("rename_playlist failed", path, e);
    toast("Couldn't rename playlist");
    return;
  }
  addRecentPlaylist(path, name);
  // Re-sort the tree now (deterministic, not waiting on the watcher's debounce) and
  // scroll the renamed row into view at its new position.
  app.pendingRevealPlaylistPath = path;
  await refreshLibrary();
}

// Start an inline rename on a playlist's tree row. The whole label (icon + text)
// is swapped for the edit field; commit writes the file, cancel restores as-is.
export function startTreePlaylistRename(node: TreeNode, label: HTMLElement): void {
  editInline(label, node.name, (value) => void renameTreePlaylist(node, label, value));
}

// Delete a playlist file from the tree. Confirms first (the file is removed from
// disk), drops it from recents, closes the browse if it was open, and refreshes.
// If the deleted playlist is the *audible* source, playback stops (tear down to
// the empty hero) — leaving it playing would autosave, and thus resurrect, the
// just-deleted file on the next curation. A merely *stashed* copy (a folder/stream
// plays over it) is dropped without disturbing that unrelated playback.
export async function deletePlaylistNode(node: TreeNode): Promise<void> {
  const name = displayLabel(node);
  const filename = node.path.split(/[\\/]/).pop() ?? node.path;
  const ok = await confirm(`This will delete ${filename}`, {
    title: `Delete ${name}?`,
    kind: "warning",
  });
  if (!ok) return;
  try {
    await invoke("delete_playlist", { path: node.path });
  } catch (e) {
    console.error("delete_playlist failed", node.path, e);
    toast("Couldn't delete playlist");
    return;
  }
  removeRecentPlaylist(node.path);
  const active = activeQueue.value;
  const activeIsDeleted = isPlaylistSource(active) && active!.sourcePath === node.path;
  if (activeIsDeleted && queueIsActivePool()) {
    // The deleted playlist is the audible pool: stop and clear playback entirely.
    teardownPlaybackToEmpty();
  } else if (activeIsDeleted) {
    // A merely stashed copy (a folder/stream plays over it): drop it so a later
    // curation can't rewrite (resurrect) the file; that playback continues.
    clearActiveQueue();
    queuePlayingIndex.value = null;
  }
  // If we were browsing the deleted file, close the browse. (An unrelated browse
  // of a different playlist is left open.)
  if (browsedPlaylist.value?.sourcePath === node.path) {
    browsedPlaylist.value = null;
    if (!activeQueue.value) listFaceOpen.value = false;
  }
  await refreshLibrary();
}

export async function openArtistQueue(name: string): Promise<void> {
  let tracks: SearchTrack[];
  try {
    tracks = await invoke<SearchTrack[]>("artist_tracks", { artist: name });
  } catch (e) {
    console.error("artist_tracks failed", name, e);
    return;
  }
  if (tracks.length === 0) return;
  playQueue(
    {
      kind: "artist",
      title: name,
      subtitle: trackCountSubtitle(tracks),
      tracks,
    },
    `queue:artist:${name}`,
  );
}

export async function openAlbumQueue(album: string, albumArtist: string): Promise<void> {
  let tracks: SearchTrack[];
  try {
    tracks = await invoke<SearchTrack[]>("album_tracks", { album, albumArtist });
  } catch (e) {
    console.error("album_tracks failed", album, albumArtist, e);
    return;
  }
  if (tracks.length === 0) return;
  playQueue(
    {
      kind: "album",
      title: album,
      subtitle: trackCountSubtitle(tracks),
      tracks,
    },
    // NUL joins the two keys so a "/" in either can't forge a collision.
    `queue:album:${albumArtist}\0${album}`,
  );
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

function trackToNode(t: SearchTrack): TreeNode {
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

function appendTracksToActiveQueue(tracks: SearchTrack[]): void {
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
function seedQueueFromCurrent(): void {
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
function armQueueAtRest(tracks: SearchTrack[]): void {
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
function detachActivePoolFromPlaylist(): void {
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
function closeQueue(): void {
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
function teardownPlaybackToEmpty(): void {
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

// A brief, self-dismissing confirmation (e.g. "Added 12 tracks"). Add-to-queue
// often lands on the list where the growth is visible anyway, but the toast
// confirms the append even when the tracks scroll in below the fold.
let toastTimer: number | undefined;
function toast(message: string): void {
  if (!toastEl) return;
  toastEl.textContent = message;
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl.classList.remove("show"), 1600);
}

// "Go to artist" / "Go to album" rows for a track's context menu, each present
// only when its tag exists. The album's grouping key is albumArtist ?? artist,
// matching the backend's album_tracks — so a compilation track (album artist
// "Various Artists", track artist something else) resolves the whole album.
// --- Add to playlist ▸ (phase 4) ---
//
// A universal submenu on any track-bearing node (tree tracks/folders/playlists,
// queue rows, search hits): a leading New Playlist… plus every indexed library
// playlist. New Playlist… seeds a fresh file with the clicked tracks; an
// existing target appends. When the target is the open list (browsed or
// playing), the append goes through the in-memory list + autosave (applyCuration
// reconciles playback and writes the file) so we never double-write; otherwise
// it's written straight to the file. Track resolution is lazy — a folder / album
// / artist only queries when its entry is chosen, not when the menu is built.


// The "Add to playlist ▸" menu item, built from the current index (the menu is
// rebuilt per right-click, so it always reflects the freshest index). Every
// playlist is offered, including the one a row already belongs to — matching
// how mainstream players handle it (a self-add just duplicates the row, which
// this app's positional model allows).
// "Show in Finder" verb, shared by the track / folder / playlist menus. Opens
// the OS file explorer with the item selected (a file is highlighted in its
// containing folder; a folder reveals itself). One path per invocation, so a
// multi-selection reveals its first item.
export function showInFinderItem(path: string): ContextMenuItem {
  return {
    label: "Show in Finder",
    action: () => {
      revealItemInDir(path).catch((e) => {
        console.error("revealItemInDir failed", path, e);
        toast("Couldn't show in Finder");
      });
    },
  };
}

export function addToPlaylistItem(getTracks: TrackProvider): ContextMenuItem {
  const submenu: ContextMenuItem[] = [
    { label: "New Playlist…", action: () => void newPlaylistWithTracks(getTracks) },
  ];
  // Duplicate #PLAYLIST: names may yield two identically-labelled entries
  // (accepted limitation); they still target distinct files by path.
  for (const pl of app.playlistIndex) {
    submenu.push({
      label: pl.name,
      action: () => void addTracksToPlaylist(pl.path, getTracks),
    });
  }
  return { label: "Add to playlist", submenu };
}

// New Playlist… from a menu: save dialog → write an .m3u8 seeded with the
// clicked tracks → browse it (playback untouched) as confirmation.
async function newPlaylistWithTracks(getTracks: TrackProvider): Promise<void> {
  const tracks = await getTracks();
  const dir = defaultPlaylistDir();
  const path = await save({
    title: "New Playlist",
    defaultPath: dir ? `${dir}/Untitled.m3u8` : "Untitled.m3u8",
    filters: [{ name: "Playlist", extensions: ["m3u8"] }],
  });
  if (!path) return;
  const name = playlistNameFromPath(path);
  try {
    await invoke("write_playlist", { path, name, tracks: tracks.map((t) => t.path) });
  } catch (e) {
    console.error("write_playlist (new) failed", path, e);
    toast("Couldn't create playlist");
    return;
  }
  await refreshLibrary();
  await browsePlaylistPath(path);
}

// Append tracks to an existing playlist. If it's the open list (browsed or the
// playing source), route through the in-memory list + autosave; otherwise read
// the file, append the new paths, and write it back.
async function addTracksToPlaylist(path: string, getTracks: TrackProvider): Promise<void> {
  const tracks = await getTracks();
  if (tracks.length === 0) return;
  const open = curatedList();
  if (open?.sourcePath === path) {
    // The open list is the target: append in memory (applyCuration autosaves and
    // reconciles playback when it's the live pool) — never a second file write.
    insertCuratedTracks(tracks, open.tracks.length);
    toast(`Added to "${open.title}"`);
    return;
  }
  // The target isn't the *visible* list, but it may still be the live playing
  // pool — you can browse one playlist while a different one plays. curatedList()
  // is browsed-first, so it misses that case; append to the active pool directly
  // so the in-memory pool, the engine, and the file all stay in sync. Skipping
  // this lets a later curation autosave the stale pool back over the add (#3).
  const active = activeQueue.value;
  if (isPlaylistSource(active) && active!.sourcePath === path) {
    appendToActivePool(active!, tracks);
    toast(`Added to "${active!.title}"`);
    return;
  }
  // Closed file: read the current rows (missing included, to round-trip), append
  // the new paths, and rewrite.
  let data: PlaylistData;
  try {
    data = await invoke<PlaylistData>("read_playlist", { path });
  } catch (e) {
    console.error("read_playlist failed", path, e);
    toast("Couldn't open playlist");
    return;
  }
  const combined = [...data.tracks.map((t) => t.path), ...tracks.map((t) => t.path)];
  try {
    await invoke("write_playlist", { path, name: data.name, tracks: combined });
  } catch (e) {
    console.error("write_playlist (append) failed", path, e);
    toast("Couldn't save playlist");
    return;
  }
  await refreshLibrary();
  toast(`Added to "${data.name}"`);
}

// Tracks behind a search hit, for its Add-to-playlist submenu. Resolves lazily
// (artist/album/folder query only when chosen). Null for kinds with no tracks to
// add (streams, and playlist hits themselves).
export function searchItemTrackProvider(item: SearchItem): TrackProvider | null {
  switch (item.kind) {
    case "file":
      return () => [item.track];
    case "folder":
      return () => invoke<SearchTrack[]>("folder_tracks", { path: item.folder.path });
    case "artist":
      return () => invoke<SearchTrack[]>("artist_tracks", { artist: item.artist.name });
    case "album":
      return () =>
        invoke<SearchTrack[]>("album_tracks", {
          album: item.album.album,
          albumArtist: item.album.artist,
        });
    default:
      return null;
  }
}

export function trackContextItems(track: {
  artist: string | null;
  album: string | null;
  albumArtist: string | null;
}): ContextMenuItem[] {
  const items: ContextMenuItem[] = [];
  if (track.artist) {
    const artist = track.artist;
    items.push({ label: "Play artist", action: () => void openArtistQueue(artist) });
  }
  if (track.album) {
    const album = track.album;
    const albumArtist = track.albumArtist ?? track.artist ?? "";
    items.push({
      label: "Play album",
      action: () => void openAlbumQueue(album, albumArtist),
    });
  }
  return items;
}

// Add a lazily-resolved set of tracks (artist/album query) to the queue, using
// the same snapshot guard as addFolderToQueue so a scan that resolves after the
// user has navigated away appends to the right destination or not at all.
async function addProviderToQueue(getTracks: TrackProvider): Promise<void> {
  const queueBefore = activeQueue.value;
  const pathBefore = currentNodePath.value;
  try {
    const tracks = await getTracks();
    if (activeQueue.value !== queueBefore) return;
    if (!queueBefore && currentNodePath.value !== pathBefore) return;
    addToQueue(tracks);
  } catch (e) {
    console.error("addProviderToQueue failed", e);
  }
}

// Right-click menus for the Artists / Albums browse rows in the library
// navigator. Built here (and injected into the navigator, which owns the rows) so
// all menu construction — and the artist/album track providers behind Add to
// queue / Add to playlist — reuses openArtistQueue / openAlbumQueue, addToQueue,
// and addToPlaylistItem instead of a second implementation in the nav module.
function showArtistContextMenu(x: number, y: number, name: string): void {
  const getTracks: TrackProvider = () =>
    invoke<SearchTrack[]>("artist_tracks", { artist: name });
  showContextMenu(x, y, [
    { label: "Play", action: () => void openArtistQueue(name) },
    { label: "Add to queue", action: () => void addProviderToQueue(getTracks) },
    addToPlaylistItem(getTracks),
  ]);
}

function showAlbumContextMenu(
  x: number,
  y: number,
  album: string,
  albumArtist: string,
): void {
  const getTracks: TrackProvider = () =>
    invoke<SearchTrack[]>("album_tracks", { album, albumArtist });
  showContextMenu(x, y, [
    { label: "Play", action: () => void openAlbumQueue(album, albumArtist) },
    { label: "Add to queue", action: () => void addProviderToQueue(getTracks) },
    addToPlaylistItem(getTracks),
  ]);
}

// Right-click menu for the Playlists browse rows (Phase 5). Mirrors the artist /
// album menus but reuses the existing playlist paths: Play plays the file through
// playPlaylistPath (so it becomes the playing source, same as a tree double-click),
// and Add to queue / Add to playlist run off the playlist's playable tracks. Missing
// rows are already dropped by playlistPlayableTracks, so the queue pool never carries
// danglers.
function showPlaylistContextMenu(x: number, y: number, path: string): void {
  const getTracks: TrackProvider = async () =>
    playlistPlayableTracks(await invoke<PlaylistData>("read_playlist", { path }));
  showContextMenu(x, y, [
    { label: "Play", action: () => void playPlaylistPath(path) },
    { label: "Add to queue", action: () => void addProviderToQueue(getTracks) },
    addToPlaylistItem(getTracks),
  ]);
}

// Loads the root menu's playlist section. list_all_playlists is keyed to one
// library folder (it walks that tree), so scan each and merge; yields nothing
// until a library folder is set.
async function loadAllPlaylists(): Promise<PlaylistRef[]> {
  const roots = libraryRootPaths();
  if (roots.length === 0) return [];
  const perRoot = await Promise.all(
    roots.map((root) => invoke<PlaylistRef[]>("list_all_playlists", { root })),
  );
  return perRoot.flat();
}

// --- Shared leaf-row list (library navigator) ---------------------------------
//
// One builder for every track list under the Files-tab navigator (Songs, and —
// later — album / artist / playlist detail). It encodes the leaf-row behavior
// once: single-click select (cmd/shift extend), double-click / hover-play, the
// row context menu, and drag-to-playlist — reusing the very primitives the queue
// and tree rows use, so nothing here is a third implementation.
//
// Selection uses navSel — the navigator's own TrackSelection instance, separate
// from the queue's (queueSel). The two panes share row *objects* (a track added to
// the queue from this list is the very same SearchTrack), so a single shared Set
// would highlight a selection in both panes at once; separate instances keep each
// pane's selection its own (see makeTrackSelection and the nav-selection painter in
// setupEffects).
//
// Play semantics: like a browse-tree track, double-click / hover-play lands on the
// now-playing hero and plays *in context*, the whole list becoming the implicit
// pool so auto-advance, shuffle, and repeat carry on through it. It is deliberately
// NOT an explicit queue: play just plays (no right-pane queue chrome); "Add to
// queue" stays the only verb that builds one. It differs from playTreeTrack in one
// way: the pool is a synthetic `queue:` parent (not a real folder), so
// queueIsActivePool() is true and play-after-the-list-ends restarts from the top —
// the same start-of-pool restart the browse tree now uses (see togglePlayPause).


// The leaf list currently shown in the navigator, so the reactive nav-selection
// painter can map its object-keyed Set back to rows by view index (mirrors how
// the queue painter reads openListTracks()).

export function renderLeafTrackList(
  tracks: SearchTrack[],
  ctx: LeafListContext,
): HTMLElement {
  app.navLeafTracks = tracks;
  const ul = h("div", { class: "nav-list" });

  // Play from `index` in context (cf. playTreeTrack): select the row so it stays
  // highlighted, drop the queue-row highlight, dismiss any queue/playlist chrome
  // (hero only), then play with the whole list as the pool (a synthetic `queue:`
  // parent). These leaf lists carry no missing rows, so the view index is the
  // playable index.
  const playAt = (t: SearchTrack, index: number): void => {
    navSel.single(t);
    const parent = syntheticParent(ctx.syntheticPath, ctx.title, tracks);
    queuePlayingIndex.value = null;
    resetToLonePlayback();
    playFile(parent.children[index], parent, index);
  };

  tracks.forEach((t, i) => {
    // Album track lists carry the file's metadata track number (matching the
    // browse tree), so show it; flat lists (Songs) leave it null and fall back to
    // the positional row index. A metadata number of 0 is treated as absent.
    const label = String(t.track ? t.track : i + 1);
    const numText = h("span", {
      class: "nav-num-text",
      text: label,
      // Numbers up to 3 digits sit centered in the gutter at full size (see .nav-num
      // CSS). 4+ digit numbers — 1000th track and beyond — would overflow that
      // footprint, so shrink them to the 3-digit width (tabular digits are equal
      // width, so N digits fit 3 digits' width at scale 3/N). Self-limiting: the
      // number never grows past the 3-digit footprint, it just gets smaller, and
      // that only bites at track counts (10k+, 100k+) real libraries never reach.
      style: label.length > 3 ? { "font-size": `${3 / label.length}em` } : {},
    });
    // Number gutter that gives way to a hover play button, matching the queue and
    // tree track rows (see .nav-num CSS).
    const num = h(
      "span",
      { class: "nav-num" },
      numText,
      h("button", {
        class: "row-play",
        attrs: { type: "button", "aria-label": "Play" },
        on: {
          click: (e) => {
            e.stopPropagation();
            playAt(t, i);
          },
        },
      }),
    );

    const secondaryText = [t.artist, t.album].filter(Boolean).join(" · ");
    const cell = h(
      "span",
      { class: "nav-cell" },
      h("span", {
        class: "nav-primary",
        text: t.title ?? (t.path.split(/[\\/]/).pop() ?? t.path),
      }),
      secondaryText && h("span", { class: "nav-secondary", text: secondaryText }),
    );

    const row = h(
      "div",
      {
        class: "nav-track-row",
        // View index, so the reactive painter maps the object-keyed selection back
        // to rows without relying on unique paths.
        data: { rowIndex: i },
        on: {
          click: (e) => {
            // Note: lastSelectionPane is left untouched — the navigator is a distinct
            // surface from the right-pane list, and keyboard Enter-to-play for it is
            // deferred (see plan.md Phase 1's "keyboard back shortcut is still TBD").
            if (e.metaKey || e.ctrlKey) {
              navSel.toggle(t);
              return;
            }
            if (e.shiftKey) {
              navSel.rangeTo(t, tracks);
              return;
            }
            navSel.single(t);
          },
          dblclick: () => playAt(t, i),
          contextmenu: (e) => {
            e.preventDefault();
            // Finder-style: right-clicking outside the selection makes this the
            // selection; inside a multi-selection it's kept.
            if (!navSel.signal.peek().has(t)) navSel.single(t);
            const sel = navSel.resolveIn(tracks);
            if (sel.length > 1) {
              showContextMenu(e.clientX, e.clientY, [
                { label: `Add ${sel.length} to queue`, action: () => addToQueue(sel) },
                addToPlaylistItem(() => sel),
                showInFinderItem(sel[0].path),
              ]);
            } else {
              // A plain click only selects here (unlike the tree), so the menu leads
              // with an explicit Play; then the list-building verbs and the per-track
              // navigation (Play artist / album when tagged), matching the tree order.
              showContextMenu(e.clientX, e.clientY, [
                { label: "Play", action: () => playAt(t, i) },
                { label: "Add to queue", action: () => addToQueue([t]) },
                addToPlaylistItem(() => [t]),
                ...trackContextItems({ artist: t.artist, album: t.album, albumArtist: null }),
                editMetadataItem(t.path),
                showInFinderItem(t.path),
              ]);
            }
          },
          // Drag a row (or the whole selection) into an open playlist/queue list,
          // like a tree track. Pointer-based so it coexists with the native OS
          // file-drop; the 5px threshold keeps a plain click a select/play.
          pointerdown: (e) => {
            const selSet = navSel.signal.peek();
            const dragTracks =
              selSet.has(t) && selSet.size > 1 ? navSel.resolveIn(tracks) : [t];
            startTrackDrag(e, dragTracks);
          },
        },
      },
      num,
      cell,
    );
    if (navSel.signal.peek().has(t)) row.classList.add("selected");

    ul.appendChild(row);
  });
  return ul;
}

// Plays a queue row by its index (not path, so a duplicated track resolves to
// the clicked instance). This is the sole way to (re)enter the queue: it makes
// the queue the engine's active pool. If the queue is already the pool, reuse
// its synthetic parent; if it was merely stashed while a folder/stream/lone
// track played, rebuild the parent from the queue tracks so playback moves into
// it. activeQueue (the queue data) is untouched.
// `poolIndex` addresses the *playable* pool (renderQueue skips missing rows when
// it computes the index), never the view. A browsed playlist keeps its missing
// rows on screen; the pool is built from just the playable ones, so playing from
// it doesn't collapse the view. When the queue is already the active pool,
// currentParent.children *is* that playable pool.
export function playQueueTrack(poolIndex: number): void {
  const q = activeQueue.value;
  if (!q) return;
  const parent = queueIsActivePool() && app.currentParent
    ? app.currentParent
    : syntheticParent(
        `queue:active:${Date.now()}`,
        q.title,
        q.tracks.filter((t) => !t.missing),
      );
  const node = parent.children[poolIndex];
  if (!node) return;
  playFile(node, parent, poolIndex);
}

// Plays a file from outside the library (passed in via OS file association).
// Intentionally leaves currentNode/currentParent null so the tree is not
// touched, no row is highlighted, and album-advance on end is a no-op. The
// next library or stream selection replaces this state entirely.
// Routes a file delivered by an OS file association (Finder double-click, "open
// with", cold-start arg). A playlist opens for browsing (view + curate) like a
// tree single-click; any other file is an audio track and plays.
function openAssociatedFile(path: string): void {
  if (/\.m3u8?$/i.test(path)) {
    void browsePlaylistPath(path);
  } else {
    void openExternalFile(path);
  }
}

async function openExternalFile(path: string): Promise<void> {
  let meta: TrackMeta;
  try {
    meta = await invoke<TrackMeta>("prepare_external_file", { path });
  } catch (e) {
    console.error("prepare_external_file failed", path, e);
    return;
  }
  // Leaves currentParent null so the tree is untouched, no row is highlighted,
  // and album-advance is a no-op (single-track queue). Lone playback: dismiss
  // any open queue/playlist; null the highlight since this plays outside it.
  resetToLonePlayback();
  queuePlayingIndex.value = null;
  app.currentParent = null;
  currentNodePath.value = null;
  currentStreamUrl.value = null;
  isStream.value = false;
  currentTime.value = 0;
  duration.value = 0;
  app.queueEnded = false;
  app.lastQueue = [path];
  app.lastIndex = 0;
  app.shuffleBag = [];
  const fallback = path.split(/[\\/]/).pop() ?? path;
  setNowPlaying(meta.title ?? fallback, meta.artist, meta.album);
  void loadArt(path);
  void engine.play([path], 0);
}

function clearArt(): void {
  app.artRequestId++;
  npArt.value = null;
}

export async function loadArt(path: string): Promise<void> {
  await applyArt(() => invoke<string | null>("get_art", { path }), path);
}

// Station art declared in the stream stream list, fetched by the backend (the
// CSP forbids remote/file <img> sources, so it arrives as a data URL just
// like embedded track art).
async function loadStreamArt(image: string): Promise<void> {
  await applyArt(() => invoke<string | null>("get_stream_image", { image }), image);
}

async function applyArt(
  fetchArt: () => Promise<string | null>,
  source: string,
): Promise<void> {
  const id = ++app.artRequestId;
  // Note: we intentionally do NOT clear npArt here. Keeping the previous
  // track's art on screen until the new one is fetched and decoded avoids a
  // black flash on track change — most noticeably between tracks of the same
  // album, where the art is identical and shouldn't visibly change at all.
  let dataUrl: string | null;
  try {
    dataUrl = await fetchArt();
  } catch (e) {
    console.error("art load failed for", source, e);
    return;
  }
  if (id !== app.artRequestId) return;
  if (dataUrl) {
    // Decode off-screen so the on-screen swap is instantaneous rather than
    // showing a half-painted image.
    const img = new Image();
    img.src = dataUrl;
    try {
      await img.decode();
    } catch {
      /* decode can reject on detached images; assign anyway */
    }
    if (id !== app.artRequestId) return;
  }
  npArt.value = dataUrl;
}

// --- Event wiring ---

function setupTabs(): void {
  const tabs = document.querySelectorAll<HTMLButtonElement>(".tab");
  for (const btn of tabs) {
    btn.addEventListener("click", () => {
      const next = btn.dataset.tab as "files" | "streams";
      if (next === activeTab.value) {
        // Re-clicking the already-active tab. For Files, this is the iOS-style
        // "tap the active tab to pop home" accelerator: collapse any drill-down
        // back to the root menu. (Deciding it here, before activeTab changes,
        // avoids racing the effect that toggles the button's .active class.)
        if (next === "files") popNavToRoot();
        return;
      }
      // Switching tabs drops the sidebar selection — the tree's and the stream's
      // highlight are both per-tab, so leaving one behind the other tab would be a
      // stale, invisible selection (and a stray Enter target).
      clearTreeSelection();
      selectedStreamUrl.value = null;
      if (app.lastSelectionPane !== "list") app.lastSelectionPane = null;
      activeTab.value = next;
      void persistActiveTab();
    });
  }
}

// A per-track mode (shuffle on, or repeat-one) needs the frontend to choose the
// next track, but straight play hands the whole album to the engine for gapless
// auto-advance. When such a mode turns on mid-album, drop that queued tail so
// the change takes effect at the current track's end — the engine keeps playing
// the current track untouched, then reports queue-ended and handleEnded picks
// the next track. lastQueue.length <= 1 means the engine already holds only the
// current track (single-track mode, search hit, external file), so there's
// nothing to drop.
function applyModeChange(): void {
  const perTrack = shuffleMode.value || repeatMode.value === "one";
  if (perTrack && !isStream.value && app.lastQueue.length > 1) {
    void engine.clearUpcoming();
    if (currentNodePath.value) {
      app.lastQueue = [currentNodePath.value];
      app.lastIndex = 0;
    }
  }
}

// Reconcile the engine's queued tail with an autoadvance setting that just
// changed for the *currently playing* context. Under a per-track mode (shuffle /
// repeat-one) the engine already holds only the current track, so there's
// nothing to reconcile. Otherwise: turning autoadvance off drops the queued tail
// (clearUpcoming) so the current track finishes and then stops; turning it on
// re-extends the engine with the rest of the pool so gapless auto-advance
// resumes from where playback sits. Callers gate on the changed context matching
// what's playing, so autoadvanceEnabled() here reads the setting that changed.
function applyAutoadvanceChange(): void {
  if (isStream.value) return;
  if (shuffleMode.value || repeatMode.value === "one") return;
  const current = currentNodePath.value;
  if (!current) return; // nothing playing (or a drained queue) — next play uses it
  if (autoadvanceEnabled()) {
    // Re-extend: hand the engine the tail after the current track for gapless.
    const pool = poolPaths();
    // Use the live row index in the queue pool so a duplicate track resolves to
    // the instance actually playing, not the first path match.
    const idx = queueIsActivePool() && queuePlayingIndex.value != null
      ? queuePlayingIndex.value
      : pool.indexOf(current);
    if (idx >= 0 && idx < pool.length - 1) {
      void engine.append(pool.slice(idx + 1));
      app.lastQueue = pool;
      app.lastIndex = idx;
    }
  } else if (app.lastQueue.length > 1) {
    // Drop the tail so the current track is the last thing the engine plays.
    void engine.clearUpcoming();
    app.lastQueue = [current];
    app.lastIndex = 0;
  }
}

// Apply the autoadvance toggle from the OS Playback menu: update the signal,
// persist it, and — since it's global — reconcile the engine for whatever is
// playing so the change takes effect at the current track's end (not the queue's).
function setAutoadvance(enabled: boolean): void {
  if (autoadvance.value === enabled) return;
  autoadvance.value = enabled;
  void persistAutoadvance();
  if (hasTrack.value) applyAutoadvanceChange();
}

const persistAutoadvance = async (): Promise<void> => {
  await app.store.set(KEY_AUTOADVANCE, autoadvance.value);
  await app.store.save();
};

export const persistActiveTab = async (): Promise<void> => {
  await app.store.set(KEY_ACTIVE_TAB, activeTab.value);
  await app.store.save();
};

const persistPlaybackModes = async (): Promise<void> => {
  await app.store.set(KEY_SHUFFLE, shuffleMode.value);
  await app.store.set(KEY_REPEAT, repeatMode.value);
  await app.store.save();
};

// Shared by the toolbar button and the Playback menu so both take the same path.
function toggleShuffle(): void {
  shuffleMode.value = !shuffleMode.value;
  // Seed the bag so a shuffle turned on mid-album has a full cycle ready;
  // clear it when turning shuffle off.
  if (shuffleMode.value) refillShuffleBag(currentNodePath.value);
  else app.shuffleBag = [];
  applyModeChange();
  void persistPlaybackModes();
}

function setRepeatMode(mode: RepeatMode): void {
  if (repeatMode.value === mode) return;
  repeatMode.value = mode;
  applyModeChange();
  void persistPlaybackModes();
}

function setupPlaybackModes(): void {
  modeShuffleBtn.addEventListener("click", toggleShuffle);
  modeRepeatBtn.addEventListener("click", () => {
    // Cycle off → all → one → off.
    setRepeatMode(
      repeatMode.value === "off" ? "all" : repeatMode.value === "all" ? "one" : "off",
    );
  });
}

function setupSplitter(initialWidth: string | null): void {
  if (initialWidth) {
    document.documentElement.style.setProperty("--left-width", initialWidth);
  }

  splitterEl.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const mainEl = document.getElementById("main-view") as HTMLElement;
    const mainLeft = mainEl.getBoundingClientRect().left;
    document.body.classList.add("dragging");
    splitterEl.classList.add("dragging");

    const onMove = (ev: MouseEvent) => {
      const min = 120;
      const max = mainEl.getBoundingClientRect().width - 200;
      const width = Math.max(min, Math.min(max, ev.clientX - mainLeft));
      document.documentElement.style.setProperty("--left-width", `${width}px`);
    };
    const onUp = async () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.classList.remove("dragging");
      splitterEl.classList.remove("dragging");
      const final = getComputedStyle(document.documentElement)
        .getPropertyValue("--left-width")
        .trim();
      if (final) {
        await app.store.set(KEY_SPLITTER_WIDTH, final);
        await app.store.save();
      }
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}

// Last size the window had in each layout mode, in logical (CSS) px. Seeded
// from the store on launch and updated on every resize; the double-click toggle
// resizes to whichever of these belongs to the mode it's switching into.
let normalSize = { ...DEFAULT_NORMAL_SIZE };
let miniSize = { ...DEFAULT_MINI_SIZE };

// The layout mode is derived purely from the current viewport height, so a
// manual resize past the breakpoint and the double-click toggle land on the
// exact same CSS state. window.innerHeight is logical px (matches the media
// query and MINI_MAX_HEIGHT) regardless of display scale factor.
function isMiniViewport(): boolean {
  return window.innerHeight <= MINI_MAX_HEIGHT;
}

// Double-click handler for the now-playing area: jump across the breakpoint to
// the other mode, restoring that mode's last-used size. CSS reflows the rest.
async function toggleMiniPlayer(): Promise<void> {
  const target = isMiniViewport() ? normalSize : miniSize;
  await getCurrentWindow().setSize(new LogicalSize(target.width, target.height));
}

// Marquee the title/artist lines when they'd overflow the mini bar (they must
// stay on one line there). Off in normal mode, where the lines wrap freely. The
// distance/duration ride on CSS custom properties so the keyframes are static;
// speed is a fixed px/sec so long titles don't scroll faster than short ones.
function updateMarquee(pEl: HTMLElement): void {
  pEl.classList.remove("marquee");
  pEl.style.removeProperty("--marquee-distance");
  pEl.style.removeProperty("--marquee-duration");
  if (!isMiniViewport()) return;
  const overflow = pEl.scrollWidth - pEl.clientWidth;
  if (overflow <= 1) return;
  pEl.classList.add("marquee");
  pEl.style.setProperty("--marquee-distance", `-${overflow}px`);
  // Duration scales with distance so every line scrolls at the same rate
  // (~25 px/s of overflow, but the keyframes dwell at each end so only ~76% of
  // the duration is spent moving → ~33 px/s of visible motion). The 3s floor
  // keeps short overflows from whipping past.
  pEl.style.setProperty("--marquee-duration", `${Math.max(3, overflow / 25)}s`);
}

function updateMarquees(): void {
  updateMarquee(nowPlayingTitleEl);
  updateMarquee(nowPlayingArtistEl);
  updateMarquee(nowPlayingAlbumEl);
  updateMarquee(streamMetaSongEl);
  updateMarquee(streamMetaArtistEl);
}

async function setupWindowSize(
  appWindow: ReturnType<typeof getCurrentWindow>,
): Promise<void> {
  // A stored size only counts for a mode if it's on that mode's side of the
  // breakpoint. This self-heals if the breakpoint changes: a normal size that's
  // now in the mini range (or vice versa) is discarded in favor of the default,
  // so the toggle can never get stuck resizing to a size that stays in the same
  // mode.
  const storedNormal = await app.store.get<{ width: number; height: number }>(
    KEY_WINDOW_SIZE_NORMAL,
  );
  if (storedNormal && storedNormal.width > 0 && storedNormal.height > MINI_MAX_HEIGHT) {
    normalSize = storedNormal;
  }
  const storedMini = await app.store.get<{ width: number; height: number }>(
    KEY_WINDOW_SIZE_MINI,
  );
  if (storedMini && storedMini.width > 0 && storedMini.height > 0 && storedMini.height <= MINI_MAX_HEIGHT) {
    miniSize = storedMini;
  }
  // Always start in normal mode. Mini hides the library/settings, so launching
  // into it would leave the user unable to pick anything to play without first
  // expanding the window.
  await appWindow.setSize(new LogicalSize(normalSize.width, normalSize.height));

  // Persist the current logical size under the active mode's key. Reading
  // window.inner* (rather than the resize event's physical payload) keeps
  // storage in logical px, so restored sizes stay stable across scale factors.
  const persistSize = debounce(async () => {
    // Skip while zoomed (macOS green-button "Zoom"): AppKit owns the un-zoom
    // restore, so recording the transient zoomed size would clobber the mode's
    // real remembered size. Without this, zooming out of mini then expanding
    // lands on the zoomed size instead of the last true normal size.
    if (await appWindow.isMaximized()) return;
    const width = window.innerWidth;
    const height = window.innerHeight;
    if (width <= 0 || height <= 0) return;
    if (isMiniViewport()) {
      miniSize = { width, height };
      await app.store.set(KEY_WINDOW_SIZE_MINI, miniSize);
    } else {
      normalSize = { width, height };
      await app.store.set(KEY_WINDOW_SIZE_NORMAL, normalSize);
    }
    await app.store.save();
  }, 400);

  // Keep the Window menu's "Mini Player" checkmark mirroring the current mode.
  // Mode is derived from viewport height, so sync on every resize (manual drags
  // across the breakpoint included) and once now for the initial normal-mode start.
  const syncMiniplayerChecked = () => {
    void invoke("set_miniplayer_checked", { mini: isMiniViewport() });
  };
  syncMiniplayerChecked();

  window.addEventListener("resize", () => {
    persistSize();
    syncMiniplayerChecked();
  });

  const storedPos = await app.store.get<{ x: number; y: number }>(
    KEY_WINDOW_POSITION,
  );
  if (storedPos) {
    await appWindow.setPosition(new PhysicalPosition(storedPos.x, storedPos.y));
  }

  const persistPos = debounce(async (x: number, y: number) => {
    await app.store.set(KEY_WINDOW_POSITION, { x, y });
    await app.store.save();
  }, 400);

  await appWindow.onMoved(({ payload }) => {
    persistPos(payload.x, payload.y);
  });
}

function setupSettings(): void {
  // Settings opens from the native application menu (Pudding → Settings…, ⌘,),
  // which emits "open-settings"; the topbar's old gear is now the mini-player
  // toggle. The Back button in the panel returns to now-playing.
  void listen("open-settings", () => { settingsOpen.value = true; });
  settingsBackBtn.addEventListener("click", () => { settingsOpen.value = false; });

  // The get-started prompts' inline "settings" links (Files: no library root,
  // Streams: no stream list path) open the settings panel.
  for (const id of ["files-empty-settings", "streams-empty-settings"]) {
    document
      .getElementById(id)
      ?.addEventListener("click", () => { settingsOpen.value = true; });
  }

  // External links must go to the OS browser, not navigate the webview.
  document.addEventListener("click", (e) => {
    const link = (e.target as Element).closest?.("a[href^='http']");
    if (!(link instanceof HTMLAnchorElement)) return;
    e.preventDefault();
    void openUrl(link.href);
  });
}

function setupPlayerControls(): void {
  playPauseBtn.addEventListener("click", togglePlayPause);
  prevBtn.addEventListener("click", skipPrev);
  nextBtn.addEventListener("click", skipNext);

  document.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (isTextInputTarget(e.target)) return;

    if (e.key === "Delete" || e.key === "Backspace") {
      const list = openListTracks();
      const sel = queueSel.resolveIn(list);
      if (sel.length === 0) return;
      e.preventDefault();
      // Keep the keyboard selection on the row that fills the first deleted slot
      // so repeated Delete keeps clearing rows without re-reaching for the mouse.
      const fill = fillRowAfterRemoval(list, sel);
      removeCuratedTracks(sel);
      if (fill) {
        queueSel.single(fill);
        app.lastSelectionPane = "list";
      }
      return;
    }

    if (e.key === "Enter") {
      // Enter commits the selected row (the play a plain click no longer does),
      // in whichever pane the user last selected in.
      if (playSelectedRow()) e.preventDefault();
      return;
    }

    if (e.key === " " || e.code === "Space") {
      if (e.repeat) return;
      e.preventDefault();
      togglePlayPause();
      return;
    }

    if (e.key === "ArrowUp") {
      e.preventDefault();
      setVolume(volume.value + 0.1);
      return;
    }

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setVolume(volume.value - 0.1);
      return;
    }

    if (e.key === "ArrowLeft") {
      if (isStream.value) return;
      e.preventDefault();
      seekBy(-10);
      return;
    }

    if (e.key === "ArrowRight") {
      if (isStream.value) return;
      e.preventDefault();
      seekBy(10);
      return;
    }
  });

  seekBar.addEventListener("input", () => {
    seekTo(Number(seekBar.value));
  });
}

// Shared by the volume button and the Playback menu's Mute item.
function toggleMute(): void {
  setVolume(volume.value > 0 ? 0 : lastNonZeroVolume);
}

function setupVolumeControl(): void {
  volumeBtn.addEventListener("click", toggleMute);

  volumeControlEl.addEventListener("mouseenter", () => {
    volumePopoverOpen.value = true;
  });

  volumeControlEl.addEventListener("mouseleave", () => {
    volumePopoverOpen.value = false;
  });

  volumeBar.addEventListener("input", () => {
    setVolume(Number(volumeBar.value));
  });
}

// --- Effects: declarative DOM sync ---

// What the stream-meta block currently shows, tracked outside the signal so
// title changes can cross-fade: fade the old text out, swap, fade the new one
// in. Re-emits of the identical title (the engine re-announces on every
// stream reconnect, e.g. pause/resume) are no-ops.
let renderedStreamMeta: { song: string; artist: string | null } | null = null;
let streamMetaFadeTimer: ReturnType<typeof setTimeout> | undefined;

function applyStreamMeta(
  meta: { song: string; artist: string | null } | null,
): void {
  renderedStreamMeta = meta;
  streamMetaSongInner.textContent = meta?.song ?? "";
  streamMetaArtistInner.textContent = meta?.artist ?? "";
  streamMetaArtistEl.classList.toggle("hidden", !meta?.artist);
  updateMarquee(streamMetaSongEl);
  updateMarquee(streamMetaArtistEl);
}

// The live-pulse keyframes start and end on the paused gray, so stopping
// doesn't cut the pulse off mid-cycle: clamp the infinite animation to the
// end of its current iteration, then pin the .paused color once it lands
// there. Resuming mid-wind-down just lifts the clamp.
function setLiveIndicatorPaused(paused: boolean): void {
  const pulse = liveIndicatorEl
    .getAnimations()
    .find(
      (a): a is CSSAnimation =>
        a instanceof CSSAnimation && a.animationName === "live-pulse",
    );
  if (!paused) {
    liveIndicatorEl.classList.remove("paused");
    if (pulse) {
      pulse.onfinish = null;
      pulse.effect?.updateTiming({ iterations: Infinity });
    }
    return;
  }
  if (!pulse || pulse.playState !== "running") {
    liveIndicatorEl.classList.add("paused");
    return;
  }
  const time = typeof pulse.currentTime === "number" ? pulse.currentTime : 0;
  const timing = pulse.effect?.getComputedTiming();
  const duration = typeof timing?.duration === "number" ? timing.duration : 0;
  if (duration <= 0) {
    liveIndicatorEl.classList.add("paused");
    return;
  }
  pulse.effect?.updateTiming({
    iterations: Math.max(1, Math.ceil(time / duration)),
    fill: "forwards",
  });
  pulse.onfinish = () => liveIndicatorEl.classList.add("paused");
}

function setupEffects(): void {
  effect(() => {
    nowPlayingEmptyEl.classList.toggle("hidden", hasTrack.value);
  });
  effect(() => {
    nowPlayingTitleInner.textContent = npTitle.value;
    updateMarquee(nowPlayingTitleEl);
  });
  effect(() => {
    nowPlayingArtistInner.textContent = npArtist.value ?? "";
    nowPlayingArtistEl.classList.toggle("hidden", !npArtist.value);
    updateMarquee(nowPlayingArtistEl);
  });
  effect(() => {
    nowPlayingAlbumInner.textContent = npAlbum.value ?? "";
    nowPlayingAlbumEl.classList.toggle("hidden", !npAlbum.value);
    updateMarquee(nowPlayingAlbumEl);
  });
  // The nav bar: the single line above the transport that carries the source
  // context and the button swapping between the two faces (hero / list). See
  // renderNavBar for the state table.
  effect(renderNavBar);
  effect(() => {
    liveIndicatorEl.classList.toggle("hidden", !isStream.value);
    setLiveIndicatorPaused(!isPlaying.value);
  });
  effect(() => {
    // In the layout (invisibly) for the whole stream; .visible fades the text
    // in once metadata exists. Layout-inert either way — see the CSS.
    const meta = npStreamMeta.value;
    const streaming = isStream.value;
    clearTimeout(streamMetaFadeTimer);
    nowPlayingStreamMetaEl.classList.toggle("hidden", !streaming);
    if (!streaming || !meta) {
      // Leaving streams, or a new stream starting (playStream nulls the
      // meta): reset instantly so the previous track can't linger over the
      // fresh station name.
      applyStreamMeta(null);
      nowPlayingStreamMetaEl.classList.remove("visible");
      return;
    }
    if (
      renderedStreamMeta?.song === meta.song &&
      renderedStreamMeta?.artist === meta.artist
    ) {
      return;
    }
    if (!renderedStreamMeta) {
      // First title of this stream: fade in over the reserved spot.
      applyStreamMeta(meta);
      nowPlayingStreamMetaEl.classList.add("visible");
    } else {
      // Song changed mid-stream: fade out, swap once invisible, fade in.
      // The delay matches the fade-out duration in the CSS.
      nowPlayingStreamMetaEl.classList.remove("visible");
      streamMetaFadeTimer = setTimeout(() => {
        applyStreamMeta(meta);
        nowPlayingStreamMetaEl.classList.add("visible");
      }, 250);
    }
  });
  effect(() => {
    const url = npArt.value;
    if (url) {
      // Avoid reassigning an identical src (same-album tracks): a no-op set
      // would still trigger a reload/repaint and flicker.
      if (nowPlayingArtEl.getAttribute("src") !== url) {
        nowPlayingArtEl.src = url;
      }
      nowPlayingArtEl.classList.remove("hidden");
    } else {
      nowPlayingArtEl.removeAttribute("src");
      nowPlayingArtEl.classList.add("hidden");
    }
    // Art presence changes the width left for the text, so the lines may start
    // or stop overflowing.
    updateMarquees();
  });

  effect(() => {
    playPauseBtn.textContent = isPlaying.value ? "⏸" : "▶";
    playPauseBtn.setAttribute("aria-label", isPlaying.value ? "Pause" : "Play");
  });
  effect(() => {
    // Idle, the play button doesn't go dead — it "starts the library" by playing
    // the first Files entry (see togglePlayPause/startLibrary), preserving the
    // ready-to-go energy. It's only truly disabled when there's nothing to start:
    // no track loaded and an empty/absent library.
    playPauseBtn.disabled = !hasTrack.value && !libraryHasContent.value;
  });
  effect(() => {
    // Streams have no track to step between, so hide prev/next entirely (like
    // the seek row) rather than leave dead chrome. Otherwise prev is live
    // whenever play is (it restarts or steps back), and next disables at the
    // genuine end of the line so a dead press reads as unavailable.
    prevBtn.classList.toggle("hidden", isStream.value);
    nextBtn.classList.toggle("hidden", isStream.value);
    prevBtn.disabled = !hasTrack.value;
    nextBtn.disabled = !hasNextTrack();
  });
  effect(() => {
    // Streams swap the whole seek row for the live indicator: no timeline to
    // scrub, so a disabled bar would just be dead chrome.
    seekBar.disabled = isStream.value;
    seekBar.classList.toggle("hidden", isStream.value);
    timeCurrentEl.classList.toggle("hidden", isStream.value);
    timeRemainingEl.classList.toggle("hidden", isStream.value);
  });
  effect(() => {
    const t = currentTime.value;
    const d = duration.value;
    seekBar.max = String(d);
    seekBar.value = String(t);
    const pct = d > 0 ? (t / d) * 100 : 0;
    seekBar.style.setProperty("--progress", `${pct}%`);
  });
  effect(() => {
    timeCurrentEl.textContent = formatTime(currentTime.value);
    timeRemainingEl.textContent = "-" + formatTime(
      Math.max(0, duration.value - currentTime.value),
    );
  });

  effect(() => {
    const v = volume.value;
    void engine.setVolume(v);
    volumeBar.value = String(v);
    volumeBar.style.setProperty("--progress", `${v * 100}%`);
    const waves = volumeBtn.querySelectorAll<SVGPathElement>(".volume-wave");
    waves.forEach((w, i) => {
      w.style.opacity = String(i === 0 ? v : v >= 1 ? 1 : 0);
    });
  });
  effect(() => {
    volumePopover.classList.toggle("open", volumePopoverOpen.value);
  });

  effect(() => {
    const path = currentNodePath.value;
    const url = currentStreamUrl.value;
    const queue = activeQueue.value;
    // A live queue row is the reactive signal for "a queue owns the playhead":
    // non-null only while a queue is the audible pool, null for folder play (and
    // when a queue rests drained). Drives this effect where queueIsActivePool()
    // — which reads non-reactive currentParent — cannot, so the highlight moves
    // even when the file path is unchanged (same track replayed from the tree).
    const queueOwnsPlayhead = queuePlayingIndex.value !== null;
    // A browsed playlist marks its tree row as "open" (a selection background),
    // independent of what's playing — so the panel shows which playlist is open
    // even when a different source owns the playhead.
    const browsed = browsedPlaylist.value;
    document
      .querySelectorAll(
        "#folder-tree .node-label.playing, #folder-tree .node-label.open, #streams-list .node-label.playing",
      )
      .forEach((el) => el.classList.remove("playing", "open"));
    // The now-playing accent marks the context that owns the playhead, not every
    // occurrence of the same file. When a playlist/queue is the active pool it
    // carries the highlight in the right pane, so the tree's copy of the same
    // track stays plain.
    if (path && !queueOwnsPlayhead) {
      document
        .querySelector(`#folder-tree .node-label[data-path="${CSS.escape(path)}"]`)
        ?.classList.add("playing");
    }
    // A playlist playing from the tree lights up its own row (the .m3u8 node,
    // keyed by sourcePath) instead of its member track — the tree's stand-in for
    // "playing from here".
    if (queueOwnsPlayhead && queue?.kind === "playlist" && queue.sourcePath) {
      document
        .querySelector(`#folder-tree .node-label[data-path="${CSS.escape(queue.sourcePath)}"]`)
        ?.classList.add("playing");
    }
    if (url) {
      document
        .querySelector(`#streams-list .node-label[data-stream-url="${CSS.escape(url)}"]`)
        ?.classList.add("playing");
    }
    if (browsed?.sourcePath) {
      document
        .querySelector(`#folder-tree .node-label[data-path="${CSS.escape(browsed.sourcePath)}"]`)
        ?.classList.add("open");
    }
  });

  // Paint the multi-select background reactively, so cmd/shift-click updates the
  // tree without a full re-render (renderNode reapplies it on any rebuild).
  effect(() => {
    const sel = treeSelection.value;
    document
      .querySelectorAll("#folder-tree .node-label.selected")
      .forEach((el) => el.classList.remove("selected"));
    for (const path of sel) {
      document
        .querySelector(`#folder-tree .node-label[data-path="${CSS.escape(path)}"]`)
        ?.classList.add("selected");
    }
  });

  // Paint the single-selected stream row reactively, so a click highlights it
  // without a full renderStreams rebuild (which reapplies it on any rebuild).
  effect(() => {
    const url = selectedStreamUrl.value;
    document
      .querySelectorAll("#streams-list .node-label.selected")
      .forEach((el) => el.classList.remove("selected"));
    if (url) {
      document
        .querySelector(`#streams-list .node-label[data-stream-url="${CSS.escape(url)}"]`)
        ?.classList.add("selected");
    }
  });

  effect(() => {
    const tab = activeTab.value;
    document.querySelectorAll<HTMLButtonElement>(".tab").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.tab === tab);
    });
    document.getElementById("tab-files")?.classList.toggle("hidden", tab !== "files");
    document.getElementById("tab-streams")?.classList.toggle("hidden", tab !== "streams");
    // The lens tab bar belongs to Files only.
    document.getElementById("lens-footer")?.classList.toggle("hidden", tab !== "files");
  });

  // Until a library folder is configured, the whole Files panel is a get-started
  // prompt instead of the lens springboard. render() owns hiding the navigator,
  // folder tree and create button (it already gates those), so just re-render it
  // when the root-set state flips.
  effect(() => {
    libraryRootSet.value;
    renderNav();
  });

  // Streams counterpart: until a stream list path is set, swap the streams list for
  // the get-started prompt. Simpler than Files (no navigator) — just the two.
  effect(() => {
    const noStreamList = !streamListPathSet.value;
    document.getElementById("streams-empty")?.classList.toggle("hidden", !noStreamList);
    streamsContainer.classList.toggle("hidden", noStreamList);
    // The Add-station button shows only for a writable (valid, local) list. When
    // the list stops being writable, drop any open stream editor so a stale form
    // can't linger (a metadata editor is unrelated, so leave it be).
    const btn = document.getElementById("add-station-btn");
    btn?.classList.toggle("hidden", !streamListWritable.value);
    if (!streamListWritable.value && paneEditor.value === "stream") closePaneEditor();
  });

  // The two-face right pane, painted from the derived paneView. `has-nav` reveals
  // the nav bar whenever a list exists; `show-list` puts the list face up (else
  // the hero owns the pane). Reads queuePlayingIndex too so the highlighted/
  // scrolled row tracks advances (and clears when the queue is merely stashed),
  // even when paneView's own fields are unchanged.
  effect(() => {
    const { list, isSource, showList, nav } = paneView.value;
    queuePlayingIndex.value;
    const hasList = list !== null;
    nowPlayingPanel.classList.toggle("has-nav", hasList && nav !== null);
    nowPlayingPanel.classList.toggle("show-list", hasList && showList);
    renderQueue(list, isSource);
  });

  // The editor face: `.show-editor` takes the pane over whichever face was up while
  // a track's tags or a stream are being edited; clearing paneEditor reveals it
  // again (see openPaneEditor). Its own effect so it doesn't rebuild the queue list.
  effect(() => {
    nowPlayingPanel.classList.toggle("show-editor", paneEditor.value !== null);
  });

  // Paint the list-pane multi-select background reactively, so cmd/shift-click
  // updates it without a renderQueue rebuild (which would scroll to the playing
  // row on every click). Runs after the render effect above — both read the open
  // list — so it repaints on rebuilds too. Maps the object-keyed set back to rows
  // through each row's view index (paths aren't unique across duplicates).
  effect(() => {
    const sel = queueSel.signal.value;
    const tracks = openListTracks();
    queueListEl.querySelectorAll<HTMLElement>("li.queue-row").forEach((li) => {
      const t = tracks[Number(li.dataset.rowIndex)];
      li.classList.toggle("selected", !!t && sel.has(t));
    });
  });

  // The navigator's leaf rows (Songs, etc.) paint from navSel — their own
  // selection, independent of the queue's (see makeTrackSelection) — updating on
  // cmd/shift-click without a rebuild. navLeafTracks holds the list currently
  // shown; only the on-screen list ever writes it (asyncListBody drops a
  // superseded load whose host was detached), so its indices match the DOM rows.
  effect(() => {
    const sel = navSel.signal.value;
    document
      .querySelectorAll<HTMLElement>("#library-nav .nav-track-row")
      .forEach((el) => {
        const t = app.navLeafTracks[Number(el.dataset.rowIndex)];
        el.classList.toggle("selected", !!t && sel.has(t));
      });
  });

  effect(() => {
    const open = settingsOpen.value;
    settingsPanel.classList.toggle("hidden", !open);
    nowPlayingPanel.classList.toggle("hidden", open);
    miniplayerBtn.classList.toggle("hidden", open);
    settingsBackBtn.classList.toggle("hidden", !open);
    // Search targets the library/streams, not settings — hide it here too so the
    // whole action cluster (search + mode toggles) clears out together rather
    // than leaving a lone search box beside the Back button.
    searchEl.classList.toggle("hidden", open);
  });

  // The playback-mode toggles only act on the files queue, but we keep them
  // visible in the streams view too: they take little space, do no harm there,
  // and leaving them put avoids shuffling the search box as tabs switch. Only
  // settings hides them.
  effect(() => {
    playbackModesEl.classList.toggle("hidden", settingsOpen.value);
  });

  effect(() => {
    modeShuffleBtn.classList.toggle("active", shuffleMode.value);
    modeShuffleBtn.setAttribute("aria-pressed", String(shuffleMode.value));
  });

  effect(() => {
    const mode = repeatMode.value;
    modeRepeatBtn.classList.toggle("active", mode !== "off");
    modeRepeatBtn.classList.toggle("repeat-one", mode === "one");
    const label = mode === "all" ? "Repeat all" : mode === "one" ? "Repeat one" : "Repeat off";
    modeRepeatBtn.setAttribute("aria-label", label);
    modeRepeatBtn.title = label;
  });

  // Library-folder rows get their .invalid outline in renderLibraryRootRows
  // (per-row, driven by invalidLibraryRoots).
  effect(() => {
    streamListPathInput.classList.toggle("invalid", !streamListPathValid.value);
  });
}

// --- Init ---

async function init(): Promise<void> {
  if (navigator.userAgent.includes("Mac")) {
    document.body.classList.add("platform-mac");
  }

  const appWindow = getCurrentWindow();
  document.addEventListener("mousedown", (e) => {
    const target = e.target as HTMLElement | null;
    if (!target) return;
    if (target.closest("button, input, select, textarea, a, [role='slider']")) return;
    if (!target.closest("[data-tauri-drag-region]")) return;
    if (e.detail === 2) {
      void appWindow.toggleMaximize();
    } else {
      void appWindow.startDragging();
    }
  });

  // Double-click the art/title area (not the controls row) to toggle the mini
  // player. Not a drag region, so this never conflicts with the topbar's
  // double-click-to-maximize.
  const nowPlayingMainEl = document.querySelector("#now-playing-main") as HTMLElement;
  nowPlayingMainEl.addEventListener("dblclick", () => void toggleMiniPlayer());
  // Same gesture in the queue view, but only in the empty space around the
  // rows — double-clicking a row is reserved for playing it.
  const queueViewEl = document.querySelector("#queue-view") as HTMLElement;
  queueViewEl.addEventListener("dblclick", (e) => {
    if ((e.target as HTMLElement).closest(".queue-row")) return;
    void toggleMiniPlayer();
  });
  // Recompute the title/artist marquees on every resize (width change or a
  // mode switch across the breakpoint both change whether the lines overflow).
  window.addEventListener("resize", updateMarquees);
  // Mini-only expand button (shown where the mini-player toggle sits in full
  // view); its arrows are the mirror of that toggle's collapse glyph.
  const expandBtn = document.querySelector("#expand-btn") as HTMLButtonElement;
  expandBtn.addEventListener("click", () => void toggleMiniPlayer());

  bindDom();
  navBarBtnEl.addEventListener("click", toggleNavFace);
  navBarAltBtnEl.addEventListener("click", showSourceList);
  // Double-click the bar's text (not the button) toggles the mini player, like
  // the hero card it sits beneath.
  navBarTextEl.addEventListener("dblclick", () => void toggleMiniPlayer());
  // The metadata above is selectable text (copy "what's playing"), so a
  // double-click on it selects a word instead of bubbling to #now-playing-main's
  // mini-player toggle. The panel's art and empty space still toggle as before.
  for (const el of [
    nowPlayingTitleEl,
    nowPlayingArtistEl,
    nowPlayingAlbumEl,
    nowPlayingStreamMetaEl,
  ]) {
    el.addEventListener("dblclick", (e) => e.stopPropagation());
  }
  // Click-off deselect for the Files tab's own rows (the file-manager convention),
  // bound to the whole scrolling tab-panel (not just #folder-tree, which only grows
  // to its content) so the blank area below the last row deselects too. A click off
  // a nav-leaf row drops the navigator selection; a click off a tree row drops the
  // tree's multi-select. The queue is a separate surface, but selecting a row in
  // either Files pane already drops the queue's selection (see makeTrackSelection's
  // onSelect wiring), so this click-off doesn't need to touch it.
  (document.querySelector("#tab-files") as HTMLElement).addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    if (!target.closest(".nav-track-row")) navSel.clear();
    if (!target.closest(".node-label")) clearTreeSelection();
  });
  (document.querySelector("#create-playlist-btn") as HTMLButtonElement).addEventListener(
    "click",
    () => void menuNewPlaylist(),
  );
  (document.querySelector("#add-station-btn") as HTMLButtonElement).addEventListener(
    "click",
    () => openAddStationEditor(),
  );
  // Same click-off convention for the streams tab: a click below the rows (or on
  // any empty space in the tab-panel) drops the stream highlight.
  (document.querySelector("#tab-streams") as HTMLElement).addEventListener("click", (e) => {
    if (!(e.target as HTMLElement).closest(".node-label")) selectedStreamUrl.value = null;
  });
  miniplayerBtn.addEventListener("click", () => void toggleMiniPlayer());
  // Click-off deselect for the queue, mirroring the Files handler: a click off any
  // row drops the queue's own multi-select. Selecting a queue row already drops the
  // Files-tab selections (see makeTrackSelection's onSelect wiring), so this
  // click-off only needs to handle the queue's own.
  queueListEl.addEventListener("click", (e) => {
    if (!(e.target as HTMLElement).closest(".queue-row")) queueSel.clear();
  });
  queueCloseBtn.addEventListener("click", closeQueue);
  // Clicking anywhere on the title — the text or the hover pencil — starts an
  // inline rename; startTitleEdit no-ops when the header isn't a playlist.
  (document.querySelector("#queue-title") as HTMLElement).addEventListener("click", startTitleEdit);
  // Dropping onto the list's empty area (below the last row, or an empty playlist)
  // targets the end of the list — that case is resolved by updateDropTarget's
  // hit-test against the list box, so no container drop listener is needed.

  app.store = await load(STORE_FILE, { defaults: {}, autoSave: false });

  app.libraryRoots = (await app.store.get<string[]>(KEY_LIBRARY_ROOTS)) ?? [];
  // First run (key never set): adopt the default stream list the backend seeds
  // in the app data dir, and persist it so it shows in settings and can be
  // repointed. An explicit "" (user cleared the path) is respected, not reseeded.
  const storedStreamListPath = await app.store.get<string>(KEY_STREAM_LIST_PATH);
  let streamListPath = storedStreamListPath ?? "";
  if (storedStreamListPath === undefined) {
    try {
      streamListPath = await invoke<string>("default_stream_list_path");
      await app.store.set(KEY_STREAM_LIST_PATH, streamListPath);
      await app.store.save();
    } catch (e) {
      console.error("default_stream_list_path failed", e);
    }
  }
  const splitterWidth = (await app.store.get<string>(KEY_SPLITTER_WIDTH)) ?? null;
  const storedVolume = await app.store.get<number>(KEY_VOLUME);
  volume.value = typeof storedVolume === "number" ? Math.max(0, Math.min(1, storedVolume)) : 1;
  if (volume.value > 0) lastNonZeroVolume = volume.value;

  // Autoadvance (global, defaults on). Prefer the new key; fall back to the legacy
  // browsing setting so an existing user's off-preference carries over. Sync the
  // OS Playback-menu checkmark, then listen for the menu's toggle.
  autoadvance.value =
    (await app.store.get<boolean>(KEY_AUTOADVANCE)) ??
    (await app.store.get<boolean>(KEY_AUTOADVANCE_FILES)) ??
    true;
  void invoke("set_autoadvance_checked", { enabled: autoadvance.value });
  await listen<boolean>("menu:autoadvance", (event) => {
    setAutoadvance(event.payload);
  });

  // Playback modes (both default off). The button effects read these signals, so
  // setting them here syncs the toolbar; the shuffle bag is refilled lazily at
  // the next play, so no need to seed it now.
  shuffleMode.value = (await app.store.get<boolean>(KEY_SHUFFLE)) ?? false;
  const storedRepeat = await app.store.get<RepeatMode>(KEY_REPEAT);
  repeatMode.value =
    storedRepeat === "all" || storedRepeat === "one" ? storedRepeat : "off";

  // Keep the Playback-menu checkmarks in sync with the frontend's own state —
  // these effects fire on load (syncing the persisted values) and after any
  // toolbar or menu change. Mute reflects a zeroed volume.
  effect(() => {
    void invoke("set_shuffle_checked", { shuffle: shuffleMode.value });
  });
  effect(() => {
    void invoke("set_repeat_checked", { mode: repeatMode.value });
  });
  effect(() => {
    void invoke("set_mute_checked", { muted: volume.value === 0 });
  });

  // Recent playlists → the OS "Open Recent ▸" submenu. Load the persisted list
  // and push it into the native menu.
  app.recentPlaylists = (await app.store.get<RecentPlaylist[]>(KEY_RECENT_PLAYLISTS)) ?? [];
  syncRecentPlaylistsMenu();

  // The last Files-tab place, handed to the navigator below to restore on launch.
  const navLocation = (await app.store.get<NavStep[]>(KEY_NAV_LOCATION)) ?? [];

  // Restore the open sidebar tab. Set before setupEffects() so the tab effect
  // renders the right panel on first paint (no Files→Streams flash).
  const storedTab = await app.store.get<string>(KEY_ACTIVE_TAB);
  if (storedTab === "streams" || storedTab === "files") activeTab.value = storedTab;

  // Keep "Save Queue as Playlist" enabled only while an ephemeral queue is the active
  // pool (a saved playlist autosaves; nothing else is convertible). currentNodePath
  // is a signal, so this re-runs whenever playback moves in or out of the queue.
  effect(() => {
    void currentNodePath.value;
    void activeQueue.value;
    void invoke("set_save_playlist_enabled", { enabled: queueCanSaveAsPlaylist() });
  });

  // Keep "Move Playlist File…" enabled only while a playlist is open — browsed,
  // else playing (openPlaylistPath). There's no file to relocate otherwise, and
  // enabling it mirrors exactly what menuMovePlaylist would act on.
  effect(() => {
    void browsedPlaylist.value;
    void activeQueue.value;
    void invoke("set_move_playlist_enabled", { enabled: openPlaylistPath() != null });
  });

  // Playlist menu intents (New / Open… / Save / Move / Clear Recent), plus a
  // recent item carrying its own path.
  await listen<string>("menu:playlist", (event) => {
    switch (event.payload) {
      case "new":
        void menuNewPlaylist();
        break;
      case "open":
        void menuOpenPlaylist();
        break;
      case "save":
        void menuSavePlaylist();
        break;
      case "move":
        void menuMovePlaylist();
        break;
      case "recent-clear":
        app.recentPlaylists = [];
        void persistRecentPlaylists();
        syncRecentPlaylistsMenu();
        break;
    }
  });
  await listen<string>("menu:playlist-open-path", (event) => {
    void browsePlaylistPath(event.payload);
  });

  setupTabs();
  // Inject the leaf-list builder + backend loaders the navigator needs; keeping
  // them as deps (rather than a value import back into this entry module) avoids a
  // circular import while letting the navigator reuse the shared row behavior.
  initLibraryNav({
    listAllSongs: () => invoke<SearchTrack[]>("list_all_songs"),
    listAllArtists: () => invoke<SearchArtist[]>("list_all_artists"),
    listAllAlbums: () => invoke<SearchAlbum[]>("list_all_albums"),
    listAllPlaylists: loadAllPlaylists,
    artistAlbums: (artist) => invoke<SearchAlbum[]>("artist_albums", { artist }),
    artistAlbumlessTracks: (artist) =>
      invoke<SearchTrack[]>("artist_albumless_tracks", { artist }),
    albumTracks: (album, albumArtist) =>
      invoke<SearchTrack[]>("album_tracks", { album, albumArtist }),
    renderLeafTrackList,
    // A playlist row: single-click opens it in the right pane, double-click plays.
    openPlaylist: (path) => void browsePlaylistPath(path),
    playPlaylist: (path) => void playPlaylistPath(path),
    showArtistMenu: showArtistContextMenu,
    showAlbumMenu: showAlbumContextMenu,
    showPlaylistMenu: showPlaylistContextMenu,
    persistLocation: persistNavLocation,
    libraryRootSet: () => libraryRootSet.value,
  }, navLocation);
  setupPlaybackModes();
  await setupWindowSize(appWindow);
  setupSplitter(splitterWidth);
  setupSettings();
  setupSearch();
  setupPlayerControls();
  setupVolumeControl();
  setupEffects();

  renderLibraryRootRows();
  streamListPathInput.value = streamListPath;

  // The + under the library rows appends a folder via the same picker as a row's
  // Choose… button.
  libraryRootAddBtn.addEventListener("click", () => void browseLibraryRoot());
  streamListPathBrowseBtn.addEventListener("click", () => void browseStreamListPath());

  // The stream field also accepts a typed/pasted path: Enter commits (blur fires
  // "change"), and change re-reads the stream list via the same path as the
  // Choose… button. (Library rows wire their own inputs in renderLibraryRootRows.)
  streamListPathInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") streamListPathInput.blur();
  });
  streamListPathInput.addEventListener("change", () => {
    void setStreamListPath(streamListPathInput.value.trim());
  });

  await listen<ScanResult>("library-scanned", (event) => {
    if (!event.payload.ok) {
      console.error("library scan failed:", event.payload.error);
      return;
    }
    void refreshLibrary();
  });

  await listen<string>("open-file", (event) => {
    openAssociatedFile(event.payload);
  });

  // Next / previous from the OS Now Playing widget or hardware media keys.
  await listen("remote-next", () => skipNext());
  await listen("remote-prev", () => skipPrev());

  // Transport from the Playback menu: Play/Pause, plus Previous/Next whose
  // ⌘←/⌘→ accelerators double as the keyboard shortcut (and reveal it in the
  // menu). Same skipNext/Prev path as the media keys above.
  await listen<string>("menu:transport", (event) => {
    switch (event.payload) {
      case "playpause":
        togglePlayPause();
        break;
      case "prev":
        skipPrev();
        break;
      case "next":
        skipNext();
        break;
    }
  });

  // Playback-menu Shuffle / Repeat / Volume / Mute / Clear Queue. Each routes to
  // the same handler the toolbar uses, so state and persistence stay identical;
  // the sync effects above then re-check the menu items.
  await listen("menu:shuffle", () => toggleShuffle());
  await listen<string>("menu:repeat", (event) => {
    setRepeatMode(event.payload as RepeatMode);
    // The clicked item auto-toggled its checkmark natively. If it was already the
    // active mode, setRepeatMode is a no-op (no signal change, so the sync effect
    // won't fire), which would leave it wrongly unchecked — re-sync explicitly.
    void invoke("set_repeat_checked", { mode: repeatMode.value });
  });
  await listen<string>("menu:volume", (event) => {
    setVolume(volume.value + (event.payload === "up" ? 0.1 : -0.1));
  });
  await listen("menu:mute", () => toggleMute());
  await listen("menu:miniplayer", () => void toggleMiniPlayer());

  // Drain any file passed at launch (cold start). Must happen after the
  // open-file listener is registered so the ready-flag race is closed.
  const pendingOpen = await invoke<string | null>("frontend_ready");
  if (pendingOpen) {
    openAssociatedFile(pendingOpen);
  }

  await refreshTree(app.libraryRoots);
  void refreshPlaylistIndex();
  await refreshStreams(streamListPath);

  if (app.libraryRoots.length) {
    void invoke("rescan_libraries", { paths: app.libraryRoots });
    void invoke("watch_libraries", { paths: app.libraryRoots }).catch((e) =>
      console.error("watch_libraries failed", e),
    );
  }

  // Dev/e2e only: connect to the test harness if one launched us. The probe
  // reports the live playback signals so tests can assert engine/UI agreement.
  void maybeStartE2eBridge(
    () => ({
      isPlaying: isPlaying.value,
      hasTrack: hasTrack.value,
      isStream: isStream.value,
      currentTime: currentTime.value,
      duration: duration.value,
      title: npTitle.value,
      currentNodePath: currentNodePath.value,
      queuePlayingIndex: queuePlayingIndex.value,
      shuffle: shuffleMode.value,
      repeat: repeatMode.value,
      autoadvance: autoadvance.value,
      queueIsActivePool: queueIsActivePool(),
      // True while the active pool is a real playlist file (autosaves on curation).
      // "Add to queue" detaches the pool from its file, flipping this to false.
      activePoolIsPlaylist: isPlaylistSource(activeQueue.value),
      queueLength: activeQueue.value?.tracks.length ?? 0,
      treeSelectionSize: treeSelection.value.size,
      listSelectionSize: queueSel.signal.value.size,
      navSelectionSize: navSel.signal.value.size,
    }),
    {
      playFile: (p) => openExternalFile(String(p)),
      // Click a tree row through the real handler, optionally with Cmd/Shift so
      // tests can drive multi-select (the bridge's plain `click` carries no
      // modifiers). Dispatches a genuine MouseEvent so onNodeClick runs its true
      // branch (toggle / range / play).
      treeClick: (arg) => {
        const a = arg as { selector: string; meta?: boolean; shift?: boolean };
        const el = document.querySelector<HTMLElement>(a.selector);
        if (!el) throw new Error(`no tree row for selector: ${a.selector}`);
        el.dispatchEvent(
          new MouseEvent("click", {
            bubbles: true,
            cancelable: true,
            metaKey: !!a.meta,
            shiftKey: !!a.shift,
          }),
        );
      },
      // Add the current file-tree selection to the queue via the same call the
      // multi-select context-menu verb makes, so tests assert the selection
      // resolves to the right tracks.
      addSelectionToQueue: () => addToQueue(selectedTracks()),
      // Click a list row (queue / browsed playlist) through the real handler,
      // optionally with Cmd/Shift, so tests drive the list's multi-select the same
      // way treeClick drives the tree's. Targets the Nth `li.queue-row` in view
      // order and dispatches a genuine modifier-carrying MouseEvent.
      listClick: (arg) => {
        const a = arg as { index: number; meta?: boolean; shift?: boolean };
        const rows = queueListEl.querySelectorAll<HTMLElement>("li.queue-row");
        const el = rows[a.index];
        if (!el) throw new Error(`no queue row at index: ${a.index}`);
        el.dispatchEvent(
          new MouseEvent("click", {
            bubbles: true,
            cancelable: true,
            metaKey: !!a.meta,
            shiftKey: !!a.shift,
          }),
        );
      },
      // The list-pane (queue / browsed playlist) equivalents of the verbs above,
      // acting on the object-keyed list selection.
      addListSelectionToQueue: () => addToQueue(selectedListTracks()),
      removeListSelection: () => removeCuratedTracks(selectedListTracks()),
      // Point the library at a single folder through the real setLibraryRoots
      // path (rescan + watch + refreshTree), so tree-interaction tests can
      // populate the file browser without the native folder picker.
      setLibraryRoot: (arg) => setLibraryRoots([String((arg as { path: string }).path)]),
      // Toggle the global autoadvance through the real setAutoadvance path (the
      // same one the OS Playback menu drives), so a toggle mid-play also
      // reconciles the engine via applyAutoadvanceChange.
      setAutoadvance: (arg) => {
        setAutoadvance((arg as { enabled: boolean }).enabled);
      },
      // Add paths to the queue via the real "Add to queue" entry point: appends
      // to an open queue, or starts a fresh one when nothing is queued.
      addToQueue: (arg) => {
        const a = arg as { paths: string[] };
        addToQueue(
          a.paths.map((path) => ({ path, title: null, artist: null, album: null })),
        );
      },
      // Play a saved playlist file from disk through the real read+play path, so
      // it becomes the active pool under the Playlists autoadvance context.
      playPlaylist: (arg) => playPlaylistPath(String((arg as { path: string }).path)),
      // Open a saved playlist in the browse pane (single-click path) without
      // changing playback, so curation tests can edit a browsed copy.
      browsePlaylist: (arg) => browsePlaylistPath(String((arg as { path: string }).path)),
      // Save Queue as Playlist to an explicit path, bypassing the native file
      // picker (undrivable in e2e). Runs the real post-dialog logic so tests can
      // assert the ephemeral queue becomes an autosaving playlist source.
      savePlaylistAs: (arg) =>
        saveQueueAsPlaylist(String((arg as { path: string }).path)),
      // Add explicit paths to a specific playlist file via the real
      // "Add to playlist ▸" entry point (addTracksToPlaylist), so tests exercise
      // its open-list-vs-closed-file routing — including the case where the target
      // is the playing pool but a *different* playlist is browsed.
      addToPlaylist: (arg) => {
        const a = arg as { path: string; paths: string[] };
        const tracks: SearchTrack[] = a.paths.map((path) => ({
          path,
          title: null,
          artist: null,
          album: null,
        }));
        return addTracksToPlaylist(a.path, () => tracks);
      },
      // Leave a browsed playlist for the playing source's own list (the real nav
      // path), so a subsequent curation targets the active pool rather than the
      // browsed copy.
      showSourceList: () => showSourceList(),
      // Remove a row from the open (browsed or active) list via the real curation
      // path, so the edit reconciles engine + activeQueue when it hits the pool.
      removeRow: (arg) => removeCuratedRow((arg as { index: number }).index),
      // Play an explicit set of file paths as a synthetic pool via the real
      // playQueue path, so curation tests can reorder/remove a live multi-track
      // list. The "queue:" path makes it the active pool (queueIsActivePool).
      playPaths: (arg) => {
        const a = arg as { paths: string[]; startIndex?: number };
        const tracks: SearchTrack[] = a.paths.map((path) => ({
          path,
          title: null,
          artist: null,
          album: null,
        }));
        playQueue(
          {
            kind: "folder",
            title: "E2E Pool",
            subtitle: trackCountSubtitle(tracks),
            tracks,
          },
          "queue:e2e:pool",
          a.startIndex,
        );
      },
      // Reorder a row by synthesizing the real pointer-drag: pointerdown on the
      // row, a move past the drag threshold, a move to the target position, then
      // pointerup. Drives the actual attachRowReorder path (threshold, hit-test,
      // drop) rather than shortcutting to reorderCuratedTracks, so the test reflects
      // real drag behavior. `to` matches reorderCuratedTracks's insert-before index.
      dragRow: (arg) => {
        const a = arg as { from: number; to: number };
        const rows = Array.from(
          queueListEl.querySelectorAll<HTMLElement>("li.queue-row"),
        );
        const src = rows[a.from];
        if (!src) return;
        const s = src.getBoundingClientRect();
        const sx = s.left + s.width / 2;
        const sy = s.top + s.height / 2;
        let tx: number;
        let ty: number;
        if (a.to >= rows.length) {
          const last = rows[rows.length - 1].getBoundingClientRect();
          tx = last.left + last.width / 2;
          ty = last.bottom + 4; // empty area past the last row -> insert at end
        } else {
          const t = rows[a.to].getBoundingClientRect();
          tx = t.left + t.width / 2;
          ty = t.top + t.height * 0.25; // top half -> insert before row `to`
        }
        const fire = (target: EventTarget, type: string, x: number, y: number) =>
          target.dispatchEvent(
            new PointerEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true }),
          );
        fire(src, "pointerdown", sx, sy);
        fire(window, "pointermove", sx + 8, sy + 8); // cross the drag threshold
        fire(window, "pointermove", tx, ty); // hit-test the target row
        fire(window, "pointerup", tx, ty);
      },
    },
  );
}

window.addEventListener("DOMContentLoaded", init);
