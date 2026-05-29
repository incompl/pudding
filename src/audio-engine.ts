import { convertFileSrc } from "@tauri-apps/api/core";
import { info as logInfo, warn as logWarn, error as logError } from "@tauri-apps/plugin-log";

// Generated once when this module is first evaluated. If two adjacent log
// entries carry different session IDs, the WebView re-executed the JS bundle
// between them (a WKWebView background-reload, page navigation, etc.) — that's
// the hypothesis we're trying to confirm for the silent-after-idle bug. With a
// stable id stamped on every line, "did the page reload?" stops being
// guesswork.
const SESSION_ID =
  typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10);

// Funnel audio-engine diagnostics through tauri-plugin-log so they hit the
// rotating log file on disk (the bug — playback going silent after long idle —
// reproduces over hours and devtools console isn't viable for that).
// Fire-and-forget; we never await logging because it must not perturb the
// audio scheduling timing we're trying to observe. The plugin's "Webview"
// target also mirrors these to the browser console for live debugging.
function alog(msg: string, fields?: Record<string, unknown>): void {
  const stamped = { sid: SESSION_ID, ...(fields ?? {}) };
  void logInfo(`audio: ${msg} ${JSON.stringify(stamped)}`);
}
function awarn(msg: string, fields?: Record<string, unknown>): void {
  const stamped = { sid: SESSION_ID, ...(fields ?? {}) };
  void logWarn(`audio: ${msg} ${JSON.stringify(stamped)}`);
}
function aerr(msg: string, fields?: Record<string, unknown>): void {
  const stamped = { sid: SESSION_ID, ...(fields ?? {}) };
  void logError(`audio: ${msg} ${JSON.stringify(stamped)}`);
}

// Fires once per module evaluation — the first log line of each session. If we
// see this appearing again mid-session, we caught a reload in the act.
alog("module.load", { loadTime: Date.now() });

// Sample-accurate gapless playback engine.
//
// Files are fetched as bytes, decoded to PCM with the Web Audio API, and
// scheduled back-to-back on the AudioContext clock so there is no silence
// between tracks of a continuous album. The successor is decoded as soon as
// the current track starts; when ready we call `source.start(boundary)` where
// `boundary` is the exact context time the current buffer ends. The
// ended-event of the current source only drives UI promotion — the audio
// itself is already seamless because the next source was scheduled at a
// precise context time, independent of event latency.
//
// The engine speaks file paths only. The host (main.ts) owns the path -> UI
// mapping and the codec/oversize fallback to an <audio> element.

// Per-track decoded PCM ceiling. Float32 PCM is large (~10 MB/min stereo
// 44.1 kHz); current + next are held simultaneously, so an unbounded track
// could OOM. Above this we refuse the track and let the host stream it via
// <audio> (non-gapless, but alive). ~1.2 GB ≈ 57 min stereo 44.1 kHz.
const MAX_TRACK_BYTES = 1_200_000_000;

// Most music libraries are CD-derived (44.1 kHz). decodeAudioData resamples to
// the context rate regardless; pinning to 44.1 kHz means the common case is
// not resampled (48 kHz sources are — an unavoidable trade-off without a
// context per file). latencyHint "playback" favors glitch-free scheduling.
const CONTEXT_OPTIONS: AudioContextOptions = {
  sampleRate: 44100,
  latencyHint: "playback",
};

// Builds a tiny silent WAV as a `data:` URL. Used as the source for an
// HTMLAudioElement that loops continuously — the trick that keeps macOS's
// audio session classified as "media app" so the WebContent process's audio
// plumbing doesn't get parked during idle. Even after a clean `ctx.close()`
// recreate, the parked state survives (confirmed by reproduction): the
// session never has a chance to park if an HTMLMediaElement is playing.
// ~150 bytes total; 100ms of 8kHz 8-bit mono silence.
function createSilentWavDataUrl(): string {
  const sampleRate = 8000;
  const numSamples = Math.floor(sampleRate * 0.1);
  const dataSize = numSamples;
  const fileSize = 44 + dataSize;
  const buf = new ArrayBuffer(fileSize);
  const v = new DataView(buf);
  v.setUint32(0, 0x52494646, false); // "RIFF"
  v.setUint32(4, fileSize - 8, true);
  v.setUint32(8, 0x57415645, false); // "WAVE"
  v.setUint32(12, 0x666d7420, false); // "fmt "
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate, true);
  v.setUint16(32, 1, true); // block align
  v.setUint16(34, 8, true); // bits per sample
  v.setUint32(36, 0x64617461, false); // "data"
  v.setUint32(40, dataSize, true);
  // 0x80 is the centre value (silence) for unsigned 8-bit PCM.
  for (let i = 0; i < numSamples; i++) v.setUint8(44 + i, 0x80);
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return `data:audio/wav;base64,${btoa(bin)}`;
}

