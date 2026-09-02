// Local .m3u/.m3u8 playlist support: parse (lenient, encoding-tolerant), write
// (always UTF-8 .m3u8), and index the library for the "Add to playlist ▸" menu
// and searchable playlists. A playlist is a *source* like a folder — not the
// queue — so this module only deals with the file format and metadata
// resolution; playback and curation live in the frontend.
//
// Format decisions (see playlist-plan.md "File format"):
// - Read `.m3u` and `.m3u8`; always write `.m3u8` bytes as UTF-8.
// - Non-lossy read: try UTF-8, fall back to Windows-1252 (a total byte→codepoint
//   map that never errors), so a legacy `.m3u` opens without corrupting paths.
// - Display name lives in a `#PLAYLIST:<name>` comment directive, never the
//   filename — so rename never touches the filesystem.
// - Metadata: the library DB wins for known paths; `#EXTINF` title / filename is
//   the fallback for out-of-library rows.
// - Paths: write relative to the playlist file when the track is under its
//   directory, absolute otherwise; resolve to absolute on open.

use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::SystemTime;

use rusqlite::Connection;
use serde::Serialize;
use tauri::State;

use crate::{fetch_meta, DbHandle};

const PLAYLIST_EXTS: &[&str] = &["m3u", "m3u8"];

pub fn is_playlist_path(s: &str) -> bool {
    Path::new(s)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| {
            let lower = e.to_ascii_lowercase();
            PLAYLIST_EXTS.iter().any(|x| *x == lower)
        })
        .unwrap_or(false)
}

// One resolved playlist row handed to the frontend. `path` is always absolute;
// `name` is the basename (shown for out-of-library rows). Metadata is the DB's
// when `in_library`, else the `#EXTINF` title / None. `missing` flags a row
// whose file is absent on disk (kept so the file round-trips, filtered out of
// what's handed to the engine).
#[derive(Serialize)]
pub struct PlaylistTrack {
    path: String,
    name: String,
    title: Option<String>,
    artist: Option<String>,
    album: Option<String>,
    #[serde(rename = "albumArtist")]
    album_artist: Option<String>,
    disc: Option<u32>,
    track: Option<u32>,
    #[serde(rename = "inLibrary")]
    in_library: bool,
    missing: bool,
    // Track length in seconds (None when unknown / out of library). Summed for
    // the playlist's runtime beside its track count.
    duration: Option<f64>,
}

#[derive(Serialize)]
pub struct PlaylistData {
    // Display name: the `#PLAYLIST:` directive, else the filename stem.
    name: String,
    path: String,
    tracks: Vec<PlaylistTrack>,
}

// A library playlist for the index (Add to playlist ▸ / searchable playlists).
#[derive(Serialize)]
pub struct PlaylistRef {
    path: String,
    name: String,
}

// One parsed entry before DB resolution: an absolute path plus the optional
// `#EXTINF` title that preceded it.
struct ParsedEntry {
    path: String,
    extinf_title: Option<String>,
}

// --- Encoding ---------------------------------------------------------------

// Decode playlist bytes non-lossily: UTF-8 when valid, else Windows-1252 (which
// maps every byte to a codepoint, so it never errors and never drops bytes).
fn decode_bytes(bytes: &[u8]) -> String {
    match std::str::from_utf8(bytes) {
        Ok(s) => s.to_string(),
        Err(_) => bytes.iter().map(|&b| cp1252_char(b)).collect(),
    }
}

// Windows-1252 differs from Latin-1 only in 0x80–0x9F; the rest is identity.
// Undefined slots (0x81, 0x8D, 0x8F, 0x90, 0x9D) map to the same codepoint so
// the mapping stays total and reversible enough for round-tripping paths.
fn cp1252_char(b: u8) -> char {
    match b {
        0x80 => '\u{20AC}',
        0x82 => '\u{201A}',
        0x83 => '\u{0192}',
        0x84 => '\u{201E}',
        0x85 => '\u{2026}',
        0x86 => '\u{2020}',
        0x87 => '\u{2021}',
        0x88 => '\u{02C6}',
        0x89 => '\u{2030}',
        0x8A => '\u{0160}',
        0x8B => '\u{2039}',
        0x8C => '\u{0152}',
        0x8E => '\u{017D}',
        0x91 => '\u{2018}',
        0x92 => '\u{2019}',
        0x93 => '\u{201C}',
        0x94 => '\u{201D}',
        0x95 => '\u{2022}',
        0x96 => '\u{2013}',
        0x97 => '\u{2014}',
        0x98 => '\u{02DC}',
        0x99 => '\u{2122}',
        0x9A => '\u{0161}',
        0x9B => '\u{203A}',
        0x9C => '\u{0153}',
        0x9E => '\u{017E}',
        0x9F => '\u{0178}',
        other => other as char,
    }
}

