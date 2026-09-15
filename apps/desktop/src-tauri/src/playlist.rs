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
// - Paths: a row Pudding writes itself goes relative to the playlist file when
//   both ends sit inside one *container* — the volume, sync root, or home folder
//   you could copy as a unit (see `Bounds`) — and absolute otherwise; every row
//   resolves to absolute on open. Relative is what makes a playlist portable.
// - Rewrites are non-destructive: comments and unknown `#EXT*` directives are
//   carried over from the file being overwritten (see `Preserved`), a row's
//   `#EXTINF` survives even when the library has never seen the file, and a row
//   the file already had keeps the exact spelling its author gave it. Pudding
//   chooses a path's form only for the rows it is actually authoring.

use std::collections::{HashMap, HashSet};
use std::ffi::{CStr, OsStr};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::MetadataExt;
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::SystemTime;

use rusqlite::Connection;
use serde::Serialize;
use tauri::State;

use crate::{fetch_meta, DbHandle};

pub const PLAYLIST_EXTS: &[&str] = &["m3u", "m3u8"];

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

// A playlist row naming a stream rather than a file. Any scheme counts, which is
// the same test the stream-list reader uses (`parse_m3u_stream_list` in lib.rs) —
// the two readers must never disagree about which rows are stations, since a
// station list and a playlist are the same file format.
pub(crate) fn is_url_row(s: &str) -> bool {
    s.contains("://")
}

// What still counts as a playlist file. Neither ceiling is a format rule — the
// parser stays lenient by design — they only bound the damage a file that is not
// a playlist at all can do: `read_playlist` is a synchronous command, so it runs
// on the UI thread, and a mis-renamed binary would otherwise decode byte-for-byte
// into hundreds of thousands of "rows", each paying a stat, with the window
// frozen for all of it. A 50,000-row playlist is already far past any real one
// (an iTunes library export runs to a few thousand).
const MAX_PLAYLIST_BYTES: u64 = 16 * 1024 * 1024;
const MAX_PLAYLIST_ROWS: usize = 50_000;

// One resolved playlist row handed to the frontend. `path` is always absolute —
// except a stream row, which is its URL; `name` is the basename (a station's host)
// shown for out-of-library rows. Metadata is the DB's
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
    year: Option<u32>,
    genre: Option<String>,
    #[serde(rename = "inLibrary")]
    in_library: bool,
    missing: bool,
    // A row naming a stream (an `http(s)://` station) rather than a local file.
    // It is a real row of the file and round-trips like any other, but it is not
    // something the engine's track queue can hold — see `playlistPlayableTracks`
    // in the frontend, which keeps it out of the pool the way `missing` does.
    // Never stat'd, so it is never wrongly called missing.
    stream: bool,
    // A cloud file the provider hasn't put on this Mac yet. Distinct from
    // `missing` in the one way that matters: the file exists and playing it will
    // fetch it (see audio.rs), so the row stays playable — it just says so first,
    // because that click costs a download the user should see coming.
    #[serde(rename = "notDownloaded")]
    not_downloaded: bool,
    // Track length in seconds (None when unknown / out of library). Summed for
    // the playlist's runtime beside its track count.
    duration: Option<f64>,
    // The remaining column fields. All None for an out-of-library track: they come
    // from the scan cache, and a path outside every library root was never scanned.
    // That is a real distinction the row shows rather than hides — see `in_library`.
    bitrate: Option<u32>,
    #[serde(rename = "sampleRate")]
    sample_rate: Option<u32>,
    #[serde(rename = "bitDepth")]
    bit_depth: Option<u32>,
    gain: Option<f64>,
    created: Option<i64>,
    modified: Option<i64>,
}

#[derive(Serialize)]
pub struct PlaylistData {
    // Display name: the `#PLAYLIST:` directive, else the filename stem.
    name: String,
    path: String,
    tracks: Vec<PlaylistTrack>,
    // The file's mtime as of this read. The frontend keeps it and re-stats the
    // file on library scans and window focus: a value that moved without one of
    // our own writes means another app (or a text editor) rewrote the playlist,
    // and the open view is stale. None when the file vanished mid-read.
    mtime: Option<i64>,
}

// A library playlist for the index (Add to playlist ▸ / searchable playlists).
#[derive(Serialize)]
pub struct PlaylistRef {
    path: String,
    name: String,
}

// One parsed entry before DB resolution: an absolute path plus the optional
// `#EXTINF` title that preceded it.
#[derive(Debug)]
struct ParsedEntry {
    path: String,
    extinf_title: Option<String>,
    // The `#EXTINF` runtime in seconds, or None when absent or unknown (`-1`).
    // Kept because for an out-of-library row it is the only duration there is —
    // both for the runtime the pane shows and for the rewrite that has to put the
    // line back. The DB's value wins whenever the path is in the library.
    extinf_secs: Option<f64>,
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
//
// A row naming a stream is left exactly as it was written. It is not a path, and
// treating it as one is worse than useless: `http://host/s.mp3` is *relative* as
// far as `Path` is concerned, so it used to be joined onto the playlist's own
// folder — which turned every internet-radio `.m3u` into one dangling row.
fn resolve_path(base_dir: &Path, raw: &str) -> String {
    if is_url_row(raw) {
        return raw.to_string();
    }
    let p = Path::new(raw);
    let joined = if p.is_absolute() {
        p.to_path_buf()
    } else {
        base_dir.join(p)
    };
    normalize(&joined).to_string_lossy().into_owned()
}

// One classified line of an extended-M3U file. Blanks and directives are kept as
// variants rather than skipped because the rewrite path has to put the directives
// back; only `parse` discards them.
enum Line<'a> {
    Blank,
    Directive(&'a str),
    Track(&'a str),
}

// Split playlist text into classified lines. This is the single definition of
// "which lines carry paths" — both the reader and the rewrite's directive
// preserver consume it, so the two can never disagree about where a track's
// attached directives end.
fn scan(content: &str) -> Vec<Line<'_>> {
    content
        .lines()
        .map(str::trim)
        .map(|l| {
            if l.is_empty() {
                Line::Blank
            } else if l.starts_with('#') {
                Line::Directive(l)
            } else {
                Line::Track(l)
            }
        })
        .collect()
}

// The seconds field of an `#EXTINF:` value — the number before the comma.
// Tolerates the IPTV-style `#EXTINF:123 tvg-id="x",Title` by reading only the
// numeric prefix. `-1` is the format's "unknown", so it comes back None like
// anything unparseable.
fn parse_extinf_secs(head: &str) -> Option<f64> {
    let num: String = head
        .trim()
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == '-' || *c == '.')
        .collect();
    num.parse::<f64>().ok().filter(|s| *s >= 0.0)
}

