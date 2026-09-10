// HTTP transport for internet radio: connects to an Icecast/SHOUTcast URL,
// resolves playlist indirection (.pls/.m3u), requests in-band ICY metadata,
// and exposes a de-interleaved audio byte stream plus a shared slot the
// decode loop polls for now-playing titles.
//
// ICY metadata protocol: when the request carries `Icy-MetaData: 1`, the
// server replies with `icy-metaint: N` and interleaves a metadata block into
// the body every N audio bytes. A block is one length byte L followed by
// L*16 bytes of `StreamTitle='...';` padded with NULs. IcyReader strips these
// so the decoder only ever sees clean audio bytes.
//
// Known limitation: ancient SHOUTcast v1 servers answer with a bare
// `ICY 200 OK` status line, which ureq rejects as malformed HTTP. Those
// surface as a connect error; Icecast and SHOUTcast v2 speak real HTTP.

use std::io::Read;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use symphonia::core::io::MediaSource;

// Playlist bodies are tiny (a handful of URLs); anything bigger than this is
// not a playlist and we refuse to buffer it.
const PLAYLIST_MAX_BYTES: u64 = 64 * 1024;

// A playlist pointing at another playlist is rare but legal; beyond a few
// hops it's a loop.
const MAX_PLAYLIST_HOPS: usize = 3;

// If the server stops sending for this long the read errors out and the
// engine's reconnect logic takes over. Radio servers push continuously, so a
// stall this long means the connection is effectively dead.
const READ_TIMEOUT: Duration = Duration::from_secs(10);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(8);

pub struct IcyConnection {
    // De-interleaved audio bytes (metadata blocks already stripped).
    pub reader: Box<dyn Read + Send>,
    // Content-Type of the stream, e.g. "audio/mpeg" — used as a codec hint
    // for the symphonia probe.
    pub content_type: Option<String>,
    // Station name from the icy-name header, when the server sends one.
    pub station_name: Option<String>,
    // Latest StreamTitle parsed out of the interleaved metadata. Written by
    // IcyReader from inside symphonia's read path; polled by the decode loop
    // between packets. None until the first title arrives (or forever, for
    // stations that never send one).
    pub title: Arc<Mutex<Option<String>>>,
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(CONNECT_TIMEOUT)
        .timeout_read(READ_TIMEOUT)
        .user_agent(crate::USER_AGENT)
        .build()
}

pub fn connect(url: &str) -> Result<IcyConnection, String> {
    let agent = agent();
    let mut target = url.to_string();

    for _ in 0..MAX_PLAYLIST_HOPS {
        let resp = agent
            .get(&target)
            .set("Icy-MetaData", "1")
            .set("Accept", "*/*")
            .call()
            .map_err(|e| format!("connect {target}: {e}"))?;

        let content_type = {
            let ct = resp.content_type().trim().to_ascii_lowercase();
            if ct.is_empty() {
                None
            } else {
                Some(ct)
            }
        };

        if looks_like_playlist(content_type.as_deref(), &target) {
            let mut body = String::new();
            resp.into_reader()
                .take(PLAYLIST_MAX_BYTES)
                .read_to_string(&mut body)
                .map_err(|e| format!("read playlist {target}: {e}"))?;
            if body.contains("#EXT-X-") {
                return Err("HLS streams are not supported".into());
            }
            target = parse_playlist(&body)
                .ok_or_else(|| format!("playlist {target} contains no stream URL"))?;
            continue;
        }

        let metaint: usize = resp
            .header("icy-metaint")
            .and_then(|v| v.trim().parse().ok())
            .unwrap_or(0);
        let station_name = resp
            .header("icy-name")
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty());

        let title = Arc::new(Mutex::new(None));
        let raw = resp.into_reader();
        let reader: Box<dyn Read + Send> = if metaint > 0 {
            Box::new(IcyReader::new(raw, metaint, Arc::clone(&title)))
        } else {
            Box::new(raw)
        };

        return Ok(IcyConnection {
            reader,
            content_type,
            station_name,
            title,
        });
    }

    Err(format!("too many playlist redirects from {url}"))
}

