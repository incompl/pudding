use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, UNIX_EPOCH};

use base64::Engine;
use lofty::prelude::*;
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use notify_debouncer_full::{new_debouncer, DebounceEventResult, Debouncer, FileIdMap};
use rusqlite::{params, params_from_iter, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_store::StoreExt;

const STORE_FILE: &str = "settings.json";
const KEY_LIBRARY_ROOT: &str = "libraryRoot";
const DB_FILE: &str = "metadata.db";

struct DbHandle {
    conn: Arc<Mutex<Connection>>,
    path: PathBuf,
}

// Holds the recursive filesystem watcher for the current library root. Replaced
// (the old debouncer dropped, which stops its thread) whenever the root changes;
// None when no library root is set.
struct WatcherState {
    inner: Mutex<Option<Debouncer<RecommendedWatcher, FileIdMap>>>,
}

#[derive(Serialize)]
struct FileEntry {
    name: String,
    title: Option<String>,
    artist: Option<String>,
    album: Option<String>,
    disc: Option<u32>,
    track: Option<u32>,
}

#[derive(Serialize)]
struct TrackMeta {
    title: Option<String>,
    artist: Option<String>,
    album: Option<String>,
    disc: Option<u32>,
    track: Option<u32>,
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
}

#[derive(Serialize, Deserialize)]
struct Stream {
    name: String,
    url: String,
}

#[derive(Serialize, Clone)]
struct ScanResult {
    ok: bool,
    error: Option<String>,
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
    disc: Option<u32>,
    track: Option<u32>,
}

// The tracks table is a cache rebuilt by run_scan; bump this whenever its shape changes
// and the next startup will drop and recreate it.
const SCHEMA_VERSION: i64 = 1;

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
            disc INTEGER,
            track INTEGER
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
        disc: None,
        track: None,
    };
    let Ok(tagged) = lofty::read_from_path(path) else {
        return empty;
    };
    let Some(tag) = tagged.primary_tag().or_else(|| tagged.first_tag()) else {
        return empty;
    };
    let norm = |v: Option<std::borrow::Cow<'_, str>>| {
        v.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
    };
    Tags {
        title: norm(tag.title()),
        artist: norm(tag.artist()),
        album: norm(tag.album()),
        disc: tag.disk(),
        track: tag.track(),
    }
}

fn walk_mp3s(root: &std::path::Path, out: &mut Vec<PathBuf>, visited: &mut HashSet<PathBuf>) {
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
            walk_mp3s(&path, out, visited);
        } else if meta.is_file() {
            let name = entry.file_name();
            if name.to_string_lossy().to_lowercase().ends_with(".mp3") {
                out.push(path);
            }
        }
    }
}

fn run_scan(root: PathBuf, db_path: PathBuf) -> Result<(), String> {
    let mut files = Vec::new();
    let mut visited = HashSet::new();
    walk_mp3s(&root, &mut files, &mut visited);

    let mut conn = open_connection(&db_path)
        .map_err(|e| format!("open scan connection failed: {}", e))?;
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
            "INSERT INTO tracks (path, mtime, size, title, artist, album, disc, track)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(path) DO UPDATE SET
                 mtime = excluded.mtime,
                 size = excluded.size,
                 title = excluded.title,
                 artist = excluded.artist,
                 album = excluded.album,
                 disc = excluded.disc,
                 track = excluded.track",
            params![
                path_str,
                mtime,
                size,
                tags.title,
                tags.artist,
                tags.album,
                tags.disc,
                tags.track
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
        Ok(()) => ScanResult { ok: true, error: None },
        Err(e) => {
            eprintln!("scan failed: {}", e);
            ScanResult { ok: false, error: Some(e) }
        }
    };
    let _ = app.emit("library-scanned", payload);
}

