// Thin IPC wrapper around the native gapless engine that lives in Rust
// (src-tauri/src/audio.rs). All actual decoding, resampling, and device output
// happen there; this file translates frontend calls into Tauri commands and
// surfaces engine events back to UI callbacks.
//
// The webview does not touch audio at all. Local files and internet radio
// both play through the native engine; radio additionally reports in-band
// ICY metadata via onStreamMetadata.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { SearchTrack } from "./types";

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
  // Playback is waiting on `path` to be downloaded from a file provider, or on
  // nothing when null. Not an error and not a stall: the transport stays live
  // and the track plays by itself once the file lands.
  onFetching: (path: string | null) => void;
  // A cloud file's bytes are on this Mac now, and `track` is the file read again
  // now that it can be read at all — the row every surface is holding for it was
  // built from a scan that could see its name and nothing else. Distinct from
  // onFetching(null), which only says the wait ended: a download that failed
  // clears the same way, and this fires only when the file actually arrived.
  onDownloaded: (track: SearchTrack) => void;
  // The engine has played through the entire queue. The "current track" stays
  // remembered so a subsequent play() with the same queue can restart from the
  // last track that ran.
  onQueueEnded: () => void;
  // Radio-stream now-playing info. `station` is the server's icy-name header
  // (arrives on connect/reconnect); `title` is the latest in-band StreamTitle,
  // null until the first one arrives or when the station clears it.
  onStreamMetadata: (station: string | null, title: string | null) => void;
}

interface TrackChangedEvent {
  path: string;
  duration: number;
  // The play session this advance belongs to (see `playToken`).
  token: number;
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
// Null path = nothing is being fetched. One event carries the whole state (see
// emit_fetching) so a missed edge can't leave the UI waiting forever.
interface FetchingEvent {
  path: string | null;
}
interface StreamMetadataEvent {
  station: string | null;
  title: string | null;
}

export class GaplessEngine {
  // Mirror of the engine's notion of "current track" so seekBy()/seekTo() can
  // compute and guard seek targets synchronously without an IPC round-trip.
  private currentPath: string | null = null;
  private currentDuration = 0;
  private currentPosition = 0;
  // Identifies the play session every engine command opens. Bumped
  // synchronously before the command is sent and echoed back on track-changed,
  // so an advance belonging to a play we have already superseded can be told
  // apart from the real one and dropped.
  //
  // It has to travel with the event, because by the time a stale one lands
  // nothing else can identify it: the engine emits track-changed from its
  // position thread, and one emitted for the outgoing play can still be in
  // flight over IPC when the next play() is issued. Replay the same files as a
  // new pool and its path, its queue slot, and every piece of frontend state it
  // would be checked against are identical to the real advance's. Acting on it
  // consumed the pending highlight index and left the true first track
  // highlighted one row too far down (see engine-glue's onAdvance).
  private playToken = 0;
  private unlistens: UnlistenFn[] = [];

  constructor(private cb: AudioEngineCallbacks) {
    void this.attach();
  }

  private async attach(): Promise<void> {
    this.unlistens.push(
      await listen<TrackChangedEvent>("audio:track-changed", (e) => {
        // A superseded play's advance describes audio that is no longer
        // sounding: ignore it outright rather than letting it move the track,
        // the highlight, or the duration.
        if (e.payload.token !== this.playToken) return;
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
      await listen<FetchingEvent>("audio:fetching", (e) => {
        this.cb.onFetching(e.payload.path);
      }),
    );
    this.unlistens.push(
      await listen<SearchTrack>("audio:downloaded", (e) => {
        this.cb.onDownloaded(e.payload);
      }),
    );
    this.unlistens.push(
      await listen("audio:queue-ended", () => {
        this.cb.onQueueEnded();
      }),
    );
    this.unlistens.push(
      await listen<StreamMetadataEvent>("audio:stream-metadata", (e) => {
        this.cb.onStreamMetadata(e.payload.station, e.payload.title);
      }),
    );
  }

  async setVolume(v: number): Promise<void> {
    await invoke("audio_set_volume", { volume: v });
  }

  // Start (or replace) playback with a queue of file paths. start_index picks
  // which entry to play first; the engine auto-advances through the rest
  // gaplessly.
  async play(tracks: string[], startIndex: number = 0): Promise<void> {
    if (tracks.length === 0) return;
    // Optimistic: claim the start track immediately so a seek issued before
    // the track-changed event round-trips back from the engine isn't dropped
    // by the currentPath guard.
    const start = Math.max(0, Math.min(tracks.length - 1, startIndex));
    this.currentPath = tracks[start];
    // Bumped before the command is sent, so every track-changed still in flight
    // from the previous play is already recognizable as stale.
    const token = ++this.playToken;
    await invoke("audio_play", { tracks, startIndex: start, token });
  }

  // Start (or replace) playback with an internet radio stream. The engine
  // owns the connection, live-edge pause/resume semantics, and reconnects;
  // now-playing info flows back through onStreamMetadata.
  async playStream(url: string): Promise<void> {
    // Optimistic, mirroring play(): streams emit no track-changed event, so
    // claim the source immediately. Duration/position stay 0 — live streams
    // have no timeline and the UI disables seeking.
    this.currentPath = url;
    this.currentDuration = 0;
    this.currentPosition = 0;
    // A stream emits no track-changed of its own, so this is what keeps the
    // outgoing file's last advance from landing on top of it.
    const token = ++this.playToken;
    await invoke("audio_play_stream", { url, token });
  }

  async togglePause(): Promise<void> {
    await invoke("audio_toggle_pause");
  }

  // Drop the queued tracks after the current one, so the currently playing
  // track runs to its natural end and then reports queue-ended — at which point
  // the frontend picks the next track. Used when shuffle / repeat-one turns on
  // mid-album: the change takes effect immediately (the ordered tail is gone)
  // without restarting or glitching what's playing.
  async clearUpcoming(): Promise<void> {
    await invoke("audio_clear_upcoming");
  }

  // Append tracks to the tail of the current queue without interrupting the
  // playing track. During straight play the engine reaches them via gapless
  // auto-advance; if the queue had already drained, playback resumes into them.
  // Backs the "Add to queue" action.
  async append(tracks: string[]): Promise<void> {
    if (tracks.length === 0) return;
    await invoke("audio_append", { tracks });
  }

  // Tear down playback: drop the queue and silence the device. The engine
  // reports has_track=false, which clears the transport. Backs "Close queue".
  async stop(): Promise<void> {
    this.currentPath = null;
    this.currentDuration = 0;
    this.currentPosition = 0;
    // Teardown supersedes the play it tears down: nothing it emitted on its way
    // out may re-light a row behind the stop.
    const token = ++this.playToken;
    await invoke("audio_stop", { token });
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
