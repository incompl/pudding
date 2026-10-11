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
use ureq::unversioned::resolver::DefaultResolver;
use ureq::unversioned::transport::time::Duration as TransportDuration;
use ureq::unversioned::transport::{
    Buffers, ConnectionDetails, Connector, DefaultConnector, NextTimeout, Transport,
};

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

// ureq 3 has no equivalent of ureq 2's `timeout_read`. Its timeouts are
// deadlines rather than per-read caps, and the one covering the body,
// `timeout_recv_body`, budgets the *whole* body measured from the moment the
// response headers arrived. A radio body never ends, so any value at all would
// abort playback that long into the stream, while leaving it unset lets a dead
// connection block in `read()` forever, so the engine's reconnect never fires.
//
// The transport is the last layer that still sees individual socket reads
// (`TcpTransport::await_input` turns the deadline it is handed into
// `set_read_timeout`), so the liveness cap is reimposed there by shortening
// that deadline to READ_TIMEOUT on every read.
#[derive(Debug)]
struct IdleTimeout<T> {
    inner: T,
    idle: TransportDuration,
}

impl<T: Transport> Transport for IdleTimeout<T> {
    fn buffers(&mut self) -> &mut dyn Buffers {
        self.inner.buffers()
    }

    fn transmit_output(&mut self, amount: usize, timeout: NextTimeout) -> Result<(), ureq::Error> {
        self.inner.transmit_output(amount, timeout)
    }

    fn await_input(&mut self, timeout: NextTimeout) -> Result<bool, ureq::Error> {
        // min() so a shorter real deadline still wins; the idle cap only ever
        // shortens the wait, it never extends one ureq meant to be tighter.
        let after = self.idle.min(timeout.after);
        self.inner.await_input(NextTimeout { after, ..timeout })
    }

    fn is_open(&mut self) -> bool {
        self.inner.is_open()
    }

    fn is_tls(&self) -> bool {
        self.inner.is_tls()
    }
}

// Last link in the chain, so it wraps whatever the default chain produced —
// the TLS transport for https, the bare TCP one for http.
#[derive(Debug)]
struct IdleTimeoutConnector(TransportDuration);

impl<In: Transport> Connector<In> for IdleTimeoutConnector {
    type Out = IdleTimeout<In>;

    fn connect(
        &self,
        _: &ConnectionDetails,
        chained: Option<In>,
    ) -> Result<Option<Self::Out>, ureq::Error> {
        Ok(chained.map(|inner| IdleTimeout {
            inner,
            idle: self.0,
        }))
    }
}

fn agent(read_timeout: Duration, connect_timeout: Duration) -> ureq::Agent {
    let config = ureq::Agent::config_builder()
        .timeout_connect(Some(connect_timeout))
        .user_agent(crate::USER_AGENT)
        .build();
    ureq::Agent::with_parts(
        config,
        DefaultConnector::new().chain(IdleTimeoutConnector(read_timeout.into())),
        DefaultResolver::default(),
    )
}

pub fn connect(url: &str) -> Result<IcyConnection, String> {
    connect_with(&agent(READ_TIMEOUT, CONNECT_TIMEOUT), url)
}

