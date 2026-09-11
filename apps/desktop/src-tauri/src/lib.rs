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
    // The single writer connection. SQLite allows one writer at a time, so scan
    // inserts and write_tags updates serialize through this mutex — correct, and
    // WAL keeps that write from blocking readers.
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
// populated) and the tag set the metadata editor is seeded from and hands back
// (where they are not — the editor deals only in the six fields it can write).
// Default exists for that second use, so an editor path says what it isn't filling
// in rather than listing seven Nones.
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

// The tracks table is a cache rebuilt by run_scan; bump this whenever its shape changes
// and the next startup will drop and recreate it.
const SCHEMA_VERSION: i64 = 7;

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
    if version != SCHEMA_VERSION {
        conn.pragma_update(None, "user_version", SCHEMA_VERSION)?;
    }
    Ok(())
}

fn read_tags(path: &std::path::Path) -> Tags {
    let empty = Tags::default();
    let Ok(tagged) = lofty::read_from_path(path) else {
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

fn walk_audio(root: &std::path::Path, out: &mut Vec<PathBuf>, visited: &mut HashSet<PathBuf>) {
    // Canonicalize so a symlink loop (e.g. /foo/back -> /foo) gets caught regardless
    // of which path we entered the cycle from.
    let Ok(canon) = std::fs::canonicalize(root) else {
        return;
    };
    if !visited.insert(canon) {
        return;
    }
    let Ok(entries) = std::fs::read_dir(root) else {
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
            walk_audio(&path, out, visited);
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

fn run_scan(root: PathBuf, db_path: PathBuf, app: &AppHandle) -> Result<(), String> {
    let root_key = normalize_root(&root.to_string_lossy());
    let mut files = Vec::new();
    let mut visited = HashSet::new();
    walk_audio(&root, &mut files, &mut visited);

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
// Blocks on the DB writer mutex, which a running scan holds for the length of a
// whole walk, so only call this from a thread with nothing waiting on it.
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
async fn read_stream_list(path: String) -> Result<Vec<Stream>, String> {
    // A remote stream list is fetched with a blocking 15s-timeout HTTP GET; a local
    // one is read from disk. Both are blocking I/O, so they run on a blocking thread
    // — a slow or dead host must never freeze the UI thread, which (were this sync)
    // it would for up to the full timeout on startup.
    tauri::async_runtime::spawn_blocking(move || {
        let contents = if path.starts_with("http://") || path.starts_with("https://") {
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
            std::fs::read_to_string(&path).map_err(|e| e.to_string())?
        };
        parse_m3u_stream_list(&contents)
            .ok_or_else(|| "not an M3U stream list (no #EXTM3U header or stream URLs)".to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

// Resolve the default stream list path, creating an empty (header-only) file on
// first run if it is missing. The frontend seeds this as the stream list setting
// when none has ever been configured, so a fresh install has a valid, writable
// list instead of the "not configured" prompt.
fn ensure_default_stream_list(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
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
// one seen since the previous URL, matching the parser's pending-title rule
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
        } else if line.contains("://") {
            spans.push((pending_extinf.take(), i));
        }
    }
    spans
}

// Append a station to a local stream list (.m3u8).
#[tauri::command]
fn add_stream(
    path: String,
    name: String,
    url: String,
    image: Option<String>,
) -> Result<(), String> {
    reject_remote_list(&path)?;
    let url = clean_stream_url(&url)?;
    // Start from the existing file (or a fresh header if it's missing/empty),
    // guaranteeing a trailing newline so the new #EXTINF starts its own line.
    let mut contents = std::fs::read_to_string(&path).unwrap_or_default();
    if contents.trim().is_empty() {
        contents = "#EXTM3U\n".to_string();
    } else if !contents.ends_with('\n') {
        contents.push('\n');
    }
    contents.push_str(&extinf_line(&name, image.as_deref()));
    contents.push('\n');
    contents.push_str(url);
    contents.push('\n');
    std::fs::write(&path, contents).map_err(|e| e.to_string())
}

// Rewrite the `index`-th station in place: replace its #EXTINF (inserting one
// when the entry had none) and its URL line, leaving every other line untouched.
// `index` is a station ordinal from read_stream_list, so it lines up with
// stream_spans.
#[tauri::command]
fn update_stream(
    path: String,
    index: usize,
    name: String,
    url: String,
    image: Option<String>,
) -> Result<(), String> {
    reject_remote_list(&path)?;
    let url = clean_stream_url(&url)?;
    let contents = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let lines: Vec<&str> = contents.lines().collect();
    let &(extinf, url_line) = stream_spans(&lines)
        .get(index)
        .ok_or("stream index out of range")?;
    let new_extinf = extinf_line(&name, image.as_deref());
    let mut out = String::new();
    for (i, line) in lines.iter().enumerate() {
        if Some(i) == extinf {
            out.push_str(&new_extinf);
        } else if i == url_line {
            // No prior #EXTINF: introduce one so the new name/art persists.
            if extinf.is_none() {
                out.push_str(&new_extinf);
                out.push('\n');
            }
            out.push_str(url);
        } else {
            out.push_str(line);
        }
        out.push('\n');
    }
    std::fs::write(&path, out).map_err(|e| e.to_string())
}

// Move the station at `from` to sit before the station currently at `to` (both
// are ordinals from read_stream_list; `to == len` appends at the end). Each
// station owns the run of lines from its #EXTINF (or bare URL) up to the next
// station's start, so its #EXTVLCOPT options and any trailing blank/comment lines
// travel with it; the preamble (#EXTM3U header and anything before the first
// station) stays put. Rewrites the whole body in the new order.
#[tauri::command]
fn move_stream(path: String, from: usize, to: usize) -> Result<(), String> {
    reject_remote_list(&path)?;
    let contents = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
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
    let mut out = String::new();
    for line in &lines[..starts[0]] {
        out.push_str(line);
        out.push('\n');
    }
    for &i in &order {
        let (s, e) = block(i);
        for line in &lines[s..e] {
            out.push_str(line);
            out.push('\n');
        }
    }
    std::fs::write(&path, out).map_err(|e| e.to_string())
}

// Remove the `index`-th station: drop its URL line and the whole run from its
// #EXTINF down to that URL (taking any #EXTVLCOPT etc. that rode with it), so no
// orphaned directive leaks onto the next station.
#[tauri::command]
fn delete_stream(path: String, index: usize) -> Result<(), String> {
    reject_remote_list(&path)?;
    let contents = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let lines: Vec<&str> = contents.lines().collect();
    let &(extinf, url_line) = stream_spans(&lines)
        .get(index)
        .ok_or("stream index out of range")?;
    let start = extinf.unwrap_or(url_line);
    let mut out = String::new();
    for (i, line) in lines.iter().enumerate() {
        if i >= start && i <= url_line {
            continue;
        }
        out.push_str(line);
        out.push('\n');
    }
    std::fs::write(&path, out).map_err(|e| e.to_string())
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
        } else if line.contains("://") {
            let name = pending_title
                .take()
                .unwrap_or_else(|| m3u_fallback_name(line).to_string());
            streams.push(Stream {
                name,
                url: line.to_string(),
                image: pending_image.take(),
            });
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
fn m3u_fallback_name(url: &str) -> &str {
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
    let tagged = lofty::read_from_path(path).ok()?;
    let tag = tagged.primary_tag().or_else(|| tagged.first_tag())?;
    let pic = tag.pictures().first()?;
    let mime = pic.mime_type().map(|m| m.as_str()).unwrap_or("image/jpeg");
    let encoded = base64::engine::general_purpose::STANDARD.encode(pic.data());
    Some(format!("data:{};base64,{}", mime, encoded))
}

// Ceiling on a stream list station image. Anything larger than this is not
// plausible station art and would balloon the data URL held in the DOM.
const MAX_STREAM_IMAGE_BYTES: u64 = 10 * 1024 * 1024;

// Station art for a stream list stream: `image` is an http(s) or file:// URL.
// Returned as a data URL for the same reason get_art's is: the webview CSP
// only permits 'self' and data: image sources, so neither remote URLs nor
// arbitrary local files can be given to <img> directly.
#[tauri::command]
fn get_stream_image(image: String) -> Option<String> {
    let (bytes, mime) = if image.starts_with("http://") || image.starts_with("https://") {
        let resp = ureq::AgentBuilder::new()
            .timeout(Duration::from_secs(15))
            .user_agent(USER_AGENT)
            .build()
            .get(&image)
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

// Write the editable tags back into a file and sync the library cache row, so
// the Songs/Artists/Albums views reflect the change without waiting for the
// debounced watcher rescan. Mirrors read_tags: it mutates the *primary* tag (the
// one read_tags reads), creating one of the file's native type when the file is
// untagged. Empty/omitted fields clear the corresponding item. `duration` comes
// Read a file's current tags straight from disk to seed the metadata editor.
// Views carry only partial rows for a track — a SearchResult (Songs/album/artist
// leaf lists) has no album-artist or disc — so seeding from the row would let a
// save write those fields back as empty and wipe them. Reading fresh gives the
// editor the whole tag set. Shape matches what write_tags returns.
#[tauri::command]
fn read_file_tags(path: String) -> Result<FileEntry, String> {
    let p = PathBuf::from(&path);
    let tags = read_tags(&p);
    Ok(FileEntry {
        name: p
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default(),
        title: tags.title,
        artist: tags.artist,
        album: tags.album,
        album_artist: tags.album_artist,
        disc: tags.disc,
        track: tags.track,
        // Editor seed: the six fields above are the whole of what it can write.
        ..Default::default()
    })
}

// from the decoded audio, not a tag, so it is neither shown nor written here.
//
// The frontend refuses this for the file the audio engine currently holds open
// (lofty rewrites the file in place, which would corrupt an in-progress decode),
// so this command assumes the file is not being played.
#[tauri::command]
async fn write_tags(
    path: String,
    title: Option<String>,
    artist: Option<String>,
    album_artist: Option<String>,
    album: Option<String>,
    disc: Option<u32>,
    track: Option<u32>,
    db: State<'_, DbHandle>,
) -> Result<FileEntry, String> {
    // lofty read/save is blocking file I/O and the cache UPDATE takes the writer
    // mutex, so run the whole thing off the UI thread.
    let write_conn = db.conn.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let p = PathBuf::from(&path);
        let mut tagged = lofty::read_from_path(&p).map_err(|e| format!("read failed: {}", e))?;

        // Untagged files have no tag to mutate; give them one of the container's
        // native type (ID3v2 for MP3, MP4 atoms for m4a, Vorbis comments for FLAC...).
        if tagged.primary_tag_mut().is_none() {
            let tag_type = tagged.primary_tag_type();
            tagged.insert_tag(lofty::tag::Tag::new(tag_type));
        }
        let tag = tagged
            .primary_tag_mut()
            .expect("primary tag present (inserted above when absent)");

        // Trim, and treat empty as "clear" — symmetric with read_tags' norm().
        let norm = |v: Option<String>| v.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
        let title = norm(title);
        let artist = norm(artist);
        let album = norm(album);
        let album_artist = norm(album_artist);

        match &title {
            Some(v) => tag.set_title(v.clone()),
            None => tag.remove_title(),
        }
        match &artist {
            Some(v) => tag.set_artist(v.clone()),
            None => tag.remove_artist(),
        }
        match &album {
            Some(v) => tag.set_album(v.clone()),
            None => tag.remove_album(),
        }
        // No Accessor shortcut for album artist (see read_tags): set/clear by key.
        match &album_artist {
            Some(v) => {
                tag.insert_text(lofty::tag::ItemKey::AlbumArtist, v.clone());
            }
            None => tag.remove_key(&lofty::tag::ItemKey::AlbumArtist),
        }
        match disc {
            Some(d) => tag.set_disk(d),
            None => tag.remove_disk(),
        }
        match track {
            Some(t) => tag.set_track(t),
            None => tag.remove_track(),
        }

        tagged
            .save_to_path(&p, lofty::config::WriteOptions::default())
            .map_err(|e| format!("save failed: {}", e))?;

        // Re-stat after the write so the cached mtime/size match the file lofty just
        // rewrote. The incremental scan skips rows whose mtime+size are unchanged, so
        // recording the post-write values makes the watcher's self-write event a
        // no-op instead of a redundant re-read.
        let (mtime, size) = std::fs::metadata(&p)
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

        {
            let conn = write_conn.lock().unwrap_or_else(|e| e.into_inner());
            let _ = conn.execute(
                "UPDATE tracks SET mtime = ?2, size = ?3, title = ?4, artist = ?5,
                     album = ?6, album_artist = ?7, disc = ?8, track = ?9 WHERE path = ?1",
                params![
                    path,
                    mtime,
                    size,
                    title,
                    artist,
                    album,
                    album_artist,
                    disc,
                    track
                ],
            );
        }

        Ok(FileEntry {
            name: p
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default(),
            title,
            artist,
            album,
            album_artist,
            disc,
            track,
            // The one column field an edit changes. Writing tags rewrites the file,
            // so every open row's Date Modified cell is stale the moment this
            // returns; handing back the post-write mtime lets the caller patch it
            // (see applyTagUpdate) instead of waiting for a rescan that the
            // mtime/size pre-sync above has deliberately made a no-op.
            modified: Some(mtime),
            ..Default::default()
        })
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
fn audio_play(tracks: Vec<String>, start_index: usize, engine: State<audio::AudioEngine>) {
    let paths: Vec<PathBuf> = tracks.into_iter().map(PathBuf::from).collect();
    engine.send(audio::Command::Play {
        tracks: paths,
        start_index,
    });
}

// Internet radio: the engine owns the HTTP connection, ICY metadata, and
// reconnect policy. Pause disconnects; resume rejoins the live edge.
#[tauri::command]
fn audio_play_stream(url: String, engine: State<audio::AudioEngine>) {
    engine.send(audio::Command::PlayStream { url });
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
fn audio_stop(engine: State<audio::AudioEngine>) {
    engine.send(audio::Command::Stop);
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
// setting (persisted in its store, menu checkbox); the engine reads it as it
// opens each track, so a change lands at the next track boundary rather than
// interrupting the one playing. See audio::desired_output_rate.
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
                walk_audio(path, &mut group, &mut visited);
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
                // Help ▸ Pudding on GitHub opens the repo in the default browser.
                "open-readme" => {
                    let _ = app.opener().open_url(
                        "https://github.com/incompl/pudding",
                        None::<&str>,
                    );
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

            let app_data = app.path().app_data_dir()?;
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

            // Playback menu, top to bottom: transport (Play/Pause, Previous,
            // Next); Shuffle + a Repeat submenu; Volume Up/Down + Mute; and a
            // single global "Autoadvance" checkbox (does playback flow
            // track-to-track, or stop after each?). Queue teardown ("Clear") lives
            // on the queue pane itself, not here — a queue verb has no home in a
            // global menu. Transport items relay to the
            // frontend (menu:transport); Previous/Next carry ⌘←/⌘→ accelerators
            // that both drive the shortcut and reveal it here. (Play/Pause, seek,
            // and volume have bare-key shortcuts that can't be menu accelerators
            // without hijacking typing, so those appear without accelerators.)
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
                CheckMenuItemBuilder::with_id("repeat-all", "Repeat All").build(app)?;
            let repeat_one =
                CheckMenuItemBuilder::with_id("repeat-one", "Repeat One").build(app)?;
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
            // / About) — an audio effect on playback, so it sits by Volume/Mute
            // rather than in Window (it's a pane, not a separate window as in
            // Apple Music). ⌥⌘E is the familiar Equalizer accelerator. Selecting
            // it emits "open-equalizer" for the frontend.
            let equalizer = MenuItemBuilder::with_id("open-equalizer", "Equalizer")
                .accelerator("Alt+Cmd+E")
                .build(app)?;
            // ReplayGain (volume normalization): three radio-style items in a
            // submenu next to the Equalizer, another playback audio setting. Off
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
                .separator()
                .item(&shuffle)
                .item(&repeat_menu)
                .separator()
                .item(&volume_up)
                .item(&volume_down)
                .item(&mute)
                .item(&equalizer)
                .item(&replaygain_menu)
                .item(&follow_sample_rate)
                .separator()
                .item(&autoadvance)
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
            let readme_item =
                MenuItemBuilder::with_id("open-readme", "Pudding on GitHub").build(app)?;
            // Licenses opens another right-pane panel in the Settings/About family
            // (same Back button): the open source software Pudding is built from,
            // generated from the real dependency graph at build time.
            let licenses_item =
                MenuItemBuilder::with_id("open-licenses", "Licenses").build(app)?;
            let help_menu = SubmenuBuilder::new(app, "Help")
                .item(&readme_item)
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
            artist_albums,
            artist_albumless_tracks,
            get_art,
            get_stream_image,
            frontend_ready,
            e2e_port,
            window_number,
            prepare_external_file,
            write_tags,
            read_file_tags,
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
        delete_stream(p.clone(), 1).unwrap();
        let contents = std::fs::read_to_string(&path).unwrap();
        let streams = parse_m3u_stream_list(&contents).unwrap();
        assert_eq!(streams.len(), 1);
        assert_eq!(streams[0].name, "Now Named");
        assert!(!contents.contains("#EXTVLCOPT"));

        // Out-of-range index is an error, not a silent no-op.
        assert!(delete_stream(p.clone(), 9).is_err());

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
        move_stream(p.clone(), 1, 0).unwrap();
        let contents = std::fs::read_to_string(&path).unwrap();
        let streams = parse_m3u_stream_list(&contents).unwrap();
        assert_eq!(
            streams.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(),
            ["B", "A", "C"],
        );
        // B's option line rode along and the header stayed put.
        assert!(contents.starts_with("#EXTM3U\n#EXTINF:-1,B\n#EXTVLCOPT:network-caching=1000\n"));

        // Move A (now index 1) to the end (to == len).
        move_stream(p.clone(), 1, 3).unwrap();
        let streams = parse_m3u_stream_list(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(
            streams.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(),
            ["B", "C", "A"],
        );

        // Out-of-range indices are errors.
        assert!(move_stream(p.clone(), 9, 0).is_err());
        assert!(move_stream(p.clone(), 0, 9).is_err());

        let _ = std::fs::remove_file(&path);
    }
}
