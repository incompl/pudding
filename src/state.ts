// Reactive renderer state: the signals the UI derives from, plus the small
// pure-signal helpers that read/mutate them. Extracted from main.ts so every
// feature module can import state without importing main.ts.
//
// Keep this dependency-light (only types + the signal lib): it must never import
// a feature module, or import cycles become easy to introduce. State that needs
// feature functions (paneView, queueIsActivePool) deliberately stays in main.ts.

import { signal } from "@preact/signals-core";
import type { Store } from "@tauri-apps/plugin-store";
import type {
  Queue,
  RepeatMode,
  TreeNode,
  Stream,
  SearchTrack,
  RecentPlaylist,
  PlaylistRef,
} from "./types";

// --- Non-reactive plumbing state ---
//
// The reassigned module-level `let`s that aren't reactive — "the current value,
// no re-render on change". They live as fields on one shared object so any
// feature module can read AND write them (`app.currentParent = …`) without the
// read-only live-binding problem a plain exported `let` would hit. Reactive
// state stays in the signals below; DOM refs live in dom-refs.ts.
//
// State whose home is unambiguously one module (drag ghost, stream-meta fade)
// stays a local `let` there; only genuinely cross-module plumbing lives here.
export interface AppState {
  store: Store;
  // The library tree root (Files tab). Null until the first scan populates it.
  rootNode: TreeNode | null;
  libraryRoots: string[];
  invalidLibraryRoots: Set<string>;
  // File-tree multi-select Shift-range pivot (path of the last click).
  selectionAnchor: string | null;
  // Which pane last committed a selection, so cross-pane clears stay coordinated and
  // the keyboard cursor (activeKbdList) knows which surface bare ↑/↓ should drive.
  lastSelectionPane: "tree" | "list" | "stream" | "nav" | null;
  allStreams: Stream[];
  currentStreamName: string | null;
  // The synthetic/real parent whose children form the audible pool.
  currentParent: TreeNode | null;
  // Bumps per art request so a stale async art load can't overwrite a newer one.
  artRequestId: number;
  // The engine's current pool + index, snapshotted for restart/advance logic.
  lastQueue: string[];
  lastIndex: number;
  pendingQueueIndex: number | null;
  queueEnded: boolean;
  shuffleBag: string[];
  // The tracks already played this shuffle session, in the order they were heard
  // (the current track is not on it — it's pushed only as playback leaves it).
  // skipPrev pops this to return to the track you actually just heard, instead of
  // restarting the current one. Cleared whenever a new play context begins.
  shuffleHistory: string[];
  // Throttle tell for pushPlayback ticks.
  lastPlaybackPush: number;
  pendingQueueScrollIndex: number | null;
  recentPlaylists: RecentPlaylist[];
  playlistIndex: PlaylistRef[];
  // Whether the playlist index has completed its first build (distinguishes a
  // genuinely empty library from "not walked yet" so the navigator can show a
  // "Loading…" line until the initial walk lands rather than a false "No playlists").
  playlistIndexLoaded: boolean;
  // The leaf list currently shown in the navigator (maps the nav selection back
  // to rows by view index).
  navLeafTracks: SearchTrack[];
  // The synthetic pool path (ctx.syntheticPath) of that leaf list. The now-playing
  // accent lights a leaf row when this equals the live pool (app.currentParent.path)
  // — i.e. the list you're looking AT is the one feeding playback — covering both
  // lone play from the leaf and an explicit Play album/artist of the same set. Null
  // when no leaf list is shown.
  navLeafPoolPath: string | null;
  // Library-refresh coalescing + edit-deferral flags.
  libraryRefreshing: boolean;
  libraryRefreshPending: boolean;
  inlineEditing: boolean;
  refreshDeferredWhileEditing: boolean;
  // A playlist file to reveal in the tree once the next refresh lands.
  pendingRevealPlaylistPath: string | null;
  // A playing track's path to scroll to the next time a leaf track list builds —
  // set when the now-playing title is clicked to reveal the track in its playing
  // context (see revealNowPlaying). Consumed (and cleared) by the first
  // renderLeafTrackList that follows, so a navigation landing on the wrong list
  // just drops it. Null when no reveal is pending.
  pendingRevealPlayingPath: string | null;
  // Set at launch when a queue + playhead was restored from the previous session:
  // the engine holds no track yet, so the first play press seeds it here and seeks
  // to `time`. Cleared the moment any real playback starts (see feedEngine et al.).
  pendingResume: { time: number } | null;
}

