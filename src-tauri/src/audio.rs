// Native gapless audio engine.
//
// Architecture (read first if you're touching this):
//
//   [Tauri command] --cmd_tx--> [decode thread] --PCM--> (ring buffer) --> [audio callback] --> device
//                                                                                 |
//                                                                          frames_played (AtomicU64)
//                                                                                 |
//                                                                       [position-emit thread] --> Tauri events
//
// The output stream is opened once at startup and stays open for the whole
// session. Tracks are joined by adjacency in the ring buffer — track N's last
// sample sits next to track N+1's first sample with nothing in between.
//
// The audio callback is real-time: no allocation, no locking, no I/O, no logging.
// It only reads samples out of the ring buffer, applies volume, and counts
// frames played.
//
// Seek/stop/queue-change use a flush generation counter (AtomicU64). The decode
// thread bumps it; the callback notices and drains the ring buffer's stale
// contents on its next invocation.
//
// Internet radio runs through the same pipeline: PlayStream swaps the decode
// thread's source from a file queue to an HTTP connection (icy.rs strips the
// in-band ICY metadata before symphonia sees the bytes). Live-stream policy
// lives here: pause disconnects (resume rejoins the live edge instead of
// playing a stale buffer), and a dropped connection reconnects with backoff.

use std::collections::VecDeque;
use std::fs::File;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{SampleFormat, SampleRate, StreamConfig};
use crossbeam_channel::{Receiver, Sender, TryRecvError};
use rtrb::{Consumer as RbConsumer, Producer as RbProducer, RingBuffer};
use rubato::{
    Resampler, SincFixedIn, SincInterpolationParameters, SincInterpolationType, WindowFunction,
};
use serde::Serialize;
use symphonia::core::audio::{AudioBufferRef, Signal};
use symphonia::core::codecs::{Decoder, DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::errors::Error as SymError;
use symphonia::core::formats::{FormatOptions, FormatReader, SeekMode, SeekTo, Track};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use symphonia::core::units::Time;
use tauri::{AppHandle, Emitter};

use crate::icy;

// We force stereo output. Devices that don't support stereo are exotic enough
// that supporting them isn't worth the per-frame channel-count branching in
// the audio callback. OUT_CHANNELS appears in arithmetic (samples_per_frame),
// so keeping it a named constant makes the intent obvious.
const OUT_CHANNELS: usize = 2;

// Ring buffer sized for ~1 second of audio. Big enough to ride out a slow
// decode hiccup, small enough that the user-visible position lag at the
// boundary between "what's been decoded" and "what's audible" is imperceptible.
const RING_BUFFER_SECONDS: f32 = 1.0;

// Position events emitted ~20 Hz: smooth enough for a seekbar, cheap enough
// to be free on the event loop.
const POSITION_EMIT_INTERVAL_MS: u64 = 50;

// rubato chunk size in input frames. Larger = better resampling efficiency,
// smaller = lower latency. 1024 is the conventional sweet spot.
const RESAMPLER_CHUNK_FRAMES: usize = 1024;

// Stream reconnect policy, mirroring what mature web radio players ship
// (icecast-metadata-player defaults): quick first retry, exponential backoff
// to a small cap, and a bounded total outage before reporting failure and
// stopping. On give-up the session is kept paused rather than discarded, so
// the play button doubles as "try again".
const STREAM_RETRY_INITIAL: Duration = Duration::from_millis(500);
const STREAM_RETRY_MAX: Duration = Duration::from_secs(4);
const STREAM_GIVE_UP: Duration = Duration::from_secs(30);

// === Commands from the frontend ===

pub enum Command {
    Play {
        tracks: Vec<PathBuf>,
        start_index: usize,
    },
    PlayStream {
        url: String,
    },
    TogglePause,
    Seek(f64),
    Stop,
}

// === Shared atomics ===

pub struct SharedState {
    // Total stereo frames played (= samples written to device / OUT_CHANNELS).
    // Monotonically increases. Reset to 0 on every Play command so the producer
    // can publish track origins keyed against it without needing to know the
    // full history.
    frames_played: AtomicU64,
    // Cumulative stereo frames the consumer has drained (discarded) during
    // flushes. Used by the producer to translate its own frame count into the
    // consumer's space when publishing origins. Reset alongside frames_played.
    total_drained: AtomicU64,
    // Bumped by the decode thread whenever the buffered audio must be
    // discarded (seek, stop, new Play). The audio callback compares it to its
    // local cache; on mismatch, it drains its end of the ring before reading.
    flush_gen: AtomicU64,
    // Written by the audio callback after it observes flush_gen change and
    // drains. The decode thread bumps flush_gen and then waits for this to
    // catch up before pushing new audio — otherwise the callback could race
    // and drain the first samples of the new track along with the stale ones,
    // chopping ~10-100ms off the start of playback.
    flush_gen_acked: AtomicU64,
    // f32 volume as bits. Read once per callback, applied as a multiplier.
    volume: AtomicU32,
    // True when playback is paused. The callback emits silence and does NOT
    // drain the ring; the decode thread idles and stops pushing.
    paused: AtomicBool,
    // True when the decode thread has consumed the entire queue and there is
    // nothing more to push. The position-emit thread uses this together with
    // frames_played catching up to total_produced to decide when to fire
    // queue-ended.
    queue_exhausted: AtomicBool,
    // Cumulative stereo frames the producer has pushed across all tracks since
    // the current Play (i.e. since the last frames_played reset). Used by the
    // position emit thread to detect "everything is played out" → queue-ended.
    total_produced: AtomicU64,
}

impl SharedState {
    fn new() -> Self {
        Self {
            frames_played: AtomicU64::new(0),
            total_drained: AtomicU64::new(0),
            flush_gen: AtomicU64::new(0),
            flush_gen_acked: AtomicU64::new(0),
            volume: AtomicU32::new(1.0_f32.to_bits()),
            paused: AtomicBool::new(false),
            queue_exhausted: AtomicBool::new(true),
            total_produced: AtomicU64::new(0),
        }
    }
}

// === Origin queue ===
//
// Whenever the producer changes track (auto-advance or seek-within-track), it
// publishes an origin: "starting at consumer-frame N, the playing track is X
// at in-track offset Y." The position-emit thread compares frames_played
// against the head of the queue and fires track-changed when it crosses.

#[derive(Clone)]
struct Origin {
    at_consumer_frame: u64,
    path: String,
    duration_seconds: f64,
    start_offset_seconds: f64,
}

#[derive(Default)]
struct Origins {
    pending: VecDeque<Origin>,
    // Most recently activated origin (frames_played has reached its
    // at_consumer_frame). None until the first origin activates.
    current: Option<Origin>,
}

// === Event payloads ===

#[derive(Serialize, Clone)]
pub struct TrackChangedEvent {
    pub path: String,
    pub duration: f64,
}

#[derive(Serialize, Clone)]
pub struct PositionEvent {
    pub seconds: f64,
}

#[derive(Serialize, Clone)]
pub struct StateEvent {
    pub playing: bool,
    pub has_track: bool,
}

#[derive(Serialize, Clone)]
pub struct ErrorEvent {
    pub path: String,
    pub message: String,
}

// Now-playing info for a radio stream. `station` comes from the icy-name
// response header on connect; `title` is the latest in-band StreamTitle.
// Emitted on every (re)connect and whenever the title changes.
#[derive(Serialize, Clone)]
pub struct StreamMetadataEvent {
    pub station: Option<String>,
    pub title: Option<String>,
}

// === Public handle ===

pub struct AudioEngine {
    pub cmd_tx: Sender<Command>,
    shared: Arc<SharedState>,
}

impl AudioEngine {
    pub fn send(&self, cmd: Command) {
        // The decode thread lives for the whole process, so send only fails if
        // the channel was somehow closed (shouldn't happen). Log and move on.
        if let Err(e) = self.cmd_tx.send(cmd) {
            log::error!("audio: failed to send command: {}", e);
        }
    }

    pub fn set_volume(&self, v: f32) {
        let clamped = v.clamp(0.0, 1.0);
        self.shared
            .volume
            .store(clamped.to_bits(), Ordering::Relaxed);
    }
}

// === Engine startup ===

pub fn start(app: AppHandle) -> Result<AudioEngine, String> {
    let host = cpal::default_host();
    let device = host
        .default_output_device()
        .ok_or_else(|| "no default output device".to_string())?;

    // Prefer the device's default config. We force stereo and f32; if the
    // device's preferred sample format isn't f32 we still try f32 (cpal
    // converts via the StreamConfig path with format mismatch errors surfaced
    // at build_output_stream time). Most modern OSes are f32 native.
    let default_cfg = device
        .default_output_config()
        .map_err(|e| format!("default_output_config: {e}"))?;
    let output_rate = default_cfg.sample_rate().0;
    let sample_format = default_cfg.sample_format();

    let stream_cfg = StreamConfig {
        channels: OUT_CHANNELS as u16,
        sample_rate: SampleRate(output_rate),
        // None lets cpal choose. Letting the OS pick keeps latency reasonable
        // without us hard-coding a buffer that some backend rejects.
        buffer_size: cpal::BufferSize::Default,
    };

    log::info!(
        "audio: device={} rate={} format={:?} channels={}",
        device.name().unwrap_or_else(|_| "<unknown>".into()),
        output_rate,
        sample_format,
        OUT_CHANNELS,
    );

    // Ring buffer in samples (not frames). Stereo → 2 samples per frame.
    let ring_samples = (output_rate as f32 * RING_BUFFER_SECONDS) as usize * OUT_CHANNELS;
    let (rb_producer, rb_consumer) = RingBuffer::<f32>::new(ring_samples);

    let shared = Arc::new(SharedState::new());
    let origins = Arc::new(Mutex::new(Origins::default()));
    let (cmd_tx, cmd_rx) = crossbeam_channel::unbounded::<Command>();

    // Audio callback thread (cpal-owned). The closure captures rb_consumer +
    // a clone of shared and runs exclusively from cpal's output thread. The
    // stream is parked on its own keeper thread because cpal::Stream is !Send
    // on some backends (CoreAudio), so we can't store it in Tauri-managed
    // state. The keeper thread holds it forever; the OS reclaims at exit.
    {
        let device = device.clone();
        let stream_cfg = stream_cfg.clone();
        let shared = Arc::clone(&shared);
        let (ready_tx, ready_rx) = std::sync::mpsc::sync_channel::<Result<(), String>>(1);
        std::thread::Builder::new()
            .name("audio-output".into())
            .spawn(move || {
                let stream = match build_stream(
                    &device,
                    &stream_cfg,
                    sample_format,
                    rb_consumer,
                    shared,
                ) {
                    Ok(s) => s,
                    Err(e) => {
                        let _ = ready_tx.send(Err(e));
                        return;
                    }
                };
                if let Err(e) = stream.play() {
                    let _ = ready_tx.send(Err(format!("stream.play: {e}")));
                    return;
                }
                let _ = ready_tx.send(Ok(()));
                // Park forever. Dropping the stream would tear the device
                // down; we want the opposite.
                loop {
                    std::thread::park();
                }
            })
            .map_err(|e| format!("spawn output thread: {e}"))?;
        ready_rx
            .recv()
            .map_err(|e| format!("output thread setup: {e}"))??;
    }

    // Decode thread.
    {
        let shared = Arc::clone(&shared);
        let origins = Arc::clone(&origins);
        let app = app.clone();
        std::thread::Builder::new()
            .name("audio-decode".into())
            .spawn(move || {
                decode_loop(rb_producer, shared, origins, cmd_rx, app, output_rate);
            })
            .map_err(|e| format!("spawn decode thread: {e}"))?;
    }

    // Position-emit thread.
    {
        let shared = Arc::clone(&shared);
        let origins = Arc::clone(&origins);
        let app = app.clone();
        std::thread::Builder::new()
            .name("audio-position".into())
            .spawn(move || {
                position_emit_loop(shared, origins, app, output_rate);
            })
            .map_err(|e| format!("spawn position thread: {e}"))?;
    }

    Ok(AudioEngine { cmd_tx, shared })
}

// === Audio callback ===
//
// Real-time safe. Reads from the ring buffer, applies volume, writes to the
// output. Nothing else.

struct ConsumerState {
    rb: RbConsumer<f32>,
    shared: Arc<SharedState>,
    // Local cache of the flush generation observed at the last callback. When
    // shared.flush_gen drifts ahead of this, we drain stale audio before
    // reading. Stored in the closure (not an atomic) since only the audio
    // thread ever reads or writes it.
    last_flush_gen: u64,
}

fn build_stream(
    device: &cpal::Device,
    cfg: &StreamConfig,
    sample_format: SampleFormat,
    rb: RbConsumer<f32>,
    shared: Arc<SharedState>,
) -> Result<cpal::Stream, String> {
    let mut state = ConsumerState {
        rb,
        shared,
        last_flush_gen: 0,
    };

    let err_fn = |err| {
        // Stream errors usually mean the device went away (hot-unplug, OS
        // session moved). Log it; the rest of the engine keeps running and the
        // user can resume after re-plugging. A proper hot-swap policy is left
        // as future work.
        log::error!("audio: stream error: {err}");
    };

    // We always feed cpal f32 (Symphonia + rubato already give us f32). If the
    // device's preferred format isn't f32, cpal will fail to build the stream;
    // we surface that loudly rather than silently converting.
    if sample_format != SampleFormat::F32 {
        return Err(format!(
            "device sample format {sample_format:?} not supported (only F32)"
        ));
    }

    let stream = device
        .build_output_stream(
            cfg,
            move |out: &mut [f32], _: &cpal::OutputCallbackInfo| {
                fill_output(&mut state, out);
            },
            err_fn,
            None,
        )
        .map_err(|e| format!("build_output_stream: {e}"))?;
    Ok(stream)
}

fn fill_output(state: &mut ConsumerState, out: &mut [f32]) {
    // Flush on generation change. Done BEFORE reading new samples so the
    // ring is empty of stale audio by the time we pull from it.
    let cur_gen = state.shared.flush_gen.load(Ordering::Acquire);
    if cur_gen != state.last_flush_gen {
        let avail = state.rb.slots();
        if avail > 0 {
            // SAFETY: rtrb's read_chunk returns at most `avail` samples;
            // committing the full chunk is the documented drain pattern.
            if let Ok(read) = state.rb.read_chunk(avail) {
                let drained_samples = read.len();
                read.commit_all();
                state
                    .shared
                    .total_drained
                    .fetch_add((drained_samples / OUT_CHANNELS) as u64, Ordering::Relaxed);
            }
        }
        state.last_flush_gen = cur_gen;
        // Tell the decode thread the ring is drained and it's safe to push
        // new audio. Release pairs with the decode thread's Acquire load.
        state
            .shared
            .flush_gen_acked
            .store(cur_gen, Ordering::Release);
    }

    let paused = state.shared.paused.load(Ordering::Relaxed);
    if paused {
        for s in out.iter_mut() {
            *s = 0.0;
        }
        return;
    }

    let volume = f32::from_bits(state.shared.volume.load(Ordering::Relaxed));

    let want = out.len();
    let avail = state.rb.slots();
    let take = avail.min(want);

    let mut written = 0;
    if take > 0 {
        if let Ok(read) = state.rb.read_chunk(take) {
            let (a, b) = read.as_slices();
            for &v in a.iter() {
                out[written] = v * volume;
                written += 1;
            }
            for &v in b.iter() {
                out[written] = v * volume;
                written += 1;
            }
            read.commit_all();
        }
    }

    // Silence the rest. Underrun feels like a gap but is reported as one to
    // the device clock; we just produce zeros so the callback returns clean.
    for s in out[written..].iter_mut() {
        *s = 0.0;
    }

    // Frame-count update. `written` is in samples; divide by channels.
    let frames = (written / OUT_CHANNELS) as u64;
    state.shared.frames_played.fetch_add(frames, Ordering::Relaxed);
}

// === Decode loop ===
//
// Owns the queue, the current Symphonia reader/decoder, and the rubato
// resampler. Pumps PCM into the ring buffer until the queue is exhausted or
// a control command interrupts.

struct TrackReader {
    reader: Box<dyn FormatReader>,
    decoder: Box<dyn Decoder>,
    track_id: u32,
    input_rate: u32,
    input_channels: usize,
    duration_seconds: f64,
    path: String,
    // Resampler kept across decode calls so internal state (sinc taps) carries
    // over between symphonia packets. Recreated per-track because input rate
    // or channel count may change.
    resampler: SincFixedIn<f32>,
    // Pending input frames that haven't been resampled yet (we feed rubato in
    // fixed-size chunks). One Vec per channel.
    pending_in: Vec<Vec<f32>>,
    // Whether we've sent the resampler its last partial chunk.
    flushed: bool,
}

fn decode_loop(
    mut rb: RbProducer<f32>,
    shared: Arc<SharedState>,
    origins: Arc<Mutex<Origins>>,
    cmd_rx: Receiver<Command>,
    app: AppHandle,
    output_rate: u32,
) {
    let mut queue: Vec<PathBuf> = Vec::new();
    let mut queue_idx: usize = 0;
    let mut current: Option<TrackReader> = None;
    // Radio session. Mutually exclusive with `current`: Play/PlayStream/Stop
    // each clear the other mode before installing their own source.
    let mut stream: Option<StreamSession> = None;

    // Producer-side cumulative stereo frames pushed since the last full reset
    // (Play command). Matches shared.total_produced.
    let mut producer_frames: u64 = 0;

    loop {
        // Drain commands non-blocking. Most iterations have none; when a
        // command does arrive it's usually one of TogglePause/Seek/Stop.
        loop {
            match cmd_rx.try_recv() {
                Ok(cmd) => match cmd {
                    Command::Play {
                        tracks,
                        start_index,
                    } => {
                        if tracks.is_empty() {
                            continue;
                        }
                        let start = start_index.min(tracks.len().saturating_sub(1));
                        queue = tracks;
                        queue_idx = start;
                        stream = None;
                        producer_frames = 0;
                        reset_for_new_playback(&shared, &origins);
                        emit_state(&app, true, true);
                        current = advance_to_next_playable(
                            &queue,
                            &mut queue_idx,
                            output_rate,
                            producer_frames,
                            &shared,
                            &origins,
                            &app,
                        );
                        if current.is_none() {
                            shared.queue_exhausted.store(true, Ordering::Relaxed);
                            emit_state(&app, false, false);
                        }
                    }
                    Command::PlayStream { url } => {
                        queue.clear();
                        queue_idx = 0;
                        current = None;
                        producer_frames = 0;
                        reset_for_new_playback(&shared, &origins);
                        emit_state(&app, true, true);
                        stream = Some(StreamSession::new(url));
                    }
                    Command::TogglePause => {
                        // Only meaningful if there's a current source. Toggling
                        // pause with nothing loaded is a no-op so the UI's
                        // "play button after queue ended" can call Play
                        // (frontend's responsibility, not ours).
                        if current.is_some() || stream.is_some() {
                            let now = !shared.paused.load(Ordering::Relaxed);
                            shared.paused.store(now, Ordering::Relaxed);
                            if let Some(ref mut s) = stream {
                                if now {
                                    // Live radio pause = disconnect. Resume
                                    // must rejoin the live edge, not replay a
                                    // stale buffer, so drop the connection and
                                    // drain what's already decoded.
                                    s.reader = None;
                                    flush_and_wait(&shared);
                                } else {
                                    // Resume = fresh connection at the live
                                    // edge, with retry state cleared so a
                                    // give-up doesn't inherit old backoff.
                                    s.reset_retry();
                                }
                            }
                            emit_state(&app, !now, true);
                        }
                    }
                    Command::Seek(secs) => {
                        if let Some(ref mut tr) = current {
                            let target = secs.max(0.0).min(tr.duration_seconds);
                            // Reset resampler state — internal sinc taps from
                            // the old position would otherwise bleed a few ms
                            // of old audio into the new position.
                            tr.resampler = make_resampler(tr.input_rate, output_rate, tr.input_channels);
                            tr.pending_in = vec![Vec::new(); tr.input_channels];
                            tr.flushed = false;
                            seek_track(tr, target);
                            // Bump flush_gen and wait for the callback to ack
                            // the drain. Without the wait, the next callback
                            // could race the producer's first post-seek push
                            // and discard those new samples too.
                            flush_and_wait(&shared);
                            // Capture frames_played AFTER the drain. Any
                            // callback that fired during flush_and_wait
                            // drained (not played), so frames_played reflects
                            // "audio already played out the speakers." Origins
                            // published with at_consumer_frame = this value
                            // will activate when the new audio reaches the
                            // device.
                            let at = shared.frames_played.load(Ordering::Acquire);
                            // Reset producer_frames so it stays in sync with
                            // origins (origins are published using
                            // producer_frames - total_drained, and the
                            // upcoming flush will add `slots_buffered` to
                            // total_drained; resetting both is simpler than
                            // tracking the delta).
                            producer_frames = at + shared.total_drained.load(Ordering::Relaxed);
                            publish_origin(
                                &origins,
                                &shared,
                                producer_frames,
                                &tr.path,
                                tr.duration_seconds,
                                target,
                            );
                            // Resume if paused — seek implies the user wants
                            // to hear the new position.
                            if shared.paused.load(Ordering::Relaxed) {
                                shared.paused.store(false, Ordering::Relaxed);
                                emit_state(&app, true, true);
                            }
                        }
                    }
                    Command::Stop => {
                        queue.clear();
                        queue_idx = 0;
                        current = None;
                        stream = None;
                        producer_frames = 0;
                        reset_for_new_playback(&shared, &origins);
                        shared.queue_exhausted.store(true, Ordering::Relaxed);
                        emit_state(&app, false, false);
                    }
                },
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => return,
            }
        }

        // Idle conditions: paused, or nothing loaded. In both cases sleep
        // briefly and re-check commands. We don't block on the channel because
        // the audio callback continues running and we want fast response on
        // resume. A paused stream holds no connection (dropped at pause time),
        // so idling here costs nothing.
        if shared.paused.load(Ordering::Relaxed) {
            std::thread::sleep(Duration::from_millis(10));
            continue;
        }

        // Radio mode: connect / decode / reconnect as needed.
        if let Some(ref mut s) = stream {
            if !stream_step(s, &mut rb, &shared, &app, &mut producer_frames, output_rate) {
                // Outage exceeded the give-up budget. Keep the session but
                // pause it: the play button becomes "try again" (unpause
                // resets retry state and reconnects).
                shared.paused.store(true, Ordering::Relaxed);
                emit_state(&app, false, true);
            }
            continue;
        }

        if current.is_none() {
            std::thread::sleep(Duration::from_millis(10));
            continue;
        }

        // Decode + push the next chunk.
        let tr = current.as_mut().unwrap();
        match decode_and_push(tr, &mut rb, &shared, &mut producer_frames) {
            Ok(StepOutcome::Continue) => {}
            Ok(StepOutcome::TrackEnded) => {
                queue_idx += 1;
                current = advance_to_next_playable(
                    &queue,
                    &mut queue_idx,
                    output_rate,
                    producer_frames,
                    &shared,
                    &origins,
                    &app,
                );
                if current.is_none() {
                    // Queue exhausted (or every remaining track failed to
                    // open). Leave current=None; the position-emit thread
                    // will fire queue-ended once playback drains.
                    shared.queue_exhausted.store(true, Ordering::Relaxed);
                }
            }
            Err(e) => {
                log::warn!("audio: decode error: {e}");
                let path = tr.path.clone();
                emit_error(&app, &PathBuf::from(&path), &e);
                queue_idx += 1;
                current = advance_to_next_playable(
                    &queue,
                    &mut queue_idx,
                    output_rate,
                    producer_frames,
                    &shared,
                    &origins,
                    &app,
                );
                if current.is_none() {
                    shared.queue_exhausted.store(true, Ordering::Relaxed);
                }
            }
        }
    }
}

enum StepOutcome {
    Continue,
    TrackEnded,
}

// === Radio streams ===
//
// A StreamSession outlives its connection: `reader` is Some while connected
// and None while paused, between reconnect attempts, or after give-up. The
// URL and retry bookkeeping persist so pause/resume and reconnects don't
// lose the station.

struct StreamSession {
    url: String,
    reader: Option<TrackReader>,
    // Shared with the IcyReader inside `reader`'s media source; it writes
    // titles as they arrive in-band, we poll between decode steps.
    title: Arc<Mutex<Option<String>>>,
    station: Option<String>,
    // Last title emitted to the frontend. Deliberately survives reconnects
    // (pause/resume, outage recovery) so the now-playing line isn't blanked
    // just to fade the same text back in moments later.
    last_title: Option<String>,
    retry_delay: Duration,
    next_attempt_at: Instant,
    // When the current outage began (first failed connect or the moment the
    // connection dropped). None while healthy. Give-up triggers when an
    // outage outlasts STREAM_GIVE_UP.
    outage_since: Option<Instant>,
}

impl StreamSession {
    fn new(url: String) -> Self {
        Self {
            url,
            reader: None,
            title: Arc::new(Mutex::new(None)),
            station: None,
            last_title: None,
            retry_delay: STREAM_RETRY_INITIAL,
            next_attempt_at: Instant::now(),
            outage_since: None,
        }
    }

    fn reset_retry(&mut self) {
        self.retry_delay = STREAM_RETRY_INITIAL;
        self.next_attempt_at = Instant::now();
        self.outage_since = None;
    }

    // Records a failed connect and schedules the next attempt with backoff.
    // Returns false when the outage has exhausted the give-up budget.
    fn connect_failed(&mut self, app: &AppHandle, err: &str) -> bool {
        log::warn!("audio: stream {}: {err}", self.url);
        let now = Instant::now();
        let began = *self.outage_since.get_or_insert(now);
        if now.duration_since(began) >= STREAM_GIVE_UP {
            emit_error(
                app,
                &PathBuf::from(&self.url),
                &format!("stream unavailable: {err}"),
            );
            return false;
        }
        self.next_attempt_at = now + self.retry_delay;
        self.retry_delay = (self.retry_delay * 2).min(STREAM_RETRY_MAX);
        true
    }
}

// One iteration of radio playback: surface title changes, (re)connect when
// disconnected, otherwise decode a chunk into the ring buffer. Returns false
// when the session should give up (caller pauses it).
fn stream_step(
    s: &mut StreamSession,
    rb: &mut RbProducer<f32>,
    shared: &Arc<SharedState>,
    app: &AppHandle,
    producer_frames: &mut u64,
    output_rate: u32,
) -> bool {
    if s.reader.is_none() {
        if Instant::now() < s.next_attempt_at {
            std::thread::sleep(Duration::from_millis(10));
            return true;
        }
        let opened = icy::connect(&s.url).and_then(|conn| open_stream(conn, &s.url, output_rate));
        match opened {
            Ok(o) => {
                log::info!(
                    "audio: stream connected url={} station={:?}",
                    s.url,
                    o.station
                );
                s.reader = Some(o.reader);
                s.title = o.title;
                s.station = o.station;
                s.reset_retry();
                // Announce the station immediately, carrying the last known
                // title across the (re)connect. If the song changed while
                // disconnected, the first in-band title corrects it within
                // seconds.
                emit_stream_metadata(app, &s.station, &s.last_title);
            }
            Err(e) => return s.connect_failed(app, &e),
        }
        return true;
    }

    // Title changes arrive interleaved with audio, exactly on song
    // boundaries; polling between decode steps adds at most one packet of
    // latency (~tens of ms). The Arc only ever moves None -> Some (IcyReader
    // ignores empty StreamTitle blocks), so None means "nothing has arrived
    // on this connection yet", not "title cleared" — without the is_some
    // guard a fresh connection would wipe the carried title.
    let latest = s.title.lock().unwrap_or_else(|e| e.into_inner()).clone();
    if latest.is_some() && latest != s.last_title {
        s.last_title = latest.clone();
        emit_stream_metadata(app, &s.station, &latest);
    }

    let tr = s.reader.as_mut().unwrap();
    match decode_and_push(tr, rb, shared, producer_frames) {
        Ok(StepOutcome::Continue) => true,
        Ok(StepOutcome::TrackEnded) => {
            // The server closed the connection (EOF). Reconnect immediately;
            // whatever is still in the ring buffer plays out meanwhile.
            log::warn!("audio: stream {} disconnected, reconnecting", s.url);
            s.reader = None;
            s.outage_since = Some(Instant::now());
            s.next_attempt_at = Instant::now();
            true
        }
        Err(e) => {
            // Read timeout, socket error, or the codec lost sync past
            // recovery. Same remedy: fresh connection.
            log::warn!("audio: stream {} error: {e}, reconnecting", s.url);
            s.reader = None;
            s.outage_since = Some(Instant::now());
            s.next_attempt_at = Instant::now();
            true
        }
    }
}

struct OpenedStream {
    reader: TrackReader,
    title: Arc<Mutex<Option<String>>>,
    station: Option<String>,
}

// Builds the decode chain for a connected stream. Mirrors open_track, except
// the source is non-seekable, duration is unknown (0 = "live" to the UI),
// and gapless trimming is meaningless mid-stream.
fn open_stream(
    conn: icy::IcyConnection,
    url: &str,
    output_rate: u32,
) -> Result<OpenedStream, String> {
    let title = Arc::clone(&conn.title);
    let station = conn.station_name.clone();

    let mss = MediaSourceStream::new(
        Box::new(icy::NetSource::new(conn.reader)),
        Default::default(),
    );
    let mut hint = Hint::new();
    if let Some(ct) = conn.content_type.as_deref() {
        hint.mime_type(ct);
    }
    let fmt_opts = FormatOptions {
        enable_gapless: false,
        ..Default::default()
    };
    let meta_opts: MetadataOptions = Default::default();

    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &fmt_opts, &meta_opts)
        .map_err(|e| format!("probe: {e}"))?;
    let reader = probed.format;

    let track = reader
        .tracks()
        .iter()
        .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
        .ok_or_else(|| "no decodable audio in stream".to_string())?;
    let track_id = track.id;
    let input_rate = track.codec_params.sample_rate.unwrap_or(44_100);
    let input_channels = track
        .codec_params
        .channels
        .map(|c| c.count())
        .unwrap_or(2)
        .max(1);
    let decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|e| format!("codec init: {e}"))?;
    let resampler = make_resampler(input_rate, output_rate, input_channels);

    Ok(OpenedStream {
        reader: TrackReader {
            reader,
            decoder,
            track_id,
            input_rate,
            input_channels,
            duration_seconds: 0.0,
            path: url.to_string(),
            resampler,
            pending_in: vec![Vec::new(); input_channels],
            flushed: false,
        },
        title,
        station,
    })
}

