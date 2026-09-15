// One capture can serve multiple consumers. Add new documentation scenes here.
// Each recipe runs in a fresh app/profile and must prepare its own complete state.
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { encodePNG } from './png.mjs';

// Exercise the app's normal session restoration: it restores paused at an exact
// playhead without racing audio callbacks (seeking a live track resumes playback).
// A scene layers its own `settings` over this rather than restating it.
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

// Every documentation scene is the same 960 × 640 window, so the images sit
// together on a page without one of them reading as a different app. The mini
// player is the sole exception — its window genuinely is that small.
const WINDOW = { width: 960, height: 640 };
const asset = (name) => [`apps/website/src/assets/${name}.png`];

// --- Fictional stream list ---------------------------------------------------
// The streams list draws a radio glyph per row, so these are names only.
// "Night Light Radio" exists to give the search scene a stream hit for its query.
const STATIONS = [
  'Night Light Radio',
  'Deep Field FM',
  'Paper Lantern Radio',
  'Coastal Static',
  'Orbit One',
];

// One of them is a station the suite actually broadcasts (station.mjs), so the
// streams scene can capture live radio rather than describe it: the LIVE
// indicator in place of the seek row, no prev/next, the ICY song title under the
// station name, and the station's own artwork in Now Playing. The rest stay
// unreachable example URLs — nothing connects to them.
//
// `title` is the ICY StreamTitle the station broadcasts, in the conventional
// "Artist - Song" form the hero splits across its two lines. The artist is one
// the fixture library does not contain, so the image can't be misread as a local
// track playing.
// Its artwork is also what the scene asserts the hero is showing: the restored
// session's album cover is 512 square, so a 600 there is proof the art swapped
// to the station's own rather than a cover left over from the paused track.
const LOGO_SIZE = 600;
export const LIVE_STATION = {
  name: 'Deep Field FM',
  title: 'Hollow Coast - Tidal Hour',
  song: 'Tidal Hour',
  logo: stationLogo(),
};

// Generated rather than tracked, like the fixture library's covers: concentric
// signal rings over a deep field, in colors no album in that library uses.
function stationLogo() {
  const field = [0x0a, 0x12, 0x2b], wave = [0x4f, 0xd8, 0xc4], core = [0xff, 0xc2, 0x6b];
  const rgba = Buffer.alloc(LOGO_SIZE * LOGO_SIZE * 4);
  for (let y = 0; y < LOGO_SIZE; y += 1) {
    for (let x = 0; x < LOGO_SIZE; x += 1) {
      const dx = x / LOGO_SIZE - 0.5, dy = y / LOGO_SIZE - 0.5;
      const r = Math.hypot(dx, dy);
      const rings = (0.5 + 0.5 * Math.cos(r * 64 - 0.8)) ** 4 * Math.max(0, 1 - r * 2.1);
      const glow = Math.max(0, 1 - r * 16) ** 2.4;
      const i = (y * LOGO_SIZE + x) * 4;
      for (let c = 0; c < 3; c += 1) {
        const lit = field[c] + (wave[c] - field[c]) * rings;
        rgba[i + c] = Math.round(Math.min(255, lit + (core[c] - lit) * glow));
      }
      rgba[i + 3] = 255;
    }
  }
  return encodePNG(LOGO_SIZE, LOGO_SIZE, rgba);
}

// Written beside the library folder, never inside it: a .m3u8 under a library
// root would show up as another playlist in the Files panel. That directory is
// also the one path Settings may display (see publishablePaths), so every scene
// that opens Settings takes this rather than the per-profile default the app
// would otherwise write — which names the capture machine.
const streamListPath = (library) => path.join(path.dirname(library), 'Stations.m3u8');
async function writeStreamList(profile, library, station) {
  const lines = ['#EXTM3U'];
  STATIONS.forEach((name, index) => {
    // The one live station points at the suite's own broadcast and carries its
    // art on the tvg-logo attribute, the same convention a real stream list
    // uses. Loopback URLs and an ephemeral port never reach a pixel: the list
    // shows station names, and Now Playing shows the fetched image.
    const live = name === LIVE_STATION.name;
    const attrs = live ? ` tvg-logo="${station.logoUrl}"` : '';
    const url = live ? station.streamUrl : `https://streams.example/${index + 1}`;
    lines.push(`#EXTINF:-1${attrs},${name}`, url);
  });
  await writeFile(streamListPath(library), `${lines.join('\n')}\n`);
}
const withStreams = { fixture: writeStreamList, settings: (library) => ({ manifestPath: streamListPath(library) }) };

