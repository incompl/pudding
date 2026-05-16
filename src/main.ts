import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { load, type Store } from "@tauri-apps/plugin-store";

const STORE_FILE = "settings.json";
const KEY_LIBRARY_ROOT = "libraryRoot";
const KEY_MANIFEST_PATH = "manifestPath";

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

function joinPath(parent: string, child: string): string {
  return parent.endsWith("/") ? parent + child : parent + "/" + child;
}

async function loadChildren(node: TreeNode): Promise<void> {
  if (node.loaded || !node.isFolder) return;
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
  }
}

function renderNode(node: TreeNode): HTMLLIElement {
  const li = document.createElement("li");
  const label = document.createElement("span");
  const prefix = node.isFolder ? (node.expanded ? "▼ " : "▶ ") : "♪ ";
  label.textContent = prefix + node.name;
  label.style.cursor = "pointer";
  label.addEventListener("click", () => onNodeClick(node, li));
  li.appendChild(label);

  if (node.isFolder && node.expanded) {
    const childUl = document.createElement("ul");
    for (const child of node.children) {
      childUl.appendChild(renderNode(child));
    }
    li.appendChild(childUl);
  }
  return li;
}

async function onNodeClick(node: TreeNode, li: HTMLLIElement): Promise<void> {
  if (node.isFolder) {
    if (!node.loaded) await loadChildren(node);
    node.expanded = !node.expanded;
    li.replaceWith(renderNode(node));
  } else {
    playFile(node);
  }
}

function playFile(node: TreeNode): void {
  audioEl.src = convertFileSrc(node.path);
  nowPlayingNameEl.textContent = node.name;
  void audioEl.play();
}

function playStream(stream: Stream): void {
  audioEl.src = stream.url;
  nowPlayingNameEl.textContent = stream.name;
  audioEl.addEventListener(
    "loadedmetadata",
    () => {
      if (!isFinite(audioEl.duration)) return;
      const ranges = audioEl.seekable;
      if (ranges.length > 0) {
        audioEl.currentTime = Math.max(0, ranges.end(ranges.length - 1) - 5);
      }
    },
    { once: true },
  );
  void audioEl.play();
}

function renderStreams(streams: Stream[]): void {
  streamsContainer.innerHTML = "";
  const ul = document.createElement("ul");
  for (const stream of streams) {
    const li = document.createElement("li");
    const label = document.createElement("span");
    label.textContent = "📻 " + stream.name;
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
  const ul = document.createElement("ul");
  for (const child of rootNode.children) {
    ul.appendChild(renderNode(child));
  }
  treeContainer.appendChild(ul);
}

async function refreshTree(libraryRoot: string): Promise<void> {
  treeContainer.innerHTML = "";
  rootNode = null;
  if (!libraryRoot) {
    treeContainer.textContent = "No library root set";
    return;
  }
  let listing: DirListing;
  try {
    listing = await invoke<DirListing>("list_dir", { path: libraryRoot });
  } catch (e) {
    console.error("list_dir failed for", libraryRoot, e);
    treeContainer.textContent = "Invalid library root";
    return;
  }
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
  streamsContainer.innerHTML = "";
  if (!manifestPath) {
    streamsContainer.textContent = "No manifest path set";
    return;
  }
  try {
    const streams = await invoke<Stream[]>("read_manifest", { path: manifestPath });
    renderStreams(streams);
  } catch (e) {
    console.error("read_manifest failed for", manifestPath, e);
    streamsContainer.textContent = "Invalid manifest path";
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

async function init(): Promise<void> {
  audioEl = document.querySelector("#audio") as HTMLAudioElement;
  nowPlayingNameEl = document.querySelector("#now-playing-name") as HTMLElement;
  treeContainer = document.querySelector("#folder-tree") as HTMLElement;
  streamsContainer = document.querySelector("#streams-list") as HTMLElement;
  libraryRootInput = document.querySelector("#library-root") as HTMLInputElement;
  manifestPathInput = document.querySelector("#manifest-path") as HTMLInputElement;

  store = await load(STORE_FILE, { defaults: {}, autoSave: false });

  const libraryRoot = (await store.get<string>(KEY_LIBRARY_ROOT)) ?? "";
  const manifestPath = (await store.get<string>(KEY_MANIFEST_PATH)) ?? "";

  libraryRootInput.value = libraryRoot;
  manifestPathInput.value = manifestPath;

  libraryRootInput.addEventListener("change", onLibraryRootChange);
  manifestPathInput.addEventListener("change", onManifestPathChange);

  await refreshTree(libraryRoot);
  await refreshStreams(manifestPath);
}

window.addEventListener("DOMContentLoaded", init);