// Parse extended-M3U text into the display name and resolved entries.
// `#PLAYLIST:` sets the name and `#EXTINF:<secs>,<title>` supplies the fallback
// runtime and title for the next path line. Blank lines and other `#` directives
// are ignored *here* — they have no bearing on what the pane shows — but they are
// not lost: `Preserved` captures them for the rewrite.
fn parse(content: &str, base_dir: &Path) -> (Option<String>, Vec<ParsedEntry>) {
    let mut name: Option<String> = None;
    let mut entries: Vec<ParsedEntry> = Vec::new();
    let mut pending_title: Option<String> = None;
    let mut pending_secs: Option<f64> = None;

    for line in scan(content) {
        match line {
            Line::Blank => {}
            Line::Directive(d) => {
                let rest = &d[1..];
                if let Some(n) = rest.strip_prefix("PLAYLIST:") {
                    name = Some(n.trim().to_string());
                } else if let Some(inf) = rest.strip_prefix("EXTINF:") {
                    // `<secs>,<title>` — both halves are kept now: the title names
                    // an out-of-library row and the seconds are its only runtime.
                    if let Some((head, title)) = inf.split_once(',') {
                        pending_secs = parse_extinf_secs(head);
                        pending_title =
                            Some(title.trim().to_string()).filter(|t| !t.is_empty());
                    }
                }
            }
            Line::Track(t) => entries.push(ParsedEntry {
                path: resolve_path(base_dir, t),
                extinf_title: pending_title.take(),
                extinf_secs: pending_secs.take(),
            }),
        }
    }
    (name, entries)
}

// --- Preservation -----------------------------------------------------------

// The parts of an existing playlist file that have no place in Pudding's data
// model — plain comments and non-`#EXTINF` extension directives — captured so a
// rewrite can put them back. Curation autosaves on every edit, so without this a
// single drag would silently strip whatever the file's original author wrote.
//
// `#EXTM3U`, `#PLAYLIST:` and `#EXTINF:` are deliberately *not* captured: all
// three are regenerated from live state on every write, so carrying them over
// would duplicate them.
#[derive(Default)]
struct Preserved {
    // Plain `#` comments standing before the first track — a file banner
    // ("# Created by ..."), which belongs to the file rather than to any one row.
    header: Vec<String>,
    // Directives that introduce a track, keyed by the resolved path they precede:
    // `#EXTGRP`, `#EXTVLCOPT`, `#EXTALB` and friends. They travel with their row,
    // so a reorder moves them rather than stranding them. First occurrence wins
    // when one path appears twice — the two rows are indistinguishable by the only
    // key we have.
    attached: HashMap<String, Vec<String>>,
    // Anything trailing the last track line.
    trailer: Vec<String>,
    // The exact text each row was written with, keyed by the resolved path —
    // `attached`'s key, so the two can never disagree about which row is which.
    // A spelling is content its author chose: `./a.mp3`, a route that runs
    // through a symlink, an accented filename in NFC where the DB holds NFD.
    // Re-deriving one from the resolved path quietly rewrites all three, so a
    // rewrite plays back the original bytes instead. First occurrence wins for a
    // repeated path, as with `attached`.
    raw: HashMap<String, String>,
    // The directory those spellings are relative to. A write aimed anywhere else
    // — the destination half of a move — must not reuse them: the same
    // `../Artist/x.mp3` names a different file read from a different folder.
    base_dir: PathBuf,
    style: HouseStyle,
}

// The prevailing path form of the rows a file already has, which is what a row
// added to it should look like.
#[derive(Default, Clone, Copy, PartialEq)]
enum HouseStyle {
    // Every row absolute. Such a file has already given up portability, and a
    // lone relative row among twenty absolute ones just makes it a patchwork.
    AllAbsolute,
    // Anything else — all-relative, mixed, or no rows to judge by. `relativize`
    // decides, which for an all-relative file reproduces its style anyway.
    #[default]
    Open,
}

impl Preserved {
    // Capture from playlist text. `#EXT*` directives attach to the track they
    // precede; plain comments do too, except before the first track, where they
    // read as a banner for the file and stay at the top.
    fn from_content(content: &str, base_dir: &Path) -> Self {
        let mut out = Preserved {
            base_dir: base_dir.to_path_buf(),
            ..Preserved::default()
        };
        let mut run: Vec<String> = Vec::new();
        let mut seen_track = false;
        let mut all_absolute = true;

        for line in scan(content) {
            match line {
                Line::Blank => {}
                Line::Directive(d) => {
                    let rest = &d[1..];
                    if rest.starts_with("EXTM3U")
                        || rest.starts_with("PLAYLIST:")
                        || rest.starts_with("EXTINF:")
                    {
                        continue;
                    }
                    if !seen_track && !rest.starts_with("EXT") {
                        out.header.push(d.to_string());
                    } else {
                        run.push(d.to_string());
                    }
                }
                Line::Track(t) => {
                    seen_track = true;
                    // A stream row is neither absolute nor relative, so it gets no
                    // vote on how *file* rows should be spelled — without this, one
                    // station among twenty absolute paths would flip the whole file
                    // to `Open` and start relativizing rows it shouldn't.
                    if !is_url_row(t) {
                        all_absolute &= Path::new(t).is_absolute();
                    }
                    let resolved = resolve_path(base_dir, t);
                    let block = std::mem::take(&mut run);
                    if !block.is_empty() {
                        out.attached.entry(resolved.clone()).or_insert(block);
                    }
                    out.raw.entry(resolved).or_insert_with(|| t.to_string());
                }
            }
        }
        out.trailer = run;
        out.style = if seen_track && all_absolute {
            HouseStyle::AllAbsolute
        } else {
            HouseStyle::Open
        };
        out
    }

    // The spelling a row already had, when it still means the same file from the
    // directory being written. None for a row the file didn't have — and for a
    // *relative* spelling captured against some other directory, which is what
    // keeps a move from carrying `../Artist/x.mp3` to a folder where it points
    // somewhere else entirely. An absolute spelling is immune to the move and
    // travels as it is.
    fn row_spelling(&self, resolved: &str, base_dir: &Path) -> Option<&str> {
        let raw = self.raw.get(resolved)?;
        (Path::new(raw).is_absolute() || self.base_dir == base_dir).then_some(raw.as_str())
    }

    // Capture from the file a write is about to overwrite. A missing or unreadable
    // file — a brand-new playlist, the common case — preserves nothing. Nor does
    // one past the ceiling `read_rows` enforces: nothing that large opened as a
    // playlist, so there is nothing of a playlist author's in it to keep, and
    // building a row map over a few million junk lines is the cost this avoids.
    fn from_file(path: &str) -> Self {
        match std::fs::metadata(path) {
            Ok(meta) if meta.len() <= MAX_PLAYLIST_BYTES => {}
            _ => return Preserved::default(),
        }
        match std::fs::read(path) {
            Ok(bytes) => Self::from_content(&decode_bytes(&bytes), &playlist_base_dir(path)),
            Err(_) => Preserved::default(),
        }
    }
}