fn emit_stream_metadata(app: &AppHandle, station: &Option<String>, title: &Option<String>) {
    let _ = app.emit(
        "audio:stream-metadata",
        StreamMetadataEvent {
            station: station.clone(),
            title: title.clone(),
        },
    );
}

// Open the next playable track at or after queue_idx, skipping (and reporting)
// any that fail to open. Returns None when the queue is exhausted. On success,
// publishes the new track's origin so the position-emit thread will pick it up
// as soon as playback reaches it.
fn advance_to_next_playable(
    queue: &[PathBuf],
    queue_idx: &mut usize,
    output_rate: u32,
    producer_frames: u64,
    shared: &Arc<SharedState>,
    origins: &Arc<Mutex<Origins>>,
    app: &AppHandle,
) -> Option<TrackReader> {
    while *queue_idx < queue.len() {
        match open_track(&queue[*queue_idx], output_rate) {
            Some(reader) => {
                publish_origin(
                    origins,
                    shared,
                    producer_frames,
                    &reader.path,
                    reader.duration_seconds,
                    0.0,
                );
                return Some(reader);
            }
            None => {
                emit_error(app, &queue[*queue_idx], "could not open");
                *queue_idx += 1;
            }
        }
    }
    None
}

fn decode_and_push(
    tr: &mut TrackReader,
    rb: &mut RbProducer<f32>,
    shared: &Arc<SharedState>,
    producer_frames: &mut u64,
) -> Result<StepOutcome, String> {
    // Step 1: pull a packet → decode → append to pending_in (planar).
    let packet = match tr.reader.next_packet() {
        Ok(p) => p,
        Err(SymError::IoError(ref e))
            if e.kind() == std::io::ErrorKind::UnexpectedEof =>
        {
            // EOF: flush the resampler's tail, push it, then signal end.
            if !tr.flushed {
                let tail = resample_flush(&mut tr.resampler, &tr.pending_in, tr.input_channels)
                    .map_err(|e| format!("resample flush: {e}"))?;
                tr.pending_in = vec![Vec::new(); tr.input_channels];
                tr.flushed = true;
                if !tail.is_empty() {
                    let interleaved = interleave_stereo(&tail, tr.input_channels);
                    push_blocking(rb, &interleaved);
                    let frames = (interleaved.len() / OUT_CHANNELS) as u64;
                    *producer_frames += frames;
                    shared.total_produced.fetch_add(frames, Ordering::Relaxed);
                }
            }
            return Ok(StepOutcome::TrackEnded);
        }
        Err(e) => return Err(format!("next_packet: {e}")),
    };

    if packet.track_id() != tr.track_id {
        return Ok(StepOutcome::Continue);
    }

    let decoded = match tr.decoder.decode(&packet) {
        Ok(d) => d,
        Err(SymError::DecodeError(e)) => {
            // Decode errors on a single packet are recoverable — symphonia
            // recommends skipping the packet and continuing.
            log::warn!("audio: skip packet: {e}");
            return Ok(StepOutcome::Continue);
        }
        Err(e) => return Err(format!("decode: {e}")),
    };

    append_planar(&decoded, &mut tr.pending_in, tr.input_channels);

    // Step 2: while we have a full rubato input chunk, resample + push.
    while tr.pending_in[0].len() >= RESAMPLER_CHUNK_FRAMES {
        let chunk_in: Vec<Vec<f32>> = (0..tr.input_channels)
            .map(|c| tr.pending_in[c].drain(..RESAMPLER_CHUNK_FRAMES).collect())
            .collect();
        let in_refs: Vec<&[f32]> = chunk_in.iter().map(|v| v.as_slice()).collect();
        let out_planar = tr
            .resampler
            .process(&in_refs, None)
            .map_err(|e| format!("resample: {e}"))?;
        let interleaved = interleave_stereo(&out_planar, tr.input_channels);
        push_blocking(rb, &interleaved);
        let frames = (interleaved.len() / OUT_CHANNELS) as u64;
        *producer_frames += frames;
        shared.total_produced.fetch_add(frames, Ordering::Relaxed);
    }

    Ok(StepOutcome::Continue)
}