// --- Shared arrival ----------------------------------------------------------

async function nowPlaying(d, library, manifest, { clearQueue = false } = {}) {
  const track = manifest.tracks[0];
  await d.waitFor(async () => {
    const songs = await d.invoke('list_all_songs');
    return songs.length === manifest.tracks.length;
  }, { timeout: 30_000, message: 'Screenshot library was not fully indexed' });
  // A full row count is not the end of the scan — rows land as they are read, and
  // the navigator only re-renders a restored drill when the scan finishes. Without
  // this, a scene that asserts on the Files panel races a pane the app is still
  // about to replace, which is exactly how the artist scene fails intermittently.
  await d.waitFor(async () => !(await d.exists('#scan-status.scanning')),
    { timeout: 30_000, message: 'Library scan did not finish' });
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
}

// Absolute paths from the capture machine must never reach a tracked image. Only
// Settings shows any — its library-folder rows and its stream list — and the
// panel is shorter than the pane, so there is no framing that leaves them out.
// Instead the fixtures they name live at a path that is the same on every Mac
// (run.mjs), and this proves the panel shows nothing else: the rows carry their
// paths as input values, which no pixel or text assertion can see.
async function publishablePaths(d, library) {
  const fixtures = path.dirname(library);
  const shown = await d.action('panelPaths', { selector: '#settings-panel' });
  const paths = shown.filter((value) => value.startsWith('/'));
  const leaked = paths.filter((value) => value !== fixtures && !value.startsWith(`${fixtures}/`));
  if (leaked.length) throw new Error(`Settings shows a path outside ${fixtures}: ${leaked.join(', ')}`);
  if (paths.length < 2) throw new Error(`Settings showed ${paths.length} paths; expected the library folder and the stream list`);
}

// The tracks of an album other than the restored one, as absolute paths.
const albumPaths = (library, manifest, album) => manifest.tracks
  .filter((track) => track.album === album)
  .map((track) => path.join(library, track.file));

// --- Recipes -----------------------------------------------------------------

async function basicLayout(d, library, manifest) {
  await nowPlaying(d, library, manifest, { clearQueue: true });
  // The Files panel stays on its index — the library views, then the Playlists
  // section listing the two playlists the fixture library ships with. No drill is
  // needed: an unset navLocation restores the navigator to its root menu.
  await d.waitFor(async () => {
    const nav = await d.text('#library-nav');
    return ['Browse', 'Songs', 'Artists', 'Albums', 'Playlists', 'Favorites', 'Synthwave']
      .every((label) => nav.includes(label));
  }, { message: 'Files panel index did not list the views and both example playlists' });
  await d.waitFor(async () => {
    const state = await d.probe();
    return state.queueLength === 0 && state.queuePlayingIndex === null &&
      !(await d.exists('.nav-back')) &&
      !state.activePoolIsPlaylist && !state.shuffle && state.repeat === 'off' &&
      !state.autoadvance && !(await d.exists('#now-playing-panel.has-nav')) &&
      !(await d.prop('#eq-enabled', 'checked'));
  }, { message: 'Basic layout must sit at the Files index with no queue or optional playback features' });
}

// Artists drilled one level: the artist's Albums section over their Tracks
// section, with the back row to Artists. Documents the drill model, which the
// flat view lists (all rows, no hierarchy) can't show. The restored album stays
// the playing pool so its track carries the playing glyph in this list.
async function artistDetail(d, library, manifest) {
  await nowPlaying(d, library, manifest);
  const { albumArtist, album } = manifest.tracks[0];
  const titles = manifest.tracks.filter((track) => track.album === album).map((track) => track.title);
  await d.waitFor(async () => {
    const nav = await d.text('#library-nav');
    return nav.includes(albumArtist) && nav.includes(album) && titles.every((t) => nav.includes(t));
  }, { message: `Artist detail did not list ${albumArtist}'s album and tracks` });
  await d.waitFor(() => d.exists('.nav-back'), { message: 'Artist detail should offer a back row to Artists' });
}

// One query across the categories search spans. "light" is chosen because the
// fixture answers it in four of them at once: a track, an album, the album's
// folder, and a station.
const SEARCH_QUERY = 'light';
async function searchResults(d, library, manifest) {
  await nowPlaying(d, library, manifest);
  await d.action('search', { query: SEARCH_QUERY });
  await d.waitFor(async () => !(await d.exists('#search-results.hidden')),
    { message: 'Search results did not open' });
  await d.waitFor(async () => {
    const results = await d.text('#search-results');
    return ['The Last Green Light', 'Borrowed Light', 'Album', 'Night Light Radio']
      .every((label) => results.includes(label));
  }, { message: `"${SEARCH_QUERY}" did not match a track, an album, a folder and a stream` });
}

