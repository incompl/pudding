mod audio;
// pub so examples/sandbox_check.rs can link it: the only honest test of a
// security-scoped bookmark runs inside a signed, sandboxed .app, which means a
// separate binary. See tools/sandbox-check.sh.
pub mod bookmarks;
// Cloud files that are not on disk yet, and which threads are allowed to wait
// for one. Read it before touching the scanner's or the decode thread's I/O.
mod dataless;
mod icy;
mod now_playing;
mod output_device;
mod playlist;
// Who holds the sandbox grant for each library root, and for how long. The
// primitive it drives is bookmarks.rs; pub for the same reason bookmarks is —
// examples/sandbox_check.rs drives this exact code inside a real sandbox.
pub mod root_access;

use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, UNIX_EPOCH};

use base64::Engine;
use lofty::prelude::*;
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use notify_debouncer_full::{new_debouncer, DebounceEventResult, Debouncer, FileIdMap};
use rusqlite::{params, params_from_iter, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::menu::{
    CheckMenuItem, CheckMenuItemBuilder, MenuBuilder, MenuItem, MenuItemBuilder,
    PredefinedMenuItem, Submenu, SubmenuBuilder,
};
use tauri::{AppHandle, Emitter, Manager, State, Wry};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_log::{Target, TargetKind};
use tauri_plugin_opener::OpenerExt;

const DB_FILE: &str = "metadata.db";
// Default stream list seeded on first run, alongside the library DB in the app
// data dir. Created empty (header only) so the Streams panel starts as a valid,
// empty list rather than an unconfigured dead-end; the path stays an editable
// setting so the user can repoint it at a curated file elsewhere.
const DEFAULT_STREAM_LIST_FILE: &str = "streams.m3u8";

// Identifies the app on every outbound HTTP request: stream list and station-art
// fetches here, plus the ICY stream connection in the icy module. Public
// directories like radio-browser.info ask clients to send a descriptive
// User-Agent and may throttle generic ones; the version tracks Cargo.toml.
pub const USER_AGENT: &str = concat!("pudding/", env!("CARGO_PKG_VERSION"));

struct DbHandle {
    // The single writer connection everything outside a scan writes through —
    // write_tags and reindex_downloaded today. SQLite allows one writer at a
    // time, so those serialize through this mutex, and WAL keeps the write from
    // blocking readers.
    //
    // A scan is not among them: run_scan opens its own connection (see there) and
    // never touches this mutex. It holds one transaction across the entire
    // library walk instead, so a command write that lands mid-scan serializes
    // down at the SQLite level, where it waits out busy_timeout (5 s) and then
    // fails rather than queueing behind the walk.
    conn: Arc<Mutex<Connection>>,
    // Pool of read-only connections for the query commands. Reads run off the UI
    // thread (spawn_blocking) each on their own connection instead of contending on
    // the writer mutex, so concurrent reads (e.g. the two library roots listed at
    // startup) run in parallel and never wait on a background scan. See ReadPool.
    readers: Arc<ReadPool>,
    path: PathBuf,
}

// Holds the recursive filesystem watchers — one per configured library root.
// The whole set is replaced (old debouncers dropped, which stops their threads)
// whenever the roots change; empty when no library roots are set.
struct WatcherState {
    inner: Mutex<Vec<Debouncer<RecommendedWatcher, FileIdMap>>>,
}

// Handles to the Playback menu's checkboxes. The frontend owns the authoritative
// settings (persisted in its store and used to drive playback); these handles let
// it sync the checkmarks to the persisted values at startup. The checkboxes
// auto-toggle on click, and the on_menu_event handler emits the new state back to
// the frontend.
struct PlaybackMenu {
    // The single global "Autoadvance" checkbox (set_autoadvance_checked).
    autoadvance: CheckMenuItem<Wry>,
    // Shuffle, the three Repeat modes (radio-style: only one checked), and Mute
    // are checkmarks the frontend keeps in sync as its own state changes (from the
    // toolbar or the menu).
    shuffle: CheckMenuItem<Wry>,
    repeat_off: CheckMenuItem<Wry>,
    repeat_all: CheckMenuItem<Wry>,
    repeat_one: CheckMenuItem<Wry>,
    mute: CheckMenuItem<Wry>,
    // ReplayGain (volume normalization): three radio-style items, only one
    // checked ("off"/"track"/"album"), synced from the frontend like Repeat.
    rg_off: CheckMenuItem<Wry>,
    rg_track: CheckMenuItem<Wry>,
    rg_album: CheckMenuItem<Wry>,
    // "Match Source Sample Rate" (set_follow_sample_rate_checked). Off
    // by default, unlike the rest: it reconfigures a system-wide device setting.
    follow_sample_rate: CheckMenuItem<Wry>,
}

// The Window menu's "Mini Player" checkbox. The frontend derives mini mode from
// the viewport height, so it keeps this checkmark in sync (set_miniplayer_checked)
// on startup and on every resize.
struct WindowMenu {
    miniplayer: CheckMenuItem<Wry>,
}

// The View ▸ Visualizer toggle (album art when off, MilkDrop visualizer when on).
// A single checkable item that mirrors the topbar viz button's on/off state; the
// frontend owns the persisted preference and keeps the checkmark in sync
// (set_now_playing_view_checked). zen_mode is the checkable View ▸ Zen Mode
// toggle, kept in sync from the frontend (set_zen_mode_checked) since ⌘⇧F and
// Escape also flip it.
struct ViewMenu {
    np_view_visualizer: CheckMenuItem<Wry>,
    zen_mode: CheckMenuItem<Wry>,
}

// Handles into the Playlist menu that the frontend keeps in sync: the "Save as
// Playlist" item is enabled only while an ephemeral queue is the active pool
// (set_save_playlist_enabled), "Move Playlist File..." is enabled only while a
// playlist is open — browsed or playing (set_move_playlist_enabled) — and the
// "Open Recent" submenu is rebuilt from the frontend's persisted recents list
// (set_recent_items).
struct PlaylistMenu {
    save_as: MenuItem<Wry>,
    move_file: MenuItem<Wry>,
    recent: Submenu<Wry>,
}

// The Edit menu's Undo/Redo. One item each, owning ⌘Z / ⌘⇧Z, that the frontend
// routes by focus (like the macOS responder chain does natively): editing text →
// the web view's own text undo (document.execCommand), otherwise → *curation* undo
// (playlist / queue reorder-remove-drag-in). Enabled whenever either applies
// (set_edit_undo_state) — replacing the predefined .undo()/.redo(), whose selector
// is what would otherwise power text undo, so the frontend must supply it instead.
struct EditMenu {
    undo: MenuItem<Wry>,
    redo: MenuItem<Wry>,
}

// The two Open Recent row glyphs as PNG bytes, keyed by RecentItem::kind. The
// frontend rasterizes them from the app's own CSS icons and hands them over at
// boot (set_recent_icons), so the menu and the track/playlist rows in the tree
// can never show two different drawings of the same thing. Empty until then,
// which only costs the rows their icons.
#[derive(Default)]
struct RecentIcons {
    png: Mutex<HashMap<String, Vec<u8>>>,
}

// One entry the frontend hands set_recent_items to rebuild the Open Recent
// submenu (most-recent first). `kind` is "playlist" or "track" and only picks the
// row's icon — the click relays the path and the frontend re-derives the verb from
// the extension, so an absent/unknown kind is cosmetic, never wrong behavior.
#[derive(Deserialize)]
struct RecentItem {
    path: String,
    name: String,
    kind: Option<String>,
}

// Does double duty: a row of a browse listing (where the column fields below are
// populated) and what write_tags hands back after a save (where the eight cached
// tag fields, plus `modified`, are). Default exists for that second use, so the
// write path says what it isn't filling in rather than listing the Nones. The
// editor is *seeded* from EditorTags, not from this — the two sets only overlap.
#[derive(Serialize, Default)]
struct FileEntry {
    name: String,
    title: Option<String>,
    artist: Option<String>,
    album: Option<String>,
    // Raw ALBUMARTIST tag (None when untagged). The frontend forms the album
    // grouping key as albumArtist ?? artist — see album_tracks below — so a
    // track row carries what "go to album" needs without a DB round trip.
    #[serde(rename = "albumArtist")]
    album_artist: Option<String>,
    disc: Option<u32>,
    track: Option<u32>,
    // The column fields. The browse tree draws none of them — it shows title and a
    // dimmed artist/album suffix — but a track queued or played *from* the tree
    // becomes a row in a pane that does, so dropping them here would make the same
    // file read blank in the queue and filled in the Songs list. fetch_meta already
    // reads them, and a folder listing is bounded by one folder rather than by the
    // library, so carrying them costs a little JSON on a small payload.
    year: Option<u32>,
    genre: Option<String>,
    duration: Option<f64>,
    bitrate: Option<u32>,
    // The other two audio-property facts, alongside `bitrate`: the rate the audio
    // is actually at, and how many bits each sample carries. Lossy formats have no
    // meaningful bit depth, so that one stays None for MP3/AAC — a blank cell that
    // says "lossy" as plainly as a number could.
    #[serde(rename = "sampleRate")]
    sample_rate: Option<u32>,
    #[serde(rename = "bitDepth")]
    bit_depth: Option<u32>,
    gain: Option<f64>,
    created: Option<i64>,
    modified: Option<i64>,
    // The file's bytes were not on this Mac at scan time. Shown as a
    // "(Not downloaded)" row marker, in the same slot as "(Missing file)" — but
    // unlike missing, the row stays playable: clicking it fetches the file.
    #[serde(rename = "notDownloaded")]
    not_downloaded: bool,
}

#[derive(Serialize)]
struct TrackMeta {
    title: Option<String>,
    artist: Option<String>,
    album: Option<String>,
}

// Holds a file path passed at launch (CLI arg on Win/Linux, Apple Event on macOS)
// until the frontend has registered its open-file listener and asks for it.
// `ready` and `path` share one mutex so deliver_open_file's decision (emit vs.
// queue) and frontend_ready's drain cannot interleave across threads.
#[derive(Default)]
struct PendingState {
    ready: bool,
    path: Option<String>,
}

struct PendingOpen {
    inner: Mutex<PendingState>,
}

#[derive(Serialize)]
struct DirListing {
    folders: Vec<String>,
    files: Vec<FileEntry>,
    // Playlists in this folder, sorted after all tracks (see list_dir). `file`
    // is the basename (the frontend joins it to the parent path); `name` is the
    // display name (#PLAYLIST: directive or filename stem).
    playlists: Vec<PlaylistListing>,
}

#[derive(Serialize)]
struct PlaylistListing {
    file: String,
    name: String,
}

// A stream list as read: the stations plus the mtime the file carried when we
// read it. That stamp is what the index-addressed edits compare against before
// they touch a station — see check_stream_stamp. None for a remote list (nothing
// to stat, and remote lists are read-only anyway).
#[derive(Serialize)]
struct StreamList {
    streams: Vec<Stream>,
    mtime: Option<i64>,
}

#[derive(Serialize)]
struct Stream {
    name: String,
    url: String,
    // Optional station art: an http(s) or file:// URL, from the #EXTINF
    // tvg-logo attribute.
    image: Option<String>,
}

#[derive(Serialize, Clone)]
struct ScanResult {
    ok: bool,
    error: Option<String>,
}

// Progress for the scan status footer. `total` is the whole audio-file count (known
// up front, after the walk); `done` is how many have been reconciled so far. Emitted
// as "scan-started" (done 0) then periodically as "scan-progress" during indexing.
#[derive(Serialize, Clone)]
struct ScanProgress {
    done: usize,
    total: usize,
}

#[derive(Serialize)]
struct SearchResult {
    path: String,
    title: Option<String>,
    artist: Option<String>,
    album: Option<String>,
    // The raw ALBUMARTIST tag (nullable) — carried per-track so "go to album" from
    // the now-playing line and the row menu resolves a compilation's album by its
    // real album artist. Combined as albumArtist ?? artist at the use site, matching
    // ALBUM_ARTIST_EXPR / FileEntry.albumArtist. Not ALBUM_ARTIST_EXPR here: the raw
    // column keeps the frontend convention (fall back to artist only when displaying).
    #[serde(rename = "albumArtist")]
    album_artist: Option<String>,
    // The file's metadata track number, populated only where a within-album
    // ordinal is meaningful (album_tracks). Left None for flat lists (the Songs
    // view, search results) whose gutter shows a positional index instead. The
    // browse tree renders the same metadata number; see main.ts renderLeafTrackList.
    track: Option<u32>,
    // The file's metadata disc number. Unlike `track` this is carried on every
    // list: no gutter shows it, so the column is the only place it can appear.
    disc: Option<u32>,
    year: Option<u32>,
    genre: Option<String>,
    // Track length in seconds (None when unknown). Summed per queue/playlist for
    // the runtime shown beside the track count; individual rows don't display it.
    duration: Option<f64>,
    // kbps, from the file's audio properties rather than a tag.
    bitrate: Option<u32>,
    // The other two audio-property facts, alongside `bitrate`: the rate the audio
    // is actually at, and how many bits each sample carries. Lossy formats have no
    // meaningful bit depth, so that one stays None for MP3/AAC — a blank cell that
    // says "lossy" as plainly as a number could.
    #[serde(rename = "sampleRate")]
    sample_rate: Option<u32>,
    #[serde(rename = "bitDepth")]
    bit_depth: Option<u32>,
    // REPLAYGAIN_TRACK_GAIN in dB as the file states it — see the schema comment
    // for why this is the raw tag and not the multiplier playback applies.
    gain: Option<f64>,
    // Unix seconds. `created` is the file's birth time and `modified` its mtime;
    // both are facts about the file, neither is library bookkeeping (Pudding keeps
    // no such thing — the cache is disposable and the files are the truth).
    created: Option<i64>,
    modified: Option<i64>,
    // See the `dataless` column: the file's bytes were not on this Mac when the
    // scan walked past it. Shown as a "(Not downloaded)" row marker in the same
    // slot as "(Missing file)" — but unlike missing, the row stays playable,
    // because clicking it is what fetches the file.
    #[serde(rename = "notDownloaded")]
    not_downloaded: bool,
}

// The SELECT list every track-producing query shares, and the mapping that reads a
// row of it. One list rather than six hand-maintained ones: a column added here
// reaches the browse tree, search, artist, album and playlist views at once, and a
// pane can't end up showing a field that is blank only because one query forgot it.
// Index-order coupling between the two lives in this one pair.
const TRACK_COLUMNS: &str = "path, title, artist, album, album_artist, disc, track, \
                             year, genre, duration, bitrate, sample_rate, bit_depth, \
                             rg_track_gain, created, mtime, dataless";

fn track_row(row: &rusqlite::Row) -> rusqlite::Result<SearchResult> {
    Ok(SearchResult {
        path: row.get(0)?,
        title: row.get(1)?,
        artist: row.get(2)?,
        album: row.get(3)?,
        album_artist: row.get(4)?,
        disc: row.get(5)?,
        track: row.get(6)?,
        year: row.get(7)?,
        genre: row.get(8)?,
        duration: row.get(9)?,
        bitrate: row.get(10)?,
        sample_rate: row.get(11)?,
        bit_depth: row.get(12)?,
        gain: row.get(13)?,
        created: row.get(14)?,
        modified: row.get(15)?,
        not_downloaded: row.get(16)?,
    })
}

// Columnar wire row for the whole-library Songs list. Serialized as a positional
// JSON array so the field names aren't repeated once per row — at the library-scale
// target that key repetition is a large share of the IPC + JSON.parse cost, and it
// is why this one list doesn't just send SearchResult like every other query.
//
// The field order is TRACK_COLUMNS minus `track` (always null for this flat list,
// whose gutter shows a positional index). Three things must move together: this
// tuple, the SELECT, and the frontend re-key in main.ts. See list_all_songs.
type SongRow = (
    String,         // path
    Option<String>, // title
    Option<String>, // artist
    Option<String>, // album
    Option<String>, // album_artist
    Option<u32>,    // disc
    Option<u32>,    // year
    Option<String>, // genre
    Option<f64>,    // duration
    Option<u32>,    // bitrate
    Option<u32>,    // sample_rate
    Option<u32>,    // bit_depth
    Option<f64>,    // rg_track_gain
    Option<i64>,    // created
    Option<i64>,    // mtime
    bool,           // dataless
);

#[derive(Serialize)]
struct FolderResult {
    path: String,
    name: String,
}

#[derive(Serialize)]
struct ArtistResult {
    name: String,
}

// An album is identified by its name plus its album artist — the standard
// grouping key mainstream players use. `artist` here is the *album* artist:
// the ALBUMARTIST tag when present, else the (single) track artist. This keeps
// a properly-tagged Various-Artists compilation as one album.
#[derive(Serialize)]
struct AlbumResult {
    album: String,
    artist: String,
}

fn join_path(parent: &str, child: &str) -> String {
    if parent.ends_with('/') {
        format!("{}{}", parent, child)
    } else {
        format!("{}/{}", parent, child)
    }
}

// Default is "no tags at all", which two callers want by name: read_tags when
// lofty can't open the file, and the drop path when it declines to open a cloud
// file in the first place.
#[derive(Default)]
struct Tags {
    title: Option<String>,
    artist: Option<String>,
    album: Option<String>,
    album_artist: Option<String>,
    disc: Option<u32>,
    track: Option<u32>,
    year: Option<u32>,
    genre: Option<String>,
    // Track length in seconds, read from the decoded file's properties (not a
    // tag). None when lofty can't determine it. Summed per queue/playlist to
    // show a total runtime beside the track count.
    duration: Option<f64>,
    // The rest come from the same FileProperties as duration, so they are free:
    // the file is already open and parsed by the time we read one of them.
    bitrate: Option<u32>,
    sample_rate: Option<u32>,
    bit_depth: Option<u32>,
    // REPLAYGAIN_TRACK_GAIN in dB as the file states it. See the schema comment.
    rg_track_gain: Option<f64>,
}

// The tracks table is a cache rebuilt by run_scan; bump this whenever its shape
// changes — or whenever what the scanner *reads* changes — and the next startup
// will drop and recreate it. The second case is why this is at 8: open_tagged
// identifies a container by its bytes rather than its extension, so files whose
// name lied about their format (an MP4 called .mp3) were cached as untagged and
// duration-less. The incremental scan skips any row whose mtime and size are
// unchanged, so without a rebuild those rows would stay wrong until the files
// themselves were touched.
const SCHEMA_VERSION: i64 = 8;

// WAL lets the scan's write transaction run without blocking concurrent reads
// (list_dir, get_metadata) on the main connection.
fn open_connection(path: &std::path::Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open(path)?;
    let _: String = conn.query_row("PRAGMA journal_mode = WAL", [], |row| row.get(0))?;
    conn.busy_timeout(Duration::from_millis(5000))?;
    Ok(conn)
}

// A read-only connection for the pool. The database is already in WAL mode (set
// once on the writer connection in setup and persisted in the file header), so a
// reader needs only the matching busy_timeout; query_only makes an accidental
// write on a pooled reader fail loudly instead of contending with the writer.
fn open_read_connection(path: &std::path::Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open(path)?;
    conn.busy_timeout(Duration::from_millis(5000))?;
    conn.execute_batch("PRAGMA query_only = true;")?;
    Ok(conn)
}

// A small pool of read-only SQLite connections, checked out per blocking read task
// and returned afterward. WAL permits unlimited concurrent readers, so this is what
// lets off-thread reads actually run in parallel instead of serializing on the
// single writer mutex. The idle list is capped so a burst of concurrent reads can't
// leave an unbounded number of connections open forever.
struct ReadPool {
    path: PathBuf,
    idle: Mutex<Vec<Connection>>,
}

impl ReadPool {
    fn new(path: PathBuf) -> Self {
        ReadPool {
            path,
            idle: Mutex::new(Vec::new()),
        }
    }

    // Run `f` with a pooled read connection, opening a fresh one when none is idle
    // and returning it to the pool afterward (up to the cap). Poisoned locks are
    // recovered rather than propagated, matching the writer mutex's handling. Must
    // be called from a blocking context, never the UI thread.
    fn with<T>(&self, f: impl FnOnce(&Connection) -> Result<T, String>) -> Result<T, String> {
        let pooled = {
            let mut idle = self.idle.lock().unwrap_or_else(|e| e.into_inner());
            idle.pop()
        };
        let conn = match pooled {
            Some(c) => c,
            None => open_read_connection(&self.path).map_err(|e| e.to_string())?,
        };
        let out = f(&conn);
        let mut idle = self.idle.lock().unwrap_or_else(|e| e.into_inner());
        if idle.len() < 8 {
            idle.push(conn);
        }
        out
    }
}

impl DbHandle {
    // Run a read query off the UI thread on a pooled connection. The freeze fix in
    // one place: a synchronous #[tauri::command] fn runs on the main/WKWebView
    // thread, so any DB read there blocks the UI; this hops onto a blocking thread
    // and hands the closure a pooled reader.
    async fn read<T, F>(&self, f: F) -> Result<T, String>
    where
        F: FnOnce(&Connection) -> Result<T, String> + Send + 'static,
        T: Send + 'static,
    {
        let readers = self.readers.clone();
        tauri::async_runtime::spawn_blocking(move || readers.with(f))
            .await
            .map_err(|e| e.to_string())?
    }
}

fn init_schema(conn: &Connection) -> rusqlite::Result<()> {
    let version: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    if version != SCHEMA_VERSION {
        conn.execute_batch("DROP TABLE IF EXISTS tracks;")?;
    }
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS tracks (
            path TEXT PRIMARY KEY,
            root TEXT NOT NULL,
            mtime INTEGER NOT NULL,
            size INTEGER NOT NULL,
            title TEXT,
            artist TEXT,
            album TEXT,
            album_artist TEXT,
            disc INTEGER,
            track INTEGER,
            duration REAL,
            created INTEGER,
            year INTEGER,
            genre TEXT,
            bitrate INTEGER,
            -- Read for free alongside duration and bitrate (read_tags already
            -- holds the FileProperties all four come from). Cached here before
            -- anything displayed them, which is why surfacing them as the Sample
            -- Rate and Bit Depth columns cost no schema bump and no rescan: every
            -- existing library already had the values sitting in this table.
            sample_rate INTEGER,
            bit_depth INTEGER,
            -- The raw REPLAYGAIN_TRACK_GAIN figure in dB, NOT the playback
            -- multiplier: the engine re-reads the tags at decode time and applies
            -- its own clip-safe math (see replaygain_multiplier). This column
            -- exists to *show* what the file carries — a blank cell is a file the
            -- ReplayGain setting can't act on, which is otherwise invisible.
            rg_track_gain REAL,
            -- 1 when the file provider (iCloud Drive, Proton Drive) held this
            -- file's metadata but none of its bytes at scan time. A fact about
            -- the file rather than about its audio, cached here for the same
            -- reason the rest of this table exists: the lists that show it run
            -- to thousands of rows, and a stat per row on every open would put
            -- the filesystem back in the render path.
            --
            -- Can go stale in one direction only. A row that is dataless has a
            -- NULL duration (the tag read failed), so the scan always retries it
            -- and downloading a track clears the flag; but a downloaded track the
            -- provider later *evicts* keeps its tags, so the skip below refreshes
            -- this column on its own when the stat disagrees. Nothing depends on
            -- it being current to be correct: the engine re-checks the live file
            -- before it plays anything (see audio.rs), so the column only decides
            -- what the row says, never what playback does.
            dataless INTEGER NOT NULL DEFAULT 0
        );",
    )?;
    // Each cached track carries its owning library root (the folder that was scanned
    // to produce it). Reconcile and prune filter on it — `root = ?` / `root NOT IN (...)`
    // — so scoping a delete to one library folder is a column match rather than a
    // path-prefix reconstruction the caller has to remember. Indexed so those deletes
    // don't scan the whole table.
    conn.execute_batch("CREATE INDEX IF NOT EXISTS idx_tracks_root ON tracks(root);")?;
    // Sort index for the whole-library Songs list. Its column list mirrors that
    // query's ORDER BY exactly — including the leading `artist IS NULL` *expression*
    // (untagged tracks sort last) and the NOCASE collations — so SQLite reads the
    // rows pre-sorted instead of sorting all N on every open. That sort avoidance is
    // the whole value and it holds however wide the SELECT gets.
    //
    // It is NOT a covering index, despite path + duration being appended as payload:
    // the Songs SELECT also reads album_artist, and now the column fields besides, so
    // every row already costs a table lookup. Widening the index to close that gap
    // would roughly duplicate the table a second time for a lookup SQLite does from
    // the page cache anyway; the sort is the expensive part and it is already gone.
    // Cost as it stands: the index roughly duplicates the table (path strings
    // dominate) and is maintained on every scan insert — a read-speed-for-write-cost
    // trade we accept since opens are user-facing and scans are background.
    // See list_all_songs.
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_songs_sort ON tracks(
            (artist IS NULL),
            artist COLLATE NOCASE,
            album COLLATE NOCASE,
            disc,
            track,
            title COLLATE NOCASE,
            path,
            duration
        );",
    )?;
    // The Recently Added list was withdrawn, and with it the only query that
    // ordered the whole table by arrival time. Drop its index rather than leave it:
    // nothing reads it now, and it was maintained on every scan insert. Unconditional
    // (IF EXISTS), so a database written by a version that had the list sheds it on
    // first open and a fresh one never pays for it.
    conn.execute_batch("DROP INDEX IF EXISTS idx_tracks_added;")?;
    if version != SCHEMA_VERSION {
        conn.pragma_update(None, "user_version", SCHEMA_VERSION)?;
    }
    Ok(())
}

// Whether the audio properties are parsed alongside the tags. The library scan
// needs them (duration, bit rate, sample rate, bit depth are four of its columns);
// the tag editor and ReplayGain want only the tags, and skipping the parse means a
// file whose audio stream has a damaged frame can still be read and re-tagged
// instead of failing at the door.
const WITH_PROPERTIES: bool = true;
const TAGS_ONLY: bool = false;

// Open a file for tag work. Two things this does that lofty::read_from_path does
// not, and every tag read and write in the app goes through it:
//
//   - Identifies the container from the file's own bytes, falling back to the
//     extension only when the bytes say nothing (guess_file_type's `or`). Real
//     libraries are full of files whose name lies about what they are — an MP4
//     called .mp3 is the common one, from a download that renamed by format
//     rather than by container. lofty otherwise trusts the extension, hands the
//     MPEG parser an MP4, and fails the whole file: no tags in any list, no
//     artwork, and an editor that could neither read nor save it.
//   - Skips the audio-property parse for callers that only want tags, so a
//     damaged frame somewhere in the stream doesn't stop a tag edit either.
fn open_tagged(
    path: &std::path::Path,
    read_properties: bool,
) -> Result<lofty::file::TaggedFile, lofty::error::LoftyError> {
    lofty::probe::Probe::open(path)?
        .options(lofty::config::ParseOptions::new().read_properties(read_properties))
        // Options first: the sniff reads as far as they allow it to.
        .guess_file_type()?
        .read()
}

fn read_tags(path: &std::path::Path) -> Tags {
    let empty = Tags::default();
    let Ok(tagged) = open_tagged(path, WITH_PROPERTIES) else {
        return empty;
    };
    // These come from the decoded audio properties, not from tags, so they are
    // available even for a file carrying no tags at all — which is exactly why
    // Kind and Bit Rate can never be blank while Genre and Year often are.
    let props = tagged.properties();
    let duration = {
        let secs = props.duration().as_secs_f64();
        (secs > 0.0).then_some(secs)
    };
    let bitrate = props.audio_bitrate();
    let sample_rate = props.sample_rate();
    let bit_depth = props.bit_depth().map(u32::from);
    let Some(tag) = tagged.primary_tag().or_else(|| tagged.first_tag()) else {
        return Tags {
            duration,
            bitrate,
            sample_rate,
            bit_depth,
            ..empty
        };
    };
    let norm = |v: Option<std::borrow::Cow<'_, str>>| {
        v.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
    };
    Tags {
        title: norm(tag.title()),
        artist: norm(tag.artist()),
        album: norm(tag.album()),
        // No Accessor shortcut for album artist; pull it by key. Cow-wrapped so
        // it flows through the same norm() (trim + drop-if-empty) as the rest.
        album_artist: norm(
            tag.get_string(&lofty::tag::ItemKey::AlbumArtist)
                .map(std::borrow::Cow::Borrowed),
        ),
        disc: tag.disk(),
        track: tag.track(),
        year: tag.year(),
        genre: norm(tag.genre()),
        duration,
        bitrate,
        sample_rate,
        bit_depth,
        // A gain tag is a signed dB figure, usually suffixed " dB" (e.g. "-7.89 dB").
        // Parsed the same way the engine parses it (see replaygain_multiplier) so the
        // column can't disagree with what playback actually acts on.
        rg_track_gain: tag
            .get_string(&lofty::tag::ItemKey::ReplayGainTrackGain)
            .and_then(|v| {
                v.trim()
                    .trim_end_matches(|c: char| c.is_alphabetic())
                    .trim()
                    .parse::<f64>()
                    .ok()
            }),
    }
}

// `unreadable` collects the directories the walk could not look inside. Finding no
// audio in a folder that would not open is not evidence that the folder holds none,
// and run_scan has to tell those two apart before it deletes anything (see
// preserve_unreadable). Callers that only want the files can pass a vec and drop it.
//
// Recorded as the path the walk was handed rather than its canonical form, because
// that is the path the entries below are built from and therefore the one the
// tracks rows are keyed by.
fn walk_audio(
    root: &std::path::Path,
    out: &mut Vec<PathBuf>,
    visited: &mut HashSet<PathBuf>,
    unreadable: &mut Vec<PathBuf>,
) {
    // Canonicalize so a symlink loop (e.g. /foo/back -> /foo) gets caught regardless
    // of which path we entered the cycle from. A path that will not resolve is a
    // hole rather than an empty folder: an ejected external is the common one, and
    // its mount point stops existing the moment it goes.
    let Ok(canon) = std::fs::canonicalize(root) else {
        unreadable.push(root.to_path_buf());
        return;
    };
    // Reached twice under two names. Not a hole — whatever is down there went into
    // `out` on the first visit.
    if !visited.insert(canon) {
        return;
    }
    // Still there, still won't open: a permission that changed, or a share that
    // mounted but did not answer.
    let Ok(entries) = std::fs::read_dir(root) else {
        unreadable.push(root.to_path_buf());
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        // std::fs::metadata follows symlinks; entry.file_type() does not. Following lets
        // a user organize their library with symlinks to dirs / files.
        let Ok(meta) = std::fs::metadata(&path) else {
            continue;
        };
        if meta.is_dir() {
            walk_audio(&path, out, visited, unreadable);
        } else if meta.is_file() && is_audio_path(&path.to_string_lossy()) {
            out.push(path);
        }
    }
}

// The canonical string a root is stored under in tracks.root (and compared against
// when pruning). Trailing separators are stripped so the same folder typed with or
// without a slash resolves to one key. The frontend commits roots in this same form
// (see setLibraryRoots), so both sides agree without further coordination.
fn normalize_root(s: &str) -> String {
    s.strip_suffix(std::path::MAIN_SEPARATOR)
        .unwrap_or(s)
        .to_string()
}

// Carry the rows the walk could not have found, because it could not look, into
// scan_current as though it had seen them. Which is what they are: present,
// unverified.
//
// Without this, a folder that would not open is indistinguishable from a folder
// with nothing in it, and the prune below deletes every track under it — an
// unplugged external, a share that didn't answer, a permission that changed. No
// files are harmed and a rescan rebuilds the rows, but until the volume comes back
// that part of the library reads as empty, and when it returns the user pays for a
// full rescan of it.
//
// Scoped to the subtrees that actually failed, rather than suspending the prune for
// the whole root: one unreadable folder must not stop a track deleted from a folder
// we *did* read from leaving the library on this pass. That also covers the root
// itself failing — everything under it is preserved and the prune finds nothing to
// do — so there is no separate case for an unreachable root.
//
// Costs one pass over the root's rows, and only on a scan that hit a hole.
fn preserve_unreadable(
    conn: &Connection,
    root_key: &str,
    unreadable: &[PathBuf],
) -> Result<(), String> {
    if unreadable.is_empty() {
        return Ok(());
    }
    let held: Vec<String> = {
        let mut stmt = conn
            .prepare("SELECT path FROM tracks WHERE root = ?1")
            .map_err(|e| format!("select root rows failed: {}", e))?;
        let rows = stmt
            .query_map([root_key], |r| r.get::<_, String>(0))
            .map_err(|e| format!("select root rows failed: {}", e))?;
        rows.filter_map(|r| r.ok())
            .filter(|p| is_under_any(Path::new(p), unreadable))
            .collect()
    };
    let mut insert = conn
        .prepare("INSERT OR IGNORE INTO scan_current (path) VALUES (?1)")
        .map_err(|e| format!("prepare preserve failed: {}", e))?;
    for path in held {
        insert
            .execute([&path])
            .map_err(|e| format!("preserve failed: {}", e))?;
    }
    Ok(())
}

// Path::starts_with compares whole components, so /Volumes/Ext does not swallow
// /Volumes/Extra the way a string prefix would.
fn is_under_any(path: &Path, dirs: &[PathBuf]) -> bool {
    dirs.iter().any(|dir| path.starts_with(dir))
}