type MetaRow = (
    Option<String>,
    Option<String>,
    Option<String>,
    Option<u32>,
    Option<u32>,
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
            "SELECT path, title, artist, album, disc, track FROM tracks WHERE path IN ({})",
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
        } else if meta.is_file() && name.to_lowercase().ends_with(".mp3") {
            file_names.push(name);
        }
    }
    folders.sort_by_key(|s| s.to_lowercase());

    let fulls: Vec<String> = file_names.iter().map(|n| join_path(&path, n)).collect();
    let meta_map = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        fetch_meta(&conn, &fulls)?
    };
    let mut files: Vec<FileEntry> = Vec::with_capacity(file_names.len());
    for (name, full) in file_names.into_iter().zip(fulls.into_iter()) {
        let (title, artist, album, disc, track) = meta_map
            .get(&full)
            .cloned()
            .unwrap_or((None, None, None, None, None));
        files.push(FileEntry {
            name,
            title,
            artist,
            album,
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
            .then_with(|| a.track.unwrap_or(u32::MAX).cmp(&b.track.unwrap_or(u32::MAX)))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(DirListing { folders, files })
}

#[tauri::command]
fn read_manifest(path: String) -> Result<Vec<Stream>, String> {
    let contents = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&contents).map_err(|e| e.to_string())
}

// Asset scope is in-memory only. Re-applied on boot from the store, and
// extended at runtime when the user changes the library root.
#[tauri::command]
fn set_asset_scope(app: tauri::AppHandle, path: String) -> Result<(), String> {
    app.asset_protocol_scope()
        .allow_directory(&path, true)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn rescan_library(path: String, db: State<DbHandle>, app: AppHandle) {
    request_scan(PathBuf::from(path), db.path.clone(), app);
}

// Starts (or replaces) a recursive watcher on the library root. Any filesystem
// change under it triggers a debounced incremental rescan, which emits
// "library-scanned" exactly like an explicit rescan so the frontend refreshes
// uniformly. An empty path just tears the watcher down.
#[tauri::command]
fn watch_library(
    path: String,
    app: AppHandle,
    db: State<DbHandle>,
    watcher: State<WatcherState>,
) -> Result<(), String> {
    let mut guard = watcher.inner.lock().map_err(|e| e.to_string())?;
    // Drop the old debouncer first so we never hold two watchers on overlapping
    // trees during a root change.
    *guard = None;
    if path.is_empty() {
        return Ok(());
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
    // goes dead and does not self-heal until the root is set again (which calls
    // this command afresh). Acceptable for a music library; the explicit-rescan
    // and boot paths still function.
    debouncer
        .watcher()
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;
    debouncer.cache().add_root(&root, RecursiveMode::Recursive);
    *guard = Some(debouncer);
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

// Picks the first arg that looks like an audio file path. We can't assume
// position because launchers / OS shells pass argv differently (macOS adds
// -psn flags, some Windows shells quote oddly).
fn find_audio_in_argv(argv: &[String]) -> Option<String> {
    argv.iter()
        .skip(1)
        .find(|a| is_audio_path(a) && Path::new(a).exists())
        .cloned()
}

fn deliver_open_file(app: &AppHandle, path: String) {
    if !is_audio_path(&path) {
        return;
    }
    // Grant asset-protocol access to just this file so the webview can load it
    // via convertFileSrc without widening scope to its parent directory.
    let _ = app.asset_protocol_scope().allow_file(&path);

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

// Prepares an externally-opened file for playback: grants asset access and
// returns tags read directly from the file (it may not be in the library DB).
#[tauri::command]
fn prepare_external_file(path: String, app: AppHandle) -> Result<TrackMeta, String> {
    let p = Path::new(&path);
    if !p.exists() {
        return Err(format!("file not found: {}", path));
    }
    app.asset_protocol_scope()
        .allow_file(&path)
        .map_err(|e| e.to_string())?;
    let tags = read_tags(p);
    Ok(TrackMeta {
        title: tags.title,
        artist: tags.artist,
        album: tags.album,
        disc: tags.disc,
        track: tags.track,
    })
}

#[tauri::command]
fn get_metadata(paths: Vec<String>, db: State<DbHandle>) -> Result<Vec<TrackMeta>, String> {
    let meta_map = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        fetch_meta(&conn, &paths)?
    };
    let out: Vec<TrackMeta> = paths
        .iter()
        .map(|p| {
            let (title, artist, album, disc, track) = meta_map
                .get(p)
                .cloned()
                .unwrap_or((None, None, None, None, None));
            TrackMeta {
                title,
                artist,
                album,
                disc,
                track,
            }
        })
        .collect();
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
            if let Some(path) = find_audio_in_argv(&argv) {
                deliver_open_file(app, path);
            }
        }))
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
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
                inner: Mutex::new(None),
            });

            let store = app.store(STORE_FILE)?;
            if let Some(value) = store.get(KEY_LIBRARY_ROOT) {
                if let Some(path) = value.as_str() {
                    if !path.is_empty() {
                        // Allow asset-protocol access immediately so audio playback works
                        // before the frontend kicks off its scan.
                        app.asset_protocol_scope().allow_directory(path, true)?;
                    }
                }
            }

            // Cold-start file open on Windows/Linux arrives as a CLI arg. On macOS
            // it arrives later via RunEvent::Opened (handled below).
            let argv: Vec<String> = std::env::args().collect();
            if let Some(path) = find_audio_in_argv(&argv) {
                deliver_open_file(&app.handle(), path);
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_dir,
            read_manifest,
            set_asset_scope,
            rescan_library,
            watch_library,
            get_metadata,
            get_art,
            frontend_ready,
            prepare_external_file
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