// Blocking push into the ring buffer. Yields on full buffer and re-checks. We
// don't watch for commands here because commands change shared state (atomics)
// and the next loop iteration picks them up — the worst case is one chunk of
// latency on Pause, ~10ms, which is imperceptible.
fn push_blocking(rb: &mut RbProducer<f32>, samples: &[f32]) {
    let mut idx = 0;
    while idx < samples.len() {
        let avail = rb.slots();
        if avail == 0 {
            std::thread::sleep(Duration::from_millis(5));
            continue;
        }
        let want = (samples.len() - idx).min(avail);
        match rb.write_chunk_uninit(want) {
            Ok(mut chunk) => {
                let (a, b) = chunk.as_mut_slices();
                let mut local = 0;
                for s in a.iter_mut() {
                    s.write(samples[idx + local]);
                    local += 1;
                }
                for s in b.iter_mut() {
                    s.write(samples[idx + local]);
                    local += 1;
                }
                // SAFETY: we initialized exactly `want` slots above.
                unsafe { chunk.commit_all() };
                idx += want;
            }
            Err(_) => {
                std::thread::sleep(Duration::from_millis(5));
            }
        }
    }
}

// === Symphonia helpers ===

fn open_track(path: &std::path::Path, output_rate: u32) -> Option<TrackReader> {
    let file = match File::open(path) {
        Ok(f) => f,
        Err(e) => {
            log::warn!("audio: open {} failed: {e}", path.display());
            return None;
        }
    };

    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }

    // enable_gapless: symphonia consults the file's LAME/Xing header (MP3) or
    // edit lists (M4A/AAC) and trims encoder delay + padding for us. This is
    // the difference between "audible click at every MP3 boundary" and
    // "actually gapless." Verify on a known-gapless album.
    let fmt_opts = FormatOptions {
        enable_gapless: true,
        ..Default::default()
    };
    let meta_opts: MetadataOptions = Default::default();

    let probed = match symphonia::default::get_probe().format(&hint, mss, &fmt_opts, &meta_opts) {
        Ok(p) => p,
        Err(e) => {
            log::warn!("audio: probe {} failed: {e}", path.display());
            return None;
        }
    };
    let reader = probed.format;

    let default_track = reader
        .tracks()
        .iter()
        .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)?;
    let track_id = default_track.id;
    let input_rate = default_track.codec_params.sample_rate.unwrap_or(44_100);
    let input_channels = default_track
        .codec_params
        .channels
        .map(|c| c.count())
        .unwrap_or(2)
        .max(1);
    let duration_seconds = compute_duration_seconds(default_track);

    let decoder = match symphonia::default::get_codecs()
        .make(&default_track.codec_params, &DecoderOptions::default())
    {
        Ok(d) => d,
        Err(e) => {
            log::warn!("audio: codec init {} failed: {e}", path.display());
            return None;
        }
    };

    let resampler = make_resampler(input_rate, output_rate, input_channels);

    Some(TrackReader {
        reader,
        decoder,
        track_id,
        input_rate,
        input_channels,
        duration_seconds,
        path: path.to_string_lossy().to_string(),
        resampler,
        pending_in: vec![Vec::new(); input_channels],
        flushed: false,
    })
}

