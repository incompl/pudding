// Playlist feature module: data/IO + play/browse, the OS Playlist menu + client
// index, rename/delete, and the "Add to playlist ▸" submenu ops. Extracted
// verbatim from main.ts (see plan.md). The shared context-menu builders that
// call these (addToPlaylistItem, show*ContextMenu) stay in main.ts.
import { invoke } from "@tauri-apps/api/core";
import { confirm, open, save } from "@tauri-apps/plugin-dialog";
import type {
  PlaylistData,
  SearchTrack,
  TreeNode,
  Queue,
  PlaylistRef,
  TrackProvider,
} from "./types";
import {
  activeQueue,
  currentNodePath,
  browsedPlaylist,
  listFaceOpen,
  queuePlayingIndex,
  clearActiveQueue,
  isPlaylistSource,
  openPlaylistPath,
  dismissRightPanel,
  app,
} from "./state";
import { refreshLibrary } from "./library";
import { refreshNavPlaylists } from "./library-nav";
import {
  addToQueue,
  curatedList,
  insertCuratedTracks,
  appendToActivePool,
  teardownPlaybackToEmpty,
} from "./queue";
import { editInline } from "./editors";
import {
  playQueue,
  toast,
  trackCountSubtitle,
  displayLabel,
  queueIsActivePool,
  libraryRootPaths,
  UNTITLED_PLAYLIST_TITLE,
} from "./main";

// Persisted store key + cap for the Open Recent list (moved here with the
// recents ops that own them; main.ts imports KEY_RECENT_PLAYLISTS to hydrate).
export const KEY_RECENT_PLAYLISTS = "recentPlaylists";
const RECENT_PLAYLISTS_MAX = 10;

// The playable rows of a playlist as SearchTracks (dropping missing files),
// ready for the queue/engine machinery.
export function playlistPlayableTracks(data: PlaylistData): SearchTrack[] {
  return data.tracks
    .filter((t) => !t.missing)
    .map((t) => ({
      path: t.path,
      title: t.title,
      artist: t.artist,
      album: t.album,
      duration: t.duration,
    }));
}

// Every row of a playlist as SearchTracks — including missing files, carried
// through with their `missing` flag so the browse view can show them (marked,
// unplayable) rather than silently dropping them. Playback paths use
// playlistPlayableTracks instead, keeping the engine's pool free of dangling
// files. See playlist-plan.md "Missing / dangling tracks".
export function playlistViewTracks(data: PlaylistData): SearchTrack[] {
  return data.tracks.map((t) => ({
    path: t.path,
    title: t.title,
    artist: t.artist,
    album: t.album,
    missing: t.missing,
    duration: t.duration,
  }));
}

// Playlist rows use single-click = browse, double-click = play. A short timer
// disambiguates so the browse fires only when no second click follows.
// A playlist is a container, like a folder: single-click opens it (browse), just
// as clicking a folder shows its contents rather than playing them. We act on the
// first click immediately — no click/double-click disambiguation timer — because
// browsing is non-destructive, so there's nothing to lose by opening the pane
// right away. A double-click then upgrades to Play (its opening browse is
// harmless and idempotent; the play follows). This keeps the frequent action
// (open) instant and free of the latency a timer would impose.
export function attachPlaylistClicks(label: HTMLElement, node: TreeNode): void {
  label.addEventListener("click", () => void browsePlaylist(node));
  label.addEventListener("dblclick", () => void playPlaylist(node));
}

// Double-click / "Play": play the playlist from its first track. A playlist
// plays like a folder — autoadvance/shuffle/repeat-all apply — via the queue
// machinery under a `queue:playlist:` synthetic path (so it reads the Playlists
// autoadvance context). It becomes the playing source (playQueue shows the list
// face titled by its name, distinct from an ephemeral "Queue").
export async function playPlaylist(node: TreeNode): Promise<void> {
  await playPlaylistPath(node.path);
}

// Play a playlist by file path (tree double-click / "Play", or a search hit).
// Shows it as the playing source (its own list face titled by its name, distinct
// from an ephemeral "Queue").
export async function playPlaylistPath(path: string): Promise<void> {
  let data: PlaylistData;
  try {
    data = await invoke<PlaylistData>("read_playlist", { path });
  } catch (e) {
    // The file is gone (moved/deleted outside the app). Self-heal: tell the
    // user and drop it from the recents so the dead entry stops reappearing.
    console.error("read_playlist failed", path, e);
    removeRecentPlaylist(path);
    toast("Playlist no longer available");
    return;
  }
  // Show every row (missing included, marked/unplayable) while playing the
  // playable ones — playQueue filters missing out of the engine pool. Bail only
  // when nothing is playable, so an all-dangling playlist doesn't open a dead queue.
  const tracks = playlistViewTracks(data);
  if (tracks.every((t) => t.missing)) return;
  playQueue(
    {
      kind: "playlist",
      title: data.name,
      subtitle: trackCountSubtitle(tracks),
      tracks,
      sourcePath: data.path,
    },
    `queue:playlist:${path}`,
  );
  addRecentPlaylist(data.path, data.name);
}