fn run_scan(root: PathBuf, db_path: PathBuf, app: &AppHandle) -> Result<(), String> {
    let root_key = normalize_root(&root.to_string_lossy());
    let mut files = Vec::new();
    let mut visited = HashSet::new();
    let mut unreadable = Vec::new();
    walk_audio(&root, &mut files, &mut visited, &mut unreadable);

    // Total is known now (the walk is complete), so the footer can show a determinate
    // bar. Emitted for every scan, including instant watcher rescans; the frontend
    // debounces the reveal so a sub-second pass never actually paints.
    let total = files.len();
    let _ = app.emit("scan-started", ScanProgress { done: 0, total });

    let mut conn =
        open_connection(&db_path).map_err(|e| format!("open scan connection failed: {}", e))?;
    let tx = conn
        .transaction()
        .map_err(|e| format!("begin tx failed: {}", e))?;

    tx.execute(
        "CREATE TEMP TABLE IF NOT EXISTS scan_current (path TEXT PRIMARY KEY)",
        [],
    )
    .map_err(|e| format!("create temp table failed: {}", e))?;
    tx.execute("DELETE FROM scan_current", [])
        .map_err(|e| format!("clear temp table failed: {}", e))?;

    for (i, file) in files.iter().enumerate() {
        // Throttle progress emits to one every 512 files: cheap for the frontend and
        // fine-grained enough to animate smoothly even over a 200k first scan.
        if i % 512 == 0 {
            let _ = app.emit("scan-progress", ScanProgress { done: i, total });
        }
        let Ok(meta) = file.metadata() else { continue };
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let size = meta.len() as i64;
        // Birth time (APFS/HFS+ st_birthtime). Distinct from mtime and the more
        // useful of the two for "what did I just add": Pudding's own metadata
        // editor rewrites files (see write_tags), which bumps mtime — so a tagging
        // pass would otherwise reshuffle a Date Modified sort into "files I recently
        // edited". None on filesystems that don't record it.
        let created = meta
            .created()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64);
        let path_str = file.to_string_lossy().to_string();
        // Free: the same stat that gave us mtime and size carries the flag.
        let dataless = dataless::is_dataless(&meta);

        let _ = tx.execute(
            "INSERT OR IGNORE INTO scan_current (path) VALUES (?)",
            [&path_str],
        );

        // `duration IS NOT NULL` doubles as "we have actually read this file":
        // it comes from the decoded audio properties rather than from a tag, so
        // every file we could open has one, and a NULL row is one read_tags
        // failed on — which, since the scan thread no longer waits for cloud
        // files, is mostly "it wasn't downloaded when we walked past it".
        //
        // Those have to be retried on their own, because materializing a file
        // changes NEITHER mtime NOR size (only ctime and st_blocks move), so the
        // unchanged-file skip below would otherwise leave a track the user has
        // since downloaded untagged forever. Retrying is free: a still-dataless
        // read fails in ~0.00s, and a locally unreadable file (corrupt, DRM)
        // costs one header read it might one day survive.
        let existing: Option<(i64, i64, bool, bool)> = tx
            .query_row(
                "SELECT mtime, size, duration IS NOT NULL, dataless FROM tracks WHERE path = ?",
                [&path_str],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()
            .map_err(|e| format!("query existing row failed: {}", e))?;
        if let Some((m, s, read_before, was_dataless)) = existing {
            if m == mtime && s == size && read_before {
                // Nothing to re-read — but the provider may have evicted the file
                // since, and eviction moves neither mtime nor size. Correct the one
                // column the stat disagrees with rather than skipping blind; the
                // write happens only on an actual change, so a steady library still
                // does zero writes on a rescan.
                if was_dataless != dataless {
                    let _ = tx.execute(
                        "UPDATE tracks SET dataless = ?1 WHERE path = ?2",
                        params![dataless, path_str],
                    );
                }
                continue;
            }
        }

        let tags = read_tags(file);
        let _ = upsert_track(
            &tx,
            &path_str,
            &root_key,
            mtime,
            size,
            created,
            &tags,
            dataless,
        );
    }

    // Anything the walk couldn't look at counts as still there, so the delete below
    // only ever removes what it actually looked for and didn't find.
    preserve_unreadable(&tx, &root_key, &unreadable)?;

    // Remove rows for files that vanished from *this* root. A scan only walks one
    // library folder (rescan_libraries and the watcher both drive scans one root at a
    // time), so scan_current holds just this root's files — the delete is scoped to
    // this root's rows so it can't touch any other library root. Pruning of roots the
    // user removed from the library is handled separately (see prune_library_roots).
    tx.execute(
        "DELETE FROM tracks WHERE root = ?1 AND path NOT IN (SELECT path FROM scan_current)",
        [&root_key],
    )
    .map_err(|e| format!("delete missing failed: {}", e))?;

    tx.commit().map_err(|e| format!("commit failed: {}", e))?;
    Ok(())
}

// A cloud track's bytes just landed (see audio.rs's fetch thread), and the row the
// scanner left behind describes the file as it was *before* that: flagged
// dataless, and untagged — reading its tags is exactly what the scanner refused
// to do, because doing it would have downloaded the file.
//
// The next scan cannot correct the flag on its own: materializing a file moves
// neither mtime nor size (only ctime and st_blocks), and the incremental skip is
// keyed on exactly those two. It would eventually re-read the tags, since a NULL
// duration is the scanner's "never actually read this one" retry flag — but
// "eventually" means the next rescan, and until then the Files tree keeps showing
// a filename and a "(Not downloaded)" marker for a track the user is listening to.
//
// `facts` comes from the caller because it read the file already, to tell the UI
// the same news (see audio.rs's fetch worker); reading it twice would be two
// answers where there is one file.
//
// Only ever corrects a row that exists. A path outside every library root was
// never indexed, so there is no stale row to fix and no `root` to invent for a new
// one; the SELECT that finds neither is the whole decision.
//
// Blocks for the length of a whole scan when one is running — not on the writer
// mutex (a scan has its own connection; see DbHandle), but on SQLite's own write
// lock, which the scan's single transaction holds across the walk. So only call
// this from a thread with nothing waiting on it.
fn reindex_downloaded(app: &AppHandle, path: &Path, facts: &DiskFacts) {
    let db = app.state::<DbHandle>();
    // Poisoned only if another writer panicked mid-statement; this row's work is
    // independent of theirs, so recover rather than propagate.
    let conn = db.conn.lock().unwrap_or_else(|e| e.into_inner());
    let path_str = path.to_string_lossy().to_string();
    let root: Option<String> = conn
        .query_row(
            "SELECT root FROM tracks WHERE path = ?",
            [&path_str],
            |row| row.get(0),
        )
        .optional()
        .unwrap_or(None);
    let Some(root) = root else { return };
    if let Err(e) = upsert_track(
        &conn,
        &path_str,
        &root,
        facts.modified.unwrap_or(0),
        facts.size,
        facts.created,
        &facts.tags,
        facts.not_downloaded,
    ) {
        log::warn!("could not re-index {} after download: {e}", path.display());
    }
}

// The one statement that writes a track row, shared by the scanner and by the
// post-download re-read below. Two callers, one column list: a column added to
// the cache is written by both, or by neither — never by whichever of them
// someone remembered.
//
// Upsert rather than update because the scanner is usually meeting the file for
// the first time. The other caller only ever lands on the UPDATE half; it has
// already established that the row exists (see reindex_downloaded).
#[allow(clippy::too_many_arguments)]
fn upsert_track(
    conn: &Connection,
    path: &str,
    root: &str,
    mtime: i64,
    size: i64,
    created: Option<i64>,
    tags: &Tags,
    dataless: bool,
) -> rusqlite::Result<usize> {
    conn.execute(
        "INSERT INTO tracks (path, root, mtime, size, created, title, artist, album, album_artist,
                             disc, track, year, genre, duration, bitrate, sample_rate, bit_depth,
                             rg_track_gain, dataless)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18,
                 ?19)
         ON CONFLICT(path) DO UPDATE SET
             root = excluded.root,
             mtime = excluded.mtime,
             size = excluded.size,
             created = excluded.created,
             title = excluded.title,
             artist = excluded.artist,
             album = excluded.album,
             album_artist = excluded.album_artist,
             disc = excluded.disc,
             track = excluded.track,
             year = excluded.year,
             genre = excluded.genre,
             duration = excluded.duration,
             bitrate = excluded.bitrate,
             sample_rate = excluded.sample_rate,
             bit_depth = excluded.bit_depth,
             rg_track_gain = excluded.rg_track_gain,
             dataless = excluded.dataless",
        params![
            path,
            root,
            mtime,
            size,
            created,
            tags.title,
            tags.artist,
            tags.album,
            tags.album_artist,
            tags.disc,
            tags.track,
            tags.year,
            tags.genre,
            tags.duration,
            tags.bitrate,
            tags.sample_rate,
            tags.bit_depth,
            tags.rg_track_gain,
            dataless
        ],
    )
}

struct ScanCoalesce {
    running: bool,
    // Distinct roots requested while a scan runs, each drained as one follow-up pass.
    // A burst of watcher flushes for the *same* root during a long scan collapses to a
    // single extra scan (dedup on insert) rather than a thread + full walk per flush —
    // but requests for *different* roots are all kept, so a rescan of several library
    // folders can never drop one by overwriting a single slot.
    pending: Vec<PathBuf>,
}

// Mutex guards only the bools/Option above for very short critical sections;
// the data is trivially valid, so a poisoned lock is recovered rather than
// propagated (a panicked scan must not wedge all future scans).
fn scan_coalesce() -> &'static Mutex<ScanCoalesce> {
    static C: OnceLock<Mutex<ScanCoalesce>> = OnceLock::new();
    C.get_or_init(|| {
        Mutex::new(ScanCoalesce {
            running: false,
            pending: Vec::new(),
        })
    })
}

// Single entry point for every scan (explicit rescan + watcher). At most one
// scan thread exists at a time; concurrent requests fold into one follow-up
// pass. This both serializes the SQLite write transaction (no busy-timeout
// races between an explicit rescan and a watcher scan) and prevents a burst of
// filesystem events from stacking redundant full-library walks.
fn request_scan(root: PathBuf, db_path: PathBuf, app: AppHandle) {
    {
        let mut c = scan_coalesce().lock().unwrap_or_else(|e| e.into_inner());
        if c.running {
            // Dedup: a burst for one root folds into a single follow-up, but distinct
            // roots each stay queued. db_path is invariant (always the one DB), so the
            // running thread's captured copy serves every drained root.
            if !c.pending.contains(&root) {
                c.pending.push(root);
            }
            return;
        }
        c.running = true;
    }
    std::thread::spawn(move || {
        // Every scan runs on this thread, so opting out once here covers all of
        // them. A tag read on a cloud file that isn't downloaded now fails
        // instantly instead of pulling the file down: a library that lives in
        // ProtonDrive/iCloud scans in seconds rather than blocking ~2s *per
        // file*, and Pudding stops silently materializing folders the user never
        // asked it to. See dataless.rs.
        dataless::never_materialize_on_this_thread();
        let mut root = root;
        loop {
            scan_and_emit(root.clone(), db_path.clone(), app.clone());
            let mut c = scan_coalesce().lock().unwrap_or_else(|e| e.into_inner());
            match c.pending.pop() {
                Some(next) => root = next,
                None => {
                    c.running = false;
                    return;
                }
            }
        }
    });
}

fn scan_and_emit(root: PathBuf, db_path: PathBuf, app: AppHandle) {
    let payload = match run_scan(root, db_path, &app) {
        Ok(()) => ScanResult {
            ok: true,
            error: None,
        },
        Err(e) => {
            eprintln!("scan failed: {}", e);
            ScanResult {
                ok: false,
                error: Some(e),
            }
        }
    };
    let _ = app.emit("library-scanned", payload);
}

// The cached metadata for one path, for callers that look tracks up by path rather
// than querying a list (the browse tree, playlist expansion, M3U serialization).
//
// A struct rather than the tuple this used to be: it grew past the point where
// positional destructuring at three call sites — each wanting a different subset —
// stayed readable, and `..Default::default()` gives the out-of-library case a name.
#[derive(Clone, Default)]
pub(crate) struct MetaRow {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub album_artist: Option<String>,
    pub disc: Option<u32>,
    pub track: Option<u32>,
    pub year: Option<u32>,
    pub genre: Option<String>,
    pub duration: Option<f64>,
    pub bitrate: Option<u32>,
    pub sample_rate: Option<u32>,
    pub bit_depth: Option<u32>,
    pub gain: Option<f64>,
    pub created: Option<i64>,
    pub modified: Option<i64>,
    pub not_downloaded: bool,
}

// Fetches the cached metadata for many paths in one round trip
// instead of a SELECT per path. SQLite caps bound parameters (default 999), so
// paths are chunked. Paths missing from the cache simply don't appear in the
// map; callers substitute a None-filled row.
fn fetch_meta(conn: &Connection, paths: &[String]) -> Result<HashMap<String, MetaRow>, String> {
    let mut map: HashMap<String, MetaRow> = HashMap::with_capacity(paths.len());
    for chunk in paths.chunks(900) {
        let placeholders = vec!["?"; chunk.len()].join(",");
        let sql = format!(
            "SELECT {TRACK_COLUMNS} FROM tracks WHERE path IN ({placeholders})"
        );
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params_from_iter(chunk), |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    MetaRow {
                        title: row.get(1)?,
                        artist: row.get(2)?,
                        album: row.get(3)?,
                        album_artist: row.get(4)?,
                        disc: row.get(5)?,
                        track: row.get(6)?,
                        year: row.get(7)?,
                        genre: row.get(8)?,
                        duration: row.get(9)?,
                        bitrate: row.get(10)?,
                        sample_rate: row.get(11)?,
                        bit_depth: row.get(12)?,
                        gain: row.get(13)?,
                        created: row.get(14)?,
                        modified: row.get(15)?,
                        not_downloaded: row.get(16)?,
                    },
                ))
            })
            .map_err(|e| e.to_string())?;
        for r in rows {
            let (path, meta) = r.map_err(|e| e.to_string())?;
            map.insert(path, meta);
        }
    }
    Ok(map)
}

#[tauri::command]
async fn list_dir(path: String, db: State<'_, DbHandle>) -> Result<DirListing, String> {
    db.read(move |conn| {
        let entries = std::fs::read_dir(&path).map_err(|e| e.to_string())?;

        let mut folders: Vec<String> = Vec::new();
        let mut file_names: Vec<String> = Vec::new();
        let mut playlists: Vec<PlaylistListing> = Vec::new();
        for entry in entries {
            let entry = entry.map_err(|e| e.to_string())?;
            let name = entry.file_name().to_string_lossy().into_owned();
            // Prefer the dirent's file type — readdir already carries it, so no
            // extra syscall. Only fall back to a full metadata() (a stat per entry
            // that follows symlinks) when the entry IS a symlink or the type wasn't
            // available, so a big directory of plain files costs one readdir instead
            // of N stats. Broken links / permission errors are skipped silently.
            let (is_dir, is_file) = match entry.file_type() {
                Ok(ft) if !ft.is_symlink() => (ft.is_dir(), ft.is_file()),
                _ => match std::fs::metadata(entry.path()) {
                    Ok(m) => (m.is_dir(), m.is_file()),
                    Err(_) => continue,
                },
            };
            if is_dir {
                folders.push(name);
            } else if is_file && is_audio_path(&name) {
                file_names.push(name);
            } else if is_file && playlist::is_playlist_path(&name) {
                // Playlists stay out of the audio-tag path (no tag scan, own icon
                // and click action); the display name comes from the file.
                playlists.push(PlaylistListing {
                    name: playlist::display_name(&entry.path()),
                    file: name,
                });
            }
        }
        folders.sort_by_key(|s| s.to_lowercase());
        // Playlists sort after all tracks, alphabetically by display name.
        playlists.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

        let fulls: Vec<String> = file_names.iter().map(|n| join_path(&path, n)).collect();
        let meta_map = fetch_meta(conn, &fulls)?;
        let mut files: Vec<FileEntry> = Vec::with_capacity(file_names.len());
        for (name, full) in file_names.into_iter().zip(fulls.into_iter()) {
            let m = meta_map.get(&full).cloned().unwrap_or_default();
            files.push(FileEntry {
                name,
                title: m.title,
                artist: m.artist,
                album: m.album,
                album_artist: m.album_artist,
                disc: m.disc,
                track: m.track,
                year: m.year,
                genre: m.genre,
                duration: m.duration,
                bitrate: m.bitrate,
                sample_rate: m.sample_rate,
                bit_depth: m.bit_depth,
                gain: m.gain,
                created: m.created,
                modified: m.modified,
                // Free here — the browse listing's metadata already came from the
                // cache, so the marker reaches the Files tree without the stat per
                // entry that this loop deliberately avoids.
                not_downloaded: m.not_downloaded,
            });
        }

        // Sort by (disc, track, name). Missing disc is treated as disc 1; missing track
        // sorts after numbered tracks within the same disc. sort_by_cached_key computes
        // each key — including the one lowercased-name allocation — exactly once per
        // element, instead of re-lowercasing both sides of every comparison (O(n log n)
        // allocations). That matters for very large flat folders.
        files.sort_by_cached_key(|f| {
            (
                f.disc.unwrap_or(1),
                f.track.unwrap_or(u32::MAX),
                f.name.to_lowercase(),
            )
        });

        Ok(DirListing {
            folders,
            files,
            playlists,
        })
    })
    .await
}

// The stream list is an extended M3U (.m3u8) file: each stream is a URL,
// optionally preceded by an #EXTINF line carrying its display name and, via the
// de-facto tvg-logo attribute, its station art. The path is a local file or an
// http(s) URL (remote stream lists are fetched here rather than in the webview,
// which the CSP blocks).
#[tauri::command]
async fn read_stream_list(path: String) -> Result<StreamList, String> {
    // A remote stream list is fetched with a blocking 15s-timeout HTTP GET; a local
    // one is read from disk. Both are blocking I/O, so they run on a blocking thread
    // — a slow or dead host must never freeze the UI thread, which (were this sync)
    // it would for up to the full timeout on startup.
    tauri::async_runtime::spawn_blocking(move || {
        let remote = path.starts_with("http://") || path.starts_with("https://");
        // Stamp before reading, for the reason read_rows spells out: a write landing
        // between the two pairs new content with an older mtime, which costs at worst
        // a needless "changed on disk" refusal. The other order pairs old content
        // with a newer stamp and the staleness is never noticed at all.
        let mtime = (!remote)
            .then(|| crate::playlist::file_mtime_ms(&path))
            .flatten();
        let contents = if remote {
            ureq::AgentBuilder::new()
                .timeout(Duration::from_secs(15))
                .user_agent(USER_AGENT)
                .build()
                .get(&path)
                .call()
                .map_err(|e| e.to_string())?
                .into_string()
                .map_err(|e| e.to_string())?
        } else {
            // Decoded like a playlist rather than read as strict UTF-8: M3U in the
            // wild is often Latin-1/Windows-1252, and a list that won't decode is a
            // list the pane marks unwritable and refuses to edit.
            read_stream_file(&path)?.ok_or_else(|| format!("{path}: no such file"))?
        };
        let streams = parse_m3u_stream_list(&contents).ok_or_else(|| {
            "not an M3U stream list (no #EXTM3U header or stream URLs)".to_string()
        })?;
        Ok(StreamList { streams, mtime })
    })
    .await
    .map_err(|e| e.to_string())?
}

// Resolve the default stream list path, creating an empty (header-only) file on
// first run if it is missing. The frontend seeds this as the stream list setting
// when none has ever been configured, so a fresh install has a valid, writable
// list instead of the "not configured" prompt.
fn ensure_default_stream_list(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data = app_data_dir(app)?;
    std::fs::create_dir_all(&app_data).map_err(|e| e.to_string())?;
    let path = app_data.join(DEFAULT_STREAM_LIST_FILE);
    if !path.exists() {
        std::fs::write(&path, "#EXTM3U\n").map_err(|e| e.to_string())?;
    }
    Ok(path)
}

#[tauri::command]
fn default_stream_list_path(app: AppHandle) -> Result<String, String> {
    Ok(ensure_default_stream_list(&app)?
        .to_string_lossy()
        .into_owned())
}

// A stream list on disk is only editable when it's a local file — a remote
// http(s) list is fetched read-only, so add/update/delete all reject it up
// front (the frontend hides the affordances too, this is the backstop).
fn reject_remote_list(path: &str) -> Result<(), String> {
    if path.starts_with("http://") || path.starts_with("https://") {
        Err("can't edit a remote stream list".to_string())
    } else {
        Ok(())
    }
}

// Trim and sanity-check a station URL shared by add/update: non-empty and
// carrying a scheme, so a typo doesn't write an unplayable entry.
fn clean_stream_url(url: &str) -> Result<&str, String> {
    let url = url.trim();
    if url.is_empty() {
        return Err("stream URL is required".to_string());
    }
    if !url.contains("://") {
        return Err("stream URL must include a scheme (e.g. https://)".to_string());
    }
    Ok(url)
}

// The #EXTINF line for a station: duration -1, the tvg-logo art attribute when
// an image is given, then the (trimmed) name after the comma. Exactly the shape
// parse_m3u_stream_list reads back.
fn extinf_line(name: &str, image: Option<&str>) -> String {
    let attrs = match image.map(str::trim).filter(|s| !s.is_empty()) {
        Some(img) => format!(" tvg-logo=\"{img}\""),
        None => String::new(),
    };
    format!("#EXTINF:-1{attrs},{}", name.trim())
}

// The line spans of each stream in a stream-list body, in the same order (and
// thus by the same index) as parse_m3u_stream_list yields them. Each entry is
// (optional #EXTINF line index, URL line index): the #EXTINF is the most recent
// one seen since the previous track row, matching the parser's pending-title rule
// (plain comments between #EXTINF and the URL don't reset it). Lets update and
// delete edit one station surgically, preserving every other line (headers,
// #EXTVLCOPT options, blank lines) verbatim.
fn stream_spans(lines: &[&str]) -> Vec<(Option<usize>, usize)> {
    let mut spans = Vec::new();
    let mut pending_extinf: Option<usize> = None;
    for (i, raw) in lines.iter().enumerate() {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        if line.starts_with("#EXTINF:") {
            pending_extinf = Some(i);
        } else if line.starts_with('#') {
            // Other comments/options don't claim the pending title.
        } else if crate::playlist::is_url_row(line) {
            spans.push((pending_extinf.take(), i));
        } else {
            // Local tracks consume their metadata too; it must not become part
            // of a following station's editable/deletable span.
            pending_extinf = None;
        }
    }
    spans
}

// Read a local stream list for rewriting. Two things this is not: it is not
// read_to_string — a Latin-1 list is common enough that the playlist reader has a
// decoder for it, and failing to decode one here would mean rewriting a live list
// from nothing. And it does not flatten failure into emptiness: only NotFound
// answers None (the list hasn't been created yet, the sole case where starting
// from a blank file is right); every other error propagates, because "couldn't
// read it" written as "it was empty" replaces the user's stations with whatever we
// were about to append.
fn read_stream_file(path: &str) -> Result<Option<String>, String> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(Some(crate::playlist::decode_bytes(&bytes))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("{path}: {e}")),
    }
}

// Stream lists have the same integrity requirements as local playlists. If the
// directory cannot stage a replacement, leave the original intact and report it.
fn write_stream_file(path: &str, contents: &str) -> Result<(), String> {
    write_durably(Path::new(path), contents.as_bytes()).map_err(|e| e.to_string())
}

// The newline a rewrite should re-emit. `lines()` drops the `\r` of a CRLF file,
// so without this every edit would quietly convert a CRLF list to LF. A mixed file
// settles on CRLF; it has to settle on something.
fn stream_line_ending(contents: &str) -> &'static str {
    if contents.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    }
}

// Rebuild a stream-list body from its lines, in the file's own line ending.
fn join_stream_lines(lines: impl IntoIterator<Item = String>, eol: &str) -> String {
    let mut out = String::new();
    for line in lines {
        out.push_str(&line);
        out.push_str(eol);
    }
    out
}

// Refuse an index-addressed edit to a file that moved since the caller read it.
// The ordinals in update/move/delete come from the station list the pane is
// showing; against a file something else has rewritten they address whatever now
// sits at that position, so the user renames or deletes a station other than the
// one the dialog named. This is the stream-list equivalent of the mtime the
// playlist views compare (notePlaylistMtime / reloadChangedPlaylists) — here as a
// compare-and-swap, since stream lists have no watcher to reload them.
//
// No stamp from the caller, or no stamp on disk, means there is nothing to compare
// and the edit goes through: the guard exists to catch a file that demonstrably
// changed, not to block edits whenever a stat is unavailable.
fn check_stream_stamp(path: &str, expected_mtime: Option<i64>) -> Result<(), String> {
    let (Some(expected), Some(current)) = (expected_mtime, crate::playlist::file_mtime_ms(path))
    else {
        return Ok(());
    };
    if expected == current {
        Ok(())
    } else {
        Err("the stream list changed on disk; reloading it".to_string())
    }
}

// Append a station to a local stream list (.m3u8). Deliberately takes no mtime
// stamp: appending is the one stream edit that addresses no ordinal, so it stays
// correct against a file that changed since the pane read it.
#[tauri::command]
fn add_stream(
    path: String,
    name: String,
    url: String,
    image: Option<String>,
) -> Result<(), String> {
    reject_remote_list(&path)?;
    let url = clean_stream_url(&url)?;
    // Start from the existing file (or a fresh header when there is no file yet),
    // guaranteeing a trailing newline so the new #EXTINF starts its own line.
    let existing = read_stream_file(&path)?.unwrap_or_default();
    let eol = stream_line_ending(&existing);
    let mut contents = existing;
    if contents.trim().is_empty() {
        contents = format!("#EXTM3U{eol}");
    } else if !contents.ends_with('\n') {
        contents.push_str(eol);
    }
    contents.push_str(&extinf_line(&name, image.as_deref()));
    contents.push_str(eol);
    contents.push_str(url);
    contents.push_str(eol);
    write_stream_file(&path, &contents)
}

// Rewrite the `index`-th station in place: replace its #EXTINF (inserting one
// when the entry had none) and its URL line, leaving every other line untouched.
// `index` is a station ordinal from read_stream_list, so it lines up with
// stream_spans — and with `expected_mtime`, the stamp of the read it came from.
#[tauri::command]
fn update_stream(
    path: String,
    index: usize,
    name: String,
    url: String,
    image: Option<String>,
    expected_mtime: Option<i64>,
) -> Result<(), String> {
    reject_remote_list(&path)?;
    let url = clean_stream_url(&url)?;
    check_stream_stamp(&path, expected_mtime)?;
    let contents = read_stream_file(&path)?.ok_or_else(|| format!("{path}: no such file"))?;
    let eol = stream_line_ending(&contents);
    let lines: Vec<&str> = contents.lines().collect();
    let &(extinf, url_line) = stream_spans(&lines)
        .get(index)
        .ok_or("stream index out of range")?;
    let new_extinf = extinf_line(&name, image.as_deref());
    let out = lines.iter().enumerate().map(|(i, line)| {
        if Some(i) == extinf {
            new_extinf.clone()
        } else if i == url_line {
            // No prior #EXTINF: introduce one so the new name/art persists.
            match extinf {
                Some(_) => url.to_string(),
                None => format!("{new_extinf}{eol}{url}"),
            }
        } else {
            line.to_string()
        }
    });
    write_stream_file(&path, &join_stream_lines(out, eol))
}

// Move the station at `from` to sit before the station currently at `to` (both
// are ordinals from read_stream_list; `to == len` appends at the end). Each
// station owns the run of lines from its #EXTINF (or bare URL) up to the next
// station's start, so its #EXTVLCOPT options and any trailing blank/comment lines
// travel with it; the preamble (#EXTM3U header and anything before the first
// station) stays put. Rewrites the whole body in the new order.
#[tauri::command]
fn move_stream(
    path: String,
    from: usize,
    to: usize,
    expected_mtime: Option<i64>,
) -> Result<(), String> {
    reject_remote_list(&path)?;
    check_stream_stamp(&path, expected_mtime)?;
    let contents = read_stream_file(&path)?.ok_or_else(|| format!("{path}: no such file"))?;
    let eol = stream_line_ending(&contents);
    let lines: Vec<&str> = contents.lines().collect();
    let spans = stream_spans(&lines);
    if from >= spans.len() || to > spans.len() {
        return Err("stream index out of range".to_string());
    }
    // Each station's block runs from its start (#EXTINF or URL) up to the next
    // station's start; the last runs to end of file.
    let starts: Vec<usize> = spans
        .iter()
        .map(|&(extinf, url)| extinf.unwrap_or(url))
        .collect();
    let block = |i: usize| -> (usize, usize) {
        (starts[i], starts.get(i + 1).copied().unwrap_or(lines.len()))
    };
    // Reorder the block indices: pull `from` out, reinsert before `to` (adjusting
    // the target for the removed element when moving downward).
    let mut order: Vec<usize> = (0..spans.len()).collect();
    let moved = order.remove(from);
    order.insert(if to > from { to - 1 } else { to }, moved);
    let reordered = lines[..starts[0]].iter().copied().chain(
        order
            .iter()
            .flat_map(|&i| {
                let (s, e) = block(i);
                &lines[s..e]
            })
            .copied(),
    );
    let out = join_stream_lines(reordered.map(str::to_string), eol);
    write_stream_file(&path, &out)
}

// Remove the `index`-th station: drop its URL line and the whole run from its
// #EXTINF down to that URL (taking any #EXTVLCOPT etc. that rode with it), so no
// orphaned directive leaks onto the next station.
#[tauri::command]
fn delete_stream(path: String, index: usize, expected_mtime: Option<i64>) -> Result<(), String> {
    reject_remote_list(&path)?;
    check_stream_stamp(&path, expected_mtime)?;
    let contents = read_stream_file(&path)?.ok_or_else(|| format!("{path}: no such file"))?;
    let eol = stream_line_ending(&contents);
    let lines: Vec<&str> = contents.lines().collect();
    let &(extinf, url_line) = stream_spans(&lines)
        .get(index)
        .ok_or("stream index out of range")?;
    let start = extinf.unwrap_or(url_line);
    let kept = lines
        .iter()
        .enumerate()
        .filter(|&(i, _)| i < start || i > url_line)
        .map(|(_, line)| line.to_string());
    write_stream_file(&path, &join_stream_lines(kept, eol))
}

// A local file path → its file:// URL, so a station image picked from the file
// dialog is stored in the portable form get_stream_image (and other players)
// expect. Url::from_file_path percent-encodes and handles platform path quirks.
#[tauri::command]
fn to_file_url(path: String) -> Result<String, String> {
    url::Url::from_file_path(&path)
        .map(|u| u.to_string())
        .map_err(|()| format!("not an absolute path: {path}"))
}

// Lenient like icy::parse_playlist: #EXTINF is optional, its title (after the
// first comma) names the following URL, and any non-comment line containing
// "://" counts as a stream. Station art rides on the #EXTINF tvg-logo attribute
// (the widely-used IPTV/radio convention), so foreign players render it too.
// Unnamed entries fall back to their hostname so the station list never shows a
// raw URL. Returns None when the body has neither an #EXTM3U header nor a single
// URL, so read_stream_list can reject arbitrary text rather than presenting it
// as an empty stream list.
fn parse_m3u_stream_list(body: &str) -> Option<Vec<Stream>> {
    let mut saw_header = false;
    let mut pending_title: Option<String> = None;
    let mut pending_image: Option<String> = None;
    let mut streams = Vec::new();
    for line in body.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if let Some(rest) = line.strip_prefix("#EXTINF:") {
            // Everything before the first comma is the duration and attributes;
            // the title is what follows.
            let (attrs, title) = rest.split_once(',').unwrap_or((rest, ""));
            pending_title = (!title.trim().is_empty()).then(|| title.trim().to_string());
            pending_image = extinf_attr(attrs, "tvg-logo").map(str::to_string);
        } else if line.starts_with('#') {
            saw_header |= line.starts_with("#EXTM3U");
        } else if crate::playlist::is_url_row(line) {
            let name = pending_title
                .take()
                .unwrap_or_else(|| m3u_fallback_name(line).to_string());
            streams.push(Stream {
                name,
                url: line.to_string(),
                image: pending_image.take(),
            });
        } else {
            pending_title = None;
            pending_image = None;
        }
    }
    (saw_header || !streams.is_empty()).then_some(streams)
}

// Value of a quoted key="value" attribute in an #EXTINF attribute list, if
// present. Attributes are space-separated with no spaces around the '=', per the
// tvg-* convention.
fn extinf_attr<'a>(attrs: &'a str, key: &str) -> Option<&'a str> {
    let needle = format!("{key}=\"");
    let start = attrs.find(&needle)? + needle.len();
    attrs[start..].split_once('"').map(|(value, _)| value)
}

// Hostname portion of a URL, or the URL itself if it has no obvious host.
pub(crate) fn m3u_fallback_name(url: &str) -> &str {
    let Some((_, rest)) = url.split_once("://") else {
        return url;
    };
    let host = rest.split(['/', '?', '#']).next().unwrap_or(rest);
    if host.is_empty() {
        url
    } else {
        host
    }
}

#[tauri::command]
fn rescan_libraries(paths: Vec<String>, db: State<DbHandle>, app: AppHandle) {
    // Drop cached tracks that no longer belong to any configured root. run_scan now
    // prunes only within the root it walked, so a root the user removed from the
    // library leaves its tracks behind unless we sweep them here, where the full
    // (post-change) root set is known.
    prune_library_roots(&paths, &db.path);
    for path in paths {
        if path.is_empty() {
            continue;
        }
        request_scan(PathBuf::from(path), db.path.clone(), app.clone());
    }
}

// Delete every cached track whose owning root is not in `roots`. Called on a
// library-roots change (rescan_libraries) so removing a folder purges its tracks;
// an empty root set clears the whole cache. Best-effort: a failure here just leaves
// stale rows that the next roots change or a table-shape bump will clear.
fn prune_library_roots(roots: &[String], db_path: &Path) {
    let Ok(conn) = open_connection(db_path) else {
        return;
    };
    let keys: Vec<String> = roots
        .iter()
        .filter(|r| !r.is_empty())
        .map(|r| normalize_root(r))
        .collect();
    let sql = if keys.is_empty() {
        "DELETE FROM tracks".to_string()
    } else {
        let placeholders = vec!["?"; keys.len()].join(", ");
        format!("DELETE FROM tracks WHERE root NOT IN ({})", placeholders)
    };
    let _ = conn.execute(&sql, params_from_iter(keys));
}

