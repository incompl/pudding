import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { load, type Store } from "@tauri-apps/plugin-store";
import { open } from "@tauri-apps/plugin-dialog";
import { signal, effect } from "@preact/signals-core";

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
let audioEl: HTMLAudioElement;
let currentNode: TreeNode | null = null;
let currentParent: TreeNode | null = null;
let artRequestId = 0;

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

function setSource(
  title: string,
  artist: string | null,
  album: string | null,
  src: string,
  stream: boolean,
): void {
  audioEl.pause();
  audioEl.removeAttribute("src");
  audioEl.load();

  hasTrack.value = true;
  npTitle.value = title;
  npArtist.value = artist;
  npAlbum.value = album;
  isStream.value = stream;
  canPlay.value = true;
  currentTime.value = 0;
  duration.value = 0;

  audioEl.src = src;
  void audioEl.play();
}

function togglePlayPause(): void {
  if (!canPlay.value) return;
  if (audioEl.paused) {
    void audioEl.play();
  } else {
    audioEl.pause();
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
  const dur = audioEl.duration;
  if (!isFinite(dur) || dur <= 0) return;
  audioEl.currentTime = Math.max(0, Math.min(dur, audioEl.currentTime + seconds));
}

function playFile(node: TreeNode, parent: TreeNode): void {
  currentNode = node;
  currentParent = parent;
  currentNodePath.value = node.path;
  currentStreamUrl.value = null;
  setSource(node.title ?? node.name, node.artist, node.album, convertFileSrc(node.path), false);
  void loadArt(node.path);
}

function playStream(stream: Stream): void {
  currentNode = null;
  currentParent = null;
  currentNodePath.value = null;
  currentStreamUrl.value = stream.url;
  setSource(stream.name, null, null, stream.url, true);
  clearArt();
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

function playNextInAlbum(): void {
  if (isStream.value || !currentNode || !currentParent) return;
  const siblings = currentParent.children.filter((c) => !c.isFolder);
  const idx = siblings.findIndex((c) => c.path === currentNode!.path);
  if (idx < 0 || idx + 1 >= siblings.length) return;
  playFile(siblings[idx + 1], currentParent);
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

function collectFilePaths(node: TreeNode, out: string[]): void {
  if (!node.isFolder) {
    out.push(node.path);
    return;
  }
  if (!node.loaded) return;
  for (const child of node.children) collectFilePaths(child, out);
}

function applyMetadata(node: TreeNode, byPath: Map<string, TrackMeta>): void {
  if (node.isFolder) {
    for (const child of node.children) applyMetadata(child, byPath);
    node.children.sort(compareChildren);
    return;
  }
  const m = byPath.get(node.path);
  if (m) {
    node.title = m.title;
    node.artist = m.artist;
    node.album = m.album;
    node.disc = m.disc;
    node.track = m.track;
  }
}

async function refreshMetadata(): Promise<void> {
  if (!rootNode) return;
  const paths: string[] = [];
  collectFilePaths(rootNode, paths);
  if (paths.length === 0) return;
  let metas: TrackMeta[];
  try {
    metas = await invoke<TrackMeta[]>("get_metadata", { paths });
  } catch (e) {
    console.error("get_metadata failed", e);
    return;
  }
  const byPath = new Map<string, TrackMeta>();
  for (let i = 0; i < paths.length; i++) byPath.set(paths[i], metas[i]);
  applyMetadata(rootNode, byPath);
  const filesTab = document.getElementById("tab-files");
  const scrollTop = filesTab?.scrollTop ?? 0;
  renderTree();
  if (filesTab) filesTab.scrollTop = scrollTop;
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
    audioEl.currentTime = Number(seekBar.value);
  });

  audioEl.addEventListener("play", () => { isPlaying.value = true; });
  audioEl.addEventListener("pause", () => { isPlaying.value = false; });
  audioEl.addEventListener("ended", playNextInAlbum);

  audioEl.addEventListener("loadedmetadata", () => {
    if (isStream.value || !isFinite(audioEl.duration)) return;
    duration.value = audioEl.duration;
  });

  audioEl.addEventListener("timeupdate", () => {
    if (isStream.value) return;
    currentTime.value = audioEl.currentTime;
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
    audioEl.volume = v;
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

  audioEl = new Audio();
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
    void refreshMetadata();
  });

  await refreshTree(libraryRoot);
  await refreshStreams(manifestPath);

  if (libraryRoot) {
    void invoke("rescan_library", { path: libraryRoot });
  }
}

window.addEventListener("DOMContentLoaded", init);
