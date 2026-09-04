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
// Seek and queue-change use a flush generation counter (AtomicU64). The decode
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
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicU8, Ordering};
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

use lofty::prelude::*;

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

// Waveform (visualizer) tap. The audio callback copies the samples it just
// wrote into a second ring buffer; a background thread drains it and emits
// ~30 Hz frames of the most recent oscilloscope waveform, decimated to a fixed
// point count. Event-based (not a Tauri Channel); the frontend owns the look.
const WAVEFORM_EMIT_INTERVAL_MS: u64 = 33;
// Sliding window of mono samples the scope is drawn from (~21 ms at 48 kHz).
const WAVEFORM_WINDOW: usize = 1024;
// Points emitted per frame — the window decimated down to this many amplitudes.
const WAVEFORM_POINTS: usize = 256;
// Longer mono window used only for the per-band spectrum (audio:spectrum). ~85 ms
// at 48 kHz — enough periods to resolve the lowest EQ band (32 Hz ≈ 31 ms) via
// Goertzel. The oscilloscope keeps its own shorter WAVEFORM_WINDOW.
const SPECTRUM_WINDOW: usize = 4096;
// Perceptual gain applied to each band's RMS magnitude before clamping to [0,1].
// Tuned so ordinary program material rests around accent and strong passages push
// the band toward white; raise to whiten more eagerly.
const SPECTRUM_GAIN: f32 = 3.2;

// rubato chunk size in input frames. Larger = better resampling efficiency,
// smaller = lower latency. 1024 is the conventional sweet spot.
const RESAMPLER_CHUNK_FRAMES: usize = 1024;

// Equalizer. A classic graphic EQ: one RBJ peaking biquad per band at these
// ~octave-spaced center frequencies, in series, plus a wideband preamp. We run
// it in the real-time callback (not the decode thread) so a slider move is
// audible immediately rather than after the ~1s ring buffer drains. The shared
// Q suits octave spacing (adjacent bands overlap gently rather than leaving
// dips between them).
const EQ_FREQS: [f32; 10] = [
    32.0, 64.0, 125.0, 250.0, 500.0, 1000.0, 2000.0, 4000.0, 8000.0, 16000.0,
];
const EQ_BAND_COUNT: usize = EQ_FREQS.len();
const EQ_Q: f32 = 1.41;

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
    // Drop everything queued after the currently playing track, leaving it to
    // play to its natural end and then report queue-ended. Lets the frontend
    // re-decide the next track (shuffle / repeat-one) without disturbing — or
    // restarting — the audible track.
    ClearUpcoming,
    // Append tracks to the tail of the current queue. During ongoing straight
    // play the running decode simply reaches them via auto-advance — no flush,
    // no restart. If the queue had already drained (or was empty), playback
    // resumes into the appended tracks. Used by "Add to queue".
    Append {
        tracks: Vec<PathBuf>,
    },
    // Tear everything down: drop the queue/stream, silence the device, and
    // report no track so the transport disables. Backs "Clear queue".
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
    // discarded (seek, new Play). The audio callback compares it to its
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
    // Bumped on every new playback session (reset_for_new_playback). Stamped
    // onto each origin so the position thread can tell a genuine (re)Play apart
    // from a seek's re-publish of the current origin: replaying the *same* track
    // reuses its slot index and path, so without the epoch the track-changed
    // guard would suppress the event and the frontend would never re-learn the
    // track's duration (seek bar stuck at max=0). A seek keeps the epoch, so it
    // still doesn't spuriously re-fire track-changed.
    play_epoch: AtomicU64,
    // Equalizer parameters, written by the UI thread and read by the audio
    // callback. `eq_enabled` bypasses the whole chain when false. `eq_preamp_db`
    // is a wideband gain; `eq_gains_db` holds the per-band peaking gains, all in
    // dB stored as f32 bits. `eq_gen` is bumped on any change so the callback
    // knows to recompute its cached biquad coefficients (the trig/pow math is
    // too heavy to redo every callback, so it only runs on a gen change).
    eq_enabled: AtomicBool,
    eq_preamp_db: AtomicU32,
    eq_gains_db: [AtomicU32; EQ_BAND_COUNT],
    eq_gen: AtomicU64,
    // ReplayGain (volume normalization) mode: 0 = off, 1 = track, 2 = album.
    // Read once per track when it's opened (open_track), where the file's
    // REPLAYGAIN_* tags are turned into a constant per-track gain baked into the
    // decoded samples — so unlike the EQ (a live callback effect) a mode change
    // only takes effect on the next track opened, not the one already decoding.
    rg_mode: AtomicU8,
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
            play_epoch: AtomicU64::new(0),
            eq_enabled: AtomicBool::new(false),
            eq_preamp_db: AtomicU32::new(0.0_f32.to_bits()),
            eq_gains_db: std::array::from_fn(|_| AtomicU32::new(0.0_f32.to_bits())),
            eq_gen: AtomicU64::new(0),
            rg_mode: AtomicU8::new(0),
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
    // The playback session that produced this origin (SharedState::play_epoch).
    // Distinguishes a genuine (re)Play from a seek's same-track re-publish.
    epoch: u64,
    at_consumer_frame: u64,
    // The queue slot this origin describes. Lets the consumer side name the
    // *audible* track unambiguously (path alone is ambiguous with duplicate
    // rows) — Seek re-seats the decode frontier onto it. See decode_loop.
    queue_index: usize,
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

// Visualizer waveform frame: `samples` are the most recent oscilloscope
// amplitudes in roughly [-1, 1], left to right. Emitted ~30 Hz while playing.
#[derive(Serialize, Clone)]
pub struct WaveformEvent {
    pub samples: Vec<f32>,
}

// Per-band spectrum frame for the equalizer's live fade: one normalized energy
// (0..1) per EQ_FREQS band, computed by Goertzel over the recent audio. Emitted
// on the same ~30 Hz cadence as the waveform while playing.
#[derive(Serialize, Clone)]
pub struct SpectrumEvent {
    pub bands: Vec<f32>,
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