// Starts (or replaces) recursive watchers on the library roots — one debouncer
// per root. Any filesystem change under a root triggers a debounced incremental
// rescan of that root, which emits "library-scanned" exactly like an explicit
// rescan so the frontend refreshes uniformly. An empty list just tears every
// watcher down.
#[tauri::command]
fn watch_libraries(
    paths: Vec<String>,
    app: AppHandle,
    db: State<DbHandle>,
    watcher: State<WatcherState>,
) -> Result<(), String> {
    let mut guard = watcher.inner.lock().map_err(|e| e.to_string())?;
    // Drop the old debouncers first so we never hold two watchers on overlapping
    // trees during a roots change.
    guard.clear();

    for path in paths {
        if path.is_empty() {
            continue;
        }
        let root = PathBuf::from(&path);
        let db_path = db.path.clone();
        let app_handle = app.clone();
        let scan_root = root.clone();
        let mut debouncer = new_debouncer(
            Duration::from_secs(2),
            None,
            move |res: DebounceEventResult| {
                // Watcher-internal errors (e.g. transient rename races) are ignored
                // — the next event re-syncs. request_scan coalesces: a burst of
                // flushes during an in-flight scan collapses into one follow-up
                // pass rather than a thread + full walk per flush.
                if res.is_ok() {
                    request_scan(scan_root.clone(), db_path.clone(), app_handle.clone());
                }
            },
        )
        .map_err(|e| e.to_string())?;

        // Watches the root itself: if it is deleted or renamed at runtime the watch
        // goes dead and does not self-heal until the roots are set again (which calls
        // this command afresh). Acceptable for a music library; the explicit-rescan
        // and boot paths still function.
        debouncer
            .watcher()
            .watch(&root, RecursiveMode::Recursive)
            .map_err(|e| e.to_string())?;
        debouncer.cache().add_root(&root, RecursiveMode::Recursive);
        guard.push(debouncer);
    }
    Ok(())
}

#[tauri::command]
fn get_art(path: String) -> Option<String> {
    let path = std::path::Path::new(&path);
    // Cover art is never worth downloading a track for. Reading tags materializes
    // the whole file (see dataless.rs), this command is synchronous so it runs on
    // the UI thread, and on a restored session it is the *first* thing to touch
    // the track — so a cloud file froze the window on launch, downloading a track
    // the user had not asked to play. No art until the bytes are here: playing the
    // track fetches it, and the track-changed callback asks for the art again.
    if dataless::path_is_dataless(path) {
        return None;
    }
    art_data_url(path)
}

// One file's embedded cover as a data URL, opened for the picture alone. The hero
// wants it for the track it is drawing; the editor's bulk seed wants it once, at
// the end of a fold that compared digests rather than encoding every selected
// file's cover (see fold_common_tags).
fn art_data_url(path: &Path) -> Option<String> {
    let tagged = open_tagged(path, TAGS_ONLY).ok()?;
    let tag = tagged.primary_tag().or_else(|| tagged.first_tag())?;
    picture_data_url(tag)
}

// A tag's embedded cover as a data URL, or None when it carries no picture. The
// webview's CSP allows only 'self' and data: image sources, so this is the only
// shape art can reach an <img> in. Shared by the hero (get_art) and the metadata
// editor's seed (read_file_tags), so the well in the editor shows exactly the
// picture the hero would draw — the first of the primary tag's pictures, which is
// also the one write_tags replaces.
fn picture_data_url(tag: &lofty::tag::Tag) -> Option<String> {
    let pic = tag.pictures().first()?;
    let mime = pic.mime_type().map(|m| m.as_str()).unwrap_or("image/jpeg");
    let encoded = base64::engine::general_purpose::STANDARD.encode(pic.data());
    Some(format!("data:{};base64,{}", mime, encoded))
}

// A stand-in for the picture, for the bulk seed's fold: equal digests mean equal
// bytes, so a selection can be asked whether it shares a cover without base64
// encoding every file's. That cost is unbounded otherwise —
// MAX_EMBEDDED_ART_BYTES caps what the *picker* will embed, not what a file
// already holds. Never shown and never persisted: std's hasher is not stable
// across Rust releases, and nothing here outlives the fold that produced it.
fn picture_digest(tag: &lofty::tag::Tag) -> Option<String> {
    use std::hash::{Hash, Hasher};
    let pic = tag.pictures().first()?;
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    pic.mime_type().map(|m| m.as_str()).hash(&mut hasher);
    pic.data().hash(&mut hasher);
    Some(format!("{:016x}", hasher.finish()))
}

// Ceiling on a stream list station image. Anything larger than this is not
// plausible station art and would balloon the data URL held in the DOM.
const MAX_STREAM_IMAGE_BYTES: u64 = 10 * 1024 * 1024;

// Station art for a stream list stream: `image` is an http(s) or file:// URL.
// Returned as a data URL for the same reason get_art's is: the webview CSP
// only permits 'self' and data: image sources, so neither remote URLs nor
// arbitrary local files can be given to <img> directly.
//
// Async, and on a blocking thread, for the same reason read_stream_list is: a
// sync #[tauri::command] runs on the main thread, which on macOS is the thread
// that draws the window. A station whose art host is slow or dead would hold it
// for the full 15s timeout — audio playing (it has its own threads) under a
// window that can't paint the station that just started.
#[tauri::command]
async fn get_stream_image(image: String) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || fetch_stream_image(&image))
        .await
        .ok()
        .flatten()
}

fn fetch_stream_image(image: &str) -> Option<String> {
    let (bytes, mime) = if image.starts_with("http://") || image.starts_with("https://") {
        let resp = ureq::AgentBuilder::new()
            .timeout(Duration::from_secs(15))
            .user_agent(USER_AGENT)
            .build()
            .get(image)
            .call()
            .map_err(|e| log::warn!("stream image fetch failed for {image}: {e}"))
            .ok()?;
        // Servers routinely mislabel static files; trust the header only when
        // it says image, otherwise fall back to the URL's extension.
        let mime = match resp.content_type() {
            ct if ct.starts_with("image/") => ct.to_string(),
            _ => image_mime_from_ext(&image).to_string(),
        };
        let mut bytes = Vec::new();
        // take() caps memory; reading one byte past the limit distinguishes
        // "exactly at the cap" from "truncated", which must be rejected rather
        // than decoded as a broken image.
        resp.into_reader()
            .take(MAX_STREAM_IMAGE_BYTES + 1)
            .read_to_end(&mut bytes)
            .ok()?;
        if bytes.len() as u64 > MAX_STREAM_IMAGE_BYTES {
            log::warn!("stream image too large for {image}");
            return None;
        }
        (bytes, mime)
    } else if let Some(path) = file_url_to_path(&image) {
        let meta = std::fs::metadata(&path).ok()?;
        if meta.len() > MAX_STREAM_IMAGE_BYTES {
            log::warn!("stream image too large for {image}");
            return None;
        }
        let bytes = std::fs::read(&path).ok()?;
        (
            bytes,
            image_mime_from_ext(&path.to_string_lossy()).to_string(),
        )
    } else {
        log::warn!("stream image is not an http(s) or file URL: {image}");
        return None;
    };
    let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Some(format!("data:{};base64,{}", mime, encoded))
}

// file:// URL → local path. Url::to_file_path percent-decodes and handles
// host/drive quirks per platform; anything that isn't a valid file URL is None.
fn file_url_to_path(image: &str) -> Option<PathBuf> {
    let url = url::Url::parse(image).ok()?;
    if url.scheme() != "file" {
        return None;
    }
    url.to_file_path().ok()
}

fn image_mime_from_ext(path: &str) -> &'static str {
    let ext = path
        .rsplit('.')
        .next()
        .map(|e| e.split(['?', '#']).next().unwrap_or(e).to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        _ => "image/jpeg",
    }
}

// Audio extensions we accept via OS file associations. Must match the
// fileAssociations list in tauri.conf.json so the registered handlers and the
// runtime gate agree.
//
// This list is also what keeps Apple Music out of the library. Under the sandbox
// the assets.music entitlement grants all of ~/Music, so a user whose root is
// ~/Music hands us ~/Music/Music/Media.localized as well — and everything Apple
// Music downloads under a subscription is FairPlay-protected .m4p, with protected
// audiobooks as .m4b. Neither is here, so the walk never collects them, nothing
// unplayable reaches the tree, and Finder never offers Pudding as a handler for
// one. Purchases have been DRM-free .m4a since 2009 and play normally.
//
// So: do not add "m4p" or "m4b" without first handling decode failure as
// something better than an unplayable row. See audio_extensions_exclude_drm.
const AUDIO_EXTS: &[&str] = &[
    "mp3", "wav", "flac", "m4a", "aac", "ogg", "oga", "opus", "aiff", "aif",
];

fn is_audio_path(s: &str) -> bool {
    Path::new(s)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| {
            let lower = e.to_ascii_lowercase();
            AUDIO_EXTS.iter().any(|x| *x == lower)
        })
        .unwrap_or(false)
}

// A path the app knows how to open via an OS file association: an audio file
// (played) or a playlist (opened for browsing). The frontend re-checks the
// extension to route audio vs. playlist.
fn is_openable_path(s: &str) -> bool {
    is_audio_path(s) || playlist::is_playlist_path(s)
}

// Picks the first arg that looks like an openable file path. We can't assume
// position because launchers / OS shells pass argv differently (macOS adds
// -psn flags, some Windows shells quote oddly).
fn find_openable_in_argv(argv: &[String]) -> Option<String> {
    argv.iter()
        .skip(1)
        .find(|a| is_openable_path(a) && Path::new(a).exists())
        .cloned()
}

fn deliver_open_file(app: &AppHandle, path: String) {
    if !is_openable_path(&path) {
        return;
    }
    // try_state, not state(): on a macOS cold-start file open the Opened Apple
    // Event fires before setup() runs. state() would panic if PendingOpen were
    // not yet managed, and that panic cannot unwind through the ObjC callback
    // (it aborts the process). PendingOpen is managed on the builder so this
    // should always resolve, but stay non-panicking regardless.
    let Some(state) = app.try_state::<PendingOpen>() else {
        return;
    };
    let Ok(mut guard) = state.inner.lock() else {
        return;
    };
    if guard.ready {
        // Drop the lock before emitting; emit doesn't touch it, but holding a
        // lock across an event dispatch is needless.
        drop(guard);
        let _ = app.emit("open-file", path);
    } else {
        guard.path = Some(path);
    }
}

// Called by the frontend once its open-file listener is wired. Marks the
// frontend ready (so future opens are emitted live) and returns any path that
// was queued before the listener existed.
#[tauri::command]
fn frontend_ready(state: State<PendingOpen>) -> Option<String> {
    let mut guard = state.inner.lock().ok()?;
    guard.ready = true;
    guard.path.take()
}

// Dev/e2e only: the WebSocket port the test harness is listening on, passed via
// PUDDING_E2E_PORT. Returns None in normal runs, so the frontend test bridge
// stays completely inert unless a harness launched us. Deliberately env-gated
// rather than a build feature so a single release binary can be driven by tests.
#[tauri::command]
fn e2e_port() -> Option<u16> {
    std::env::var("PUDDING_E2E_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
}

// Screenshot runs use a fresh profile, including the database, store, and stream
// list. Never honor the override in a shipping build or a normal app launch.
fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    if cfg!(debug_assertions) && e2e_port().is_some() {
        if let Some(dir) = std::env::var_os("PUDDING_E2E_DATA_DIR") {
            let path = PathBuf::from(dir);
            if !path.is_absolute() {
                return Err("PUDDING_E2E_DATA_DIR must be absolute".into());
            }
            return Ok(path);
        }
    }
    app.path().app_data_dir().map_err(|e| e.to_string())
}

#[tauri::command]
fn settings_path(app: AppHandle) -> Result<String, String> {
    Ok(app_data_dir(&app)?
        .join("settings.json")
        .to_string_lossy()
        .into_owned())
}

// Native traffic lights otherwise depend on whichever app the operator last
// clicked. Keep this opt-in: caliper may still capture without stealing focus.
#[tauri::command]
fn focus_e2e_window(window: tauri::Window) -> Result<bool, String> {
    if e2e_port().is_none() {
        return Err("window focus control requires an e2e launch".into());
    }
    window.set_focus().map_err(|e| e.to_string())?;
    window.is_focused().map_err(|e| e.to_string())
}

// Dev/e2e only: this window's CGWindowID, so `screencapture -l <id>` can grab
// exactly this window's real rasterized pixels.
//
// Why this exists at all: sub-pixel alignment cannot be measured in a headless
// browser. Headless WebKit and the WKWebView we ship disagree by a whole device
// pixel on boxes that land off the device grid (measured 2026-09-07 on the topbar
// search field), so the only honest source is the window as macOS actually drew
// it. Capturing by window id rather than by screen region means the capture is
// immune to occlusion, needs no focus stealing, and arrives already cropped to
// the window — see scripts/caliper.mjs.
//
// An NSWindow's `windowNumber` IS its CGWindowID. Env-gated like e2e_port above
// so it stays inert in normal runs.
#[cfg(target_os = "macos")]
#[tauri::command]
fn window_number(window: tauri::Window) -> Option<u32> {
    use objc2_app_kit::NSWindow;
    use objc2_foundation::MainThreadMarker;

    std::env::var("PUDDING_E2E_PORT").ok()?;
    // AppKit is main-thread-only, and both `ns_window()` and `windowNumber` are
    // AppKit. Tauri runs non-async commands on the main thread, so this holds
    // today — the marker is what keeps it holding: adding `async` to this
    // signature would otherwise move it off-thread silently, and the same guard
    // is how the other objc2 call sites in this file open.
    MainThreadMarker::new()?;
    let ptr = window.ns_window().ok()?;
    if ptr.is_null() {
        return None;
    }
    // SAFETY: Tauri hands back this window's live NSWindow pointer, we are on the
    // main thread per the marker above, and `windowNumber` is a plain property
    // read that neither mutates the window nor escapes the borrow.
    let number = unsafe { (*(ptr as *const NSWindow)).windowNumber() };
    u32::try_from(number).ok()
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
fn window_number() -> Option<u32> {
    None
}

// Tags for an externally-opened file, read directly from the file (it may not
// be in the library DB).
#[tauri::command]
fn prepare_external_file(path: String) -> Result<TrackMeta, String> {
    let p = Path::new(&path);
    if !p.exists() {
        return Err(format!("file not found: {}", path));
    }
    let tags = read_tags(p);
    Ok(TrackMeta {
        title: tags.title,
        artist: tags.artist,
        album: tags.album,
    })
}

// The metadata editor's own shape: every field it can write, plus the file's name
// to title the form with. Deliberately not a FileEntry — the editable set is
// neither a subset nor a superset of a browse row's. The totals, the comment and
// the artwork are editable but are not columns and so are not cached (the tracks
// table holds what the lists draw), while a row's duration, bit rate and dates are
// facts about the file that no tag edit can change.
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct EditorTags {
    name: String,
    title: Option<String>,
    artist: Option<String>,
    album: Option<String>,
    album_artist: Option<String>,
    disc: Option<u32>,
    disc_total: Option<u32>,
    track: Option<u32>,
    track_total: Option<u32>,
    year: Option<u32>,
    genre: Option<String>,
    comment: Option<String>,
    // The embedded cover as a data URL — the same picture the hero draws (see
    // picture_data_url), so the editor's well shows what the rest of the app shows.
    artwork: Option<String>,
}

// Read a file's current tags straight from disk to seed the metadata editor.
// Views carry only partial rows for a track — a SearchResult (Songs/album/artist
// leaf lists) has no album-artist or disc — so seeding from the row would let a
// save write those fields back as empty and wipe them. Reading fresh gives the
// editor the whole tag set.
//
// Reads the file itself rather than going through read_tags: that one fills the
// scan cache, so it stops at what the tracks table stores, and three of the fields
// here (the two totals and the comment) are editor-only. One lofty parse either way.
#[tauri::command]
fn read_file_tags(path: String) -> Result<EditorTags, String> {
    Ok(file_tags(&path, ArtworkRead::DataUrl))
}

// How much work a read owes the artwork well. The single-file seed wants the
// picture itself; the fold below wants only to know whether two files carry the
// same one, and drops to Skip for the rest of a selection that has already been
// found to disagree — a field in `mixed` is settled, so its value is never
// compared again.
#[derive(Clone, Copy)]
enum ArtworkRead {
    DataUrl,
    Digest,
    Skip,
}

// The editor's whole read side, shared by the single-file seed above and the bulk
// fold below. One 13-field mapping in one place: a second reader for the bulk case
// would drift from this one within a release or two, and the drift would show up
// as a field the bulk form quietly refuses to seed.
fn file_tags(path: &str, artwork: ArtworkRead) -> EditorTags {
    let p = PathBuf::from(path);
    let name = p
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    // An unreadable or untagged file still opens the editor, on an empty form:
    // saving from it writes a fresh tag of the container's native type, which is
    // exactly how an untagged file gets its first tag (see write_tags).
    let Ok(tagged) = open_tagged(&p, TAGS_ONLY) else {
        return EditorTags {
            name,
            ..Default::default()
        };
    };
    let Some(tag) = tagged.primary_tag().or_else(|| tagged.first_tag()) else {
        return EditorTags {
            name,
            ..Default::default()
        };
    };
    let norm = |v: Option<std::borrow::Cow<'_, str>>| {
        v.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
    };
    EditorTags {
        name,
        title: norm(tag.title()),
        artist: norm(tag.artist()),
        album: norm(tag.album()),
        // No Accessor shortcut for album artist; pull it by key, as read_tags does.
        album_artist: norm(
            tag.get_string(&lofty::tag::ItemKey::AlbumArtist)
                .map(std::borrow::Cow::Borrowed),
        ),
        disc: tag.disk(),
        disc_total: tag.disk_total(),
        track: tag.track(),
        track_total: tag.track_total(),
        year: tag.year(),
        genre: norm(tag.genre()),
        comment: norm(tag.comment()),
        artwork: match artwork {
            ArtworkRead::DataUrl => picture_data_url(tag),
            ArtworkRead::Digest => picture_digest(tag),
            ArtworkRead::Skip => None,
        },
    }
}

// What a selection agrees on, and which fields it doesn't. `common` carries the
// value where every file matches; `mixed` *names* the fields where they differ
// rather than leaving a sentinel in `common`, so "they all agree there is no
// album" stays distinct from "the albums differ".
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct CommonTags {
    common: EditorTags,
    mixed: Vec<String>,
}

// One field of the fold. A field already in `mixed` is settled — nothing later can
// bring it back — so it is never read or compared again, which is what lets the
// artwork read drop to Skip once the covers are known to disagree.
fn merge_field<T: PartialEq>(
    key: &str,
    common: &mut Option<T>,
    next: Option<T>,
    mixed: &mut Vec<String>,
    still_common: &mut bool,
) {
    if mixed.iter().any(|k| k == key) {
        return;
    }
    if *common == next {
        *still_common = true;
    } else {
        mixed.push(key.to_string());
        *common = None;
    }
}

// Seed the editor from N files: fold their tags down to what they share. A fold
// over file_tags rather than a second reader, for the reason given there.
//
// Agreement is judged on the strings the editor would show — file_tags' own norm()
// does the trimming — so two files whose artist differs only in trailing space
// agree, as the form would have it.
fn fold_common_tags(
    paths: &[String],
    progress: &dyn Fn(usize, usize),
) -> Result<CommonTags, String> {
    let Some((first, rest)) = paths.split_first() else {
        return Err("No tracks to edit.".to_string());
    };
    let total = paths.len();
    // One file is no fold and needs no digest: read its picture straight and skip
    // the re-encode at the end. The single-track editor takes this path.
    let mut common = file_tags(
        first,
        if rest.is_empty() {
            ArtworkRead::DataUrl
        } else {
            ArtworkRead::Digest
        },
    );
    let mut mixed: Vec<String> = Vec::new();
    progress(1, total);

    for (i, path) in rest.iter().enumerate() {
        let art_settled = mixed.iter().any(|k| k == "artwork");
        let next = file_tags(
            path,
            if art_settled {
                ArtworkRead::Skip
            } else {
                ArtworkRead::Digest
            },
        );

        let mut still_common = false;
        // `name` is the one field that isn't an Option, and it needs no special
        // case beyond that: any real selection disagrees on it and reports itself
        // mixed, which is exactly what the form's heading wants to hear.
        if !mixed.iter().any(|k| k == "name") {
            if common.name == next.name {
                still_common = true;
            } else {
                mixed.push("name".to_string());
                common.name = String::new();
            }
        }
        // Short handles, only so the twelve fields below stay one line each.
        let m = &mut mixed;
        let sc = &mut still_common;
        merge_field("title", &mut common.title, next.title, m, sc);
        merge_field("artist", &mut common.artist, next.artist, m, sc);
        merge_field("album", &mut common.album, next.album, m, sc);
        merge_field(
            "albumArtist",
            &mut common.album_artist,
            next.album_artist,
            m,
            sc,
        );
        merge_field("disc", &mut common.disc, next.disc, m, sc);
        merge_field("discTotal", &mut common.disc_total, next.disc_total, m, sc);
        merge_field("track", &mut common.track, next.track, m, sc);
        merge_field(
            "trackTotal",
            &mut common.track_total,
            next.track_total,
            m,
            sc,
        );
        merge_field("year", &mut common.year, next.year, m, sc);
        merge_field("genre", &mut common.genre, next.genre, m, sc);
        merge_field("comment", &mut common.comment, next.comment, m, sc);
        merge_field("artwork", &mut common.artwork, next.artwork, m, sc);

        // Nothing left to learn once every field disagrees, so the rest of the
        // selection need not be opened at all — worth the three lines on a large,
        // heterogeneous one. The label is told the whole list is done, because for
        // its purposes it is.
        if !still_common {
            progress(total, total);
            break;
        }
        progress(i + 2, total);
    }

    // The fold compared digests to keep N covers off the CPU; the form needs the
    // picture. Encode the one that survived — the files agree on it, so the first
    // one's is theirs.
    if !rest.is_empty() && common.artwork.is_some() {
        common.artwork = art_data_url(Path::new(first));
    }
    Ok(CommonTags { common, mixed })
}

