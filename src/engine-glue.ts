// The native audio engine handle plus the System Now Playing bridge. The engine
// is a stable `const` imported wherever playback is driven; its track-changed /
// stream-metadata callbacks resolve the UI's now-playing state, and a small set
// of push helpers + effects feed macOS Control Center / the lock screen.

import { invoke } from "@tauri-apps/api/core";
import { effect } from "@preact/signals-core";
import { GaplessEngine } from "./audio-engine";
import {
  hasTrack,
  npTitle,
  npArtist,
  npAlbum,
  npArt,
  npStreamMeta,
  isStream,
  isPlaying,
  currentTime,
  duration,
  currentNodePath,
  currentStreamUrl,
  queuePlayingIndex,
  app,
} from "./state";
import {
  siblingByPath,
  queueIsActivePool,
  loadArt,
  cleanStreamText,
} from "./main";
import { setNowPlaying, handleEnded } from "./playback";

export const engine = new GaplessEngine({
  onAdvance: (path) => {
    // currentParent stays the album folder across an album. For external/
    // search playback there is no parent and no sibling row to highlight; the
    // UI was already set by the caller (playSearchTrack / openExternalFile).
    const node = siblingByPath(path);
    if (!node) return;
    currentNodePath.value = node.path;
    currentStreamUrl.value = null;
    // Track which queue row is live. A play/jump sets pendingQueueIndex to its
    // target; a gapless auto-advance leaves it null, so we step to the next row
    // down (positional, so duplicate rows resolve to the right instance).
    if (queueIsActivePool()) {
      queuePlayingIndex.value =
        app.pendingQueueIndex ?? (queuePlayingIndex.value ?? -1) + 1;
    } else {
      queuePlayingIndex.value = null;
    }
    app.pendingQueueIndex = null;
    setNowPlaying(node.title ?? node.name, node.artist, node.album);
    void loadArt(node.path);
  },
  onTime: (t) => { currentTime.value = t; nowPlayingPositionTick(t); },
  onDuration: (d) => { duration.value = d; },
  onPlayingChange: (p) => { isPlaying.value = p; },
  onError: (path, message) => {
    console.error("audio: track failed", path, message);
  },
  onQueueEnded: () => {
    handleEnded();
  },
  // ICY now-playing for radio. The station name stays on the title line no
  // matter what so the layout never shifts when metadata arrives; the ICY
  // title fades in below it. The stream list's stream name wins over the
  // server's icy-name (stream list names are user-curated; icy-name is often a
  // slogan). The title is conventionally "Artist - Song"; split on the first
  // separator, keeping the whole string as the song when there is none.
  onStreamMetadata: (station, title) => {
    if (!isStream.value) return;
    const stationName =
      app.currentStreamName ?? (station ? cleanStreamText(station) : null);
    setNowPlaying(stationName || "Stream", null, null);
    const cleaned = title ? cleanStreamText(title) : "";
    if (cleaned) {
      const sep = cleaned.indexOf(" - ");
      const artist = sep > 0 ? cleaned.slice(0, sep).trim() : null;
      const song = sep > 0 ? cleaned.slice(sep + 3).trim() : cleaned;
      npStreamMeta.value = { song: song || cleaned, artist };
    } else {
      npStreamMeta.value = null;
    }
  },
});

// --- System Now Playing (macOS Control Center / lock screen / media keys) ---
//
// The OS integration lives in Rust (now_playing.rs); this half feeds it the
// resolved metadata + playback state that only the frontend knows. We push
// metadata whenever it changes and playback state on play/pause, plus a ~1 Hz
// refresh so the OS scrubber tracks seeks (position events themselves aren't
// forwarded — the OS extrapolates elapsed time from the last rate we sent).

function pushNowPlayingMeta(): void {
  if (!hasTrack.value) return;
  let title = npTitle.value;
  let artist = npArtist.value;
  // Radio: surface the current song/artist when the station sends ICY metadata,
  // falling back to the station name on the title line.
  if (isStream.value && npStreamMeta.value) {
    title = npStreamMeta.value.song;
    artist = npStreamMeta.value.artist ?? npTitle.value;
  }
  void invoke("now_playing_set_metadata", {
    title,
    artist,
    album: npAlbum.value,
    art: npArt.value,
    // Streams have no timeline; a 0 duration tells the OS to show it as live.
    duration: isStream.value ? 0 : duration.value,
  });
}

function pushPlayback(elapsed: number): void {
  if (!hasTrack.value) return;
  void invoke("now_playing_set_playback", {
    playing: isPlaying.value,
    elapsed,
  });
  app.lastPlaybackPush = performance.now();
}

// Throttled position refresh, called from the engine's position callback so the
// OS elapsed time re-syncs (e.g. after a seek) without one IPC call per tick.
function nowPlayingPositionTick(t: number): void {
  if (!isPlaying.value) return;
  if (performance.now() - app.lastPlaybackPush > 1000) pushPlayback(t);
}

// Metadata card: fires on any change to the fields that make it up.
effect(() => {
  // Subscribe to every field the card is built from.
  npTitle.value;
  npArtist.value;
  npAlbum.value;
  npArt.value;
  duration.value;
  npStreamMeta.value;
  isStream.value;
  hasTrack.value;
  pushNowPlayingMeta();
});

// Play/pause: push immediately so the widget's button state flips at once.
effect(() => {
  isPlaying.value;
  hasTrack.value;
  pushPlayback(currentTime.peek());
});