export const app: AppState = {
  store: undefined as unknown as Store, // assigned in init(), like the old `let`
  rootNode: null,
  libraryRoots: [],
  invalidLibraryRoots: new Set<string>(),
  selectionAnchor: null,
  lastSelectionPane: null,
  allStreams: [],
  currentStreamName: null,
  currentParent: null,
  artRequestId: 0,
  lastQueue: [],
  lastIndex: 0,
  pendingQueueIndex: null,
  queueEnded: false,
  shuffleBag: [],
  shuffleHistory: [],
  lastPlaybackPush: 0,
  pendingQueueScrollIndex: null,
  recentPlaylists: [],
  playlistIndex: [],
  playlistIndexLoaded: false,
  navLeafTracks: [],
  navLeafPoolPath: null,
  libraryRefreshing: false,
  libraryRefreshPending: false,
  inlineEditing: false,
  refreshDeferredWhileEditing: false,
  pendingRevealPlaylistPath: null,
  pendingRevealPlayingPath: null,
  pendingResume: null,
};

// --- Reactive state ---

export const hasTrack = signal(false);
export const npTitle = signal("");
export const npArtist = signal<string | null>(null);
export const npAlbum = signal<string | null>(null);
// The playing track's album-artist grouping key (albumArtist ?? artist), stashed
// so clicking the now-playing album line can drill to the right album detail —
// matching how the backend's album_tracks groups. Null for streams / external
// files with no album context.
export const npAlbumArtist = signal<string | null>(null);
export const npArt = signal<string | null>(null);
// ICY now-playing (song + artist) shown under the station name during
// streams. Null until the first title arrives (or forever, for stations that
// never send one); the block is absolutely positioned so its arrival never
// shifts the station name.
export const npStreamMeta = signal<{ song: string; artist: string | null } | null>(
  null,
);

export const isStream = signal(false);
export const isPlaying = signal(false);
export const currentTime = signal(0);
export const duration = signal(0);
export const volume = signal(1);
export const volumePopoverOpen = signal(false);

export const currentNodePath = signal<string | null>(null);
export const currentStreamUrl = signal<string | null>(null);
// The stream row highlighted by a single click — a select, not a commit. Mirrors
// the tree's select-on-click (play is the hover button or a double-click), so a
// click can preview which station you're about to start without interrupting
// what's already playing.
export const selectedStreamUrl = signal<string | null>(null);

export const settingsOpen = signal(false);
// The About panel shares the right pane with Settings (mutually exclusive: the
// same Back button dismisses either). Opened from Pudding → About Pudding.
export const aboutOpen = signal(false);

// Snap the right pane back to Now Playing, dismissing whichever panel face
// (Settings or About) is up. Called from the user gestures that change what the
// pane would show — playing a track, manual skip, changing the queue, browsing a
// playlist, opening an editor — so the result of the action is revealed instead
// of staying hidden behind a panel. Deliberately NOT called on autoadvance (a
// track ending into the next) or on shuffle/repeat toggles: those leave an open
// panel up. Idempotent.
export function dismissRightPanel(): void {
  settingsOpen.value = false;
  aboutOpen.value = false;
}
export const activeTab = signal<"files" | "streams">("files");

// The playing *source* as a navigable list: an ephemeral queue (Play
// folder/album/artist, Add to queue) or a *played* playlist (kind "playlist"
// with a sourcePath). Null when a lone track / stream plays with no queue. This
// is what's playing (or stashed while something else plays); it is distinct from
// `browsedPlaylist` below — a playlist you're merely *looking at* changes no
// playback. Together they feed the two-face right pane (see paneView).
export const activeQueue = signal<Queue | null>(null);

// Named for intent at the call sites; both just set `activeQueue`.
export function openActiveQueue(queue: Queue): void {
  activeQueue.value = queue;
}
export function clearActiveQueue(): void {
  activeQueue.value = null;
}

// A playlist opened for *browsing* only — single-click in the tree, OS Open… /
// Open Recent, or New Playlist. Viewing/curating it never changes playback: a
// queue can keep playing (as `activeQueue`) while you look at a playlist here.
// Playing *from* it (double-click, or clicking a row) is the commit that makes
// it the source — moving it into `activeQueue` and clearing this.
export const browsedPlaylist = signal<Queue | null>(null);

