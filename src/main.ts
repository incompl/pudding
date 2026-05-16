import { invoke, convertFileSrc } from "@tauri-apps/api/core";

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

let rootNode: TreeNode | null = null;
let audioEl: HTMLAudioElement;
let nowPlayingNameEl: HTMLElement;
let treeContainer: HTMLElement;
let streamsContainer: HTMLElement;

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

async function loadStreams(): Promise<void> {
  const manifestPath = await invoke<string>("get_manifest_path");
  try {
    const streams = await invoke<Stream[]>("read_manifest", { path: manifestPath });
    renderStreams(streams);
  } catch (e) {
    console.error("read_manifest failed for", manifestPath, e);
    streamsContainer.textContent = "Failed to load manifest: " + String(e);
  }
}

async function init(): Promise<void> {
  audioEl = document.querySelector("#audio") as HTMLAudioElement;
  nowPlayingNameEl = document.querySelector("#now-playing-name") as HTMLElement;
  treeContainer = document.querySelector("#folder-tree") as HTMLElement;
  streamsContainer = document.querySelector("#streams-list") as HTMLElement;

  const libraryRoot = await invoke<string>("get_library_root");

  rootNode = {
    path: libraryRoot,
    name: libraryRoot,
    isFolder: true,
    loaded: false,
    expanded: true,
    children: [],
  };

  await loadChildren(rootNode);
  renderTree();
  await loadStreams();
}

window.addEventListener("DOMContentLoaded", init);
