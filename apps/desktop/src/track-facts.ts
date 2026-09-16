// One file's cached facts, and the copies of them the UI is holding.
//
// Everything the app shows about a track — its title, its times, the
// "(Not downloaded)" marker — is a copy of a scan-cache row, taken when the row
// was built and never told about anything since. Two things change those facts
// underneath: an explicit tag edit (editors.ts), and a cloud file finishing the
// download that playing it started (engine-glue.ts). The copies live in the same
// places either way, so both land here rather than each learning the list.

import type { FileEntry, SearchTrack, TreeNode } from "./types";
import { app, activeQueue, browsedPlaylist, downloadedPaths } from "./state";
import { renderTree } from "./tree-view";
import { repaintQueueList } from "./queue";
import {
  invalidateNavListCache,
  reloadNavPane,
  refreshNavPaneAfterScan,
} from "./library-nav";

// The fields a queue row and a tree node hold in common — which is everything the
// scan cache knows about a file, under the same names in both shapes, so one patch
// object serves both. Partial because a caller states only what it actually
// learned: a tag write knows nothing about bitrate, and must not blank it.
export type TrackFacts = Partial<
  Pick<
    SearchTrack & TreeNode,
    | "title"
    | "artist"
    | "album"
    | "albumArtist"
    | "disc"
    | "track"
    | "year"
    | "genre"
    | "duration"
    | "bitrate"
    | "sampleRate"
    | "bitDepth"
    | "gain"
    | "created"
    | "modified"
    | "notDownloaded"
  >
>;

// Which surfaces actually held a copy, so a caller repaints only what changed —
// each repaint below is a full rebuild of its surface, and a track that isn't in
// the open list shouldn't cost one.
export interface FactsPatched {
  tree: boolean;
  list: boolean;
}

// Write `facts` into every copy of this path the UI is holding. Does not repaint:
// the two callers repaint different things (see applyDownloaded, applyTagUpdates).
export function patchTrackFacts(path: string, facts: TrackFacts): FactsPatched {
  return patchTracksFacts(new Map([[path, facts]]));
}

// The same write for a whole batch, one pass per surface. A bulk tag edit lands
// hundreds of paths at once, and calling the single-path wrapper for each would be
// that many walks of the tree and that many scans of a queue that can hold
// thousands of rows — so the paths travel together as a map and every surface is
// visited once, whatever the batch size.
function patchTracksFacts(facts: Map<string, TrackFacts>): FactsPatched {
  const out: FactsPatched = { tree: false, list: false };

  // The Files tree's nodes, which draw the title and artist themselves and are
  // also what a later play/queue copies their rows from (nodeToTrack).
  const inTree = new Set<string>();
  if (app.rootNode) patchTreeNodes(app.rootNode, facts, inTree);
  out.tree = inTree.size > 0;

  // The playing pool's parent. For tree playback it holds the same node objects
  // the patch above just reached, but a play from a library view or a search
  // result builds a synthetic parent of its own (syntheticParent), and that one is
  // where now-playing reads its title from on the next advance (siblingByPath).
  for (const child of app.currentParent?.children ?? []) {
    const f = facts.get(child.path);
    if (f) Object.assign(child, f);
  }

  // Both lists, not just the open one: the queue keeps playing while a playlist is
  // browsed, and a stale row in it would surface the moment the user flips back.
  // A path can repeat within a list, and every instance of it is the same file.
  for (const list of new Set([browsedPlaylist.peek(), activeQueue.peek()])) {
    for (const t of list?.tracks ?? []) {
      const f = facts.get(t.path);
      if (!f) continue;
      Object.assign(t, f);
      out.list = true;
    }
  }
  return out;
}

// One walk of the tree for the whole batch, stopping as soon as every path in the
// map has been found. findNode returns at its first match, so without the stop a
// single-path patch — which is still how a download lands — would walk a large
// library to the end instead of returning where it used to. `found` doubles as the
// stop condition and as the answer to "did this surface hold any of them", and it
// holds paths rather than a count so a path that appears at two nodes (the same
// file reachable twice) can't end the walk early.
function patchTreeNodes(
  node: TreeNode,
  facts: Map<string, TrackFacts>,
  found: Set<string>,
): void {
  for (const child of node.children) {
    if (child.isFolder) {
      // The same reach findNode has: an unloaded folder holds no node objects yet,
      // so there is nothing under it to go stale.
      if (child.loaded) patchTreeNodes(child, facts, found);
    } else {
      const f = facts.get(child.path);
      if (f) {
        Object.assign(child, f);
        found.add(child.path);
      }
    }
    if (found.size === facts.size) return;
  }
}