fn connect_with(agent: &ureq::Agent, url: &str) -> Result<IcyConnection, String> {
    let mut target = url.to_string();

    for _ in 0..MAX_PLAYLIST_HOPS {
        let resp = agent
            .get(&target)
            .header("Icy-MetaData", "1")
            .header("Accept", "*/*")
            .call()
            .map_err(|e| format!("connect {target}: {e}"))?;

        let content_type = resp
            .body()
            .mime_type()
            .map(|ct| ct.trim().to_ascii_lowercase())
            .filter(|ct| !ct.is_empty());

        if looks_like_playlist(content_type.as_deref(), &target) {
            let mut body = String::new();
            resp.into_body()
                .into_reader()
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

        // Decoded with from_utf8 rather than HeaderValue::to_str, which rejects
        // any byte above 0x7F: station names carry accents often enough that
        // to_str would drop them, and ureq 2's header accessor decoded as UTF-8
        // too. A name that isn't valid UTF-8 is still skipped, as before.
        let header = |name: &str| {
            resp.headers()
                .get(name)
                .and_then(|v| std::str::from_utf8(v.as_bytes()).ok())
        };
        let metaint: usize = header("icy-metaint")
            .and_then(|v| v.trim().parse().ok())
            .unwrap_or(0);
        let station_name = header("icy-name")
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty());

        let title = Arc::new(Mutex::new(None));
        let raw = resp.into_body().into_reader();
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

    use std::io::Write;
    use std::net::TcpListener;

    const HDR_200: &[u8] = b"HTTP/1.1 200 OK\r\ncontent-type: audio/mpeg\r\n\r\n";

    // A one-shot HTTP server on a loopback port. `script` runs once the request
    // headers have been drained and owns the socket for its duration: a radio
    // body is close-delimited, so the script must keep the socket alive — the
    // moment it returns the client sees EOF instead of whatever was being
    // tested. Returns the URL to point connect_with() at.
    fn serve(script: impl FnOnce(&mut std::net::TcpStream) + Send + 'static) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let addr = listener.local_addr().expect("local addr");
        std::thread::spawn(move || {
            let Ok((mut sock, _)) = listener.accept() else {
                return;
            };
            let mut req = Vec::new();
            let mut byte = [0u8; 1];
            while !req.ends_with(b"\r\n\r\n") {
                match sock.read(&mut byte) {
                    Ok(0) | Err(_) => return,
                    Ok(_) => req.push(byte[0]),
                }
            }
            script(&mut sock);
        });
        format!("http://{addr}/stream")
    }

    fn test_agent(idle: Duration) -> ureq::Agent {
        agent(idle, Duration::from_secs(5))
    }

    // The upgrade to ureq 3 turns on this and the next test. ureq 3 has no
    // per-read timeout, and the body timeout it does have is a single deadline
    // for the whole body, so the two failure modes to rule out are a dead
    // stream that hangs forever and a healthy stream that gets cut off.
    #[test]
    fn a_stalled_stream_errors_at_the_idle_timeout() {
        let url = serve(|sock| {
            sock.write_all(HDR_200).expect("write headers");
            sock.write_all(&[7u8; 64]).expect("write audio");
            sock.flush().expect("flush");
            // Stall with the socket still open: no bytes, no FIN.
            std::thread::sleep(Duration::from_secs(10));
        });

        let idle = Duration::from_millis(300);
        let conn = connect_with(&test_agent(idle), &url).expect("connect");
        let mut reader = conn.reader;
        let mut buf = [0u8; 4096];
        let started = std::time::Instant::now();
        loop {
            match reader.read(&mut buf) {
                Ok(0) => panic!("got EOF; the stall should surface as a timeout"),
                Ok(_) => continue,
                Err(_) => break,
            }
        }
        let elapsed = started.elapsed();
        assert!(
            elapsed >= idle && elapsed < idle * 8,
            "stall surfaced after {elapsed:?}, idle cap is {idle:?}"
        );
    }

    #[test]
    fn a_slow_stream_outlives_the_idle_timeout() {
        // 15 writes, each gap well under the cap but together five times it. A
        // total-body deadline of `idle` would abort partway through.
        const WRITES: usize = 15;
        const CHUNK: usize = 64;
        let url = serve(|sock| {
            sock.write_all(HDR_200).expect("write headers");
            sock.flush().expect("flush");
            for i in 0..WRITES {
                std::thread::sleep(Duration::from_millis(100));
                if sock.write_all(&[i as u8; CHUNK]).is_err() {
                    return;
                }
                let _ = sock.flush();
            }
            std::thread::sleep(Duration::from_secs(5));
        });

        let conn = connect_with(&test_agent(Duration::from_millis(300)), &url).expect("connect");
        let mut reader = conn.reader;
        let mut got = Vec::new();
        while got.len() < WRITES * CHUNK {
            let mut buf = [0u8; 256];
            let n = reader
                .read(&mut buf)
                .expect("a stream still sending must not time out");
            assert!(n > 0, "unexpected EOF after {} bytes", got.len());
            got.extend_from_slice(&buf[..n]);
        }
        assert!(got.iter().all(|&b| (b as usize) < WRITES));
    }

    // content-type reaches the symphonia hint with its charset parameter
    // stripped, and a UTF-8 icy-name survives: http's HeaderValue::to_str
    // rejects every byte above 0x7F, so the header is decoded here instead.
    #[test]
    fn response_headers_become_content_type_station_name_and_metaint() {
        let audio: Vec<u8> = (0..64u8).collect();
        let body = icy_body(16, &audio, "Live Set");
        let url = serve(move |sock| {
            let head = concat!(
                "HTTP/1.1 200 OK\r\n",
                "content-type: Audio/MPEG; charset=utf-8\r\n",
                "icy-metaint: 16\r\n",
                // Latin-small-e-acute as UTF-8, the encoding modern Icecast uses.
                "icy-name: Radio Caf\u{e9}\r\n\r\n",
            );
            sock.write_all(head.as_bytes()).expect("write headers");
            sock.write_all(&body).expect("write body");
            sock.flush().expect("flush");
            std::thread::sleep(Duration::from_secs(5));
        });

        let conn = connect_with(&test_agent(Duration::from_secs(2)), &url).expect("connect");
        assert_eq!(conn.content_type.as_deref(), Some("audio/mpeg"));
        assert_eq!(conn.station_name.as_deref(), Some("Radio Café"));

        let title = Arc::clone(&conn.title);
        let mut reader = conn.reader;
        let mut got = vec![0u8; audio.len()];
        reader
            .read_exact(&mut got)
            .expect("read de-interleaved audio");
        assert_eq!(got, audio, "metaint must have been honored");
        assert_eq!(title.lock().unwrap().as_deref(), Some("Live Set"));
    }

    // A playlist hop: the .pls body is read to a String and the stream URL in
    // it becomes the next request. Exercises into_body().into_reader() on a
    // non-audio content type.
    #[test]
    fn a_pls_body_redirects_to_the_stream() {
        let stream = serve(|sock| {
            sock.write_all(HDR_200).expect("write headers");
            sock.write_all(&[3u8; 32]).expect("write audio");
            sock.flush().expect("flush");
            std::thread::sleep(Duration::from_secs(5));
        });
        let pls = serve(move |sock| {
            let body = format!("[playlist]\nNumberOfEntries=1\nFile1={stream}\n");
            let head = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: audio/x-scpls\r\ncontent-length: {}\r\n\r\n",
                body.len()
            );
            sock.write_all(head.as_bytes()).expect("write headers");
            sock.write_all(body.as_bytes()).expect("write body");
            sock.flush().expect("flush");
            std::thread::sleep(Duration::from_secs(5));
        });

        let conn = connect_with(&test_agent(Duration::from_secs(2)), &pls).expect("connect");
        assert_eq!(conn.content_type.as_deref(), Some("audio/mpeg"));
        let mut reader = conn.reader;
        let mut got = [0u8; 32];
        reader
            .read_exact(&mut got)
            .expect("read audio past the hop");
        assert_eq!(got, [3u8; 32]);
    }

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
