// The Files-tab library tree: lazy folder loading, row rendering (folders,
// tracks, playlists), click/select/context-menu wiring, and Enter-to-play
// dispatch across panes. Rendering only — the tree *data* + refresh lifecycle
// lives in library.ts.

import { invoke } from "@tauri-apps/api/core";
import { h } from "./dom";
import type {
  TreeNode,
  DirListing,
  SearchTrack,
  ContextMenuItem,
  PlaylistData,
} from "./types";
import {
  app,
  queuePlayingIndex,
  currentNodePath,
  activeQueue,
  browsedPlaylist,
  treeSelection,
  activeTab,
  selectedStreamUrl,
  resetToLonePlayback,
} from "./state";
import { treeContainer } from "./dom-refs";
import { showContextMenu } from "./context-menu";
import { startTrackDrag } from "./drag-drop";
import {
  joinPath,
  displayLabel,
  setEmpty,
  selectedTracks,
  toggleTreeSelection,
  selectTreeRangeTo,
  selectTreeSingle,
  showInFinderItem,
  addToPlaylistItem,
  trackContextItems,
  paneView,
  queueSel,
  playQueueTrack,
  commitBrowsedPlaylist,
} from "./main";
import {
  addPlaylistToQueue,
  playPlaylist,
  startTreePlaylistRename,
  deletePlaylistNode,
  playlistPlayableTracks,
  attachPlaylistClicks,
} from "./playlists";
import { editMetadataItem } from "./editors";
import { playFile, playFolder, playStream } from "./playback";
import { addFolderToQueue, nodeToTrack, queueMenuItems } from "./queue";
import { windowedList, type WindowedList } from "./windowed-list";

// One flattened, currently-visible row of the tree: a node plus the context the
// row renderer needs (its parent, its indent depth, and whether tracks in this
// folder should show their artist subline). Expanding a folder splices its
// children in after it; collapsing removes them — see flattenVisible. Windowing
// the tree means rendering a slice of this linear array, not the nested <ul> DOM.
interface TreeRow {
  node: TreeNode;
  parent: TreeNode;
  depth: number;
  showArtist: boolean;
  // A synthetic "(empty)" marker shown under an expanded folder with no children
  // (there's no child node to hang it on, so it's its own row).
  empty?: boolean;
}
// Per-depth indent, matching the old nested-<ul> padding-left (see #folder-tree ul).
const INDENT_EM = 1.6;

// Child nodes for one directory listing. Display order comes entirely from
// the backend: list_dir returns folders sorted by name and files sorted by
// (disc, track, name), and folders-before-files holds by construction here.
// `oldFolders` lets reconcileNode carry over an existing folder node (with its
// loaded/expanded state and children) instead of resetting it to a lazy stub.
export function nodesFromListing(
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
    // Playlists sort after all tracks (the backend already orders them
    // alphabetically). `name` is the display name; `path` the file.
    ...listing.playlists.map<TreeNode>((p) => ({
      path: joinPath(parentPath, p.file),
      name: p.name,
      title: null,
      artist: null,
      album: null,
      albumArtist: null,
      disc: null,
      track: null,
      isFolder: false,
      isPlaylist: true,
      loaded: true,
      expanded: false,
      children: [],
    })),
  ];
}

