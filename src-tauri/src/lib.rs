mod audio;
mod icy;
mod now_playing;
mod playlist;

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
    AboutMetadataBuilder, CheckMenuItem, CheckMenuItemBuilder, MenuBuilder, MenuItem,
    MenuItemBuilder, PredefinedMenuItem, Submenu, SubmenuBuilder,
};
use tauri::{AppHandle, Emitter, Manager, State, Wry};
use tauri_plugin_log::{Target, TargetKind};

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
    conn: Arc<Mutex<Connection>>,
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
}

// The Window menu's "Mini Player" checkbox. The frontend derives mini mode from
// the viewport height, so it keeps this checkmark in sync (set_miniplayer_checked)
// on startup and on every resize.
struct WindowMenu {
    miniplayer: CheckMenuItem<Wry>,
}

// Handles into the Playlist menu that the frontend keeps in sync: the "Save as
// Playlist" item is enabled only while an ephemeral queue is the active pool
// (set_save_playlist_enabled), "Move Playlist File…" is enabled only while a
// playlist is open — browsed or playing (set_move_playlist_enabled) — and the
// "Open Recent" submenu is rebuilt from the frontend's persisted recents list
// (set_recent_playlists).
struct PlaylistMenu {
    save_as: MenuItem<Wry>,
    move_file: MenuItem<Wry>,
    recent: Submenu<Wry>,
}

// One entry the frontend hands set_recent_playlists to rebuild the Open Recent
// submenu (most-recent first).
#[derive(Deserialize)]
struct RecentPlaylist {
    path: String,
    name: String,
}

#[derive(Serialize)]
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

#[derive(Serialize)]
struct SearchResult {
    path: String,
    title: Option<String>,
    artist: Option<String>,
    album: Option<String>,
    // The file's metadata track number, populated only where a within-album
    // ordinal is meaningful (album_tracks). Left None for flat lists (the Songs
    // view, search results) whose gutter shows a positional index instead. The
    // browse tree renders the same metadata number; see main.ts renderLeafTrackList.
    track: Option<u32>,
    // Track length in seconds (None when unknown). Summed per queue/playlist for
    // the runtime shown beside the track count; individual rows don't display it.
    duration: Option<f64>,
}

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

struct Tags {
    title: Option<String>,
    artist: Option<String>,
    album: Option<String>,
    album_artist: Option<String>,
    disc: Option<u32>,
    track: Option<u32>,
    // Track length in seconds, read from the decoded file's properties (not a
    // tag). None when lofty can't determine it. Summed per queue/playlist to
    // show a total runtime beside the track count.
    duration: Option<f64>,
}

// The tracks table is a cache rebuilt by run_scan; bump this whenever its shape changes
// and the next startup will drop and recreate it.
const SCHEMA_VERSION: i64 = 3;

// WAL lets the scan's write transaction run without blocking concurrent reads
// (list_dir, get_metadata) on the main connection.
fn open_connection(path: &std::path::Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open(path)?;
    let _: String = conn.query_row("PRAGMA journal_mode = WAL", [], |row| row.get(0))?;
    conn.busy_timeout(Duration::from_millis(5000))?;
    Ok(conn)
}

fn init_schema(conn: &Connection) -> rusqlite::Result<()> {
    let version: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    if version != SCHEMA_VERSION {
        conn.execute_batch("DROP TABLE IF EXISTS tracks;")?;
    }
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS tracks (
            path TEXT PRIMARY KEY,
            mtime INTEGER NOT NULL,
            size INTEGER NOT NULL,
            title TEXT,
            artist TEXT,
            album TEXT,
            album_artist TEXT,
            disc INTEGER,
            track INTEGER,
            duration REAL
        );",
    )?;
    if version != SCHEMA_VERSION {
        conn.pragma_update(None, "user_version", SCHEMA_VERSION)?;
    }
    Ok(())
}