// A .m3u8 extension or HLS content type still comes through here: plain-m3u
// bodies get resolved, real HLS bodies (#EXT-X-) are rejected in connect().
fn looks_like_playlist(content_type: Option<&str>, url: &str) -> bool {
    if let Some(ct) = content_type {
        if matches!(
            ct,
            "audio/x-scpls"
                | "application/pls+xml"
                | "audio/x-mpegurl"
                | "audio/mpegurl"
                | "application/x-mpegurl"
                | "application/vnd.apple.mpegurl"
        ) {
            return true;
        }
    }
    let path = url
        .split(['?', '#'])
        .next()
        .unwrap_or(url)
        .to_ascii_lowercase();
    path.ends_with(".pls") || path.ends_with(".m3u") || path.ends_with(".m3u8")
}

// First stream URL out of a PLS (`File1=http://...`) or M3U (first
// non-comment line) body. Lenient on purpose: radio playlists in the wild are
// frequently hand-edited.
fn parse_playlist(body: &str) -> Option<String> {
    for line in body.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with('[') {
            continue;
        }
        // PLS entry: FileN=url. M3U entry: bare url.
        let candidate = match line.split_once('=') {
            Some((key, value)) if key.trim().to_ascii_lowercase().starts_with("file") => {
                value.trim()
            }
            Some(_) => continue, // other PLS keys (TitleN=, LengthN=, NumberOfEntries=)
            None => line,
        };
        if candidate.starts_with("http://") || candidate.starts_with("https://") {
            return Some(candidate.to_string());
        }
    }
    None
}

// === ICY de-interleaver ===

struct IcyReader<R: Read> {
    inner: R,
    metaint: usize,
    // Audio bytes remaining before the next metadata block.
    until_meta: usize,
    title: Arc<Mutex<Option<String>>>,
}

impl<R: Read> IcyReader<R> {
    fn new(inner: R, metaint: usize, title: Arc<Mutex<Option<String>>>) -> Self {
        Self {
            inner,
            metaint,
            until_meta: metaint,
            title,
        }
    }

    fn consume_metadata_block(&mut self) -> std::io::Result<()> {
        let mut len_byte = [0u8; 1];
        self.inner.read_exact(&mut len_byte)?;
        let len = len_byte[0] as usize * 16;
        if len > 0 {
            let mut meta = vec![0u8; len];
            self.inner.read_exact(&mut meta)?;
            if let Some(t) = parse_stream_title(&meta) {
                *self.title.lock().unwrap_or_else(|e| e.into_inner()) = Some(t);
            }
        }
        self.until_meta = self.metaint;
        Ok(())
    }
}

impl<R: Read> Read for IcyReader<R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if self.until_meta == 0 {
            self.consume_metadata_block()?;
        }
        let take = buf.len().min(self.until_meta);
        let n = self.inner.read(&mut buf[..take])?;
        self.until_meta -= n;
        Ok(n)
    }
}

// Extracts the value of StreamTitle='...'; from a metadata block. Titles are
// NUL-padded and occasionally contain apostrophes: most encoders leave them
// bare (so match the closing quote-semicolon pair, not the first apostrophe),
// but some (notably liquidsoap) backslash-escape them, so skip escaped quotes
// when scanning and unescape the result. Empty titles (some stations send
// StreamTitle=''; between songs) map to None.
fn parse_stream_title(meta: &[u8]) -> Option<String> {
    // ICY metadata is nominally Latin-1 but many modern stations send UTF-8.
    // Try UTF-8 first; if it fails, decode as Latin-1 (each byte maps directly
    // to the same Unicode code point, so `b as char` is correct).
    let owned;
    let text = match std::str::from_utf8(meta) {
        Ok(s) => std::borrow::Cow::Borrowed(s),
        Err(_) => {
            owned = meta.iter().map(|&b| b as char).collect::<String>();
            std::borrow::Cow::Owned(owned)
        }
    };
    let text = text.trim_end_matches('\0');
    let start = text.find("StreamTitle='")? + "StreamTitle='".len();
    let rest = &text[start..];
    let end = find_title_end(rest)?;
    let title = unescape_title(rest[..end].trim());
    if title.is_empty() {
        None
    } else {
        Some(title)
    }
}