export async function fetchChildren(node: TreeNode): Promise<void> {
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

// Build the currently-visible rows as a flat, linear array: walk the tree, and for
// every expanded+loaded folder splice its children in right after it (recursively).
// Collapsed / unloaded folders contribute only their own row. This is what the
// window renders a slice of — so a 200k-file folder costs a screenful of DOM, not
// 200k nodes. showArtist is computed once per parent (folderArtistsVary); the top
// level keeps the historical default of showing the artist.
function flattenVisible(): TreeRow[] {
  const rows: TreeRow[] = [];
  const walk = (parent: TreeNode, depth: number, showArtist: boolean): void => {
    for (const child of parent.children) {
      rows.push({ node: child, parent, depth, showArtist });
      if (child.isFolder && child.expanded && child.loaded) {
        if (child.children.length === 0) {
          rows.push({ node: child, parent, depth: depth + 1, showArtist, empty: true });
        } else {
          walk(child, depth + 1, folderArtistsVary(child.children));
        }
      }
    }
  };
  if (app.rootNode) walk(app.rootNode, 0, true);
  return rows;
}

// Build one flat tree row (a `.node-label`) for the windowed list. Unlike the old
// nested renderer it never recurses — flattenVisible already laid out the children
// as their own rows — and it always renders a two-line cell (primary + a secondary
// that's a blank line when there's no artist) so every row is the uniform height
// the window positions rows by. Indentation, which the nested <ul> padding used to
// give, is applied here as a left margin from the row's depth.
function renderTreeRow(row: TreeRow): HTMLElement {
  const { node, parent, depth, showArtist } = row;
  if (row.empty) {
    const marker = h("span", { class: "node-label tree-empty", text: "(empty)" });
    marker.style.marginLeft = `${depth * INDENT_EM}em`;
    return marker;
  }
  // Every row carries its path so the playing-highlight effect can find it.
  // The tree row skips the accent while a queue/playlist owns the playhead — the
  // now-playing highlight belongs to the context playing the track, not to every
  // copy of the same file (see the highlight effect and queueIsActivePool).
  const label = h("span", { class: "node-label", data: { path: node.path } });
  // Indent by depth — the flat window has no nested <ul> to carry the old padding.
  if (depth > 0) label.style.marginLeft = `${depth * INDENT_EM}em`;
  // Mirror the highlight effect's basis: a live queue row means a queue owns the
  // playhead, so the tree's copy of its track stays plain and the playlist's own
  // row carries the accent instead. Keeps a mid-playback re-render in agreement.
  const queueOwnsPlayhead = queuePlayingIndex.peek() !== null;
  if (!node.isFolder && currentNodePath.value === node.path && !queueOwnsPlayhead) {
    label.classList.add("playing");
  }
  if (node.isPlaylist && queueOwnsPlayhead) {
    const q = activeQueue.peek();
    if (q?.kind === "playlist" && q.sourcePath === node.path) {
      label.classList.add("playing");
    }
  }
  // The open (browsed) playlist carries a persistent selection background so a
  // re-render keeps showing which playlist is open (the highlight effect below
  // reapplies it reactively; this keeps a mid-browse re-render in agreement).
  if (node.isPlaylist && browsedPlaylist.peek()?.sourcePath === node.path) {
    label.classList.add("open");
  }
  // Multi-select background, reapplied on re-render like the highlight classes
  // above (the selection effect keeps it live). Only tracks are selectable.
  if (!node.isFolder && !node.isPlaylist && treeSelection.peek().has(node.path)) {
    label.classList.add("selected");
  }
  // Folders show an open/closed folder. A track's slot carries its tagged track
  // number when it has one (the playing row just recolors it) and, on row hover,
  // a play button in the same cell — clicking a row now selects rather than
  // plays, so the hover button (or a double-click) is how you play one track.
  // Every track keeps the gutter even when untagged/loose so the play button has
  // a home and titles stay aligned with sibling folders.
  if (node.isPlaylist) {
    // A playlist gets its own "stack of rows" glyph, distinct from folders and
    // tracks, and always occupies the gutter.
    label.appendChild(h("span", { class: "icon playlist" }));
  } else if (node.isFolder) {
    label.appendChild(
      h("span", { class: `icon ${node.expanded ? "folder-open" : "folder"}` }),
    );
  } else {
    label.appendChild(
      h(
        "span",
        { class: "icon track" },
        h("span", {
          class: "track-num",
          text:
            parent !== app.rootNode && node.track != null ? String(node.track) : "",
        }),
        // The button plays directly and swallows the click so the row's
        // select-on-click doesn't also fire.
        h("button", {
          class: "row-play",
          attrs: { "aria-label": "Play" },
          on: {
            click: (e) => {
              e.stopPropagation();
              playTreeTrack(node, parent);
            },
          },
        }),
      ),
    );
  }
  // Every row is two lines for a uniform windowed height (see renderTreeRow's
  // header): the title/name on top, the artist beneath (a de-emphasized second
  // line, like a search result) for a tagged track — otherwise a blank second line
  // (a non-breaking space, so folders and untagged files reserve the same height
  // rather than collapsing to a shorter row and breaking the window's row math).
  const primaryText = !node.isFolder && node.title ? node.title : displayLabel(node);
  const secondaryText =
    !node.isFolder && node.title && node.artist && showArtist ? node.artist : "";
  label.appendChild(
    h(
      "span",
      { class: "label-text" },
      h("span", { class: "primary", text: primaryText }),
      h("span", { class: "secondary", text: secondaryText || " " }),
    ),
  );
  if (node.isPlaylist) {
    attachPlaylistClicks(label, node);
  } else {
    label.addEventListener("click", (e) => onNodeClick(node, e));
  }
  // Right-click a playlist to play it, add its tracks to the queue, or curate it
  // (Rename rewrites the #PLAYLIST: directive; Delete removes the file).
  if (node.isPlaylist) {
    label.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      showContextMenu(e.clientX, e.clientY, [
        { label: "Play", action: () => void playPlaylist(node) },
        ...queueMenuItems((sink) => void addPlaylistToQueue(node, sink)),
        addToPlaylistItem(async () =>
          playlistPlayableTracks(
            await invoke<PlaylistData>("read_playlist", { path: node.path }),
          ),
        ),
        { label: "Rename", action: () => startTreePlaylistRename(node, label) },
        { label: "Delete", action: () => void deletePlaylistNode(node) },
        showInFinderItem(node.path),
      ]);
    });
  } else if (node.isFolder) {
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
        ...queueMenuItems(
          (sink) => void addFolderToQueue({ path: node.path, name: node.name }, sink),
        ),
        addToPlaylistItem(() =>
          invoke<SearchTrack[]>("folder_tracks", { path: node.path }),
        ),
        showInFinderItem(node.path),
      ]);
    });
  } else {
    // Right-click a track to go to its artist or album detail view. Each item is
    // only offered when that tag exists. An untagged track (common for OST rips
    // named purely by filename) has neither, so fall back to "Play folder" on its
    // containing folder — right-click always does something.
    label.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      // Finder-style: right-clicking a row outside the current selection makes it
      // the selection; right-clicking inside a multi-selection keeps it. The verbs
      // then act on the whole selection (see selectedTracks).
      if (!treeSelection.peek().has(node.path)) {
        treeSelection.value = new Set([node.path]);
        app.selectionAnchor = node.path;
      }
      const sel = selectedTracks();
      const items: ContextMenuItem[] = [];
      if (sel.length > 1) {
        // Multi-select: the per-track navigation verbs (Go to artist/album) don't
        // apply to a heterogeneous set, so offer only the list-building verbs,
        // acting on every selected track. Count in the label confirms the scope.
        items.push(...queueMenuItems((sink) => sink(sel), sel.length));
        items.push(addToPlaylistItem(() => sel));
        // revealItemInDir takes one path; reveal the first selected track.
        items.push(showInFinderItem(sel[0].path));
      } else {
        // The navigation verbs lead — Go to artist / Go to album when their tags
        // exist, else "Play folder" on the container for an untagged track (which
        // has neither) so right-click always does something. The list-building
        // verbs (Play next / Add to queue) follow, matching the folder menu's order.
        const nav = trackContextItems({
          artist: node.artist,
          album: node.album,
          albumArtist: node.albumArtist,
        });
        items.push(...nav);
        if (nav.length === 0 && parent.isFolder) {
          items.push({
            label: "Play folder",
            action: () => void playFolder({ path: parent.path, name: parent.name }),
          });
        }
        items.push(...queueMenuItems((sink) => sink([nodeToTrack(node)])));
        items.push(addToPlaylistItem(() => [nodeToTrack(node)]));
        items.push(editMetadataItem(node.path));
        items.push(showInFinderItem(node.path));
      }
      showContextMenu(e.clientX, e.clientY, items);
    });
    // A track can be dragged out of the tree into an open playlist/queue list to
    // add it at a position (the tree itself accepts no drops). The payload is the
    // track as a SearchTrack; the list's drop resolves an insert and autosaves.
    // Pointer-based (not HTML5 DnD) so it coexists with Tauri's native OS
    // file-drop handler — see beginPointerDrag.
    label.addEventListener("pointerdown", (e) => {
      // Dragging a selected row carries the whole selection into the drop target;
      // dragging an unselected one carries just that track.
      const sel = treeSelection.peek();
      const tracks =
        sel.has(node.path) && sel.size > 1 ? selectedTracks() : [nodeToTrack(node)];
      startTrackDrag(e, tracks);
    });
    // Double-click anywhere on the row plays it — the second verb alongside the
    // hover play button, now that a plain click only selects.
    label.addEventListener("dblclick", () => playTreeTrack(node, parent));
  }
  // A folder's children are their own flattened rows (see flattenVisible), so the
  // row is just the label — no nested <ul> to build here.
  return label;
}

