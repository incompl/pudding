import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  getCurrentWindow,
  LogicalSize,
  PhysicalPosition,
} from "@tauri-apps/api/window";
import { load, type Store } from "@tauri-apps/plugin-store";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { signal, effect } from "@preact/signals-core";
import { GaplessEngine } from "./audio-engine";

const STORE_FILE = "settings.json";
const KEY_LIBRARY_ROOT = "libraryRoot";
const KEY_MANIFEST_PATH = "manifestPath";
const KEY_SPLITTER_WIDTH = "splitterWidth";
const KEY_VOLUME = "volume";
// Window size is remembered per layout mode so the double-click toggle can
// restore the size you last used in the *other* mode.
const KEY_WINDOW_SIZE_NORMAL = "windowSizeNormal";
const KEY_WINDOW_SIZE_MINI = "windowSizeMini";
const KEY_WINDOW_POSITION = "windowPosition";
// Autoadvance preferences, one per playback context (file-tree play vs. explicit
// playlists/queues). Both live in the OS Playback menu, not the app UI.
const KEY_AUTOADVANCE_FILES = "autoadvanceFiles";
const KEY_AUTOADVANCE_PLAYLISTS = "autoadvancePlaylists";

// Below this logical (CSS-px) height the layout collapses to the mini player.
// Mirrors the `max-height` breakpoint in styles.css — keep the two in sync.
const MINI_MAX_HEIGHT = 480;
const DEFAULT_NORMAL_SIZE = { width: 800, height: 600 };
const DEFAULT_MINI_SIZE = { width: 367, height: 168 };

interface FileEntry {
  name: string;
  title: string | null;
  artist: string | null;
  album: string | null;
  // Raw ALBUMARTIST tag; combined as albumArtist ?? artist to form the album
  // grouping key for "go to album". See the backend's album_tracks.
  albumArtist: string | null;
  disc: number | null;
  track: number | null;
}

interface TrackMeta {
  title: string | null;
  artist: string | null;
  album: string | null;
}

interface DirListing {
  folders: string[];
  files: FileEntry[];
}

interface TreeNode {
  path: string;
  name: string;
  title: string | null;
  artist: string | null;
  album: string | null;
  albumArtist: string | null;
  disc: number | null;
  track: number | null;
  isFolder: boolean;
  loaded: boolean;
  expanded: boolean;
  children: TreeNode[];
}

interface Stream {
  name: string;
  url: string;
  // Optional station art from the JSON manifest: an http(s) or file:// URL.
  image?: string | null;
}

interface SearchTrack {
  path: string;
  title: string | null;
  artist: string | null;
  album: string | null;
}

interface SearchFolder {
  path: string;
  name: string;
}

interface SearchArtist {
  name: string;
}

// An album is (name, album artist) — the grouping key from the backend, where
// `artist` is the album artist (ALBUMARTIST tag, else the track artist).
interface SearchAlbum {
  album: string;
  artist: string;
}

// Discriminated rows shown in the search dropdown: artists and albums, library
// folders and files (all from the SQLite metadata cache), and manifest streams
// (filtered client-side).
type SearchItem =
  | { kind: "artist"; artist: SearchArtist }
  | { kind: "album"; album: SearchAlbum }
  | { kind: "folder"; folder: SearchFolder }
  | { kind: "file"; track: SearchTrack }
  | { kind: "stream"; stream: Stream };

// --- Queue ---
//
// An immutable, ordered list of tracks that playback advances through, shown as
// a list in the right pane (replacing the now-playing card). Today the only
// sources are artist and album pages; the `kind` discriminant and the standalone
// Queue shape leave room for a future mutable "playlist" kind without reworking
// the view or the advancement logic — which already treats poolPaths() (the
// current synthetic parent's children) as "the queue".
type QueueKind = "artist" | "album" | "folder" | "playlist";

interface Queue {
  kind: QueueKind;
  title: string; // header line: the queue/playlist name (artist, album, folder…)
  subtitle: string | null; // always a track count
  tracks: SearchTrack[];
}

// Header for a queue the user builds by hand (Add to queue), as opposed to one
// opened from a fixed source (Play artist/album/folder). Deliberately NOT named
// after any track: the contents change as more are added, so a track-derived
// title would drift. Placeholder framing ("Untitled") anticipates saving it as a
// named playlist later.
const UNTITLED_PLAYLIST_TITLE = "Untitled";

interface ScanResult {
  ok: boolean;
  error: string | null;
}

// --- Reactive state ---

const hasTrack = signal(false);
const npTitle = signal("");
const npArtist = signal<string | null>(null);
const npAlbum = signal<string | null>(null);
const npArt = signal<string | null>(null);
// ICY now-playing (song + artist) shown under the station name during
// streams. Null until the first title arrives (or forever, for stations that
// never send one); the block is absolutely positioned so its arrival never
// shifts the station name.
const npStreamMeta = signal<{ song: string; artist: string | null } | null>(
  null,
);

const isStream = signal(false);
const isPlaying = signal(false);
const currentTime = signal(0);
const duration = signal(0);
const volume = signal(1);
const volumePopoverOpen = signal(false);

const currentNodePath = signal<string | null>(null);
const currentStreamUrl = signal<string | null>(null);

const settingsOpen = signal(false);
const activeTab = signal<"files" | "streams">("files");

// The queue backing the right pane, or null when a lone track is playing. Set
// whenever queue intent is expressed — Play folder/album/artist, or Add to
// queue — and cleared when a lone track plays (a tree track click, a stream, a
// search track).
//
// The right pane is one vertical stack, not two toggled faces: the now-playing
// hero sits on top and, when a queue exists, the queue list fills the space
// below it (scrolling the list collapses the hero to a compact strip — see
// syncHeroCollapsed). So `activeQueue` alone decides whether the queue section
// is present; there is no separate card/list mode.
const activeQueue = signal<Queue | null>(null);

// Named for intent at the call sites; both just set `activeQueue` now that the
// hero and queue coexist (no face to pick).
function openActiveQueue(queue: Queue): void {
  activeQueue.value = queue;
}
function clearActiveQueue(): void {
  activeQueue.value = null;
}

// The queue row currently playing, or null when playback is outside the queue
// (folder autoplay, a lone search/external track, or a stream). Not a boolean
// "am I in the queue" flag: a queue can hold the same track at several rows, so
// only an index can say which instance is live — driving the single-row
// highlight (and, at rest after the queue drains, the absence of one). The
// queue and folder autoplay are fully independent: normal playback never flows
// into the queue on its own; the only way to play the queue is to play from it
// (a queue row, or Play folder/album/artist). Whether the queue is the *audible
// pool* — for Close's teardown and the play-restart — is read from
// `queueIsActivePool()` (the synthetic `queue:` parent), not from this index,
// which goes null while the drained queue rests.
const queuePlayingIndex = signal<number | null>(null);

// A queue is the engine's active pool iff currentParent is one of the synthetic
// `queue:` parents (real folders are filesystem paths). Distinguishes "the queue
// is playing / rests at its end" from "a queue is merely stashed while a folder,
// stream, or lone track plays".
function queueIsActivePool(): boolean {
  return currentParent?.path.startsWith("queue:") ?? false;
}

// Playback-mode controls (files view only): Shuffle (on/off) and Repeat, a
// three-state cycle matching every mainstream player — off (play through and
// stop), all (loop the album), one (loop the current track).
//
// The native engine plays a queue straight through and reports when it drains
// (onQueueEnded); shuffle and repeat live entirely here. Straight play hands the
// whole album to the engine for gapless auto-advance; shuffle and repeat-one
// hand one track at a time and pick the next at each queue-ended — which is also
// why shuffle gets an ordinary track gap (no gapless), desirable since
// crossfading random tracks is worse, not better. Turning a per-track mode on
// mid-album drops the engine's queued tail (audio_clear_upcoming) so it engages
// at the current track's end without restarting what's playing.
type RepeatMode = "off" | "all" | "one";
const shuffleMode = signal(false);
const repeatMode = signal<RepeatMode>("off");

// Autoadvance: when a track ends, does playback flow on to the next one? A
// persistent, set-once preference (not a per-play choice), split by context —
// file-tree play vs. explicit playlists/queues — and set from the OS Playback
// menu, never the app UI. Both default on, matching what a media player is
// expected to do. When off for the active context, the engine is only ever
// handed the current track (never its tail), so gapless prep has nothing to
// advance into and handleEnded stops at each track's end. See applyAutoadvance.
const autoadvanceFiles = signal(true);
const autoadvancePlaylists = signal(true);

// The autoadvance setting governing what's currently playing: playlists/queues
// when the active pool is a synthetic queue, else the file tree. Read at each
// advancement point and each engine hand-off.
function autoadvanceEnabled(): boolean {
  return queueIsActivePool() ? autoadvancePlaylists.value : autoadvanceFiles.value;
}
const libraryRootValid = signal(true);
const manifestPathValid = signal(true);
// Whether the file tree has at least one top-level entry to start from. Drives
// the idle play button: with content, an idle play "starts the library" (plays
// the first entry) instead of sitting disabled, so the button reads ready-to-go.
const libraryHasContent = signal(false);

// --- Helpers ---

function displayLabel(node: TreeNode): string {
  if (node.isFolder) return node.name;
  if (node.title) {
    return node.artist ? `${node.artist} - ${node.title}` : node.title;
  }
  return node.name;
}

function joinPath(parent: string, child: string): string {
  return parent.endsWith("/") ? parent + child : parent + "/" + child;
}

