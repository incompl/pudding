import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { listen } from "@tauri-apps/api/event";
import {
  getCurrentWindow,
  LogicalSize,
  PhysicalPosition,
} from "@tauri-apps/api/window";
import { load } from "@tauri-apps/plugin-store";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { signal, computed, effect } from "@preact/signals-core";
import { engine } from "./engine-glue";
import { h, eqBars, append } from "./dom";
import {
  activeColumns,
  buildCells,
  buildHeaderCells,
  columnHeaders,
  columnsMenuItem,
  showColumnsMenuAt,
  gridTemplate,
  gridClasses,
  librarySort,
  loadColumnPrefs,
  nextSort,
  persist as persistColumnPrefs,
  setColumnHost,
  setColumnRepaint,
  setColumnRoom,
  sortTracks,
  NAV_CELLS,
  type ColumnId,
  type ColumnPane,
} from "./columns";
import { windowedList } from "./windowed-list";
import { maybeStartE2eBridge } from "./e2e-bridge";
import { createVisualizer, type Visualizer } from "./visualizer";
import { bootProfileStart, bootStep, bootProfileReport } from "./perf";
import {
  initLibraryNav,
  navigateTo,
  currentNavStep,
  popNavToRoot,
  renderNav,
  refreshNavPaneAfterScan,
  invalidateNavListCache,
  registerNavList,
  navMove,
  navActivate,
  navClearCursor,
  type NavStep,
} from "./library-nav";
import type {
  TrackMeta,
  TreeNode,
  SearchTrack,

  SearchArtist,
  SearchAlbum,
  SearchItem,
  Queue,
  ScanResult,
  ScanProgress,
  RepeatMode,
  ReplayGainMode,
  TrackSelection,
  ContextMenuItem,
  NavState,
  PaneView,
  PlaylistData,
  RecentItem,
  TrackProvider,
  LeafListContext,
} from "./types";
import {
  hasTrack,
  npTitle,
  npArtist,
  npAlbum,
  npAlbumArtist,
  npArt,
  npStreamMeta,
  isStream,
  isPlaying,
  currentTime,
  duration,
  volume,
  volumePopoverOpen,
  currentNodePath,
  currentPoolPath,
  currentStreamUrl,
  selectedStreamUrl,
  settingsOpen,
  aboutOpen,
  licensesOpen,
  equalizerOpen,
  nowPlayingView,
  type NowPlayingView,
  zenMode,
  activeTab,
  activeQueue,
  browsedPlaylist,
  editingText,
  listFaceOpen,
  queuePlayingIndex,
  fetchingPath,
  shuffleMode,
  repeatMode,
  replayGainMode,
  followSampleRate,
  autoadvance,
  libraryRootSet,
  streamListPathValid,
  streamListPathSet,
  streamListWritable,
  libraryHasContent,
  libraryTreeLoaded,
  treeSelection,
  paneEditor,
  openActiveQueue,
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
  playPauseGlyph,
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
  aboutPanel,
  licensesPanel,
  licensesBody,
  eqBandsEl,
  eqEnabledEl,
  eqResetBtn,
  nowPlayingVisualizerEl,
  aboutVersionEl,
  splitterEl,
  themeMatchSystemEl,
  themeSwatchesEl,

  queueListEl,
  queueCloseBtn,

  searchInput,
  toastEl,
} from "./dom-refs";
import { showContextMenu } from "./context-menu";
import { startTrackDrag } from "./drag-drop";
import { initFileDrop } from "./file-drop";
import { attachOverflowTitles } from "./overflow-title";
import { setupSearch } from "./search";
import {
  refreshTree,
  refreshLibrary,
  holdLibraryRoots,
  setLibraryRoots,
  renderLibraryRootRows,
  setStreamListPath,
  browseLibraryRoot,
  browseStreamListPath,
  refreshStreams,
} from "./library";
import {
  playSelectedRow,
  moveTreeSelection,
  activateTreeSelected,
  isBrowseActive,
  revealFolderInTree,
  revealFileInTree,
  revealTreeRow,
  setBrowseActive,
  repaintTreeStatus,
} from "./tree-view";
import { applyRowFlash, startRowFlash } from "./row-flash";
import { applyCellStatus, rowStatus } from "./row-status";
import {
  closePaneEditor,
  editMetadataItem,
  editTags,
  startTitleEdit,
} from "./editors";
import {
  openAddStationEditor,
  moveStreamSelection,
  clearStreamSelection,
} from "./streams-view";
import {
  setNowPlaying,
  playFile,
  poolPaths,

  refillShuffleBag,
  resetShuffleState,

  syntheticParent,
  togglePlayPause,
  seekBy,
  seekTo,
  setVolume,
  setLastNonZeroVolume,
  skipNext,
  skipPrev,
  hasNextTrack,
  lastNonZeroVolume,
  rowPlayButton,
} from "./playback";
import {
  renderQueue,
  revealQueueRow,
  addToQueue,
  queueMenuItems,
  nodeToTrack,
  closeQueue,
  fillRowAfterRemoval,
  removeCuratedTracks,
  removeCuratedRow,
  undoCuration,
  redoCuration,
  canUndoCuration,
  canRedoCuration,
  curationHistoryVersion,
} from "./queue";
import {
  KEY_RECENT_ITEMS,
  hydrateRecentItems,
  primeRecentIcons,
  addRecentItem,
  removeRecentItem,
  persistRecentItems,
  syncRecentItemsMenu,
} from "./recents";
import {
  playlistPlayableTracks,
  playlistViewTracks,
  playPlaylistPath,
  browsePlaylistPath,
  refreshPlaylistIndex,
  menuNewPlaylist,
  menuSavePlaylist,
  queueCanSaveAsPlaylist,
  saveQueueAsPlaylist,
  menuMovePlaylist,
  newPlaylistWithTracks,
  addTracksToPlaylist,
  deletePlaylistPath,
  startNavPlaylistRename,
} from "./playlists";
import { app } from "./state";
import {
  type ThemeMode,
  MODE_BG,
  accentIdFor,
  effectiveMode,
  loadThemeSettings,
  setAccentFor,
  setThemeMode,
  setupTheme,
  themeMode,
  themesForMode,
} from "./theme";
import {
  BUNDLED_SAMPLE,
  bundledSampleArt,
  bundledSamplePath,
  prepareBundledSample,
} from "./sample";

export const KEY_LIBRARY_ROOTS = "libraryRoots";
// Security-scoped bookmarks for those roots, base64 keyed by path. A separate key
// rather than a field on each root: the path stays the root's identity everywhere
// (tracks.root, the tree, playlist scanning), and the blob is data hanging off it.
export const KEY_ROOT_BOOKMARKS = "libraryRootBookmarks";
// Value stays "manifestPath" (the pre-rename key) so existing saved settings survive.
export const KEY_STREAM_LIST_PATH = "manifestPath";
const KEY_SPLITTER_WIDTH = "splitterWidth";
export const KEY_VOLUME = "volume";
// Window size is remembered per layout mode so the double-click toggle can
// restore the size you last used in the *other* mode.
const KEY_WINDOW_SIZE_NORMAL = "windowSizeNormal";
const KEY_WINDOW_SIZE_MINI = "windowSizeMini";
const KEY_WINDOW_POSITION = "windowPosition";
// Autoadvance: one global preference (does playback flow track-to-track, or stop
// after each?). Lives in the OS Playback menu, not the app UI. Was once split by
// context (file tree vs. playlists), but that context turned into six library
// views + playlists; a single global toggle keeps the behavior predictable
// without any "which context am I in?" reasoning. KEY_AUTOADVANCE_FILES is read
// once at load to migrate the old browsing setting; the new key supersedes both.
const KEY_AUTOADVANCE = "autoadvance";
const KEY_AUTOADVANCE_FILES = "autoadvanceFiles"; // legacy, migrated on load
// Playback modes remembered across launches, like every mainstream player.
const KEY_SHUFFLE = "shuffleMode";
const KEY_REPEAT = "repeatMode";
// ReplayGain (volume normalization) mode, remembered across launches.
const KEY_REPLAYGAIN = "replayGainMode";
// Whether the output device follows each file's sample rate. Remembered across
// launches; defaults off (see the signal's note in state.ts).
const KEY_FOLLOW_SAMPLE_RATE = "followSampleRate";
// Which Now Playing hero view the user last chose (art vs. visualizer).
const KEY_NOW_PLAYING_VIEW = "nowPlayingView";

// The graphic equalizer's saved curve (on/off, preamp, per-band gains), restored
// on launch and re-pushed to the engine so your EQ survives a restart.
const KEY_EQ = "equalizer";

// The user's last place in the Files-tab navigator (the serialized drill stack),
// restored on launch so browse/songs/artists/albums drill-downs survive a restart.
const KEY_NAV_LOCATION = "navLocation";

// The open sidebar tab (Files/Streams), restored on launch so a Streams-focused
// user isn't bounced back to Files every start.
const KEY_ACTIVE_TAB = "activeTab";

// The playing queue + playhead, so quitting doesn't lose the queue and your place
// (like Spotify/Apple). Only a queue that IS the audible pool is restorable; a
// lone track / stream / drained-and-torn-down queue clears the key. Restored
// paused — the first play press resumes at the saved position (see restorePlaybackSession).
const KEY_PLAYBACK_SESSION = "playbackSession";

// Position ticks fire ~20 Hz; cap the session write to at most one per this window
// so the playhead survives a crash/quit without hammering the store during play.
const SESSION_WRITE_INTERVAL_MS = 5000;

// The shape saved under KEY_PLAYBACK_SESSION.
interface PersistedSession {
  queue: Queue; // full activeQueue data (kind, title, subtitle, tracks, sourcePath)
  index: number; // the playing row, in the playable-pool index space (missing rows skipped)
  path: string; // the playing track's path, for a sanity check against index
  time: number; // playhead seconds
  duration: number; // the track's duration, so the scrubber shows a full bar before play
}

// At or below EITHER of these logical (CSS-px) bounds the layout collapses to
// the mini player: the full layout needs room in both directions (a left pane
// beside a right one, a list with a nav bar under it), so a window too small on
// either axis falls back to the bar rather than cramming. Mirrors the
// media-query breakpoints in styles.css — keep the two in sync.
const MINI_MAX_HEIGHT = 360;
const MINI_MAX_WIDTH = 600;
const DEFAULT_NORMAL_SIZE = { width: 800, height: 600 };
const DEFAULT_MINI_SIZE = { width: 367, height: 168 };



