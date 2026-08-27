import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  getCurrentWindow,
  LogicalSize,
  PhysicalPosition,
} from "@tauri-apps/api/window";
import { load, type Store } from "@tauri-apps/plugin-store";
import { confirm, open, save } from "@tauri-apps/plugin-dialog";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { signal, computed, effect, type Signal } from "@preact/signals-core";
import { GaplessEngine } from "./audio-engine";
import { h } from "./dom";
import { maybeStartE2eBridge } from "./e2e-bridge";
import { initLibraryNav, popNavToRoot, refreshNavPlaylists, reloadNavView, renderNav, type NavStep } from "./library-nav";

const STORE_FILE = "settings.json";
const KEY_LIBRARY_ROOTS = "libraryRoots";
// Value stays "manifestPath" (the pre-rename key) so existing saved settings survive.
const KEY_STREAM_LIST_PATH = "manifestPath";
const KEY_SPLITTER_WIDTH = "splitterWidth";
const KEY_VOLUME = "volume";
// Window size is remembered per layout mode so the double-click toggle can
// restore the size you last used in the *other* mode.
const KEY_WINDOW_SIZE_NORMAL = "windowSizeNormal";
const KEY_WINDOW_SIZE_MINI = "windowSizeMini";
const KEY_WINDOW_POSITION = "windowPosition";
// Autoadvance: one global preference (does playback flow track-to-track, or stop
// after each?). Lives in the OS Playback menu, not the app UI. Was once split by
// context (file tree vs. playlists), but that context turned into six library
// lenses + playlists; a single global toggle keeps the behavior predictable
// without any "which context am I in?" reasoning. KEY_AUTOADVANCE_FILES is read
// once at load to migrate the old browsing setting; the new key supersedes both.
const KEY_AUTOADVANCE = "autoadvance";
const KEY_AUTOADVANCE_FILES = "autoadvanceFiles"; // legacy, migrated on load
// Playback modes remembered across launches, like every mainstream player.
const KEY_SHUFFLE = "shuffleMode";
const KEY_REPEAT = "repeatMode";

// Recently opened playlists for the OS "Open Recent ▸" submenu (most-recent
// first, capped). Persisted so the list survives restarts.
const KEY_RECENT_PLAYLISTS = "recentPlaylists";
const RECENT_PLAYLISTS_MAX = 10;

// The user's last place in the Files-tab navigator (the serialized drill stack),
// restored on launch so browse/songs/artists/albums drill-downs survive a restart.
const KEY_NAV_LOCATION = "navLocation";

// The open sidebar tab (Files/Streams), restored on launch so a Streams-focused
// user isn't bounced back to Files every start.
const KEY_ACTIVE_TAB = "activeTab";

// Below this logical (CSS-px) height the layout collapses to the mini player.
// Mirrors the `max-height` breakpoint in styles.css — keep the two in sync.
const MINI_MAX_HEIGHT = 480;
const DEFAULT_NORMAL_SIZE = { width: 800, height: 600 };
const DEFAULT_MINI_SIZE = { width: 367, height: 168 };

interface FileEntry {
  name: string;
  title: string | null;
  artist: string | null;
  album: string | null;
  // Raw ALBUMARTIST tag; combined as albumArtist ?? artist to form the album
  // grouping key for "go to album". See the backend's album_tracks.
  albumArtist: string | null;
  disc: number | null;
  track: number | null;
}

interface TrackMeta {
  title: string | null;
  artist: string | null;
  album: string | null;
}

interface DirListing {
  folders: string[];
  files: FileEntry[];
  playlists: PlaylistListing[];
}

// A .m3u/.m3u8 in a folder: `file` is the basename (joined to the parent path),
// `name` the display name (#PLAYLIST: directive or filename stem).
interface PlaylistListing {
  file: string;
  name: string;
}

interface TreeNode {
  path: string;
  name: string;
  title: string | null;
  artist: string | null;
  album: string | null;
  albumArtist: string | null;
  disc: number | null;
  track: number | null;
  isFolder: boolean;
  // True for a .m3u/.m3u8 row. A playlist is a *source* like a folder, not a
  // track: its own icon and click action (single-click browses, double-click
  // plays), and it never enters the audio-tag/album-sort path. Optional so the
  // many track/folder node literals don't each have to set it.
  isPlaylist?: boolean;
  loaded: boolean;
  expanded: boolean;
  children: TreeNode[];
}

interface Stream {
  name: string;
  url: string;
  // Optional station art from the stream list (#EXTINF tvg-logo): an http(s) or file:// URL.
  image?: string | null;
}

export interface SearchTrack {
  path: string;
  title: string | null;
  artist: string | null;
  album: string | null;
  // The file's metadata track number, carried only where a within-album ordinal
  // is meaningful (album_tracks) so the gutter can show the real number like the
  // browse tree; null for flat lists (Songs, search), which show a positional
  // index instead. See renderLeafTrackList.
  track?: number | null;
  // Set only for playlist browse rows whose file is absent on disk: shown in the
  // view (marked, per the plan's "keep the row") but never handed to the engine.
  missing?: boolean;
  // Track length in seconds (absent/null when unknown). Not shown per-row; summed
  // to display a total runtime beside a queue/playlist's track count.
  duration?: number | null;
}

interface SearchFolder {
  path: string;
  name: string;
}

export interface SearchArtist {
  name: string;
}

// An album is (name, album artist) — the grouping key from the backend, where
// `artist` is the album artist (ALBUMARTIST tag, else the track artist).
export interface SearchAlbum {
  album: string;
  artist: string;
}

// Discriminated rows shown in the search dropdown: artists and albums, library
// folders and files (all from the SQLite metadata cache), and stream list streams
// (filtered client-side).
type SearchItem =
  | { kind: "artist"; artist: SearchArtist }
  | { kind: "album"; album: SearchAlbum }
  | { kind: "folder"; folder: SearchFolder }
  | { kind: "file"; track: SearchTrack }
  | { kind: "playlist"; playlist: PlaylistRef }
  | { kind: "stream"; stream: Stream };

// --- Queue ---
//
// An immutable, ordered list of tracks that playback advances through, shown as
// a list in the right pane (replacing the now-playing card). Today the only
// sources are artist and album pages; the `kind` discriminant and the standalone
// Queue shape leave room for a future mutable "playlist" kind without reworking
// the view or the advancement logic — which already treats poolPaths() (the
// current synthetic parent's children) as "the queue".
export type QueueKind = "artist" | "album" | "folder" | "playlist";

interface Queue {
  kind: QueueKind;
  title: string; // header line: the queue/playlist name (artist, album, folder…)
  subtitle: string | null; // always a track count
  tracks: SearchTrack[];
  // For a playlist source (kind === "playlist"): the `.m3u8` file path. Lets the
  // OS menu act on the open playlist (Move Playlist File…). Absent for ephemeral
  // queues and other sources.
  sourcePath?: string;
}

// Header for a queue the user builds by hand (Add to queue), as opposed to one
// opened from a fixed source (Play artist/album/folder). Deliberately NOT named
// after any track: the contents change as more are added, so a track-derived
// title would drift. Placeholder framing ("Untitled") anticipates saving it as a
// named playlist later.
const UNTITLED_PLAYLIST_TITLE = "Untitled";