fn compute_duration_seconds(track: &Track) -> f64 {
    // n_frames is the number of decoded audio frames in the track. Combined
    // with the codec's time_base, it gives us a duration in seconds. Some
    // unusual files don't carry one of these; we report 0 and the UI shows
    // "0:00" but playback still works.
    let tb = match track.codec_params.time_base {
        Some(t) => t,
        None => return 0.0,
    };
    let n_frames = match track.codec_params.n_frames {
        Some(n) => n,
        None => return 0.0,
    };
    let t = tb.calc_time(n_frames);
    t.seconds as f64 + t.frac
}

fn seek_track(tr: &mut TrackReader, target_seconds: f64) {
    let secs = target_seconds.trunc() as u64;
    let frac = target_seconds - secs as f64;
    let _ = tr.reader.seek(
        SeekMode::Accurate,
        SeekTo::Time {
            time: Time {
                seconds: secs,
                frac,
            },
            track_id: Some(tr.track_id),
        },
    );
    // After seek, the decoder state is suspect; reset it.
    tr.decoder.reset();
}

fn make_resampler(input_rate: u32, output_rate: u32, channels: usize) -> SincFixedIn<f32> {
    let params = SincInterpolationParameters {
        sinc_len: 256,
        f_cutoff: 0.95,
        interpolation: SincInterpolationType::Linear,
        oversampling_factor: 256,
        window: WindowFunction::BlackmanHarris2,
    };
    let ratio = output_rate as f64 / input_rate as f64;
    SincFixedIn::<f32>::new(
        ratio,
        // max_resample_ratio_relative — used by rubato for buffer sizing. 2.0
        // is plenty since input/output rates are fixed within a track.
        2.0,
        params,
        RESAMPLER_CHUNK_FRAMES,
        channels,
    )
    .expect("resampler init")
}