// Byte offset of the closing quote: the first "';" whose quote isn't
// backslash-escaped. Falls back to the last apostrophe for truncated blocks
// that lost their terminator.
fn find_title_end(rest: &str) -> Option<usize> {
    let bytes = rest.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'\\' => i += 2,
            b'\'' if bytes.get(i + 1) == Some(&b';') => return Some(i),
            _ => i += 1,
        }
    }
    rest.rfind('\'')
}

// Undo backslash-escaping of quotes and backslashes; any other backslash is
// treated as literal since most encoders don't escape at all.
fn unescape_title(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            match chars.next() {
                Some(n @ ('\'' | '"' | '\\')) => out.push(n),
                Some(n) => {
                    out.push(c);
                    out.push(n);
                }
                None => out.push(c),
            }
        } else {
            out.push(c);
        }
    }
    out
}

// === symphonia adapter ===

// Wraps the network reader as a non-seekable MediaSource. The Mutex is only
// there to satisfy MediaSource's Sync bound; the decode thread is the sole
// reader, so it's uncontended.
pub struct NetSource {
    inner: Mutex<Box<dyn Read + Send>>,
}

impl NetSource {
    pub fn new(inner: Box<dyn Read + Send>) -> Self {
        Self {
            inner: Mutex::new(inner),
        }
    }
}

impl Read for NetSource {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        self.inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .read(buf)
    }
}

impl std::io::Seek for NetSource {
    fn seek(&mut self, _: std::io::SeekFrom) -> std::io::Result<u64> {
        Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "live streams are not seekable",
        ))
    }
}

impl MediaSource for NetSource {
    fn is_seekable(&self) -> bool {
        false
    }

    fn byte_len(&self) -> Option<u64> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Builds an ICY body: audio bytes interleaved with metadata blocks every
    // `metaint` bytes.
    fn icy_body(metaint: usize, audio: &[u8], title: &str) -> Vec<u8> {
        let mut meta = format!("StreamTitle='{title}';").into_bytes();
        let padded = meta.len().div_ceil(16) * 16;
        meta.resize(padded, 0);
        let len_byte = (padded / 16) as u8;

        let mut out = Vec::new();
        for (i, chunk) in audio.chunks(metaint).enumerate() {
            out.extend_from_slice(chunk);
            if chunk.len() == metaint {
                out.push(if i == 0 { len_byte } else { 0 });
                if i == 0 {
                    out.extend_from_slice(&meta);
                }
            }
        }
        out
    }

    #[test]
    fn icy_reader_strips_metadata_and_captures_title() {
        let audio: Vec<u8> = (0..100u8).collect();
        let body = icy_body(8, &audio, "Artist - Song");
        let title = Arc::new(Mutex::new(None));
        let mut reader = IcyReader::new(body.as_slice(), 8, Arc::clone(&title));

        let mut out = Vec::new();
        reader.read_to_end(&mut out).unwrap();
        assert_eq!(out, audio);
        assert_eq!(title.lock().unwrap().as_deref(), Some("Artist - Song"));
    }

    #[test]
    fn icy_reader_handles_tiny_read_buffers() {
        let audio: Vec<u8> = (0..64u8).collect();
        let body = icy_body(16, &audio, "T");
        let title = Arc::new(Mutex::new(None));
        let mut reader = IcyReader::new(body.as_slice(), 16, Arc::clone(&title));

        let mut out = Vec::new();
        let mut buf = [0u8; 3]; // deliberately misaligned with metaint
        loop {
            let n = reader.read(&mut buf).unwrap();
            if n == 0 {
                break;
            }
            out.extend_from_slice(&buf[..n]);
        }
        assert_eq!(out, audio);
        assert_eq!(title.lock().unwrap().as_deref(), Some("T"));
    }

