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
import { findNode } from "./library";
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
// the two callers repaint different things (see applyDownloaded, applyTagUpdate).
export function patchTrackFacts(path: string, facts: TrackFacts): FactsPatched {
  const out: FactsPatched = { tree: false, list: false };

  // The Files tree's node, which draws the title and artist itself and is also
  // what a later play/queue copies its row from (nodeToTrack).
  const found = app.rootNode ? findNode(app.rootNode, path) : null;
  if (found && !found.node.isFolder) {
    Object.assign(found.node, facts);
    out.tree = true;
  }

  // The playing pool's parent. For tree playback it holds the same node objects
  // the patch above just reached, but a play from a library view or a search
  // result builds a synthetic parent of its own (syntheticParent), and that one is
  // where now-playing reads its title from on the next advance (siblingByPath).
  for (const child of app.currentParent?.children ?? []) {
    if (child.path === path) Object.assign(child, facts);
  }

  // Both lists, not just the open one: the queue keeps playing while a playlist is
  // browsed, and a stale row in it would surface the moment the user flips back.
  // A path can repeat within a list, and every instance of it is the same file.
  for (const list of new Set([browsedPlaylist.peek(), activeQueue.peek()])) {
    for (const t of list?.tracks ?? []) {
      if (t.path !== path) continue;
      Object.assign(t, facts);
      out.list = true;
    }
  }
  return out;
}

// Refresh every surface that might show a just-edited track, after write_tags. The
// edit is decoupled from any one row, so each surface updates through its own path:
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
export function applyTagUpdate(path: string, tags: FileEntry): void {
  const patched = patchTrackFacts(path, {
    title: tags.title,
    artist: tags.artist,
    album: tags.album,
    albumArtist: tags.albumArtist,
    disc: tags.disc,
    track: tags.track,
    // Absent rather than null when the re-stat failed: a patch says what it
    // learned, and "we don't know the new mtime" is not "there isn't one".
    ...(tags.modified != null ? { modified: tags.modified } : {}),
  });
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