fn append_planar(decoded: &AudioBufferRef<'_>, into: &mut [Vec<f32>], expected_channels: usize) {
    // Decoded buffer may be any sample format; we convert to f32 planar.
    // Symphonia's AudioBufferRef::convert() helps but the explicit per-format
    // path here is clearer and avoids an extra allocation.
    let channels = decoded.spec().channels.count().min(expected_channels);
    match decoded {
        AudioBufferRef::F32(buf) => {
            for c in 0..channels {
                into[c].extend_from_slice(buf.chan(c));
            }
        }
        AudioBufferRef::F64(buf) => {
            for c in 0..channels {
                into[c].extend(buf.chan(c).iter().map(|&v| v as f32));
            }
        }
        AudioBufferRef::S32(buf) => {
            let scale = 1.0 / (i32::MAX as f32);
            for c in 0..channels {
                into[c].extend(buf.chan(c).iter().map(|&v| v as f32 * scale));
            }
        }
        AudioBufferRef::S24(buf) => {
            // S24 samples ride in i32 with values in [-2^23, 2^23-1].
            let scale = 1.0 / 8_388_608.0;
            for c in 0..channels {
                into[c].extend(buf.chan(c).iter().map(|&v| v.inner() as f32 * scale));
            }
        }
        AudioBufferRef::S16(buf) => {
            let scale = 1.0 / (i16::MAX as f32);
            for c in 0..channels {
                into[c].extend(buf.chan(c).iter().map(|&v| v as f32 * scale));
            }
        }
        AudioBufferRef::S8(buf) => {
            let scale = 1.0 / (i8::MAX as f32);
            for c in 0..channels {
                into[c].extend(buf.chan(c).iter().map(|&v| v as f32 * scale));
            }
        }
        AudioBufferRef::U32(buf) => {
            let scale = 1.0 / (u32::MAX as f32 / 2.0);
            for c in 0..channels {
                into[c].extend(buf.chan(c).iter().map(|&v| (v as f32 - u32::MAX as f32 / 2.0) * scale));
            }
        }
        AudioBufferRef::U24(buf) => {
            let scale = 1.0 / 8_388_608.0;
            for c in 0..channels {
                into[c].extend(buf.chan(c).iter().map(|&v| (v.inner() as f32 - 8_388_608.0) * scale));
            }
        }
        AudioBufferRef::U16(buf) => {
            let scale = 1.0 / (i16::MAX as f32);
            for c in 0..channels {
                into[c].extend(buf.chan(c).iter().map(|&v| (v as f32 - 32_768.0) * scale));
            }
        }
        AudioBufferRef::U8(buf) => {
            let scale = 1.0 / 128.0;
            for c in 0..channels {
                into[c].extend(buf.chan(c).iter().map(|&v| (v as f32 - 128.0) * scale));
            }
        }
    }
    // If the source had more channels than expected, the rest are dropped
    // (5.1 → stereo: take L, R only). Acceptable for a music player.
}