// True while a text field (search, an inline rename, an editor) holds focus. Gates
// the Edit ▸ Undo/Redo menu items off so their ⌘Z/⌘⇧Z accelerators don't preempt
// the web view's own text undo while typing. Driven by document focus events.
export const editingText = signal(false);

// Which face fills the right pane: true = the list face (the queue or the open
// playlist), false = the now-playing hero. Only meaningful when a list exists
// (see paneView); the CSS falls back to the hero otherwise.
export const listFaceOpen = signal(false);

// A Queue is a *real playlist* (a backing .m3u8 file) iff it carries a
// sourcePath. The `kind` field is overloaded — ephemeral queues seeded by hand
// also use kind "playlist" — so path presence, not kind, is the true test.
export function isPlaylistSource(q: Queue | null | undefined): boolean {
  return q?.sourcePath != null;
}

// The list the list-face shows — a browsed playlist wins over the playing source
// (you can browse a playlist while a queue plays underneath) — is derived, along
// with everything else the right pane renders, by `paneView`.

// The open playlist file the OS menu acts on (Move Playlist File…): the one
// being browsed, else the one playing.
export function openPlaylistPath(): string | undefined {
  if (isPlaylistSource(browsedPlaylist.value)) return browsedPlaylist.value!.sourcePath;
  if (isPlaylistSource(activeQueue.value)) return activeQueue.value!.sourcePath;
  return undefined;
}

// Swap to the list face (reveals the queue / open playlist).
export function showListFace(): void {
  listFaceOpen.value = true;
}

// Swap to the now-playing hero. Leaving the list abandons any *browsed*
// playlist: the back button is source-anchored — you re-reach a merely-browsed
// playlist from the tree, never from the hero (which returns to what's playing).
// The queue stays put (still playing / stashed), so the hero's nav bar still
// offers to show it.
export function showHeroFace(): void {
  listFaceOpen.value = false;
  browsedPlaylist.value = null;
}

// Leave a browsed playlist for the playing source's own list, staying on the
// list face (unlike showHeroFace, which flips to the hero). Lets you jump
// straight from a playlist you're eyeing to the queue/playlist that's playing.
export function showSourceList(): void {
  browsedPlaylist.value = null;
  listFaceOpen.value = true;
}

// A lone playback — a tree track, stream, search hit, external file, or idle
// play — is bare continuation: the track (its album under the hood) becomes the
// whole story. It dismisses any open queue/playlist entirely, so the pane is the
// hero alone with no nav bar. Distinct from showHeroFace (the nav bar's flip),
// which keeps the queue. Callers repoint the engine themselves (playFile /
// playStream / …), so dropping the queue here is state-only.
export function resetToLonePlayback(): void {
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
export const queuePlayingIndex = signal<number | null>(null);

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
export const shuffleMode = signal(false);
export const repeatMode = signal<RepeatMode>("off");

// Autoadvance: when a track ends, does playback flow on to the next one? A single
// global, persistent preference (not a per-play choice), set from the OS Playback
// menu, never the app UI. Defaults on, matching what a media player is expected to
// do. When off, the engine is only ever handed the current track (never its tail),
// so gapless prep has nothing to advance into and handleEnded stops at each
// track's end. See applyAutoadvance.
export const autoadvance = signal(true);

// Whether playback flows to the next track. One global setting now — no context
// branching. Read at each advancement point and each engine hand-off.
export function autoadvanceEnabled(): boolean {
  return autoadvance.value;
}
// Whether a library root has been configured at all. When false the whole Files
// panel is replaced by a get-started prompt (see the files-empty effect) rather
// than showing an empty lens springboard the user can't do anything with.
export const libraryRootSet = signal(false);
export const streamListPathValid = signal(true);
// Whether a stream list path has been configured. When false the Streams panel is
// replaced by the same get-started prompt (see the streams-empty effect).
export const streamListPathSet = signal(false);
// Whether the current stream list can be written to — true only for a valid
// local file (a remote http(s) list is read-only here). Gates the Add-station
// button: adding appends to the file, which a remote list has no path for.
export const streamListWritable = signal(false);
// Whether the file tree has at least one top-level entry to start from. Drives
// the idle play button: with content, an idle play "starts the library" (plays
// the first entry) instead of sitting disabled, so the button reads ready-to-go.
export const libraryHasContent = signal(false);

export const treeSelection = signal<Set<string>>(new Set());

export const paneEditor = signal<"metadata" | "stream" | null>(null);
