// Reactive renderer state: the signals the UI derives from, plus the small
// pure-signal helpers that read/mutate them. Extracted from main.ts so every
// feature module can import state without importing main.ts.
//
// Keep this dependency-light (only types + the signal lib): it must never import
// a feature module, or import cycles become easy to introduce. State that needs
// feature functions (paneView, queueIsActivePool) deliberately stays in main.ts.

import { signal, computed } from "@preact/signals-core";
import type { Store } from "@tauri-apps/plugin-store";
import type {
  Queue,
  RepeatMode,
  ReplayGainMode,
  TreeNode,
  Stream,
  SearchTrack,
  RecentItem,
  PlaylistRef,
} from "./types";

// --- Non-reactive plumbing state ---
//
// The reassigned module-level `let`s that aren't reactive — "the current value,
// no re-render on change". They live as fields on one shared object so any
// feature module can read AND write them (`app.currentParent = ...`) without the
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
  // The security-scoped bookmark for each library root, base64, keyed by the root
  // path. Sandboxed, this — not the path — is what survives a relaunch; see
  // src-tauri/src/root_access.rs. Sparse: a root reachable without one (~/Music
  // via its entitlement, or any path at all when unsandboxed) has no entry.
  rootBookmarks: Record<string, string>;
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
  recentItems: RecentItem[];
  playlistIndex: PlaylistRef[];
  // Whether the playlist index has completed its first build (distinguishes a
  // genuinely empty library from "not walked yet" so the navigator can show a
  // "Loading..." line until the initial walk lands rather than a false "No playlists").
  playlistIndexLoaded: boolean;
  // The leaf list currently shown in the navigator (maps the nav selection back
  // to rows by view index).
  navLeafTracks: SearchTrack[];
  // The synthetic pool path (ctx.syntheticPath) of that leaf list. The now-playing
  // accent lights a leaf row when this equals the live pool (currentPoolPath)
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

// The audible pool's *identity*, as a signal. `app.currentParent` itself stays a
// plain field — the playback paths read it constantly and must not subscribe — but
// its setter mirrors the path here, so an effect can depend on "which pool is
// feeding playback" without polling. Needed because a pool change doesn't always
// move the track: replaying the song you're already hearing from a different list
// leaves currentNodePath untouched, and the highlight would otherwise never
// repaint (see the navigator leaf-row effect). Never assign this directly —
// writing app.currentParent keeps the two in step.
export const currentPoolPath = signal<string | null>(null);

// Backing field for the app.currentParent accessor below.
let currentParentNode: TreeNode | null = null;

// Backing signals for the two "the engine is holding nothing" flags. Both stay
// plain fields on `app` — the playback paths write them on every track change and
// read them constantly, and must not drag subscriptions along — but their setters
// mirror here so a gate can react to them. The getters peek, so reading
// app.queueEnded inside an effect subscribes to nothing.
const queueEndedSignal = signal(false);
const pendingResumeSignal = signal<{ time: number } | null>(null);

// Whether the engine has a pool loaded that it hasn't drained — i.e. whether
// currentNodePath names a file the decode thread may still have open. The two
// false cases both leave a playhead standing with no engine behind it:
//   drained    playback ran to the end. The handles are dropped, but folder
//              continuation deliberately keeps its row highlighted so play
//              resumes the finished track (see stopAtQueueEnd).
//   armed      a session restored but never played, or a queue built at rest.
// This is the renderer's mirror of the backend's queue_exhausted, which empties
// held_paths_of for exactly the same reason.
export const enginePoolLive = computed(
  () => !queueEndedSignal.value && pendingResumeSignal.value == null,
);

