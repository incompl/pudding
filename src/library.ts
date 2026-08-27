// Library + streams loading: building the Files tree from the configured folders,
// coalesced reconcile on filesystem-scan events, the Settings library-folder
// rows, and loading/validating the stream list. Rendering of individual rows
// lives in the view modules; this module owns the data + refresh lifecycle.

import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { h } from "./dom";
import type { DirListing, TreeNode, Stream } from "./types";
import {
  app,
  libraryHasContent,
  libraryRootSet,
  streamListPathSet,
  streamListPathValid,
  streamListWritable,
  currentNodePath,
} from "./state";
import {
  treeContainer,
  streamsContainer,
  libraryRootsContainer,
  streamListPathInput,
} from "./dom-refs";
import { nodesFromListing, renderTree } from "./tree-view";
import { renderStreams } from "./streams-view";
import {
  refreshPlaylistIndex,
  setEmpty,
  queueIsActivePool,
  KEY_LIBRARY_ROOTS,
  KEY_STREAM_LIST_PATH,
} from "./main";

// The final path segment (trailing slashes ignored) — the folder's display name
// when several library roots share the top level. Falls back to the whole path.
function basename(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : path;
}

// A loaded, expanded folder TreeNode wrapping a directory listing. `name` is the
// display label (the whole path for the sole root; the basename when several
// roots share the top level).
function makeRootFolderNode(path: string, name: string, listing: DirListing): TreeNode {
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
    expanded: true,
    children: nodesFromListing(path, listing),
  };
}

