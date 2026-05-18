import { convertFileSrc } from "@tauri-apps/api/core";

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
  private volume = 1;

  private current: Voice | null = null;
  private next: NextSlot = { status: "idle" };

  // Bumped on every interruption (new track, stop, seek-rebuild) so a decode
  // resolving late for a superseded track is discarded.
  private decodeGen = 0;
  // True when the current track ended before its successor finished decoding;
  // the in-flight decode then starts immediately instead of at the boundary.
  private currentEndedEarly = false;

  // Abort in-flight fetches on interruption so rapid track-skipping does not
  // stack full background downloads/decodes.
  private currentAbort: AbortController | null = null;
  private nextAbort: AbortController | null = null;

  private rafId: number | null = null;

  constructor(private cb: AudioEngineCallbacks) {}

  private ensureCtx(): { ctx: AudioContext; gain: GainNode } {
    if (!this.ctx || !this.masterGain) {
      let ctx: AudioContext;
      try {
        ctx = new AudioContext(CONTEXT_OPTIONS);
      } catch {
        ctx = new AudioContext();
      }
      const gain = ctx.createGain();
      gain.gain.value = this.volume;
      gain.connect(ctx.destination);
      this.ctx = ctx;
      this.masterGain = gain;
    }
    return { ctx: this.ctx, gain: this.masterGain };
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
      console.error("gapless: fetch failed", path, r.error);
    } else if (r.kind === "decodeError") {
      console.warn("gapless: decodeAudioData failed (codec?)", path, r.error);
    } else if (r.kind === "tooLarge") {
      console.warn(
        `gapless: track exceeds ${MAX_TRACK_BYTES} byte PCM ceiling ` +
          `(${r.bytes}); streaming via <audio>`,
        path,
      );
    }
  }

  // Start playing `path` now, replacing anything currently playing.
  async play(path: string): Promise<void> {
    this.teardown();
    const { ctx } = this.ensureCtx();
    const gen = this.decodeGen;
    const abort = new AbortController();
    this.currentAbort = abort;

    const r = await this.decode(path, gen, abort);
    if (gen !== this.decodeGen) return;
    if (r.kind !== "ok") {
      this.logUnplayable(path, r);
      if (r.kind !== "superseded") this.cb.onUnsupported(path);
      return;
    }

    const source = this.makeSource(r.buffer);
    source.start(ctx.currentTime, 0);
    this.current = {
      path,
      buffer: r.buffer,
      source,
      startCtxTime: ctx.currentTime,
      startOffset: 0,
    };
    this.attachEnded(source, gen);

    if (ctx.state === "suspended") void ctx.resume();
    this.cb.onDuration(r.buffer.duration);
    this.cb.onTime(0);
    this.cb.onPlayingChange(true);
    this.startRaf();
    void this.scheduleNext(gen);
  }

  private attachEnded(source: AudioBufferSourceNode, gen: number): void {
    source.onended = () => {
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
      return;
    }

    this.next = { status: "decoding" };
    const abort = new AbortController();
    this.nextAbort = abort;
    const r = await this.decode(nextPath, gen, abort);
    if (gen !== this.decodeGen || !this.current) return;

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
      this.promote(gen);
      return;
    }

    const boundary =
      this.current.startCtxTime +
      (this.current.buffer.duration - this.current.startOffset);
    const source = this.makeSource(r.buffer);
    source.start(boundary);
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
  }

  private onCurrentEnded(gen: number): void {
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
        // Last track (or successor never resolved): playback finished.
        const cur = this.current;
        this.stopRaf();
        if (cur) this.cb.onTime(cur.buffer.duration);
        this.cb.onPlayingChange(false);
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
    if (!this.ctx || !this.current) return;
    if (this.ctx.state === "running") {
      void this.ctx.suspend().then(() => {
        this.cb.onPlayingChange(false);
        this.stopRaf();
      });
    } else {
      void this.ctx.resume().then(() => {
        this.cb.onPlayingChange(true);
        this.startRaf();
      });
    }
  }

  seekBy(seconds: number): void {
    this.seekTo(this.position() + seconds);
  }

  seekTo(seconds: number): void {
    if (!this.current || !this.ctx) return;
    const cur = this.current;
    const pos = Math.max(0, Math.min(cur.buffer.duration, seconds));
    const gen = ++this.decodeGen; // invalidate the old scheduled `next`
    this.currentEndedEarly = false;

    this.stopVoice(cur);
    this.nextAbort?.abort();
    this.nextAbort = null;
    if (this.next.status === "scheduled") this.stopVoice(this.next.voice);
    this.next = { status: "idle" };

    const source = this.makeSource(cur.buffer);
    source.start(this.ctx.currentTime, pos);
    cur.source = source;
    cur.startCtxTime = this.ctx.currentTime;
    cur.startOffset = pos;
    this.attachEnded(source, gen);
    this.cb.onTime(pos);
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