// Single-click: browse the playlist (view its tracks) without changing what's
// playing. It becomes the open playlist on the list face; whatever was playing
// keeps playing underneath (see browsedPlaylist / paneView).
export async function browsePlaylist(node: TreeNode): Promise<void> {
  await browsePlaylistPath(node.path);
}

// Browse a playlist by file path (tree single-click, OS Open…, Open Recent).
// Reads and shows it as the open playlist without changing playback, and
// records it as recent.
export async function browsePlaylistPath(path: string): Promise<void> {
  let data: PlaylistData;
  try {
    data = await invoke<PlaylistData>("read_playlist", { path });
  } catch (e) {
    // The file is gone (moved/deleted outside the app). Self-heal: tell the
    // user and drop it from the recents so the dead entry stops reappearing.
    console.error("read_playlist failed", path, e);
    removeRecentPlaylist(path);
    toast("Playlist no longer available");
    return;
  }
  // Browse shows every row, missing files included (marked, unplayable) — so a
  // playlist whose files can't be resolved doesn't collapse to near-nothing.
  // Playback (playPlaylist / Add to queue) still filters missing.
  const tracks = playlistViewTracks(data);
  // The read succeeded and we're committing to show the browse in the pane; a
  // failed read above bails without a pane change, so it leaves any panel up.
  dismissRightPanel();
  browsedPlaylist.value = {
    kind: "playlist",
    title: data.name,
    subtitle: trackCountSubtitle(tracks),
    tracks,
    sourcePath: data.path,
  };
  listFaceOpen.value = true;
  addRecentPlaylist(data.path, data.name);
}

// `sink` is the terminal verb — addToQueue (default) or playNext — so both share
// the snapshot guard.
export async function addPlaylistToQueue(
  node: TreeNode,
  sink: (tracks: SearchTrack[]) => void = addToQueue,
): Promise<void> {
  const queueBefore = activeQueue.value;
  const pathBefore = currentNodePath.value;
  try {
    const data = await invoke<PlaylistData>("read_playlist", { path: node.path });
    if (activeQueue.value !== queueBefore) return;
    if (!queueBefore && currentNodePath.value !== pathBefore) return;
    sink(playlistPlayableTracks(data));
  } catch (e) {
    console.error("read_playlist failed", node.path, e);
    toast("Playlist no longer available");
  }
}

// --- OS Playlist menu ---
// The Playlist menu (New / Open… / Open Recent ▸ / Save Queue as Playlist / Move) is
// built in Rust and relays intents here; the frontend owns the dialogs, file
// writes, and the recents list (persisted in the settings store, mirrored into
// the native Open Recent submenu via set_recent_playlists).



// --- Playlist index (phase 4) ---
// Every `.m3u/.m3u8` under the library root — path + display name — backing the
// "Add to playlist ▸" submenu and searchable playlists. Built from Rust's
// `list_all_playlists` and kept fresh by the filesystem watcher (refreshLibrary
// runs on every library change, our own writes included). Read synchronously
// when a context menu is built, so the submenu reflects the current library.


export async function refreshPlaylistIndex(): Promise<void> {
  const roots = libraryRootPaths();
  if (roots.length === 0) {
    app.playlistIndex = [];
    refreshNavPlaylists();
    return;
  }
  try {
    // list_all_playlists is keyed to one root (it walks that tree), so scan each
    // configured folder and merge into a single index.
    const perRoot = await Promise.all(
      roots.map((root) => invoke<PlaylistRef[]>("list_all_playlists", { root })),
    );
    app.playlistIndex = perRoot.flat();
  } catch (e) {
    console.error("list_all_playlists failed", e);
  }
  // Keep the navigator's root-menu playlist list in step with the index.
  refreshNavPlaylists();
}

// The filename stem (no extension) — the display name for a freshly saved file
// before it carries a #PLAYLIST: directive of its own.
export function playlistNameFromPath(path: string): string {
  const base = path.split("/").pop() ?? path;
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  return stem || "Untitled";
}

