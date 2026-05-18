import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { load, type Store } from "@tauri-apps/plugin-store";
import { open } from "@tauri-apps/plugin-dialog";
import { signal, effect } from "@preact/signals-core";
import { GaplessEngine } from "./audio-engine";

const STORE_FILE = "settings.json";
const KEY_LIBRARY_ROOT = "libraryRoot";
const KEY_MANIFEST_PATH = "manifestPath";
const KEY_SPLITTER_WIDTH = "splitterWidth";
const KEY_VOLUME = "volume";

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
  disc: number | null;
  track: number | null;
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

const isStream = signal(false);
const isPlaying = signal(false);
const canPlay = signal(false);
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

function compareChildren(a: TreeNode, b: TreeNode): number {
  if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
  if (a.isFolder) {
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  }
  const ad = a.disc ?? 1;
  const bd = b.disc ?? 1;
  if (ad !== bd) return ad - bd;
  const at = a.track ?? Number.MAX_SAFE_INTEGER;
  const bt = b.track ?? Number.MAX_SAFE_INTEGER;
  if (at !== bt) return at - bt;
  return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
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
// <audio> element used only for radio streams and for the rare codec-fallback
// path (a file the WebView's decodeAudioData cannot decode). All normal file
// playback goes through the gapless Web Audio engine.
let streamEl: HTMLAudioElement;
// True while a file is playing through `streamEl` because Web Audio could not
// decode it (non-gapless for that one file).
let elementFallback = false;
let currentNode: TreeNode | null = null;
let currentParent: TreeNode | null = null;
let artRequestId = 0;

// Library-file lookups for the engine (which speaks paths only). Auto-advance
// stays within the current album folder, so currentParent's children are the
// universe; external/streamed playback has no parent and never advances.
function siblingByPath(path: string): TreeNode | null {
  if (!currentParent) return null;
  return (
    currentParent.children.find((c) => !c.isFolder && c.path === path) ?? null
  );
}

function nextSiblingPath(path: string): string | null {
  if (!currentParent) return null;
  const siblings = currentParent.children.filter((c) => !c.isFolder);
  const idx = siblings.findIndex((c) => c.path === path);
  if (idx < 0 || idx + 1 >= siblings.length) return null;
  return siblings[idx + 1].path;
}

const engine = new GaplessEngine({
  getNextPath: (path) => nextSiblingPath(path),
  onAdvance: (path) => {
    // currentParent stays the album folder across an album.
    const node = siblingByPath(path);
    if (!node) return;
    currentNode = node;
    currentNodePath.value = node.path;
    currentStreamUrl.value = null;
    setNowPlaying(node.title ?? node.name, node.artist, node.album);
    void loadArt(node.path);
  },
  onTime: (t) => { currentTime.value = t; },
  onDuration: (d) => { duration.value = d; },
  onPlayingChange: (p) => { isPlaying.value = p; },
  onUnsupported: (path) => { fallbackToElement(path); },
});

let nowPlayingTitleEl: HTMLElement;
let nowPlayingArtistEl: HTMLElement;
let nowPlayingAlbumEl: HTMLElement;
let nowPlayingSubtitleEl: HTMLElement;
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
let nowPlayingPanel: HTMLElement;
let settingsPanel: HTMLElement;
let splitterEl: HTMLElement;

// --- Tree ---

async function loadChildren(node: TreeNode, li: HTMLLIElement): Promise<void> {
  if (node.loaded || !node.isFolder) return;
  const loadingLi = document.createElement("li");
  loadingLi.className = "loading-state";
  loadingLi.textContent = "Loading…";
  const childUl = document.createElement("ul");
  childUl.appendChild(loadingLi);
  li.appendChild(childUl);

  try {
    const listing = await invoke<DirListing>("list_dir", { path: node.path });
    node.children = [
      ...listing.folders.map<TreeNode>((name) => ({
        path: joinPath(node.path, name),
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
      })),
      ...listing.files.map<TreeNode>((f) => ({
        path: joinPath(node.path, f.name),
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
    node.loaded = true;
  } catch (e) {
    console.error("list_dir failed for", node.path, e);
    node.loaded = true;
    node.children = [];
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
  canPlay.value = true;
}

function togglePlayPause(): void {
  if (!canPlay.value) return;
  if (isStream.value || elementFallback) {
    if (streamEl.paused) void streamEl.play();
    else streamEl.pause();
  } else {
    engine.togglePause();
  }
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
  if (elementFallback) {
    const dur = streamEl.duration;
    if (!isFinite(dur) || dur <= 0) return;
    streamEl.currentTime = Math.max(0, Math.min(dur, streamEl.currentTime + seconds));
    return;
  }
  engine.seekBy(seconds);
}

function seekTo(seconds: number): void {
  if (isStream.value) return;
  if (elementFallback) {
    streamEl.currentTime = seconds;
    return;
  }
  engine.seekTo(seconds);
}

function playFile(node: TreeNode, parent: TreeNode): void {
  streamEl.pause();
  elementFallback = false;
  currentNode = node;
  currentParent = parent;
  currentNodePath.value = node.path;
  currentStreamUrl.value = null;
  isStream.value = false;
  currentTime.value = 0;
  duration.value = 0;
  setNowPlaying(node.title ?? node.name, node.artist, node.album);
  void loadArt(node.path);
  void engine.play(node.path);
}

// Fallback when the engine cannot play a file (codec the WebView can't decode,
// oversize PCM, or fetch failure). Plays the single file through the <audio>
// element — not gapless, but it plays. If the file is a library track, the
// element's `ended` handler advances to the next sibling (back through the
// gapless engine); for an external file there is no successor.
function fallbackToElement(path: string): void {
  engine.stop();
  elementFallback = true;
  isStream.value = false;
  currentTime.value = 0;
  duration.value = 0;
  const node = siblingByPath(path);
  if (node) {
    // Library track: take over the now-playing UI and row highlight.
    currentNode = node;
    currentNodePath.value = node.path;
    currentStreamUrl.value = null;
    setNowPlaying(node.title ?? node.name, node.artist, node.album);
    void loadArt(node.path);
  }
  // Otherwise (external file) now-playing was already set by the caller and
  // currentNode stays null so the tree is untouched.
  streamEl.src = convertFileSrc(path);
  void streamEl.play();
}

function playStream(stream: Stream): void {
  engine.stop();
  elementFallback = false;
  currentNode = null;
  currentParent = null;
  currentNodePath.value = null;
  currentStreamUrl.value = stream.url;
  isStream.value = true;
  currentTime.value = 0;
  duration.value = 0;
  setNowPlaying(stream.name, null, null);
  streamEl.src = stream.url;
  void streamEl.play();
  clearArt();
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
  streamEl.pause();
  elementFallback = false;
  // Leaves currentNode/currentParent null so the tree is untouched, no row is
  // highlighted, and album-advance is a no-op (engine.getNext returns null).
  currentNode = null;
  currentParent = null;
  currentNodePath.value = null;
  currentStreamUrl.value = null;
  isStream.value = false;
  currentTime.value = 0;
  duration.value = 0;
  const fallback = path.split(/[\\/]/).pop() ?? path;
  setNowPlaying(meta.title ?? fallback, meta.artist, meta.album);
  void loadArt(path);
  void engine.play(path);
}

function clearArt(): void {
  artRequestId++;
  npArt.value = null;
}

async function loadArt(path: string): Promise<void> {
  const id = ++artRequestId;
  npArt.value = null;
  let dataUrl: string | null;
  try {
    dataUrl = await invoke<string | null>("get_art", { path });
  } catch (e) {
    console.error("get_art failed for", path, e);
    return;
  }
  if (id !== artRequestId) return;
  npArt.value = dataUrl;
}

// Advance after a codec-fallback file finishes on the <audio> element. The
// gapless engine handles advancement for all normally-decoded files itself.
function advanceAfterFallback(): void {
  if (!currentNode || !currentParent) return;
  const nextPath = nextSiblingPath(currentNode.path);
  if (!nextPath) return;
  const next = siblingByPath(nextPath);
  if (next) playFile(next, currentParent);
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
    children: [
      ...listing.folders.map<TreeNode>((name) => ({
        path: joinPath(libraryRoot, name),
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
      })),
      ...listing.files.map<TreeNode>((f) => ({
        path: joinPath(libraryRoot, f.name),
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
    ],
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

  const next: TreeNode[] = [
    ...listing.folders.map<TreeNode>(
      (name) =>
        oldFolders.get(name) ?? {
          path: joinPath(node.path, name),
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
      path: joinPath(node.path, f.name),
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
  next.sort(compareChildren);
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
      // reconcile rebuilds node objects, so the currentNode/currentParent
      // captured at play time now point outside the tree. Re-bind them by path
      // so the playing-row highlight and album auto-advance keep working. If
      // the playing file was deleted, leave the stale references — playback
      // continues and the next selection replaces them.
      const path = currentNodePath.value;
      if (path) {
        const found = findNode(rootNode, path);
        if (found) {
          currentNode = found.node;
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
    manifestPathValid.value = true;
    setEmpty(streamsContainer, "No manifest path set");
    return;
  }
  setEmpty(streamsContainer, "Loading…", "loading");
  try {
    const streams = await invoke<Stream[]>("read_manifest", { path: manifestPath });
    manifestPathValid.value = true;
    renderStreams(streams);
  } catch (e) {
    console.error("read_manifest failed for", manifestPath, e);
    manifestPathValid.value = false;
    setEmpty(streamsContainer, "Invalid manifest path");
  }
}

async function setLibraryRoot(value: string): Promise<void> {
  libraryRootInput.value = value;
  await store.set(KEY_LIBRARY_ROOT, value);
  await store.save();
  if (value) {
    try {
      await invoke("set_asset_scope", { path: value });
    } catch (e) {
      console.error("set_asset_scope failed", e);
    }
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

function setupSettings(): void {
  settingsBtn.addEventListener("click", () => { settingsOpen.value = true; });
  settingsBackBtn.addEventListener("click", () => { settingsOpen.value = false; });
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

  // streamEl handles radio streams and the codec-fallback file path only;
  // these listeners are no-ops while the gapless engine is driving playback
  // (the engine reports isPlaying/time/duration via its callbacks).
  streamEl.addEventListener("play", () => {
    if (isStream.value || elementFallback) isPlaying.value = true;
  });
  streamEl.addEventListener("pause", () => {
    if (isStream.value || elementFallback) isPlaying.value = false;
  });
  streamEl.addEventListener("ended", () => {
    if (elementFallback) advanceAfterFallback();
  });

  streamEl.addEventListener("loadedmetadata", () => {
    if (!elementFallback || !isFinite(streamEl.duration)) return;
    duration.value = streamEl.duration;
  });

  streamEl.addEventListener("timeupdate", () => {
    if (!elementFallback) return;
    currentTime.value = streamEl.currentTime;
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

function setupEffects(): void {
  effect(() => {
    nowPlayingEmptyEl.classList.toggle("hidden", hasTrack.value);
  });
  effect(() => {
    nowPlayingTitleEl.textContent = npTitle.value;
  });
  effect(() => {
    nowPlayingArtistEl.textContent = npArtist.value ?? "";
    nowPlayingArtistEl.classList.toggle("hidden", !npArtist.value);
  });
  effect(() => {
    nowPlayingAlbumEl.textContent = npAlbum.value ?? "";
    nowPlayingAlbumEl.classList.toggle("hidden", !npAlbum.value);
  });
  effect(() => {
    nowPlayingSubtitleEl.classList.toggle("hidden", !isStream.value);
    nowPlayingSubtitleEl.classList.toggle("paused", !isPlaying.value);
  });
  effect(() => {
    const url = npArt.value;
    if (url) {
      nowPlayingArtEl.src = url;
      nowPlayingArtEl.classList.remove("hidden");
    } else {
      nowPlayingArtEl.removeAttribute("src");
      nowPlayingArtEl.classList.add("hidden");
    }
  });

  effect(() => {
    playPauseBtn.textContent = isPlaying.value ? "⏸" : "▶";
    playPauseBtn.setAttribute("aria-label", isPlaying.value ? "Pause" : "Play");
  });
  effect(() => {
    playPauseBtn.disabled = !canPlay.value;
  });
  effect(() => {
    seekBar.disabled = isStream.value;
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
    engine.setVolume(v);
    streamEl.volume = v;
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

  streamEl = new Audio();
  nowPlayingTitleEl = document.querySelector("#now-playing-title") as HTMLElement;
  nowPlayingArtistEl = document.querySelector("#now-playing-artist") as HTMLElement;
  nowPlayingAlbumEl = document.querySelector("#now-playing-album") as HTMLElement;
  nowPlayingSubtitleEl = document.querySelector("#now-playing-subtitle") as HTMLElement;
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
  setupSplitter(splitterWidth);
  setupSettings();
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