// Seed the metadata editor over a selection. Off the UI thread for two reasons:
// N lofty parses is a multi-second read at a few hundred files, and reading a
// dataless file would *download* it (see dataless.rs) — the caller keeps cloud
// files out, but not on this thread's good behaviour.
//
// `generation` is the same frontend-minted batch id the write takes, stamped onto
// every progress event so a label can ignore a fold that isn't its own: start on
// 300 files, escape, open on 3, and without it the new form counts to 300. There
// is no cancel to go with it — escaping the form leaves the fold running to the
// end of its list, which is bounded, touches nothing, and is then never heard
// from again.
#[tauri::command]
async fn read_common_tags(
    paths: Vec<String>,
    generation: u64,
    app: AppHandle,
) -> Result<CommonTags, String> {
    tauri::async_runtime::spawn_blocking(move || {
        fold_common_tags(&paths, &|done, total| {
            let _ = app.emit(
                "tag-read-progress",
                TagProgress {
                    generation,
                    done,
                    total,
                },
            );
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

// Ceiling on a picture the editor will embed. Separate from the stream-image cap
// despite matching it today: a station image is fetched into the DOM and can be
// dropped, while this is copied into the audio file itself and into every backup
// of it, so the two limits answer to different things and shouldn't drift by
// accident.
const MAX_EMBEDDED_ART_BYTES: u64 = 10 * 1024 * 1024;

// Read a picked image file for the editor's artwork well: validates it the same
// way the save will (lofty sniffs the format from the bytes, so the extension is
// never trusted) and hands back a data URL to preview. Doing both here is the
// point — a file that previews is a file that will save, so a bad pick is caught
// at the picker instead of blowing up the write. The messages are user-facing.
#[tauri::command]
fn read_artwork_file(path: String) -> Result<String, String> {
    let p = PathBuf::from(&path);
    let meta = std::fs::metadata(&p).map_err(|e| format!("Couldn't read that file: {}", e))?;
    if meta.len() > MAX_EMBEDDED_ART_BYTES {
        return Err(format!(
            "That image is too large to embed (limit {} MB).",
            MAX_EMBEDDED_ART_BYTES / (1024 * 1024)
        ));
    }
    let pic = read_picture(&p)?;
    let mime = pic.mime_type().map(|m| m.as_str()).unwrap_or("image/jpeg");
    let encoded = base64::engine::general_purpose::STANDARD.encode(pic.data());
    Ok(format!("data:{};base64,{}", mime, encoded))
}

// A picked file as a lofty Picture, typed as the front cover. from_reader is what
// decides whether this is an image at all: it sniffs the signature and rejects
// anything that isn't one of the formats a tag can carry.
fn read_picture(path: &std::path::Path) -> Result<lofty::picture::Picture, String> {
    let mut file =
        std::fs::File::open(path).map_err(|e| format!("Couldn't read that file: {}", e))?;
    let mut pic = lofty::picture::Picture::from_reader(&mut file)
        .map_err(|_| "That file isn't a PNG, JPEG, GIF, BMP or TIFF image.".to_string())?;
    pic.set_pic_type(lofty::picture::PictureType::CoverFront);
    Ok(pic)
}

// What the metadata editor sends back: a **patch**, not a description of the
// file. Three states per field, which is what lets one form edit any number of
// files at once:
//
//   key absent   leave this tag alone
//   null         clear this tag
//   a value      set this tag
//
// The double Option carries that: `None` is the absent key, `Some(None)` the
// explicit null. Absent-means-untouched is why a save can no longer flatten a
// field the user never looked at — an ID3 full date (1979-10-05) now survives an
// unrelated edit instead of being rewritten as its year (see apply_tag_edits).
//
// Nothing downstream may read this to learn what a track now holds: with most
// keys absent it describes the edit and not the file. The tag itself, after
// apply_tag_edits, is what answers that (see cached_fields).
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct TagEdits {
    #[serde(default, deserialize_with = "double_option")]
    title: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    artist: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    album_artist: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    album: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    disc: Option<Option<u32>>,
    #[serde(default, deserialize_with = "double_option")]
    disc_total: Option<Option<u32>>,
    #[serde(default, deserialize_with = "double_option")]
    track: Option<Option<u32>>,
    #[serde(default, deserialize_with = "double_option")]
    track_total: Option<Option<u32>>,
    #[serde(default, deserialize_with = "double_option")]
    year: Option<Option<u32>>,
    #[serde(default, deserialize_with = "double_option")]
    genre: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    comment: Option<Option<String>>,
    // Absent for a save that doesn't touch the picture, which is most of them —
    // hence the default. A chosen image rides as the path the picker returned
    // rather than as its bytes: the preview already crossed the IPC boundary once
    // as a data URL, and sending a 10 MB cover back to be written would be the
    // same megabytes a second time.
    #[serde(default)]
    artwork: ArtworkEdit,
}

// Serde reads a present `null` and an absent key as the same `None` on an
// Option, which is exactly the distinction a patch is made of. Deserializing
// into the inner Option and wrapping the result in Some makes the two differ:
// the field's own `#[serde(default)]` supplies `None` when the key is absent,
// and this is only ever called when it is present.
fn double_option<'de, D, T>(de: D) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Deserialize::deserialize(de).map(Some)
}

// The three things a save can do to a file's picture.
#[derive(Deserialize, Default)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum ArtworkEdit {
    // Leave whatever the file has. The editor sends this unless the user used
    // the well, so a tag edit never rewrites (or re-compresses) the cover.
    #[default]
    Keep,
    Remove,
    Set {
        path: String,
    },
}

// The same three, once the picked file has been read and validated — so the
// fallible part happens before the audio file is opened.
enum ArtworkChange {
    Keep,
    Remove,
    Set(lofty::picture::Picture),
}

impl ArtworkEdit {
    fn resolve(&self) -> Result<ArtworkChange, String> {
        match self {
            ArtworkEdit::Keep => Ok(ArtworkChange::Keep),
            ArtworkEdit::Remove => Ok(ArtworkChange::Remove),
            ArtworkEdit::Set { path } => Ok(ArtworkChange::Set(read_picture(
                std::path::Path::new(path),
            )?)),
        }
    }
}

impl TagEdits {
    // Trim every text field and turn what's left of an empty one into a clear, so
    // "   " strips a tag rather than writing whitespace into it. Trims through
    // both layers: an absent key stays absent (`None`), while `Some(Some("  "))`
    // becomes `Some(None)`. Symmetric with the norm() read_file_tags seeds the
    // form through, so agreement is judged on the same strings the editor shows.
    fn normalized(self) -> TagEdits {
        let norm = |v: Option<Option<String>>| {
            v.map(|inner| {
                inner
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
            })
        };
        TagEdits {
            title: norm(self.title),
            artist: norm(self.artist),
            album_artist: norm(self.album_artist),
            album: norm(self.album),
            genre: norm(self.genre),
            comment: norm(self.comment),
            ..self
        }
    }
}

// Apply the patch to `tag`. Split out of write_tags so the mapping from "the form
// said this" to "the file says that" can be tested without a file on disk — it is
// the half of the command with all the per-field decisions in it.
//
// Three arms per field, straight off TagEdits: an absent key is left alone, a null
// removes the item, a value sets it. A field the editor does NOT offer (a composer,
// a grouping, any tag another editor wrote) survives for the same reason an
// untouched one does — nothing here rebuilds the tag, it only touches the items the
// patch names.
fn apply_tag_edits(tag: &mut lofty::tag::Tag, edits: &TagEdits, artwork: &ArtworkChange) {
    match &edits.title {
        None => {}
        Some(None) => tag.remove_title(),
        Some(Some(v)) => tag.set_title(v.clone()),
    }
    match &edits.artist {
        None => {}
        Some(None) => tag.remove_artist(),
        Some(Some(v)) => tag.set_artist(v.clone()),
    }
    match &edits.album {
        None => {}
        Some(None) => tag.remove_album(),
        Some(Some(v)) => tag.set_album(v.clone()),
    }
    // No Accessor shortcut for album artist (see read_file_tags): set/clear by key.
    match &edits.album_artist {
        None => {}
        Some(None) => tag.remove_key(&lofty::tag::ItemKey::AlbumArtist),
        Some(Some(v)) => {
            tag.insert_text(lofty::tag::ItemKey::AlbumArtist, v.clone());
        }
    }
    match &edits.genre {
        None => {}
        Some(None) => tag.remove_genre(),
        Some(Some(v)) => tag.set_genre(v.clone()),
    }
    match &edits.comment {
        None => {}
        Some(None) => tag.remove_comment(),
        Some(Some(v)) => tag.set_comment(v.clone()),
    }
    match edits.disc {
        None => {}
        Some(None) => tag.remove_disk(),
        Some(Some(d)) => tag.set_disk(d),
    }
    match edits.disc_total {
        None => {}
        Some(None) => tag.remove_disk_total(),
        Some(Some(d)) => tag.set_disk_total(d),
    }
    match edits.track {
        None => {}
        Some(None) => tag.remove_track(),
        Some(Some(t)) => tag.set_track(t),
    }
    match edits.track_total {
        None => {}
        Some(None) => tag.remove_track_total(),
        Some(Some(t)) => tag.set_track_total(t),
    }
    // ID3v2 keeps the year inside the recording-time frame, so a file carrying a
    // full date (1979-10-05) shows in the editor as the year alone — and writing
    // that back destroys the month and day. Under a patch that only happens when
    // the user actually typed in the Year box: an untouched Year is an absent key,
    // and the date survives the save untouched.
    match edits.year {
        None => {}
        Some(None) => tag.remove_year(),
        Some(Some(y)) => tag.set_year(y),
    }
    // Picture 0 and only picture 0 — the one the well showed, and the one
    // picture_data_url hands the hero. A file with a back cover or a band photo
    // behind it keeps them: the editor never displayed those, so a save has no
    // business dropping them.
    match artwork {
        ArtworkChange::Keep => {}
        ArtworkChange::Remove => {
            if tag.picture_count() > 0 {
                tag.remove_picture(0);
            }
        }
        // By reference, and cloned here: one resolved image is stamped into every
        // file of a batch, so the Picture can't be moved out of the change.
        ArtworkChange::Set(pic) => tag.set_picture(0, pic.clone()),
    }
}

// The eight tag fields the tracks table caches, read back off the tag write_tags
// has just mutated. The patch describes the edit; the tag describes the file — a
// patch that carries only `album` says nothing about the title, so building the
// cache row or the returned FileEntry from `edits` would null out seven columns
// per file and hand the frontend rows that had lost their titles. Read the file
// instead, which is also more honest than the old version for a single track: it
// reports what the file says rather than what the form said.
//
// `modified` is deliberately not here. It comes from the post-write re-stat, not
// from a tag, and it is the whole reason applyTagUpdate can patch the Date
// Modified cell instead of waiting for a rescan the mtime/size pre-sync has made
// a no-op. Nine fields leave write_tags; these eight come off the tag.
fn cached_fields(tag: &lofty::tag::Tag) -> FileEntry {
    let norm = |v: Option<std::borrow::Cow<'_, str>>| {
        v.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
    };
    FileEntry {
        title: norm(tag.title()),
        artist: norm(tag.artist()),
        album: norm(tag.album()),
        album_artist: norm(
            tag.get_string(&lofty::tag::ItemKey::AlbumArtist)
                .map(std::borrow::Cow::Borrowed),
        ),
        disc: tag.disk(),
        track: tag.track(),
        year: tag.year(),
        genre: norm(tag.genre()),
        ..Default::default()
    }
}

// One file's worth of a successful save: the path it was written to, and what the
// file says afterwards. `path` is explicit because a FileEntry carries a `name`
// and not a path, and the caller must not have to re-derive which entry is which
// from the input order minus the failures. Also applyTagUpdates' own entry shape.
#[derive(Serialize)]
struct WrittenTrack {
    path: String,
    tags: FileEntry,
}

// One file the batch could not finish. `stale` separates the two kinds: a file
// that was not written at all (locked, unreadable, held by the decoder) from one
// that was written correctly but whose library row could not be updated. The
// second is not a save failure — telling the user a save failed when it didn't is
// the one report worse than no report — so the form counts it with the saved and
// says the list will catch up.
//
// A file in here with `stale: false` is a file still holding exactly what it held
// before Save was pressed. write_one_file stages every write on a copy and renames
// it into place, so "couldn't be written" means untouched rather than damaged, and
// the form is free to say so.
#[derive(Serialize)]
struct FailedWrite {
    path: String,
    message: String,
    stale: bool,
}

// Four outcomes, not two. A path the loop never reached because the user pressed
// Stop is neither ok nor failed, and "Saved 12 of 300" reads as 288 errors unless
// the caller can tell which happened. `aborted` is the same distinction for the
// batch that gave up on its own.
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct TagWriteReport {
    ok: Vec<WrittenTrack>,
    failed: Vec<FailedWrite>,
    stopped: bool,
    // Set when the storage failed under the batch — a full disk, a read-only
    // mount, a drive pulled out — and the loop stopped rather than attempting the
    // rest. Every remaining path is untouched and unreported, which is only
    // legible if the caller is told why the counts don't add up. Carries the
    // failure that ended it, because "23 of 300" with no reason reads as a bug.
    aborted: Option<String>,
}

// Per-file progress for the editor's "Saving... 37 of 300" label, and for the
// "Reading 300 tracks..." one the bulk seed fills in behind. One payload, two
// events (`tag-write-progress`, `tag-read-progress`): the same three numbers said
// twice would drift. One event per file, unthrottled — 300 events over a run
// measured in seconds is nothing next to 300 file rewrites. `generation` is the
// frontend-minted batch id, so a label can ignore events that aren't its own.
#[derive(Serialize, Clone)]
struct TagProgress {
    generation: u64,
    done: usize,
    total: usize,
}

// The Stop button's reach into a running batch. Holds the generation the user
// asked to cancel; the loop compares it against its own and stops only on a
// match, so a cancel arriving late cannot kill the batch after the one it was
// aimed at. Zero means nothing has been cancelled — the frontend's counter starts
// at 1.
#[derive(Default)]
struct TagWriteCancel {
    generation: std::sync::atomic::AtomicU64,
}

// Stop a running tag write between files. Cancellation is never inside a file: a
// save already under way runs to completion. It is safe to stop one now — the
// write is staged on a copy and the track is only replaced by an atomic rename —
// but a half-tagged staged file is still wasted work, so the loop finishes the
// file it is on and checks between them.
#[tauri::command]
fn cancel_tag_write(generation: u64, cancel: State<'_, Arc<TagWriteCancel>>) {
    cancel
        .generation
        .store(generation, std::sync::atomic::Ordering::Relaxed);
}

// Is this the error that means another connection holds the write lock? A scan
// holds one transaction across its entire library walk, so this is what a save
// started during a scan hits — after waiting out the full 5 s busy_timeout.
fn is_sqlite_busy(e: &rusqlite::Error) -> bool {
    matches!(
        e,
        rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error {
                code: rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked,
                ..
            },
            _
        )
    )
}

// Keep one library row in step with the file just written. Only the fields the
// tracks table actually holds: the totals, the comment and the artwork are
// editable but uncached (see EditorTags), so there is nothing here for them.
//
// One UPDATE per file, from inside the loop — deferring them into a single
// transaction after the loop would make a failure all-or-nothing (three hundred
// files correctly rewritten and zero rows updated), and would leave the mtime/size
// pre-sync comparing every mid-loop rescan against a pre-edit row.
fn update_cached_row(
    conn: &Connection,
    path: &str,
    tags: &FileEntry,
    mtime: i64,
    size: i64,
) -> rusqlite::Result<usize> {
    conn.execute(
        "UPDATE tracks SET mtime = ?2, size = ?3, title = ?4, artist = ?5,
             album = ?6, album_artist = ?7, disc = ?8, track = ?9, year = ?10,
             genre = ?11 WHERE path = ?1",
        params![
            path,
            mtime,
            size,
            tags.title,
            tags.artist,
            tags.album,
            tags.album_artist,
            tags.disc,
            tags.track,
            tags.year,
            tags.genre
        ],
    )
}

// The batch itself: apply one patch to every path, keeping the cache in step.
//
// Everything the engine and the frontend own arrives as a closure so the loop can
// be tested with literals — the held set especially, which is read *per iteration*
// because nothing decided at submit can protect the back half of a batch:
// autoadvance can walk into file #37 while the loop is on #12.
//
// Two things end a batch early, and they are not the same: `cancelled` is the user
// pressing Stop, and a storage failure is the disk refusing everything that comes
// next (see WriteFailure). Both leave the untouched files unreported rather than
// counting them as errors.
fn write_tags_to_files(
    paths: &[String],
    edits: &TagEdits,
    artwork: &ArtworkChange,
    cache: &dyn Fn(&str, &FileEntry, i64, i64) -> rusqlite::Result<usize>,
    held: &dyn Fn() -> Vec<String>,
    cancelled: &dyn Fn() -> bool,
    progress: &dyn Fn(usize, usize),
) -> TagWriteReport {
    let mut report = TagWriteReport::default();
    // Latched on the first SQLITE_BUSY. One timeout means a scan holds the write
    // lock and will hold it for the rest of its walk, so every remaining file would
    // pay the full 5 s busy_timeout before failing the same way — 300 files is up
    // to 25 minutes of a loop sitting in the kernel with the label apparently
    // frozen. Stop attempting and mark the rest stale instead; the recovery is
    // identical either way, since a row that never got its UPDATE keeps its
    // pre-edit mtime and the next incremental scan re-reads it. Per batch, not
    // global: the next save tries again from scratch.
    let mut cache_locked = false;
    let total = paths.len();
    for (done, path) in paths.iter().enumerate() {
        if cancelled() {
            report.stopped = true;
            break;
        }
        let p = PathBuf::from(path);

        // Asked of the engine, now, for this file. The decode frontier runs ahead
        // of the audible track (gapless opens the next one early), so "the track
        // that is playing" is not the whole answer.
        if held().iter().any(|h| h == path) {
            report.failed.push(FailedWrite {
                path: path.clone(),
                message: "Can't write a track while it's playing".to_string(),
                stale: false,
            });
            progress(done + 1, total);
            continue;
        }

        let written = write_one_file(&p, edits, artwork);
        let (tags, mtime, size) = match written {
            Ok(v) => v,
            Err(failure) => {
                let fatal = failure.fatal;
                report.failed.push(FailedWrite {
                    path: path.clone(),
                    message: failure.message.clone(),
                    stale: false,
                });
                progress(done + 1, total);
                // The mount said no, so it will say no to all 287 files left.
                // Attempting them anyway is not harmless: each one first copies the
                // track to stage the write, so a full disk would be answered by
                // trying to fill it another 287 times, slowly, while the label
                // counts up as though something were being saved.
                if fatal {
                    report.aborted = Some(failure.message);
                    break;
                }
                continue;
            }
        };

        // The file is correct on disk from here on; what is left is the library
        // row (see update_cached_row). A row that could not be updated is its own
        // outcome, not a write failure.
        let synced = if cache_locked {
            Err("Saved the file, but the library list may be stale".to_string())
        } else {
            // Zero rows updated is not a failure: a file outside every library
            // root has no cached row to keep in step.
            cache(path, &tags, mtime, size).map(|_| ()).map_err(|e| {
                if is_sqlite_busy(&e) {
                    cache_locked = true;
                }
                log::error!("write_tags: cache update for {} failed: {e}", p.display());
                "Saved the file, but the library list may be stale".to_string()
            })
        };

        match synced {
            Ok(()) => report.ok.push(WrittenTrack {
                path: path.clone(),
                tags: FileEntry {
                    // The one column field an edit changes that the user didn't
                    // type. Writing tags rewrites the file, so every open row's Date
                    // Modified cell is stale the moment this returns; handing back
                    // the post-write mtime lets the caller patch it (see
                    // applyTagUpdate) instead of waiting for a rescan that the
                    // mtime/size pre-sync has deliberately made a no-op.
                    modified: Some(mtime),
                    ..tags
                },
            }),
            Err(message) => report.failed.push(FailedWrite {
                path: path.clone(),
                message,
                stale: true,
            }),
        }
        progress(done + 1, total);
    }
    report
}

// Why one file was not written, and whether the batch has any business trying the
// next one. A file that is unreadable, or a container lofty can't tag, is its own
// problem and the loop steps over it. A storage failure is the *mount* talking,
// and it will say the same thing to every file left in the batch — so it stops.
#[derive(Debug)]
struct WriteFailure {
    message: String,
    fatal: bool,
}

impl WriteFailure {
    fn io(context: &str, e: &std::io::Error) -> Self {
        WriteFailure {
            message: format!("{}: {}", context, e),
            fatal: is_storage_fatal(e),
        }
    }

    // A lofty error is only ever fatal to the batch when it is an io error
    // underneath — a malformed tag or an unsupported container says nothing about
    // the next file.
    fn lofty(context: &str, e: &lofty::error::LoftyError) -> Self {
        WriteFailure {
            message: format!("{}: {}", context, e),
            fatal: match e.kind() {
                lofty::error::ErrorKind::Io(io) => is_storage_fatal(io),
                _ => false,
            },
        }
    }
}

// Did the storage itself fail, rather than this one file? A full disk, a volume
// remounted read-only, a quota, or a drive pulled out mid-batch. std names the
// first three; the unplugged-drive errnos have no named ErrorKind and arrive as
// Uncategorized, so they are read off the raw number — EIO, ENXIO and ENODEV
// carry the same values on every unix this builds for.
fn is_storage_fatal(e: &std::io::Error) -> bool {
    use std::io::ErrorKind;
    if matches!(
        e.kind(),
        ErrorKind::StorageFull | ErrorKind::ReadOnlyFilesystem | ErrorKind::QuotaExceeded
    ) {
        return true;
    }
    #[cfg(unix)]
    {
        matches!(e.raw_os_error(), Some(5 | 6 | 19))
    }
    #[cfg(not(unix))]
    {
        false
    }
}

// Where a save is staged before it becomes the track. Next to the file, because
// rename is only atomic within one filesystem — a temp in /tmp would make the last
// step a cross-device copy, which is the thing this is all here to avoid.
//
// The name deliberately carries no audio extension: is_audio_path goes by
// extension alone and list_dir does not skip dotfiles, so a temp called
// `.track.mp3` would show up as a song in any scan that overlapped the save. lofty
// identifies a container by sniffing the bytes it is handed and never by the name
// (write_id3v2 builds its own Probe over the open file), so dropping the extension
// costs nothing.
fn temp_sibling(target: &Path) -> Result<PathBuf, std::io::Error> {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let dir = target.parent().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "no parent directory")
    })?;
    Ok(dir.join(format!(
        ".pudding-save-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    )))
}

// Deletes the staged copy on every way out of write_one_file except the one that
// renames it away. Without this a failed save leaves litter beside the track, and
// the next scan would be indexing half-written files.
struct StagedFile(PathBuf);

impl Drop for StagedFile {
    fn drop(&mut self) {
        // After a successful rename there is nothing at this path and the remove
        // fails with ENOENT, which is exactly the no-op wanted.
        let _ = std::fs::remove_file(&self.0);
    }
}

// Replace a file's entire contents without ever leaving it truncated: write the
// new bytes to a staged sibling, then rename that over the target. The same trade
// write_one_file makes, for callers that author a whole file rather than patching
// one — a plain `fs::write` truncates first, so anything that interrupts it (a full
// disk, a drive pulled mid-write, a force-quit, an OS crash) leaves an empty or
// half-written file where the user's data used to be. Rename is atomic, so the only
// two things this can leave on disk are the old contents and the new.
//
// Staged by *copying* the original first, exactly as write_one_file does, even
// though the caller already holds every byte and none of the copy's content is
// kept. The copy is not there for the bytes: the rename lands a brand-new inode,
// and everything hanging off the old one — Finder tags and comments and the rest
// of the xattrs, the ACL, the mode — belongs to the inode, not the name. Cloning
// the file and truncating the clone carries all of it across; creating the staged
// file from scratch would silently strip it on every save, and a playlist is saved
// on every drag. On APFS the clone costs no bytes, and a playlist is kilobytes
// anywhere else.
//
// A target that isn't there yet (a new playlist, the common case) has nothing to
// clone and nothing to inherit, so it starts from an empty file.
pub(crate) fn write_atomic(target: &Path, bytes: &[u8]) -> Result<(), std::io::Error> {
    write_atomic_checked(target, bytes, || Ok(()))
}

// Validate again after staging so an external edit during a slow save is refused.
pub(crate) fn write_atomic_checked(
    target: &Path,
    bytes: &[u8],
    before_replace: impl FnOnce() -> Result<(), std::io::Error>,
) -> Result<(), std::io::Error> {
    use std::io::Write;
    // Resolve the link first, for the reason write_one_file does: rename replaces a
    // *directory entry*, so renaming onto a symlink would leave a regular file where
    // the link was. A path that won't resolve — a file being created, the ordinary
    // case here — is used unchanged.
    let target = std::fs::canonicalize(target).unwrap_or_else(|_| target.to_path_buf());
    let staged = StagedFile(temp_sibling(&target)?);
    // Missing target: nothing to inherit, so skip the clone rather than fail. Any
    // other copy error is the write failing, and fails here with the original still
    // whole — which is the entire point of staging.
    match std::fs::copy(&target, &staged.0) {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e),
    }
    // `truncate`, because the clone is the old file: without it a new body shorter
    // than the old one would leave the old tail behind it.
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(&staged.0)?;
    f.write_all(bytes)?;
    // Flushed before the rename, not merely written. This is narrower than it
    // sounds: a full disk or any other failed write returns above and never reaches
    // the rename, and a force-quit leaves the page cache for the OS to flush. What
    // it buys is the kernel panic and the power cut, where the rename could
    // otherwise be on disk ahead of the bytes it publishes — the old file gone and
    // the new one arbitrarily short.
    //
    // fsync(2), not F_FULLFSYNC: this flushes to the device but doesn't force the
    // drive's own cache, so a power cut in that last window can still lose the tail.
    // Forcing the cache costs tens of milliseconds, and every curation autosaves
    // through here — not a trade worth making against the case an autosave is
    // already re-derivable from.
    f.sync_all()?;
    drop(f);
    before_replace()?;
    std::fs::rename(&staged.0, &target)
}

// Never retry a failed staged write by truncating the original. A file-only
// sandbox grant or an unwritable directory must fail safely too.
pub(crate) fn write_durably(target: &Path, bytes: &[u8]) -> Result<(), std::io::Error> {
    write_atomic(target, bytes).map_err(safe_save_error)
}

fn safe_save_error(e: std::io::Error) -> std::io::Error {
    if is_staging_denied(&e) {
        std::io::Error::new(e.kind(), format!(
            "Couldn't safely save the file; the original is unchanged. Allow access to its folder or choose a writable folder. ({e})"
        ))
    } else {
        e
    }
}

// Permission failures can mean a file-only sandbox grant, directory mode bits,
// or a read-only volume. All are refusals, never permission to truncate in place.
fn is_staging_denied(e: &std::io::Error) -> bool {
    use std::io::ErrorKind;
    if matches!(
        e.kind(),
        ErrorKind::PermissionDenied | ErrorKind::ReadOnlyFilesystem
    ) {
        return true;
    }
    #[cfg(unix)]
    {
        matches!(e.raw_os_error(), Some(1 | 13 | 30))
    }
    #[cfg(not(unix))]
    {
        false
    }
}

// One file: open, patch, save, re-stat, read back. Returns what the file says
// afterwards (read off the mutated tag, never off the patch — see cached_fields)
// along with the post-write mtime and size. Mirrors read_file_tags in mutating the
// *primary* tag, creating one of the container's native type when the file is
// untagged.
fn write_one_file(
    p: &Path,
    edits: &TagEdits,
    artwork: &ArtworkChange,
) -> Result<(FileEntry, i64, i64), WriteFailure> {
    // Resolve the link first. This save ends in a rename, and rename replaces a
    // *directory entry*: renaming onto a symlink would leave a regular file where
    // the link was and strand the track it pointed at. Canonicalizing puts the
    // copy, the tagging and the rename all on the real file. A path that won't
    // resolve is handed on unchanged, for open_tagged to reject with its own
    // message.
    let target = std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());

    let mut tagged = open_tagged(&target, TAGS_ONLY).map_err(|e| {
        log::error!("write_tags: reading {} failed: {e}", target.display());
        WriteFailure::lofty("Couldn't read that file", &e)
    })?;

    // Untagged files have no tag to mutate; give them one of the container's
    // native type (ID3v2 for MP3, MP4 atoms for m4a, Vorbis comments for FLAC...).
    //
    // Seeded from whatever tag the file does carry, because that is the tag the
    // user was just looking at: file_tags reads `primary_tag().or_else(first_tag)`,
    // so an MP3 carrying nothing but ID3v1 — an ordinary thing in a library ripped
    // before about 2005 — seeds the form from ID3v1 while the save lands on a
    // brand-new ID3v2. Starting that new tag empty made a title-only edit write a
    // tag holding nothing but the title, and being primary it then shadowed the
    // artist and album the form had shown a second earlier. re_map keeps what the
    // new type can carry, drops what it can't, and leaves the pictures alone.
    //
    // The old tag stays where it is. It is redundant once the primary carries the
    // same values, but stripping tags is not what Save was asked to do, and every
    // reader — this app included — prefers the primary one.
    if tagged.primary_tag_mut().is_none() {
        let tag_type = tagged.primary_tag_type();
        let mut seed = tagged
            .first_tag()
            .cloned()
            .unwrap_or_else(|| lofty::tag::Tag::new(tag_type));
        seed.re_map(tag_type);
        tagged.insert_tag(seed);
    }
    let tag = tagged
        .primary_tag_mut()
        .expect("primary tag present (inserted above when absent)");

    apply_tag_edits(tag, edits, artwork);
    let mut tags = cached_fields(tag);
    // From the path the caller gave, not the canonicalized one: a symlinked track
    // is its own row under its own name, and the library shows the name the user
    // has for it.
    tags.name = p
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();

    // Stage the write on a copy, then rename it over the original. lofty rewrites
    // a file where it stands: for ID3v2 it reads the audio into memory, truncates
    // the file to zero bytes and writes the whole thing back. A save interrupted
    // anywhere between that truncate and the last byte leaves an empty or
    // half-written file where a song used to be — a full disk does it, so does a
    // drive pulled mid-batch, a force-quit, or a power cut. Rename is atomic, so
    // the only two things this can leave on disk are the old file and the new one.
    //
    // On APFS the copy is a clone: no second copy of the bytes, and the xattrs,
    // ACLs and Finder tags come along with it. Elsewhere it is a real copy, which
    // costs the track's own size in temporary space for the length of one save.
    // That is the price of never destroying a file, and it is worth it.
    //
    // It does mean a save now needs a writable *directory* and not just a writable
    // file, so a track sitting in a read-only folder can no longer be tagged where
    // it once could. That case is close to imaginary in a music library, and it
    // fails cleanly with the file intact — which is the trade being made.
    let staged = StagedFile(
        temp_sibling(&target).map_err(|e| WriteFailure::io("Couldn't save the tags", &e))?,
    );
    std::fs::copy(&target, &staged.0).map_err(|e| {
        log::error!("write_tags: staging {} failed: {e}", target.display());
        WriteFailure::io("Couldn't save the tags", &e)
    })?;

    tagged
        .save_to_path(&staged.0, lofty::config::WriteOptions::default())
        .map_err(|e| {
            // The frontend shows this string in the form; the log keeps the path,
            // which the form has no room for.
            log::error!("write_tags: saving {} failed: {e}", target.display());
            WriteFailure::lofty("Couldn't save the tags", &e)
        })?;

    // Lofty has closed its writer, but the bytes can still be in the page cache.
    // Flush before publishing the replacement, just as write_atomic_checked does.
    std::fs::OpenOptions::new()
        .write(true)
        .open(&staged.0)
        .and_then(|f| f.sync_all())
        .map_err(|e| {
            log::error!("write_tags: flushing {} failed: {e}", target.display());
            WriteFailure::io("Couldn't save the tags", &e)
        })?;

    // The staged copy is a correct, complete track carrying the new tags. This is
    // the instant it becomes the file.
    std::fs::rename(&staged.0, &target).map_err(|e| {
        log::error!("write_tags: replacing {} failed: {e}", target.display());
        WriteFailure::io("Couldn't save the tags", &e)
    })?;

    // Re-stat after the write so the cached mtime/size match the file lofty just
    // rewrote. The incremental scan skips rows whose mtime+size are unchanged, so
    // recording the post-write values makes the watcher's self-write event a
    // no-op instead of a redundant re-read.
    let (mtime, size) = std::fs::metadata(&target)
        .map(|m| {
            let mtime = m
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);
            (mtime, m.len() as i64)
        })
        .unwrap_or((0, 0));
    Ok((tags, mtime, size))
}

// Apply one patch from the metadata editor to any number of files, and sync each
// library cache row so the Songs/Artists/Albums views reflect the change without
// waiting for the debounced watcher rescan. `duration` comes from the decoded
// audio, not a tag, so it is neither shown nor written here.
//
// `tags` is a patch: absent keys are left alone on every file (see TagEdits). One
// bad file does not sink the rest — every path gets its own outcome in the report.
//
// The file the audio engine holds open is refused here rather than trusted to the
// frontend's gate: the decoder reads ahead across track boundaries, and a batch
// takes long enough for playback to walk into a file the loop has not reached yet.
// The check is per file and live, which narrows that window without closing it.
// The save itself renames a staged copy over the track, so the worst a lost race
// costs is a decoder reading from the replaced file — not a damaged one.
#[tauri::command]
async fn write_tags(
    paths: Vec<String>,
    tags: TagEdits,
    generation: u64,
    db: State<'_, DbHandle>,
    engine: State<'_, audio::AudioEngine>,
    cancel: State<'_, Arc<TagWriteCancel>>,
    app: AppHandle,
) -> Result<TagWriteReport, String> {
    // lofty read/save is blocking file I/O and the cache UPDATE takes the writer
    // mutex, so run the whole thing off the UI thread.
    let write_conn = db.conn.clone();
    let held = engine.held_probe();
    let cancel = Arc::clone(&cancel);
    tauri::async_runtime::spawn_blocking(move || {
        // Resolve the picked image once, before touching any audio file: a file
        // that isn't an image must fail with the picker's own message and leave
        // every track untouched, not half-written. One read and one validation for
        // the whole batch, however many files it stamps the cover into.
        let artwork = tags.artwork.resolve()?;
        let edits = tags.normalized();

        Ok(write_tags_to_files(
            &paths,
            &edits,
            &artwork,
            &|path, tags, mtime, size| {
                let conn = write_conn.lock().unwrap_or_else(|e| e.into_inner());
                update_cached_row(&conn, path, tags, mtime, size)
            },
            &|| held.held_paths(),
            &|| cancel.generation.load(std::sync::atomic::Ordering::Relaxed) == generation,
            &|done, total| {
                let _ = app.emit(
                    "tag-write-progress",
                    TagProgress {
                        generation,
                        done,
                        total,
                    },
                );
            },
        ))
    })
    .await
    .map_err(|e| e.to_string())?
}

// === Audio playback commands ===
//
// The native audio engine runs on its own threads (output, decode, position).
// These commands are thin wrappers that forward to its command channel; they
// return immediately and do not block the IPC worker.

#[tauri::command]
fn audio_play(
    tracks: Vec<String>,
    start_index: usize,
    token: u64,
    engine: State<audio::AudioEngine>,
) {
    let paths: Vec<PathBuf> = tracks.into_iter().map(PathBuf::from).collect();
    engine.send(audio::Command::Play {
        tracks: paths,
        start_index,
        token,
    });
}

// Internet radio: the engine owns the HTTP connection, ICY metadata, and
// reconnect policy. Pause disconnects; resume rejoins the live edge.
#[tauri::command]
fn audio_play_stream(url: String, token: u64, engine: State<audio::AudioEngine>) {
    engine.send(audio::Command::PlayStream { url, token });
}

#[tauri::command]
fn audio_toggle_pause(engine: State<audio::AudioEngine>) {
    engine.send(audio::Command::TogglePause);
}

#[tauri::command]
fn audio_seek(seconds: f64, engine: State<audio::AudioEngine>) {
    engine.send(audio::Command::Seek(seconds));
}

// Drop the queued tracks after the current one so the frontend can pick the
// next track itself (shuffle / repeat-one) without restarting what's playing.
#[tauri::command]
fn audio_clear_upcoming(engine: State<audio::AudioEngine>) {
    engine.send(audio::Command::ClearUpcoming);
}

// Sync the global "Autoadvance" checkmark to the frontend's persisted setting.
// Called once at startup after the store is read, so a preference the user turned
// off in a prior session shows correctly in the menu.
#[tauri::command]
fn set_autoadvance_checked(menu: State<PlaybackMenu>, enabled: bool) {
    let _ = menu.autoadvance.set_checked(enabled);
}

// Sync the Shuffle checkmark. Called whenever shuffle toggles (toolbar or menu)
// and once at startup, so the menu always mirrors the frontend's state.
#[tauri::command]
fn set_shuffle_checked(menu: State<PlaybackMenu>, shuffle: bool) {
    let _ = menu.shuffle.set_checked(shuffle);
}

// Sync the three Repeat items radio-style: exactly one is checked ("off"/"all"/
// "one"). Called whenever the repeat mode changes and once at startup.
#[tauri::command]
fn set_repeat_checked(menu: State<PlaybackMenu>, mode: String) {
    let _ = menu.repeat_off.set_checked(mode == "off");
    let _ = menu.repeat_all.set_checked(mode == "all");
    let _ = menu.repeat_one.set_checked(mode == "one");
}

// Sync the Mute checkmark (checked when the volume is zeroed).
#[tauri::command]
fn set_mute_checked(menu: State<PlaybackMenu>, muted: bool) {
    let _ = menu.mute.set_checked(muted);
}

// Sync the three ReplayGain items radio-style ("off"/"track"/"album"). Called
// whenever the mode changes and once at startup, mirroring the Repeat trio.
#[tauri::command]
fn set_replaygain_checked(menu: State<PlaybackMenu>, mode: String) {
    let _ = menu.rg_off.set_checked(mode == "off");
    let _ = menu.rg_track.set_checked(mode == "track");
    let _ = menu.rg_album.set_checked(mode == "album");
}

// Sync the "Match Source Sample Rate" checkmark to the frontend's
// persisted setting, at startup and after each change.
#[tauri::command]
fn set_follow_sample_rate_checked(menu: State<PlaybackMenu>, enabled: bool) {
    let _ = menu.follow_sample_rate.set_checked(enabled);
}

// Sync the "Mini Player" checkmark to the current mode (the frontend derives it
// from the viewport height, on startup and on every resize).
#[tauri::command]
fn set_miniplayer_checked(menu: State<WindowMenu>, mini: bool) {
    let _ = menu.miniplayer.set_checked(mini);
}

// Sync the View ▸ Visualizer checkmark: checked while the visualizer is the
// active hero view. Called whenever the view changes (menu, topbar button, or
// startup restore).
#[tauri::command]
fn set_now_playing_view_checked(menu: State<ViewMenu>, view: String) {
    let _ = menu.np_view_visualizer.set_checked(view == "visualizer");
}

// Reflect Zen Mode's on/off state in the View ▸ Zen Mode checkmark. Called
// whenever the frontend signal changes (menu, ⌘⇧F, or Escape).
#[tauri::command]
fn set_zen_mode_checked(menu: State<ViewMenu>, on: bool) {
    let _ = menu.zen_mode.set_checked(on);
}

// Enable/disable "Save Queue as Playlist" (⌘S). The frontend calls this as playback
// state changes: only an ephemeral queue that's the active pool can be
// converted (a saved playlist already autosaves, nothing else is convertible).
#[tauri::command]
fn set_save_playlist_enabled(menu: State<PlaylistMenu>, enabled: bool) {
    let _ = menu.save_as.set_enabled(enabled);
}

// Toggle "Move Playlist File..." as the open playlist (browsed or playing) comes
// and goes: there's no file to relocate when no playlist is open.
#[tauri::command]
fn set_move_playlist_enabled(menu: State<PlaylistMenu>, enabled: bool) {
    let _ = menu.move_file.set_enabled(enabled);
}

// Enable/disable Edit ▸ Undo / Redo. The frontend calls this as its curation
// history grows/shrinks and as focus enters/leaves a text field: each is enabled
// when a field is focused (so ⌘Z reaches the frontend to drive text undo) or when
// there's a curation to undo/redo.
#[tauri::command]
fn set_edit_undo_state(menu: State<EditMenu>, undo: bool, redo: bool) {
    let _ = menu.undo.set_enabled(undo);
    let _ = menu.redo.set_enabled(redo);
}

// Receive the Open Recent row glyphs (base64 PNG, one per kind). Called once at
// boot, before the first set_recent_items, which is what draws them.
#[tauri::command]
fn set_recent_icons(
    icons: State<RecentIcons>,
    playlist: String,
    track: String,
) -> Result<(), String> {
    let decode = |b64: &str| {
        base64::engine::general_purpose::STANDARD
            .decode(b64)
            .map_err(|e| e.to_string())
    };
    let (playlist, track) = (decode(&playlist)?, decode(&track)?);
    let mut png = icons.png.lock().map_err(|_| "recent icons poisoned".to_string())?;
    png.insert("playlist".to_string(), playlist);
    png.insert("track".to_string(), track);
    Ok(())
}

// Rebuild the Open Recent submenu from the frontend's persisted recents
// (most-recent first). Each row's id carries its path (recent:<path>) so the
// click handler can relay it; an empty list shows a disabled placeholder. The
// icon pass runs last, over the rows this just built.
#[tauri::command]
fn set_recent_items(
    app: AppHandle,
    menu: State<PlaylistMenu>,
    icons: State<RecentIcons>,
    items: Vec<RecentItem>,
) -> Result<(), String> {
    let sub = &menu.recent;
    let count = sub.items().map_err(|e| e.to_string())?.len();
    for _ in 0..count {
        sub.remove_at(0).map_err(|e| e.to_string())?;
    }
    if items.is_empty() {
        let empty = MenuItemBuilder::with_id("recent-empty", "No Recent Items")
            .enabled(false)
            .build(&app)
            .map_err(|e| e.to_string())?;
        sub.append(&empty).map_err(|e| e.to_string())?;
        return Ok(());
    }
    for it in &items {
        let item = MenuItemBuilder::with_id(format!("recent:{}", it.path), &it.name)
            .build(&app)
            .map_err(|e| e.to_string())?;
        sub.append(&item).map_err(|e| e.to_string())?;
    }
    let sep = PredefinedMenuItem::separator(&app).map_err(|e| e.to_string())?;
    sub.append(&sep).map_err(|e| e.to_string())?;
    let clear = MenuItemBuilder::with_id("recent-clear", "Clear Menu")
        .build(&app)
        .map_err(|e| e.to_string())?;
    sub.append(&clear).map_err(|e| e.to_string())?;
    #[cfg(target_os = "macos")]
    set_recent_item_icons(&items, &icons);
    Ok(())
}

// Draw the app's own playlist / track glyph beside every Open Recent row, so the
// two kinds sharing one list are told apart at a glance, in the same drawing the
// tree uses for them.
//
// Done by hand against AppKit rather than through muda's IconMenuItem, because
// that never marks the NSImage as a template: macOS would paint our glyph in the
// fixed colors it was rasterized with, leaving it dark against the blue highlight
// and wrong in dark mode. Marked as a template, the image is drawn from its alpha
// alone and AppKit tints it with the row's text color — the same relationship the
// CSS mask has with `background-color` in the tree.
//
// Reaching the NSMenuItems means walking down from NSApp: muda hands out no
// native handle, so match on the two submenu titles, which are ours (see the menu
// build in setup) and therefore stable. Every bail leaves rows that are perfectly
// usable, just unadorned.
#[cfg(target_os = "macos")]
fn set_recent_item_icons(items: &[RecentItem], icons: &RecentIcons) {
    use objc2::AllocAnyThread;
    use objc2_app_kit::{NSApplication, NSImage, NSMenu};
    use objc2_foundation::{MainThreadMarker, NSData, NSSize};

    // The bitmaps are 2x (see ICON_PX); declaring the logical size scales them
    // back down and lets AppKit spend the extra pixels on a retina display.
    const ICON_POINTS: f64 = 16.0;

    fn submenu_titled(menu: &NSMenu, title: &str) -> Option<objc2::rc::Retained<NSMenu>> {
        (0..menu.numberOfItems())
            .filter_map(|i| menu.itemAtIndex(i))
            .filter_map(|item| item.submenu())
            .find(|sub| sub.title().to_string() == title)
    }

    let Ok(png) = icons.png.lock() else {
        return;
    };
    if png.is_empty() {
        return; // boot hasn't handed them over yet; the next sync will draw them
    }
    // AppKit is main-thread-only; a sync command lands there (same thread that
    // just mutated the submenu above), and the marker checks that rather than
    // assuming it. A miss below is silent and cosmetic, so say so in the log.
    let recent = MainThreadMarker::new()
        .and_then(|mtm| NSApplication::sharedApplication(mtm).mainMenu())
        .and_then(|main_menu| submenu_titled(&main_menu, "File"))
        .and_then(|file| submenu_titled(&file, "Open Recent"));
    let Some(recent) = recent else {
        log::warn!("could not reach the Open Recent submenu; rows drawn without icons");
        return;
    };
    // Index-aligned with the loop above: rows first, then the separator and Clear
    // Menu, which get no icon.
    for (i, it) in items.iter().enumerate() {
        let Some(row) = recent.itemAtIndex(i as isize) else {
            continue;
        };
        let kind = match it.kind.as_deref() {
            Some("track") => "track",
            _ => "playlist",
        };
        let Some(bytes) = png.get(kind) else {
            continue;
        };
        let Some(image) = NSImage::initWithData(NSImage::alloc(), &NSData::with_bytes(bytes))
        else {
            continue;
        };
        image.setSize(NSSize::new(ICON_POINTS, ICON_POINTS));
        image.setTemplate(true);
        row.setImage(Some(&image));
    }
}