// --- Parsing ----------------------------------------------------------------

// Lexically normalize a path (collapse `.` and `..`) without touching the
// filesystem — playlist rows may point at files that don't exist yet.
fn normalize(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in p.components() {
        match comp {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

// Resolve a raw playlist line to an absolute path against the playlist's
// directory. Absolute lines are normalized as-is; relative ones join `base_dir`.
fn resolve_path(base_dir: &Path, raw: &str) -> String {
    let p = Path::new(raw);
    let joined = if p.is_absolute() {
        p.to_path_buf()
    } else {
        base_dir.join(p)
    };
    normalize(&joined).to_string_lossy().into_owned()
}

// Parse extended-M3U text into the display name and resolved entries. Blank
// lines and unknown `#` directives are ignored; `#PLAYLIST:` sets the name and
// `#EXTINF:<secs>,<title>` supplies a fallback title for the next path line.
fn parse(content: &str, base_dir: &Path) -> (Option<String>, Vec<ParsedEntry>) {
    let mut name: Option<String> = None;
    let mut entries: Vec<ParsedEntry> = Vec::new();
    let mut pending_title: Option<String> = None;

    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if let Some(rest) = line.strip_prefix('#') {
            if let Some(n) = rest.strip_prefix("PLAYLIST:") {
                name = Some(n.trim().to_string());
            } else if let Some(inf) = rest.strip_prefix("EXTINF:") {
                // `<secs>,<title>` — keep the title, drop the duration.
                pending_title = inf
                    .split_once(',')
                    .map(|(_, t)| t.trim().to_string())
                    .filter(|t| !t.is_empty());
            }
            // Other `#` directives (#EXTM3U, unknown extensions) round-trip
            // harmlessly by being ignored on read.
            continue;
        }
        entries.push(ParsedEntry {
            path: resolve_path(base_dir, line),
            extinf_title: pending_title.take(),
        });
    }
    (name, entries)
}

// The filename stem as a display-name fallback (Kodi/VLC convention when no
// `#PLAYLIST:` is present). Empty/oddly-named files fall back to "Untitled".
fn stem_name(path: &str) -> String {
    Path::new(path)
        .file_stem()
        .and_then(|s| s.to_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .unwrap_or_else(|| "Untitled".to_string())
}

// The directory used to resolve a playlist's relative rows. `Path::parent()`
// returns `Some("")` for a bare filename (not `None`), so an empty parent must
// also fall back to `/` to keep resolved row paths absolute.
fn playlist_base_dir(path: &str) -> PathBuf {
    match Path::new(path).parent() {
        Some(p) if !p.as_os_str().is_empty() => p.to_path_buf(),
        _ => PathBuf::from("/"),
    }
}

// --- Commands ---------------------------------------------------------------

// Open a playlist file: decode, parse, and resolve each row's metadata against
// the library DB (falling back to `#EXTINF`/filename for out-of-library rows).
#[tauri::command]
pub fn read_playlist(path: String, db: State<DbHandle>) -> Result<PlaylistData, String> {
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    let content = decode_bytes(&bytes);
    let base_dir = playlist_base_dir(&path);
    let (name, entries) = parse(&content, &base_dir);

    let paths: Vec<String> = entries.iter().map(|e| e.path.clone()).collect();
    let meta_map = {
        let conn = db.conn.lock().unwrap_or_else(|e| e.into_inner());
        fetch_meta(&conn, &paths)?
    };

    let tracks = entries
        .into_iter()
        .map(|e| {
            let basename = Path::new(&e.path)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or(&e.path)
                .to_string();
            let missing = !Path::new(&e.path).exists();
            match meta_map.get(&e.path).cloned() {
                Some((title, artist, album, album_artist, disc, track, duration)) => {
                    PlaylistTrack {
                        path: e.path,
                        name: basename,
                        title,
                        artist,
                        album,
                        album_artist,
                        disc,
                        track,
                        in_library: true,
                        missing,
                        duration,
                    }
                }
                None => PlaylistTrack {
                    // Out-of-library: no DB metadata; show the `#EXTINF` title
                    // if any, else the frontend falls back to the filename.
                    path: e.path,
                    name: basename,
                    title: e.extinf_title,
                    artist: None,
                    album: None,
                    album_artist: None,
                    disc: None,
                    track: None,
                    in_library: false,
                    missing,
                    duration: None,
                },
            }
        })
        .collect();

    Ok(PlaylistData {
        name: name
            .filter(|n| !n.is_empty())
            .unwrap_or_else(|| stem_name(&path)),
        path,
        tracks,
    })
}

// Serialize a playlist to extended-M3U text (UTF-8). Paths under the playlist's
// directory are written relative; others absolute. `#EXTINF` carries the DB
// display for portability, with the cached runtime in seconds (−1 if unknown).
fn serialize(
    path: &str,
    name: &str,
    tracks: &[String],
    conn: &Connection,
) -> Result<String, String> {
    let base_dir = playlist_base_dir(path);
    let meta_map = fetch_meta(conn, tracks)?;

    let mut out = String::from("#EXTM3U\n");
    out.push_str(&format!("#PLAYLIST:{}\n", sanitize_line(name)));
    for t in tracks {
        if let Some((title, artist, _, _, _, _, duration)) = meta_map.get(t) {
            let display = match (artist, title) {
                (Some(a), Some(ti)) => format!("{} - {}", a, ti),
                (_, Some(ti)) => ti.clone(),
                _ => String::new(),
            };
            if !display.is_empty() {
                let secs = duration.map(|d| d.round() as i64).unwrap_or(-1);
                out.push_str(&format!("#EXTINF:{},{}\n", secs, sanitize_line(&display)));
            }
        }
        out.push_str(&relativize(&base_dir, t));
        out.push('\n');
    }
    Ok(out)
}

// Collapse any run of line-break characters into a single space so a name or
// EXTINF display can't inject a bare line that re-parses as a track path on the
// next read. Trims the result since the collapse can leave edge whitespace.
fn sanitize_line(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut prev_break = false;
    for c in s.chars() {
        if c == '\n' || c == '\r' {
            if !prev_break {
                out.push(' ');
                prev_break = true;
            }
        } else {
            out.push(c);
            prev_break = false;
        }
    }
    out.trim().to_string()
}

// A track path relative to the playlist's directory when it's a descendant,
// else the absolute path unchanged.
fn relativize(base_dir: &Path, track: &str) -> String {
    Path::new(track)
        .strip_prefix(base_dir)
        .ok()
        .and_then(|rel| rel.to_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| track.to_string())
}

// Write (create or overwrite) a playlist file. Used by New (empty tracks),
// autosave after curation, Save-as-Playlist, and Add-to-playlist on a closed
// file.
#[tauri::command]
pub fn write_playlist(
    path: String,
    name: String,
    tracks: Vec<String>,
    db: State<DbHandle>,
) -> Result<(), String> {
    let content = {
        let conn = db.conn.lock().unwrap_or_else(|e| e.into_inner());
        serialize(&path, &name, &tracks, &conn)?
    };
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

// Relocate a playlist file (rename implied, like `mv`): rewrite it at the new
// location — which reworks relative track paths against the new directory — then
// remove the original. Track paths are resolved to absolute on read, so
// serializing at the destination re-relativizes them correctly.
#[tauri::command]
pub fn move_playlist(
    old_path: String,
    new_path: String,
    db: State<DbHandle>,
) -> Result<(), String> {
    let conn = db.conn.lock().unwrap_or_else(|e| e.into_inner());
    move_playlist_inner(&old_path, &new_path, &conn)
}

// Do two path strings name the same on-disk file? A lexical `!=` can't tell:
// `/a/b.m3u`, `/a/./b.m3u`, a symlink, and a case-variant on a case-insensitive
// filesystem all point at one inode. Canonicalize both (resolving `.`/`..`,
// symlinks, and stored casing) and compare. If either path can't be resolved —
// e.g. the destination doesn't exist yet, the common "real move" case — they are
// necessarily distinct files.
fn is_same_file(a: &str, b: &str) -> bool {
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(pa), Ok(pb)) => pa == pb,
        _ => false,
    }
}

fn move_playlist_inner(old_path: &str, new_path: &str, conn: &Connection) -> Result<(), String> {
    let bytes = std::fs::read(old_path).map_err(|e| e.to_string())?;
    let content = decode_bytes(&bytes);
    let base_dir = playlist_base_dir(old_path);
    let (name, entries) = parse(&content, &base_dir);
    let name = name
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| stem_name(new_path));
    let paths: Vec<String> = entries.into_iter().map(|e| e.path).collect();

    // Decide before writing: once we write the destination, an aliased source and
    // destination are indistinguishable from a genuine one, and removing the
    // source would delete the file we just wrote.
    let same = is_same_file(old_path, new_path);

    let out = serialize(new_path, &name, &paths, conn)?;
    std::fs::write(new_path, out).map_err(|e| e.to_string())?;
    // Best-effort remove of the original; skip it when source and destination are
    // the same file (writing already rewrote it in place).
    if !same {
        std::fs::remove_file(old_path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

// Rename a playlist in place: rewrite only the `#PLAYLIST:` directive, leaving
// the file where it is and its rows untouched. Round-trips through parse/serialize
// (like move_playlist) so dangling rows and unknown directives survive — a
// read→map→write in the frontend would drop them. The name never touches the
// filename, so the file path is stable.
#[tauri::command]
pub fn rename_playlist(path: String, name: String, db: State<DbHandle>) -> Result<(), String> {
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    let content = decode_bytes(&bytes);
    let base_dir = playlist_base_dir(&path);
    let (_old_name, entries) = parse(&content, &base_dir);
    let paths: Vec<String> = entries.into_iter().map(|e| e.path).collect();

    let out = {
        let conn = db.conn.lock().unwrap_or_else(|e| e.into_inner());
        serialize(&path, &name, &paths, &conn)?
    };
    std::fs::write(&path, out).map_err(|e| e.to_string())
}

// Delete a playlist file from disk (tree Delete). Guarded to actual playlist
// extensions so a mis-sent path can't remove an arbitrary file.
#[tauri::command]
pub fn delete_playlist(path: String) -> Result<(), String> {
    if !is_playlist_path(&path) {
        return Err("not a playlist file".to_string());
    }
    std::fs::remove_file(&path).map_err(|e| e.to_string())
}

// Index every `.m3u/.m3u8` under the library root for the Add-to-playlist menu
// and searchable playlists: path + display name (directive or filename stem).
//
// This walks the entire library tree (read_dir + metadata on every entry), which
// on a large library is 500ms–1s. It's `async` + `spawn_blocking` for one reason:
// a synchronous #[tauri::command] runs on the main (UI) thread that WKWebView
// paints on, so the walk would freeze the window for its whole duration. Moving
// the blocking FS work onto a worker thread keeps the UI responsive; the frontend
// also caches the result (see refreshPlaylistIndex) so the walk runs on library
// changes, not on every navigation back to the Files index.
#[tauri::command]
pub async fn list_all_playlists(root: String) -> Result<Vec<PlaylistRef>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut out: Vec<PlaylistRef> = Vec::new();
        let mut visited: HashSet<PathBuf> = HashSet::new();
        collect_playlists(Path::new(&root), &mut out, &mut visited);
        out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        out
    })
    .await
    .map_err(|e| e.to_string())
}

fn collect_playlists(dir: &Path, out: &mut Vec<PlaylistRef>, visited: &mut HashSet<PathBuf>) {
    // Guard against symlink cycles (e.g. loop -> ancestor): recurse into a
    // directory only once, keyed by its canonical (symlink-resolved) path.
    // Without this a `loop -> ..` symlink recurses until the stack overflows.
    let key = std::fs::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf());
    if !visited.insert(key) {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(meta) = std::fs::metadata(&path) else {
            continue;
        };
        if meta.is_dir() {
            collect_playlists(&path, out, visited);
        } else if meta.is_file() {
            let Some(s) = path.to_str() else { continue };
            if is_playlist_path(s) {
                out.push(PlaylistRef {
                    name: read_playlist_name(&path).unwrap_or_else(|| stem_name(s)),
                    path: s.to_string(),
                });
            }
        }
    }
}