export interface AudioEngineCallbacks {
  // Path of the track that should follow `path`, or null if it is the last.
  getNextPath: (path: string) => string | null;
  // Playback advanced to `path` at the gapless boundary. The host updates
  // now-playing metadata, the highlighted row, and album art.
  onAdvance: (path: string) => void;
  // Playback position / track length, in seconds.
  onTime: (seconds: number) => void;
  onDuration: (seconds: number) => void;
  // Mirrors AudioContext running/suspended state into the isPlaying signal.
  onPlayingChange: (playing: boolean) => void;
  // The engine cannot play `path` (codec the WebView can't decode, oversize,
  // or fetch failure). The host plays it via the <audio> element instead
  // (non-gapless for that one file).
  onUnsupported: (path: string) => void;
}

interface Voice {
  path: string;
  buffer: AudioBuffer;
  source: AudioBufferSourceNode;
  // Context time at which playback position equals `startOffset`.
  startCtxTime: number;
  // Seconds into the buffer at `startCtxTime` (non-zero after a seek).
  startOffset: number;
}

type DecodeResult =
  | { kind: "ok"; buffer: AudioBuffer }
  // A newer generation invalidated this decode (track changed / teardown).
  | { kind: "superseded" }
  | { kind: "fetchError"; error: unknown }
  | { kind: "decodeError"; error: unknown }
  | { kind: "tooLarge"; bytes: number };

// Explicit state of the "next track" slot — replaces inferring intent from a
// tangle of booleans.
type NextSlot =
  | { status: "idle" } // not looked at yet (only before first scheduleNext)
  | { status: "none" } // no successor: current is the last track
  | { status: "decoding" } // decode in flight
  | { status: "scheduled"; voice: Voice } // decoded and start()-scheduled
  | { status: "failed"; path: string }; // successor exists but engine can't play it

function estimatedBytes(buffer: AudioBuffer): number {
  return buffer.length * buffer.numberOfChannels * 4; // Float32 per sample
}

