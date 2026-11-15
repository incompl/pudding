// Library + streams loading: building the Files tree from the configured folders,
// coalesced reconcile on filesystem-scan events, the Settings library-folder
// rows, and loading/validating the stream list. Rendering of individual rows
// lives in the view modules; this module owns the data + refresh lifecycle.

import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { h } from "./dom";
import type { DirListing, TreeNode, StreamList, HeldRoot, HeldStreamList } from "./types";
import {
  app,
  libraryHasContent,
  libraryRootSet,
  libraryRootsAway,
  libraryTreeLoaded,
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
import { nodesFromListing, renderTree, revealTreeRow } from "./tree-view";
import { applyTagFactsSinceSnapshot, tagFactsRevisionSnapshot } from "./track-facts";
import { renderStreams } from "./streams-view";
import { bootStep } from "./perf";
import {
  setEmpty,
  toast,
  queueIsActivePool,
  KEY_LIBRARY_ROOTS,
  KEY_ROOT_BOOKMARKS,
  KEY_STREAM_LIST_PATH,
  KEY_STREAM_LIST_BOOKMARK,
} from "./main";
import { refreshPlaylistIndex } from "./playlists";
import { invalidateNavListCache, popNavToRoot } from "./library-nav";

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
  // Mid-refresh the two signals above say "nothing" without meaning it, so the
  // get-started prompt must not read them until this flips back (both exits below
  // set it). Otherwise the prompt flashes over "Loading..." on every boot.
  libraryTreeLoaded.value = false;
  libraryRootSet.value = roots.length > 0;
  app.invalidLibraryRoots = new Set();
  libraryRootsAway.value = 0;
  if (roots.length === 0) {
    // The panel-wide get-started prompt (files-empty effect) covers this case;
    // the tree stays empty behind it.
    setEmpty(treeContainer, "No library folder set");
    renderLibraryRootRows();
    libraryTreeLoaded.value = true;
    return;
  }
  setEmpty(treeContainer, "Loading...", "loading");
  // List every root in parallel; a failed root becomes an empty folder node and
  // is flagged invalid (its Settings row outlines red) rather than sinking the
  // whole tree.
  const nodes = await Promise.all(
    roots.map(async (root) => {
      try {
        const listing = await bootStep("  list_dir(invoke)", () =>
          invoke<DirListing>("list_dir", { path: root }),
        );
        const name = roots.length === 1 ? root : basename(root);
        return await bootStep("  makeRootFolderNode", () =>
          makeRootFolderNode(root, name, listing),
        );
      } catch (e) {
        console.error("list_dir failed for", root, e);
        app.invalidLibraryRoots.add(root);
        const name = roots.length === 1 ? root : basename(root);
        return makeRootFolderNode(root, name, { folders: [], files: [], playlists: [] });
      }
    }),
  );
  // Every root has now been tried, so publish how many refused — the get-started
  // prompt says "plug it back in" rather than "no music found" when any did. Set
  // before renderTree so the empty-state effect has the answer the first time it
  // reads it.
  libraryRootsAway.value = app.invalidLibraryRoots.size;
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
  libraryTreeLoaded.value = true;
  await bootStep("  renderTree", () => renderTree());
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
  // A tag save can finish while this listing is in flight. Remember the boundary
  // so its newer in-memory facts survive the wholesale children replacement
  // below; the watcher that prompted this refresh is commonly the save's own
  // sequence of atomic renames.
  const tagFactsSnapshot = tagFactsRevisionSnapshot();
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
  applyTagFactsSinceSnapshot(next, tagFactsSnapshot);
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
      // A reconcile can be the moment a library stops (or starts) being empty —
      // first files copied into a configured folder, or the last ones removed — and the
      // get-started prompt is gated on this, so recompute it here as refreshTree
      // does rather than leaving it at whatever the last full rebuild decided.
      libraryHasContent.value = app.rootNode.children.length > 0;
      // renderTree reuses the live window (repaint in place), which keeps scrollTop
      // and the measured row height — so a scan/watcher refresh no longer jumps the
      // browsed tree to the top.
      renderTree();
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
    app.streamListMtime = null;
    streamListPathValid.value = true;
    streamListWritable.value = false;
    // The panel-wide get-started prompt (streams-empty effect) covers this case.
    setEmpty(streamsContainer, "No stream list path set");
    return;
  }
  setEmpty(streamsContainer, "Loading...", "loading");
  try {
    const list = await bootStep("  read_stream_list(invoke)", () =>
      invoke<StreamList>("read_stream_list", { path: streamListPath }),
    );
    const streams = list.streams;
    app.allStreams = streams;
    // The stamp every index-addressed edit will send back with its ordinals.
    app.streamListMtime = list.mtime;
    streamListPathValid.value = true;
    // Only a valid local file is appendable; a remote list is read-only.
    streamListWritable.value = !isRemoteStreamList(streamListPath);
    await bootStep("  renderStreams", () => renderStreams(streams));
  } catch (e) {
    console.error("read_stream_list failed for", streamListPath, e);
    app.allStreams = [];
    app.streamListMtime = null;
    streamListPathValid.value = false;
    streamListWritable.value = false;
    setEmpty(streamsContainer, "Invalid stream list path");
  }
}