// Append tracks to the tail of the current queue without disturbing the
// playing track (see Command::Append). Backs the "Add to queue" action.
#[tauri::command]
fn audio_append(tracks: Vec<String>, engine: State<audio::AudioEngine>) {
    let paths: Vec<PathBuf> = tracks.into_iter().map(PathBuf::from).collect();
    engine.send(audio::Command::Append { tracks: paths });
}

// Tear down playback entirely (see Command::Stop). Backs the "Clear queue"
// action, which drops the queue and stops the music.
#[tauri::command]
fn audio_stop(token: u64, engine: State<audio::AudioEngine>) {
    engine.send(audio::Command::Stop { token });
}

#[tauri::command]
fn audio_set_volume(volume: f32, engine: State<audio::AudioEngine>) {
    engine.set_volume(volume);
}

// Push the equalizer state to the engine. `preamp` and `gains` are in dB; the
// frontend sends the full band set on every slider move. Applied in the audio
// callback, so the change is audible immediately.
#[tauri::command]
fn audio_set_eq(enabled: bool, preamp: f32, gains: Vec<f32>, engine: State<audio::AudioEngine>) {
    engine.set_eq(enabled, preamp, &gains);
}

// Set the ReplayGain (volume normalization) mode. The frontend owns the setting
// (persisted in its store, menu radio items), and sends "off" / "track" / "album";
// the engine reads it the next time it opens a track. See audio::open_track.
#[tauri::command]
fn audio_set_replaygain(mode: String, engine: State<audio::AudioEngine>) {
    let m = match mode.as_str() {
        "track" => 1,
        "album" => 2,
        _ => 0,
    };
    engine.set_replaygain(m);
}

// Turn follow-the-content output rate switching on or off. The frontend owns the
// setting (persisted in its store, menu checkbox). Enabling is read as each
// track opens; disabling also initiates guarded restoration of the device rate
// that source matching displaced. See audio::desired_output_rate.
#[tauri::command]
fn audio_set_follow_sample_rate(enabled: bool, engine: State<audio::AudioEngine>) {
    engine.set_rate_follow(enabled);
}

// === System Now Playing (macOS Control Center / media keys) ===
// The frontend drives these because it alone resolves title/artist/album/art
// across files, external files, and radio. Position/state come from the engine
// events the frontend already receives. Off macOS these are no-ops.

#[tauri::command]
fn now_playing_set_metadata(
    app: AppHandle,
    title: String,
    artist: Option<String>,
    album: Option<String>,
    art: Option<String>,
    duration: f64,
) {
    now_playing::set_metadata(&app, title, artist, album, art, duration);
}

#[tauri::command]
fn now_playing_set_playback(app: AppHandle, playing: bool, elapsed: f64) {
    now_playing::set_playback(&app, playing, elapsed);
}

#[tauri::command]
fn now_playing_clear(app: AppHandle) {
    now_playing::clear(&app);
}

// Escapes LIKE wildcards in user input so a typed '%' or '_' matches literally
// (used with `ESCAPE '\'`). Also doubles backslashes so a literal '\' matches.
fn escape_like(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

// Substring search over the cached metadata (title/artist/album) and the file
// path (so a filename match works even when a track has no tags). The query is
// matched literally — LIKE wildcards in user input are escaped so a typed '%'
// finds a literal '%'. Capped so a one-character query can't return the whole
// library into the dropdown.
#[tauri::command]
async fn search_tracks(
    query: String,
    db: State<'_, DbHandle>,
) -> Result<Vec<SearchResult>, String> {
    db.read(move |conn| {
        let q = query.trim();
        if q.is_empty() {
            return Ok(Vec::new());
        }
        let like = format!("%{}%", escape_like(q));

        let sql = format!(
            "SELECT {TRACK_COLUMNS} FROM tracks
             WHERE title LIKE ?1 ESCAPE '\\'
                OR artist LIKE ?1 ESCAPE '\\'
                OR album LIKE ?1 ESCAPE '\\'
                OR path LIKE ?1 ESCAPE '\\'
             ORDER BY artist IS NULL, artist COLLATE NOCASE,
                      album COLLATE NOCASE, disc, track,
                      title COLLATE NOCASE
             LIMIT 50"
        );
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([&like], |row| {
                // Flat/positional list: the gutter shows a row index, not a
                // within-album ordinal, so the metadata track number is dropped.
                // Everything else the column table can draw is carried as-is.
                Ok(SearchResult {
                    track: None,
                    ..track_row(row)?
                })
            })
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(|e| e.to_string())?);
        }
        Ok(out)
    })
    .await
}

// Folders whose name (any path segment above a track) contains the query.
// Folders aren't stored as rows — they're the ancestor directories of cached
// track paths — so they're derived here: every track path matching the query
// somewhere is split into its ancestor dirs, and each dir whose own name
// matches is kept once. Matches search_tracks' literal (escaped) substring
// semantics and cap.
#[tauri::command]
async fn search_folders(
    query: String,
    db: State<'_, DbHandle>,
) -> Result<Vec<FolderResult>, String> {
    db.read(move |conn| {
        let q = query.trim();
        if q.is_empty() {
            return Ok(Vec::new());
        }
        let needle = q.to_lowercase();
        // A folder name only matches if the query is a substring of the full path,
        // so pre-filter in SQL to avoid walking every track on each keystroke.
        let like = format!("%{}%", escape_like(q));

        let mut stmt = conn
            .prepare("SELECT path FROM tracks WHERE path LIKE ?1 ESCAPE '\\'")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([&like], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?;

        let mut seen = HashSet::new();
        let mut out: Vec<FolderResult> = Vec::new();
        for r in rows {
            let path = r.map_err(|e| e.to_string())?;
            // Each '/' (past a leading one) closes an ancestor directory; the final
            // component is the file itself and is skipped by only looking at slices
            // ending at a separator.
            for (i, ch) in path.char_indices() {
                if ch != '/' || i == 0 {
                    continue;
                }
                let dir = &path[..i];
                let name = dir.rsplit('/').next().unwrap_or(dir);
                if name.to_lowercase().contains(&needle) && seen.insert(dir.to_string()) {
                    out.push(FolderResult {
                        path: dir.to_string(),
                        name: name.to_string(),
                    });
                }
            }
        }
        out.sort_by(|a, b| {
            a.name
                .to_lowercase()
                .cmp(&b.name.to_lowercase())
                .then_with(|| a.path.cmp(&b.path))
        });
        out.truncate(50);
        Ok(out)
    })
    .await
}

// Every cached track under a folder (recursively), ordered for playback:
// grouped by album, then disc/track, so an album folder plays in track order
// and an artist folder plays album by album. Backs the "play a folder from
// search" action.
// Everything a track row is made of, read straight off the file: the two stat
// facts the scan cache keys on, the two it displays, whether the bytes are here
// at all, and the tags. One read serving both shapes it can turn into — the row
// the UI draws (row_from_facts) and the row the cache stores (upsert_track) —
// because a file that has just been downloaded needs both and reading it twice
// would be two answers where there is one file.
struct DiskFacts {
    tags: Tags,
    size: i64,
    created: Option<i64>,
    modified: Option<i64>,
    not_downloaded: bool,
}

fn read_disk_facts(path: &Path) -> DiskFacts {
    let meta = std::fs::metadata(path);
    let not_downloaded = meta
        .as_ref()
        .map(dataless::is_dataless)
        .unwrap_or(false);
    let (size, created, modified) = match &meta {
        Ok(m) => {
            let secs = |t: std::io::Result<std::time::SystemTime>| {
                t.ok()
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_secs() as i64)
            };
            (m.len() as i64, secs(m.created()), secs(m.modified()))
        }
        Err(_) => (0, None, None),
    };
    // Stat before tags, so a cloud file can be recognized without being read. The
    // callers that reach here on a *dataless* file run on command threads that have
    // NOT opted out of materializing (only the scanner and the decoder do), so
    // reading tags would download the file — minutes of a blocked thread, to fill
    // in a title. The row goes up untagged and marked, and playing it is what
    // fetches it (after which the row is read again — see reindex_downloaded).
    let tags = if not_downloaded {
        Tags::default()
    } else {
        read_tags(path)
    };
    DiskFacts {
        tags,
        size,
        created,
        modified,
        not_downloaded,
    }
}

// The same shape a DB row produces, from facts read off the file instead.
fn row_from_facts(path: &Path, f: &DiskFacts) -> SearchResult {
    SearchResult {
        path: path.to_string_lossy().into_owned(),
        title: f.tags.title.clone(),
        artist: f.tags.artist.clone(),
        album: f.tags.album.clone(),
        album_artist: f.tags.album_artist.clone(),
        // Unlike the flat library lists, a dropped folder is one contiguous run of
        // files, so the metadata track/disc numbers are meaningful and worth keeping
        // — they are also what the drop sort reads.
        track: f.tags.track,
        disc: f.tags.disc,
        year: f.tags.year,
        genre: f.tags.genre.clone(),
        duration: f.tags.duration,
        bitrate: f.tags.bitrate,
        sample_rate: f.tags.sample_rate,
        bit_depth: f.tags.bit_depth,
        gain: f.tags.rg_track_gain,
        created: f.created,
        modified: f.modified,
        not_downloaded: f.not_downloaded,
    }
}

// A track row for a file the library index has never seen, read straight off the
// file. The drop path needs this — everything else in the app is looking at
// indexed files by construction.
fn track_from_disk(path: PathBuf) -> SearchResult {
    row_from_facts(&path, &read_disk_facts(&path))
}

// Flatten what the user dropped on the window into a playable list of tracks, in
// the order the drop implies: dropped items in the order they were handed to us,
// and each dropped folder's own files in listening order.
//
// Deliberately not `folder_tracks`. That one answers the same question out of the
// library index, so it only knows about folders *inside* a configured root — and a
// drop can carry any folder on the disk, including one from a library the user
// hasn't set up yet. So this walks the filesystem instead (walk_audio, the same
// recursive, symlink-loop-safe walk the scanner uses) and reads tags off any file
// the index has never seen. Indexed files still come from the DB: dropping an album
// out of your own library shouldn't cost a full tag re-read.
#[tauri::command]
async fn dropped_tracks(
    paths: Vec<String>,
    db: State<'_, DbHandle>,
) -> Result<Vec<SearchResult>, String> {
    db.read(move |conn| {
        // One `visited` across the whole drop, so dropping a folder together with
        // its own parent yields each file once rather than twice; `seen` does the
        // same for a file dropped alongside the folder that contains it.
        let mut visited: HashSet<PathBuf> = HashSet::new();
        let mut seen: HashSet<PathBuf> = HashSet::new();
        // Each dropped item's files, kept as its own group: a folder is sorted
        // internally, while the groups stay in drop order.
        let mut groups: Vec<Vec<PathBuf>> = Vec::new();
        let mut unreadable = Vec::new();
        for p in &paths {
            let path = Path::new(p);
            // Follows symlinks (unlike a dirent's file_type), so a dropped alias to
            // a folder expands like the folder it points at.
            let Ok(meta) = std::fs::metadata(path) else {
                continue;
            };
            let mut group: Vec<PathBuf> = Vec::new();
            if meta.is_dir() {
                // Left in readdir order for now — arbitrary, and a queue's order
                // is not. Sorted properly once the tags are read, below.
                // Nothing here deletes anything, so a folder that won't open is
                // just a folder with no audio in it; the holes are collected and
                // dropped.
                walk_audio(path, &mut group, &mut visited, &mut unreadable);
            } else if meta.is_file() && is_audio_path(p) {
                group.push(path.to_path_buf());
            }
            group.retain(|f| seen.insert(f.clone()));
            if !group.is_empty() {
                groups.push(group);
            }
        }

        let all: Vec<String> = groups
            .iter()
            .flatten()
            .map(|p| p.to_string_lossy().into_owned())
            .collect();
        let meta_map = fetch_meta(conn, &all)?;

        let mut out: Vec<SearchResult> = Vec::with_capacity(all.len());
        for group in groups {
            let mut rows: Vec<SearchResult> = group
                .into_iter()
                .map(|p| {
                    let full = p.to_string_lossy().into_owned();
                    match meta_map.get(&full) {
                        Some(m) => SearchResult {
                            path: full,
                            title: m.title.clone(),
                            artist: m.artist.clone(),
                            album: m.album.clone(),
                            album_artist: m.album_artist.clone(),
                            track: m.track,
                            disc: m.disc,
                            year: m.year,
                            genre: m.genre.clone(),
                            duration: m.duration,
                            bitrate: m.bitrate,
                            sample_rate: m.sample_rate,
                            bit_depth: m.bit_depth,
                            gain: m.gain,
                            created: m.created,
                            modified: m.modified,
                            not_downloaded: m.not_downloaded,
                        },
                        None => track_from_disk(p),
                    }
                })
                .collect();
            // Listening order, now that disc/track are known: the same (disc, track,
            // name) list_dir sorts a folder by, under a leading key of the containing
            // folder — so a drop spanning several album folders plays album by album
            // rather than every track 1 first.
            rows.sort_by_cached_key(|r| {
                let path = Path::new(&r.path);
                let dir = path
                    .parent()
                    .map(|d| d.to_string_lossy().to_lowercase())
                    .unwrap_or_default();
                let name = path
                    .file_name()
                    .map(|n| n.to_string_lossy().to_lowercase())
                    .unwrap_or_default();
                (
                    dir,
                    r.disc.unwrap_or(1),
                    r.track.unwrap_or(u32::MAX),
                    name,
                )
            });
            out.extend(rows);
        }
        Ok(out)
    })
    .await
}

#[tauri::command]
async fn folder_tracks(path: String, db: State<'_, DbHandle>) -> Result<Vec<SearchResult>, String> {
    db.read(move |conn| {
        // Trailing slash so `/a/b` matches `/a/b/...` but not a sibling `/a/bc/...`.
        let prefix = if path.ends_with('/') {
            path.clone()
        } else {
            format!("{}/", path)
        };
        let like = format!("{}%", escape_like(&prefix));

        let sql = format!(
            "SELECT {TRACK_COLUMNS} FROM tracks
             WHERE path LIKE ?1 ESCAPE '\\'
             ORDER BY album IS NULL, album COLLATE NOCASE,
                      disc, track, path COLLATE NOCASE"
        );
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([&like], |row| {
                // Flat/positional list: the gutter shows a row index, not a
                // within-album ordinal, so the metadata track number is dropped.
                // Everything else the column table can draw is carried as-is.
                Ok(SearchResult {
                    track: None,
                    ..track_row(row)?
                })
            })
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(|e| e.to_string())?);
        }
        Ok(out)
    })
    .await
}

// The album grouping key, matching how mainstream players identify an album:
// the ALBUMARTIST tag when present, else the track artist. An empty string
// stands in for "no artist at all" so the value is never NULL and equality
// comparisons (and the frontend's albumArtist ?? artist) stay total.
const ALBUM_ARTIST_EXPR: &str = "COALESCE(NULLIF(album_artist, ''), artist, '')";

// Distinct artists whose name contains the query. Backs the "artist" rows in
// search; choosing one opens an immutable queue of every track by that artist.
#[tauri::command]
async fn search_artists(
    query: String,
    db: State<'_, DbHandle>,
) -> Result<Vec<ArtistResult>, String> {
    db.read(move |conn| {
        let q = query.trim();
        if q.is_empty() {
            return Ok(Vec::new());
        }
        let like = format!("%{}%", escape_like(q));

        let mut stmt = conn
            .prepare(
                "SELECT DISTINCT artist FROM tracks
                 WHERE artist IS NOT NULL AND artist <> '' AND artist LIKE ?1 ESCAPE '\\'
                 ORDER BY artist COLLATE NOCASE
                 LIMIT 50",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([&like], |row| Ok(ArtistResult { name: row.get(0)? }))
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(|e| e.to_string())?);
        }
        Ok(out)
    })
    .await
}

// Distinct (album, album-artist) pairs whose album name contains the query.
// Choosing one opens an immutable queue of the album's tracks in disc/track
// order.
#[tauri::command]
async fn search_albums(query: String, db: State<'_, DbHandle>) -> Result<Vec<AlbumResult>, String> {
    db.read(move |conn| {
        let q = query.trim();
        if q.is_empty() {
            return Ok(Vec::new());
        }
        let like = format!("%{}%", escape_like(q));

        let sql = format!(
            "SELECT album, {expr} AS album_artist FROM tracks
             WHERE album IS NOT NULL AND album <> '' AND album LIKE ?1 ESCAPE '\\'
             GROUP BY album, {expr}
             ORDER BY album COLLATE NOCASE, album_artist COLLATE NOCASE
             LIMIT 50",
            expr = ALBUM_ARTIST_EXPR
        );
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([&like], |row| {
                Ok(AlbumResult {
                    album: row.get(0)?,
                    artist: row.get(1)?,
                })
            })
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(|e| e.to_string())?);
        }
        Ok(out)
    })
    .await
}

// Every track by an artist, ordered album by album (then disc/track) for
// playback. Backs the artist queue page.
#[tauri::command]
async fn artist_tracks(
    artist: String,
    db: State<'_, DbHandle>,
) -> Result<Vec<SearchResult>, String> {
    db.read(move |conn| {
        let sql = format!(
            "SELECT {TRACK_COLUMNS} FROM tracks
             WHERE artist = ?1
             ORDER BY album IS NULL, album COLLATE NOCASE,
                      disc, track, path COLLATE NOCASE"
        );
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([&artist], |row| {
                // Flat/positional list: the gutter shows a row index, not a
                // within-album ordinal, so the metadata track number is dropped.
                // Everything else the column table can draw is carried as-is.
                Ok(SearchResult {
                    track: None,
                    ..track_row(row)?
                })
            })
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(|e| e.to_string())?);
        }
        Ok(out)
    })
    .await
}

// Every track on an album (identified by name + album artist), in disc/track
// order. `album_artist` is the grouping key the frontend already holds —
// albumArtist ?? artist for a track row, or the value from a search album row.
// Backs the album queue page.
#[tauri::command]
async fn album_tracks(
    album: String,
    album_artist: String,
    db: State<'_, DbHandle>,
) -> Result<Vec<SearchResult>, String> {
    db.read(move |conn| {
        let sql = format!(
            "SELECT {TRACK_COLUMNS} FROM tracks
             WHERE album = ?1 AND {expr} = ?2
             ORDER BY disc, track, path COLLATE NOCASE",
            expr = ALBUM_ARTIST_EXPR
        );
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![album, album_artist], |row| {
                Ok(SearchResult {
                    track: row.get(6)?,
                    ..track_row(row)?
                })
            })
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(|e| e.to_string())?);
        }
        Ok(out)
    })
    .await
}

// The whole library as a flat track list, in the same album-by-album order the
// search/artist queries use, so the Songs view reads consistently. Unfiltered
// twin of search_tracks with the LIKE and LIMIT removed — it returns every
// cached track (the view virtualizes for scale; see plan.md Phase 7). Reuses
// SearchResult so no new frontend plumbing.
#[tauri::command]
async fn list_all_songs(db: State<'_, DbHandle>) -> Result<Vec<SongRow>, String> {
    db.read(move |conn| {
        // Debug: PUDDING_PERF=1 logs the pure query+collect time (excludes the IPC
        // serialize + JS parse the frontend's __perfLog measures) so the two can be
        // compared to see where the Songs-open pause actually lives.
        let perf = std::env::var("PUDDING_PERF").is_ok();
        let t0 = std::time::Instant::now();
        // TRACK_COLUMNS without `track`: this list's gutter is a positional index,
        // so the metadata ordinal would be dead weight on every row of the library.
        let sql = format!(
            "SELECT path, title, artist, album, album_artist, disc,
                    year, genre, duration, bitrate, sample_rate, bit_depth,
                    rg_track_gain, created, mtime, dataless
             FROM tracks
             ORDER BY artist IS NULL, artist COLLATE NOCASE,
                      album COLLATE NOCASE, disc, track,
                      title COLLATE NOCASE"
        );
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        // Columnar/tuple rows (see SongRow): the whole-library list is large enough
        // at the scale target that repeating the JSON field names per row dominates
        // the IPC + parse cost, so ship positional tuples and let the frontend
        // re-key them.
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                    row.get(7)?,
                    row.get(8)?,
                    row.get(9)?,
                    row.get(10)?,
                    row.get(11)?,
                    row.get(12)?,
                    row.get(13)?,
                    row.get(14)?,
                    row.get(15)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(|e| e.to_string())?);
        }
        if perf {
            eprintln!(
                "[perf] list_all_songs query+collect: {:.1}ms ({} rows)",
                t0.elapsed().as_secs_f64() * 1000.0,
                out.len()
            );
        }
        Ok(out)
    })
    .await
}

// Every distinct artist in the library, alphabetized. Unfiltered twin of
// search_artists with the LIKE and LIMIT removed; reuses ArtistResult. Backs the
// Artists browse list; drilling in reuses artist_tracks.
#[tauri::command]
async fn list_all_artists(db: State<'_, DbHandle>) -> Result<Vec<ArtistResult>, String> {
    db.read(move |conn| {
        let mut stmt = conn
            .prepare(
                "SELECT DISTINCT artist FROM tracks
                 WHERE artist IS NOT NULL AND artist <> ''
                 ORDER BY artist COLLATE NOCASE",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| Ok(ArtistResult { name: row.get(0)? }))
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(|e| e.to_string())?);
        }
        Ok(out)
    })
    .await
}

// Every distinct (album, album-artist) pair in the library, alphabetized.
// Unfiltered twin of search_albums; reuses AlbumResult. Grouping on
// ALBUM_ARTIST_EXPR (not the raw album_artist column) so the key matches what
// album_tracks / openAlbumQueue expect — a track with an empty album_artist
// groups under its track artist, not a blank bucket. Backs the Albums browse
// list.
#[tauri::command]
async fn list_all_albums(db: State<'_, DbHandle>) -> Result<Vec<AlbumResult>, String> {
    db.read(move |conn| {
        let sql = format!(
            "SELECT album, {expr} AS album_artist FROM tracks
             WHERE album IS NOT NULL AND album <> ''
             GROUP BY album, {expr}
             ORDER BY album COLLATE NOCASE, album_artist COLLATE NOCASE",
            expr = ALBUM_ARTIST_EXPR
        );
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok(AlbumResult {
                    album: row.get(0)?,
                    artist: row.get(1)?,
                })
            })
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(|e| e.to_string())?);
        }
        Ok(out)
    })
    .await
}

// --- Genres / Decades --------------------------------------------------------
//
// Two more read-only slices of the same table. Unlike an artist (who owns albums)
// a genre and a decade have no sub-structure of their own — they are pure filters
// — so each is two queries and no hierarchy: the distinct values for the browse
// list, and every track behind one of them, which serves BOTH the row's Play /
// Add to queue verbs and the flat list you land on by opening it. The album and
// artist are still one right-click away from any of those rows (Go to album / Go
// to artist), which is why indexing them here would have bought nothing but an
// extra level to click through.
//
// Neither needs bookkeeping of its own — a genre is the `genre` tag and a decade
// is the `year` tag rounded down — so both stay true through a cache wipe and
// through changes made outside the app.

// Every distinct genre in the library, alphabetized. The `genre` twin of
// list_all_artists; a bare string per row, since a genre carries no second key
// the way an album carries its album artist. Backs the Genres browse list.
#[tauri::command]
async fn list_all_genres(db: State<'_, DbHandle>) -> Result<Vec<String>, String> {
    db.read(move |conn| {
        let mut stmt = conn
            .prepare(
                "SELECT DISTINCT genre FROM tracks
                 WHERE genre IS NOT NULL AND genre <> ''
                 ORDER BY genre COLLATE NOCASE",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(|e| e.to_string())?);
        }
        Ok(out)
    })
    .await
}

// Every track tagged with this genre, in the artist-then-album order
// artist_tracks uses — so the flat list reads grouped rather than scrambled, and
// a column sort can regroup it any other way. Backs both the Genres drill-in and
// the genre row's Play / Add to queue / Add to playlist / Edit metadata verbs (the
// same lazily-resolved track provider those menus take for an artist or an album).
// Reuses SearchResult.
#[tauri::command]
async fn genre_tracks(
    genre: String,
    db: State<'_, DbHandle>,
) -> Result<Vec<SearchResult>, String> {
    db.read(move |conn| {
        let sql = format!(
            "SELECT {TRACK_COLUMNS} FROM tracks
             WHERE genre = ?1
             ORDER BY artist IS NULL, artist COLLATE NOCASE,
                      album IS NULL, album COLLATE NOCASE,
                      disc, track, path COLLATE NOCASE"
        );
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([&genre], |row| {
                // Flat/positional list, like artist_tracks: the gutter numbers the
                // rows, so the within-album ordinal is dropped.
                Ok(SearchResult {
                    track: None,
                    ..track_row(row)?
                })
            })
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(|e| e.to_string())?);
        }
        Ok(out)
    })
    .await
}

// The decade a `year` tag falls in, as SQL: 1994 → 1990. The frontend labels it
// ("1990s"); the backend only ever speaks the starting year, which is also the
// argument decade_tracks takes.
const DECADE_EXPR: &str = "(year / 10) * 10";
// Which years count as a real release year. A tag below 1000 is junk — a bare
// "94", a stray "0" left by a tagger — not a medieval recording, and letting one
// through mints a nonsense "90s" bucket sitting next to the real "1990s". Every
// decade query shares this one condition so they can never disagree about it.
const DECADE_YEARS: &str = "year IS NOT NULL AND year >= 1000";

// Every decade the library has music from, newest first — the end of the list
// worth landing on. Returns the starting years (2020, 2010, ...); the Decades
// browse list labels them.
#[tauri::command]
async fn list_all_decades(db: State<'_, DbHandle>) -> Result<Vec<i64>, String> {
    db.read(move |conn| {
        let sql = format!(
            "SELECT DISTINCT {DECADE_EXPR} AS decade FROM tracks
             WHERE {DECADE_YEARS}
             ORDER BY decade DESC"
        );
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| row.get::<_, i64>(0))
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(|e| e.to_string())?);
        }
        Ok(out)
    })
    .await
}

// Every track from one decade, oldest year first and then artist by artist — the
// decade twin of genre_tracks, backing both the Decades drill-in and the decade
// row's Play / Add to queue verbs. Year leads the sort because inside a decade
// that is the axis the list is *about*. Reuses SearchResult.
#[tauri::command]
async fn decade_tracks(
    decade: i64,
    db: State<'_, DbHandle>,
) -> Result<Vec<SearchResult>, String> {
    db.read(move |conn| {
        let sql = format!(
            "SELECT {TRACK_COLUMNS} FROM tracks
             WHERE {DECADE_YEARS} AND {DECADE_EXPR} = ?1
             ORDER BY year, artist IS NULL, artist COLLATE NOCASE,
                      album IS NULL, album COLLATE NOCASE,
                      disc, track, path COLLATE NOCASE"
        );
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([decade], |row| {
                Ok(SearchResult {
                    track: None,
                    ..track_row(row)?
                })
            })
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(|e| e.to_string())?);
        }
        Ok(out)
    })
    .await
}

// Distinct albums that contain a track by this artist, carrying the album-artist
// grouping key (ALBUM_ARTIST_EXPR) so a drill-in via album_tracks / openAlbumQueue
// matches — including a compilation whose album_artist differs from the track
// artist. Reuses AlbumResult. Backs the artist-detail (albums) view of the
// Artists browse view; filtering on the *track* artist mirrors artist_tracks.
#[tauri::command]
async fn artist_albums(
    artist: String,
    db: State<'_, DbHandle>,
) -> Result<Vec<AlbumResult>, String> {
    db.read(move |conn| {
        let sql = format!(
            "SELECT album, {expr} AS album_artist FROM tracks
             WHERE artist = ?1 AND album IS NOT NULL AND album <> ''
             GROUP BY album, {expr}
             ORDER BY album COLLATE NOCASE, album_artist COLLATE NOCASE",
            expr = ALBUM_ARTIST_EXPR
        );
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([&artist], |row| {
                Ok(AlbumResult {
                    album: row.get(0)?,
                    artist: row.get(1)?,
                })
            })
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(|e| e.to_string())?);
        }
        Ok(out)
    })
    .await
}

// Tracks by this artist that belong to no album (empty/NULL album tag) — the
// complement of artist_albums, which drops them. The artist-detail view lists
// these below the albums so an artist's loose singles aren't stranded. Filtering
// on the *track* artist mirrors artist_albums; ordered by title for a stable,
// readable list. Reuses SearchResult.
#[tauri::command]
async fn artist_albumless_tracks(
    artist: String,
    db: State<'_, DbHandle>,
) -> Result<Vec<SearchResult>, String> {
    db.read(move |conn| {
        let sql = format!(
            "SELECT {TRACK_COLUMNS} FROM tracks
             WHERE artist = ?1 AND (album IS NULL OR album = '')
             ORDER BY title COLLATE NOCASE, path COLLATE NOCASE"
        );
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([&artist], |row| {
                // Flat list: the gutter shows a row index, not a within-album
                // ordinal, so the metadata track number is dropped.
                //
                // The album artist tag IS carried, though these tracks have no album.
                // It used to be forced to None here because its only job was keying
                // "go to album", which an albumless track can't do. It is now also a
                // column, and a column reports what the file says — blanking it would
                // make these rows claim the tag is absent when it may not be.
                Ok(SearchResult {
                    track: None,
                    ..track_row(row)?
                })
            })
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(|e| e.to_string())?);
        }
        Ok(out)
    })
    .await
}

