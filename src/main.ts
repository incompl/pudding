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
import { h } from "./dom";
import { windowedList } from "./windowed-list";
import { maybeStartE2eBridge } from "./e2e-bridge";
import { bootProfileStart, bootStep, bootProfileReport } from "./perf";
import {
  initLibraryNav,
  navigateTo,
  currentNavStep,
  popNavToRoot,
  renderNav,
  refreshNavViewAfterScan,
  invalidateNavListCache,
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
  TrackSelection,
  ContextMenuItem,
  NavState,
  PaneView,
  PlaylistData,
  RecentPlaylist,
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
  aboutOpen,
  activeTab,
  activeQueue,
  browsedPlaylist,
  editingText,
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
  aboutPanel,
  aboutVersionEl,
  splitterEl,
  themeMatchSystemEl,
  themeSwatchesEl,

  queueListEl,
  queueCloseBtn,

  toastEl,
} from "./dom-refs";
import { showContextMenu } from "./context-menu";
import { startTrackDrag } from "./drag-drop";
import { setupSearch } from "./search";
import {
  refreshTree,
  refreshLibrary,
  setLibraryRoots,
  renderLibraryRootRows,
  setStreamListPath,
  browseLibraryRoot,
  browseStreamListPath,
  refreshStreams,
} from "./library";
import { playSelectedRow, revealFolderInTree, setBrowseActive } from "./tree-view";
import {
  closePaneEditor,
  editMetadataItem,
  startTitleEdit,
} from "./editors";
import { openAddStationEditor } from "./streams-view";
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
} from "./playback";
import {
  renderQueue,
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
  KEY_RECENT_PLAYLISTS,
  playlistPlayableTracks,
  playPlaylistPath,
  browsePlaylistPath,
  refreshPlaylistIndex,
  persistRecentPlaylists,
  syncRecentPlaylistsMenu,
  menuNewPlaylist,
  menuOpenPlaylist,
  menuSavePlaylist,
  queueCanSaveAsPlaylist,
  saveQueueAsPlaylist,
  menuMovePlaylist,
  newPlaylistWithTracks,
  addTracksToPlaylist,
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

const STORE_FILE = "settings.json";
export const KEY_LIBRARY_ROOTS = "libraryRoots";
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
// lenses + playlists; a single global toggle keeps the behavior predictable
// without any "which context am I in?" reasoning. KEY_AUTOADVANCE_FILES is read
// once at load to migrate the old browsing setting; the new key supersedes both.
const KEY_AUTOADVANCE = "autoadvance";
const KEY_AUTOADVANCE_FILES = "autoadvanceFiles"; // legacy, migrated on load
// Playback modes remembered across launches, like every mainstream player.
const KEY_SHUFFLE = "shuffleMode";
const KEY_REPEAT = "repeatMode";

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
  navigateTo([{ t: "lens", lens: "artist" }, { t: "artist", name }]);
}

export function goToAlbum(album: string, albumArtist: string): void {
  goToFilesTab();
  navigateTo([{ t: "lens", lens: "album" }, { t: "album", album, albumArtist }]);
}

