// Shared type/interface definitions for the renderer.
//
// Extracted from main.ts so feature modules (and library-nav.ts) can import
// types without importing main.ts itself — killing the old main->types coupling.
// Types only: no runtime values, no imports beyond the signal type.

import type { Signal } from "@preact/signals-core";

export interface FileEntry {
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

export interface TrackMeta {
  title: string | null;
  artist: string | null;
  album: string | null;
}

export interface DirListing {
  folders: string[];
  files: FileEntry[];
  playlists: PlaylistListing[];
}

// A .m3u/.m3u8 in a folder: `file` is the basename (joined to the parent path),
// `name` the display name (#PLAYLIST: directive or filename stem).
export interface PlaylistListing {
  file: string;
  name: string;
}

export interface TreeNode {
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

export interface Stream {
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

export interface SearchFolder {
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
export type SearchItem =
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

export interface Queue {
  kind: QueueKind;
  title: string; // header line: the queue/playlist name (artist, album, folder…)
  subtitle: string | null; // always a track count
  tracks: SearchTrack[];
  // For a playlist source (kind === "playlist"): the `.m3u8` file path. Lets the
  // OS menu act on the open playlist (Move Playlist File…). Absent for ephemeral
  // queues and other sources.
  sourcePath?: string;
  // Curation-undo identity for an *ephemeral* queue (which has no sourcePath to key
  // its history by). Stamped lazily on the first curation and carried forward by the
  // `{...list}` spread every edit makes, so one queue's undo stack stays distinct
  // from the next's. Playlists key their history by sourcePath instead. See
  // curation history in queue.ts.
  historyId?: string;
}

export interface ScanResult {
  ok: boolean;
  error: string | null;
}

// Progress for the scan-status footer: `total` is the full audio-file count (known
// once the walk finishes), `done` how many have been reconciled. Carried by the
// "scan-started" (done 0) and "scan-progress" events.
export interface ScanProgress {
  done: number;
  total: number;
}

export type RepeatMode = "off" | "all" | "one";

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
export interface TrackSelection {
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

// Lightweight cursor-positioned context menu for tree rows. Styled like the
// search dropdown (dark lifted surface). A leaf item runs an action; a `submenu`
// item opens a flyout to the right on hover (used by "Add to playlist ▸").
// Dismisses on any outside press, Escape, scroll, or resize.
export type ContextMenuItem =
  | { label: string; action: () => void }
  | { label: string; submenu: ContextMenuItem[] };

// A reusable field editor: a small stacked form of labeled text inputs plus
// Cancel/Save. Both callers mount it in the right-pane editor face (track
// metadata, stream add/edit — see openPaneEditor). Kept generic — the caller
// supplies the fields and what Save does — so they share one look and one set of
// behaviors (Enter submits, Esc cancels, Save disabled until the required fields
// are filled). Returns the <form> element for
// the caller to insert; `onCancel` fires on Esc or the Cancel button.
export interface InlineEditorField {
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

export interface InlineEditorOptions {
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

export type DragPayload =
  | { kind: "reorder"; tracks: SearchTrack[] }
  | { kind: "tracks"; tracks: SearchTrack[] }
  // Reorder a station within the (writable, local) stream list. Carries the
  // dragged Stream; its live index is resolved at drop time against allStreams.
  | { kind: "stream"; stream: Stream };

export interface ActiveDrag {
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

// The nav bar above the transport. It swaps the two faces and names the source:
// on the list face the button returns to the hero ("Now Playing"), on the hero
// face it reveals the list ("Show Queue" / "Show Playlist"). A null button is
// hidden. An idle browse (a playlist open, nothing playing) has neither a source
// to name nor a face to flip to, so the whole bar drops out (null nav) rather
// than sitting empty — the list face keeps the pane.
export interface NavState {
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
export interface PaneView {
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

// One resolved row from read_playlist. `missing` rows are kept for round-trip
// but filtered out of what's handed to the engine (so gapless never stalls).
export interface PlaylistTrack {
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

export interface PlaylistData {
  name: string;
  path: string;
  tracks: PlaylistTrack[];
}

export interface RecentPlaylist {
  path: string;
  name: string;
}

export interface PlaylistRef {
  path: string;
  name: string;
}

export type TrackProvider = () => SearchTrack[] | Promise<SearchTrack[]>;

export interface LeafListContext {
  // Now-playing pool title (the synthetic parent's name) when a row is played.
  title: string;
  // Synthetic pool path; its `queue:` prefix marks the pool as a queue
  // (queueIsActivePool) so play-after-end restarts from the top and a rescan won't
  // re-bind it to a folder. Autoadvance is global now, so the prefix no longer
  // picks a context.
  syntheticPath: string;
}