    // Update the equalizer. `gains_db` are the per-band peaking gains (any extra
    // entries are ignored, any missing ones left unchanged is not a concern
    // since the frontend always sends the full set). Publishing the gen last,
    // with Release ordering, is what makes the callback pick up the new values.
    pub fn set_eq(&self, enabled: bool, preamp_db: f32, gains_db: &[f32]) {
        self.shared.eq_enabled.store(enabled, Ordering::Relaxed);
        self.shared
            .eq_preamp_db
            .store(preamp_db.to_bits(), Ordering::Relaxed);
        for (slot, g) in self.shared.eq_gains_db.iter().zip(gains_db.iter()) {
            slot.store(g.to_bits(), Ordering::Relaxed);
        }
        self.shared.eq_gen.fetch_add(1, Ordering::Release);
    }

    // Set the ReplayGain mode (0 = off, 1 = track, 2 = album). Read by the decode
    // thread each time it opens a track, so it applies from the next track on.
    pub fn set_replaygain(&self, mode: u8) {
        self.shared.rg_mode.store(mode, Ordering::Relaxed);
    }
}

// === Equalizer DSP ===

// A single RBJ-cookbook biquad in Direct Form II transposed. Coefficients are
// recomputed when a band's gain changes; the per-channel state (s1/s2) carries
// across those updates and across track boundaries so there's no click.
#[derive(Clone, Copy)]
struct Biquad {
    b0: f32,
    b1: f32,
    b2: f32,
    a1: f32,
    a2: f32,
    s1: [f32; OUT_CHANNELS],
    s2: [f32; OUT_CHANNELS],
}

impl Biquad {
    // Identity (unity passthrough) until the first coefficient update.
    fn identity() -> Self {
        Self {
            b0: 1.0,
            b1: 0.0,
            b2: 0.0,
            a1: 0.0,
            a2: 0.0,
            s1: [0.0; OUT_CHANNELS],
            s2: [0.0; OUT_CHANNELS],
        }
    }

    // RBJ "peaking EQ" design. Preserves the delay state so re-tuning while
    // audio flows doesn't glitch.
    fn set_peaking(&mut self, f0: f32, fs: f32, q: f32, gain_db: f32) {
        let a = 10.0_f32.powf(gain_db / 40.0);
        let w0 = 2.0 * std::f32::consts::PI * f0 / fs;
        let cos_w0 = w0.cos();
        let alpha = w0.sin() / (2.0 * q);
        let a0 = 1.0 + alpha / a;
        self.b0 = (1.0 + alpha * a) / a0;
        self.b1 = (-2.0 * cos_w0) / a0;
        self.b2 = (1.0 - alpha * a) / a0;
        self.a1 = (-2.0 * cos_w0) / a0;
        self.a2 = (1.0 - alpha / a) / a0;
    }

    #[inline]
    fn process(&mut self, x: f32, ch: usize) -> f32 {
        let y = self.b0 * x + self.s1[ch];
        self.s1[ch] = self.b1 * x - self.a1 * y + self.s2[ch];
        self.s2[ch] = self.b2 * x - self.a2 * y;
        y
    }
}

// The callback-side EQ: a cascade of peaking biquads plus a preamp. Lives in
// ConsumerState and is only touched by the audio thread. `refresh` pulls the
// latest parameters when the shared gen counter moves; `process_block` filters
// an interleaved stereo buffer in place.
struct EqChain {
    enabled: bool,
    preamp: f32,
    bands: [Biquad; EQ_BAND_COUNT],
    sample_rate: f32,
    last_gen: u64,
}

impl EqChain {
    fn new(sample_rate: u32) -> Self {
        Self {
            enabled: false,
            preamp: 1.0,
            bands: [Biquad::identity(); EQ_BAND_COUNT],
            sample_rate: sample_rate as f32,
            last_gen: 0,
        }
    }

    // Cheap on the common path: one Acquire load and a compare. Only when the UI
    // has changed something do we read the gains and recompute coefficients —
    // that's the only place the callback does trig/pow, and it's rare.
    fn refresh(&mut self, shared: &SharedState) {
        let gen = shared.eq_gen.load(Ordering::Acquire);
        if gen == self.last_gen {
            return;
        }
        self.last_gen = gen;
        self.enabled = shared.eq_enabled.load(Ordering::Relaxed);
        self.preamp =
            10.0_f32.powf(f32::from_bits(shared.eq_preamp_db.load(Ordering::Relaxed)) / 20.0);
        for (band, (freq, gain)) in self
            .bands
            .iter_mut()
            .zip(EQ_FREQS.iter().zip(shared.eq_gains_db.iter()))
        {
            let gain_db = f32::from_bits(gain.load(Ordering::Relaxed));
            band.set_peaking(*freq, self.sample_rate, EQ_Q, gain_db);
        }
    }

    #[inline]
    fn process_block(&mut self, out: &mut [f32]) {
        for (i, s) in out.iter_mut().enumerate() {
            let ch = i % OUT_CHANNELS;
            let mut x = *s * self.preamp;
            for band in self.bands.iter_mut() {
                x = band.process(x, ch);
            }
            *s = x;
        }
    }
}

// === Engine startup ===

// Raise the calling thread to USER_INTERACTIVE QoS so macOS treats it as
// latency-critical and won't throttle/deprioritize it under Low Power Mode.
// The CoreAudio callback already runs at real-time priority; this keeps the
// decode thread that feeds it from being the weak link. No-op off macOS.
#[cfg(target_os = "macos")]
fn raise_decode_thread_qos() {
    // Safety: pthread_set_qos_class_self_np only mutates the current thread's
    // scheduling class; the relative priority of 0 is the class default.
    let rc = unsafe {
        libc::pthread_set_qos_class_self_np(libc::qos_class_t::QOS_CLASS_USER_INTERACTIVE, 0)
    };
    if rc != 0 {
        log::warn!("failed to raise decode thread QoS: rc={rc}");
    }
}

