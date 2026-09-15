// Shared type/interface definitions for the renderer.
//
// Extracted from main.ts so feature modules (and library-nav.ts) can import
// types without importing main.ts itself — killing the old main->types coupling.
// Types only: no runtime values, no imports beyond the signal type.

import type { Signal } from "@preact/signals-core";

// Does double duty (matching the Rust struct): a row of a browse listing, and the
// tag set the metadata editor is seeded from and hands back. The column fields are
// populated only on the listing path — the editor deals in the six above them — so
// they are optional here, and an editor response leaves them undefined rather than
// null. write_tags is the one exception: it returns `modified`, because writing tags
// rewrites the file and every open row's Date Modified goes stale.
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
  year?: number | null;
  genre?: string | null;
  duration?: number | null;
  bitrate?: number | null;
  sampleRate?: number | null;
  bitDepth?: number | null;
  gain?: number | null;
  created?: number | null;
  modified?: number | null;
  // The scan cache's dataless flag, carried through the browse listing so a
  // cloud file reads the same in the Files tree as it does in a playlist. See
  // SearchTrack.notDownloaded.
  notDownloaded?: boolean;
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
  // Column fields, carried but never drawn by the tree itself: a track played or
  // queued from here becomes a row in a pane that does draw them (see nodeToTrack).
  // All absent on a folder or playlist node.
  year?: number | null;
  genre?: string | null;
  duration?: number | null;
  bitrate?: number | null;
  sampleRate?: number | null;
  bitDepth?: number | null;
  gain?: number | null;
  created?: number | null;
  modified?: number | null;
  notDownloaded?: boolean;
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
  // Raw ALBUMARTIST tag (nullable), mirroring FileEntry/TreeNode; combined as
  // albumArtist ?? artist to form the album grouping key for "go to album" from
  // the now-playing line and the row menu. Threaded end to end so a compilation
  // (album artist ≠ track artist) resolves to the right album detail.
  albumArtist: string | null;
  // The file's metadata track number, carried only where a within-album ordinal
  // is meaningful (album_tracks) so the gutter can show the real number like the
  // browse tree; null for flat lists (Songs, search), which show a positional
  // index instead. See renderLeafTrackList.
  track?: number | null;
  // Set only for playlist browse rows whose file is absent on disk: shown in the
  // view (marked, per the plan's "keep the row") but never handed to the engine.
  missing?: boolean;
  // A cloud file the provider hasn't downloaded yet. Marked like `missing` but
  // NOT filtered out of what the engine gets: the file is real and playing it
  // fetches it (see audio.rs). The marker is a warning about what the click
  // costs, not a statement that the row is unplayable.
  notDownloaded?: boolean;
  // Track length in seconds (absent/null when unknown). Summed to display a total
  // runtime beside a queue/playlist's track count, and drawn per-row by the Time
  // column when the pane shows one.
  duration?: number | null;

  // --- column fields ---
  //
  // Everything below exists to be drawn by the column table (see columns.ts) and
  // nothing else reads it. All optional and all nullable, and the two mean the same
  // thing to a cell — it draws blank — but they differ in provenance: absent means
  // this row came from a path that never carries the field (an out-of-library
  // playlist entry, a synthesized row), null means the file was scanned and the
  // field wasn't there. Neither is a value, so both sort to the bottom (see isBlank).
  //
  // The metadata disc number. Its sibling `track` above is carried only where a
  // within-album ordinal is meaningful, because the gutter draws that one; nothing
  // draws disc, so it is carried everywhere.
  disc?: number | null;
  year?: number | null;
  genre?: string | null;
  // kbps, from the file's audio properties rather than a tag — so, like Kind, it is
  // present even on a file with no tags at all.
  bitrate?: number | null;
  // The other two audio-property facts: the rate the audio is at, and the bits per
  // sample. Bit depth is absent on lossy formats, which have none — a blank cell
  // there is itself the answer, the same way a blank Gain cell is.
  sampleRate?: number | null;
  bitDepth?: number | null;
  // REPLAYGAIN_TRACK_GAIN in dB exactly as the file states it, NOT the multiplier
  // playback applies (the engine re-reads the tags and does its own clip-safe math).
  // A blank cell is a file the ReplayGain setting cannot act on.
  gain?: number | null;
  // Unix seconds. `created` is the file's birth time, `modified` its mtime. Both are
  // facts about the file rather than library bookkeeping, which Pudding does not keep
  // — so they survive a cache wipe, and they stay true if the user reorganizes
  // outside the app. Prefer created for "what did I just add": editing tags through
  // Pudding rewrites the file and bumps modified.
  created?: number | null;
  modified?: number | null;
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
  title: string; // header line: the queue/playlist name (artist, album, folder...)
  subtitle: string | null; // always a track count
  tracks: SearchTrack[];
  // For a playlist source (kind === "playlist"): the `.m3u8` file path. Lets the
  // OS menu act on the open playlist (Move Playlist File...). Absent for ephemeral
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