// A station edit the backend refused. Say why — a stream list that changed on disk
// is the one failure the user can't otherwise explain, since the row they acted on
// is no longer the row the file has — and re-read the list so the pane, and the
// stamp the next edit sends, match what is actually there.
export async function streamEditFailed(what: string, e: unknown): Promise<void> {
  console.error(what, e);
  toast(String(e));
  await refreshStreams(streamListPathInput.value);
}

// The one form a root path is ever stored or keyed under. Trailing separators are
// stripped so a folder typed with or without a slash is one root, matching the key
// the backend stamps each track with (normalize_root) — and, since rootBookmarks is
// keyed by path, so that a blob minted from a picker result is findable later.
export function normalizeRootPath(path: string): string {
  return path.trim().replace(/\/+$/, "");
}

// Take — and keep — the OS-level grant for every configured library root.
//
// Sandboxed, a path string carries no permission of its own: the grant the user
// gave through the picker dies with the process, and only a security-scoped
// bookmark brings it back. The backend holds one guard per root for as long as that
// folder stays configured (src-tauri/src/root_access.rs), which is why nothing else
// in the app had to change — the scanner, the watchers, the tag writer and the
// playlist writer all keep opening plain paths. But it has to run *before* any of
// them, or they read an unreadable folder and the library comes back empty.
//
// Returns nothing; its effects are on `app.libraryRoots` (a folder the user moved
// comes back at its new path) and on the persisted blobs.
export async function holdLibraryRoots(): Promise<void> {
  const before = app.libraryRoots;
  let held: HeldRoot[];
  try {
    held = await invoke<HeldRoot[]>("hold_library_roots", {
      roots: before.map((path) => ({ path, bookmark: app.rootBookmarks[path] ?? null })),
    });
  } catch (e) {
    // Nothing here is load-bearing when the app isn't sandboxed, so a failure means
    // carrying on with what's configured — never blanking the library over it.
    console.error("hold_library_roots failed", e);
    return;
  }

  const paths: string[] = [];
  const bookmarks: Record<string, string> = {};
  let changed = false;
  held.forEach((root, i) => {
    // A fresh blob comes back when one was minted or the old one is aging out;
    // null means keep what's stored, which is also the answer when the folder was
    // unreachable — an unplugged drive shouldn't cost the user their grant.
    const blob = root.bookmark ?? app.rootBookmarks[before[i]];
    if (root.bookmark || root.path !== before[i]) changed = true;
    paths.push(root.path);
    if (blob) bookmarks[root.path] = blob;
    if (root.error) console.warn("library root unavailable:", root.path, root.error);
  });

  app.libraryRoots = paths;
  app.rootBookmarks = bookmarks;
  if (changed) {
    await app.store.set(KEY_LIBRARY_ROOTS, paths);
    await app.store.set(KEY_ROOT_BOOKMARKS, bookmarks);
    await app.store.save();
  }
}