// The Streams tab with a station actually on the air. Everything that makes the
// transport read as radio rather than a file — the LIVE indicator where the seek
// row sits, no prev/next, the ICY song under the station name, the station's own
// art — is state only a live connection produces, so this scene is the one that
// leaves the shared paused session behind (see liveStream).
async function streamsTab(d, library, manifest, station) {
  await nowPlaying(d, library, manifest, { clearQueue: true });
  await d.click('.tab[data-tab="streams"]');
  await d.waitFor(async () => {
    const list = await d.text('#streams-list');
    return STATIONS.every((name) => list.includes(name));
  }, { message: 'Streams tab did not list the fixture stations' });
  // The row's own play button, which is how a station starts from this list —
  // no bridge shortcut reaching past the UI. Attribute values need no escaping
  // here: a URL carries neither a quote nor a backslash.
  const row = `#streams-list .node-label[data-stream-url="${station.streamUrl}"]`;
  await d.click(`${row} .row-play`);
  // isPlaying belongs in this predicate, not the next one: the frontend turns
  // isStream and the title on synchronously inside playStream, while isPlaying
  // waits on the engine's own state event — a round trip later. Reading it in
  // the give-up check below without waiting for it here makes that check fire
  // on the gap between the click and the command landing.
  await d.waitFor(async () => {
    const state = await d.probe();
    return state.isStream && state.isPlaying && state.title === LIVE_STATION.name;
  }, { message: `The transport did not take over for ${LIVE_STATION.name}` });
  await d.waitFor(() => d.exists(`${row}.playing`),
    { message: 'The playing station did not take the list highlight' });
  // The engine reported playing the moment the command landed, before it had
  // connected, so that alone is no proof of live radio. The in-band title is:
  // it exists only once the station's own body is being decoded, and it arrives
  // one metadata block after the first audio. Waiting for it here is also what
  // keeps the two native captures from straddling its fade-in. A station that
  // never answers gives up after 30s and drops back to paused instead, which the
  // first half of this predicate turns into a failure that names the cause —
  // unambiguously, now that playing has already been observed once.
  await d.waitFor(async () => {
    if (!(await d.probe()).isPlaying) {
      throw new Error(`${LIVE_STATION.name} gave up connecting; see this scene's app log`);
    }
    return (await d.text('#now-playing-stream-meta')).includes(LIVE_STATION.song);
  }, { timeout: 45_000, message: 'The station\'s ICY title never reached Now Playing' });
  await d.waitFor(async () => !(await d.exists('#live-indicator.hidden')) &&
    await d.exists('#seek-bar.hidden') && await d.exists('#prev-btn.hidden'),
    { message: 'The transport did not swap the seek row for the live indicator' });
  // Station art replaces the restored album's cover in the same spot, and only
  // its size tells the two apart — see LOGO_SIZE.
  await d.waitFor(async () => Number(await d.prop('#now-playing-art', 'naturalWidth')) === LOGO_SIZE,
    { timeout: 30_000, message: 'Now Playing is not showing the station\'s own artwork' });
}

// A playlist opened in the right pane through the single-click path, without
// playing it — playback has to stay paused at 0:42 for every capture.
async function playlistView(d, library, manifest) {
  await nowPlaying(d, library, manifest, { clearQueue: true });
  await d.action('browsePlaylist', { path: path.join(library, 'Favorites.m3u8') });
  await d.waitFor(async () => (await d.text('#queue-title-text')) === 'Favorites',
    { message: 'Favorites did not open in the right pane' });
  await d.waitFor(async () => Number(await d.attr('#queue-list', 'data-row-count')) > 0,
    { message: 'The open playlist rendered no rows' });
}

// The queue as the docs describe it: an existing queue grown by "Add to queue",
// and the Clear button that dismisses the whole thing. Distinguished from the
// playlist scene by its title and that Clear.
//
// The restored session is itself the queue this appends to — it carries no
// sourcePath, so it renders as "Queue" with the Clear button, and its synthetic
// `queue:restored` pool makes the placement verbs see a real queue. Clearing it
// first would instead route Add to queue through createQueue (its no-real-queue
// branch), which builds a queue at rest: engine stopped, empty hero, playhead
// gone — and every scene here must stay paused at 0:42.
async function queueView(d, library, manifest) {
  await nowPlaying(d, library, manifest);
  const paths = albumPaths(library, manifest, 'Weather for Satellites').slice(0, 4);
  const before = (await d.probe()).queueLength;
  await d.action('addToQueue', { paths });
  await d.action('showSourceList');
  await d.waitFor(async () => {
    const state = await d.probe();
    return state.queueLength === before + paths.length && state.queueIsActivePool &&
      !state.activePoolIsPlaylist && await d.exists('#queue-close-btn');
  }, { message: 'Add to queue did not append to the playing queue' });
}