// Default directory for a save dialog: the first library folder when set, else
// let the OS pick. Used so New / Save-as land in the library by default.
export function defaultPlaylistDir(): string | null {
  return libraryRootPaths()[0] ?? null;
}

export async function persistRecentPlaylists(): Promise<void> {
  await app.store.set(KEY_RECENT_PLAYLISTS, app.recentPlaylists);
  await app.store.save();
}

// Push a playlist to the front of the recents (most-recent first, deduped by
// path, capped), persist, and rebuild the native Open Recent submenu.
export function addRecentPlaylist(path: string, name: string): void {
  app.recentPlaylists = [
    { path, name },
    ...app.recentPlaylists.filter((r) => r.path !== path),
  ].slice(0, RECENT_PLAYLISTS_MAX);
  void persistRecentPlaylists();
  syncRecentPlaylistsMenu();
}

export function removeRecentPlaylist(path: string): void {
  app.recentPlaylists = app.recentPlaylists.filter((r) => r.path !== path);
  void persistRecentPlaylists();
  syncRecentPlaylistsMenu();
}

export function syncRecentPlaylistsMenu(): void {
  void invoke("set_recent_playlists", { items: app.recentPlaylists });
}

// New Playlist…: save dialog → write an empty .m3u8 → open it ready to fill.
export async function menuNewPlaylist(): Promise<void> {
  const dir = defaultPlaylistDir();
  const path = await save({
    title: "New Playlist",
    defaultPath: dir ? `${dir}/Untitled.m3u8` : "Untitled.m3u8",
    filters: [{ name: "Playlist", extensions: ["m3u8"] }],
  });
  if (!path) return;
  const name = playlistNameFromPath(path);
  try {
    await invoke("write_playlist", { path, name, tracks: [] });
  } catch (e) {
    console.error("write_playlist failed", path, e);
    return;
  }
  await refreshLibrary();
  await browsePlaylistPath(path);
}

// Open…: native dialog filtered to playlists; may live outside the library.
export async function menuOpenPlaylist(): Promise<void> {
  const selected = await open({
    directory: false,
    multiple: false,
    defaultPath: defaultPlaylistDir() ?? undefined,
    filters: [{ name: "Playlist", extensions: ["m3u", "m3u8"] }],
  });
  if (typeof selected === "string") await browsePlaylistPath(selected);
}

// Save Queue as Playlist (⌘S): convert the ephemeral queue into an autosaving
// playlist source. Guarded to an ephemeral queue that's the active pool (the menu
// item is also disabled otherwise); the native path picker chooses the file.
export async function menuSavePlaylist(): Promise<void> {
  if (!queueCanSaveAsPlaylist()) return;
  const dir = defaultPlaylistDir();
  const path = await save({
    title: "Save Queue as Playlist",
    defaultPath: dir ? `${dir}/Untitled.m3u8` : "Untitled.m3u8",
    filters: [{ name: "Playlist", extensions: ["m3u8"] }],
  });
  if (!path) return;
  await saveQueueAsPlaylist(path);
}

// True when the active pool is an ephemeral queue that can be promoted to a file
// (not already a playlist source). Gates both the menu item and the save flow.
export function queueCanSaveAsPlaylist(): boolean {
  const q = activeQueue.value;
  return !!q && !isPlaylistSource(q) && queueIsActivePool();
}

// Write the live queue to `path`, then repoint it at that file so it becomes an
// autosaving playlist source: from here on curations flow to disk (saveOpenPlaylist
// keys off sourcePath). kind is already "playlist"; we adopt the saved name too.
// Guard against a queue swap during the write. The browse at the end opens with
// the same sourcePath, so the two are recognised as one pool rather than diverging.
export async function saveQueueAsPlaylist(path: string): Promise<void> {
  const q = activeQueue.value;
  if (!q || isPlaylistSource(q) || !queueIsActivePool()) return;
  const name = playlistNameFromPath(path);
  try {
    await invoke("write_playlist", { path, name, tracks: q.tracks.map((t) => t.path) });
  } catch (e) {
    console.error("write_playlist failed", path, e);
    return;
  }
  if (activeQueue.value === q) {
    activeQueue.value = { ...q, title: name, sourcePath: path };
  }
  toast(`Saved playlist "${name}"`);
  await refreshLibrary();
  await browsePlaylistPath(path);
}