// Human runtime for a queue/playlist total. Rounds to whole minutes past a
// minute ("1 hr 32 min", "47 min"); a sub-minute total (a single short track)
// shows seconds so it isn't misreported as "0 min".
function formatRuntime(seconds: number): string {
  const total = Math.round(seconds);
  if (total < 60) return `${total} sec`;
  const mins = Math.round(total / 60);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h} hr` : `${h} hr ${m} min`;
}

// The subtitle under a queue/playlist header: the track count, plus the summed
// runtime when durations are known ("24 tracks, 1 hr 32 min"). The runtime is
// omitted entirely if no row carries a duration (e.g. an all-out-of-library
// playlist), so the count never sits beside a bogus "0 min".
function trackCountSubtitle(tracks: SearchTrack[]): string {
  const n = tracks.length;
  const count = `${n} track${n === 1 ? "" : "s"}`;
  let secs = 0;
  for (const t of tracks) if (t.duration) secs += t.duration;
  return secs > 0 ? `${count}, ${formatRuntime(secs)}` : count;
}

interface ScanResult {
  ok: boolean;
  error: string | null;
}

// --- Reactive state ---

const hasTrack = signal(false);
const npTitle = signal("");
const npArtist = signal<string | null>(null);
const npAlbum = signal<string | null>(null);
const npArt = signal<string | null>(null);
// ICY now-playing (song + artist) shown under the station name during
// streams. Null until the first title arrives (or forever, for stations that
// never send one); the block is absolutely positioned so its arrival never
// shifts the station name.
const npStreamMeta = signal<{ song: string; artist: string | null } | null>(
  null,
);

const isStream = signal(false);
const isPlaying = signal(false);
const currentTime = signal(0);
const duration = signal(0);
const volume = signal(1);
const volumePopoverOpen = signal(false);

const currentNodePath = signal<string | null>(null);
const currentStreamUrl = signal<string | null>(null);
// The stream row highlighted by a single click — a select, not a commit. Mirrors
// the tree's select-on-click (play is the hover button or a double-click), so a
// click can preview which station you're about to start without interrupting
// what's already playing.
const selectedStreamUrl = signal<string | null>(null);

const settingsOpen = signal(false);
const activeTab = signal<"files" | "streams">("files");

// The playing *source* as a navigable list: an ephemeral queue (Play
// folder/album/artist, Add to queue) or a *played* playlist (kind "playlist"
// with a sourcePath). Null when a lone track / stream plays with no queue. This
// is what's playing (or stashed while something else plays); it is distinct from
// `browsedPlaylist` below — a playlist you're merely *looking at* changes no
// playback. Together they feed the two-face right pane (see paneView).
const activeQueue = signal<Queue | null>(null);

// Named for intent at the call sites; both just set `activeQueue`.
function openActiveQueue(queue: Queue): void {
  activeQueue.value = queue;
}
function clearActiveQueue(): void {
  activeQueue.value = null;
}

// A playlist opened for *browsing* only — single-click in the tree, OS Open… /
// Open Recent, or New Playlist. Viewing/curating it never changes playback: a
// queue can keep playing (as `activeQueue`) while you look at a playlist here.
// Playing *from* it (double-click, or clicking a row) is the commit that makes
// it the source — moving it into `activeQueue` and clearing this.
const browsedPlaylist = signal<Queue | null>(null);

// Which face fills the right pane: true = the list face (the queue or the open
// playlist), false = the now-playing hero. Only meaningful when a list exists
// (see paneView); the CSS falls back to the hero otherwise.
const listFaceOpen = signal(false);

// A Queue is a *real playlist* (a backing .m3u8 file) iff it carries a
// sourcePath. The `kind` field is overloaded — ephemeral queues seeded by hand
// also use kind "playlist" — so path presence, not kind, is the true test.
function isPlaylistSource(q: Queue | null | undefined): boolean {
  return q?.sourcePath != null;
}

// The list the list-face shows — a browsed playlist wins over the playing source
// (you can browse a playlist while a queue plays underneath) — is derived, along
// with everything else the right pane renders, by `paneView`.

// The open playlist file the OS menu acts on (Move Playlist File…): the one
// being browsed, else the one playing.
function openPlaylistPath(): string | undefined {
  if (isPlaylistSource(browsedPlaylist.value)) return browsedPlaylist.value!.sourcePath;
  if (isPlaylistSource(activeQueue.value)) return activeQueue.value!.sourcePath;
  return undefined;
}

// Swap to the list face (reveals the queue / open playlist).
function showListFace(): void {
  listFaceOpen.value = true;
}

// Swap to the now-playing hero. Leaving the list abandons any *browsed*
// playlist: the back button is source-anchored — you re-reach a merely-browsed
// playlist from the tree, never from the hero (which returns to what's playing).
// The queue stays put (still playing / stashed), so the hero's nav bar still
// offers to show it.
function showHeroFace(): void {
  listFaceOpen.value = false;
  browsedPlaylist.value = null;
}

// Leave a browsed playlist for the playing source's own list, staying on the
// list face (unlike showHeroFace, which flips to the hero). Lets you jump
// straight from a playlist you're eyeing to the queue/playlist that's playing.
function showSourceList(): void {
  browsedPlaylist.value = null;
  listFaceOpen.value = true;
}

// A lone playback — a tree track, stream, search hit, external file, or idle
// play — is bare continuation: the track (its album under the hood) becomes the
// whole story. It dismisses any open queue/playlist entirely, so the pane is the
// hero alone with no nav bar. Distinct from showHeroFace (the nav bar's flip),
// which keeps the queue. Callers repoint the engine themselves (playFile /
// playStream / …), so dropping the queue here is state-only.
function resetToLonePlayback(): void {
  clearActiveQueue();
  browsedPlaylist.value = null;
  listFaceOpen.value = false;
}

// The queue row currently playing, or null when playback is outside the queue
// (folder autoplay, a lone search/external track, or a stream). Not a boolean
// "am I in the queue" flag: a queue can hold the same track at several rows, so
// only an index can say which instance is live — driving the single-row
// highlight (and, at rest after the queue drains, the absence of one). The
// queue and folder autoplay are fully independent: normal playback never flows
// into the queue on its own; the only way to play the queue is to play from it
// (a queue row, or Play folder/album/artist). Whether the queue is the *audible
// pool* — for Close's teardown and the play-restart — is read from
// `queueIsActivePool()` (the synthetic `queue:` parent), not from this index,
// which goes null while the drained queue rests.
const queuePlayingIndex = signal<number | null>(null);

// A queue is the engine's active pool iff currentParent is one of the synthetic
// `queue:` parents (real folders are filesystem paths). Distinguishes "the queue
// is playing / rests at its end" from "a queue is merely stashed while a folder,
// stream, or lone track plays".
function queueIsActivePool(): boolean {
  return currentParent?.path.startsWith("queue:") ?? false;
}

// Playback-mode controls (files view only): Shuffle (on/off) and Repeat, a
// three-state cycle matching every mainstream player — off (play through and
// stop), all (loop the album), one (loop the current track).
//
// The native engine plays a queue straight through and reports when it drains
// (onQueueEnded); shuffle and repeat live entirely here. Straight play hands the
// whole album to the engine for gapless auto-advance; shuffle and repeat-one
// hand one track at a time and pick the next at each queue-ended — which is also
// why shuffle gets an ordinary track gap (no gapless), desirable since
// crossfading random tracks is worse, not better. Turning a per-track mode on
// mid-album drops the engine's queued tail (audio_clear_upcoming) so it engages
// at the current track's end without restarting what's playing.
type RepeatMode = "off" | "all" | "one";
const shuffleMode = signal(false);
const repeatMode = signal<RepeatMode>("off");

// Autoadvance: when a track ends, does playback flow on to the next one? A single
// global, persistent preference (not a per-play choice), set from the OS Playback
// menu, never the app UI. Defaults on, matching what a media player is expected to
// do. When off, the engine is only ever handed the current track (never its tail),
// so gapless prep has nothing to advance into and handleEnded stops at each
// track's end. See applyAutoadvance.
const autoadvance = signal(true);

// Whether playback flows to the next track. One global setting now — no context
// branching. Read at each advancement point and each engine hand-off.
function autoadvanceEnabled(): boolean {
  return autoadvance.value;
}
// Whether a library root has been configured at all. When false the whole Files
// panel is replaced by a get-started prompt (see the files-empty effect) rather
// than showing an empty lens springboard the user can't do anything with.
const libraryRootSet = signal(false);
const streamListPathValid = signal(true);
// Whether a stream list path has been configured. When false the Streams panel is
// replaced by the same get-started prompt (see the streams-empty effect).
const streamListPathSet = signal(false);
// Whether the current stream list can be written to — true only for a valid
// local file (a remote http(s) list is read-only here). Gates the Add-station
// button: adding appends to the file, which a remote list has no path for.
const streamListWritable = signal(false);
// Whether the file tree has at least one top-level entry to start from. Drives
// the idle play button: with content, an idle play "starts the library" (plays
// the first entry) instead of sitting disabled, so the button reads ready-to-go.
const libraryHasContent = signal(false);

// --- Helpers ---

function displayLabel(node: TreeNode): string {
  if (node.isFolder) return node.name;
  if (node.title) {
    return node.artist ? `${node.artist} - ${node.title}` : node.title;
  }
  return node.name;
}

function joinPath(parent: string, child: string): string {
  return parent.endsWith("/") ? parent + child : parent + "/" + child;
}

function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number): (...args: A) => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (...args: A) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

function formatTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) seconds = 0;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function isTextInputTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.tagName === "TEXTAREA" || target.isContentEditable) return true;
  if (target instanceof HTMLInputElement) {
    const type = target.type.toLowerCase();
    return type === "text" || type === "search" || type === "url" ||
      type === "email" || type === "password" || type === "tel" || type === "number";
  }
  return false;
}

function setEmpty(container: HTMLElement, message: string, kind: "empty" | "loading" = "empty"): void {
  container.innerHTML = "";
  container.appendChild(
    h("div", {
      class: kind === "loading" ? "loading-state" : "empty-state",
      text: message,
    }),
  );
}

// --- Module state (non-reactive) ---

let store: Store;
let rootNode: TreeNode | null = null;

// The configured library folders (source of truth). The tree is built from
// these: one root shows its contents at top level; two or more each show as a
// top-level folder under a synthetic virtual rootNode (see refreshTree). Edited
// by the Settings library-roots rows.
let libraryRoots: string[] = [];

// Library folders whose list_dir failed (missing / unreadable). Their Settings
// rows show the .invalid outline. Recomputed by refreshTree; read by
// renderLibraryRootRows. Not reactive — refreshTree re-renders the rows itself.
let invalidLibraryRoots = new Set<string>();

// The configured library folders, as an array. rootNode.path is a per-node
// concept (empty for the virtual root), so anything that means "the library
// root(s)" — playlist scanning, default save dir, search context — reads this.
function libraryRootPaths(): string[] {
  return libraryRoots;
}

// --- File-tree multi-select ---
//
// A set of selected *track* paths (files only — folders and playlists are
// sources, not selectable rows). Cmd/Ctrl-click toggles a track; Shift-click
// extends a contiguous range from the anchor over the visible track order; a
// plain click plays and drops the selection down to a bare (unhighlighted)
// anchor. So the highlight only ever shows a *deliberate* selection: a size-1
// set exists solely as the anchor and does nothing the click itself didn't, so
// it isn't drawn. The track context-menu verbs (Add to queue / Add to playlist)
// act on the whole selection when non-empty. Reactive so a `.selected` row
// highlight tracks it (see the selection effect and renderNode).
const treeSelection = signal<Set<string>>(new Set());
// The pivot a Shift-click ranges from — the last track any click touched
// (including a plain play-click, so click A then Shift-click B selects A..B).
let selectionAnchor: string | null = null;

// Track nodes in render order. `visibleOnly` descends into expanded folders alone
// (matching what renderNode paints) for Shift-range selection; false walks every
// loaded folder so a selection survives a folder collapse. Folders and playlists
// are skipped — only files are selectable.
function collectTrackNodes(visibleOnly: boolean): TreeNode[] {
  const out: TreeNode[] = [];
  const walk = (node: TreeNode): void => {
    for (const child of node.children) {
      if (child.isFolder) {
        if (child.loaded && (child.expanded || !visibleOnly)) walk(child);
      } else if (!child.isPlaylist) {
        out.push(child);
      }
    }
  };
  if (rootNode) walk(rootNode);
  return out;
}

// The current selection resolved to tracks, in tree order (hidden-but-selected
// rows under a collapsed folder included). What the context-menu verbs act on.
function selectedTracks(): SearchTrack[] {
  const sel = treeSelection.value;
  if (sel.size === 0) return [];
  return collectTrackNodes(false)
    .filter((n) => sel.has(n.path))
    .map(nodeToTrack);
}

function clearTreeSelection(): void {
  selectionAnchor = null;
  if (treeSelection.peek().size === 0) return;
  treeSelection.value = new Set();
}

// Drop the row (queue/navigator) selections so the tree is the only highlighted
// surface — the tree's half of the one-selection-at-a-time rule the row panes keep
// among themselves (see queueSel / navSel). Called by every tree selecting action.
function clearRowSelections(): void {
  queueSel.clear();
  navSel.clear();
}

// Plain click: select just this row and anchor a following Shift-range here.
// Replaces any prior multi-select with the single clicked track.
function selectTreeSingle(path: string): void {
  clearRowSelections();
  treeSelection.value = new Set([path]);
  selectionAnchor = path;
}

// Cmd/Ctrl-click: add or remove one track, and re-anchor the range here.
function toggleTreeSelection(path: string): void {
  clearRowSelections();
  const next = new Set(treeSelection.peek());
  if (next.has(path)) next.delete(path);
  else next.add(path);
  treeSelection.value = next;
  selectionAnchor = path;
}

// Shift-click: replace the selection with the contiguous range from the anchor to
// `path` over the visible track order. With no live anchor, this click becomes it.
// Shift-clicking a track that's already selected deselects just it, so a range can
// be trimmed a track at a time.
function selectTreeRangeTo(path: string): void {
  clearRowSelections();
  const sel = treeSelection.peek();
  if (sel.has(path)) {
    const next = new Set(sel);
    next.delete(path);
    treeSelection.value = next;
    selectionAnchor = path;
    return;
  }
  const order = collectTrackNodes(true).map((n) => n.path);
  const to = order.indexOf(path);
  if (to === -1) return;
  const anchor =
    selectionAnchor && order.includes(selectionAnchor) ? selectionAnchor : path;
  selectionAnchor = anchor;
  const from = order.indexOf(anchor);
  const [lo, hi] = from <= to ? [from, to] : [to, from];
  treeSelection.value = new Set(order.slice(lo, hi + 1));
}

// --- Row multi-select model (queue list + navigator leaf list) ---
//
// A multi-select over SearchTrack *object identity* (not index or path) — the same
// basis playingTrackObj uses — so a selection follows its exact rows across
// reorders, survives duplicate paths, and drops a row automatically when it's
// removed or the list is rebuilt from new data. A separate model from the tree's
// (which keys by path): a list row is a positional instance, a tree row is a file.
// Cmd/Ctrl-click toggles a row; Shift-click ranges over the view; a plain click
// plays/commits and drops the selection to a bare (unhighlighted) anchor for a
// following Shift-click. The row context-menu verbs act on the whole selection.
//
// Every pane that selects track rows gets its *own* instance (see queueSel /
// navSel): the queue and the navigator's Songs list share row *objects* — a track
// added to the queue from the Songs list is the very same SearchTrack — so one Set
// across both panes would paint a selection in both at once. Keeping them separate
// is what lets each pane hold its own selection independently.
interface TrackSelection {
  // The reactive Set, read by the row painters and the act-on-selection verbs.
  signal: Signal<Set<SearchTrack>>;
  // The Shift-range pivot: the last row a click touched. Read by keyboard Enter as
  // the "focused" row to commit.
  anchor(): SearchTrack | null;
  // The selection resolved to rows of `tracks`, in view order; missing rows (no
  // real file) are dropped so the add verbs stay valid.
  resolveIn(tracks: SearchTrack[]): SearchTrack[];
  clear(): void;
  // Plain click: select just this row and anchor a following Shift-range here.
  single(t: SearchTrack): void;
  // Cmd/Ctrl-click: add or remove one row, and re-anchor the range here.
  toggle(t: SearchTrack): void;
  // Shift-click: replace the selection with the contiguous range from the anchor to
  // `t` over `tracks`, skipping missing rows. With no live anchor, `t` becomes it.
  // Shift-clicking a selected row deselects just it, so a range can be trimmed.
  rangeTo(t: SearchTrack, tracks: SearchTrack[]): void;
}

// `onSelect` fires just before any selecting action (single / toggle / range) —
// but not clear or resolve — so a pane can drop the *other* panes' selections and
// keep the highlight on one surface at a time (see the queueSel / navSel wiring).
function makeTrackSelection(onSelect: () => void = () => {}): TrackSelection {
  const sel = signal<Set<SearchTrack>>(new Set());
  let anchor: SearchTrack | null = null;
  return {
    signal: sel,
    anchor: () => anchor,
    resolveIn(tracks) {
      const s = sel.value;
      if (s.size === 0) return [];
      return tracks.filter((t) => s.has(t) && !t.missing);
    },
    clear() {
      anchor = null;
      if (sel.peek().size === 0) return;
      sel.value = new Set();
    },
    single(t) {
      onSelect();
      sel.value = new Set([t]);
      anchor = t;
    },
    toggle(t) {
      onSelect();
      const next = new Set(sel.peek());
      if (next.has(t)) next.delete(t);
      else next.add(t);
      sel.value = next;
      anchor = t;
    },
    rangeTo(t, tracks) {
      onSelect();
      const s = sel.peek();
      if (s.has(t)) {
        const next = new Set(s);
        next.delete(t);
        sel.value = next;
        anchor = t;
        return;
      }
      const to = tracks.indexOf(t);
      if (to === -1) return;
      const a = anchor && tracks.includes(anchor) ? anchor : t;
      anchor = a;
      const from = tracks.indexOf(a);
      const [lo, hi] = from <= to ? [from, to] : [to, from];
      const next = new Set<SearchTrack>();
      for (let i = lo; i <= hi; i++) if (!tracks[i].missing) next.add(tracks[i]);
      sel.value = next;
    },
  };
}

// The right-pane queue/browsed-playlist selection and the Files-tab navigator's
// leaf-list (Songs, …) selection — separate Sets so they never mirror each other
// (a queued track is the same object as its Songs row), but mutually exclusive:
// selecting in one drops the other's (and the tree's) highlight, so exactly one
// surface is ever selected. The forward refs resolve at call time (both consts
// exist before any click fires). clearTreeSelection covers the third surface.
const queueSel: TrackSelection = makeTrackSelection(() => {
  navSel.clear();
  clearTreeSelection();
});
const navSel: TrackSelection = makeTrackSelection(() => {
  queueSel.clear();
  clearTreeSelection();
});

// The pane whose selection a keyboard Enter should play — set by the click that
// last touched a selection in the tree, the list, or the streams pane. Enter is a
// commit for the same row a click now merely selects, so it needs to know which
// of the (independently selectable) panes the user last acted in.
let lastSelectionPane: "tree" | "list" | "stream" | null = null;

function openListTracks(): SearchTrack[] {
  return (browsedPlaylist.value ?? activeQueue.value)?.tracks ?? [];
}

// The queue selection resolved to rows still in the open queue/playlist list.
function selectedListTracks(): SearchTrack[] {
  return queueSel.resolveIn(openListTracks());
}
// Last stream list streams loaded by refreshStreams, kept so search can filter
// them without re-reading the stream list on every keystroke.
let allStreams: Stream[] = [];
// Stream list name of the currently playing stream, shown as the now-playing
// station line. Kept separately from currentStreamUrl because ICY metadata
// events re-render the now-playing panel after the fact.
let currentStreamName: string | null = null;
// Album-folder context for the currently playing track. Held so an
// auto-advance event from the engine can look up the matching TreeNode (for
// the row highlight + now-playing UI) via siblingByPath. Null while playing
// a stream, a search hit, or an external file — those have no album context.
let currentParent: TreeNode | null = null;
let artRequestId = 0;
// Last queue + index handed to the engine. Held so play-after-queue-ended
// restarts from the same track the user last heard (the existing UX: hit play
// after the album finishes → resume from the last track).
let lastQueue: string[] = [];
let lastIndex = 0;
// The queue-row index the *next* engine play should land on, consumed by the
// following onAdvance to set queuePlayingIndex. Set right before every play that
// starts or jumps within the queue pool; left null for gapless auto-advance,
// which onAdvance treats as "the next row down" (so duplicate rows are tracked
// positionally, matching the engine's sequential advance).
let pendingQueueIndex: number | null = null;
// True once the engine has played through the queue's last track. Cleared on
// the next Play (file selection, seek, or restart-from-end via play button).
let queueEnded = false;

// Upcoming tracks for shuffle playback: a shuffled permutation of the album
// pool, consumed one entry per queue-ended. Draining it to empty means the
// shuffle cycle is done (stop when repeat is off, reshuffle when repeat all).
// Filled when shuffle turns on or a shuffled album starts; cleared for straight
// play so a stale order can't leak into the next album.
let shuffleBag: string[] = [];

// Some stations relay scraped playlists and broadcast titles that were never
// cleaned for ICY: HTML entities still encoded ("&#23665;" for 山) and the
// whole string wrapped in the source's quoting ("'Artist - Song'"). Decoded
// by hand rather than via DOMParser/innerHTML so a literal "<" in a title
// can't be eaten as a tag. Unknown entities pass through unchanged.
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function cleanStreamText(raw: string): string {
  let s = raw.replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, body) => {
    if (body.startsWith("#")) {
      const hex = body[1] === "x" || body[1] === "X";
      const cp = parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? m;
  });
  s = s.trim();
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

// Library-file lookup for the engine's track-changed events. Auto-advance
// stays within the current album folder, so currentParent's children are the
// universe; external/streamed playback has no parent and never advances.
function siblingByPath(path: string): TreeNode | null {
  if (!currentParent) return null;
  return (
    currentParent.children.find((c) => !c.isFolder && c.path === path) ?? null
  );
}

const engine = new GaplessEngine({
  onAdvance: (path) => {
    // currentParent stays the album folder across an album. For external/
    // search playback there is no parent and no sibling row to highlight; the
    // UI was already set by the caller (playSearchTrack / openExternalFile).
    const node = siblingByPath(path);
    if (!node) return;
    currentNodePath.value = node.path;
    currentStreamUrl.value = null;
    // Track which queue row is live. A play/jump sets pendingQueueIndex to its
    // target; a gapless auto-advance leaves it null, so we step to the next row
    // down (positional, so duplicate rows resolve to the right instance).
    if (queueIsActivePool()) {
      queuePlayingIndex.value =
        pendingQueueIndex ?? (queuePlayingIndex.value ?? -1) + 1;
    } else {
      queuePlayingIndex.value = null;
    }
    pendingQueueIndex = null;
    setNowPlaying(node.title ?? node.name, node.artist, node.album);
    void loadArt(node.path);
  },
  onTime: (t) => { currentTime.value = t; nowPlayingPositionTick(t); },
  onDuration: (d) => { duration.value = d; },
  onPlayingChange: (p) => { isPlaying.value = p; },
  onError: (path, message) => {
    console.error("audio: track failed", path, message);
  },
  onQueueEnded: () => {
    handleEnded();
  },
  // ICY now-playing for radio. The station name stays on the title line no
  // matter what so the layout never shifts when metadata arrives; the ICY
  // title fades in below it. The stream list's stream name wins over the
  // server's icy-name (stream list names are user-curated; icy-name is often a
  // slogan). The title is conventionally "Artist - Song"; split on the first
  // separator, keeping the whole string as the song when there is none.
  onStreamMetadata: (station, title) => {
    if (!isStream.value) return;
    const stationName =
      currentStreamName ?? (station ? cleanStreamText(station) : null);
    setNowPlaying(stationName || "Stream", null, null);
    const cleaned = title ? cleanStreamText(title) : "";
    if (cleaned) {
      const sep = cleaned.indexOf(" - ");
      const artist = sep > 0 ? cleaned.slice(0, sep).trim() : null;
      const song = sep > 0 ? cleaned.slice(sep + 3).trim() : cleaned;
      npStreamMeta.value = { song: song || cleaned, artist };
    } else {
      npStreamMeta.value = null;
    }
  },
});

// --- System Now Playing (macOS Control Center / lock screen / media keys) ---
//
// The OS integration lives in Rust (now_playing.rs); this half feeds it the
// resolved metadata + playback state that only the frontend knows. We push
// metadata whenever it changes and playback state on play/pause, plus a ~1 Hz
// refresh so the OS scrubber tracks seeks (position events themselves aren't
// forwarded — the OS extrapolates elapsed time from the last rate we sent).

function pushNowPlayingMeta(): void {
  if (!hasTrack.value) return;
  let title = npTitle.value;
  let artist = npArtist.value;
  // Radio: surface the current song/artist when the station sends ICY metadata,
  // falling back to the station name on the title line.
  if (isStream.value && npStreamMeta.value) {
    title = npStreamMeta.value.song;
    artist = npStreamMeta.value.artist ?? npTitle.value;
  }
  void invoke("now_playing_set_metadata", {
    title,
    artist,
    album: npAlbum.value,
    art: npArt.value,
    // Streams have no timeline; a 0 duration tells the OS to show it as live.
    duration: isStream.value ? 0 : duration.value,
  });
}

let lastPlaybackPush = 0;
function pushPlayback(elapsed: number): void {
  if (!hasTrack.value) return;
  void invoke("now_playing_set_playback", {
    playing: isPlaying.value,
    elapsed,
  });
  lastPlaybackPush = performance.now();
}

// Throttled position refresh, called from the engine's position callback so the
// OS elapsed time re-syncs (e.g. after a seek) without one IPC call per tick.
function nowPlayingPositionTick(t: number): void {
  if (!isPlaying.value) return;
  if (performance.now() - lastPlaybackPush > 1000) pushPlayback(t);
}

// Metadata card: fires on any change to the fields that make it up.
effect(() => {
  // Subscribe to every field the card is built from.
  npTitle.value;
  npArtist.value;
  npAlbum.value;
  npArt.value;
  duration.value;
  npStreamMeta.value;
  isStream.value;
  hasTrack.value;
  pushNowPlayingMeta();
});

// Play/pause: push immediately so the widget's button state flips at once.
effect(() => {
  isPlaying.value;
  hasTrack.value;
  pushPlayback(currentTime.peek());
});

let nowPlayingTitleEl: HTMLElement;
let nowPlayingTitleInner: HTMLElement;
let nowPlayingArtistEl: HTMLElement;
let nowPlayingArtistInner: HTMLElement;
let nowPlayingAlbumEl: HTMLElement;
let nowPlayingAlbumInner: HTMLElement;
let navBarTextEl: HTMLElement;
let navBarBtnEl: HTMLButtonElement;
let navBarAltBtnEl: HTMLButtonElement;
let nowPlayingStreamMetaEl: HTMLElement;
let streamMetaSongEl: HTMLElement;
let streamMetaSongInner: HTMLElement;
let streamMetaArtistEl: HTMLElement;
let streamMetaArtistInner: HTMLElement;
let liveIndicatorEl: HTMLElement;
let nowPlayingArtEl: HTMLImageElement;
let nowPlayingEmptyEl: HTMLElement;
let playPauseBtn: HTMLButtonElement;
let prevBtn: HTMLButtonElement;
let nextBtn: HTMLButtonElement;
let seekBar: HTMLInputElement;
let timeCurrentEl: HTMLElement;
let timeRemainingEl: HTMLElement;
let volumeControlEl: HTMLElement;
let volumeBtn: HTMLButtonElement;
let volumePopover: HTMLElement;
let volumeBar: HTMLInputElement;
let treeContainer: HTMLElement;
let streamsContainer: HTMLElement;
let libraryRootsContainer: HTMLElement;
let libraryRootAddBtn: HTMLButtonElement;
let streamListPathInput: HTMLInputElement;
let streamListPathBrowseBtn: HTMLButtonElement;
let miniplayerBtn: HTMLButtonElement;
let settingsBackBtn: HTMLButtonElement;
let playbackModesEl: HTMLElement;
let modeShuffleBtn: HTMLButtonElement;
let modeRepeatBtn: HTMLButtonElement;
let searchEl: HTMLElement;
let searchInput: HTMLInputElement;
let searchResultsEl: HTMLElement;
let nowPlayingPanel: HTMLElement;
let settingsPanel: HTMLElement;
let splitterEl: HTMLElement;
let queueTitleEl: HTMLElement;
let queueSubtitleEl: HTMLElement;
let queueListEl: HTMLElement;
let queueCloseBtn: HTMLButtonElement;
let queueRenameBtn: HTMLButtonElement;
let toastEl: HTMLElement;

// --- Tree ---

// Child nodes for one directory listing. Display order comes entirely from
// the backend: list_dir returns folders sorted by name and files sorted by
// (disc, track, name), and folders-before-files holds by construction here.
// `oldFolders` lets reconcileNode carry over an existing folder node (with its
// loaded/expanded state and children) instead of resetting it to a lazy stub.
function nodesFromListing(
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

async function fetchChildren(node: TreeNode): Promise<void> {
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

async function loadChildren(node: TreeNode, li: HTMLLIElement): Promise<void> {
  if (node.loaded || !node.isFolder) return;
  const childUl = h(
    "ul",
    {},
    h("li", { class: "loading-state", text: "Loading…" }),
  );
  li.appendChild(childUl);
  try {
    await fetchChildren(node);
  } finally {
    childUl.remove();
  }
}

// Lightweight cursor-positioned context menu for tree rows. Styled like the
// search dropdown (dark lifted surface). A leaf item runs an action; a `submenu`
// item opens a flyout to the right on hover (used by "Add to playlist ▸").
// Dismisses on any outside press, Escape, scroll, or resize.
type ContextMenuItem =
  | { label: string; action: () => void }
  | { label: string; submenu: ContextMenuItem[] };

// The open menu stack: index 0 is the root, deeper entries are flyouts. Kept so
// dismissal removes every level and a hover can close menus below a given depth.
let contextMenus: HTMLElement[] = [];
let contextMenuListenersInstalled = false;

function hideContextMenu(): void {
  for (const m of contextMenus) m.remove();
  contextMenus = [];
}

function contextMenusContain(target: Node): boolean {
  return contextMenus.some((m) => m.contains(target));
}

// Close every flyout deeper than `depth`, leaving that menu and its ancestors up.
function closeSubmenusBelow(depth: number): void {
  while (contextMenus.length > depth + 1) {
    contextMenus.pop()?.remove();
  }
}

function ensureContextMenuListeners(): void {
  if (contextMenuListenersInstalled) return;
  contextMenuListenersInstalled = true;
  // A press anywhere outside the menu(s) dismisses; items run on click, which
  // fires after this mousedown. Capture phase so it fires even if a descendant
  // (e.g. the search input's native shadow DOM) swallows the bubbling event.
  document.addEventListener(
    "mousedown",
    (e) => {
      if (!contextMenusContain(e.target as Node)) hideContextMenu();
    },
    true,
  );
  // Focus moving out of the menu also dismisses it — covers focusing the search
  // box (or any control) by click or keyboard.
  document.addEventListener("focusin", (e) => {
    if (!contextMenusContain(e.target as Node)) hideContextMenu();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hideContextMenu();
  });
  window.addEventListener("resize", hideContextMenu);
  // Capture so a scroll in any container (e.g. the tree) closes the menu, since
  // its fixed position would otherwise detach from the row.
  window.addEventListener("scroll", hideContextMenu, true);
}

// Clamp a menu to the viewport so an edge row doesn't push it offscreen.
function positionContextMenu(menu: HTMLElement, x: number, y: number): void {
  const rect = menu.getBoundingClientRect();
  const left = Math.max(4, Math.min(x, window.innerWidth - rect.width - 4));
  const top = Math.max(4, Math.min(y, window.innerHeight - rect.height - 4));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

// Build one menu level (root or flyout) at `depth`. Hovering any row closes
// deeper flyouts; a `submenu` row then opens its own flyout beside itself.
function buildContextMenu(items: ContextMenuItem[], depth: number): HTMLElement {
  const menu = h("div", { class: "context-menu" });
  for (const item of items) {
    const row = h("div", { class: "context-menu-item", text: item.label });
    if ("submenu" in item) {
      row.classList.add("has-submenu");
      const submenu = item.submenu;
      row.addEventListener("mouseenter", () => {
        closeSubmenusBelow(depth);
        const child = buildContextMenu(submenu, depth + 1);
        document.body.appendChild(child);
        contextMenus.push(child);
        // Open to the row's right, aligned to its top; positionContextMenu flips
        // it left if it would overflow.
        const r = row.getBoundingClientRect();
        positionContextMenu(child, r.right - 2, r.top);
      });
    } else {
      const action = item.action;
      row.addEventListener("mouseenter", () => closeSubmenusBelow(depth));
      row.addEventListener("click", () => {
        hideContextMenu();
        action();
      });
    }
    menu.appendChild(row);
  }
  return menu;
}

function showContextMenu(x: number, y: number, items: ContextMenuItem[]): void {
  ensureContextMenuListeners();
  hideContextMenu();
  const menu = buildContextMenu(items, 0);
  document.body.appendChild(menu);
  contextMenus.push(menu);
  positionContextMenu(menu, x, y);
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

function renderNode(
  node: TreeNode,
  parent: TreeNode,
  showArtist = true,
): HTMLLIElement {
  const li = h("li");
  // Every row carries its path so the playing-highlight effect can find it.
  // The tree row skips the accent while a queue/playlist owns the playhead — the
  // now-playing highlight belongs to the context playing the track, not to every
  // copy of the same file (see the highlight effect and queueIsActivePool).
  const label = h("span", { class: "node-label", data: { path: node.path } });
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
            parent !== rootNode && node.track != null ? String(node.track) : "",
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
  // A tagged track reads as two lines — title over a de-emphasized artist —
  // like a search result. Folders and untagged files keep a single plain line.
  const text =
    !node.isFolder && node.title
      ? h(
          "span",
          { class: "label-text" },
          h("span", { class: "primary", text: node.title }),
          node.artist && showArtist &&
            h("span", { class: "secondary", text: node.artist }),
        )
      : h("span", { class: "label-text", text: displayLabel(node) });
  label.appendChild(text);
  if (node.isPlaylist) {
    attachPlaylistClicks(label, node);
  } else {
    label.addEventListener("click", (e) => onNodeClick(node, parent, li, e));
  }
  // Right-click a playlist to play it, add its tracks to the queue, or curate it
  // (Rename rewrites the #PLAYLIST: directive; Delete removes the file).
  if (node.isPlaylist) {
    label.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      showContextMenu(e.clientX, e.clientY, [
        { label: "Play", action: () => void playPlaylist(node) },
        { label: "Add to queue", action: () => void addPlaylistToQueue(node) },
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
        {
          label: "Add to queue",
          action: () => void addFolderToQueue({ path: node.path, name: node.name }),
        },
        addToPlaylistItem(() =>
          invoke<SearchTrack[]>("folder_tracks", { path: node.path }),
        ),
        showInFinderItem(node.path),
      ]);
    });
  } else {
    // Right-click a track to jump to its artist or album as a queue page. Each
    // item is only offered when that tag exists. An untagged track (common for
    // OST rips named purely by filename) has neither, so fall back to "Play
    // folder" on its containing folder — right-click always does something.
    label.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      // Finder-style: right-clicking a row outside the current selection makes it
      // the selection; right-clicking inside a multi-selection keeps it. The verbs
      // then act on the whole selection (see selectedTracks).
      if (!treeSelection.peek().has(node.path)) {
        treeSelection.value = new Set([node.path]);
        selectionAnchor = node.path;
      }
      const sel = selectedTracks();
      const items: ContextMenuItem[] = [];
      if (sel.length > 1) {
        // Multi-select: the per-track navigation verbs (Play artist/album) don't
        // apply to a heterogeneous set, so offer only the list-building verbs,
        // acting on every selected track. Count in the label confirms the scope.
        items.push({ label: `Add ${sel.length} to queue`, action: () => addToQueue(sel) });
        items.push(addToPlaylistItem(() => sel));
        // revealItemInDir takes one path; reveal the first selected track.
        items.push(showInFinderItem(sel[0].path));
      } else {
        // The Play verbs lead — the navigation verbs (Play artist / Play album)
        // when their tags exist, else "Play folder" on the container for an
        // untagged track (which has neither) so right-click always does something.
        // "Add to queue" always comes last, matching the folder menu's order.
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
        items.push({ label: "Add to queue", action: () => addToQueue([nodeToTrack(node)]) });
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
  li.appendChild(label);

  if (node.isFolder && node.expanded) {
    const childUl = h("ul");
    if (node.children.length === 0) {
      childUl.appendChild(h("li", { class: "empty-state", text: "(empty)" }));
    } else {
      const showArtist = folderArtistsVary(node.children);
      for (const child of node.children) {
        childUl.appendChild(renderNode(child, node, showArtist));
      }
    }
    li.appendChild(childUl);
  }
  return li;
}

async function onNodeClick(
  node: TreeNode,
  parent: TreeNode,
  li: HTMLLIElement,
  e?: MouseEvent,
): Promise<void> {
  if (node.isFolder) {
    if (!node.loaded) await loadChildren(node, li);
    node.expanded = !node.expanded;
    li.replaceWith(renderNode(node, parent));
    return;
  }
  lastSelectionPane = "tree";
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
  if (rootNode) walk(rootNode);
  return found;
}

// Play whatever a keyboard Enter should commit: the selected row in the pane the
// user last acted in. A commit for the same row a plain click now merely selects.
// Returns true when it played something (so the caller can preventDefault).
// Sidebar panes only fire when their tab is showing, so Enter never plays a row
// hidden behind the other tab; the list pane is always visible.
function playSelectedRow(): boolean {
  if (lastSelectionPane === "stream" && activeTab.value === "streams") {
    const url = selectedStreamUrl.value;
    const stream = url ? allStreams.find((s) => s.url === url) : undefined;
    if (stream) {
      playStream(stream);
      return true;
    }
    return false;
  }
  if (lastSelectionPane === "tree" && activeTab.value === "files") {
    // The anchor is the last row a click touched — the natural "focused" row to
    // commit when a range is selected. Fall back to a lone selected path.
    const sel = treeSelection.value;
    const path =
      selectionAnchor && sel.has(selectionAnchor)
        ? selectionAnchor
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
  if (lastSelectionPane === "list") {
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

function renderTree(): void {
  treeContainer.innerHTML = "";
  if (!rootNode) return;
  if (rootNode.children.length === 0) {
    setEmpty(treeContainer, "Library is empty");
    return;
  }
  const ul = h("ul");
  for (const child of rootNode.children) {
    ul.appendChild(renderNode(child, rootNode));
  }
  treeContainer.appendChild(ul);
}

function renderStreams(streams: Stream[]): void {
  streamsContainer.innerHTML = "";
  if (streams.length === 0) {
    setEmpty(streamsContainer, "Stream list is empty");
    return;
  }
  const ul = h("ul");
  for (const stream of streams) {
    const label = h("span", {
      class: "node-label",
      data: { streamUrl: stream.url },
    });
    if (currentStreamUrl.value === stream.url) {
      label.classList.add("playing");
    }
    if (selectedStreamUrl.value === stream.url) {
      label.classList.add("selected");
    }
    // The gutter shows the station glyph at rest and a play button on hover —
    // the same swap tree tracks do with their track number, now that a plain
    // click selects rather than plays.
    label.appendChild(
      h(
        "span",
        { class: "icon stream" },
        h("span", { class: "radio" }),
        // Plays directly and swallows the click so the row's select-on-click
        // doesn't also fire.
        h("button", {
          class: "row-play",
          attrs: { "aria-label": "Play" },
          on: {
            click: (e) => {
              e.stopPropagation();
              playStream(stream);
            },
          },
        }),
      ),
    );
    label.appendChild(h("span", { class: "label-text", text: stream.name }));
    // Single click selects (highlight only); the hover play button or a
    // double-click commits — matching the file tree and playlists.
    label.addEventListener("click", () => {
      lastSelectionPane = "stream";
      selectedStreamUrl.value = stream.url;
    });
    label.addEventListener("dblclick", () => playStream(stream));
    // Right-click a station to play it, or (on a writable local list) edit it
    // in place / remove it. Selecting the row first mirrors the tree's
    // right-click-selects behavior.
    label.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      lastSelectionPane = "stream";
      selectedStreamUrl.value = stream.url;
      const items: ContextMenuItem[] = [{ label: "Play", action: () => playStream(stream) }];
      if (streamListWritable.value) {
        items.push(
          { label: "Edit…", action: () => openEditStationEditor(stream) },
          { label: "Delete", action: () => void deleteStream(stream) },
        );
      }
      showContextMenu(e.clientX, e.clientY, items);
    });
    const li = h("li", { class: "stream-row" }, label);
    attachStreamReorder(li, stream);
    ul.appendChild(li);
  }
  streamsContainer.appendChild(ul);
}

// A reusable field editor: a small stacked form of labeled text inputs plus
// Cancel/Save. Both callers mount it in the right-pane editor face (track
// metadata, stream add/edit — see openPaneEditor). Kept generic — the caller
// supplies the fields and what Save does — so they share one look and one set of
// behaviors (Enter submits, Esc cancels, Save disabled until the required fields
// are filled). Returns the <form> element for
// the caller to insert; `onCancel` fires on Esc or the Cancel button.
interface InlineEditorField {
  key: string;
  label: string;
  value?: string;
  placeholder?: string;
  // When true, Save stays disabled until this field is non-empty. A form with no
  // required fields keeps Save always enabled.
  required?: boolean;
  // When set, the field gets a trailing "Choose…" button; it resolves to a value
  // to drop into the input (or null to leave it), e.g. picking an image file.
  browse?: () => Promise<string | null>;
}

interface InlineEditorOptions {
  fields: InlineEditorField[];
  submitLabel: string;
  // Optional title line above the fields, e.g. "Editing <filename>" or "New
  // station" — the editor face fills the pane, so it names what's being edited
  // now that there's no adjacent row to imply it.
  heading?: string;
  onSubmit: (values: Record<string, string>) => void | Promise<void>;
  onCancel: () => void;
  // When set, Save is disabled whenever this returns true (on top of the
  // required-field check), and `blockedNote` shows above the buttons to say why.
  // It's read inside a reactive effect, so referencing a signal re-evaluates the
  // gate live (e.g. re-enabling Save the moment playback leaves the edited file).
  blocked?: () => boolean;
  blockedNote?: string;
}

function buildInlineEditor(opts: InlineEditorOptions): HTMLFormElement {
  const form = h("form", { class: "inline-editor" });
  if (opts.heading) {
    form.appendChild(
      h("div", { class: "inline-editor-heading", text: opts.heading }),
    );
  }
  const inputs = new Map<string, HTMLInputElement>();
  // Browse buttons are wired after submitBtn/syncEnabled exist (a pick updates
  // the disabled state), so collect them during the build pass.
  const browsers: { input: HTMLInputElement; browse: () => Promise<string | null> }[] = [];
  for (const field of opts.fields) {
    const input = h("input", {
      attrs: { type: "text", placeholder: field.placeholder ?? false },
    });
    input.value = field.value ?? "";
    inputs.set(field.key, input);
    form.appendChild(
      h(
        "label",
        { class: "inline-editor-field" },
        h("span", { class: "inline-editor-label", text: field.label }),
        input,
        field.browse &&
          h("button", {
            class: "inline-editor-browse",
            attrs: { type: "button" },
            text: "Choose…",
          }),
      ),
    );
    if (field.browse) browsers.push({ input, browse: field.browse });
  }

  const cancelBtn = h("button", {
    class: "inline-editor-cancel",
    attrs: { type: "button" },
    text: "Cancel",
    on: { click: () => opts.onCancel() },
  });
  const submitBtn = h("button", {
    class: "inline-editor-submit",
    attrs: { type: "submit" },
    text: opts.submitLabel,
  });
  // Optional note above the buttons, shown only while `blocked` holds (e.g.
  // "Can't save while this track is playing"). Present in the DOM from the start
  // so toggling it doesn't reflow the actions row.
  let noteEl: HTMLElement | null = null;
  if (opts.blocked && opts.blockedNote) {
    noteEl = h("div", {
      class: "inline-editor-note hidden",
      text: opts.blockedNote,
    });
    form.appendChild(noteEl);
  }

  form.appendChild(
    h("div", { class: "inline-editor-actions" }, cancelBtn, submitBtn),
  );

  const required = opts.fields.filter((f) => f.required).map((f) => f.key);
  const syncEnabled = (): void => {
    const blocked = opts.blocked?.() ?? false;
    submitBtn.disabled = blocked || required.some((key) => !inputs.get(key)!.value.trim());
    noteEl?.classList.toggle("hidden", !blocked);
  };
  for (const input of inputs.values()) input.addEventListener("input", syncEnabled);
  for (const { input, browse } of browsers) {
    const buttonRow = input.parentElement!.querySelector(".inline-editor-browse")!;
    buttonRow.addEventListener("click", async () => {
      const picked = await browse();
      if (picked != null) {
        input.value = picked;
        syncEnabled();
      }
    });
  }
  syncEnabled();

  // Keep the Save gate live: re-run syncEnabled whenever a signal read by
  // `blocked` changes. There's no teardown hook for the editor, so the effect
  // self-disposes once the form leaves the DOM (Save/Cancel re-render the row).
  // The first run happens before the caller mounts the form, so the disconnect
  // check is gated on `mounted` to avoid disposing before it's ever shown.
  if (opts.blocked) {
    let mounted = false;
    const stop = effect(() => {
      opts.blocked!(); // subscribe to whatever signals the predicate reads
      if (mounted && !form.isConnected) {
        stop();
        return;
      }
      syncEnabled();
    });
    mounted = true;
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (submitBtn.disabled) return;
    const values: Record<string, string> = {};
    for (const [key, input] of inputs) values[key] = input.value.trim();
    void opts.onSubmit(values);
  });
  // Esc cancels from anywhere in the form (matching the rename affordance).
  form.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      opts.onCancel();
    }
  });
  // Focus the first field once the form is in the DOM.
  queueMicrotask(() => inputs.values().next().value?.focus());
  return form;
}

// Pick a local image file and hand back its file:// URL (the portable form
// get_stream_image reads), or null if the dialog was dismissed. A user can also
// just type/paste an http(s) URL into the field instead of browsing.
async function browseStationImage(): Promise<string | null> {
  const selected = await open({
    directory: false,
    multiple: false,
    filters: [{ name: "Image", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp"] }],
  });
  if (typeof selected !== "string") return null;
  try {
    return await invoke<string>("to_file_url", { path: selected });
  } catch (e) {
    console.error("to_file_url failed", selected, e);
    return null;
  }
}

// The three fields of a station, shared by Add and Edit so both look and behave
// identically. `stream` prefills them when editing an existing entry.
function stationEditorFields(stream?: Stream): InlineEditorField[] {
  return [
    { key: "name", label: "Name", value: stream?.name, placeholder: "Pudding FM" },
    { key: "url", label: "URL", value: stream?.url, placeholder: "https://", required: true },
    {
      key: "image",
      label: "Image",
      value: stream?.image ?? "",
      placeholder: "URL or file",
      browse: browseStationImage,
    },
  ];
}

// Add a station: open the editor face (see openPaneEditor) with an empty form.
// Only reachable when the list is writable (the Add button hides otherwise), and
// the face replaces its own contents, so no "already open" guard is needed. Save
// writes the stream, refreshes the list, and closes; Cancel just closes.
function openAddStationEditor(): void {
  if (!streamListWritable.value) return;
  const editor = buildInlineEditor({
    fields: stationEditorFields(),
    submitLabel: "Add",
    heading: "New stream",
    onCancel: closePaneEditor,
    onSubmit: async (values) => {
      try {
        await invoke("add_stream", {
          path: streamListPathInput.value,
          name: values.name,
          url: values.url,
          image: values.image || null,
        });
      } catch (e) {
        console.error("add_stream failed", e);
        return; // leave the form up so the user can correct and retry
      }
      closePaneEditor();
      await refreshStreams(streamListPathInput.value);
    },
  });
  openPaneEditor("stream", editor);
}

// Edit an existing station in the editor face, prefilled. `index` is the
// station's position in the file (== its index in allStreams, which is the file
// order), resolved live so it's right even if the list changed since render.
// Save rewrites the entry and refreshes the list; Cancel just closes (the row was
// never touched, so nothing to restore).
function openEditStationEditor(stream: Stream): void {
  const index = allStreams.indexOf(stream);
  if (index < 0) return;
  const editor = buildInlineEditor({
    fields: stationEditorFields(stream),
    submitLabel: "Save",
    heading: `Editing ${stream.name}`,
    onCancel: closePaneEditor,
    onSubmit: async (values) => {
      try {
        await invoke("update_stream", {
          path: streamListPathInput.value,
          index,
          name: values.name,
          url: values.url,
          image: values.image || null,
        });
      } catch (e) {
        console.error("update_stream failed", e);
        return; // leave the form up so the user can correct and retry
      }
      closePaneEditor();
      await refreshStreams(streamListPathInput.value);
    },
  });
  openPaneEditor("stream", editor);
}

// --- Right-pane editor face ---
//
// Editing a track's tags or a stream is a *right-pane mode*, not an inline row
// swap: the context menus that trigger it (tree, Songs/album/artist leaf lists,
// queue/playlist for tracks; the streams list for stations) build a form and open
// the editor face over whatever the pane was showing. Closing it clears the face
// signal and the pane falls back to the hero/list it was on — so you land back
// where you were, no saved "return to" state needed. A row swap couldn't work
// uniformly for tags: album/artist lists derive membership from the very tags
// being edited, so an in-place patch would strand an ejected track; here the edit
// is decoupled from any row and applyTagUpdate refreshes each surface after the
// write. Streams follow the same face for consistency.

// Which editor the face is showing ("metadata" or "stream"), or null when it's
// closed. Only its presence drives the `.show-editor` face toggle; the kind lets
// the streams-writability effect close just the stream editor. The form itself is
// rebuilt on each open, so this needn't carry any per-edit state.
const paneEditor = signal<"metadata" | "stream" | null>(null);

// The #pane-editor-view element the form mounts into (assigned at init).
let paneEditorView: HTMLElement;

// Close the editor face, revealing whatever face was underneath. Idempotent.
function closePaneEditor(): void {
  paneEditor.value = null;
  paneEditorView.replaceChildren();
}

// Mount `form` as the editor face and reveal it. `kind` tags which editor is up.
function openPaneEditor(kind: "metadata" | "stream", form: HTMLElement): void {
  paneEditorView.replaceChildren(form);
  paneEditor.value = kind;
}

// Open the metadata editor for `path`, prefilled from `seed` (its current tags,
// read fresh from disk — see editMetadataItem). Building the form here means one
// editor surface no matter which menu opened it. Save writes the tags, refreshes
// every surface that shows the track (applyTagUpdate), and closes; Cancel closes.
function openMetadataEditor(path: string, seed: FileEntry): void {
  // Empty or non-positive parses to null (clears the tag); disc/track are 1-based.
  const parsePositive = (s: string): number | null => {
    const n = parseInt(s, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const editor = buildInlineEditor({
    fields: [
      { key: "title", label: "Title", value: seed.title ?? "", placeholder: seed.name },
      { key: "artist", label: "Artist", value: seed.artist ?? "" },
      { key: "album", label: "Album", value: seed.album ?? "" },
      { key: "albumArtist", label: "Album Artist", value: seed.albumArtist ?? "" },
      { key: "disc", label: "Disc", value: seed.disc?.toString() ?? "" },
      { key: "track", label: "Track", value: seed.track?.toString() ?? "" },
    ],
    submitLabel: "Save",
    heading: `Editing ${seed.name}`,
    // Saving rewrites the file in place — unsafe while the engine holds it open
    // (you can open this for the playing track, or playback may advance into it
    // while the editor is up). Gate Save on that, live.
    blocked: () => currentNodePath.value === path,
    blockedNote: "Can't save while this track is playing",
    onCancel: closePaneEditor,
    onSubmit: async (values) => {
      // Defensive re-check: the reactive gate keeps Save disabled while playing,
      // so this only trips on a same-tick race. Leave the form up rather than
      // rewriting the file under the decoder.
      if (currentNodePath.value === path) return;
      let res: FileEntry;
      try {
        res = await invoke<FileEntry>("write_tags", {
          path,
          title: values.title || null,
          artist: values.artist || null,
          albumArtist: values.albumArtist || null,
          album: values.album || null,
          disc: parsePositive(values.disc),
          track: parsePositive(values.track),
        });
      } catch (e) {
        console.error("write_tags failed", e);
        return; // leave the form up so the user can correct and retry
      }
      applyTagUpdate(path, res);
      closePaneEditor();
    },
  });
  openPaneEditor("metadata", editor);
}

// The single "Edit metadata…" context-menu verb, shared by every track surface.
// Reads the file's tags fresh from disk before opening — a view carries only a
// partial row (a SearchTrack from Songs/album/artist lists has no album-artist or
// disc), so seeding the editor from the row would let a save write those fields
// back empty and wipe them. read_file_tags returns the whole tag set.
function editMetadataItem(path: string): ContextMenuItem {
  return {
    label: "Edit metadata…",
    action: async () => {
      let seed: FileEntry;
      try {
        seed = await invoke<FileEntry>("read_file_tags", { path });
      } catch (e) {
        console.error("read_file_tags failed", e);
        return;
      }
      openMetadataEditor(path, seed);
    },
  };
}

// Refresh every surface that might show a just-edited track, after write_tags. The
// edit is decoupled from any one row, so each surface updates through its own path:
//   - Tree: the fs watcher's own scan skips this row (write_tags pre-synced
//     mtime/size), so patch the in-memory node and repaint the tree here.
//   - Library nav lenses (Songs/Artists/Albums + detail): reload so tag-derived
//     membership recomputes — an edited-away track drops out and the list re-sorts.
//   - Open right-pane list (queue / browsed playlist): membership is by path
//     (unchanged), so patch the matching rows' display fields in place and repaint.
function applyTagUpdate(path: string, tags: FileEntry): void {
  if (rootNode) {
    const found = findNode(rootNode, path);
    if (found && !found.node.isFolder) {
      const n = found.node;
      n.title = tags.title;
      n.artist = tags.artist;
      n.album = tags.album;
      n.albumArtist = tags.albumArtist;
      n.disc = tags.disc;
      n.track = tags.track;
      renderTree();
    }
  }
  reloadNavView();
  const list = browsedPlaylist.value ?? activeQueue.value;
  if (list && list.tracks.some((t) => t.path === path)) {
    for (const t of list.tracks) {
      if (t.path !== path) continue;
      t.title = tags.title;
      t.artist = tags.artist;
      t.album = tags.album;
      t.track = tags.track;
    }
    renderQueue(list, browsedPlaylist.value === null);
  }
}

async function deleteStream(stream: Stream): Promise<void> {
  const index = allStreams.indexOf(stream);
  if (index < 0) return;
  const ok = await confirm(`This will remove ${stream.name} from the stream list.`, {
    title: `Remove ${stream.name}?`,
    kind: "warning",
  });
  if (!ok) return;
  try {
    await invoke("delete_stream", { path: streamListPathInput.value, index });
  } catch (e) {
    console.error("delete_stream failed", e);
    return;
  }
  await refreshStreams(streamListPathInput.value);
}

// Renders the queue view's track list. Rebuilt whenever the queue or the
// playing row changes (both cheap: a queue is at most a few hundred rows).
// One uniform view for every queue regardless of how it was built — a queue is
// an arbitrary, possibly mixed-source list once you can Add to it from anywhere,
// so there's no per-kind header cover or per-kind row line. The playing row
// (queuePlayingIndex, which distinguishes duplicate rows) is highlighted and
// scrolled into view; clicking any row plays it within the queue.
// One-shot: the index a just-appended track wants brought into view. renderQueue
// consumes it so the re-render lands on the new row rather than the default
// scroll-to-playing (which sits earlier, and would otherwise hide the addition).
let pendingQueueScrollIndex: number | null = null;

// Renders the list face. `isSource` is true when the list is the playing
// source (the queue, or a played playlist) and false when it's a playlist being
// browsed while something else plays — a browse carries no playing-row highlight
// and its rows *commit* (play the playlist) rather than jumping the pool.
function renderQueue(queue: Queue | null, isSource: boolean): void {
  if (!queue) {
    queueListEl.innerHTML = "";
    return;
  }
  const isPlaylist = isPlaylistSource(queue);
  // A real playlist is titled by its #PLAYLIST: name; every ephemeral queue is
  // simply "Queue" (the source name lives on the hero, not this list header).
  queueTitleEl.textContent = isPlaylist ? queue.title : "Queue";
  queueSubtitleEl.textContent = queue.subtitle ?? "";
  queueSubtitleEl.classList.toggle("hidden", !queue.subtitle);
  // Only the ephemeral queue offers teardown (Clear). A playlist has no
  // header teardown — deleting one is a tree action. A playlist instead offers an
  // inline rename: the title reads as clickable and reveals a pencil on hover; the
  // queue has no name to edit.
  queueCloseBtn.classList.toggle("hidden", isPlaylist);
  queueRenameBtn.classList.toggle("hidden", !isPlaylist);
  queueTitleEl.parentElement?.classList.toggle("renamable", isPlaylist);

  // A browsed playlist isn't the pool, so nothing in it is "playing".
  const playing = isSource ? queuePlayingIndex.value : null;
  // A pending append target wins over the playing row for this render only, and
  // only when we're actually showing the queue it was appended to (a browsed
  // playlist has its own, unrelated rows).
  const scrollTo = isSource ? pendingQueueScrollIndex : null;
  pendingQueueScrollIndex = null;
  queueListEl.innerHTML = "";
  let activeRow: HTMLElement | null = null;
  let scrollRow: HTMLElement | null = null;
  // `playing` (queuePlayingIndex) indexes the *playable* pool, which excludes
  // missing rows; the view keeps them (marked, unplayable). Walk a parallel pool
  // index so the right row highlights and a click maps back to its pool position.
  let poolIdx = 0;
  queue.tracks.forEach((t, i) => {
    const rowPoolIdx = t.missing ? -1 : poolIdx;
    if (!t.missing) poolIdx++;
    const isPlaying = rowPoolIdx === playing;
    // The playing row keeps its index and just recolors to the accent (like the
    // tree's track rows), rather than swapping in a glyph. The number and the
    // hover play button share this one gutter cell (see CSS), so the button
    // lands exactly where the number was.
    const label = String(i + 1);
    const num = h(
      "span",
      { class: "queue-num" },
      h("span", {
        class: "queue-num-text",
        text: label,
        // 4+ digit numbers shrink to the 3-digit width so they stay centered
        // without overflowing (same rule as the Songs list — tabular digits are
        // equal width, so N digits fit 3 digits' width at scale 3/N).
        style: label.length > 3 ? { "font-size": `${3 / label.length}em` } : {},
      }),
    );
    // A missing playlist row is shown but can't be played: dim it, label it, and
    // skip the click handler so it reads as unavailable rather than dropped.
    const secondaryText = t.missing ? "Missing file" : (t.artist ?? t.album ?? "");
    const text = h(
      "span",
      { class: "queue-text" },
      h("span", {
        class: "queue-primary",
        text: t.title ?? (t.path.split(/[\\/]/).pop() ?? t.path),
      }),
      secondaryText && h("span", { class: "queue-secondary", text: secondaryText }),
    );
    // Row remove (curation): strips this row from the list (and file, if a
    // playlist). Stops propagation so it never counts as a play/commit click.
    const remove = h("button", {
      class: "queue-remove",
      text: "✕",
      attrs: { type: "button", title: "Remove from list", "aria-label": "Remove from list" },
      on: {
        click: (e) => {
          e.stopPropagation();
          removeCuratedRow(i);
        },
      },
    });
    // The view index, so the reactive selection effect can map its object-keyed
    // set back to rows without a unique path (duplicates share one).
    const li = h("li", { class: "queue-row", data: { rowIndex: i } }, num, text, remove);
    if (isPlaying) {
      li.classList.add("playing");
      activeRow = li;
    }
    // Multi-select background, reapplied on rebuild like .playing (the list
    // selection effect keeps it live between rebuilds).
    if (!t.missing && queueSel.signal.peek().has(t)) li.classList.add("selected");
    if (i === scrollTo) scrollRow = li;
    if (t.missing) {
      li.classList.add("missing");
    } else {
      // Select-and-play, shared by the hover play button and a double-click. The
      // played row stays selected (matching the tree and Apple Music). Source
      // list: jump the pool to this row. Browsed playlist: commit it — play the
      // playlist from that track, making it the source.
      const playRow = () => {
        queueSel.single(t);
        if (isSource) playQueueTrack(rowPoolIdx);
        else commitBrowsedPlaylist(rowPoolIdx);
      };
      // Hover play button in the gutter, mirroring the tree's track rows. Swallows
      // the click so the row's select-on-click doesn't also fire.
      num.appendChild(
        h("button", {
          class: "row-play",
          attrs: { type: "button", "aria-label": "Play" },
          on: {
            click: (e) => {
              e.stopPropagation();
              playRow();
            },
          },
        }),
      );
      li.addEventListener("click", (e) => {
        lastSelectionPane = "list";
        // Cmd/Ctrl- and Shift-click build a selection; a plain click selects just
        // this row (and anchors a following Shift-range here). Play is the hover
        // button or a double-click, matching the tree.
        if (e.metaKey || e.ctrlKey) {
          queueSel.toggle(t);
          return;
        }
        if (e.shiftKey) {
          queueSel.rangeTo(t, openListTracks());
          return;
        }
        queueSel.single(t);
      });
      li.addEventListener("dblclick", playRow);
    }
    // Right-click a playable row to queue it, add it to a playlist, or (multi)
    // remove it (a missing row has no real file to copy, so it's skipped).
    // "Add to queue" leads, matching the tree track/folder menus.
    if (!t.missing) {
      li.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        // Finder-style: right-clicking a row outside the selection makes it the
        // selection; inside a multi-selection it's kept. The verbs act on it.
        if (!queueSel.signal.peek().has(t)) queueSel.single(t);
        const sel = selectedListTracks();
        if (sel.length > 1) {
          showContextMenu(e.clientX, e.clientY, [
            { label: `Add ${sel.length} to queue`, action: () => addToQueue(sel) },
            addToPlaylistItem(() => sel),
            {
              label: `Remove ${sel.length} from list`,
              action: () => removeCuratedTracks(sel),
            },
          ]);
        } else {
          showContextMenu(e.clientX, e.clientY, [
            { label: "Add to queue", action: () => addToQueue([t]) },
            addToPlaylistItem(() => [t]),
            editMetadataItem(t.path),
          ]);
        }
      });
    }
    attachRowReorder(li, t);
    queueListEl.appendChild(li);
  });
  const target = (scrollRow ?? activeRow) as HTMLElement | null;
  if (target) target.scrollIntoView({ block: "nearest" });
}

// Pointer-based drag for curation: reorder a list row, or insert track(s)
// dragged in from the tree. Built on pointer events rather than HTML5
// drag-and-drop so it coexists with Tauri's native OS file-drop handler (the
// window keeps the default dragDropEnabled: true): that handler swallows HTML5
// dragstart/drop inside the webview but leaves pointer events untouched. Pointer
// events also sidestep WKWebView's unreliable dataTransfer — the payload simply
// lives in this closure.
type DragPayload =
  | { kind: "reorder"; tracks: SearchTrack[] }
  | { kind: "tracks"; tracks: SearchTrack[] }
  // Reorder a station within the (writable, local) stream list. Carries the
  // dragged Stream; its live index is resolved at drop time against allStreams.
  | { kind: "stream"; stream: Stream };

// A drag only *starts* once the pointer travels this many px from where it went
// down, so a plain click on a row still plays/commits it (no accidental reorder)
// and a click on a tree track still plays it.
const DRAG_THRESHOLD_PX = 5;

interface ActiveDrag {
  payload: DragPayload;
  // The reordered row, greyed while dragging; null for a tree-track insert (a copy).
  sourceEl: HTMLElement | null;
  // The list the drop hit-tests against, and the CSS selector for its rows — so
  // one drag engine serves the queue/playlist list and the stream list alike.
  listEl: HTMLElement;
  rowSelector: string;
  startX: number;
  startY: number;
  started: boolean;
  // View index the drop would land at (insert-before), or null when the pointer
  // is off the list (a drop there cancels).
  dropAt: number | null;
}
let activeDrag: ActiveDrag | null = null;

// Begin a tree-track drag (called from the tree on pointerdown). Carries the
// track(s) to insert; the drag only engages past the movement threshold. Drops
// land in the open queue/playlist list.
function startTrackDrag(e: PointerEvent, tracks: SearchTrack[]): void {
  beginPointerDrag(e, { kind: "tracks", tracks }, null, queueListEl, "li.queue-row");
}

// Arm a drag from a pointerdown on a drag source (a list row, or a tree track).
// `listEl`/`rowSelector` name the list the drop resolves against.
function beginPointerDrag(
  e: PointerEvent,
  payload: DragPayload,
  sourceEl: HTMLElement | null,
  listEl: HTMLElement,
  rowSelector: string,
): void {
  if (e.button !== 0) return; // left button only
  activeDrag = {
    payload,
    sourceEl,
    listEl,
    rowSelector,
    startX: e.clientX,
    startY: e.clientY,
    started: false,
    dropAt: null,
  };
  // Kill text selection for the whole gesture from the outset — a pointer sweep
  // across rows would otherwise rubber-band-select their titles before the drag
  // threshold is even crossed. WKWebView doesn't reliably honor user-select:none
  // mid-gesture, so also cancel selectstart outright. Harmless on a plain click.
  document.body.classList.add("dragging-noselect");
  document.addEventListener("selectstart", preventSelectStart);
  window.addEventListener("pointermove", onDragPointerMove);
  window.addEventListener("pointerup", onDragPointerUp);
  window.addEventListener("pointercancel", onDragPointerCancel);
}

function onDragPointerMove(e: PointerEvent): void {
  const d = activeDrag;
  if (!d) return;
  if (!d.started) {
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (dx * dx + dy * dy < DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) return;
    d.started = true;
    if (d.sourceEl) d.sourceEl.classList.add("dragging");
    document.body.classList.add("reordering");
    // Drop any selection that slipped in before user-select:none took hold.
    window.getSelection()?.removeAllRanges();
    createDragGhost(d.payload);
  }
  moveDragGhost(e.clientX, e.clientY);
  d.dropAt = updateDropTarget(e.clientX, e.clientY);
}

function onDragPointerUp(): void {
  const d = activeDrag;
  endPointerDrag();
  if (!d || !d.started) return; // a click, not a drag — let the click handler run
  suppressNextClick();
  if (d.dropAt != null) applyDrop(d.payload, d.dropAt);
}

function onDragPointerCancel(): void {
  endPointerDrag();
}

// Block the browser from starting a text selection mid-drag (WKWebView ignores
// user-select:none once a selection is underway).
function preventSelectStart(e: Event): void {
  e.preventDefault();
}

// Tear down an in-progress drag: drop the window listeners, markers, and styling.
function endPointerDrag(): void {
  window.removeEventListener("pointermove", onDragPointerMove);
  window.removeEventListener("pointerup", onDragPointerUp);
  window.removeEventListener("pointercancel", onDragPointerCancel);
  document.removeEventListener("selectstart", preventSelectStart);
  if (activeDrag?.sourceEl) activeDrag.sourceEl.classList.remove("dragging");
  document.body.classList.remove("reordering", "dragging-noselect");
  clearDropMarkers();
  removeDragGhost();
  activeDrag = null;
}

// A floating badge that follows the pointer during a drag, showing how many
// tracks are in flight ("N tracks"). Purely cosmetic — the payload lives in the
// activeDrag closure, not the DOM — so it gives the gesture a visible object to
// carry rather than only the drop marker at the destination.
let dragGhostEl: HTMLElement | null = null;

function createDragGhost(p: DragPayload): void {
  const n = p.kind === "stream" ? 0 : p.tracks.length;
  const el = h("div", {
    class: "drag-ghost",
    text: p.kind === "stream" ? p.stream.name : `${n} track${n === 1 ? "" : "s"}`,
  });
  document.body.appendChild(el);
  dragGhostEl = el;
}

// Position the badge just below-right of the pointer so it doesn't sit under the
// cursor or eat elementFromPoint hit-tests (it's also pointer-events:none).
function moveDragGhost(x: number, y: number): void {
  if (!dragGhostEl) return;
  dragGhostEl.style.left = `${x}px`;
  dragGhostEl.style.top = `${y}px`;
}

function removeDragGhost(): void {
  dragGhostEl?.remove();
  dragGhostEl = null;
}

// A real drag ends with a click (pointerup over the row); swallow that one click
// so the drag doesn't also play/commit the row. Cleared shortly after in case no
// click fires (e.g. the pointer released off the row).
function suppressNextClick(): void {
  const stop = (ev: Event) => ev.stopPropagation();
  window.addEventListener("click", stop, { capture: true, once: true });
  setTimeout(() => window.removeEventListener("click", stop, true), 300);
}

// Hit-test the pointer against the open list and paint the drop marker. Returns
// the view index an insert would land at: before the row under the pointer (top
// half) or after it (bottom half); the end of the list when the pointer is over
// the list's empty area past the last row (or an empty list); null when the
// pointer is off the list entirely, which cancels the drop.
function updateDropTarget(x: number, y: number): number | null {
  clearDropMarkers();
  const d = activeDrag;
  if (!d) return null;
  const rows = Array.from(d.listEl.querySelectorAll<HTMLElement>(d.rowSelector));
  const el = document.elementFromPoint(x, y) as HTMLElement | null;
  const row = el?.closest(d.rowSelector) as HTMLElement | null;
  if (row && d.listEl.contains(row)) {
    const rect = row.getBoundingClientRect();
    const before = y < rect.top + rect.height / 2;
    row.classList.add(before ? "drop-before" : "drop-after");
    return rows.indexOf(row) + (before ? 0 : 1);
  }
  // Off the rows: an insert at the end while still within the list box, else cancel.
  const box = d.listEl.getBoundingClientRect();
  const inside = x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
  return inside ? rows.length : null;
}

function clearDropMarkers(): void {
  activeDrag?.listEl
    .querySelectorAll(".drop-before, .drop-after")
    .forEach((el) => el.classList.remove("drop-before", "drop-after"));
}

// Resolve a drop at view index `at`: an internal reorder, an insert of track(s)
// dragged in from the tree, or a station reorder in the stream list.
function applyDrop(p: DragPayload, at: number): void {
  if (p.kind === "reorder") reorderCuratedTracks(p.tracks, at);
  else if (p.kind === "tracks") insertCuratedTracks(p.tracks, at);
  else void reorderStream(p.stream, at);
}

// Make a list row a drag source for reorder. A pointerdown on the row's remove
// button is ignored so the ✕ stays a plain click. The row is also a drop target
// for tree-track inserts, resolved by pointer hit-testing in updateDropTarget.
function attachRowReorder(li: HTMLElement, track: SearchTrack): void {
  li.addEventListener("pointerdown", (e) => {
    if ((e.target as HTMLElement).closest(".queue-remove")) return;
    // Dragging a selected row carries the whole selection (in view order); a row
    // outside the selection carries just itself. Mirrors the tree drag so a
    // multi-selection reorders as one block instead of only the grabbed row.
    const sel = queueSel.signal.peek();
    const tracks = sel.has(track) && sel.size > 1 ? selectedListTracks() : [track];
    beginPointerDrag(e, { kind: "reorder", tracks }, li, queueListEl, "li.queue-row");
  });
}

// Make a stream row a drag source for reordering the (writable, local) stream
// list. A pointerdown on the hover play button is ignored so it stays a plain
// click; the drop persists straight to the .m3u8 via move_stream + refresh.
function attachStreamReorder(li: HTMLElement, stream: Stream): void {
  li.addEventListener("pointerdown", (e) => {
    if (!streamListWritable.value) return;
    if ((e.target as HTMLElement).closest(".row-play")) return;
    beginPointerDrag(e, { kind: "stream", stream }, li, streamsContainer, "li.stream-row");
  });
}

// Move a dragged station to view index `to` (insert-before) and persist the new
// order to the stream list file, then re-render. The station's live index is
// resolved against allStreams at drop time; a no-op move is skipped so it doesn't
// rewrite the file needlessly.
async function reorderStream(stream: Stream, to: number): Promise<void> {
  if (!streamListWritable.value) return;
  const from = allStreams.indexOf(stream);
  if (from < 0 || to === from || to === from + 1) return;
  try {
    await invoke("move_stream", { path: streamListPathInput.value, from, to });
  } catch (e) {
    console.error("move_stream failed", e);
    return;
  }
  await refreshStreams(streamListPathInput.value);
}

// "<artist> – <title>" for the current track (title alone when the artist is
// unknown), used as the nav bar's playing context.
function nowPlayingLabel(): string {
  let t = npTitle.value;
  let a = npArtist.value;
  // Radio: once the station sends ICY metadata, name the current song/artist
  // rather than the bare station name, falling back to the station on the title
  // line. Mirrors pushNowPlayingMeta so the nav bar and OS widget agree.
  if (isStream.value && npStreamMeta.value) {
    t = npStreamMeta.value.song;
    a = npStreamMeta.value.artist ?? npTitle.value;
  }
  return a ? `${a} – ${t}` : t;
}

// The next track in straight-play order as "<artist> – <title>", or null when
// it can't be named (shuffle is nondeterministic; repeat-one loops in place —
// both handled by the caller). Under repeat-all the last track wraps to the
// first. Best-effort — it feeds the hero-face "Up Next" hint, not playback.
function upNextLabel(): string | null {
  if (shuffleMode.value || repeatMode.value === "one") return null;
  const pool = poolPaths();
  const curIdx = queueIsActivePool() && queuePlayingIndex.value != null
    ? queuePlayingIndex.value
    : pool.indexOf(currentNodePath.value ?? "");
  let nextIdx = curIdx + 1;
  if (nextIdx >= pool.length) {
    if (repeatMode.value !== "all") return null; // genuine end
    nextIdx = 0; // wrap
  }
  const nextPath = pool[nextIdx];
  if (curIdx < 0 || !nextPath) return null;
  const t = (activeQueue.value?.tracks ?? []).find((x) => x.path === nextPath)
    ?? currentParent?.children.find((c) => c.path === nextPath);
  if (!t) return null;
  const title = t.title ?? (nextPath.split(/[\\/]/).pop() ?? nextPath);
  return t.artist ? `${t.artist} – ${title}` : title;
}

// The nav bar above the transport. It swaps the two faces and names the source:
// on the list face the button returns to the hero ("Now Playing"), on the hero
// face it reveals the list ("Show Queue" / "Show Playlist"). A null button is
// hidden. An idle browse (a playlist open, nothing playing) has neither a source
// to name nor a face to flip to, so the whole bar drops out (null nav) rather
// than sitting empty — the list face keeps the pane.
interface NavState {
  text: string;
  // The face-swap button's label, or null when the button is hidden.
  button: string | null;
  // A secondary button shown only while browsing a playlist with a different
  // source playing underneath: it leaves the browse for the playing source's
  // own list ("Show Queue", or "Show Playlist" when the source is a playlist).
  // Null in every other state.
  altButton: string | null;
}

// A single derived description of the right pane. Every pane render — whether the
// nav bar exists at all, its text and button, which face is up, and the list the
// list-face shows — is a pure function of the playback signals, collected here so
// no render path hand-reconciles them (see architecture-notes Suggestion 1: derive
// the view, don't store it). Rendering effects read this one value instead of
// reaching into `browsedPlaylist`, `activeQueue`, `listFaceOpen`, `hasTrack`, the
// mode signals, and the queue-drained tell individually and risking disagreement.
interface PaneView {
  // The list the list-face shows (queue or open playlist), or null when only the
  // hero exists. Null hides the nav bar (.has-nav) entirely.
  list: Queue | null;
  // The list is the playing source (row highlight; clicking a row jumps the pool)
  // vs. a playlist merely browsed while something else plays (no highlight; a row
  // click commits it). Mirrors `browsedPlaylist === null`.
  isSource: boolean;
  // The list face is up (else the hero fills the pane). Only meaningful with a list.
  showList: boolean;
  // The nav bar's content, or null when the bar should be hidden: either there's
  // no list, or a list is browsed with nothing playing (nothing to name/flip).
  nav: NavState | null;
}

const paneView = computed<PaneView>(() => {
  const browsed = browsedPlaylist.value;
  const list = browsed ?? activeQueue.value;
  const isSource = browsed === null;
  const showList = listFaceOpen.value;
  if (!list) return { list: null, isSource, showList: false, nav: null };

  let nav: NavState;
  if (showList) {
    if (hasTrack.value) {
      // A queue that ran to its end rests as the pool with no playing row — that's
      // "End of queue" (no track to name). (queuePlayingIndex is the reactive tell:
      // set while a row plays/pauses, null once the queue drains.)
      const drained = queueIsActivePool() && queuePlayingIndex.value === null;
      // Browsing a playlist while a *different* source plays: offer a jump
      // straight to that source's list alongside the hero flip. Suppressed when
      // the browsed playlist is itself the playing source (same file) — that
      // button would just point back at the list you're already viewing.
      const active = activeQueue.value;
      const source =
        browsed !== null && active && active.sourcePath !== browsed.sourcePath
          ? active
          : null;
      nav = {
        // Keep naming the current track even while paused — the transport
        // controls already show the paused state, so the useful thing to show
        // is *what* is paused. Only a drained queue has no track to name.
        text: drained ? "End of queue" : nowPlayingLabel(),
        button: "Now Playing",
        altButton: source
          ? isPlaylistSource(source)
            ? "Show Playlist"
            : "Show Queue"
          : null,
      };
    } else {
      // Browsing a list with nothing playing: no source to name, nowhere to flip
      // to. The bar has no job, so drop it entirely (null nav hides .has-nav) —
      // the list face still owns the pane.
      return { list, isSource, showList, nav: null };
    }
  } else {
    const sourceName = isPlaylistSource(list) ? list.title : "Queue";
    const button = isPlaylistSource(list) ? "Show Playlist" : "Show Queue";
    // Describe what's coming. Shuffle and repeat-one have no single "next track"
    // to name — say what mode is running over the source instead. Otherwise name
    // the next track (repeat-all wraps), and only a genuine end reads "End of
    // queue" — or "End of playlist" when the source is a playlist, which is not a
    // queue.
    let text: string;
    if (!hasTrack.value || (!hasNextTrack() && repeatMode.value !== "one")) {
      text = isPlaylistSource(list) ? "End of playlist" : "End of queue";
    } else if (shuffleMode.value) {
      text = `Shuffling ${sourceName}`;
    } else if (repeatMode.value === "one") {
      text = "Repeating this track";
    } else {
      const next = upNextLabel();
      text = next ? `Up Next: ${next}` : "Up Next";
    }
    nav = { text, button, altButton: null };
  }
  return { list, isSource, showList, nav };
});

// Paint the nav bar from the derived view. Nothing to reconcile: text and button
// are already resolved in paneView.
function renderNavBar(): void {
  const nav = paneView.value.nav;
  if (!nav) return; // no list → nav hidden via .has-nav
  navBarTextEl.textContent = nav.text;
  navBarBtnEl.textContent = nav.button ?? "";
  navBarBtnEl.classList.toggle("hidden", nav.button === null);
  navBarAltBtnEl.textContent = nav.altButton ?? "";
  navBarAltBtnEl.classList.toggle("hidden", nav.altButton === null);
}

// The nav bar's face-swap button: to the hero from the list, to the list from
// the hero.
function toggleNavFace(): void {
  if (listFaceOpen.value) showHeroFace();
  else showListFace();
}

// --- Playback ---

function setNowPlaying(
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
  const root = rootNode;
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

function togglePlayPause(): void {
  // A queue resting with no playhead — drained at its end, or armed from silence
  // by "Add to queue" without auto-playing — starts from the top. This is checked
  // before the idle-play fallback so an armed queue (hasTrack still false, nothing
  // ever played) starts itself rather than the whole library.
  if (queueEnded && lastQueue.length > 0) {
    queueEnded = false;
    if (queueIsActivePool()) {
      // The queue rests with no playhead, so play restarts it from the top rather
      // than resuming any one track. (activeQueue can now be set while a folder
      // plays with the queue merely stashed — the pool, not its mere existence,
      // is what decides this.)
      const pool = poolPaths();
      lastQueue = pool;
      lastIndex = 0;
      pendingQueueIndex = 0;
      currentNodePath.value = pool[0] ?? null;
      feedEngine(pool, 0);
    } else {
      // Implicit folder continuation: the album played through and stopped, so
      // play restarts it from the start of the folder — matching how a queue pool
      // and the navigator's leaf lists restart from their top rather than resuming
      // the track you happened to start on.
      lastIndex = 0;
      currentNodePath.value = lastQueue[0] ?? null;
      feedEngine(lastQueue, 0);
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
  await store.set(KEY_VOLUME, v);
  await store.save();
}, 200);

// Most recent non-muted volume, restored when unmuting via the volume button.
let lastNonZeroVolume = 1;

function setVolume(v: number): void {
  const clamped = Math.max(0, Math.min(1, v));
  if (clamped > 0) lastNonZeroVolume = clamped;
  if (clamped === volume.value) return;
  volume.value = clamped;
  persistVolume(clamped);
}

function seekBy(seconds: number): void {
  if (isStream.value) return;
  queueEnded = false;
  void engine.seekBy(seconds);
}

function seekTo(seconds: number): void {
  if (isStream.value) return;
  queueEnded = false;
  void engine.seekTo(seconds);
}

// The tracks eligible for shuffle/repeat advancement. Inside an album that's
// the folder's tracks in listing order; a search hit or external file has no
// album context, so the pool is just that single track.
function poolPaths(): string[] {
  if (currentParent) {
    return currentParent.children.filter((c) => !c.isFolder).map((c) => c.path);
  }
  if (currentNodePath.value) return [currentNodePath.value];
  // Search hit or external file: no album context, so the queue itself is the
  // pool (a single track). Lets repeat still loop it.
  return lastQueue;
}

function shuffled<T>(items: T[]): T[] {
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
function refillShuffleBag(current: string | null): void {
  const pool = poolPaths();
  const rest = pool.filter((p) => p !== current);
  shuffleBag = shuffled(rest.length ? rest : pool);
}

// Hand the engine a single track and remember it as the queue, so play-after-end
// and the play button restart the right thing. UI (row highlight, now-playing,
// art) follows from the engine's track-changed → onAdvance for album tracks;
// for a lone search/external track it's already correct (same track).
function playSingle(path: string, queueIndex?: number): void {
  queueEnded = false;
  lastQueue = [path];
  lastIndex = 0;
  currentTime.value = 0;
  // Shuffle / repeat-one hand the engine one track at a time; when that track is
  // a queue row, mark which one so onAdvance highlights it. Callers pass the
  // positional index when known (e.g. repeat-one looping row 3 of a duplicate-
  // heavy queue) so the correct instance is highlighted rather than the first match.
  if (queueIsActivePool()) {
    if (queueIndex != null) {
      pendingQueueIndex = queueIndex;
    } else {
      const found = currentParent?.children.findIndex((c) => c.path === path) ?? -1;
      pendingQueueIndex = found >= 0 ? found : null;
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
function playPool(pool: string[], idx: number): void {
  queueEnded = false;
  lastQueue = pool;
  lastIndex = idx;
  if (queueIsActivePool()) pendingQueueIndex = idx;
  feedEngine(pool, idx);
}

// Playback has run to the end with nothing left to advance to. A visible queue
// rests with no playhead — the finished rows stay on screen, but nothing is
// "current", so pressing play restarts it from the top (see togglePlayPause).
// Implicit folder continuation keeps its row highlighted so play resumes the
// track that just finished.
function stopAtQueueEnd(): void {
  queueEnded = true;
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
function handleEnded(): void {
  const mode = repeatMode.value;
  // currentNodePath is null for an external file; fall back to the queue so
  // repeat still identifies the track to loop.
  const current = currentNodePath.value ?? lastQueue[lastIndex] ?? null;

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
    if (shuffleBag.length === 0) {
      // Cycle exhausted: reshuffle and keep going when repeating, else stop.
      if (mode !== "all") {
        stopAtQueueEnd();
        return;
      }
      refillShuffleBag(current);
    }
    const next = shuffleBag.shift();
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
function skipNext(): void {
  if (isStream.value) return;
  const current = currentNodePath.value ?? lastQueue[lastIndex] ?? null;

  if (shuffleMode.value) {
    if (shuffleBag.length === 0) refillShuffleBag(current);
    const next = shuffleBag.shift();
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
function skipPrev(): void {
  if (isStream.value) return;
  if (currentTime.value > 3 || shuffleMode.value) {
    void engine.seekTo(0);
    return;
  }
  const current = currentNodePath.value ?? lastQueue[lastIndex] ?? null;
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
function hasNextTrack(): boolean {
  if (!hasTrack.value || isStream.value) return false;
  if (shuffleMode.value) return true;
  const pool = poolPaths();
  if (pool.length === 0) return false;
  if (repeatMode.value === "all") return true;
  const current = currentNodePath.value ?? lastQueue[lastIndex] ?? null;
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
function playFile(node: TreeNode, parent: TreeNode, startIndex?: number): void {
  currentParent = parent;
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
  queueEnded = false;
  setNowPlaying(node.title ?? node.name, node.artist, node.album);
  void loadArt(node.path);
  const siblings = parent.children.filter((c) => !c.isFolder);
  const tracks = siblings.map((c) => c.path);
  if (repeatMode.value === "one") {
    // Loop this track; the album never enters the queue.
    shuffleBag = [];
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
    shuffleBag = [];
    const idx = startIndex ?? Math.max(
      0,
      siblings.findIndex((c) => c.path === node.path),
    );
    lastQueue = tracks;
    lastIndex = idx;
    if (queueIsActivePool()) pendingQueueIndex = idx;
    feedEngine(tracks, idx);
  }
}

function playStream(stream: Stream): void {
  // A stream is lone playback: dismiss any open queue/playlist and land on the
  // hero (its own face, no nav bar). Null the highlight (streams emit no
  // track-changed, so onAdvance won't).
  resetToLonePlayback();
  queuePlayingIndex.value = null;
  currentParent = null;
  currentNodePath.value = null;
  currentStreamUrl.value = stream.url;
  // The played station is also the selected row, so selection follows playback
  // (matching a played tree track) rather than leaving a stale prior highlight.
  selectedStreamUrl.value = stream.url;
  currentStreamName = stream.name;
  isStream.value = true;
  currentTime.value = 0;
  duration.value = 0;
  queueEnded = false;
  lastQueue = [];
  shuffleBag = [];
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
function playSearchTrack(t: SearchTrack): void {
  // A lone search hit is lone playback: dismiss any open queue/playlist and land
  // on the hero. currentParent is null so onAdvance won't touch the highlight.
  resetToLonePlayback();
  queuePlayingIndex.value = null;
  currentParent = null;
  currentNodePath.value = t.path;
  currentStreamUrl.value = null;
  isStream.value = false;
  currentTime.value = 0;
  duration.value = 0;
  queueEnded = false;
  lastQueue = [t.path];
  lastIndex = 0;
  shuffleBag = [];
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
function syntheticParent(
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

async function playFolder(folder: SearchFolder): Promise<void> {
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

// One resolved row from read_playlist. `missing` rows are kept for round-trip
// but filtered out of what's handed to the engine (so gapless never stalls).
interface PlaylistTrack {
  path: string;
  name: string;
  title: string | null;
  artist: string | null;
  album: string | null;
  albumArtist: string | null;
  disc: number | null;
  track: number | null;
  inLibrary: boolean;
  missing: boolean;
  duration: number | null;
}

interface PlaylistData {
  name: string;
  path: string;
  tracks: PlaylistTrack[];
}

// The playable rows of a playlist as SearchTracks (dropping missing files),
// ready for the queue/engine machinery.
function playlistPlayableTracks(data: PlaylistData): SearchTrack[] {
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
function playlistViewTracks(data: PlaylistData): SearchTrack[] {
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
function attachPlaylistClicks(label: HTMLElement, node: TreeNode): void {
  label.addEventListener("click", () => void browsePlaylist(node));
  label.addEventListener("dblclick", () => void playPlaylist(node));
}

// Double-click / "Play": play the playlist from its first track. A playlist
// plays like a folder — autoadvance/shuffle/repeat-all apply — via the queue
// machinery under a `queue:playlist:` synthetic path (so it reads the Playlists
// autoadvance context). It becomes the playing source (playQueue shows the list
// face titled by its name, distinct from an ephemeral "Queue").
async function playPlaylist(node: TreeNode): Promise<void> {
  await playPlaylistPath(node.path);
}

// Play a playlist by file path (tree double-click / "Play", or a search hit).
// Shows it as the playing source (its own list face titled by its name, distinct
// from an ephemeral "Queue").
async function playPlaylistPath(path: string): Promise<void> {
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
async function browsePlaylist(node: TreeNode): Promise<void> {
  await browsePlaylistPath(node.path);
}

// Browse a playlist by file path (tree single-click, OS Open…, Open Recent).
// Reads and shows it as the open playlist without changing playback, and
// records it as recent.
async function browsePlaylistPath(path: string): Promise<void> {
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

async function addPlaylistToQueue(node: TreeNode): Promise<void> {
  const queueBefore = activeQueue.value;
  const pathBefore = currentNodePath.value;
  try {
    const data = await invoke<PlaylistData>("read_playlist", { path: node.path });
    if (activeQueue.value !== queueBefore) return;
    if (!queueBefore && currentNodePath.value !== pathBefore) return;
    addToQueue(playlistPlayableTracks(data));
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

interface RecentPlaylist {
  path: string;
  name: string;
}

let recentPlaylists: RecentPlaylist[] = [];

// --- Playlist index (phase 4) ---
// Every `.m3u/.m3u8` under the library root — path + display name — backing the
// "Add to playlist ▸" submenu and searchable playlists. Built from Rust's
// `list_all_playlists` and kept fresh by the filesystem watcher (refreshLibrary
// runs on every library change, our own writes included). Read synchronously
// when a context menu is built, so the submenu reflects the current library.
export interface PlaylistRef {
  path: string;
  name: string;
}

let playlistIndex: PlaylistRef[] = [];

async function refreshPlaylistIndex(): Promise<void> {
  const roots = libraryRootPaths();
  if (roots.length === 0) {
    playlistIndex = [];
    refreshNavPlaylists();
    return;
  }
  try {
    // list_all_playlists is keyed to one root (it walks that tree), so scan each
    // configured folder and merge into a single index.
    const perRoot = await Promise.all(
      roots.map((root) => invoke<PlaylistRef[]>("list_all_playlists", { root })),
    );
    playlistIndex = perRoot.flat();
  } catch (e) {
    console.error("list_all_playlists failed", e);
  }
  // Keep the navigator's root-menu playlist list in step with the index.
  refreshNavPlaylists();
}

// The filename stem (no extension) — the display name for a freshly saved file
// before it carries a #PLAYLIST: directive of its own.
function playlistNameFromPath(path: string): string {
  const base = path.split("/").pop() ?? path;
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  return stem || "Untitled";
}

// Default directory for a save dialog: the first library folder when set, else
// let the OS pick. Used so New / Save-as land in the library by default.
function defaultPlaylistDir(): string | null {
  return libraryRootPaths()[0] ?? null;
}

async function persistRecentPlaylists(): Promise<void> {
  await store.set(KEY_RECENT_PLAYLISTS, recentPlaylists);
  await store.save();
}

// Save the navigator's current place so it's restored on the next launch. The
// navigator calls this (fire-and-forget) on every drill / back / pop; writes are
// at click frequency, so no debounce is needed.
function persistNavLocation(steps: NavStep[]): void {
  void (async () => {
    await store.set(KEY_NAV_LOCATION, steps);
    await store.save();
  })();
}

// Push a playlist to the front of the recents (most-recent first, deduped by
// path, capped), persist, and rebuild the native Open Recent submenu.
function addRecentPlaylist(path: string, name: string): void {
  recentPlaylists = [
    { path, name },
    ...recentPlaylists.filter((r) => r.path !== path),
  ].slice(0, RECENT_PLAYLISTS_MAX);
  void persistRecentPlaylists();
  syncRecentPlaylistsMenu();
}

function removeRecentPlaylist(path: string): void {
  recentPlaylists = recentPlaylists.filter((r) => r.path !== path);
  void persistRecentPlaylists();
  syncRecentPlaylistsMenu();
}

function syncRecentPlaylistsMenu(): void {
  void invoke("set_recent_playlists", { items: recentPlaylists });
}

// New Playlist…: save dialog → write an empty .m3u8 → open it ready to fill.
async function menuNewPlaylist(): Promise<void> {
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
async function menuOpenPlaylist(): Promise<void> {
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
async function menuSavePlaylist(): Promise<void> {
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
function queueCanSaveAsPlaylist(): boolean {
  const q = activeQueue.value;
  return !!q && !isPlaylistSource(q) && queueIsActivePool();
}

// Write the live queue to `path`, then repoint it at that file so it becomes an
// autosaving playlist source: from here on curations flow to disk (saveOpenPlaylist
// keys off sourcePath). kind is already "playlist"; we adopt the saved name too.
// Guard against a queue swap during the write. The browse at the end opens with
// the same sourcePath, so the two are recognised as one pool rather than diverging.
async function saveQueueAsPlaylist(path: string): Promise<void> {
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
async function menuMovePlaylist(): Promise<void> {
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

// Opens a queue in the right pane and starts it. Playback reuses the album path
// via a synthetic parent (so shuffle/repeat/gapless all work); the queue view is
// what makes it visible. Under shuffle we start on a random track (matching
// playFolder) so replaying the same artist/album doesn't always open on track 1;
// straight play starts on the first track, the page's natural order. Either way
// the view keeps natural order and just highlights the playing row. The synthetic
// path is unique per queue and never a real tree path, so the rescan re-bind
// (suppressed while activeQueue is set) can't repoint currentParent at a folder.
function playQueue(queue: Queue, syntheticPath: string, startIndex?: number): void {
  // The engine pool is the playable rows only; any missing rows stay in the view
  // (openActiveQueue keeps queue.tracks intact) but never reach the engine, so
  // gapless never stalls on a dangling file. renderQueue bridges the two index
  // spaces. For non-playlist queues nothing is missing, so pool === view.
  const playable = queue.tracks.filter((t) => !t.missing);
  if (playable.length === 0) return;
  const parent = syntheticParent(syntheticPath, queue.title, playable);
  // A given start row (a browsed playlist committed from a row) wins; otherwise
  // shuffle opens on a random track and straight play on the first.
  const startAt = startIndex != null
    ? startIndex
    : shuffleMode.value
      ? Math.floor(Math.random() * parent.children.length)
      : 0;
  playFile(parent.children[startAt], parent, startAt);
  openActiveQueue(queue);
  // Every explicit Play verb presents its list; committing to play also
  // abandons any prior browse (this queue is now the source).
  browsedPlaylist.value = null;
  listFaceOpen.value = true;
}

// Play a browsed playlist starting at a given row — the commit that turns a
// browse into the playing source. Reuses the same synthetic path as double-
// click Play so it reads the Playlists autoadvance context.
function commitBrowsedPlaylist(startIndex: number): void {
  const q = browsedPlaylist.value;
  if (!q?.sourcePath) return;
  playQueue(q, `queue:playlist:${q.sourcePath}`, startIndex);
}

// --- Curation (phase 3): reorder / remove / drag-in on the open list ---
//
// Edits act on the list currently shown — a browsed playlist if one is open, else
// the active queue. Three tiny operations (reorder, remove, insert) produce a new
// view-array and funnel through applyCuration, which updates the signal, autosaves
// the file (playlists only), and — when the edited list is the audible pool —
// reconciles playback so the playing track is undisturbed (or skipped, if it was
// the removed row). See playlist-plan.md "reconciling reorder/remove with live
// playback".

// The list a curation edit targets: the open browse if any, else the active queue.
function curatedList(): Queue | null {
  return browsedPlaylist.value ?? activeQueue.value;
}

// Map a playable-pool index (queuePlayingIndex, which excludes missing rows) back
// to its index in the full view array. Inverse of renderQueue's poolIdx walk.
function viewIndexOfPlayable(tracks: SearchTrack[], playableIdx: number): number {
  let p = 0;
  for (let i = 0; i < tracks.length; i++) {
    if (tracks[i].missing) continue;
    if (p === playableIdx) return i;
    p++;
  }
  return -1;
}

// The playing row's SearchTrack object in `list`, or null. Tracked by object
// identity (not path) so a reorder/remove follows the exact instance even when the
// list holds duplicate paths.
function playingTrackObj(list: Queue): SearchTrack | null {
  const idx = queuePlayingIndex.value;
  if (idx == null) return null;
  const v = viewIndexOfPlayable(list.tracks, idx);
  return v >= 0 ? list.tracks[v] : null;
}

// Persist the open playlist after an edit. Every row is written (missing included)
// so the file round-trips; paths only — metadata is re-resolved from the DB on read.
async function saveOpenPlaylist(path: string, name: string, tracks: SearchTrack[]): Promise<void> {
  try {
    await invoke("write_playlist", { path, name, tracks: tracks.map((t) => t.path) });
  } catch (e) {
    console.error("write_playlist (autosave) failed", path, e);
    toast("Couldn't save playlist");
  }
}

// Apply a new view-array to the open list: swap the signal, reconcile playback when
// it's the live pool, and autosave when it's a playlist file.
function applyCuration(newTracks: SearchTrack[]): void {
  const browsed = browsedPlaylist.value;
  const list = browsed ?? activeQueue.value;
  if (!list) return;
  // The edit touches the live engine pool when we're editing the active pool
  // directly (no browse open), or when the browsed playlist *is* the playing
  // pool — same source file, opened for a look while it plays. Without the
  // second case, curating a browsed copy of the playing playlist would write the
  // file but leave the engine order, gapless tail, and activeQueue.tracks stale.
  const active = activeQueue.value;
  const browsedIsActivePool =
    browsed !== null &&
    queueIsActivePool() &&
    active != null &&
    browsed.sourcePath != null &&
    browsed.sourcePath === active.sourcePath;
  const isPool = (browsed === null && queueIsActivePool()) || browsedIsActivePool;
  // Capture the playing instance (by ref) from the *old* array before the swap.
  const playingObj = isPool ? playingTrackObj(list) : null;

  const updated: Queue = {
    ...list,
    tracks: newTracks,
    subtitle: trackCountSubtitle(newTracks),
  };
  if (browsed) browsedPlaylist.value = updated;
  else activeQueue.value = updated;

  // When the browsed view is also the live pool, keep the active queue's rows in
  // sync (sharing the edited objects) so a later autosave/reconcile of the queue
  // can't ship the pre-edit list.
  if (browsedIsActivePool && active) {
    activeQueue.value = { ...active, tracks: newTracks, subtitle: updated.subtitle };
  }

  if (isPool) reconcilePoolEdit(newTracks, playingObj);

  if (isPlaylistSource(list) && list.sourcePath) {
    void saveOpenPlaylist(list.sourcePath, list.title, newTracks);
  }
}

// Reconcile the engine + pool state after the live pool's track list changed.
// currentParent.children is rebuilt from the new playable rows; the playing track
// is then either kept (playback undisturbed — indices refreshed, gapless tail
// rebuilt to match the new order) or, if it was the removed row, skipped past.
function reconcilePoolEdit(newTracks: SearchTrack[], playingObj: SearchTrack | null): void {
  if (!currentParent) return;
  const playable = newTracks.filter((t) => !t.missing);
  // Rebuild the synthetic parent's children in place (same path, so
  // queueIsActivePool stays true and the pane keeps rendering this pool).
  currentParent.children = syntheticParent(
    currentParent.path,
    currentParent.name,
    playable,
  ).children;
  const poolPathsNew = playable.map((t) => t.path);
  lastQueue = poolPathsNew;

  const oldPlayableIdx = queuePlayingIndex.value;
  // Nothing was playing (queue drained or never started): just refresh the pool.
  if (playingObj === null || oldPlayableIdx == null) return;

  const newPlayableIdx = playable.indexOf(playingObj);
  if (newPlayableIdx >= 0) {
    // The playing track survived. Keep it playing; refresh the row highlight and
    // resume index; rebuild the engine's gapless tail so the upcoming order
    // matches. Only straight-play-with-autoadvance holds a tail to fix — per-track
    // modes hand the engine one track at a time, so a reorder is inaudible there.
    queuePlayingIndex.value = newPlayableIdx;
    lastIndex = newPlayableIdx;
    if (shuffleMode.value) {
      // Drop any removed paths from the pending bag (dup-lossy, acceptable).
      shuffleBag = shuffleBag.filter((p) => poolPathsNew.includes(p));
    } else if (repeatMode.value !== "one" && autoadvanceEnabled()) {
      // Rebuild the gapless tail: drop the stale upcoming tracks, then re-append
      // the new order. Chained so the append can't race ahead of the clear.
      const tail = poolPathsNew.slice(newPlayableIdx + 1);
      void engine.clearUpcoming().then(() => engine.append(tail));
    }
    return;
  }

  // The playing row was removed → skip to whatever now occupies its slot (an
  // edit, not a stop). The engine is still sounding the removed track, so this
  // must actively start the replacement (or stop when there's nothing left).
  advanceAfterRemovedPlaying(poolPathsNew, oldPlayableIdx);
}

// The playing row was removed from the live pool; move playback onward. Mirrors
// skipNext's mode branches, but the target is the track that *took* the removed
// slot (straight order), not slot+1.
function advanceAfterRemovedPlaying(pool: string[], slot: number): void {
  if (pool.length === 0) {
    stopAfterRemove();
    return;
  }
  if (shuffleMode.value) {
    if (shuffleBag.length === 0) refillShuffleBag(null);
    const next = shuffleBag.shift();
    if (next) playSingle(next);
    else stopAfterRemove();
    return;
  }
  if (repeatMode.value === "one") {
    // Repeat-one can't loop a removed track: adopt the one now at the slot.
    const idx = slot < pool.length ? slot : 0;
    playSingle(pool[idx], idx);
    return;
  }
  const idx = slot < pool.length ? slot : repeatMode.value === "all" ? 0 : -1;
  if (idx < 0) {
    // Removed the last row while it played, no wrap: nothing follows.
    stopAfterRemove();
    return;
  }
  playPool(pool, idx);
}

// Removing the playing row left nothing to advance into: silence the engine and
// rest with no playhead. The (now shorter) list stays on screen.
function stopAfterRemove(): void {
  queuePlayingIndex.value = null;
  currentNodePath.value = null;
  shuffleBag = [];
  void engine.stop();
}

// Reorder the open list: move `moved` (one row, or a whole multi-selection) to
// sit before view index `to`, keeping the moved rows in their view order. A `to`
// past the end appends. By object identity, so duplicate paths keep their
// distinct rows and dropping onto the moving block itself is a no-op.
function reorderCuratedTracks(moved: SearchTrack[], to: number): void {
  const list = curatedList();
  if (!list || moved.length === 0) return;
  const set = new Set(moved);
  // Anchor on the first row at or after `to` that isn't itself moving; drop
  // before it. With none (drop at the end, or inside the block's tail) append.
  let anchor: SearchTrack | null = null;
  for (let i = to; i < list.tracks.length; i++) {
    if (!set.has(list.tracks[i])) {
      anchor = list.tracks[i];
      break;
    }
  }
  const rest = list.tracks.filter((t) => !set.has(t));
  const block = list.tracks.filter((t) => set.has(t)); // in view order
  const insertAt = anchor ? rest.indexOf(anchor) : rest.length;
  const next = rest.slice();
  next.splice(insertAt, 0, ...block);
  if (next.every((t, i) => t === list.tracks[i])) return; // no-op drop
  applyCuration(next);
}

// Remove row `i` from the open list.
function removeCuratedRow(i: number): void {
  const list = curatedList();
  if (!list || i < 0 || i >= list.tracks.length) return;
  const tracks = list.tracks.slice();
  tracks.splice(i, 1);
  applyCuration(tracks);
}

// Remove every selected row (by object identity, so duplicates and reorders
// resolve exactly) from the open list in a single curation edit.
function removeCuratedTracks(objs: SearchTrack[]): void {
  const list = curatedList();
  if (!list || objs.length === 0) return;
  const drop = new Set(objs);
  const tracks = list.tracks.filter((t) => !drop.has(t));
  if (tracks.length === list.tracks.length) return;
  queueSel.clear();
  applyCuration(tracks);
}

// The row that should take the keyboard selection after `removed` is deleted from
// `list`, following the macOS convention: the row that slides up into the first
// deleted slot (the first survivor at or after it), or — if the tail was deleted —
// the last survivor before it. Null when the list is left empty. Keying on object
// identity, so non-contiguous multi-selections and duplicate paths resolve exactly.
function fillRowAfterRemoval(
  list: SearchTrack[],
  removed: SearchTrack[],
): SearchTrack | null {
  const drop = new Set(removed);
  const firstIdx = list.findIndex((t) => drop.has(t));
  if (firstIdx === -1) return null;
  for (let i = firstIdx; i < list.length; i++) {
    if (!drop.has(list[i])) return list[i];
  }
  for (let i = firstIdx - 1; i >= 0; i--) {
    if (!drop.has(list[i])) return list[i];
  }
  return null;
}

// Insert tracks into the open list at `at` (drag-from-tree). Clamped to the list.
function insertCuratedTracks(tracks: SearchTrack[], at: number): void {
  const list = curatedList();
  if (!list || tracks.length === 0) return;
  const next = list.tracks.slice();
  next.splice(Math.max(0, Math.min(at, next.length)), 0, ...tracks);
  applyCuration(next);
}

// Append tracks to the active pool when it's the target but *not* the visible
// list (a different playlist is browsed, so applyCuration would edit the wrong
// one). Mirrors applyCuration's pool path — update the signal, reconcile the
// engine when it's live, autosave the file — but aimed at the active pool
// regardless of what's browsed. The playing instance is captured from the old
// array and survives into `next` by reference, so reconcilePoolEdit re-finds it.
function appendToActivePool(active: Queue, tracks: SearchTrack[]): void {
  const isPool = queueIsActivePool();
  const playingObj = isPool ? playingTrackObj(active) : null;
  const next = [...active.tracks, ...tracks];
  activeQueue.value = {
    ...active,
    tracks: next,
    subtitle: trackCountSubtitle(next),
  };
  if (isPool) reconcilePoolEdit(next, playingObj);
  if (active.sourcePath) void saveOpenPlaylist(active.sourcePath, active.title, next);
}

// --- Rename / delete (phase 3) ---

// Rename the open playlist from the header pencil. The `#PLAYLIST:` directive is
// the only thing that changes — the file never moves — so this rewrites the
// directive + rows in place and refreshes the tree label. Guards an empty name to
// the placeholder (never a nameless playlist).
async function renameOpenPlaylist(input: string): Promise<void> {
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
async function renameTreePlaylist(node: TreeNode, label: HTMLElement, raw: string): Promise<void> {
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
  pendingRevealPlaylistPath = path;
  await refreshLibrary();
}

// Start an inline rename on a playlist's tree row. The whole label (icon + text)
// is swapped for the edit field; commit writes the file, cancel restores as-is.
function startTreePlaylistRename(node: TreeNode, label: HTMLElement): void {
  editInline(label, node.name, (value) => void renameTreePlaylist(node, label, value));
}

// Delete a playlist file from the tree. Confirms first (the file is removed from
// disk), drops it from recents, closes the browse if it was open, and refreshes.
// If the deleted playlist is the *audible* source, playback stops (tear down to
// the empty hero) — leaving it playing would autosave, and thus resurrect, the
// just-deleted file on the next curation. A merely *stashed* copy (a folder/stream
// plays over it) is dropped without disturbing that unrelated playback.
async function deletePlaylistNode(node: TreeNode): Promise<void> {
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

// --- Inline rename editing ---
// Turns a label in place into a text input: the label's current content is hidden
// and an input takes its slot. Commits on Enter or blur, cancels on Escape. This
// replaces the old modal prompt so renaming the open playlist stays on its header
// title rather than interrupting with a dialog.
function editInline(
  host: HTMLElement,
  initial: string,
  onCommit: (value: string) => void,
): void {
  // Guard against a second click (on the host, the pencil, or the input itself)
  // reopening an edit that's already in progress.
  if (host.querySelector(":scope > .inline-edit")) return;
  inlineEditing = true;
  // Lock the row to its current height for the duration of the edit. The input's
  // line box can be a hair shorter than the label it replaces (their line-heights
  // differ across contexts); if the row shrinks while the panel is scrolled to its
  // bottom, the browser clamps scrollTop down and the list appears to creep up.
  // Pinning the height keeps swapping in the input from changing content height.
  const prevMinHeight = host.style.minHeight;
  const prevBoxSizing = host.style.boxSizing;
  const lockHeight = host.getBoundingClientRect().height;
  host.style.boxSizing = "border-box";
  host.style.minHeight = `${lockHeight}px`;
  const hidden = Array.from(host.children) as HTMLElement[];
  for (const el of hidden) el.style.display = "none";
  const input = h("input", {
    class: "inline-edit",
    attrs: { type: "text", autocomplete: "off" },
  });
  input.value = initial;
  input.spellcheck = false;
  host.appendChild(input);
  // preventScroll: focusing an element otherwise scrolls it into view. Harmless on
  // the header (already visible, outside any scroller), but in a long, scrolled
  // tree it yanks the panel to the row — one of the two causes of the old
  // "scroll on edit" bug (the other being a full renderTree; see renameTreePlaylist).
  input.focus({ preventScroll: true });
  input.select();
  let done = false;
  const finish = (commit: boolean): void => {
    if (done) return;
    done = true;
    inlineEditing = false;
    const value = input.value;
    input.remove();
    host.style.minHeight = prevMinHeight;
    host.style.boxSizing = prevBoxSizing;
    for (const el of hidden) el.style.display = "";
    if (commit) onCommit(value);
    // Flush any watcher refresh that arrived while the edit was open (e.g. the
    // scan from a prior rename's write). Runs after onCommit so this rename's own
    // write is included in the single rebuild.
    if (refreshDeferredWhileEditing) {
      refreshDeferredWhileEditing = false;
      void refreshLibrary();
    }
  };
  input.addEventListener("keydown", (e) => {
    // Keep Enter/Escape (and any typing) from reaching the tree/global handlers.
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      finish(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      finish(false);
    }
  });
  input.addEventListener("blur", () => finish(true));
  // The input sits inside a row/label whose click plays; swallow those so
  // interacting with the field never triggers playback or a re-edit.
  input.addEventListener("click", (e) => e.stopPropagation());
  input.addEventListener("mousedown", (e) => e.stopPropagation());
}

// Start renaming the open playlist from its header — clicking the title text or
// the pencil both land here. A no-op unless a real playlist is open.
function startTitleEdit(): void {
  const list = curatedList();
  if (!list?.sourcePath) return;
  const host = queueTitleEl.parentElement;
  if (!host) return;
  editInline(host, list.title, (value) => void renameOpenPlaylist(value));
}

async function openArtistQueue(name: string): Promise<void> {
  let tracks: SearchTrack[];
  try {
    tracks = await invoke<SearchTrack[]>("artist_tracks", { artist: name });
  } catch (e) {
    console.error("artist_tracks failed", name, e);
    return;
  }
  if (tracks.length === 0) return;
  playQueue(
    {
      kind: "artist",
      title: name,
      subtitle: trackCountSubtitle(tracks),
      tracks,
    },
    `queue:artist:${name}`,
  );
}

async function openAlbumQueue(album: string, albumArtist: string): Promise<void> {
  let tracks: SearchTrack[];
  try {
    tracks = await invoke<SearchTrack[]>("album_tracks", { album, albumArtist });
  } catch (e) {
    console.error("album_tracks failed", album, albumArtist, e);
    return;
  }
  if (tracks.length === 0) return;
  playQueue(
    {
      kind: "album",
      title: album,
      subtitle: trackCountSubtitle(tracks),
      tracks,
    },
    // NUL joins the two keys so a "/" in either can't forge a collision.
    `queue:album:${albumArtist}\0${album}`,
  );
}

// --- Add to queue ---
//
// The queue is explicit: it exists only once the user deliberately builds one,
// and holds only what they put in it (playing a folder track still auto-continues
// under the hood, but that never presents as a queue). There are exactly two
// verbs: "Play X" (folder/album/artist) replaces and plays now, while
// "Add to queue" only ever appends — play-later, never interrupting the audible
// track. That symmetry is why a track has no "Play" menu item of its own (a
// left-click already plays it) and no "start queue" verb: the sole way to build
// an explicit queue by hand is to Add to queue.
//
// Adding when no queue exists yet: if a track is playing (implicit folder
// continuation), seed a queue from just that one track — the song the user can
// already hear, so row 1 is never a surprise — and append after it, severing the
// folder tail so only explicitly-queued tracks follow (seedQueueFromCurrent). If
// nothing is playing, the append starts a fresh queue that plays at once.
//
// The visible queue and the engine's queue are kept in step: the engine plays a
// flat path list, while the frontend resolves per-track metadata (row highlight,
// now-playing on auto-advance) through currentParent.children — so appended
// tracks must land in both. currentParent.children is also the shuffle/repeat
// pool (poolPaths), so they join that too.

function trackToNode(t: SearchTrack): TreeNode {
  return {
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
  };
}

function nodeToTrack(n: TreeNode): SearchTrack {
  return { path: n.path, title: n.title, artist: n.artist, album: n.album };
}

function appendTracksToActiveQueue(tracks: SearchTrack[]): void {
  const q = activeQueue.value;
  if (!q || tracks.length === 0) return;
  const paths = tracks.map((t) => t.path);

  // Sync the engine only when the queue is the pool that's actually playing. A
  // stashed queue (a folder/stream/lone track is the pool) grows as data alone —
  // its tracks reach the engine only when the user later plays from the queue,
  // which rebuilds the pool from these same tracks (playQueueTrack).
  if (queueIsActivePool()) {
    // Grow the playback pool: onAdvance/siblingByPath and poolPaths read
    // currentParent.children, so appended tracks live there to resolve on
    // auto-advance and to join shuffle/repeat.
    if (currentParent) currentParent.children.push(...tracks.map(trackToNode));
    lastQueue = [...lastQueue, ...paths];

    if (queueEnded) {
      // The queue rests with no playhead — drained at its end, or armed from
      // silence by "Add to queue" without auto-playing. Appends grow the pool
      // (done above) but never start playback: "Add to queue" is play-later, so
      // the queue stays at rest and the play button starts it from the top.
    } else if (!shuffleMode.value && repeatMode.value !== "one" && autoadvanceEnabled()) {
      // Straight play with autoadvance on: the engine holds the whole queue and
      // auto-advances gaplessly, so append natively — the new tracks play on
      // uninterrupted. With autoadvance off the engine holds only the current
      // track; the appends stay pool-only (reachable by a manual skip) and never
      // enter the engine, so playback still stops at the current track's end.
      void engine.append(paths);
    } else if (shuffleMode.value) {
      // Shuffle hands the engine one track at a time (handleEnded picks the next
      // from the bag), so route the new tracks through the pending bag.
      shuffleBag.push(...shuffled(paths));
    }
    // repeat-one: nothing to enqueue now; the appended tracks joined the pool for
    // when repeat-one is turned off.
  }

  // Bring the first appended row into view on the coming re-render (else the
  // list would snap back to the playing row and hide the addition below the fold).
  pendingQueueScrollIndex = q.tracks.length;
  // Reassign to re-render the list + count.
  const combined = [...q.tracks, ...tracks];
  openActiveQueue({
    ...q,
    tracks: combined,
    subtitle: trackCountSubtitle(combined),
  });
}

// Promotes the track currently playing (via implicit folder continuation) into a
// one-row explicit queue, so a following append has a coherent row 1 and playback
// continues uninterrupted. Only the audible track is captured — never the rest of
// the folder — and the folder tail is severed (clearUpcoming) so nothing but the
// explicit queue follows it. Metadata comes from the playing node when we can
// find it, else the now-playing signals.
function seedQueueFromCurrent(): void {
  const path = currentNodePath.value;
  if (!path) return;
  const cur = currentParent?.children.find((c) => c.path === path);
  const track: SearchTrack = cur
    ? nodeToTrack(cur)
    : { path, title: npTitle.value || null, artist: npArtist.value, album: npAlbum.value };
  const title = UNTITLED_PLAYLIST_TITLE;
  currentParent = syntheticParent(`queue:current:${Date.now()}`, title, [track]);
  lastQueue = [path];
  lastIndex = 0;
  // The audible track is now the queue's row 0 and keeps playing (no new engine
  // play fires here), so highlight it directly rather than waiting on onAdvance.
  queuePlayingIndex.value = 0;
  shuffleBag = [];
  // Straight play holds the whole folder in the engine for gapless auto-advance;
  // drop that tail so the current track is the queue's last entry until the
  // append extends it. (Per-track modes already hold only the current track.)
  if (!shuffleMode.value && repeatMode.value !== "one") void engine.clearUpcoming();
  openActiveQueue({
    kind: "playlist",
    title,
    subtitle: trackCountSubtitle([track]),
    tracks: [track],
  });
}

// Build a queue from `tracks` as the active pool but at rest — no playhead, the
// engine untouched — so "Add to queue" from silence keeps its play-later promise
// instead of startling the user with playback. The queue rests exactly as a
// drained one does (queueEnded set, currentNodePath/queuePlayingIndex null), so
// the play button starts it from the top (see togglePlayPause).
function armQueueAtRest(tracks: SearchTrack[]): void {
  const playable = tracks.filter((t) => !t.missing);
  if (playable.length === 0) return;
  currentParent = syntheticParent(
    `queue:adhoc:${Date.now()}`,
    UNTITLED_PLAYLIST_TITLE,
    playable,
  );
  lastQueue = playable.map((t) => t.path);
  lastIndex = 0;
  queueEnded = true;
  queuePlayingIndex.value = null;
  currentNodePath.value = null;
  shuffleBag = [];
  browsedPlaylist.value = null;
  openActiveQueue({
    kind: "playlist",
    title: UNTITLED_PLAYLIST_TITLE,
    subtitle: trackCountSubtitle(tracks),
    tracks,
  });
  listFaceOpen.value = true;
}

// The single entry point behind "Add to queue". It only ever appends —
// play-later, never interrupting the audible track. With a queue open it appends
// to it. With none, it seeds a queue from the currently playing track first
// (seedQueueFromCurrent) and appends after it; from silence it arms a fresh queue
// at rest (armQueueAtRest) without playing, so the play button — not the add —
// starts it. A live stream is the one exception: nothing can follow it, so the
// add starts the queue now.
//
// Feedback is the queue itself: every add reveals the list face (showSourceList)
// so the appended rows are visible, rather than flashing a toast.
function addToQueue(tracks: SearchTrack[]): void {
  if (tracks.length === 0) return;
  if (!activeQueue.value) {
    if (hasTrack.value && currentNodePath.value && !isStream.value) {
      seedQueueFromCurrent();
    } else if (!hasTrack.value) {
      // True silence: honor "Add to queue" as play-later by arming the queue at
      // rest rather than playing it now. It becomes the active pool with no
      // playhead (like a drained queue); the play button starts it from the top.
      armQueueAtRest(tracks);
      return;
    } else {
      // A live stream (or a lone track with no queueable context) is playing:
      // there's nothing for the queue to follow, so this add starts it now.
      playQueue(
        {
          kind: "playlist",
          title: UNTITLED_PLAYLIST_TITLE,
          subtitle: trackCountSubtitle(tracks),
          tracks,
        },
        `queue:adhoc:${Date.now()}`,
      );
      return;
    }
  }
  // "Add to queue" is a queue verb, never a playlist edit: if the active pool is a
  // playing playlist, adding to the queue detaches the pool from its .m3u8 first —
  // this append and every later curation then stay in memory and the file on disk
  // is left as it was. The queue and a playlist are never the same thing.
  detachActivePoolFromPlaylist();
  appendTracksToActiveQueue(tracks);
  showSourceList();
}

// Sever the active pool from its backing playlist file so queue operations can't
// modify it: it becomes a plain, ephemeral "Queue" (no sourcePath) holding the
// same tracks. isPlaylistSource keys off sourcePath alone, so dropping it turns
// off autosave, drops the tree's playing-playlist highlight, and retitles the
// list/hero to "Queue" — all reactively. The engine, playing index, currentParent,
// and the track objects are untouched (same synthetic pool, same rows), so
// playback continues uninterrupted. A no-op unless the pool is a playlist source.
function detachActivePoolFromPlaylist(): void {
  const q = activeQueue.value;
  if (!isPlaylistSource(q)) return;
  activeQueue.value = {
    kind: q!.kind,
    title: "Queue",
    subtitle: q!.subtitle,
    tracks: q!.tracks,
    // sourcePath deliberately omitted — a queue is never a playlist file.
  };
}

// "Close queue": always dismisses the explicit queue, but is a list action, not a
// transport one. If a folder, stream, or lone track is playing (the queue merely
// stashed), Close drops the stash and leaves that playback untouched. When the
// queue is the audible pool, closing the list does NOT stop the music: the
// current track keeps playing, detached into a lone now-playing track (the tail
// is severed so it doesn't flow into the now-gone rest of the queue). Only a
// queue that has already drained — resting with no playhead — has nothing to keep
// playing, so closing it tears down to the empty hero.
function closeQueue(): void {
  if (!queueIsActivePool()) {
    // A stashed queue that isn't the audible pool: closing just drops the list,
    // leaving whatever's playing untouched.
    clearActiveQueue();
    queuePlayingIndex.value = null;
    listFaceOpen.value = false;
    return;
  }

  const current = currentNodePath.value;
  if (current && !queueEnded) {
    // The queue is gone but its current track keeps playing — hand it back to
    // the file browser as its context. Drop the engine's gapless tail so the
    // vanished queue's rows don't play on; straight-play autoadvance resumes at
    // this track's end via handleEnded. The now-playing card and playback are
    // untouched.
    pendingQueueIndex = null;
    shuffleBag = [];
    if (!shuffleMode.value && repeatMode.value !== "one") void engine.clearUpcoming();
    // If the track's home folder is loaded in the tree, rebind playback to it
    // so Next/Prev walk the album (its siblings) and autoadvance flows on — the
    // "final panel becomes the context" behavior. Otherwise (a search/external
    // track, or an unloaded folder) there's no context to return to, so it
    // detaches as a lone track: the pool is just this track and Next is a no-op.
    // This rebinds currentParent (non-reactive) *before* the reactive list-state
    // writes below, so the transport effect they fire recomputes Next/Prev's
    // enabled state against the rebound folder — poolPaths reads currentParent,
    // which no signal tracks, so the effect only sees it if it runs afterward.
    const home = rootNode ? findNode(rootNode, current) : null;
    if (home) {
      currentParent = home.parent;
      const pool = poolPaths();
      lastQueue = pool;
      lastIndex = Math.max(0, pool.indexOf(current));
    } else {
      currentParent = null;
      lastQueue = [current];
      lastIndex = 0;
    }
    clearActiveQueue();
    queuePlayingIndex.value = null;
    listFaceOpen.value = false;
    return;
  }

  // The queue already drained (rests with no playhead): nothing to keep playing,
  // so tear playback fully down (native Stop) and return to a clean empty hero.
  teardownPlaybackToEmpty();
}

// Full playback teardown (native Stop): silence the engine, drop the queue, and
// return to a clean empty hero with no playhead. Non-reactive playback vars go
// first so the reactive writes below fire their effects against a fully cleared
// context. Used by Close on a drained queue and by deleting the playing playlist.
function teardownPlaybackToEmpty(): void {
  currentParent = null;
  queueEnded = false;
  lastQueue = [];
  lastIndex = 0;
  pendingQueueIndex = null;
  shuffleBag = [];
  clearActiveQueue();
  queuePlayingIndex.value = null;
  listFaceOpen.value = false;
  currentNodePath.value = null;
  currentStreamUrl.value = null;
  isStream.value = false;
  currentTime.value = 0;
  duration.value = 0;
  hasTrack.value = false;
  npTitle.value = "";
  npArtist.value = null;
  npAlbum.value = null;
  clearArt();
  void engine.stop();
}

async function addFolderToQueue(folder: SearchFolder): Promise<void> {
  // Snapshot before the await; if queue or current track changes during the
  // scan the user navigated away — append to the wrong destination instead of
  // silently merging into whatever opened in the meantime.
  const queueBefore = activeQueue.value;
  const pathBefore = currentNodePath.value;
  try {
    const tracks = await invoke<SearchTrack[]>("folder_tracks", { path: folder.path });
    if (activeQueue.value !== queueBefore) return;
    if (!queueBefore && currentNodePath.value !== pathBefore) return;
    addToQueue(tracks);
  } catch (e) {
    console.error("folder_tracks failed", folder.path, e);
  }
}

// A brief, self-dismissing confirmation (e.g. "Added 12 tracks"). Add-to-queue
// often lands on the list where the growth is visible anyway, but the toast
// confirms the append even when the tracks scroll in below the fold.
let toastTimer: number | undefined;
function toast(message: string): void {
  if (!toastEl) return;
  toastEl.textContent = message;
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl.classList.remove("show"), 1600);
}

// "Go to artist" / "Go to album" rows for a track's context menu, each present
// only when its tag exists. The album's grouping key is albumArtist ?? artist,
// matching the backend's album_tracks — so a compilation track (album artist
// "Various Artists", track artist something else) resolves the whole album.
// --- Add to playlist ▸ (phase 4) ---
//
// A universal submenu on any track-bearing node (tree tracks/folders/playlists,
// queue rows, search hits): a leading New Playlist… plus every indexed library
// playlist. New Playlist… seeds a fresh file with the clicked tracks; an
// existing target appends. When the target is the open list (browsed or
// playing), the append goes through the in-memory list + autosave (applyCuration
// reconciles playback and writes the file) so we never double-write; otherwise
// it's written straight to the file. Track resolution is lazy — a folder / album
// / artist only queries when its entry is chosen, not when the menu is built.

type TrackProvider = () => SearchTrack[] | Promise<SearchTrack[]>;

// The "Add to playlist ▸" menu item, built from the current index (the menu is
// rebuilt per right-click, so it always reflects the freshest index). Every
// playlist is offered, including the one a row already belongs to — matching
// how mainstream players handle it (a self-add just duplicates the row, which
// this app's positional model allows).
// "Show in Finder" verb, shared by the track / folder / playlist menus. Opens
// the OS file explorer with the item selected (a file is highlighted in its
// containing folder; a folder reveals itself). One path per invocation, so a
// multi-selection reveals its first item.
function showInFinderItem(path: string): ContextMenuItem {
  return {
    label: "Show in Finder",
    action: () => {
      revealItemInDir(path).catch((e) => {
        console.error("revealItemInDir failed", path, e);
        toast("Couldn't show in Finder");
      });
    },
  };
}

function addToPlaylistItem(getTracks: TrackProvider): ContextMenuItem {
  const submenu: ContextMenuItem[] = [
    { label: "New Playlist…", action: () => void newPlaylistWithTracks(getTracks) },
  ];
  // Duplicate #PLAYLIST: names may yield two identically-labelled entries
  // (accepted limitation); they still target distinct files by path.
  for (const pl of playlistIndex) {
    submenu.push({
      label: pl.name,
      action: () => void addTracksToPlaylist(pl.path, getTracks),
    });
  }
  return { label: "Add to playlist", submenu };
}

// New Playlist… from a menu: save dialog → write an .m3u8 seeded with the
// clicked tracks → browse it (playback untouched) as confirmation.
async function newPlaylistWithTracks(getTracks: TrackProvider): Promise<void> {
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
async function addTracksToPlaylist(path: string, getTracks: TrackProvider): Promise<void> {
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

// Tracks behind a search hit, for its Add-to-playlist submenu. Resolves lazily
// (artist/album/folder query only when chosen). Null for kinds with no tracks to
// add (streams, and playlist hits themselves).
function searchItemTrackProvider(item: SearchItem): TrackProvider | null {
  switch (item.kind) {
    case "file":
      return () => [item.track];
    case "folder":
      return () => invoke<SearchTrack[]>("folder_tracks", { path: item.folder.path });
    case "artist":
      return () => invoke<SearchTrack[]>("artist_tracks", { artist: item.artist.name });
    case "album":
      return () =>
        invoke<SearchTrack[]>("album_tracks", {
          album: item.album.album,
          albumArtist: item.album.artist,
        });
    default:
      return null;
  }
}

function trackContextItems(track: {
  artist: string | null;
  album: string | null;
  albumArtist: string | null;
}): ContextMenuItem[] {
  const items: ContextMenuItem[] = [];
  if (track.artist) {
    const artist = track.artist;
    items.push({ label: "Play artist", action: () => void openArtistQueue(artist) });
  }
  if (track.album) {
    const album = track.album;
    const albumArtist = track.albumArtist ?? track.artist ?? "";
    items.push({
      label: "Play album",
      action: () => void openAlbumQueue(album, albumArtist),
    });
  }
  return items;
}

// Add a lazily-resolved set of tracks (artist/album query) to the queue, using
// the same snapshot guard as addFolderToQueue so a scan that resolves after the
// user has navigated away appends to the right destination or not at all.
async function addProviderToQueue(getTracks: TrackProvider): Promise<void> {
  const queueBefore = activeQueue.value;
  const pathBefore = currentNodePath.value;
  try {
    const tracks = await getTracks();
    if (activeQueue.value !== queueBefore) return;
    if (!queueBefore && currentNodePath.value !== pathBefore) return;
    addToQueue(tracks);
  } catch (e) {
    console.error("addProviderToQueue failed", e);
  }
}

// Right-click menus for the Artists / Albums browse rows in the library
// navigator. Built here (and injected into the navigator, which owns the rows) so
// all menu construction — and the artist/album track providers behind Add to
// queue / Add to playlist — reuses openArtistQueue / openAlbumQueue, addToQueue,
// and addToPlaylistItem instead of a second implementation in the nav module.
function showArtistContextMenu(x: number, y: number, name: string): void {
  const getTracks: TrackProvider = () =>
    invoke<SearchTrack[]>("artist_tracks", { artist: name });
  showContextMenu(x, y, [
    { label: "Play", action: () => void openArtistQueue(name) },
    { label: "Add to queue", action: () => void addProviderToQueue(getTracks) },
    addToPlaylistItem(getTracks),
  ]);
}

function showAlbumContextMenu(
  x: number,
  y: number,
  album: string,
  albumArtist: string,
): void {
  const getTracks: TrackProvider = () =>
    invoke<SearchTrack[]>("album_tracks", { album, albumArtist });
  showContextMenu(x, y, [
    { label: "Play", action: () => void openAlbumQueue(album, albumArtist) },
    { label: "Add to queue", action: () => void addProviderToQueue(getTracks) },
    addToPlaylistItem(getTracks),
  ]);
}

// Right-click menu for the Playlists browse rows (Phase 5). Mirrors the artist /
// album menus but reuses the existing playlist paths: Play plays the file through
// playPlaylistPath (so it becomes the playing source, same as a tree double-click),
// and Add to queue / Add to playlist run off the playlist's playable tracks. Missing
// rows are already dropped by playlistPlayableTracks, so the queue pool never carries
// danglers.
function showPlaylistContextMenu(x: number, y: number, path: string): void {
  const getTracks: TrackProvider = async () =>
    playlistPlayableTracks(await invoke<PlaylistData>("read_playlist", { path }));
  showContextMenu(x, y, [
    { label: "Play", action: () => void playPlaylistPath(path) },
    { label: "Add to queue", action: () => void addProviderToQueue(getTracks) },
    addToPlaylistItem(getTracks),
  ]);
}

// Loads the root menu's playlist section. list_all_playlists is keyed to one
// library folder (it walks that tree), so scan each and merge; yields nothing
// until a library folder is set.
async function loadAllPlaylists(): Promise<PlaylistRef[]> {
  const roots = libraryRootPaths();
  if (roots.length === 0) return [];
  const perRoot = await Promise.all(
    roots.map((root) => invoke<PlaylistRef[]>("list_all_playlists", { root })),
  );
  return perRoot.flat();
}

// --- Shared leaf-row list (library navigator) ---------------------------------
//
// One builder for every track list under the Files-tab navigator (Songs, and —
// later — album / artist / playlist detail). It encodes the leaf-row behavior
// once: single-click select (cmd/shift extend), double-click / hover-play, the
// row context menu, and drag-to-playlist — reusing the very primitives the queue
// and tree rows use, so nothing here is a third implementation.
//
// Selection uses navSel — the navigator's own TrackSelection instance, separate
// from the queue's (queueSel). The two panes share row *objects* (a track added to
// the queue from this list is the very same SearchTrack), so a single shared Set
// would highlight a selection in both panes at once; separate instances keep each
// pane's selection its own (see makeTrackSelection and the nav-selection painter in
// setupEffects).
//
// Play semantics: like a browse-tree track, double-click / hover-play lands on the
// now-playing hero and plays *in context*, the whole list becoming the implicit
// pool so auto-advance, shuffle, and repeat carry on through it. It is deliberately
// NOT an explicit queue: play just plays (no right-pane queue chrome); "Add to
// queue" stays the only verb that builds one. It differs from playTreeTrack in one
// way: the pool is a synthetic `queue:` parent (not a real folder), so
// queueIsActivePool() is true and play-after-the-list-ends restarts from the top —
// the same start-of-pool restart the browse tree now uses (see togglePlayPause).

export interface LeafListContext {
  // Now-playing pool title (the synthetic parent's name) when a row is played.
  title: string;
  // Synthetic pool path; its `queue:` prefix marks the pool as a queue
  // (queueIsActivePool) so play-after-end restarts from the top and a rescan won't
  // re-bind it to a folder. Autoadvance is global now, so the prefix no longer
  // picks a context.
  syntheticPath: string;
}

// The leaf list currently shown in the navigator, so the reactive nav-selection
// painter can map its object-keyed Set back to rows by view index (mirrors how
// the queue painter reads openListTracks()).
let navLeafTracks: SearchTrack[] = [];

export function renderLeafTrackList(
  tracks: SearchTrack[],
  ctx: LeafListContext,
): HTMLElement {
  navLeafTracks = tracks;
  const ul = h("div", { class: "nav-list" });

  // Play from `index` in context (cf. playTreeTrack): select the row so it stays
  // highlighted, drop the queue-row highlight, dismiss any queue/playlist chrome
  // (hero only), then play with the whole list as the pool (a synthetic `queue:`
  // parent). These leaf lists carry no missing rows, so the view index is the
  // playable index.
  const playAt = (t: SearchTrack, index: number): void => {
    navSel.single(t);
    const parent = syntheticParent(ctx.syntheticPath, ctx.title, tracks);
    queuePlayingIndex.value = null;
    resetToLonePlayback();
    playFile(parent.children[index], parent, index);
  };

  tracks.forEach((t, i) => {
    // Album track lists carry the file's metadata track number (matching the
    // browse tree), so show it; flat lists (Songs) leave it null and fall back to
    // the positional row index. A metadata number of 0 is treated as absent.
    const label = String(t.track ? t.track : i + 1);
    const numText = h("span", {
      class: "nav-num-text",
      text: label,
      // Numbers up to 3 digits sit centered in the gutter at full size (see .nav-num
      // CSS). 4+ digit numbers — 1000th track and beyond — would overflow that
      // footprint, so shrink them to the 3-digit width (tabular digits are equal
      // width, so N digits fit 3 digits' width at scale 3/N). Self-limiting: the
      // number never grows past the 3-digit footprint, it just gets smaller, and
      // that only bites at track counts (10k+, 100k+) real libraries never reach.
      style: label.length > 3 ? { "font-size": `${3 / label.length}em` } : {},
    });
    // Number gutter that gives way to a hover play button, matching the queue and
    // tree track rows (see .nav-num CSS).
    const num = h(
      "span",
      { class: "nav-num" },
      numText,
      h("button", {
        class: "row-play",
        attrs: { type: "button", "aria-label": "Play" },
        on: {
          click: (e) => {
            e.stopPropagation();
            playAt(t, i);
          },
        },
      }),
    );

    const secondaryText = [t.artist, t.album].filter(Boolean).join(" · ");
    const cell = h(
      "span",
      { class: "nav-cell" },
      h("span", {
        class: "nav-primary",
        text: t.title ?? (t.path.split(/[\\/]/).pop() ?? t.path),
      }),
      secondaryText && h("span", { class: "nav-secondary", text: secondaryText }),
    );

    const row = h(
      "div",
      {
        class: "nav-track-row",
        // View index, so the reactive painter maps the object-keyed selection back
        // to rows without relying on unique paths.
        data: { rowIndex: i },
        on: {
          click: (e) => {
            // Note: lastSelectionPane is left untouched — the navigator is a distinct
            // surface from the right-pane list, and keyboard Enter-to-play for it is
            // deferred (see plan.md Phase 1's "keyboard back shortcut is still TBD").
            if (e.metaKey || e.ctrlKey) {
              navSel.toggle(t);
              return;
            }
            if (e.shiftKey) {
              navSel.rangeTo(t, tracks);
              return;
            }
            navSel.single(t);
          },
          dblclick: () => playAt(t, i),
          contextmenu: (e) => {
            e.preventDefault();
            // Finder-style: right-clicking outside the selection makes this the
            // selection; inside a multi-selection it's kept.
            if (!navSel.signal.peek().has(t)) navSel.single(t);
            const sel = navSel.resolveIn(tracks);
            if (sel.length > 1) {
              showContextMenu(e.clientX, e.clientY, [
                { label: `Add ${sel.length} to queue`, action: () => addToQueue(sel) },
                addToPlaylistItem(() => sel),
                showInFinderItem(sel[0].path),
              ]);
            } else {
              // A plain click only selects here (unlike the tree), so the menu leads
              // with an explicit Play; then the list-building verbs and the per-track
              // navigation (Play artist / album when tagged), matching the tree order.
              showContextMenu(e.clientX, e.clientY, [
                { label: "Play", action: () => playAt(t, i) },
                { label: "Add to queue", action: () => addToQueue([t]) },
                addToPlaylistItem(() => [t]),
                ...trackContextItems({ artist: t.artist, album: t.album, albumArtist: null }),
                editMetadataItem(t.path),
                showInFinderItem(t.path),
              ]);
            }
          },
          // Drag a row (or the whole selection) into an open playlist/queue list,
          // like a tree track. Pointer-based so it coexists with the native OS
          // file-drop; the 5px threshold keeps a plain click a select/play.
          pointerdown: (e) => {
            const selSet = navSel.signal.peek();
            const dragTracks =
              selSet.has(t) && selSet.size > 1 ? navSel.resolveIn(tracks) : [t];
            startTrackDrag(e, dragTracks);
          },
        },
      },
      num,
      cell,
    );
    if (navSel.signal.peek().has(t)) row.classList.add("selected");

    ul.appendChild(row);
  });
  return ul;
}

// Plays a queue row by its index (not path, so a duplicated track resolves to
// the clicked instance). This is the sole way to (re)enter the queue: it makes
// the queue the engine's active pool. If the queue is already the pool, reuse
// its synthetic parent; if it was merely stashed while a folder/stream/lone
// track played, rebuild the parent from the queue tracks so playback moves into
// it. activeQueue (the queue data) is untouched.
// `poolIndex` addresses the *playable* pool (renderQueue skips missing rows when
// it computes the index), never the view. A browsed playlist keeps its missing
// rows on screen; the pool is built from just the playable ones, so playing from
// it doesn't collapse the view. When the queue is already the active pool,
// currentParent.children *is* that playable pool.
function playQueueTrack(poolIndex: number): void {
  const q = activeQueue.value;
  if (!q) return;
  const parent = queueIsActivePool() && currentParent
    ? currentParent
    : syntheticParent(
        `queue:active:${Date.now()}`,
        q.title,
        q.tracks.filter((t) => !t.missing),
      );
  const node = parent.children[poolIndex];
  if (!node) return;
  playFile(node, parent, poolIndex);
}

// Plays a file from outside the library (passed in via OS file association).
// Intentionally leaves currentNode/currentParent null so the tree is not
// touched, no row is highlighted, and album-advance on end is a no-op. The
// next library or stream selection replaces this state entirely.
// Routes a file delivered by an OS file association (Finder double-click, "open
// with", cold-start arg). A playlist opens for browsing (view + curate) like a
// tree single-click; any other file is an audio track and plays.
function openAssociatedFile(path: string): void {
  if (/\.m3u8?$/i.test(path)) {
    void browsePlaylistPath(path);
  } else {
    void openExternalFile(path);
  }
}

async function openExternalFile(path: string): Promise<void> {
  let meta: TrackMeta;
  try {
    meta = await invoke<TrackMeta>("prepare_external_file", { path });
  } catch (e) {
    console.error("prepare_external_file failed", path, e);
    return;
  }
  // Leaves currentParent null so the tree is untouched, no row is highlighted,
  // and album-advance is a no-op (single-track queue). Lone playback: dismiss
  // any open queue/playlist; null the highlight since this plays outside it.
  resetToLonePlayback();
  queuePlayingIndex.value = null;
  currentParent = null;
  currentNodePath.value = null;
  currentStreamUrl.value = null;
  isStream.value = false;
  currentTime.value = 0;
  duration.value = 0;
  queueEnded = false;
  lastQueue = [path];
  lastIndex = 0;
  shuffleBag = [];
  const fallback = path.split(/[\\/]/).pop() ?? path;
  setNowPlaying(meta.title ?? fallback, meta.artist, meta.album);
  void loadArt(path);
  void engine.play([path], 0);
}

function clearArt(): void {
  artRequestId++;
  npArt.value = null;
}

async function loadArt(path: string): Promise<void> {
  await applyArt(() => invoke<string | null>("get_art", { path }), path);
}

// Station art declared in the stream stream list, fetched by the backend (the
// CSP forbids remote/file <img> sources, so it arrives as a data URL just
// like embedded track art).
async function loadStreamArt(image: string): Promise<void> {
  await applyArt(() => invoke<string | null>("get_stream_image", { image }), image);
}

async function applyArt(
  fetchArt: () => Promise<string | null>,
  source: string,
): Promise<void> {
  const id = ++artRequestId;
  // Note: we intentionally do NOT clear npArt here. Keeping the previous
  // track's art on screen until the new one is fetched and decoded avoids a
  // black flash on track change — most noticeably between tracks of the same
  // album, where the art is identical and shouldn't visibly change at all.
  let dataUrl: string | null;
  try {
    dataUrl = await fetchArt();
  } catch (e) {
    console.error("art load failed for", source, e);
    return;
  }
  if (id !== artRequestId) return;
  if (dataUrl) {
    // Decode off-screen so the on-screen swap is instantaneous rather than
    // showing a half-painted image.
    const img = new Image();
    img.src = dataUrl;
    try {
      await img.decode();
    } catch {
      /* decode can reject on detached images; assign anyway */
    }
    if (id !== artRequestId) return;
  }
  npArt.value = dataUrl;
}

// --- Library / streams loading ---

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
async function refreshTree(roots: string[]): Promise<void> {
  rootNode = null;
  libraryHasContent.value = false;
  libraryRootSet.value = roots.length > 0;
  invalidLibraryRoots = new Set();
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
        invalidLibraryRoots.add(root);
        const name = roots.length === 1 ? root : basename(root);
        return makeRootFolderNode(root, name, { folders: [], files: [], playlists: [] });
      }
    }),
  );
  renderLibraryRootRows();
  if (roots.length === 1) {
    rootNode = nodes[0];
  } else {
    // Virtual root: not a real folder on disk (path ""), just a container whose
    // children are the library folders. renderTree renders its children.
    rootNode = {
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
  libraryHasContent.value = rootNode.children.length > 0;
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

function findNode(
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

let libraryRefreshing = false;
let libraryRefreshPending = false;
// True while an inline edit (tree rename) is open. The filesystem watcher fires
// `library-scanned` a beat after any write — including our own rename's — and that
// lands a renderTree() that would tear out the live edit input (and disturb
// scroll). While an edit is open we defer the refresh and flush it on finish.
let inlineEditing = false;
let refreshDeferredWhileEditing = false;
// Set by a tree rename to the renamed playlist's path; the next renderTree scrolls
// that row into view and flashes it, so following it to its new sorted slot reads
// as deliberate. Cleared once consumed.
let pendingRevealPlaylistPath: string | null = null;

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
async function refreshLibrary(): Promise<void> {
  // The playlist index tracks every library change (the watcher and our own
  // writes both land here), so the Add-to-playlist submenu and searchable
  // playlists stay current without a separate refresh at each write site.
  void refreshPlaylistIndex();
  // Hold off rebuilding the tree while an inline edit is open — a renderTree()
  // here would destroy the edit input mid-type. finish() re-runs this once closed.
  if (inlineEditing) {
    refreshDeferredWhileEditing = true;
    return;
  }
  if (libraryRefreshing) {
    libraryRefreshPending = true;
    return;
  }
  libraryRefreshing = true;
  try {
    do {
      libraryRefreshPending = false;
      if (!rootNode) break;
      await reconcileNode(rootNode);
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
        const found = findNode(rootNode, path);
        if (found) {
          currentParent = found.parent;
        }
      }
      // An edit may have opened while we were mid-reconcile (the entry guard only
      // catches edits that predate the refresh). Rendering now would tear out its
      // input and shift scroll — the "scrolls after the 2nd edit" case. Defer the
      // paint; finish() re-runs refreshLibrary once the edit closes.
      if (inlineEditing) {
        refreshDeferredWhileEditing = true;
        break;
      }
      const filesTab = document.getElementById("tab-files");
      const scrollTop = filesTab?.scrollTop ?? 0;
      renderTree();
      if (filesTab) filesTab.scrollTop = scrollTop;
      // Follow a just-renamed playlist to its new alphabetical slot so the re-sort
      // reads as intentional rather than the row vanishing. Consumed once here.
      if (pendingRevealPlaylistPath) {
        revealTreeRow(pendingRevealPlaylistPath);
        pendingRevealPlaylistPath = null;
      }
    } while (libraryRefreshPending);
  } finally {
    libraryRefreshing = false;
  }
}

function isRemoteStreamList(path: string): boolean {
  return path.startsWith("http://") || path.startsWith("https://");
}

async function refreshStreams(streamListPath: string): Promise<void> {
  streamListPathSet.value = !!streamListPath;
  if (!streamListPath) {
    allStreams = [];
    streamListPathValid.value = true;
    streamListWritable.value = false;
    // The panel-wide get-started prompt (streams-empty effect) covers this case.
    setEmpty(streamsContainer, "No stream list path set");
    return;
  }
  setEmpty(streamsContainer, "Loading…", "loading");
  try {
    const streams = await invoke<Stream[]>("read_stream_list", { path: streamListPath });
    allStreams = streams;
    streamListPathValid.value = true;
    // Only a valid local file is appendable; a remote list is read-only.
    streamListWritable.value = !isRemoteStreamList(streamListPath);
    renderStreams(streams);
  } catch (e) {
    console.error("read_stream_list failed for", streamListPath, e);
    allStreams = [];
    streamListPathValid.value = false;
    streamListWritable.value = false;
    setEmpty(streamsContainer, "Invalid stream list path");
  }
}

// Commit a new set of library folders: persist, re-render the settings rows,
// rescan + (re)watch the whole set, and rebuild the tree. Empty paths and
// duplicates are dropped so the array stays clean. Passing [] tears every
// watcher down and returns the Files panel to its get-started prompt.
async function setLibraryRoots(paths: string[]): Promise<void> {
  const seen = new Set<string>();
  libraryRoots = paths.map((p) => p.trim()).filter((p) => p && !seen.has(p) && seen.add(p));
  await store.set(KEY_LIBRARY_ROOTS, libraryRoots);
  await store.save();
  renderLibraryRootRows();
  if (libraryRoots.length) {
    void invoke("rescan_libraries", { paths: libraryRoots });
  }
  // (Re)watch the new set (or, when empty, tear all old watchers down).
  void invoke("watch_libraries", { paths: libraryRoots }).catch((e) =>
    console.error("watch_libraries failed", e),
  );
  await refreshTree(libraryRoots);
  void refreshPlaylistIndex();
}

// Rebuild the Settings library-folder rows from `libraryRoots`. Each row is a
// .path-picker: the folder path (editable), a Choose… button that repoints that
// row, and an × that removes it. All three edit paths funnel through
// setLibraryRoots so persistence, rescan/watch, and the tree stay in step.
function renderLibraryRootRows(): void {
  libraryRootsContainer.innerHTML = "";
  libraryRoots.forEach((path, index) => {
    const input = h("input", {
      class: invalidLibraryRoots.has(path) ? "invalid" : "",
      attrs: { type: "text" },
      on: {
        keydown: (e) => {
          if (e.key === "Enter") input.blur();
        },
        change: () => {
          const next = [...libraryRoots];
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
          const next = [...libraryRoots];
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

async function setStreamListPath(value: string): Promise<void> {
  streamListPathInput.value = value;
  await store.set(KEY_STREAM_LIST_PATH, value);
  await store.save();
  await refreshStreams(value);
}

// Open a folder picker for the library. With an index, it repoints that row;
// without one (the Add button), it appends a new folder.
async function browseLibraryRoot(index?: number): Promise<void> {
  const selected = await open({
    directory: true,
    multiple: false,
    defaultPath: (index != null ? libraryRoots[index] : undefined) || undefined,
  });
  if (typeof selected !== "string") return;
  const next = [...libraryRoots];
  if (index != null) next[index] = selected;
  else next.push(selected);
  await setLibraryRoots(next);
}

async function browseStreamListPath(): Promise<void> {
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

// --- Event wiring ---

function setupTabs(): void {
  const tabs = document.querySelectorAll<HTMLButtonElement>(".tab");
  for (const btn of tabs) {
    btn.addEventListener("click", () => {
      const next = btn.dataset.tab as "files" | "streams";
      if (next === activeTab.value) {
        // Re-clicking the already-active tab. For Files, this is the iOS-style
        // "tap the active tab to pop home" accelerator: collapse any drill-down
        // back to the root menu. (Deciding it here, before activeTab changes,
        // avoids racing the effect that toggles the button's .active class.)
        if (next === "files") popNavToRoot();
        return;
      }
      // Switching tabs drops the sidebar selection — the tree's and the stream's
      // highlight are both per-tab, so leaving one behind the other tab would be a
      // stale, invisible selection (and a stray Enter target).
      clearTreeSelection();
      selectedStreamUrl.value = null;
      if (lastSelectionPane !== "list") lastSelectionPane = null;
      activeTab.value = next;
      void persistActiveTab();
    });
  }
}

// A per-track mode (shuffle on, or repeat-one) needs the frontend to choose the
// next track, but straight play hands the whole album to the engine for gapless
// auto-advance. When such a mode turns on mid-album, drop that queued tail so
// the change takes effect at the current track's end — the engine keeps playing
// the current track untouched, then reports queue-ended and handleEnded picks
// the next track. lastQueue.length <= 1 means the engine already holds only the
// current track (single-track mode, search hit, external file), so there's
// nothing to drop.
function applyModeChange(): void {
  const perTrack = shuffleMode.value || repeatMode.value === "one";
  if (perTrack && !isStream.value && lastQueue.length > 1) {
    void engine.clearUpcoming();
    if (currentNodePath.value) {
      lastQueue = [currentNodePath.value];
      lastIndex = 0;
    }
  }
}

// Reconcile the engine's queued tail with an autoadvance setting that just
// changed for the *currently playing* context. Under a per-track mode (shuffle /
// repeat-one) the engine already holds only the current track, so there's
// nothing to reconcile. Otherwise: turning autoadvance off drops the queued tail
// (clearUpcoming) so the current track finishes and then stops; turning it on
// re-extends the engine with the rest of the pool so gapless auto-advance
// resumes from where playback sits. Callers gate on the changed context matching
// what's playing, so autoadvanceEnabled() here reads the setting that changed.
function applyAutoadvanceChange(): void {
  if (isStream.value) return;
  if (shuffleMode.value || repeatMode.value === "one") return;
  const current = currentNodePath.value;
  if (!current) return; // nothing playing (or a drained queue) — next play uses it
  if (autoadvanceEnabled()) {
    // Re-extend: hand the engine the tail after the current track for gapless.
    const pool = poolPaths();
    // Use the live row index in the queue pool so a duplicate track resolves to
    // the instance actually playing, not the first path match.
    const idx = queueIsActivePool() && queuePlayingIndex.value != null
      ? queuePlayingIndex.value
      : pool.indexOf(current);
    if (idx >= 0 && idx < pool.length - 1) {
      void engine.append(pool.slice(idx + 1));
      lastQueue = pool;
      lastIndex = idx;
    }
  } else if (lastQueue.length > 1) {
    // Drop the tail so the current track is the last thing the engine plays.
    void engine.clearUpcoming();
    lastQueue = [current];
    lastIndex = 0;
  }
}

// Apply the autoadvance toggle from the OS Playback menu: update the signal,
// persist it, and — since it's global — reconcile the engine for whatever is
// playing so the change takes effect at the current track's end (not the queue's).
function setAutoadvance(enabled: boolean): void {
  if (autoadvance.value === enabled) return;
  autoadvance.value = enabled;
  void persistAutoadvance();
  if (hasTrack.value) applyAutoadvanceChange();
}

const persistAutoadvance = async (): Promise<void> => {
  await store.set(KEY_AUTOADVANCE, autoadvance.value);
  await store.save();
};

const persistActiveTab = async (): Promise<void> => {
  await store.set(KEY_ACTIVE_TAB, activeTab.value);
  await store.save();
};

const persistPlaybackModes = async (): Promise<void> => {
  await store.set(KEY_SHUFFLE, shuffleMode.value);
  await store.set(KEY_REPEAT, repeatMode.value);
  await store.save();
};

// Shared by the toolbar button and the Playback menu so both take the same path.
function toggleShuffle(): void {
  shuffleMode.value = !shuffleMode.value;
  // Seed the bag so a shuffle turned on mid-album has a full cycle ready;
  // clear it when turning shuffle off.
  if (shuffleMode.value) refillShuffleBag(currentNodePath.value);
  else shuffleBag = [];
  applyModeChange();
  void persistPlaybackModes();
}

function setRepeatMode(mode: RepeatMode): void {
  if (repeatMode.value === mode) return;
  repeatMode.value = mode;
  applyModeChange();
  void persistPlaybackModes();
}

function setupPlaybackModes(): void {
  modeShuffleBtn.addEventListener("click", toggleShuffle);
  modeRepeatBtn.addEventListener("click", () => {
    // Cycle off → all → one → off.
    setRepeatMode(
      repeatMode.value === "off" ? "all" : repeatMode.value === "all" ? "one" : "off",
    );
  });
}

function setupSplitter(initialWidth: string | null): void {
  if (initialWidth) {
    document.documentElement.style.setProperty("--left-width", initialWidth);
  }

  splitterEl.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const mainEl = document.getElementById("main-view") as HTMLElement;
    const mainLeft = mainEl.getBoundingClientRect().left;
    document.body.classList.add("dragging");
    splitterEl.classList.add("dragging");

    const onMove = (ev: MouseEvent) => {
      const min = 120;
      const max = mainEl.getBoundingClientRect().width - 200;
      const width = Math.max(min, Math.min(max, ev.clientX - mainLeft));
      document.documentElement.style.setProperty("--left-width", `${width}px`);
    };
    const onUp = async () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.classList.remove("dragging");
      splitterEl.classList.remove("dragging");
      const final = getComputedStyle(document.documentElement)
        .getPropertyValue("--left-width")
        .trim();
      if (final) {
        await store.set(KEY_SPLITTER_WIDTH, final);
        await store.save();
      }
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}

// Last size the window had in each layout mode, in logical (CSS) px. Seeded
// from the store on launch and updated on every resize; the double-click toggle
// resizes to whichever of these belongs to the mode it's switching into.
let normalSize = { ...DEFAULT_NORMAL_SIZE };
let miniSize = { ...DEFAULT_MINI_SIZE };

// The layout mode is derived purely from the current viewport height, so a
// manual resize past the breakpoint and the double-click toggle land on the
// exact same CSS state. window.innerHeight is logical px (matches the media
// query and MINI_MAX_HEIGHT) regardless of display scale factor.
function isMiniViewport(): boolean {
  return window.innerHeight <= MINI_MAX_HEIGHT;
}

// Double-click handler for the now-playing area: jump across the breakpoint to
// the other mode, restoring that mode's last-used size. CSS reflows the rest.
async function toggleMiniPlayer(): Promise<void> {
  const target = isMiniViewport() ? normalSize : miniSize;
  await getCurrentWindow().setSize(new LogicalSize(target.width, target.height));
}

// Marquee the title/artist lines when they'd overflow the mini bar (they must
// stay on one line there). Off in normal mode, where the lines wrap freely. The
// distance/duration ride on CSS custom properties so the keyframes are static;
// speed is a fixed px/sec so long titles don't scroll faster than short ones.
function updateMarquee(pEl: HTMLElement): void {
  pEl.classList.remove("marquee");
  pEl.style.removeProperty("--marquee-distance");
  pEl.style.removeProperty("--marquee-duration");
  if (!isMiniViewport()) return;
  const overflow = pEl.scrollWidth - pEl.clientWidth;
  if (overflow <= 1) return;
  pEl.classList.add("marquee");
  pEl.style.setProperty("--marquee-distance", `-${overflow}px`);
  // Duration scales with distance so every line scrolls at the same rate
  // (~25 px/s of overflow, but the keyframes dwell at each end so only ~76% of
  // the duration is spent moving → ~33 px/s of visible motion). The 3s floor
  // keeps short overflows from whipping past.
  pEl.style.setProperty("--marquee-duration", `${Math.max(3, overflow / 25)}s`);
}

function updateMarquees(): void {
  updateMarquee(nowPlayingTitleEl);
  updateMarquee(nowPlayingArtistEl);
  updateMarquee(nowPlayingAlbumEl);
  updateMarquee(streamMetaSongEl);
  updateMarquee(streamMetaArtistEl);
}

async function setupWindowSize(
  appWindow: ReturnType<typeof getCurrentWindow>,
): Promise<void> {
  // A stored size only counts for a mode if it's on that mode's side of the
  // breakpoint. This self-heals if the breakpoint changes: a normal size that's
  // now in the mini range (or vice versa) is discarded in favor of the default,
  // so the toggle can never get stuck resizing to a size that stays in the same
  // mode.
  const storedNormal = await store.get<{ width: number; height: number }>(
    KEY_WINDOW_SIZE_NORMAL,
  );
  if (storedNormal && storedNormal.width > 0 && storedNormal.height > MINI_MAX_HEIGHT) {
    normalSize = storedNormal;
  }
  const storedMini = await store.get<{ width: number; height: number }>(
    KEY_WINDOW_SIZE_MINI,
  );
  if (storedMini && storedMini.width > 0 && storedMini.height > 0 && storedMini.height <= MINI_MAX_HEIGHT) {
    miniSize = storedMini;
  }
  // Always start in normal mode. Mini hides the library/settings, so launching
  // into it would leave the user unable to pick anything to play without first
  // expanding the window.
  await appWindow.setSize(new LogicalSize(normalSize.width, normalSize.height));

  // Persist the current logical size under the active mode's key. Reading
  // window.inner* (rather than the resize event's physical payload) keeps
  // storage in logical px, so restored sizes stay stable across scale factors.
  const persistSize = debounce(async () => {
    // Skip while zoomed (macOS green-button "Zoom"): AppKit owns the un-zoom
    // restore, so recording the transient zoomed size would clobber the mode's
    // real remembered size. Without this, zooming out of mini then expanding
    // lands on the zoomed size instead of the last true normal size.
    if (await appWindow.isMaximized()) return;
    const width = window.innerWidth;
    const height = window.innerHeight;
    if (width <= 0 || height <= 0) return;
    if (isMiniViewport()) {
      miniSize = { width, height };
      await store.set(KEY_WINDOW_SIZE_MINI, miniSize);
    } else {
      normalSize = { width, height };
      await store.set(KEY_WINDOW_SIZE_NORMAL, normalSize);
    }
    await store.save();
  }, 400);

  // Keep the Window menu's "Mini Player" checkmark mirroring the current mode.
  // Mode is derived from viewport height, so sync on every resize (manual drags
  // across the breakpoint included) and once now for the initial normal-mode start.
  const syncMiniplayerChecked = () => {
    void invoke("set_miniplayer_checked", { mini: isMiniViewport() });
  };
  syncMiniplayerChecked();

  window.addEventListener("resize", () => {
    persistSize();
    syncMiniplayerChecked();
  });

  const storedPos = await store.get<{ x: number; y: number }>(
    KEY_WINDOW_POSITION,
  );
  if (storedPos) {
    await appWindow.setPosition(new PhysicalPosition(storedPos.x, storedPos.y));
  }

  const persistPos = debounce(async (x: number, y: number) => {
    await store.set(KEY_WINDOW_POSITION, { x, y });
    await store.save();
  }, 400);

  await appWindow.onMoved(({ payload }) => {
    persistPos(payload.x, payload.y);
  });
}

function setupSettings(): void {
  // Settings opens from the native application menu (Pudding → Settings…, ⌘,),
  // which emits "open-settings"; the topbar's old gear is now the mini-player
  // toggle. The Back button in the panel returns to now-playing.
  void listen("open-settings", () => { settingsOpen.value = true; });
  settingsBackBtn.addEventListener("click", () => { settingsOpen.value = false; });

  // The get-started prompts' inline "settings" links (Files: no library root,
  // Streams: no stream list path) open the settings panel.
  for (const id of ["files-empty-settings", "streams-empty-settings"]) {
    document
      .getElementById(id)
      ?.addEventListener("click", () => { settingsOpen.value = true; });
  }

  // External links must go to the OS browser, not navigate the webview.
  document.addEventListener("click", (e) => {
    const link = (e.target as Element).closest?.("a[href^='http']");
    if (!(link instanceof HTMLAnchorElement)) return;
    e.preventDefault();
    void openUrl(link.href);
  });
}

function searchLabel(t: SearchTrack): { primary: string; secondary: string } {
  const fallbackName = t.path.split(/[\\/]/).pop() ?? t.path;
  return {
    primary: t.title ?? fallbackName,
    secondary: [t.artist, t.album].filter(Boolean).join(" · "),
  };
}

function setupSearch(): void {
  let items: SearchItem[] = [];
  let activeIndex = -1;
  // Bumped per query so a slow search_tracks that resolves after a newer
  // keystroke can't overwrite fresher results.
  let queryToken = 0;
  // Query and caret held while the input is blurred. Blur empties the visible
  // box (the collapsed field just shows clipped stale text otherwise) but the
  // search isn't discarded: refocusing restores the query, its selection, and
  // reopens its results.
  let stash: {
    query: string;
    start: number;
    end: number;
    dir: "forward" | "backward" | "none";
  } | null = null;
  const searchBox = document.getElementById("search") as HTMLElement;

  function close(): void {
    items = [];
    activeIndex = -1;
    searchResultsEl.classList.add("hidden");
    searchResultsEl.innerHTML = "";
  }

  function choose(item: SearchItem): void {
    if (item.kind === "artist") {
      void openArtistQueue(item.artist.name);
    } else if (item.kind === "album") {
      void openAlbumQueue(item.album.album, item.album.artist);
    } else if (item.kind === "folder") {
      // Play into the queue without touching the left panel — no tab switch or
      // scroll, so a search never yanks you away from where you were browsing.
      void playFolder(item.folder);
    } else if (item.kind === "file") {
      playSearchTrack(item.track);
    } else if (item.kind === "playlist") {
      // Choosing a playlist plays it, consistent with every other search hit
      // (there's no single/double-click split in search, so a choice is a play,
      // not the tree's browse). It opens as the playing source and starts from
      // the first track; preview-only browsing lives in the tree.
      void playPlaylistPath(item.playlist.path);
    } else {
      activeTab.value = "streams";
      void persistActiveTab();
      playStream(item.stream);
    }
    searchInput.value = "";
    searchInput.blur();
    close();
  }

  function render(): void {
    searchResultsEl.innerHTML = "";
    if (items.length === 0) {
      searchResultsEl.appendChild(
        h("div", { class: "search-empty", text: "No results" }),
      );
      searchResultsEl.classList.remove("hidden");
      return;
    }
    let activeRow: HTMLElement | null = null;
    items.forEach((item, i) => {
      // Distinct masked-SVG icons (like the folder row's) mark artist, album,
      // folder and playlist rows so the library row types read apart at a glance;
      // file/stream rows carry no icon. The glyph is a masked SVG in .search-icon
      // so it takes the row's color instead of the OS emoji.
      let iconClass: string | null = null;
      let primaryText = "";
      let secondaryText = "";
      if (item.kind === "artist") {
        iconClass = "search-icon icon-artist";
        primaryText = item.artist.name;
        secondaryText = "Artist";
      } else if (item.kind === "album") {
        iconClass = "search-icon icon-album";
        primaryText = item.album.album;
        secondaryText = item.album.artist ? `Album · ${item.album.artist}` : "Album";
      } else if (item.kind === "folder") {
        iconClass = "search-icon";
        primaryText = item.folder.name;
        // The containing folder's path (relative to its library folder) gives
        // context — which artist an album sits under. Skipped for top-level
        // folders, where the parent is a library folder itself and adds only
        // noise. With several library folders, strip whichever one contains it.
        const parentPath = item.folder.path.split("/").slice(0, -1).join("/");
        const root = libraryRootPaths().find(
          (r) => parentPath === r || parentPath.startsWith(r + "/"),
        );
        if (root && parentPath !== root) {
          secondaryText = parentPath.slice(root.length + 1);
        } else if (!root) {
          secondaryText = parentPath;
        }
      } else if (item.kind === "file") {
        const l = searchLabel(item.track);
        primaryText = l.primary;
        secondaryText = l.secondary;
      } else if (item.kind === "playlist") {
        iconClass = "search-icon icon-playlist";
        primaryText = item.playlist.name;
        secondaryText = "Playlist";
      } else {
        primaryText = item.stream.name;
      }
      const text = h(
        "span",
        { class: "text" },
        h("div", { class: "primary", text: primaryText }),
        secondaryText && h("div", { class: "secondary", text: secondaryText }),
      );
      const row = h(
        "div",
        {
          class: i === activeIndex ? "search-result active" : "search-result",
          attrs: { role: "option" },
          // mousedown, not click: clicking a row blurs the input first, and a blur
          // handler that closed the dropdown would remove the row before click.
          // preventDefault keeps the input focused (so the dropdown survives a
          // right-click); only a left-click chooses the row.
          on: {
            mousedown: (e) => {
              e.preventDefault();
              if (e.button === 0) choose(item);
            },
          },
        },
        iconClass && h("span", { class: iconClass }),
        text,
      );
      if (i === activeIndex) activeRow = row;
      // Right-click a track-bearing hit to add it to a playlist.
      const provider = searchItemTrackProvider(item);
      if (provider) {
        row.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          showContextMenu(e.clientX, e.clientY, [addToPlaylistItem(provider)]);
        });
      }
      searchResultsEl.appendChild(row);
    });
    searchResultsEl.classList.remove("hidden");
    if (activeRow) (activeRow as HTMLElement).scrollIntoView({ block: "nearest" });
  }

  const runSearch = debounce(async (raw: string) => {
    const token = ++queryToken;
    const query = raw.trim();
    if (!query) {
      close();
      return;
    }
    const needle = query.toLowerCase();
    const streamItems: SearchItem[] = allStreams
      .filter((s) => s.name.toLowerCase().includes(needle))
      .map((s) => ({ kind: "stream", stream: s }));
    // Playlists are indexed client-side (kept fresh by the watcher), so they
    // filter here alongside streams rather than through a backend query.
    const playlistItems: SearchItem[] = playlistIndex
      .filter((p) => p.name.toLowerCase().includes(needle))
      .map((p) => ({ kind: "playlist", playlist: p }));
    let artistItems: SearchItem[] = [];
    let albumItems: SearchItem[] = [];
    let folderItems: SearchItem[] = [];
    let fileItems: SearchItem[] = [];
    try {
      const [artists, albums, folders, tracks] = await Promise.all([
        invoke<SearchArtist[]>("search_artists", { query }),
        invoke<SearchAlbum[]>("search_albums", { query }),
        invoke<SearchFolder[]>("search_folders", { query }),
        invoke<SearchTrack[]>("search_tracks", { query }),
      ]);
      artistItems = artists.map((a) => ({ kind: "artist", artist: a }));
      albumItems = albums.map((a) => ({ kind: "album", album: a }));
      folderItems = folders.map((f) => ({ kind: "folder", folder: f }));
      fileItems = tracks.map((t) => ({ kind: "file", track: t }));
    } catch (e) {
      console.error("search failed", e);
    }
    if (token !== queryToken) return;
    // Artists and albums first (a metadata-name match usually means "open that
    // page"), then folders and playlists (both "open this collection" hits),
    // streams, and finally individual tracks.
    items = [
      ...artistItems,
      ...albumItems,
      ...folderItems,
      ...playlistItems,
      ...streamItems,
      ...fileItems,
    ];
    activeIndex = items.length > 0 ? 0 : -1;
    render();
  }, 150);

  searchInput.addEventListener("input", () => runSearch(searchInput.value));
  searchInput.addEventListener("focus", () => {
    if (stash && !searchInput.value) {
      searchInput.value = stash.query;
      // Restores the caret for keyboard-driven focus (tab, window
      // reactivation). On mouse focus the browser places the caret from the
      // click position afterward, which is the better behavior there anyway.
      searchInput.setSelectionRange(stash.start, stash.end, stash.dir);
    }
    if (searchInput.value.trim()) runSearch(searchInput.value);
  });

  // Escape and choose() clear the value before blurring, so only abandoned
  // queries survive the round trip. The runSearch("") call supersedes any
  // pending debounced keystroke that would otherwise reopen the dropdown
  // after the box has visually emptied.
  searchInput.addEventListener("blur", () => {
    stash = searchInput.value
      ? {
          query: searchInput.value,
          start: searchInput.selectionStart ?? searchInput.value.length,
          end: searchInput.selectionEnd ?? searchInput.value.length,
          dir: searchInput.selectionDirection ?? "none",
        }
      : null;
    searchInput.value = "";
    close();
    runSearch("");
  });

  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      searchInput.value = "";
      close();
      searchInput.blur();
      return;
    }
    if (searchResultsEl.classList.contains("hidden") || items.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      activeIndex = (activeIndex + 1) % items.length;
      render();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      activeIndex = (activeIndex - 1 + items.length) % items.length;
      render();
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(items[activeIndex >= 0 ? activeIndex : 0]);
    }
  });

  // Cmd/Ctrl+F focuses the search field (matches Apple Music / iTunes).
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.key === "f" || e.key === "F")) {
      e.preventDefault();
      searchInput.focus();
      searchInput.select();
    }
  });

  // Swallow mousedown inside the widget so it never reaches the document-level
  // drag-region handler (which would otherwise start a window drag) or the
  // outside-click closer below.
  searchBox.addEventListener("mousedown", (e) => e.stopPropagation());

  // Any mousedown that escapes the widget closes the dropdown.
  document.addEventListener("mousedown", () => close());
}

function setupPlayerControls(): void {
  playPauseBtn.addEventListener("click", togglePlayPause);
  prevBtn.addEventListener("click", skipPrev);
  nextBtn.addEventListener("click", skipNext);

  document.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (isTextInputTarget(e.target)) return;

    if (e.key === "Delete" || e.key === "Backspace") {
      const list = openListTracks();
      const sel = queueSel.resolveIn(list);
      if (sel.length === 0) return;
      e.preventDefault();
      // Keep the keyboard selection on the row that fills the first deleted slot
      // so repeated Delete keeps clearing rows without re-reaching for the mouse.
      const fill = fillRowAfterRemoval(list, sel);
      removeCuratedTracks(sel);
      if (fill) {
        queueSel.single(fill);
        lastSelectionPane = "list";
      }
      return;
    }

    if (e.key === "Enter") {
      // Enter commits the selected row (the play a plain click no longer does),
      // in whichever pane the user last selected in.
      if (playSelectedRow()) e.preventDefault();
      return;
    }

    if (e.key === " " || e.code === "Space") {
      if (e.repeat) return;
      e.preventDefault();
      togglePlayPause();
      return;
    }

    if (e.key === "ArrowUp") {
      e.preventDefault();
      setVolume(volume.value + 0.1);
      return;
    }

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setVolume(volume.value - 0.1);
      return;
    }

    if (e.key === "ArrowLeft") {
      if (isStream.value) return;
      e.preventDefault();
      seekBy(-10);
      return;
    }

    if (e.key === "ArrowRight") {
      if (isStream.value) return;
      e.preventDefault();
      seekBy(10);
      return;
    }
  });

  seekBar.addEventListener("input", () => {
    seekTo(Number(seekBar.value));
  });
}

