// The playback core: feeding tracks to the native engine, shuffle-bag + repeat
// advancement (handleEnded / skip), and the entry points that start playback
// (playFile / playStream / playSearchTrack / playFolder). Transport controls
// (play-pause, seek, volume) live here too. The engine handle itself is in
// engine-glue.ts; queue/playlist assembly is in main for now.

import { invoke } from "@tauri-apps/api/core";
import type { TreeNode, Stream, SearchTrack, SearchFolder } from "./types";
import { engine } from "./engine-glue";
import {
  app,
  hasTrack,
  npTitle,
  npArtist,
  npAlbum,
  npStreamMeta,
  currentNodePath,
  currentStreamUrl,
  selectedStreamUrl,
  isStream,
  currentTime,
  duration,
  volume,
  queuePlayingIndex,
  repeatMode,
  shuffleMode,
  resetToLonePlayback,
  autoadvanceEnabled,
} from "./state";
import { fetchChildren } from "./tree-view";
import {
  debounce,
  queueIsActivePool,
  loadArt,
  clearArt,
  loadStreamArt,
  trackCountSubtitle,
  playQueue,
  KEY_VOLUME,
} from "./main";

// --- Playback ---

export function setNowPlaying(
  title: string,
  artist: string | null,
  album: string | null,
): void {
  hasTrack.value = true;
  npTitle.value = title;
  npArtist.value = artist;
  npAlbum.value = album;
}

// Idle play, cold start: "start the library" by playing the first song. For a
// folder that's its first track — the same as clicking that track in the tree
// (the album auto-continues under the hood, no queue view), not the whole folder
// as an explicit playlist. A loose top-level file plays on its own. This keeps
// the idle play button ready-to-go rather than a dead disabled control.
async function startLibrary(): Promise<void> {
  const root = app.rootNode;
  const first = root?.children[0];
  if (!root || !first) return;
  // Idle play starts a lone track (album continuation) — the hero, no list.
  resetToLonePlayback();
  if (!first.isFolder) {
    playFile(first, root);
    return;
  }
  await fetchChildren(first);
  const track = first.children.find((c) => !c.isFolder);
  if (track) playFile(track, first);
}

export function togglePlayPause(): void {
  // A queue resting with no playhead — drained at its end, or armed from silence
  // by "Add to queue" without auto-playing — starts from the top. This is checked
  // before the idle-play fallback so an armed queue (hasTrack still false, nothing
  // ever played) starts itself rather than the whole library.
  if (app.queueEnded && app.lastQueue.length > 0) {
    app.queueEnded = false;
    if (queueIsActivePool()) {
      // The queue rests with no playhead, so play restarts it from the top rather
      // than resuming any one track. (activeQueue can now be set while a folder
      // plays with the queue merely stashed — the pool, not its mere existence,
      // is what decides this.)
      const pool = poolPaths();
      app.lastQueue = pool;
      app.lastIndex = 0;
      app.pendingQueueIndex = 0;
      currentNodePath.value = pool[0] ?? null;
      feedEngine(pool, 0);
    } else {
      // Implicit folder continuation: the album played through and stopped, so
      // play restarts it from the start of the folder — matching how a queue pool
      // and the navigator's leaf lists restart from their top rather than resuming
      // the track you happened to start on.
      app.lastIndex = 0;
      currentNodePath.value = app.lastQueue[0] ?? null;
      feedEngine(app.lastQueue, 0);
    }
    return;
  }
  if (!hasTrack.value) {
    void startLibrary();
    return;
  }
  // Streams also route through togglePause: the engine implements live-radio
  // semantics natively (pause disconnects, resume rejoins the live edge).
  void engine.togglePause();
}

const persistVolume = debounce(async (v: number) => {
  await app.store.set(KEY_VOLUME, v);
  await app.store.save();
}, 200);

// Most recent non-muted volume, restored when unmuting via the volume button.
export let lastNonZeroVolume = 1;

// Seed the remembered volume from the restored setting at startup (a reassigned
// module `let` can't be written across a module boundary).
export function setLastNonZeroVolume(v: number): void {
  if (v > 0) lastNonZeroVolume = v;
}