// Refresh every surface that might show a just-edited track, after write_tags —
// one entry per file the write reported back, which is a batch of any size, since
// a save can now carry a whole selection. Every path is patched first and each
// surface is then rebuilt once for the lot: the three repaints below are full
// rebuilds, and a bulk edit that ran them per track would rebuild the tree three
// hundred times to show one set of changes.
//
// The edit is decoupled from any one row, so each surface updates through its own
// path:
//   - Tree: the fs watcher's own scan skips this row (write_tags pre-synced
//     mtime/size), so the patched node needs a repaint from here.
//   - Library nav views (Songs/Artists/Albums + detail): reload so tag-derived
//     membership recomputes — an edited-away track drops out and the list re-sorts.
//     A tag edit is an explicit act, so the scroll reset that comes with it reads
//     as intentional (unlike the download case below).
//   - Open right-pane list (queue / browsed playlist): membership is by path
//     (unchanged), so the patched rows need repaintQueueList, not renderQueue: the
//     tracks were edited *inside* the list object, so renderQueue is handed the
//     same Queue it already rendered and takes its fast path, which only re-toggles
//     the playing highlight. Every patched field would sit at its pre-edit value
//     until something else rebuilt the rows.
//
// Date Modified is patched alongside the tags, and is the one field here that the
// user didn't type: writing tags rewrites the file, so its mtime moves on every save.
// Without this the cell would sit at the pre-edit time until something forced a
// rescan — which the mtime/size pre-sync in write_tags has deliberately stopped from
// happening. (This is also why Date Created is the better "what did I just add"
// sort of the two; see the column table.)
export function applyTagUpdates(
  entries: { path: string; tags: FileEntry }[],
): void {
  if (entries.length === 0) return;
  const facts = new Map<string, TrackFacts>();
  for (const { path, tags } of entries) {
    facts.set(path, {
      title: tags.title,
      artist: tags.artist,
      album: tags.album,
      albumArtist: tags.albumArtist,
      disc: tags.disc,
      track: tags.track,
      // The other two tag columns. Absent from the editor's set for years, so a
      // Genre or Year cell would sit at its pre-edit value while every cell beside
      // it updated — the one row in the list that disagreed with the file.
      year: tags.year,
      genre: tags.genre,
      // Absent rather than null when the re-stat failed: a patch says what it
      // learned, and "we don't know the new mtime" is not "there isn't one".
      ...(tags.modified != null ? { modified: tags.modified } : {}),
    });
  }
  const patched = patchTracksFacts(facts);
  if (patched.tree) renderTree();
  reloadNavPane();
  if (patched.list) repaintQueueList();
}

// The other direction: a cloud file the user played has finished downloading, and
// the row every surface is holding describes the file as the scanner last saw it —
// flagged "(Not downloaded)", and untagged, because reading tags off a dataless
// file is exactly what the scanner refuses to do. `track` is the file read again
// now that it is local (audio.rs's fetch worker), and the backend has already
// corrected the cache row it came from, so this is only about the copies.
//
// Unprompted, unlike a tag edit — the user asked to play a track, not to reindex
// one — so the nav pane refreshes the way it does after a background scan, keeping
// its scroll position instead of yanking back to the top.
export function applyDownloaded(track: SearchTrack): void {
  // Belt and braces for the one field that has copies this can't reach: a nav
  // list memoized before the download, or a synthetic parent built from one, would
  // otherwise carry "not downloaded" into a queue row built after it. rowStatus
  // reads the marker through this set, so those rows come out right too.
  downloadedPaths.add(track.path);
  const patched = patchTrackFacts(track.path, {
    title: track.title,
    artist: track.artist,
    album: track.album,
    albumArtist: track.albumArtist,
    disc: track.disc,
    track: track.track,
    year: track.year,
    genre: track.genre,
    duration: track.duration,
    bitrate: track.bitrate,
    sampleRate: track.sampleRate,
    bitDepth: track.bitDepth,
    gain: track.gain,
    created: track.created,
    modified: track.modified,
    notDownloaded: track.notDownloaded,
  });
  if (patched.tree) renderTree();
  if (patched.list) repaintQueueList();
  // The cache row behind every memoized view list changed too (the backend's
  // reindex_downloaded), so drop them and re-render the open pane — the same pair
  // main.ts runs when a scan lands, and for the same reason.
  invalidateNavListCache();
  if (!app.inlineEditing) refreshNavPaneAfterScan();
}