fn resample_flush(
    resampler: &mut SincFixedIn<f32>,
    pending_in: &[Vec<f32>],
    channels: usize,
) -> Result<Vec<Vec<f32>>, String> {
    // Feed the resampler one last partial chunk padded with zeros so its
    // internal state flushes the audio tail. Without this, the last ~5ms of
    // every track are lost — a small but real per-track gap.
    let chunk_size = RESAMPLER_CHUNK_FRAMES;
    let padded: Vec<Vec<f32>> = (0..channels)
        .map(|c| {
            let mut v = pending_in[c].clone();
            v.resize(chunk_size, 0.0);
            v
        })
        .collect();
    let in_refs: Vec<&[f32]> = padded.iter().map(|v| v.as_slice()).collect();
    resampler
        .process(&in_refs, None)
        .map_err(|e| format!("flush: {e}"))
}

fn interleave_stereo(planar: &[Vec<f32>], input_channels: usize) -> Vec<f32> {
    // Output is always stereo. Input channel mapping:
    //   1ch (mono):  L=R=mono
    //   2+ch:        take channels 0 and 1
    if planar.is_empty() || planar[0].is_empty() {
        return Vec::new();
    }
    let frames = planar[0].len();
    let mut out = Vec::with_capacity(frames * OUT_CHANNELS);
    if input_channels == 1 {
        for i in 0..frames {
            let v = planar[0][i];
            out.push(v);
            out.push(v);
        }
    } else {
        for i in 0..frames {
            out.push(planar[0][i]);
            out.push(planar[1][i]);
        }
    }
    out
}

