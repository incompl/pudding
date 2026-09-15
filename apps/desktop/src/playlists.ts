// Playlist feature module: data/IO + play/browse, the OS Playlist menu + client
// index, rename/delete, and the "Add to playlist ▸" submenu ops. Extracted
// verbatim from main.ts (see plan.md). The shared context-menu builders that
// call these (addToPlaylistItem, show*ContextMenu) stay in main.ts.
import { invoke } from "@tauri-apps/api/core";
import { confirm, save } from "@tauri-apps/plugin-dialog";
import type {
  PlaylistData,
  SearchTrack,
  TreeNode,
  Queue,
  PlaylistRef,
  TrackProvider,
} from "./types";
import { addRecentItem, removeRecentItem, updateRecentItem } from "./recents";
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
  isPlayableRow,
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
  forgetCurationHistory,
  readPlaylist,
  writePlaylist,
  notePlaylistMtime,
  playlistChangedOnDisk,
  adoptReloadedPlaylist,
} from "./queue";
import { editInline } from "./editors";
import { playStream } from "./playback";
import {
  playQueue,
  toast,
  trackCountSubtitle,
  displayLabel,
  queueIsActivePool,
  libraryRootPaths,
  UNTITLED_PLAYLIST_TITLE,
} from "./main";

// A station's display name: the `#EXTINF` title its file gave it, else the host
// (the backend's `name` for a stream row). Not the column's usual fallback — the
// last path segment of a URL is a stream endpoint, so it is as often empty
// ("https://host/") as it is meaningful.
function rowTitle(t: { title: string | null; name: string; stream: boolean }): string | null {
  return t.stream ? (t.title ?? t.name) : t.title;
}

// The playable rows of a playlist as SearchTracks (dropping missing files),
// ready for the queue/engine machinery.
export function playlistPlayableTracks(data: PlaylistData): SearchTrack[] {
  return data.tracks
    .filter(isPlayableRow)
    .map((t) => ({
      path: t.path,
      title: rowTitle(t),
      artist: t.artist,
      album: t.album,
      albumArtist: t.albumArtist,
      disc: t.disc,
      year: t.year,
      genre: t.genre,
      duration: t.duration,
      bitrate: t.bitrate,
      sampleRate: t.sampleRate,
      bitDepth: t.bitDepth,
      gain: t.gain,
      created: t.created,
      modified: t.modified,
      // Not a filter, unlike `missing` above: a cloud track is playable, and the
      // flag rides along so the queue view marks it once the playlist is playing.
      notDownloaded: t.notDownloaded,
    }));
}

// Every row of a playlist as SearchTracks — including the rows the engine will
// never see, carried through with the flag that says why (`missing` for a file
// that's gone, `stream` for a station) so the browse view can show them, marked,
// rather than silently dropping them. Playback paths use playlistPlayableTracks
// instead, keeping the engine's pool free of dangling files.
// See playlist-plan.md "Missing / dangling tracks".
export function playlistViewTracks(data: PlaylistData): SearchTrack[] {
  return data.tracks.map((t) => ({
    path: t.path,
    title: rowTitle(t),
    artist: t.artist,
    album: t.album,
    albumArtist: t.albumArtist,
    disc: t.disc,
    year: t.year,
    genre: t.genre,
    missing: t.missing,
    stream: t.stream,
    notDownloaded: t.notDownloaded,
    duration: t.duration,
    bitrate: t.bitrate,
    sampleRate: t.sampleRate,
    bitDepth: t.bitDepth,
    gain: t.gain,
    created: t.created,
    modified: t.modified,
  }));
}

// What to say, and what to clean up, when a playlist won't open. The two cases
// need different answers: a file that is *gone* should stop haunting Open Recent,
// while one that is merely unreadable — something else wearing the extension, or
// past the ceilings read_playlist enforces — keeps its place, because it is still
// there and the user may well fix it. Asks the filesystem rather than reading the
// error text: playlist_mtime is a single stat and answers exactly that question.
async function reportPlaylistOpenFailure(path: string, e: unknown): Promise<void> {
  console.error("read_playlist failed", path, e);
  const mtime = await invoke<number | null>("playlist_mtime", { path }).catch(() => null);
  if (mtime === null) {
    removeRecentItem(path);
    toast("Playlist no longer available");
    return;
  }
  toast("Couldn't open playlist");
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
    data = await readPlaylist(path);
  } catch (e) {
    await reportPlaylistOpenFailure(path, e);
    return;
  }
  // Show every row (missing and stream rows included, marked) while playing the
  // playable ones — playQueue filters the rest out of the engine pool.
  const tracks = playlistViewTracks(data);
  const streams = tracks.filter((t) => t.stream);
  // A one-row station file *is* a station: it is the same format (see
  // parse_m3u_stream_list in lib.rs) and it is what every internet-radio link
  // hands you. Play it as what it is rather than opening a one-row playlist whose
  // only row can't join a queue.
  if (streams.length === 1 && streams.length === tracks.length) {
    playStream({ name: streams[0].title ?? data.name, url: streams[0].path });
    return;
  }
  // Nothing to play. Land in the playlist anyway — a double-click that produces
  // no visible event at all reads as a broken app, and the pane is where the user
  // can see which rows are the problem and fix them — but say which kind of
  // nothing it is, because an empty file, a list of dead paths and a list of
  // stations are three different problems with three different fixes.
  if (!tracks.some(isPlayableRow)) {
    showPlaylistBrowse(data);
    toast(
      tracks.length === 0
        ? `"${data.name}" is empty`
        : streams.length === tracks.length
          ? `"${data.name}" holds only streams`
          : `No playable tracks in "${data.name}"`,
    );
    return;
  }
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
}