// Commit a new set of library folders: persist, re-render the settings rows,
// rescan + (re)watch the whole set, and rebuild the tree. Empty paths and
// duplicates are dropped so the array stays clean. Passing [] tears every
// watcher down and returns the Files panel to its get-started prompt.
export async function setLibraryRoots(paths: string[]): Promise<void> {
  const before = app.libraryRoots;
  const seen = new Set<string>();
  const cleaned = paths
    .map(normalizeRootPath)
    .filter((p) => p && !seen.has(p) && seen.add(p));
  // Drop any root nested inside another kept root: a track under it would otherwise
  // belong to two roots, making its owning-root attribution (and thus which scan
  // reconciles it) ambiguous. The ancestor wins; its scan already covers the subtree.
  app.libraryRoots = cleaned.filter(
    (p) => !cleaned.some((q) => q !== p && p.startsWith(q + "/")),
  );
  // Blobs are keyed by path, so a root that just left the set takes its grant with
  // it; keeping it would resurrect access to a folder the user removed.
  app.rootBookmarks = Object.fromEntries(
    app.libraryRoots.flatMap((p) => (app.rootBookmarks[p] ? [[p, app.rootBookmarks[p]]] : [])),
  );
  // The Files panel's drill location is a place in the library — an album, an
  // artist — and a folder that just LEFT the set may have been the only thing
  // holding it up: remove a root, add a different one, and the open pane would
  // otherwise keep the old album's title over a list with no rows in it. So pop
  // home, and drop the memoized view lists that still mirror the departed
  // folder's tracks. Keyed on departures, not on any difference: adding a folder
  // can't invalidate a place in the ones already there, and taking the user's
  // place away is not something an append has earned. Membership, not order —
  // no gesture here reorders the set, and a reorder wouldn't matter if one did.
  if (before.some((p) => !app.libraryRoots.includes(p))) {
    invalidateNavListCache();
    popNavToRoot();
  }
  await app.store.set(KEY_LIBRARY_ROOTS, app.libraryRoots);
  await app.store.set(KEY_ROOT_BOOKMARKS, app.rootBookmarks);
  await app.store.save();
  // Before the rescan and the tree rebuild below, and before renderLibraryRootRows
  // draws paths that a moved folder may have changed. Also releases the grants for
  // roots that just left the set.
  await holdLibraryRoots();
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

// Re-check whether the configured folders are actually there, and put the app
// back in step with the answer if it changed.
//
// Driven by volume mounts and unmounts (see src-tauri/src/volumes.rs) and by the
// window regaining focus, which between them cover a drive ejected from Finder, a
// cable pulled, a share that dropped, and the same three in reverse. Both are
// "something might have happened" nudges rather than statements about the roots,
// so the first thing this does is establish whether anything did: every nudge
// runs the gate, and only a changed answer runs the reaction.
//
// The reaction is deliberately the ordinary roots-committed path with the same
// set of roots. A root leaving the building and a root coming back need the same
// five things done — re-take the grants, redraw the Settings rows, rescan,
// re-watch, rebuild the tree — and setLibraryRoots is where those five already
// live in the right order. (Re-watching is not incidental: notify's watch on a
// departed root is dead and does not self-heal, so without this a drive that came
// back would be un-watched until the next launch.) What it does *not* do is pop
// the Files panel home the way a root the user removed does: the folder is still
// configured, its tracks are still in the DB — the scan carries rows it could not
// walk straight through the prune — and a drive that comes back in ten seconds
// should not have cost the user their place.
export async function refreshRootAvailability(): Promise<void> {
  // Two nudges can arrive around one gesture — ejecting from Finder posts the
  // unmount notification and hands Pudding the focus back — and the second would
  // otherwise run its gate against the invalid-root set the first has not finished
  // replacing yet, concluding a second time that everything changed and starting a
  // second rescan and tree rebuild over the top of the first. So one at a time,
  // with a nudge that lands mid-check remembered rather than dropped: it may be
  // the drive coming back, and the state it would have corrected is the one the
  // user is looking at.
  if (checkingAvailability) {
    recheckAvailability = true;
    return;
  }
  checkingAvailability = true;
  try {
    do {
      recheckAvailability = false;
      await checkRootAvailability();
    } while (recheckAvailability);
  } finally {
    checkingAvailability = false;
  }
}

let checkingAvailability = false;
let recheckAvailability = false;

// One pass of the above: gate, then react. See refreshRootAvailability.
async function checkRootAvailability(): Promise<void> {
  if (!app.libraryRoots.length) return;
  // Re-take the grants *before* the gate, but only when something is already
  // known to be unreachable. Sandboxed, the probe below opens the folder and so
  // needs the access root_access holds, and the hold for a volume that went away
  // did not survive it — without this a returning drive would answer "still gone"
  // forever and never recover. Skipped in the common case (nothing is wrong, a USB
  // stick was plugged in), where it would be pure grant churn and a settings write.
  if (app.invalidLibraryRoots.size) await holdLibraryRoots();
  let unreachable: string[];
  try {
    unreachable = await invoke<string[]>("unreachable_roots", { paths: app.libraryRoots });
  } catch (e) {
    // Nothing is known now, and the next nudge asks again. Acting on a failed
    // probe would mean rebuilding the tree on a guess.
    console.error("unreachable_roots failed", e);
    return;
  }
  // Compared against the set the *tree* produced, which is what the app is
  // currently showing the user — red Settings rows, an emptied branch. The probe
  // is read_dir for exactly this reason: it fails where list_dir fails, so the two
  // can agree on a folder that is present but won't open, and a nudge that changes
  // nothing stays free. See unreachable_roots.
  const same =
    unreachable.length === app.invalidLibraryRoots.size &&
    unreachable.every((p) => app.invalidLibraryRoots.has(p));
  if (same) return;
  await setLibraryRoots(app.libraryRoots);
}

// Rebuild the Settings library-folder rows from `libraryRoots`. Each row is a
// .path-picker: the folder path (editable), a Choose... button that repoints that
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
      text: "Choose...",
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

// Take — and keep — the OS-level grant for the configured stream list, for the same
// reason holdLibraryRoots does it for each root: sandboxed, the picker's grant dies
// with the process, and a path alone comes back EPERM on the next launch — the
// stream pane saying "Invalid stream list path" over a file that never moved. Must
// run before read_stream_list, and before any station edit rewrites the file.
//
// Returns the path to actually use: a bookmark follows a file the user renamed or
// moved, so it can differ from the one that was stored.
export async function holdStreamList(path: string): Promise<string> {
  if (!path || isRemoteStreamList(path)) return path;
  let held: HeldStreamList;
  try {
    held = await invoke<HeldStreamList>("hold_stream_list", {
      path,
      bookmark: app.streamListBookmark,
    });
  } catch (e) {
    // Nothing here is load-bearing when the app isn't sandboxed, so a failure means
    // carrying on with the configured path — the read either works or reports why.
    console.error("hold_stream_list failed", e);
    return path;
  }

  // A fresh blob comes back when one was minted or the old one is aging out; null
  // means keep what's stored, which is also the answer when the file was
  // unreachable — an unplugged drive shouldn't cost the user their grant.
  if (held.bookmark) app.streamListBookmark = held.bookmark;
  if (held.bookmark || held.path !== path) {
    streamListPathInput.value = held.path;
    await app.store.set(KEY_STREAM_LIST_PATH, held.path);
    await app.store.set(KEY_STREAM_LIST_BOOKMARK, app.streamListBookmark);
    await app.store.save();
  }
  return held.path;
}

export async function setStreamListPath(value: string): Promise<void> {
  const before = (await app.store.get<string>(KEY_STREAM_LIST_PATH)) ?? "";
  streamListPathInput.value = value;
  // A blob belongs to the file it was minted from, so repointing the setting drops
  // it: resolving the old one against a new path would follow the *old* file back
  // over the user's choice, and holding its grant would be holding the wrong file's.
  // An unchanged path keeps its blob — committing the field without editing it (a
  // blur fires "change") must not spend a grant that cannot be re-minted while the
  // file is unreachable.
  if (value !== before) {
    app.streamListBookmark = null;
    await app.store.set(KEY_STREAM_LIST_BOOKMARK, null);
  }
  await app.store.set(KEY_STREAM_LIST_PATH, value);
  await app.store.save();
  // Freeze the grant now. For a picked file this is the one moment it exists — the
  // picker extended the sandbox to this process only — and for a typed path it is
  // a no-op that costs a log line.
  await refreshStreams(await holdStreamList(value));
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
  const path = normalizeRootPath(selected);
  // Freeze the grant now, while it exists. Sandboxed, the picker's grant lasts
  // only until quit and cannot be re-derived afterwards without asking again, so
  // this is the single moment a bookmark can be made. Null just means there was no
  // grant to freeze (unsandboxed), which costs nothing.
  const blob = await invoke<string | null>("bookmark_root", { path }).catch((e) => {
    console.error("bookmark_root failed", e);
    return null;
  });
  if (blob) app.rootBookmarks[path] = blob;
  const next = [...app.libraryRoots];
  if (index != null) next[index] = path;
  else next.push(path);
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
