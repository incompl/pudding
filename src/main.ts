import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { load, type Store } from "@tauri-apps/plugin-store";

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

interface Stream {
  name: string;
  url: string;
}

interface ScanResult {
  ok: boolean;
  error: string | null;
}

let store: Store;
let rootNode: TreeNode | null = null;
let audioEl: HTMLAudioElement;
let nowPlayingTitleEl: HTMLElement;
let nowPlayingArtistEl: HTMLElement;
let nowPlayingAlbumEl: HTMLElement;
let nowPlayingSubtitleEl: HTMLElement;
let nowPlayingArtEl: HTMLImageElement;
let artRequestId = 0;
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
let manifestPathInput: HTMLInputElement;
let settingsBtn: HTMLButtonElement;
let settingsBackBtn: HTMLButtonElement;
let nowPlayingPanel: HTMLElement;
let settingsPanel: HTMLElement;
let splitterEl: HTMLElement;
let currentIsStream = false;
let currentNode: TreeNode | null = null;
let currentParent: TreeNode | null = null;
let currentStreamUrl: string | null = null;

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

function setEmpty(container: HTMLElement, message: string, kind: "empty" | "loading" = "empty"): void {
  container.innerHTML = "";
  const div = document.createElement("div");
  div.className = kind === "loading" ? "loading-state" : "empty-state";
  div.textContent = message;
  container.appendChild(div);
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
    if (currentNode && currentNode.path === node.path) {
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

function formatTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) seconds = 0;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function updateSeekProgress(): void {
  const max = Number(seekBar.max);
  const pct = max > 0 ? (Number(seekBar.value) / max) * 100 : 0;
  seekBar.style.setProperty("--progress", `${pct}%`);
}

function updateVolumeProgress(): void {
  const v = Number(volumeBar.value);
  volumeBar.style.setProperty("--progress", `${v * 100}%`);
  const waves = volumeBtn.querySelectorAll<SVGPathElement>(".volume-wave");
  waves.forEach((w, i) => {
    w.style.opacity = String(i === 0 ? v : v >= 1 ? 1 : 0);
  });
}

function resetControls(): void {
  seekBar.value = "0";
  seekBar.max = "0";
  timeCurrentEl.textContent = "0:00";
  timeRemainingEl.textContent = "-0:00";
  updateSeekProgress();
}

function setSource(
  title: string,
  artist: string | null,
  album: string | null,
  src: string,
  isStream: boolean,
): void {
  audioEl.pause();
  audioEl.removeAttribute("src");
  audioEl.load();

  currentIsStream = isStream;
  nowPlayingTitleEl.textContent = title;
  nowPlayingArtistEl.textContent = artist ?? "";
  nowPlayingArtistEl.classList.toggle("hidden", !artist);
  nowPlayingAlbumEl.textContent = album ?? "";
  nowPlayingAlbumEl.classList.toggle("hidden", !album);
  nowPlayingSubtitleEl.classList.toggle("hidden", !isStream);
  playPauseBtn.disabled = false;
  seekBar.disabled = isStream;
  resetControls();
  if (isStream) {
    timeCurrentEl.classList.add("hidden");
    timeRemainingEl.classList.add("hidden");
  } else {
    timeCurrentEl.classList.remove("hidden");
    timeRemainingEl.classList.remove("hidden");
  }

  audioEl.src = src;
  void audioEl.play();
}

function updatePlayButton(): void {
  const playing = !audioEl.paused;
  playPauseBtn.textContent = playing ? "⏸" : "▶";
  playPauseBtn.setAttribute("aria-label", playing ? "Pause" : "Play");
}

function togglePlayPause(): void {
  if (playPauseBtn.disabled) return;
  if (audioEl.paused) {
    void audioEl.play();
  } else {
    audioEl.pause();
  }
}

function setVolumePopoverOpen(open: boolean): void {
  volumePopover.classList.toggle("open", open);
}

function setupVolumeControl(initialVolume: number): void {
  volumeBar.value = String(initialVolume);
  audioEl.volume = initialVolume;
  updateVolumeProgress();

  const persistVolume = debounce(async (v: number) => {
    await store.set(KEY_VOLUME, v);
    await store.save();
  }, 200);

  volumeBtn.addEventListener("click", () => {
    setVolumePopoverOpen(!volumePopover.classList.contains("open"));
  });

  volumeControlEl.addEventListener("mouseleave", () => {
    setVolumePopoverOpen(false);
  });

  volumeBar.addEventListener("input", () => {
    const v = Number(volumeBar.value);
    audioEl.volume = v;
    updateVolumeProgress();
    persistVolume(v);
  });
}

function setupPlayerControls(): void {
  playPauseBtn.addEventListener("click", togglePlayPause);

  document.addEventListener("keydown", (e) => {
    if (e.key !== " " && e.code !== "Space") return;
    if (e.repeat) return;
    const target = e.target as HTMLElement | null;
    if (target) {
      if (target.tagName === "TEXTAREA" || target.isContentEditable) return;
      if (target instanceof HTMLInputElement) {
        const type = target.type.toLowerCase();
        const textLike = type === "text" || type === "search" || type === "url" ||
          type === "email" || type === "password" || type === "tel" || type === "number";
        if (textLike) return;
      }
    }
    e.preventDefault();
    togglePlayPause();
  });

  seekBar.addEventListener("input", () => {
    audioEl.currentTime = Number(seekBar.value);
    updateSeekProgress();
  });

  audioEl.addEventListener("play", updatePlayButton);
  audioEl.addEventListener("pause", updatePlayButton);
  audioEl.addEventListener("ended", playNextInAlbum);

  audioEl.addEventListener("loadedmetadata", () => {
    if (currentIsStream || !isFinite(audioEl.duration)) return;
    seekBar.max = String(audioEl.duration);
    timeRemainingEl.textContent = "-" + formatTime(audioEl.duration);
  });

  audioEl.addEventListener("timeupdate", () => {
    if (currentIsStream) return;
    seekBar.value = String(audioEl.currentTime);
    updateSeekProgress();
    timeCurrentEl.textContent = formatTime(audioEl.currentTime);
    if (isFinite(audioEl.duration)) {
      timeRemainingEl.textContent = "-" + formatTime(audioEl.duration - audioEl.currentTime);
    }
  });
}

function playFile(node: TreeNode, parent: TreeNode): void {
  currentNode = node;
  currentParent = parent;
  currentStreamUrl = null;
  setSource(node.title ?? node.name, node.artist, node.album, convertFileSrc(node.path), false);
  updatePlayingHighlight();
  void loadArt(node.path);
}

function playStream(stream: Stream): void {
  currentNode = null;
  currentParent = null;
  currentStreamUrl = stream.url;
  setSource(stream.name, null, null, stream.url, true);
  updatePlayingHighlight();
  clearArt();
}

function clearArt(): void {
  artRequestId++;
  nowPlayingArtEl.removeAttribute("src");
  nowPlayingArtEl.classList.add("hidden");
}

async function loadArt(path: string): Promise<void> {
  const id = ++artRequestId;
  nowPlayingArtEl.removeAttribute("src");
  nowPlayingArtEl.classList.add("hidden");
  let dataUrl: string | null;
  try {
    dataUrl = await invoke<string | null>("get_art", { path });
  } catch (e) {
    console.error("get_art failed for", path, e);
    return;
  }
  if (id !== artRequestId) return;
  if (!dataUrl) return;
  nowPlayingArtEl.src = dataUrl;
  nowPlayingArtEl.classList.remove("hidden");
}

function updatePlayingHighlight(): void {
  document
    .querySelectorAll("#folder-tree .node-label.playing, #streams-list .node-label.playing")
    .forEach((el) => el.classList.remove("playing"));
  if (currentNode) {
    const el = document.querySelector(
      `#folder-tree .node-label[data-path="${CSS.escape(currentNode.path)}"]`,
    );
    el?.classList.add("playing");
  } else if (currentStreamUrl) {
    const el = document.querySelector(
      `#streams-list .node-label[data-stream-url="${CSS.escape(currentStreamUrl)}"]`,
    );
    el?.classList.add("playing");
  }
}

function playNextInAlbum(): void {
  if (currentIsStream || !currentNode || !currentParent) return;
  const siblings = currentParent.children.filter((c) => !c.isFolder);
  const idx = siblings.findIndex((c) => c.path === currentNode!.path);
  if (idx < 0 || idx + 1 >= siblings.length) return;
  playFile(siblings[idx + 1], currentParent);
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
    if (currentStreamUrl === stream.url) {
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

async function refreshTree(libraryRoot: string): Promise<void> {
  rootNode = null;
  if (!libraryRoot) {
    libraryRootInput.classList.remove("invalid");
    setEmpty(treeContainer, "No library root set");
    return;
  }
  setEmpty(treeContainer, "Loading…", "loading");
  let listing: DirListing;
  try {
    listing = await invoke<DirListing>("list_dir", { path: libraryRoot });
  } catch (e) {
    console.error("list_dir failed for", libraryRoot, e);
    libraryRootInput.classList.add("invalid");
    setEmpty(treeContainer, "Invalid library root");
    return;
  }
  libraryRootInput.classList.remove("invalid");
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
    manifestPathInput.classList.remove("invalid");
    setEmpty(streamsContainer, "No manifest path set");
    return;
  }
  setEmpty(streamsContainer, "Loading…", "loading");
  try {
    const streams = await invoke<Stream[]>("read_manifest", { path: manifestPath });
    manifestPathInput.classList.remove("invalid");
    renderStreams(streams);
  } catch (e) {
    console.error("read_manifest failed for", manifestPath, e);
    manifestPathInput.classList.add("invalid");
    setEmpty(streamsContainer, "Invalid manifest path");
  }
}

async function onLibraryRootChange(): Promise<void> {
  const value = libraryRootInput.value.trim();
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

async function onManifestPathChange(): Promise<void> {
  const value = manifestPathInput.value.trim();
  await store.set(KEY_MANIFEST_PATH, value);
  await store.save();
  await refreshStreams(value);
}

function setupTabs(): void {
  const tabs = document.querySelectorAll<HTMLButtonElement>(".tab");
  const panels = {
    files: document.getElementById("tab-files") as HTMLElement,
    streams: document.getElementById("tab-streams") as HTMLElement,
  };
  for (const btn of tabs) {
    btn.addEventListener("click", () => {
      const target = btn.dataset.tab as "files" | "streams";
      for (const t of tabs) t.classList.toggle("active", t === btn);
      panels.files.classList.toggle("hidden", target !== "files");
      panels.streams.classList.toggle("hidden", target !== "streams");
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

function setSettingsOpen(open: boolean): void {
  settingsPanel.classList.toggle("hidden", !open);
  nowPlayingPanel.classList.toggle("hidden", open);
  settingsBtn.classList.toggle("hidden", open);
  settingsBackBtn.classList.toggle("hidden", !open);
}

function setupSettings(): void {
  settingsBtn.addEventListener("click", () => setSettingsOpen(true));
  settingsBackBtn.addEventListener("click", () => setSettingsOpen(false));
}

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
  manifestPathInput = document.querySelector("#manifest-path") as HTMLInputElement;
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
  const volume = typeof storedVolume === "number" ? Math.max(0, Math.min(1, storedVolume)) : 1;

  setupTabs();
  setupSplitter(splitterWidth);
  setupSettings();
  setupPlayerControls();
  setupVolumeControl(volume);

  libraryRootInput.value = libraryRoot;
  manifestPathInput.value = manifestPath;

  libraryRootInput.addEventListener("input", debounce(onLibraryRootChange, 400));
  manifestPathInput.addEventListener("input", debounce(onManifestPathChange, 400));

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