function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number): (...args: A) => void {
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

function setEmpty(container: HTMLElement, message: string, kind: "empty" | "loading" = "empty"): void {
  container.innerHTML = "";
  const div = document.createElement("div");
  div.className = kind === "loading" ? "loading-state" : "empty-state";
  div.textContent = message;
  container.appendChild(div);
}

// --- Module state (non-reactive) ---

let store: Store;
let rootNode: TreeNode | null = null;
// Last manifest streams loaded by refreshStreams, kept so search can filter
// them without re-reading the manifest on every keystroke.
let allStreams: Stream[] = [];
// Manifest name of the currently playing stream, shown as the now-playing
// station line. Kept separately from currentStreamUrl because ICY metadata
// events re-render the now-playing panel after the fact.
let currentStreamName: string | null = null;
// Album-folder context for the currently playing track. Held so an
// auto-advance event from the engine can look up the matching TreeNode (for
// the row highlight + now-playing UI) via siblingByPath. Null while playing
// a stream, a search hit, or an external file — those have no album context.
let currentParent: TreeNode | null = null;
let artRequestId = 0;
// Last queue + index handed to the engine. Held so play-after-queue-ended
// restarts from the same track the user last heard (the existing UX: hit play
// after the album finishes → resume from the last track).
let lastQueue: string[] = [];
let lastIndex = 0;
// The queue-row index the *next* engine play should land on, consumed by the
// following onAdvance to set queuePlayingIndex. Set right before every play that
// starts or jumps within the queue pool; left null for gapless auto-advance,
// which onAdvance treats as "the next row down" (so duplicate rows are tracked
// positionally, matching the engine's sequential advance).
let pendingQueueIndex: number | null = null;
// True once the engine has played through the queue's last track. Cleared on
// the next Play (file selection, seek, or restart-from-end via play button).
let queueEnded = false;

// Upcoming tracks for shuffle playback: a shuffled permutation of the album
// pool, consumed one entry per queue-ended. Draining it to empty means the
// shuffle cycle is done (stop when repeat is off, reshuffle when repeat all).
// Filled when shuffle turns on or a shuffled album starts; cleared for straight
// play so a stale order can't leak into the next album.
let shuffleBag: string[] = [];

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

function cleanStreamText(raw: string): string {
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
function siblingByPath(path: string): TreeNode | null {
  if (!currentParent) return null;
  return (
    currentParent.children.find((c) => !c.isFolder && c.path === path) ?? null
  );
}

const engine = new GaplessEngine({
  onAdvance: (path) => {
    // currentParent stays the album folder across an album. For external/
    // search playback there is no parent and no sibling row to highlight; the
    // UI was already set by the caller (playSearchTrack / openExternalFile).
    const node = siblingByPath(path);
    if (!node) return;
    currentNodePath.value = node.path;
    currentStreamUrl.value = null;
    // Track which queue row is live. A play/jump sets pendingQueueIndex to its
    // target; a gapless auto-advance leaves it null, so we step to the next row
    // down (positional, so duplicate rows resolve to the right instance).
    if (queueIsActivePool()) {
      queuePlayingIndex.value =
        pendingQueueIndex ?? (queuePlayingIndex.value ?? -1) + 1;
    } else {
      queuePlayingIndex.value = null;
    }
    pendingQueueIndex = null;
    setNowPlaying(node.title ?? node.name, node.artist, node.album);
    void loadArt(node.path);
  },
  onTime: (t) => { currentTime.value = t; nowPlayingPositionTick(t); },
  onDuration: (d) => { duration.value = d; },
  onPlayingChange: (p) => { isPlaying.value = p; },
  onError: (path, message) => {
    console.error("audio: track failed", path, message);
  },
  onQueueEnded: () => {
    handleEnded();
  },
  // ICY now-playing for radio. The station name stays on the title line no
  // matter what so the layout never shifts when metadata arrives; the ICY
  // title fades in below it. The manifest's stream name wins over the
  // server's icy-name (manifest names are user-curated; icy-name is often a
  // slogan). The title is conventionally "Artist - Song"; split on the first
  // separator, keeping the whole string as the song when there is none.
  onStreamMetadata: (station, title) => {
    if (!isStream.value) return;
    const stationName =
      currentStreamName ?? (station ? cleanStreamText(station) : null);
    setNowPlaying(stationName || "Stream", null, null);
    const cleaned = title ? cleanStreamText(title) : "";
    if (cleaned) {
      const sep = cleaned.indexOf(" - ");
      const artist = sep > 0 ? cleaned.slice(0, sep).trim() : null;
      const song = sep > 0 ? cleaned.slice(sep + 3).trim() : cleaned;
      npStreamMeta.value = { song: song || cleaned, artist };
    } else {
      npStreamMeta.value = null;
    }
  },
});

// --- System Now Playing (macOS Control Center / lock screen / media keys) ---
//
// The OS integration lives in Rust (now_playing.rs); this half feeds it the
// resolved metadata + playback state that only the frontend knows. We push
// metadata whenever it changes and playback state on play/pause, plus a ~1 Hz
// refresh so the OS scrubber tracks seeks (position events themselves aren't
// forwarded — the OS extrapolates elapsed time from the last rate we sent).

function pushNowPlayingMeta(): void {
  if (!hasTrack.value) return;
  let title = npTitle.value;
  let artist = npArtist.value;
  // Radio: surface the current song/artist when the station sends ICY metadata,
  // falling back to the station name on the title line.
  if (isStream.value && npStreamMeta.value) {
    title = npStreamMeta.value.song;
    artist = npStreamMeta.value.artist ?? npTitle.value;
  }
  void invoke("now_playing_set_metadata", {
    title,
    artist,
    album: npAlbum.value,
    art: npArt.value,
    // Streams have no timeline; a 0 duration tells the OS to show it as live.
    duration: isStream.value ? 0 : duration.value,
  });
}

let lastPlaybackPush = 0;
function pushPlayback(elapsed: number): void {
  if (!hasTrack.value) return;
  void invoke("now_playing_set_playback", {
    playing: isPlaying.value,
    elapsed,
  });
  lastPlaybackPush = performance.now();
}

// Throttled position refresh, called from the engine's position callback so the
// OS elapsed time re-syncs (e.g. after a seek) without one IPC call per tick.
function nowPlayingPositionTick(t: number): void {
  if (!isPlaying.value) return;
  if (performance.now() - lastPlaybackPush > 1000) pushPlayback(t);
}

// Metadata card: fires on any change to the fields that make it up.
effect(() => {
  // Subscribe to every field the card is built from.
  npTitle.value;
  npArtist.value;
  npAlbum.value;
  npArt.value;
  duration.value;
  npStreamMeta.value;
  isStream.value;
  hasTrack.value;
  pushNowPlayingMeta();
});

// Play/pause: push immediately so the widget's button state flips at once.
effect(() => {
  isPlaying.value;
  hasTrack.value;
  pushPlayback(currentTime.peek());
});

let nowPlayingTitleEl: HTMLElement;
let nowPlayingTitleInner: HTMLElement;
let nowPlayingArtistEl: HTMLElement;
let nowPlayingArtistInner: HTMLElement;
let nowPlayingAlbumEl: HTMLElement;
let nowPlayingAlbumInner: HTMLElement;
let npStripTitleEl: HTMLElement;
let npStripArtistEl: HTMLElement;
let npStripArtistWrapEl: HTMLElement;
let nowPlayingStreamMetaEl: HTMLElement;
let streamMetaSongEl: HTMLElement;
let streamMetaSongInner: HTMLElement;
let streamMetaArtistEl: HTMLElement;
let streamMetaArtistInner: HTMLElement;
let liveIndicatorEl: HTMLElement;
let nowPlayingArtEl: HTMLImageElement;
let nowPlayingEmptyEl: HTMLElement;
let playPauseBtn: HTMLButtonElement;
let prevBtn: HTMLButtonElement;
let nextBtn: HTMLButtonElement;
let seekBar: HTMLInputElement;
let timeCurrentEl: HTMLElement;
let timeRemainingEl: HTMLElement;
let volumeControlEl: HTMLElement;
let volumeBtn: HTMLButtonElement;
let volumePopover: HTMLElement;
let volumeBar: HTMLInputElement;
let treeContainer: HTMLElement;
let streamsContainer: HTMLElement;
let libraryRootInput: HTMLInputElement;
let libraryRootBrowseBtn: HTMLButtonElement;
let manifestPathInput: HTMLInputElement;
let manifestPathBrowseBtn: HTMLButtonElement;
let miniplayerBtn: HTMLButtonElement;
let settingsBackBtn: HTMLButtonElement;
let playbackModesEl: HTMLElement;
let modeShuffleBtn: HTMLButtonElement;
let modeRepeatBtn: HTMLButtonElement;
let searchEl: HTMLElement;
let searchInput: HTMLInputElement;
let searchResultsEl: HTMLElement;
let nowPlayingPanel: HTMLElement;
let settingsPanel: HTMLElement;
let splitterEl: HTMLElement;
let queueTitleEl: HTMLElement;
let queueSubtitleEl: HTMLElement;
let queueListEl: HTMLElement;
let queueCloseBtn: HTMLButtonElement;
let toastEl: HTMLElement;

// --- Tree ---

// Child nodes for one directory listing. Display order comes entirely from
// the backend: list_dir returns folders sorted by name and files sorted by
// (disc, track, name), and folders-before-files holds by construction here.
// `oldFolders` lets reconcileNode carry over an existing folder node (with its
// loaded/expanded state and children) instead of resetting it to a lazy stub.
function nodesFromListing(
  parentPath: string,
  listing: DirListing,
  oldFolders?: Map<string, TreeNode>,
): TreeNode[] {
  return [
    ...listing.folders.map<TreeNode>(
      (name) =>
        oldFolders?.get(name) ?? {
          path: joinPath(parentPath, name),
          name,
          title: null,
          artist: null,
          album: null,
          albumArtist: null,
          disc: null,
          track: null,
          isFolder: true,
          loaded: false,
          expanded: false,
          children: [],
        },
    ),
    ...listing.files.map<TreeNode>((f) => ({
      path: joinPath(parentPath, f.name),
      name: f.name,
      title: f.title,
      artist: f.artist,
      album: f.album,
      albumArtist: f.albumArtist,
      disc: f.disc,
      track: f.track,
      isFolder: false,
      loaded: true,
      expanded: false,
      children: [],
    })),
  ];
}

async function fetchChildren(node: TreeNode): Promise<void> {
  if (node.loaded || !node.isFolder) return;
  try {
    const listing = await invoke<DirListing>("list_dir", { path: node.path });
    node.children = nodesFromListing(node.path, listing);
    node.loaded = true;
  } catch (e) {
    console.error("list_dir failed for", node.path, e);
    node.loaded = true;
    node.children = [];
  }
}

async function loadChildren(node: TreeNode, li: HTMLLIElement): Promise<void> {
  if (node.loaded || !node.isFolder) return;
  const loadingLi = document.createElement("li");
  loadingLi.className = "loading-state";
  loadingLi.textContent = "Loading…";
  const childUl = document.createElement("ul");
  childUl.appendChild(loadingLi);
  li.appendChild(childUl);
  try {
    await fetchChildren(node);
  } finally {
    childUl.remove();
  }
}

// Lightweight cursor-positioned context menu for tree rows. A single reusable
// element, repopulated and repositioned per open, styled like the search
// dropdown (dark lifted surface). Dismisses on any outside press, another
// right-click, Escape, scroll, or resize.
let contextMenuEl: HTMLElement | null = null;

function hideContextMenu(): void {
  contextMenuEl?.classList.add("hidden");
}

function showContextMenu(
  x: number,
  y: number,
  items: { label: string; action: () => void }[],
): void {
  if (!contextMenuEl) {
    contextMenuEl = document.createElement("div");
    contextMenuEl.id = "context-menu";
    contextMenuEl.className = "hidden";
    document.body.appendChild(contextMenuEl);
    // A press anywhere outside the menu dismisses it; the menu's own items run
    // on click, which fires after this mousedown leaves the menu open. Capture
    // phase so it fires even if a descendant (e.g. the search input's native
    // shadow DOM) swallows the bubbling event.
    document.addEventListener(
      "mousedown",
      (e) => {
        if (contextMenuEl && !contextMenuEl.contains(e.target as Node)) hideContextMenu();
      },
      true,
    );
    // Focus moving out of the menu also dismisses it — covers focusing the
    // search box (or any control) by click or keyboard, where the mousedown
    // outside-press alone doesn't reliably reach us.
    document.addEventListener("focusin", (e) => {
      if (contextMenuEl && !contextMenuEl.contains(e.target as Node)) hideContextMenu();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") hideContextMenu();
    });
    window.addEventListener("resize", hideContextMenu);
    // Capture so a scroll in any container (e.g. the tree) closes the menu,
    // since its fixed position would otherwise detach from the row.
    window.addEventListener("scroll", hideContextMenu, true);
  }
  contextMenuEl.innerHTML = "";
  for (const item of items) {
    const row = document.createElement("div");
    row.className = "context-menu-item";
    row.textContent = item.label;
    row.addEventListener("click", () => {
      hideContextMenu();
      item.action();
    });
    contextMenuEl.appendChild(row);
  }
  contextMenuEl.classList.remove("hidden");
  // Clamp to the viewport so a row near an edge doesn't push the menu offscreen.
  const rect = contextMenuEl.getBoundingClientRect();
  const left = Math.max(4, Math.min(x, window.innerWidth - rect.width - 4));
  const top = Math.max(4, Math.min(y, window.innerHeight - rect.height - 4));
  contextMenuEl.style.left = `${left}px`;
  contextMenuEl.style.top = `${top}px`;
}

// Whether a track's artist is worth showing in a given folder. Suppressed only
// when it's pure repetition: a multi-track album whose tagged tracks all share
// one artist (the folder header already carries it). Shown when the artists vary
// (compilations, a lone guest feature, "Various Artists") and when the folder
// holds a single tagged track — a loose single, where there's nothing to repeat.
function folderArtistsVary(children: TreeNode[]): boolean {
  const artists = new Set<string>();
  let tagged = 0;
  for (const c of children) {
    if (c.isFolder || !c.artist) continue;
    tagged++;
    artists.add(c.artist);
    if (artists.size > 1) return true;
  }
  return tagged === 1;
}

function renderNode(
  node: TreeNode,
  parent: TreeNode,
  showArtist = true,
): HTMLLIElement {
  const li = document.createElement("li");
  const label = document.createElement("span");
  label.className = "node-label";
  // Every row carries its path so the playing-highlight effect can find it;
  // only files ever match currentNodePath, so the highlight stays file-only.
  label.dataset.path = node.path;
  if (!node.isFolder && currentNodePath.value === node.path) {
    label.classList.add("playing");
  }
  const icon = document.createElement("span");
  icon.className = "icon";
  // Folders show an open/closed folder. A file's slot carries its tagged track
  // number when it has one (the playing row just recolors it); an untagged file
  // — or any loose top-level file — gets no gutter icon and sits flush.
  if (node.isFolder) {
    icon.classList.add(node.expanded ? "folder-open" : "folder");
    label.appendChild(icon);
  } else if (parent !== rootNode && node.track != null) {
    icon.classList.add("track");
    icon.textContent = String(node.track);
    label.appendChild(icon);
  }
  const text = document.createElement("span");
  text.className = "label-text";
  // A tagged track reads as two lines — title over a de-emphasized artist —
  // like a search result. Folders and untagged files keep a single plain line.
  if (!node.isFolder && node.title) {
    const primary = document.createElement("span");
    primary.className = "primary";
    primary.textContent = node.title;
    text.appendChild(primary);
    if (node.artist && showArtist) {
      const secondary = document.createElement("span");
      secondary.className = "secondary";
      secondary.textContent = node.artist;
      text.appendChild(secondary);
    }
  } else {
    text.textContent = displayLabel(node);
  }
  label.appendChild(text);
  label.addEventListener("click", () => onNodeClick(node, parent, li));
  // Right-click a folder to play it as one recursive album (all tracks beneath
  // it, at any depth) — the same behavior as choosing a folder from search.
  if (node.isFolder) {
    label.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      showContextMenu(e.clientX, e.clientY, [
        {
          label: "Play folder",
          action: () => {
            // The queue pane is the feedback for this action, so leave the tree
            // where it is — no recursive expand or scroll-to.
            void playFolder({ path: node.path, name: node.name });
          },
        },
        {
          label: "Add to queue",
          action: () => void addFolderToQueue({ path: node.path, name: node.name }),
        },
      ]);
    });
  } else {
    // Right-click a track to jump to its artist or album as a queue page. Each
    // item is only offered when that tag exists. An untagged track (common for
    // OST rips named purely by filename) has neither, so fall back to "Play
    // folder" on its containing folder — right-click always does something.
    label.addEventListener("contextmenu", (e) => {
      // The Play verbs lead — the navigation verbs (Play artist / Play album)
      // when their tags exist, else "Play folder" on the container for an
      // untagged track (which has neither) so right-click always does something.
      // "Add to queue" always comes last, matching the folder menu's order.
      const nav = trackContextItems({
        artist: node.artist,
        album: node.album,
        albumArtist: node.albumArtist,
      });
      const items: { label: string; action: () => void }[] = [...nav];
      if (nav.length === 0 && parent.isFolder) {
        items.push({
          label: "Play folder",
          action: () => void playFolder({ path: parent.path, name: parent.name }),
        });
      }
      items.push({ label: "Add to queue", action: () => addToQueue([nodeToTrack(node)]) });
      e.preventDefault();
      showContextMenu(e.clientX, e.clientY, items);
    });
  }
  li.appendChild(label);

  if (node.isFolder && node.expanded) {
    const childUl = document.createElement("ul");
    if (node.children.length === 0) {
      const emptyLi = document.createElement("li");
      emptyLi.className = "empty-state";
      emptyLi.textContent = "(empty)";
      childUl.appendChild(emptyLi);
    } else {
      const showArtist = folderArtistsVary(node.children);
      for (const child of node.children) {
        childUl.appendChild(renderNode(child, node, showArtist));
      }
    }
    li.appendChild(childUl);
  }
  return li;
}