// Header for a queue the user builds by hand (Add to queue), as opposed to one
// opened from a fixed source (Play artist/album/folder). Deliberately NOT named
// after any track: the contents change as more are added, so a track-derived
// title would drift. Placeholder framing ("Untitled") anticipates saving it as a
// named playlist later.
export const UNTITLED_PLAYLIST_TITLE = "Untitled";

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
export function trackCountSubtitle(tracks: SearchTrack[]): string {
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

export function formatTime(seconds: number): string {
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

// Whether `path` sits inside a configured library folder, and so is covered by
// that folder's security-scoped bookmark (root_access.rs) — the only access this
// app holds across launches. Sandboxed, everything else (a Finder drop, an Open
// With, a launch argument) is granted for this launch only, so this is the test
// for "will still be openable next time", not "exists".
function insideLibraryRoots(path: string): boolean {
  return libraryRootPaths().some((root) => {
    // A stored root can carry a trailing separator (typed by hand, or normalized
    // only on the backend's side of the wire); left in, it would make every path
    // in that library read as outside it, which fails in the quiet direction.
    const r = root.replace(/[\\/]+$/, "");
    return path === r || path.startsWith(r + "/");
  });
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
// highlight tracks it (see the selection effect and renderTreeRow).
// The pivot a Shift-click ranges from — the last track any click touched
// (including a plain play-click, so click A then Shift-click B selects A..B).

// Track nodes in render order. `visibleOnly` descends into expanded folders alone
// (matching what renderTreeRow paints) for Shift-range selection; false walks every
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
  // navClearCursor drops both the navigator's leaf (navSel) selection and any
  // drill-row `.kbd-cursor`, so a keyboard cursor there doesn't linger once the
  // tree becomes the selected surface.
  navClearCursor();
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
// leaf-list (Songs, ...) selection — separate Sets so they never mirror each other
// (a queued track is the same object as its Songs row), but mutually exclusive:
// selecting in one drops the other's (and the tree's) highlight, so exactly one
// surface is ever selected. The forward refs resolve at call time (both consts
// exist before any click fires). clearTreeSelection covers the third surface.
export const queueSel: TrackSelection = makeTrackSelection(() => {
  // navClearCursor drops the navigator's leaf selection *and* any drill-row
  // `.kbd-cursor`, so the queue becoming the selected surface leaves no stale
  // keyboard highlight in the navigator.
  navClearCursor();
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

export function openListTracks(): SearchTrack[] {
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
  const active = activeQueue.value;
  const list = browsed ?? active;
  // A browsed playlist that *is* the playing source (same file, and a queue owns
  // the playhead) is treated as the source: its playing row highlights and its
  // rows jump the pool. Otherwise returning to a playlist you're playing would
  // read as a detached browse with no playhead. A distinct playlist, or folder /
  // stream / lone-track play, stays a plain browse (isSource false).
  const browsedIsPlayingSource =
    browsed !== null &&
    isPlaylistSource(browsed) &&
    isPlaylistSource(active) &&
    browsed.sourcePath === active!.sourcePath &&
    queueIsActivePool();
  const isSource = browsed === null || browsedIsPlayingSource;
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

// The now-playing hero is the visible right-pane face: the list face is down and no
// settings/about/editor panel has taken the pane over. This is the track analog of a
// playlist being "open" — a playing track lights its nav row with the accent only
// while the hero (which is showing that track) is what the right pane displays, the
// same way a browsed playlist's row is accented because its contents fill the pane.
// A signal so the highlight effects repaint as you flip faces or open a panel.
// The visualizer is a face OF the hero (art vs. visualizer), not a pane
// takeover, so it doesn't gate this — the hero is "visible" under either view.
export const heroVisible = computed(
  () =>
    !listFaceOpen.value &&
    !settingsOpen.value &&
    !aboutOpen.value &&
    !licensesOpen.value &&
    !equalizerOpen.value &&
    paneEditor.value === null,
);

// A fresh install uses the normal hero as a preview of the bundled welcome track,
// without claiming anything is loaded to the engine or publishing it to system
// Now Playing. Real playback always wins over the preview.
const welcomeSamplePreview = computed(
  () =>
    libraryTreeLoaded.value &&
    !libraryRootSet.value &&
    !hasTrack.value &&
    bundledSamplePath.value !== null,
);
// The preview and the playing bundled track use the normal metadata elements,
// but neither has a home in the user's library for those elements to link to.
const bundledSampleShown = computed(
  () =>
    welcomeSamplePreview.value ||
    (bundledSamplePath.value !== null &&
      currentNodePath.value === bundledSamplePath.value),
);

// The playlist whose contents currently fill the pane's list face — the browsed one,
// or the playing source once you play from it (playQueue clears browsedPlaylist and
// makes the playlist the activeQueue). This is the playlist analog of heroVisible: a
// playlist row is "open" (accented) exactly while the right pane is showing that
// playlist's list, whether you're browsing it or playing it. Null when the hero is up
// or the list face shows a plain (unsaved) queue.
export const shownPlaylistPath = computed(() => {
  if (!listFaceOpen.value) return null;
  const list = browsedPlaylist.value ?? activeQueue.value;
  return isPlaylistSource(list) ? (list!.sourcePath ?? null) : null;
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



// Save the navigator's current place so it's restored on the next launch. The
// navigator calls this (fire-and-forget) on every drill / back / pop; writes are
// at click frequency, so no debounce is needed.
function persistNavLocation(steps: NavStep[]): void {
  void (async () => {
    await app.store.set(KEY_NAV_LOCATION, steps);
    await app.store.save();
  })();
}


// Opens a queue in the right pane and starts it. Playback reuses the album path
// via a synthetic parent (so shuffle/repeat/gapless all work); the queue view is
// what makes it visible. Under shuffle we start on a random track (matching
// playFolder) so replaying the same artist/album doesn't always open on track 1;
// straight play starts on the first track, the page's natural order. Either way
// the view keeps natural order and just highlights the playing row. The synthetic
// path is unique per queue and never a real tree path, so the rescan re-bind
// (suppressed while activeQueue is set) can't repoint currentParent at a folder.
export function playQueue(queue: Queue, syntheticPath: string, startIndex?: number): void {
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

// A brief, self-dismissing confirmation (e.g. "Added 12 tracks"). Add-to-queue
// often lands on the list where the growth is visible anyway, but the toast
// confirms the append even when the tracks scroll in below the fold.
let toastTimer: number | undefined;
export function toast(message: string): void {
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
// queue rows, search hits): a leading New Playlist... plus every indexed library
// playlist. New Playlist... seeds a fresh file with the clicked tracks; an
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
    { label: "New Playlist...", action: () => void newPlaylistWithTracks(getTracks) },
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

// The "Go to" verbs: switch to the Files tab and drill straight to an artist,
// album, or folder. The library navigator now hosts artist and album detail
// views (and the Browse folder tree), so a track's menu and search hits point
// you AT the thing rather than playing it — playing then happens from the detail
// view. Each makes the Files tab active (persisted) before navigating.
function goToFilesTab(): void {
  activeTab.value = "files";
  void persistActiveTab();
}

export function goToArtist(name: string): void {
  goToFilesTab();
  // flashTitle: the detail view has no persistent marker for where you landed, so
  // pulse its Back-bar title as the "here it is" cue — the album/artist analogue of
  // the tree-row flash a browsed-to track gets (see goToFile).
  navigateTo([{ t: "view", view: "artist" }, { t: "artist", name }], {
    flashTitle: true,
  });
}

export function goToAlbum(album: string, albumArtist: string): void {
  goToFilesTab();
  navigateTo([{ t: "view", view: "album" }, { t: "album", album, albumArtist }], {
    flashTitle: true,
  });
}

export async function goToFolder(path: string): Promise<void> {
  goToFilesTab();
  // Browse hosts the real folder tree; show it, then expand + scroll to the target
  // and flash the row — the same "here it is" a track hit gets (see goToFile).
  navigateTo([{ t: "view", view: "browse" }]);
  await revealFolderInTree(path);
  revealTreeRow(path);
}

// Reveal a single track hit in Browse — expand its containing folder, scroll to it,
// and flash the row — instead of playing it. This is the search "show, don't play"
// for leaf tracks, mirroring how a folder hit goes to the folder. Unlike the now-
// playing reveal (where the playing row stays highlighted), a browsed-to track has
// no persistent marker, so the flash is what says "here it is".
export async function goToFile(path: string): Promise<void> {
  goToFilesTab();
  navigateTo([{ t: "view", view: "browse" }]);
  await revealFileInTree(path);
  revealTreeRow(path);
}

// Clicking the now-playing title reveals what is playing in the matching sidebar.
// A stream switches to Streams, selects its station, and scrolls that row into view.
// A track is revealed in its *playing context* — the pool autoadvance is walking
// (app.currentParent) — so the title answers "where does this live / what am I
// playing from / what plays next" in one tap, the same "go home to what's playing"
// the artist/album lines offer for their grouping. The pool's synthetic path IS its
// canonical origin identity (these keys mirror openAlbumQueue / the leaf lists'
// syntheticPath — see the syntheticParent call sites), so we read the context
// straight off it rather than recording a parallel breadcrumb that could drift from
// the actual pool:
//   queue:album:<albumArtist>\0<album>  → the Albums view's album detail
//   queue:artist:<name>                 → the Artists view's artist detail
//   queue:songs                         → the Songs view
//   an active playlist / folder queue / ad-hoc queue → that source's list face
//   anything else (a real folder pool, or no pool at all for a search / OS-opened
//     file) reveals where the file lives — its folder in Browse. For library views
//     we stash the path so the list that lands scrolls straight to the playing row.
// Hidden when nothing's playing.
export function revealNowPlaying(): void {
  if (!hasTrack.value) return;
  if (isStream.value) {
    const url = currentStreamUrl.value;
    if (!url) return;
    // Match a user-driven tab switch, except keep the destination station selected
    // so the title acts as a real "show me this" link rather than merely opening
    // the right tab. The tab effect runs synchronously, making the row measurable
    // before scrollIntoView is called even when Streams was previously hidden.
    clearTreeSelection();
    activeTab.value = "streams";
    void persistActiveTab();
    app.lastSelectionPane = "stream";
    selectedStreamUrl.value = url;
    streamsContainer
      .querySelector(`.node-label[data-stream-url="${CSS.escape(url)}"]`)
      ?.scrollIntoView({ block: "nearest" });
    return;
  }
  const path = currentNodePath.value;
  const pool = app.currentParent?.path ?? "";
  if (pool.startsWith("queue:album:")) {
    const [albumArtist, album] = pool.slice("queue:album:".length).split("\0");
    goToFilesTab();
    app.pendingRevealPlayingPath = path;
    navigateTo([{ t: "view", view: "album" }, { t: "album", album, albumArtist }]);
  } else if (pool.startsWith("queue:artist:")) {
    const name = pool.slice("queue:artist:".length);
    goToFilesTab();
    app.pendingRevealPlayingPath = path;
    navigateTo([{ t: "view", view: "artist" }, { t: "artist", name }]);
  } else if (pool === "queue:songs") {
    goToFilesTab();
    app.pendingRevealPlayingPath = path;
    navigateTo([{ t: "view", view: "songs" }]);
  } else if (queueIsActivePool() && activeQueue.value) {
    // Playlist, played-folder, and explicit/ad-hoc queue sources already retain
    // their exact ordered list in activeQueue. Reopen that source rather than
    // degrading to the file's home folder, which is not necessarily what plays
    // next. This also abandons any unrelated playlist browse that may be on top.
    showSourceList();
  } else if (path) {
    goToFilesTab();
    navigateTo([{ t: "view", view: "browse" }]);
    // Same "here it is" the view branches get above, via the tree's own reveal.
    void revealFileInTree(path).then(() => revealTreeRow(path));
  }
}

export function trackContextItems(track: {
  artist: string | null;
  album: string | null;
  albumArtist: string | null;
}): ContextMenuItem[] {
  // Suppress the verb that would just re-open the detail view we're already in:
  // the artist/album detail lists its own tracks, so "Go to" there is a no-op.
  const here = currentNavStep();
  const items: ContextMenuItem[] = [];
  if (track.artist && !(here?.t === "artist" && here.name === track.artist)) {
    const artist = track.artist;
    items.push({ label: "Go to artist", action: () => goToArtist(artist) });
  }
  if (track.album && !(here?.t === "album" && here.album === track.album)) {
    const album = track.album;
    const albumArtist = track.albumArtist ?? track.artist ?? "";
    items.push({ label: "Go to album", action: () => goToAlbum(album, albumArtist) });
  }
  return items;
}

// Add a lazily-resolved set of tracks (artist/album query) to the queue, using
// the same snapshot guard as addFolderToQueue so a scan that resolves after the
// user has navigated away appends to the right destination or not at all.
// `sink` is the terminal verb — addToQueue (default) or playNext — so "Add to
// queue" and "Play next" share the snapshot guard.
async function addProviderToQueue(
  getTracks: TrackProvider,
  sink: (tracks: SearchTrack[]) => void = addToQueue,
): Promise<void> {
  const queueBefore = activeQueue.value;
  const pathBefore = currentNodePath.value;
  try {
    const tracks = await getTracks();
    if (activeQueue.value !== queueBefore) return;
    if (!queueBefore && currentNodePath.value !== pathBefore) return;
    sink(tracks);
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
  void showContextMenu(x, y, [
    { label: "Play", action: () => void openArtistQueue(name) },
    ...queueMenuItems((sink) => void addProviderToQueue(getTracks, sink)),
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
  void showContextMenu(x, y, [
    { label: "Play", action: () => void openAlbumQueue(album, albumArtist) },
    ...queueMenuItems((sink) => void addProviderToQueue(getTracks, sink)),
    addToPlaylistItem(getTracks),
  ]);
}

// Right-click menu for the Playlists browse rows (Phase 5). Mirrors the artist /
// album menus but reuses the existing playlist paths: Play plays the file through
// playPlaylistPath (so it becomes the playing source, same as a tree double-click),
// and Add to queue / Add to playlist run off the playlist's playable tracks. Missing
// rows are already dropped by playlistPlayableTracks, so the queue pool never carries
// danglers.
function showPlaylistContextMenu(
  x: number,
  y: number,
  path: string,
  name: string,
  startRename: () => void,
): void {
  const getTracks: TrackProvider = async () =>
    playlistPlayableTracks(await invoke<PlaylistData>("read_playlist", { path }));
  void showContextMenu(x, y, [
    { label: "Play", action: () => void playPlaylistPath(path) },
    ...queueMenuItems((sink) => void addProviderToQueue(getTracks, sink)),
    addToPlaylistItem(getTracks),
    { label: "Rename", action: startRename },
    { label: "Delete", action: () => void deletePlaylistPath(path, name) },
    showInFinderItem(path),
  ]);
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

// Whether a leaf list's tracks disagree about a field (artist / album) — i.e. is it
// worth showing in the row suffix, or is it the same on every row and just noise?
// Empty values don't count as a distinct value; short-circuits once two differ, so
// a real varying list (Songs) is O(1) despite the whole-library size.
function fieldVaries(
  tracks: SearchTrack[],
  get: (t: SearchTrack) => string | null,
): boolean {
  let seen: string | null = null;
  for (const t of tracks) {
    const v = get(t);
    if (!v) continue;
    if (seen === null) seen = v;
    else if (v !== seen) return true;
  }
  return false;
}

export function renderLeafTrackList(
  inputTracks: SearchTrack[],
  ctx: LeafListContext,
): HTMLElement {
  // A library list has a *sort* (sticky, indicated in the header), unlike a queue,
  // which has an order the user owns. Sorting up front means the play pool, the
  // keyboard order, and the row indices are all built from what's on screen.
  const tracks = sortTracks(inputTracks, librarySort.peek());
  app.navLeafTracks = tracks;
  app.navLeafPoolPath = ctx.syntheticPath;
  // The query container for this list's header row. The windowed row block inside
  // declares its own `listcol` container at the identical width, so header and rows
  // switch into column mode together.
  const ul = h("div", { class: "nav-list col-host" });

  // Show a field in the dimmed suffix only when the list's tracks disagree about it
  // (mirrors the browse tree's per-folder showArtist). A field that's the same on
  // every row is noise repeated down the list, so drop it: an album view (one album,
  // often one artist) collapses to bare titles, while a compilation still shows the
  // varying artist. Songs — the whole library — varies on both, but forces the album
  // off via ctx.hideAlbum to stay an uncluttered title · artist list, so it shows just
  // the artist. The artist detail view likewise forces the album off (see
  // LeafListContext) and additionally drops the artist as constant, leaving bare titles.
  const showArtist = fieldVaries(tracks, (t) => t.artist);
  const showAlbum = !ctx.hideAlbum && fieldVaries(tracks, (t) => t.album);
  // fieldVaries is now the *default*, not an override: it decides the automatic
  // column set, and the moment the user picks their own set through `Columns ▸`
  // that set is taken literally — constant fields and all. "You made the mess."
  const autoCols: ColumnId[] = [
    "title",
    ...(showArtist ? (["artist"] as ColumnId[]) : []),
    ...(showAlbum ? (["album"] as ColumnId[]) : []),
    "duration",
  ];
  const cols = activeColumns("library", autoCols);
  // One template for the whole list, computed here rather than per row: a fixed
  // column's width is a fact about the list (see gridTemplate), and this is the
  // only place that sees all of it — the rows below are built one at a time, as
  // the window scrolls them in.
  const showHeader = columnHeaders.library.peek();
  const colTemplate = gridTemplate(cols, tracks, showHeader, "library");

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

  // One row, built fresh whenever the window (re)mounts it. Rows carry no state the
  // window can't rebuild — the selected highlight is read from navSel at build time
  // (and re-toggled live by the selection painter effect), so a scrolled-in row is
  // already correct without waiting for the effect to run.
  const buildRow = (i: number): HTMLElement => {
    const t = tracks[i];
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
      // it only shrinks past 999 — well inside the 100k-snappy / 500k-functional
      // library target, where 6-digit gutters are real.
      style: label.length > 3 ? { "font-size": `${3 / label.length}em` } : {},
    });
    // Number gutter that gives way to a hover play button, matching the queue and
    // tree track rows (see .nav-num CSS).
    const num = h(
      "span",
      { class: "nav-num" },
      numText,
      // The playing-row equalizer glyph, hidden until this row is the one playing
      // (CSS keys off .nav-track-row.playing) and swapped for the pause button on hover.
      eqBars(),
      rowPlayButton(() => playAt(t, i)),
    );

    // One cell per column, in the field table's order. The same DOM serves both
    // layouts: past the pane's 28rem breakpoint `.col-grid` becomes a grid and each
    // cell is a track; below it the cells fold back into a single inline
    // `title · artist · album` line via the `· ` separators in CSS. Every row is one
    // line at any width either way, so the height never varies — the uniform height
    // the window positions rows by (row i at i * rowHeight).
    const cell = h("span", {
      class: gridClasses("library", "nav-cell"),
      style: { "--cols": colTemplate },
    });
    append(cell, buildCells(t, cols, NAV_CELLS));
    // The same aside the queue's rows wear — "(Not downloaded)" for a cloud file,
    // "(Downloading...)" while the engine is parked on one. It is a fact about the
    // file, so it belongs to every list the file appears in, not just the one on
    // the right (see row-status.ts). The live half — the marker moving from row to
    // row as the download does — is repainted by the fetchingPath effect in
    // setupEffects; the download *landing* rebuilds these rows outright
    // (applyDownloaded), because it rewrites their fields and not just the marker.
    applyCellStatus(cell, rowStatus(t, fetchingPath.peek()));

    const row = h(
      "div",
      {
        class: "nav-track-row",
        // View index, so the reactive painter maps the object-keyed selection back
        // to rows without relying on unique paths.
        data: { rowIndex: i },
        on: {
          click: (e) => {
            // A click focuses the navigator for the keyboard: ↑/↓ then walk this
            // leaf list and Enter plays the selected row (see activeKbdList).
            app.lastSelectionPane = "nav";
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
              void showContextMenu(e.clientX, e.clientY, [
                ...queueMenuItems((sink) => sink(sel), sel.length),
                addToPlaylistItem(() => sel),
                showInFinderItem(sel[0].path),
                columnsMenuItem("library", autoCols),
              ]);
            } else {
              // Double-click plays the row, so the menu skips a redundant Play (as in
              // the tree and queue menus): it leads with the list-building verbs, then
              // the per-track navigation (Go to artist / album when tagged).
              void showContextMenu(e.clientX, e.clientY, [
                ...queueMenuItems((sink) => sink([t])),
                addToPlaylistItem(() => [t]),
                ...trackContextItems({ artist: t.artist, album: t.album, albumArtist: t.albumArtist }),
                editMetadataItem(t),
                showInFinderItem(t.path),
                // Right-clicking a row scopes the picker to that row's pane
                // implicitly, so it needs no "Library ▸" label and no
                // focused-pane guesswork.
                columnsMenuItem("library", autoCols),
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
    // A reveal's one-shot wash, applied at build time (like the selection and
    // playing state below) so it survives the remount the reveal's own scroll
    // triggers — see row-flash.
    applyRowFlash(row, t.path);
    // The now-playing accent, applied at build time so a row scrolled into view is
    // already correct (the effect below repaints mounted rows as the track changes).
    // Light the playing row only when this leaf list IS the live pool — its synthetic
    // path equals currentParent's — so the accent tracks "you're looking at what's
    // feeding playback." That covers lone play from the leaf (currentParent built from
    // this ctx.syntheticPath) and an explicit Play album/artist of the same set, and
    // stays dark when some other / reordered / ad-hoc pool owns the playhead even if
    // the same track happens to appear in this list.
    if (
      currentPoolPath.peek() === ctx.syntheticPath &&
      currentNodePath.peek() === t.path
    ) {
      row.classList.add("playing");
      // The accent (see the reactive effect) rides along only while the hero is up.
      if (heroVisible.peek()) row.classList.add("open");
    }

    return row;
  };

  // Register this leaf list as the navigator's keyboard list: ↑/↓ move the navSel
  // single-selection (its existing `.selected` highlight, so it survives a windowed
  // remount) and Enter plays the focused row. The cursor index is read from navSel
  // so a click and the keyboard share one selection. `reveal` differs per render
  // path (windowed vs eager) — passed in below.
  const registerLeafKbd = (reveal: (i: number) => void): void =>
    registerNavList({
      count: tracks.length,
      index: () => {
        const sel = navSel.signal.peek();
        const anchor = navSel.anchor();
        const cur =
          anchor && sel.has(anchor) ? anchor : sel.size === 1 ? [...sel][0] : null;
        return cur ? tracks.indexOf(cur) : -1;
      },
      focus: (i) => {
        app.lastSelectionPane = "nav";
        navSel.single(tracks[i]);
        reveal(i);
      },
      activate: (i) => playAt(tracks[i], i),
    });

  // Debug escape hatch for A/B perf comparison: set `__noWindowing = true` in the
  // devtools console and re-enter a list to render every row eagerly (the pre-
  // windowing path — all N nodes in the DOM). Off by default; never set in normal use.
  if ((globalThis as { __noWindowing?: boolean }).__noWindowing) {
    for (let i = 0; i < tracks.length; i++) ul.appendChild(buildRow(i));
    registerLeafKbd((i) =>
      (ul.children[i] as HTMLElement | undefined)?.scrollIntoView({ block: "nearest" }),
    );
    return ul;
  }

  // The optional header row, built as a real .nav-track-row — same padding, same
  // gutter width, same --cols template — so it lines up with the rows by
  // construction rather than by a second set of matched numbers. It is
  // display:none outside column mode, gated by the *same* container query as the
  // columns, so a header can never appear above a folded row.
  if (showHeader) {
    const headCells = h("span", {
      class: "nav-cell col-grid",
      style: { "--cols": colTemplate },
    });
    append(
      headCells,
      buildHeaderCells("library", cols, librarySort.peek(), (id) => {
        librarySort.value = nextSort(librarySort.peek(), id);
        void persistColumnPrefs();
        renderNav();
      }),
    );
    ul.appendChild(
      h(
        "div",
        {
          class: "nav-track-row colhead",
          // Right-clicking the header is the other way to reach the picker the
          // row menu carries under `Columns ▸` — the header is the columns, so it
          // opens them flat. Its own handler, not the row menu's: a header is not
          // a track, and Play / Add to queue would have nothing to act on.
          on: { contextmenu: (e) => showColumnsMenuAt(e, "library", autoCols) },
        },
        h("span", { class: "nav-num" }),
        headCells,
      ),
    );
  }

  // Window the rows: only the on-screen slice is mounted over a full-height spacer,
  // so a whole-library Songs list costs a screenful of DOM instead of one node per
  // track. Native scroll/inertia are unchanged (real scroll pane, full height). The
  // selection painter and drag-out still work per mounted row; there's no reorder,
  // scroll-to-playing, or keyboard row-indexing on these lists to rework.
  const win = windowedList({ count: tracks.length, renderRow: buildRow });
  win.el.classList.add("nav-window");
  ul.appendChild(win.el);
  // Reveal past the sticky column header (see queue.ts's stickyMargin): a row
  // scrolled flush to the top of the scroll box otherwise lands underneath it, so
  // walking the selection up off the top of the viewport parks the focused row out
  // of sight. offsetHeight is 0 when the header is off or folded away by a narrow
  // pane, which is exactly the margin wanted then.
  const headMargin = (): number =>
    ul.querySelector<HTMLElement>(".colhead")?.offsetHeight ?? 0;
  registerLeafKbd((i) => win.revealIndex(i, headMargin()));
  // Clicking the now-playing title parks the playing track's path here so the list
  // it navigates to scrolls straight to it (the row already paints .playing via the
  // currentNodePath match above). Consume it: scroll if this list actually holds the
  // track, and clear it either way so a later, unrelated navigation doesn't inherit
  // a stale reveal.
  const revealPath = app.pendingRevealPlayingPath;
  if (revealPath) {
    app.pendingRevealPlayingPath = null;
    const idx = tracks.findIndex((t) => t.path === revealPath);
    if (idx >= 0) {
      // Flash it as well as scrolling to it: landing on a list you were already
      // looking at (or whose playing row was already on screen) otherwise reads as
      // the click doing nothing at all. Armed before the window's first paint, so
      // the row mounts already washing (see row-flash).
      startRowFlash(revealPath);
      win.revealIndex(idx, headMargin());
    }
  }
  return ul;
}

// A column-set / header / sort change has to rebuild the pane's rows, and no
// signal the nav render path tracks covers that — so the picker re-renders it
// explicitly. renderNav() rebuilds the current drill pane in place.
setColumnRepaint("library", () => renderNav());
// Both panes' "make room" hooks are registered here, not one per module: the
// divider between them is a single number, and main.ts is what owns it.
setColumnRoom("library", () => ensureColumnRoom("library"));
setColumnRoom("queue", () => ensureColumnRoom("queue"));
// The same containers a "make room" nudge measures are the ones a divider drag
// repaints, so both hooks are answered by the one lookup.
setColumnHost("library", () => columnContainer("library"));
setColumnHost("queue", () => columnContainer("queue"));

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

// The single "open a file" entry point: ⌘O, a Finder double-click / "Open With",
// a launch argument, an Open Recent row, and a lone file dropped on the window
// (see file-drop.ts) all land here. The extension decides the verb — a playlist
// opens for browsing, audio plays — and both branches record the open in the
// recents list (the only thing that does).
export function openAssociatedFile(path: string): void {
  if (/\.m3u8?$/i.test(path)) {
    void browsePlaylistPath(path, { recent: true });
  } else {
    void openExternalFile(path);
  }
}

async function openExternalFile(path: string): Promise<void> {
  let meta: TrackMeta;
  try {
    meta = await invoke<TrackMeta>("prepare_external_file", { path });
  } catch (e) {
    // Unreadable or gone (moved/deleted outside the app). Self-heal the same way
    // browsePlaylistPath does for a dead playlist: drop it from the recents so a
    // stale row doesn't sit there forever.
    console.error("prepare_external_file failed", path, e);
    removeRecentItem(path);
    return;
  }
  // Leaves currentParent null so the tree is untouched, no row is highlighted,
  // and album-advance is a no-op (single-track queue). Lone playback: dismiss
  // any open queue/playlist; null the highlight since this plays outside it.
  app.pendingResume = null;
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
  resetShuffleState();
  const fallback = path.split(/[\\/]/).pop() ?? path;
  // The read above is the proof the file is really there, so record the open now
  // — under the same title the transport is about to show.
  addRecentItem(path, meta.title ?? fallback, "track");
  setNowPlaying(meta.title ?? fallback, meta.artist, meta.album);
  void loadArt(path);
  void engine.play([path], 0);
}

export function clearArt(): void {
  app.artRequestId++;
  npArt.value = null;
}

export async function loadArt(path: string): Promise<void> {
  await applyArt(() => invoke<string | null>("get_art", { path }), path);
}

// Station art declared in the stream stream list, fetched by the backend (the
// CSP forbids remote/file <img> sources, so it arrives as a data URL just
// like embedded track art).
export async function loadStreamArt(image: string): Promise<void> {
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

const persistNowPlayingView = async (): Promise<void> => {
  await app.store.set(KEY_NOW_PLAYING_VIEW, nowPlayingView.value);
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

// --- Queue + playhead persistence (restore on relaunch) ---

// performance.now() of the last session write, so schedulePersistSession can
// throttle the flood of position-tick writes to one per SESSION_WRITE_INTERVAL_MS.
let lastSessionWrite = 0;
// Whether a non-null session is currently on disk, so we don't rewrite `null`
// every few seconds during lone (non-queue) playback — one clear is enough.
let sessionPersisted = false;

// Whether a queue is one we could honestly bring back next launch. Access is the
// whole question: the library roots are the only paths we hold a bookmark for, so
// a queue assembled from a Finder drop or an externally opened playlist has access
// for this launch only, and restoring it would hand back rows that cannot be read
// — the stale-and-unplayable case. A playlist is judged by its file, since that
// file is what gets re-read on restore (refreshPlaylistSnapshot) and what its rows
// come from; an ephemeral queue is judged by its rows, which are all it is.
function queueIsRestorable(q: Queue): boolean {
  return q.sourcePath
    ? insideLibraryRoots(q.sourcePath)
    : q.tracks.every((t) => insideLibraryRoots(t.path));
}

// Forget the saved session. Used both by the clear path below and by a restore
// that rejects what it read, so a session we refuse to honor doesn't sit on disk
// being re-read and re-rejected every launch.
async function clearPersistedSession(): Promise<void> {
  await app.store.set(KEY_PLAYBACK_SESSION, null);
  await app.store.save();
  sessionPersisted = false;
}

// Snapshot the current playback into the store, or clear it. Only a queue that is
// the audible pool and lives inside the library restores; everything else (lone
// track, stream, torn-down queue, anything dropped in or opened from outside)
// clears the key so relaunch doesn't resurrect a queue that isn't playing or
// can't be opened.
async function persistSessionNow(): Promise<void> {
  lastSessionWrite = performance.now();
  const q = activeQueue.value;
  if (!q || !queueIsActivePool() || !queueIsRestorable(q)) {
    if (!sessionPersisted) return; // already clear — nothing to do
    await clearPersistedSession();
    return;
  }
  const session: PersistedSession = {
    queue: q,
    index: queuePlayingIndex.value ?? 0,
    path: currentNodePath.value ?? "",
    time: currentTime.value,
    duration: duration.value,
  };
  await app.store.set(KEY_PLAYBACK_SESSION, session);
  await app.store.save();
  sessionPersisted = true;
}

// Structural changes (new queue, row change, pause, teardown) pass immediate=true
// to write at once; position ticks pass false and are throttled so continuous play
// writes at most once per interval (a plain debounce would defer forever mid-play).
function schedulePersistSession(immediate: boolean): void {
  if (immediate) {
    void persistSessionNow();
    return;
  }
  if (performance.now() - lastSessionWrite >= SESSION_WRITE_INTERVAL_MS) {
    void persistSessionNow();
  }
}

// Register the effects that keep the saved session current. Called after
// restorePlaybackSession so the effects' immediate first run re-saves the restored
// state rather than a blank one clobbering it.
function setupSessionPersistence(): void {
  // New queue / row change / teardown → write immediately.
  effect(() => {
    void activeQueue.value;
    void queuePlayingIndex.value;
    schedulePersistSession(true);
  });
  // Playhead ticks → throttled write, so a crash/quit loses at most a few seconds.
  effect(() => {
    void currentTime.value;
    schedulePersistSession(false);
  });
  // Capture the freshest position at each pause (the common quit-after-pause case).
  effect(() => {
    if (!isPlaying.value) schedulePersistSession(true);
  });
}

// A saved session carries the queue's rows as they stood at quit. For an
// ephemeral queue that snapshot IS the queue — there's nowhere else to read it
// from — but a real playlist has a backing .m3u8 that outranks it: the file can
// be edited by another app (or by hand) while we're closed, and it's re-read on
// every browse/play anyway, so restoring the stale snapshot is the one path that
// shows out-of-date rows until you navigate away and back. Re-read it here.
// A failed read (the file moved or was deleted) keeps the snapshot, so the
// session still restores rather than vanishing.
async function refreshPlaylistSnapshot(queue: Queue): Promise<Queue> {
  if (!queue.sourcePath) return queue;
  try {
    const data = await invoke<PlaylistData>("read_playlist", { path: queue.sourcePath });
    // Missing rows included, marked — same view the browse path builds.
    const tracks = playlistViewTracks(data);
    return {
      ...queue,
      title: data.name,
      subtitle: trackCountSubtitle(tracks),
      tracks,
      sourcePath: data.path,
    };
  } catch (e) {
    console.error("read_playlist failed", queue.sourcePath, e);
    return queue;
  }
}

// Rebuild the queue + playhead saved by the previous session, paused. The engine
// holds no track yet — app.pendingResume arms the first play to seed it here and
// seek to the saved position (togglePlayPause), so launch never blasts audio.
async function restorePlaybackSession(): Promise<void> {
  const s = await app.store.get<PersistedSession>(KEY_PLAYBACK_SESSION);
  if (!s?.queue || !Array.isArray(s.queue.tracks)) return;
  // Re-check reachability here and not just at write time, because the roots can
  // change while we're closed (one removed in Settings) and because a session
  // written by an older build predates the check entirely. Ordering matters: this
  // runs after hold-roots, so the roots it reads are the ones we actually hold.
  if (!queueIsRestorable(s.queue)) {
    await clearPersistedSession();
    return;
  }
  const queue = await refreshPlaylistSnapshot(s.queue);
  // The engine pool is playable rows only (missing files stay in the view but
  // never reach the engine), mirroring playQueue/playQueueTrack.
  const playable = queue.tracks.filter((t) => !t.missing);
  if (playable.length === 0) return;
  // Re-anchor the playhead on the saved *path*, not just its index: a re-read
  // playlist may have gained or lost rows above it. The saved index wins when it
  // still names that track (a playlist can hold the same file twice, and only the
  // index says which row was live); otherwise fall back to the first row with that
  // path, and to the clamped index when the track is gone from the playlist.
  const clamped = Math.min(Math.max(0, Math.trunc(s.index)), playable.length - 1);
  const found = playable.findIndex((t) => t.path === s.path);
  const idx = playable[clamped]?.path === s.path ? clamped : found >= 0 ? found : clamped;
  const track = playable[idx];
  // The saved position belongs to the saved track; if that track is gone, the row
  // we landed on starts from the top rather than inheriting a stranger's playhead.
  const sameTrack = track.path === s.path;

  // A synthetic queue: parent so queueIsActivePool() is true and the same pool
  // seeds the engine on the first play. A real playlist reuses its file-keyed path.
  const syntheticPath = queue.sourcePath
    ? `queue:playlist:${queue.sourcePath}`
    : "queue:restored";
  app.currentParent = syntheticParent(syntheticPath, queue.title, playable);
  openActiveQueue(queue);
  currentNodePath.value = track.path;
  queuePlayingIndex.value = idx;
  app.lastQueue = playable.map((t) => t.path);
  app.lastIndex = idx;
  app.queueEnded = false;

  const time = sameTrack && typeof s.time === "number" && s.time > 0 ? s.time : 0;
  currentTime.value = time;
  duration.value =
    sameTrack && typeof s.duration === "number" ? s.duration : track.duration ?? 0;
  const fallback = track.path.split(/[\\/]/).pop() ?? track.path;
  setNowPlaying(track.title ?? fallback, track.artist, track.album);
  void loadArt(track.path);

  // Open on the queue list (row highlighted), not the now-playing hero: the
  // restored queue IS the point of restoring, and behind the hero's nav-bar flip
  // it's easy to miss. Mirrors how an explicit Play verb reveals its list.
  listFaceOpen.value = true;

  sessionPersisted = true; // the key we just read is the on-disk state
  app.pendingResume = { time };
}

// Shared by the toolbar button and the Playback menu so both take the same path.
function toggleShuffle(): void {
  shuffleMode.value = !shuffleMode.value;
  // Seed the bag so a shuffle turned on mid-album has a full cycle ready;
  // clear it when turning shuffle off. Either way a fresh shuffle session starts
  // with no back-history (skipPrev falls back to restarting the current track).
  app.shuffleHistory = [];
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

// Change the ReplayGain mode and persist it. Pushing it to the engine and syncing
// the menu's radio checkmarks is handled by the reactive effect on replayGainMode
// (which also fires once on load). Unlike shuffle/repeat this doesn't touch
// playback flow, so there's no applyModeChange().
function setReplayGainMode(mode: ReplayGainMode): void {
  if (replayGainMode.value === mode) return;
  replayGainMode.value = mode;
  void app.store.set(KEY_REPLAYGAIN, mode).then(() => app.store.save());
}

// Turn "match device to file sample rate" on or off and persist it. Enabling
// takes effect when the engine next opens a track; disabling also makes the
// engine restore the pre-matching device rate when its ownership guard allows.
function setFollowSampleRate(enabled: boolean): void {
  if (followSampleRate.value === enabled) return;
  followSampleRate.value = enabled;
  void app.store.set(KEY_FOLLOW_SAMPLE_RATE, enabled).then(() => app.store.save());
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

// The splitter's own limits, in px: the left pane never shrinks past a usable
// navigator, and never grows so far that the right pane can't hold a queue. Every
// write of --left-width goes through here, so a drag and a programmatic nudge
// (ensureColumnRoom) can't disagree about how far the divider may go.
function setLeftWidth(px: number): void {
  const mainEl = document.getElementById("main-view") as HTMLElement;
  const max = mainEl.getBoundingClientRect().width - 200;
  document.documentElement.style.setProperty(
    "--left-width",
    `${Math.max(120, Math.min(max, px))}px`,
  );
}

async function persistLeftWidth(): Promise<void> {
  const final = getComputedStyle(document.documentElement).getPropertyValue("--left-width").trim();
  if (!final) return;
  await app.store.set(KEY_SPLITTER_WIDTH, final);
  await app.store.save();
}

// The pane widths the column layout is keyed off: the element each pane declares
// its `listcol` query container on (see styles.css), which is the pane's list
// *inside* the panel's insets — so the width read here is the one the container
// query compares, insets already discounted, rather than the pane's outer box.
function columnContainer(pane: ColumnPane): HTMLElement | null {
  return pane === "queue" ? queueListEl : document.querySelector(".nav-list.col-host");
}

// Matches `@container listcol (min-width: 28rem)` in styles.css — the fold gate.
// Resolved against the root font size the query itself resolves it against, so the
// two stay the same width rather than the same number.
const COLUMN_GATE_REM = 28;

// Move the divider until `pane` is wide enough for column mode, if it isn't.
// Registered with columns.ts as the pane's "make room" hook: below the gate the
// rows are one folded line and a header has nothing to label, so a "Show header"
// tick would otherwise be a switch with nothing behind it.
//
// Only ever in the direction that helps, and only by the shortfall — the pane
// lands exactly on the gate rather than at some remembered width, so the nudge is
// the smallest one that answers the request. setLeftWidth clamps it, so a window
// too narrow to give either pane 28rem moves as far as it can and the header stays
// hidden rather than squeezing the other pane out of existence.
function ensureColumnRoom(pane: ColumnPane): void {
  const box = columnContainer(pane);
  if (!box) return;
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
  const short = COLUMN_GATE_REM * rem - box.getBoundingClientRect().width;
  if (short <= 0) return;
  const leftEl = document.getElementById("left");
  if (!leftEl) return;
  const left = leftEl.getBoundingClientRect().width;
  // The left pane makes room by growing; the right pane by taking that width off
  // the left, which is the same divider in the other direction. A pixel past the
  // gate rather than exactly on it: the container's used inline size is fractional
  // and `min-width` compares that, so landing on the boundary can round to the
  // wrong side of it and the tick would do nothing after all.
  const room = short + 1;
  setLeftWidth(pane === "library" ? left + room : left - room);
  void persistLeftWidth();
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
      setLeftWidth(ev.clientX - mainLeft);
    };
    const onUp = async () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.classList.remove("dragging");
      splitterEl.classList.remove("dragging");
      await persistLeftWidth();
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

// The layout mode is derived purely from the current viewport size, so a
// manual resize past the breakpoint and the double-click toggle land on the
// exact same CSS state. window.inner* is logical px (matches the media queries
// and the MINI_MAX_* bounds) regardless of display scale factor.
function isMiniViewport(): boolean {
  return window.innerHeight <= MINI_MAX_HEIGHT || window.innerWidth <= MINI_MAX_WIDTH;
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
  if (storedNormal && storedNormal.height > MINI_MAX_HEIGHT && storedNormal.width > MINI_MAX_WIDTH) {
    normalSize = storedNormal;
  }
  const storedMini = await app.store.get<{ width: number; height: number }>(
    KEY_WINDOW_SIZE_MINI,
  );
  if (
    storedMini &&
    storedMini.width > 0 &&
    storedMini.height > 0 &&
    (storedMini.height <= MINI_MAX_HEIGHT || storedMini.width <= MINI_MAX_WIDTH)
  ) {
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

// Graphic equalizer. Ten fixed ISO frequency bands plus a preamp, each an
// abstract rectangular bar (−12...+12 dB) whose fill is painted from the center
// (0 dB) outward — up for boost, down for cut — rather than a native slider. The
// bar is still a real <input type=range> underneath (free drag + keyboard), just
// with the OS chrome hidden; we draw the fill with a CSS var gradient the way the
// seek bar does. The fill color follows --accent, and (stage 2) fades toward
// white with the live energy at that band.
// Slider 0 is the wideband preamp; the rest are per-band peaking gains at these
// center frequencies (matched to EQ_FREQS in the Rust engine). Labels are for
// display only — the engine owns the actual frequencies. "Preamp" is set apart
// from the ten frequency bands by a gap + divider (see .eq-band.preamp in CSS).
const EQ_BANDS = ["Preamp", "32", "64", "125", "250", "500", "1K", "2K", "4K", "8K", "16K"];
const eqSliders: HTMLInputElement[] = [];
const eqBandEls: HTMLElement[] = [];

// The persisted EQ curve: on/off, the preamp, and one gain per frequency band
// (all in dB). `gains` has EQ_BANDS.length − 1 entries (the preamp is separate).
type EqState = { enabled: boolean; preamp: number; gains: number[] };

// Persist the current sliders + on/off. Debounced (like volume) so dragging a
// band doesn't hammer the store; the trailing write captures the final curve.
const persistEq = debounce(async () => {
  const state: EqState = {
    enabled: eqEnabledEl.checked,
    preamp: Number(eqSliders[0].value),
    gains: eqBandGains(),
  };
  await app.store.set(KEY_EQ, state);
  await app.store.save();
}, 200);

// Paint one band's fill height: the bar fills from the bottom up to the slider's
// value, so a flat EQ sits half-height (0 dB = 50%), boosts grow taller and cuts
// shrink — always something on screen to see and to color. Exposed to the CSS
// track gradient as --fill (% of track height).
function paintBand(i: number): void {
  const v = Number(eqSliders[i].value); // −12...+12
  // Set the var on the slider itself: it declares its own --fill/--energy
  // defaults, which would shadow anything set on the parent .eq-band.
  eqSliders[i].style.setProperty("--fill", `${((v + 12) / 24) * 100}%`);
}

// The band gains (everything but the preamp at index 0).
function eqBandGains(): number[] {
  return eqSliders.slice(1).map((s) => Number(s.value));
}

// Send the current slider positions to the engine and remember them. Called from
// every user-driven change (a band drag, the on/off toggle, Reset), so the engine
// and the store stay in step with the sliders.
function pushEq(): void {
  void invoke("audio_set_eq", {
    enabled: eqEnabledEl.checked,
    preamp: Number(eqSliders[0].value),
    gains: eqBandGains(),
  });
  persistEq();
}

// Live per-band energy (0..1) from the engine's audio:spectrum feed, smoothed on
// screen with a fast attack / slow release so the bars punch on beats but ease
// back down (mirrors the visualizer's energy easing).
const eqEnergy = new Float32Array(EQ_BANDS.length - 1);
let eqLatestBands: number[] = [];

function setupEqualizer(restored: EqState | null): void {
  eqSliders.length = 0;
  eqBandEls.length = 0;
  // The restored curve, index-aligned to the sliders: slider 0 is the preamp, the
  // rest are the per-band gains. Missing/out-of-range values fall back to 0 (flat).
  const savedFor = (i: number): number => {
    if (!restored) return 0;
    const v = i === 0 ? restored.preamp : restored.gains[i - 1];
    return typeof v === "number" ? Math.max(-12, Math.min(12, v)) : 0;
  };
  eqBandsEl.replaceChildren(
    ...EQ_BANDS.map((label, i) => {
      const band = document.createElement("div");
      band.className = i === 0 ? "eq-band preamp" : "eq-band";
      const slider = document.createElement("input");
      slider.type = "range";
      slider.className = "eq-slider";
      slider.min = "-12";
      slider.max = "12";
      slider.step = "1";
      slider.value = String(savedFor(i));
      slider.setAttribute("aria-label", i === 0 ? "Preamp gain" : `${label} Hz gain`);
      slider.addEventListener("input", () => {
        paintBand(i);
        pushEq();
      });
      eqSliders.push(slider);
      eqBandEls.push(band);
      const cap = document.createElement("span");
      cap.className = "eq-band-label";
      cap.textContent = label;
      band.append(slider, cap);
      return band;
    }),
  );
  eqBandEls.forEach((_, i) => paintBand(i));

  // Restore the on/off state (defaults on, matching a fresh engine), then push the
  // restored curve straight to the engine so it reflects the sliders from the first
  // frame. Sent directly rather than through pushEq() to avoid a redundant store
  // write on every launch — the sliders already hold exactly what's persisted.
  eqEnabledEl.checked = restored ? restored.enabled : true;
  if (restored) {
    void invoke("audio_set_eq", {
      enabled: restored.enabled,
      preamp: Number(eqSliders[0].value),
      gains: eqBandGains(),
    });
  }

  // On/off bypasses the whole chain in the engine; the sliders stay put (and
  // stay editable) so it's an instant A/B against your curve. A subtle dimming
  // signals the bypassed state.
  const syncEnabled = () => {
    eqBandsEl.classList.toggle("bypassed", !eqEnabledEl.checked);
  };
  eqEnabledEl.addEventListener("change", () => {
    syncEnabled();
    pushEq();
  });

  // Reset flattens every slider (preamp included) back to 0.
  eqResetBtn.addEventListener("click", () => {
    eqSliders.forEach((s, i) => {
      s.value = "0";
      paintBand(i);
    });
    pushEq();
  });

  syncEnabled();
  setupEqSpectrum();
}

// Stage 2: drive each frequency band's fill color from accent (quiet) → white
// (loud) using the engine's live per-band energy. The rAF loop runs only while
// the Equalizer face is open, so it costs nothing otherwise (same gating idea as
// the visualizer). The preamp is wideband, not a frequency band, so it has no
// energy and stays plain accent.
function setupEqSpectrum(): void {
  void listen<{ bands: number[] }>("audio:spectrum", (e) => {
    eqLatestBands = e.payload.bands;
  });

  let rafId = 0;
  const frame = () => {
    // When bypassed, let the bars settle back to accent (energy → 0) rather than
    // pulsing a chain that isn't actually shaping the sound.
    const bypassed = !eqEnabledEl.checked;
    for (let b = 0; b < eqEnergy.length; b++) {
      const target = bypassed ? 0 : Math.min(1, eqLatestBands[b] ?? 0);
      // Fast attack, slow release.
      eqEnergy[b] += (target - eqEnergy[b]) * (target > eqEnergy[b] ? 0.5 : 0.12);
      // Sliders are offset by 1 (index 0 is the preamp). Set on the slider, not
      // the band, so it isn't shadowed by the slider's own --energy default.
      eqSliders[b + 1]?.style.setProperty("--energy", (eqEnergy[b] * 100).toFixed(1));
    }
    rafId = requestAnimationFrame(frame);
  };

  effect(() => {
    if (equalizerOpen.value) {
      if (!rafId) rafId = requestAnimationFrame(frame);
    } else if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
  });
}

// The full-pane panels are mutually exclusive and each one takes the pane the
// hero was covering, so opening any of them also leaves Zen Mode. Expressing that
// once keeps the four menu handlers from drifting apart.
type Panel = "settings" | "about" | "licenses" | "equalizer";
function openPanel(panel: Panel): void {
  settingsOpen.value = panel === "settings";
  aboutOpen.value = panel === "about";
  licensesOpen.value = panel === "licenses";
  equalizerOpen.value = panel === "equalizer";
  zenMode.value = false;
  if (panel === "licenses") void loadLicenses();
}

// The live visualizer, once it has mounted. Held at module scope only so the
// screenshot bridge can reach captureStill; nothing else should drive it from
// here — its start/stop belongs to the effect in setupSettings.
let visualizer: Visualizer | null = null;

function setupSettings(restoredEq: EqState | null): void {
  // Settings opens from the native application menu (Pudding → Settings..., ⌘,),
  // which emits "open-settings"; the topbar's old gear is now the mini-player
  // toggle. About (Pudding → About Pudding) shares the pane and emits
  // "open-about". Opening one closes the other; the single Back button dismisses
  // whichever is up, returning to now-playing. Opening either also leaves full
  // screen (a hero mode), since the panel takes the pane the hero was covering.
  // Equalizer (Playback → Equalizer, ⌥⌘E) is a third member of this family: same
  // pane, same Back button, mutually exclusive with Settings/About.
  void listen("open-settings", () => openPanel("settings"));
  void listen("open-about", () => openPanel("about"));
  void listen("open-licenses", () => openPanel("licenses"));
  void listen("open-equalizer", () => openPanel("equalizer"));
  settingsBackBtn.addEventListener("click", () => {
    settingsOpen.value = false;
    aboutOpen.value = false;
    licensesOpen.value = false;
    equalizerOpen.value = false;
  });
  setupEqualizer(restoredEq);

  // The visualizer mounts once into its layer inside the now-playing hero (not a
  // pane takeover). Its rAF loop runs only while it's the chosen hero view AND
  // the hero face is actually visible (not covered by the list, an editor, or a
  // panel), so it costs nothing otherwise. The idle sample preview keeps its art
  // face, but once Play loads that sample it behaves like every other track.
  void createVisualizer(nowPlayingVisualizerEl).then((viz) => {
    visualizer = viz;
    effect(() => {
      if (
        nowPlayingView.value === "visualizer" &&
        heroVisible.value &&
        !welcomeSamplePreview.value
      ) viz.start();
      else viz.stop();
    });
    // Announce each new track over the visualizer: flash its title/artist that
    // fades in and back out. Only when the visualizer is the visible view (no
    // point animating a hidden layer), and only on an actual change — not
    // when merely switching into the view or re-running for other signals.
    //
    // For streams we flash the ICY song/artist rather than the station name;
    // stations that never send metadata get nothing (an empty banner would just
    // repeat the station name already shown in the hero, so we skip it).
    let lastAnnounced = "";
    effect(() => {
      let title = npTitle.value;
      let artist = npArtist.value;
      if (isStream.value) {
        const meta = npStreamMeta.value;
        if (!meta) return;
        title = meta.song;
        artist = meta.artist;
      }
      const key = `${title}\n${artist ?? ""}`;
      const changed = key !== lastAnnounced;
      lastAnnounced = key;
      if (!changed || !title) return;
      if (nowPlayingView.value === "visualizer" && heroVisible.value) {
        viz.showTrack(title, artist);
      }
    });
  });

  // The About panel's main line is "pudding <version>"; the version is the app
  // version from tauri.conf.json, read via the Tauri app API.
  void getVersion().then((v) => { aboutVersionEl.textContent = `pudding ${v}`; });

  // The get-started prompts' inline settings links (Files: no library root,
  // Streams: no stream list path) open the settings panel.
  for (const id of ["files-empty-settings", "streams-empty-settings"]) {
    document
      .getElementById(id)
      ?.addEventListener("click", () => { settingsOpen.value = true; });
  }

  // Match-system checkbox: on = mode "system" (dark + light auto-swap with the
  // OS); off pins the appearance to whichever mode is currently live.
  themeMatchSystemEl.addEventListener("change", () => {
    setThemeMode(themeMatchSystemEl.checked ? "system" : effectiveMode());
  });
  effect(() => {
    themeMatchSystemEl.checked = themeMode.value === "system";
  });
  // The picker (both groups), rebuilt on any mode / OS-scheme / accent change.
  effect(renderThemePicker);

  // External links must go to the OS browser, not navigate the webview.
  document.addEventListener("click", (e) => {
    const link = (e.target as Element).closest?.("a[href^='http']");
    if (!(link instanceof HTMLAnchorElement)) return;
    e.preventDefault();
    void openUrl(link.href);
  });
}

// One dependency in the generated license manifest (public/licenses.json, built
// by scripts/gen-licenses.mjs). `text` indexes the shared `texts` array — the
// same Apache-2.0 body is quoted by hundreds of crates, so bodies are stored once
// and referenced.
//
// `elected` names which branch of an "or" license the shown text is, for packages
// offered under a choice; `note` replaces the text for the rare package that
// publishes no notice at all to reproduce. Exactly one of a real `text` or a
// `note` is always present — the generator fails the build otherwise.
interface LicenseComponent {
  name: string;
  version: string;
  ecosystem: "cargo" | "npm" | "rust" | "vendored";
  license: string;
  url: string;
  text: number;
  elected?: string;
  note?: string;
}

interface LicenseManifest {
  generated: string;
  app: { name: string; version: string; license: string; text: number };
  components: LicenseComponent[];
  texts: string[];
}

// The manifest is a static asset rather than an import so its ~1.5 MB of license
// text never enters the JS bundle: it's fetched the first time Help ▸ Licenses is
// opened and the rendered DOM is kept for later opens. A failed fetch clears the
// flag so reopening the panel retries.
let licensesLoaded = false;
async function loadLicenses(): Promise<void> {
  if (licensesLoaded) return;
  licensesLoaded = true;
  licensesBody.textContent = "Loading...";
  try {
    const res = await fetch("licenses.json");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    renderLicenses((await res.json()) as LicenseManifest);
  } catch (e) {
    console.error("loading licenses.json failed", e);
    licensesLoaded = false;
    licensesBody.textContent = "The license list could not be loaded.";
  }
}

// Build the license list: a summary line, then one collapsed row per dependency
// that expands to its actual license text. Rows are built eagerly (377 of them is
// nothing) but their license bodies are filled on first expand, so opening the
// panel doesn't put a megabyte of text into the DOM.
function renderLicenses(data: LicenseManifest): void {
  licensesBody.textContent = "";

  const intro = document.createElement("p");
  intro.className = "licenses-intro";
  intro.textContent =
    `${data.app.name} ${data.app.version} is ${data.app.license} licensed and is built on ` +
    `${data.components.length} open source packages, listed below with their license terms. ` +
    `This list is generated from the project's dependencies (last built ${data.generated}).`;
  licensesBody.append(intro);

  // Pudding's own license leads the list, then everything it depends on.
  const entries: LicenseComponent[] = [
    {
      name: data.app.name,
      version: data.app.version,
      ecosystem: "cargo",
      license: data.app.license,
      url: "https://github.com/incompl/pudding",
      text: data.app.text,
    },
    ...data.components,
  ];

  for (const c of entries) {
    const row = document.createElement("details");
    row.className = "license-entry";

    const summary = document.createElement("summary");
    const name = document.createElement("span");
    name.className = "license-name";
    name.textContent = c.name;
    const version = document.createElement("span");
    version.className = "license-version";
    version.textContent = c.version;
    const spdx = document.createElement("span");
    spdx.className = "license-spdx";
    spdx.textContent = c.license || "license not declared";
    summary.append(name, version, spdx);
    row.append(summary);

    const detail = document.createElement("div");
    detail.className = "license-detail";
    row.append(detail);

    // Filled once, on first expand.
    row.addEventListener("toggle", () => {
      if (!row.open || detail.childElementCount > 0) return;

      // Labelled "Source" rather than left as a bare link: the MPL-2.0 packages
      // (symphonia and friends) must tell you where to get their source, and for
      // everything else it's the project page anyway.
      const source = document.createElement("p");
      source.className = "license-source";
      source.append("Source: ");
      const link = document.createElement("a");
      link.href = c.url;
      link.textContent = c.url;
      source.append(link);
      detail.append(source);

      // Offered under a choice of licenses: say which one the text below is, so
      // it doesn't read as the package's only terms.
      if (c.elected) {
        const elected = document.createElement("p");
        elected.className = "license-elected";
        elected.textContent = `Offered as ${c.license}; shown here under ${c.elected}.`;
        detail.append(elected);
      }

      const body = document.createElement("pre");
      body.className = "license-text";
      // A handful of packages publish no notice anywhere to reproduce; the
      // generator records why, and that stands in for the text.
      body.textContent = c.text >= 0 ? data.texts[c.text] : (c.note ?? "");
      body.classList.toggle("license-text-missing", c.text < 0);
      detail.append(body);
    });

    licensesBody.append(row);
  }
}

// Render the appearance picker: a Dark group and a Light group, each a row of
// preview cards showing the accent on that mode's real black/white ground (see
// the .theme-card CSS). Selection follows the match-system checkbox — when
// matching, each group keeps its own selection (dark + light auto-swap with the
// OS) and the live one is marked; when not, a single card is selected across both
// groups and its group is the pinned mode. Reads themeMode + effectiveMode (the
// OS scheme) + both accents, so the effect re-runs on any of them.
function renderThemePicker(): void {
  const isSystem = themeMode.value === "system";
  const live = effectiveMode();
  themeSwatchesEl.innerHTML = "";
  for (const mode of ["dark", "light"] as const) {
    const selectedId = isSystem || mode === live ? accentIdFor(mode) : null;
    const head = h("div", { class: "theme-group-head" }, mode === "dark" ? "Dark" : "Light");
    const row = h("div", { class: "theme-group-row" });
    for (const t of themesForMode(mode)) {
      const isActive = t.id === selectedId;
      row.appendChild(
        h(
          "button",
          {
            class: "theme-card" + (isActive ? " active" : ""),
            attrs: { type: "button", title: t.name, "aria-pressed": isActive },
            style: {
              "--card-bg": MODE_BG[mode],
              "--card-accent": t.accent,
              "--card-accent-dim": t.accentDim,
            },
            on: { click: () => selectTheme(mode, t.id) },
          },
          h(
            "span",
            { class: "theme-card-preview" },
            h("span", { class: "theme-card-ring" }, h("span", { class: "theme-card-core" })),
          ),
          h("span", { class: "theme-card-label", text: t.name }),
        ),
      );
    }
    themeSwatchesEl.appendChild(h("div", { class: "theme-group" }, head, row));
  }
}

// Clicking a card sets that mode's accent. When not matching system, it also pins
// the appearance to that card's mode — so choosing a light card switches the app
// to light without touching the checkbox.
function selectTheme(mode: ThemeMode, id: string): void {
  setAccentFor(mode, id);
  if (themeMode.value !== "system") setThemeMode(mode);
}

// Walk the open list (queue or browsed playlist) by one row with the arrow keys.
// The navigable set is the playable rows — missing files are skipped, mirroring
// what a click/Enter can actually commit. With no list selection yet, ↓ lands on
// the first row and ↑ on the last (the natural "step into the list" from a fresh
// focus). Selection clamps at the ends rather than wrapping. Keeps the focused
// row on screen so it stays visible through a long list.
function moveListSelection(delta: 1 | -1): void {
  const list = openListTracks();
  if (list.length === 0) return;
  const sel = queueSel.signal.peek();
  const anchor = queueSel.anchor();
  const current =
    anchor && sel.has(anchor) ? anchor : sel.size === 1 ? [...sel][0] : null;
  // Where we step from: the focused row, or one past the near end so the first
  // step lands on the first (↓) / last (↑) row.
  let i = current ? list.indexOf(current) : delta > 0 ? -1 : list.length;
  do {
    i += delta;
  } while (i >= 0 && i < list.length && list[i].missing);
  if (i < 0 || i >= list.length) return; // already at the playable end
  queueSel.single(list[i]);
  app.lastSelectionPane = "list";
  revealQueueRow(i);
}

// The surface bare ↑/↓ (and Enter/Esc) drive. The right-pane queue is a persistent
// surface always on screen, so if the user last acted there it keeps the keyboard
// until they touch another pane. Otherwise arrows drive the left pane's *currently
// visible* list — the stream list (Streams tab), or the Browse tree / springboard
// navigator (Files tab). Deriving the left surface from what's on screen (rather
// than a stored pane) keeps arrows on the right list as the user drills Browse ↔
// the navigator, whose click may have left lastSelectionPane on the other one.
type KbdSurface = "list" | "tree" | "nav" | "stream";

function activeKbdSurface(): KbdSurface {
  if (app.lastSelectionPane === "list") return "list";
  if (activeTab.value === "streams") return "stream";
  return isBrowseActive() ? "tree" : "nav";
}

// ↑/↓: step the active surface's selection by one row.
function moveKbdSelection(delta: 1 | -1): void {
  switch (activeKbdSurface()) {
    case "list":
      moveListSelection(delta);
      break;
    case "tree":
      moveTreeSelection(delta);
      break;
    case "nav":
      navMove(delta);
      break;
    case "stream":
      moveStreamSelection(delta);
      break;
  }
}

// Enter: commit the active surface's selection (play a track/station, open a
// playlist, drill a view/album/artist, or expand a folder). Returns whether it acted.
function activateKbdSelection(): boolean {
  switch (activeKbdSurface()) {
    case "nav":
      return navActivate();
    case "tree":
      return activateTreeSelected();
    default:
      // list + stream both resolve through the pane-keyed playSelectedRow.
      return playSelectedRow();
  }
}

// Esc: drop the active surface's highlight. Returns whether there was one to drop
// (so Esc only swallows the key when it cleared something).
function clearKbdSelection(): boolean {
  switch (activeKbdSurface()) {
    case "list":
      if (queueSel.signal.peek().size === 0) return false;
      queueSel.clear();
      return true;
    case "tree":
      if (treeSelection.peek().size === 0) return false;
      clearTreeSelection();
      return true;
    case "nav":
      return navClearCursor();
    case "stream":
      if (selectedStreamUrl.peek() == null) return false;
      clearStreamSelection();
      return true;
  }
}

function setupPlayerControls(): void {
  playPauseBtn.addEventListener("click", togglePlayPause);
  prevBtn.addEventListener("click", skipPrev);
  nextBtn.addEventListener("click", skipNext);

  // The now-playing artist / album lines double as links into the Files pane:
  // click to drill straight to that artist's or album's detail view, the same
  // "Go to" the track context menu offers — a one-tap way back to the playing
  // track's home when you've wandered off browsing (see .np-link hover accent).
  // Hidden for streams / tagless tracks (the elements themselves are hidden), so
  // these only fire when there's a real artist/album to land on.
  // The title line reveals the track in its playing context (the pool feeding
  // autoadvance) — see revealNowPlaying for how the context is derived.
  // Listeners hang on the inner marquee span, not the full-width block, so a
  // click in the empty space beside the text is absorbed rather than firing the
  // link (the .np-link hover accent is scoped to the same span).
  nowPlayingTitleInner.addEventListener("click", () => {
    if (bundledSampleShown.value) return;
    revealNowPlaying();
  });
  nowPlayingArtistInner.addEventListener("click", () => {
    if (bundledSampleShown.value) return;
    if (npArtist.value) goToArtist(npArtist.value);
  });
  nowPlayingAlbumInner.addEventListener("click", () => {
    if (bundledSampleShown.value) return;
    if (npAlbum.value) goToAlbum(npAlbum.value, npAlbumArtist.value ?? npArtist.value ?? "");
  });

  document.addEventListener("keydown", (e) => {
    if (isTextInputTarget(e.target)) return;

    // Volume rides a modifier now (matching Apple Music's ⌘↑/⌘↓), freeing bare
    // ↑/↓ to walk the list. Any other modified key isn't ours — return without
    // preventDefault so ⌘F (search), ⌘S (save), the ⌘1–6 view switch, etc. still
    // reach their own handlers.
    if (e.metaKey || e.ctrlKey || e.altKey) {
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setVolume(volume.value + 0.1);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setVolume(volume.value - 0.1);
      }
      return;
    }

    // +/- as a mnemonic volume alias (=/_ so it works unshifted too).
    if (e.key === "+" || e.key === "=") {
      e.preventDefault();
      setVolume(volume.value + 0.1);
      return;
    }
    if (e.key === "-" || e.key === "_") {
      e.preventDefault();
      setVolume(volume.value - 0.1);
      return;
    }

    // Mute toggle on bare M (VLC's key). ⌘M stays Minimize — the modifier block
    // above already returned, so this only fires unmodified, and the text-input
    // guard at the top keeps "m" typeable in fields.
    if (e.key === "m" || e.key === "M") {
      e.preventDefault();
      toggleMute();
      return;
    }

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
      // Enter commits the active surface's selection (a plain click no longer
      // plays) — the queue, the navigator, the Browse tree, or the stream list.
      if (activateKbdSelection()) e.preventDefault();
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
      moveKbdSelection(-1);
      return;
    }

    if (e.key === "ArrowDown") {
      e.preventDefault();
      moveKbdSelection(1);
      return;
    }

    if (e.key === "Escape") {
      // No guard for an open context menu: it's a native menu, which takes the
      // keyboard while it's up, so its Esc never reaches this listener. One Esc
      // closes the menu, a second clears the highlight — as before, but AppKit's.
      // Bail out of keyboard navigation: drop the active surface's highlight (and
      // Enter's target with it).
      if (clearKbdSelection()) e.preventDefault();
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
  // The button is click-to-open, not hover-to-open: a merely passing pointer
  // never unfurls the bar over the transport. The first click opens it; a
  // second click, while it's open, toggles mute — so from closed a double-click
  // reads as mute/unmute, and a lone click can't silence playback by accident.
  volumeBtn.addEventListener("click", () => {
    if (volumePopoverOpen.value) {
      toggleMute();
    } else {
      volumePopoverOpen.value = true;
    }
  });

  // Dismissal stays hover-based: the bar folds away as soon as the pointer
  // leaves the button+popover cluster, so there's nothing extra to click.
  // A thumb drag is exempt — pointers routinely stray off a 120px bar mid-drag,
  // and closing there would drop `pointer-events` out from under the drag.
  let dragging = false;

  volumeControlEl.addEventListener("mouseleave", () => {
    if (!dragging) volumePopoverOpen.value = false;
  });

  volumeBar.addEventListener("pointerdown", () => {
    dragging = true;
  });

  window.addEventListener("pointerup", () => {
    if (!dragging) return;
    dragging = false;
    // Releasing outside the cluster is the deferred mouseleave.
    if (!volumeControlEl.matches(":hover")) volumePopoverOpen.value = false;
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
    const samplePreview = welcomeSamplePreview.value;
    const sampleShown = bundledSampleShown.value;
    // `welcome-sample` is the idle preview override that keeps the cover visible
    // even when Visualizer is the saved view. Drop it as soon as the sample is
    // actually loaded so playback gets the normal art/visualizer behavior.
    nowPlayingPanel.classList.toggle("welcome-sample", samplePreview);
    nowPlayingPanel.classList.toggle("bundled-sample", sampleShown);
    nowPlayingEmptyEl.classList.toggle(
      "hidden",
      hasTrack.value || sampleShown,
    );
  });
  effect(() => {
    nowPlayingTitleInner.textContent = bundledSampleShown.value
      ? BUNDLED_SAMPLE.title
      : npTitle.value;
    updateMarquee(nowPlayingTitleEl);
  });
  effect(() => {
    const artist = bundledSampleShown.value ? BUNDLED_SAMPLE.artist : npArtist.value;
    nowPlayingArtistInner.textContent = artist ?? "";
    nowPlayingArtistEl.classList.toggle("hidden", !artist);
    updateMarquee(nowPlayingArtistEl);
  });
  effect(() => {
    const album = bundledSampleShown.value ? BUNDLED_SAMPLE.album : npAlbum.value;
    nowPlayingAlbumInner.textContent = album ?? "";
    nowPlayingAlbumEl.classList.toggle("hidden", !album);
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
    // Keep the sample on the already-decoded preview URL after Play. Switching
    // to npArt here would hand the <img> between two reactive sources while the
    // engine starts, which can briefly drop the composited image to black even
    // though both sources contain the same data URL.
    const url = bundledSampleShown.value ? bundledSampleArt.value : npArt.value;
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
    playPauseGlyph.textContent = isPlaying.value ? "⏸" : "▶";
    playPauseBtn.setAttribute("aria-label", isPlaying.value ? "Pause" : "Play");
    // Freeze the playing-row equalizer bars while paused (CSS pins their animation
    // off body.playback-paused), matching the paused transport state.
    document.body.classList.toggle("playback-paused", !isPlaying.value);
  });
  effect(() => {
    // Idle play starts the first library entry, or the bundled welcome track on a
    // fresh/no-library install. It is disabled only when neither source is ready.
    playPauseBtn.disabled =
      !hasTrack.value &&
      !libraryHasContent.value &&
      !(welcomeSamplePreview.value && bundledSamplePath.value);
  });
  effect(() => {
    // Streams have no track to step between, so hide prev/next entirely (like
    // the seek row) rather than leave dead chrome. Otherwise prev is live
    // whenever play is (it restarts or steps back), and next disables at the
    // genuine end of the line so a dead press reads as unavailable. hasNextTrack
    // reads the pool via poolPaths, which subscribes to the activeQueue signal
    // for a live queue — so this re-runs when a drag-in grows the pool ahead.
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
    // A live queue row is the reactive signal for "a queue owns the playhead":
    // non-null only while a queue is the audible pool, null for folder play (and
    // when a queue rests drained). Drives this effect where queueIsActivePool()
    // — which reads non-reactive currentParent — cannot, so the highlight moves
    // even when the file path is unchanged (same track replayed from the tree).
    const queueOwnsPlayhead = queuePlayingIndex.value !== null;
    // Two orthogonal channels light a tree row (see .node-label.playing/.open in the
    // CSS): .playing is the equalizer glyph — "this row IS the active play context";
    // .open is the accent — "the right pane is currently showing this row". A playlist
    // takes .playing when its pool plays and .open when it's browsed; a track takes
    // .playing when it owns the playhead from the tree and .open when it does so while
    // the now-playing hero is the visible face (the mirror of a browsed playlist).
    const openPlaylist = shownPlaylistPath.value;
    // The playing playlist: a queue owns the playhead and that queue is a real
    // playlist (a backing file). Its tree row takes the glyph, mirroring how a played
    // folder lights its track row.
    const playingPlaylist =
      queueOwnsPlayhead && isPlaylistSource(activeQueue.value)
        ? (activeQueue.value!.sourcePath ?? null)
        : null;
    const heroShowsTrack = heroVisible.value;
    document
      .querySelectorAll(
        "#folder-tree .node-label.playing, #folder-tree .node-label.open, #streams-list .node-label.playing",
      )
      .forEach((el) => el.classList.remove("playing", "open"));
    // The glyph marks the context that owns the playhead, not every occurrence of the
    // same file. When a playlist/queue is the active pool it carries the glyph on its
    // own row (below / in the right pane), so the tree's copy of the track stays plain.
    if (path && !queueOwnsPlayhead) {
      const row = document.querySelector(
        `#folder-tree .node-label[data-path="${CSS.escape(path)}"]`,
      );
      row?.classList.add("playing");
      // ...and the accent when the hero (showing this track) is the visible face.
      if (heroShowsTrack) row?.classList.add("open");
    }
    if (playingPlaylist) {
      document
        .querySelector(`#folder-tree .node-label[data-path="${CSS.escape(playingPlaylist)}"]`)
        ?.classList.add("playing");
    }
    if (url) {
      document
        .querySelector(`#streams-list .node-label[data-stream-url="${CSS.escape(url)}"]`)
        ?.classList.add("playing");
    }
    // The playlist whose contents fill the list face is "open" (accent), whether it's
    // merely browsed or the playing source you played from.
    if (openPlaylist) {
      document
        .querySelector(`#folder-tree .node-label[data-path="${CSS.escape(openPlaylist)}"]`)
        ?.classList.add("open");
    }
  });

  // Paint the multi-select background reactively, so cmd/shift-click updates the
  // tree without a full re-render (renderTreeRow reapplies it on any rebuild).
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
  });

  // While Files has nothing to browse, the whole pane is a get-started prompt:
  // setup copy when no root is configured, recovery copy for an empty root.
  // render() owns both branches, so re-render whenever an input flips.
  effect(() => {
    libraryRootSet.value;
    libraryHasContent.value;
    libraryTreeLoaded.value;
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
  // even when paneView's own fields are unchanged. fetchingPath for the same
  // reason: the row the engine is parked on wears a "(Downloading...)" marker
  // that has to move with it (see rowStatus). The other end of that story — the
  // download landing — repaints through applyDownloaded instead, because it
  // rewrites the row's fields and not just its marker.
  effect(() => {
    const { list, isSource, showList, nav } = paneView.value;
    queuePlayingIndex.value;
    fetchingPath.value;
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

  // The navigator's leaf rows pick up the now-playing accent (+ the equalizer glyph):
  // repaint mounted rows when the current track moves. Light a row only when the leaf
  // list on screen IS the live pool — its stashed synthetic path equals the pool's —
  // matching the build-time paint above (lone play from the leaf or an explicit Play
  // album/artist of the same set light up; a foreign / reordered / ad-hoc pool leaves
  // them plain). The pool is read through currentPoolPath (not the non-reactive
  // app.currentParent) so a pool change alone repaints: replaying the track you're
  // already hearing from a different list leaves currentNodePath untouched.
  effect(() => {
    const path = currentNodePath.value;
    const heroShows = heroVisible.value;
    const isLivePool = app.navLeafPoolPath === currentPoolPath.value;
    document
      .querySelectorAll<HTMLElement>("#library-nav .nav-track-row")
      .forEach((el) => {
        const t = app.navLeafTracks[Number(el.dataset.rowIndex)];
        const playing = !!t && isLivePool && t.path === path;
        // .playing is the glyph; .open is the accent, shown only while the hero (which
        // is displaying this track) is the visible face — the leaf-list mirror of the
        // tree rule above.
        el.classList.toggle("playing", playing);
        el.classList.toggle("open", playing && heroShows);
      });
  });

  // The left pane's two track lists follow the engine's parked download the way the
  // queue does: the row it is fetching wears "(Downloading...)" and gives it back
  // when the wait moves on (see rowStatus). Both panes in one effect because both
  // read the one signal, and only the rows currently mounted need touching — a row
  // scrolled in later reads fetchingPath as it is built.
  //
  // Only the marker. The download *finishing* is the other half of the story and
  // goes through applyDownloaded, which rewrites the row's tags, times and rate as
  // well, and so rebuilds these lists rather than patching a span.
  effect(() => {
    const fetching = fetchingPath.value;
    repaintTreeStatus(fetching);
    document
      .querySelectorAll<HTMLElement>("#library-nav .nav-track-row:not(.colhead)")
      .forEach((el) => {
        const t = app.navLeafTracks[Number(el.dataset.rowIndex)];
        const cell = el.querySelector<HTMLElement>(".nav-cell");
        if (t && cell) applyCellStatus(cell, rowStatus(t, fetching));
      });
  });

  // The navigator's playlist rows (Playlists view) carry the same two channels as the
  // tree: .open (accent) for the browsed playlist, .playing (equalizer glyph) for the
  // one whose pool is playing. Repaint mounted rows when either changes; a freshly
  // built row paints itself (see the playlist loop in library-nav), so this only
  // covers changes while it stays mounted.
  effect(() => {
    const open = shownPlaylistPath.value;
    const queueOwnsPlayhead = queuePlayingIndex.value !== null;
    const playing =
      queueOwnsPlayhead && isPlaylistSource(activeQueue.value)
        ? (activeQueue.value!.sourcePath ?? null)
        : null;
    document
      .querySelectorAll<HTMLElement>("#library-nav .nav-row[data-playlist-path]")
      .forEach((el) => {
        const p = el.dataset.playlistPath;
        el.classList.toggle("open", !!p && p === open);
        el.classList.toggle("playing", !!p && p === playing);
      });
  });

  effect(() => {
    const settings = settingsOpen.value;
    const about = aboutOpen.value;
    const licenses = licensesOpen.value;
    const equalizer = equalizerOpen.value;
    // Settings, About and Equalizer are mutually exclusive and all dismissed by
    // the same Back button, so the action cluster (Back / search / mode toggles)
    // keys off whether *any* is open. But they split on how much they cover:
    // Settings/About take the whole pane (transport included), while the
    // Equalizer is a face of the now-playing panel (like the editor) that leaves
    // the transport row put — you tune while listening. So only Settings/About
    // hide the now-playing panel; the Equalizer just adds `.show-eq`. (The
    // visualizer is in neither group — it's a hero view, not a takeover.)
    const panelOpen = settings || about || licenses || equalizer;
    const paneCovered = settings || about || licenses;
    settingsPanel.classList.toggle("hidden", !settings);
    aboutPanel.classList.toggle("hidden", !about);
    licensesPanel.classList.toggle("hidden", !licenses);
    nowPlayingPanel.classList.toggle("show-eq", equalizer);
    nowPlayingPanel.classList.toggle("hidden", paneCovered);
    miniplayerBtn.classList.toggle("hidden", panelOpen);
    settingsBackBtn.classList.toggle("hidden", !panelOpen);
    // Search targets the library/streams, not these panels — hide it here too so
    // the whole action cluster (search + mode toggles) clears out together rather
    // than leaving a lone search box beside the Back button.
    searchEl.classList.toggle("hidden", panelOpen);
  });

  // The playback-mode toggles only act on the files queue, but we keep them
  // visible in the streams view too: they take little space, do no harm there,
  // and leaving them put avoids shuffling the search box as tabs switch. Only
  // the settings/about panels hide them.
  effect(() => {
    playbackModesEl.classList.toggle(
      "hidden",
      settingsOpen.value || aboutOpen.value || licensesOpen.value || equalizerOpen.value,
    );
  });

  // Now Playing view (art vs. visualizer): a class on the panel that CSS uses to
  // swap the art/text card for the visualizer canvas layer. The transport
  // controls and nav bar are siblings, so they stay put under either view.
  effect(() => {
    nowPlayingPanel.classList.toggle(
      "view-visualizer",
      nowPlayingView.value === "visualizer",
    );
  });

  // Zen Mode: the hero covers the window, controls auto-hide on idle. Only
  // meaningful while the hero face is up, so if a list/editor/panel takes the
  // pane the body class drops even though the preference is retained — it
  // re-applies when the hero returns. Not persisted.
  let idleTimer = 0;
  const armIdle = (): void => {
    document.body.classList.remove("np-idle");
    window.clearTimeout(idleTimer);
    if (zenMode.value) {
      idleTimer = window.setTimeout(
        () => document.body.classList.add("np-idle"),
        2500,
      );
    }
  };
  // Reset the idle timer on *real* pointer movement only. The animating
  // visualizer canvas makes WebKit re-fire mousemove for a stationary pointer
  // (the pixels beneath it change each frame), which would otherwise keep the
  // timer pinned and the controls permanently visible in visualizer zen mode.
  let lastX = -1;
  let lastY = -1;
  document.addEventListener("mousemove", (e) => {
    if (e.clientX === lastX && e.clientY === lastY) return;
    lastX = e.clientX;
    lastY = e.clientY;
    armIdle();
  });
  effect(() => {
    const zen = zenMode.value && heroVisible.value;
    document.body.classList.toggle("np-zen", zen);
    if (zen) {
      armIdle();
    } else {
      window.clearTimeout(idleTimer);
      document.body.classList.remove("np-idle");
    }
  });
  // Keep the View ▸ Zen Mode checkmark in sync (menu, ⌘⇧F, and Escape all flip
  // the signal). Tracks the preference itself, not the hero-gated body class, so
  // the mark reflects what ⌘⇧F will do even while a list face is up.
  effect(() => {
    void invoke("set_zen_mode_checked", { on: zenMode.value });
  });

  // Entering Zen Mode only makes sense while the hero owns the pane; exiting
  // always works. View ▸ Zen Mode (⌘⇧F) and Escape relay here.
  const toggleZen = (on?: boolean): void => {
    const next = on ?? !zenMode.value;
    if (next && !heroVisible.value) return;
    zenMode.value = next;
  };
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && zenMode.value) {
      toggleZen(false);
    }
  });
  void listen("np-zen-toggle", () => toggleZen());

  // Flip the hero between album art and the visualizer, then persist. The only
  // control is View ▸ Visualizer (⌘T); the menu checkmark re-syncs through the
  // effect below (which fires because the value always changes here).
  const toggleVisualizer = (): void => {
    nowPlayingView.value =
      nowPlayingView.value === "visualizer" ? "art" : "visualizer";
    void persistNowPlayingView();
  };
  void listen("np-view-toggle", () => toggleVisualizer());
  effect(() => {
    void invoke("set_now_playing_view_checked", { view: nowPlayingView.value });
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
  // Boot profiler (off unless `localStorage.puddingBootPerf = "1"`): arm the
  // long-task observer before any work so the first-paint freeze is captured.
  bootProfileStart();

  if (navigator.userAgent.includes("Mac")) {
    document.body.classList.add("platform-mac");
  }

  // Right-click fall-through. Every meaningful target builds its own menu (the
  // contextmenu handlers on rows), but anything else — padding, the topbar, an
  // empty pane — drops through to WebKit's built-in menu. Release builds compile
  // devtools out, so that menu is a lone "Reload" that silently restarts the
  // frontend: never what a music player's user wants. Suppress it, keeping the
  // one exception macOS itself makes — real text has a menu, chrome doesn't.
  //
  // Two passes, because "real text" has to win at both ends. Capture runs ahead
  // of the row handlers and hands editable fields straight to WebKit: the inline
  // playlist rename field lives inside a row that opens its own menu, so without
  // this, right-clicking mid-rename offers Play/Delete instead of Paste.
  document.addEventListener(
    "contextmenu",
    (e) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest("input, textarea, [contenteditable='true']")) {
        e.stopPropagation();
      }
    },
    true,
  );
  // Bubble is the backstop for whatever no row claimed. Selected prose keeps its
  // native menu (Copy / Look Up / Services) — the selectable set is the
  // user-select: text opt-in list in styles.css — and dev keeps the default menu
  // outright, so Inspect Element stays one right-click away.
  if (!import.meta.env.DEV) {
    document.addEventListener("contextmenu", (e) => {
      const target = e.target as HTMLElement | null;
      const prose = target?.closest(
        "#now-playing-title, #now-playing-artist, #now-playing-album, #now-playing-stream-meta",
      );
      const sel = window.getSelection();
      const selected =
        !!prose &&
        !!sel &&
        !sel.isCollapsed &&
        sel.rangeCount > 0 &&
        sel.getRangeAt(0).intersectsNode(prose);
      if (!selected) e.preventDefault();
    });
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
  nowPlayingMainEl.addEventListener("dblclick", (e) => {
    // The overlay view toggle sits atop the hero, so double-clicking it has its
    // own effect — don't also toggle the mini player.
    if ((e.target as HTMLElement).closest("button")) return;
    void toggleMiniPlayer();
  });
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

  await bootStep("bindDom", () => bindDom());
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
  // Hover-to-read for whatever the columns had to clip, in both table panes. Armed
  // on the two hosts that outlive their lists — the navigator replaces its list on
  // every drill, and both panes window their rows — so no rebuild has to remember
  // to re-arm it. See overflow-title.ts.
  attachOverflowTitles(document.querySelector("#library-nav") as HTMLElement);
  attachOverflowTitles(queueListEl);
  queueCloseBtn.addEventListener("click", closeQueue);
  // Clicking anywhere on the title — the text or the hover pencil — starts an
  // inline rename; startTitleEdit no-ops when the header isn't a playlist.
  (document.querySelector("#queue-title") as HTMLElement).addEventListener("click", startTitleEdit);
  // Dropping onto the list's empty area (below the last row, or an empty playlist)
  // targets the end of the list — that case is resolved by updateDropTarget's
  // hit-test against the list box, so no container drop listener is needed.

  app.store = await bootStep("load-store", () =>
    invoke<string>("settings_path").then((path) => load(path, { defaults: {}, autoSave: false })),
  );

  // Resolve the built-in welcome track and read its embedded cover before the
  // first hero render. Failure is non-fatal: the ordinary idle state remains.
  try {
    await bootStep("prepare-bundled-sample", prepareBundledSample);
  } catch (error) {
    console.error("bundled sample failed", error);
  }

  // Per-pane column sets, header visibility, and the library sort. Loaded before
  // anything renders, so the first paint is already the user's layout — no flash
  // of the automatic columns followed by a rebuild.
  await loadColumnPrefs();

  // No implicit library on first run: existing saved folders remain intact, while
  // a missing key starts in the bundled-sample onboarding state. Choosing a folder
  // in Settings is the only action that establishes a library root.
  const storedRoots = await app.store.get<string[]>(KEY_LIBRARY_ROOTS);
  app.libraryRoots = storedRoots ?? [];
  app.rootBookmarks =
    (await app.store.get<Record<string, string>>(KEY_ROOT_BOOKMARKS)) ?? {};
  // Reclaim the sandbox grant on each root before anything reads one. Everything
  // downstream — the tree listing, the scan, the watchers, playback — opens plain
  // paths, which is only true because the backend is holding those grants by the
  // time they run. See holdLibraryRoots.
  await bootStep("hold-roots", () => holdLibraryRoots());
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
  setLastNonZeroVolume(volume.value);

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

  // ReplayGain mode (defaults off). The effect below pushes it to the engine and
  // syncs the menu radio on this initial set and after any change.
  const storedRg = await app.store.get<ReplayGainMode>(KEY_REPLAYGAIN);
  replayGainMode.value = storedRg === "track" || storedRg === "album" ? storedRg : "off";

  // Device sample-rate following (defaults off). Same effect-driven wiring as
  // ReplayGain below: seeded into the engine and the menu on this initial set.
  followSampleRate.value = (await app.store.get<boolean>(KEY_FOLLOW_SAMPLE_RATE)) ?? false;

  // Now Playing view (album art vs. visualizer), defaults to art. The reactive
  // sync effect in setupSettings re-checks the matching menu radio item.
  nowPlayingView.value =
    (await app.store.get<NowPlayingView>(KEY_NOW_PLAYING_VIEW)) === "visualizer"
      ? "visualizer"
      : "art";

  // The saved equalizer curve, handed to setupSettings → setupEqualizer below to
  // seed the sliders and re-push to the engine on launch.
  const restoredEq = (await app.store.get<EqState>(KEY_EQ)) ?? null;

  // Appearance: read the persisted mode + per-mode accents, then wire the apply
  // effect + OS-scheme listener. applyTheme runs immediately (first effect pass),
  // painting the saved theme before setupSettings renders the swatch row.
  await loadThemeSettings();
  setupTheme();

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
  // ReplayGain: push the mode to the engine and check the matching menu radio.
  // Fires on load (seeding the engine from the persisted value) and after any change.
  effect(() => {
    const mode = replayGainMode.value;
    void invoke("audio_set_replaygain", { mode });
    void invoke("set_replaygain_checked", { mode });
  });
  // Sample-rate following: same shape as ReplayGain — push to the engine, check
  // the menu box, on load and after any change.
  effect(() => {
    const enabled = followSampleRate.value;
    void invoke("audio_set_follow_sample_rate", { enabled });
    void invoke("set_follow_sample_rate_checked", { enabled });
  });

  // Recently opened playlists and tracks → the OS "Open Recent ▸" submenu. Hand
  // the native menu its row glyphs first, so the first draw below already has
  // them, then load the persisted list and push it over.
  await primeRecentIcons();
  hydrateRecentItems(await app.store.get<RecentItem[]>(KEY_RECENT_ITEMS));
  syncRecentItemsMenu();

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

  // Keep "Move Playlist File..." enabled only while a playlist is open — browsed,
  // else playing (openPlaylistPath). There's no file to relocate otherwise, and
  // enabling it mirrors exactly what menuMovePlaylist would act on.
  effect(() => {
    void browsedPlaylist.value;
    void activeQueue.value;
    void invoke("set_move_playlist_enabled", { enabled: openPlaylistPath() != null });
  });

  // Keep Edit ▸ Undo / Redo enabled in step with what ⌘Z would do. Our custom items
  // own ⌘Z / ⌘⇧Z (they replace the predefined ones), so they must be enabled both
  // while a text field is focused — so the key reaches us to drive the field's own
  // undo — and when a curation is undoable. Reads the history version (bumped on
  // every push/pop) and, via canUndoCuration, the browsed/active-queue signals, so
  // switching lists or editing either re-runs it.
  effect(() => {
    void curationHistoryVersion.value;
    const typing = editingText.value;
    void invoke("set_edit_undo_state", {
      undo: typing || canUndoCuration(),
      redo: typing || canRedoCuration(),
    });
  });

  // Edit ▸ Undo / Redo (also ⌘Z / ⌘⇧Z, which the custom native items own). Routed by
  // focus the way the macOS responder chain routes a native Undo: a focused text
  // field gets its own editing undo (execCommand — the predefined selector that
  // would otherwise supply it is gone); anything else gets curation undo.
  await listen<string>("menu:edit", (event) => {
    const redo = event.payload === "redo";
    if (isTextInputTarget(document.activeElement)) {
      document.execCommand(redo ? "redo" : "undo");
    } else if (redo) {
      redoCuration();
    } else {
      undoCuration();
    }
  });

  // Track text-field focus so the effect above keeps ⌘Z enabled for text undo while
  // typing. focusout lands on <body> (a non-text element) → false.
  const refreshEditingText = () => {
    editingText.value = isTextInputTarget(document.activeElement);
  };
  document.addEventListener("focusin", refreshEditingText);
  document.addEventListener("focusout", refreshEditingText);

  // File menu intents (New Playlist / Save Queue as Playlist / Move Playlist File).
  // Open... is handled in Rust; Open Recent has its own events below.
  await listen<string>("menu:playlist", (event) => {
    switch (event.payload) {
      case "new":
        void menuNewPlaylist();
        break;
      case "save":
        void menuSavePlaylist();
        break;
      case "move":
        void menuMovePlaylist();
        break;
    }
  });
  // An Open Recent row carries its own path. It routes through the same opener as
  // ⌘O and the Finder, so a playlist row browses, a track row plays, and clicking
  // one bumps it back to the top of the list.
  await listen<string>("menu:open-recent", (event) => {
    openAssociatedFile(event.payload);
  });
  await listen("menu:recent-clear", () => {
    app.recentItems = [];
    void persistRecentItems();
    syncRecentItemsMenu();
  });

  setupTabs();
  // Debug perf timing for the whole-library loaders: set `__perfLog = true` in the
  // devtools console, then open a view. Logs how long invoke+IPC+JSON.parse took and
  // the row count — i.e. the pre-render pause, which windowing does not address.
  const perfTimed = async <T>(label: string, run: () => Promise<T>): Promise<T> => {
    if (!(globalThis as { __perfLog?: boolean }).__perfLog) return run();
    const t0 = performance.now();
    const out = await run();
    const n = Array.isArray(out) ? out.length : "";
    console.log(`[perf] ${label}: ${(performance.now() - t0).toFixed(1)}ms (${n} rows)`);
    return out;
  };
  // Inject the leaf-list builder + backend loaders the navigator needs; keeping
  // them as deps (rather than a value import back into this entry module) avoids a
  // circular import while letting the navigator reuse the shared row behavior.
  void bootStep("init-nav", () => initLibraryNav({
    listAllSongs: () =>
      perfTimed("list_all_songs", async () => {
        // Columnar wire format (see the Rust SongRow): rows arrive as positional
        // tuples, not keyed objects, so the JSON doesn't repeat the field names once
        // per row (a large share of the payload + parse cost at the scale target).
        // The tuple order must match the Rust SongRow SELECT in lockstep. Re-key here
        // at the boundary; the rest of the app still works in SearchTrack objects.
        // track is always null for this flat list (the gutter shows a positional
        // index), which is why it isn't in the tuple.
        type SongRow = [
          path: string,
          title: string | null,
          artist: string | null,
          album: string | null,
          albumArtist: string | null,
          disc: number | null,
          year: number | null,
          genre: string | null,
          duration: number | null,
          bitrate: number | null,
          sampleRate: number | null,
          bitDepth: number | null,
          gain: number | null,
          created: number | null,
          modified: number | null,
          notDownloaded: boolean,
        ];
        const rows = await invoke<SongRow[]>("list_all_songs");
        return rows.map(
          ([
            path,
            title,
            artist,
            album,
            albumArtist,
            disc,
            year,
            genre,
            duration,
            bitrate,
            sampleRate,
            bitDepth,
            gain,
            created,
            modified,
            notDownloaded,
          ]): SearchTrack => ({
            path,
            title,
            artist,
            album,
            albumArtist,
            disc,
            year,
            genre,
            duration,
            bitrate,
            sampleRate,
            bitDepth,
            gain,
            created,
            modified,
            notDownloaded,
            track: null,
          }),
        );
      }),
    listAllArtists: () => invoke<SearchArtist[]>("list_all_artists"),
    listAllAlbums: () => invoke<SearchAlbum[]>("list_all_albums"),
    playlistIndex: () => ({
      loaded: app.playlistIndexLoaded,
      items: app.playlistIndex,
    }),
    artistAlbums: (artist) => invoke<SearchAlbum[]>("artist_albums", { artist }),
    artistTracks: (artist) =>
      invoke<SearchTrack[]>("artist_tracks", { artist }),
    albumTracks: (album, albumArtist) =>
      invoke<SearchTrack[]>("album_tracks", { album, albumArtist }),
    renderLeafTrackList,
    // A playlist row: single-click opens it in the right pane, double-click plays.
    openPlaylist: (path) => void browsePlaylistPath(path),
    playPlaylist: (path) => void playPlaylistPath(path),
    // The playlist filling the list face, for the nav row's "open" accent highlight
    // (browsed, or the playing source you played from).
    openPlaylistPath: () => shownPlaylistPath.peek(),
    // The playing playlist path, for the nav row's equalizer glyph — a queue owns the
    // playhead and that queue is a real playlist (a backing file).
    playingPlaylistPath: () =>
      queuePlayingIndex.peek() !== null && isPlaylistSource(activeQueue.peek())
        ? (activeQueue.peek()!.sourcePath ?? null)
        : null,
    showArtistMenu: showArtistContextMenu,
    showAlbumMenu: showAlbumContextMenu,
    showPlaylistMenu: showPlaylistContextMenu,
    startPlaylistRename: startNavPlaylistRename,
    persistLocation: persistNavLocation,
    // Mid-refresh nothing is known yet, so claim the panel is fine and let the
    // tree show its own "Loading..." — the prompt appearing and vanishing on every
    // boot would be worse than a beat of springboard.
    libraryEmpty: () =>
      !libraryTreeLoaded.value
        ? null
        : !libraryRootSet.value
          ? "no-root"
          : !libraryHasContent.value
            ? "empty"
            : null,
    setBrowseActive,
    markNavFocused: () => {
      app.lastSelectionPane = "nav";
    },
    clearNavSelection: () => {
      const had = navSel.signal.peek().size > 0;
      navSel.clear();
      return had;
    },
  }, navLocation));
  setupPlaybackModes();
  await setupWindowSize(appWindow);
  setupSplitter(splitterWidth);
  setupSettings(restoredEq);
  setupSearch();
  setupPlayerControls();
  setupVolumeControl();
  // Restore the previous session's queue + playhead (paused) BEFORE wiring the
  // persistence effects, so their immediate first run re-saves the restored state
  // instead of a blank one overwriting the saved session.
  await bootStep("restore-session", () => restorePlaybackSession());
  setupSessionPersistence();
  await bootStep("setup-effects", () => setupEffects());

  renderLibraryRootRows();
  streamListPathInput.value = streamListPath;

  // The + under the library rows appends a folder via the same picker as a row's
  // Choose... button.
  libraryRootAddBtn.addEventListener("click", () => void browseLibraryRoot());
  streamListPathBrowseBtn.addEventListener("click", () => void browseStreamListPath());

  // The stream field also accepts a typed/pasted path: Enter commits (blur fires
  // "change"), and change re-reads the stream list via the same path as the
  // Choose... button. (Library rows wire their own inputs in renderLibraryRootRows.)
  streamListPathInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") streamListPathInput.blur();
  });
  streamListPathInput.addEventListener("change", () => {
    void setStreamListPath(streamListPathInput.value.trim());
  });

  // Scan-status footer: reveals a thin determinate bar + count at the bottom of the
  // left pane, but only for scans that outlive a short debounce — routine watcher
  // rescans (a tag edit, a single added file) finish in well under it and never
  // paint, so the footer stays collapsed and the UI quiet.
  const scanStatus = (() => {
    const root = document.getElementById("scan-status")!;
    const fill = document.getElementById("scan-status-fill")!;
    const label = document.getElementById("scan-status-label")!;
    const REVEAL_DELAY_MS = 300;
    let revealTimer: number | null = null;

    const render = (done: number, total: number): void => {
      label.textContent =
        done > 0
          ? `Scanning... ${done.toLocaleString()} of ${total.toLocaleString()}`
          : "Scanning...";
      fill.style.width = total > 0 ? `${(done / total) * 100}%` : "0%";
    };

    return {
      start(total: number): void {
        render(0, total);
        // Arm the reveal once; a scan already onscreen (a coalesced follow-up pass)
        // keeps its bar rather than restarting the timer.
        if (revealTimer === null && !root.classList.contains("scanning")) {
          revealTimer = window.setTimeout(() => {
            revealTimer = null;
            root.classList.add("scanning");
          }, REVEAL_DELAY_MS);
        }
      },
      progress(done: number, total: number): void {
        render(done, total);
      },
      done(): void {
        if (revealTimer !== null) {
          clearTimeout(revealTimer);
          revealTimer = null;
        }
        root.classList.remove("scanning");
      },
    };
  })();

  await listen<ScanProgress>("scan-started", (event) => {
    scanStatus.start(event.payload.total);
  });
  await listen<ScanProgress>("scan-progress", (event) => {
    scanStatus.progress(event.payload.done, event.payload.total);
  });

  await listen<ScanResult>("library-scanned", (event) => {
    scanStatus.done();
    if (!event.payload.ok) {
      console.error("library scan failed:", event.payload.error);
      return;
    }
    void refreshLibrary();
    // The scan changed what's on disk, so the memoized view lists are stale. Drop
    // them unconditionally — even while an inline edit blocks the pane refresh below,
    // the cache must not outlive the data it mirrors, or a later open serves stale
    // rows.
    invalidateNavListCache();
    // Also refresh the open navigator view/detail pane so new/changed tracks show
    // without leaving and re-entering. Skip while an inline edit is open — like
    // refreshLibrary, a rebuild would tear out the edit input.
    if (!app.inlineEditing) refreshNavPaneAfterScan();
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
  await listen<string>("menu:replaygain", (event) => {
    setReplayGainMode(event.payload as ReplayGainMode);
    // Like Repeat: the clicked item auto-toggled its own checkmark. If it was
    // already the active mode, setReplayGainMode is a no-op and the effect won't
    // fire, leaving the trio wrongly checked — re-sync explicitly.
    void invoke("set_replaygain_checked", { mode: replayGainMode.value });
  });
  await listen<boolean>("menu:follow-sample-rate", (event) => {
    setFollowSampleRate(event.payload);
  });
  await listen<string>("menu:volume", (event) => {
    setVolume(volume.value + (event.payload === "up" ? 0.1 : -0.1));
  });
  await listen("menu:mute", () => toggleMute());
  await listen("menu:miniplayer", () => void toggleMiniPlayer());

  // Make the window a target for music dragged out of Finder. Independent of the
  // curation drag in drag-drop.ts — that one is pointer-based precisely because
  // this native handler exists — so the two never contend for a gesture.
  await bootStep("init-file-drop", () =>
    initFileDrop().catch((e) => console.error("initFileDrop failed", e)),
  );

  // Drain any file passed at launch (cold start). Must happen after the
  // open-file listener is registered so the ready-flag race is closed.
  const pendingOpen = await invoke<string | null>("frontend_ready");
  if (pendingOpen) {
    openAssociatedFile(pendingOpen);
  }

  await bootStep("refresh-tree", () => refreshTree(app.libraryRoots));
  void refreshPlaylistIndex();
  await bootStep("refresh-streams", () => refreshStreams(streamListPath));

  // Flush the boot report once init's synchronous work is done. Deferred inside
  // (setTimeout) so post-init paint/layout freezes are captured too.
  bootProfileReport();

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
      // The audible pool's identity and the leaf list on screen: equal means the
      // list you're looking at is the one feeding playback (its rows light up).
      currentPoolPath: currentPoolPath.value,
      navLeafPoolPath: app.navLeafPoolPath,
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
      setWindowSize: async (arg) => {
        const { width, height } = arg as { width: number; height: number };
        if (!(width > 0 && height > 0)) throw new Error("invalid window size");
        await getCurrentWindow().setSize(new LogicalSize(width, height));
      },
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
      // Open one of the full-pane panels the way its menu item does. The
      // screenshot suite needs Settings and the Equalizer, which are otherwise
      // reachable only through the native menu bar (undrivable from here).
      openPanel: (arg) => openPanel((arg as { panel: Panel }).panel),
      // Run a search through the real input path — assigning the value and
      // firing the event the listener is bound to, rather than calling runSearch
      // behind its back, so the results pane opens exactly as it does for a user.
      search: (arg) => {
        searchInput.focus();
        searchInput.value = String((arg as { query: string }).query);
        searchInput.dispatchEvent(new Event("input", { bubbles: true }));
      },
      // Open the tag editor for a path through the shared "Edit metadata..."
      // verb, so the pane editor is built and seeded the same way every context
      // menu builds it.
      editMetadata: (arg) => editTags(String((arg as { path: string }).path)),
      // Every path a panel puts on screen. Settings shows the library folders and
      // the stream list as absolute paths from whichever machine ran a capture,
      // and it carries them as input *values* — invisible to a text or pixel
      // assertion. The screenshot suite ships that panel in a public image, so it
      // reads these back and proves each one is a fixture path before the
      // shutter — an assertion, not a hope.
      panelPaths: (arg) => {
        const selector = String((arg as { selector: string }).selector);
        const panel = document.querySelector(selector);
        if (!panel) throw new Error(`panelPaths: no element for ${selector}`);
        return [...panel.querySelectorAll<HTMLInputElement>("input[type='text']")]
          .map((input) => input.value);
      },
      // Freeze the visualizer on one reproducible frame. Terminal for the
      // session: the rAF loop does not resume, which is what lets two native
      // captures of an animated canvas match.
      visualizerStill: () => {
        if (!visualizer) throw new Error("visualizer has not mounted");
        visualizer.captureStill();
      },
      // Click a list row (queue / browsed playlist) through the real handler,
      // optionally with Cmd/Shift, so tests drive the list's multi-select the same
      // way treeClick drives the tree's. Targets the Nth `li.queue-row` in view
      // order and dispatches a genuine modifier-carrying MouseEvent.
      listClick: (arg) => {
        const a = arg as { index: number; meta?: boolean; shift?: boolean };
        // The queue is windowed, so only a slice is mounted: resolve the row by its
        // view index (data-row-index), not its position in the mounted slice.
        const rows = Array.from(queueListEl.querySelectorAll<HTMLElement>("li.queue-row"));
        const el = rows.find((r) => Number(r.dataset.rowIndex) === a.index) ?? rows[a.index];
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
      //
      // Bare paths are the one thing no UI entry point hands this verb — every
      // real one (tree selection, nav row, search hit) carries the row's
      // metadata already. Resolve it the way a Finder drop does, so a scripted
      // add renders like a real one (title / artist / duration) instead of a
      // bare filename. Order stays the caller's: dropped_tracks sorts into
      // listening order for the drop case, so map its rows back onto the paths
      // as given.
      addToQueue: async (arg) => {
        const a = arg as { paths: string[] };
        let resolved: SearchTrack[] = [];
        try {
          resolved = await invoke<SearchTrack[]>("dropped_tracks", { paths: a.paths });
        } catch (e) {
          console.error("dropped_tracks failed", a.paths, e);
        }
        const byPath = new Map(resolved.map((track) => [track.path, track]));
        addToQueue(
          a.paths.map((path) => byPath.get(path) ??
            { path, title: null, artist: null, album: null, albumArtist: null }),
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
          albumArtist: null,
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
          albumArtist: null,
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
        // Windowed list: resolve rows by view index (data-row-index), and read the
        // full row count from the list (not the mounted slice) for the end case.
        const byIndex = (i: number) => rows.find((r) => Number(r.dataset.rowIndex) === i);
        const total = Number(queueListEl.dataset.rowCount ?? rows.length);
        const src = byIndex(a.from) ?? rows[a.from];
        if (!src) return;
        const s = src.getBoundingClientRect();
        const sx = s.left + s.width / 2;
        const sy = s.top + s.height / 2;
        let tx: number;
        let ty: number;
        if (a.to >= total) {
          const last = (byIndex(total - 1) ?? rows[rows.length - 1]).getBoundingClientRect();
          tx = last.left + last.width / 2;
          ty = last.bottom + 4; // empty area past the last row -> insert at end
        } else {
          const t = (byIndex(a.to) ?? rows[a.to]).getBoundingClientRect();
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