// Move Playlist File…: relocate the open playlist on disk (rewriting relative
// paths against the new location), then re-open it there.
export async function menuMovePlaylist(): Promise<void> {
  const src = openPlaylistPath();
  if (!src) {
    toast("Open a playlist to move it");
    return;
  }
  const dest = await save({
    title: "Move Playlist File",
    defaultPath: src,
    filters: [{ name: "Playlist", extensions: ["m3u8"] }],
  });
  if (!dest || dest === src) return;
  try {
    await invoke("move_playlist", { oldPath: src, newPath: dest });
  } catch (e) {
    console.error("move_playlist failed", src, dest, e);
    toast("Couldn't move playlist");
    return;
  }
  // Redirect the playing source (if it's the moved playlist) at its new path, so a
  // later curation autosaves to the new location instead of resurrecting the old
  // one. The browse is re-opened at dest below; this covers the playing copy, which
  // browsePlaylistPath doesn't touch.
  const active = activeQueue.value;
  if (isPlaylistSource(active) && active!.sourcePath === src) {
    activeQueue.value = { ...active!, sourcePath: dest };
  }
  removeRecentPlaylist(src);
  await refreshLibrary();
  await browsePlaylistPath(dest);
}

// --- Rename / delete (phase 3) ---

// Rename the open playlist from the header pencil. The `#PLAYLIST:` directive is
// the only thing that changes — the file never moves — so this rewrites the
// directive + rows in place and refreshes the tree label. Guards an empty name to
// the placeholder (never a nameless playlist).
export async function renameOpenPlaylist(input: string): Promise<void> {
  const list = curatedList();
  if (!list?.sourcePath) return;
  const path = list.sourcePath;
  const name = input.trim() || UNTITLED_PLAYLIST_TITLE;
  if (name === list.title) return;
  // Update whichever open copies point at this file so the header/tree agree
  // without a re-read.
  const retitle = (q: Queue | null): Queue | null =>
    q && q.sourcePath === path ? { ...q, title: name } : q;
  browsedPlaylist.value = retitle(browsedPlaylist.value);
  activeQueue.value = retitle(activeQueue.value);
  try {
    await invoke("write_playlist", { path, name, tracks: list.tracks.map((t) => t.path) });
  } catch (e) {
    console.error("write_playlist (rename) failed", path, e);
    toast("Couldn't rename playlist");
    return;
  }
  addRecentPlaylist(path, name);
  await refreshLibrary();
}

// Rename a playlist from its tree row (context menu → Rename). Runs after the edit
// input has already closed (see editInline.finish), so a renderTree here is safe —
// no live input to tear out. It optimistically retitles the row in place to avoid
// a flash of the old name, writes the directive, then refreshes so the row re-sorts
// to its new alphabetical slot; refreshLibrary follows it there (pendingReveal).
export async function renameTreePlaylist(node: TreeNode, label: HTMLElement, raw: string): Promise<void> {
  const name = raw.trim() || UNTITLED_PLAYLIST_TITLE;
  if (name === node.name) return;
  const path = node.path;
  // Optimistic in-place update: the node model and the row's own text, so the new
  // name shows immediately in the row's current position until the refresh re-sorts.
  node.name = name;
  const textEl = label.querySelector(".label-text");
  if (textEl) textEl.textContent = name;
  // Keep any open copies (browsed / active queue) titled in agreement without a re-read.
  const retitle = (q: Queue | null): Queue | null =>
    q && q.sourcePath === path ? { ...q, title: name } : q;
  browsedPlaylist.value = retitle(browsedPlaylist.value);
  activeQueue.value = retitle(activeQueue.value);
  try {
    await invoke("rename_playlist", { path, name });
  } catch (e) {
    console.error("rename_playlist failed", path, e);
    toast("Couldn't rename playlist");
    return;
  }
  addRecentPlaylist(path, name);
  // Re-sort the tree now (deterministic, not waiting on the watcher's debounce) and
  // scroll the renamed row into view at its new position.
  app.pendingRevealPlaylistPath = path;
  await refreshLibrary();
}

// Start an inline rename on a playlist's tree row. The whole label (icon + text)
// is swapped for the edit field; commit writes the file, cancel restores as-is.
export function startTreePlaylistRename(node: TreeNode, label: HTMLElement): void {
  editInline(label, node.name, (value) => void renameTreePlaylist(node, label, value));
}