// === State helpers ===

fn reset_for_new_playback(shared: &Arc<SharedState>, origins: &Arc<Mutex<Origins>>) {
    // Bump flush_gen first so the callback drains any stale audio from the
    // previous Play, then wait for the callback to acknowledge the drain
    // before we reset counters and let new audio be pushed. Without the wait,
    // a callback firing between our bump and the first new push would drain
    // those new samples too — audible as the start of the track being chopped.
    flush_and_wait(shared);
    shared.frames_played.store(0, Ordering::Relaxed);
    shared.total_drained.store(0, Ordering::Relaxed);
    shared.total_produced.store(0, Ordering::Relaxed);
    shared.queue_exhausted.store(false, Ordering::Relaxed);
    shared.paused.store(false, Ordering::Relaxed);
    let mut o = origins.lock().unwrap_or_else(|e| e.into_inner());
    o.pending.clear();
    o.current = None;
}

// Bump flush_gen and block until the audio callback has acknowledged the
// drain. Bounded by a short timeout so a stuck/disconnected output device
// can't hang command processing forever; the audible glitch on timeout is
// strictly less bad than a frozen player.
fn flush_and_wait(shared: &SharedState) {
    let prev = shared.flush_gen.fetch_add(1, Ordering::Release);
    let target = prev + 1;
    let deadline = std::time::Instant::now() + Duration::from_millis(100);
    while shared.flush_gen_acked.load(Ordering::Acquire) < target {
        if std::time::Instant::now() >= deadline {
            return;
        }
        std::thread::sleep(Duration::from_millis(1));
    }
}