// Display name for a playlist file: the `#PLAYLIST:` directive, else the
// filename stem. Used by the tree (list_dir) and the index.
pub fn display_name(path: &Path) -> String {
    read_playlist_name(path).unwrap_or_else(|| stem_name(&path.to_string_lossy()))
}

// A cached `#PLAYLIST:` lookup, keyed by file identity so an unchanged playlist is
// never re-read+decoded. Both `list_all_playlists` and the tree (`list_dir`) call
// read_playlist_name on every filesystem change — including the app's own autosave
// writes, which would otherwise re-scan every *other* playlist's bytes. `name` is
// the parsed directive (`None` = no directive), so a directive-less file is a cache
// hit too. (mtime, len) together survive coarse mtime resolution: any content edit
// that keeps the same byte length still lands on a fresh mtime, and any that keeps
// the same mtime still changes the length in practice.
struct NameCacheEntry {
    mtime: SystemTime,
    len: u64,
    name: Option<String>,
}

// Process-wide name cache. Same OnceLock<Mutex<..>> idiom as scan_coalesce; a
// poisoned lock is recovered rather than propagated (a panic mid-parse must not
// wedge every future tree walk). Entries for deleted playlists linger only until
// their next lookup fails (which prunes them); the set is one small entry per
// playlist file, so unbounded growth isn't a concern.
fn name_cache() -> &'static Mutex<HashMap<PathBuf, NameCacheEntry>> {
    static C: OnceLock<Mutex<HashMap<PathBuf, NameCacheEntry>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}

