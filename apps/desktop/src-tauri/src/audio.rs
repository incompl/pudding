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
// The output stream is opened once at startup and normally stays open for the
// whole session. Tracks are joined by adjacency in the ring buffer — track N's
// last sample sits next to track N+1's first sample with nothing in between.
//
// The one thing that ever reopens it is an optional, off-by-default rate switch:
// with "Match Source Sample Rate" on, a track whose rate the device
// isn't running gets the stream (and the ring) rebuilt at that rate, at the
// track boundary and behind a drain barrier. See "Output rate switching" below.
// Two tracks that share a rate never go near it and stay sample-adjacent.
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

use cpal::traits::{DeviceTrait, StreamTrait};
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

use crate::dataless;
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

// Follow-the-content output rate switching (Playback > "Match Device to File
// Sample Rate", off by default). Switching means changing the output device's
// nominal rate, explicitly through CoreAudio on macOS. The stream is torn down
// and rebuilt at that rate, and the device is silent while that
// happens. It is therefore done at a track boundary, behind a drain barrier,
// and only when the rate actually changes: a track that plays at the rate
// already running never touches any of this and stays sample-adjacent to its
// predecessor, which is the whole point of the engine.
//
// Silence pushed into the fresh ring ahead of the new track's first sample. Two
// jobs: the rebuilt stream starts with a full buffer instead of underrunning
// while the decode thread catches up, and external DACs that mute themselves
// while re-locking to a new rate don't swallow the first note.
const RATE_SWITCH_PREROLL_MS: u64 = 200;
// The callback hands the device a buffer at a time, so an empty ring still has
// frames in flight that haven't been heard. Wait this long after the ring
// drains before tearing the stream down, or the previous track loses its tail.
const RATE_SWITCH_SETTLE_MS: u64 = 30;
// Ceiling on a followed rate. A 96 kHz file on a DAC that offers 384 kHz gains
// nothing from the extra octaves and costs real decode-thread headroom.
const MAX_FOLLOW_RATE: u32 = 192_000;
// Bound on the drain barrier, so a device that has stopped consuming (asleep,
// wedged, unplugged) can't hold the decode thread there forever.
const RATE_SWITCH_DRAIN_TIMEOUT: Duration = Duration::from_secs(3);
// Bound on the rebuild round-trip. The native rate setter waits up to a second
// for the device to report its new rate, with room for teardown/build either side.
const RATE_SWITCH_REBUILD_TIMEOUT: Duration = Duration::from_secs(5);
const RATE_RESTORE_EXIT_TIMEOUT: Duration = Duration::from_secs(10);

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
    // Update follow-the-content switching. Disabling is a command (rather than
    // just an atomic write) because it also restores the device rate Pudding
    // found immediately before its first switch, when the ownership guard says
    // the device is still ours to restore.
    SetRateFollow(bool),
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
    // Ring underrun counters, bumped by the audio callback when it had to pad
    // its output with silence because the decode thread hadn't kept the ring
    // filled. The callback is real-time and can't log, so it only touches these
    // atomics; position_emit_loop drains and reports them at a human rate.
    // Cumulative for the life of the process — this is a diagnostic, and a
    // running total is what you want when comparing playback under stress.
    // `underrun_events` counts callbacks that came up short, `underrun_frames`
    // the stereo frames of silence inserted (severity, not just frequency).
    underrun_events: AtomicU64,
    underrun_frames: AtomicU64,
    // The decoder is parked waiting for a cloud file to download (see Fetch).
    // Read by the audio callback for one reason: the ring is *supposed* to be
    // empty while we wait, exactly as it is at the end of a queue, so this joins
    // queue_exhausted and friends in gating underrun accounting. Counting a
    // deliberate wait as starvation would fill the log with a warning a second
    // for the length of the download and make the real diagnostic useless.
    fetching: AtomicBool,
    // ReplayGain (volume normalization) mode: 0 = off, 1 = track, 2 = album.
    // Read once per track when it's opened (open_track), where the file's
    // REPLAYGAIN_* tags are turned into a constant per-track gain baked into the
    // decoded samples — so unlike the EQ (a live callback effect) a mode change
    // only takes effect on the next track opened, not the one already decoding.
    rg_mode: AtomicU8,
    // The device rate currently running. Written by the decode thread (the only
    // thread that changes it) after a rate switch, read by threads that need the
    // rate without owning it. Position math does NOT read this — it uses the
    // rate stamped on each origin, which stays correct for audio that was
    // produced before a switch. See Origin::rate.
    output_rate: AtomicU32,
    // Follow-the-content rate switching, off by default. Enabling is read by
    // the decode thread as it opens each track; disabling also schedules the
    // guarded restoration switch described below.
    rate_follow: AtomicBool,
    // Set during Tauri's final Exit event. The output thread rejects any
    // already-armed follow switch after this flips, so nothing can race behind
    // the final restore and change the device again on the way out.
    shutting_down: AtomicBool,
    // Set while the decode thread is deliberately letting the ring run dry to
    // reach a rate switch's drain barrier. The callback reads it to keep that
    // silence out of the underrun counters — the same role queue_exhausted and
    // post_flush play for the other two by-design silences.
    rate_switch_pending: AtomicBool,
}