async function onNodeClick(node: TreeNode, e?: MouseEvent): Promise<void> {
  if (node.isFolder) {
    // Load lazily on first open, then toggle and re-window: expanding splices this
    // folder's children into the flat row list, collapsing removes them.
    if (!node.loaded) await fetchChildren(node);
    node.expanded = !node.expanded;
    refreshTreeRows();
    return;
  }
  app.lastSelectionPane = "tree";
  if (e && (e.metaKey || e.ctrlKey)) {
    // Cmd/Ctrl-click builds a discontiguous selection without playing anything.
    toggleTreeSelection(node.path);
  } else if (e && e.shiftKey) {
    // Shift-click extends a contiguous range from the anchor, also without playing.
    selectTreeRangeTo(node.path);
  } else {
    // A plain click now selects the single row (and anchors a following
    // Shift-range here) instead of playing — play is the hover play button or a
    // double-click (see playTreeTrack). Matches playlists (single = inspect,
    // double = commit) and lets you browse without interrupting playback.
    selectTreeSingle(node.path);
  }
}

// Play a tree track — the hover play button or a double-click. Selects the
// played row (dropping any multi-select) so it stays highlighted, matching Apple
// Music, and clears the queue highlight so the folder becomes the pool. Does NOT
// clear any explicit queue — that stays stashed and visible so the user can
// return to it. A lone track is bare continuation (hero only), so dismiss any
// open queue/playlist chrome first.
function playTreeTrack(node: TreeNode, parent: TreeNode): void {
  selectTreeSingle(node.path);
  queuePlayingIndex.value = null;
  resetToLonePlayback();
  playFile(node, parent);
}