// Explicitly hand the "Help" submenu to AppKit as NSApplication.helpMenu. macOS
// is supposed to auto-detect a menu titled "Help" and inject its built-in search
// field (the one that indexes every menu item), but that auto-detection doesn't
// fire reliably under Tauri/muda — so we find the submenu by title in the main
// menu and set it ourselves, which lights up the search field for real.
#[cfg(target_os = "macos")]
fn wire_macos_help_menu() {
    use objc2_app_kit::NSApplication;
    use objc2_foundation::MainThreadMarker;

    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    let app = NSApplication::sharedApplication(mtm);
    let Some(main_menu) = app.mainMenu() else {
        return;
    };
    let count = main_menu.numberOfItems();
    for i in 0..count {
        let Some(item) = main_menu.itemAtIndex(i) else {
            continue;
        };
        if let Some(submenu) = item.submenu() {
            if submenu.title().to_string() == "Help" {
                app.setHelpMenu(Some(&submenu));
                break;
            }
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Managed on the builder, not in setup(): a macOS cold-start file open
        // delivers its Apple Event before setup() runs, and deliver_open_file
        // needs this state to exist by then.
        .manage(PendingOpen {
            inner: Mutex::new(PendingState::default()),
        })
        .manage(RecentIcons::default())
        // The generation the user has asked to stop, read by a running tag write
        // between files. An Arc because the batch runs on a blocking worker that
        // outlives the command's borrow of state.
        .manage(Arc::new(TagWriteCancel::default()))
        // The security-scoped grants for the library roots. Managed on the builder
        // so the guards outlive every scan, watcher and tag write that depends on
        // them; see root_access.rs.
        .manage(root_access::RootAccess::default())
        // Single-instance must be the first plugin. When a second launch happens
        // (e.g. user double-clicks another mp3 on Windows/Linux), this callback
        // fires in the running instance with the new process's argv.
        //
        // Under the App Sandbox (the Mac App Store build only — see
        // src-tauri/MAS-BUILD.md) this plugin is INERT, deliberately. Its rendezvous
        // socket is hardcoded to /tmp, which a sandboxed process may neither write
        // nor read; the bind fails, the plugin logs and lets the app launch normally.
        // That costs nothing here, because macOS never gives a bundled app a second
        // instance to begin with: Launch Services activates the running one and
        // delivers the file as an Apple Event, which arrives as RunEvent::Opened and
        // is handled below. The plugin only ever mattered for Windows and Linux, and
        // for `open -n` on a developer's machine, which is unsandboxed anyway.
        //
        // The failure mode that would matter is the plugin CONNECTING and calling
        // exit(0), which would be a launch that silently does nothing. It cannot: a
        // sandboxed connect to /tmp is denied, so the plugin takes its
        // "launching normally" branch. tools/sandbox-check.sh asserts exactly that,
        // and asserts that the container's own tmp would accept the socket — which
        // is where it would have to move if single-instance is ever wanted here.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.set_focus();
            }
            if let Some(path) = find_openable_in_argv(&argv) {
                deliver_open_file(app, path);
            }
        }))
        .plugin(
            tauri_plugin_log::Builder::new()
                .targets([
                    Target::new(TargetKind::LogDir { file_name: None }),
                    Target::new(TargetKind::Stdout),
                    Target::new(TargetKind::Webview),
                ])
                .level(log::LevelFilter::Info)
                // Media-parsing crates warn about conditions that are normal in
                // a real library and that we never act on: symphonia logs
                // "invalid main_data_begin" on every MP3 seek (the bit
                // reservoir is empty by definition after a seek), and lofty
                // warns per-file about legacy-but-valid tags, so one library
                // scan can bury everything else. Genuine failures don't come
                // from these lines anyway — symphonia signals them through
                // Result, and we log those ourselves with the file path
                // attached ("audio: probe ... failed", "audio: decode error").
                .level_for("symphonia_bundle_mp3", log::LevelFilter::Error)
                .level_for("symphonia_bundle_flac", log::LevelFilter::Error)
                .level_for("symphonia_format_isomp4", log::LevelFilter::Error)
                .level_for("symphonia_format_ogg", log::LevelFilter::Error)
                .level_for("symphonia_metadata", log::LevelFilter::Error)
                .level_for("lofty", log::LevelFilter::Error)
                .build(),
        )
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .on_menu_event(|app, event| {
            match event.id().as_ref() {
                "open-settings" => {
                    let _ = app.emit("open-settings", ());
                }
                "open-about" => {
                    let _ = app.emit("open-about", ());
                }
                "open-licenses" => {
                    let _ = app.emit("open-licenses", ());
                }
                "open-equalizer" => {
                    let _ = app.emit("open-equalizer", ());
                }
                // Help ▸ Website and Help ▸ Support open the site in the default
                // browser. Support is the in-app path App Review expects, and it
                // is the same URL given in App Store Connect.
                "open-website" => {
                    let _ = app
                        .opener()
                        .open_url("https://puddingisgood.com", None::<&str>);
                }
                "open-support" => {
                    let _ = app
                        .opener()
                        .open_url("https://puddingisgood.com/support/", None::<&str>);
                }
                // View ▸ Visualizer is a single on/off toggle (⌘T); it relays a
                // flip. The frontend owns the preference (swaps art <-> visualizer,
                // persists it, re-syncs the checkmark) — same path as the topbar
                // viz button.
                "np-view-visualizer" => {
                    let _ = app.emit("np-view-toggle", ());
                }
                // View ▸ Zen Mode relays the toggle; the frontend owns the
                // immersive hero cover (a hero view, not a window change).
                "np-zen" => {
                    let _ = app.emit("np-zen-toggle", ());
                }
                // Edit ▸ Undo / Redo relay to the frontend, which owns the curation
                // history (playlist / queue reorder-remove-drag-in).
                "edit-undo" => {
                    let _ = app.emit("menu:edit", "undo");
                }
                "edit-redo" => {
                    let _ = app.emit("menu:edit", "redo");
                }
                // Transport items. The frontend owns playback, so these just
                // relay the intent; Previous/Next carry ⌘←/⌘→ accelerators, which
                // also serve to surface the shortcuts in the menu.
                "transport-playpause" => {
                    let _ = app.emit("menu:transport", "playpause");
                }
                "transport-prev" => {
                    let _ = app.emit("menu:transport", "prev");
                }
                "transport-next" => {
                    let _ = app.emit("menu:transport", "next");
                }
                // Volume: nudge up/down (the frontend owns the level and clamps).
                "playback-volume-up" => {
                    let _ = app.emit("menu:volume", "up");
                }
                "playback-volume-down" => {
                    let _ = app.emit("menu:volume", "down");
                }
                // Shuffle and Mute are checkboxes that auto-toggled before this
                // fires; the frontend owns the state, so just relay the intent
                // (it flips its own state and re-syncs the checkmark).
                "playback-shuffle" => {
                    let _ = app.emit("menu:shuffle", ());
                }
                "playback-mute" => {
                    let _ = app.emit("menu:mute", ());
                }
                // Repeat is three radio-style items; each selects its mode.
                "repeat-off" => {
                    let _ = app.emit("menu:repeat", "off");
                }
                "repeat-all" => {
                    let _ = app.emit("menu:repeat", "all");
                }
                "repeat-one" => {
                    let _ = app.emit("menu:repeat", "one");
                }
                // ReplayGain is three radio-style items; each selects its mode.
                "replaygain-off" => {
                    let _ = app.emit("menu:replaygain", "off");
                }
                "replaygain-track" => {
                    let _ = app.emit("menu:replaygain", "track");
                }
                "replaygain-album" => {
                    let _ = app.emit("menu:replaygain", "album");
                }
                // Mini Player checkbox auto-toggled before this fires; the frontend
                // owns the mode (it resizes across the breakpoint) and re-syncs the
                // checkmark from the resulting viewport height.
                "window-miniplayer" => {
                    let _ = app.emit("menu:miniplayer", ());
                }
                // The checkbox auto-toggled its own state before this fires, so
                // is_checked() reads the new value; relay it to the frontend,
                // which owns the setting and persists it.
                "follow-sample-rate" => {
                    if let Some(menu) = app.try_state::<PlaybackMenu>() {
                        let enabled = menu.follow_sample_rate.is_checked().unwrap_or(false);
                        let _ = app.emit("menu:follow-sample-rate", enabled);
                    }
                }
                "autoadvance" => {
                    if let Some(menu) = app.try_state::<PlaybackMenu>() {
                        let enabled = menu.autoadvance.is_checked().unwrap_or(true);
                        let _ = app.emit("menu:autoadvance", enabled);
                    }
                }
                // File ▸ Open...: show the native picker, then hand the result to
                // deliver_open_file, so opening from the menu and opening from the
                // Finder are literally the same code path (audio plays, a playlist
                // opens for browsing). That one command covers both file kinds,
                // which is why there is no separate Open Playlist. Non-blocking
                // form — this handler runs on the main thread, where a blocking
                // panel would deadlock.
                "open-file-dialog" => {
                    let handle = app.clone();
                    let every_ext = [AUDIO_EXTS, playlist::PLAYLIST_EXTS].concat();
                    app.dialog()
                        .file()
                        .set_title("Open")
                        // The combined filter leads so both kinds are selectable
                        // under the default choice; the named two follow for
                        // platforms that show a format popup (macOS flattens them
                        // all into one allowed set, so order is moot there).
                        .add_filter("Music and Playlists", &every_ext)
                        .add_filter("Audio", AUDIO_EXTS)
                        .add_filter("Playlist", playlist::PLAYLIST_EXTS)
                        .pick_file(move |file| {
                            let Some(path) = file.and_then(|f| f.into_path().ok()) else {
                                return;
                            };
                            if let Some(s) = path.to_str() {
                                deliver_open_file(&handle, s.to_string());
                            }
                        });
                }
                // The rest of the File menu — the frontend owns these dialogs,
                // writes, and the recents list, so these relay the intent. Recent
                // rows carry their path in the id (recent:<path>).
                "playlist-new" => {
                    let _ = app.emit("menu:playlist", "new");
                }
                "playlist-save" => {
                    let _ = app.emit("menu:playlist", "save");
                }
                "playlist-move" => {
                    let _ = app.emit("menu:playlist", "move");
                }
                "recent-clear" => {
                    let _ = app.emit("menu:recent-clear", ());
                }
                other if other.starts_with("recent:") => {
                    let path = other.trim_start_matches("recent:");
                    let _ = app.emit("menu:open-recent", path.to_string());
                }
                _ => {}
            }
        })
        .setup(|app| {
            log::info!(
                "app.boot version={} pid={}",
                env!("CARGO_PKG_VERSION"),
                std::process::id()
            );

            let app_data = app_data_dir(app.handle())?;
            std::fs::create_dir_all(&app_data)?;
            let db_path = app_data.join(DB_FILE);
            let conn = open_connection(&db_path)?;
            init_schema(&conn)?;
            app.manage(DbHandle {
                conn: Arc::new(Mutex::new(conn)),
                readers: Arc::new(ReadPool::new(db_path.clone())),
                path: db_path,
            });
            app.manage(WatcherState {
                inner: Mutex::new(Vec::new()),
            });

            // Seed the default stream list file so a fresh install has a valid,
            // empty list to point at. The frontend adopts this path only when no
            // stream list has ever been configured.
            if let Err(e) = ensure_default_stream_list(&app.handle()) {
                log::warn!("could not create default stream list: {e}");
            }

            // Bring the audio engine up before the frontend can issue play
            // commands. Failure here is fatal: the app is a media player.
            let engine = audio::start(app.handle().clone()).map_err(|e| {
                log::error!("audio engine failed to start: {e}");
                format!("audio engine: {e}")
            })?;
            app.manage(engine);

            // Register system Now Playing / media-key handlers (macOS). Must run
            // after the audio engine is managed: the remote-command handlers look
            // it up to drive play/pause/seek.
            now_playing::install(&app.handle());

            // Cold-start file open on Windows/Linux arrives as a CLI arg. On macOS
            // it arrives later via RunEvent::Opened (handled below).
            let argv: Vec<String> = std::env::args().collect();
            if let Some(path) = find_openable_in_argv(&argv) {
                deliver_open_file(&app.handle(), path);
            }

            // About opens our own in-app About panel (name/version + credit) in
            // the right pane, matching Settings, rather than the native macOS
            // About dialog. Selecting it emits "open-about" for the frontend.
            let about_item = MenuItemBuilder::with_id("open-about", "About Pudding").build(app)?;

            // App settings live under the standard macOS Preferences slot
            // (Pudding → Settings..., ⌘,). Selecting it emits "open-settings",
            // which the frontend uses to reveal the settings panel.
            let settings_item = MenuItemBuilder::with_id("open-settings", "Settings...")
                .accelerator("CmdOrCtrl+,")
                .build(app)?;

            let app_menu = SubmenuBuilder::new(app, "Pudding")
                .item(&about_item)
                .separator()
                .item(&settings_item)
                .separator()
                .services()
                .separator()
                .hide()
                .hide_others()
                .show_all()
                .separator()
                .quit()
                .build()?;

            // Setting a custom menu replaces the default, so the Edit submenu is
            // re-added here — without it ⌘C/⌘V/⌘Z stop working in the webview.
            // Undo/Redo are *ours* — custom items carrying ⌘Z/⌘⇧Z rather than the
            // predefined .undo()/.redo() — because they must serve both curation undo
            // and text undo, routed by focus in the frontend (see EditMenu). They
            // start disabled; the frontend enables them (set_edit_undo_state) whenever
            // a text field is focused or a curation is undoable. Cut/Copy/Paste/Select
            // All stay predefined (their selectors still power the webview directly).
            let edit_undo = MenuItemBuilder::with_id("edit-undo", "Undo")
                .accelerator("CmdOrCtrl+Z")
                .enabled(false)
                .build(app)?;
            let edit_redo = MenuItemBuilder::with_id("edit-redo", "Redo")
                .accelerator("CmdOrCtrl+Shift+Z")
                .enabled(false)
                .build(app)?;
            let edit_menu = SubmenuBuilder::new(app, "Edit")
                .item(&edit_undo)
                .item(&edit_redo)
                .separator()
                .cut()
                .copy()
                .paste()
                .select_all()
                .build()?;
            app.manage(EditMenu {
                undo: edit_undo,
                redo: edit_redo,
            });

            // Playback menu, in three groups ordered by subject: the track in
            // progress (Play/Pause, Previous, Next, then Volume Up/Down and
            // Mute — the hands-on controls for what's playing right now); what
            // plays next (Shuffle, a Repeat submenu, and the global
            // "Autoadvance" checkbox — does playback flow track-to-track, or
            // stop after each?); and how it sounds (Equalizer, a ReplayGain
            // submenu, Match Source Sample Rate). Autoadvance sits with Shuffle
            // and Repeat because all three answer the same question — what
            // happens when this track ends — and the set-once audio-path
            // settings stay in their own group rather than trailing the volume
            // keys. Queue teardown ("Clear") lives on the queue pane itself, not
            // here — a queue verb has no home in a global menu. Transport items
            // relay to the frontend (menu:transport); Previous/Next carry ⌘←/⌘→
            // accelerators that both drive the shortcut and reveal it here.
            // (Play/Pause, seek, and volume have bare-key shortcuts that can't
            // be menu accelerators without hijacking typing, so those appear
            // without accelerators.)
            // Shuffle/Repeat/Mute mirror the toolbar controls and Autoadvance
            // defaults on; the frontend corrects every checkmark to its persisted
            // value at startup and after each change (set_*_checked). Autoadvance
            // lives only here (a set-once preference); the rest also have toolbar
            // controls.
            let play_pause =
                MenuItemBuilder::with_id("transport-playpause", "Play / Pause").build(app)?;
            let previous = MenuItemBuilder::with_id("transport-prev", "Previous")
                .accelerator("CmdOrCtrl+Left")
                .build(app)?;
            let next = MenuItemBuilder::with_id("transport-next", "Next")
                .accelerator("CmdOrCtrl+Right")
                .build(app)?;
            let autoadvance = CheckMenuItemBuilder::with_id("autoadvance", "Autoadvance")
                .checked(true)
                .build(app)?;
            // Shuffle / Repeat / Volume / Mute mirror the toolbar controls; the
            // frontend owns the state and re-syncs these checkmarks after any
            // change (set_shuffle_checked / set_repeat_checked / set_mute_checked).
            // Repeat is three radio-style items (only one checked); Volume nudges
            // (+/-, ⌘↑/⌘↓) and Mute (bare M) have frontend key equivalents that a
            // text-input guard can gate, so no menu accelerators here (a bare-key
            // menu accelerator would fire app-wide and swallow typing).
            let shuffle =
                CheckMenuItemBuilder::with_id("playback-shuffle", "Shuffle").build(app)?;
            let repeat_off = CheckMenuItemBuilder::with_id("repeat-off", "Off")
                .checked(true)
                .build(app)?;
            let repeat_all =
                CheckMenuItemBuilder::with_id("repeat-all", "All").build(app)?;
            let repeat_one =
                CheckMenuItemBuilder::with_id("repeat-one", "One").build(app)?;
            let repeat_menu = SubmenuBuilder::new(app, "Repeat")
                .item(&repeat_off)
                .item(&repeat_all)
                .item(&repeat_one)
                .build()?;
            let volume_up =
                MenuItemBuilder::with_id("playback-volume-up", "Volume Up").build(app)?;
            let volume_down =
                MenuItemBuilder::with_id("playback-volume-down", "Volume Down").build(app)?;
            let mute = CheckMenuItemBuilder::with_id("playback-mute", "Mute").build(app)?;
            // Equalizer opens our in-app EQ panel in the right pane (like Settings
            // / About) — an audio effect on playback, so it heads the audio-path
            // group rather than living in Window (it's a pane, not a separate
            // window as in Apple Music). ⌥⌘E is the familiar Equalizer
            // accelerator. Selecting it emits "open-equalizer" for the frontend.
            let equalizer = MenuItemBuilder::with_id("open-equalizer", "Equalizer")
                .accelerator("Alt+Cmd+E")
                .build(app)?;
            // ReplayGain (volume normalization): three radio-style items in a
            // submenu below the Equalizer, another playback audio setting. Off
            // by default; the frontend corrects the checkmark to its persisted
            // value at startup and after each change (set_replaygain_checked),
            // like the Repeat trio. Applied per track from the file's
            // REPLAYGAIN_* tags — untagged files play unchanged.
            let rg_off = CheckMenuItemBuilder::with_id("replaygain-off", "Off")
                .checked(true)
                .build(app)?;
            let rg_track =
                CheckMenuItemBuilder::with_id("replaygain-track", "Track").build(app)?;
            let rg_album =
                CheckMenuItemBuilder::with_id("replaygain-album", "Album").build(app)?;
            let replaygain_menu = SubmenuBuilder::new(app, "ReplayGain")
                .item(&rg_off)
                .item(&rg_track)
                .item(&rg_album)
                .build()?;
            // Follow the file's sample rate: put the output device at the rate
            // the music was made at instead of resampling everything to whatever
            // the device is set to. Sits with the other audio-path settings
            // (Equalizer, ReplayGain). Off by default and the only Playback
            // checkbox that is — switching rates reconfigures the device for
            // every app on the machine, and costs a short silence between two
            // tracks that don't share a rate, so it's opt-in.
            let follow_sample_rate =
                CheckMenuItemBuilder::with_id("follow-sample-rate", "Match Source Sample Rate")
                    .build(app)?;
            let playback_menu = SubmenuBuilder::new(app, "Playback")
                .item(&play_pause)
                .item(&previous)
                .item(&next)
                .item(&volume_up)
                .item(&volume_down)
                .item(&mute)
                .separator()
                .item(&shuffle)
                .item(&repeat_menu)
                .item(&autoadvance)
                .separator()
                .item(&equalizer)
                .item(&replaygain_menu)
                .item(&follow_sample_rate)
                .build()?;
            app.manage(PlaybackMenu {
                autoadvance,
                shuffle,
                repeat_off,
                repeat_all,
                repeat_one,
                mute,
                rg_off,
                rg_track,
                rg_album,
                follow_sample_rate,
            });

            // View menu: presentation choices, as distinct from Playback's
            // transport — this is where macOS apps (Music/iTunes) put them. The
            // Visualizer toggle swaps the hero between album art and the MilkDrop
            // visualizer; it's a single checkable item (mirroring the topbar viz
            // button's on/off state), kept in sync from the frontend
            // (set_now_playing_view_checked). ⌘T is Apple's classic iTunes
            // "Show Visualizer" accelerator.
            let np_view_visualizer =
                CheckMenuItemBuilder::with_id("np-view-visualizer", "Visualizer")
                    .accelerator("CmdOrCtrl+T")
                    .build(app)?;
            // Zen Mode: an immersive full-window player (hides all chrome), NOT a
            // native window fullscreen — the two compose, and Zen inside full
            // screen is the album-art-fills-the-display state neither reaches
            // alone. A checkable toggle, kept in sync from the frontend
            // (set_zen_mode_checked). ⌘⇧F keeps it on the same letter as the real
            // fullscreen below, the modifier tier marking which is ours (⌘⇧) and
            // which is the system's (⌃⌘).
            let zen_mode = CheckMenuItemBuilder::with_id("np-zen", "Zen Mode")
                .accelerator("CmdOrCtrl+Shift+F")
                .build(app)?;
            // Real window fullscreen, which the window has always supported (the
            // green traffic light offers it) with no menu item to reach it — and
            // ⌃⌘F is an App Shortcut macOS routes to a menu item *by name*, so
            // without one the key did nothing. This predefined item brings both
            // the ⌃⌘F accelerator and toggleFullScreen: with it. Left as muda's
            // default "Toggle Full Screen" rather than "Enter Full Screen": AppKit
            // only swaps Enter/Exit titles for the standard nib item, and a
            // toggle label reads correctly in both states.
            let fullscreen = PredefinedMenuItem::fullscreen(app, None)?;
            let view_menu = SubmenuBuilder::new(app, "View")
                .item(&np_view_visualizer)
                .separator()
                .item(&zen_mode)
                .item(&fullscreen)
                .build()?;
            app.manage(ViewMenu {
                np_view_visualizer,
                zen_mode,
            });

            // File menu. Open... (⌘O) is the in-app equivalent of double-clicking a
            // file in the Finder, and takes either kind Pudding can open — a track
            // or a playlist — so there is one Open, not two. Its picker is native
            // (owned by the backend, unlike the playlist dialogs below) so the
            // choice can go straight into deliver_open_file — the very same path an
            // "Open With" Apple Event takes, extension gate and all.
            let open_file = MenuItemBuilder::with_id("open-file-dialog", "Open...")
                .accelerator("CmdOrCtrl+O")
                .build(app)?;
            // Open Recent ▸ sits with it and mixes both kinds, since both arrive
            // through that one Open. It is filled only by actual openings — never by
            // browsing the library, which would crowd out the openings worth
            // returning to. Starts as a placeholder; the frontend syncs it after
            // load (set_recent_items, which also gives each row its icon).
            let recent_submenu = SubmenuBuilder::new(app, "Open Recent").build()?;
            let recent_placeholder = MenuItemBuilder::with_id("recent-empty", "No Recent Items")
                .enabled(false)
                .build(app)?;
            // The rest is playlist document handling: New (there is no "new track"),
            // Save Queue as Playlist (⌘S) and Move Playlist File.... Each relays to
            // the frontend, which owns the dialogs and file writes. Save starts
            // disabled — only an ephemeral queue can be converted.
            let new_playlist =
                MenuItemBuilder::with_id("playlist-new", "New Playlist...").build(app)?;
            recent_submenu.append(&recent_placeholder)?;
            let save_as = MenuItemBuilder::with_id("playlist-save", "Save Queue as Playlist...")
                .accelerator("CmdOrCtrl+S")
                .enabled(false)
                .build(app)?;
            let move_file = MenuItemBuilder::with_id("playlist-move", "Move Playlist File...")
                .enabled(false)
                .build(app)?;
            let playlist_menu = SubmenuBuilder::new(app, "File")
                .item(&open_file)
                .item(&recent_submenu)
                .separator()
                .item(&new_playlist)
                .item(&save_as)
                .item(&move_file)
                .build()?;
            app.manage(PlaylistMenu {
                save_as,
                move_file,
                recent: recent_submenu,
            });

            // Standard macOS Window menu. Minimize/Zoom/Close are predefined items
            // that carry their own behavior and ⌘M/⌘W accelerators. "Mini Player"
            // is ours: a checkbox that toggles the app's compact mode (⌘⇧M),
            // matching where Apple Music surfaces it. The frontend owns the mode
            // and re-syncs the checkmark (set_miniplayer_checked).
            let miniplayer = CheckMenuItemBuilder::with_id("window-miniplayer", "Mini Player")
                .accelerator("CmdOrCtrl+Shift+M")
                .build(app)?;
            let window_menu = SubmenuBuilder::new(app, "Window")
                .item(&miniplayer)
                .separator()
                .minimize()
                .maximize()
                .separator()
                .close_window()
                .build()?;
            app.manage(WindowMenu { miniplayer });

            // The submenu title must be exactly "Help" so macOS treats it as the
            // app's Help menu and injects its built-in search field (the one that
            // indexes every menu item — type "equalizer" and it points you at the
            // item; see wire_macos_help_menu).
            let website_item = MenuItemBuilder::with_id("open-website", "Website").build(app)?;
            // Support is a store requirement as much as a courtesy: the app has to
            // offer a way to reach the developer without leaving it to find one.
            let support_item = MenuItemBuilder::with_id("open-support", "Support").build(app)?;
            // Licenses opens another right-pane panel in the Settings/About family
            // (same Back button): the open source software Pudding is built from,
            // generated from the real dependency graph at build time.
            let licenses_item =
                MenuItemBuilder::with_id("open-licenses", "Licenses").build(app)?;
            let help_menu = SubmenuBuilder::new(app, "Help")
                .item(&website_item)
                .item(&support_item)
                .item(&licenses_item)
                .build()?;

            // Order follows macOS convention: the app menu, then File (which owns
            // New/Open/Save — playlists are Pudding's only document type), Edit,
            // View (presentation choices), our Playback menu, Window, and Help last.
            let menu = MenuBuilder::new(app)
                .items(&[
                    &app_menu,
                    &playlist_menu,
                    &edit_menu,
                    &view_menu,
                    &playback_menu,
                    &window_menu,
                    &help_menu,
                ])
                .build()?;
            app.set_menu(menu)?;

            // macOS only adds the Help search field once the menu is registered as
            // NSApp.helpMenu; do it after the menu is installed.
            #[cfg(target_os = "macos")]
            wire_macos_help_menu();

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_dir,
            read_stream_list,
            default_stream_list_path,
            add_stream,
            update_stream,
            delete_stream,
            move_stream,
            to_file_url,
            rescan_libraries,
            watch_libraries,
            search_tracks,
            search_folders,
            folder_tracks,
            dropped_tracks,
            search_artists,
            search_albums,
            artist_tracks,
            album_tracks,
            list_all_songs,
            list_all_artists,
            list_all_albums,
            list_all_genres,
            genre_tracks,
            list_all_decades,
            decade_tracks,
            artist_albums,
            artist_albumless_tracks,
            get_art,
            get_stream_image,
            frontend_ready,
            e2e_port,
            settings_path,
            focus_e2e_window,
            window_number,
            prepare_external_file,
            write_tags,
            cancel_tag_write,
            read_file_tags,
            read_common_tags,
            read_artwork_file,
            audio_play,
            audio_play_stream,
            audio_toggle_pause,
            audio_seek,
            audio_clear_upcoming,
            set_autoadvance_checked,
            set_shuffle_checked,
            set_repeat_checked,
            set_mute_checked,
            set_replaygain_checked,
            set_follow_sample_rate_checked,
            set_miniplayer_checked,
            set_now_playing_view_checked,
            set_zen_mode_checked,
            set_save_playlist_enabled,
            set_move_playlist_enabled,
            set_edit_undo_state,
            set_recent_items,
            set_recent_icons,
            audio_append,
            audio_stop,
            audio_set_volume,
            audio_set_eq,
            audio_set_replaygain,
            audio_set_follow_sample_rate,
            now_playing_set_metadata,
            now_playing_set_playback,
            now_playing_clear,
            playlist::read_playlist,
            playlist::write_playlist,
            playlist::playlist_mtime,
            playlist::move_playlist,
            playlist::rename_playlist,
            playlist::delete_playlist,
            playlist::list_all_playlists,
            root_access::bookmark_root,
            root_access::hold_library_roots,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // The output device's sample rate is global system state. On a
            // normal exit, give the audio thread one synchronous chance to put
            // back the rate that source matching displaced. Its ownership
            // guard leaves a later user/third-party change untouched.
            if matches!(&event, tauri::RunEvent::Exit) {
                app.state::<audio::AudioEngine>().restore_rate_on_exit();
            }
            // macOS: file associations and "open with" deliver paths via Apple
            // Events, surfaced here as file:// URLs. Fires both on cold start
            // (after setup) and while the app is already running.
            if let tauri::RunEvent::Opened { urls } = event {
                for url in urls {
                    if url.scheme() == "file" {
                        if let Ok(path) = url.to_file_path() {
                            if let Some(s) = path.to_str() {
                                deliver_open_file(app, s.to_string());
                            }
                        }
                    }
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn track_columns_match_the_schema_and_the_row_reader() {
        // Three things are coupled by position and nothing but a comment holds
        // them together: the tracks table, the TRACK_COLUMNS select list, and the
        // indices track_row reads. Adding a column to two of the three is the easy
        // mistake — and it fails at runtime, in one pane, as a cell that is blank
        // or (worse) shows the neighbouring column's value.
        let conn = Connection::open_in_memory().expect("open");
        init_schema(&conn).expect("schema");
        conn.execute(
            "INSERT INTO tracks (path, root, mtime, size, title, duration, dataless)
             VALUES ('/m/a.flac', '/m', 42, 7, 'A', 1.5, 1)",
            [],
        )
        .expect("insert");

        let sql = format!("SELECT {TRACK_COLUMNS} FROM tracks");
        let row = conn
            .query_row(&sql, [], track_row)
            .expect("every TRACK_COLUMNS name must exist in the tracks table");

        // Spot-check both ends of the list plus the column just added: a shifted
        // index shows up here as a value landing in its neighbour's field.
        assert_eq!(row.path, "/m/a.flac");
        assert_eq!(row.title.as_deref(), Some("A"));
        assert_eq!(row.duration, Some(1.5));
        assert_eq!(row.modified, Some(42));
        assert!(row.not_downloaded);
    }

    #[test]
    fn audio_extensions_exclude_drm() {
        // A regression guard on a decision, not on a behaviour: FairPlay containers
        // are excluded by being absent from AUDIO_EXTS, which is easy to undo by
        // accident when adding a format. If this fails, Apple Music subscription
        // downloads are about to start appearing as rows that cannot play.
        for drm in [
            "Song.m4p",
            "/Users/x/Music/Music/Media.localized/A/B/Track.m4p",
            "Book.m4b",
        ] {
            assert!(!is_audio_path(drm), "{drm} must not be scanned or opened");
            assert!(!is_openable_path(drm), "{drm} must not be an association");
        }
        // The DRM-free sibling of the same container format still plays.
        assert!(is_audio_path("Purchase.m4a"));
    }

    #[test]
    fn m3u_stream_list_named_and_bare_entries() {
        let streams = parse_m3u_stream_list(
            "#EXTM3U\r\n#EXTINF:-1,SomaFM Groove Salad\r\nhttps://ice5.somafm.com/groovesalad-128-mp3\r\n\r\nhttps://stream.nightride.fm/nightride.mp3\r\n",
        )
        .unwrap();
        assert_eq!(streams.len(), 2);
        assert_eq!(streams[0].name, "SomaFM Groove Salad");
        assert_eq!(
            streams[0].url,
            "https://ice5.somafm.com/groovesalad-128-mp3"
        );
        // No #EXTINF: hostname stands in for the name.
        assert_eq!(streams[1].name, "stream.nightride.fm");
    }

    #[test]
    fn m3u_stream_list_headerless_and_title_variants() {
        // Bare URL list with no #EXTM3U header is still a valid stream list.
        let streams = parse_m3u_stream_list("http://ex.am/ple\n").unwrap();
        assert_eq!(streams[0].name, "ex.am");

        // Attribute-style EXTINF: title is everything after the first comma.
        let streams =
            parse_m3u_stream_list("#EXTINF:-1 tvg-id=\"x\",My Station\nhttp://ex.am/s\n").unwrap();
        assert_eq!(streams[0].name, "My Station");

        // Empty EXTINF title falls back like a bare URL; other comments
        // between EXTINF and URL don't eat the pending title.
        let streams = parse_m3u_stream_list(
            "#EXTINF:-1,Named\n#EXTVLCOPT:network-caching=1000\nhttp://ex.am/a\n#EXTINF:-1,\nhttp://ex.am/b\n",
        )
        .unwrap();
        assert_eq!(streams[0].name, "Named");
        assert_eq!(streams[1].name, "ex.am");
    }

    #[test]
    fn m3u_stream_list_tvg_logo_art() {
        let streams = parse_m3u_stream_list(
            "#EXTM3U\n#EXTINF:-1 tvg-logo=\"https://ex.am/c.png\",Arty\nhttp://ex.am/c\n#EXTINF:-1,Plain\nhttp://ex.am/a\n",
        )
        .unwrap();
        assert_eq!(streams[0].name, "Arty");
        assert_eq!(streams[0].image.as_deref(), Some("https://ex.am/c.png"));
        // No tvg-logo, and art doesn't leak onto the next stream.
        assert_eq!(streams[1].name, "Plain");
        assert_eq!(streams[1].image, None);
    }

    // A form the user opened and saved untouched must write back exactly what it
    // showed, and an emptied box must clear the item rather than write "" into it.
    // The whole write path against a real file: the sample MP3 the app ships,
    // copied aside. apply_tag_edits is unit-tested above on a bare Tag, but only a
    // save proves the edited tag survives lofty's round trip into an actual
    // container — including the picture, which is the one item that is not text.
    //
    // Run twice: once under the file's own extension, and once under a *lying*
    // one. A real library has files whose name disagrees with their container (an
    // MP4 downloaded as .mp3 is the usual one), and lofty trusts the extension
    // unless asked not to — so the lying copy is the case that fails at the first
    // read, before any of this, if open_tagged ever stops sniffing the bytes.
    #[test]
    fn write_and_read_back_a_real_file() {
        for ext in ["mp3", "m4a"] {
            let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .unwrap()
                .join("pudding sample.mp3");
            let dst =
                std::env::temp_dir().join(format!("pudding-tags-{}.{}", std::process::id(), ext));
            std::fs::copy(&src, &dst).expect("copy sample");

            let mut tagged = open_tagged(&dst, TAGS_ONLY).expect("read");
            if tagged.primary_tag_mut().is_none() {
                let tag_type = tagged.primary_tag_type();
                tagged.insert_tag(lofty::tag::Tag::new(tag_type));
            }
            let tag = tagged.primary_tag_mut().unwrap();
            let edits = TagEdits {
                title: set("Corneria"),
                artist: set("yeyeyeye"),
                genre: set("Chiptune"),
                year: Some(Some(1993)),
                disc: Some(Some(2)),
                disc_total: Some(Some(3)),
                track: Some(Some(4)),
                track_total: Some(Some(5)),
                comment: set("line one\nline two"),
                ..Default::default()
            }
            .normalized();
            // A one-pixel PNG, sniffed by the same from_reader the picker uses.
            let png = std::env::temp_dir().join(format!("pudding-art-{}.png", std::process::id()));
            std::fs::write(&png, PNG_1PX).expect("write png");
            let art = ArtworkEdit::Set {
                path: png.to_string_lossy().into_owned(),
            }
            .resolve()
            .expect("read picture");
            apply_tag_edits(tag, &edits, &art);
            tagged
                .save_to_path(&dst, lofty::config::WriteOptions::default())
                .expect("save");

            let back = read_file_tags(dst.to_string_lossy().into_owned()).expect("read back");
            assert_eq!(back.title.as_deref(), Some("Corneria"), "ext {ext}");
            assert_eq!(back.artist.as_deref(), Some("yeyeyeye"), "ext {ext}");
            assert_eq!(back.genre.as_deref(), Some("Chiptune"), "ext {ext}");
            assert_eq!(back.year, Some(1993), "ext {ext}");
            assert_eq!(back.disc, Some(2), "ext {ext}");
            assert_eq!(back.disc_total, Some(3), "ext {ext}");
            assert_eq!(back.track, Some(4), "ext {ext}");
            assert_eq!(back.track_total, Some(5), "ext {ext}");
            assert_eq!(
                back.comment.as_deref(),
                Some("line one\nline two"),
                "ext {ext}"
            );
            assert!(
                back.artwork
                    .as_deref()
                    .unwrap()
                    .starts_with("data:image/png;base64,"),
                "ext {ext}"
            );

            let _ = std::fs::remove_file(&dst);
            let _ = std::fs::remove_file(&png);
        }
    }

    // The smallest valid PNG: 1x1, transparent.
    const PNG_1PX: &[u8] = &[
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F,
        0x15, 0xC4, 0x89, 0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0x00,
        0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, 0x00, 0x00, 0x00, 0x49,
        0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
    ];

    // Shorthands for the two loud halves of a patch literal, so the tests below
    // read as the instructions they are rather than as nested Options.
    fn set<T: Into<String>>(v: T) -> Option<Option<String>> {
        Some(Some(v.into()))
    }
    fn clear<T>() -> Option<Option<T>> {
        Some(None)
    }

    #[test]
    fn tag_edits_deserialize_from_the_editor_payload() {
        let json = r#"{"title":null,"artist":"yeyeyeye","albumArtist":null,"album":null,
            "genre":null,"comment":"ueueueue","disc":2,"discTotal":3,"track":4,
            "trackTotal":5,"year":null,"artwork":{"kind":"set","path":"/tmp/x.png"}}"#;
        let edits: TagEdits = serde_json::from_str(json).expect("deserialize");
        assert_eq!(edits.artist, set("yeyeyeye"));
        assert_eq!(edits.disc_total, Some(Some(3)));
        assert!(matches!(edits.artwork, ArtworkEdit::Set { .. }));
        let keep = r#"{"artwork":{"kind":"keep"}}"#;
        let edits: TagEdits = serde_json::from_str(keep).expect("deserialize keep");
        assert!(matches!(edits.artwork, ArtworkEdit::Keep));
    }

    // The distinction the whole patch rests on: serde reads an absent key and a
    // present null identically on a plain Option, and these must not be the same
    // instruction. Absent leaves the tag alone; null clears it.
    #[test]
    fn an_absent_key_is_not_a_null_one() {
        let edits: TagEdits = serde_json::from_str(r#"{"album":"Night Bus"}"#).expect("patch");
        assert_eq!(edits.album, set("Night Bus"));
        assert_eq!(edits.title, None, "a key the form never sent");
        assert_eq!(edits.year, None);

        let edits: TagEdits = serde_json::from_str(r#"{"title":null,"year":null}"#).expect("nulls");
        assert_eq!(edits.title, clear(), "an explicit null is a clear");
        assert_eq!(edits.year, Some(None));
    }

    // An untouched field is not an instruction, so nothing about the file changes
    // where the patch is silent — including the tags the editor doesn't offer.
    #[test]
    fn an_absent_key_leaves_its_tag_alone() {
        let mut tag = lofty::tag::Tag::new(lofty::tag::TagType::Id3v2);
        tag.set_title("Borrowed Light".into());
        tag.set_artist("Wren".into());
        tag.insert_text(lofty::tag::ItemKey::Composer, "Hollis".into());
        // The ID3 full date the old write path destroyed on every save: the year
        // box shows 1979, and an unrelated edit used to write that back through
        // set_year and lose the month and day.
        tag.insert_text(lofty::tag::ItemKey::RecordingDate, "1979-10-05".into());

        let album_only = TagEdits {
            album: set("Night Bus"),
            ..Default::default()
        }
        .normalized();
        apply_tag_edits(&mut tag, &album_only, &ArtworkChange::Keep);

        assert_eq!(tag.album().as_deref(), Some("Night Bus"));
        assert_eq!(tag.title().as_deref(), Some("Borrowed Light"));
        assert_eq!(tag.artist().as_deref(), Some("Wren"));
        assert_eq!(
            tag.get_string(&lofty::tag::ItemKey::Composer),
            Some("Hollis")
        );
        assert_eq!(
            tag.get_string(&lofty::tag::ItemKey::RecordingDate),
            Some("1979-10-05"),
            "an untouched Year box does not flatten a full date"
        );

        // And the explicit null still clears.
        let drop_title = TagEdits {
            title: clear(),
            ..Default::default()
        }
        .normalized();
        apply_tag_edits(&mut tag, &drop_title, &ArtworkChange::Keep);
        assert_eq!(tag.title(), None);
        assert_eq!(tag.artist().as_deref(), Some("Wren"));
    }

    // The corollary the cache and every surface depend on: a patch carrying only
    // `album` describes the edit, not the file, so the fields handed back have to
    // be read off the mutated tag. Built from the patch instead, this is 300 rows
    // that have lost their titles while the files on disk are fine.
    #[test]
    fn the_read_back_reports_the_file_not_the_patch() {
        let mut tag = lofty::tag::Tag::new(lofty::tag::TagType::Id3v2);
        tag.set_title("Borrowed Light".into());
        tag.set_artist("Wren".into());
        tag.set_year(1979);
        let album_only = TagEdits {
            album: set("Night Bus"),
            ..Default::default()
        }
        .normalized();
        apply_tag_edits(&mut tag, &album_only, &ArtworkChange::Keep);

        let back = cached_fields(&tag);
        assert_eq!(back.album.as_deref(), Some("Night Bus"));
        assert_eq!(back.title.as_deref(), Some("Borrowed Light"));
        assert_eq!(back.artist.as_deref(), Some("Wren"));
        assert_eq!(back.year, Some(1979));
    }

    #[test]
    fn tag_edits_round_trip_and_clear() {
        let mut tag = lofty::tag::Tag::new(lofty::tag::TagType::Id3v2);
        let filled = TagEdits {
            title: set("  Borrowed Light  "),
            artist: set("Wren"),
            album_artist: set("Various Artists"),
            album: set("Night Bus"),
            disc: Some(Some(1)),
            disc_total: Some(Some(2)),
            track: Some(Some(3)),
            track_total: Some(Some(12)),
            year: Some(Some(1979)),
            genre: set("Ambient"),
            comment: set("ripped from vinyl"),
            artwork: ArtworkEdit::Keep,
        }
        .normalized();
        apply_tag_edits(&mut tag, &filled, &ArtworkChange::Keep);

        // Trimmed on the way in, like every other text field.
        assert_eq!(tag.title().as_deref(), Some("Borrowed Light"));
        assert_eq!(tag.artist().as_deref(), Some("Wren"));
        assert_eq!(
            tag.get_string(&lofty::tag::ItemKey::AlbumArtist),
            Some("Various Artists")
        );
        assert_eq!(tag.album().as_deref(), Some("Night Bus"));
        assert_eq!(tag.disk(), Some(1));
        assert_eq!(tag.disk_total(), Some(2));
        assert_eq!(tag.track(), Some(3));
        assert_eq!(tag.track_total(), Some(12));
        assert_eq!(tag.year(), Some(1979));
        assert_eq!(tag.genre().as_deref(), Some("Ambient"));
        assert_eq!(tag.comment().as_deref(), Some("ripped from vinyl"));

        // Whitespace is not a value: a box typed full of spaces clears, same as
        // one emptied. It reaches here as Some(Some("   ")) — a field the user
        // touched — and normalized() turns it into the clear it means.
        let cleared = TagEdits {
            title: set("   "),
            artist: clear(),
            album_artist: clear(),
            album: clear(),
            disc: Some(None),
            disc_total: Some(None),
            track: Some(None),
            track_total: Some(None),
            year: Some(None),
            genre: clear(),
            comment: clear(),
            artwork: ArtworkEdit::Keep,
        }
        .normalized();
        apply_tag_edits(&mut tag, &cleared, &ArtworkChange::Keep);
        assert_eq!(tag.title(), None);
        assert_eq!(tag.artist(), None);
        assert_eq!(tag.get_string(&lofty::tag::ItemKey::AlbumArtist), None);
        assert_eq!(tag.album(), None);
        assert_eq!(tag.disk(), None);
        assert_eq!(tag.disk_total(), None);
        assert_eq!(tag.track(), None);
        assert_eq!(tag.track_total(), None);
        assert_eq!(tag.year(), None);
        assert_eq!(tag.genre(), None);
        assert_eq!(tag.comment(), None);
    }

    // The assumption the editor's Year field is built on: a year is four digits or
    // it is nothing. Both tag families keep it inside a date item (ID3v2.4's TDRC,
    // MP4's ©day), and lofty reads a year back out only when it finds four digits
    // — so a shorter one would be written to the file and then be invisible to
    // Pudding and to every other player. The editor refuses it in the field rather
    // than let a save swallow it; if this ever stops holding, that rule should go.
    #[test]
    fn a_year_is_four_digits_or_it_is_not_read_back() {
        let mut tag = lofty::tag::Tag::new(lofty::tag::TagType::Mp4Ilst);
        tag.insert_text(lofty::tag::ItemKey::RecordingDate, "1993".into());
        assert_eq!(tag.year(), Some(1993));
        tag.insert_text(lofty::tag::ItemKey::RecordingDate, "123".into());
        assert_eq!(
            tag.year(),
            None,
            "a three-digit year does not survive the read"
        );
        // And a full date still answers with its year, which is why the editor
        // writes back only the year it showed (see apply_tag_edits).
        tag.insert_text(lofty::tag::ItemKey::RecordingDate, "1979-10-05".into());
        assert_eq!(tag.year(), Some(1979));
    }

    // The well shows picture 0, so a save may replace or drop picture 0 — and must
    // leave anything queued behind it (a back cover, a band photo) alone.
    #[test]
    fn artwork_edit_touches_only_the_first_picture() {
        let png = |byte: u8| {
            lofty::picture::Picture::new_unchecked(
                lofty::picture::PictureType::CoverFront,
                Some(lofty::picture::MimeType::Png),
                None,
                vec![byte],
            )
        };
        let mut tag = lofty::tag::Tag::new(lofty::tag::TagType::Id3v2);
        tag.push_picture(png(1));
        tag.push_picture(lofty::picture::Picture::new_unchecked(
            lofty::picture::PictureType::CoverBack,
            Some(lofty::picture::MimeType::Png),
            None,
            vec![2],
        ));
        let keep = TagEdits::default().normalized();

        apply_tag_edits(&mut tag, &keep, &ArtworkChange::Set(png(9)));
        assert_eq!(tag.pictures().len(), 2);
        assert_eq!(tag.pictures()[0].data(), [9]);
        assert_eq!(tag.pictures()[1].data(), [2]);

        apply_tag_edits(&mut tag, &keep, &ArtworkChange::Remove);
        assert_eq!(tag.pictures().len(), 1);
        assert_eq!(
            tag.pictures()[0].pic_type(),
            lofty::picture::PictureType::CoverBack
        );

        // Removing from a file with no picture at all is a no-op, not a panic.
        apply_tag_edits(&mut tag, &keep, &ArtworkChange::Remove);
        apply_tag_edits(&mut tag, &keep, &ArtworkChange::Remove);
        assert!(tag.pictures().is_empty());
    }

    // === The batch loop ===
    //
    // Everything the loop talks to arrives as a closure, so these run against real
    // files on disk and literal answers for the engine, the Stop button and the
    // library cache. The one test that wants a real database says so.

    // A scratch directory holding `n` copies of the sample MP3, named 0.mp3, 1.mp3...
    // Returned as the path strings the loop takes. The caller removes the directory.
    fn sample_copies(name: &str, n: usize) -> (PathBuf, Vec<String>) {
        let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("pudding sample.mp3");
        let dir =
            std::env::temp_dir().join(format!("pudding-bulk-{}-{}", std::process::id(), name));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch dir");
        let paths = (0..n)
            .map(|i| {
                let dst = dir.join(format!("{i}.mp3"));
                std::fs::copy(&src, &dst).expect("copy sample");
                dst.to_string_lossy().into_owned()
            })
            .collect();
        (dir, paths)
    }

    // The patch every test below sends unless it wants something else: one field,
    // touched. The rest of the file must come through unharmed.
    fn album_patch(album: &str) -> TagEdits {
        TagEdits {
            album: set(album),
            ..Default::default()
        }
        .normalized()
    }

    fn album_of(path: &str) -> Option<String> {
        let tagged = open_tagged(std::path::Path::new(path), TAGS_ONLY).expect("read back");
        let tag = tagged.primary_tag().or_else(|| tagged.first_tag())?;
        tag.album().map(|s| s.to_string())
    }

    // A cache that always succeeds, for the tests that are not about the cache.
    fn cache_ok(_: &str, _: &FileEntry, _: i64, _: i64) -> rusqlite::Result<usize> {
        Ok(1)
    }

    fn nothing_held() -> Vec<String> {
        Vec::new()
    }

    // One unwritable file must not cost the other two their edit — the difference
    // between a bulk save and a bulk save that is safe to reach for.
    #[test]
    fn one_bad_file_does_not_sink_the_batch() {
        let (dir, mut paths) = sample_copies("bad-file", 3);
        let missing = dir.join("gone.mp3").to_string_lossy().into_owned();
        paths[1] = missing.clone();

        let seen = std::cell::RefCell::new(Vec::new());
        let report = write_tags_to_files(
            &paths,
            &album_patch("Night Bus"),
            &ArtworkChange::Keep,
            &cache_ok,
            &nothing_held,
            &|| false,
            &|done, total| seen.borrow_mut().push((done, total)),
        );

        assert_eq!(report.ok.len(), 2);
        assert!(!report.stopped);
        assert_eq!(report.failed.len(), 1);
        assert_eq!(report.failed[0].path, missing);
        assert!(!report.failed[0].stale, "the file was not written at all");
        assert_eq!(album_of(&paths[0]).as_deref(), Some("Night Bus"));
        assert_eq!(album_of(&paths[2]).as_deref(), Some("Night Bus"));
        // Every path reports, failures included: the label counts files handled,
        // not files saved.
        assert_eq!(*seen.borrow(), vec![(1, 3), (2, 3), (3, 3)]);

        let _ = std::fs::remove_dir_all(&dir);
    }

    // The behaviour change the mode collapse brings, and the one a user could
    // notice: a tag holding only whitespace shows as an empty box, so it is
    // untouched, so it is not sent — and now survives a save that used to clear it.
    #[test]
    fn an_untouched_whitespace_only_tag_survives() {
        let (dir, paths) = sample_copies("whitespace", 1);
        {
            let mut tagged = open_tagged(std::path::Path::new(&paths[0]), TAGS_ONLY).expect("read");
            if tagged.primary_tag_mut().is_none() {
                let tag_type = tagged.primary_tag_type();
                tagged.insert_tag(lofty::tag::Tag::new(tag_type));
            }
            let tag = tagged.primary_tag_mut().unwrap();
            tag.set_comment("   ".into());
            tagged
                .save_to_path(
                    std::path::Path::new(&paths[0]),
                    lofty::config::WriteOptions::default(),
                )
                .expect("seed comment");
        }

        let report = write_tags_to_files(
            &paths,
            &album_patch("Night Bus"),
            &ArtworkChange::Keep,
            &cache_ok,
            &nothing_held,
            &|| false,
            &|_, _| {},
        );
        assert_eq!(report.ok.len(), 1);

        let tagged = open_tagged(std::path::Path::new(&paths[0]), TAGS_ONLY).expect("read back");
        let tag = tagged.primary_tag().expect("tag");
        assert_eq!(tag.comment().as_deref(), Some("   "));
        assert_eq!(tag.album().as_deref(), Some("Night Bus"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    // The engine is asked per file, not handed a path at submit: the decode
    // frontier moves while a batch runs. A held file is refused and left exactly
    // as it was — asserted on its bytes, since a rewrite under the decoder is the
    // thing this exists to prevent.
    #[test]
    fn a_held_file_is_refused_and_left_byte_identical() {
        let (dir, paths) = sample_copies("held", 3);
        let before = std::fs::read(&paths[1]).expect("read before");
        let held = paths[1].clone();

        let report = write_tags_to_files(
            &paths,
            &album_patch("Night Bus"),
            &ArtworkChange::Keep,
            &cache_ok,
            &|| vec![held.clone()],
            &|| false,
            &|_, _| {},
        );

        assert_eq!(report.ok.len(), 2);
        assert_eq!(report.failed.len(), 1);
        assert_eq!(report.failed[0].path, paths[1]);
        assert_eq!(
            report.failed[0].message,
            "Can't write a track while it's playing"
        );
        assert_eq!(std::fs::read(&paths[1]).expect("read after"), before);
        assert_eq!(album_of(&paths[0]).as_deref(), Some("Night Bus"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    // Stop means "write no more files", never "undo the ones already written" —
    // and the files it did not reach are untouched, not half-written.
    #[test]
    fn a_cancel_between_files_stops_the_batch() {
        let (dir, paths) = sample_copies("cancel", 3);
        let untouched = std::fs::read(&paths[2]).expect("read before");
        let handled = std::cell::Cell::new(0usize);

        let report = write_tags_to_files(
            &paths,
            &album_patch("Night Bus"),
            &ArtworkChange::Keep,
            &cache_ok,
            &nothing_held,
            // Pressed while the first file was being written.
            &|| handled.get() >= 1,
            &|done, _| handled.set(done),
        );

        assert!(report.stopped);
        assert_eq!(report.ok.len(), 1);
        assert!(report.failed.is_empty(), "unreached is not failed");
        assert_eq!(album_of(&paths[0]).as_deref(), Some("Night Bus"));
        assert_eq!(std::fs::read(&paths[2]).expect("read after"), untouched);

        let _ = std::fs::remove_dir_all(&dir);
    }

    // The generation stamp: a Stop aimed at the batch the user already watched
    // finish must not kill the one they started next.
    #[test]
    fn a_stale_cancel_does_not_stop_the_current_batch() {
        let (dir, paths) = sample_copies("stale-cancel", 2);
        let cancel = TagWriteCancel::default();
        // The user stopped batch 1; this is batch 2.
        cancel
            .generation
            .store(1, std::sync::atomic::Ordering::Relaxed);
        let generation = 2u64;

        let report = write_tags_to_files(
            &paths,
            &album_patch("Night Bus"),
            &ArtworkChange::Keep,
            &cache_ok,
            &nothing_held,
            &|| cancel.generation.load(std::sync::atomic::Ordering::Relaxed) == generation,
            &|_, _| {},
        );
        assert!(!report.stopped);
        assert_eq!(report.ok.len(), 2);

        let _ = std::fs::remove_dir_all(&dir);
    }

    // A library row that could not be updated is not a save that failed. The file
    // is correct on disk — asserted on the file, because reporting this as a write
    // failure is the one report worse than saying nothing.
    #[test]
    fn a_cache_failure_is_reported_stale_with_the_file_written() {
        let (dir, paths) = sample_copies("cache-fail", 1);

        let report = write_tags_to_files(
            &paths,
            &album_patch("Night Bus"),
            &ArtworkChange::Keep,
            &|_, _, _, _| Err(rusqlite::Error::InvalidQuery),
            &nothing_held,
            &|| false,
            &|_, _| {},
        );

        assert!(report.ok.is_empty());
        assert_eq!(report.failed.len(), 1);
        assert!(report.failed[0].stale);
        assert_eq!(
            report.failed[0].message,
            "Saved the file, but the library list may be stale"
        );
        assert_eq!(album_of(&paths[0]).as_deref(), Some("Night Bus"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    // The busy latch. A scan holds SQLite's write lock across its entire library
    // walk, so once one row times out every row will — at the full busy_timeout
    // each. Three hundred files is up to 25 minutes of a loop sitting in the
    // kernel with Stop read only between files, which is why the assertion that
    // matters here is the attempt *count*: one, not one per file.
    #[test]
    fn the_busy_latch_stops_attempting_after_one_timeout() {
        let (dir, paths) = sample_copies("busy-latch", 3);
        let db_path = dir.join("library.db");
        let conn = open_connection(&db_path).expect("open db");
        init_schema(&conn).expect("schema");
        // The real command waits 5 s per attempt; the point is made in a fraction
        // of that, and the count is what is being asserted either way.
        conn.busy_timeout(Duration::from_millis(100))
            .expect("busy timeout");

        // Stand in for a scan: one connection holding the write lock throughout.
        let scanner = open_connection(&db_path).expect("open scanner");
        scanner
            .execute_batch(
                "BEGIN IMMEDIATE;
                 INSERT INTO tracks (path, root, mtime, size) VALUES ('/x', '/', 1, 1)",
            )
            .expect("hold the write lock");

        let attempts = std::cell::Cell::new(0usize);
        let report = write_tags_to_files(
            &paths,
            &album_patch("Night Bus"),
            &ArtworkChange::Keep,
            &|path, tags, mtime, size| {
                attempts.set(attempts.get() + 1);
                update_cached_row(&conn, path, tags, mtime, size)
            },
            &nothing_held,
            &|| false,
            &|_, _| {},
        );

        assert_eq!(attempts.get(), 1, "latched after the first SQLITE_BUSY");
        assert!(report.ok.is_empty());
        assert_eq!(report.failed.len(), 3);
        assert!(report.failed.iter().all(|f| f.stale));
        // Every file is still correctly written: the batch stays disk-bound, and
        // the rows recover on the next incremental scan because they kept their
        // pre-edit mtime.
        for path in &paths {
            assert_eq!(album_of(path).as_deref(), Some("Night Bus"));
        }

        let _ = scanner.execute_batch("ROLLBACK");
        drop(scanner);
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    // Seed a copy the way a save would, so the fold below reads tags that went
    // through the same write path the editor uses.
    fn seed(path: &str, edits: TagEdits, artwork: &ArtworkChange) {
        let report = write_tags_to_files(
            &[path.to_string()],
            &edits.normalized(),
            artwork,
            &cache_ok,
            &nothing_held,
            &|| false,
            &|_, _| {},
        );
        assert!(report.failed.is_empty(), "seeding {path}");
    }

    fn png_picture(dir: &Path) -> ArtworkChange {
        let png = dir.join("art.png");
        std::fs::write(&png, PNG_1PX).expect("write png");
        ArtworkEdit::Set {
            path: png.to_string_lossy().into_owned(),
        }
        .resolve()
        .expect("read picture")
    }

    // The bulk seed: what the selection shares lands in `common`, what it doesn't
    // is *named* in `mixed` — a list, not a sentinel, so the form can tell "they
    // all agree there's no comment" from "the comments differ".
    #[test]
    fn a_bulk_seed_folds_to_what_the_selection_shares() {
        let (dir, paths) = sample_copies("common-tags", 3);
        let art = png_picture(&dir);
        for (i, path) in paths.iter().enumerate() {
            seed(
                path,
                TagEdits {
                    album: set("Night Bus"),
                    year: Some(Some(1979)),
                    title: set(format!("Track {i}")),
                    ..Default::default()
                },
                &art,
            );
        }

        let seen = std::cell::RefCell::new(Vec::new());
        let folded = fold_common_tags(&paths, &|done, total| seen.borrow_mut().push((done, total)))
            .expect("fold");

        assert_eq!(folded.common.album.as_deref(), Some("Night Bus"));
        assert_eq!(folded.common.year, Some(1979));
        assert!(!folded.mixed.iter().any(|k| k == "album"));

        assert_eq!(folded.common.title, None, "a mixed field carries no value");
        assert!(folded.mixed.iter().any(|k| k == "title"));
        // Names differ across any real selection; the heading ignores it.
        assert!(folded.mixed.iter().any(|k| k == "name"));

        // The artwork carve-out: folded on digests, handed back as the picture.
        assert!(!folded.mixed.iter().any(|k| k == "artwork"));
        assert!(
            folded
                .common
                .artwork
                .as_deref()
                .unwrap()
                .starts_with("data:image/png;base64,"),
            "the surviving cover is encoded once, at the end"
        );
        assert_eq!(*seen.borrow(), vec![(1, 3), (2, 3), (3, 3)]);

        let _ = std::fs::remove_dir_all(&dir);
    }

    // Once every field disagrees there is nothing left to learn, and the files
    // after that point are never opened — the assertion that matters is which
    // files the fold touched, since on a large heterogeneous selection that is the
    // whole cost of the read.
    #[test]
    fn a_selection_that_agrees_on_nothing_stops_the_read_early() {
        let (dir, paths) = sample_copies("all-mixed", 4);
        let art = png_picture(&dir);
        for (i, path) in paths.iter().enumerate() {
            let n = i as u32 + 1;
            seed(
                path,
                TagEdits {
                    title: set(format!("Title {i}")),
                    artist: set(format!("Artist {i}")),
                    album: set(format!("Album {i}")),
                    album_artist: set(format!("Various {i}")),
                    genre: set(format!("Genre {i}")),
                    comment: set(format!("Comment {i}")),
                    disc: Some(Some(n)),
                    disc_total: Some(Some(n + 10)),
                    track: Some(Some(n + 20)),
                    track_total: Some(Some(n + 30)),
                    year: Some(Some(1979 + n)),
                    ..Default::default()
                },
                // The covers have to disagree too, or artwork holds the fold open.
                if i % 2 == 0 {
                    &art
                } else {
                    &ArtworkChange::Remove
                },
            );
        }

        let seen = std::cell::RefCell::new(Vec::new());
        let folded = fold_common_tags(&paths, &|done, total| seen.borrow_mut().push((done, total)))
            .expect("fold");

        assert_eq!(folded.common.title, None);
        assert_eq!(folded.common.artwork, None);
        for key in ["title", "artist", "album", "year", "artwork", "name"] {
            assert!(folded.mixed.iter().any(|k| k == key), "{key} must be mixed");
        }
        // Two files settled every field; the last two were never opened. The
        // second file's own number is never reported — the fold knows on reading
        // it that the read is over, so the label goes straight to done rather
        // than resting on 2 of 4.
        assert_eq!(*seen.borrow(), vec![(1, 4), (4, 4)]);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn file_url_to_path_conversion() {
        assert_eq!(
            file_url_to_path("file:///art/My%20Station.png"),
            Some(PathBuf::from("/art/My Station.png"))
        );
        // Non-file URLs and bare paths are not local files.
        assert_eq!(file_url_to_path("https://ex.am/c.png"), None);
        assert_eq!(file_url_to_path("art/b.png"), None);
        assert_eq!(file_url_to_path("/art/b.png"), None);
    }

    #[test]
    fn image_mime_guessing() {
        assert_eq!(image_mime_from_ext("/a/cover.PNG"), "image/png");
        assert_eq!(image_mime_from_ext("https://x/logo.webp?v=2"), "image/webp");
        assert_eq!(image_mime_from_ext("noextension"), "image/jpeg");
    }

    #[test]
    fn m3u_stream_list_rejects_non_playlists() {
        // Arbitrary text with no header and no URLs is not a stream list.
        assert!(parse_m3u_stream_list("just some notes\nnothing here\n").is_none());
        // A header alone is a valid, empty stream list.
        assert_eq!(parse_m3u_stream_list("#EXTM3U\n").unwrap().len(), 0);
    }

    #[test]
    fn add_stream_appends_and_round_trips() {
        let path = std::env::temp_dir().join(format!("pudding-add-{}.m3u8", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let p = path.to_string_lossy().into_owned();

        // First add seeds the header on a missing file.
        add_stream(
            p.clone(),
            "  Jazz24  ".into(),
            " https://ex.am/jazz ".into(),
            None,
        )
        .unwrap();
        // Second add carries art and lands on its own line after the first.
        add_stream(
            p.clone(),
            "Arty".into(),
            "https://ex.am/art".into(),
            Some("https://ex.am/logo.png".into()),
        )
        .unwrap();

        let streams = parse_m3u_stream_list(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(streams.len(), 2);
        // Name and URL are trimmed on the way in.
        assert_eq!(streams[0].name, "Jazz24");
        assert_eq!(streams[0].url, "https://ex.am/jazz");
        assert_eq!(streams[0].image, None);
        assert_eq!(streams[1].name, "Arty");
        assert_eq!(streams[1].image.as_deref(), Some("https://ex.am/logo.png"));

        // A remote list has no local path to append to, and a scheme-less URL is
        // rejected before anything is written.
        assert!(add_stream(
            "https://ex.am/list.m3u8".into(),
            "x".into(),
            "y".into(),
            None
        )
        .is_err());
        assert!(add_stream(p.clone(), "x".into(), "not-a-url".into(), None).is_err());

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn update_and_delete_stream_edit_in_place() {
        let path = std::env::temp_dir().join(format!("pudding-edit-{}.m3u8", std::process::id()));
        let p = path.to_string_lossy().into_owned();
        // A hand-authored list: header, a bare (EXTINF-less) entry, then a named
        // entry carrying a passthrough #EXTVLCOPT option line.
        std::fs::write(
            &path,
            "#EXTM3U\nhttp://ex.am/bare\n#EXTINF:-1,Named\n#EXTVLCOPT:network-caching=1000\nhttp://ex.am/named\n",
        )
        .unwrap();

        // Updating the bare entry (index 0) introduces an #EXTINF with art.
        update_stream(
            p.clone(),
            0,
            "Now Named".into(),
            "http://ex.am/bare2".into(),
            Some("file:///art/x.png".into()),
            None,
        )
        .unwrap();
        let streams = parse_m3u_stream_list(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(streams[0].name, "Now Named");
        assert_eq!(streams[0].url, "http://ex.am/bare2");
        assert_eq!(streams[0].image.as_deref(), Some("file:///art/x.png"));
        // The second entry and its #EXTVLCOPT are untouched.
        assert_eq!(streams[1].name, "Named");
        assert!(std::fs::read_to_string(&path)
            .unwrap()
            .contains("#EXTVLCOPT:network-caching=1000"));

        // Deleting index 1 takes its #EXTINF, its #EXTVLCOPT, and its URL, leaving
        // only the first station.
        delete_stream(p.clone(), 1, None).unwrap();
        let contents = std::fs::read_to_string(&path).unwrap();
        let streams = parse_m3u_stream_list(&contents).unwrap();
        assert_eq!(streams.len(), 1);
        assert_eq!(streams[0].name, "Now Named");
        assert!(!contents.contains("#EXTVLCOPT"));

        // Out-of-range index is an error, not a silent no-op.
        assert!(delete_stream(p.clone(), 9, None).is_err());

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn move_stream_reorders_keeping_option_lines() {
        let path = std::env::temp_dir().join(format!("pudding-move-{}.m3u8", std::process::id()));
        let p = path.to_string_lossy().into_owned();
        // Three stations; the middle one carries a passthrough option line that
        // must travel with it when it moves.
        std::fs::write(
            &path,
            "#EXTM3U\n#EXTINF:-1,A\nhttp://ex.am/a\n#EXTINF:-1,B\n#EXTVLCOPT:network-caching=1000\nhttp://ex.am/b\n#EXTINF:-1,C\nhttp://ex.am/c\n",
        )
        .unwrap();

        // Move B (index 1) to the front (before index 0).
        move_stream(p.clone(), 1, 0, None).unwrap();
        let contents = std::fs::read_to_string(&path).unwrap();
        let streams = parse_m3u_stream_list(&contents).unwrap();
        assert_eq!(
            streams.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(),
            ["B", "A", "C"],
        );
        // B's option line rode along and the header stayed put.
        assert!(contents.starts_with("#EXTM3U\n#EXTINF:-1,B\n#EXTVLCOPT:network-caching=1000\n"));

        // Move A (now index 1) to the end (to == len).
        move_stream(p.clone(), 1, 3, None).unwrap();
        let streams = parse_m3u_stream_list(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(
            streams.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(),
            ["B", "C", "A"],
        );

        // Out-of-range indices are errors.
        assert!(move_stream(p.clone(), 9, 0, None).is_err());
        assert!(move_stream(p.clone(), 0, 9, None).is_err());

        let _ = std::fs::remove_file(&path);
    }
    #[test]
    fn stream_edits_refuse_a_file_that_moved_under_them() {
        let path = std::env::temp_dir().join(format!("pudding-stale-{}.m3u8", std::process::id()));
        let p = path.to_string_lossy().into_owned();
        let original = "#EXTM3U\n#EXTINF:-1,A\nhttp://ex.am/a\n#EXTINF:-1,B\nhttp://ex.am/b\n";
        std::fs::write(&path, original).unwrap();

        // The ordinals the pane sends are only meaningful against the file it read.
        // With a stamp from some other version of the file, every index-addressed
        // edit refuses rather than renaming or deleting whichever station now sits
        // at that position — and the file is left exactly as it was.
        let stamp = crate::playlist::file_mtime_ms(&p).unwrap();
        let stale = Some(stamp - 5000);
        assert!(delete_stream(p.clone(), 1, stale).is_err());
        assert!(move_stream(p.clone(), 1, 0, stale).is_err());
        assert!(update_stream(
            p.clone(),
            0,
            "X".into(),
            "http://ex.am/x".into(),
            None,
            stale,
        )
        .is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), original);

        // The stamp the file actually carries lets the same edit through. Appending
        // addresses no ordinal, so add_stream takes no stamp at all.
        delete_stream(p.clone(), 1, Some(stamp)).unwrap();
        let streams = parse_m3u_stream_list(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(streams.len(), 1);

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn add_stream_keeps_a_list_it_cannot_read_as_utf8() {
        let path = std::env::temp_dir().join(format!("pudding-latin1-{}.m3u8", std::process::id()));
        let p = path.to_string_lossy().into_owned();
        // A Latin-1 list, the shape read_to_string chokes on — and choking must not
        // read as "the file was empty", which would replace the user's stations with
        // the one being added.
        let mut bytes = b"#EXTM3U\n#EXTINF:-1,Caf".to_vec();
        bytes.push(0xE9);
        bytes.extend_from_slice(b" Radio\nhttp://ex.am/cafe\n");
        std::fs::write(&path, &bytes).unwrap();

        add_stream(p.clone(), "New".into(), "http://ex.am/new".into(), None).unwrap();
        let contents = crate::playlist::decode_bytes(&std::fs::read(&path).unwrap());
        let streams = parse_m3u_stream_list(&contents).unwrap();
        assert_eq!(
            streams.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(),
            ["Café Radio", "New"],
        );

        // A read that fails for a reason other than "no such file" is an error, not
        // an empty slate: a directory stats fine and refuses to be read.
        let dir = std::env::temp_dir().join(format!("pudding-dir-{}.m3u8", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(add_stream(
            dir.to_string_lossy().into_owned(),
            "x".into(),
            "http://ex.am/x".into(),
            None
        )
        .is_err());

        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn stream_rewrites_keep_the_files_line_ending() {
        let path = std::env::temp_dir().join(format!("pudding-crlf-{}.m3u8", std::process::id()));
        let p = path.to_string_lossy().into_owned();
        std::fs::write(
            &path,
            "#EXTM3U\r\n#EXTINF:-1,A\r\nhttp://ex.am/a\r\n#EXTINF:-1,B\r\nhttp://ex.am/b\r\n",
        )
        .unwrap();

        // `lines()` drops the \r, so every rewrite has to put it back — otherwise
        // editing one station silently converts the whole file to LF.
        add_stream(p.clone(), "C".into(), "http://ex.am/c".into(), None).unwrap();
        update_stream(
            p.clone(),
            0,
            "A2".into(),
            "http://ex.am/a".into(),
            None,
            None,
        )
        .unwrap();
        move_stream(p.clone(), 2, 0, None).unwrap();
        delete_stream(p.clone(), 1, None).unwrap();

        let contents = std::fs::read_to_string(&path).unwrap();
        assert!(
            !contents.replace("\r\n", "").contains('\n'),
            "a bare LF survived: {contents:?}"
        );
        let streams = parse_m3u_stream_list(&contents).unwrap();
        assert_eq!(
            streams.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(),
            ["C", "B"],
        );

        let _ = std::fs::remove_file(&path);
    }

    // === Never destroy a file ===
    //
    // lofty rewrites a file where it stands: for ID3v2 it reads the audio into
    // memory, truncates the file to zero and writes it all back. Every test here
    // exists because a save that dies between that truncate and the last byte used
    // to leave an empty file where a song was. write_one_file stages on a copy and
    // renames, so the assertions are all the same shape: after a failure, the track
    // is byte-for-byte what it was.

    // A small APFS volume that can actually be filled. There is no way to fake
    // ENOSPC through std, and ENOSPC is precisely the failure that lands after the
    // truncate — a read-only file or a missing one fails at the open instead, which
    // is the safe half of the story and proves nothing. Returns None where hdiutil
    // isn't available, and the test says it skipped rather than passing quietly.
    struct TinyVolume {
        dmg: PathBuf,
        mount: PathBuf,
    }

    impl TinyVolume {
        fn new(name: &str, megabytes: u32) -> Option<TinyVolume> {
            let volname = format!("PuddingTiny{}{}", std::process::id(), name);
            let dmg = std::env::temp_dir().join(format!("{volname}.dmg"));
            let _ = std::fs::remove_file(&dmg);
            let ok = std::process::Command::new("hdiutil")
                .args([
                    "create",
                    "-size",
                    &format!("{megabytes}m"),
                    "-fs",
                    "APFS",
                    "-volname",
                    &volname,
                    "-quiet",
                ])
                .arg(&dmg)
                .status()
                .ok()?
                .success();
            if !ok {
                return None;
            }
            let attached = std::process::Command::new("hdiutil")
                .args(["attach", "-nobrowse", "-quiet"])
                .arg(&dmg)
                .status()
                .ok()?
                .success();
            if !attached {
                let _ = std::fs::remove_file(&dmg);
                return None;
            }
            Some(TinyVolume {
                dmg,
                mount: PathBuf::from(format!("/Volumes/{volname}")),
            })
        }

        // `n` copies of the sample, as the path strings the loop takes.
        fn with_tracks(&self, n: usize) -> Vec<String> {
            let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .unwrap()
                .join("pudding sample.mp3");
            (0..n)
                .map(|i| {
                    let dst = self.mount.join(format!("{i}.mp3"));
                    std::fs::copy(&src, &dst).expect("copy sample onto the tiny volume");
                    dst.to_string_lossy().into_owned()
                })
                .collect()
        }
    }

    impl Drop for TinyVolume {
        fn drop(&mut self) {
            let _ = std::process::Command::new("hdiutil")
                .args(["detach", "-quiet", "-force"])
                .arg(&self.mount)
                .status();
            let _ = std::fs::remove_file(&self.dmg);
        }
    }

    // An uncompressed BMP of a known size, so a test can ask for "more than fits"
    // exactly. Uncompressed because the number has to be predictable and because
    // lofty sniffs the signature rather than decoding anything.
    fn big_bmp(bytes_wanted: usize) -> Vec<u8> {
        let w: i32 = 1000;
        let row = (w as usize * 3).div_ceil(4) * 4;
        let h = (bytes_wanted / row).max(1);
        let pix = row * h;
        let mut v = Vec::with_capacity(54 + pix);
        v.extend_from_slice(b"BM");
        v.extend_from_slice(&((54 + pix) as u32).to_le_bytes());
        v.extend_from_slice(&0u32.to_le_bytes());
        v.extend_from_slice(&54u32.to_le_bytes());
        v.extend_from_slice(&40u32.to_le_bytes());
        v.extend_from_slice(&w.to_le_bytes());
        v.extend_from_slice(&(h as i32).to_le_bytes());
        v.extend_from_slice(&1u16.to_le_bytes());
        v.extend_from_slice(&24u16.to_le_bytes());
        v.extend_from_slice(&0u32.to_le_bytes());
        v.extend_from_slice(&(pix as u32).to_le_bytes());
        v.extend_from_slice(&2835i32.to_le_bytes());
        v.extend_from_slice(&2835i32.to_le_bytes());
        v.extend_from_slice(&0u32.to_le_bytes());
        v.extend_from_slice(&0u32.to_le_bytes());
        v.resize(54 + pix, 0x40);
        v
    }

    // An artwork change big enough that stamping it in will not fit. Staged in the
    // ordinary temp directory and never on the volume under test — the picture has
    // to be readable for the save to get as far as the write it cannot finish.
    fn oversized_cover(name: &str, bytes: usize) -> ArtworkChange {
        let art =
            std::env::temp_dir().join(format!("pudding-cover-{}-{}.bmp", std::process::id(), name));
        std::fs::write(&art, big_bmp(bytes)).expect("write cover");
        ArtworkEdit::Set {
            path: art.to_string_lossy().into_owned(),
        }
        .resolve()
        .expect("a BMP is a picture")
    }

    // Anything left beside the track after a save is litter the next scan would
    // trip over.
    fn staged_leftovers(dir: &Path) -> Vec<String> {
        std::fs::read_dir(dir)
            .expect("read dir")
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.starts_with(".pudding-save-"))
            .collect()
    }

    #[test]
    fn deleting_a_station_preserves_the_preceding_local_track() {
        let path = std::env::temp_dir().join(format!("pudding-mixed-delete-{}.m3u8", std::process::id()));
        let local = "#EXTM3U\n#EXTINF:123 tvg-logo=\"local.jpg\",Local song\na.mp3\n";
        let original = format!("{local}https://example.test/radio\n");
        std::fs::write(&path, &original).unwrap();
        let stations = parse_m3u_stream_list(&original).unwrap();
        assert_ne!(stations[0].name, "Local song");
        assert_eq!(stations[0].image, None);
        update_stream(path.to_str().unwrap().into(), 0, "Radio".into(), "https://example.test/new".into(), None, None).unwrap();
        assert!(std::fs::read_to_string(&path).unwrap().starts_with(local));
        // Repeat with the bare URL: this used to consume the local track's EXTINF.
        std::fs::write(&path, &original).unwrap();
        delete_stream(path.to_str().unwrap().into(), 0, None).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), local);
        std::fs::remove_file(path).unwrap();
    }

    // Isolate RLIMIT_FSIZE to a child process so parallel tests cannot inherit it.
    #[test]
    fn failed_playlist_writes_keep_originals() {
        const CHILD: &str = "PUDDING_TEST_FAILED_PLAYLIST_WRITE";
        if std::env::var_os(CHILD).is_none() {
            let status = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "tests::failed_playlist_writes_keep_originals", "--nocapture"])
                .env(CHILD, "1").status().unwrap();
            assert!(status.success());
            return;
        }
        let dir = std::env::temp_dir().join(format!("pudding-write-limit-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("mix.m3u8");
        let original = b"#EXTM3U\na.mp3\n";
        std::fs::write(&path, original).unwrap();
        let mut prior: libc::rlimit = unsafe { std::mem::zeroed() };
        unsafe {
            assert_eq!(libc::getrlimit(libc::RLIMIT_FSIZE, &mut prior), 0);
            libc::signal(libc::SIGXFSZ, libc::SIG_IGN);
            let limit = libc::rlimit { rlim_cur: 1024, rlim_max: prior.rlim_max };
            assert_eq!(libc::setrlimit(libc::RLIMIT_FSIZE, &limit), 0);
        }
        let stream_result = write_stream_file(path.to_str().unwrap(), &"x".repeat(4096));
        let playlist_result = write_durably(&path, &vec![b'x'; 4096]);
        unsafe { assert_eq!(libc::setrlimit(libc::RLIMIT_FSIZE, &prior), 0); }
        assert!(stream_result.is_err());
        assert!(playlist_result.is_err());
        assert_eq!(std::fs::read(&path).unwrap(), original);
        assert!(staged_leftovers(&dir).is_empty());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn an_edit_during_staging_is_preserved() {
        let dir = std::env::temp_dir().join(format!("pudding-before-replace-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("mix.m3u8");
        std::fs::write(&path, b"old").unwrap();
        let result = write_atomic_checked(&path, b"our edit", || {
            std::fs::write(&path, b"external edit")?;
            Err(std::io::Error::other("changed on disk"))
        });
        assert!(result.is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"external edit");
        assert!(staged_leftovers(&dir).is_empty());
        std::fs::remove_dir_all(dir).unwrap();
    }

    // --- write_atomic ------------------------------------------------------

    // The whole point: an interrupted write must not be able to destroy what was
    // already on disk. A full volume is the cheapest real interruption to stage.
    #[test]
    fn a_full_disk_leaves_the_old_contents_of_an_atomic_write() {
        let Some(vol) = TinyVolume::new("atomicfull", 3) else {
            eprintln!("skipped: hdiutil unavailable");
            return;
        };
        let target = vol.mount.join("Road Trip.m3u8");
        std::fs::write(&target, "#EXTM3U\n/Music/a.mp3\n").expect("seed");

        // Staged on the same volume, so there is nowhere for these bytes to go.
        let err = write_atomic(&target, &vec![b'x'; 8 * 1024 * 1024])
            .err()
            .expect("the volume is full, this cannot succeed");
        assert_eq!(err.kind(), std::io::ErrorKind::StorageFull);

        assert_eq!(
            std::fs::read_to_string(&target).expect("read after"),
            "#EXTM3U\n/Music/a.mp3\n",
            "a failed write must leave the file exactly as it was"
        );
        assert!(
            staged_leftovers(&vol.mount).is_empty(),
            "the staged file is cleaned up on the way out"
        );
    }

    // Rename replaces a directory entry, so an unresolved symlink target would be
    // overwritten by a regular file and the real playlist stranded.
    #[test]
    fn an_atomic_write_through_a_symlink_keeps_the_symlink() {
        let dir = std::env::temp_dir().join(format!("pudding-atomic-link-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("mkdir");
        let real = dir.join("real.m3u8");
        let link = dir.join("link.m3u8");
        std::fs::write(&real, "#EXTM3U\n").expect("seed");
        std::os::unix::fs::symlink(&real, &link).expect("symlink");

        write_atomic(&link, b"#EXTM3U\n/Music/b.mp3\n").expect("write");

        assert!(
            std::fs::symlink_metadata(&link)
                .expect("stat link")
                .file_type()
                .is_symlink(),
            "the link is still a link"
        );
        assert_eq!(
            std::fs::read_to_string(&real).expect("read real"),
            "#EXTM3U\n/Music/b.mp3\n",
            "the bytes landed on the file the link points at"
        );
        assert!(staged_leftovers(&dir).is_empty());

        let _ = std::fs::remove_dir_all(&dir);
    }

    // The rename lands a new inode, so the old file's mode has to be carried over
    // explicitly or every save would quietly reset it to the umask default.
    #[test]
    fn an_atomic_write_keeps_the_files_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("pudding-atomic-mode-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("mkdir");
        let target = dir.join("private.m3u8");
        std::fs::write(&target, "#EXTM3U\n").expect("seed");
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o600)).expect("chmod");

        write_atomic(&target, b"#EXTM3U\n/Music/c.mp3\n").expect("write");

        let mode = std::fs::metadata(&target)
            .expect("stat")
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600, "the mode survived the rename");

        let _ = std::fs::remove_dir_all(&dir);
    }

    // A file that doesn't exist yet is the ordinary case (New Playlist), and it must
    // not trip over the canonicalize or the permission copy.
    #[test]
    fn an_atomic_write_creates_a_file_that_was_not_there() {
        let dir = std::env::temp_dir().join(format!("pudding-atomic-new-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("mkdir");
        let target = dir.join("Brand New.m3u8");

        write_atomic(&target, b"#EXTM3U\n").expect("write");

        assert_eq!(std::fs::read_to_string(&target).expect("read"), "#EXTM3U\n");
        assert!(staged_leftovers(&dir).is_empty());

        let _ = std::fs::remove_dir_all(&dir);
    }

    // Same guarantee extended_attributes_survive_a_save pins for a track, for the
    // file a playlist lives in. Everything the user hangs off a playlist — a Finder
    // tag, a comment — is attached to the inode, and the rename lands a new one, so
    // only the clone carries it over. A playlist autosaves on every drag, which is
    // how often this would otherwise be thrown away.
    #[test]
    fn extended_attributes_survive_an_atomic_write() {
        let dir = std::env::temp_dir().join(format!("pudding-atomic-xattr-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("mkdir");
        let target = dir.join("Road Trip.m3u8");
        let p = target.to_string_lossy().into_owned();
        std::fs::write(&target, "#EXTM3U\n/Music/a.mp3\n/Music/b.mp3\n").expect("seed");

        let wrote = std::process::Command::new("xattr")
            .args(["-w", "com.apple.metadata:pudding_test", "keep me", &p])
            .status();
        if !matches!(wrote, Ok(s) if s.success()) {
            eprintln!("skipped: xattr unavailable");
            let _ = std::fs::remove_dir_all(&dir);
            return;
        }

        // Deliberately shorter than what it replaces: the clone starts out as the
        // old file, so a body that doesn't cover it must still not leave a tail.
        write_atomic(&target, b"#EXTM3U\n").expect("write");

        let read = std::process::Command::new("xattr")
            .args(["-p", "com.apple.metadata:pudding_test", &p])
            .output()
            .expect("read xattr");
        assert!(
            String::from_utf8_lossy(&read.stdout).contains("keep me"),
            "the staged clone carries the file's metadata across the rename"
        );
        assert_eq!(std::fs::read_to_string(&target).expect("read"), "#EXTM3U\n");
        assert!(staged_leftovers(&dir).is_empty());

        let _ = std::fs::remove_dir_all(&dir);
    }

    // A file-only grant must never cause a truncating fallback.
    #[test]
    fn a_station_edit_without_directory_access_preserves_the_file() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("pudding-nodirw-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("mkdir");
        let path = dir.join("stations.m3u8");
        let p = path.to_string_lossy().into_owned();
        std::fs::write(&path, "#EXTM3U\n#EXTINF:-1,A\nhttp://ex.am/a\n").expect("seed");
        // r-x: the file stays writable, the directory stops accepting new entries.
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o500)).expect("chmod");

        // Running as root would bypass the mode entirely and prove nothing.
        if write_atomic(&path, b"#EXTM3U\n").is_ok() {
            eprintln!("skipped: the directory mode is not being enforced (root?)");
            std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).expect("chmod");
            let _ = std::fs::remove_dir_all(&dir);
            return;
        }

        update_stream(
            p.clone(),
            0,
            "A2".into(),
            "http://ex.am/a".into(),
            None,
            None,
        )
        .expect_err("unsafe in-place edits must be refused");
        let renamed = std::fs::read_to_string(&path).expect("read after edit");
        assert_eq!(renamed, "#EXTM3U\n#EXTINF:-1,A\nhttp://ex.am/a\n");

        delete_stream(p, 0, None).expect_err("unsafe in-place deletes must be refused");
        let emptied = std::fs::read_to_string(&path).expect("read after delete");
        assert_eq!(emptied, renamed);

        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).expect("chmod");
        let _ = std::fs::remove_dir_all(&dir);
    }

    // --- write_durably -----------------------------------------------------

    // A playlist opened from Finder autosaves on every drag into a directory the app
    // was never granted. Same r-x stand-in as the stream-list test above: staging is
    // refused, so saving must fail without touching the writable file.
    #[test]
    fn a_playlist_in_an_unwritable_directory_is_unchanged() {
        use std::os::unix::fs::PermissionsExt;
        let dir =
            std::env::temp_dir().join(format!("pudding-durable-nodirw-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("mkdir");
        let target = dir.join("From Finder.m3u8");
        std::fs::write(&target, "#EXTM3U\n/Music/a.mp3\n").expect("seed");
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o500)).expect("chmod");

        // Running as root would bypass the mode entirely and prove nothing.
        if write_atomic(&target, b"#EXTM3U\n").is_ok() {
            eprintln!("skipped: the directory mode is not being enforced (root?)");
            std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).expect("chmod");
            let _ = std::fs::remove_dir_all(&dir);
            return;
        }

        write_durably(&target, b"#EXTM3U\n/Music/a.mp3\n/Music/b.mp3\n")
            .expect_err("an autosave must not truncate when staging is denied");
        assert_eq!(
            std::fs::read_to_string(&target).expect("read after"),
            "#EXTM3U\n/Music/a.mp3\n"
        );

        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).expect("chmod");
        let _ = std::fs::remove_dir_all(&dir);
    }

    // A full volume must come back as an error with the old contents intact —
    // retrying it as a plain write would truncate the playlist and then discover it
    // has nothing to put there, which is the failure staging exists to prevent.
    #[test]
    fn a_full_disk_does_not_fall_back_to_a_plain_write() {
        let Some(vol) = TinyVolume::new("durablefull", 3) else {
            eprintln!("skipped: hdiutil unavailable");
            return;
        };
        let target = vol.mount.join("Road Trip.m3u8");
        std::fs::write(&target, "#EXTM3U\n/Music/a.mp3\n").expect("seed");

        let err = write_durably(&target, &vec![b'x'; 8 * 1024 * 1024])
            .err()
            .expect("the volume is full, this cannot succeed");
        assert_eq!(err.kind(), std::io::ErrorKind::StorageFull);
        assert_eq!(
            std::fs::read_to_string(&target).expect("read after"),
            "#EXTM3U\n/Music/a.mp3\n",
            "a failed write must leave the file exactly as it was"
        );
        assert!(staged_leftovers(&vol.mount).is_empty());
    }

    // Where the directory is ours, nothing changes: the write still goes through
    // staging, so the guarantees the atomic tests above pin still hold for the
    // ordinary in-library playlist.
    #[test]
    fn a_playlist_in_a_writable_directory_is_still_staged() {
        use std::os::unix::fs::MetadataExt;
        let dir =
            std::env::temp_dir().join(format!("pudding-durable-staged-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("mkdir");
        let target = dir.join("Road Trip.m3u8");
        std::fs::write(&target, "#EXTM3U\n/Music/a.mp3\n").expect("seed");
        let before = std::fs::metadata(&target).expect("stat").ino();

        write_durably(&target, b"#EXTM3U\n").expect("write");

        let after = std::fs::metadata(&target).expect("stat").ino();
        assert_ne!(before, after, "a staged write lands a new inode");
        assert_eq!(std::fs::read_to_string(&target).expect("read"), "#EXTM3U\n");
        assert!(staged_leftovers(&dir).is_empty());

        let _ = std::fs::remove_dir_all(&dir);
    }

    // --- the walk's holes, and what survives a prune -------------------------

    // A directory that will not open has to come back as a hole and not as an empty
    // folder: everything downstream of the walk turns "found nothing" into "delete
    // what was there".
    #[test]
    fn the_walk_reports_a_directory_it_could_not_open() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("pudding-walk-holes-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let reachable = dir.join("Albums");
        let shut = dir.join("Bootlegs");
        std::fs::create_dir_all(&reachable).expect("mkdir");
        std::fs::create_dir_all(&shut).expect("mkdir");
        std::fs::write(reachable.join("a.mp3"), b"x").expect("seed");
        std::fs::write(shut.join("b.mp3"), b"x").expect("seed");
        std::fs::set_permissions(&shut, std::fs::Permissions::from_mode(0o000)).expect("chmod");

        let mut files = Vec::new();
        let mut visited = HashSet::new();
        let mut unreadable = Vec::new();
        walk_audio(&dir, &mut files, &mut visited, &mut unreadable);

        // Running as root would bypass the mode entirely and prove nothing.
        if files.len() == 2 {
            eprintln!("skipped: the directory mode is not being enforced (root?)");
            std::fs::set_permissions(&shut, std::fs::Permissions::from_mode(0o700)).expect("chmod");
            let _ = std::fs::remove_dir_all(&dir);
            return;
        }

        assert_eq!(
            files,
            vec![reachable.join("a.mp3")],
            "the readable half walked"
        );
        assert_eq!(unreadable, vec![shut.clone()], "the other half is a hole");

        std::fs::set_permissions(&shut, std::fs::Permissions::from_mode(0o700)).expect("chmod");
        let _ = std::fs::remove_dir_all(&dir);
    }

    // The unmounted external: the root itself is gone, so the whole root is one hole.
    #[test]
    fn the_walk_reports_a_root_that_is_not_there() {
        let gone =
            std::env::temp_dir().join(format!("pudding-no-such-root-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&gone);

        let mut files = Vec::new();
        let mut visited = HashSet::new();
        let mut unreadable = Vec::new();
        walk_audio(&gone, &mut files, &mut visited, &mut unreadable);

        assert!(files.is_empty());
        assert_eq!(unreadable, vec![gone]);
    }

    // The opposite case, and the one that makes deleting work at all: a folder the
    // user actually emptied is not a hole, so its rows must still prune.
    #[test]
    fn a_readable_empty_root_is_not_a_hole() {
        let dir = std::env::temp_dir().join(format!("pudding-empty-root-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("mkdir");

        let mut files = Vec::new();
        let mut visited = HashSet::new();
        let mut unreadable = Vec::new();
        walk_audio(&dir, &mut files, &mut visited, &mut unreadable);

        assert!(files.is_empty());
        assert!(
            unreadable.is_empty(),
            "an empty folder is empty, not unreachable"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    // Run the prune the way run_scan does — scan_current from the walk, then the
    // delete — against a root where one subtree was unreadable and the rest was not.
    // The partial case is the one that matters: a scan that found *some* files used
    // to be taken as authoritative for the whole root.
    #[test]
    fn an_unreadable_subtree_survives_a_prune_that_still_removes_the_rest() {
        let conn = Connection::open_in_memory().expect("open");
        init_schema(&conn).expect("schema");
        conn.execute_batch("CREATE TEMP TABLE scan_current (path TEXT PRIMARY KEY)")
            .expect("temp table");
        for path in [
            "/m/Albums/a.mp3",   // walked, still there
            "/m/Albums/b.mp3",   // walked, deleted by the user
            "/m/Bootlegs/c.mp3", // under the unreadable subtree
            "/m/Bootlegs/d.mp3",
        ] {
            conn.execute(
                "INSERT INTO tracks (path, root, mtime, size) VALUES (?1, '/m', 0, 0)",
                [path],
            )
            .expect("insert");
        }
        // What the walk actually found.
        conn.execute(
            "INSERT INTO scan_current (path) VALUES ('/m/Albums/a.mp3')",
            [],
        )
        .expect("insert");

        preserve_unreadable(&conn, "/m", &[PathBuf::from("/m/Bootlegs")]).expect("preserve");
        conn.execute(
            "DELETE FROM tracks WHERE root = ?1 AND path NOT IN (SELECT path FROM scan_current)",
            ["/m"],
        )
        .expect("prune");

        let mut stmt = conn
            .prepare("SELECT path FROM tracks ORDER BY path")
            .expect("prepare");
        let left: Vec<String> = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .expect("query")
            .filter_map(|r| r.ok())
            .collect();
        assert_eq!(
            left,
            vec!["/m/Albums/a.mp3", "/m/Bootlegs/c.mp3", "/m/Bootlegs/d.mp3"],
            "the unreadable subtree is untouched; the file deleted from the folder we \
             did read is gone"
        );
    }

    // A hole at the root preserves everything, which is the unplugged-drive case.
    #[test]
    fn an_unreachable_root_prunes_nothing() {
        let conn = Connection::open_in_memory().expect("open");
        init_schema(&conn).expect("schema");
        conn.execute_batch("CREATE TEMP TABLE scan_current (path TEXT PRIMARY KEY)")
            .expect("temp table");
        for path in ["/Volumes/Ext/a.mp3", "/Volumes/Ext/Live/b.mp3"] {
            conn.execute(
                "INSERT INTO tracks (path, root, mtime, size) VALUES (?1, '/Volumes/Ext', 0, 0)",
                [path],
            )
            .expect("insert");
        }

        preserve_unreadable(&conn, "/Volumes/Ext", &[PathBuf::from("/Volumes/Ext")])
            .expect("preserve");
        conn.execute(
            "DELETE FROM tracks WHERE root = ?1 AND path NOT IN (SELECT path FROM scan_current)",
            ["/Volumes/Ext"],
        )
        .expect("prune");

        let count: i64 = conn
            .query_row("SELECT count(*) FROM tracks", [], |r| r.get(0))
            .expect("count");
        assert_eq!(count, 2, "an empty walk of an absent root deletes nothing");
    }

    // Whole components, not characters: the neighbouring folder is a different
    // folder, and a string prefix would preserve its rows too.
    #[test]
    fn a_hole_does_not_cover_a_similarly_named_sibling() {
        let holes = [PathBuf::from("/Volumes/Ext")];
        assert!(is_under_any(Path::new("/Volumes/Ext/a.mp3"), &holes));
        assert!(!is_under_any(Path::new("/Volumes/Extra/a.mp3"), &holes));
    }

    // The one that matters. A save that runs out of disk used to leave a 0-byte
    // file: lofty had already truncated the original before it found out it could
    // not write it back. The track must come through untouched instead.
    #[test]
    fn a_save_that_runs_out_of_disk_leaves_the_track_untouched() {
        let Some(vol) = TinyVolume::new("nospace", 3) else {
            eprintln!("skipped: hdiutil unavailable");
            return;
        };
        let paths = vol.with_tracks(1);
        let track = PathBuf::from(&paths[0]);
        let before = std::fs::read(&track).expect("read before");

        // Staged on the same volume, so the write has nowhere to go.
        let art = oversized_cover("nospace", 3 * 1024 * 1024);
        let failure = write_one_file(&track, &album_patch("Night Bus").normalized(), &art)
            .err()
            .expect("the disk is full, this cannot succeed");

        assert!(
            failure.fatal,
            "a full disk is the mount talking, not this one file"
        );
        assert_eq!(
            std::fs::read(&track).expect("read after"),
            before,
            "a failed save must leave the file byte for byte as it was"
        );
        assert!(
            open_tagged(&track, WITH_PROPERTIES).is_ok(),
            "still a playable audio file"
        );
        assert!(
            staged_leftovers(&vol.mount).is_empty(),
            "the staged copy is cleaned up"
        );
    }

    // The same failure across a batch. Every file after the first used to be
    // destroyed in turn, each one reported as a mild "couldn't be written" — a
    // library quietly emptied while the form counted up.
    #[test]
    fn a_full_disk_stops_the_batch_instead_of_emptying_it() {
        let Some(vol) = TinyVolume::new("batch", 5) else {
            eprintln!("skipped: hdiutil unavailable");
            return;
        };
        let paths = vol.with_tracks(4);
        let before: Vec<Vec<u8>> = paths
            .iter()
            .map(|p| std::fs::read(p).expect("read before"))
            .collect();

        let art = oversized_cover("batch", 3 * 1024 * 1024);
        let report = write_tags_to_files(
            &paths,
            &album_patch("Night Bus").normalized(),
            &art,
            &cache_ok,
            &nothing_held,
            &|| false,
            &|_, _| {},
        );

        assert!(report.ok.is_empty());
        assert_eq!(
            report.failed.len(),
            1,
            "the batch gives up after the first storage failure rather than \
             attempting — and copying — every file behind it"
        );
        assert!(report.aborted.is_some(), "and says why it stopped short");
        assert!(!report.stopped, "nobody pressed Stop");

        for (path, was) in paths.iter().zip(&before) {
            assert_eq!(
                &std::fs::read(path).expect("read after"),
                was,
                "{path} must be exactly what it was"
            );
        }
        assert!(staged_leftovers(&vol.mount).is_empty());
    }

    // A file's own problem is not the storage's: one unreadable track must not
    // abort the batch the way a full disk does.
    #[test]
    fn a_single_bad_file_does_not_abort_the_batch() {
        let (dir, mut paths) = sample_copies("not-fatal", 3);
        paths[1] = dir.join("gone.mp3").to_string_lossy().into_owned();

        let report = write_tags_to_files(
            &paths,
            &album_patch("Night Bus"),
            &ArtworkChange::Keep,
            &cache_ok,
            &nothing_held,
            &|| false,
            &|_, _| {},
        );

        assert_eq!(report.ok.len(), 2);
        assert!(report.aborted.is_none(), "a missing file is not the disk");
        assert!(staged_leftovers(&dir).is_empty());

        let _ = std::fs::remove_dir_all(&dir);
    }

    // The editor reads `primary_tag().or_else(first_tag)`, so an MP3 carrying only
    // an ID3v1 tag — ordinary in a library ripped before about 2005 — seeds the
    // form from ID3v1 while the save lands on a new ID3v2. That new tag used to
    // start empty, so editing the title alone wrote a tag holding nothing but the
    // title, and being primary it shadowed the artist and album the form had shown
    // a second earlier. The patch promises an absent key is a tag the file keeps.
    #[test]
    fn editing_one_field_keeps_the_rest_of_a_non_primary_tag() {
        use lofty::tag::TagExt;
        let (dir, paths) = sample_copies("id3v1-only", 1);
        let track = PathBuf::from(&paths[0]);

        // Strip the sample back to a single ID3v1 tag.
        for t in [
            lofty::tag::TagType::Id3v2,
            lofty::tag::TagType::Id3v1,
            lofty::tag::TagType::Ape,
        ] {
            let _ = t.remove_from_path(&track);
        }
        let mut v1 = lofty::tag::Tag::new(lofty::tag::TagType::Id3v1);
        v1.set_title("Old Title".into());
        v1.set_artist("Old Artist".into());
        v1.set_album("Old Album".into());
        v1.save_to_path(&track, lofty::config::WriteOptions::default())
            .expect("write an ID3v1-only file");

        // What the editor would show.
        let shown = file_tags(&paths[0], ArtworkRead::DataUrl);
        assert_eq!(shown.artist.as_deref(), Some("Old Artist"));
        assert_eq!(shown.album.as_deref(), Some("Old Album"));

        // The user edits the title and nothing else.
        let edits = TagEdits {
            title: set("New Title"),
            ..Default::default()
        }
        .normalized();
        let (cached, _, _) =
            write_one_file(&track, &edits, &ArtworkChange::Keep).expect("write succeeds");

        let after = file_tags(&paths[0], ArtworkRead::DataUrl);
        assert_eq!(after.title.as_deref(), Some("New Title"));
        assert_eq!(
            after.artist.as_deref(),
            Some("Old Artist"),
            "an absent key is a tag the file keeps"
        );
        assert_eq!(after.album.as_deref(), Some("Old Album"));
        // And the library row is read off that same tag, so it cannot disagree.
        assert_eq!(cached.artist.as_deref(), Some("Old Artist"));
        assert_eq!(cached.album.as_deref(), Some("Old Album"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    // Saving through a symlink must tag the track, not replace the link with a
    // copy of it. The save ends in a rename, and rename swaps a directory entry —
    // so without canonicalizing first, editing a symlinked track would leave a
    // regular file where the link was and strand the original.
    #[test]
    fn saving_through_a_symlink_keeps_the_symlink() {
        let (dir, paths) = sample_copies("symlink", 1);
        let real = PathBuf::from(&paths[0]);
        let link = dir.join("link.mp3");
        std::os::unix::fs::symlink(&real, &link).expect("symlink");

        write_one_file(&link, &album_patch("Night Bus"), &ArtworkChange::Keep).expect("write");

        assert!(
            std::fs::symlink_metadata(&link)
                .expect("stat link")
                .file_type()
                .is_symlink(),
            "the link is still a link"
        );
        assert_eq!(album_of(&paths[0]).as_deref(), Some("Night Bus"));
        assert!(staged_leftovers(&dir).is_empty());

        let _ = std::fs::remove_dir_all(&dir);
    }

    // The staged copy is what carries a file's metadata across the rename. Finder
    // tags and comments live in xattrs, and losing them on every tag edit would be
    // its own quiet data loss.
    #[test]
    fn extended_attributes_survive_a_save() {
        let (dir, paths) = sample_copies("xattr", 1);
        let wrote = std::process::Command::new("xattr")
            .args([
                "-w",
                "com.apple.metadata:pudding_test",
                "keep me",
                &paths[0],
            ])
            .status();
        if !matches!(wrote, Ok(s) if s.success()) {
            eprintln!("skipped: xattr unavailable");
            let _ = std::fs::remove_dir_all(&dir);
            return;
        }

        write_one_file(
            Path::new(&paths[0]),
            &album_patch("Night Bus"),
            &ArtworkChange::Keep,
        )
        .expect("write");

        let read = std::process::Command::new("xattr")
            .args(["-p", "com.apple.metadata:pudding_test", &paths[0]])
            .output()
            .expect("read xattr");
        assert!(
            String::from_utf8_lossy(&read.stdout).contains("keep me"),
            "the staged copy carries the file's metadata across the rename"
        );
        assert_eq!(album_of(&paths[0]).as_deref(), Some("Night Bus"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    // The latch reads the storage's answer, not the file's. Getting this wrong in
    // either direction is bad: too eager and one odd file stops a 300-file save,
    // too shy and a full disk is answered by copying 300 tracks into it.
    #[test]
    fn only_storage_failures_are_fatal_to_a_batch() {
        use std::io::{Error, ErrorKind};
        for kind in [
            ErrorKind::StorageFull,
            ErrorKind::ReadOnlyFilesystem,
            ErrorKind::QuotaExceeded,
        ] {
            assert!(is_storage_fatal(&Error::from(kind)), "{kind:?}");
        }
        // EIO, ENXIO, ENODEV: a drive pulled out mid-batch. std gives these no
        // named kind, so they have to be read off the raw errno.
        for errno in [5, 6, 19] {
            assert!(
                is_storage_fatal(&Error::from_raw_os_error(errno)),
                "{errno}"
            );
        }
        for kind in [
            ErrorKind::NotFound,
            ErrorKind::PermissionDenied,
            ErrorKind::InvalidData,
        ] {
            assert!(!is_storage_fatal(&Error::from(kind)), "{kind:?}");
        }
    }
}
