// One capture can serve multiple consumers. Add new documentation scenes here.
// Each recipe runs in a fresh app/profile and must prepare its own complete state.
import path from 'node:path';

// Exercise the app's normal session restoration: it restores paused at an exact
// playhead without racing audio callbacks (seeking a live track resumes playback).
export function initialSettings(library, manifest) {
  const first = manifest.tracks[0];
  const tracks = manifest.tracks.filter((track) => track.album === first.album)
    .map((track) => ({ ...track, path: path.join(library, track.file) }));
  return {
    libraryRoots: [library],
    themeMode: 'dark', darkAccent: 'pistachio', volume: 0,
    followSampleRate: false, autoadvance: false,
    shuffleMode: false, repeatMode: 'off', replayGainMode: 'off',
    nowPlayingView: 'art',
    equalizer: { enabled: false, preamp: 0, gains: Array(10).fill(0) },
    windowSizeNormal: { width: 960, height: 640 },
    windowSizeMini: { width: 367, height: 168 }, windowPosition: { x: 120, y: 120 },
    playbackSession: {
      queue: { kind: 'album', title: first.album, subtitle: `${tracks.length} tracks`, tracks },
      index: 0, path: tracks[0].path, time: 42, duration: first.duration,
    },
  };
}

async function nowPlaying(d, library, manifest, { clearQueue = false } = {}) {
  const track = manifest.tracks[0];
  await d.waitFor(async () => {
    const songs = await d.invoke('list_all_songs');
    return songs.length === manifest.tracks.length;
  }, { timeout: 30_000, message: 'Screenshot library was not fully indexed' });
  await d.waitFor(async () => {
    const state = await d.probe();
    return !state.isPlaying && state.title === track.title && state.currentTime === 42 &&
      state.currentNodePath === path.join(library, track.file);
  }, { message: 'Demo session did not restore paused at 0:42' });
  await d.waitFor(async () => Number(await d.prop('#now-playing-art', 'naturalWidth')) > 0,
    { message: 'Album artwork did not load' });
  // Restored sessions open the list. Clearing it preserves the paused track
  // while removing the queue and its navigation chrome from the basic layout.
  await d.click(clearQueue ? '#queue-close-btn' : '#nav-bar-btn');
  await d.action('browseAlbum', { album: track.album, albumArtist: track.albumArtist });
  await d.waitFor(async () => (await d.text('#library-nav')).includes('Moss Circuit'),
    { message: 'Album tracks were not shown in the library' });
}

async function basicLayout(d, library, manifest) {
  await nowPlaying(d, library, manifest, { clearQueue: true });
  await d.waitFor(async () => {
    const state = await d.probe();
    return state.queueLength === 0 && state.queuePlayingIndex === null &&
      !state.activePoolIsPlaylist && !state.shuffle && state.repeat === 'off' &&
      !state.autoadvance && !(await d.exists('#now-playing-panel.has-nav')) &&
      !(await d.prop('#eq-enabled', 'checked'));
  }, { message: 'Basic layout must have no queue or optional playback features enabled' });
}

export const scenes = [
  {
    id: 'desktop', size: { width: 960, height: 640 },
    destinations: ['apps/desktop/images/screenshot.png', 'apps/website/src/assets/desktop.png'],
    prepare: basicLayout,
  },
  {
    id: 'mini', size: { width: 367, height: 168 },
    destinations: ['apps/desktop/images/mini.png', 'apps/website/src/assets/mini.png'],
    prepare: nowPlaying,
  },
];