// Find a loaded track node and its parent by path, walking every loaded folder
// (so a selection under a collapsed folder still resolves). Returns null for a
// path that isn't a currently-loaded track — e.g. a folder collapsed away its
// children after selection.
function findTreeNodeAndParent(path: string): { node: TreeNode; parent: TreeNode } | null {
  let found: { node: TreeNode; parent: TreeNode } | null = null;
  const walk = (parent: TreeNode): void => {
    for (const child of parent.children) {
      if (found) return;
      if (child.isFolder) {
        if (child.loaded) walk(child);
      } else if (!child.isPlaylist && child.path === path) {
        found = { node: child, parent };
      }
    }
  };
  if (app.rootNode) walk(app.rootNode);
  return found;
}

// Play whatever a keyboard Enter should commit: the selected row in the pane the
// user last acted in. A commit for the same row a plain click now merely selects.
// Returns true when it played something (so the caller can preventDefault).
// Sidebar panes only fire when their tab is showing, so Enter never plays a row
// hidden behind the other tab; the list pane is always visible.
export function playSelectedRow(): boolean {
  if (app.lastSelectionPane === "stream" && activeTab.value === "streams") {
    const url = selectedStreamUrl.value;
    const stream = url ? app.allStreams.find((s) => s.url === url) : undefined;
    if (stream) {
      playStream(stream);
      return true;
    }
    return false;
  }
  if (app.lastSelectionPane === "tree" && activeTab.value === "files") {
    // The anchor is the last row a click touched — the natural "focused" row to
    // commit when a range is selected. Fall back to a lone selected path.
    const sel = treeSelection.value;
    const path =
      app.selectionAnchor && sel.has(app.selectionAnchor)
        ? app.selectionAnchor
        : sel.size === 1
          ? [...sel][0]
          : null;
    const hit = path ? findTreeNodeAndParent(path) : null;
    if (hit) {
      playTreeTrack(hit.node, hit.parent);
      return true;
    }
    return false;
  }
  if (app.lastSelectionPane === "list") {
    const { list, isSource } = paneView.value;
    if (!list) return false;
    // The anchor is the focused row; fall back to a lone selection. Map it to a
    // playable-pool index (missing rows are skipped, mirroring renderQueue).
    const sel = queueSel.signal.value;
    const lone = sel.size === 1 ? [...sel][0] : null;
    const anchor = queueSel.anchor();
    const target = anchor && sel.has(anchor) ? anchor : lone;
    if (!target || target.missing) return false;
    let poolIdx = 0;
    for (const row of list.tracks) {
      if (row.missing) continue;
      if (row === target) {
        if (isSource) playQueueTrack(poolIdx);
        else commitBrowsedPlaylist(poolIdx);
        return true;
      }
      poolIdx++;
    }
    return false;
  }
  return false;
}