export function goToFolder(path: string): void {
  goToFilesTab();
  // Browse hosts the real folder tree; show it, then expand + scroll to the target.
  navigateTo([{ t: "lens", lens: "browse" }]);
  void revealFolderInTree(path);
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
  showContextMenu(x, y, [
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
  showContextMenu(x, y, [
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
function showPlaylistContextMenu(x: number, y: number, path: string): void {
  const getTracks: TrackProvider = async () =>
    playlistPlayableTracks(await invoke<PlaylistData>("read_playlist", { path }));
  showContextMenu(x, y, [
    { label: "Play", action: () => void playPlaylistPath(path) },
    ...queueMenuItems((sink) => void addProviderToQueue(getTracks, sink)),
    addToPlaylistItem(getTracks),
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
  tracks: SearchTrack[],
  ctx: LeafListContext,
): HTMLElement {
  app.navLeafTracks = tracks;
  const ul = h("div", { class: "nav-list" });

  // Show a field in the dimmed suffix only when the list's tracks disagree about it
  // (mirrors the browse tree's per-folder showArtist). A field that's the same on
  // every row is noise repeated down the list, so drop it: an album view (one album,
  // often one artist) collapses to bare titles, while a compilation still shows the
  // varying artist; an artist's Tracks list drops the redundant artist and keeps the
  // album. Songs — the whole library — varies on both, so it shows artist · album.
  const showArtist = fieldVaries(tracks, (t) => t.artist);
  const showAlbum = fieldVaries(tracks, (t) => t.album);

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
      // library target (see TODO's "Library scale target"), where 6-digit gutters
      // are real.
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

    // Single line, left-aligned (matching the browse tree): the title, then the
    // artist/album inline and dimmed after a separator. Every row is one line at
    // any width, so the height never varies — the uniform height the window
    // positions rows by (row i at i * rowHeight). The suffix is appended only when
    // present, so a metadata-less row is just the bare title (still one-line height)
    // rather than a reserved blank; the whole cell truncates with one ellipsis.
    const secondaryText = [showArtist ? t.artist : null, showAlbum ? t.album : null]
      .filter(Boolean)
      .join(" · ");
    const cell = h(
      "span",
      { class: "nav-cell" },
      h("span", {
        class: "nav-primary",
        text: t.title ?? (t.path.split(/[\\/]/).pop() ?? t.path),
      }),
    );
    if (secondaryText) {
      cell.appendChild(h("span", { class: "nav-secondary", text: secondaryText }));
    }

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
                ...queueMenuItems((sink) => sink(sel), sel.length),
                addToPlaylistItem(() => sel),
                showInFinderItem(sel[0].path),
              ]);
            } else {
              // Double-click plays the row, so the menu skips a redundant Play (as in
              // the tree and queue menus): it leads with the list-building verbs, then
              // the per-track navigation (Go to artist / album when tagged).
              showContextMenu(e.clientX, e.clientY, [
                ...queueMenuItems((sink) => sink([t])),
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

    return row;
  };

  // Debug escape hatch for A/B perf comparison: set `__noWindowing = true` in the
  // devtools console and re-enter a list to render every row eagerly (the pre-
  // windowing path — all N nodes in the DOM). Off by default; never set in normal use.
  if ((globalThis as { __noWindowing?: boolean }).__noWindowing) {
    for (let i = 0; i < tracks.length; i++) ul.appendChild(buildRow(i));
    return ul;
  }

  // Window the rows: only the on-screen slice is mounted over a full-height spacer,
  // so a whole-library Songs list costs a screenful of DOM instead of one node per
  // track. Native scroll/inertia are unchanged (real scroll pane, full height). The
  // selection painter and drag-out still work per mounted row; there's no reorder,
  // scroll-to-playing, or keyboard row-indexing on these lists to rework.
  const win = windowedList({ count: tracks.length, renderRow: buildRow });
  win.el.classList.add("nav-window");
  ul.appendChild(win.el);
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

// Snapshot the current playback into the store, or clear it. Only a queue that is
// the audible pool restores; everything else (lone track, stream, torn-down queue)
// clears the key so relaunch doesn't resurrect a queue that isn't playing.
async function persistSessionNow(): Promise<void> {
  lastSessionWrite = performance.now();
  const q = activeQueue.value;
  if (!q || !queueIsActivePool()) {
    if (!sessionPersisted) return; // already clear — nothing to do
    await app.store.set(KEY_PLAYBACK_SESSION, null);
    await app.store.save();
    sessionPersisted = false;
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

// Rebuild the queue + playhead saved by the previous session, paused. The engine
// holds no track yet — app.pendingResume arms the first play to seed it here and
// seek to the saved position (togglePlayPause), so launch never blasts audio.
async function restorePlaybackSession(): Promise<void> {
  const s = await app.store.get<PersistedSession>(KEY_PLAYBACK_SESSION);
  if (!s?.queue || !Array.isArray(s.queue.tracks)) return;
  // The engine pool is playable rows only (missing files stay in the view but
  // never reach the engine), mirroring playQueue/playQueueTrack.
  const playable = s.queue.tracks.filter((t) => !t.missing);
  if (playable.length === 0) return;
  const idx = Math.min(Math.max(0, Math.trunc(s.index)), playable.length - 1);
  const track = playable[idx];

  // A synthetic queue: parent so queueIsActivePool() is true and the same pool
  // seeds the engine on the first play. A real playlist reuses its file-keyed path.
  const syntheticPath = s.queue.sourcePath
    ? `queue:playlist:${s.queue.sourcePath}`
    : "queue:restored";
  app.currentParent = syntheticParent(syntheticPath, s.queue.title, playable);
  openActiveQueue(s.queue);
  currentNodePath.value = track.path;
  queuePlayingIndex.value = idx;
  app.lastQueue = playable.map((t) => t.path);
  app.lastIndex = idx;
  app.queueEnded = false;

  const time = typeof s.time === "number" && s.time > 0 ? s.time : 0;
  currentTime.value = time;
  duration.value = typeof s.duration === "number" ? s.duration : track.duration ?? 0;
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
  // toggle. About (Pudding → About Pudding) shares the pane and emits
  // "open-about". Opening one closes the other; the single Back button dismisses
  // whichever is up, returning to now-playing.
  void listen("open-settings", () => { aboutOpen.value = false; settingsOpen.value = true; });
  void listen("open-about", () => { settingsOpen.value = false; aboutOpen.value = true; });
  settingsBackBtn.addEventListener("click", () => {
    settingsOpen.value = false;
    aboutOpen.value = false;
  });

  // The About panel's main line is "pudding <version>"; the version is the app
  // version from tauri.conf.json, read via the Tauri app API.
  void getVersion().then((v) => { aboutVersionEl.textContent = `pudding ${v}`; });

  // The get-started prompts' inline "settings" links (Files: no library root,
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
    const settings = settingsOpen.value;
    const about = aboutOpen.value;
    // Settings and About are mutually exclusive faces of the right pane, both
    // dismissed by the same Back button. Anything that yields the pane to a
    // panel keys off whether *either* is open.
    const panelOpen = settings || about;
    settingsPanel.classList.toggle("hidden", !settings);
    aboutPanel.classList.toggle("hidden", !about);
    nowPlayingPanel.classList.toggle("hidden", panelOpen);
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
    playbackModesEl.classList.toggle("hidden", settingsOpen.value || aboutOpen.value);
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
  queueCloseBtn.addEventListener("click", closeQueue);
  // Clicking anywhere on the title — the text or the hover pencil — starts an
  // inline rename; startTitleEdit no-ops when the header isn't a playlist.
  (document.querySelector("#queue-title") as HTMLElement).addEventListener("click", startTitleEdit);
  // Dropping onto the list's empty area (below the last row, or an empty playlist)
  // targets the end of the list — that case is resolved by updateDropTarget's
  // hit-test against the list box, so no container drop listener is needed.

  app.store = await bootStep("load-store", () =>
    load(STORE_FILE, { defaults: {}, autoSave: false }),
  );

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
  // Debug perf timing for the whole-library loaders: set `__perfLog = true` in the
  // devtools console, then open a lens. Logs how long invoke+IPC+JSON.parse took and
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
        // [path, title, artist, album, duration] tuples, not keyed objects, so the
        // JSON doesn't repeat the field names once per row (a large share of the
        // payload + parse cost at the scale target). Re-key here at the boundary;
        // the rest of the app still works in SearchTrack objects. track is always
        // null for this flat list (the gutter shows a positional index).
        type SongRow = [string, string | null, string | null, string | null, number | null];
        const rows = await invoke<SongRow[]>("list_all_songs");
        return rows.map(
          ([path, title, artist, album, duration]): SearchTrack => ({
            path,
            title,
            artist,
            album,
            duration,
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
    showArtistMenu: showArtistContextMenu,
    showAlbumMenu: showAlbumContextMenu,
    showPlaylistMenu: showPlaylistContextMenu,
    persistLocation: persistNavLocation,
    libraryRootSet: () => libraryRootSet.value,
    setBrowseActive,
  }, navLocation));
  setupPlaybackModes();
  await setupWindowSize(appWindow);
  setupSplitter(splitterWidth);
  setupSettings();
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
          ? `Scanning… ${done.toLocaleString()} of ${total.toLocaleString()}`
          : "Scanning…";
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
    // The scan changed what's on disk, so the memoized lens lists are stale. Drop
    // them unconditionally — even while an inline edit blocks the view refresh below,
    // the cache must not outlive the data it mirrors, or a later open serves stale
    // rows.
    invalidateNavListCache();
    // Also refresh the open navigator lens/detail view so new/changed tracks show
    // without leaving and re-entering. Skip while an inline edit is open — like
    // refreshLibrary, a rebuild would tear out the edit input.
    if (!app.inlineEditing) refreshNavViewAfterScan();
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