// ReplayGain (volume normalization) mode: off, or normalize per track / per album
// from the file's REPLAYGAIN_* tags. A global, persistent preference set from the
// Playback menu; the engine applies it as each track is opened.
export type ReplayGainMode = "off" | "track" | "album";

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

// The declarative description of a row's context menu. A leaf item runs an
// action; a `submenu` item opens a flyout (used by "Add to playlist ▸"). The OS
// draws it — see context-menu.ts, which maps this onto a native menu — so the
// look, the flyouts, and dismissal on an outside press, Escape, or scroll are
// AppKit's, not ours.
export type ContextMenuItem =
  // `checked` makes the item a native check item, so a menu can carry toggles —
  // the Columns picker — beside ordinary verbs. `disabled` greys the item and
  // swallows the click, for a toggle that is on but not the user's to turn off
  // (the Title column). Clicking any item dismisses the menu: a native menu
  // can't be held open across a run of toggles, so ticking four columns is four
  // right-clicks.
  | {
      label: string;
      action: () => void;
      checked?: boolean;
      disabled?: boolean;
    }
  // A submenu may be a thunk, so a level that shows live state (checkmarks) is
  // built against that state at the moment the menu is raised. No `checked`
  // here: the native payload infers a check item from that field and would drop
  // the submenu (see NativeItem in context-menu.ts).
  | {
      label: string;
      submenu: ContextMenuItem[] | (() => ContextMenuItem[]);
      disabled?: boolean;
    }
  // A horizontal rule between groups. Carries no label and no behavior.
  | { separator: true };

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
  // When set, the field gets a trailing "Choose..." button; it resolves to a value
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
  year: number | null;
  genre: string | null;
  inLibrary: boolean;
  missing: boolean;
  notDownloaded: boolean;
  // Seconds. The library's cached value for a known path; for an out-of-library
  // row, the playlist file's own `#EXTINF` claim — unverified, but the only
  // runtime that row will ever have.
  duration: number | null;
  // The remaining column fields. All null for an out-of-library row: they come from
  // the scan cache, and a path outside every library root was never scanned. See
  // `inLibrary`, which is the row's own account of why its cells are empty.
  bitrate: number | null;
  sampleRate: number | null;
  bitDepth: number | null;
  gain: number | null;
  created: number | null;
  modified: number | null;
}

export interface PlaylistData {
  name: string;
  path: string;
  tracks: PlaylistTrack[];
  // The file's mtime at the moment of this read, or null if it vanished. Kept by
  // the mtime registry in queue.ts so an open playlist can tell an outside edit
  // from one of our own saves. See notePlaylistMtime.
  mtime: number | null;
}

// What writePlaylist needs from a row: where the file is, plus the `#EXTINF`
// facts to fall back on when the library has never scanned it. Both SearchTrack
// and PlaylistTrack satisfy it, so the queue, the open pane, and a file we just
// read can all be written back without a conversion step.
export interface PlaylistWriteRow {
  path: string;
  title?: string | null;
  duration?: number | null;
}

// A row of the Open Recent submenu. The list is mixed: `kind` says whether the
// path is a playlist (opening browses it) or a loose audio file (opening plays
// it), which picks the row's icon and its open verb. Optional so entries stored
// before tracks joined the list still parse — see hydrateRecentItems.
export type RecentKind = "playlist" | "track";

export interface RecentItem {
  path: string;
  name: string;
  kind?: RecentKind;
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
  // Suppress the album in each row's dimmed suffix even when it varies. The artist
  // detail view sets this (its Tracks list is ordered album by album, so the album
  // repeats in runs, and its Albums section already enumerates them); the Songs view
  // sets it too, to stay a lean title · artist list once you've skipped Albums.
  // Default (unset) keeps the fieldVaries rule.
  hideAlbum?: boolean;
}

// One library root as `hold_library_roots` reports it back, after the backend has
// taken (and kept) the sandbox grant for it. `path` is where the folder actually
// is — a bookmark follows a folder the user moved, so it can differ from what was
// stored. `bookmark` is a blob to write down, and null means "keep the stored one"
// rather than "drop it". `error` is advisory: the root stays configured and simply
// fails to list, exactly like a folder that went missing.
export interface HeldRoot {
  path: string;
  bookmark: string | null;
  error: string | null;
}