#[cfg(not(target_os = "macos"))]
fn raise_decode_thread_qos() {}

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

    // Second ring for the visualizer tap: the audio callback pushes, the
    // spectrum thread drains. Sized to a handful of FFT windows so a slow
    // spectrum tick can't back-pressure the audio thread.
    let viz_samples = WAVEFORM_WINDOW * OUT_CHANNELS * 4;
    let (viz_producer, viz_consumer) = RingBuffer::<f32>::new(viz_samples);

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
                    viz_producer,
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
                // Feeding the real-time CoreAudio callback is latency-critical:
                // if this thread falls behind, the ring buffer drains and the
                // callback stutters. Tag it USER_INTERACTIVE so macOS keeps it
                // scheduled — otherwise Low Power Mode throttles and deprioritizes
                // it, starving the buffer while the callback keeps draining.
                raise_decode_thread_qos();
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

    // Spectrum (visualizer) thread. Drains the viz ring, runs the FFT, and
    // emits bar frames. Owns the viz consumer; nothing else reads it.
    {
        let app = app.clone();
        std::thread::Builder::new()
            .name("audio-spectrum".into())
            .spawn(move || {
                waveform_emit_loop(viz_consumer, app, output_rate);
            })
            .map_err(|e| format!("spawn spectrum thread: {e}"))?;
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
    // Visualizer tap: a copy of every audible sample is pushed here for the
    // spectrum thread to analyze. Real-time safe (lock-free, no alloc); if the
    // ring is full we drop samples rather than block the audio thread.
    viz: RbProducer<f32>,
    // Equalizer. Owned solely by the audio thread; picks up parameter changes
    // from `shared` via a gen counter. Applied after volume, before the viz tap
    // so the visualizer shows what you hear.
    eq: EqChain,
}