// Shared by the volume button and the Playback menu's Mute item.
function toggleMute(): void {
  setVolume(volume.value > 0 ? 0 : lastNonZeroVolume);
}

function setupVolumeControl(): void {
  volumeBtn.addEventListener("click", toggleMute);

  volumeControlEl.addEventListener("mouseenter", () => {
    volumePopoverOpen.value = true;
  });

  volumeControlEl.addEventListener("mouseleave", () => {
    volumePopoverOpen.value = false;
  });

  volumeBar.addEventListener("input", () => {
    setVolume(Number(volumeBar.value));
  });
}

// --- Effects: declarative DOM sync ---

// What the stream-meta block currently shows, tracked outside the signal so
// title changes can cross-fade: fade the old text out, swap, fade the new one
// in. Re-emits of the identical title (the engine re-announces on every
// stream reconnect, e.g. pause/resume) are no-ops.
let renderedStreamMeta: { song: string; artist: string | null } | null = null;
let streamMetaFadeTimer: ReturnType<typeof setTimeout> | undefined;

function applyStreamMeta(
  meta: { song: string; artist: string | null } | null,
): void {
  renderedStreamMeta = meta;
  streamMetaSongInner.textContent = meta?.song ?? "";
  streamMetaArtistInner.textContent = meta?.artist ?? "";
  streamMetaArtistEl.classList.toggle("hidden", !meta?.artist);
  updateMarquee(streamMetaSongEl);
  updateMarquee(streamMetaArtistEl);
}