// The visualizer is a live canvas, so this is the one scene that can't simply be
// held still by freezing CSS. captureStill composes a fixed number of frames from
// a seeded field and a synthetic waveform, then leaves the loop stopped — so the
// runner's two native captures agree.
async function visualizerStill(d, library, manifest) {
  await nowPlaying(d, library, manifest, { clearQueue: true });
  await d.waitFor(async () => await d.exists('#now-playing-panel.view-visualizer'),
    { message: 'Now Playing did not restore on the visualizer view' });
  // A new track flashes its title over the scene and fades it back out. Let that
  // finish rather than capturing a banner mid-life.
  await d.waitFor(async () => !(await d.exists('.viz-track-banner.show')),
    { timeout: 10_000, message: 'The track banner never finished its hold' });
  await d.action('visualizerStill');
}

// Settings, on the theme picker. The panel's library-folder and stream-list rows
// show absolute paths, so this scene takes the fixture stream list rather than
// the per-profile default and asserts every path on screen is a fixture path
// before the shutter.
async function themePicker(d, library, manifest) {
  await nowPlaying(d, library, manifest, { clearQueue: true });
  await d.action('openPanel', { panel: 'settings' });
  await d.waitFor(async () => {
    const swatches = await d.text('#theme-swatches');
    return swatches.includes('Pistachio') && swatches.includes('Apple');
  }, { message: 'The theme picker did not render both the dark and light groups' });
  await publishablePaths(d, library);
}

// The equalizer with a curve dialled in. The bars themselves only move to a live
// signal, and every capture is paused, so the sliders carry the picture.
async function equalizer(d, library, manifest) {
  await nowPlaying(d, library, manifest, { clearQueue: true });
  await d.action('openPanel', { panel: 'equalizer' });
  await d.waitFor(async () => await d.prop('#eq-enabled', 'checked') && await d.exists('.eq-band .eq-slider'),
    { message: 'The equalizer panel did not open with the restored curve enabled' });
}

// The tag editor, opened on a track that isn't the one playing: Save is disabled
// while the engine holds the file open, and a greyed-out button with a warning
// is the wrong thing to document.
async function metadataEditor(d, library, manifest) {
  await nowPlaying(d, library, manifest, { clearQueue: true });
  const [track] = albumPaths(library, manifest, 'Borrowed Light');
  await d.action('editMetadata', { path: track });
  await d.waitFor(async () => (await d.text('#pane-editor-view')).includes('Editing'),
    { message: 'The metadata editor did not open' });
  await d.waitFor(async () => await d.exists('#now-playing-panel.show-editor'),
    { message: 'The editor face did not take the pane' });
}

// The wide Files panel: the divider moved right until the leaf list is past its
// column gate, with the header up, a sorted column, and two fields the automatic
// set would never put there — Genre and Year, which only vary row to row in a flat
// Songs list spanning every album. Seeded through the stored splitter width and
// column prefs rather than through `Columns ▸`: that menu is a native one, out of
// this runner's reach, and the store is the same path a returning user's own
// layout arrives by (setupSplitter / loadColumnPrefs, before the first paint).
const YEAR_CELL = '#library-nav .nav-track-row:not(.colhead) [data-col="year"]';
async function wideColumns(d, library, manifest) {
  await nowPlaying(d, library, manifest, { clearQueue: true });
  await d.waitFor(async () => (await d.text('.nav-back-title')) === 'Songs',
    { message: 'The Files panel is not on the Songs view' });
  // The rows carry a cell per field in both layouts, so their presence alone
  // proves nothing about the capture — but a filled Year is what says this image
  // is of a set the automatic columns would never have produced.
  await d.waitFor(async () =>
    (await d.exists(YEAR_CELL)) && /^(19|20)\d\d$/.test(await d.text(YEAR_CELL)),
    { message: 'The Songs rows did not render a filled Year column' });
  // Below the container gate the header collapses and the fields fold back into one
  // inline run, so a seeded width that fell short would capture the ordinary narrow
  // list and say nothing. offsetHeight is the proof the header is laid out at all.
  await d.waitFor(async () => Number(await d.prop('#library-nav .colhead', 'offsetHeight')) > 0,
    { message: 'The column header is not laid out: the Files panel is below the column gate' });
  await d.waitFor(async () => {
    const head = await d.text('#library-nav .colhead');
    return ['Title', 'Artist', 'Album', 'Year', 'Time'].every((label) => head.includes(label));
  }, { message: 'The column header did not carry every seeded column' });
  // The sort arrow is half of what this image documents, and it only exists on the
  // sorted column's own cell.
  await d.waitFor(() => d.exists('#library-nav .colhead-cell.sorted .colhead-arrow'),
    { message: 'The header did not mark a sorted column' });
  if (Number(await d.prop('#left', 'offsetWidth')) <= 280) {
    throw new Error('The left panel is still at its default width; the stored splitter width did not take');
  }
}