// Whether `folderPath` is `target` or one of its ancestors — the descent test
// for revealFolderInTree. Separator-agnostic (accepts both / and \) so it holds
// on either platform without importing the path joiner.
function isAncestorOrSelf(folderPath: string, target: string): boolean {
  return (
    target === folderPath ||
    target.startsWith(folderPath + "/") ||
    target.startsWith(folderPath + "\\")
  );
}

// Reveal a folder in the Browse tree: expand every ancestor from the root down
// (loading each lazily), expand the target itself so its contents show, then
// scroll it into view. Backs the search hit's "Go to folder" — the caller has
// already switched to the Files tab and entered the Browse lens (which un-hides
// this tree). A path that isn't under the library resolves to nothing and just
// leaves the tree where it was.
export async function revealFolderInTree(path: string): Promise<void> {
  const root = app.rootNode;
  if (!root) return;
  let node: TreeNode = root;
  // Descend toward the target, loading + expanding each ancestor on the way.
  while (node.path !== path) {
    if (!node.loaded) await fetchChildren(node);
    const next = node.children.find(
      (c) => c.isFolder && isAncestorOrSelf(c.path, path),
    );
    if (!next) break; // not under the library, or a stale/removed folder
    if (next.path !== path) next.expanded = true;
    node = next;
  }
  // Expand the target so arriving shows its tracks, not just a collapsed row.
  if (node.path === path) {
    if (!node.loaded) await fetchChildren(node);
    node.expanded = true;
  }
  // Rebuild with the ancestors expanded, then scroll the target's row to the top
  // (offset past the sticky Browse back-bar). The row may be far off-screen and
  // unmounted, so scroll by its index in the flattened list, not by finding a DOM
  // node — the window mounts it once the scroll lands there (scrollToIndex waits
  // for the first measure if the tree was only just un-hidden).
  buildTree();
  scrollTreeToPath(path);
}