// Single-click: browse the playlist (view its tracks) without changing what's
// playing. It becomes the open playlist on the list face; whatever was playing
// keeps playing underneath (see browsedPlaylist / paneView).
export async function browsePlaylist(node: TreeNode): Promise<void> {
  await browsePlaylistPath(node.path);
}

// Browse a playlist by file path (tree single-click, OS Open..., Open Recent).
// Reads and shows it as the open playlist without changing playback, and
// records it as recent.
// Flash the list-face title once, marking where a playlist search hit landed — the
// right-pane analogue of the Back-bar title flash for album/artist hits (see
// navigateTo's flashTitle). Washes just the title (not the track-count subtitle). The
// header is static DOM filled by renderQueue's effect, so defer past the reactive
// render before adding the class.
function flashPlaylistHeader(): void {
  requestAnimationFrame(() => {
    const title = document.getElementById("queue-title");
    if (!title) return;
    title.classList.remove("flash");
    void title.offsetWidth; // restart the animation if it was mid-flight
    title.classList.add("flash");
    title.addEventListener("animationend", () => title.classList.remove("flash"), {
      once: true,
    });
  });
}

export async function browsePlaylistPath(
  path: string,
  opts?: { flash?: boolean; recent?: boolean },
): Promise<void> {
  let data: PlaylistData;
  try {
    data = await readPlaylist(path);
  } catch (e) {
    await reportPlaylistOpenFailure(path, e);
    return;
  }
  showPlaylistBrowse(data, opts);
}

// Put an already-read playlist in the pane. Split from the read so a *play* that
// finds nothing playable can fall through to the browse without paying for a
// second read of the same file.
function showPlaylistBrowse(
  data: PlaylistData,
  opts?: { flash?: boolean; recent?: boolean },
): void {
  // Browse shows every row, missing files and stations included (marked,
  // unplayable-in-place) — so a playlist whose files can't be resolved doesn't
  // collapse to near-nothing. Playback (playPlaylist / Add to queue) still
  // filters them out of the pool.
  const tracks = playlistViewTracks(data);
  // We're committing to show the browse in the pane. A failed read never reaches
  // here, so it leaves any open panel up rather than clearing the pane first.
  dismissRightPanel();
  browsedPlaylist.value = {
    kind: "playlist",
    title: data.name,
    subtitle: trackCountSubtitle(tracks),
    tracks,
    sourcePath: data.path,
  };
  listFaceOpen.value = true;
  // Only an *opening* is recorded (Open..., Finder, an Open Recent row, or a
  // playlist we just created). A tree click browsing the library is not.
  if (opts?.recent) addRecentItem(data.path, data.name, "playlist");
  if (opts?.flash) flashPlaylistHeader();
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
    const data = await readPlaylist(node.path);
    if (activeQueue.value !== queueBefore) return;
    if (!queueBefore && currentNodePath.value !== pathBefore) return;
    const tracks = playlistPlayableTracks(data);
    // Both sinks return silently on an empty list, which for a playlist means a
    // queue verb that looked like it worked and did nothing. Say so instead.
    if (tracks.length === 0) {
      toast(`Nothing to add from "${data.name}"`);
      return;
    }
    sink(tracks);
  } catch (e) {
    await reportPlaylistOpenFailure(node.path, e);
  }
}

// --- OS File menu ---
// The File menu (Open... / Open Recent ▸ / New Playlist / Save Queue as Playlist /
// Move) is built in Rust and relays intents here; the frontend owns these dialogs
// and the file writes. Open... itself is the exception — it stays in Rust so the
// menu and a Finder double-click are one code path (see deliver_open_file) — and
// it takes playlists as well as audio, which is why there is no Open Playlist.


