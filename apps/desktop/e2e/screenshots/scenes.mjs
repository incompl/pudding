// One capture can serve multiple consumers. Add new documentation scenes here.
// Each recipe runs in a fresh app/profile and must prepare its own complete state.
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STORE_WINDOW } from './poster.mjs';

// Exercise the app's normal session restoration: it restores paused at an exact
// playhead without racing audio callbacks (seeking a live track resumes playback).
// A scene layers its own `settings` over this rather than restating it.
export function initialSettings(library, manifest) {
  return {
    libraryRoots: [library],
    themeMode: 'dark', darkAccent: 'pistachio', volume: 0,
    followSampleRate: false, autoadvance: false,
    shuffleMode: false, repeatMode: 'off', replayGainMode: 'off',
    nowPlayingView: 'art',
    equalizer: { enabled: false, preamp: 0, gains: Array(10).fill(0) },
    windowSizeNormal: { width: 960, height: 640 },
    windowSizeMini: { width: 367, height: 168 }, windowPosition: { x: 120, y: 120 },
    playbackSession: restoredAlbum(library, manifest, defaultAlbum(manifest)),
  };
}

// The album every scene but the homepage hero arrives on.
const defaultAlbum = (manifest) => manifest.tracks[0].album;

// The album the homepage screenshot arrives on instead. It exists so that image
// can carry its own cover: the fixture library gives this one album a different
// photograph (gen-screenshot-library.mjs), and nothing else in the suite shows
// it — the artist, search, queue and editor scenes each feature another album.
const HERO_ALBUM = 'A Little Nugget of Universe';

// One album's tracks as the paused session a scene arrives on. A scene that
// needs a different album layers this over `initialSettings` through `settings`.
export function restoredAlbum(library, manifest, album) {
  const tracks = manifest.tracks.filter((track) => track.album === album)
    .map((track) => ({ ...track, path: path.join(library, track.file) }));
  if (!tracks.length) throw new Error(`The fixture library holds no album named ${album}`);
  return {
    queue: { kind: 'album', title: album, subtitle: `${tracks.length} tracks`, tracks },
    index: 0, path: tracks[0].path, time: 42, duration: tracks[0].duration,
  };
}

// Every documentation scene is the same 960 × 640 window, so the images sit
// together on a page without one of them reading as a different app. Two scenes
// stand outside that set and size themselves: the mini player, whose window
// genuinely is that small, and the homepage hero (see HERO_WINDOW).
const WINDOW = { width: 960, height: 640 };

// The homepage hero is narrower because it is the one image that never sits
// beside the documentation set — index.astro is the only page that shows it, and
// the README shows it alone — and because it stands in a column next to the hero
// copy, where a 3:2 window reads as mostly empty. Now Playing's art is pinned to
// the window's HEIGHT (`max-width: min(100%, 60vh)` in styles.css), so it stays
// the same 384px square here and only the black gutter beside it goes. Keep this
// between 720 and 960: below ~720 the art itself starts shrinking, and below
// 601 the app switches to its compact layout.
const HERO_WINDOW = { width: 800, height: 640 };
const asset = (name) => [`apps/website/src/assets/${name}.png`];