// The live-pulse keyframes start and end on the paused gray, so stopping
// doesn't cut the pulse off mid-cycle: clamp the infinite animation to the
// end of its current iteration, then pin the .paused color once it lands
// there. Resuming mid-wind-down just lifts the clamp.
function setLiveIndicatorPaused(paused: boolean): void {
  const pulse = liveIndicatorEl
    .getAnimations()
    .find(
      (a): a is CSSAnimation =>
        a instanceof CSSAnimation && a.animationName === "live-pulse",
    );
  if (!paused) {
    liveIndicatorEl.classList.remove("paused");
    if (pulse) {
      pulse.onfinish = null;
      pulse.effect?.updateTiming({ iterations: Infinity });
    }
    return;
  }
  if (!pulse || pulse.playState !== "running") {
    liveIndicatorEl.classList.add("paused");
    return;
  }
  const time = typeof pulse.currentTime === "number" ? pulse.currentTime : 0;
  const timing = pulse.effect?.getComputedTiming();
  const duration = typeof timing?.duration === "number" ? timing.duration : 0;
  if (duration <= 0) {
    liveIndicatorEl.classList.add("paused");
    return;
  }
  pulse.effect?.updateTiming({
    iterations: Math.max(1, Math.ceil(time / duration)),
    fill: "forwards",
  });
  pulse.onfinish = () => liveIndicatorEl.classList.add("paused");
}