impl SharedState {
    fn new(output_rate: u32) -> Self {
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
            underrun_events: AtomicU64::new(0),
            underrun_frames: AtomicU64::new(0),
            fetching: AtomicBool::new(false),
            rg_mode: AtomicU8::new(0),
            output_rate: AtomicU32::new(output_rate),
            rate_follow: AtomicBool::new(false),
            shutting_down: AtomicBool::new(false),
            rate_switch_pending: AtomicBool::new(false),
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
    // The device rate this origin's audio was produced at. Frame counts either
    // side of a rate switch measure different amounts of time, so the divisor
    // has to travel with the origin rather than being read live. A switch only
    // ever happens at a track boundary — which always publishes a fresh origin
    // — so no origin ever spans two rates.
    rate: u32,
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
    output_tx: Sender<OutputRequest>,
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

    // Follow-the-content output rate switching. Enabling takes effect when the
    // next track is opened. Disabling also asks the decode/output threads to
    // restore the device rate this feature displaced.
    pub fn set_rate_follow(&self, enabled: bool) {
        self.send(Command::SetRateFollow(enabled));
    }

    // Tauri calls this from its final Exit event, while the engine threads are
    // still alive. This path is synchronous because the process is about to go
    // away: merely queueing a restore would let normal teardown win the race.
    pub fn restore_rate_on_exit(&self) {
        self.shared.rate_follow.store(false, Ordering::Relaxed);
        self.shared.shutting_down.store(true, Ordering::Release);
        let (reply_tx, reply_rx) = crossbeam_channel::bounded(1);
        if self
            .output_tx
            .send(OutputRequest::RestoreOnExit { reply: reply_tx })
            .is_err()
        {
            log::warn!("audio: output thread unavailable during sample-rate restore");
            return;
        }
        match reply_rx.recv_timeout(RATE_RESTORE_EXIT_TIMEOUT) {
            Ok(Ok(RestoreOutcome::Restored(rate))) => {
                log::info!("audio: restored output rate to {rate} Hz before exit")
            }
            Ok(Ok(RestoreOutcome::AlreadyRestored(rate))) => {
                log::info!("audio: output rate already restored at {rate} Hz before exit")
            }
            Ok(Ok(RestoreOutcome::ExternalChange { expected, actual })) => log::info!(
                "audio: not restoring output rate before exit: expected Pudding's {expected} Hz, found {actual} Hz"
            ),
            Ok(Ok(RestoreOutcome::NothingToRestore)) => {}
            Ok(Err(e)) => log::warn!("audio: could not restore output rate before exit: {e}"),
            Err(_) => log::warn!("audio: timed out restoring output rate before exit"),
        }
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

    // Drop the delay state. Used when a band goes idle: a band that isn't being
    // run should hold no history, so that if it comes back it starts from
    // silence rather than ringing out whatever it held the last time it ran.
    fn reset_state(&mut self) {
        self.s1 = [0.0; OUT_CHANNELS];
        self.s2 = [0.0; OUT_CHANNELS];
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
    // Indices into `bands` of the bands that actually change the signal, and how
    // many of them there are. A peaking biquad at 0 dB is an exact identity —
    // the RBJ design gives b0 = 1 and b1/b2 equal to a1/a2, so H(z) = 1 — and an
    // enabled EQ sitting at its default is ten of those in series. Running that
    // cascade costs ~880k biquad evaluations a second inside the real-time
    // callback to reproduce the input sample for sample, so we run only the
    // bands the user has actually moved.
    active: [u8; EQ_BAND_COUNT],
    active_len: usize,
    sample_rate: f32,
    last_gen: u64,
}

impl EqChain {
    fn new(sample_rate: u32) -> Self {
        Self {
            enabled: false,
            preamp: 1.0,
            bands: [Biquad::identity(); EQ_BAND_COUNT],
            active: [0; EQ_BAND_COUNT],
            active_len: 0,
            sample_rate: sample_rate as f32,
            // Deliberately not 0: a chain built for a rebuilt stream (rate
            // switch) must adopt whatever the user's EQ is set to on its first
            // callback, and 0 is a gen it could legitimately match.
            last_gen: u64::MAX,
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
        let sample_rate = self.sample_rate;
        let mut active_len = 0;
        for (i, (band, (freq, gain))) in self
            .bands
            .iter_mut()
            .zip(EQ_FREQS.iter().zip(shared.eq_gains_db.iter()))
            .enumerate()
        {
            let gain_db = f32::from_bits(gain.load(Ordering::Relaxed));
            // Exact zero, not an epsilon: 0 dB is the "user never moved this
            // band" resting value the UI writes, and a real setting that happens
            // to be tiny should still be honoured rather than silently dropped.
            if gain_db == 0.0 {
                band.reset_state();
                continue;
            }
            band.set_peaking(*freq, sample_rate, EQ_Q, gain_db);
            self.active[active_len] = i as u8;
            active_len += 1;
        }
        self.active_len = active_len;
    }

    #[inline]
    fn process_block(&mut self, out: &mut [f32]) {
        // No live bands and a unity preamp means the whole chain is an exact
        // identity — leave the buffer alone rather than multiplying it by one.
        if self.active_len == 0 && self.preamp == 1.0 {
            return;
        }
        let preamp = self.preamp;
        let bands = &mut self.bands;
        let active = &self.active[..self.active_len];
        for (i, s) in out.iter_mut().enumerate() {
            let ch = i % OUT_CHANNELS;
            let mut x = *s * preamp;
            for &b in active {
                x = bands[b as usize].process(x, ch);
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
    let output_device = crate::output_device::OutputDevice::default()?;
    let device = output_device.device.clone();

    // Prefer the device's default config. We force stereo and f32; if the
    // device's preferred sample format isn't f32 we still try f32 (cpal
    // converts via the StreamConfig path with format mismatch errors surfaced
    // at build_output_stream time). Most modern OSes are f32 native.
    let default_cfg = device
        .default_output_config()
        .map_err(|e| format!("default_output_config: {e}"))?;
    let output_rate = default_cfg.sample_rate().0;
    let sample_format = default_cfg.sample_format();

    // The rates this device can be switched to, read once and cached: asking
    // cpal instantiates an audio unit, which is far too costly to repeat per
    // track. `default_rate` is where the device was found — the rate we fall
    // back to for content whose own rate can't be followed, so that an odd file
    // leaves the device where its owner had it rather than somewhere arbitrary.
    let device_rates = Arc::new(device_output_rates(&device));
    let default_rate = output_rate;

    let stream_cfg = StreamConfig {
        channels: OUT_CHANNELS as u16,
        sample_rate: SampleRate(output_rate),
        // None lets cpal choose. Letting the OS pick keeps latency reasonable
        // without us hard-coding a buffer that some backend rejects.
        buffer_size: cpal::BufferSize::Default,
    };

    log::info!(
        "audio: device={} rate={} format={:?} channels={} switchable={:?}",
        device.name().unwrap_or_else(|_| "<unknown>".into()),
        output_rate,
        sample_format,
        OUT_CHANNELS,
        device_rates,
    );

    // Ring buffer in samples (not frames). Stereo -> 2 samples per frame. Sized
    // from the rate, so a rate switch rebuilds it (see perform_rate_switch).
    let (rb_producer, rb_consumer) = RingBuffer::<f32>::new(ring_samples(output_rate));

    // Second ring for the visualizer tap: the audio callback pushes, the
    // spectrum thread drains. Sized to a handful of FFT windows so a slow
    // spectrum tick can't back-pressure the audio thread.
    let (viz_producer, viz_consumer) = RingBuffer::<f32>::new(viz_ring_samples());

    let shared = Arc::new(SharedState::new(output_rate));
    let origins = Arc::new(Mutex::new(Origins::default()));
    let rate_ownership = Arc::new(Mutex::new(RateOwnership::default()));
    let (cmd_tx, cmd_rx) = crossbeam_channel::unbounded::<Command>();
    // Rate-switch plumbing. `output_tx` carries both ordinary source-rate
    // rebuilds and guarded restoration requests to the output thread; `viz_tx`
    // carries the replacement visualizer ring the rebuilt stream will fill.
    let (output_tx, output_rx) = crossbeam_channel::unbounded::<OutputRequest>();
    let (viz_tx, viz_rx) = crossbeam_channel::unbounded::<VizHandoff>();

    // Audio callback thread (cpal-owned). The closure captures rb_consumer +
    // a clone of shared and runs exclusively from cpal's output thread. The
    // stream lives on its own thread because cpal::Stream is !Send on some
    // backends (CoreAudio), so we can't store it in Tauri-managed state. That
    // thread holds it for the life of the process; the OS reclaims at exit.
    //
    // It is also where rate switches are executed, for the same !Send reason:
    // the old stream must be dropped before changing the nominal hardware rate,
    // and only this thread may own a stream. See output_thread_loop.
    {
        let device = device.clone();
        let stream_cfg = stream_cfg.clone();
        let shared = Arc::clone(&shared);
        let rate_ownership = Arc::clone(&rate_ownership);
        let (ready_tx, ready_rx) = std::sync::mpsc::sync_channel::<Result<(), String>>(1);
        std::thread::Builder::new()
            .name("audio-output".into())
            .spawn(move || {
                let stream = match build_stream(
                    &device,
                    &stream_cfg,
                    sample_format,
                    rb_consumer,
                    Arc::clone(&shared),
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
                output_thread_loop(
                    &output_device,
                    sample_format,
                    &shared,
                    &rate_ownership,
                    stream,
                    output_rx,
                    viz_tx,
                );
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
        let rate_ownership = Arc::clone(&rate_ownership);
        let app = app.clone();
        let device_rates = Arc::clone(&device_rates);
        let output_tx = output_tx.clone();
        std::thread::Builder::new()
            .name("audio-decode".into())
            .spawn(move || {
                // Feeding the real-time CoreAudio callback is latency-critical:
                // if this thread falls behind, the ring buffer drains and the
                // callback stutters. Tag it USER_INTERACTIVE so macOS keeps it
                // scheduled — otherwise Low Power Mode throttles and deprioritizes
                // it, starving the buffer while the callback keeps draining.
                raise_decode_thread_qos();
                decode_loop(
                    rb_producer,
                    shared,
                    origins,
                    cmd_rx,
                    app,
                    output_rate,
                    device_rates,
                    default_rate,
                    output_tx,
                    rate_ownership,
                );
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
                position_emit_loop(shared, origins, app);
            })
            .map_err(|e| format!("spawn position thread: {e}"))?;
    }

    // Spectrum (visualizer) thread. Drains the viz ring, runs the FFT, and
    // emits bar frames. Owns the viz consumer; nothing else reads it — until a
    // rate switch rebuilds the stream, when it is handed a replacement over
    // viz_rx along with the new rate its Goertzel coefficients depend on.
    {
        let app = app.clone();
        std::thread::Builder::new()
            .name("audio-spectrum".into())
            .spawn(move || {
                waveform_emit_loop(viz_consumer, app, output_rate, viz_rx);
            })
            .map_err(|e| format!("spawn spectrum thread: {e}"))?;
    }

    Ok(AudioEngine {
        cmd_tx,
        shared,
        output_tx,
    })
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
    // Set when a flush drains the ring, cleared by the first callback that
    // reads anything back. While it's set the ring is *supposed* to be empty
    // (the decode thread is parked in flush_and_wait until we ack), so the
    // silence we emit is intentional and must not be counted as an underrun.
    post_flush: bool,
}

fn build_stream(
    device: &cpal::Device,
    cfg: &StreamConfig,
    sample_format: SampleFormat,
    rb: RbConsumer<f32>,
    shared: Arc<SharedState>,
    viz: RbProducer<f32>,
) -> Result<cpal::Stream, String> {
    // Seed the flush handshake from the live counter. A rebuilt stream gets a
    // brand-new ConsumerState, and starting it at 0 while flush_gen has long
    // since moved on would make the very first callback believe a flush is
    // outstanding — draining the ring the decode thread just pre-filled and
    // chopping the start of the track. (On the first build the counter is 0
    // anyway, so this is a no-op there.)
    let gen = shared.flush_gen.load(Ordering::Acquire);
    shared.flush_gen_acked.store(gen, Ordering::Release);
    let mut state = ConsumerState {
        rb,
        shared,
        last_flush_gen: gen,
        viz,
        eq: EqChain::new(cfg.sample_rate.0),
        // The ring holds only what was pre-filled before this stream existed,
        // and nothing has read it yet: the same "silence here is by design"
        // state a flush leaves behind, so borrow its underrun suppression.
        post_flush: true,
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
        state.post_flush = true;
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

    // Any audio at all means the producer has refilled the ring after a flush.
    if written > 0 {
        state.post_flush = false;
    }

    // Count the shortfall so it can be reported off the real-time thread. Three
    // cases silence the ring by design rather than by starvation, and all are
    // gated out here: once the decode thread has drained the queue the ring is
    // *supposed* to empty (that's the end of playback, not starvation); a
    // seek deliberately empties it — the callback that performs the drain then
    // finds nothing to read, since the decode thread stays parked in
    // flush_and_wait until we ack (without post_flush every seek logged a
    // one-callback underrun); and a pending rate switch is the decode thread
    // deliberately letting the ring run dry so the device can be rebuilt; and a
    // parked download is the decode thread with nothing it is allowed to decode
    // yet (see Fetch), which is a wait, not a starve.
    if written < want
        && !state.shared.queue_exhausted.load(Ordering::Relaxed)
        && !state.post_flush
        && !state.shared.rate_switch_pending.load(Ordering::Relaxed)
        && !state.shared.fetching.load(Ordering::Relaxed)
    {
        state.shared.underrun_events.fetch_add(1, Ordering::Relaxed);
        state
            .shared
            .underrun_frames
            .fetch_add(((want - written) / OUT_CHANNELS) as u64, Ordering::Relaxed);
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
    // Whether the container actually declared its sample rate, as opposed to us
    // defaulting to 44.1 kHz because it didn't. Only a declared rate may drive a
    // device rate switch: reconfiguring the machine's output on a guess is worse
    // than not following at all.
    //
    // A declaration can also be wrong (a 22.05 kHz ALAC declaring 44.1 — see
    // spec_reconcile_tests), and that is fine: spec_resolved rebuilds the
    // resampler from the decoded buffer's spec, so a bad declaration costs at
    // worst a suboptimal device rate, never wrong-sounding audio.
    input_rate_declared: bool,
    duration_seconds: f64,
    path: String,
    // Resampler kept across decode calls so internal state (sinc taps) carries
    // over between symphonia packets. Recreated per-track because input rate
    // or channel count may change.
    resampler: ResampleStage,
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

#[allow(clippy::too_many_arguments)]
fn decode_loop(
    mut rb: RbProducer<f32>,
    shared: Arc<SharedState>,
    origins: Arc<Mutex<Origins>>,
    cmd_rx: Receiver<Command>,
    app: AppHandle,
    // Mutable: the device rate can change under us when a track asks for one we
    // can follow. This thread is the only writer (it also publishes the value on
    // shared.output_rate for the threads that only read it).
    mut output_rate: u32,
    device_rates: Arc<Vec<u32>>,
    default_rate: u32,
    output_tx: Sender<OutputRequest>,
    rate_ownership: Arc<Mutex<RateOwnership>>,
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
    // This thread must never wait on a cloud file. It is the transport's command
    // loop as much as it is the decoder, and the ring buffer it feeds holds one
    // second: a read that blocks here stops Pause/Next/Stop from being processed
    // AND cuts the currently playing track to silence, for however long a
    // provider takes to hand over a file nobody asked it to fetch yet. Opted out,
    // such a read fails instantly and `advance_to_next_playable` reports the
    // track as needing a download instead. See dataless.rs.
    dataless::never_materialize_on_this_thread();
    // The download the decoder is parked on, when any. Set and cleared through
    // seat_advance; polled below while the frontier is empty.
    let mut fetching: Option<Fetch> = None;
    // Radio session. Mutually exclusive with `frontier`: Play and PlayStream
    // each clear the other mode before installing their own source.
    let mut stream: Option<StreamSession> = None;

    // Producer-side cumulative stereo frames pushed since the last full reset
    // (Play command). Matches shared.total_produced.
    let mut producer_frames: u64 = 0;
    // An armed rate switch waiting on its drain barrier. While this is Some the
    // frontier track is open but NOTHING is decoded or pushed: the previous
    // track's audio has to finish sounding before the device can be rebuilt at
    // the new rate. See PendingSwitch and perform_rate_switch.
    let mut pending_switch: Option<PendingSwitch> = None;
    // A failed paused rewind leaves the ring intact until resume or another
    // command changes the source. Do not keep reopening an unavailable file.
    let mut paused_restore_deferred = false;

    loop {
        // Drain commands non-blocking. Most iterations have none; when a
        // command does arrive it's usually TogglePause or Seek.
        loop {
            let command = cmd_rx.try_recv();
            if command.is_ok() {
                if paused_restore_deferred {
                    // Time spent intentionally paused must not exhaust the drain
                    // budget: resume still needs time to play the preserved ring.
                    if let Some(ref mut ps) = pending_switch {
                        ps.deadline = Instant::now() + RATE_SWITCH_DRAIN_TIMEOUT;
                    }
                }
                paused_restore_deferred = false;
            }
            match command {
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
                        let adv = advance_to_next_playable(
                            &queue,
                            &mut frontier_idx,
                            output_rate,
                            producer_frames,
                            &shared,
                            &origins,
                            &app,
                            &device_rates,
                            default_rate,
                        );
                        let seat = seat_advance(adv, &mut frontier, &mut fetching, &shared, &app);
                        pending_switch =
                            update_rate_switch(&shared, pending_switch, seat.switch_to);
                        if seat.exhausted {
                            emit_state(&app, false, false);
                        }
                    }
                    Command::PlayStream { url } => {
                        queue.clear();
                        frontier_idx = 0;
                        frontier = None;
                        cancel_fetch(&mut fetching, &shared, &app);
                        // Radio never follows content rate (see decode_loop's
                        // rate-switch notes), and the file the switch was armed
                        // for is gone regardless.
                        pending_switch = update_rate_switch(&shared, pending_switch, None);
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
                        // auto-advance reaches the new tracks with no flush. Same
                        // for a track still being downloaded from the cloud: the
                        // decode hasn't started, so `frontier` is None, but the
                        // queue has NOT drained — the engine is parked on a fetch.
                        // Taking the branch below would re-advance onto that same
                        // track, and seat_advance cancels and restarts the fetch
                        // unconditionally, throwing away the download in progress.
                        // The fetch's own completion (see the poll below) advances
                        // into whatever the queue holds by then, appends included.
                        if frontier.is_none() && stream.is_none() && fetching.is_none() {
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
                                let adv = advance_to_next_playable(
                                    &queue,
                                    &mut frontier_idx,
                                    output_rate,
                                    producer_frames,
                                    &shared,
                                    &origins,
                                    &app,
                                    &device_rates,
                                    default_rate,
                                );
                                let seat =
                                    seat_advance(adv, &mut frontier, &mut fetching, &shared, &app);
                                pending_switch =
                                    update_rate_switch(&shared, pending_switch, seat.switch_to);
                            } else {
                                // Nothing is audible (never started, or the tail has
                                // fully drained): a full reset re-bases the frame
                                // counters like a fresh Play, which is safe because
                                // the flush has nothing to chop.
                                producer_frames = 0;
                                reset_for_new_playback(&shared, &origins);
                                emit_state(&app, true, true);
                                let adv = advance_to_next_playable(
                                    &queue,
                                    &mut frontier_idx,
                                    output_rate,
                                    producer_frames,
                                    &shared,
                                    &origins,
                                    &app,
                                    &device_rates,
                                    default_rate,
                                );
                                let seat =
                                    seat_advance(adv, &mut frontier, &mut fetching, &shared, &app);
                                pending_switch =
                                    update_rate_switch(&shared, pending_switch, seat.switch_to);
                                if seat.exhausted {
                                    emit_state(&app, false, false);
                                }
                            }
                        }
                    }
                    Command::SetRateFollow(enabled) => {
                        shared.rate_follow.store(enabled, Ordering::Relaxed);
                        if !enabled {
                            // Cancel a source switch that has not happened yet,
                            // then restore any rate a completed switch displaced.
                            publish_cancelled_follow_origin(
                                pending_switch,
                                frontier.as_ref(),
                                frontier_idx,
                                producer_frames,
                                &shared,
                                &origins,
                            );
                            pending_switch = arm_rate_restore(&shared, &rate_ownership);
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
                        cancel_fetch(&mut fetching, &shared, &app);
                        stream = None;
                        pending_switch = update_rate_switch(&shared, pending_switch, None);
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
                        // A seek acts on the track the user hears, which is
                        // already playing at the running device rate. Any switch
                        // armed for the *next* track is moot: the frontier has
                        // just been re-seated onto the audible one.
                        pending_switch = update_rate_switch(&shared, pending_switch, None);
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
                                output_rate,
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

        // A pause can arrive after restoration was armed. Rewind before
        // discarding buffered audio, and defer restoration until resume if the
        // audible file cannot be reopened and sought without losing that audio.
        if shared.paused.load(Ordering::Relaxed)
            && matches!(
                pending_switch,
                Some(PendingSwitch {
                    purpose: SwitchPurpose::Restore { .. },
                    ..
                })
            )
        {
            if paused_restore_deferred
                || !flush_paused_restore(
                    &shared,
                    &origins,
                    &queue,
                    output_rate,
                    &mut frontier,
                    &mut frontier_idx,
                    &mut producer_frames,
                )
            {
                paused_restore_deferred = true;
                std::thread::sleep(Duration::from_millis(10));
                continue;
            }
            if frontier.is_some() {
                cancel_fetch(&mut fetching, &shared, &app);
            }
        }

        // Idle conditions: paused, or nothing loaded. In both cases sleep
        // briefly and re-check commands. We don't block on the channel because
        // the audio callback continues running and we want fast response on
        // resume. A paused stream holds no connection (dropped at pause time),
        // so idling here costs nothing.
        if shared.paused.load(Ordering::Relaxed)
            && !matches!(
                pending_switch,
                Some(PendingSwitch {
                    purpose: SwitchPurpose::Restore { .. },
                    ..
                })
            )
        {
            std::thread::sleep(Duration::from_millis(10));
            continue;
        }

        // Rate-switch drain barrier. The frontier track wants a device rate we
        // aren't running, and rebuilding the device silences it — so hold here,
        // pushing nothing, until every frame the previous track produced has
        // been played (the same accounting queue-ended uses: produced frames are
        // eventually either played or discarded by a flush). Commands keep being
        // served at the top of the loop, so this stays responsive; a pause parks
        // the barrier above rather than deadlocking on a callback that has
        // stopped draining.
        if let Some(ps) = pending_switch {
            let produced = shared.total_produced.load(Ordering::Relaxed);
            let played = shared.frames_played.load(Ordering::Relaxed);
            let drained = shared.total_drained.load(Ordering::Relaxed);
            let timed_out = Instant::now() >= ps.deadline;
            if played + drained < produced && !timed_out {
                std::thread::sleep(Duration::from_millis(2));
                continue;
            }
            if timed_out {
                // Whatever is still buffered dies with the ring the old stream
                // was reading. Every produced frame is either played or
                // discarded, so book the remainder as discarded — otherwise
                // queue-ended waits forever on frames that no longer exist.
                let lost = produced.saturating_sub(played + drained);
                if lost > 0 {
                    shared.total_drained.fetch_add(lost, Ordering::Relaxed);
                }
                log::warn!(
                    "audio: rate-switch drain barrier timed out ({played}+{drained} of {produced} frames); dropping {lost} and switching anyway"
                );
            }
            pending_switch = None;
            let restoring = matches!(ps.purpose, SwitchPurpose::Restore { .. });
            let restore_position = if restoring {
                restore_position_for_frontier(&origins, played, frontier_idx)
            } else {
                0.0
            };
            match perform_rate_switch(&mut rb, ps.target_rate, output_rate, ps.purpose, &output_tx)
            {
                Ok(switched) => {
                    // The pre-roll silence is real produced audio and has to be
                    // counted, or queue-ended would wait forever for frames that
                    // were never accounted for. Counting it here also puts the
                    // new track's origin past it, so position starts at the
                    // track's first real sample rather than inside the silence.
                    shared.rate_switch_pending.store(false, Ordering::Relaxed);
                    if switched.rebuilt {
                        producer_frames += switched.preroll_frames;
                        shared
                            .total_produced
                            .fetch_add(switched.preroll_frames, Ordering::Relaxed);
                        output_rate = switched.rate;
                        shared.output_rate.store(output_rate, Ordering::Relaxed);
                        if let Some(ref mut tr) = frontier {
                            // Re-point the track at the rate now running. A normal
                            // source-follow switch happens before this track has
                            // decoded anything. A restore can happen mid-track, so
                            // retain pending input and rebase its position instead.
                            tr.output_rate = output_rate;
                            tr.resampler =
                                make_resampler(tr.input_rate, output_rate, tr.input_channels);
                            if !restoring {
                                tr.pending_in = vec![Vec::new(); tr.input_channels];
                                tr.flushed = false;
                            }
                            publish_origin(
                                &origins,
                                &shared,
                                producer_frames,
                                frontier_idx,
                                &tr.path,
                                tr.duration_seconds,
                                restore_position,
                                output_rate,
                            );
                        }
                        if restoring {
                            if let Some(tr) = stream.as_mut().and_then(|s| s.reader.as_mut()) {
                                tr.output_rate = output_rate;
                                tr.resampler =
                                    make_resampler(tr.input_rate, output_rate, tr.input_channels);
                            }
                        }
                    }
                }
                Err(e) => {
                    // Both the new rate and the rate we were running failed to
                    // build: there is no output stream at all now. Stop rather
                    // than decode into a ring nobody reads.
                    log::error!("audio: rate switch failed: {e}");
                    shared.rate_switch_pending.store(false, Ordering::Relaxed);
                    if let Some(ref tr) = frontier {
                        emit_error(
                            &app,
                            &PathBuf::from(&tr.path),
                            &format!("audio output unavailable: {e}"),
                        );
                    }
                    frontier = None;
                    cancel_fetch(&mut fetching, &shared, &app);
                    shared.queue_exhausted.store(true, Ordering::Relaxed);
                    shared.paused.store(true, Ordering::Relaxed);
                    emit_state(&app, false, false);
                }
            }
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
            // Parked on a download: check it without blocking, then either play
            // the track that just landed or give up on it and move along. The
            // command drain at the top of the loop has been running throughout,
            // so the transport stayed live the whole time the file was coming
            // down — the user could have hit Next and never reached this.
            if let Some(state) = fetching.as_ref().map(|f| f.state.load(Ordering::Acquire)) {
                if state != FETCH_PENDING {
                    let path = fetching.take().expect("checked above").path;
                    shared.fetching.store(false, Ordering::Relaxed);
                    emit_fetching(&app, None);
                    // "Downloaded" but still dataless would send us straight back
                    // to parking on the same track forever, so treat it exactly
                    // like a failure: report it once and step past.
                    if state == FETCH_FAILED || dataless::path_is_dataless(&path) {
                        emit_error(&app, &path, "could not download");
                        frontier_idx += 1;
                    }
                    let adv = advance_to_next_playable(
                        &queue,
                        &mut frontier_idx,
                        output_rate,
                        producer_frames,
                        &shared,
                        &origins,
                        &app,
                        &device_rates,
                        default_rate,
                    );
                    let seat = seat_advance(adv, &mut frontier, &mut fetching, &shared, &app);
                    pending_switch = update_rate_switch(&shared, pending_switch, seat.switch_to);
                    if seat.exhausted {
                        emit_state(&app, false, false);
                    }
                    continue;
                }
            }
            std::thread::sleep(Duration::from_millis(10));
            continue;
        }

        // Decode + push the next chunk.
        let tr = frontier.as_mut().unwrap();
        match decode_and_push(tr, &mut rb, &shared, &mut producer_frames) {
            Ok(StepOutcome::Continue) => {}
            Ok(StepOutcome::TrackEnded) => {
                frontier_idx += 1;
                let adv = advance_to_next_playable(
                    &queue,
                    &mut frontier_idx,
                    output_rate,
                    producer_frames,
                    &shared,
                    &origins,
                    &app,
                    &device_rates,
                    default_rate,
                );
                let seat = seat_advance(adv, &mut frontier, &mut fetching, &shared, &app);
                pending_switch = update_rate_switch(&shared, pending_switch, seat.switch_to);
                // An exhausted queue leaves frontier=None (seat_advance sets the
                // flag); the position-emit thread fires queue-ended once playback
                // drains. A parked download leaves it None too, but not exhausted —
                // that one resumes rather than ending.
            }
            Err(e) => {
                log::warn!("audio: decode error: {e}");
                let path = tr.path.clone();
                emit_error(&app, &PathBuf::from(&path), &e);
                frontier_idx += 1;
                let adv = advance_to_next_playable(
                    &queue,
                    &mut frontier_idx,
                    output_rate,
                    producer_frames,
                    &shared,
                    &origins,
                    &app,
                    &device_rates,
                    default_rate,
                );
                let seat = seat_advance(adv, &mut frontier, &mut fetching, &shared, &app);
                pending_switch = update_rate_switch(&shared, pending_switch, seat.switch_to);
                // Exhaustion (and the parked-download case that is not it) is
                // seat_advance's call; see the note above.
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
    let input_rate_declared = track.codec_params.sample_rate.is_some();
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
            input_rate_declared,
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

// What advancing the decode frontier produced: the opened track, and the device
// rate it wants if that isn't the one already running.
//
// A track that needs no rate change has its origin published during the advance,
// exactly as before — the gapless path is untouched. A track that does need one
// can't publish yet: its audio lands after a pre-roll whose length isn't known
// until the switch actually happens, so the caller publishes once the rebuilt
// device is running. See decode_loop's drain barrier.
struct Advance {
    reader: Option<TrackReader>,
    switch_to: Option<u32>,
    // Set when the walk stopped on a cloud file that isn't downloaded. The track
    // is not skipped and frontier_idx still points at it: the caller starts the
    // download and parks until it lands. A reader of None with this set means
    // "waiting", which is emphatically not "queue exhausted" — see seat_advance.
    needs_fetch: Option<PathBuf>,
}

// A download in flight for the track the decoder is parked on.
//
// The decode thread cannot do this itself: it is the transport's command loop,
// and a materializing read blocks for as long as the provider takes (~37s for an
// 8 MB track over Proton Drive, unbounded in principle), during which Pause and
// Next would go unprocessed and the one-second ring buffer would run dry mid-
// track. So the wait happens here, on a thread that has not opted out of
// materializing, and the decoder polls a flag while staying live.
//
// There is no cancel: a read blocked in the kernel cannot be interrupted. Stop
// or a new Play simply drops the handle, and the orphaned thread finishes its
// download into the page cache — where the file is exactly what the user would
// have wanted next time — and exits.
struct Fetch {
    path: PathBuf,
    state: Arc<AtomicU8>,
}

const FETCH_PENDING: u8 = 0;
const FETCH_DONE: u8 = 1;
const FETCH_FAILED: u8 = 2;

fn start_fetch(path: PathBuf, app: &AppHandle) -> Fetch {
    let state = Arc::new(AtomicU8::new(FETCH_PENDING));
    let worker_state = Arc::clone(&state);
    let worker_path = path.clone();
    let worker_app = app.clone();
    std::thread::spawn(move || {
        let outcome = match crate::dataless::materialize(&worker_path) {
            Ok(()) => FETCH_DONE,
            Err(e) => {
                log::warn!("audio: download {} failed: {e}", worker_path.display());
                FETCH_FAILED
            }
        };
        // The read can come back Ok with the file still dataless (the provider
        // gave up, or handed back a placeholder); that is not a download, and the
        // decode thread treats it as a failure below. Ask the filesystem rather
        // than trusting the read, so nothing downstream is told the bytes landed
        // when they didn't.
        let landed = outcome == FETCH_DONE && !dataless::path_is_dataless(&worker_path);
        // Read the file now that it is local: a header read, off the page cache the
        // download just filled. The cache row and the rows the UI is holding are
        // both describing this file as the scanner last saw it — untagged, because
        // reading tags is what the scanner refused to do — and both are corrected
        // from this one read.
        let facts = landed.then(|| crate::read_disk_facts(&worker_path));
        // Before the store, so the fresh row reaches the UI ahead of the
        // fetching-cleared event the decode thread emits on seeing it. Both repaint
        // the same row: out of order, it would blink back to a filename and a
        // "(Not downloaded)" marker for a frame between them.
        if let Some(f) = &facts {
            emit_downloaded(&worker_app, &crate::row_from_facts(&worker_path, f));
        }
        worker_state.store(outcome, Ordering::Release);
        // After the store, deliberately: correcting the scan cache takes the DB
        // writer lock, which a running library scan can hold for the length of a
        // whole walk. Playback has been waiting on this download for tens of
        // seconds already and must not wait on a scan too.
        if let Some(f) = &facts {
            crate::reindex_downloaded(&worker_app, &worker_path, f);
        }
    });
    emit_fetching(app, Some(&path));
    Fetch { path, state }
}

// Stop waiting on a download, because whatever we were waiting *for* is gone —
// the queue was torn down, replaced by a station, or the output died. The worker
// thread is not interruptible and finishes on its own; dropping the handle is
// what makes its result irrelevant.
fn cancel_fetch(fetching: &mut Option<Fetch>, shared: &Arc<SharedState>, app: &AppHandle) {
    if fetching.take().is_some() {
        shared.fetching.store(false, Ordering::Relaxed);
        emit_fetching(app, None);
    }
}

// Seat whatever the walk came back with, and keep the three outcomes apart:
// a reader (play it), a fetch (park on it — the queue is NOT exhausted, audio
// resumes when the file lands), or nothing left (it really is). Returns the
// rate switch to arm and whether the queue ran out, because two callers also
// emit a stopped state on that.
struct Seat {
    switch_to: Option<u32>,
    exhausted: bool,
}

fn seat_advance(
    adv: Advance,
    frontier: &mut Option<TrackReader>,
    fetching: &mut Option<Fetch>,
    shared: &Arc<SharedState>,
    app: &AppHandle,
) -> Seat {
    // Any advance supersedes a park: whatever we were waiting for, we are not
    // waiting for it now. Clearing before starting the new one also means Play
    // and Stop get this for free rather than each remembering to.
    cancel_fetch(fetching, shared, app);
    *frontier = adv.reader;
    if let Some(path) = adv.needs_fetch {
        *fetching = Some(start_fetch(path, app));
        shared.fetching.store(true, Ordering::Relaxed);
        // Parked, not finished. Leaving this set would fire queue-ended and stop
        // the transport under a download that is about to succeed.
        shared.queue_exhausted.store(false, Ordering::Relaxed);
        return Seat {
            switch_to: adv.switch_to,
            exhausted: false,
        };
    }
    let exhausted = frontier.is_none();
    if exhausted {
        shared.queue_exhausted.store(true, Ordering::Relaxed);
    }
    Seat {
        switch_to: adv.switch_to,
        exhausted,
    }
}

// Open the next playable track at or after frontier_idx, skipping (and reporting)
// any that fail to open. Returns a reader of None when the queue is exhausted.
#[allow(clippy::too_many_arguments)]
fn advance_to_next_playable(
    queue: &[PathBuf],
    frontier_idx: &mut usize,
    output_rate: u32,
    producer_frames: u64,
    shared: &Arc<SharedState>,
    origins: &Arc<Mutex<Origins>>,
    app: &AppHandle,
    device_rates: &[u32],
    default_rate: u32,
) -> Advance {
    let rg_mode = shared.rg_mode.load(Ordering::Relaxed);
    let follow = shared.rate_follow.load(Ordering::Relaxed);
    while *frontier_idx < queue.len() {
        // Ask before opening, because opening is the expensive question. This
        // thread has opted out of materializing cloud files (see decode_loop), so
        // open_track on one would come back as a plain failure and the track
        // would be *skipped* — a file the user owns silently vanishing from its
        // own queue. Stop here instead and let the caller fetch it.
        if dataless::path_is_dataless(&queue[*frontier_idx]) {
            return Advance {
                reader: None,
                switch_to: None,
                needs_fetch: Some(queue[*frontier_idx].clone()),
            };
        }
        match open_track(&queue[*frontier_idx], output_rate, rg_mode) {
            Some(reader) => {
                let target = desired_output_rate(
                    follow,
                    reader.input_rate_declared,
                    reader.input_rate,
                    device_rates,
                    output_rate,
                    default_rate,
                );
                if target != output_rate {
                    return Advance {
                        reader: Some(reader),
                        switch_to: Some(target),
                        needs_fetch: None,
                    };
                }
                publish_origin(
                    origins,
                    shared,
                    producer_frames,
                    *frontier_idx,
                    &reader.path,
                    reader.duration_seconds,
                    0.0,
                    output_rate,
                );
                return Advance {
                    reader: Some(reader),
                    switch_to: None,
                    needs_fetch: None,
                };
            }
            None => {
                emit_error(app, &queue[*frontier_idx], "could not open");
                *frontier_idx += 1;
            }
        }
    }
    Advance {
        reader: None,
        switch_to: None,
        needs_fetch: None,
    }
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
                let tail = tr
                    .resampler
                    .flush(&tr.pending_in, tr.input_channels)
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
        let out_planar = tr.resampler.process(chunk_in)?;
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
        if rb.is_abandoned() {
            // The consumer went down with a torn-down output stream (a rate
            // switch that failed to rebuild). Nothing will ever make room again,
            // so dropping the samples beats spinning here for the life of the
            // process. The decode thread stops playback on that path anyway.
            return;
        }
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

// === Output rate switching ===
//
// Optional, off by default (Playback > "Match Source Sample Rate").
// Instead of resampling every file to whatever rate the output device happens to
// be set to, put the device at the file's own rate and hand it the samples
// untouched. On macOS we explicitly set the hardware's nominal rate: CPAL's
// output stream format alone only changes its client-side rate. A switch drops
// the output stream, sets the device rate, then builds another stream — and the
// device is silent in between.
//
// That silence is the whole reason for the drain barrier in decode_loop: a
// switch happens only at a track boundary, and only once the previous track has
// finished sounding. Two tracks at the same rate never reach this code at all,
// so the sample-adjacent join between them is exactly what it always was.
//
// This does change a system-wide setting — every other app on the machine is
// resampled by the HAL to the rate we picked — which is why it ships off by
// default. RateOwnership below makes the change session-scoped when it is still
// safe for us to put the prior rate back.

// A switch armed at the moment the frontier track was opened, waiting for the
// previous track to finish playing out.
#[derive(Clone, Copy)]
struct PendingSwitch {
    target_rate: u32,
    purpose: SwitchPurpose,
    // Bound on the wait. A device that has stopped consuming (asleep, wedged,
    // unplugged) must not hold the decode thread here forever.
    deadline: Instant,
}

#[derive(Clone, Copy)]
enum SwitchPurpose {
    Follow,
    Restore { expected_rate: u32 },
}

// A request to rebuild the output stream at a new device rate, decode thread ->
// output thread. cpal::Stream is !Send on CoreAudio, so only the output thread
// may own one, which makes it the only place a rate change can happen. The ring
// buffer is rebuilt too (it's sized in frames, and a frame is a different amount
// of time at a different rate), so its consumer travels with the request.
struct RebuildRequest {
    rate: u32,
    rb: RbConsumer<f32>,
    purpose: SwitchPurpose,
    // The rate actually running when the dust settles, or why it isn't.
    reply: Sender<Result<RebuildOutcome, String>>,
}

// The output thread also owns exit restoration because it is the only thread
// allowed to hold/rebuild cpal::Stream on CoreAudio.
enum OutputRequest {
    Rebuild(RebuildRequest),
    RestoreOnExit {
        reply: Sender<Result<RestoreOutcome, String>>,
    },
}

#[derive(Debug, PartialEq, Eq)]
enum RebuildOutcome {
    Applied(u32),
    AlreadyRestored(u32),
    ExternalChange { expected: u32, actual: u32 },
    ShuttingDown,
}

#[derive(Debug, PartialEq, Eq)]
enum RestoreOutcome {
    Restored(u32),
    AlreadyRestored(u32),
    ExternalChange { expected: u32, actual: u32 },
    NothingToRestore,
}

// Session-only ownership record. Nothing here is a preference: it exists only
// from Pudding's first rate-changing source selection until restoration (or
// until an external change proves the device is no longer ours to restore).
#[derive(Default, Debug)]
struct RateOwnership {
    original_rate: Option<u32>,
    last_selected_rate: Option<u32>,
}

impl RateOwnership {
    fn note_selection(&mut self, rate_before: u32, selected: u32) {
        // A no-op cannot start ownership, but it can correct the guard after
        // a failed build recorded a target the device never reached.
        if rate_before == selected && self.original_rate.is_none() {
            return;
        }
        self.original_rate.get_or_insert(rate_before);
        self.last_selected_rate = Some(selected);
    }

    fn restore_request(&self) -> Option<(u32, u32)> {
        Some((self.original_rate?, self.last_selected_rate?))
    }

    fn restore_target_if_unchanged(&self, current_rate: u32) -> Option<u32> {
        let (original, last_selected) = self.restore_request()?;
        (current_rate == last_selected).then_some(original)
    }

    fn clear(&mut self) {
        self.original_rate = None;
        self.last_selected_rate = None;
    }
}

// The replacement visualizer ring a rebuilt stream fills, output thread ->
// spectrum thread. The old producer died inside the old stream's closure, and
// the spectrum thread's Goertzel coefficients depend on the rate, so both travel
// together.
struct VizHandoff {
    rb: RbConsumer<f32>,
    rate: u32,
}

// What a completed switch tells the decode thread.
struct SwitchResult {
    // The rate now running — the target, or the previous rate if the target
    // failed to build and the fallback took.
    rate: u32,
    // Frames of pre-roll silence pushed ahead of the track. The caller counts
    // these as produced audio (they are: the device will play them).
    preroll_frames: u64,
    // False when the guarded restore deliberately left an externally changed
    // device (and the existing stream/ring) untouched.
    rebuilt: bool,
}

// Ring buffer size in samples for a given output rate. Stereo -> 2 samples per
// frame; RING_BUFFER_SECONDS of headroom either way.
fn ring_samples(rate: u32) -> usize {
    (rate as f32 * RING_BUFFER_SECONDS) as usize * OUT_CHANNELS
}

// The visualizer tap ring: a handful of FFT windows, so a slow spectrum tick
// can't back-pressure the audio thread. Independent of the output rate.
fn viz_ring_samples() -> usize {
    WAVEFORM_WINDOW * OUT_CHANNELS * 4
}

fn preroll_frames(rate: u32) -> u64 {
    rate as u64 * RATE_SWITCH_PREROLL_MS / 1000
}

// The discrete output rates this device can be switched to.
//
// cpal reports one config range per entry in the device's
// AvailableNominalSampleRates. Follow only advertised discrete entries (min ==
// max), rather than guessing the supported steps inside a continuous range. Enumerating
// instantiates an audio unit, so this is called once at startup, never per track.
fn device_output_rates(device: &cpal::Device) -> Vec<u32> {
    let mut rates: Vec<u32> = match device.supported_output_configs() {
        Ok(configs) => configs
            .filter(|c| c.sample_format() == SampleFormat::F32)
            .filter(|c| c.min_sample_rate() == c.max_sample_rate())
            .map(|c| c.min_sample_rate().0)
            .collect(),
        Err(e) => {
            // Not fatal: an empty list simply means nothing is followable and
            // the engine behaves exactly as it did before this feature.
            log::warn!("audio: could not enumerate device sample rates: {e}");
            Vec::new()
        }
    };
    rates.sort_unstable();
    rates.dedup();
    rates
}

// Pick the device rate to play `content_rate` at, given the rates the device
// offers (sorted, discrete):
//
//   1. The content's own rate, if the device has it. The point of the feature.
//   2. Otherwise the smallest supported whole multiple (44.1 -> 88.2 / 176.4,
//      48 -> 96 / 192): an exact integer ratio is the next best thing, and it
//      keeps us inside the content's family rather than crossing 44.1 <-> 48.
//   3. Otherwise the device's own default rate, so a file we can't follow leaves
//      the device where its owner had it instead of somewhere arbitrary.
//   4. Otherwise the lowest rate that isn't a downsample, else the highest on
//      offer — last resorts for a device with an unusual rate list.
//
// Total and pure: with no usable rate list it returns `current`, which every
// caller reads as "don't switch."
fn choose_output_rate(rates: &[u32], content_rate: u32, current: u32, default_rate: u32) -> u32 {
    if rates.is_empty() || content_rate == 0 {
        return current;
    }
    if rates.contains(&content_rate) {
        return content_rate;
    }
    if let Some(multiple) = rates
        .iter()
        .copied()
        .find(|&r| r > content_rate && r % content_rate == 0 && r <= MAX_FOLLOW_RATE)
    {
        return multiple;
    }
    if rates.contains(&default_rate) {
        return default_rate;
    }
    rates
        .iter()
        .copied()
        .find(|&r| r >= content_rate)
        .unwrap_or_else(|| rates[rates.len() - 1])
}

// The rate the frontier's next track wants, or `current` when nothing should
// change. Every reason to suppress a switch funnels through here: the feature
// being off, a container that never declared its rate (we would be reconfiguring
// the machine's audio output on a guess), and a target that is already running.
fn desired_output_rate(
    follow: bool,
    rate_declared: bool,
    content_rate: u32,
    rates: &[u32],
    current: u32,
    default_rate: u32,
) -> u32 {
    if !follow || !rate_declared {
        return current;
    }
    choose_output_rate(rates, content_rate, current, default_rate)
}

// Arm (or cancel) the drain barrier for a switch, and tell the audio callback
// that the silence about to appear in the ring is deliberate. Passing None is
// how every ordinary advance clears a switch that is no longer wanted, so the
// flag can't be left set.
fn arm_rate_switch(shared: &SharedState, target: Option<u32>) -> Option<PendingSwitch> {
    shared
        .rate_switch_pending
        .store(target.is_some(), Ordering::Relaxed);
    target.map(|target_rate| PendingSwitch {
        target_rate,
        purpose: SwitchPurpose::Follow,
        deadline: Instant::now() + RATE_SWITCH_DRAIN_TIMEOUT,
    })
}

// Transport commands may replace a source-follow switch, but restoration is
// a device obligation independent of the current source. Preserve it without
// blocking command reception (including Stop, Seek, Play, and pause).
fn update_rate_switch(
    shared: &SharedState,
    pending: Option<PendingSwitch>,
    target: Option<u32>,
) -> Option<PendingSwitch> {
    if matches!(
        pending,
        Some(PendingSwitch {
            purpose: SwitchPurpose::Restore { .. },
            ..
        })
    ) {
        pending
    } else {
        arm_rate_switch(shared, target)
    }
}

// Opening a track that needs a switch defers its origin until the rebuild.
// Cancelling that switch must publish it at the running rate, even if there is
// nothing to restore or the ownership guard later skips the restoration.
fn publish_cancelled_follow_origin(
    pending_switch: Option<PendingSwitch>,
    frontier: Option<&TrackReader>,
    frontier_idx: usize,
    producer_frames: u64,
    shared: &Arc<SharedState>,
    origins: &Arc<Mutex<Origins>>,
) {
    if let (
        Some(PendingSwitch {
            purpose: SwitchPurpose::Follow,
            ..
        }),
        Some(tr),
    ) = (pending_switch, frontier)
    {
        publish_origin(
            origins,
            shared,
            producer_frames,
            frontier_idx,
            &tr.path,
            tr.duration_seconds,
            0.0,
            tr.output_rate,
        );
    }
}

fn arm_rate_restore(
    shared: &SharedState,
    ownership: &Mutex<RateOwnership>,
) -> Option<PendingSwitch> {
    let request = ownership
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .restore_request();
    shared
        .rate_switch_pending
        .store(request.is_some(), Ordering::Relaxed);
    request.map(|(target_rate, expected_rate)| PendingSwitch {
        target_rate,
        purpose: SwitchPurpose::Restore { expected_rate },
        deadline: Instant::now() + RATE_SWITCH_DRAIN_TIMEOUT,
    })
}

// Execute an armed switch. Called only once the drain barrier has cleared, so
// the ring is empty and everything the previous track produced has sounded.
//
// The old ring dies with the old stream, so each attempt builds a fresh one,
// pre-fills it with silence and hands the consumer over. A failed attempt can't
// be retried with the same ring (the failed build consumed it), which is why the
// fallback to the previous rate gets a ring of its own. If both attempts fail
// there is no output stream at all and the caller stops playback.
fn perform_rate_switch(
    rb: &mut RbProducer<f32>,
    target_rate: u32,
    current_rate: u32,
    purpose: SwitchPurpose,
    output_tx: &Sender<OutputRequest>,
) -> Result<SwitchResult, String> {
    // An empty ring is not a silent device: the callback hands the device a
    // buffer at a time, so the last frames read are still in flight. Tearing the
    // stream down now would clip the end of the track that just finished.
    std::thread::sleep(Duration::from_millis(RATE_SWITCH_SETTLE_MS));

    let mut candidates = vec![target_rate];
    if current_rate != target_rate {
        candidates.push(current_rate);
    }
    let mut last_err = String::from("no rate to try");
    for (attempt, rate) in candidates.into_iter().enumerate() {
        if attempt > 0 {
            log::warn!("audio: {target_rate} Hz failed ({last_err}); falling back to {rate} Hz");
        }
        let (mut producer, consumer) = RingBuffer::<f32>::new(ring_samples(rate));
        let preroll = preroll_frames(rate);
        // Fits by construction (RATE_SWITCH_PREROLL_MS is a fraction of
        // RING_BUFFER_SECONDS), so this never blocks on a ring nobody reads yet.
        push_blocking(&mut producer, &vec![0.0; preroll as usize * OUT_CHANNELS]);

        let (reply_tx, reply_rx) = crossbeam_channel::bounded::<Result<RebuildOutcome, String>>(1);
        if output_tx
            .send(OutputRequest::Rebuild(RebuildRequest {
                rate,
                rb: consumer,
                purpose: if attempt == 0 {
                    purpose
                } else {
                    SwitchPurpose::Follow
                },
                reply: reply_tx,
            }))
            .is_err()
        {
            return Err("output thread is gone".to_string());
        }
        match reply_rx.recv_timeout(RATE_SWITCH_REBUILD_TIMEOUT) {
            Ok(Ok(RebuildOutcome::Applied(actual))) => {
                *rb = producer;
                log::info!("audio: output rate {current_rate} -> {actual} Hz");
                return Ok(SwitchResult {
                    rate: actual,
                    preroll_frames: preroll,
                    rebuilt: true,
                });
            }
            Ok(Ok(RebuildOutcome::AlreadyRestored(actual))) => {
                return Ok(SwitchResult {
                    rate: actual,
                    preroll_frames: 0,
                    rebuilt: false,
                });
            }
            Ok(Ok(RebuildOutcome::ExternalChange { expected, actual })) => {
                log::info!(
                    "audio: not restoring output rate: expected Pudding's {expected} Hz, found {actual} Hz"
                );
                return Ok(SwitchResult {
                    // The live stream/ring were deliberately left untouched.
                    rate: current_rate,
                    preroll_frames: 0,
                    rebuilt: false,
                });
            }
            Ok(Ok(RebuildOutcome::ShuttingDown)) => {
                return Ok(SwitchResult {
                    rate: current_rate,
                    preroll_frames: 0,
                    rebuilt: false,
                });
            }
            Ok(Err(e)) => last_err = e,
            // The output thread may still be working on it. Requests are served
            // in order, so a fallback queued now still ends up as the live
            // stream — and the ring we hand it is the one we keep.
            Err(_) => last_err = "output thread did not answer in time".to_string(),
        }
    }
    Err(last_err)
}

// The output thread's steady state: hold the stream open, and serve rate
// switches when they come.
//
// Parking forever was this thread's whole job before rate switching, and still
// is whenever nobody asks for a new rate: dropping a stream tears the device
// down, so the only reason to do it is to build another one.
fn output_thread_loop(
    device: &crate::output_device::OutputDevice,
    sample_format: SampleFormat,
    shared: &Arc<SharedState>,
    ownership: &Arc<Mutex<RateOwnership>>,
    stream: cpal::Stream,
    output_rx: Receiver<OutputRequest>,
    viz_tx: Sender<VizHandoff>,
) {
    let mut stream = Some(stream);
    loop {
        let Ok(request) = output_rx.recv() else {
            // Nobody can ask for a switch any more (the decode thread is gone).
            // Park holding the stream, exactly as this thread did before
            // switching existed — returning would drop it and kill the device.
            loop {
                std::thread::park();
            }
        };
        match request {
            OutputRequest::Rebuild(req) => {
                let RebuildRequest {
                    rate,
                    rb,
                    purpose,
                    reply,
                } = req;
                if matches!(purpose, SwitchPurpose::Follow)
                    && shared.shutting_down.load(Ordering::Acquire)
                {
                    let _ = reply.send(Ok(RebuildOutcome::ShuttingDown));
                    continue;
                }

                // This is deliberately queried here, immediately before the
                // only operation that can alter the device. It is both the
                // value we promise to restore and the guard against trampling a
                // later user/third-party change.
                let rate_before = match device.current_rate() {
                    Ok(rate) => rate,
                    Err(e) => {
                        let _ = reply.send(Err(e));
                        continue;
                    }
                };
                if let SwitchPurpose::Restore { expected_rate } = purpose {
                    let restore_target = ownership
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .restore_target_if_unchanged(rate_before);
                    if restore_target != Some(rate) {
                        ownership.lock().unwrap_or_else(|e| e.into_inner()).clear();
                        let _ = reply.send(Ok(RebuildOutcome::ExternalChange {
                            expected: expected_rate,
                            actual: rate_before,
                        }));
                        continue;
                    }
                    if rate_before == rate {
                        ownership.lock().unwrap_or_else(|e| e.into_inner()).clear();
                        let _ = reply.send(Ok(RebuildOutcome::AlreadyRestored(rate)));
                        continue;
                    }
                } else {
                    // Record before dropping/building the stream. Even a failed
                    // build can have changed CoreAudio's nominal device rate.
                    ownership
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .note_selection(rate_before, rate);
                }

                // Release the device before asking for a new nominal rate.
                drop(stream.take());
                match build_replacement(device, sample_format, shared, rate, rb) {
                    Ok((s, viz_consumer)) => {
                        stream = Some(s);
                        shared.output_rate.store(rate, Ordering::Relaxed);
                        if matches!(purpose, SwitchPurpose::Restore { .. }) {
                            ownership.lock().unwrap_or_else(|e| e.into_inner()).clear();
                        }
                        let _ = viz_tx.send(VizHandoff {
                            rb: viz_consumer,
                            rate,
                        });
                        let _ = reply.send(Ok(RebuildOutcome::Applied(rate)));
                    }
                    Err(e) => {
                        // The device is silent now: the old stream is gone and
                        // the new one never started. The decode thread retries
                        // at the rate that was working, with a ring of its own.
                        log::error!("audio: rebuild at {rate} Hz failed: {e}");
                        let _ = reply.send(Err(e));
                    }
                }
            }
            OutputRequest::RestoreOnExit { reply } => {
                let Some((original, expected)) = ownership
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .restore_request()
                else {
                    let _ = reply.send(Ok(RestoreOutcome::NothingToRestore));
                    continue;
                };
                let actual = match device.current_rate() {
                    Ok(rate) => rate,
                    Err(e) => {
                        let _ = reply.send(Err(e));
                        continue;
                    }
                };
                let restore_target = ownership
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .restore_target_if_unchanged(actual);
                if restore_target != Some(original) {
                    ownership.lock().unwrap_or_else(|e| e.into_inner()).clear();
                    let _ = reply.send(Ok(RestoreOutcome::ExternalChange { expected, actual }));
                    continue;
                }
                if actual == original {
                    ownership.lock().unwrap_or_else(|e| e.into_inner()).clear();
                    let _ = reply.send(Ok(RestoreOutcome::AlreadyRestored(original)));
                    continue;
                }

                // Playback is ending with the process, so this ring intentionally
                // contains no program audio. Holding the restored stream until
                // teardown makes the nominal-rate change stick reliably.
                let (_producer, consumer) = RingBuffer::<f32>::new(ring_samples(original));
                drop(stream.take());
                match build_replacement(device, sample_format, shared, original, consumer) {
                    Ok((s, _viz_consumer)) => {
                        stream = Some(s);
                        shared.output_rate.store(original, Ordering::Relaxed);
                        ownership.lock().unwrap_or_else(|e| e.into_inner()).clear();
                        let _ = reply.send(Ok(RestoreOutcome::Restored(original)));
                    }
                    Err(e) => {
                        log::error!("audio: exit restore at {original} Hz failed: {e}");
                        let _ = reply.send(Err(e));
                    }
                }
            }
        }
    }
}

fn build_replacement(
    device: &crate::output_device::OutputDevice,
    sample_format: SampleFormat,
    shared: &Arc<SharedState>,
    rate: u32,
    rb: RbConsumer<f32>,
) -> Result<(cpal::Stream, RbConsumer<f32>), String> {
    // On macOS the output AudioUnit's client format does not set the hardware
    // rate. Change the nominal rate explicitly before constructing the stream.
    device.set_rate(rate)?;
    let cfg = StreamConfig {
        channels: OUT_CHANNELS as u16,
        sample_rate: SampleRate(rate),
        buffer_size: cpal::BufferSize::Default,
    };
    let (viz_producer, viz_consumer) = RingBuffer::<f32>::new(viz_ring_samples());
    let stream = build_stream(
        &device.device,
        &cfg,
        sample_format,
        rb,
        Arc::clone(shared),
        viz_producer,
    )?;
    stream.play().map_err(|e| format!("stream.play: {e}"))?;
    device.verify_rate(rate)?;
    Ok((stream, viz_consumer))
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
    let input_rate_declared = default_track.codec_params.sample_rate.is_some();
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
        input_rate_declared,
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
        tag.get_string(k).and_then(|s| {
            s.trim()
                .trim_end_matches(|c: char| c.is_alphabetic())
                .trim()
                .parse::<f32>()
                .ok()
        })
    };
    // A peak tag is a linear sample value (typically 0..~1); ignore non-positive.
    let parse_peak = |k: &ItemKey| -> Option<f32> {
        tag.get_string(k)
            .and_then(|s| s.trim().parse::<f32>().ok())
            .filter(|p| *p > 0.0)
    };

    // mode 2 = album: prefer album tags, fall back to track tags.
    let (gain_db, peak) = if mode == 2 {
        (
            parse_db(&ItemKey::ReplayGainAlbumGain)
                .or_else(|| parse_db(&ItemKey::ReplayGainTrackGain)),
            parse_peak(&ItemKey::ReplayGainAlbumPeak)
                .or_else(|| parse_peak(&ItemKey::ReplayGainTrackPeak)),
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

fn seek_track(tr: &mut TrackReader, target_seconds: f64) -> bool {
    let secs = target_seconds.trunc() as u64;
    let frac = target_seconds - secs as f64;
    let result = tr.reader.seek(
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
    result.is_ok()
}

// The resampling stage between decoder and ring.
//
// rubato has no 1:1 fast path: asked for a ratio of exactly 1.0 it still runs
// its 256-tap sinc filter over every sample, and still applies the f_cutoff
// low-pass. On a 44.1 kHz device playing 44.1 kHz files — the common case —
// that was ~97% of the decode thread's cost, all of it to reproduce the input.
// Passthrough skips the filter entirely and hands the frames straight through.
enum ResampleStage {
    // input_rate == output_rate: no conversion needed.
    Passthrough,
    // Boxed because SincFixedIn is large (sinc tables) and TrackReader is moved
    // around; the enum shouldn't inherit its footprint.
    Sinc(Box<SincFixedIn<f32>>),
}

impl ResampleStage {
    // Takes the chunk by value so Passthrough can return it untouched rather
    // than copying planar buffers it isn't going to change.
    fn process(&mut self, input: Vec<Vec<f32>>) -> Result<Vec<Vec<f32>>, String> {
        match self {
            ResampleStage::Passthrough => Ok(input),
            ResampleStage::Sinc(r) => {
                let in_refs: Vec<&[f32]> = input.iter().map(|v| v.as_slice()).collect();
                r.process(&in_refs, None)
                    .map_err(|e| format!("resample: {e}"))
            }
        }
    }

    // End-of-track tail: whatever is left in pending_in, below a full chunk.
    fn flush(&mut self, pending_in: &[Vec<f32>], channels: usize) -> Result<Vec<Vec<f32>>, String> {
        match self {
            // No internal state — the pending frames *are* the tail, exactly.
            ResampleStage::Passthrough => Ok(pending_in.to_vec()),
            ResampleStage::Sinc(r) => {
                // Feed the resampler one last partial chunk padded with zeros so
                // its internal state flushes the audio tail. Without this, the
                // last ~5ms of every track are lost — a small but real per-track
                // gap.
                let padded: Vec<Vec<f32>> = (0..channels)
                    .map(|c| {
                        let mut v = pending_in[c].clone();
                        v.resize(RESAMPLER_CHUNK_FRAMES, 0.0);
                        v
                    })
                    .collect();
                let in_refs: Vec<&[f32]> = padded.iter().map(|v| v.as_slice()).collect();
                r.process(&in_refs, None).map_err(|e| format!("flush: {e}"))
            }
        }
    }
}

fn make_resampler(input_rate: u32, output_rate: u32, channels: usize) -> ResampleStage {
    if input_rate == output_rate {
        return ResampleStage::Passthrough;
    }
    let params = SincInterpolationParameters {
        sinc_len: 256,
        f_cutoff: 0.95,
        interpolation: SincInterpolationType::Linear,
        oversampling_factor: 256,
        window: WindowFunction::BlackmanHarris2,
    };
    let ratio = output_rate as f64 / input_rate as f64;
    ResampleStage::Sinc(Box::new(
        SincFixedIn::<f32>::new(
            ratio,
            // max_resample_ratio_relative — used by rubato for buffer sizing. 2.0
            // is plenty since input/output rates are fixed within a track.
            2.0,
            params,
            RESAMPLER_CHUNK_FRAMES,
            channels,
        )
        .expect("resampler init"),
    ))
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
            // Signed PCM spans [-2^(bits-1), 2^(bits-1)-1]. Using MAX adds
            // gain and maps the negative endpoint below -1.0.
            let scale = 1.0 / 32_768.0;
            for c in 0..channels {
                into[c].extend(buf.chan(c).iter().map(|&v| v as f32 * scale));
            }
        }
        AudioBufferRef::S8(buf) => {
            let scale = 1.0 / 128.0;
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
            let scale = 1.0 / 32_768.0;
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

// Prepare the replacement decoder before committing a paused flush. On any
// preparation failure, keep the old frontier, ring, origins, and counters so
// resume can play every buffered frame before restoration proceeds.
#[allow(clippy::too_many_arguments)]
fn flush_paused_restore(
    shared: &Arc<SharedState>,
    origins: &Arc<Mutex<Origins>>,
    queue: &[PathBuf],
    output_rate: u32,
    frontier: &mut Option<TrackReader>,
    frontier_idx: &mut usize,
    producer_frames: &mut u64,
) -> bool {
    let played = shared.frames_played.load(Ordering::Relaxed);
    if played + shared.total_drained.load(Ordering::Relaxed)
        >= shared.total_produced.load(Ordering::Relaxed)
    {
        return true;
    }
    let Some((idx, position)) = playback_location(origins, played) else {
        return false;
    };
    let Some(path) = queue.get(idx) else {
        return false;
    };
    let rg = shared.rg_mode.load(Ordering::Relaxed);
    let Some(mut reader) = open_track(path, output_rate, rg) else {
        return false;
    };
    if !seek_track(&mut reader, position) {
        return false;
    }

    flush_and_wait(shared);
    *frontier = Some(reader);
    *frontier_idx = idx;
    shared.queue_exhausted.store(false, Ordering::Relaxed);
    origins
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .pending
        .clear();
    *producer_frames =
        shared.frames_played.load(Ordering::Relaxed) + shared.total_drained.load(Ordering::Relaxed);
    true
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

#[allow(clippy::too_many_arguments)]
fn publish_origin(
    origins: &Arc<Mutex<Origins>>,
    shared: &Arc<SharedState>,
    producer_frames: u64,
    queue_index: usize,
    path: &str,
    duration_seconds: f64,
    start_offset_seconds: f64,
    rate: u32,
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
        rate,
    });
}

// Resolve the audible queue slot and position at a frame boundary. The regular
// position thread normally advances pending origins, but a rate restore cannot
// depend on winning that scheduling race after it has drained the ring.
fn playback_location(origins: &Arc<Mutex<Origins>>, frames_played: u64) -> Option<(usize, f64)> {
    let mut origins = origins.lock().unwrap_or_else(|e| e.into_inner());
    while let Some(front) = origins.pending.front() {
        if front.at_consumer_frame > frames_played {
            break;
        }
        origins.current = origins.pending.pop_front();
    }
    origins.current.as_ref().map(|origin| {
        let delta_frames = frames_played.saturating_sub(origin.at_consumer_frame);
        let position =
            origin.start_offset_seconds + delta_frames as f64 / origin.rate.max(1) as f64;
        // This position is a seek target, so only clamp against a duration we
        // actually know: compute_duration_seconds reports 0.0 for files with no
        // time_base or n_frames, and clamping to that would restart the track.
        let position = if origin.duration_seconds > 0.0 {
            position.min(origin.duration_seconds)
        } else {
            position
        };
        (origin.queue_index, position)
    })
}

fn restore_position_for_frontier(
    origins: &Arc<Mutex<Origins>>,
    frames_played: u64,
    frontier_idx: usize,
) -> f64 {
    // The frontier can be the next, unstarted track while the audible origin
    // still describes the previous track's tail. Never carry that time across.
    playback_location(origins, frames_played)
        .filter(|(idx, _)| *idx == frontier_idx)
        .map_or(0.0, |(_, position)| position)
}

// === Position-emit thread ===

fn position_emit_loop(shared: Arc<SharedState>, origins: Arc<Mutex<Origins>>, app: AppHandle) {
    let mut last_emitted_position: f64 = -1.0;
    let mut last_emitted_path: Option<String> = None;
    let mut last_emitted_index: Option<usize> = None;
    let mut last_emitted_epoch: Option<u64> = None;
    let mut queue_ended_sent = false;
    let mut reported_underrun_events: u64 = 0;
    let mut reported_underrun_frames: u64 = 0;
    let mut last_underrun_log = Instant::now();

    loop {
        std::thread::sleep(Duration::from_millis(POSITION_EMIT_INTERVAL_MS));

        // Report ring underruns the callback recorded. Batched to at most one
        // line a second: a starved ring produces them in bursts, and a log line
        // per callback would itself become a source of load.
        let underrun_events = shared.underrun_events.load(Ordering::Relaxed);
        if underrun_events != reported_underrun_events
            && last_underrun_log.elapsed() >= Duration::from_secs(1)
        {
            let underrun_frames = shared.underrun_frames.load(Ordering::Relaxed);
            // Against the rate running now: a mid-session switch makes older
            // frames a slightly different length, which is noise at the
            // resolution of a diagnostic log line.
            let rate = shared.output_rate.load(Ordering::Relaxed).max(1);
            let ms = |frames: u64| frames as f64 * 1000.0 / rate as f64;
            log::warn!(
                "audio: ring underrun +{} callbacks / {:.1}ms silence (total {} / {:.1}ms)",
                underrun_events - reported_underrun_events,
                ms(underrun_frames - reported_underrun_frames),
                underrun_events,
                ms(underrun_frames),
            );
            reported_underrun_events = underrun_events;
            reported_underrun_frames = underrun_frames;
            last_underrun_log = Instant::now();
        }

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
                // origin.rate, not whatever is running now: frames counted
                // against an origin published before a rate switch were produced
                // at the earlier rate and are that many seconds long.
                let position =
                    origin.start_offset_seconds + delta_frames as f64 / origin.rate.max(1) as f64;
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
// Per-band Goertzel coefficient for a sample rate, recomputed whenever the
// device rate changes under this thread.
fn goertzel_coeffs(sample_rate: u32) -> [f32; EQ_BAND_COUNT] {
    std::array::from_fn(|k| 2.0 * (std::f32::consts::TAU * EQ_FREQS[k] / sample_rate as f32).cos())
}

fn waveform_emit_loop(
    mut viz: RbConsumer<f32>,
    app: AppHandle,
    sample_rate: u32,
    swap_rx: Receiver<VizHandoff>,
) {
    // Sliding window of the most recent mono samples.
    let mut mono: VecDeque<f32> = VecDeque::with_capacity(WAVEFORM_WINDOW);
    // Longer sliding window feeding the per-band spectrum (Goertzel needs several
    // periods of the lowest band to resolve it). Fed from the same drained samples.
    let mut spec: VecDeque<f32> = VecDeque::with_capacity(SPECTRUM_WINDOW);
    let mut scratch: Vec<f32> = Vec::new();
    let zeros = vec![0.0f32; WAVEFORM_POINTS];
    let band_zeros = vec![0.0f32; EQ_BAND_COUNT];
    // Precompute the Goertzel coefficient per band for this sample rate. Not
    // const across the session: a rate switch rebuilds the output stream and
    // hands this thread a new ring at a new rate (see VizHandoff).
    let mut coeffs = goertzel_coeffs(sample_rate);
    // Decimation factor: average this many window samples per emitted point.
    let block = WAVEFORM_WINDOW / WAVEFORM_POINTS;

    loop {
        std::thread::sleep(Duration::from_millis(WAVEFORM_EMIT_INTERVAL_MS));

        // A rate switch rebuilt the output stream, and with it the ring this
        // thread drains. Adopt the replacement and recompute the coefficients
        // for its rate. The windows hold samples at the old rate, so they're
        // dropped rather than analyzed as one spliced signal.
        while let Ok(handoff) = swap_rx.try_recv() {
            viz = handoff.rb;
            coeffs = goertzel_coeffs(handoff.rate);
            mono.clear();
            spec.clear();
        }

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
                        let w =
                            0.5 - 0.5 * (std::f32::consts::TAU * j as f32 / (n - 1) as f32).cos();
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

// Which track, if any, playback is currently waiting on a download for. One
// event carrying the whole answer — `None` means nothing is fetching — rather
// than a start/stop pair, so the UI can never be left showing a spinner for a
// download that ended while it wasn't listening.
#[derive(Clone, serde::Serialize)]
struct FetchingEvent {
    path: Option<String>,
}

fn emit_fetching(app: &AppHandle, path: Option<&std::path::Path>) {
    let _ = app.emit(
        "audio:fetching",
        FetchingEvent {
            path: path.map(|p| p.to_string_lossy().to_string()),
        },
    );
}

// A track's bytes just came down, and here is what the file says about itself now
// that it can be read. Separate from the fetching event going quiet, which says
// only that the wait is over — it says nothing about whether the file arrived,
// and it carries nothing to replace the row the UI has been drawing, which came
// from the scan cache and is a description of a file that wasn't there.
fn emit_downloaded(app: &AppHandle, track: &crate::SearchResult) {
    let _ = app.emit("audio:downloaded", track);
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
mod signal_integrity_tests {
    use super::*;

    #[test]
    fn signed_eight_bit_pcm_uses_the_full_negative_range() {
        use std::borrow::Cow;
        use symphonia::core::audio::{AudioBuffer, Channels, SignalSpec};
        let mut buffer = AudioBuffer::<i8>::new(4, SignalSpec::new(44_100, Channels::FRONT_LEFT));
        buffer.render_silence(None);
        buffer.chan_mut(0).copy_from_slice(&[-128, -1, 0, 127]);
        let mut output = vec![Vec::new()];
        append_planar(&AudioBufferRef::S8(Cow::Borrowed(&buffer)), &mut output, 1);
        assert_eq!(output[0], [-1.0, -1.0 / 128.0, 0.0, 127.0 / 128.0]);
    }

    // Independent PCM WAV writer: expected samples come from the signed integer
    // definition, not from the decoder or conversion helper under test.
    fn write_pcm_fixture(rate: u32, bits: u16) -> (PathBuf, Vec<f32>) {
        let frames = 5_003u32; // Deliberately not a resampler or callback block multiple.
        let bytes_per_sample = bits / 8;
        let data_size = frames * 2 * bytes_per_sample as u32;
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"RIFF");
        bytes.extend_from_slice(&(36 + data_size).to_le_bytes());
        bytes.extend_from_slice(b"WAVEfmt ");
        bytes.extend_from_slice(&16u32.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes()); // Integer PCM.
        bytes.extend_from_slice(&2u16.to_le_bytes()); // Stereo.
        bytes.extend_from_slice(&rate.to_le_bytes());
        bytes.extend_from_slice(&(rate * 2 * bytes_per_sample as u32).to_le_bytes());
        bytes.extend_from_slice(&(2 * bytes_per_sample).to_le_bytes());
        bytes.extend_from_slice(&bits.to_le_bytes());
        bytes.extend_from_slice(b"data");
        bytes.extend_from_slice(&data_size.to_le_bytes());

        let full_scale = 1i32 << (bits - 1);
        let edges = [-full_scale, full_scale - 1, -1, 0, 1, full_scale / 2];
        let mut expected = Vec::new();
        for frame in 0..frames {
            for channel in 0..2u32 {
                let index = frame as usize * 2 + channel as usize;
                let sample = if index < edges.len() {
                    edges[index]
                } else {
                    ((frame * 7_919 + channel * 17_011) % (2 * full_scale as u32)) as i32
                        - full_scale
                };
                bytes.extend_from_slice(&sample.to_le_bytes()[..bytes_per_sample as usize]);
                expected.push(sample as f32 / full_scale as f32);
            }
        }
        let path = std::env::temp_dir().join(format!(
            "pudding-signal-integrity-{}-{rate}-{bits}.wav",
            std::process::id()
        ));
        std::fs::write(&path, bytes).expect("write PCM fixture");
        (path, expected)
    }

    #[test]
    fn native_rate_pcm_reaches_the_output_callback_unchanged() {
        for rate in [44_100, 48_000, 96_000] {
            for bits in [16, 24] {
                let (path, expected) = write_pcm_fixture(rate, bits);
                let mut reader = open_track(&path, rate, 0).expect("open PCM fixture");
                // The open reader retains the file handle; remove the temporary
                // directory entry now so assertion failures leave no fixtures.
                std::fs::remove_file(path).expect("remove PCM fixture");
                let shared = Arc::new(SharedState::new(rate));
                let (mut producer, consumer) = RingBuffer::<f32>::new(expected.len() + 2);
                let (viz, _viz_consumer) = RingBuffer::<f32>::new(viz_ring_samples());
                let mut callback = ConsumerState {
                    rb: consumer,
                    shared: Arc::clone(&shared),
                    last_flush_gen: 0,
                    viz,
                    eq: EqChain::new(rate),
                    post_flush: true,
                };
                let mut produced = 0;
                let mut actual = Vec::new();
                loop {
                    let outcome =
                        decode_and_push(&mut reader, &mut producer, &shared, &mut produced)
                            .expect("decode PCM fixture");
                    while callback.rb.slots() > 0 {
                        let mut block = vec![0.0; callback.rb.slots().min(514)];
                        fill_output(&mut callback, &mut block);
                        actual.extend(block);
                    }
                    if matches!(outcome, StepOutcome::TrackEnded) {
                        break;
                    }
                }
                assert_eq!(
                    actual.len(),
                    expected.len(),
                    "{rate} Hz, {bits}-bit: missing/extra samples"
                );
                assert_eq!(produced, (expected.len() / 2) as u64);
                assert_eq!(shared.frames_played.load(Ordering::Relaxed), produced);
                for (index, (&actual, &expected)) in actual.iter().zip(&expected).enumerate() {
                    assert_eq!(actual, expected, "{rate} Hz, {bits}-bit, sample {index}");
                }
            }
        }
    }
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
        let shared = Arc::new(SharedState::new(48_000));
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
        write_rg_tags(&path, &[(ItemKey::ReplayGainTrackGain, "-6.00 dB")]);
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
        assert!(
            (replaygain_multiplier(&path, 2) - 1.0).abs() < 1e-3,
            "album gain"
        );
        assert!(
            (replaygain_multiplier(&path, 1) - 0.5).abs() < 1e-3,
            "track gain"
        );
        let _ = std::fs::remove_file(&path);

        // Only track tags present: album mode must fall back to the track gain.
        let path = temp_copy("stereo22_alac.m4a", "fallback");
        write_rg_tags(&path, &[(ItemKey::ReplayGainTrackGain, "-6.0206 dB")]);
        assert!(
            (replaygain_multiplier(&path, 2) - 0.5).abs() < 1e-3,
            "album mode should fall back to track gain",
        );
        let _ = std::fs::remove_file(&path);
    }
}

#[cfg(test)]
mod eq_bypass_tests {
    //! The EQ skips bands sitting at 0 dB. That is only safe because an RBJ
    //! peaking biquad at 0 dB is an *exact* identity, not merely a close one:
    //! with A = 1 the design gives b0 = 1 and b1/b2 bit-identical to a1/a2, so
    //! y = x and the delay state stays exactly zero forever. These tests pin
    //! that down by comparing against a chain that runs every band, and require
    //! bit equality rather than a tolerance.
    use super::*;

    fn shared_with(gains: [f32; EQ_BAND_COUNT], preamp_db: f32) -> SharedState {
        let shared = SharedState::new(48_000);
        shared.eq_enabled.store(true, Ordering::Relaxed);
        shared
            .eq_preamp_db
            .store(preamp_db.to_bits(), Ordering::Relaxed);
        for (slot, g) in shared.eq_gains_db.iter().zip(gains.iter()) {
            slot.store(g.to_bits(), Ordering::Relaxed);
        }
        shared.eq_gen.fetch_add(1, Ordering::Release);
        shared
    }

    // The pre-optimization behaviour: every band runs, 0 dB or not.
    fn reference_block(gains: [f32; EQ_BAND_COUNT], preamp_db: f32, out: &mut [f32]) {
        let preamp = 10.0_f32.powf(preamp_db / 20.0);
        let mut bands = [Biquad::identity(); EQ_BAND_COUNT];
        for (band, (freq, gain)) in bands.iter_mut().zip(EQ_FREQS.iter().zip(gains.iter())) {
            band.set_peaking(*freq, 44_100.0, EQ_Q, *gain);
        }
        for (i, s) in out.iter_mut().enumerate() {
            let ch = i % OUT_CHANNELS;
            let mut x = *s * preamp;
            for band in bands.iter_mut() {
                x = band.process(x, ch);
            }
            *s = x;
        }
    }

    // A few seconds of something with content across the spectrum.
    fn signal() -> Vec<f32> {
        (0..4096)
            .map(|i| {
                let t = i as f32 / 44_100.0;
                0.3 * (2.0 * std::f32::consts::PI * 220.0 * t).sin()
                    + 0.2 * (2.0 * std::f32::consts::PI * 3000.0 * t).sin()
            })
            .collect()
    }

    fn run_chain(gains: [f32; EQ_BAND_COUNT], preamp_db: f32, out: &mut [f32]) -> usize {
        let shared = shared_with(gains, preamp_db);
        let mut eq = EqChain::new(44_100);
        eq.refresh(&shared);
        eq.process_block(out);
        eq.active_len
    }

    #[test]
    fn all_bands_flat_is_fully_bypassed() {
        let mut got = signal();
        let active = run_chain([0.0; EQ_BAND_COUNT], 0.0, &mut got);
        assert_eq!(active, 0, "no band should be live at 0 dB");
        assert_eq!(got, signal(), "flat EQ must leave the buffer untouched");
    }

    #[test]
    fn flat_bands_match_running_them() {
        // The optimization is only legitimate if it changes nothing.
        let mut got = signal();
        run_chain([0.0; EQ_BAND_COUNT], 0.0, &mut got);
        let mut want = signal();
        reference_block([0.0; EQ_BAND_COUNT], 0.0, &mut want);
        assert_eq!(got, want);
    }

    #[test]
    fn mixed_gains_match_running_every_band() {
        // Identity bands interleaved between live ones must not perturb the
        // cascade — this is the case that would break if 0 dB were merely close
        // to transparent instead of exactly transparent.
        let mut gains = [0.0f32; EQ_BAND_COUNT];
        gains[0] = 6.0;
        gains[4] = -3.5;
        gains[9] = 2.0;

        let mut got = signal();
        let active = run_chain(gains, 0.0, &mut got);
        assert_eq!(active, 3, "only the three moved bands should be live");

        let mut want = signal();
        reference_block(gains, 0.0, &mut want);
        assert_eq!(got, want);
    }

    #[test]
    fn preamp_still_applies_with_every_band_flat() {
        // Bypass keys on the preamp too; a preamp with no live bands must still
        // scale the signal rather than being skipped along with the bands.
        let mut got = signal();
        let active = run_chain([0.0; EQ_BAND_COUNT], 6.0, &mut got);
        assert_eq!(active, 0);
        let mut want = signal();
        reference_block([0.0; EQ_BAND_COUNT], 6.0, &mut want);
        assert_eq!(got, want);
        assert!(got[100] != signal()[100], "preamp must have been applied");
    }

    #[test]
    fn band_returning_from_flat_starts_from_silence() {
        // A skipped band holds no history, so re-enabling it must not ring out
        // state left over from the last time it ran.
        let shared = shared_with([0.0; EQ_BAND_COUNT], 0.0);
        let mut eq = EqChain::new(44_100);

        let mut gains = [0.0f32; EQ_BAND_COUNT];
        gains[3] = 9.0;
        for (slot, g) in shared.eq_gains_db.iter().zip(gains.iter()) {
            slot.store(g.to_bits(), Ordering::Relaxed);
        }
        shared.eq_gen.fetch_add(1, Ordering::Release);
        eq.refresh(&shared);
        eq.process_block(&mut signal());
        assert_eq!(eq.active_len, 1);

        // Back to flat: the band goes idle and must drop its delay state.
        for slot in shared.eq_gains_db.iter() {
            slot.store(0.0_f32.to_bits(), Ordering::Relaxed);
        }
        shared.eq_gen.fetch_add(1, Ordering::Release);
        eq.refresh(&shared);
        assert_eq!(eq.active_len, 0);
        assert_eq!(eq.bands[3].s1, [0.0; OUT_CHANNELS]);
        assert_eq!(eq.bands[3].s2, [0.0; OUT_CHANNELS]);
    }
}

#[cfg(test)]
mod rate_switch_tests {
    //! Coverage for follow-the-content output rate switching. The switch itself
    //! needs a real device (it is literally "build a cpal stream at another
    //! rate"), so what's tested here is everything that decides *whether* and
    //! *what to*, plus the sizing invariant the switch mechanism relies on:
    //!
    //!   * choose_output_rate's preference order, including the cases that must
    //!     NOT switch (the whole feature is opt-in and must stay inert),
    //!   * the gate in front of it (feature off, rate not declared by the file),
    //!   * arm_rate_switch leaving the callback's underrun suppression flag in
    //!     the right state — including on cancel, since a stuck flag would hide
    //!     genuine underruns for the rest of the session,
    //!   * and that the pre-roll always fits in the ring it is pushed into,
    //!     which is what makes that push non-blocking on a ring with no reader.
    use super::*;

    // A typical Mac built-in output.
    const BUILTIN: [u32; 4] = [44_100, 48_000, 88_200, 96_000];
    // A DAC with a full ladder.
    const LADDER: [u32; 7] = [44_100, 48_000, 88_200, 96_000, 176_400, 192_000, 384_000];
    // A device that only does 48k family (plenty of USB interfaces, AirPlay).
    const FORTY_EIGHT_ONLY: [u32; 3] = [48_000, 96_000, 192_000];

    #[test]
    fn exact_match_wins() {
        // The point of the feature: 44.1 content on a device sitting at 48.
        assert_eq!(choose_output_rate(&BUILTIN, 44_100, 48_000, 48_000), 44_100);
        assert_eq!(choose_output_rate(&BUILTIN, 96_000, 44_100, 44_100), 96_000);
        // Already there -> the same rate, which callers read as "don't switch".
        assert_eq!(choose_output_rate(&BUILTIN, 44_100, 44_100, 48_000), 44_100);
    }

    #[test]
    fn falls_back_to_the_smallest_whole_multiple() {
        // 44.1 on a 48-only device: 88.2 is not there, so the family is lost;
        // but 22.05k content has 44.1 available as an exact double on BUILTIN.
        assert_eq!(choose_output_rate(&BUILTIN, 22_050, 48_000, 48_000), 44_100);
        // Smallest multiple, not the largest: 24k -> 48k, not 96k or 192k.
        assert_eq!(
            choose_output_rate(&FORTY_EIGHT_ONLY, 24_000, 192_000, 192_000),
            48_000
        );
        // A ladder device playing 11.025k content climbs only to 44.1.
        assert_eq!(choose_output_rate(&LADDER, 11_025, 48_000, 48_000), 44_100);
    }

    #[test]
    fn whole_multiples_are_capped() {
        // A device offering only 44.1k and 384k, playing 48k content. 384k is a
        // whole multiple of 48k, but past MAX_FOLLOW_RATE — the multiple rule
        // declines it and the device is left at its default rather than driven
        // to 8x for nothing. Without the ceiling this returns 384_000.
        let capped = [44_100u32, 384_000];
        assert_eq!(choose_output_rate(&capped, 48_000, 44_100, 44_100), 44_100);
        // The same device still climbs where the ceiling isn't in the way: 44.1k
        // is an exact double of 22.05k content.
        assert_eq!(
            choose_output_rate(&capped, 22_050, 384_000, 384_000),
            44_100
        );
    }

    #[test]
    fn unfollowable_content_returns_to_the_device_default() {
        // 44.1 on a device that has no 44.1 family at all: rather than picking
        // 96k or 192k on a whim, leave the device where its owner had it.
        assert_eq!(
            choose_output_rate(&FORTY_EIGHT_ONLY, 44_100, 96_000, 48_000),
            48_000
        );
        // Same file, different device default -> that default.
        assert_eq!(
            choose_output_rate(&FORTY_EIGHT_ONLY, 44_100, 48_000, 96_000),
            96_000
        );
    }

    #[test]
    fn last_resorts_prefer_not_to_downsample() {
        // Odd device whose list contains neither the content rate, a multiple,
        // nor the reported default: take the lowest rate that isn't a
        // downsample.
        let odd = [32_000u32, 64_000];
        assert_eq!(choose_output_rate(&odd, 44_100, 32_000, 48_000), 64_000);
        // And if everything on offer is below the content rate, the highest.
        let low = [8_000u32, 16_000];
        assert_eq!(choose_output_rate(&low, 44_100, 8_000, 48_000), 16_000);
    }

    #[test]
    fn no_usable_rate_list_never_switches() {
        // A device cpal couldn't enumerate, or one that only reports ranges.
        assert_eq!(choose_output_rate(&[], 44_100, 48_000, 48_000), 48_000);
        // A file claiming a zero rate is nonsense; don't act on it.
        assert_eq!(choose_output_rate(&BUILTIN, 0, 48_000, 48_000), 48_000);
    }

    #[test]
    fn the_gate_keeps_the_feature_inert_when_it_should_be() {
        // Feature off (the shipping default): never switch, however tempting.
        assert_eq!(
            desired_output_rate(false, true, 44_100, &BUILTIN, 48_000, 48_000),
            48_000
        );
        // On, but the container never declared a rate — open_track guessed
        // 44.1. Reconfiguring the machine's audio output on a guess is worse
        // than not following at all.
        assert_eq!(
            desired_output_rate(true, false, 44_100, &BUILTIN, 48_000, 48_000),
            48_000
        );
        // On, declared, and available: switch.
        assert_eq!(
            desired_output_rate(true, true, 44_100, &BUILTIN, 48_000, 48_000),
            44_100
        );
        // On and declared, but it's what we're already running: no switch.
        assert_eq!(
            desired_output_rate(true, true, 48_000, &BUILTIN, 48_000, 48_000),
            48_000
        );
    }

    #[test]
    fn arming_and_cancelling_track_the_callback_flag() {
        let shared = SharedState::new(48_000);
        assert!(!shared.rate_switch_pending.load(Ordering::Relaxed));

        let armed = arm_rate_switch(&shared, Some(44_100));
        assert_eq!(armed.map(|p| p.target_rate), Some(44_100));
        assert!(shared.rate_switch_pending.load(Ordering::Relaxed));
        // The barrier is bounded, not open-ended.
        assert!(armed.unwrap().deadline > Instant::now());

        // Cancelling must clear the flag: left set, it would suppress genuine
        // underrun reporting for the rest of the session.
        let cancelled = arm_rate_switch(&shared, None);
        assert!(cancelled.is_none());
        assert!(!shared.rate_switch_pending.load(Ordering::Relaxed));
    }

    #[test]
    fn transport_source_changes_preserve_an_armed_restore_and_its_deadline() {
        let shared = SharedState::new(44_100);
        let mut ownership = RateOwnership::default();
        ownership.note_selection(48_000, 44_100);
        let mut pending = arm_rate_restore(&shared, &Mutex::new(ownership));
        let deadline = pending.unwrap().deadline;

        // Stop / Seek / radio cancel source following; Play / Append can
        // request a different source rate. Neither may cancel restoration.
        for target in [None, Some(96_000), None, Some(44_100)] {
            pending = update_rate_switch(&shared, pending, target);
            let restore = pending.unwrap();
            assert_eq!(restore.target_rate, 48_000);
            assert!(matches!(
                restore.purpose,
                SwitchPurpose::Restore {
                    expected_rate: 44_100
                }
            ));
            assert_eq!(restore.deadline, deadline);
            assert!(shared.rate_switch_pending.load(Ordering::Relaxed));
        }
        // Ordinary source switches must still be replaceable and cancellable.
        let follow = update_rate_switch(&shared, None, Some(96_000));
        assert!(update_rate_switch(&shared, follow, None).is_none());
        assert!(!shared.rate_switch_pending.load(Ordering::Relaxed));
    }

    #[test]
    fn failed_paused_restore_preserves_buffered_audio_across_a_track_boundary() {
        let fixture =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests-fixtures/mono44_alac.m4a");
        for failure in ["open", "queue slot", "origin", "seek"] {
            let shared = Arc::new(SharedState::new(44_100));
            shared.paused.store(true, Ordering::Relaxed);
            let origins = Arc::new(Mutex::new(Origins::default()));
            let mut queue = vec![fixture.clone(), fixture.clone()];
            let mut frontier = open_track(&fixture, 44_100, 0);
            // Pending decoded input must survive along with the ring itself.
            frontier.as_mut().unwrap().pending_in[0].push(0.125);
            let mut frontier_idx = 1;
            let mut producer_frames = 4;
            shared
                .total_produced
                .store(producer_frames, Ordering::Relaxed);
            let expected = [0.1, 0.1, 0.2, 0.2, 0.3, 0.3, 0.4, 0.4];
            let (mut producer, consumer) = RingBuffer::<f32>::new(expected.len());
            push_blocking(&mut producer, &expected);
            let (viz, _tap) = RingBuffer::<f32>::new(32);
            let mut callback = ConsumerState {
                rb: consumer,
                shared: shared.clone(),
                last_flush_gen: 0,
                viz,
                eq: EqChain::new(44_100),
                post_flush: false,
            };
            if failure != "origin" {
                let offset = if failure == "seek" { 1e9 } else { 0.0 };
                publish_origin(&origins, &shared, 0, 0, "audible", 0.0, offset, 44_100);
                playback_location(&origins, 0);
                publish_origin(&origins, &shared, 2, 1, "next", 1.0, 0.0, 44_100);
            }
            if failure == "open" {
                queue[0] = fixture.with_extension("missing-paused-restore-test");
                assert!(!queue[0].exists());
            } else if failure == "queue slot" {
                queue.clear();
            }
            let pending_origins = origins.lock().unwrap().pending.len();
            assert!(
                !flush_paused_restore(
                    &shared,
                    &origins,
                    &queue,
                    44_100,
                    &mut frontier,
                    &mut frontier_idx,
                    &mut producer_frames,
                ),
                "{failure}"
            );
            assert_eq!(frontier.as_ref().unwrap().pending_in[0], [0.125]);
            assert_eq!(frontier_idx, 1);
            assert_eq!(producer_frames, 4);
            assert_eq!(shared.flush_gen.load(Ordering::Relaxed), 0);
            assert_eq!(shared.total_drained.load(Ordering::Relaxed), 0);
            assert_eq!(origins.lock().unwrap().pending.len(), pending_origins);
            // Exercise the real callback: resume must play all of both tracks'
            // buffered samples, without an intervening flush or skip.
            shared.paused.store(false, Ordering::Relaxed);
            let mut output = [0.0; 8];
            fill_output(&mut callback, &mut output);
            assert_eq!(output, expected, "{failure}");
        }
    }

    #[test]
    fn successful_paused_restore_reseats_the_audible_track_before_flushing() {
        let fixture =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests-fixtures/mono44_alac.m4a");
        let queue = vec![fixture.clone(), fixture.clone()];
        let shared = Arc::new(SharedState::new(44_100));
        shared.paused.store(true, Ordering::Relaxed);
        shared.queue_exhausted.store(true, Ordering::Relaxed);
        let origins = Arc::new(Mutex::new(Origins::default()));
        publish_origin(&origins, &shared, 0, 0, "audible", 1.0, 0.0, 44_100);
        publish_origin(&origins, &shared, 2, 1, "next", 1.0, 0.0, 44_100);
        let mut frontier = None; // Decoder already reached EOF; a tail remains.
        let mut frontier_idx = 2;
        let mut producer_frames = 4;
        shared.total_produced.store(4, Ordering::Relaxed);
        let (mut producer, consumer) = RingBuffer::<f32>::new(8);
        push_blocking(&mut producer, &[0.25; 8]);
        let (viz, _tap) = RingBuffer::<f32>::new(32);
        let mut callback = ConsumerState {
            rb: consumer,
            shared: shared.clone(),
            last_flush_gen: 0,
            viz,
            eq: EqChain::new(44_100),
            post_flush: false,
        };
        let callback_shared = shared.clone();
        let callback_thread = std::thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(1);
            while callback_shared.flush_gen.load(Ordering::Acquire) == 0 {
                assert!(Instant::now() < deadline, "flush was never requested");
                std::thread::sleep(Duration::from_millis(1));
            }
            fill_output(&mut callback, &mut [0.0; 8]);
            assert_eq!(callback.rb.slots(), 0);
        });
        assert!(flush_paused_restore(
            &shared,
            &origins,
            &queue,
            44_100,
            &mut frontier,
            &mut frontier_idx,
            &mut producer_frames,
        ));
        callback_thread.join().unwrap();
        assert_eq!(frontier_idx, 0);
        assert_eq!(frontier.unwrap().path, fixture.to_string_lossy());
        assert!(!shared.queue_exhausted.load(Ordering::Relaxed));
        assert_eq!(shared.total_drained.load(Ordering::Relaxed), 4);
        assert_eq!(producer_frames, 4);
        assert!(origins.lock().unwrap().pending.is_empty());
        assert_eq!(playback_location(&origins, 0), Some((0, 0.0)));
    }

    #[test]
    fn ownership_remembers_only_the_rate_before_the_first_change() {
        let mut ownership = RateOwnership::default();
        // Merely rebuilding at a rate the device already has does not claim it.
        ownership.note_selection(48_000, 48_000);
        assert_eq!(ownership.restore_request(), None);

        ownership.note_selection(48_000, 44_100);
        assert_eq!(ownership.restore_request(), Some((48_000, 44_100)));

        // Later source-rate switches update the guard but never replace the
        // rate that preceded Pudding's first change.
        ownership.note_selection(44_100, 96_000);
        assert_eq!(ownership.restore_request(), Some((48_000, 96_000)));
        assert_eq!(ownership.restore_target_if_unchanged(96_000), Some(48_000));
    }

    #[test]
    fn ownership_guard_rejects_a_later_external_change() {
        let mut ownership = RateOwnership::default();
        ownership.note_selection(48_000, 44_100);

        assert_eq!(ownership.restore_target_if_unchanged(44_100), Some(48_000));
        assert_eq!(ownership.restore_target_if_unchanged(96_000), None);

        ownership.clear();
        assert_eq!(ownership.restore_request(), None);
        assert_eq!(ownership.restore_target_if_unchanged(44_100), None);
    }

    #[test]
    fn cancelling_follow_preserves_the_next_tracks_origin_without_a_rebuild() {
        let shared = Arc::new(SharedState::new(48_000));
        let origins = Arc::new(Mutex::new(Origins::default()));
        let path =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests-fixtures/mono44_aac.m4a");
        let reader = open_track(&path, 48_000, 0).expect("open_track");
        // Include a previous flush: origins use consumed, not produced, frames.
        shared.total_drained.store(4_800, Ordering::Relaxed);
        publish_origin(&origins, &shared, 4_800, 0, "previous", 10.0, 0.0, 48_000);
        let pending = arm_rate_switch(&shared, Some(44_100));
        publish_cancelled_follow_origin(pending, Some(&reader), 1, 52_800, &shared, &origins);
        let restore = arm_rate_restore(&shared, &Mutex::new(RateOwnership::default()));
        assert!(restore.is_none());
        assert!(!shared.rate_switch_pending.load(Ordering::Relaxed));

        // The next track stays pending until the preceding audio has sounded.
        assert_eq!(playback_location(&origins, 24_000), Some((0, 0.5)));
        assert_eq!(playback_location(&origins, 48_000), Some((1, 0.0)));
        let active = origins.lock().unwrap().current.clone().unwrap();
        assert_eq!(active.path, reader.path);
        assert_eq!(active.rate, 48_000);
        assert_eq!(playback_location(&origins, 52_800), Some((1, 0.1)));

        // Disabling again mid-track must not publish a new zero-time origin.
        publish_cancelled_follow_origin(None, Some(&reader), 1, 57_600, &shared, &origins);
        assert!(origins.lock().unwrap().pending.is_empty());
    }

    #[test]
    fn restore_position_tracks_the_frontier_slot_and_pending_origins() {
        let shared = Arc::new(SharedState::new(44_100));
        let origins = Arc::new(Mutex::new(Origins::default()));
        publish_origin(&origins, &shared, 0, 0, "track", 120.0, 5.0, 44_100);
        // Mid-track restoration retains a previous seek offset at the old rate.
        assert_eq!(restore_position_for_frontier(&origins, 441_000, 0), 15.0);
        // An unstarted next slot must not inherit the preceding track's time.
        assert_eq!(restore_position_for_frontier(&origins, 441_000, 1), 0.0);

        // Duplicate queue entries share a path; the slot determines identity.
        // Resolve a pending origin without waiting for the position thread.
        publish_origin(&origins, &shared, 441_000, 1, "track", 120.0, 0.0, 44_100);
        assert_eq!(restore_position_for_frontier(&origins, 485_100, 1), 1.0);
        assert_eq!(restore_position_for_frontier(&origins, 485_100, 0), 0.0);
    }

    #[test]
    fn ownership_preserves_restoration_after_a_failed_switch_and_fallback() {
        // A failed build can leave either the old or the attempted rate on the
        // device. A fallback must repair the guard in both cases.
        for rate_after_failure in [44_100, 96_000] {
            let mut ownership = RateOwnership::default();
            ownership.note_selection(48_000, 44_100);
            ownership.note_selection(44_100, 96_000);
            ownership.note_selection(rate_after_failure, 44_100);
            assert_eq!(ownership.restore_request(), Some((48_000, 44_100)));
            assert_eq!(ownership.restore_target_if_unchanged(44_100), Some(48_000));
            // An actual later external change must still prevent restoration.
            assert_eq!(ownership.restore_target_if_unchanged(96_000), None);
        }
    }

    #[test]
    fn preroll_always_fits_the_ring_it_is_pushed_into() {
        // perform_rate_switch pushes the pre-roll into a ring whose consumer has
        // not been handed to a stream yet, so nothing can make room: if it
        // didn't fit, push_blocking would spin until the deadline. Guard the
        // relationship rather than the two constants separately.
        for rate in [44_100u32, 48_000, 88_200, 96_000, 176_400, 192_000] {
            let capacity = ring_samples(rate);
            let preroll = preroll_frames(rate) as usize * OUT_CHANNELS;
            assert!(
                preroll < capacity,
                "{rate} Hz: pre-roll {preroll} samples does not fit ring of {capacity}"
            );
            // And it's actually the duration we asked for.
            assert_eq!(
                preroll_frames(rate),
                rate as u64 * RATE_SWITCH_PREROLL_MS / 1000
            );
        }
    }

    #[test]
    fn real_files_drive_the_decision_end_to_end() {
        // The pure functions above can all be right while the wiring is wrong —
        // an input_rate_declared that is never true would leave the feature
        // silently inert. So run the real open_track over real files and decide
        // from what it reports, exactly as advance_to_next_playable does.
        let decide = |name: &str, follow: bool| {
            let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests-fixtures")
                .join(name);
            let tr = open_track(&path, 48_000, 0).expect("open_track");
            assert!(
                tr.input_rate_declared,
                "{name}: rate not declared; the gate would block every switch"
            );
            desired_output_rate(
                follow,
                tr.input_rate_declared,
                tr.input_rate,
                &BUILTIN,
                48_000,
                48_000,
            )
        };

        // Device sitting at 48k, file is 44.1k: follow it down. The everyday case.
        assert_eq!(decide("mono44_aac.m4a", true), 44_100);
        // 22.05k with no exact match on this device: the whole multiple wins over
        // the 48k it would otherwise have been resampled to.
        assert_eq!(decide("mono22_aac.m4a", true), 44_100);
        // This one is 22.05k audio in a container that declares 44.1k (see
        // spec_reconcile_tests — the container is not ground truth). We follow
        // the declaration and land on 44.1k, which is where the true rate would
        // have sent us anyway; the resampler is corrected from the decoded
        // buffer's spec once the first packet arrives, so the audio is right
        // either way. A mis-declared rate costs at worst a suboptimal device
        // rate, never wrong-sounding audio.
        assert_eq!(decide("mono22_alac.m4a", true), 44_100);

        // And with the feature off — the shipping default — nothing is asked for.
        assert_eq!(decide("mono44_aac.m4a", false), 48_000);
        assert_eq!(decide("mono22_aac.m4a", false), 48_000);
    }

    #[test]
    fn ring_is_sized_in_time_not_frames() {
        // A frame is a different amount of time at a different rate, which is
        // why the ring is rebuilt on a switch rather than reused.
        assert!(ring_samples(96_000) > ring_samples(48_000));
        assert_eq!(ring_samples(48_000) % OUT_CHANNELS, 0);
    }

    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "briefly changes the default output device's hardware rate, then restores it"]
    fn hardware_output_rebuild_changes_nominal_rate_and_restores() {
        let device = crate::output_device::OutputDevice::default().expect("output device");
        let original = device.current_rate().expect("original nominal rate");
        let target = device_output_rates(&device.device)
            .into_iter()
            .find(|&rate| rate != original)
            .expect("device must support another rate");
        let format = device
            .device
            .default_output_config()
            .unwrap()
            .sample_format();
        let shared = Arc::new(SharedState::new(original));
        // Restore even if a hardware assertion panics. Declared before streams
        // so those drop first during unwinding.
        struct RestoreRate(crate::output_device::OutputDevice, u32);
        impl Drop for RestoreRate {
            fn drop(&mut self) {
                if let Err(e) = self.0.set_rate(self.1) {
                    eprintln!("hardware test could not restore {} Hz: {e}", self.1);
                }
            }
        }
        let _restore = RestoreRate(device.clone(), original);
        let build = |rate| {
            let (_producer, consumer) = RingBuffer::<f32>::new(ring_samples(rate));
            build_replacement(&device, format, &shared, rate, consumer).expect("build replacement")
        };
        let (stream, _) = build(original);
        drop(stream);
        let (stream, _) = build(target);
        assert_eq!(device.current_rate().unwrap(), target);
        eprintln!("hardware nominal rate: {original} -> {target} Hz");
        drop(stream);
        let (stream, _) = build(original);
        assert_eq!(device.current_rate().unwrap(), original);
        eprintln!("hardware nominal rate restored: {original} Hz");
        drop(stream);
    }
}