// --- What the probe must show at the shutter ---------------------------------
// A recipe has to reach its state without disturbing playback, so the runner
// re-asserts the expected state just before the shutter: a scene that started
// something by accident would otherwise capture a moving playhead, and the two
// native captures would never agree on where it was.
export function restoredSession(state) {
  return !state.isPlaying && Math.abs(Number(state.currentTime) - 42) < 0.1
    ? null : 'the restored session, paused at 0:42';
}

// The streams scene is the one that is deliberately live. It has no playhead to
// pin — a stream has no timeline, which is the very thing the image documents —
// so what the runner checks instead is the absence of one.
function liveStream(state) {
  return state.isStream && state.isPlaying && Number(state.duration) === 0
    ? null : 'a station playing live, with no timeline';
}

export const scenes = [
  {
    id: 'desktop', size: WINDOW,
    destinations: ['apps/desktop/images/screenshot.png', 'apps/website/src/assets/desktop.png'],
    prepare: basicLayout,
  },
  {
    id: 'mini', size: { width: 367, height: 168 },
    destinations: ['apps/desktop/images/mini.png', 'apps/website/src/assets/mini.png'],
    prepare: nowPlaying,
  },
  {
    id: 'artist', size: WINDOW, destinations: asset('library-artist'),
    settings: (library, manifest) => ({
      navLocation: [{ t: 'view', view: 'artist' }, { t: 'artist', name: manifest.tracks[0].albumArtist }],
    }),
    prepare: artistDetail,
  },
  {
    id: 'search', size: WINDOW, destinations: asset('search'),
    ...withStreams, prepare: searchResults,
  },
  {
    id: 'streams', size: WINDOW, destinations: asset('streams'),
    ...withStreams, prepare: streamsTab, playback: liveStream,
  },
  { id: 'playlist', size: WINDOW, destinations: asset('playlist'), prepare: playlistView },
  { id: 'queue', size: WINDOW, destinations: asset('queue'), prepare: queueView },
  {
    id: 'visualizer', size: WINDOW, destinations: asset('visualizer'),
    settings: () => ({ nowPlayingView: 'visualizer' }),
    prepare: visualizerStill,
  },
  { id: 'themes', size: WINDOW, destinations: asset('settings-theme'), ...withStreams, prepare: themePicker },
  {
    // The same layout as `desktop`, in the light mode the docs tell people they
    // can pin or let the OS swap into.
    id: 'light', size: WINDOW, destinations: asset('theme-light'),
    settings: () => ({ themeMode: 'light', lightAccent: 'apple' }),
    prepare: basicLayout,
  },
  {
    id: 'equalizer', size: WINDOW, destinations: asset('equalizer'),
    settings: () => ({ equalizer: { enabled: true, preamp: 0, gains: [6, 4, 2, 0, -2, -2, 0, 3, 5, 6] } }),
    prepare: equalizer,
  },
  {
    // The wide Files panel with column headers, a sort, and fields the automatic
    // set leaves out. Songs (a flat list spanning every album) is the view where
    // Year and Genre actually vary row to row.
    id: 'columns', size: WINDOW, destinations: asset('columns'),
    settings: () => ({
      navLocation: [{ t: 'view', view: 'songs' }],
      splitterWidth: '600px',
      columnPrefs: {
        library: ['title', 'artist', 'album', 'year', 'duration'],
        libraryHeaders: true,
        librarySort: { id: 'artist', dir: 1 },
      },
    }),
    prepare: wideColumns,
  },
  { id: 'editor', size: WINDOW, destinations: asset('metadata-editor'), prepare: metadataEditor },
];