// --- Outside changes ---------------------------------------------------------

// Re-read any open playlist whose file changed on disk without us. The watcher
// supplies the prompt but not the answer — a library scan only reports that
// *something* under a root moved — so each open playlist is stat'd and only a
// disagreeing mtime costs a read.
//
// Both open copies are checked: the browsed playlist and the playing queue can be
// two different files, or one file seen twice. The playing one matters most,
// because curation autosaves — leave it stale and the user's next drag writes the
// pre-edit rows back over whatever the other app just wrote.
//
// Only reaches playlists the watcher can see, i.e. those under a library root; one
// opened from elsewhere via Open... is covered by the window-focus check that also
// calls this (see main.ts), which is the case where you'd have been editing it in
// another app anyway.
export async function reloadChangedPlaylists(): Promise<void> {
  // An inline rename owns a live text input inside the list we would rebuild, and
  // a swap here would tear it out mid-type — the same guard the scan's pane
  // refresh takes. Nothing is lost by waiting: the next scan or focus re-checks.
  if (app.inlineEditing) return;
  const paths = new Set(
    [browsedPlaylist.value, activeQueue.value]
      .filter((q): q is Queue => isPlaylistSource(q))
      .map((q) => q.sourcePath!),
  );
  for (const path of paths) {
    let mtime: number | null;
    try {
      mtime = await invoke<number | null>("playlist_mtime", { path });
    } catch (e) {
      console.error("playlist_mtime failed", path, e);
      continue;
    }
    // Gone is not changed. A deleted playlist is handled where it's noticed (the
    // tree refresh, the next play), and blanking the open pane here would be a
    // worse answer than leaving up the rows we last read.
    if (mtime === null) continue;
    if (!playlistChangedOnDisk(path, mtime)) continue;
    let data: PlaylistData;
    try {
      data = await readPlaylist(path);
    } catch (e) {
      // Unreadable for some other reason: forget the stamp so a later attempt
      // retries rather than deciding the file is settled.
      console.error("read_playlist failed", path, e);
      notePlaylistMtime(path, null);
      continue;
    }
    // Say so. The rows under the user's cursor just changed without them asking,
    // and a list that silently reorders itself reads as a bug.
    if (adoptReloadedPlaylist(path, data.name, playlistViewTracks(data))) {
      toast(`"${data.name}" changed on disk`);
    }
  }
}

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
    app.playlistIndexLoaded = true;
    refreshNavPlaylists();
    return;
  }
  try {
    // list_all_playlists is keyed to one root (it walks that tree), so scan each
    // configured folder and merge into a single index. The command is async on the
    // Rust side (spawn_blocking) so this full-tree walk never blocks the UI thread.
    const perRoot = await Promise.all(
      roots.map((root) => invoke<PlaylistRef[]>("list_all_playlists", { root })),
    );
    app.playlistIndex = perRoot.flat();
    app.playlistIndexLoaded = true;
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

// New Playlist...: save dialog → write an empty .m3u8 → open it ready to fill.
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
    await writePlaylist(path, name, []);
  } catch (e) {
    console.error("write_playlist failed", path, e);
    return;
  }
  await refreshLibrary();
  await browsePlaylistPath(path, { recent: true });
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
    await writePlaylist(path, name, q.tracks);
  } catch (e) {
    console.error("write_playlist failed", path, e);
    return;
  }
  if (activeQueue.value === q) {
    activeQueue.value = { ...q, title: name, sourcePath: path };
  }
  toast(`Saved playlist "${name}"`);
  await refreshLibrary();
  await browsePlaylistPath(path, { recent: true });
}

// Move Playlist File...: relocate the open playlist on disk (rewriting relative
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
  updateRecentItem(src, { path: dest });
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
    await writePlaylist(path, name, list.tracks);
  } catch (e) {
    console.error("write_playlist (rename) failed", path, e);
    toast("Couldn't rename playlist");
    return;
  }
  updateRecentItem(path, { name });
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
  const textEl = label.querySelector(".label-text .title");
  if (textEl) textEl.textContent = name;
  if (!(await commitPlaylistRename(path, name))) return;
  // Re-sort the tree now (deterministic, not waiting on the watcher's debounce) and
  // scroll the renamed row into view at its new position.
  app.pendingRevealPlaylistPath = path;
  await refreshLibrary();
}

