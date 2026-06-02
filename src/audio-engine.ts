// Thin IPC wrapper around the native gapless engine that lives in Rust
// (src-tauri/src/audio.rs). All actual decoding, resampling, and device output
// happen there; this file translates frontend calls into Tauri commands and
// surfaces engine events back to UI callbacks.
//
// The webview no longer touches audio for local files. Internet radio streams
// stay on the HTMLAudioElement in main.ts (separate code path).

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface AudioEngineCallbacks {
  // Fires when playback advances to a new track (initial track of a Play, or
  // auto-advance to the next queue entry).
  onAdvance: (path: string) => void;
  // Playback position / track length, in seconds. Position is throttled to
  // ~20 Hz by the engine.
  onTime: (seconds: number) => void;
  onDuration: (seconds: number) => void;
  // Engine's view of whether audio is actively playing.
  onPlayingChange: (playing: boolean) => void;
  // A single track failed to decode or open. The engine auto-advances past it;
  // this callback is for logging / surfacing to the user.
  onError: (path: string, message: string) => void;
  // The engine has played through the entire queue. The "current track" stays
  // remembered so a subsequent play() with the same queue can restart from the
  // last track that ran.
  onQueueEnded: () => void;
}

interface TrackChangedEvent {
  path: string;
  duration: number;
}
interface PositionEvent {
  seconds: number;
}
interface StateEvent {
  playing: boolean;
  has_track: boolean;
}
interface ErrorEvent {
  path: string;
  message: string;
}

export class GaplessEngine {
  // Mirror of the engine's notion of "current track" so the UI can answer
  // hasTrack() / isPaused() / seekBy() synchronously without an IPC round-trip.
  private currentPath: string | null = null;
  private currentDuration = 0;
  private currentPosition = 0;
  private playing = false;
  private unlistens: UnlistenFn[] = [];

  constructor(private cb: AudioEngineCallbacks) {
    void this.attach();
  }

  private async attach(): Promise<void> {
    this.unlistens.push(
      await listen<TrackChangedEvent>("audio:track-changed", (e) => {
        this.currentPath = e.payload.path;
        this.currentDuration = e.payload.duration;
        this.cb.onAdvance(e.payload.path);
        this.cb.onDuration(e.payload.duration);
      }),
    );
    this.unlistens.push(
      await listen<PositionEvent>("audio:position", (e) => {
        this.currentPosition = e.payload.seconds;
        this.cb.onTime(e.payload.seconds);
      }),
    );
    this.unlistens.push(
      await listen<StateEvent>("audio:state", (e) => {
        this.playing = e.payload.playing;
        this.cb.onPlayingChange(e.payload.playing);
        if (!e.payload.has_track) {
          this.currentPath = null;
          this.currentDuration = 0;
          this.currentPosition = 0;
        }
      }),
    );
    this.unlistens.push(
      await listen<ErrorEvent>("audio:error", (e) => {
        this.cb.onError(e.payload.path, e.payload.message);
      }),
    );
    this.unlistens.push(
      await listen("audio:queue-ended", () => {
        this.cb.onQueueEnded();
      }),
    );
  }

  async setVolume(v: number): Promise<void> {
    await invoke("audio_set_volume", { volume: v });
  }

  async stop(): Promise<void> {
    await invoke("audio_stop");
  }

  // Start (or replace) playback with a queue of file paths. start_index picks
  // which entry to play first; the engine auto-advances through the rest
  // gaplessly.
  async play(tracks: string[], startIndex: number = 0): Promise<void> {
    if (tracks.length === 0) return;
    // Optimistic: claim the start track immediately so the UI's
    // hasTrack()/isPaused() reflect intent before the track-changed event
    // round-trips back from the engine.
    const start = Math.max(0, Math.min(tracks.length - 1, startIndex));
    this.currentPath = tracks[start];
    this.playing = true;
    await invoke("audio_play", { tracks, startIndex: start });
  }

  hasTrack(): boolean {
    return this.currentPath !== null;
  }

  isPaused(): boolean {
    return this.currentPath !== null && !this.playing;
  }

  isPlaying(): boolean {
    return this.playing;
  }

  async togglePause(): Promise<void> {
    await invoke("audio_toggle_pause");
  }

  async seekBy(seconds: number): Promise<void> {
    if (this.currentPath === null) return;
    const target = Math.max(
      0,
      Math.min(this.currentDuration, this.currentPosition + seconds),
    );
    await this.seekTo(target);
  }

  async seekTo(seconds: number): Promise<void> {
    if (this.currentPath === null) return;
    await invoke("audio_seek", { seconds });
  }
}