    #[test]
    fn stream_title_parsing() {
        let t = |s: &str| parse_stream_title(s.as_bytes());
        assert_eq!(
            t("StreamTitle='Artist - Song';StreamUrl='';"),
            Some("Artist - Song".into())
        );
        // Apostrophe inside the title.
        assert_eq!(
            t("StreamTitle='Don't Stop';StreamUrl='';"),
            Some("Don't Stop".into())
        );
        // Backslash-escaped apostrophe (liquidsoap-style, e.g. Vintage
        // Obscura) is unescaped, and an escaped "\';" doesn't end the title.
        assert_eq!(
            t("StreamTitle='W\\'s - Dungeon Chains';StreamUrl='';"),
            Some("W's - Dungeon Chains".into())
        );
        assert_eq!(
            t("StreamTitle='odd \\'; mid-title';StreamUrl='';"),
            Some("odd '; mid-title".into())
        );
        // Escaped backslash before the real closing quote.
        assert_eq!(t("StreamTitle='back\\\\';"), Some("back\\".into()));
        // Empty title → None.
        assert_eq!(t("StreamTitle='';"), None);
        // No StreamTitle field at all.
        assert_eq!(t("StreamUrl='x';"), None);
        // NUL padding.
        assert_eq!(
            parse_stream_title(b"StreamTitle='A';\0\0\0\0"),
            Some("A".into())
        );
        // Latin-1 encoded title (ì = 0xEC in Latin-1, invalid UTF-8).
        assert_eq!(
            parse_stream_title(b"StreamTitle='Luned\xec Ore 7,45';"),
            Some("Lunedì Ore 7,45".into())
        );
    }

    #[test]
    fn playlist_parsing() {
        assert_eq!(
            parse_playlist("[playlist]\nNumberOfEntries=1\nFile1=http://ex.am/ple\nTitle1=X\n"),
            Some("http://ex.am/ple".into())
        );
        assert_eq!(
            parse_playlist("#EXTM3U\n#EXTINF:-1,Station\nhttps://ex.am/stream\n"),
            Some("https://ex.am/stream".into())
        );
        assert_eq!(parse_playlist("[playlist]\nNumberOfEntries=0\n"), None);
    }

    // Live-network smoke test against a real Icecast server; excluded from
    // normal runs. Invoke with `cargo test -- --ignored` to verify the full
    // connect → ICY handshake → de-interleave path against reality.
    #[test]
    #[ignore = "requires network"]
    fn live_connect_smoke() {
        let conn = connect("https://ice5.somafm.com/groovesalad-128-mp3").expect("connect");
        assert_eq!(conn.content_type.as_deref(), Some("audio/mpeg"));
        assert!(conn.station_name.is_some(), "SomaFM sends icy-name");

        // 64 KiB spans several metaint blocks at Icecast's typical 16000, so
        // a StreamTitle must have been parsed by the end of it.
        let mut reader = conn.reader;
        let mut buf = vec![0u8; 64 * 1024];
        let mut got = 0;
        while got < buf.len() {
            let n = reader.read(&mut buf[got..]).expect("read stream");
            assert!(n > 0, "unexpected EOF from live stream");
            got += n;
        }
        let title = conn.title.lock().unwrap().clone();
        println!(
            "station={:?} title={:?}",
            conn.station_name.as_deref(),
            title
        );
        assert!(title.is_some(), "SomaFM interleaves StreamTitle");
    }

    #[test]
    fn playlist_detection() {
        assert!(looks_like_playlist(Some("audio/x-scpls"), "http://x/hi"));
        assert!(looks_like_playlist(None, "http://x/listen.pls?y=1"));
        assert!(looks_like_playlist(None, "http://x/chunklist.m3u8"));
        assert!(!looks_like_playlist(Some("audio/mpeg"), "http://x/stream"));
        assert!(!looks_like_playlist(None, "http://x/stream.mp3"));
    }
}