async function onNodeClick(node: TreeNode, parent: TreeNode, li: HTMLLIElement): Promise<void> {
  if (node.isFolder) {
    if (!node.loaded) await loadChildren(node, li);
    node.expanded = !node.expanded;
    li.replaceWith(renderNode(node, parent));
  } else {
    // A plain tree track plays with its album auto-continuing under the hood. It
    // does NOT clear any explicit queue — that stays stashed and visible so the
    // user can return to it (the only way back in is to play from the queue).
    // Drop the queue highlight now (the folder becomes the pool) rather than
    // waiting a frame for onAdvance.
    queuePlayingIndex.value = null;
    playFile(node, parent);
  }
}

function renderTree(): void {
  treeContainer.innerHTML = "";
  if (!rootNode) return;
  if (rootNode.children.length === 0) {
    setEmpty(treeContainer, "Library is empty");
    return;
  }
  const ul = document.createElement("ul");
  for (const child of rootNode.children) {
    ul.appendChild(renderNode(child, rootNode));
  }
  treeContainer.appendChild(ul);
}

function renderStreams(streams: Stream[]): void {
  streamsContainer.innerHTML = "";
  if (streams.length === 0) {
    setEmpty(streamsContainer, "Manifest is empty");
    return;
  }
  const ul = document.createElement("ul");
  for (const stream of streams) {
    const li = document.createElement("li");
    const label = document.createElement("span");
    label.className = "node-label";
    label.dataset.streamUrl = stream.url;
    if (currentStreamUrl.value === stream.url) {
      label.classList.add("playing");
    }
    const icon = document.createElement("span");
    icon.className = "icon radio";
    label.appendChild(icon);
    const text = document.createElement("span");
    text.className = "label-text";
    text.textContent = stream.name;
    label.appendChild(text);
    label.addEventListener("click", () => playStream(stream));
    li.appendChild(label);
    ul.appendChild(li);
  }
  streamsContainer.appendChild(ul);
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
let pendingQueueScrollIndex: number | null = null;

function renderQueue(queue: Queue | null): void {
  if (!queue) {
    queueListEl.innerHTML = "";
    return;
  }
  queueTitleEl.textContent = queue.title;
  queueSubtitleEl.textContent = queue.subtitle ?? "";
  queueSubtitleEl.classList.toggle("hidden", !queue.subtitle);

  const playing = queuePlayingIndex.value;
  // A pending append target wins over the playing row for this render only.
  const scrollTo = pendingQueueScrollIndex;
  pendingQueueScrollIndex = null;
  queueListEl.innerHTML = "";
  let activeRow: HTMLElement | null = null;
  let scrollRow: HTMLElement | null = null;
  queue.tracks.forEach((t, i) => {
    const li = document.createElement("li");
    li.className = "queue-row";
    const isPlaying = i === playing;
    if (isPlaying) {
      li.classList.add("playing");
      activeRow = li;
    }
    if (i === scrollTo) scrollRow = li;
    const num = document.createElement("span");
    num.className = "queue-num";
    // The playing row shows a ♪ in place of its index (like the tree's rows).
    num.textContent = isPlaying ? "♪" : String(i + 1);
    const text = document.createElement("span");
    text.className = "queue-text";
    const primary = document.createElement("span");
    primary.className = "queue-primary";
    primary.textContent = t.title ?? (t.path.split(/[\\/]/).pop() ?? t.path);
    const secondary = document.createElement("span");
    secondary.className = "queue-secondary";
    secondary.textContent = t.artist ?? t.album ?? "";
    text.appendChild(primary);
    if (secondary.textContent) text.appendChild(secondary);
    li.appendChild(num);
    li.appendChild(text);
    li.addEventListener("click", () => playQueueTrack(i));
    queueListEl.appendChild(li);
  });
  const target = (scrollRow ?? activeRow) as HTMLElement | null;
  if (target) target.scrollIntoView({ block: "nearest" });
}

// --- Playback ---

function setNowPlaying(
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
  const root = rootNode;
  const first = root?.children[0];
  if (!root || !first) return;
  if (!first.isFolder) {
    playFile(first, root);
    return;
  }
  await fetchChildren(first);
  const track = first.children.find((c) => !c.isFolder);
  if (track) playFile(track, first);
}

function togglePlayPause(): void {
  if (!hasTrack.value) {
    void startLibrary();
    return;
  }
  // Streams also route through togglePause: the engine implements live-radio
  // semantics natively (pause disconnects, resume rejoins the live edge).
  if (queueEnded && lastQueue.length > 0) {
    queueEnded = false;
    if (queueIsActivePool()) {
      // The queue ran to its end and rests with no playhead, so play restarts it
      // from the top rather than resuming any one track. (activeQueue can now be
      // set while a folder plays with the queue merely stashed — the pool, not
      // its mere existence, is what decides this.)
      const pool = poolPaths();
      lastQueue = pool;
      lastIndex = 0;
      pendingQueueIndex = 0;
      currentNodePath.value = pool[0] ?? null;
      feedEngine(pool, 0);
    } else {
      // Implicit folder continuation: resume the track that just finished,
      // matching the prior UX where play after an album ended replayed it.
      feedEngine(lastQueue, lastIndex);
    }
    return;
  }
  void engine.togglePause();
}

const persistVolume = debounce(async (v: number) => {
  await store.set(KEY_VOLUME, v);
  await store.save();
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
  queueEnded = false;
  void engine.seekBy(seconds);
}

function seekTo(seconds: number): void {
  if (isStream.value) return;
  queueEnded = false;
  void engine.seekTo(seconds);
}

// The tracks eligible for shuffle/repeat advancement. Inside an album that's
// the folder's tracks in listing order; a search hit or external file has no
// album context, so the pool is just that single track.
function poolPaths(): string[] {
  if (currentParent) {
    return currentParent.children.filter((c) => !c.isFolder).map((c) => c.path);
  }
  if (currentNodePath.value) return [currentNodePath.value];
  // Search hit or external file: no album context, so the queue itself is the
  // pool (a single track). Lets repeat still loop it.
  return lastQueue;
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
  shuffleBag = shuffled(rest.length ? rest : pool);
}

// Hand the engine a single track and remember it as the queue, so play-after-end
// and the play button restart the right thing. UI (row highlight, now-playing,
// art) follows from the engine's track-changed → onAdvance for album tracks;
// for a lone search/external track it's already correct (same track).
function playSingle(path: string, queueIndex?: number): void {
  queueEnded = false;
  lastQueue = [path];
  lastIndex = 0;
  currentTime.value = 0;
  // Shuffle / repeat-one hand the engine one track at a time; when that track is
  // a queue row, mark which one so onAdvance highlights it. Callers pass the
  // positional index when known (e.g. repeat-one looping row 3 of a duplicate-
  // heavy queue) so the correct instance is highlighted rather than the first match.
  if (queueIsActivePool()) {
    if (queueIndex != null) {
      pendingQueueIndex = queueIndex;
    } else {
      const found = currentParent?.children.findIndex((c) => c.path === path) ?? -1;
      pendingQueueIndex = found >= 0 ? found : null;
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
  queueEnded = false;
  lastQueue = pool;
  lastIndex = idx;
  if (queueIsActivePool()) pendingQueueIndex = idx;
  feedEngine(pool, idx);
}

// Playback has run to the end with nothing left to advance to. A visible queue
// rests with no playhead — the finished rows stay on screen, but nothing is
// "current", so pressing play restarts it from the top (see togglePlayPause).
// Implicit folder continuation keeps its row highlighted so play resumes the
// track that just finished.
function stopAtQueueEnd(): void {
  queueEnded = true;
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
function handleEnded(): void {
  const mode = repeatMode.value;
  // currentNodePath is null for an external file; fall back to the queue so
  // repeat still identifies the track to loop.
  const current = currentNodePath.value ?? lastQueue[lastIndex] ?? null;

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
    if (shuffleBag.length === 0) {
      // Cycle exhausted: reshuffle and keep going when repeating, else stop.
      if (mode !== "all") {
        stopAtQueueEnd();
        return;
      }
      refillShuffleBag(current);
    }
    const next = shuffleBag.shift();
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
  const current = currentNodePath.value ?? lastQueue[lastIndex] ?? null;

  if (shuffleMode.value) {
    if (shuffleBag.length === 0) refillShuffleBag(current);
    const next = shuffleBag.shift();
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
  const current = currentNodePath.value ?? lastQueue[lastIndex] ?? null;
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
  const current = currentNodePath.value ?? lastQueue[lastIndex] ?? null;
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
function playFile(node: TreeNode, parent: TreeNode, startIndex?: number): void {
  currentParent = parent;
  currentNodePath.value = node.path;
  currentStreamUrl.value = null;
  isStream.value = false;
  currentTime.value = 0;
  duration.value = 0;
  queueEnded = false;
  setNowPlaying(node.title ?? node.name, node.artist, node.album);
  void loadArt(node.path);
  const siblings = parent.children.filter((c) => !c.isFolder);
  const tracks = siblings.map((c) => c.path);
  if (repeatMode.value === "one") {
    // Loop this track; the album never enters the queue.
    shuffleBag = [];
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
    shuffleBag = [];
    const idx = startIndex ?? Math.max(
      0,
      siblings.findIndex((c) => c.path === node.path),
    );
    lastQueue = tracks;
    lastIndex = idx;
    if (queueIsActivePool()) pendingQueueIndex = idx;
    feedEngine(tracks, idx);
  }
}

function playStream(stream: Stream): void {
  // A stream plays outside any explicit queue, which stays stashed and visible;
  // null the highlight (streams emit no track-changed, so onAdvance won't).
  queuePlayingIndex.value = null;
  currentParent = null;
  currentNodePath.value = null;
  currentStreamUrl.value = stream.url;
  currentStreamName = stream.name;
  isStream.value = true;
  currentTime.value = 0;
  duration.value = 0;
  queueEnded = false;
  lastQueue = [];
  shuffleBag = [];
  // Station name until the first ICY title arrives (or forever, for stations
  // that don't send titles).
  setNowPlaying(stream.name, null, null);
  npStreamMeta.value = null;
  void engine.playStream(stream.url);
  // Manifest station art shows in the same spot as album art. Like loadArt,
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
function playSearchTrack(t: SearchTrack): void {
  // A lone search hit plays outside any explicit queue, which stays stashed and
  // visible; currentParent is null so onAdvance won't touch the highlight.
  queuePlayingIndex.value = null;
  currentParent = null;
  currentNodePath.value = t.path;
  currentStreamUrl.value = null;
  isStream.value = false;
  currentTime.value = 0;
  duration.value = 0;
  queueEnded = false;
  lastQueue = [t.path];
  lastIndex = 0;
  shuffleBag = [];
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

async function playFolder(folder: SearchFolder): Promise<void> {
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
  const n = tracks.length;
  playQueue(
    {
      kind: "folder",
      title: folder.name,
      subtitle: `${n} track${n === 1 ? "" : "s"}`,
      tracks,
    },
    `queue:folder:${folder.path}`,
  );
}

// Opens a queue in the right pane and starts it. Playback reuses the album path
// via a synthetic parent (so shuffle/repeat/gapless all work); the queue view is
// what makes it visible. Under shuffle we start on a random track (matching
// playFolder) so replaying the same artist/album doesn't always open on track 1;
// straight play starts on the first track, the page's natural order. Either way
// the view keeps natural order and just highlights the playing row. The synthetic
// path is unique per queue and never a real tree path, so the rescan re-bind
// (suppressed while activeQueue is set) can't repoint currentParent at a folder.
function playQueue(queue: Queue, syntheticPath: string): void {
  if (queue.tracks.length === 0) return;
  const parent = syntheticParent(syntheticPath, queue.title, queue.tracks);
  const start = shuffleMode.value
    ? parent.children[Math.floor(Math.random() * parent.children.length)]
    : parent.children[0];
  playFile(start, parent);
  openActiveQueue(queue);
}

async function openArtistQueue(name: string): Promise<void> {
  let tracks: SearchTrack[];
  try {
    tracks = await invoke<SearchTrack[]>("artist_tracks", { artist: name });
  } catch (e) {
    console.error("artist_tracks failed", name, e);
    return;
  }
  if (tracks.length === 0) return;
  const n = tracks.length;
  playQueue(
    {
      kind: "artist",
      title: name,
      subtitle: `${n} track${n === 1 ? "" : "s"}`,
      tracks,
    },
    `queue:artist:${name}`,
  );
}

async function openAlbumQueue(album: string, albumArtist: string): Promise<void> {
  let tracks: SearchTrack[];
  try {
    tracks = await invoke<SearchTrack[]>("album_tracks", { album, albumArtist });
  } catch (e) {
    console.error("album_tracks failed", album, albumArtist, e);
    return;
  }
  if (tracks.length === 0) return;
  const n = tracks.length;
  playQueue(
    {
      kind: "album",
      title: album,
      subtitle: `${n} track${n === 1 ? "" : "s"}`,
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

function nodeToTrack(n: TreeNode): SearchTrack {
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
    if (currentParent) currentParent.children.push(...tracks.map(trackToNode));
    lastQueue = [...lastQueue, ...paths];

    if (queueEnded) {
      // The queue had run to the end; kick playback into the first appended track
      // (feedEngine stops after it if playlist autoadvance is off).
      queueEnded = false;
      lastIndex = lastQueue.length - paths.length;
      pendingQueueIndex = lastIndex;
      feedEngine(lastQueue, lastIndex);
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
      shuffleBag.push(...shuffled(paths));
    }
    // repeat-one: nothing to enqueue now; the appended tracks joined the pool for
    // when repeat-one is turned off.
  }

  // Bring the first appended row into view on the coming re-render (else the
  // list would snap back to the playing row and hide the addition below the fold).
  pendingQueueScrollIndex = q.tracks.length;
  // Reassign to re-render the list + count.
  const n = q.tracks.length + tracks.length;
  openActiveQueue({
    ...q,
    tracks: [...q.tracks, ...tracks],
    subtitle: `${n} track${n === 1 ? "" : "s"}`,
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
  const cur = currentParent?.children.find((c) => c.path === path);
  const track: SearchTrack = cur
    ? nodeToTrack(cur)
    : { path, title: npTitle.value || null, artist: npArtist.value, album: npAlbum.value };
  const title = UNTITLED_PLAYLIST_TITLE;
  currentParent = syntheticParent(`queue:current:${Date.now()}`, title, [track]);
  lastQueue = [path];
  lastIndex = 0;
  // The audible track is now the queue's row 0 and keeps playing (no new engine
  // play fires here), so highlight it directly rather than waiting on onAdvance.
  queuePlayingIndex.value = 0;
  shuffleBag = [];
  // Straight play holds the whole folder in the engine for gapless auto-advance;
  // drop that tail so the current track is the queue's last entry until the
  // append extends it. (Per-track modes already hold only the current track.)
  if (!shuffleMode.value && repeatMode.value !== "one") void engine.clearUpcoming();
  openActiveQueue({
    kind: "playlist",
    title,
    subtitle: "1 track",
    tracks: [track],
  });
}

// The single entry point behind "Add to queue". It only ever appends —
// play-later, never interrupting the audible track. With a queue open it appends
// to it. With none, it seeds a queue from the currently playing track first
// (seedQueueFromCurrent) and appends after it; if nothing is playing, the append
// starts a fresh queue that plays at once (there's nothing to play it after).
function addToQueue(tracks: SearchTrack[]): void {
  if (tracks.length === 0) return;
  const n = tracks.length;
  if (!activeQueue.value) {
    if (hasTrack.value && currentNodePath.value && !isStream.value) {
      seedQueueFromCurrent();
    } else {
      // Nothing queueable is playing (silence, or a live stream): start a fresh
      // queue from these tracks and play it.
      playQueue(
        {
          kind: "playlist",
          title: UNTITLED_PLAYLIST_TITLE,
          subtitle: `${n} track${n === 1 ? "" : "s"}`,
          tracks,
        },
        `queue:adhoc:${Date.now()}`,
      );
      toast(`Added ${n} track${n === 1 ? "" : "s"}`);
      return;
    }
  }
  appendTracksToActiveQueue(tracks);
  toast(`Added ${n} track${n === 1 ? "" : "s"}`);
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
  const queueWasPool = queueIsActivePool();
  clearActiveQueue();
  queuePlayingIndex.value = null;
  if (!queueWasPool) return;

  const current = currentNodePath.value;
  if (current && !queueEnded) {
    // Detach: the audible track becomes a lone now-playing track. No parent (so
    // the pool is just this track), and the engine's gapless tail is dropped so
    // playback stops at this track's end instead of the vanished queue. The
    // now-playing card (title/artist/album/art) and playback are untouched.
    currentParent = null;
    lastQueue = [current];
    lastIndex = 0;
    pendingQueueIndex = null;
    shuffleBag = [];
    if (!shuffleMode.value && repeatMode.value !== "one") void engine.clearUpcoming();
    return;
  }

  // The queue already drained (rests with no playhead): nothing to keep playing,
  // so tear playback fully down (native Stop) and return to a clean empty hero.
  currentParent = null;
  currentNodePath.value = null;
  currentStreamUrl.value = null;
  isStream.value = false;
  queueEnded = false;
  lastQueue = [];
  lastIndex = 0;
  pendingQueueIndex = null;
  shuffleBag = [];
  currentTime.value = 0;
  duration.value = 0;
  hasTrack.value = false;
  npTitle.value = "";
  npArtist.value = null;
  npAlbum.value = null;
  clearArt();
  void engine.stop();
}

async function addFolderToQueue(folder: SearchFolder): Promise<void> {
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
function trackContextItems(track: {
  artist: string | null;
  album: string | null;
  albumArtist: string | null;
}): { label: string; action: () => void }[] {
  const items: { label: string; action: () => void }[] = [];
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

// Plays a queue row by its index (not path, so a duplicated track resolves to
// the clicked instance). This is the sole way to (re)enter the queue: it makes
// the queue the engine's active pool. If the queue is already the pool, reuse
// its synthetic parent; if it was merely stashed while a folder/stream/lone
// track played, rebuild the parent from the queue tracks so playback moves into
// it. activeQueue (the queue data) is untouched.
function playQueueTrack(index: number): void {
  const q = activeQueue.value;
  if (!q) return;
  const parent = queueIsActivePool() && currentParent
    ? currentParent
    : syntheticParent(`queue:active:${Date.now()}`, q.title, q.tracks);
  const node = parent.children[index];
  if (!node) return;
  playFile(node, parent, index);
}

// Plays a file from outside the library (passed in via OS file association).
// Intentionally leaves currentNode/currentParent null so the tree is not
// touched, no row is highlighted, and album-advance on end is a no-op. The
// next library or stream selection replaces this state entirely.
async function openExternalFile(path: string): Promise<void> {
  let meta: TrackMeta;
  try {
    meta = await invoke<TrackMeta>("prepare_external_file", { path });
  } catch (e) {
    console.error("prepare_external_file failed", path, e);
    return;
  }
  // Leaves currentParent null so the tree is untouched, no row is highlighted,
  // and album-advance is a no-op (single-track queue). Any explicit queue stays
  // stashed and visible; null the highlight since this plays outside it.
  queuePlayingIndex.value = null;
  currentParent = null;
  currentNodePath.value = null;
  currentStreamUrl.value = null;
  isStream.value = false;
  currentTime.value = 0;
  duration.value = 0;
  queueEnded = false;
  lastQueue = [path];
  lastIndex = 0;
  shuffleBag = [];
  const fallback = path.split(/[\\/]/).pop() ?? path;
  setNowPlaying(meta.title ?? fallback, meta.artist, meta.album);
  void loadArt(path);
  void engine.play([path], 0);
}

function clearArt(): void {
  artRequestId++;
  npArt.value = null;
}

async function loadArt(path: string): Promise<void> {
  await applyArt(() => invoke<string | null>("get_art", { path }), path);
}

// Station art declared in the stream manifest, fetched by the backend (the
// CSP forbids remote/file <img> sources, so it arrives as a data URL just
// like embedded track art).
async function loadStreamArt(image: string): Promise<void> {
  await applyArt(() => invoke<string | null>("get_stream_image", { image }), image);
}

async function applyArt(
  fetchArt: () => Promise<string | null>,
  source: string,
): Promise<void> {
  const id = ++artRequestId;
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
  if (id !== artRequestId) return;
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
    if (id !== artRequestId) return;
  }
  npArt.value = dataUrl;
}

// --- Library / streams loading ---

async function refreshTree(libraryRoot: string): Promise<void> {
  rootNode = null;
  libraryHasContent.value = false;
  if (!libraryRoot) {
    libraryRootValid.value = true;
    setEmpty(treeContainer, "No library root set");
    return;
  }
  setEmpty(treeContainer, "Loading…", "loading");
  let listing: DirListing;
  try {
    listing = await invoke<DirListing>("list_dir", { path: libraryRoot });
  } catch (e) {
    console.error("list_dir failed for", libraryRoot, e);
    libraryRootValid.value = false;
    setEmpty(treeContainer, "Invalid library root");
    return;
  }
  libraryRootValid.value = true;
  rootNode = {
    path: libraryRoot,
    name: libraryRoot,
    title: null,
    artist: null,
    album: null,
    albumArtist: null,
    disc: null,
    track: null,
    isFolder: true,
    loaded: true,
    expanded: true,
    children: nodesFromListing(libraryRoot, listing),
  };
  libraryHasContent.value = rootNode.children.length > 0;
  renderTree();
}

// Re-lists every folder the user has opened, merging the fresh listing into the
// existing tree: new files/folders appear, deleted ones drop, and metadata is
// taken from list_dir (which joins the freshly-scanned DB). Expansion and
// loaded state of surviving folders is preserved so an auto-rescan never
// collapses the tree out from under the user. Unopened folders are left as lazy
// stubs — they'll list correctly when clicked.
async function reconcileNode(node: TreeNode): Promise<void> {
  if (!node.isFolder || !node.loaded) return;
  let listing: DirListing;
  try {
    listing = await invoke<DirListing>("list_dir", { path: node.path });
  } catch (e) {
    // Folder vanished or became unreadable; leave its stale children in place.
    // The parent's reconcile will drop this node entirely if it's truly gone.
    console.error("list_dir failed during reconcile for", node.path, e);
    return;
  }
  const oldFolders = new Map<string, TreeNode>();
  for (const c of node.children) if (c.isFolder) oldFolders.set(c.name, c);

  const next = nodesFromListing(node.path, listing, oldFolders);
  node.children = next;
  // Reconcile sibling subtrees concurrently: each level must await its own
  // list_dir before it knows its children, but independent branches have no
  // ordering between them, so fan them out instead of serializing N round trips.
  await Promise.all(
    next
      .filter((child) => child.isFolder && child.loaded)
      .map((child) => reconcileNode(child)),
  );
}

function findNode(
  root: TreeNode,
  path: string,
): { node: TreeNode; parent: TreeNode } | null {
  for (const child of root.children) {
    if (child.path === path) return { node: child, parent: root };
    if (child.isFolder && child.loaded) {
      const found = findNode(child, path);
      if (found) return found;
    }
  }
  return null;
}

let libraryRefreshing = false;
let libraryRefreshPending = false;

// Serialized + coalesced: scans can emit "library-scanned" repeatedly, and two
// overlapping reconciles would both mutate node.children and both renderTree
// (tearing the visible tree). Mirrors the backend's request_scan — at most one
// reconcile runs; events arriving during it collapse into a single follow-up.
async function refreshLibrary(): Promise<void> {
  if (libraryRefreshing) {
    libraryRefreshPending = true;
    return;
  }
  libraryRefreshing = true;
  try {
    do {
      libraryRefreshPending = false;
      if (!rootNode) break;
      await reconcileNode(rootNode);
      // reconcile rebuilds node objects, so the currentParent captured at
      // play time now points outside the tree. Re-bind it by path so the
      // playing-row highlight and album auto-advance keep working. If the
      // playing file was deleted, leave the stale reference — playback
      // continues and the next selection replaces it.
      //
      // Suppressed only while the queue is the active pool: its parent is a
      // synthetic node whose children are the whole queue, and its currentNodePath
      // may well live in a real tree folder — re-binding would silently shrink the
      // pool from "the queue" to "that one album folder". A merely stashed queue
      // (a real folder is the pool) must still re-bind so folder playback survives.
      const path = currentNodePath.value;
      if (path && !queueIsActivePool()) {
        const found = findNode(rootNode, path);
        if (found) {
          currentParent = found.parent;
        }
      }
      const filesTab = document.getElementById("tab-files");
      const scrollTop = filesTab?.scrollTop ?? 0;
      renderTree();
      if (filesTab) filesTab.scrollTop = scrollTop;
    } while (libraryRefreshPending);
  } finally {
    libraryRefreshing = false;
  }
}

async function refreshStreams(manifestPath: string): Promise<void> {
  if (!manifestPath) {
    allStreams = [];
    manifestPathValid.value = true;
    setEmpty(streamsContainer, "No manifest path set");
    return;
  }
  setEmpty(streamsContainer, "Loading…", "loading");
  try {
    const streams = await invoke<Stream[]>("read_manifest", { path: manifestPath });
    allStreams = streams;
    manifestPathValid.value = true;
    renderStreams(streams);
  } catch (e) {
    console.error("read_manifest failed for", manifestPath, e);
    allStreams = [];
    manifestPathValid.value = false;
    setEmpty(streamsContainer, "Invalid manifest path");
  }
}

async function setLibraryRoot(value: string): Promise<void> {
  libraryRootInput.value = value;
  await store.set(KEY_LIBRARY_ROOT, value);
  await store.save();
  if (value) {
    void invoke("rescan_library", { path: value });
  }
  // Watch the new root (or, when value is "", tear the old watcher down).
  void invoke("watch_library", { path: value }).catch((e) =>
    console.error("watch_library failed", e),
  );
  await refreshTree(value);
}

async function setManifestPath(value: string): Promise<void> {
  manifestPathInput.value = value;
  await store.set(KEY_MANIFEST_PATH, value);
  await store.save();
  await refreshStreams(value);
}

async function browseLibraryRoot(): Promise<void> {
  const selected = await open({
    directory: true,
    multiple: false,
    defaultPath: libraryRootInput.value || undefined,
  });
  if (typeof selected === "string") {
    await setLibraryRoot(selected);
  }
}

async function browseManifestPath(): Promise<void> {
  const selected = await open({
    directory: false,
    multiple: false,
    defaultPath: manifestPathInput.value || undefined,
    filters: [{ name: "Manifest", extensions: ["json", "m3u", "m3u8"] }],
  });
  if (typeof selected === "string") {
    await setManifestPath(selected);
  }
}

// --- Event wiring ---

function setupTabs(): void {
  const tabs = document.querySelectorAll<HTMLButtonElement>(".tab");
  for (const btn of tabs) {
    btn.addEventListener("click", () => {
      activeTab.value = btn.dataset.tab as "files" | "streams";
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
  if (perTrack && !isStream.value && lastQueue.length > 1) {
    void engine.clearUpcoming();
    if (currentNodePath.value) {
      lastQueue = [currentNodePath.value];
      lastIndex = 0;
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
      lastQueue = pool;
      lastIndex = idx;
    }
  } else if (lastQueue.length > 1) {
    // Drop the tail so the current track is the last thing the engine plays.
    void engine.clearUpcoming();
    lastQueue = [current];
    lastIndex = 0;
  }
}

// Apply an autoadvance toggle from the OS Playback menu: update the signal,
// persist it, and — if it governs what's playing right now — reconcile the engine
// so the change takes effect at the current track's end (not the queue's).
function setAutoadvance(which: "files" | "playlists", enabled: boolean): void {
  const sig = which === "files" ? autoadvanceFiles : autoadvancePlaylists;
  if (sig.value === enabled) return;
  sig.value = enabled;
  void persistAutoadvance();
  const activeContext = queueIsActivePool() ? "playlists" : "files";
  if (hasTrack.value && which === activeContext) applyAutoadvanceChange();
}

const persistAutoadvance = async (): Promise<void> => {
  await store.set(KEY_AUTOADVANCE_FILES, autoadvanceFiles.value);
  await store.set(KEY_AUTOADVANCE_PLAYLISTS, autoadvancePlaylists.value);
  await store.save();
};

function setupPlaybackModes(): void {
  modeShuffleBtn.addEventListener("click", () => {
    shuffleMode.value = !shuffleMode.value;
    // Seed the bag so a shuffle turned on mid-album has a full cycle ready;
    // clear it when turning shuffle off.
    if (shuffleMode.value) refillShuffleBag(currentNodePath.value);
    else shuffleBag = [];
    applyModeChange();
  });
  modeRepeatBtn.addEventListener("click", () => {
    // Cycle off → all → one → off.
    repeatMode.value =
      repeatMode.value === "off" ? "all" : repeatMode.value === "all" ? "one" : "off";
    applyModeChange();
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
        await store.set(KEY_SPLITTER_WIDTH, final);
        await store.save();
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
  const storedNormal = await store.get<{ width: number; height: number }>(
    KEY_WINDOW_SIZE_NORMAL,
  );
  if (storedNormal && storedNormal.width > 0 && storedNormal.height > MINI_MAX_HEIGHT) {
    normalSize = storedNormal;
  }
  const storedMini = await store.get<{ width: number; height: number }>(
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
    const width = window.innerWidth;
    const height = window.innerHeight;
    if (width <= 0 || height <= 0) return;
    if (isMiniViewport()) {
      miniSize = { width, height };
      await store.set(KEY_WINDOW_SIZE_MINI, miniSize);
    } else {
      normalSize = { width, height };
      await store.set(KEY_WINDOW_SIZE_NORMAL, normalSize);
    }
    await store.save();
  }, 400);

  window.addEventListener("resize", () => persistSize());

  const storedPos = await store.get<{ x: number; y: number }>(
    KEY_WINDOW_POSITION,
  );
  if (storedPos) {
    await appWindow.setPosition(new PhysicalPosition(storedPos.x, storedPos.y));
  }

  const persistPos = debounce(async (x: number, y: number) => {
    await store.set(KEY_WINDOW_POSITION, { x, y });
    await store.save();
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

  // External links must go to the OS browser, not navigate the webview.
  document.addEventListener("click", (e) => {
    const link = (e.target as Element).closest?.("a[href^='http']");
    if (!(link instanceof HTMLAnchorElement)) return;
    e.preventDefault();
    void openUrl(link.href);
  });
}

function searchLabel(t: SearchTrack): { primary: string; secondary: string } {
  const fallbackName = t.path.split(/[\\/]/).pop() ?? t.path;
  return {
    primary: t.title ?? fallbackName,
    secondary: [t.artist, t.album].filter(Boolean).join(" · "),
  };
}

function setupSearch(): void {
  let items: SearchItem[] = [];
  let activeIndex = -1;
  // Bumped per query so a slow search_tracks that resolves after a newer
  // keystroke can't overwrite fresher results.
  let queryToken = 0;
  // Query and caret held while the input is blurred. Blur empties the visible
  // box (the collapsed field just shows clipped stale text otherwise) but the
  // search isn't discarded: refocusing restores the query, its selection, and
  // reopens its results.
  let stash: {
    query: string;
    start: number;
    end: number;
    dir: "forward" | "backward" | "none";
  } | null = null;
  const searchBox = document.getElementById("search") as HTMLElement;

  function close(): void {
    items = [];
    activeIndex = -1;
    searchResultsEl.classList.add("hidden");
    searchResultsEl.innerHTML = "";
  }

  function choose(item: SearchItem): void {
    if (item.kind === "artist") {
      void openArtistQueue(item.artist.name);
    } else if (item.kind === "album") {
      void openAlbumQueue(item.album.album, item.album.artist);
    } else if (item.kind === "folder") {
      // Play into the queue without touching the left panel — no tab switch or
      // scroll, so a search never yanks you away from where you were browsing.
      void playFolder(item.folder);
    } else if (item.kind === "file") {
      playSearchTrack(item.track);
    } else {
      activeTab.value = "streams";
      playStream(item.stream);
    }
    searchInput.value = "";
    searchInput.blur();
    close();
  }

  function render(): void {
    searchResultsEl.innerHTML = "";
    if (items.length === 0) {
      const empty = document.createElement("div");
      empty.className = "search-empty";
      empty.textContent = "No results";
      searchResultsEl.appendChild(empty);
      searchResultsEl.classList.remove("hidden");
      return;
    }
    let activeRow: HTMLElement | null = null;
    items.forEach((item, i) => {
      const row = document.createElement("div");
      row.className = "search-result";
      row.setAttribute("role", "option");
      if (i === activeIndex) {
        row.classList.add("active");
        activeRow = row;
      }
      const text = document.createElement("span");
      text.className = "text";
      const primary = document.createElement("div");
      primary.className = "primary";
      const secondary = document.createElement("div");
      secondary.className = "secondary";
      if (item.kind === "artist") {
        // Distinct masked-SVG icons (like the folder row's) mark artist and
        // album rows so the four library row types read apart at a glance.
        const icon = document.createElement("span");
        icon.className = "search-icon icon-artist";
        row.appendChild(icon);
        primary.textContent = item.artist.name;
        secondary.textContent = "Artist";
      } else if (item.kind === "album") {
        const icon = document.createElement("span");
        icon.className = "search-icon icon-album";
        row.appendChild(icon);
        primary.textContent = item.album.album;
        secondary.textContent = item.album.artist
          ? `Album · ${item.album.artist}`
          : "Album";
      } else if (item.kind === "folder") {
        // A folder icon distinguishes "play this whole folder" rows from the
        // single-track and stream rows around them. The glyph is a masked SVG
        // in .search-icon so it takes the row's color instead of the OS emoji.
        const icon = document.createElement("span");
        icon.className = "search-icon";
        row.appendChild(icon);
        primary.textContent = item.folder.name;
        // The containing folder's path (relative to the library root) gives
        // context — which artist an album sits under. Skipped for top-level
        // folders, where the parent is the root itself and adds only noise.
        const parentPath = item.folder.path.split("/").slice(0, -1).join("/");
        const root = rootNode?.path ?? "";
        if (parentPath !== root) {
          secondary.textContent = parentPath.startsWith(root + "/")
            ? parentPath.slice(root.length + 1)
            : parentPath;
        }
      } else if (item.kind === "file") {
        const l = searchLabel(item.track);
        primary.textContent = l.primary;
        secondary.textContent = l.secondary;
      } else {
        primary.textContent = item.stream.name;
      }
      text.appendChild(primary);
      if (secondary.textContent) text.appendChild(secondary);
      row.appendChild(text);
      // mousedown, not click: clicking a row blurs the input first, and a blur
      // handler that closed the dropdown would remove the row before click.
      row.addEventListener("mousedown", (e) => {
        e.preventDefault();
        choose(item);
      });
      searchResultsEl.appendChild(row);
    });
    searchResultsEl.classList.remove("hidden");
    if (activeRow) (activeRow as HTMLElement).scrollIntoView({ block: "nearest" });
  }

  const runSearch = debounce(async (raw: string) => {
    const token = ++queryToken;
    const query = raw.trim();
    if (!query) {
      close();
      return;
    }
    const needle = query.toLowerCase();
    const streamItems: SearchItem[] = allStreams
      .filter((s) => s.name.toLowerCase().includes(needle))
      .map((s) => ({ kind: "stream", stream: s }));
    let artistItems: SearchItem[] = [];
    let albumItems: SearchItem[] = [];
    let folderItems: SearchItem[] = [];
    let fileItems: SearchItem[] = [];
    try {
      const [artists, albums, folders, tracks] = await Promise.all([
        invoke<SearchArtist[]>("search_artists", { query }),
        invoke<SearchAlbum[]>("search_albums", { query }),
        invoke<SearchFolder[]>("search_folders", { query }),
        invoke<SearchTrack[]>("search_tracks", { query }),
      ]);
      artistItems = artists.map((a) => ({ kind: "artist", artist: a }));
      albumItems = albums.map((a) => ({ kind: "album", album: a }));
      folderItems = folders.map((f) => ({ kind: "folder", folder: f }));
      fileItems = tracks.map((t) => ({ kind: "file", track: t }));
    } catch (e) {
      console.error("search failed", e);
    }
    if (token !== queryToken) return;
    // Artists and albums first (a metadata-name match usually means "open that
    // page"), then folders, streams, and finally individual tracks.
    items = [
      ...artistItems,
      ...albumItems,
      ...folderItems,
      ...streamItems,
      ...fileItems,
    ];
    activeIndex = items.length > 0 ? 0 : -1;
    render();
  }, 150);

  searchInput.addEventListener("input", () => runSearch(searchInput.value));
  searchInput.addEventListener("focus", () => {
    if (stash && !searchInput.value) {
      searchInput.value = stash.query;
      // Restores the caret for keyboard-driven focus (tab, window
      // reactivation). On mouse focus the browser places the caret from the
      // click position afterward, which is the better behavior there anyway.
      searchInput.setSelectionRange(stash.start, stash.end, stash.dir);
    }
    if (searchInput.value.trim()) runSearch(searchInput.value);
  });

  // Escape and choose() clear the value before blurring, so only abandoned
  // queries survive the round trip. The runSearch("") call supersedes any
  // pending debounced keystroke that would otherwise reopen the dropdown
  // after the box has visually emptied.
  searchInput.addEventListener("blur", () => {
    stash = searchInput.value
      ? {
          query: searchInput.value,
          start: searchInput.selectionStart ?? searchInput.value.length,
          end: searchInput.selectionEnd ?? searchInput.value.length,
          dir: searchInput.selectionDirection ?? "none",
        }
      : null;
    searchInput.value = "";
    close();
    runSearch("");
  });

  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      searchInput.value = "";
      close();
      searchInput.blur();
      return;
    }
    if (searchResultsEl.classList.contains("hidden") || items.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      activeIndex = (activeIndex + 1) % items.length;
      render();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      activeIndex = (activeIndex - 1 + items.length) % items.length;
      render();
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(items[activeIndex >= 0 ? activeIndex : 0]);
    }
  });

  // Cmd/Ctrl+F focuses the search field (matches Apple Music / iTunes).
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.key === "f" || e.key === "F")) {
      e.preventDefault();
      searchInput.focus();
      searchInput.select();
    }
  });

  // Swallow mousedown inside the widget so it never reaches the document-level
  // drag-region handler (which would otherwise start a window drag) or the
  // outside-click closer below.
  searchBox.addEventListener("mousedown", (e) => e.stopPropagation());

  // Any mousedown that escapes the widget closes the dropdown.
  document.addEventListener("mousedown", () => close());
}

function setupPlayerControls(): void {
  playPauseBtn.addEventListener("click", togglePlayPause);
  prevBtn.addEventListener("click", skipPrev);
  nextBtn.addEventListener("click", skipNext);

  document.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (isTextInputTarget(e.target)) return;

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

function setupVolumeControl(): void {
  volumeBtn.addEventListener("click", () => {
    setVolume(volume.value > 0 ? 0 : lastNonZeroVolume);
  });

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
  // The one-line queue-mode strip: "Now Playing: <artist> - <title>". The prefix
  // and " - " separator are static (HTML/CSS); we fill title and artist and drop
  // the "<artist> - " lead-in when the artist is unknown.
  effect(() => {
    npStripTitleEl.textContent = npTitle.value;
    npStripArtistEl.textContent = npArtist.value ?? "";
    npStripArtistWrapEl.classList.toggle("hidden", !npArtist.value);
  });
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
    // Prev is live whenever play is (it restarts or steps back); only streams
    // and the idle player disable it. Next disables at the genuine end of the
    // line so a dead press reads as unavailable rather than a silent no-op.
    prevBtn.disabled = !hasTrack.value || isStream.value;
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
    document
      .querySelectorAll("#folder-tree .node-label.playing, #streams-list .node-label.playing")
      .forEach((el) => el.classList.remove("playing"));
    if (path) {
      document
        .querySelector(`#folder-tree .node-label[data-path="${CSS.escape(path)}"]`)
        ?.classList.add("playing");
    }
    if (url) {
      document
        .querySelector(`#streams-list .node-label[data-stream-url="${CSS.escape(url)}"]`)
        ?.classList.add("playing");
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

  // With a queue, the queue list fills the pane and the now-playing hero drops to
  // a compact strip above the controls; without one, the hero owns the whole pane
  // and the list is hidden. `has-queue` on the panel drives both (see styles.css).
  // Reads queuePlayingIndex too so the highlighted/scrolled row tracks advances
  // (and clears when the queue is merely stashed while a folder/stream plays).
  effect(() => {
    const queue = activeQueue.value;
    queuePlayingIndex.value;
    nowPlayingPanel.classList.toggle("has-queue", queue !== null);
    renderQueue(queue);
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

  effect(() => {
    libraryRootInput.classList.toggle("invalid", !libraryRootValid.value);
  });
  effect(() => {
    manifestPathInput.classList.toggle("invalid", !manifestPathValid.value);
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

  nowPlayingTitleEl = document.querySelector("#now-playing-title") as HTMLElement;
  nowPlayingTitleInner = nowPlayingTitleEl.querySelector(".marquee-inner") as HTMLElement;
  nowPlayingArtistEl = document.querySelector("#now-playing-artist") as HTMLElement;
  nowPlayingArtistInner = nowPlayingArtistEl.querySelector(".marquee-inner") as HTMLElement;
  nowPlayingAlbumEl = document.querySelector("#now-playing-album") as HTMLElement;
  nowPlayingAlbumInner = nowPlayingAlbumEl.querySelector(".marquee-inner") as HTMLElement;
  npStripTitleEl = document.querySelector("#np-strip-title") as HTMLElement;
  npStripArtistEl = document.querySelector("#np-strip-artist") as HTMLElement;
  npStripArtistWrapEl = document.querySelector("#np-strip-artist-wrap") as HTMLElement;
  // Same double-click-to-toggle-mini gesture as the card it replaces in queue mode.
  const nowPlayingStripEl = document.querySelector("#now-playing-strip") as HTMLElement;
  nowPlayingStripEl.addEventListener("dblclick", () => void toggleMiniPlayer());
  nowPlayingStreamMetaEl = document.querySelector("#now-playing-stream-meta") as HTMLElement;
  streamMetaSongEl = document.querySelector("#stream-meta-song") as HTMLElement;
  streamMetaSongInner = streamMetaSongEl.querySelector(".marquee-inner") as HTMLElement;
  streamMetaArtistEl = document.querySelector("#stream-meta-artist") as HTMLElement;
  streamMetaArtistInner = streamMetaArtistEl.querySelector(".marquee-inner") as HTMLElement;
  liveIndicatorEl = document.querySelector("#live-indicator") as HTMLElement;
  nowPlayingArtEl = document.querySelector("#now-playing-art") as HTMLImageElement;
  nowPlayingEmptyEl = document.querySelector("#now-playing-empty") as HTMLElement;
  playPauseBtn = document.querySelector("#play-pause-btn") as HTMLButtonElement;
  prevBtn = document.querySelector("#prev-btn") as HTMLButtonElement;
  nextBtn = document.querySelector("#next-btn") as HTMLButtonElement;
  seekBar = document.querySelector("#seek-bar") as HTMLInputElement;
  timeCurrentEl = document.querySelector("#time-current") as HTMLElement;
  timeRemainingEl = document.querySelector("#time-remaining") as HTMLElement;
  volumeControlEl = document.querySelector("#volume-control") as HTMLElement;
  volumeBtn = document.querySelector("#volume-btn") as HTMLButtonElement;
  volumePopover = document.querySelector("#volume-popover") as HTMLElement;
  volumeBar = document.querySelector("#volume-bar") as HTMLInputElement;
  treeContainer = document.querySelector("#folder-tree") as HTMLElement;
  streamsContainer = document.querySelector("#streams-list") as HTMLElement;
  libraryRootInput = document.querySelector("#library-root") as HTMLInputElement;
  libraryRootBrowseBtn = document.querySelector("#library-root-browse") as HTMLButtonElement;
  manifestPathInput = document.querySelector("#manifest-path") as HTMLInputElement;
  manifestPathBrowseBtn = document.querySelector("#manifest-path-browse") as HTMLButtonElement;
  miniplayerBtn = document.querySelector("#miniplayer-btn") as HTMLButtonElement;
  miniplayerBtn.addEventListener("click", () => void toggleMiniPlayer());
  settingsBackBtn = document.querySelector("#settings-back-btn") as HTMLButtonElement;
  playbackModesEl = document.querySelector("#playback-modes") as HTMLElement;
  modeShuffleBtn = document.querySelector("#mode-shuffle") as HTMLButtonElement;
  modeRepeatBtn = document.querySelector("#mode-repeat") as HTMLButtonElement;
  searchEl = document.querySelector("#search") as HTMLElement;
  searchInput = document.querySelector("#search-input") as HTMLInputElement;
  searchResultsEl = document.querySelector("#search-results") as HTMLElement;
  nowPlayingPanel = document.querySelector("#now-playing-panel") as HTMLElement;
  settingsPanel = document.querySelector("#settings-panel") as HTMLElement;
  splitterEl = document.querySelector("#splitter") as HTMLElement;
  queueTitleEl = document.querySelector("#queue-title") as HTMLElement;
  queueSubtitleEl = document.querySelector("#queue-subtitle") as HTMLElement;
  queueListEl = document.querySelector("#queue-list") as HTMLElement;
  queueCloseBtn = document.querySelector("#queue-close-btn") as HTMLButtonElement;
  queueCloseBtn.addEventListener("click", closeQueue);
  toastEl = document.querySelector("#toast") as HTMLElement;

  store = await load(STORE_FILE, { defaults: {}, autoSave: false });

  const libraryRoot = (await store.get<string>(KEY_LIBRARY_ROOT)) ?? "";
  const manifestPath = (await store.get<string>(KEY_MANIFEST_PATH)) ?? "";
  const splitterWidth = (await store.get<string>(KEY_SPLITTER_WIDTH)) ?? null;
  const storedVolume = await store.get<number>(KEY_VOLUME);
  volume.value = typeof storedVolume === "number" ? Math.max(0, Math.min(1, storedVolume)) : 1;
  if (volume.value > 0) lastNonZeroVolume = volume.value;

  // Autoadvance preferences (both default on). Sync the OS Playback-menu
  // checkmarks to the loaded values, then listen for the menu's toggles.
  autoadvanceFiles.value = (await store.get<boolean>(KEY_AUTOADVANCE_FILES)) ?? true;
  autoadvancePlaylists.value = (await store.get<boolean>(KEY_AUTOADVANCE_PLAYLISTS)) ?? true;
  void invoke("set_autoadvance_checked", {
    files: autoadvanceFiles.value,
    playlists: autoadvancePlaylists.value,
  });
  await listen<[string, boolean]>("menu:autoadvance", (event) => {
    const [which, enabled] = event.payload;
    setAutoadvance(which === "files" ? "files" : "playlists", enabled);
  });

  setupTabs();
  setupPlaybackModes();
  await setupWindowSize(appWindow);
  setupSplitter(splitterWidth);
  setupSettings();
  setupSearch();
  setupPlayerControls();
  setupVolumeControl();
  setupEffects();

  libraryRootInput.value = libraryRoot;
  manifestPathInput.value = manifestPath;

  libraryRootBrowseBtn.addEventListener("click", () => void browseLibraryRoot());
  manifestPathBrowseBtn.addEventListener("click", () => void browseManifestPath());

  // The manifest field also accepts a typed/pasted path or URL: Enter commits
  // (blur fires "change"), and change re-reads the manifest via the same path
  // as the Choose… button.
  manifestPathInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") manifestPathInput.blur();
  });
  manifestPathInput.addEventListener("change", () => {
    void setManifestPath(manifestPathInput.value.trim());
  });

  await listen<ScanResult>("library-scanned", (event) => {
    if (!event.payload.ok) {
      console.error("library scan failed:", event.payload.error);
      return;
    }
    void refreshLibrary();
  });

  await listen<string>("open-file", (event) => {
    void openExternalFile(event.payload);
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

  // Drain any file passed at launch (cold start). Must happen after the
  // open-file listener is registered so the ready-flag race is closed.
  const pendingOpen = await invoke<string | null>("frontend_ready");
  if (pendingOpen) {
    void openExternalFile(pendingOpen);
  }

  await refreshTree(libraryRoot);
  await refreshStreams(manifestPath);

  if (libraryRoot) {
    void invoke("rescan_library", { path: libraryRoot });
    void invoke("watch_library", { path: libraryRoot }).catch((e) =>
      console.error("watch_library failed", e),
    );
  }
}

window.addEventListener("DOMContentLoaded", init);
