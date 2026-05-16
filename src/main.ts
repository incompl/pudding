import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { load, type Store } from "@tauri-apps/plugin-store";

const STORE_FILE = "settings.json";
const KEY_LIBRARY_ROOT = "libraryRoot";
const KEY_MANIFEST_PATH = "manifestPath";
const KEY_SPLITTER_WIDTH = "splitterWidth";

interface DirListing {
  folders: string[];
  files: string[];
}

interface TreeNode {
  path: string;
  name: string;
  isFolder: boolean;
  loaded: boolean;
  expanded: boolean;
  children: TreeNode[];
}

interface Stream {
  name: string;
  url: string;
}

let store: Store;
let rootNode: TreeNode | null = null;
let audioEl: HTMLAudioElement;
let nowPlayingNameEl: HTMLElement;
let treeContainer: HTMLElement;
let streamsContainer: HTMLElement;
let libraryRootInput: HTMLInputElement;
let manifestPathInput: HTMLInputElement;
let settingsBtn: HTMLButtonElement;
let settingsBackBtn: HTMLButtonElement;
let nowPlayingPanel: HTMLElement;
let settingsPanel: HTMLElement;
let splitterEl: HTMLElement;
let sourceListeners: AbortController | null = null;

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
      ...listing.folders.map((name) => ({
        path: joinPath(node.path, name),
        name,
        isFolder: true,
        loaded: false,
        expanded: false,
        children: [],
      })),
      ...listing.files.map((name) => ({
        path: joinPath(node.path, name),
        name,
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

function renderNode(node: TreeNode): HTMLLIElement {
  const li = document.createElement("li");
  const label = document.createElement("span");
  const icon = document.createElement("span");
  icon.className = "icon";
  icon.textContent = node.isFolder ? (node.expanded ? "▼" : "▶") : "♪";
  label.appendChild(icon);
  label.appendChild(document.createTextNode(" " + node.name));
  label.style.cursor = "pointer";
  label.addEventListener("click", () => onNodeClick(node, li));
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
        childUl.appendChild(renderNode(child));
      }
    }
    li.appendChild(childUl);
  }
  return li;
}

async function onNodeClick(node: TreeNode, li: HTMLLIElement): Promise<void> {
  if (node.isFolder) {
    if (!node.loaded) await loadChildren(node, li);
    node.expanded = !node.expanded;
    li.replaceWith(renderNode(node));
  } else {
    playFile(node);
  }
}

function setSource(name: string, src: string, isStream: boolean): void {
  sourceListeners?.abort();
  audioEl.pause();
  audioEl.removeAttribute("src");
  audioEl.load();

  sourceListeners = new AbortController();
  const { signal } = sourceListeners;

  nowPlayingNameEl.textContent = name;
  audioEl.src = src;

  if (isStream) {
    audioEl.addEventListener(
      "loadedmetadata",
      () => {
        if (!isFinite(audioEl.duration)) return;
        const ranges = audioEl.seekable;
        if (ranges.length > 0) {
          audioEl.currentTime = Math.max(0, ranges.end(ranges.length - 1) - 5);
        }
      },
      { once: true, signal },
    );
  }

  void audioEl.play();
}

function playFile(node: TreeNode): void {
  setSource(node.name, convertFileSrc(node.path), false);
}

function playStream(stream: Stream): void {
  setSource(stream.name, stream.url, true);
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
    const icon = document.createElement("span");
    icon.className = "icon";
    icon.textContent = "♪";
    label.appendChild(icon);
    label.appendChild(document.createTextNode(" " + stream.name));
    label.style.cursor = "pointer";
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
    ul.appendChild(renderNode(child));
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
    isFolder: true,
    loaded: true,
    expanded: true,
    children: [
      ...listing.folders.map((name) => ({
        path: joinPath(libraryRoot, name),
        name,
        isFolder: true,
        loaded: false,
        expanded: false,
        children: [],
      })),
      ...listing.files.map((name) => ({
        path: joinPath(libraryRoot, name),
        name,
        isFolder: false,
        loaded: true,
        expanded: false,
        children: [],
      })),
    ],
  };
  renderTree();
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
  audioEl = document.querySelector("#audio") as HTMLAudioElement;
  nowPlayingNameEl = document.querySelector("#now-playing-name") as HTMLElement;
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

  setupTabs();
  setupSplitter(splitterWidth);
  setupSettings();

  libraryRootInput.value = libraryRoot;
  manifestPathInput.value = manifestPath;

  libraryRootInput.addEventListener("input", debounce(onLibraryRootChange, 400));
  manifestPathInput.addEventListener("input", debounce(onManifestPathChange, 400));

  await refreshTree(libraryRoot);
  await refreshStreams(manifestPath);
}

window.addEventListener("DOMContentLoaded", init);