fn read_tags(path: &std::path::Path) -> Tags {
    let empty = Tags {
        title: None,
        artist: None,
        album: None,
        album_artist: None,
        disc: None,
        track: None,
        duration: None,
    };
    let Ok(tagged) = lofty::read_from_path(path) else {
        return empty;
    };
    // The runtime comes from the decoded audio properties, not a tag, so it's
    // available even for otherwise-untagged files.
    let duration = {
        let secs = tagged.properties().duration().as_secs_f64();
        (secs > 0.0).then_some(secs)
    };
    let Some(tag) = tagged.primary_tag().or_else(|| tagged.first_tag()) else {
        return Tags {
            duration,
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
        duration,
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

fn run_scan(root: PathBuf, db_path: PathBuf) -> Result<(), String> {
    let mut files = Vec::new();
    let mut visited = HashSet::new();
    walk_audio(&root, &mut files, &mut visited);

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

    for file in &files {
        let Ok(meta) = file.metadata() else { continue };
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let size = meta.len() as i64;
        let path_str = file.to_string_lossy().to_string();

        let _ = tx.execute(
            "INSERT OR IGNORE INTO scan_current (path) VALUES (?)",
            [&path_str],
        );

        let existing: Option<(i64, i64)> = tx
            .query_row(
                "SELECT mtime, size FROM tracks WHERE path = ?",
                [&path_str],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|e| format!("query existing row failed: {}", e))?;
        if let Some((m, s)) = existing {
            if m == mtime && s == size {
                continue;
            }
        }

        let tags = read_tags(file);
        let _ = tx.execute(
            "INSERT INTO tracks (path, mtime, size, title, artist, album, album_artist, disc, track, duration)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT(path) DO UPDATE SET
                 mtime = excluded.mtime,
                 size = excluded.size,
                 title = excluded.title,
                 artist = excluded.artist,
                 album = excluded.album,
                 album_artist = excluded.album_artist,
                 disc = excluded.disc,
                 track = excluded.track,
                 duration = excluded.duration",
            params![
                path_str,
                mtime,
                size,
                tags.title,
                tags.artist,
                tags.album,
                tags.album_artist,
                tags.disc,
                tags.track,
                tags.duration
            ],
        );
    }

    // Remove every row not in this scan. This both drops files that disappeared under
    // the current root and clears orphans left behind by a previous library root.
    tx.execute(
        "DELETE FROM tracks WHERE path NOT IN (SELECT path FROM scan_current)",
        [],
    )
    .map_err(|e| format!("delete missing failed: {}", e))?;

    tx.commit().map_err(|e| format!("commit failed: {}", e))?;
    Ok(())
}

struct ScanCoalesce {
    running: bool,
    // While a scan runs, holds the most recent (root, db_path) for exactly one
    // follow-up pass. A burst of watcher flushes during a long scan collapses
    // into a single extra scan rather than a thread (and full library walk) per
    // flush, and a library-root change mid-scan is still honored.
    pending: Option<(PathBuf, PathBuf)>,
}

// Mutex guards only the bools/Option above for very short critical sections;
// the data is trivially valid, so a poisoned lock is recovered rather than
// propagated (a panicked scan must not wedge all future scans).
fn scan_coalesce() -> &'static Mutex<ScanCoalesce> {
    static C: OnceLock<Mutex<ScanCoalesce>> = OnceLock::new();
    C.get_or_init(|| {
        Mutex::new(ScanCoalesce {
            running: false,
            pending: None,
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
            c.pending = Some((root, db_path));
            return;
        }
        c.running = true;
    }
    std::thread::spawn(move || {
        let mut root = root;
        let mut db_path = db_path;
        loop {
            scan_and_emit(root.clone(), db_path.clone(), app.clone());
            let mut c = scan_coalesce().lock().unwrap_or_else(|e| e.into_inner());
            match c.pending.take() {
                Some((r, d)) => {
                    root = r;
                    db_path = d;
                }
                None => {
                    c.running = false;
                    return;
                }
            }
        }
    });
}

fn scan_and_emit(root: PathBuf, db_path: PathBuf, app: AppHandle) {
    let payload = match run_scan(root, db_path) {
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

type MetaRow = (
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<u32>,
    Option<u32>,
    Option<f64>,
);

// Fetches (title, artist, album, disc, track) for many paths in one round trip
// instead of a SELECT per path. SQLite caps bound parameters (default 999), so
// paths are chunked. Paths missing from the cache simply don't appear in the
// map; callers substitute a None-filled row.
fn fetch_meta(conn: &Connection, paths: &[String]) -> Result<HashMap<String, MetaRow>, String> {
    let mut map: HashMap<String, MetaRow> = HashMap::with_capacity(paths.len());
    for chunk in paths.chunks(900) {
        let placeholders = vec!["?"; chunk.len()].join(",");
        let sql = format!(
            "SELECT path, title, artist, album, album_artist, disc, track, duration FROM tracks WHERE path IN ({})",
            placeholders
        );
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params_from_iter(chunk), |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    (
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                        row.get(6)?,
                        row.get(7)?,
                    ),
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
fn list_dir(path: String, db: State<DbHandle>) -> Result<DirListing, String> {
    let entries = std::fs::read_dir(&path).map_err(|e| e.to_string())?;

    let mut folders: Vec<String> = Vec::new();
    let mut file_names: Vec<String> = Vec::new();
    let mut playlists: Vec<PlaylistListing> = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let entry_path = entry.path();
        // Follow symlinks so a link to a dir/file shows up under its true type.
        // Broken links and permission errors are skipped silently.
        let Ok(meta) = std::fs::metadata(&entry_path) else {
            continue;
        };
        let name = entry.file_name().to_string_lossy().into_owned();
        if meta.is_dir() {
            folders.push(name);
        } else if meta.is_file() && is_audio_path(&name) {
            file_names.push(name);
        } else if meta.is_file() && playlist::is_playlist_path(&name) {
            // Playlists stay out of the audio-tag path (no tag scan, own icon
            // and click action); the display name comes from the file.
            playlists.push(PlaylistListing {
                name: playlist::display_name(&entry_path),
                file: name,
            });
        }
    }
    folders.sort_by_key(|s| s.to_lowercase());
    // Playlists sort after all tracks, alphabetically by display name.
    playlists.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

    let fulls: Vec<String> = file_names.iter().map(|n| join_path(&path, n)).collect();
    let meta_map = {
        // Recover a poisoned lock rather than propagate it: the Connection is
        // still valid after a panic that didn't corrupt an open transaction, and
        // wedging every future DB read for the session is worse than the rare
        // inconsistency. Mirrors scan_coalesce's poison handling.
        let conn = db.conn.lock().unwrap_or_else(|e| e.into_inner());
        fetch_meta(&conn, &fulls)?
    };
    let mut files: Vec<FileEntry> = Vec::with_capacity(file_names.len());
    for (name, full) in file_names.into_iter().zip(fulls.into_iter()) {
        // The browse tree doesn't show per-track runtime, so the duration column
        // fetch_meta now returns is ignored here.
        let (title, artist, album, album_artist, disc, track, _duration) = meta_map
            .get(&full)
            .cloned()
            .unwrap_or((None, None, None, None, None, None, None));
        files.push(FileEntry {
            name,
            title,
            artist,
            album,
            album_artist,
            disc,
            track,
        });
    }

    // Sort by (disc, track, name). Missing disc is treated as disc 1; missing track sorts
    // after numbered tracks within the same disc.
    files.sort_by(|a, b| {
        let ad = a.disc.unwrap_or(1);
        let bd = b.disc.unwrap_or(1);
        ad.cmp(&bd)
            .then_with(|| {
                a.track
                    .unwrap_or(u32::MAX)
                    .cmp(&b.track.unwrap_or(u32::MAX))
            })
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(DirListing {
        folders,
        files,
        playlists,
    })
}

// The stream list is an extended M3U (.m3u8) file: each stream is a URL,
// optionally preceded by an #EXTINF line carrying its display name and, via the
// de-facto tvg-logo attribute, its station art. The path is a local file or an
// http(s) URL (remote stream lists are fetched here rather than in the webview,
// which the CSP blocks).
#[tauri::command]
fn read_stream_list(path: String) -> Result<Vec<Stream>, String> {
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
    Ok(ensure_default_stream_list(&app)?.to_string_lossy().into_owned())
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
fn add_stream(path: String, name: String, url: String, image: Option<String>) -> Result<(), String> {
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
    let starts: Vec<usize> = spans.iter().map(|&(extinf, url)| extinf.unwrap_or(url)).collect();
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
    for path in paths {
        if path.is_empty() {
            continue;
        }
        request_scan(PathBuf::from(path), db.path.clone(), app.clone());
    }
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
    let tagged = lofty::read_from_path(std::path::Path::new(&path)).ok()?;
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
        (bytes, image_mime_from_ext(&path.to_string_lossy()).to_string())
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
    })
}

// from the decoded audio, not a tag, so it is neither shown nor written here.
//
// The frontend refuses this for the file the audio engine currently holds open
// (lofty rewrites the file in place, which would corrupt an in-progress decode),
// so this command assumes the file is not being played.
#[tauri::command]
fn write_tags(
    path: String,
    title: Option<String>,
    artist: Option<String>,
    album_artist: Option<String>,
    album: Option<String>,
    disc: Option<u32>,
    track: Option<u32>,
    db: State<DbHandle>,
) -> Result<FileEntry, String> {
    let p = PathBuf::from(&path);
    let mut tagged = lofty::read_from_path(&p).map_err(|e| format!("read failed: {}", e))?;

    // Untagged files have no tag to mutate; give them one of the container's
    // native type (ID3v2 for MP3, MP4 atoms for m4a, Vorbis comments for FLAC…).
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
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        let _ = conn.execute(
            "UPDATE tracks SET mtime = ?2, size = ?3, title = ?4, artist = ?5,
                 album = ?6, album_artist = ?7, disc = ?8, track = ?9 WHERE path = ?1",
            params![path, mtime, size, title, artist, album, album_artist, disc, track],
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
    })
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

// Sync the "Mini Player" checkmark to the current mode (the frontend derives it
// from the viewport height, on startup and on every resize).
#[tauri::command]
fn set_miniplayer_checked(menu: State<WindowMenu>, mini: bool) {
    let _ = menu.miniplayer.set_checked(mini);
}

// Enable/disable "Save Queue as Playlist" (⌘S). The frontend calls this as playback
// state changes: only an ephemeral queue that's the active pool can be
// converted (a saved playlist already autosaves, nothing else is convertible).
#[tauri::command]
fn set_save_playlist_enabled(menu: State<PlaylistMenu>, enabled: bool) {
    let _ = menu.save_as.set_enabled(enabled);
}

// Toggle "Move Playlist File…" as the open playlist (browsed or playing) comes
// and goes: there's no file to relocate when no playlist is open.
#[tauri::command]
fn set_move_playlist_enabled(menu: State<PlaylistMenu>, enabled: bool) {
    let _ = menu.move_file.set_enabled(enabled);
}

// Rebuild the Open Recent submenu from the frontend's persisted recents
// (most-recent first). Each row's id carries its path (playlist-recent:<path>)
// so the click handler can relay it; an empty list shows a disabled placeholder.
#[tauri::command]
fn set_recent_playlists(
    app: AppHandle,
    menu: State<PlaylistMenu>,
    items: Vec<RecentPlaylist>,
) -> Result<(), String> {
    let sub = &menu.recent;
    let count = sub.items().map_err(|e| e.to_string())?.len();
    for _ in 0..count {
        sub.remove_at(0).map_err(|e| e.to_string())?;
    }
    if items.is_empty() {
        let empty = MenuItemBuilder::with_id("playlist-recent-empty", "No Recent Playlists")
            .enabled(false)
            .build(&app)
            .map_err(|e| e.to_string())?;
        sub.append(&empty).map_err(|e| e.to_string())?;
        return Ok(());
    }
    for it in &items {
        let item = MenuItemBuilder::with_id(format!("playlist-recent:{}", it.path), &it.name)
            .build(&app)
            .map_err(|e| e.to_string())?;
        sub.append(&item).map_err(|e| e.to_string())?;
    }
    let sep = PredefinedMenuItem::separator(&app).map_err(|e| e.to_string())?;
    sub.append(&sep).map_err(|e| e.to_string())?;
    let clear = MenuItemBuilder::with_id("playlist-recent-clear", "Clear Recent")
        .build(&app)
        .map_err(|e| e.to_string())?;
    sub.append(&clear).map_err(|e| e.to_string())?;
    Ok(())
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
fn search_tracks(query: String, db: State<DbHandle>) -> Result<Vec<SearchResult>, String> {
    let q = query.trim();
    if q.is_empty() {
        return Ok(Vec::new());
    }
    let like = format!("%{}%", escape_like(q));

    let conn = db.conn.lock().unwrap_or_else(|e| e.into_inner());
    let mut stmt = conn
        .prepare(
            "SELECT path, title, artist, album, duration FROM tracks
             WHERE title LIKE ?1 ESCAPE '\\'
                OR artist LIKE ?1 ESCAPE '\\'
                OR album LIKE ?1 ESCAPE '\\'
                OR path LIKE ?1 ESCAPE '\\'
             ORDER BY artist IS NULL, artist COLLATE NOCASE,
                      album COLLATE NOCASE, disc, track,
                      title COLLATE NOCASE
             LIMIT 50",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([&like], |row| {
            Ok(SearchResult {
                path: row.get(0)?,
                title: row.get(1)?,
                artist: row.get(2)?,
                album: row.get(3)?,
                // Flat/positional list: the gutter shows a row index, not a
                // within-album ordinal, so no metadata track number is carried.
                track: None,
                duration: row.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

// Folders whose name (any path segment above a track) contains the query.
// Folders aren't stored as rows — they're the ancestor directories of cached
// track paths — so they're derived here: every track path matching the query
// somewhere is split into its ancestor dirs, and each dir whose own name
// matches is kept once. Matches search_tracks' literal (escaped) substring
// semantics and cap.
#[tauri::command]
fn search_folders(query: String, db: State<DbHandle>) -> Result<Vec<FolderResult>, String> {
    let q = query.trim();
    if q.is_empty() {
        return Ok(Vec::new());
    }
    let needle = q.to_lowercase();
    // A folder name only matches if the query is a substring of the full path,
    // so pre-filter in SQL to avoid walking every track on each keystroke.
    let like = format!("%{}%", escape_like(q));

    let conn = db.conn.lock().unwrap_or_else(|e| e.into_inner());
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
}

// Every cached track under a folder (recursively), ordered for playback:
// grouped by album, then disc/track, so an album folder plays in track order
// and an artist folder plays album by album. Backs the "play a folder from
// search" action.
#[tauri::command]
fn folder_tracks(path: String, db: State<DbHandle>) -> Result<Vec<SearchResult>, String> {
    // Trailing slash so `/a/b` matches `/a/b/…` but not a sibling `/a/bc/…`.
    let prefix = if path.ends_with('/') {
        path.clone()
    } else {
        format!("{}/", path)
    };
    let like = format!("{}%", escape_like(&prefix));

    let conn = db.conn.lock().unwrap_or_else(|e| e.into_inner());
    let mut stmt = conn
        .prepare(
            "SELECT path, title, artist, album, duration FROM tracks
             WHERE path LIKE ?1 ESCAPE '\\'
             ORDER BY album IS NULL, album COLLATE NOCASE,
                      disc, track, path COLLATE NOCASE",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([&like], |row| {
            Ok(SearchResult {
                path: row.get(0)?,
                title: row.get(1)?,
                artist: row.get(2)?,
                album: row.get(3)?,
                // Flat/positional list: the gutter shows a row index, not a
                // within-album ordinal, so no metadata track number is carried.
                track: None,
                duration: row.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

// The album grouping key, matching how mainstream players identify an album:
// the ALBUMARTIST tag when present, else the track artist. An empty string
// stands in for "no artist at all" so the value is never NULL and equality
// comparisons (and the frontend's albumArtist ?? artist) stay total.
const ALBUM_ARTIST_EXPR: &str = "COALESCE(NULLIF(album_artist, ''), artist, '')";

// Distinct artists whose name contains the query. Backs the "artist" rows in
// search; choosing one opens an immutable queue of every track by that artist.
#[tauri::command]
fn search_artists(query: String, db: State<DbHandle>) -> Result<Vec<ArtistResult>, String> {
    let q = query.trim();
    if q.is_empty() {
        return Ok(Vec::new());
    }
    let like = format!("%{}%", escape_like(q));

    let conn = db.conn.lock().unwrap_or_else(|e| e.into_inner());
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
}

// Distinct (album, album-artist) pairs whose album name contains the query.
// Choosing one opens an immutable queue of the album's tracks in disc/track
// order.
#[tauri::command]
fn search_albums(query: String, db: State<DbHandle>) -> Result<Vec<AlbumResult>, String> {
    let q = query.trim();
    if q.is_empty() {
        return Ok(Vec::new());
    }
    let like = format!("%{}%", escape_like(q));

    let conn = db.conn.lock().unwrap_or_else(|e| e.into_inner());
    let sql = format!(
        "SELECT album, {expr} AS album_artist FROM tracks
         WHERE album IS NOT NULL AND album <> '' AND album LIKE ?1 ESCAPE '\\'
         GROUP BY album, album_artist
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
}

// Every track by an artist, ordered album by album (then disc/track) for
// playback. Backs the artist queue page.
#[tauri::command]
fn artist_tracks(artist: String, db: State<DbHandle>) -> Result<Vec<SearchResult>, String> {
    let conn = db.conn.lock().unwrap_or_else(|e| e.into_inner());
    let mut stmt = conn
        .prepare(
            "SELECT path, title, artist, album, duration FROM tracks
             WHERE artist = ?1
             ORDER BY album IS NULL, album COLLATE NOCASE,
                      disc, track, path COLLATE NOCASE",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([&artist], |row| {
            Ok(SearchResult {
                path: row.get(0)?,
                title: row.get(1)?,
                artist: row.get(2)?,
                album: row.get(3)?,
                // Flat/positional list: the gutter shows a row index, not a
                // within-album ordinal, so no metadata track number is carried.
                track: None,
                duration: row.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

// Every track on an album (identified by name + album artist), in disc/track
// order. `album_artist` is the grouping key the frontend already holds —
// albumArtist ?? artist for a track row, or the value from a search album row.
// Backs the album queue page.
#[tauri::command]
fn album_tracks(
    album: String,
    album_artist: String,
    db: State<DbHandle>,
) -> Result<Vec<SearchResult>, String> {
    let conn = db.conn.lock().unwrap_or_else(|e| e.into_inner());
    let sql = format!(
        "SELECT path, title, artist, album, track, duration FROM tracks
         WHERE album = ?1 AND {expr} = ?2
         ORDER BY disc, track, path COLLATE NOCASE",
        expr = ALBUM_ARTIST_EXPR
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![album, album_artist], |row| {
            Ok(SearchResult {
                path: row.get(0)?,
                title: row.get(1)?,
                artist: row.get(2)?,
                album: row.get(3)?,
                track: row.get(4)?,
                duration: row.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

// The whole library as a flat track list, in the same album-by-album order the
// search/artist queries use, so the Songs view reads consistently. Unfiltered
// twin of search_tracks with the LIKE and LIMIT removed — it returns every
// cached track (the view virtualizes for scale; see plan.md Phase 7). Reuses
// SearchResult so no new frontend plumbing.
#[tauri::command]
fn list_all_songs(db: State<DbHandle>) -> Result<Vec<SearchResult>, String> {
    let conn = db.conn.lock().unwrap_or_else(|e| e.into_inner());
    let mut stmt = conn
        .prepare(
            "SELECT path, title, artist, album, duration FROM tracks
             ORDER BY artist IS NULL, artist COLLATE NOCASE,
                      album COLLATE NOCASE, disc, track,
                      title COLLATE NOCASE",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(SearchResult {
                path: row.get(0)?,
                title: row.get(1)?,
                artist: row.get(2)?,
                album: row.get(3)?,
                // Flat/positional list: the gutter shows a row index, not a
                // within-album ordinal, so no metadata track number is carried.
                track: None,
                duration: row.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

// Every distinct artist in the library, alphabetized. Unfiltered twin of
// search_artists with the LIKE and LIMIT removed; reuses ArtistResult. Backs the
// Artists browse list; drilling in reuses artist_tracks.
#[tauri::command]
fn list_all_artists(db: State<DbHandle>) -> Result<Vec<ArtistResult>, String> {
    let conn = db.conn.lock().unwrap_or_else(|e| e.into_inner());
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
}

// Every distinct (album, album-artist) pair in the library, alphabetized.
// Unfiltered twin of search_albums; reuses AlbumResult. Grouping on
// ALBUM_ARTIST_EXPR (not the raw album_artist column) so the key matches what
// album_tracks / openAlbumQueue expect — a track with an empty album_artist
// groups under its track artist, not a blank bucket. Backs the Albums browse
// list.
#[tauri::command]
fn list_all_albums(db: State<DbHandle>) -> Result<Vec<AlbumResult>, String> {
    let conn = db.conn.lock().unwrap_or_else(|e| e.into_inner());
    let sql = format!(
        "SELECT album, {expr} AS album_artist FROM tracks
         WHERE album IS NOT NULL AND album <> ''
         GROUP BY album, album_artist
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
}

// Distinct albums that contain a track by this artist, carrying the album-artist
// grouping key (ALBUM_ARTIST_EXPR) so a drill-in via album_tracks / openAlbumQueue
// matches — including a compilation whose album_artist differs from the track
// artist. Reuses AlbumResult. Backs the artist-detail (albums) view of the
// Artists browse lens; filtering on the *track* artist mirrors artist_tracks.
#[tauri::command]
fn artist_albums(artist: String, db: State<DbHandle>) -> Result<Vec<AlbumResult>, String> {
    let conn = db.conn.lock().unwrap_or_else(|e| e.into_inner());
    let sql = format!(
        "SELECT album, {expr} AS album_artist FROM tracks
         WHERE artist = ?1 AND album IS NOT NULL AND album <> ''
         GROUP BY album, album_artist
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
}

// Tracks by this artist that belong to no album (empty/NULL album tag) — the
// complement of artist_albums, which drops them. The artist-detail view lists
// these below the albums so an artist's loose singles aren't stranded. Filtering
// on the *track* artist mirrors artist_albums; ordered by title for a stable,
// readable list. Reuses SearchResult.
#[tauri::command]
fn artist_albumless_tracks(
    artist: String,
    db: State<DbHandle>,
) -> Result<Vec<SearchResult>, String> {
    let conn = db.conn.lock().unwrap_or_else(|e| e.into_inner());
    let mut stmt = conn
        .prepare(
            "SELECT path, title, artist, album, duration FROM tracks
             WHERE artist = ?1 AND (album IS NULL OR album = '')
             ORDER BY title COLLATE NOCASE, path COLLATE NOCASE",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([&artist], |row| {
            Ok(SearchResult {
                path: row.get(0)?,
                title: row.get(1)?,
                artist: row.get(2)?,
                album: row.get(3)?,
                // Flat list: the gutter shows a row index, not a within-album
                // ordinal, so no metadata track number is carried.
                track: None,
                duration: row.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| e.to_string())?);
    }
    Ok(out)
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
        // Single-instance must be the first plugin. When a second launch happens
        // (e.g. user double-clicks another mp3 on Windows/Linux), this callback
        // fires in the running instance with the new process's argv.
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
                // Mini Player checkbox auto-toggled before this fires; the frontend
                // owns the mode (it resizes across the breakpoint) and re-syncs the
                // checkmark from the resulting viewport height.
                "window-miniplayer" => {
                    let _ = app.emit("menu:miniplayer", ());
                }
                // The checkbox auto-toggled its own state before this fires, so
                // is_checked() reads the new value; relay it to the frontend,
                // which owns the setting and persists it.
                "autoadvance" => {
                    if let Some(menu) = app.try_state::<PlaybackMenu>() {
                        let enabled = menu.autoadvance.is_checked().unwrap_or(true);
                        let _ = app.emit("menu:autoadvance", enabled);
                    }
                }
                // Playlist menu — the frontend owns the dialogs, writes, and
                // recents, so these relay the intent. Recent items carry their
                // path in the id (playlist-recent:<path>).
                "playlist-new" => {
                    let _ = app.emit("menu:playlist", "new");
                }
                "playlist-open" => {
                    let _ = app.emit("menu:playlist", "open");
                }
                "playlist-save" => {
                    let _ = app.emit("menu:playlist", "save");
                }
                "playlist-move" => {
                    let _ = app.emit("menu:playlist", "move");
                }
                "playlist-recent-clear" => {
                    let _ = app.emit("menu:playlist", "recent-clear");
                }
                other if other.starts_with("playlist-recent:") => {
                    let path = other.trim_start_matches("playlist-recent:");
                    let _ = app.emit("menu:playlist-open-path", path.to_string());
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

            // The native macOS About panel only renders name/version/copyright
            // and the credits string, so the developer name + URL go in credits
            // (authors/website are still set for the Win/Linux about dialog).
            let about = AboutMetadataBuilder::new()
                .name(Some("Pudding"))
                .version(Some(env!("CARGO_PKG_VERSION")))
                .copyright(Some("© 2026 Greg Smith"))
                .authors(Some(vec!["Greg Smith".into()]))
                .website(Some("https://incompl.com"))
                .website_label(Some("incompl.com"))
                .build();

            // App settings live under the standard macOS Preferences slot
            // (Pudding → Settings…, ⌘,). Selecting it emits "open-settings",
            // which the frontend uses to reveal the settings panel.
            let settings_item = MenuItemBuilder::with_id("open-settings", "Settings…")
                .accelerator("CmdOrCtrl+,")
                .build(app)?;

            let app_menu = SubmenuBuilder::new(app, "Pudding")
                .about(Some(about))
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
            let edit_menu = SubmenuBuilder::new(app, "Edit")
                .undo()
                .redo()
                .separator()
                .cut()
                .copy()
                .paste()
                .select_all()
                .build()?;

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
            let play_pause = MenuItemBuilder::with_id("transport-playpause", "Play / Pause")
                .build(app)?;
            let previous = MenuItemBuilder::with_id("transport-prev", "Previous")
                .accelerator("CmdOrCtrl+Left")
                .build(app)?;
            let next = MenuItemBuilder::with_id("transport-next", "Next")
                .accelerator("CmdOrCtrl+Right")
                .build(app)?;
            let autoadvance =
                CheckMenuItemBuilder::with_id("autoadvance", "Autoadvance")
                    .checked(true)
                    .build(app)?;
            // Shuffle / Repeat / Volume / Mute mirror the toolbar controls; the
            // frontend owns the state and re-syncs these checkmarks after any
            // change (set_shuffle_checked / set_repeat_checked / set_mute_checked).
            // Repeat is three radio-style items (only one checked); Volume nudges
            // and Mute have bare-key toolbar equivalents, so no accelerators here.
            let shuffle = CheckMenuItemBuilder::with_id("playback-shuffle", "Shuffle")
                .build(app)?;
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
            });

            // Playlist menu: New / Open… / Open Recent ▸ then Save Queue as Playlist
            // (⌘S) and Move Playlist File…. Every item relays to the frontend
            // (menu:playlist / menu:playlist-open-path), which owns the dialogs,
            // file writes, and recents list. "Save Queue as Playlist" starts disabled
            // (only an ephemeral queue can be converted) and Open Recent starts
            // with a placeholder; the frontend syncs both after load.
            let new_playlist =
                MenuItemBuilder::with_id("playlist-new", "New Playlist…").build(app)?;
            let open_playlist =
                MenuItemBuilder::with_id("playlist-open", "Open Playlist…").build(app)?;
            let recent_submenu = SubmenuBuilder::new(app, "Open Recent Playlist").build()?;
            let recent_placeholder =
                MenuItemBuilder::with_id("playlist-recent-empty", "No Recent Playlists")
                    .enabled(false)
                    .build(app)?;
            recent_submenu.append(&recent_placeholder)?;
            let save_as = MenuItemBuilder::with_id("playlist-save", "Save Queue as Playlist…")
                .accelerator("CmdOrCtrl+S")
                .enabled(false)
                .build(app)?;
            let move_file = MenuItemBuilder::with_id("playlist-move", "Move Playlist File…")
                .enabled(false)
                .build(app)?;
            let playlist_menu = SubmenuBuilder::new(app, "File")
                .item(&new_playlist)
                .item(&open_playlist)
                .item(&recent_submenu)
                .separator()
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

            // Order follows macOS convention: the app menu, then File (which owns
            // New/Open/Save — playlists are Pudding's only document type),
            // Edit, our Playback menu, and Window last.
            let menu = MenuBuilder::new(app)
                .items(&[
                    &app_menu,
                    &playlist_menu,
                    &edit_menu,
                    &playback_menu,
                    &window_menu,
                ])
                .build()?;
            app.set_menu(menu)?;

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
            set_miniplayer_checked,
            set_save_playlist_enabled,
            set_move_playlist_enabled,
            set_recent_playlists,
            audio_append,
            audio_stop,
            audio_set_volume,
            now_playing_set_metadata,
            now_playing_set_playback,
            now_playing_clear,
            playlist::read_playlist,
            playlist::write_playlist,
            playlist::move_playlist,
            playlist::rename_playlist,
            playlist::delete_playlist,
            playlist::list_all_playlists,
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
        add_stream(p.clone(), "  Jazz24  ".into(), " https://ex.am/jazz ".into(), None).unwrap();
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
        assert!(add_stream("https://ex.am/list.m3u8".into(), "x".into(), "y".into(), None).is_err());
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
        assert!(std::fs::read_to_string(&path).unwrap().contains("#EXTVLCOPT:network-caching=1000"));

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
        let streams =
            parse_m3u_stream_list(&std::fs::read_to_string(&path).unwrap()).unwrap();
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