fn publish_origin(
    origins: &Arc<Mutex<Origins>>,
    shared: &Arc<SharedState>,
    producer_frames: u64,
    path: &str,
    duration_seconds: f64,
    start_offset_seconds: f64,
) {
    let drained = shared.total_drained.load(Ordering::Relaxed);
    let at_consumer_frame = producer_frames.saturating_sub(drained);
    let mut o = origins.lock().unwrap_or_else(|e| e.into_inner());
    o.pending.push_back(Origin {
        at_consumer_frame,
        path: path.to_string(),
        duration_seconds,
        start_offset_seconds,
    });
}

// === Position-emit thread ===

fn position_emit_loop(
    shared: Arc<SharedState>,
    origins: Arc<Mutex<Origins>>,
    app: AppHandle,
    output_rate: u32,
) {
    let mut last_emitted_position: f64 = -1.0;
    let mut last_emitted_path: Option<String> = None;
    let mut queue_ended_sent = false;

    loop {
        std::thread::sleep(Duration::from_millis(POSITION_EMIT_INTERVAL_MS));

        let frames_played = shared.frames_played.load(Ordering::Relaxed);

        // Activate any origins the consumer has now passed.
        let (active_origin, advanced_to_new_track) = {
            let mut o = origins.lock().unwrap_or_else(|e| e.into_inner());
            let mut advanced = false;
            while let Some(front) = o.pending.front() {
                if front.at_consumer_frame <= frames_played {
                    let act = o.pending.pop_front().unwrap();
                    o.current = Some(act);
                    advanced = true;
                } else {
                    break;
                }
            }
            (o.current.clone(), advanced)
        };

        match active_origin {
            Some(origin) => {
                let delta_frames = frames_played.saturating_sub(origin.at_consumer_frame);
                let position = origin.start_offset_seconds
                    + delta_frames as f64 / output_rate as f64;
                let position = position.min(origin.duration_seconds);

                if advanced_to_new_track
                    || last_emitted_path.as_deref() != Some(origin.path.as_str())
                {
                    let _ = app.emit(
                        "audio:track-changed",
                        TrackChangedEvent {
                            path: origin.path.clone(),
                            duration: origin.duration_seconds,
                        },
                    );
                    last_emitted_path = Some(origin.path.clone());
                    queue_ended_sent = false;
                }

                // Emit position only when it changes (the seekbar in the UI is
                // re-rendered from this; spamming identical values is wasted).
                if (position - last_emitted_position).abs() > 0.01 {
                    let _ = app.emit("audio:position", PositionEvent { seconds: position });
                    last_emitted_position = position;
                }

                // Queue-ended detection: producer is done AND playback has
                // caught up to total_produced.
                if shared.queue_exhausted.load(Ordering::Relaxed)
                    && !queue_ended_sent
                {
                    let produced = shared.total_produced.load(Ordering::Relaxed);
                    if frames_played >= produced {
                        let _ = app.emit("audio:queue-ended", ());
                        let _ = app.emit(
                            "audio:state",
                            StateEvent {
                                playing: false,
                                has_track: true,
                            },
                        );
                        queue_ended_sent = true;
                    }
                }
            }
            None => {
                // No track active yet (or after Stop). Reset emit cache so a
                // subsequent track-changed re-fires.
                last_emitted_position = -1.0;
                last_emitted_path = None;
                queue_ended_sent = false;
            }
        }
    }
}

fn emit_state(app: &AppHandle, playing: bool, has_track: bool) {
    let _ = app.emit("audio:state", StateEvent { playing, has_track });
}

fn emit_error(app: &AppHandle, path: &std::path::Path, message: &str) {
    let _ = app.emit(
        "audio:error",
        ErrorEvent {
            path: path.to_string_lossy().to_string(),
            message: message.to_string(),
        },
    );
}
