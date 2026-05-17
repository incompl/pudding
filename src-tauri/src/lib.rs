use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::UNIX_EPOCH;

use lofty::prelude::*;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_store::StoreExt;

const STORE_FILE: &str = "settings.json";
const KEY_LIBRARY_ROOT: &str = "libraryRoot";
const DB_FILE: &str = "metadata.db";

struct DbHandle(Arc<Mutex<Connection>>);

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

fn walk_mp3s(root: &std::path::Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        let path = entry.path();
        if file_type.is_dir() {
            walk_mp3s(&path, out);
        } else if file_type.is_file() {
            let name = entry.file_name();
            if name.to_string_lossy().to_lowercase().ends_with(".mp3") {
                out.push(path);
            }
        }
    }
}

fn run_scan(root: PathBuf, db: Arc<Mutex<Connection>>) {
    let mut files = Vec::new();
    walk_mp3s(&root, &mut files);

    let mut conn = match db.lock() {
        Ok(c) => c,
        Err(_) => return,
    };
    let tx = match conn.transaction() {
        Ok(tx) => tx,
        Err(e) => {
            eprintln!("scan: begin tx failed: {}", e);
            return;
        }
    };

    if let Err(e) = tx.execute(
        "CREATE TEMP TABLE IF NOT EXISTS scan_current (path TEXT PRIMARY KEY)",
        [],
    ) {
        eprintln!("scan: create temp table failed: {}", e);
        return;
    }
    let _ = tx.execute("DELETE FROM scan_current", []);

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
            .ok();
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

    let root_str = root.to_string_lossy().to_string();
    let root_like = format!("{}/%", root_str.trim_end_matches('/'));
    if let Err(e) = tx.execute(
        "DELETE FROM tracks
         WHERE (path = ?1 OR path LIKE ?2)
           AND path NOT IN (SELECT path FROM scan_current)",
        params![root_str, root_like],
    ) {
        eprintln!("scan: delete missing failed: {}", e);
    }

    if let Err(e) = tx.commit() {
        eprintln!("scan: commit failed: {}", e);
    }
}

#[tauri::command]
fn list_dir(path: String, db: State<DbHandle>) -> Result<DirListing, String> {
    let entries = std::fs::read_dir(&path).map_err(|e| e.to_string())?;

    let mut folders: Vec<String> = Vec::new();
    let mut file_names: Vec<String> = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let file_type = entry.file_type().map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if file_type.is_dir() {
            folders.push(name);
        } else if file_type.is_file() && name.to_lowercase().ends_with(".mp3") {
            file_names.push(name);
        }
    }
    folders.sort_by_key(|s| s.to_lowercase());

    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let mut files: Vec<FileEntry> = Vec::with_capacity(file_names.len());
    for name in file_names {
        let full = join_path(&path, &name);
        let meta: Option<(
            Option<String>,
            Option<String>,
            Option<String>,
            Option<u32>,
            Option<u32>,
        )> = conn
            .query_row(
                "SELECT title, artist, album, disc, track FROM tracks WHERE path = ?",
                [&full],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .ok();
        let (title, artist, album, disc, track) = meta.unwrap_or((None, None, None, None, None));
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
    let db = db.0.clone();
    std::thread::spawn(move || {
        run_scan(PathBuf::from(path), db);
        let _ = app.emit("library-scanned", ());
    });
}

#[tauri::command]
fn get_metadata(paths: Vec<String>, db: State<DbHandle>) -> Result<Vec<TrackMeta>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let mut out: Vec<TrackMeta> = Vec::with_capacity(paths.len());
    for path in &paths {
        let row: Option<(
            Option<String>,
            Option<String>,
            Option<String>,
            Option<u32>,
            Option<u32>,
        )> = conn
            .query_row(
                "SELECT title, artist, album, disc, track FROM tracks WHERE path = ?",
                [path],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .ok();
        let (title, artist, album, disc, track) = row.unwrap_or((None, None, None, None, None));
        out.push(TrackMeta {
            title,
            artist,
            album,
            disc,
            track,
        });
    }
    Ok(out)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::new().build())
        .setup(|app| {
            let app_data = app.path().app_data_dir()?;
            std::fs::create_dir_all(&app_data)?;
            let db_path = app_data.join(DB_FILE);
            let conn = Connection::open(&db_path)?;
            init_schema(&conn)?;
            let db = Arc::new(Mutex::new(conn));
            app.manage(DbHandle(db.clone()));

            let store = app.store(STORE_FILE)?;
            if let Some(value) = store.get(KEY_LIBRARY_ROOT) {
                if let Some(path) = value.as_str() {
                    if !path.is_empty() {
                        app.asset_protocol_scope().allow_directory(path, true)?;
                        let path_owned = path.to_string();
                        let db_clone = db.clone();
                        let app_handle = app.handle().clone();
                        std::thread::spawn(move || {
                            run_scan(PathBuf::from(path_owned), db_clone);
                            let _ = app_handle.emit("library-scanned", ());
                        });
                    }
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_dir,
            read_manifest,
            set_asset_scope,
            rescan_library,
            get_metadata
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