function setupEffects(): void {
  effect(() => {
    nowPlayingEmptyEl.classList.toggle("hidden", hasTrack.value);
  });
  effect(() => {
    nowPlayingTitleInner.textContent = npTitle.value;
    updateMarquee(nowPlayingTitleEl);
  });
  effect(() => {
    nowPlayingArtistInner.textContent = npArtist.value ?? "";
    nowPlayingArtistEl.classList.toggle("hidden", !npArtist.value);
    updateMarquee(nowPlayingArtistEl);
  });
  effect(() => {
    nowPlayingAlbumInner.textContent = npAlbum.value ?? "";
    nowPlayingAlbumEl.classList.toggle("hidden", !npAlbum.value);
    updateMarquee(nowPlayingAlbumEl);
  });
  // The nav bar: the single line above the transport that carries the source
  // context and the button swapping between the two faces (hero / list). See
  // renderNavBar for the state table.
  effect(renderNavBar);
  effect(() => {
    liveIndicatorEl.classList.toggle("hidden", !isStream.value);
    setLiveIndicatorPaused(!isPlaying.value);
  });
  effect(() => {
    // In the layout (invisibly) for the whole stream; .visible fades the text
    // in once metadata exists. Layout-inert either way — see the CSS.
    const meta = npStreamMeta.value;
    const streaming = isStream.value;
    clearTimeout(streamMetaFadeTimer);
    nowPlayingStreamMetaEl.classList.toggle("hidden", !streaming);
    if (!streaming || !meta) {
      // Leaving streams, or a new stream starting (playStream nulls the
      // meta): reset instantly so the previous track can't linger over the
      // fresh station name.
      applyStreamMeta(null);
      nowPlayingStreamMetaEl.classList.remove("visible");
      return;
    }
    if (
      renderedStreamMeta?.song === meta.song &&
      renderedStreamMeta?.artist === meta.artist
    ) {
      return;
    }
    if (!renderedStreamMeta) {
      // First title of this stream: fade in over the reserved spot.
      applyStreamMeta(meta);
      nowPlayingStreamMetaEl.classList.add("visible");
    } else {
      // Song changed mid-stream: fade out, swap once invisible, fade in.
      // The delay matches the fade-out duration in the CSS.
      nowPlayingStreamMetaEl.classList.remove("visible");
      streamMetaFadeTimer = setTimeout(() => {
        applyStreamMeta(meta);
        nowPlayingStreamMetaEl.classList.add("visible");
      }, 250);
    }
  });
  effect(() => {
    const url = npArt.value;
    if (url) {
      // Avoid reassigning an identical src (same-album tracks): a no-op set
      // would still trigger a reload/repaint and flicker.
      if (nowPlayingArtEl.getAttribute("src") !== url) {
        nowPlayingArtEl.src = url;
      }
      nowPlayingArtEl.classList.remove("hidden");
    } else {
      nowPlayingArtEl.removeAttribute("src");
      nowPlayingArtEl.classList.add("hidden");
    }
    // Art presence changes the width left for the text, so the lines may start
    // or stop overflowing.
    updateMarquees();
  });

  effect(() => {
    playPauseBtn.textContent = isPlaying.value ? "⏸" : "▶";
    playPauseBtn.setAttribute("aria-label", isPlaying.value ? "Pause" : "Play");
  });
  effect(() => {
    // Idle, the play button doesn't go dead — it "starts the library" by playing
    // the first Files entry (see togglePlayPause/startLibrary), preserving the
    // ready-to-go energy. It's only truly disabled when there's nothing to start:
    // no track loaded and an empty/absent library.
    playPauseBtn.disabled = !hasTrack.value && !libraryHasContent.value;
  });
  effect(() => {
    // Streams have no track to step between, so hide prev/next entirely (like
    // the seek row) rather than leave dead chrome. Otherwise prev is live
    // whenever play is (it restarts or steps back), and next disables at the
    // genuine end of the line so a dead press reads as unavailable.
    prevBtn.classList.toggle("hidden", isStream.value);
    nextBtn.classList.toggle("hidden", isStream.value);
    prevBtn.disabled = !hasTrack.value;
    nextBtn.disabled = !hasNextTrack();
  });
  effect(() => {
    // Streams swap the whole seek row for the live indicator: no timeline to
    // scrub, so a disabled bar would just be dead chrome.
    seekBar.disabled = isStream.value;
    seekBar.classList.toggle("hidden", isStream.value);
    timeCurrentEl.classList.toggle("hidden", isStream.value);
    timeRemainingEl.classList.toggle("hidden", isStream.value);
  });
  effect(() => {
    const t = currentTime.value;
    const d = duration.value;
    seekBar.max = String(d);
    seekBar.value = String(t);
    const pct = d > 0 ? (t / d) * 100 : 0;
    seekBar.style.setProperty("--progress", `${pct}%`);
  });
  effect(() => {
    timeCurrentEl.textContent = formatTime(currentTime.value);
    timeRemainingEl.textContent = "-" + formatTime(
      Math.max(0, duration.value - currentTime.value),
    );
  });

  effect(() => {
    const v = volume.value;
    void engine.setVolume(v);
    volumeBar.value = String(v);
    volumeBar.style.setProperty("--progress", `${v * 100}%`);
    const waves = volumeBtn.querySelectorAll<SVGPathElement>(".volume-wave");
    waves.forEach((w, i) => {
      w.style.opacity = String(i === 0 ? v : v >= 1 ? 1 : 0);
    });
  });
  effect(() => {
    volumePopover.classList.toggle("open", volumePopoverOpen.value);
  });

  effect(() => {
    const path = currentNodePath.value;
    const url = currentStreamUrl.value;
    const queue = activeQueue.value;
    // A live queue row is the reactive signal for "a queue owns the playhead":
    // non-null only while a queue is the audible pool, null for folder play (and
    // when a queue rests drained). Drives this effect where queueIsActivePool()
    // — which reads non-reactive currentParent — cannot, so the highlight moves
    // even when the file path is unchanged (same track replayed from the tree).
    const queueOwnsPlayhead = queuePlayingIndex.value !== null;
    // A browsed playlist marks its tree row as "open" (a selection background),
    // independent of what's playing — so the panel shows which playlist is open
    // even when a different source owns the playhead.
    const browsed = browsedPlaylist.value;
    document
      .querySelectorAll(
        "#folder-tree .node-label.playing, #folder-tree .node-label.open, #streams-list .node-label.playing",
      )
      .forEach((el) => el.classList.remove("playing", "open"));
    // The now-playing accent marks the context that owns the playhead, not every
    // occurrence of the same file. When a playlist/queue is the active pool it
    // carries the highlight in the right pane, so the tree's copy of the same
    // track stays plain.
    if (path && !queueOwnsPlayhead) {
      document
        .querySelector(`#folder-tree .node-label[data-path="${CSS.escape(path)}"]`)
        ?.classList.add("playing");
    }
    // A playlist playing from the tree lights up its own row (the .m3u8 node,
    // keyed by sourcePath) instead of its member track — the tree's stand-in for
    // "playing from here".
    if (queueOwnsPlayhead && queue?.kind === "playlist" && queue.sourcePath) {
      document
        .querySelector(`#folder-tree .node-label[data-path="${CSS.escape(queue.sourcePath)}"]`)
        ?.classList.add("playing");
    }
    if (url) {
      document
        .querySelector(`#streams-list .node-label[data-stream-url="${CSS.escape(url)}"]`)
        ?.classList.add("playing");
    }
    if (browsed?.sourcePath) {
      document
        .querySelector(`#folder-tree .node-label[data-path="${CSS.escape(browsed.sourcePath)}"]`)
        ?.classList.add("open");
    }
  });

  // Paint the multi-select background reactively, so cmd/shift-click updates the
  // tree without a full re-render (renderNode reapplies it on any rebuild).
  effect(() => {
    const sel = treeSelection.value;
    document
      .querySelectorAll("#folder-tree .node-label.selected")
      .forEach((el) => el.classList.remove("selected"));
    for (const path of sel) {
      document
        .querySelector(`#folder-tree .node-label[data-path="${CSS.escape(path)}"]`)
        ?.classList.add("selected");
    }
  });

  // Paint the single-selected stream row reactively, so a click highlights it
  // without a full renderStreams rebuild (which reapplies it on any rebuild).
  effect(() => {
    const url = selectedStreamUrl.value;
    document
      .querySelectorAll("#streams-list .node-label.selected")
      .forEach((el) => el.classList.remove("selected"));
    if (url) {
      document
        .querySelector(`#streams-list .node-label[data-stream-url="${CSS.escape(url)}"]`)
        ?.classList.add("selected");
    }
  });

  effect(() => {
    const tab = activeTab.value;
    document.querySelectorAll<HTMLButtonElement>(".tab").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.tab === tab);
    });
    document.getElementById("tab-files")?.classList.toggle("hidden", tab !== "files");
    document.getElementById("tab-streams")?.classList.toggle("hidden", tab !== "streams");
    // The lens tab bar belongs to Files only.
    document.getElementById("lens-footer")?.classList.toggle("hidden", tab !== "files");
  });

  // Until a library folder is configured, the whole Files panel is a get-started
  // prompt instead of the lens springboard. render() owns hiding the navigator,
  // folder tree and create button (it already gates those), so just re-render it
  // when the root-set state flips.
  effect(() => {
    libraryRootSet.value;
    renderNav();
  });

  // Streams counterpart: until a stream list path is set, swap the streams list for
  // the get-started prompt. Simpler than Files (no navigator) — just the two.
  effect(() => {
    const noStreamList = !streamListPathSet.value;
    document.getElementById("streams-empty")?.classList.toggle("hidden", !noStreamList);
    streamsContainer.classList.toggle("hidden", noStreamList);
    // The Add-station button shows only for a writable (valid, local) list. When
    // the list stops being writable, drop any open stream editor so a stale form
    // can't linger (a metadata editor is unrelated, so leave it be).
    const btn = document.getElementById("add-station-btn");
    btn?.classList.toggle("hidden", !streamListWritable.value);
    if (!streamListWritable.value && paneEditor.value === "stream") closePaneEditor();
  });

  // The two-face right pane, painted from the derived paneView. `has-nav` reveals
  // the nav bar whenever a list exists; `show-list` puts the list face up (else
  // the hero owns the pane). Reads queuePlayingIndex too so the highlighted/
  // scrolled row tracks advances (and clears when the queue is merely stashed),
  // even when paneView's own fields are unchanged.
  effect(() => {
    const { list, isSource, showList, nav } = paneView.value;
    queuePlayingIndex.value;
    const hasList = list !== null;
    nowPlayingPanel.classList.toggle("has-nav", hasList && nav !== null);
    nowPlayingPanel.classList.toggle("show-list", hasList && showList);
    renderQueue(list, isSource);
  });

  // The editor face: `.show-editor` takes the pane over whichever face was up while
  // a track's tags or a stream are being edited; clearing paneEditor reveals it
  // again (see openPaneEditor). Its own effect so it doesn't rebuild the queue list.
  effect(() => {
    nowPlayingPanel.classList.toggle("show-editor", paneEditor.value !== null);
  });

  // Paint the list-pane multi-select background reactively, so cmd/shift-click
  // updates it without a renderQueue rebuild (which would scroll to the playing
  // row on every click). Runs after the render effect above — both read the open
  // list — so it repaints on rebuilds too. Maps the object-keyed set back to rows
  // through each row's view index (paths aren't unique across duplicates).
  effect(() => {
    const sel = queueSel.signal.value;
    const tracks = openListTracks();
    queueListEl.querySelectorAll<HTMLElement>("li.queue-row").forEach((li) => {
      const t = tracks[Number(li.dataset.rowIndex)];
      li.classList.toggle("selected", !!t && sel.has(t));
    });
  });

  // The navigator's leaf rows (Songs, etc.) paint from navSel — their own
  // selection, independent of the queue's (see makeTrackSelection) — updating on
  // cmd/shift-click without a rebuild. navLeafTracks holds the list currently
  // shown; only the on-screen list ever writes it (asyncListBody drops a
  // superseded load whose host was detached), so its indices match the DOM rows.
  effect(() => {
    const sel = navSel.signal.value;
    document
      .querySelectorAll<HTMLElement>("#library-nav .nav-track-row")
      .forEach((el) => {
        const t = navLeafTracks[Number(el.dataset.rowIndex)];
        el.classList.toggle("selected", !!t && sel.has(t));
      });
  });

  effect(() => {
    const open = settingsOpen.value;
    settingsPanel.classList.toggle("hidden", !open);
    nowPlayingPanel.classList.toggle("hidden", open);
    miniplayerBtn.classList.toggle("hidden", open);
    settingsBackBtn.classList.toggle("hidden", !open);
    // Search targets the library/streams, not settings — hide it here too so the
    // whole action cluster (search + mode toggles) clears out together rather
    // than leaving a lone search box beside the Back button.
    searchEl.classList.toggle("hidden", open);
  });

  // The playback-mode toggles only act on the files queue, but we keep them
  // visible in the streams view too: they take little space, do no harm there,
  // and leaving them put avoids shuffling the search box as tabs switch. Only
  // settings hides them.
  effect(() => {
    playbackModesEl.classList.toggle("hidden", settingsOpen.value);
  });

  effect(() => {
    modeShuffleBtn.classList.toggle("active", shuffleMode.value);
    modeShuffleBtn.setAttribute("aria-pressed", String(shuffleMode.value));
  });

  effect(() => {
    const mode = repeatMode.value;
    modeRepeatBtn.classList.toggle("active", mode !== "off");
    modeRepeatBtn.classList.toggle("repeat-one", mode === "one");
    const label = mode === "all" ? "Repeat all" : mode === "one" ? "Repeat one" : "Repeat off";
    modeRepeatBtn.setAttribute("aria-label", label);
    modeRepeatBtn.title = label;
  });

  // Library-folder rows get their .invalid outline in renderLibraryRootRows
  // (per-row, driven by invalidLibraryRoots).
  effect(() => {
    streamListPathInput.classList.toggle("invalid", !streamListPathValid.value);
  });
}