export const app: AppState = {
  store: undefined as unknown as Store, // assigned in init(), like the old `let`
  rootNode: null,
  libraryRoots: [],
  rootBookmarks: {},
  invalidLibraryRoots: new Set<string>(),
  selectionAnchor: null,
  lastSelectionPane: null,
  allStreams: [],
  currentStreamName: null,
  get currentParent(): TreeNode | null {
    return currentParentNode;
  },
  set currentParent(node: TreeNode | null) {
    currentParentNode = node;
    // Same path, new node object (a rescan re-binding the same folder, or a leaf
    // list replayed from itself) is not a pool change: the signal's own equality
    // check drops it, so no highlight repaint is triggered.
    currentPoolPath.value = node?.path ?? null;
  },
  artRequestId: 0,
  lastQueue: [],
  lastIndex: 0,
  pendingQueueIndex: null,
  get queueEnded(): boolean {
    return queueEndedSignal.peek();
  },
  set queueEnded(ended: boolean) {
    queueEndedSignal.value = ended;
  },
  shuffleBag: [],
  shuffleHistory: [],
  lastPlaybackPush: 0,
  pendingQueueScrollIndex: null,
  recentItems: [],
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
  get pendingResume(): { time: number } | null {
    return pendingResumeSignal.peek();
  },
  set pendingResume(resume: { time: number } | null) {
    pendingResumeSignal.value = resume;
  },
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

// The track playback is waiting on a download for, or null. A cloud file that
// isn't on this Mac can't be decoded until the provider hands it over, which
// takes as long as it takes (~37s for an 8 MB track on a slow provider); the
// decode thread refuses to block on that, so this is what the wait looks like
// from the outside. One path at a time: the engine parks on exactly one track.
export const fetchingPath = signal<string | null>(null);

// Paths whose bytes came down during this session.
//
// Every "(Not downloaded)" the UI can draw comes from a boolean copied off the
// scan cache when the row was built — into a tree node, a queue row, a playlist
// row, a nav list — and a download that finishes an hour later reaches none of
// those copies. Read *through* this set (see rowStatus), any copy comes out
// right: it is the later fact about the same path, so it wins.
//
// Most of the copies are patched directly and the cache row behind them is
// rewritten (see applyDownloaded, and the backend's reindex_downloaded). This
// covers the ones neither reaches — a library view list memoized before the
// download, and any row later built from it.
// Deliberately not a signal: nothing repaints off it. A row already on screen is
// repainted by the patch that fills in the rest of its fields, and every row built
// after that reads this as it is built.
//
// Known limitation: add-only, for the life of the session. A file the OS evicts
// back to the cloud *after* we downloaded it keeps its downloaded status until
// relaunch — the scan notices the re-eviction and corrects the cache row (see the
// `was_dataless != dataless` refresh), but this set is read last and wins, so the
// "(Not downloaded)" marker cannot come back. Accepted: eviction of a file played
// this session is rare, and the cost is a missing marker on a file that still
// plays, after a wait. The fix would be to drop the path here on that refresh.
export const downloadedPaths = new Set<string>();

// Whether a track is still cloud-only *right now*: the row's own flag, corrected
// by the set above. The one place both readers agree — the "(Not downloaded)"
// marker (rowStatus) and the greyed-out "Edit metadata..." (editMetadataItem),
// which must match, since the marker is the whole explanation for the grey.
export function isNotDownloaded(t: { path: string; notDownloaded?: boolean }): boolean {
  return !!t.notDownloaded && !downloadedPaths.has(t.path);
}

// Whether a row can go in the engine's pool. Two things keep it out, and every
// list that builds a pool — or steps through one with the arrow keys, or selects
// rows to act on — means this rather than `missing` alone:
//   missing  a playlist row whose file is gone. Kept in the view (marked) so the
//            file round-trips, never handed to the engine, so gapless can't stall
//            on a dangling path.
//   stream   a playlist row naming a station. A real row of the file, but the
//            engine's queue holds decodable file paths and a station is its own
//            command (playStream) with no end and no duration — see playlists.ts.
// `notDownloaded` deliberately isn't here: that file plays, after a wait.
export function isPlayableRow(t: { missing?: boolean; stream?: boolean }): boolean {
  return !t.missing && !t.stream;
}

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
// The Licenses panel: the third full-pane member of the Settings/About family
// (same Back button, mutually exclusive with them). Opened from Help → Licenses.
// Its contents are fetched on first open rather than bundled — see
// renderLicenses in src/main.ts.
export const licensesOpen = signal(false);
// The Equalizer panel is another right-pane takeover in the Settings/About
// family (same Back button, mutually exclusive with them). Opened from
// Playback → Equalizer (⌥⌘E).
export const equalizerOpen = signal(false);
// The Now Playing hero renders one of two views, a persisted set-once
// preference toggled from View ▸ Visualizer (⌘T) or the topbar viz button: the
// album-art card ("art") or the MilkDrop visualizer ("visualizer"). The menu
// item is a single on/off checkbox mirroring the button. Unlike Settings/About,
// the visualizer is
// NOT a pane takeover — it's an alternate face of the hero, so the transport
// controls and nav bar stay put beneath it.
export type NowPlayingView = "art" | "visualizer";
export const nowPlayingView = signal<NowPlayingView>("art");

// Zen Mode: the now-playing hero covers the window (all chrome — topbar, left
// panel, splitter — hidden), controls auto-hide on idle. Named for what you get
// (an immersive player) rather than the chrome it hides. Not a native window
// fullscreen — it composes with one rather than replacing it. Transient (never
// persisted); only meaningful while the hero face is up. Toggled from
// View ▸ Zen Mode (⌘⇧F) or Escape.
export const zenMode = signal(false);

// Dismiss the full-pane panels (Settings / About / Licenses) that take the whole pane over,
// transport included — so a gesture whose result lives in the pane isn't left
// hidden behind one. The Equalizer is deliberately spared: it's a face of the
// now-playing panel that coexists with the transport (you tune while listening),
// so playing or skipping a track keeps it up rather than snapping to Now Playing.
// Called from the pure-playback gestures (play, manual skip). Deliberately NOT
// called on autoadvance or on shuffle/repeat toggles: those leave any panel up.
// Idempotent.
export function dismissFullPanels(): void {
  settingsOpen.value = false;
  aboutOpen.value = false;
  licensesOpen.value = false;
}

// dismissFullPanels plus the Equalizer face — for gestures that reveal the list
// or editor face, both of which `.show-eq` would otherwise cover. Idempotent.
export function dismissRightPanel(): void {
  dismissFullPanels();
  equalizerOpen.value = false;
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

// A playlist opened for *browsing* only — single-click in the tree, OS Open... /
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

// The open playlist file the OS menu acts on (Move Playlist File...): the one
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
// playStream / ...), so dropping the queue here is state-only.
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

// ReplayGain (volume normalization) mode. A global, persistent preference set from
// the Playback menu (never the app UI), defaulting off. Pushed to the engine, which
// reads each track's REPLAYGAIN_* tags as it opens it; untagged files play unchanged.
export const replayGainMode = signal<ReplayGainMode>("off");

// Whether the output device follows the sample rate of the file being played,
// instead of resampling everything to the rate the device is set to. A global,
// persistent preference set from the Playback menu (never the app UI). Defaults
// OFF, unlike the other playback settings: the device's rate is a system-wide
// setting shared with every other app, and changing it costs a short silence
// between two tracks that don't share a rate. The engine reads it as it opens
// each track when enabled. Disabling also restores the device's prior rate when
// it has not subsequently been changed outside Pudding.
export const followSampleRate = signal(false);

// Whether playback flows to the next track. One global setting now — no context
// branching. Read at each advancement point and each engine hand-off.
export function autoadvanceEnabled(): boolean {
  return autoadvance.value;
}
// Whether a library root has been configured at all. When false the Files panel
// shows its setup prompt while the bundled sample previews in Now Playing, rather
// than showing an empty view springboard the user can't do anything with.
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
// Also part of the Files empty-state condition — but only once libraryTreeLoaded
// says the answer is real. See that signal.
export const libraryHasContent = signal(false);
// Whether the tree has finished its first (or latest) build — false for the
// window between refreshTree clearing the old answer and the listing coming back.
// Without this empty-state UI would flash on every boot and every library change:
// libraryRootSet and libraryHasContent are both false mid-refresh, which is
// indistinguishable from "no library" unless something says "not known yet".
export const libraryTreeLoaded = signal(false);

export const treeSelection = signal<Set<string>>(new Set());

export const paneEditor = signal<"metadata" | "stream" | null>(null);