// Shared write path for a playlist rename (tree rows and the Files-tab navigator).
// Keeps any open copies (browsed / active queue) and the recents list titled in
// agreement, then rewrites the #PLAYLIST: directive. Returns whether the write
// landed; each caller does its own view refresh (the tree re-sorts, the nav reloads
// its index).
async function commitPlaylistRename(path: string, name: string): Promise<boolean> {
  const retitle = (q: Queue | null): Queue | null =>
    q && q.sourcePath === path ? { ...q, title: name } : q;
  browsedPlaylist.value = retitle(browsedPlaylist.value);
  activeQueue.value = retitle(activeQueue.value);
  try {
    await invoke("rename_playlist", { path, name });
  } catch (e) {
    console.error("rename_playlist failed", path, e);
    toast("Couldn't rename playlist");
    return false;
  }
  updateRecentItem(path, { name });
  return true;
}

// Rename a playlist by path (the Files-tab navigator has only a path — no TreeNode).
// Writes the directive, then reloads the playlist index so the nav row re-sorts to
// its new alphabetical slot under the new name.
export async function renamePlaylistPath(path: string, raw: string): Promise<void> {
  const name = raw.trim() || UNTITLED_PLAYLIST_TITLE;
  if (!(await commitPlaylistRename(path, name))) return;
  await refreshPlaylistIndex();
}

// Start an inline rename on a playlist's tree row. The whole label (icon + text)
// is swapped for the edit field; commit writes the file, cancel restores as-is.
export function startTreePlaylistRename(node: TreeNode, label: HTMLElement): void {
  editInline(label, node.name, (value) => void renameTreePlaylist(node, label, value));
}

// Start an inline rename on a Files-tab navigator playlist row. Swaps the row's text
// cell for the edit field (the playlist glyph stays put, outside the cell); commit
// optimistically retitles the row in place — so it doesn't flash the old name — then
// writes the file and reloads the index, which re-sorts the row.
export function startNavPlaylistRename(host: HTMLElement, path: string, name: string): void {
  editInline(host, name, (raw) => {
    const next = raw.trim() || UNTITLED_PLAYLIST_TITLE;
    if (next === name) return;
    const primary = host.querySelector(".nav-primary");
    if (primary) primary.textContent = next;
    void renamePlaylistPath(path, next);
  });
}

// Delete a playlist file from a tree row. Thin wrapper over deletePlaylistPath.
export async function deletePlaylistNode(node: TreeNode): Promise<void> {
  await deletePlaylistPath(node.path, displayLabel(node));
}

// Delete a playlist file by path (used by the tree rows via deletePlaylistNode and
// by the Files-tab navigator, which has only a path + display name — no TreeNode).
// Confirms first (the file is removed from disk), drops it from recents, closes the
// browse if it was open, and refreshes. If the deleted playlist is the *audible*
// source, playback stops (tear down to the empty hero) — leaving it playing would
// autosave, and thus resurrect, the just-deleted file on the next curation. A merely
// *stashed* copy (a folder/stream plays over it) is dropped without disturbing that
// unrelated playback.
export async function deletePlaylistPath(path: string, name: string): Promise<void> {
  const filename = path.split(/[\\/]/).pop() ?? path;
  const ok = await confirm(`This will delete ${filename}`, {
    title: `Delete ${name}?`,
    kind: "warning",
  });
  if (!ok) return;
  try {
    await invoke("delete_playlist", { path });
  } catch (e) {
    console.error("delete_playlist failed", path, e);
    toast("Couldn't delete playlist");
    return;
  }
  removeRecentItem(path);
  // Drop any curation-undo history for the file — a lingering snapshot must not be
  // able to re-save (resurrect) it on a later ⌘Z.
  forgetCurationHistory(path);
  const active = activeQueue.value;
  const activeIsDeleted = isPlaylistSource(active) && active!.sourcePath === path;
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
  if (browsedPlaylist.value?.sourcePath === path) {
    browsedPlaylist.value = null;
    if (!activeQueue.value) listFaceOpen.value = false;
  }
  await refreshLibrary();
}

// New Playlist... from a menu: save dialog → write an .m3u8 seeded with the
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
    await writePlaylist(path, name, tracks);
  } catch (e) {
    console.error("write_playlist (new) failed", path, e);
    toast("Couldn't create playlist");
    return;
  }
  await refreshLibrary();
  await browsePlaylistPath(path, { recent: true });
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
    data = await readPlaylist(path);
  } catch (e) {
    console.error("read_playlist failed", path, e);
    toast("Couldn't open playlist");
    return;
  }
  // The file's own rows keep the `#EXTINF` values they were read with, so
  // appending to a hand-made playlist can't strip the rows already in it.
  const combined = [...data.tracks, ...tracks];
  try {
    await writePlaylist(path, data.name, combined);
  } catch (e) {
    console.error("write_playlist (append) failed", path, e);
    toast("Couldn't save playlist");
    return;
  }
  await refreshLibrary();
  toast(`Added to "${data.name}"`);
}