// Scroll a tree row (by path) to the top of the pane. Returns the index found (or
// -1). Shared by the search "Go to folder" reveal and the post-rename flash.
function scrollTreeToPath(path: string): number {
  const idx = treeRows.findIndex((r) => !r.empty && r.node.path === path);
  if (idx >= 0) treeWin?.scrollToIndex(idx, stickyMargin());
  return idx;
}

// Scroll a tree row into view (by file path) and briefly flash it — used to follow
// a just-renamed playlist to its new sorted slot. The row mounts a frame or two
// after the scroll lands, so poll briefly for its label before flashing.
export function revealTreeRow(path: string): void {
  if (scrollTreeToPath(path) < 0) return;
  let tries = 0;
  const flash = (): void => {
    const label = treeContainer.querySelector<HTMLElement>(
      `.node-label[data-path="${CSS.escape(path)}"]`,
    );
    if (!label) {
      if (tries++ < 15) requestAnimationFrame(flash);
      return;
    }
    label.classList.remove("flash");
    void label.offsetWidth; // restart the animation if it was mid-flight
    label.classList.add("flash");
    label.addEventListener("animationend", () => label.classList.remove("flash"), {
      once: true,
    });
  };
  requestAnimationFrame(flash);
}

// The Browse folder tree is costly to build for a large library, yet it's hidden
// unless the Browse lens is the active view — and most sessions live in Songs and
// never open Browse. So defer the DOM build: when Browse isn't active, renderTree()
// just flags the tree stale and returns, sparing the startup + scan-complete freeze.
// library-nav's render() calls setBrowseActive() when the lens changes; entering
// Browse with a stale tree builds it once. The node *model* (app.rootNode) is kept
// current by refreshTree/reconcile regardless — only the DOM paint waits.
let browseActive = false;
let treeStale = false;
// The flattened visible rows the window renders a slice of, and the window handle.
// Kept at module scope so expand/collapse (refreshTreeRows) and reveal can update
// the window in place — resizing + repainting without a teardown flash.
let treeRows: TreeRow[] = [];
let treeWin: WindowedList | null = null;

function buildTree(): void {
  treeStale = false;
  treeContainer.innerHTML = "";
  treeWin = null;
  treeRows = [];
  if (!app.rootNode) return;
  if (app.rootNode.children.length === 0) {
    setEmpty(treeContainer, "Library is empty");
    return;
  }
  treeRows = flattenVisible();
  // Window the rows: only the on-screen slice is mounted over a full-height spacer,
  // so a huge (esp. flat) folder costs a screenful of DOM instead of one node per
  // file. `count` is a function so expand/collapse can re-window in place via
  // treeWin.update() (see refreshTreeRows). Reactive highlight/selection effects
  // query mounted rows by data-path and no-op on the absent ones — a row applies
  // its own state at build time when it scrolls in, so it's already correct.
  treeWin = windowedList({
    count: () => treeRows.length,
    renderRow: (i) => renderTreeRow(treeRows[i]),
  });
  treeWin.el.classList.add("tree-window");
  treeContainer.appendChild(treeWin.el);
}

// Re-flatten after an expand/collapse and repaint the window in place (no teardown,
// so scroll position and the measured row height survive). Falls back to a full
// build if the window doesn't exist yet.
function refreshTreeRows(): void {
  if (!treeWin) {
    buildTree();
    return;
  }
  treeRows = flattenVisible();
  treeWin.update();
}

// Pixels to leave above a revealed row so it clears the sticky Browse back-bar
// (2em, matching the row's old scroll-margin-top). Read from the pane's font size
// so it tracks the app zoom.
function stickyMargin(): number {
  return 2 * (parseFloat(getComputedStyle(treeContainer).fontSize) || 16);
}

export function renderTree(): void {
  if (!browseActive) {
    treeStale = true;
    return;
  }
  buildTree();
}

// Tell the tree whether the Browse lens is now the active view. Entering Browse
// with a deferred (stale) tree builds it now — the paint we skipped while hidden.
export function setBrowseActive(active: boolean): void {
  browseActive = active;
  if (active && treeStale) buildTree();
}
