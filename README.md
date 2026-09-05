# Pudding

![Pudding screenshot](images/screenshot.png)

![Mini player screenshot](images/mini.png)

## What is Pudding?

Abandon your streaming service. Buy music. Pay artists. Donate to listener-supported radio.

If that's your vibe, maybe you'd like this media player.

It plays local files and internet radio. It's not a streaming service. It's free.

In the spirit of Winamp but with modern nicities.

## What makes Pudding different?

These features are bog standard for streaming service apps, but rare for file-based media players:

* No import step. You pick your library folders and they are automatically watched: no need for import or rescan.
* Relational navigation eg "Go to album"
* Search-based navigation: ⌘F, type album name, hit enter.
* First class queue. Right click anything to build one.
* Playlists are autosaved files, not something you import/export.
* Full macOS integration. Light / dark mode, media keys, lock screen with album art, control center.
* Art forward presentation. We love album covers.

## Features

### Local playback

- Custom Rust audio engine (symphonia + cpal) with gapless playback: tracks are joined sample-to-sample in a single continuous output stream
- Plays MP3, FLAC, WAV, AAC/M4A, Ogg/Opus, and AIFF
- High-quality sinc resampling to match your output device
- Shuffle and repeat (off / all / one), applied live without interrupting the current track
- Autoadvance toggle in the Playback menu — turn it off and playback stops at the end of each track instead of rolling on
- ReplayGain volume normalization (off / track / album) that honors standard gain tags, with peak-based clip prevention — untagged files play unchanged

### Library

- Point it at one or more folders: no import step, your files browsed as they are
- Four views for the same library, switched from the Files pane: Browse the real folder tree, or view it flat as Songs, Artists, or Albums — the last three drill iPod-style (artist → album → tracks) and remember your place across restarts
- Fast SQLite metadata cache, scanned in the background
- Built to scale: tested up to 500,000 tracks. Every long list  is windowed so only the on-screen rows exist in the DOM, opened views are cached, and the whole-library sort is served from a covering index
- Live library watching: add or edit files on disk and the app updates itself
- Search across title, artist, album, and filename, or match a folder and play it as an album
- Cmd/Shift-click to select multiple tracks; every menu verb (play, queue, add to playlist) acts on the whole selection
- Right-click a track to jump to its artist or album, or reveal it with Show in Finder
- Embedded album art, and disc/track-number-aware sorting
- Edit an audio file's metadata tags right in the app.
- Registered for audio file types: double-click a file in Finder and it plays here (single instance)

### Playback queue

- Right-click tracks to Create queue, then Play next (insert after the playhead) or Add to queue (append); reorder by dragging, remove with Delete

### Playlists

- Playlists are plain `.m3u8` files on disk. No lock-in, hand-editable and readable by any other player, and they autosave on every change
- Start one from the Playlist menu, or turn the current queue into a saved playlist with Save Queue as Playlist (⌘S)
- Right-click any track and use "Add to playlist" to file it into an existing list or a new one
- Single-click a playlist in the tree to browse it, double-click to play; rename, move, or delete it from the tree or the Playlist menu
- Recent playlists live under Playlist ▸ Open Recent, and every `.m3u` / `.m3u8` under your library is searchable

### Internet radio

- Icecast / SHOUTcast streams with in-band ICY now-playing metadata
- Manage your stations right in the Streams tab: add, edit, reorder, and delete, with optional per-station art. Saved to a plain `.m3u8` you can also hand-edit or share
- Starts with a writable list on first run; point it at any existing `.m3u` / `.m3u8`, or a remote `http(s)` URL (read-only)
- Automatic reconnect with backoff; pausing disconnects, resuming rejoins the live edge
- `.pls` / `.m3u` playlist URLs resolve automatically

### Equalizer & visualizer

- 10-band graphic equalizer (32 Hz – 16 kHz) running in the audio engine as a cascade of RBJ peaking biquads plus a preamp
- The equalizer bars glow with the real per-band energy of what's playing, which is just dang nifty
- Visualizer: an oldschool neon oscilloscope over a starfield, toggled from the topbar or with ⌘T

### Interface

- Light and dark themes, each with a variety of flavors, and can auto-switch with the macOS light / dark setting
- Compact mini player mode (double click now playing)
- Zen Mode (View ▸ Zen Mode / ⌃⌘F) expands the Now Playing view (album art or visualizer) to fill the window and hide all chrome. Try it with fullscreen!
- Window size and position remembered separately for mini and normal modes
- Keyboard shortcuts for playback, volume, and seeking (see below)
- macOS system integration: Now Playing in Control Center and the lock screen (with album art), plus hardware media keys and lock-screen controls for play/pause, next/previous, and scrubbing

## Install

No prebuilt release yet. Requires [Rust](https://www.rust-lang.org/tools/install), [Node](https://nodejs.org/), and [pnpm](https://pnpm.io/).

```sh
pnpm install
pnpm tauri build
```

On macOS the dmg auto-opens. Drag Pudding into Applications and you're good to go.

## Keyboard shortcuts

- `Space` - play / pause
- `↑` / `↓` - move the selection up / down the list
- `Enter` - play the selected row
- `Delete` / `Backspace` - remove the selected row(s) from the queue or playlist
- `Esc` - clear the selection
- `⌘↑` / `⌘↓` (or `+` / `-`) - volume up / down (10%)
- `M` - mute / unmute
- `←` / `→` - seek back / forward 10s (files only)
- `⌘F` / `Ctrl+F` - focus search
- `⌘S` - save the current queue as a playlist
- `⌘T` - toggle the visualizer
- `⌃⌘F` - toggle Zen Mode

## Tips

A few things that aren't obvious:

- **Click the title in Now Playing** to jump to wherever the current track is playing from. Album and artist are also clickable.
- **Click the Files tab while it's already showing** to pop back to the top of the navigation hierarchy.
- **Double-click the album art** to switch to and from the mini player.

## Tech stack

- [Tauri](https://tauri.app/) 2 - desktop shell
- Rust backend with [rusqlite](https://github.com/rusqlite/rusqlite) for the metadata cache, [lofty](https://github.com/Serial-ATA/lofty-rs) for reading and writing tags, and [notify](https://github.com/notify-rs/notify) for live library watching
- TypeScript frontend built with [Vite](https://vitejs.dev/) - no UI framework, reactivity via [Preact signals](https://github.com/preactjs/signals)
- Native Rust audio engine ([symphonia](https://github.com/pdeljanov/Symphonia) + [cpal](https://github.com/RustAudio/cpal)) for gapless file playback and internet radio with in-band ICY now-playing metadata

## Some streams I like

This project is not affiliated with these, but I listened to them a lot while working on it.

- **[SomaFM](https://somafm.com/listen/)** ambient, downtempo, etc.
- **[Nightride FM](https://nightride.fm)** synthwave, etc.

Both run on listener support, so consider throwing them a few bucks.