fn build_stream(
    device: &cpal::Device,
    cfg: &StreamConfig,
    sample_format: SampleFormat,
    rb: RbConsumer<f32>,
    shared: Arc<SharedState>,
    viz: RbProducer<f32>,
) -> Result<cpal::Stream, String> {
    let mut state = ConsumerState {
        rb,
        shared,
        last_flush_gen: 0,
        viz,
        eq: EqChain::new(cfg.sample_rate.0),
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

    // Equalize the audible samples in place. refresh() is near-free unless the
    // UI just moved a slider; when bypassed the whole chain is skipped.
    state.eq.refresh(&state.shared);
    if state.eq.enabled {
        state.eq.process_block(&mut out[..written]);
    }

    // Frame-count update. `written` is in samples; divide by channels.
    let frames = (written / OUT_CHANNELS) as u64;
    state
        .shared
        .frames_played
        .fetch_add(frames, Ordering::Relaxed);

    // Visualizer tap. Copy the samples we just produced into the viz ring for
    // the spectrum thread. push() never blocks or allocates; once the ring is
    // full we stop (drop the rest) so the audio thread is never held up. The
    // spectrum thread drains far faster than we fill, so this rarely trips.
    for &s in out[..written].iter() {
        if state.viz.push(s).is_err() {
            break;
        }
    }
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
    // Output rate this track resamples to. Kept so we can rebuild the resampler
    // when the first decoded packet reveals a different input rate/channel count
    // than the container metadata claimed (see spec_resolved).
    output_rate: u32,
    duration_seconds: f64,
    path: String,
    // Resampler kept across decode calls so internal state (sinc taps) carries
    // over between symphonia packets. Recreated per-track because input rate
    // or channel count may change.
    resampler: SincFixedIn<f32>,
    // Pending input frames that haven't been resampled yet (we feed rubato in
    // fixed-size chunks). One Vec per channel.
    pending_in: Vec<Vec<f32>>,
    // Constant linear multiplier applied to this track's samples on the way into
    // the ring (ReplayGain volume normalization). 1.0 when RG is off or the file
    // carries no tags; see replaygain_multiplier.
    gain: f32,
    // Whether we've sent the resampler its last partial chunk.
    flushed: bool,
    // Whether we've reconciled channel count / sample rate against the first
    // decoded packet. Container codec_params can be absent or wrong — notably
    // M4A/AAC/ALAC leave channels = None until a packet is decoded, so our
    // open-time guess defaults to stereo. The decoded buffer's spec is ground
    // truth; we fix up the resampler and buffers once, on the first packet.
    spec_resolved: bool,
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
    // The *decode frontier*: the track being decoded into the ring buffer and
    // its queue slot. This runs AHEAD of what's audible — up to a full ring
    // buffer (RING_BUFFER_SECONDS), and across track boundaries, since gapless
    // playback decodes the next track early. What the user actually hears is the
    // consumer side, tracked by `origins`. Reads (position, track-changed) come
    // from `origins`; commands that act on "the track the user hears" (Seek)
    // must resolve against `origins` too and re-seat the frontier — acting on
    // the frontier directly would target the wrong track near a boundary.
    let mut frontier_idx: usize = 0;
    let mut frontier: Option<TrackReader> = None;
    // Radio session. Mutually exclusive with `frontier`: Play and PlayStream
    // each clear the other mode before installing their own source.
    let mut stream: Option<StreamSession> = None;

    // Producer-side cumulative stereo frames pushed since the last full reset
    // (Play command). Matches shared.total_produced.
    let mut producer_frames: u64 = 0;

    loop {
        // Drain commands non-blocking. Most iterations have none; when a
        // command does arrive it's usually TogglePause or Seek.
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
                        frontier_idx = start;
                        stream = None;
                        producer_frames = 0;
                        reset_for_new_playback(&shared, &origins);
                        emit_state(&app, true, true);
                        frontier = advance_to_next_playable(
                            &queue,
                            &mut frontier_idx,
                            output_rate,
                            producer_frames,
                            &shared,
                            &origins,
                            &app,
                        );
                        if frontier.is_none() {
                            shared.queue_exhausted.store(true, Ordering::Relaxed);
                            emit_state(&app, false, false);
                        }
                    }
                    Command::PlayStream { url } => {
                        queue.clear();
                        frontier_idx = 0;
                        frontier = None;
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
                        if frontier.is_some() || stream.is_some() {
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
                    Command::ClearUpcoming => {
                        // Keep the frontier track and its in-flight decode;
                        // discard the rest. When it ends, advance_to_next_playable
                        // finds nothing and queue-ended fires. No flush, so
                        // audible playback is untouched.
                        //
                        // Edge: within the last ~RING_BUFFER_SECONDS of a track,
                        // the frontier has already advanced past the audible track
                        // to the next one, whose leading frames are buffered in
                        // the ring. Truncating at the frontier keeps that next
                        // track, so it plays once before the per-track mode
                        // engages. Unlike Seek, re-seating to the audible track
                        // wouldn't help: those next-track frames are already
                        // decoded into the ring, and the only way to drop them is
                        // a flush — which reintroduces the very glitch this
                        // command exists to avoid. So the tradeoff stands.
                        if frontier_idx < queue.len() {
                            queue.truncate(frontier_idx + 1);
                        }
                    }
                    Command::Append { tracks } => {
                        if tracks.is_empty() {
                            continue;
                        }
                        // frontier_idx already points at the first appended track
                        // when the queue had drained (frontier_idx == old len).
                        queue.extend(tracks);
                        // While a track is decoding, we do nothing here —
                        // auto-advance reaches the new tracks with no flush.
                        if frontier.is_none() && stream.is_none() {
                            // The frontier drained (or never started). Whether we
                            // can flush hinges on whether anything is still
                            // *audible*: the frontier runs up to a full ring buffer
                            // (RING_BUFFER_SECONDS) ahead, so it goes None the
                            // instant the last track finishes DECODING — while that
                            // much of its audio is still playing out the speakers.
                            let produced = shared.total_produced.load(Ordering::Relaxed);
                            let played = shared.frames_played.load(Ordering::Relaxed);
                            let drained = shared.total_drained.load(Ordering::Relaxed);
                            if produced > played + drained {
                                // A tail is still sounding. Resume the frontier into
                                // the appended tracks WITHOUT a flush/reset: their
                                // origin is published at producer_frames, so it
                                // activates exactly when the tail's last frame plays
                                // out — gapless, and the audible tail is untouched.
                                // (A reset here would flush_and_wait the ring and
                                // chop that tail.)
                                shared.queue_exhausted.store(false, Ordering::Relaxed);
                                frontier = advance_to_next_playable(
                                    &queue,
                                    &mut frontier_idx,
                                    output_rate,
                                    producer_frames,
                                    &shared,
                                    &origins,
                                    &app,
                                );
                                if frontier.is_none() {
                                    shared.queue_exhausted.store(true, Ordering::Relaxed);
                                }
                            } else {
                                // Nothing is audible (never started, or the tail has
                                // fully drained): a full reset re-bases the frame
                                // counters like a fresh Play, which is safe because
                                // the flush has nothing to chop.
                                producer_frames = 0;
                                reset_for_new_playback(&shared, &origins);
                                emit_state(&app, true, true);
                                frontier = advance_to_next_playable(
                                    &queue,
                                    &mut frontier_idx,
                                    output_rate,
                                    producer_frames,
                                    &shared,
                                    &origins,
                                    &app,
                                );
                                if frontier.is_none() {
                                    shared.queue_exhausted.store(true, Ordering::Relaxed);
                                    emit_state(&app, false, false);
                                }
                            }
                        }
                    }
                    Command::Stop => {
                        // Full teardown. Mirrors a Play reset but into an empty,
                        // exhausted state: flush the device to silence, drop the
                        // queue, and report no track. With `frontier` cleared the
                        // position-emit thread takes its None branch, so no
                        // spurious queue-ended fires on the way down.
                        queue.clear();
                        frontier_idx = 0;
                        frontier = None;
                        stream = None;
                        producer_frames = 0;
                        reset_for_new_playback(&shared, &origins);
                        shared.queue_exhausted.store(true, Ordering::Relaxed);
                        emit_state(&app, false, false);
                    }
                    Command::Seek(secs) => {
                        // Seek acts on the track the user *hears*, not the decode
                        // frontier — which may have run past it (see the frontier
                        // note above), even off the end of the queue while the
                        // final track's tail drains. Resolve the audible slot from
                        // the active origin and re-seat the frontier onto it when
                        // they differ. A seek flushes the ring buffer regardless,
                        // so reopening the audible track costs nothing extra.
                        let audible_idx = {
                            let o = origins.lock().unwrap_or_else(|e| e.into_inner());
                            o.current.as_ref().map(|orig| orig.queue_index)
                        };
                        if let Some(idx) = audible_idx {
                            if idx < queue.len() && (frontier.is_none() || idx != frontier_idx) {
                                let rg = shared.rg_mode.load(Ordering::Relaxed);
                                if let Some(reader) = open_track(&queue[idx], output_rate, rg) {
                                    frontier = Some(reader);
                                    frontier_idx = idx;
                                    shared.queue_exhausted.store(false, Ordering::Relaxed);
                                }
                            }
                        }
                        if let Some(ref mut tr) = frontier {
                            let target = secs.max(0.0).min(tr.duration_seconds);
                            // Reset resampler state — internal sinc taps from
                            // the old position would otherwise bleed a few ms
                            // of old audio into the new position.
                            tr.resampler =
                                make_resampler(tr.input_rate, output_rate, tr.input_channels);
                            tr.pending_in = vec![Vec::new(); tr.input_channels];
                            tr.flushed = false;
                            seek_track(tr, target);
                            // Bump flush_gen and wait for the callback to ack
                            // the drain. Without the wait, the next callback
                            // could race the producer's first post-seek push
                            // and discard those new samples too.
                            flush_and_wait(&shared);
                            // The flush discards every buffered frame, so all
                            // pending origins (audio not yet heard — e.g. the
                            // next track the frontier queued near a boundary) are
                            // now stale. Drop them; the origin published below is
                            // the only valid one from here.
                            {
                                let mut o = origins.lock().unwrap_or_else(|e| e.into_inner());
                                o.pending.clear();
                            }
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
                                frontier_idx,
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

        if frontier.is_none() {
            std::thread::sleep(Duration::from_millis(10));
            continue;
        }

        // Decode + push the next chunk.
        let tr = frontier.as_mut().unwrap();
        match decode_and_push(tr, &mut rb, &shared, &mut producer_frames) {
            Ok(StepOutcome::Continue) => {}
            Ok(StepOutcome::TrackEnded) => {
                frontier_idx += 1;
                frontier = advance_to_next_playable(
                    &queue,
                    &mut frontier_idx,
                    output_rate,
                    producer_frames,
                    &shared,
                    &origins,
                    &app,
                );
                if frontier.is_none() {
                    // Queue exhausted (or every remaining track failed to
                    // open). Leave frontier=None; the position-emit thread
                    // will fire queue-ended once playback drains.
                    shared.queue_exhausted.store(true, Ordering::Relaxed);
                }
            }
            Err(e) => {
                log::warn!("audio: decode error: {e}");
                let path = tr.path.clone();
                emit_error(&app, &PathBuf::from(&path), &e);
                frontier_idx += 1;
                frontier = advance_to_next_playable(
                    &queue,
                    &mut frontier_idx,
                    output_rate,
                    producer_frames,
                    &shared,
                    &origins,
                    &app,
                );
                if frontier.is_none() {
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
            output_rate,
            duration_seconds: 0.0,
            path: url.to_string(),
            resampler,
            // ReplayGain is a file-tag feature; live streams carry no such tags.
            gain: 1.0,
            pending_in: vec![Vec::new(); input_channels],
            flushed: false,
            spec_resolved: false,
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

// Open the next playable track at or after frontier_idx, skipping (and reporting)
// any that fail to open. Returns None when the queue is exhausted. On success,
// publishes the new track's origin so the position-emit thread will pick it up
// as soon as playback reaches it.
fn advance_to_next_playable(
    queue: &[PathBuf],
    frontier_idx: &mut usize,
    output_rate: u32,
    producer_frames: u64,
    shared: &Arc<SharedState>,
    origins: &Arc<Mutex<Origins>>,
    app: &AppHandle,
) -> Option<TrackReader> {
    let rg_mode = shared.rg_mode.load(Ordering::Relaxed);
    while *frontier_idx < queue.len() {
        match open_track(&queue[*frontier_idx], output_rate, rg_mode) {
            Some(reader) => {
                publish_origin(
                    origins,
                    shared,
                    producer_frames,
                    *frontier_idx,
                    &reader.path,
                    reader.duration_seconds,
                    0.0,
                );
                return Some(reader);
            }
            None => {
                emit_error(app, &queue[*frontier_idx], "could not open");
                *frontier_idx += 1;
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
        Err(SymError::IoError(ref e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => {
            // EOF: flush the resampler's tail, push it, then signal end.
            if !tr.flushed {
                let tail = resample_flush(&mut tr.resampler, &tr.pending_in, tr.input_channels)
                    .map_err(|e| format!("resample flush: {e}"))?;
                tr.pending_in = vec![Vec::new(); tr.input_channels];
                tr.flushed = true;
                if !tail.is_empty() {
                    let mut interleaved = interleave_stereo(&tail, tr.input_channels);
                    apply_track_gain(&mut interleaved, tr.gain);
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

    // Reconcile against the decoded buffer's spec on the first packet. The
    // container's codec_params may omit or misreport the channel count / rate
    // (M4A/AAC/ALAC report channels = None until decoded, so our open-time guess
    // defaults to stereo). If we kept trusting that, a mono source would leave
    // pending_in[1] permanently empty and the `drain(..CHUNK)` below would panic
    // ("range end index 1024 out of range for slice of length 0") — which, on
    // the decode thread, silently kills playback (decodes, duration known, but
    // the playhead never advances).
    if !tr.spec_resolved {
        let spec = decoded.spec();
        let actual_channels = spec.channels.count().max(1);
        let actual_rate = spec.rate;
        if actual_channels != tr.input_channels || actual_rate != tr.input_rate {
            log::info!(
                "audio: reconciling spec for {}: channels {}->{}, rate {}->{}",
                tr.path,
                tr.input_channels,
                actual_channels,
                tr.input_rate,
                actual_rate
            );
            tr.input_channels = actual_channels;
            tr.input_rate = actual_rate;
            tr.resampler = make_resampler(actual_rate, tr.output_rate, actual_channels);
            tr.pending_in = vec![Vec::new(); actual_channels];
        }
        tr.spec_resolved = true;
    }

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
        let mut interleaved = interleave_stereo(&out_planar, tr.input_channels);
        apply_track_gain(&mut interleaved, tr.gain);
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

fn open_track(path: &std::path::Path, output_rate: u32, rg_mode: u8) -> Option<TrackReader> {
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
        output_rate,
        duration_seconds,
        path: path.to_string_lossy().to_string(),
        resampler,
        gain: replaygain_multiplier(path, rg_mode),
        pending_in: vec![Vec::new(); input_channels],
        flushed: false,
        spec_resolved: false,
    })
}

// The per-track linear gain for the given ReplayGain mode, or 1.0 when RG is off
// or the file has no usable tags. Reads the standard REPLAYGAIN_* tags (lofty
// maps them across ID3v2 TXXX, Vorbis comments, and iTunes MP4 atoms). Album
// mode prefers the album gain/peak and falls back to the track values, matching
// how other players treat an album-mode track that was only track-scanned.
//
// To avoid the classic ReplayGain failure — boosting a quiet track past 0 dBFS
// and clipping — we cap the gain so gain * peak <= 1.0 when a peak is known.
fn replaygain_multiplier(path: &std::path::Path, mode: u8) -> f32 {
    if mode == 0 {
        return 1.0;
    }
    let Ok(tagged) = lofty::read_from_path(path) else {
        return 1.0;
    };
    let Some(tag) = tagged.primary_tag().or_else(|| tagged.first_tag()) else {
        return 1.0;
    };

    // A gain tag is a signed dB figure, usually suffixed " dB" (e.g. "-7.89 dB").
    let parse_db = |k: &ItemKey| -> Option<f32> {
        tag.get_string(k)
            .and_then(|s| s.trim().trim_end_matches(|c: char| c.is_alphabetic()).trim().parse::<f32>().ok())
    };
    // A peak tag is a linear sample value (typically 0..~1); ignore non-positive.
    let parse_peak = |k: &ItemKey| -> Option<f32> {
        tag.get_string(k).and_then(|s| s.trim().parse::<f32>().ok()).filter(|p| *p > 0.0)
    };

    // mode 2 = album: prefer album tags, fall back to track tags.
    let (gain_db, peak) = if mode == 2 {
        (
            parse_db(&ItemKey::ReplayGainAlbumGain).or_else(|| parse_db(&ItemKey::ReplayGainTrackGain)),
            parse_peak(&ItemKey::ReplayGainAlbumPeak).or_else(|| parse_peak(&ItemKey::ReplayGainTrackPeak)),
        )
    } else {
        (
            parse_db(&ItemKey::ReplayGainTrackGain),
            parse_peak(&ItemKey::ReplayGainTrackPeak),
        )
    };

    replaygain_gain(gain_db, peak)
}

/// Pure ReplayGain math, split out from tag I/O so it can be unit-tested.
/// `gain_db` is the signed dB adjustment from the tag; `peak` is the linear
/// sample peak (if present). Returns the linear multiplier to apply to samples.
fn replaygain_gain(gain_db: Option<f32>, peak: Option<f32>) -> f32 {
    let Some(gain_db) = gain_db else {
        return 1.0;
    };
    let mut gain = 10.0_f32.powf(gain_db / 20.0);
    if let Some(peak) = peak {
        // Clip prevention: never let gain*peak exceed full scale.
        gain = gain.min(1.0 / peak);
    }
    // Guard against absurd tags; keep the multiplier in a sane range.
    gain.clamp(0.0, 4.0)
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
                into[c].extend(
                    buf.chan(c)
                        .iter()
                        .map(|&v| (v as f32 - u32::MAX as f32 / 2.0) * scale),
                );
            }
        }
        AudioBufferRef::U24(buf) => {
            let scale = 1.0 / 8_388_608.0;
            for c in 0..channels {
                into[c].extend(
                    buf.chan(c)
                        .iter()
                        .map(|&v| (v.inner() as f32 - 8_388_608.0) * scale),
                );
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

// Scale an interleaved buffer in place by a constant per-track gain (ReplayGain).
// The common case (RG off / no tags) is gain == 1.0, which we skip entirely.
fn apply_track_gain(samples: &mut [f32], gain: f32) {
    if gain == 1.0 {
        return;
    }
    for s in samples.iter_mut() {
        *s *= gain;
    }
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
    // New session: bump the epoch so origins published from here on are
    // recognized as a fresh Play even when they reuse the previous track's slot
    // and path (replaying the same track).
    shared.play_epoch.fetch_add(1, Ordering::Relaxed);
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
    queue_index: usize,
    path: &str,
    duration_seconds: f64,
    start_offset_seconds: f64,
) {
    let drained = shared.total_drained.load(Ordering::Relaxed);
    let at_consumer_frame = producer_frames.saturating_sub(drained);
    let epoch = shared.play_epoch.load(Ordering::Relaxed);
    let mut o = origins.lock().unwrap_or_else(|e| e.into_inner());
    o.pending.push_back(Origin {
        epoch,
        at_consumer_frame,
        queue_index,
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
    let mut last_emitted_index: Option<usize> = None;
    let mut last_emitted_epoch: Option<u64> = None;
    let mut queue_ended_sent = false;

    loop {
        std::thread::sleep(Duration::from_millis(POSITION_EMIT_INTERVAL_MS));

        let frames_played = shared.frames_played.load(Ordering::Relaxed);

        // Activate any origins the consumer has now passed.
        let active_origin = {
            let mut o = origins.lock().unwrap_or_else(|e| e.into_inner());
            while let Some(front) = o.pending.front() {
                if front.at_consumer_frame <= frames_played {
                    let act = o.pending.pop_front().unwrap();
                    o.current = Some(act);
                } else {
                    break;
                }
            }
            o.current.clone()
        };

        match active_origin {
            Some(origin) => {
                let delta_frames = frames_played.saturating_sub(origin.at_consumer_frame);
                let position =
                    origin.start_offset_seconds + delta_frames as f64 / output_rate as f64;
                let position = position.min(origin.duration_seconds);

                // Fire track-changed only when the audible *slot* changes — keyed
                // on queue_index, not just "an origin was activated." A Seek
                // re-publishes the current track's origin (same slot) to rebase
                // its position; treating that pop as an advance would spuriously
                // step the frontend's queue highlight to the next row on every
                // seek. Path is also checked so a new Play that reuses a slot
                // index for a different track still fires. (Adjacent duplicate
                // rows share a path but differ in index, so they still fire.)
                //
                // Epoch is checked too so replaying the *same* track (same slot
                // and path) still fires: each Play bumps play_epoch, while a Seek
                // keeps it — so the frontend re-learns the duration on replay
                // without a seek spuriously re-firing.
                if last_emitted_epoch != Some(origin.epoch)
                    || last_emitted_index != Some(origin.queue_index)
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
                    last_emitted_index = Some(origin.queue_index);
                    last_emitted_epoch = Some(origin.epoch);
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
                if shared.queue_exhausted.load(Ordering::Relaxed) && !queue_ended_sent {
                    let produced = shared.total_produced.load(Ordering::Relaxed);
                    // Every produced frame is eventually either played or
                    // discarded by a flush (seek), so the queue has fully drained
                    // when played + drained == produced. Omitting total_drained
                    // means a track whose end is reached after a seek never
                    // satisfies the check, so queue-ended never fires.
                    let drained = shared.total_drained.load(Ordering::Relaxed);
                    if frames_played + drained >= produced {
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
                last_emitted_index = None;
                last_emitted_epoch = None;
                queue_ended_sent = false;
            }
        }
    }
}

// === Waveform (visualizer) thread ===
//
// Drains the viz ring the audio callback fills, keeps a sliding window of the
// most recent mono samples, and ~30 Hz emits that window decimated to a fixed
// point count — a plain oscilloscope feed. All the look (glow, starfield,
// feedback) lives in the frontend; this just delivers clean amplitudes.
fn waveform_emit_loop(mut viz: RbConsumer<f32>, app: AppHandle, sample_rate: u32) {
    // Sliding window of the most recent mono samples.
    let mut mono: VecDeque<f32> = VecDeque::with_capacity(WAVEFORM_WINDOW);
    // Longer sliding window feeding the per-band spectrum (Goertzel needs several
    // periods of the lowest band to resolve it). Fed from the same drained samples.
    let mut spec: VecDeque<f32> = VecDeque::with_capacity(SPECTRUM_WINDOW);
    let mut scratch: Vec<f32> = Vec::new();
    let zeros = vec![0.0f32; WAVEFORM_POINTS];
    let band_zeros = vec![0.0f32; EQ_BAND_COUNT];
    // Precompute the Goertzel coefficient per band for this sample rate.
    let coeffs: [f32; EQ_BAND_COUNT] = std::array::from_fn(|k| {
        2.0 * (std::f32::consts::TAU * EQ_FREQS[k] / sample_rate as f32).cos()
    });
    // Decimation factor: average this many window samples per emitted point.
    let block = WAVEFORM_WINDOW / WAVEFORM_POINTS;

    loop {
        std::thread::sleep(Duration::from_millis(WAVEFORM_EMIT_INTERVAL_MS));

        // Drain everything available. Keep an even count so interleaved stereo
        // stays pair-aligned across ticks (the odd leftover waits for next tick).
        let avail = viz.slots() & !1;
        let mut drained_any = false;
        if avail > 0 {
            if let Ok(chunk) = viz.read_chunk(avail) {
                let (a, b) = chunk.as_slices();
                scratch.clear();
                scratch.extend_from_slice(a);
                scratch.extend_from_slice(b);
                chunk.commit_all();
                drained_any = true;

                // Downmix interleaved stereo → mono, keeping only the last N in
                // each window (the short scope window and the long spectrum window).
                let mut i = 0;
                while i + 1 < scratch.len() {
                    let m = 0.5 * (scratch[i] + scratch[i + 1]);
                    if mono.len() == WAVEFORM_WINDOW {
                        mono.pop_front();
                    }
                    mono.push_back(m);
                    if spec.len() == SPECTRUM_WINDOW {
                        spec.pop_front();
                    }
                    spec.push_back(m);
                    i += 2;
                }
            }
        }

        // Nothing new this tick (paused, silence, underrun): emit a flat line and
        // silent bands so the scope settles to center and the EQ bars ease back to
        // accent rather than freezing on the last frame.
        if !drained_any {
            let _ = app.emit(
                "audio:waveform",
                WaveformEvent {
                    samples: zeros.clone(),
                },
            );
            let _ = app.emit(
                "audio:spectrum",
                SpectrumEvent {
                    bands: band_zeros.clone(),
                },
            );
            continue;
        }

        // Per-band energy via Goertzel over the long window, once it has filled.
        // Hann-windowed to curb spectral leakage between the octave-spaced bands.
        if spec.len() == SPECTRUM_WINDOW {
            let win = spec.make_contiguous();
            let n = win.len();
            let norm = 2.0 / n as f32; // Hann halves the average amplitude; ×2 restores it
            let bands: Vec<f32> = coeffs
                .iter()
                .map(|&coeff| {
                    let mut s_prev = 0.0f32;
                    let mut s_prev2 = 0.0f32;
                    for (j, &x) in win.iter().enumerate() {
                        // Hann window w[j] = 0.5 - 0.5*cos(2πj/(N-1)).
                        let w = 0.5 - 0.5 * (std::f32::consts::TAU * j as f32 / (n - 1) as f32).cos();
                        let s = x * w + coeff * s_prev - s_prev2;
                        s_prev2 = s_prev;
                        s_prev = s;
                    }
                    let power = s_prev2 * s_prev2 + s_prev * s_prev - coeff * s_prev * s_prev2;
                    let mag = power.max(0.0).sqrt() * norm;
                    // Perceptual-ish: sqrt lifts quiet detail, then scale+clamp.
                    (mag.sqrt() * SPECTRUM_GAIN).clamp(0.0, 1.0)
                })
                .collect();
            let _ = app.emit("audio:spectrum", SpectrumEvent { bands });
        }

        // Wait until we have a full window before the first real frame.
        if mono.len() < WAVEFORM_WINDOW {
            continue;
        }

        // Decimate the window to WAVEFORM_POINTS by block-averaging: mild low-pass
        // that tames noise without flattening the waveform's shape.
        let win = mono.make_contiguous();
        let samples: Vec<f32> = (0..WAVEFORM_POINTS)
            .map(|p| {
                let start = p * block;
                let sum: f32 = win[start..start + block].iter().sum();
                sum / block as f32
            })
            .collect();

        let _ = app.emit("audio:waveform", WaveformEvent { samples });
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

#[cfg(test)]
mod spec_reconcile_tests {
    //! Regression guard for the mono/low-rate stall+panic: symphonia leaves
    //! codec_params.channels (and sometimes sample_rate) unset for M4A/AAC/ALAC
    //! until the first packet is decoded, so open_track's guess defaulted to
    //! stereo. A mono source then left pending_in[1] empty and the resampler
    //! feed panicked on `drain(..CHUNK)` — killing the decode thread, which
    //! surfaces as playback that decodes and knows its duration but never
    //! advances. We now reconcile against the decoded buffer's spec.
    use super::*;

    // Drive the real open_track + decode_and_push pipeline over a fixture and
    // return the number of stereo output frames produced. Panics propagate.
    fn produced_frames(fixture: &str, output_rate: u32) -> u64 {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests-fixtures")
            .join(fixture);
        let mut tr = open_track(&path, output_rate, 0).expect("open_track");
        eprintln!(
            "fixture={fixture} input_rate={} input_channels={} duration={:.3}",
            tr.input_rate, tr.input_channels, tr.duration_seconds
        );
        let shared = Arc::new(SharedState::new());
        let (mut prod, mut cons) = RingBuffer::<f32>::new(1 << 20);
        let mut producer_frames: u64 = 0;
        // Drain consumer in a thread so push_blocking never wedges on a full ring.
        let done = Arc::new(AtomicBool::new(false));
        let d2 = done.clone();
        let drainer = std::thread::spawn(move || {
            while !d2.load(Ordering::Relaxed) {
                while let Ok(chunk) = cons.read_chunk(cons.slots()) {
                    let n = chunk.len();
                    chunk.commit_all();
                    if n == 0 {
                        break;
                    }
                }
                std::thread::sleep(Duration::from_millis(1));
            }
        });
        loop {
            match decode_and_push(&mut tr, &mut prod, &shared, &mut producer_frames) {
                Ok(StepOutcome::TrackEnded) => break,
                Ok(_) => {}
                Err(e) => panic!("decode error: {e}"),
            }
        }
        done.store(true, Ordering::Relaxed);
        drainer.join().unwrap();
        producer_frames
    }

    #[test]
    fn mono_aac_22050() {
        let f = produced_frames("mono22_aac.m4a", 44100);
        eprintln!("mono22_aac produced_frames={f}");
        assert!(f > 0, "no audio produced (stall) for mono 22050 AAC");
    }

    #[test]
    fn mono_aac_44100() {
        let f = produced_frames("mono44_aac.m4a", 44100);
        eprintln!("mono44_aac produced_frames={f}");
        assert!(f > 0);
    }

    #[test]
    fn mono_alac_22050() {
        let f = produced_frames("mono22_alac.m4a", 44100);
        eprintln!("mono22_alac produced_frames={f}");
        assert!(f > 0);
    }

    #[test]
    fn mono_alac_44100() {
        let f = produced_frames("mono44_alac.m4a", 44100);
        eprintln!("mono44_alac produced_frames={f}");
        assert!(f > 0);
    }

    #[test]
    fn stereo_alac_22050() {
        let f = produced_frames("stereo22_alac.m4a", 44100);
        eprintln!("stereo22_alac produced_frames={f}");
        assert!(f > 0);
    }
}

#[cfg(test)]
mod replaygain_tests {
    //! Coverage for the ReplayGain volume-normalization feature. The audio
    //! itself is impractical to assert on in an e2e test (gain is baked into
    //! samples on the real-time decode thread), so we test the logic directly:
    //!   * the pure dB->linear math, including clip prevention and clamping,
    //!   * that apply_track_gain actually scales samples,
    //!   * and a real round-trip: write RG tags onto an m4a fixture with lofty
    //!     and confirm replaygain_multiplier reads them back (this is what
    //!     validates the ItemKey -> MP4 freeform-atom wiring end to end).
    use super::*;
    use lofty::config::WriteOptions;
    use lofty::tag::{Tag, TagType};

    #[test]
    fn pure_math_basics() {
        // No gain tag -> unity, regardless of peak.
        assert_eq!(replaygain_gain(None, None), 1.0);
        assert_eq!(replaygain_gain(None, Some(0.5)), 1.0);

        // 0 dB is unity; +6.02 dB doubles; -6.02 dB halves.
        assert!((replaygain_gain(Some(0.0), None) - 1.0).abs() < 1e-6);
        assert!((replaygain_gain(Some(6.0206), None) - 2.0).abs() < 1e-3);
        assert!((replaygain_gain(Some(-6.0206), None) - 0.5).abs() < 1e-3);
    }

    #[test]
    fn clip_prevention_caps_to_peak() {
        // +12 dB (~3.98x) on a track that already peaks at 0.8 would clip.
        // The multiplier must be capped to 1/peak = 1.25.
        let g = replaygain_gain(Some(12.0), Some(0.8));
        assert!((g - 1.25).abs() < 1e-4, "expected cap to 1/peak, got {g}");

        // When headroom is ample, the peak cap does not bind.
        let g = replaygain_gain(Some(3.0), Some(0.5));
        assert!((g - 10.0_f32.powf(3.0 / 20.0)).abs() < 1e-4);
    }

    #[test]
    fn absurd_gain_is_clamped() {
        // A garbage +40 dB tag (100x) is clamped to the 4.0 ceiling.
        assert_eq!(replaygain_gain(Some(40.0), None), 4.0);
        // Peak cap can also drive it high; clamp still holds.
        assert_eq!(replaygain_gain(Some(40.0), Some(0.1)), 4.0);
    }

    #[test]
    fn apply_track_gain_scales_and_skips_unity() {
        let mut s = vec![0.5, -0.25, 1.0, -1.0];
        apply_track_gain(&mut s, 0.5);
        assert_eq!(s, vec![0.25, -0.125, 0.5, -0.5]);

        // gain == 1.0 is a no-op fast path (bit-identical, no rounding).
        let mut s = vec![0.3, -0.7, 0.123_456];
        let orig = s.clone();
        apply_track_gain(&mut s, 1.0);
        assert_eq!(s, orig);
    }

    // Copy a fixture into a temp file so we can write tags without touching the
    // committed fixture. Returns the temp path; caller cleans up.
    fn temp_copy(fixture: &str, tag: &str) -> std::path::PathBuf {
        let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests-fixtures")
            .join(fixture);
        let dst = std::env::temp_dir().join(format!(
            "pud_rg_{}_{}_{}.m4a",
            tag,
            std::process::id(),
            fixture,
        ));
        std::fs::copy(&src, &dst).expect("copy fixture");
        dst
    }

    fn write_rg_tags(path: &std::path::Path, items: &[(ItemKey, &str)]) {
        let mut t = Tag::new(TagType::Mp4Ilst);
        for (k, v) in items {
            assert!(t.insert_text(k.clone(), (*v).to_string()), "insert {k:?}");
        }
        t.save_to_path(path, WriteOptions::default())
            .expect("write RG tags to fixture");
    }

    #[test]
    fn no_rg_tags_plays_at_unity() {
        // The committed fixtures carry no ReplayGain tags: any mode -> 1.0.
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests-fixtures")
            .join("stereo22_alac.m4a");
        assert_eq!(replaygain_multiplier(&path, 1), 1.0);
        assert_eq!(replaygain_multiplier(&path, 2), 1.0);
    }

    #[test]
    fn mode_off_short_circuits() {
        // Even with tags present, mode 0 never touches the volume.
        let path = temp_copy("stereo22_alac.m4a", "off");
        write_rg_tags(
            &path,
            &[(ItemKey::ReplayGainTrackGain, "-6.00 dB")],
        );
        assert_eq!(replaygain_multiplier(&path, 0), 1.0);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn reads_track_tags_roundtrip() {
        let path = temp_copy("stereo22_alac.m4a", "track");
        // -6.02 dB with a 0.9 peak: attenuation, so the peak cap won't bind.
        write_rg_tags(
            &path,
            &[
                (ItemKey::ReplayGainTrackGain, "-6.0206 dB"),
                (ItemKey::ReplayGainTrackPeak, "0.900000"),
            ],
        );
        let g = replaygain_multiplier(&path, 1);
        assert!((g - 0.5).abs() < 1e-3, "track gain not read back, got {g}");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn album_mode_prefers_album_then_falls_back_to_track() {
        // Both album and track present: album mode uses album (+0 dB -> 1.0),
        // track mode uses track (-6.02 dB -> 0.5). Same file, two modes.
        let path = temp_copy("stereo22_alac.m4a", "album");
        write_rg_tags(
            &path,
            &[
                (ItemKey::ReplayGainTrackGain, "-6.0206 dB"),
                (ItemKey::ReplayGainAlbumGain, "0.00 dB"),
            ],
        );
        assert!((replaygain_multiplier(&path, 2) - 1.0).abs() < 1e-3, "album gain");
        assert!((replaygain_multiplier(&path, 1) - 0.5).abs() < 1e-3, "track gain");
        let _ = std::fs::remove_file(&path);

        // Only track tags present: album mode must fall back to the track gain.
        let path = temp_copy("stereo22_alac.m4a", "fallback");
        write_rg_tags(
            &path,
            &[(ItemKey::ReplayGainTrackGain, "-6.0206 dB")],
        );
        assert!(
            (replaygain_multiplier(&path, 2) - 0.5).abs() < 1e-3,
            "album mode should fall back to track gain",
        );
        let _ = std::fs::remove_file(&path);
    }
}