export class GaplessEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  // AnalyserNode tapped off masterGain (gain → analyser as a dead-end branch,
  // in parallel with gain → destination). Lets us measure actual signal level
  // at the output of the engine's audio graph. When the silent-after-idle bug
  // appears, comparing RMS here against "we believe we're playing" distinguishes
  // graph-side silence (RMS=0 → audio engine is dead) from OS-side silence
  // (RMS>0 → graph is producing audio, OS isn't routing it).
  private analyser: AnalyserNode | null = null;
  private analyserBuf: Float32Array | null = null;
  private volume = 1;

  private current: Voice | null = null;
  private next: NextSlot = { status: "idle" };

  // Bumped on every interruption (new track, stop, seek-rebuild) so a decode
  // resolving late for a superseded track is discarded.
  private decodeGen = 0;
  // True when the current track ended before its successor finished decoding;
  // the in-flight decode then starts immediately instead of at the boundary.
  private currentEndedEarly = false;
  // True when the last track in the folder played through to completion.
  // `current` still points at the (now-dead) voice so togglePause can rebuild
  // a fresh source from its buffer and restart from the top.
  private endedAtEnd = false;

  // Abort in-flight fetches on interruption so rapid track-skipping does not
  // stack full background downloads/decodes.
  private currentAbort: AbortController | null = null;
  private nextAbort: AbortController | null = null;

  private rafId: number | null = null;
  private heartbeatId: number | null = null;

  // Diagnostic counters for the silent-after-idle bug. sourcesStarted is bumped
  // every time AudioBufferSourceNode.start() succeeds; sourcesEnded is bumped
  // when its onended fires. If sourcesStarted advances but sourcesEnded doesn't
  // (or vice versa) something is wrong with the lifecycle.
  private sourcesStarted = 0;
  private sourcesEnded = 0;

  // Captured at the previous heartbeat so we can log the delta against the
  // current heartbeat. Comparing wall-clock delta vs AudioContext.currentTime
  // delta tells us whether the audio clock is advancing at real time
  // (healthy) or frozen underneath a context that still reports "running"
  // (the bug signature).
  private prevHeartbeatWall: number | null = null;
  private prevHeartbeatCtxTime: number | null = null;

  // Wall-clock time of the most recent real-time source.start() (play, seek,
  // started-late). Logged as `idleMs` in heartbeats and the play() entry so
  // we can correlate the silent-after-idle bug with how long the engine sat
  // unused. No longer drives behavior — staleness gates do.
  private lastPlaybackAt = Date.now();

  // Set when a gate (visibility:visible, window.focus) signals that the audio
  // session may have gone dormant. Drives ctx recreate on next play() (or
  // eagerly, if nothing is playing). Cleared whenever recreate runs.
  private staleMarked = false;
  private staleReason: string | null = null;

  // Always-on silent HTMLAudioElement. While this loops, macOS classifies us
  // as an active media app and WebKit's audio session stays in playback mode
  // instead of being parked during idle. The known fix for the silent-
  // after-idle bug that ctx.close()+recreate alone does not address (Mode 2
  // in our logs: graph healthy, OS layer still drops output).
  private keepAlive: HTMLAudioElement | null = null;
  private keepAlivePlaying = false;

  constructor(private cb: AudioEngineCallbacks) {
    this.startHeartbeat();
    // Best-effort early start; if autoplay is blocked without a gesture, the
    // first play() call will retry from a user-gesture context.
    this.startKeepAlive();
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", () => {
        const v = document.visibilityState;
        alog("visibilitychange", {
          visibility: v,
          ctxState: this.ctx?.state ?? "none",
          ctxTime: this.ctx?.currentTime ?? null,
          hasCurrent: this.current !== null,
        });
        // Returning from a hidden state is a prime moment for the OS audio
        // session to have gone dormant beneath us. Mark stale so the next
        // play() (or an eager recreate, if nothing is playing) hits a fresh
        // ctx.
        if (v === "visible") this.markStale("visibilitychange:visible");
      });
    }
    if (typeof window !== "undefined") {
      // Window receiving focus (user clicked back from another app) is a
      // separate signal from visibility — a Tauri window can stay "visible"
      // while another app holds the OS audio focus. Treat focus the same way
      // as visibility-visible.
      window.addEventListener("focus", () => {
        alog("window.focus", {
          ctxState: this.ctx?.state ?? "none",
          ctxTime: this.ctx?.currentTime ?? null,
          hasCurrent: this.current !== null,
        });
        this.markStale("window:focus");
      });
    }
  }

  // Reads ctx.sinkId if the (relatively new) Audio Output Devices API exposes
  // it. Defensive: not all WebViews implement it; absence is not an error.
  private sinkId(): string | null {
    const ctx = this.ctx as (AudioContext & { sinkId?: string }) | null;
    return ctx?.sinkId ?? null;
  }

  // Samples the analyser's time-domain output and returns RMS (root mean
  // square) of the most recent fftSize samples. RMS > 0 means the audio graph
  // is producing signal at the tap point right now; RMS == 0 while we think
  // we're playing is the smoking gun for graph-side silence.
  private outputRms(): number | null {
    if (!this.analyser || !this.analyserBuf) return null;
    this.analyser.getFloatTimeDomainData(this.analyserBuf);
    let sum = 0;
    for (let i = 0; i < this.analyserBuf.length; i++) {
      const s = this.analyserBuf[i];
      sum += s * s;
    }
    return Math.sqrt(sum / this.analyserBuf.length);
  }

  // Snapshot of the audio output state — included on every play.started,
  // statechange, and heartbeat so we can correlate the silent state with
  // gain/destination/sink/RMS the moment it happens.
  private outputSnapshot(): Record<string, unknown> {
    const ctx = this.ctx;
    const dest = ctx?.destination;
    return {
      gainValue: this.masterGain?.gain.value ?? null,
      destChannels: dest?.channelCount ?? null,
      destMaxChannels: dest?.maxChannelCount ?? null,
      sinkId: this.sinkId(),
      rms: this.outputRms(),
    };
  }

  // Sanity check that decodeAudioData produced real PCM. Sums |sample| over
  // the first chunk of channel 0; a value of 0 means the decoder silently
  // produced a dead buffer. Bounded work — ~1024 floats — so safe to call
  // before every source.start().
  private bufferSampleSum(buffer: AudioBuffer, samples = 1024): number {
    if (buffer.length === 0 || buffer.numberOfChannels === 0) return 0;
    const data = buffer.getChannelData(0);
    const n = Math.min(samples, data.length);
    let sum = 0;
    for (let i = 0; i < n; i++) sum += Math.abs(data[i]);
    return sum;
  }

  // getOutputTimestamp returns the audio-clock time and performance-clock time
  // corresponding to the same instant at the audio output. If contextTime
  // stops advancing while performanceTime keeps moving, the audio clock froze
  // underneath a context that still reports state === "running" — the
  // smoking-gun signature for the silent-after-idle bug.
  private outputTimestamps(): Record<string, number | null> {
    const ctx = this.ctx;
    if (!ctx) return { outputContextTime: null, outputPerformanceTime: null };
    const fn = (
      ctx as AudioContext & {
        getOutputTimestamp?: () => { contextTime: number; performanceTime: number };
      }
    ).getOutputTimestamp;
    if (!fn) return { outputContextTime: null, outputPerformanceTime: null };
    try {
      const ts = fn.call(ctx);
      return {
        outputContextTime: ts.contextTime,
        outputPerformanceTime: ts.performanceTime,
      };
    } catch {
      return { outputContextTime: null, outputPerformanceTime: null };
    }
  }

  // Create (once) and start the silent keep-alive HTMLAudioElement. Calling
  // play() on a <audio> element requires a user gesture in many WebKit
  // configurations, so the initial call may be rejected; we keep retrying
  // from play() (the natural user-gesture moment) until it sticks.
  private startKeepAlive(): void {
    if (typeof Audio === "undefined") return;
    if (!this.keepAlive) {
      try {
        const a = new Audio(createSilentWavDataUrl());
        a.loop = true;
        // Effectively inaudible; even with system volume at max the human ear
        // can't hear 8-bit silence at this level. macOS still treats the
        // element as actively producing audio for session-classification.
        a.volume = 0.001;
        a.preload = "auto";
        this.keepAlive = a;
      } catch (e) {
        awarn("keepAlive.create.threw", { error: String(e) });
        return;
      }
    }
    if (this.keepAlivePlaying) return;
    const a = this.keepAlive;
    void a.play().then(
      () => {
        this.keepAlivePlaying = true;
        alog("keepAlive.started", { duration: a.duration });
      },
      (e) => {
        // Autoplay rejected — typically resolves after the next user
        // gesture (next play() call retries).
        awarn("keepAlive.playRejected", { error: String(e) });
      },
    );
  }

  // Flag the engine for ctx recreate on the next play(). If nothing is
  // currently playing (no `current`, no scheduled `next`), recreate eagerly —
  // there's no source to interrupt and pre-creating a fresh ctx removes the
  // small latency from the next play(). Multiple signals stack onto the same
  // pending flag; the first reason wins for logging purposes.
  private markStale(reason: string): void {
    if (!this.staleMarked) {
      this.staleMarked = true;
      this.staleReason = reason;
    }
    const playing =
      this.current !== null || this.next.status === "scheduled";
    alog("engine.markStale", {
      reason,
      hasCurrent: this.current !== null,
      nextStatus: this.next.status,
      eager: !playing,
    });
    if (!playing) {
      void this.recreateCtx(reason).catch((e) =>
        aerr("ctx.recreate.threw", { reason, error: String(e) }),
      );
    }
  }

  // Close the current AudioContext and let ensureCtx() build a fresh one.
  // This is the documented fix for the WKWebView silent-after-idle bug
  // (suspend/resume isn't enough — see Apple Developer Forum thread 658375
  // and WebKit bug 237878). The decoded AudioBuffers held by the old ctx are
  // implicitly invalidated; that's fine, the engine always re-decodes on
  // play() and on seek-during-resume. Refuses to run while a source is
  // (potentially) live: doing so would silence the user.
  private async recreateCtx(reason: string): Promise<void> {
    if (this.current !== null || this.next.status === "scheduled") {
      awarn("ctx.recreate.skipped.playing", { reason });
      return;
    }
    const old = this.ctx;
    const snapshot = old
      ? {
          oldState: old.state,
          oldCtxTime: old.currentTime,
          oldSampleRate: old.sampleRate,
        }
      : { oldState: "none", oldCtxTime: null, oldSampleRate: null };
    alog("ctx.recreate.start", {
      reason,
      sourcesStarted: this.sourcesStarted,
      sourcesEnded: this.sourcesEnded,
      ...snapshot,
    });
    this.ctx = null;
    this.masterGain = null;
    this.analyser = null;
    this.analyserBuf = null;
    this.staleMarked = false;
    this.staleReason = null;
    if (old) {
      try {
        await old.close();
      } catch (e) {
        awarn("ctx.close.threw", { reason, error: String(e) });
      }
    }
    // Build the fresh ctx now (eager case) — the next play() / seekTo() sees
    // an already-warm engine. If a play() is in flight it will hit
    // ensureCtx() itself and find the new one.
    this.ensureCtx();
    alog("ctx.recreate.done", { reason });
  }

  private ensureCtx(): { ctx: AudioContext; gain: GainNode } {
    if (!this.ctx || !this.masterGain) {
      let ctx: AudioContext;
      let fellBack = false;
      try {
        ctx = new AudioContext(CONTEXT_OPTIONS);
      } catch (e) {
        fellBack = true;
        aerr("AudioContext(opts) threw, retrying with defaults", {
          error: String(e),
        });
        ctx = new AudioContext();
      }
      const gain = ctx.createGain();
      gain.gain.value = this.volume;
      gain.connect(ctx.destination);
      // Parallel tap: gain feeds the destination (audible path) AND the
      // analyser (monitoring branch). Analyser output is intentionally not
      // connected anywhere — it just accumulates input for getFloatTimeDomainData.
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      gain.connect(analyser);
      this.analyser = analyser;
      this.analyserBuf = new Float32Array(analyser.fftSize);
      // statechange fires for every transition (running↔suspended↔closed). The
      // silent-after-idle bug very likely involves an unexpected suspended or
      // closed state, so we want a timestamped record of every flip.
      ctx.addEventListener("statechange", () => {
        alog("ctx.statechange", {
          state: ctx.state,
          ctxTime: ctx.currentTime,
          ...this.outputSnapshot(),
        });
      });
      this.ctx = ctx;
      this.masterGain = gain;
      alog("ctx.created", {
        sampleRate: ctx.sampleRate,
        baseLatency: (ctx as AudioContext).baseLatency,
        outputLatency: (ctx as { outputLatency?: number }).outputLatency,
        state: ctx.state,
        fellBackToDefaults: fellBack,
        destChannels: ctx.destination.channelCount,
        destMaxChannels: ctx.destination.maxChannelCount,
        sinkId: this.sinkId(),
      });
    }
    return { ctx: this.ctx, gain: this.masterGain };
  }

  // Periodic snapshot of context + playback state. The silent-audio bug only
  // appears after long idle, so a low-frequency heartbeat gives us a record of
  // ctx.state and ctx.currentTime advancement across the dead period — if the
  // context's clock froze or it auto-suspended, we'll see exactly when.
  private startHeartbeat(): void {
    if (this.heartbeatId !== null) return;
    this.heartbeatId = window.setInterval(() => {
      const ctx = this.ctx;
      const now = Date.now();
      const ctxNow = ctx?.currentTime ?? null;
      // Compare wall-clock delta to AudioContext-clock delta. Healthy:
      // wallDeltaMs ≈ ctxDeltaSec * 1000. Bug signature: wallDeltaMs advances
      // but ctxDeltaSec stays at 0 — the audio clock is frozen while the
      // context still self-reports "running".
      let wallDeltaMs: number | null = null;
      let ctxDeltaSec: number | null = null;
      if (
        this.prevHeartbeatWall !== null &&
        this.prevHeartbeatCtxTime !== null
      ) {
        wallDeltaMs = now - this.prevHeartbeatWall;
        if (ctxNow !== null) {
          ctxDeltaSec = ctxNow - this.prevHeartbeatCtxTime;
        }
      }
      this.prevHeartbeatWall = now;
      this.prevHeartbeatCtxTime = ctxNow;
      const snap = this.outputSnapshot();
      const rms = snap.rms;
      // Treat any non-trivial signal as "playback is happening now" — keeps
      // lastPlaybackAt fresh during long tracks so a subsequent play() after
      // a legitimate break doesn't incorrectly trip the idle probe.
      // Critically: only count rms when ctx is actually running. When the ctx
      // is suspended (user paused), the AnalyserNode's ring buffer still
      // reports the last samples it saw before the suspend, so rms reads
      // stale-but-loud even though no audio is actually flowing. Counting
      // that would silently defeat the idle probe across long pauses, which
      // is exactly what happened in the tunng-Sixes reproduction.
      if (
        ctx?.state === "running" &&
        typeof rms === "number" &&
        rms > 0.0001
      ) {
        this.lastPlaybackAt = now;
      }
      alog("heartbeat", {
        ctxState: ctx?.state ?? "none",
        ctxTime: ctxNow,
        wallDeltaMs,
        ctxDeltaSec,
        hasCurrent: this.current !== null,
        currentPath: this.current?.path ?? null,
        position: this.current ? this.position() : null,
        nextStatus: this.next.status,
        endedAtEnd: this.endedAtEnd,
        currentEndedEarly: this.currentEndedEarly,
        decodeGen: this.decodeGen,
        sourcesStarted: this.sourcesStarted,
        sourcesEnded: this.sourcesEnded,
        idleMs: now - this.lastPlaybackAt,
        visibility:
          typeof document !== "undefined" ? document.visibilityState : null,
        ...snap,
        ...this.outputTimestamps(),
      });
    }, 30000);
  }

  setVolume(v: number): void {
    this.volume = v;
    if (this.masterGain) this.masterGain.gain.value = v;
  }

  private stopVoice(v: Voice): void {
    v.source.onended = null;
    try {
      v.source.stop();
    } catch {
      /* already stopped */
    }
    v.source.disconnect();
  }

  // Stop everything and discard pending decodes. Keeps the AudioContext alive
  // for reuse (it is silent with no connected sources).
  private teardown(): void {
    this.decodeGen++;
    this.currentEndedEarly = false;
    this.endedAtEnd = false;
    this.currentAbort?.abort();
    this.nextAbort?.abort();
    this.currentAbort = null;
    this.nextAbort = null;
    if (this.current) this.stopVoice(this.current);
    if (this.next.status === "scheduled") this.stopVoice(this.next.voice);
    this.current = null;
    this.next = { status: "idle" };
    this.stopRaf();
  }

  stop(): void {
    alog("stop()", {
      ctxState: this.ctx?.state ?? "none",
      hasCurrent: this.current !== null,
    });
    this.teardown();
    this.cb.onPlayingChange(false);
  }

  private async decode(
    path: string,
    gen: number,
    abort: AbortController,
  ): Promise<DecodeResult> {
    const { ctx } = this.ensureCtx();
    let bytes: ArrayBuffer;
    try {
      const res = await fetch(convertFileSrc(path), { signal: abort.signal });
      bytes = await res.arrayBuffer();
    } catch (error) {
      if (abort.signal.aborted || gen !== this.decodeGen) {
        return { kind: "superseded" };
      }
      return { kind: "fetchError", error };
    }
    if (gen !== this.decodeGen) return { kind: "superseded" };
    let buffer: AudioBuffer;
    try {
      buffer = await ctx.decodeAudioData(bytes);
    } catch (error) {
      if (gen !== this.decodeGen) return { kind: "superseded" };
      return { kind: "decodeError", error };
    }
    if (gen !== this.decodeGen) return { kind: "superseded" };
    const size = estimatedBytes(buffer);
    if (size > MAX_TRACK_BYTES) return { kind: "tooLarge", bytes: size };
    return { kind: "ok", buffer };
  }

  private makeSource(buffer: AudioBuffer): AudioBufferSourceNode {
    const { ctx, gain } = this.ensureCtx();
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(gain);
    return source;
  }

  private logUnplayable(path: string, r: DecodeResult): void {
    if (r.kind === "fetchError") {
      aerr("decode.fetchError", { path, error: String(r.error) });
    } else if (r.kind === "decodeError") {
      awarn("decode.decodeError (codec?)", { path, error: String(r.error) });
    } else if (r.kind === "tooLarge") {
      awarn("decode.tooLarge", { path, bytes: r.bytes, ceiling: MAX_TRACK_BYTES });
    }
  }

  // Start playing `path` now, replacing anything currently playing.
  async play(path: string): Promise<void> {
    // Guaranteed user-gesture context. Retries the keep-alive if its initial
    // autoplay attempt in the constructor was rejected — once the loop is
    // running it stays running for the rest of the session.
    this.startKeepAlive();
    const idleMs = Date.now() - this.lastPlaybackAt;
    alog("play()", {
      path,
      ctxState: this.ctx?.state ?? "none",
      hadCurrent: this.current !== null,
      endedAtEnd: this.endedAtEnd,
      idleMs,
      sourcesStarted: this.sourcesStarted,
      sourcesEnded: this.sourcesEnded,
    });
    this.teardown();

    // Recreate the AudioContext if a staleness gate fired since the last
    // recreate. teardown() just nulled `current`, so no source is alive —
    // this is the safe moment. The recreate closes the old ctx and builds a
    // fresh one (fresh AUHAL unit, fresh OS audio session client) to fix the
    // well-documented WKWebView silent-after-idle bug. Decoded buffers were
    // tied to the old ctx and are now invalidated; play() will re-decode
    // below.
    if (this.staleMarked) {
      await this.recreateCtx(this.staleReason ?? "unknown");
    }

    const { ctx } = this.ensureCtx();

    // Auto-suspended contexts have to be resumed before audio will flow.
    // Fire-and-forget; the source.start() below schedules at ctx.currentTime
    // which advances once resume completes.
    if (ctx.state === "suspended") {
      alog("play.resume(suspended ctx)", { ctxTime: ctx.currentTime });
      void ctx.resume();
    }

    const gen = this.decodeGen;
    const abort = new AbortController();
    this.currentAbort = abort;

    const r = await this.decode(path, gen, abort);
    if (gen !== this.decodeGen) {
      alog("play.decode.superseded-after-await", { path, gen });
      return;
    }
    if (r.kind !== "ok") {
      this.logUnplayable(path, r);
      if (r.kind !== "superseded") this.cb.onUnsupported(path);
      return;
    }

    const sampleSum = this.bufferSampleSum(r.buffer);
    alog("play.decoded", {
      path,
      duration: r.buffer.duration,
      channels: r.buffer.numberOfChannels,
      length: r.buffer.length,
      sampleSum,
    });

    const source = this.makeSource(r.buffer);
    source.start(ctx.currentTime, 0);
    this.sourcesStarted++;
    this.lastPlaybackAt = Date.now();
    this.current = {
      path,
      buffer: r.buffer,
      source,
      startCtxTime: ctx.currentTime,
      startOffset: 0,
    };
    this.attachEnded(source, gen);

    alog("play.started", {
      path,
      duration: r.buffer.duration,
      ctxTime: ctx.currentTime,
      ctxState: ctx.state,
      sourcesStarted: this.sourcesStarted,
      sourcesEnded: this.sourcesEnded,
      ...this.outputSnapshot(),
      ...this.outputTimestamps(),
    });
    // Multi-offset RMS samples: 250 ms is the original "just to be sure" mark.
    // 500/1000/3000 ms tell us if silence persists or if the OS audio session
    // wakes on its own after a delay. If silent at 250 but audible at 1000,
    // the OS recovered. If silent at all four, the source is dead until the
    // next user interaction. Gen-guarded so a fast track-change doesn't blame
    // a torn-down voice.
    const startedGen = gen;
    const startedPath = path;
    const sampleAt = (ms: number) => {
      setTimeout(() => {
        if (startedGen !== this.decodeGen) return;
        alog(`play.rmsCheck+${ms}ms`, {
          path: startedPath,
          ctxState: this.ctx?.state ?? "none",
          ctxTime: this.ctx?.currentTime ?? null,
          sourcesStarted: this.sourcesStarted,
          sourcesEnded: this.sourcesEnded,
          ...this.outputSnapshot(),
          ...this.outputTimestamps(),
        });
      }, ms);
    };
    sampleAt(250);
    sampleAt(500);
    sampleAt(1000);
    sampleAt(3000);
    this.cb.onDuration(r.buffer.duration);
    this.cb.onTime(0);
    this.cb.onPlayingChange(true);
    this.startRaf();
    void this.scheduleNext(gen);
  }

  private attachEnded(source: AudioBufferSourceNode, gen: number): void {
    source.onended = () => {
      this.sourcesEnded++;
      if (gen !== this.decodeGen) return;
      if (!this.current || this.current.source !== source) return;
      this.onCurrentEnded(gen);
    };
  }

  // Decode the successor and schedule it at the exact end of the current
  // buffer. Runs as soon as the current track starts, giving multi-minute
  // tracks ample decode headroom.
  private async scheduleNext(gen: number): Promise<void> {
    if (!this.current) return;
    const nextPath = this.cb.getNextPath(this.current.path);
    if (!nextPath) {
      this.next = { status: "none" };
      alog("scheduleNext.none", { afterPath: this.current.path });
      return;
    }

    this.next = { status: "decoding" };
    alog("scheduleNext.decoding", {
      afterPath: this.current.path,
      nextPath,
      gen,
    });
    const abort = new AbortController();
    this.nextAbort = abort;
    const r = await this.decode(nextPath, gen, abort);
    if (gen !== this.decodeGen || !this.current) {
      alog("scheduleNext.superseded-after-decode", { nextPath, gen });
      return;
    }

    if (r.kind !== "ok") {
      this.logUnplayable(nextPath, r);
      if (r.kind === "superseded") return;
      this.next = { status: "failed", path: nextPath };
      // If the current track already ended, act on the failure now.
      if (this.currentEndedEarly) {
        this.currentEndedEarly = false;
        this.cb.onUnsupported(nextPath);
      }
      return;
    }

    const { ctx } = this.ensureCtx();
    if (this.currentEndedEarly) {
      // Current ended while this was decoding — start now (small gap) and
      // promote immediately.
      this.currentEndedEarly = false;
      const source = this.makeSource(r.buffer);
      source.start(ctx.currentTime, 0);
      this.sourcesStarted++;
      this.lastPlaybackAt = Date.now();
      this.next = {
        status: "scheduled",
        voice: {
          path: nextPath,
          buffer: r.buffer,
          source,
          startCtxTime: ctx.currentTime,
          startOffset: 0,
        },
      };
      alog("scheduleNext.startedLate", {
        nextPath,
        ctxTime: ctx.currentTime,
      });
      this.promote(gen);
      return;
    }

    const boundary =
      this.current.startCtxTime +
      (this.current.buffer.duration - this.current.startOffset);
    const source = this.makeSource(r.buffer);
    source.start(boundary);
    this.sourcesStarted++;
    this.next = {
      status: "scheduled",
      voice: {
        path: nextPath,
        buffer: r.buffer,
        source,
        startCtxTime: boundary,
        startOffset: 0,
      },
    };
    alog("scheduleNext.scheduled", {
      nextPath,
      boundary,
      ctxTime: ctx.currentTime,
      // Positive if scheduled in the future (the normal case); negative would
      // mean we missed the boundary, which is informative.
      leadSeconds: boundary - ctx.currentTime,
    });
  }

  private onCurrentEnded(gen: number): void {
    alog("onCurrentEnded", {
      gen,
      nextStatus: this.next.status,
      ctxState: this.ctx?.state ?? "none",
      ctxTime: this.ctx?.currentTime ?? null,
      path: this.current?.path ?? null,
    });
    switch (this.next.status) {
      case "scheduled":
        this.promote(gen);
        return;
      case "decoding":
        // Successor still decoding; scheduleNext starts it immediately.
        this.currentEndedEarly = true;
        return;
      case "failed": {
        const failedPath = this.next.path;
        this.stopRaf();
        this.cb.onUnsupported(failedPath);
        return;
      }
      case "none":
      case "idle":
      default: {
        // Last track (or successor never resolved): playback finished. Leave
        // `current` set so togglePause can restart it from the top.
        const cur = this.current;
        this.stopRaf();
        if (cur) this.cb.onTime(cur.buffer.duration);
        this.endedAtEnd = true;
        this.cb.onPlayingChange(false);
        alog("onCurrentEnded.endedAtEnd", {
          ctxState: this.ctx?.state ?? "none",
          ctxTime: this.ctx?.currentTime ?? null,
        });
        return;
      }
    }
  }

  // next -> current. The audio is already seamless; this only moves UI state.
  private promote(gen: number): void {
    if (this.next.status !== "scheduled") return;
    const promoted = this.next.voice;
    if (this.current) this.current.source.disconnect();
    this.current = promoted;
    this.next = { status: "idle" };
    this.attachEnded(promoted.source, gen);
    alog("promote", {
      path: promoted.path,
      startCtxTime: promoted.startCtxTime,
      ctxTime: this.ctx?.currentTime ?? null,
      duration: promoted.buffer.duration,
    });
    this.cb.onAdvance(promoted.path);
    this.cb.onDuration(promoted.buffer.duration);
    this.startRaf();
    void this.scheduleNext(gen);
  }

  private position(): number {
    if (!this.current || !this.ctx) return 0;
    const pos =
      this.ctx.currentTime - this.current.startCtxTime + this.current.startOffset;
    return Math.max(0, Math.min(this.current.buffer.duration, pos));
  }

  hasTrack(): boolean {
    return this.current !== null;
  }

  isPaused(): boolean {
    return this.ctx?.state === "suspended";
  }

  togglePause(): void {
    alog("togglePause()", {
      hasCtx: this.ctx !== null,
      hasCurrent: this.current !== null,
      ctxState: this.ctx?.state ?? "none",
      endedAtEnd: this.endedAtEnd,
    });
    if (!this.ctx || !this.current) return;
    if (this.endedAtEnd) {
      // Last track finished; rebuild the source from the buffer and restart.
      // An AudioBufferSourceNode is one-shot, so we can't just resume — seekTo
      // recreates it and (since we were endedAtEnd) syncs the UI. We resume
      // ctx defensively in case it auto-suspended while idle.
      alog("togglePause.endedAtEnd→restart");
      this.seekTo(0);
      if (this.ctx.state === "suspended") {
        alog("togglePause.endedAtEnd.resume");
        void this.ctx.resume();
      }
      return;
    }
    if (this.ctx.state === "running") {
      void this.ctx.suspend().then(() => {
        alog("togglePause.suspended", { ctxTime: this.ctx?.currentTime });
        this.cb.onPlayingChange(false);
        this.stopRaf();
      });
    } else {
      void this.ctx.resume().then(() => {
        alog("togglePause.resumed", {
          ctxTime: this.ctx?.currentTime,
          ctxState: this.ctx?.state,
        });
        this.cb.onPlayingChange(true);
        this.startRaf();
      });
    }
  }

  seekBy(seconds: number): void {
    this.seekTo(this.position() + seconds);
  }

  seekTo(seconds: number): void {
    alog("seekTo()", {
      seconds,
      hasCtx: this.ctx !== null,
      hasCurrent: this.current !== null,
      ctxState: this.ctx?.state ?? "none",
      ctxTime: this.ctx?.currentTime ?? null,
      endedAtEnd: this.endedAtEnd,
    });
    if (!this.current || !this.ctx) return;
    const cur = this.current;
    const pos = Math.max(0, Math.min(cur.buffer.duration, seconds));
    const wasEnded = this.endedAtEnd;
    const gen = ++this.decodeGen; // invalidate the old scheduled `next`
    this.currentEndedEarly = false;
    this.endedAtEnd = false;

    this.stopVoice(cur);
    this.nextAbort?.abort();
    this.nextAbort = null;
    if (this.next.status === "scheduled") this.stopVoice(this.next.voice);
    this.next = { status: "idle" };

    const source = this.makeSource(cur.buffer);
    source.start(this.ctx.currentTime, pos);
    this.sourcesStarted++;
    this.lastPlaybackAt = Date.now();
    cur.source = source;
    cur.startCtxTime = this.ctx.currentTime;
    cur.startOffset = pos;
    this.attachEnded(source, gen);
    this.cb.onTime(pos);
    alog("seekTo.done", {
      pos,
      ctxTime: this.ctx.currentTime,
      ctxState: this.ctx.state,
      wasEnded,
      ...this.outputSnapshot(),
      ...this.outputTimestamps(),
    });
    // seek is just as much an "audio starts now" event as play(): a fresh
    // source is created and started. Without rms samples here we have no
    // measurement when the user jumps past a silent intro into a loud
    // section — and that's exactly the window where the silent-after-idle
    // bug got past us last time. Gen-guarded against rapid re-seeks.
    const seekGen = gen;
    const seekPath = cur.path;
    const seekCheck = (ms: number) => {
      setTimeout(() => {
        if (seekGen !== this.decodeGen) return;
        alog(`seekTo.rmsCheck+${ms}ms`, {
          path: seekPath,
          pos,
          ctxState: this.ctx?.state ?? "none",
          ctxTime: this.ctx?.currentTime ?? null,
          sourcesStarted: this.sourcesStarted,
          sourcesEnded: this.sourcesEnded,
          ...this.outputSnapshot(),
          ...this.outputTimestamps(),
        });
      }, ms);
    };
    seekCheck(250);
    seekCheck(1000);
    if (wasEnded) {
      // Seek resurrected a finished track — the new source is actively
      // playing, so sync the UI (which still showed the stopped state).
      this.cb.onPlayingChange(true);
      this.startRaf();
    }
    void this.scheduleNext(gen);
  }

  private startRaf(): void {
    if (this.rafId !== null) return;
    const tick = () => {
      this.cb.onTime(this.position());
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  private stopRaf(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }
}