// --- Fictional stream list ---------------------------------------------------
// The streams list draws a radio glyph per row, so these are names only.
// "Night Light Radio" exists to give the search scene a stream hit for its query.
const STATIONS = [
  'Night Light Radio',
  'Endless Amelodic Noise',
  'Deep Field FM',
  'The Vibe Zone',
  'Real Birds 24/7',
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
// Its artwork is also what the scene asserts the hero is showing: naturalWidth
// is the only thing that tells the station's own art apart from the album cover
// left over from the paused track, so this photograph is tracked at a size the
// fixture library's 1024-square covers do not share. Keep the two sizes
// different if either image is ever replaced.
const LOGO_SIZE = 900;
const LOGO_FILE = 'sample album art 3.jpg';
export const LIVE_STATION = {
  name: 'Endless Amelodic Noise',
  title: 'No One Lives Here - Five Pitched Down Laundry Machines',
  song: 'No One Lives Here',
  logo: readFileSync(fileURLToPath(new URL(`../../images/${LOGO_FILE}`, import.meta.url))),
  logoFile: LOGO_FILE,
};

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

async function nowPlaying(d, library, manifest, { clearQueue = false, album } = {}) {
  const track = manifest.tracks.find((item) => item.album === (album ?? defaultAlbum(manifest)));
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

// Parameterised by the album it arrives on, because its two scenes differ in
// nothing else: the homepage hero takes HERO_ALBUM so its Now Playing art is not
// the cover every documentation image already shows, and the light-theme image
// takes the album the rest of the suite uses.
const basicLayout = (album) => async function basicLayout(d, library, manifest) {
  await nowPlaying(d, library, manifest, { clearQueue: true, album });
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
};

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

// Zen Mode (⌘⇧F) on a square window, where the visualizer is the whole picture:
// the hero covers the window — topbar, Files panel and splitter included — so the
// app stops being a two-pane browser and becomes the canvas. This is the one
// recipe that enters Zen, and it resizes before entering rather than leaving it
// to the runner, because the canvas sizes itself to whatever box it lands in:
// captureStill picks the pane's size up on the way in, and a resize afterwards
// would clear the frame it just composed.
const zenVisualizer = (size) => async function zenVisualizer(d, library, manifest) {
  await nowPlaying(d, library, manifest, { clearQueue: true });
  await d.action('setWindowSize', size);
  await d.waitFor(async () => {
    const view = await d.settle();
    return view.width === size.width && view.height === size.height;
  }, { message: `The Zen window never reached ${size.width}×${size.height}` });
  await d.action('zenMode');
  await d.waitFor(() => d.exists('body.np-zen'),
    { message: 'Zen Mode did not take over the window' });
  // The transport's idle auto-hide is pinned by the action above (zenIdlePinned
  // in main.ts). Assert it rather than trust it: these captures are taken with
  // the pointer outside the window, and nothing but a real mouse move brings the
  // controls back — a Zen image without them is a picture of a record sleeve.
  await d.waitFor(async () => !(await d.exists('body.np-idle')),
    { message: 'Zen Mode faded its transport out before the shutter' });
  await d.waitFor(async () =>
    Number(await d.prop('#now-playing-visualizer', 'clientWidth')) === size.width &&
    Number(await d.prop('#now-playing-visualizer', 'clientHeight')) === size.height,
    { message: 'The visualizer did not go full-bleed at the Zen window size' });
  // A new track flashes its title over the scene and fades it back out. Let
  // that finish rather than capturing a banner mid-life.
  await d.waitFor(async () => !(await d.exists('.viz-track-banner.show')),
    { timeout: 10_000, message: 'The track banner never finished its hold' });
  await d.action('visualizerStill');
};

// One face of the themes poster: the ordinary paused now-playing window, wearing
// one appearance. Everything a capture could differ by other than colour is held
// still on purpose — same album, same playhead, same window — so four of these
// side by side make one claim and only one.
//
// It resizes itself rather than leaving that to the runner because the
// assertions below are about the layout the size produces: under 601 × 361 the
// Files panel and topbar go and the hero becomes the card this poster shows.
const themeFace = (face, size) => async function themeFace(d, library, manifest) {
  await nowPlaying(d, library, manifest);
  await d.action('setWindowSize', size);
  await d.waitFor(async () => {
    const view = await d.settle();
    return view.width === size.width && view.height === size.height;
  }, { message: `The ${face.id} window never reached ${size.width}×${size.height}` });
  // The appearance arrives through stored settings, so what is asserted is what
  // actually reached <html>: applyTheme (theme.ts) writes the mode to data-mode
  // and the accent pair to inline custom properties, which is the single place
  // every `var(--accent)` rule in the app reads its colour from.
  const mode = await d.attr('html', 'data-mode');
  if (mode !== face.mode) throw new Error(`${face.id} came up in ${mode} mode, not ${face.mode}`);
  const painted = String(await d.attr('html', 'style') ?? '');
  if (!painted.includes(face.accent)) {
    throw new Error(`${face.id} is painted "${painted}" rather than ${face.accent}. ` +
      `If ${face.theme} was recoloured in theme.ts, update THEME_FACES to match: ` +
      'four distinguishable colours is the whole of what this poster claims.');
  }
  // Below the breakpoint the hero is a card: art stretched to the row's height,
  // title beside it. Both ways a hand-picked window size can break that are
  // measurable, so neither is left to the eye — the art can overflow a window too
  // narrow to hold it beside the text, and a title too long for what is left
  // starts a marquee, which freezes mid-travel with the text half gone.
  await d.waitFor(async () => Number(await d.prop('#left', 'offsetWidth')) === 0,
    { message: 'The Files panel is still laid out: this window is above the compact breakpoint' });
  await d.waitFor(async () => Number(await d.prop('#now-playing-art', 'clientWidth')) > 0,
    { message: 'The theme card rendered no artwork' });
  const overflow = Number(await d.prop('#now-playing-main', 'scrollWidth')) -
    Number(await d.prop('#now-playing-main', 'clientWidth'));
  if (overflow > 1) {
    throw new Error(`The theme card overflows its ${size.width}px window by ${overflow}px. Widen the window or shorten it.`);
  }
  if (await d.exists('#now-playing-title.marquee')) {
    throw new Error(`The title does not fit beside the art at ${size.width}×${size.height} and has started to scroll.`);
  }
};

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

// The curve both equalizer scenes are seeded with. `initialSettings` leaves the
// equalizer off, so a scene that runs the recipe below without these settings
// fails on its own assertion rather than publishing a flat, switched-off panel —
// which is what makes this a named factory and not a literal in one scene.
const eqCurve = () => ({ equalizer: { enabled: true, preamp: 0, gains: [6, 4, 2, 0, -2, -2, 0, 3, 5, 6] } });

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
//
// Save is also disabled until the form has been edited, because an untouched save
// would rewrite every selected file to no effect (see buildInlineEditor's `armed`).
// So the capture touches the field the form has already focused, by typing a
// character and taking it back — the gesture a user makes when they change their
// mind, and the one thing that arms Save without altering a single pixel of what
// this image documents. The value it ends on is the value it started with, read
// back rather than restated so the fixture's own title stays the only copy.
async function metadataEditor(d, library, manifest) {
  await nowPlaying(d, library, manifest, { clearQueue: true });
  const [track] = albumPaths(library, manifest, 'Borrowed Light');
  await d.action('editMetadata', { path: track });
  await d.waitFor(async () => (await d.text('#pane-editor-view')).includes('Editing'),
    { message: 'The metadata editor did not open' });
  await d.waitFor(async () => await d.exists('#now-playing-panel.show-editor'),
    { message: 'The editor face did not take the pane' });
  const { fields } = await d.action('editorFields');
  const title = fields.Title.value;
  await d.action('editorType', { label: 'Title', value: `${title} ` });
  await d.action('editorType', { label: 'Title', value: title });
  await d.waitFor(async () => (await d.action('editorFields')).submitDisabled === false,
    { message: 'Save stayed disabled, so the capture would document a dead button' });
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

// What `wideColumns` is seeded with, at whatever divider the window it is being
// captured in can spare: the Songs view, the header up, and the five fields the
// recipe asserts on. Two scenes ship this layout at two window widths — the
// documentation image and the tall left-hand window of the size poster — and
// they have to seed the same column set, because the recipe's assertions name
// it. The width is the only part a window gets to choose, and it
// has to clear the pane's 28rem column gate; fall short and `wideColumns` fails
// the run rather than publishing an ordinary folded list.
const songsTable = (splitterWidth) => () => ({
  navLocation: [{ t: 'view', view: 'songs' }],
  splitterWidth,
  columnPrefs: {
    library: ['title', 'artist', 'album', 'year', 'duration'],
    libraryHeaders: true,
    librarySort: { id: 'artist', dir: 1 },
  },
});

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

// --- Mac App Store posters ---------------------------------------------------
// These are the only scenes whose published image is not a capture itself: the
// captures are laid into a captioned 2560 × 1600 poster (poster.mjs), because an
// App Store screenshot has to be an accepted 16:10 size and has to say what the
// app is — Apple reads the screenshots, not the README, for 4.3 differentiation.
//
// A store scene declares its windows as `panels` rather than a recipe of its
// own, because a window is a whole app launch: the runner captures each panel
// the way it captures any scene, and the poster claims them afterwards. Most
// posters have one panel and reuse a documentation recipe at the poster's own
// window size, so no scene is captured twice for one image and the app's pixels
// are never scaled.
const storeScene = (file, headline, scene) => ({
  id: `store-${file.replace(/^\d+-/, '')}`,
  destinations: [`apps/desktop/app-store/posters/${file}.png`],
  poster: { headline },
  panels: [{ ...scene, id: 'app', size: scene.size ?? STORE_WINDOW }],
});

// The three windows of the size poster. Each is a real configuration of the app,
// not a scaled copy of one window, and the sizes are chosen against the app's
// own breakpoint (MINI_MAX_WIDTH 600 × MINI_MAX_HEIGHT 360 in main.ts):
// `library` clears it and keeps both panes, and the other two sit under it,
// where the topbar and Files panel go and the hero becomes a bar. Change one and
// check its placement in the poster layout below — the two are fitted to each
// other, and together they tile the frame with no empty row.
//
// `library` is a portrait window running the poster's whole height, which is the
// shape that makes the table say what it is: 800 × 602 fits about twenty rows,
// where the landscape window it replaced fit eight. Its divider (SIZE_SPLITTER)
// is the one number the shape costs — the Files panel still has to clear the
// 28rem column gate, so what is left for Now Playing beside it is narrower than
// any other scene gives it. The two small windows share one width because they
// stack in one column beside it; their two heights plus the 32px gutter are the
// tall window's height exactly.
const SIZE_WINDOWS = {
  library: { width: 800, height: 602 },
  visualizer: { width: 320, height: 402 },
  mini: { width: 320, height: 168 },
};

// The divider inside the tall window, and the one number this shape is actually
// tight on: both sides of it want the width. 480px clears the pane's 28rem
// (448px) column gate with the table's insets to spare, and leaves Now Playing
// 315px — the narrowest the two-pane layout is shown anywhere in the suite, and
// measured, not guessed: at 263px the seek bar is the part that goes. It has
// `flex: 1; min-width: 0`, so a transport with no room for it keeps both time
// labels and quietly draws a playhead of zero width. Lower this and the table
// folds (which `wideColumns` fails on); raise it and the hero loses its seek bar
// (which nothing fails on — look at the poster).
const SIZE_SPLITTER = '480px';

// The four windows of the themes poster are one window size, because that poster
// varies nothing but colour. It sits under the same breakpoint as the small
// windows above — the compact card: cover art, the three metadata lines, and a
// transport whose seek fill is the accent doing its most visible work. Four of
// them tile the frame at 1:1 with a 32px gap on both axes, which is what decides
// these numbers: a two-pane window (over 600 × 360) would need 722px of height
// for two rows, and the caption leaves 650.
const THEME_WINDOW = { width: 560, height: 292 };

// The four appearances, laid out one mode per column (the layout below stacks
// the two dark faces on the left and the two light ones on the right), so the
// poster reads as the mode switch it is: same window, same album, one side black
// and one side white. Two per mode is the point within a column: a theme in this
// app is an accent pair layered on the mode's neutrals, so each ground gets to
// show two different accent choices standing on it.
//
// The hex is the assertion, not decoration: it is the value theme.ts gives each
// accent, and a face whose window comes up painted anything else fails the run
// rather than publishing two colours that look alike.
const THEME_FACES = [
  { id: 'dark-pistachio', mode: 'dark', theme: 'pistachio', accent: '#b5d17a' },
  { id: 'dark-blackberry', mode: 'dark', theme: 'blackberry', accent: '#db6bf4' },
  { id: 'light-fruitpunch', mode: 'light', theme: 'fruitpunch', accent: '#f61d52' },
  { id: 'light-raspberry', mode: 'light', theme: 'raspberry', accent: '#0a3dff' },
];

export const scenes = [
  {
    // The homepage and README image. It is the one scene that arrives on
    // HERO_ALBUM, so the cover in its hero is that album's own photograph rather
    // than the one every documentation image carries.
    id: 'desktop', size: HERO_WINDOW,
    destinations: ['apps/desktop/images/screenshot.png', 'apps/website/src/assets/desktop.png'],
    settings: (library, manifest) => ({ playbackSession: restoredAlbum(library, manifest, HERO_ALBUM) }),
    prepare: basicLayout(HERO_ALBUM),
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
    // The same layout as `desktop` — on the album every other documentation
    // image shows — in the light mode the docs tell people they can pin or let
    // the OS swap into.
    id: 'light', size: WINDOW, destinations: asset('theme-light'),
    settings: () => ({ themeMode: 'light', lightAccent: 'raspberry' }),
    prepare: basicLayout(),
  },
  {
    id: 'equalizer', size: WINDOW, destinations: asset('equalizer'),
    settings: eqCurve, prepare: equalizer,
  },
  {
    // The wide Files panel with column headers, a sort, and fields the automatic
    // set leaves out. Songs (a flat list spanning every album) is the view where
    // Year and Genre actually vary row to row.
    id: 'columns', size: WINDOW, destinations: asset('columns'),
    settings: songsTable('600px'),
    prepare: wideColumns,
  },
  { id: 'editor', size: WINDOW, destinations: asset('metadata-editor'), prepare: metadataEditor },

  // The poster set, in the order the store shows it. The first two are a pair,
  // and the order is the argument: 01 is the whole app at rest, so a reader's
  // first glance answers "what is this", and 02 answers the question that
  // provokes — no, the simple view is not all of it. The five after them are one
  // feature apiece.

  // The app as it opens: the Files panel on its index (the six library views,
  // then the playlists) beside Now Playing, with no queue, no drill, and every
  // optional playback feature off. It runs the same recipe as the homepage hero
  // and the light-theme image, on the album the rest of the poster set arrives
  // on — so the first thing a reader sees here is the first thing they will see
  // in the app rather than a configuration of it. The dense Songs table this
  // used to lead with has not left the set: it is the tall window of 02.
  storeScene('01-library', 'Simple Yet Powerful.', {
    prepare: basicLayout(),
  }),

  // A poster made of several windows, and the one that has to follow 01: that
  // poster shows the app at rest and this one shows how far it moves. A single
  // mini-player capture left most of a 2560 × 1600 frame empty, and the thing
  // that filled it is also the better claim: three real windows, each captured
  // from its own launch, showing that the app has a shape for the space you give
  // it rather than one layout it shrinks. The positions are CSS px in the
  // poster's own 1280 × 800 frame, painted in the order listed, and they are
  // fitted to SIZE_WINDOWS above — the caption's clearance over the top row is
  // measured at compose time.
  //
  // Two columns inside the 64px margins the other posters keep, with a 32px
  // gutter: the stacked pair at the left in x 64, smallest window first, and the
  // tall one beside them at x 416 running the full height (158…760). The pair's
  // own gutter lands the visualizer's bottom edge on the tall window's, so the
  // three windows close on one baseline. Every window is whole, nothing overlaps,
  // and no part of the frame is left empty for a fourth that does not exist.
  {
    id: 'store-sizes',
    destinations: ['apps/desktop/app-store/posters/02-sizes.png'],
    poster: {
      headline: 'Big or small. Make it yours.',
      layout: [
        { panel: 'mini', x: 64, y: 158 },
        { panel: 'visualizer', x: 64, y: 358 },
        { panel: 'library', x: 416, y: 158 },
      ],
    },
    panels: [
      // The whole app in a tall window: both panes, and the Files panel on the
      // dense Songs table — the same recipe and seeded columns as the `columns`
      // documentation image, at a divider fitted to this window (SIZE_SPLITTER).
      // The table is what carries the claim here, and not only the one about
      // size: this is where a reader who has just seen 01 finds out that the
      // same pane does headers, sorting and twenty rows at once.
      {
        id: 'library', size: SIZE_WINDOWS.library,
        settings: songsTable(SIZE_SPLITTER), prepare: wideColumns,
      },
      // Zen, where the visualizer is the entire picture — the one place in the
      // whole suite that enters Zen Mode. The visualizer is also the only face
      // with no layout of its own to break at an unusual aspect ratio: it is a
      // canvas pinned to the window's edges, so it takes whatever box the column
      // beside the tall window has left rather than dictating one.
      {
        id: 'visualizer', size: SIZE_WINDOWS.visualizer,
        settings: () => ({ nowPlayingView: 'visualizer' }),
        prepare: zenVisualizer(SIZE_WINDOWS.visualizer),
      },
      // The mini player — the app's own smallest mode, not just a small window.
      // It runs the documentation scene's recipe at this column's width instead
      // of its own 367px: the mode is a layout, not a fixed size, and the two
      // windows stacked here have to agree on one edge.
      { id: 'mini', size: SIZE_WINDOWS.mini, prepare: nowPlaying },
    ],
  },

  storeScene('03-tags', 'Bulk edit file metadata.', {
    prepare: metadataEditor,
  }),

  // Playlists, and the one pane in the app that is two features at once: the
  // right-hand list is the queue, and a playlist is that queue saved to a file.
  // So the poster shows it opened on a playlist — named in the Playlists section
  // of the Files panel and again over the table, with its track count and
  // running time — and the caption says what the file is. Nothing else in the
  // set puts a track table beside a sidebar: 01 has the Files index with Now
  // Playing, and the table of 02 is a library view with no playlist in it.
  //
  // It runs the `playlist` documentation recipe unchanged at the poster's window
  // size, which is the documentation set's size, so this is that image composed
  // rather than a second arrangement of it. That recipe clears the restored
  // queue first, which is what leaves the pane showing the playlist by name
  // rather than the album the session arrived on.
  storeScene('04-playlists', 'Playlists are files.', {
    prepare: playlistView,
  }),

  // The other multi-window poster, and the opposite of 02: there, three window
  // shapes of one appearance; here, one window shape wearing four appearances.
  // Every panel arrives on the same album, paused at the same 0:42, at the same
  // THEME_WINDOW size, so the four captures are identical raster except where a
  // colour decision shows — which is the only way a reader can tell that what
  // changed is a setting and not a different screen.
  //
  // The grid is two 560-wide columns at x 64 and 656 and two 292-tall rows at
  // y 150 and 474: a 32px gutter on both axes inside the 64px margins the other
  // posters keep, with every window whole and nothing overlapping. The left
  // column is the dark mode and the right column the light one, so the split
  // down the middle of the poster is the setting the caption names.
  {
    id: 'store-themes',
    destinations: ['apps/desktop/app-store/posters/05-themes.png'],
    poster: {
      headline: 'Light or dark mode.',
      layout: [
        { panel: 'dark-pistachio', x: 64, y: 150 },
        { panel: 'dark-blackberry', x: 64, y: 474 },
        { panel: 'light-fruitpunch', x: 656, y: 150 },
        { panel: 'light-raspberry', x: 656, y: 474 },
      ],
    },
    // One launch per appearance, because a window is a whole app launch and the
    // theme is read from the store before the first paint. Each face writes only
    // its own mode's accent key, because that is how the app stores one: the
    // accent is kept per mode (KEY_DARK_ACCENT / KEY_LIGHT_ACCENT in theme.ts)
    // and the mode preference picks which of the two is in force.
    panels: THEME_FACES.map((face) => ({
      id: face.id, size: THEME_WINDOW,
      settings: () => ({
        themeMode: face.mode,
        [face.mode === 'dark' ? 'darkAccent' : 'lightAccent']: face.theme,
      }),
      prepare: themeFace(face, THEME_WINDOW),
    })),
  },

  // Search, and the claim no other poster in the set makes: this app has no
  // import step, so finding something is the whole of managing a library. The
  // documentation recipe's query is what earns the poster — the fixture answers
  // "light" in four categories at once (an album, its folder, a station and the
  // tracks), so one dropdown shows that search spans all of them. The station
  // hit is why this needs the fixture stream list.
  storeScene('06-search', 'Fast search. No manual rescan.', {
    ...withStreams, prepare: searchResults,
  }),

  // The equalizer, and the only poster that says anything about the audio path.
  // Its bars glow to a live signal and every capture is paused, so the curve the
  // sliders hold is the whole picture — eleven of them at the window's full
  // height, which is also the only image here that still reads at the size the
  // store shows a search result.
  storeScene('07-equalizer', '10 Band EQ.', {
    settings: eqCurve, prepare: equalizer,
  }),
];