// The `#PLAYLIST:` directive for a file, or None. Serves an unchanged file from the
// name cache without touching its bytes; only a new (mtime, len) triggers a decode.
fn read_playlist_name(path: &Path) -> Option<String> {
    // Stat is the cache key. If it fails (file gone/unreadable), drop any stale
    // entry and report no directive.
    let Ok(meta) = std::fs::metadata(path) else {
        name_cache()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(path);
        return None;
    };
    let len = meta.len();
    // A platform without mtime can't be cached safely — just read through.
    let Some(mtime) = meta.modified().ok() else {
        return parse_playlist_name(path);
    };

    // Fast path: a matching entry, served under the lock without any I/O.
    {
        let cache = name_cache().lock().unwrap_or_else(|e| e.into_inner());
        if let Some(entry) = cache.get(path) {
            if entry.mtime == mtime && entry.len == len {
                return entry.name.clone();
            }
        }
    }

    // Miss: decode outside the lock, then record. A concurrent miss on the same
    // file just re-reads harmlessly and stores the same value.
    let name = parse_playlist_name(path);
    name_cache()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(
            path.to_path_buf(),
            NameCacheEntry {
                mtime,
                len,
                name: name.clone(),
            },
        );
    name
}

// The uncached core: decode the file and return its `#PLAYLIST:` directive if
// present (playlists are small, so reading the whole file is fine).
fn parse_playlist_name(path: &Path) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    let content = decode_bytes(&bytes);
    for line in content.lines() {
        let line = line.trim();
        if let Some(n) = line.strip_prefix("#PLAYLIST:") {
            let n = n.trim();
            if !n.is_empty() {
                return Some(n.to_string());
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decode_utf8_and_cp1252() {
        assert_eq!(decode_bytes("café".as_bytes()), "café");
        // 0xE9 is 'é' in Windows-1252; invalid as lone UTF-8, so we fall back.
        assert_eq!(decode_bytes(&[b'c', b'a', b'f', 0xE9]), "café");
        // 0x92 is a curly apostrophe in CP1252, not Latin-1's control char.
        assert_eq!(decode_bytes(&[0x92]), "\u{2019}");
    }

    #[test]
    fn parse_name_extinf_and_paths() {
        let base = Path::new("/music/lists");
        let content = "#EXTM3U\n#PLAYLIST:Road Trip\n#EXTINF:212,Artist - Song\n../a/track.mp3\n/abs/b.flac\n#UNKNOWN:x\n";
        let (name, entries) = parse(content, base);
        assert_eq!(name.as_deref(), Some("Road Trip"));
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].path, "/music/a/track.mp3");
        assert_eq!(entries[0].extinf_title.as_deref(), Some("Artist - Song"));
        assert_eq!(entries[1].path, "/abs/b.flac");
        assert_eq!(entries[1].extinf_title, None);
    }

    #[test]
    fn base_dir_falls_back_for_bare_and_empty_parents() {
        // A bare filename's parent is Some(""), not None — must still fall back
        // to "/" so relative rows resolve to absolute paths.
        assert_eq!(playlist_base_dir("list.m3u"), PathBuf::from("/"));
        // Normal paths keep their real directory.
        assert_eq!(
            playlist_base_dir("/music/lists/road.m3u"),
            PathBuf::from("/music/lists")
        );
    }

    #[test]
    fn parse_resolves_relative_rows_absolute_for_bare_playlist() {
        // Regression: opening a playlist by bare name must not leave rows relative.
        let base = playlist_base_dir("list.m3u");
        let (_name, entries) = parse("#EXTM3U\nsong.mp3\n", &base);
        assert_eq!(entries.len(), 1);
        assert!(
            Path::new(&entries[0].path).is_absolute(),
            "row resolved to non-absolute path: {}",
            entries[0].path
        );
        assert_eq!(entries[0].path, "/song.mp3");
    }

    #[test]
    fn relativize_under_and_outside() {
        let base = Path::new("/music/lists");
        assert_eq!(relativize(base, "/music/lists/a/x.mp3"), "a/x.mp3");
        assert_eq!(relativize(base, "/other/y.mp3"), "/other/y.mp3");
    }

    #[test]
    fn is_playlist_path_exts() {
        assert!(is_playlist_path("x.m3u"));
        assert!(is_playlist_path("x.M3U8"));
        assert!(!is_playlist_path("x.mp3"));
    }

    #[test]
    fn sanitize_line_collapses_breaks() {
        assert_eq!(sanitize_line("Road Trip"), "Road Trip");
        assert_eq!(sanitize_line("Road\nTrip"), "Road Trip");
        assert_eq!(sanitize_line("Road\r\nTrip"), "Road Trip");
        assert_eq!(sanitize_line("Road\n\nTrip"), "Road Trip");
        assert_eq!(sanitize_line("\nRoad Trip\n"), "Road Trip");
    }

    #[test]
    fn sanitized_name_does_not_inject_a_row() {
        // A name with an interior newline must not re-parse as a phantom track.
        let content = format!("#EXTM3U\n#PLAYLIST:{}\n", sanitize_line("Road\nTrip"));
        let (name, entries) = parse(&content, Path::new("/music/lists"));
        assert_eq!(name.as_deref(), Some("Road Trip"));
        assert!(entries.is_empty());
    }

    // An in-memory DB with just the columns fetch_meta reads. move_playlist_inner
    // doesn't need any rows — out-of-library paths serialize fine without meta.
    fn empty_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE tracks (path TEXT, title TEXT, artist TEXT, album TEXT, \
             album_artist TEXT, disc INTEGER, track INTEGER, duration REAL);",
        )
        .unwrap();
        conn
    }

    #[test]
    fn move_playlist_same_file_via_dot_component_preserves_it() {
        // Regression for the lexical same-file guard: `/dir/list.m3u` and
        // `/dir/./list.m3u` are the same inode, so a "move" must rewrite in place
        // and NOT delete the file afterward.
        let root = std::env::temp_dir().join(format!("pud_pl_same_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();

        let old = root.join("list.m3u");
        std::fs::write(&old, "#EXTM3U\n#PLAYLIST:Keep Me\n/abs/a.mp3\n").unwrap();

        let old_s = old.to_str().unwrap().to_string();
        let new_s = root
            .join(".")
            .join("list.m3u")
            .to_str()
            .unwrap()
            .to_string();
        assert_ne!(
            old_s, new_s,
            "paths must differ lexically to exercise the bug"
        );

        move_playlist_inner(&old_s, &new_s, &empty_db()).unwrap();

        assert!(old.exists(), "same-file move deleted the playlist");
        let content = std::fs::read_to_string(&old).unwrap();
        assert!(content.contains("#PLAYLIST:Keep Me"));
        assert!(content.contains("/abs/a.mp3"));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn move_playlist_to_new_path_relocates_and_removes_source() {
        // The ordinary case must still delete the source after writing the dest.
        let root = std::env::temp_dir().join(format!("pud_pl_move_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();

        let old = root.join("old.m3u");
        let new = root.join("new.m3u");
        std::fs::write(&old, "#EXTM3U\n#PLAYLIST:Mover\n/abs/a.mp3\n").unwrap();

        move_playlist_inner(old.to_str().unwrap(), new.to_str().unwrap(), &empty_db()).unwrap();

        assert!(!old.exists(), "source not removed after real move");
        assert!(new.exists(), "destination not written");
        assert!(std::fs::read_to_string(&new)
            .unwrap()
            .contains("#PLAYLIST:Mover"));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn collect_playlists_survives_symlink_cycle() {
        use std::os::unix::fs::symlink;

        // Unique temp root so parallel test runs don't collide.
        let root = std::env::temp_dir().join(format!("pud_pl_cycle_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let sub = root.join("sub");
        std::fs::create_dir_all(&sub).unwrap();

        // A real playlist we expect to find exactly once.
        std::fs::write(root.join("real.m3u"), "#EXTM3U\n#PLAYLIST:Real\n").unwrap();

        // loop -> root: recursing into it revisits an ancestor forever.
        symlink(&root, sub.join("loop")).unwrap();

        let mut out = Vec::new();
        let mut visited = HashSet::new();
        collect_playlists(&root, &mut out, &mut visited); // must terminate, not stack-overflow

        let _ = std::fs::remove_dir_all(&root);

        assert_eq!(out.len(), 1);
        assert_eq!(out[0].name, "Real");
    }

    // A unique temp dir per test so the process-wide name cache (keyed by path)
    // can't let one test observe another's entries.
    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pud_pl_{}_{}", tag, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn read_playlist_name_directive_and_stem_fallback() {
        let root = scratch("name");
        let named = root.join("road.m3u8");
        std::fs::write(&named, "#EXTM3U\n#PLAYLIST:Road Trip\n/abs/a.mp3\n").unwrap();
        assert_eq!(read_playlist_name(&named).as_deref(), Some("Road Trip"));

        // No directive → None from read_playlist_name, filename stem from display_name.
        let plain = root.join("mix.m3u");
        std::fs::write(&plain, "#EXTM3U\n/abs/a.mp3\n").unwrap();
        assert_eq!(read_playlist_name(&plain), None);
        assert_eq!(display_name(&plain), "mix");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn read_playlist_name_serves_cache_without_reread() {
        // Prove a cache hit does not touch the file: after the first read populates
        // the cache, poison the entry (same mtime+len key) and confirm the poisoned
        // value — not the on-disk one — comes back.
        let root = scratch("cachehit");
        let p = root.join("list.m3u8");
        std::fs::write(&p, "#EXTM3U\n#PLAYLIST:On Disk\n").unwrap();
        assert_eq!(read_playlist_name(&p).as_deref(), Some("On Disk"));

        {
            let mut cache = name_cache().lock().unwrap();
            cache
                .get_mut(&p)
                .expect("entry cached after first read")
                .name = Some("From Cache".to_string());
        }
        assert_eq!(read_playlist_name(&p).as_deref(), Some("From Cache"));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn read_playlist_name_invalidates_on_change() {
        // A content edit that changes the byte length must invalidate the cache even
        // if the filesystem's mtime resolution is too coarse to notice the rewrite.
        let root = scratch("invalidate");
        let p = root.join("list.m3u8");
        std::fs::write(&p, "#EXTM3U\n#PLAYLIST:Before\n").unwrap();
        assert_eq!(read_playlist_name(&p).as_deref(), Some("Before"));

        std::fs::write(&p, "#EXTM3U\n#PLAYLIST:After The Rename\n").unwrap();
        assert_eq!(read_playlist_name(&p).as_deref(), Some("After The Rename"));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn read_playlist_name_prunes_deleted_file() {
        // A deleted playlist reports no name and leaves nothing stale in the cache.
        let root = scratch("prune");
        let p = root.join("gone.m3u8");
        std::fs::write(&p, "#EXTM3U\n#PLAYLIST:Ephemeral\n").unwrap();
        assert_eq!(read_playlist_name(&p).as_deref(), Some("Ephemeral"));

        std::fs::remove_file(&p).unwrap();
        assert_eq!(read_playlist_name(&p), None);
        assert!(!name_cache().lock().unwrap().contains_key(&p));

        let _ = std::fs::remove_dir_all(&root);
    }
}