// Delete a playlist file from the tree. Confirms first (the file is removed from
// disk), drops it from recents, closes the browse if it was open, and refreshes.
// If the deleted playlist is the *audible* source, playback stops (tear down to
// the empty hero) — leaving it playing would autosave, and thus resurrect, the
// just-deleted file on the next curation. A merely *stashed* copy (a folder/stream
// plays over it) is dropped without disturbing that unrelated playback.
export async function deletePlaylistNode(node: TreeNode): Promise<void> {
  const name = displayLabel(node);
  const filename = node.path.split(/[\\/]/).pop() ?? node.path;
  const ok = await confirm(`This will delete ${filename}`, {
    title: `Delete ${name}?`,
    kind: "warning",
  });
  if (!ok) return;
  try {
    await invoke("delete_playlist", { path: node.path });
  } catch (e) {
    console.error("delete_playlist failed", node.path, e);
    toast("Couldn't delete playlist");
    return;
  }
  removeRecentPlaylist(node.path);
  const active = activeQueue.value;
  const activeIsDeleted = isPlaylistSource(active) && active!.sourcePath === node.path;
  if (activeIsDeleted && queueIsActivePool()) {
    // The deleted playlist is the audible pool: stop and clear playback entirely.
    teardownPlaybackToEmpty();
  } else if (activeIsDeleted) {
    // A merely stashed copy (a folder/stream plays over it): drop it so a later
    // curation can't rewrite (resurrect) the file; that playback continues.
    clearActiveQueue();
    queuePlayingIndex.value = null;
  }
  // If we were browsing the deleted file, close the browse. (An unrelated browse
  // of a different playlist is left open.)
  if (browsedPlaylist.value?.sourcePath === node.path) {
    browsedPlaylist.value = null;
    if (!activeQueue.value) listFaceOpen.value = false;
  }
  await refreshLibrary();
}

// New Playlist… from a menu: save dialog → write an .m3u8 seeded with the
// clicked tracks → browse it (playback untouched) as confirmation.
export async function newPlaylistWithTracks(getTracks: TrackProvider): Promise<void> {
  const tracks = await getTracks();
  const dir = defaultPlaylistDir();
  const path = await save({
    title: "New Playlist",
    defaultPath: dir ? `${dir}/Untitled.m3u8` : "Untitled.m3u8",
    filters: [{ name: "Playlist", extensions: ["m3u8"] }],
  });
  if (!path) return;
  const name = playlistNameFromPath(path);
  try {
    await invoke("write_playlist", { path, name, tracks: tracks.map((t) => t.path) });
  } catch (e) {
    console.error("write_playlist (new) failed", path, e);
    toast("Couldn't create playlist");
    return;
  }
  await refreshLibrary();
  await browsePlaylistPath(path);
}

// Append tracks to an existing playlist. If it's the open list (browsed or the
// playing source), route through the in-memory list + autosave; otherwise read
// the file, append the new paths, and write it back.
export async function addTracksToPlaylist(path: string, getTracks: TrackProvider): Promise<void> {
  const tracks = await getTracks();
  if (tracks.length === 0) return;
  const open = curatedList();
  if (open?.sourcePath === path) {
    // The open list is the target: append in memory (applyCuration autosaves and
    // reconciles playback when it's the live pool) — never a second file write.
    insertCuratedTracks(tracks, open.tracks.length);
    toast(`Added to "${open.title}"`);
    return;
  }
  // The target isn't the *visible* list, but it may still be the live playing
  // pool — you can browse one playlist while a different one plays. curatedList()
  // is browsed-first, so it misses that case; append to the active pool directly
  // so the in-memory pool, the engine, and the file all stay in sync. Skipping
  // this lets a later curation autosave the stale pool back over the add (#3).
  const active = activeQueue.value;
  if (isPlaylistSource(active) && active!.sourcePath === path) {
    appendToActivePool(active!, tracks);
    toast(`Added to "${active!.title}"`);
    return;
  }
  // Closed file: read the current rows (missing included, to round-trip), append
  // the new paths, and rewrite.
  let data: PlaylistData;
  try {
    data = await invoke<PlaylistData>("read_playlist", { path });
  } catch (e) {
    console.error("read_playlist failed", path, e);
    toast("Couldn't open playlist");
    return;
  }
  const combined = [...data.tracks.map((t) => t.path), ...tracks.map((t) => t.path)];
  try {
    await invoke("write_playlist", { path, name: data.name, tracks: combined });
  } catch (e) {
    console.error("write_playlist (append) failed", path, e);
    toast("Couldn't save playlist");
    return;
  }
  await refreshLibrary();
  toast(`Added to "${data.name}"`);
}

// Loads the root menu's playlist section. list_all_playlists is keyed to one
// library folder (it walks that tree), so scan each and merge; yields nothing
// until a library folder is set.
export async function loadAllPlaylists(): Promise<PlaylistRef[]> {
  const roots = libraryRootPaths();
  if (roots.length === 0) return [];
  const perRoot = await Promise.all(
    roots.map((root) => invoke<PlaylistRef[]>("list_all_playlists", { root })),
  );
  return perRoot.flat();
}