export function setVolume(v: number): void {
  const clamped = Math.max(0, Math.min(1, v));
  if (clamped > 0) lastNonZeroVolume = clamped;
  if (clamped === volume.value) return;
  volume.value = clamped;
  persistVolume(clamped);
}

export function seekBy(seconds: number): void {
  if (isStream.value) return;
  app.queueEnded = false;
  void engine.seekBy(seconds);
}

export function seekTo(seconds: number): void {
  if (isStream.value) return;
  app.queueEnded = false;
  void engine.seekTo(seconds);
}

// The tracks eligible for shuffle/repeat advancement. Inside an album that's
// the folder's tracks in listing order; a search hit or external file has no
// album context, so the pool is just that single track.
export function poolPaths(): string[] {
  if (app.currentParent) {
    return app.currentParent.children.filter((c) => !c.isFolder).map((c) => c.path);
  }
  if (currentNodePath.value) return [currentNodePath.value];
  // Search hit or external file: no album context, so the queue itself is the
  // pool (a single track). Lets repeat still loop it.
  return app.lastQueue;
}

export function shuffled<T>(items: T[]): T[] {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// (Re)fill the shuffle bag with the pool minus the current track, so the next
// pick is never an immediate repeat. A single-track pool has nothing else to
// pick, so it falls back to looping that track.
export function refillShuffleBag(current: string | null): void {
  const pool = poolPaths();
  const rest = pool.filter((p) => p !== current);
  app.shuffleBag = shuffled(rest.length ? rest : pool);
}

// Hand the engine a single track and remember it as the queue, so play-after-end
// and the play button restart the right thing. UI (row highlight, now-playing,
// art) follows from the engine's track-changed → onAdvance for album tracks;
// for a lone search/external track it's already correct (same track).
export function playSingle(path: string, queueIndex?: number): void {
  app.queueEnded = false;
  app.lastQueue = [path];
  app.lastIndex = 0;
  currentTime.value = 0;
  // Shuffle / repeat-one hand the engine one track at a time; when that track is
  // a queue row, mark which one so onAdvance highlights it. Callers pass the
  // positional index when known (e.g. repeat-one looping row 3 of a duplicate-
  // heavy queue) so the correct instance is highlighted rather than the first match.
  if (queueIsActivePool()) {
    if (queueIndex != null) {
      app.pendingQueueIndex = queueIndex;
    } else {
      const found = app.currentParent?.children.findIndex((c) => c.path === path) ?? -1;
      app.pendingQueueIndex = found >= 0 ? found : null;
    }
  }
  void engine.play([path], 0);
}

// Hand the engine a straight-play list positioned at `idx`. With autoadvance on
// (the default) the whole list goes across so the engine advances gaplessly; with
// it off, only the one track is handed over — the engine then drains after it and
// handleEnded stops, giving "one track, then stop" without any engine change. The
// full list still lives in lastQueue/poolPaths so a manual skip can move on.
function feedEngine(list: string[], idx: number): void {
  if (autoadvanceEnabled()) void engine.play(list, idx);
  else void engine.play([list[idx]], 0);
}

// Hand the engine a pool starting at `idx` and remember it (the shared body of
// straight-play advance, repeat-all wrap, and manual skip). When the pool is the
// queue, `idx` is also the row to highlight next.
export function playPool(pool: string[], idx: number): void {
  app.queueEnded = false;
  app.lastQueue = pool;
  app.lastIndex = idx;
  if (queueIsActivePool()) app.pendingQueueIndex = idx;
  feedEngine(pool, idx);
}

// Playback has run to the end with nothing left to advance to. A visible queue
// rests with no playhead — the finished rows stay on screen, but nothing is
// "current", so pressing play restarts it from the top (see togglePlayPause).
// Implicit folder continuation keeps its row highlighted so play resumes the
// track that just finished.
function stopAtQueueEnd(): void {
  app.queueEnded = true;
  // A drained queue rests with no playhead (rows stay, none highlighted); folder
  // autoplay instead keeps its row so play resumes the finished track. The two
  // never hand off: playback outside the queue stops at the folder's end rather
  // than flowing into any stashed queue.
  if (queueIsActivePool()) {
    currentNodePath.value = null;
    queuePlayingIndex.value = null;
  }
}

// Decide what to play when the engine drains its queue. This is the sole
// advancement point: straight play only reaches it at album end (the engine
// auto-advances the rest gaplessly), while shuffle and repeat-one reach it after
// every track because they're queued one at a time.
export function handleEnded(): void {
  const mode = repeatMode.value;
  // currentNodePath is null for an external file; fall back to the queue so
  // repeat still identifies the track to loop.
  const current = currentNodePath.value ?? app.lastQueue[app.lastIndex] ?? null;

  // Repeat-one loops the finished track regardless of shuffle.
  if (mode === "one" && current) {
    playSingle(current, queueIsActivePool() ? (queuePlayingIndex.value ?? undefined) : undefined);
    return;
  }

  // Autoadvance off for this context: stop instead of moving to the next track.
  // This overrides shuffle and repeat-all (both advance to a *different* track);
  // repeat-one above still loops, since it never advances off the current track.
  if (!autoadvanceEnabled()) {
    stopAtQueueEnd();
    return;
  }

  if (shuffleMode.value) {
    if (app.shuffleBag.length === 0) {
      // Cycle exhausted: reshuffle and keep going when repeating, else stop.
      if (mode !== "all") {
        stopAtQueueEnd();
        return;
      }
      refillShuffleBag(current);
    }
    const next = app.shuffleBag.shift();
    if (next) playSingle(next);
    else stopAtQueueEnd();
    return;
  }

  // Straight play. Continue in listing order from the finished track; this
  // matters when shuffle was turned off mid-album (single-track queue) — resume
  // the album in order rather than stopping.
  const pool = poolPaths();
  // In the queue pool, use the live row index (same as skipNext) so a duplicate
  // track at a later row resolves to the correct instance rather than the first
  // path match, which would cause the queue to loop from the middle instead of stop.
  const curIdx = queueIsActivePool() && queuePlayingIndex.value != null
    ? queuePlayingIndex.value
    : pool.indexOf(current ?? "");
  const nextIdx = curIdx + 1;
  if (curIdx >= 0 && nextIdx < pool.length) {
    playPool(pool, nextIdx);
    return;
  }
  // End of the album.
  if (mode === "all" && pool.length > 0) {
    playPool(pool, 0);
    return;
  }
  stopAtQueueEnd();
}

// User-initiated skip, driven by the OS Now Playing widget / media keys (there
// is no in-app skip button). Reuses the same pool / shuffle-bag advancement as
// handleEnded, but a manual next overrides repeat-one (skip, don't re-loop).
export function skipNext(): void {
  if (isStream.value) return;
  const current = currentNodePath.value ?? app.lastQueue[app.lastIndex] ?? null;

  if (shuffleMode.value) {
    if (app.shuffleBag.length === 0) refillShuffleBag(current);
    const next = app.shuffleBag.shift();
    if (next) playSingle(next);
    return;
  }

  const pool = poolPaths();
  // In the queue pool, trust the live row index (positional, so a duplicated
  // track resolves to the instance actually playing) over a path lookup, which
  // would find the first copy. Elsewhere the path is unambiguous.
  const curIdx = queueIsActivePool() && queuePlayingIndex.value != null
    ? queuePlayingIndex.value
    : pool.indexOf(current ?? "");
  const nextIdx = curIdx + 1;
  if (curIdx >= 0 && nextIdx < pool.length) {
    playPool(pool, nextIdx);
  } else if (repeatMode.value === "all" && pool.length > 0) {
    // Wrap to the album start; without repeat-all a next past the end is a no-op.
    playPool(pool, 0);
  }
}

// Previous: within the first few seconds of a track it steps back a track,
// otherwise it restarts the current one — the near-universal transport
// convention. Shuffle keeps no back-history, so it just restarts.
export function skipPrev(): void {
  if (isStream.value) return;
  if (currentTime.value > 3 || shuffleMode.value) {
    void engine.seekTo(0);
    return;
  }
  const current = currentNodePath.value ?? app.lastQueue[app.lastIndex] ?? null;
  const pool = poolPaths();
  // Prefer the live row index in the queue pool so a duplicated track steps back
  // from the instance actually playing, not the first path match (see skipNext).
  const curIdx = queueIsActivePool() && queuePlayingIndex.value != null
    ? queuePlayingIndex.value
    : pool.indexOf(current ?? "");
  const prevIdx = curIdx - 1;
  if (prevIdx >= 0) {
    playPool(pool, prevIdx);
  } else {
    void engine.seekTo(0);
  }
}

// Whether a manual Next would land on another track — drives only the Next
// button's enabled state (skipNext stays the sole mover). Mirrors skipNext's
// branches: shuffle always has a next (the bag refills), straight play does
// until the pool's last track unless repeat-all wraps. Streams and an idle or
// drained player have nothing ahead. Prev needs no such check: it always
// restarts or steps back, so it's live whenever a non-stream track is loaded.
export function hasNextTrack(): boolean {
  if (!hasTrack.value || isStream.value) return false;
  if (shuffleMode.value) return true;
  const pool = poolPaths();
  if (pool.length === 0) return false;
  if (repeatMode.value === "all") return true;
  const current = currentNodePath.value ?? app.lastQueue[app.lastIndex] ?? null;
  // In the queue pool, trust the live row index (positional) so a duplicated
  // track resolves to the instance playing, matching skipNext.
  const curIdx = queueIsActivePool() && queuePlayingIndex.value != null
    ? queuePlayingIndex.value
    : pool.indexOf(current ?? "");
  return curIdx >= 0 && curIdx + 1 < pool.length;
}

// `startIndex` pins the position to start at within `parent`'s tracks; callers
// that click a specific queue row pass it so a duplicated track resolves to the
// clicked instance rather than the first path match. Omitted for folder/tree
// clicks, where the node's path is unambiguous within its folder.
export function playFile(node: TreeNode, parent: TreeNode, startIndex?: number): void {
  app.currentParent = parent;
  currentNodePath.value = node.path;
  currentStreamUrl.value = null;
  isStream.value = false;
  // Playing a folder track leaves any built queue stashed; drop the live-row
  // highlight so it doesn't linger (as playStream does). A queue-row click sets
  // currentParent to the synthetic queue, where the index is restored via
  // pendingQueueIndex below and onTrackChange — so only clear off-queue. Without
  // this, replaying the same file the queue was on wouldn't change any reactive
  // dep, so the highlight effect wouldn't re-run and would keep the stale accent.
  if (!queueIsActivePool()) queuePlayingIndex.value = null;
  currentTime.value = 0;
  duration.value = 0;
  app.queueEnded = false;
  setNowPlaying(node.title ?? node.name, node.artist, node.album);
  void loadArt(node.path);
  const siblings = parent.children.filter((c) => !c.isFolder);
  const tracks = siblings.map((c) => c.path);
  if (repeatMode.value === "one") {
    // Loop this track; the album never enters the queue.
    app.shuffleBag = [];
    playSingle(node.path, startIndex);
  } else if (shuffleMode.value) {
    // One track at a time, next picked at each queue-ended. Seed the bag with
    // the rest of the album so a repeat-off cycle plays every track once.
    refillShuffleBag(node.path);
    playSingle(node.path, startIndex);
  } else {
    // Straight play. With autoadvance on, queue the rest of the album so the
    // engine auto-advances gaplessly (it treats this list as the complete queue,
    // replaced when another file is clicked); with it off, feedEngine hands over
    // only this track so playback stops at its end.
    app.shuffleBag = [];
    const idx = startIndex ?? Math.max(
      0,
      siblings.findIndex((c) => c.path === node.path),
    );
    app.lastQueue = tracks;
    app.lastIndex = idx;
    if (queueIsActivePool()) app.pendingQueueIndex = idx;
    feedEngine(tracks, idx);
  }
}

export function playStream(stream: Stream): void {
  // A stream is lone playback: dismiss any open queue/playlist and land on the
  // hero (its own face, no nav bar). Null the highlight (streams emit no
  // track-changed, so onAdvance won't).
  resetToLonePlayback();
  queuePlayingIndex.value = null;
  app.currentParent = null;
  currentNodePath.value = null;
  currentStreamUrl.value = stream.url;
  // The played station is also the selected row, so selection follows playback
  // (matching a played tree track) rather than leaving a stale prior highlight.
  selectedStreamUrl.value = stream.url;
  app.currentStreamName = stream.name;
  isStream.value = true;
  currentTime.value = 0;
  duration.value = 0;
  app.queueEnded = false;
  app.lastQueue = [];
  app.shuffleBag = [];
  // Station name until the first ICY title arrives (or forever, for stations
  // that don't send titles).
  setNowPlaying(stream.name, null, null);
  npStreamMeta.value = null;
  void engine.playStream(stream.url);
  // Stream list station art shows in the same spot as album art. Like loadArt,
  // the previous art stays up until the new image is ready (a failed or absent
  // fetch resolves to null, which clears it); stations without an image clear
  // immediately.
  if (stream.image) {
    void loadStreamArt(stream.image);
  } else {
    clearArt();
  }
}

// Plays a library file picked from the search dropdown. currentParent stays
// null so there's no album auto-advance (a search hit isn't a folder context);
// setting currentNodePath still lights up the row if that folder is expanded in
// the tree. The native engine opens the file directly — no prepare step needed.
export function playSearchTrack(t: SearchTrack): void {
  // A lone search hit is lone playback: dismiss any open queue/playlist and land
  // on the hero. currentParent is null so onAdvance won't touch the highlight.
  resetToLonePlayback();
  queuePlayingIndex.value = null;
  app.currentParent = null;
  currentNodePath.value = t.path;
  currentStreamUrl.value = null;
  isStream.value = false;
  currentTime.value = 0;
  duration.value = 0;
  app.queueEnded = false;
  app.lastQueue = [t.path];
  app.lastIndex = 0;
  app.shuffleBag = [];
  const fallbackName = t.path.split(/[\\/]/).pop() ?? t.path;
  setNowPlaying(t.title ?? fallbackName, t.artist, t.album);
  void loadArt(t.path);
  void engine.play([t.path], 0);
}

// Plays a folder chosen from the search dropdown. Fetches every track under it
// and plays them as an ad-hoc album via a synthetic parent node that stands in
// for a real tree folder, so all the existing album machinery works unchanged:
// gapless straight-through play, now-playing updates on auto-advance (onAdvance
// → siblingByPath find the child in currentParent), and shuffle/repeat. The
// node isn't part of the real tree; a later library rescan re-binds currentParent
// to the matching tree folder by path if one is loaded. Shuffle starts on a
// random track (playFile shuffles the rest); straight play starts on the first.
// A stand-in tree folder wrapping an ad-hoc track list (a searched folder, or
// an artist/album queue), so all the album machinery works unchanged: gapless
// straight-through play, now-playing on auto-advance (onAdvance → siblingByPath
// finds the child in currentParent), and shuffle/repeat. `path` is synthetic for
// artist/album queues (see openArtistQueue/openAlbumQueue), which is why the
// rescan re-bind is suppressed while a queue is active.
export function syntheticParent(
  path: string,
  name: string,
  tracks: SearchTrack[],
): TreeNode {
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
    expanded: false,
    children: tracks.map((t) => ({
      path: t.path,
      name: t.path.split(/[\\/]/).pop() ?? t.path,
      title: t.title,
      artist: t.artist,
      album: t.album,
      albumArtist: null,
      disc: null,
      track: null,
      isFolder: false,
      loaded: true,
      expanded: false,
      children: [],
    })),
  };
}

export async function playFolder(folder: SearchFolder): Promise<void> {
  let tracks: SearchTrack[];
  try {
    tracks = await invoke<SearchTrack[]>("folder_tracks", { path: folder.path });
  } catch (e) {
    console.error("folder_tracks failed", folder.path, e);
    return;
  }
  if (tracks.length === 0) return;
  // A folder is a queue the user chose to play — show it as one (list view),
  // instead of the old "secret queue" that played but stayed on the card. A
  // folder can span albums (recursive flatten), so it's text-only like an
  // artist queue, keyed on the folder path.
  playQueue(
    {
      kind: "folder",
      title: folder.name,
      subtitle: trackCountSubtitle(tracks),
      tracks,
    },
    `queue:folder:${folder.path}`,
  );
}
