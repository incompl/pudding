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
// restore the size you last used in the *other* mode. KEY_WINDOW_LAST_MODE
// records which mode was active at quit so launch reopens at the right size.
const KEY_WINDOW_SIZE_NORMAL = "windowSizeNormal";
const KEY_WINDOW_SIZE_MINI = "windowSizeMini";
const KEY_WINDOW_LAST_MODE = "windowLastMode";
const KEY_WINDOW_POSITION = "windowPosition";

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
}

interface SearchTrack {
  path: string;
  title: string | null;
  artist: string | null;
  album: string | null;
}

// Discriminated rows shown in the search dropdown: library files (from the
// SQLite metadata cache) and manifest streams (filtered client-side).
type SearchItem =
  | { kind: "file"; track: SearchTrack }
  | { kind: "stream"; stream: Stream };

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
const libraryRootValid = signal(true);
const manifestPathValid = signal(true);

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
// True once the engine has played through the queue's last track. Cleared on
// the next Play (file selection, seek, or restart-from-end via play button).
let queueEnded = false;

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
    setNowPlaying(node.title ?? node.name, node.artist, node.album);
    void loadArt(node.path);
  },
  onTime: (t) => { currentTime.value = t; },
  onDuration: (d) => { duration.value = d; },
  onPlayingChange: (p) => { isPlaying.value = p; },
  onError: (path, message) => {
    console.error("audio: track failed", path, message);
  },
  onQueueEnded: () => {
    queueEnded = true;
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

let nowPlayingTitleEl: HTMLElement;
let nowPlayingTitleInner: HTMLElement;
let nowPlayingArtistEl: HTMLElement;
let nowPlayingArtistInner: HTMLElement;
let nowPlayingAlbumEl: HTMLElement;
let nowPlayingAlbumInner: HTMLElement;
let nowPlayingStreamMetaEl: HTMLElement;
let streamMetaSongEl: HTMLElement;
let streamMetaSongInner: HTMLElement;
let streamMetaArtistEl: HTMLElement;
let streamMetaArtistInner: HTMLElement;
let liveIndicatorEl: HTMLElement;
let nowPlayingArtEl: HTMLImageElement;
let nowPlayingEmptyEl: HTMLElement;
let playPauseBtn: HTMLButtonElement;
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
let settingsBtn: HTMLButtonElement;
let settingsBackBtn: HTMLButtonElement;
let searchInput: HTMLInputElement;
let searchResultsEl: HTMLElement;
let nowPlayingPanel: HTMLElement;
let settingsPanel: HTMLElement;
let splitterEl: HTMLElement;

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

function renderNode(node: TreeNode, parent: TreeNode): HTMLLIElement {
  const li = document.createElement("li");
  const label = document.createElement("span");
  label.className = "node-label";
  if (!node.isFolder) {
    label.dataset.path = node.path;
    if (currentNodePath.value === node.path) {
      label.classList.add("playing");
    }
  }
  const icon = document.createElement("span");
  icon.className = "icon";
  icon.textContent = node.isFolder ? (node.expanded ? "▼" : "▶") : "♪";
  label.appendChild(icon);
  label.appendChild(document.createTextNode(" " + displayLabel(node)));
  label.addEventListener("click", () => onNodeClick(node, parent, li));
  li.appendChild(label);

  if (node.isFolder && node.expanded) {
    const childUl = document.createElement("ul");
    if (node.children.length === 0) {
      const emptyLi = document.createElement("li");
      emptyLi.className = "empty-state";
      emptyLi.textContent = "(empty)";
      childUl.appendChild(emptyLi);
    } else {
      for (const child of node.children) {
        childUl.appendChild(renderNode(child, node));
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

// Reveals a library file in the tree: walks root → file, lazily loading and
// expanding each ancestor folder, re-renders, then scrolls the file's
// directory to the top of the pane. Bails quietly if the path can't be
// located (e.g. file removed, or path scheme doesn't match the tree).
async function revealInTree(path: string): Promise<void> {
  if (!rootNode) return;
  let node: TreeNode = rootNode;
  while (node.path !== path) {
    if (!node.loaded) await fetchChildren(node);
    const child = node.children.find(
      (c) => c.path === path || (c.isFolder && path.startsWith(c.path + "/")),
    );
    if (!child) return;
    if (child.isFolder) child.expanded = true;
    node = child;
  }
  renderTree();
  const label = treeContainer.querySelector<HTMLElement>(
    `.node-label[data-path="${CSS.escape(path)}"]`,
  );
  // The file's <li> sits inside its directory's child <ul>; scroll that
  // directory's <li> into view so the folder header and file are both shown.
  const dirLi = label?.closest("li")?.parentElement?.closest("li");
  (dirLi ?? label)?.scrollIntoView({ block: "start" });
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
    icon.className = "icon";
    icon.textContent = "♪";
    label.appendChild(icon);
    label.appendChild(document.createTextNode(" " + stream.name));
    label.addEventListener("click", () => playStream(stream));
    li.appendChild(label);
    ul.appendChild(li);
  }
  streamsContainer.appendChild(ul);
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

function togglePlayPause(): void {
  if (!hasTrack.value) return;
  // Streams also route through togglePause: the engine implements live-radio
  // semantics natively (pause disconnects, resume rejoins the live edge).
  if (queueEnded && lastQueue.length > 0) {
    // Last track of the queue ran to the end; restart it from the top. Matches
    // the prior UX where hitting play after an album finished resumed the
    // final track.
    queueEnded = false;
    void engine.play(lastQueue, lastIndex);
    return;
  }
  void engine.togglePause();
}

const persistVolume = debounce(async (v: number) => {
  await store.set(KEY_VOLUME, v);
  await store.save();
}, 200);

function setVolume(v: number): void {
  const clamped = Math.max(0, Math.min(1, v));
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

function playFile(node: TreeNode, parent: TreeNode): void {
  currentParent = parent;
  currentNodePath.value = node.path;
  currentStreamUrl.value = null;
  isStream.value = false;
  currentTime.value = 0;
  duration.value = 0;
  queueEnded = false;
  setNowPlaying(node.title ?? node.name, node.artist, node.album);
  void loadArt(node.path);
  // Queue the rest of the album so the engine auto-advances gaplessly. The
  // engine treats this list as the complete queue; clicking another file later
  // replaces it.
  const siblings = parent.children.filter((c) => !c.isFolder);
  const idx = Math.max(
    0,
    siblings.findIndex((c) => c.path === node.path),
  );
  const tracks = siblings.map((c) => c.path);
  lastQueue = tracks;
  lastIndex = idx;
  void engine.play(tracks, idx);
}

function playStream(stream: Stream): void {
  currentParent = null;
  currentNodePath.value = null;
  currentStreamUrl.value = stream.url;
  currentStreamName = stream.name;
  isStream.value = true;
  currentTime.value = 0;
  duration.value = 0;
  queueEnded = false;
  lastQueue = [];
  // Station name until the first ICY title arrives (or forever, for stations
  // that don't send titles).
  setNowPlaying(stream.name, null, null);
  npStreamMeta.value = null;
  void engine.playStream(stream.url);
  clearArt();
}

// Plays a library file picked from the search dropdown. currentParent stays
// null so there's no album auto-advance (a search hit isn't a folder context);
// setting currentNodePath still lights up the row if that folder is expanded in
// the tree. The native engine opens the file directly — no prepare step needed.
function playSearchTrack(t: SearchTrack): void {
  currentParent = null;
  currentNodePath.value = t.path;
  currentStreamUrl.value = null;
  isStream.value = false;
  currentTime.value = 0;
  duration.value = 0;
  queueEnded = false;
  lastQueue = [t.path];
  lastIndex = 0;
  const fallbackName = t.path.split(/[\\/]/).pop() ?? t.path;
  setNowPlaying(t.title ?? fallbackName, t.artist, t.album);
  void loadArt(t.path);
  void engine.play([t.path], 0);
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
  // and album-advance is a no-op (single-track queue).
  currentParent = null;
  currentNodePath.value = null;
  currentStreamUrl.value = null;
  isStream.value = false;
  currentTime.value = 0;
  duration.value = 0;
  queueEnded = false;
  lastQueue = [path];
  lastIndex = 0;
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
  const id = ++artRequestId;
  // Note: we intentionally do NOT clear npArt here. Keeping the previous
  // track's art on screen until the new one is fetched and decoded avoids a
  // black flash on track change — most noticeably between tracks of the same
  // album, where the art is identical and shouldn't visibly change at all.
  let dataUrl: string | null;
  try {
    dataUrl = await invoke<string | null>("get_art", { path });
  } catch (e) {
    console.error("get_art failed for", path, e);
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
    disc: null,
    track: null,
    isFolder: true,
    loaded: true,
    expanded: true,
    children: nodesFromListing(libraryRoot, listing),
  };
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
      const path = currentNodePath.value;
      if (path) {
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
    filters: [{ name: "JSON", extensions: ["json"] }],
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
  const lastMode =
    (await store.get<string>(KEY_WINDOW_LAST_MODE)) === "mini"
      ? "mini"
      : "normal";
  const restore = lastMode === "mini" ? miniSize : normalSize;
  await appWindow.setSize(new LogicalSize(restore.width, restore.height));

  // Persist the current logical size under the active mode's key. Reading
  // window.inner* (rather than the resize event's physical payload) keeps
  // storage in logical px, so restored sizes stay stable across scale factors.
  const persistSize = debounce(async () => {
    const width = window.innerWidth;
    const height = window.innerHeight;
    if (width <= 0 || height <= 0) return;
    const mode = isMiniViewport() ? "mini" : "normal";
    if (mode === "mini") {
      miniSize = { width, height };
      await store.set(KEY_WINDOW_SIZE_MINI, miniSize);
    } else {
      normalSize = { width, height };
      await store.set(KEY_WINDOW_SIZE_NORMAL, normalSize);
    }
    await store.set(KEY_WINDOW_LAST_MODE, mode);
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
  settingsBtn.addEventListener("click", () => { settingsOpen.value = true; });
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
    if (item.kind === "file") {
      activeTab.value = "files";
      playSearchTrack(item.track);
      void revealInTree(item.track.path);
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
      if (item.kind === "file") {
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
    let fileItems: SearchItem[] = [];
    try {
      const tracks = await invoke<SearchTrack[]>("search_tracks", { query });
      fileItems = tracks.map((t) => ({ kind: "file", track: t }));
    } catch (e) {
      console.error("search_tracks failed", e);
    }
    if (token !== queryToken) return;
    items = [...streamItems, ...fileItems];
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

  // Swallow mousedown inside the widget so it never reaches the document-level
  // drag-region handler (which would otherwise start a window drag) or the
  // outside-click closer below.
  searchBox.addEventListener("mousedown", (e) => e.stopPropagation());

  // Any mousedown that escapes the widget closes the dropdown.
  document.addEventListener("mousedown", () => close());
}

function setupPlayerControls(): void {
  playPauseBtn.addEventListener("click", togglePlayPause);

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
    volumePopoverOpen.value = !volumePopoverOpen.value;
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
    playPauseBtn.disabled = !hasTrack.value;
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

  effect(() => {
    const open = settingsOpen.value;
    settingsPanel.classList.toggle("hidden", !open);
    nowPlayingPanel.classList.toggle("hidden", open);
    settingsBtn.classList.toggle("hidden", open);
    settingsBackBtn.classList.toggle("hidden", !open);
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
  // Recompute the title/artist marquees on every resize (width change or a
  // mode switch across the breakpoint both change whether the lines overflow).
  window.addEventListener("resize", updateMarquees);
  // Mini-only expand button (shown where the settings icon sits in full view).
  const expandBtn = document.querySelector("#expand-btn") as HTMLButtonElement;
  expandBtn.addEventListener("click", () => void toggleMiniPlayer());

  nowPlayingTitleEl = document.querySelector("#now-playing-title") as HTMLElement;
  nowPlayingTitleInner = nowPlayingTitleEl.querySelector(".marquee-inner") as HTMLElement;
  nowPlayingArtistEl = document.querySelector("#now-playing-artist") as HTMLElement;
  nowPlayingArtistInner = nowPlayingArtistEl.querySelector(".marquee-inner") as HTMLElement;
  nowPlayingAlbumEl = document.querySelector("#now-playing-album") as HTMLElement;
  nowPlayingAlbumInner = nowPlayingAlbumEl.querySelector(".marquee-inner") as HTMLElement;
  nowPlayingStreamMetaEl = document.querySelector("#now-playing-stream-meta") as HTMLElement;
  streamMetaSongEl = document.querySelector("#stream-meta-song") as HTMLElement;
  streamMetaSongInner = streamMetaSongEl.querySelector(".marquee-inner") as HTMLElement;
  streamMetaArtistEl = document.querySelector("#stream-meta-artist") as HTMLElement;
  streamMetaArtistInner = streamMetaArtistEl.querySelector(".marquee-inner") as HTMLElement;
  liveIndicatorEl = document.querySelector("#live-indicator") as HTMLElement;
  nowPlayingArtEl = document.querySelector("#now-playing-art") as HTMLImageElement;
  nowPlayingEmptyEl = document.querySelector("#now-playing-empty") as HTMLElement;
  playPauseBtn = document.querySelector("#play-pause-btn") as HTMLButtonElement;
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
  settingsBtn = document.querySelector("#settings-btn") as HTMLButtonElement;
  settingsBackBtn = document.querySelector("#settings-back-btn") as HTMLButtonElement;
  searchInput = document.querySelector("#search-input") as HTMLInputElement;
  searchResultsEl = document.querySelector("#search-results") as HTMLElement;
  nowPlayingPanel = document.querySelector("#now-playing-panel") as HTMLElement;
  settingsPanel = document.querySelector("#settings-panel") as HTMLElement;
  splitterEl = document.querySelector("#splitter") as HTMLElement;

  store = await load(STORE_FILE, { defaults: {}, autoSave: false });

  const libraryRoot = (await store.get<string>(KEY_LIBRARY_ROOT)) ?? "";
  const manifestPath = (await store.get<string>(KEY_MANIFEST_PATH)) ?? "";
  const splitterWidth = (await store.get<string>(KEY_SPLITTER_WIDTH)) ?? null;
  const storedVolume = await store.get<number>(KEY_VOLUME);
  volume.value = typeof storedVolume === "number" ? Math.max(0, Math.min(1, storedVolume)) : 1;

  setupTabs();
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