// Build the Files tree from the configured library folders. With one folder the
// tree is that folder (its contents shown at top level, as with a lone root).
// With several, a synthetic virtual rootNode (path "") holds one folder node per
// library root, so each appears as an expandable top-level row. Zero folders
// leaves the tree empty behind the get-started prompt.
export async function refreshTree(roots: string[]): Promise<void> {
  app.rootNode = null;
  libraryHasContent.value = false;
  libraryRootSet.value = roots.length > 0;
  app.invalidLibraryRoots = new Set();
  if (roots.length === 0) {
    // The panel-wide get-started prompt (files-empty effect) covers this case;
    // the tree stays empty behind it.
    setEmpty(treeContainer, "No library folder set");
    renderLibraryRootRows();
    return;
  }
  setEmpty(treeContainer, "Loading…", "loading");
  // List every root in parallel; a failed root becomes an empty folder node and
  // is flagged invalid (its Settings row outlines red) rather than sinking the
  // whole tree.
  const nodes = await Promise.all(
    roots.map(async (root) => {
      try {
        const listing = await invoke<DirListing>("list_dir", { path: root });
        const name = roots.length === 1 ? root : basename(root);
        return makeRootFolderNode(root, name, listing);
      } catch (e) {
        console.error("list_dir failed for", root, e);
        app.invalidLibraryRoots.add(root);
        const name = roots.length === 1 ? root : basename(root);
        return makeRootFolderNode(root, name, { folders: [], files: [], playlists: [] });
      }
    }),
  );
  renderLibraryRootRows();
  if (roots.length === 1) {
    app.rootNode = nodes[0];
  } else {
    // Virtual root: not a real folder on disk (path ""), just a container whose
    // children are the library folders. renderTree renders its children.
    app.rootNode = {
      path: "",
      name: "",
      title: null,
      artist: null,
      album: null,
      albumArtist: null,
      disc: null,
      track: null,
      isFolder: true,
      loaded: true,
      expanded: true,
      children: nodes,
    };
  }
  libraryHasContent.value = app.rootNode.children.length > 0;
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
  // The synthetic virtual root (multiple library folders) has no path of its own
  // — its children are the library folders. Skip its list_dir and reconcile each
  // folder directly.
  if (node.path === "") {
    await Promise.all(node.children.map((child) => reconcileNode(child)));
    return;
  }
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

export function findNode(
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

// True while an inline edit (tree rename) is open. The filesystem watcher fires
// `library-scanned` a beat after any write — including our own rename's — and that
// lands a renderTree() that would tear out the live edit input (and disturb
// scroll). While an edit is open we defer the refresh and flush it on finish.
// Set by a tree rename to the renamed playlist's path; the next renderTree scrolls
// that row into view and flashes it, so following it to its new sorted slot reads
// as deliberate. Cleared once consumed.

// Scroll a tree row (by file path) into view and briefly flash it. Used to follow
// a renamed playlist to its re-sorted position. No-op if the row isn't present.
function revealTreeRow(path: string): void {
  const label = treeContainer.querySelector<HTMLElement>(
    `.node-label[data-path="${CSS.escape(path)}"]`,
  );
  if (!label) return;
  label.scrollIntoView({ block: "nearest" });
  label.classList.remove("flash");
  // Reflow so re-adding the class restarts the animation even on a back-to-back reveal.
  void label.offsetWidth;
  label.classList.add("flash");
  label.addEventListener("animationend", () => label.classList.remove("flash"), {
    once: true,
  });
}

// Serialized + coalesced: scans can emit "library-scanned" repeatedly, and two
// overlapping reconciles would both mutate node.children and both renderTree
// (tearing the visible tree). Mirrors the backend's request_scan — at most one
// reconcile runs; events arriving during it collapse into a single follow-up.
export async function refreshLibrary(): Promise<void> {
  // The playlist index tracks every library change (the watcher and our own
  // writes both land here), so the Add-to-playlist submenu and searchable
  // playlists stay current without a separate refresh at each write site.
  void refreshPlaylistIndex();
  // Hold off rebuilding the tree while an inline edit is open — a renderTree()
  // here would destroy the edit input mid-type. finish() re-runs this once closed.
  if (app.inlineEditing) {
    app.refreshDeferredWhileEditing = true;
    return;
  }
  if (app.libraryRefreshing) {
    app.libraryRefreshPending = true;
    return;
  }
  app.libraryRefreshing = true;
  try {
    do {
      app.libraryRefreshPending = false;
      if (!app.rootNode) break;
      await reconcileNode(app.rootNode);
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
        const found = findNode(app.rootNode, path);
        if (found) {
          app.currentParent = found.parent;
        }
      }
      // An edit may have opened while we were mid-reconcile (the entry guard only
      // catches edits that predate the refresh). Rendering now would tear out its
      // input and shift scroll — the "scrolls after the 2nd edit" case. Defer the
      // paint; finish() re-runs refreshLibrary once the edit closes.
      if (app.inlineEditing) {
        app.refreshDeferredWhileEditing = true;
        break;
      }
      const filesTab = document.getElementById("tab-files");
      const scrollTop = filesTab?.scrollTop ?? 0;
      renderTree();
      if (filesTab) filesTab.scrollTop = scrollTop;
      // Follow a just-renamed playlist to its new alphabetical slot so the re-sort
      // reads as intentional rather than the row vanishing. Consumed once here.
      if (app.pendingRevealPlaylistPath) {
        revealTreeRow(app.pendingRevealPlaylistPath);
        app.pendingRevealPlaylistPath = null;
      }
    } while (app.libraryRefreshPending);
  } finally {
    app.libraryRefreshing = false;
  }
}

function isRemoteStreamList(path: string): boolean {
  return path.startsWith("http://") || path.startsWith("https://");
}

export async function refreshStreams(streamListPath: string): Promise<void> {
  streamListPathSet.value = !!streamListPath;
  if (!streamListPath) {
    app.allStreams = [];
    streamListPathValid.value = true;
    streamListWritable.value = false;
    // The panel-wide get-started prompt (streams-empty effect) covers this case.
    setEmpty(streamsContainer, "No stream list path set");
    return;
  }
  setEmpty(streamsContainer, "Loading…", "loading");
  try {
    const streams = await invoke<Stream[]>("read_stream_list", { path: streamListPath });
    app.allStreams = streams;
    streamListPathValid.value = true;
    // Only a valid local file is appendable; a remote list is read-only.
    streamListWritable.value = !isRemoteStreamList(streamListPath);
    renderStreams(streams);
  } catch (e) {
    console.error("read_stream_list failed for", streamListPath, e);
    app.allStreams = [];
    streamListPathValid.value = false;
    streamListWritable.value = false;
    setEmpty(streamsContainer, "Invalid stream list path");
  }
}

// Commit a new set of library folders: persist, re-render the settings rows,
// rescan + (re)watch the whole set, and rebuild the tree. Empty paths and
// duplicates are dropped so the array stays clean. Passing [] tears every
// watcher down and returns the Files panel to its get-started prompt.
export async function setLibraryRoots(paths: string[]): Promise<void> {
  const seen = new Set<string>();
  app.libraryRoots = paths.map((p) => p.trim()).filter((p) => p && !seen.has(p) && seen.add(p));
  await app.store.set(KEY_LIBRARY_ROOTS, app.libraryRoots);
  await app.store.save();
  renderLibraryRootRows();
  if (app.libraryRoots.length) {
    void invoke("rescan_libraries", { paths: app.libraryRoots });
  }
  // (Re)watch the new set (or, when empty, tear all old watchers down).
  void invoke("watch_libraries", { paths: app.libraryRoots }).catch((e) =>
    console.error("watch_libraries failed", e),
  );
  await refreshTree(app.libraryRoots);
  void refreshPlaylistIndex();
}

// Rebuild the Settings library-folder rows from `libraryRoots`. Each row is a
// .path-picker: the folder path (editable), a Choose… button that repoints that
// row, and an × that removes it. All three edit paths funnel through
// setLibraryRoots so persistence, rescan/watch, and the tree stay in step.
export function renderLibraryRootRows(): void {
  libraryRootsContainer.innerHTML = "";
  app.libraryRoots.forEach((path, index) => {
    const input = h("input", {
      class: app.invalidLibraryRoots.has(path) ? "invalid" : "",
      attrs: { type: "text" },
      on: {
        keydown: (e) => {
          if (e.key === "Enter") input.blur();
        },
        change: () => {
          const next = [...app.libraryRoots];
          const value = input.value.trim();
          if (value) next[index] = value;
          else next.splice(index, 1);
          void setLibraryRoots(next);
        },
      },
    });
    input.spellcheck = false;
    input.value = path;

    const choose = h("button", {
      attrs: { type: "button" },
      text: "Choose…",
      on: { click: () => void browseLibraryRoot(index) },
    });

    const remove = h("button", {
      class: "path-remove",
      attrs: { type: "button", title: "Remove this folder" },
      text: "×",
      on: {
        click: () => {
          const next = [...app.libraryRoots];
          next.splice(index, 1);
          void setLibraryRoots(next);
        },
      },
    });

    libraryRootsContainer.appendChild(
      h("div", { class: "path-picker" }, input, choose, remove),
    );
  });
}

export async function setStreamListPath(value: string): Promise<void> {
  streamListPathInput.value = value;
  await app.store.set(KEY_STREAM_LIST_PATH, value);
  await app.store.save();
  await refreshStreams(value);
}

// Open a folder picker for the library. With an index, it repoints that row;
// without one (the Add button), it appends a new folder.
export async function browseLibraryRoot(index?: number): Promise<void> {
  const selected = await open({
    directory: true,
    multiple: false,
    defaultPath: (index != null ? app.libraryRoots[index] : undefined) || undefined,
  });
  if (typeof selected !== "string") return;
  const next = [...app.libraryRoots];
  if (index != null) next[index] = selected;
  else next.push(selected);
  await setLibraryRoots(next);
}

export async function browseStreamListPath(): Promise<void> {
  const selected = await open({
    directory: false,
    multiple: false,
    defaultPath: streamListPathInput.value || undefined,
    filters: [{ name: "Stream list", extensions: ["m3u8", "m3u"] }],
  });
  if (typeof selected === "string") {
    await setStreamListPath(selected);
  }
}