// mtime in milliseconds since the epoch: the token the frontend compares to notice
// that a playlist changed underneath an open view. Milliseconds because that is
// what a JS number holds exactly. None when the file is gone.
fn file_mtime_ms(path: &str) -> Option<i64> {
    mtime_ms(&std::fs::metadata(path).ok()?)
}

// The same value from a stat the caller already has, so a read that must look at
// the file's size anyway doesn't stat it twice.
fn mtime_ms(meta: &std::fs::Metadata) -> Option<i64> {
    meta.modified()
        .ok()?
        .duration_since(SystemTime::UNIX_EPOCH)
        .ok()
        .map(|d| d.as_millis() as i64)
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

// The file half of a read: stat, decode, parse — and the two ceilings that decide
// whether this is a playlist at all. Split from the command so both can be tested
// without a database, and so the ceilings sit next to the work they bound.
//
// Stats *before* reading, never after: a write landing between the two would then
// pair new content with an older mtime, which only costs a redundant reload later.
// The other order pairs old content with a newer mtime and the staleness is never
// noticed at all.
fn read_rows(path: &str) -> Result<(Option<String>, Vec<ParsedEntry>, Option<i64>), String> {
    let meta = std::fs::metadata(path).map_err(|e| e.to_string())?;
    let mtime = mtime_ms(&meta);
    // Size first, before a byte is read: past this the file is not a playlist that
    // lost a row somewhere, it is something else wearing the extension.
    if meta.len() > MAX_PLAYLIST_BYTES {
        return Err(format!(
            "not a playlist: {path} is {} MB",
            meta.len() / (1024 * 1024)
        ));
    }
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    let content = decode_bytes(&bytes);
    let (name, entries) = parse(&content, &playlist_base_dir(path));
    // The other half of the same guard: a file can sit under the byte ceiling and
    // still parse to more rows than any playlist has, each a stat below.
    if entries.len() > MAX_PLAYLIST_ROWS {
        return Err(format!("not a playlist: {path} has {} rows", entries.len()));
    }
    Ok((name, entries, mtime))
}

// Open a playlist file: decode, parse, and resolve each row's metadata against
// the library DB (falling back to `#EXTINF`/filename for out-of-library rows).
#[tauri::command]
pub fn read_playlist(path: String, db: State<DbHandle>) -> Result<PlaylistData, String> {
    let (name, entries, mtime) = read_rows(&path)?;

    let paths: Vec<String> = entries.iter().map(|e| e.path.clone()).collect();
    let meta_map = {
        let conn = db.conn.lock().unwrap_or_else(|e| e.into_inner());
        fetch_meta(&conn, &paths)?
    };

    let tracks = entries
        .into_iter()
        .map(|e| {
            let stream = is_url_row(&e.path);
            // The name a row falls back to when nothing else names it: a file's
            // basename, a station's host — which is what the streams pane shows for
            // a station whose `#EXTINF` gave no title.
            let basename = if stream {
                crate::m3u_fallback_name(&e.path).to_string()
            } else {
                Path::new(&e.path)
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or(&e.path)
                    .to_string()
            };
            // One stat for both facts (`exists()` was already paying for it):
            // absent, or present-but-not-downloaded. A stream has no file to stat,
            // and reporting it missing on a failed stat is precisely the lie this
            // skips — nothing is wrong with the row, it just isn't a file.
            let meta = (!stream).then(|| std::fs::metadata(&e.path));
            let missing = matches!(meta, Some(Err(_)));
            let not_downloaded = meta
                .and_then(Result::ok)
                .map(|m| crate::dataless::is_dataless(&m))
                .unwrap_or(false);
            match meta_map.get(&e.path).cloned() {
                Some(m) => PlaylistTrack {
                    path: e.path,
                    name: basename,
                    title: m.title,
                    artist: m.artist,
                    album: m.album,
                    album_artist: m.album_artist,
                    disc: m.disc,
                    track: m.track,
                    year: m.year,
                    genre: m.genre,
                    in_library: true,
                    missing,
                    not_downloaded,
                    stream,
                    duration: m.duration,
                    bitrate: m.bitrate,
                    sample_rate: m.sample_rate,
                    bit_depth: m.bit_depth,
                    gain: m.gain,
                    created: m.created,
                    modified: m.modified,
                },
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
                    year: None,
                    genre: None,
                    in_library: false,
                    missing,
                    not_downloaded,
                    stream,
                    // The playlist's own claim about a file we were never allowed
                    // to inspect. Unverified, but it is the only runtime this row
                    // will ever have — and showing it beats an empty cell and a
                    // total that silently undercounts.
                    duration: e.extinf_secs,
                    bitrate: None,
                    sample_rate: None,
                    bit_depth: None,
                    gain: None,
                    created: None,
                    modified: None,
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
        mtime,
    })
}

// One row a write is asked to lay down: the absolute path, plus the `#EXTINF`
// facts the caller is holding for it. Title and duration matter only for rows the
// library DB doesn't know — the DB's live tags win for everything else — but they
// are what lets an out-of-library row keep its name and runtime when it is copied
// into a *different* playlist, where re-reading the destination file could not
// possibly find it.
#[derive(serde::Deserialize)]
pub struct TrackRef {
    path: String,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    duration: Option<f64>,
}

// Serialize a playlist to extended-M3U text (UTF-8). A row the file already had
// is written back with the exact path it already had; a row being added is
// spelled relative to the playlist's directory when it can be reached without
// leaving the playlist's container, and absolute when it can't — unless the file
// spells every other row absolute, in which case it says so and we listen.
// `#EXTINF` carries the DB display and runtime when the library knows
// the path and the caller's carried-over values when it doesn't, so a rewrite
// never strips a row's only metadata. `preserved` puts back the comments and
// extension directives the data model has no room for.
fn serialize(
    path: &str,
    name: &str,
    rows: &[TrackRef],
    preserved: &Preserved,
    conn: &Connection,
) -> Result<String, String> {
    let base_dir = playlist_base_dir(path);
    let bounds = Bounds::of(&base_dir);
    let paths: Vec<String> = rows.iter().map(|r| r.path.clone()).collect();
    let meta_map = fetch_meta(conn, &paths)?;

    let mut out = String::from("#EXTM3U\n");
    out.push_str(&format!("#PLAYLIST:{}\n", sanitize_line(name)));
    for line in &preserved.header {
        out.push_str(line);
        out.push('\n');
    }
    for r in rows {
        for line in preserved.attached.get(&r.path).into_iter().flatten() {
            out.push_str(line);
            out.push('\n');
        }
        // The DB wins for a known path — its tags are live and may have been
        // edited since the file was last written. The caller's values are the
        // fallback that keeps an out-of-library row from going anonymous.
        let (display, secs) = match meta_map.get(&r.path) {
            Some(m) => (
                match (&m.artist, &m.title) {
                    (Some(a), Some(ti)) => format!("{} - {}", a, ti),
                    (_, Some(ti)) => ti.clone(),
                    _ => String::new(),
                },
                m.duration,
            ),
            None => (r.title.clone().unwrap_or_default(), r.duration),
        };
        let display = sanitize_line(&display);
        // A bare duration with no title is still worth a line: it is what the file
        // said, and dropping it would make the rewrite lossy for no gain.
        if !display.is_empty() || secs.is_some() {
            let secs = secs.map(|d| d.round() as i64).unwrap_or(-1);
            out.push_str(&format!("#EXTINF:{},{}\n", secs, display));
        }
        // A stream row is written back exactly as it came in. `relativize` would
        // decline it anyway (a URL shares no directory with the playlist), but only
        // by accident — and a row this file's author wrote as a URL must not depend
        // on that.
        if is_url_row(&r.path) {
            out.push_str(&r.path);
            out.push('\n');
            continue;
        }
        // A row the file already had keeps its author's spelling; only a row we
        // are adding gets one chosen for it.
        match preserved.row_spelling(&r.path, &base_dir) {
            Some(raw) => out.push_str(raw),
            None if preserved.style == HouseStyle::AllAbsolute => out.push_str(&r.path),
            None => out.push_str(&relativize(&base_dir, &r.path, &bounds)),
        }
        out.push('\n');
    }
    for line in &preserved.trailer {
        out.push_str(line);
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

// The container a playlist sits in: the deepest enclosing thing you could hand
// to someone else — copy, sync, unplug and carry — with both the playlist and
// its music inside it. It is the ceiling a relative row may climb to and no
// further, because it is the only unit that travels intact.
//
// Deepest match wins, and every one of these is a real boundary on macOS:
//   /Volumes/<name>            a mounted volume, external or network
//   ~/Library/CloudStorage/<x> one provider's synced tree (iCloud, Proton, ...)
//   ~/Library/Mobile Documents/<x>  an iCloud app container
//   ~                          the home folder
//   /                          nothing else matched; the whole filesystem
fn container_root(dir: &Path, home: Option<&Path>) -> PathBuf {
    let comps: Vec<Component> = dir.components().collect();
    if comps.is_empty() {
        return PathBuf::from("/");
    }
    // Depth in components, counting the root. The filesystem root is the
    // container of last resort: it always holds both ends, which is exactly why
    // a row that needs it is no longer portable in any useful sense.
    let mut depth = 1usize;
    if comps.len() >= 3 && comps[1].as_os_str() == "Volumes" {
        depth = depth.max(3);
    }
    if let Some(home) = home {
        let hc: Vec<Component> = home.components().collect();
        if !hc.is_empty() && comps.len() >= hc.len() && comps[..hc.len()] == hc[..] {
            depth = depth.max(hc.len());
            // A sync root's *children* are the containers, not the directory that
            // collects them: `~/Library/CloudStorage` holds one folder per
            // provider, and no two of them sync together.
            let rest = &comps[hc.len()..];
            let under_sync_dir = rest.len() >= 3
                && rest[0].as_os_str() == "Library"
                && matches!(
                    rest[1].as_os_str().to_str(),
                    Some("CloudStorage") | Some("Mobile Documents")
                );
            if under_sync_dir {
                depth = depth.max(hc.len() + 3);
            }
        }
    }
    comps[..depth.min(comps.len())].iter().collect()
}

// What bounds a relative row, worked out once per write because every row in a
// file shares it: the container the playlist sits in, and the device that
// container is on.
struct Bounds {
    container: PathBuf,
    dev: Option<u64>,
}

// The user's real home directory, looked up once per process.
//
// Deliberately *not* `$HOME`: the Mac App Store build runs sandboxed, where the
// kernel redirects `$HOME` into `~/Library/Containers/<bundle id>/Data`. Trust
// that and no real path looks like it is under the home folder any more — every
// container boundary below it goes undetected, and the sandboxed build quietly
// gets the unbounded behaviour this rule exists to prevent. The password
// database is not redirected, so it answers the same in both builds.
fn real_home() -> Option<PathBuf> {
    static HOME: OnceLock<Option<PathBuf>> = OnceLock::new();
    HOME.get_or_init(|| {
        // `getpwuid_r`, not `getpwuid`: the result lands in a buffer we own
        // rather than shared static storage another thread's lookup could
        // overwrite underneath us. 2 KiB is far past any real `pw_dir`; a short
        // buffer reports ERANGE, which falls through to `$HOME` like any other
        // failure — wrong only in the sandbox, which is where it never happens.
        let mut buf = vec![0u8; 2048];
        let mut pwd: libc::passwd = unsafe { std::mem::zeroed() };
        let mut found: *mut libc::passwd = std::ptr::null_mut();
        let rc = unsafe {
            libc::getpwuid_r(
                libc::getuid(),
                &mut pwd,
                buf.as_mut_ptr() as *mut libc::c_char,
                buf.len(),
                &mut found,
            )
        };
        let from_passwd = if rc == 0 && !found.is_null() {
            let dir = unsafe { (*found).pw_dir };
            (!dir.is_null())
                .then(|| unsafe { CStr::from_ptr(dir) }.to_bytes())
                .filter(|b| !b.is_empty())
                .map(|b| PathBuf::from(OsStr::from_bytes(b)))
        } else {
            None
        };
        from_passwd.or_else(|| std::env::var_os("HOME").map(PathBuf::from))
    })
    .clone()
}

impl Bounds {
    fn of(base_dir: &Path) -> Self {
        Self::with_home(base_dir, real_home().as_deref())
    }

    // Split out from `of` so the rules can be tested against a fabricated home
    // rather than whoever happens to be running the suite.
    fn with_home(base_dir: &Path, home: Option<&Path>) -> Self {
        Bounds {
            container: container_root(base_dir, home),
            dev: std::fs::metadata(base_dir).ok().map(|m| m.dev()),
        }
    }

    // Do the playlist and the track live on the same filesystem? A mount point
    // inside a container holds data the container itself doesn't carry, so a
    // relative row that crosses one survives the copy pointing at nothing.
    fn same_device(&self, track: &Path) -> bool {
        match (self.dev, std::fs::metadata(track).ok().map(|m| m.dev())) {
            (Some(a), Some(b)) => a == b,
            // A row naming a file that isn't there yet is judged on its path
            // alone. Refusing to relativize on a failed stat would make a
            // playlist's spelling depend on whether the drive is plugged in.
            _ => true,
        }
    }
}

// A track path written relative to the playlist's directory — what actually makes
// a playlist portable: move or copy the whole tree and every row still resolves.
// Walks up with `..` when the track sits *beside* the playlist rather than under
// it, which is the ordinary `Music/Playlists/x.m3u8` → `Music/Artist/...` layout a
// plain prefix-strip had to give up on and write absolute.
//
// Falls back to the absolute path when a relative one would have to leave the
// playlist's container to reach the track — an external volume, or (the case
// that named this rule) a playlist inside a sync root pointing at music outside
// it. Such a row resolves correctly on *this* machine and nowhere else: the
// thing that gets copied or synced doesn't contain both ends, so `../../../..`
// lands wherever that other machine happens to keep its home folder.
fn relativize(base_dir: &Path, track: &str, bounds: &Bounds) -> String {
    let target = Path::new(track);
    let base: Vec<Component> = base_dir.components().collect();
    let tgt: Vec<Component> = target.components().collect();
    let shared = base
        .iter()
        .zip(tgt.iter())
        .take_while(|(a, b)| a == b)
        .count();
    // `shared` counts the root component itself, so 2 is the smallest count that
    // means "a real directory in common".
    if shared < 2 {
        return track.to_string();
    }
    // The shared directory is precisely what a relative row climbs to before it
    // descends again, so a shared directory above the container means the row
    // reaches outside the unit that travels. (The container is a prefix of
    // `base_dir`, so comparing depths compares prefixes.)
    if shared < bounds.container.components().count() {
        return track.to_string();
    }
    if !bounds.same_device(target) {
        return track.to_string();
    }
    let mut rel = PathBuf::new();
    for _ in shared..base.len() {
        rel.push("..");
    }
    for comp in &tgt[shared..] {
        rel.push(comp.as_os_str());
    }
    // A non-UTF-8 or empty result (the track *is* the directory) is not a path we
    // can write as a row; the absolute form always is.
    rel.to_str()
        .filter(|s| !s.is_empty())
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
    tracks: Vec<TrackRef>,
    db: State<DbHandle>,
) -> Result<Option<i64>, String> {
    // Read what we are about to overwrite, so its comments and extension
    // directives survive the rewrite. Cheap next to the write itself, and it is
    // the only place the originals still exist.
    let preserved = Preserved::from_file(&path);
    let content = {
        let conn = db.conn.lock().unwrap_or_else(|e| e.into_inner());
        serialize(&path, &name, &tracks, &preserved, &conn)?
    };
    std::fs::write(&path, content).map_err(|e| e.to_string())?;
    // Hand back the mtime this write produced so the caller can record it as its
    // own. Otherwise the watcher sees our own file land, calls it an outside
    // change, and reloads the view out from under the edit that caused it.
    Ok(file_mtime_ms(&path))
}

// The playlist file's mtime, or None if it no longer exists. Deliberately cheap —
// one stat, no decode, no parse, no DB — because it runs for every open playlist
// on every library scan and every window focus, and re-reading a few thousand rows
// just to discover that nothing changed would not be.
#[tauri::command]
pub fn playlist_mtime(path: String) -> Option<i64> {
    file_mtime_ms(&path)
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

// Parsed rows as write rows. The round-trip commands (move, rename) rewrite a
// file they just read, so they carry its own `#EXTINF` values straight back —
// which is what keeps an out-of-library row's title and runtime alive through a
// move, where the destination file has nothing to preserve from.
fn entries_as_rows(entries: Vec<ParsedEntry>) -> Vec<TrackRef> {
    entries
        .into_iter()
        .map(|e| TrackRef {
            path: e.path,
            title: e.extinf_title,
            duration: e.extinf_secs,
        })
        .collect()
}

fn move_playlist_inner(old_path: &str, new_path: &str, conn: &Connection) -> Result<(), String> {
    let bytes = std::fs::read(old_path).map_err(|e| e.to_string())?;
    let content = decode_bytes(&bytes);
    let base_dir = playlist_base_dir(old_path);
    let (name, entries) = parse(&content, &base_dir);
    let name = name
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| stem_name(new_path));
    // Preserve from the content already in hand, and against the *old* directory:
    // attached directives are keyed by resolved absolute path, which is the same
    // key the rows carry, so the destination's own re-relativizing can't disturb
    // the match.
    let preserved = Preserved::from_content(&content, &base_dir);
    let rows = entries_as_rows(entries);

    // Decide before writing: once we write the destination, an aliased source and
    // destination are indistinguishable from a genuine one, and removing the
    // source would delete the file we just wrote.
    let same = is_same_file(old_path, new_path);

    let out = serialize(new_path, &name, &rows, &preserved, conn)?;
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
    let preserved = Preserved::from_content(&content, &base_dir);
    let rows = entries_as_rows(entries);

    let out = {
        let conn = db.conn.lock().unwrap_or_else(|e| e.into_inner());
        serialize(&path, &name, &rows, &preserved, &conn)?
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
    // Same ceiling as `read_playlist`, for the same reason: this runs for every
    // playlist the tree lists, and a mis-renamed 2 GB file must not be decoded in
    // full to discover it has no `#PLAYLIST:` line. Such a file keeps its filename
    // stem in the tree, which is what a directive-less playlist shows anyway.
    if std::fs::metadata(path).ok()?.len() > MAX_PLAYLIST_BYTES {
        return None;
    }
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
        assert_eq!(entries[0].extinf_secs, Some(212.0));
        assert_eq!(entries[1].path, "/abs/b.flac");
        assert_eq!(entries[1].extinf_title, None);
        assert_eq!(entries[1].extinf_secs, None);
    }

    #[test]
    fn parse_extinf_secs_forms() {
        assert_eq!(parse_extinf_secs("212"), Some(212.0));
        assert_eq!(parse_extinf_secs(" 212 "), Some(212.0));
        assert_eq!(parse_extinf_secs("212.5"), Some(212.5));
        // The format's "unknown" and outright junk both mean: no runtime.
        assert_eq!(parse_extinf_secs("-1"), None);
        assert_eq!(parse_extinf_secs(""), None);
        assert_eq!(parse_extinf_secs("abc"), None);
        // IPTV-style trailing attributes: read the numeric prefix, ignore the rest.
        assert_eq!(parse_extinf_secs("212 tvg-id=\"x\""), Some(212.0));
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

    // The home every path test is written against, so the rules are exercised
    // against a fixed layout rather than whoever is running the suite.
    const HOME: &str = "/Users/me";

    fn bounds(base: &str) -> Bounds {
        Bounds::with_home(Path::new(base), Some(Path::new(HOME)))
    }

    // `relativize` against that home, so a test reads as one line.
    fn rel(base: &str, track: &str) -> String {
        relativize(Path::new(base), track, &bounds(base))
    }

    #[test]
    fn relativize_under_and_outside() {
        assert_eq!(rel("/music/lists", "/music/lists/a/x.mp3"), "a/x.mp3");
        // Shares only the root: nothing you could copy as a unit holds both ends.
        assert_eq!(rel("/music/lists", "/other/y.mp3"), "/other/y.mp3");
    }

    #[test]
    fn relativize_walks_up_to_a_sibling_tree() {
        // The ordinary layout — playlists in their own folder beside the music —
        // which the old prefix-strip had to write absolute, killing portability.
        assert_eq!(rel("/music/Playlists", "/music/Artist/x.mp3"), "../Artist/x.mp3");
        assert_eq!(
            rel("/Users/me/Music/lists", "/Users/me/Downloads/y.flac"),
            "../../Downloads/y.flac"
        );
        // A separate volume still goes absolute: one shared component is the root.
        assert_eq!(rel("/Users/me/Music", "/Volumes/Ext/z.mp3"), "/Volumes/Ext/z.mp3");
    }

    #[test]
    fn real_home_is_the_users_own_directory() {
        // Unsandboxed — the suite's own case — the password database and `$HOME`
        // agree. The lookup exists for the sandboxed build, where only the former
        // still names the directory the user's music actually lives in.
        let home = real_home().expect("no home directory");
        assert!(home.is_absolute(), "{home:?}");
        if let Some(env) = std::env::var_os("HOME") {
            assert_eq!(home, PathBuf::from(env));
        }
    }

    #[test]
    fn the_reported_layout_goes_absolute_against_the_real_home() {
        // The bug end to end, on this machine's actual home rather than a
        // fabricated one: real_home → container_root → relativize.
        let home = real_home().expect("no home directory");
        let list = home.join("Library/CloudStorage/ProtonDrive-x-folder/mp3s");
        let track = home.join("mp3s/ffviibm.mp3");
        let track = track.to_str().unwrap();
        assert_eq!(relativize(&list, track, &Bounds::of(&list)), track);
    }

    #[test]
    fn container_root_is_the_deepest_unit_that_travels() {
        let home = Some(Path::new(HOME));
        let root = |d: &str| container_root(Path::new(d), home);
        // Nothing enclosing but the filesystem.
        assert_eq!(root("/music/Playlists"), Path::new("/"));
        // The volume, not the directory that collects volumes.
        assert_eq!(root("/Volumes/Ext/Music/lists"), Path::new("/Volumes/Ext"));
        assert_eq!(root("/Volumes/Ext"), Path::new("/Volumes/Ext"));
        // The home folder, until something deeper claims it.
        assert_eq!(root("/Users/me/Music/lists"), Path::new(HOME));
        // One provider's synced tree — each is its own unit, so the boundary is
        // the provider folder rather than the directory holding all of them.
        assert_eq!(
            root("/Users/me/Library/CloudStorage/ProtonDrive-x-folder/mp3s"),
            Path::new("/Users/me/Library/CloudStorage/ProtonDrive-x-folder")
        );
        assert_eq!(
            root("/Users/me/Library/Mobile Documents/com~apple~CloudDocs/Music"),
            Path::new("/Users/me/Library/Mobile Documents/com~apple~CloudDocs")
        );
        // `CloudStorage` itself syncs nothing: its children do.
        assert_eq!(root("/Users/me/Library/CloudStorage"), Path::new(HOME));
        // Someone else's home is not this user's container.
        assert_eq!(root("/Users/you/Music"), Path::new("/"));
    }

    #[test]
    fn a_relative_row_never_climbs_out_of_a_sync_root() {
        // The reported bug. A playlist inside a synced folder, pointing at music
        // outside it, used to get `../../../../mp3s/x.mp3`: correct on this Mac
        // and meaningless on the other machine the folder syncs to, where that
        // many `..` lands somewhere else entirely.
        let list = "/Users/me/Library/CloudStorage/ProtonDrive-x-folder/mp3s";
        assert_eq!(rel(list, "/Users/me/mp3s/x.mp3"), "/Users/me/mp3s/x.mp3");
        // Inside the same synced tree it stays relative — that is the whole point
        // of the container: those two ends do travel together.
        assert_eq!(
            rel(list, "/Users/me/Library/CloudStorage/ProtonDrive-x-folder/Artist/x.mp3"),
            "../Artist/x.mp3"
        );
        // Same rule one boundary out: a playlist on a volume reaches across that
        // volume freely and off it never.
        assert_eq!(rel("/Volumes/Ext/lists", "/Volumes/Ext/Artist/x.mp3"), "../Artist/x.mp3");
        assert_eq!(rel("/Volumes/Ext/lists", "/Users/me/mp3s/x.mp3"), "/Users/me/mp3s/x.mp3");
    }

    #[test]
    fn relativized_rows_resolve_back_to_the_same_paths() {
        // The round-trip that portability actually rests on: whatever relativize
        // writes, resolve_path must read back as the path we started with.
        let base = Path::new("/music/Playlists");
        for abs in [
            "/music/Playlists/a/x.mp3",
            "/music/Artist/Album/y.flac",
            "/Volumes/Ext/z.mp3",
            "/Users/me/mp3s/w.mp3",
        ] {
            assert_eq!(resolve_path(base, &rel("/music/Playlists", abs)), abs);
        }
    }

    #[test]
    fn preserved_carries_comments_and_unknown_directives() {
        let base = Path::new("/music/lists");
        let content = "#EXTM3U\n                       # Created by SomeOtherPlayer\n                       #EXTGRP:Side A\n                       #EXTINF:212,Artist - Song\n                       a.mp3\n                       #EXTVLCOPT:start-time=30\n                       b.mp3\n                       # trailing note\n";
        let pres = Preserved::from_content(content, base);
        // A plain comment before any track is the file's banner, not row 1's.
        assert_eq!(pres.header, vec!["# Created by SomeOtherPlayer".to_string()]);
        // `#EXT*` directives belong to the row they introduce and travel with it.
        assert_eq!(
            pres.attached.get("/music/lists/a.mp3"),
            Some(&vec!["#EXTGRP:Side A".to_string()])
        );
        assert_eq!(
            pres.attached.get("/music/lists/b.mp3"),
            Some(&vec!["#EXTVLCOPT:start-time=30".to_string()])
        );
        assert_eq!(pres.trailer, vec!["# trailing note".to_string()]);
        // The three we regenerate are never captured, or a rewrite would double them.
        assert!(!pres.header.iter().any(|l| l.starts_with("#EXTM3U")));
        assert!(pres
            .attached
            .values()
            .flatten()
            .all(|l| !l.starts_with("#EXTINF")));
    }

    #[test]
    fn rewrite_preserves_extinf_and_comments_for_out_of_library_rows() {
        // The regression this whole path exists for: a reorder autosave used to
        // rewrite from the DB alone, so a playlist written by another app — whose
        // files sit outside every library root — came back stripped of every title
        // and every comment it had.
        let root = scratch("rewrite");
        let list = root.join("mix.m3u8");
        let original = "#EXTM3U\n                        #PLAYLIST:Mix\n                        # hand-written, do not lose me\n                        #EXTGRP:Side A\n                        #EXTINF:212,Artist One - Song One\n                        /outside/one.mp3\n                        #EXTINF:180,Artist Two - Song Two\n                        /outside/two.mp3\n";
        std::fs::write(&list, original).unwrap();

        let path = list.to_str().unwrap();
        let preserved = Preserved::from_file(path);
        let (_n, entries) = parse(original, &playlist_base_dir(path));
        // Reorder, exactly as a drag in the pane would.
        let mut rows = entries_as_rows(entries);
        rows.reverse();

        let out = serialize(path, "Mix", &rows, &preserved, &empty_db()).unwrap();

        assert!(out.contains("#EXTINF:180,Artist Two - Song Two"), "{out}");
        assert!(out.contains("#EXTINF:212,Artist One - Song One"), "{out}");
        assert!(out.contains("# hand-written, do not lose me"), "{out}");
        // The group directive followed its row to the file's second half.
        let group = out.find("#EXTGRP:Side A").expect("group directive dropped");
        let one = out.find("/outside/one.mp3").unwrap();
        assert!(group < one && group > out.find("/outside/two.mp3").unwrap(), "{out}");
        // And the whole thing re-reads as what we wrote.
        let (name, back) = parse(&out, &playlist_base_dir(path));
        assert_eq!(name.as_deref(), Some("Mix"));
        assert_eq!(back.len(), 2);
        assert_eq!(back[0].path, "/outside/two.mp3");
        assert_eq!(back[0].extinf_secs, Some(180.0));
        assert_eq!(back[0].extinf_title.as_deref(), Some("Artist Two - Song Two"));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_sibling_playlist_folder_writes_portable_rows() {
        // The layout most people actually have — `Music/Playlists/x.m3u8` pointing
        // at `Music/Artist/...` — used to serialize every row absolute, so copying
        // the Music folder anywhere else broke the whole playlist.
        let root = scratch("portable");
        let lists = root.join("Playlists");
        std::fs::create_dir_all(&lists).unwrap();
        let list = lists.join("mix.m3u8");
        let track = root.join("Artist").join("Album").join("01.flac");

        let rows = vec![TrackRef {
            path: track.to_str().unwrap().to_string(),
            title: Some("Artist - Song".to_string()),
            duration: Some(212.0),
        }];
        let out = serialize(
            list.to_str().unwrap(),
            "Mix",
            &rows,
            &Preserved::default(),
            &empty_db(),
        )
        .unwrap();

        assert!(
            out.contains("../Artist/Album/01.flac"),
            "row did not go relative: {out}"
        );
        assert!(!out.contains(root.to_str().unwrap()), "absolute row leaked: {out}");
        // And the relative row still resolves to the file it names.
        let (_n, back) = parse(&out, &playlist_base_dir(list.to_str().unwrap()));
        assert_eq!(back[0].path, track.to_str().unwrap());

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn an_existing_rows_spelling_is_never_restyled() {
        // A path's spelling is content its author chose, like the comments and
        // directives around it. A rewrite may not quietly restyle it — even into
        // the form Pudding would have picked, and even though that form is the
        // more portable one. Only rows Pudding is adding get a form chosen.
        let root = scratch("spelling");
        let lists = root.join("Playlists");
        std::fs::create_dir_all(&lists).unwrap();
        let list = lists.join("mix.m3u8");
        let abs_track = root.join("Artist").join("01.flac");
        let abs_s = abs_track.to_str().unwrap().to_string();

        // Written absolute by hand (or by another player), plus a row spelled
        // with a redundant `./` that would not survive a round trip through the
        // resolved path either.
        let original = format!("#EXTM3U\n#PLAYLIST:Mix\n{}\n./b.mp3\n", abs_s);
        std::fs::write(&list, &original).unwrap();

        let path = list.to_str().unwrap();
        let preserved = Preserved::from_file(path);
        let (_n, entries) = parse(&original, &playlist_base_dir(path));
        let rows = entries_as_rows(entries);
        let out = serialize(path, "Mix", &rows, &preserved, &empty_db()).unwrap();

        assert!(out.contains(&format!("\n{}\n", abs_s)), "absolute row restyled: {out}");
        assert!(!out.contains("../Artist/01.flac"), "absolute row restyled: {out}");
        assert!(out.contains("\n./b.mp3\n"), "`./` spelling lost: {out}");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_new_row_follows_an_all_absolute_file() {
        // A file whose every row is absolute has already given up portability.
        // Adding the one relative row among them buys nothing and leaves a
        // patchwork, so the file's own convention wins.
        let root = scratch("housestyle");
        let lists = root.join("Playlists");
        std::fs::create_dir_all(&lists).unwrap();
        let list = lists.join("mix.m3u8");
        let track = |n: &str| root.join("Artist").join(n).to_str().unwrap().to_string();

        std::fs::write(
            &list,
            format!("#EXTM3U\n#PLAYLIST:Mix\n{}\n{}\n", track("01.flac"), track("02.flac")),
        )
        .unwrap();

        let path = list.to_str().unwrap();
        let preserved = Preserved::from_file(path);
        let rows: Vec<TrackRef> = ["01.flac", "02.flac", "03.flac"]
            .iter()
            .map(|n| TrackRef { path: track(n), title: None, duration: None })
            .collect();
        let out = serialize(path, "Mix", &rows, &preserved, &empty_db()).unwrap();

        assert!(out.contains(&format!("\n{}\n", track("03.flac"))), "new row went relative: {out}");
        assert!(!out.contains("../Artist"), "new row went relative: {out}");

        // The same addition to an all-relative file goes relative, which is the
        // same convention read the other way.
        let rel_list = lists.join("rel.m3u8");
        std::fs::write(&rel_list, "#EXTM3U\n#PLAYLIST:Rel\n../Artist/01.flac\n").unwrap();
        let rel_path = rel_list.to_str().unwrap();
        let out = serialize(
            rel_path,
            "Rel",
            &rows[..2],
            &Preserved::from_file(rel_path),
            &empty_db(),
        )
        .unwrap();
        assert!(out.contains("../Artist/02.flac"), "new row went absolute: {out}");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_move_rebases_relative_rows_and_leaves_absolute_ones() {
        // Preservation is scoped to the directory a spelling was captured
        // against: the destination of a move is a different directory, so a
        // relative row has to be recomputed there or it points somewhere else.
        // An absolute row means the same thing from anywhere and travels as-is.
        let root = scratch("moverebase");
        let from = root.join("A");
        let to = root.join("A").join("deep");
        std::fs::create_dir_all(&to).unwrap();
        let abs_track = root.join("Music").join("z.mp3");
        let abs_s = abs_track.to_str().unwrap().to_string();

        let old = from.join("mix.m3u8");
        std::fs::write(
            &old,
            format!("#EXTM3U\n#PLAYLIST:Mix\n../Music/x.mp3\n{}\n", abs_s),
        )
        .unwrap();
        let new = to.join("mix.m3u8");

        move_playlist_inner(old.to_str().unwrap(), new.to_str().unwrap(), &empty_db()).unwrap();

        let out = std::fs::read_to_string(&new).unwrap();
        assert!(out.contains("../../Music/x.mp3"), "relative row not rebased: {out}");
        assert!(out.contains(&format!("\n{}\n", abs_s)), "absolute row restyled: {out}");
        // The rebased row still names the file it named before the move.
        let (_n, back) = parse(&out, &playlist_base_dir(new.to_str().unwrap()));
        assert_eq!(back[0].path, root.join("Music").join("x.mp3").to_str().unwrap());

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn rewrite_is_idempotent() {
        // Read → write → read → write must reach a fixed point; anything else means
        // autosave churns the file (and its mtime) on every edit that changes nothing.
        let root = scratch("idem");
        let list = root.join("mix.m3u8");
        let original = "#EXTM3U\n#PLAYLIST:Mix\n# banner\n#EXTGRP:A\n#EXTINF:212,One\n/outside/one.mp3\n# tail\n";
        std::fs::write(&list, original).unwrap();
        let path = list.to_str().unwrap();
        let db = empty_db();

        let once = {
            let pres = Preserved::from_file(path);
            let (_n, e) = parse(original, &playlist_base_dir(path));
            serialize(path, "Mix", &entries_as_rows(e), &pres, &db).unwrap()
        };
        std::fs::write(&list, &once).unwrap();
        let twice = {
            let pres = Preserved::from_file(path);
            let (_n, e) = parse(&once, &playlist_base_dir(path));
            serialize(path, "Mix", &entries_as_rows(e), &pres, &db).unwrap()
        };
        assert_eq!(once, twice, "rewrite is not a fixed point");

        let _ = std::fs::remove_dir_all(&root);
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
            // Mirrors the columns TRACK_COLUMNS selects (see lib.rs init_schema):
            // fetch_meta reads that list, so a column missing here fails the query
            // rather than returning a null.
            "CREATE TABLE tracks (path TEXT, title TEXT, artist TEXT, album TEXT, \
             album_artist TEXT, disc INTEGER, track INTEGER, year INTEGER, genre TEXT, \
             duration REAL, bitrate INTEGER, sample_rate INTEGER, bit_depth INTEGER, \
             rg_track_gain REAL, created INTEGER, mtime INTEGER, \
             dataless INTEGER NOT NULL DEFAULT 0);",
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
    fn stream_rows_resolve_verbatim() {
        // The bug this fixes: a URL is *relative* as far as `Path` is concerned, so
        // every station row used to be joined onto the playlist's own folder.
        let base = Path::new("/music/lists");
        let content = "#EXTM3U\n#EXTINF:-1,BBC 6 Music\nhttps://stream.example/6music\n../a/track.mp3\n";
        let (_name, entries) = parse(content, base);
        assert_eq!(entries[0].path, "https://stream.example/6music");
        assert_eq!(entries[0].extinf_title.as_deref(), Some("BBC 6 Music"));
        // The file row beside it still resolves the way it always did.
        assert_eq!(entries[1].path, "/music/a/track.mp3");
    }

    #[test]
    fn stream_rows_round_trip_through_a_rewrite() {
        // A station row must come back byte-identical from a curation autosave, and
        // must not drag the file's *file* rows into a different spelling.
        let root = scratch("streamrows");
        let list = root.join("mixed.m3u8");
        let original = "#EXTM3U\n#PLAYLIST:Mixed\n#EXTINF:-1,BBC 6 Music\nhttps://stream.example/6music\n#EXTINF:212,Artist - Song\n/outside/one.mp3\n";
        std::fs::write(&list, original).unwrap();

        let path = list.to_str().unwrap();
        let preserved = Preserved::from_file(path);
        let (_n, entries) = parse(original, &playlist_base_dir(path));
        let out = serialize(path, "Mixed", &entries_as_rows(entries), &preserved, &empty_db())
            .unwrap();

        assert!(out.contains("\nhttps://stream.example/6music\n"), "{out}");
        assert!(out.contains("#EXTINF:-1,BBC 6 Music"), "{out}");
        // The absolute file row keeps its spelling: one station among the rows must
        // not flip the file off `AllAbsolute` and start relativizing.
        assert!(out.contains("\n/outside/one.mp3\n"), "{out}");

        let (_name, back) = parse(&out, &playlist_base_dir(path));
        assert_eq!(back.len(), 2);
        assert_eq!(back[0].path, "https://stream.example/6music");
        assert_eq!(back[1].path, "/outside/one.mp3");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn ceilings_reject_a_file_that_is_not_a_playlist() {
        let root = scratch("ceilings");

        // Too big: something else wearing the extension. Refused without decoding
        // it — the point of the ceiling — and the error says which file.
        let huge = root.join("video.m3u8");
        std::fs::write(&huge, vec![0u8; (MAX_PLAYLIST_BYTES + 1) as usize]).unwrap();
        let err = read_rows(huge.to_str().unwrap()).unwrap_err();
        assert!(err.starts_with("not a playlist:"), "{err}");
        // And the tree asks for no name from it rather than decoding it in full.
        assert_eq!(read_playlist_name(&huge), None);

        // Too many rows: under the byte ceiling, still not a playlist.
        let many = root.join("many.m3u8");
        std::fs::write(&many, "a\n".repeat(MAX_PLAYLIST_ROWS + 1)).unwrap();
        let err = read_rows(many.to_str().unwrap()).unwrap_err();
        assert!(err.contains("rows"), "{err}");

        // A real playlist of ordinary size is untouched by either.
        let fine = root.join("fine.m3u8");
        std::fs::write(&fine, "#EXTM3U\n#PLAYLIST:Fine\n/a.mp3\n").unwrap();
        let (name, entries, _mtime) = read_rows(fine.to_str().unwrap()).unwrap();
        assert_eq!(name.as_deref(), Some("Fine"));
        assert_eq!(entries.len(), 1);

        let _ = std::fs::remove_dir_all(&root);
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