// --- Init ---

async function init(): Promise<void> {
  if (navigator.userAgent.includes("Mac")) {
    document.body.classList.add("platform-mac");
  }

  const appWindow = getCurrentWindow();
  document.addEventListener("mousedown", (e) => {
    const target = e.target as HTMLElement | null;
    if (!target) return;
    if (target.closest("button, input, select, textarea, a, [role='slider']")) return;
    if (!target.closest("[data-tauri-drag-region]")) return;
    if (e.detail === 2) {
      void appWindow.toggleMaximize();
    } else {
      void appWindow.startDragging();
    }
  });

  // Double-click the art/title area (not the controls row) to toggle the mini
  // player. Not a drag region, so this never conflicts with the topbar's
  // double-click-to-maximize.
  const nowPlayingMainEl = document.querySelector("#now-playing-main") as HTMLElement;
  nowPlayingMainEl.addEventListener("dblclick", () => void toggleMiniPlayer());
  // Same gesture in the queue view, but only in the empty space around the
  // rows — double-clicking a row is reserved for playing it.
  const queueViewEl = document.querySelector("#queue-view") as HTMLElement;
  queueViewEl.addEventListener("dblclick", (e) => {
    if ((e.target as HTMLElement).closest(".queue-row")) return;
    void toggleMiniPlayer();
  });
  // Recompute the title/artist marquees on every resize (width change or a
  // mode switch across the breakpoint both change whether the lines overflow).
  window.addEventListener("resize", updateMarquees);
  // Mini-only expand button (shown where the mini-player toggle sits in full
  // view); its arrows are the mirror of that toggle's collapse glyph.
  const expandBtn = document.querySelector("#expand-btn") as HTMLButtonElement;
  expandBtn.addEventListener("click", () => void toggleMiniPlayer());

  nowPlayingTitleEl = document.querySelector("#now-playing-title") as HTMLElement;
  nowPlayingTitleInner = nowPlayingTitleEl.querySelector(".marquee-inner") as HTMLElement;
  nowPlayingArtistEl = document.querySelector("#now-playing-artist") as HTMLElement;
  nowPlayingArtistInner = nowPlayingArtistEl.querySelector(".marquee-inner") as HTMLElement;
  nowPlayingAlbumEl = document.querySelector("#now-playing-album") as HTMLElement;
  nowPlayingAlbumInner = nowPlayingAlbumEl.querySelector(".marquee-inner") as HTMLElement;
  navBarTextEl = document.querySelector("#nav-bar-text") as HTMLElement;
  navBarBtnEl = document.querySelector("#nav-bar-btn") as HTMLButtonElement;
  navBarBtnEl.addEventListener("click", toggleNavFace);
  navBarAltBtnEl = document.querySelector("#nav-bar-alt-btn") as HTMLButtonElement;
  navBarAltBtnEl.addEventListener("click", showSourceList);
  // Double-click the bar's text (not the button) toggles the mini player, like
  // the hero card it sits beneath.
  navBarTextEl.addEventListener("dblclick", () => void toggleMiniPlayer());
  nowPlayingStreamMetaEl = document.querySelector("#now-playing-stream-meta") as HTMLElement;
  streamMetaSongEl = document.querySelector("#stream-meta-song") as HTMLElement;
  streamMetaSongInner = streamMetaSongEl.querySelector(".marquee-inner") as HTMLElement;
  streamMetaArtistEl = document.querySelector("#stream-meta-artist") as HTMLElement;
  streamMetaArtistInner = streamMetaArtistEl.querySelector(".marquee-inner") as HTMLElement;
  // The metadata above is selectable text (copy "what's playing"), so a
  // double-click on it selects a word instead of bubbling to #now-playing-main's
  // mini-player toggle. The panel's art and empty space still toggle as before.
  for (const el of [
    nowPlayingTitleEl,
    nowPlayingArtistEl,
    nowPlayingAlbumEl,
    nowPlayingStreamMetaEl,
  ]) {
    el.addEventListener("dblclick", (e) => e.stopPropagation());
  }
  liveIndicatorEl = document.querySelector("#live-indicator") as HTMLElement;
  nowPlayingArtEl = document.querySelector("#now-playing-art") as HTMLImageElement;
  nowPlayingEmptyEl = document.querySelector("#now-playing-empty") as HTMLElement;
  playPauseBtn = document.querySelector("#play-pause-btn") as HTMLButtonElement;
  prevBtn = document.querySelector("#prev-btn") as HTMLButtonElement;
  nextBtn = document.querySelector("#next-btn") as HTMLButtonElement;
  seekBar = document.querySelector("#seek-bar") as HTMLInputElement;
  timeCurrentEl = document.querySelector("#time-current") as HTMLElement;
  timeRemainingEl = document.querySelector("#time-remaining") as HTMLElement;
  volumeControlEl = document.querySelector("#volume-control") as HTMLElement;
  volumeBtn = document.querySelector("#volume-btn") as HTMLButtonElement;
  volumePopover = document.querySelector("#volume-popover") as HTMLElement;
  volumeBar = document.querySelector("#volume-bar") as HTMLInputElement;
  treeContainer = document.querySelector("#folder-tree") as HTMLElement;
  // Click-off deselect for the Files tab's own rows (the file-manager convention),
  // bound to the whole scrolling tab-panel (not just #folder-tree, which only grows
  // to its content) so the blank area below the last row deselects too. A click off
  // a nav-leaf row drops the navigator selection; a click off a tree row drops the
  // tree's multi-select. The queue is a separate surface, but selecting a row in
  // either Files pane already drops the queue's selection (see makeTrackSelection's
  // onSelect wiring), so this click-off doesn't need to touch it.
  (document.querySelector("#tab-files") as HTMLElement).addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    if (!target.closest(".nav-track-row")) navSel.clear();
    if (!target.closest(".node-label")) clearTreeSelection();
  });
  (document.querySelector("#create-playlist-btn") as HTMLButtonElement).addEventListener(
    "click",
    () => void menuNewPlaylist(),
  );
  (document.querySelector("#add-station-btn") as HTMLButtonElement).addEventListener(
    "click",
    () => openAddStationEditor(),
  );
  streamsContainer = document.querySelector("#streams-list") as HTMLElement;
  // Same click-off convention for the streams tab: a click below the rows (or on
  // any empty space in the tab-panel) drops the stream highlight.
  (document.querySelector("#tab-streams") as HTMLElement).addEventListener("click", (e) => {
    if (!(e.target as HTMLElement).closest(".node-label")) selectedStreamUrl.value = null;
  });
  libraryRootsContainer = document.querySelector("#library-roots") as HTMLElement;
  libraryRootAddBtn = document.querySelector("#library-root-add") as HTMLButtonElement;
  streamListPathInput = document.querySelector("#stream-list-path") as HTMLInputElement;
  streamListPathBrowseBtn = document.querySelector("#stream-list-path-browse") as HTMLButtonElement;
  miniplayerBtn = document.querySelector("#miniplayer-btn") as HTMLButtonElement;
  miniplayerBtn.addEventListener("click", () => void toggleMiniPlayer());
  settingsBackBtn = document.querySelector("#settings-back-btn") as HTMLButtonElement;
  playbackModesEl = document.querySelector("#playback-modes") as HTMLElement;
  modeShuffleBtn = document.querySelector("#mode-shuffle") as HTMLButtonElement;
  modeRepeatBtn = document.querySelector("#mode-repeat") as HTMLButtonElement;
  searchEl = document.querySelector("#search") as HTMLElement;
  searchInput = document.querySelector("#search-input") as HTMLInputElement;
  searchResultsEl = document.querySelector("#search-results") as HTMLElement;
  nowPlayingPanel = document.querySelector("#now-playing-panel") as HTMLElement;
  paneEditorView = document.querySelector("#pane-editor-view") as HTMLElement;
  settingsPanel = document.querySelector("#settings-panel") as HTMLElement;
  splitterEl = document.querySelector("#splitter") as HTMLElement;
  queueTitleEl = document.querySelector("#queue-title-text") as HTMLElement;
  queueSubtitleEl = document.querySelector("#queue-subtitle") as HTMLElement;
  queueListEl = document.querySelector("#queue-list") as HTMLElement;
  // Click-off deselect for the queue, mirroring the Files handler: a click off any
  // row drops the queue's own multi-select. Selecting a queue row already drops the
  // Files-tab selections (see makeTrackSelection's onSelect wiring), so this
  // click-off only needs to handle the queue's own.
  queueListEl.addEventListener("click", (e) => {
    if (!(e.target as HTMLElement).closest(".queue-row")) queueSel.clear();
  });
  queueCloseBtn = document.querySelector("#queue-close-btn") as HTMLButtonElement;
  queueCloseBtn.addEventListener("click", closeQueue);
  queueRenameBtn = document.querySelector("#queue-rename-btn") as HTMLButtonElement;
  // Clicking anywhere on the title — the text or the hover pencil — starts an
  // inline rename; startTitleEdit no-ops when the header isn't a playlist.
  (document.querySelector("#queue-title") as HTMLElement).addEventListener("click", startTitleEdit);
  // Dropping onto the list's empty area (below the last row, or an empty playlist)
  // targets the end of the list — that case is resolved by updateDropTarget's
  // hit-test against the list box, so no container drop listener is needed.
  toastEl = document.querySelector("#toast") as HTMLElement;

  store = await load(STORE_FILE, { defaults: {}, autoSave: false });

  libraryRoots = (await store.get<string[]>(KEY_LIBRARY_ROOTS)) ?? [];
  // First run (key never set): adopt the default stream list the backend seeds
  // in the app data dir, and persist it so it shows in settings and can be
  // repointed. An explicit "" (user cleared the path) is respected, not reseeded.
  const storedStreamListPath = await store.get<string>(KEY_STREAM_LIST_PATH);
  let streamListPath = storedStreamListPath ?? "";
  if (storedStreamListPath === undefined) {
    try {
      streamListPath = await invoke<string>("default_stream_list_path");
      await store.set(KEY_STREAM_LIST_PATH, streamListPath);
      await store.save();
    } catch (e) {
      console.error("default_stream_list_path failed", e);
    }
  }
  const splitterWidth = (await store.get<string>(KEY_SPLITTER_WIDTH)) ?? null;
  const storedVolume = await store.get<number>(KEY_VOLUME);
  volume.value = typeof storedVolume === "number" ? Math.max(0, Math.min(1, storedVolume)) : 1;
  if (volume.value > 0) lastNonZeroVolume = volume.value;

  // Autoadvance (global, defaults on). Prefer the new key; fall back to the legacy
  // browsing setting so an existing user's off-preference carries over. Sync the
  // OS Playback-menu checkmark, then listen for the menu's toggle.
  autoadvance.value =
    (await store.get<boolean>(KEY_AUTOADVANCE)) ??
    (await store.get<boolean>(KEY_AUTOADVANCE_FILES)) ??
    true;
  void invoke("set_autoadvance_checked", { enabled: autoadvance.value });
  await listen<boolean>("menu:autoadvance", (event) => {
    setAutoadvance(event.payload);
  });

  // Playback modes (both default off). The button effects read these signals, so
  // setting them here syncs the toolbar; the shuffle bag is refilled lazily at
  // the next play, so no need to seed it now.
  shuffleMode.value = (await store.get<boolean>(KEY_SHUFFLE)) ?? false;
  const storedRepeat = await store.get<RepeatMode>(KEY_REPEAT);
  repeatMode.value =
    storedRepeat === "all" || storedRepeat === "one" ? storedRepeat : "off";

  // Keep the Playback-menu checkmarks in sync with the frontend's own state —
  // these effects fire on load (syncing the persisted values) and after any
  // toolbar or menu change. Mute reflects a zeroed volume.
  effect(() => {
    void invoke("set_shuffle_checked", { shuffle: shuffleMode.value });
  });
  effect(() => {
    void invoke("set_repeat_checked", { mode: repeatMode.value });
  });
  effect(() => {
    void invoke("set_mute_checked", { muted: volume.value === 0 });
  });

  // Recent playlists → the OS "Open Recent ▸" submenu. Load the persisted list
  // and push it into the native menu.
  recentPlaylists = (await store.get<RecentPlaylist[]>(KEY_RECENT_PLAYLISTS)) ?? [];
  syncRecentPlaylistsMenu();

  // The last Files-tab place, handed to the navigator below to restore on launch.
  const navLocation = (await store.get<NavStep[]>(KEY_NAV_LOCATION)) ?? [];

  // Restore the open sidebar tab. Set before setupEffects() so the tab effect
  // renders the right panel on first paint (no Files→Streams flash).
  const storedTab = await store.get<string>(KEY_ACTIVE_TAB);
  if (storedTab === "streams" || storedTab === "files") activeTab.value = storedTab;

  // Keep "Save Queue as Playlist" enabled only while an ephemeral queue is the active
  // pool (a saved playlist autosaves; nothing else is convertible). currentNodePath
  // is a signal, so this re-runs whenever playback moves in or out of the queue.
  effect(() => {
    void currentNodePath.value;
    void activeQueue.value;
    void invoke("set_save_playlist_enabled", { enabled: queueCanSaveAsPlaylist() });
  });

  // Keep "Move Playlist File…" enabled only while a playlist is open — browsed,
  // else playing (openPlaylistPath). There's no file to relocate otherwise, and
  // enabling it mirrors exactly what menuMovePlaylist would act on.
  effect(() => {
    void browsedPlaylist.value;
    void activeQueue.value;
    void invoke("set_move_playlist_enabled", { enabled: openPlaylistPath() != null });
  });

  // Playlist menu intents (New / Open… / Save / Move / Clear Recent), plus a
  // recent item carrying its own path.
  await listen<string>("menu:playlist", (event) => {
    switch (event.payload) {
      case "new":
        void menuNewPlaylist();
        break;
      case "open":
        void menuOpenPlaylist();
        break;
      case "save":
        void menuSavePlaylist();
        break;
      case "move":
        void menuMovePlaylist();
        break;
      case "recent-clear":
        recentPlaylists = [];
        void persistRecentPlaylists();
        syncRecentPlaylistsMenu();
        break;
    }
  });
  await listen<string>("menu:playlist-open-path", (event) => {
    void browsePlaylistPath(event.payload);
  });

  setupTabs();
  // Inject the leaf-list builder + backend loaders the navigator needs; keeping
  // them as deps (rather than a value import back into this entry module) avoids a
  // circular import while letting the navigator reuse the shared row behavior.
  initLibraryNav({
    listAllSongs: () => invoke<SearchTrack[]>("list_all_songs"),
    listAllArtists: () => invoke<SearchArtist[]>("list_all_artists"),
    listAllAlbums: () => invoke<SearchAlbum[]>("list_all_albums"),
    listAllPlaylists: loadAllPlaylists,
    artistAlbums: (artist) => invoke<SearchAlbum[]>("artist_albums", { artist }),
    artistAlbumlessTracks: (artist) =>
      invoke<SearchTrack[]>("artist_albumless_tracks", { artist }),
    albumTracks: (album, albumArtist) =>
      invoke<SearchTrack[]>("album_tracks", { album, albumArtist }),
    renderLeafTrackList,
    // A playlist row: single-click opens it in the right pane, double-click plays.
    openPlaylist: (path) => void browsePlaylistPath(path),
    playPlaylist: (path) => void playPlaylistPath(path),
    showArtistMenu: showArtistContextMenu,
    showAlbumMenu: showAlbumContextMenu,
    showPlaylistMenu: showPlaylistContextMenu,
    persistLocation: persistNavLocation,
    libraryRootSet: () => libraryRootSet.value,
  }, navLocation);
  setupPlaybackModes();
  await setupWindowSize(appWindow);
  setupSplitter(splitterWidth);
  setupSettings();
  setupSearch();
  setupPlayerControls();
  setupVolumeControl();
  setupEffects();

  renderLibraryRootRows();
  streamListPathInput.value = streamListPath;

  // The + under the library rows appends a folder via the same picker as a row's
  // Choose… button.
  libraryRootAddBtn.addEventListener("click", () => void browseLibraryRoot());
  streamListPathBrowseBtn.addEventListener("click", () => void browseStreamListPath());

  // The stream field also accepts a typed/pasted path: Enter commits (blur fires
  // "change"), and change re-reads the stream list via the same path as the
  // Choose… button. (Library rows wire their own inputs in renderLibraryRootRows.)
  streamListPathInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") streamListPathInput.blur();
  });
  streamListPathInput.addEventListener("change", () => {
    void setStreamListPath(streamListPathInput.value.trim());
  });

  await listen<ScanResult>("library-scanned", (event) => {
    if (!event.payload.ok) {
      console.error("library scan failed:", event.payload.error);
      return;
    }
    void refreshLibrary();
  });

  await listen<string>("open-file", (event) => {
    openAssociatedFile(event.payload);
  });

  // Next / previous from the OS Now Playing widget or hardware media keys.
  await listen("remote-next", () => skipNext());
  await listen("remote-prev", () => skipPrev());

  // Transport from the Playback menu: Play/Pause, plus Previous/Next whose
  // ⌘←/⌘→ accelerators double as the keyboard shortcut (and reveal it in the
  // menu). Same skipNext/Prev path as the media keys above.
  await listen<string>("menu:transport", (event) => {
    switch (event.payload) {
      case "playpause":
        togglePlayPause();
        break;
      case "prev":
        skipPrev();
        break;
      case "next":
        skipNext();
        break;
    }
  });

  // Playback-menu Shuffle / Repeat / Volume / Mute / Clear Queue. Each routes to
  // the same handler the toolbar uses, so state and persistence stay identical;
  // the sync effects above then re-check the menu items.
  await listen("menu:shuffle", () => toggleShuffle());
  await listen<string>("menu:repeat", (event) => {
    setRepeatMode(event.payload as RepeatMode);
    // The clicked item auto-toggled its checkmark natively. If it was already the
    // active mode, setRepeatMode is a no-op (no signal change, so the sync effect
    // won't fire), which would leave it wrongly unchecked — re-sync explicitly.
    void invoke("set_repeat_checked", { mode: repeatMode.value });
  });
  await listen<string>("menu:volume", (event) => {
    setVolume(volume.value + (event.payload === "up" ? 0.1 : -0.1));
  });
  await listen("menu:mute", () => toggleMute());
  await listen("menu:miniplayer", () => void toggleMiniPlayer());

  // Drain any file passed at launch (cold start). Must happen after the
  // open-file listener is registered so the ready-flag race is closed.
  const pendingOpen = await invoke<string | null>("frontend_ready");
  if (pendingOpen) {
    openAssociatedFile(pendingOpen);
  }

  await refreshTree(libraryRoots);
  void refreshPlaylistIndex();
  await refreshStreams(streamListPath);

  if (libraryRoots.length) {
    void invoke("rescan_libraries", { paths: libraryRoots });
    void invoke("watch_libraries", { paths: libraryRoots }).catch((e) =>
      console.error("watch_libraries failed", e),
    );
  }

  // Dev/e2e only: connect to the test harness if one launched us. The probe
  // reports the live playback signals so tests can assert engine/UI agreement.
  void maybeStartE2eBridge(
    () => ({
      isPlaying: isPlaying.value,
      hasTrack: hasTrack.value,
      isStream: isStream.value,
      currentTime: currentTime.value,
      duration: duration.value,
      title: npTitle.value,
      currentNodePath: currentNodePath.value,
      queuePlayingIndex: queuePlayingIndex.value,
      shuffle: shuffleMode.value,
      repeat: repeatMode.value,
      autoadvance: autoadvance.value,
      queueIsActivePool: queueIsActivePool(),
      // True while the active pool is a real playlist file (autosaves on curation).
      // "Add to queue" detaches the pool from its file, flipping this to false.
      activePoolIsPlaylist: isPlaylistSource(activeQueue.value),
      queueLength: activeQueue.value?.tracks.length ?? 0,
      treeSelectionSize: treeSelection.value.size,
      listSelectionSize: queueSel.signal.value.size,
      navSelectionSize: navSel.signal.value.size,
    }),
    {
      playFile: (p) => openExternalFile(String(p)),
      // Click a tree row through the real handler, optionally with Cmd/Shift so
      // tests can drive multi-select (the bridge's plain `click` carries no
      // modifiers). Dispatches a genuine MouseEvent so onNodeClick runs its true
      // branch (toggle / range / play).
      treeClick: (arg) => {
        const a = arg as { selector: string; meta?: boolean; shift?: boolean };
        const el = document.querySelector<HTMLElement>(a.selector);
        if (!el) throw new Error(`no tree row for selector: ${a.selector}`);
        el.dispatchEvent(
          new MouseEvent("click", {
            bubbles: true,
            cancelable: true,
            metaKey: !!a.meta,
            shiftKey: !!a.shift,
          }),
        );
      },
      // Add the current file-tree selection to the queue via the same call the
      // multi-select context-menu verb makes, so tests assert the selection
      // resolves to the right tracks.
      addSelectionToQueue: () => addToQueue(selectedTracks()),
      // Click a list row (queue / browsed playlist) through the real handler,
      // optionally with Cmd/Shift, so tests drive the list's multi-select the same
      // way treeClick drives the tree's. Targets the Nth `li.queue-row` in view
      // order and dispatches a genuine modifier-carrying MouseEvent.
      listClick: (arg) => {
        const a = arg as { index: number; meta?: boolean; shift?: boolean };
        const rows = queueListEl.querySelectorAll<HTMLElement>("li.queue-row");
        const el = rows[a.index];
        if (!el) throw new Error(`no queue row at index: ${a.index}`);
        el.dispatchEvent(
          new MouseEvent("click", {
            bubbles: true,
            cancelable: true,
            metaKey: !!a.meta,
            shiftKey: !!a.shift,
          }),
        );
      },
      // The list-pane (queue / browsed playlist) equivalents of the verbs above,
      // acting on the object-keyed list selection.
      addListSelectionToQueue: () => addToQueue(selectedListTracks()),
      removeListSelection: () => removeCuratedTracks(selectedListTracks()),
      // Point the library at a single folder through the real setLibraryRoots
      // path (rescan + watch + refreshTree), so tree-interaction tests can
      // populate the file browser without the native folder picker.
      setLibraryRoot: (arg) => setLibraryRoots([String((arg as { path: string }).path)]),
      // Toggle the global autoadvance through the real setAutoadvance path (the
      // same one the OS Playback menu drives), so a toggle mid-play also
      // reconciles the engine via applyAutoadvanceChange.
      setAutoadvance: (arg) => {
        setAutoadvance((arg as { enabled: boolean }).enabled);
      },
      // Add paths to the queue via the real "Add to queue" entry point: appends
      // to an open queue, or starts a fresh one when nothing is queued.
      addToQueue: (arg) => {
        const a = arg as { paths: string[] };
        addToQueue(
          a.paths.map((path) => ({ path, title: null, artist: null, album: null })),
        );
      },
      // Play a saved playlist file from disk through the real read+play path, so
      // it becomes the active pool under the Playlists autoadvance context.
      playPlaylist: (arg) => playPlaylistPath(String((arg as { path: string }).path)),
      // Open a saved playlist in the browse pane (single-click path) without
      // changing playback, so curation tests can edit a browsed copy.
      browsePlaylist: (arg) => browsePlaylistPath(String((arg as { path: string }).path)),
      // Save Queue as Playlist to an explicit path, bypassing the native file
      // picker (undrivable in e2e). Runs the real post-dialog logic so tests can
      // assert the ephemeral queue becomes an autosaving playlist source.
      savePlaylistAs: (arg) =>
        saveQueueAsPlaylist(String((arg as { path: string }).path)),
      // Add explicit paths to a specific playlist file via the real
      // "Add to playlist ▸" entry point (addTracksToPlaylist), so tests exercise
      // its open-list-vs-closed-file routing — including the case where the target
      // is the playing pool but a *different* playlist is browsed.
      addToPlaylist: (arg) => {
        const a = arg as { path: string; paths: string[] };
        const tracks: SearchTrack[] = a.paths.map((path) => ({
          path,
          title: null,
          artist: null,
          album: null,
        }));
        return addTracksToPlaylist(a.path, () => tracks);
      },
      // Leave a browsed playlist for the playing source's own list (the real nav
      // path), so a subsequent curation targets the active pool rather than the
      // browsed copy.
      showSourceList: () => showSourceList(),
      // Remove a row from the open (browsed or active) list via the real curation
      // path, so the edit reconciles engine + activeQueue when it hits the pool.
      removeRow: (arg) => removeCuratedRow((arg as { index: number }).index),
      // Play an explicit set of file paths as a synthetic pool via the real
      // playQueue path, so curation tests can reorder/remove a live multi-track
      // list. The "queue:" path makes it the active pool (queueIsActivePool).
      playPaths: (arg) => {
        const a = arg as { paths: string[]; startIndex?: number };
        const tracks: SearchTrack[] = a.paths.map((path) => ({
          path,
          title: null,
          artist: null,
          album: null,
        }));
        playQueue(
          {
            kind: "folder",
            title: "E2E Pool",
            subtitle: trackCountSubtitle(tracks),
            tracks,
          },
          "queue:e2e:pool",
          a.startIndex,
        );
      },
      // Reorder a row by synthesizing the real pointer-drag: pointerdown on the
      // row, a move past the drag threshold, a move to the target position, then
      // pointerup. Drives the actual attachRowReorder path (threshold, hit-test,
      // drop) rather than shortcutting to reorderCuratedTracks, so the test reflects
      // real drag behavior. `to` matches reorderCuratedTracks's insert-before index.
      dragRow: (arg) => {
        const a = arg as { from: number; to: number };
        const rows = Array.from(
          queueListEl.querySelectorAll<HTMLElement>("li.queue-row"),
        );
        const src = rows[a.from];
        if (!src) return;
        const s = src.getBoundingClientRect();
        const sx = s.left + s.width / 2;
        const sy = s.top + s.height / 2;
        let tx: number;
        let ty: number;
        if (a.to >= rows.length) {
          const last = rows[rows.length - 1].getBoundingClientRect();
          tx = last.left + last.width / 2;
          ty = last.bottom + 4; // empty area past the last row -> insert at end
        } else {
          const t = rows[a.to].getBoundingClientRect();
          tx = t.left + t.width / 2;
          ty = t.top + t.height * 0.25; // top half -> insert before row `to`
        }
        const fire = (target: EventTarget, type: string, x: number, y: number) =>
          target.dispatchEvent(
            new PointerEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true }),
          );
        fire(src, "pointerdown", sx, sy);
        fire(window, "pointermove", sx + 8, sy + 8); // cross the drag threshold
        fire(window, "pointermove", tx, ty); // hit-test the target row
        fire(window, "pointerup", tx, ty);
      },
    },
  );
}

window.addEventListener("DOMContentLoaded", init);
