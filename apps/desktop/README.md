# Pudding Desktop

Part of the [Pudding monorepo](../../README.md). Run the commands below from
`apps/desktop`, or use the compatible desktop shortcuts at the repository root.

**Music player for local files and internet radio. Oldschool taste, newschool features.**

![Pudding screenshot](images/screenshot.png)

![Mini player screenshot](images/mini.png)

## What is Pudding?

Abandon your streaming service. Buy music. Pay artists. Donate to listener-supported radio.

If that's your vibe, maybe you'd like this media player.

It plays local files and internet radio. It's not a streaming service. It's free.

In the spirit of Winamp but with modern nicities.

## What makes Pudding different?

These features are bog standard for streaming service apps, but rare for file-based media players:

* No import step. You pick your library folders and they are automatically watched. No need for manual rescan.
* Relational navigation eg "Go to album"
* Search-based navigation: type an album name and hit enter.
* First class queue. Right click anything to build one.
* Playlists are autosaved m3u8 files. No lock-in.
* Full macOS integration. Light / dark mode, media keys, lock screen with album art, control center.
* Art forward presentation. We love album covers.

## Features

### Local playback

- Custom Rust audio engine (symphonia + cpal) with gapless playback: tracks are joined sample-to-sample in a single continuous output stream
- Plays MP3, FLAC, WAV, AAC/M4A, Ogg/Opus, and AIFF
- High-quality sinc resampling to match your output device
- Optional sample-rate switching (Playback > Match Source Sample Rate): sets the output device to the file's own rate, so a 44.1 kHz track plays back at 44.1 kHz with no sample-rate conversion anywhere in the chain: a bit-perfect path to CoreAudio whenever volume is at 100% with the EQ and ReplayGain off.
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
- Columns: pick the fields a track list shows — title, artist, album, album artist, disc, genre, year, kind, time, bit rate, sample rate, bit depth, gain, date created/modified — or leave it automatic and the pane picks them per list. Turn on the header to sort by any column and drag the dividers to set your own widths; narrow panes fold back to one line
- Edit an audio file's metadata tags right in the app.
- Registered for audio file types: double-click a file in Finder and it plays here (single instance)
- Drag music from Finder onto the window: a file or playlist opens, a folder or a multi-file drop plays as a queue
- Cloud-friendly: point it at a library in iCloud Drive, Proton Drive, or Dropbox and it scans without downloading anything. Files whose bytes aren't on this Mac are marked "(Not downloaded)" and fetched only when you play them

### Playback queue

- Right-click tracks to Create queue, then Play next (insert after the playhead) or Add to queue (append); reorder by dragging, remove with Delete

### Playlists

- Playlists are plain `.m3u8` files on disk. No lock-in, hand-editable and readable by any other player, and they autosave on every change
- Start one from the File menu, or turn the current queue into a saved playlist with Save Queue as Playlist
- Right-click any track and use "Add to playlist" to file it into an existing list or a new one
- Single-click a playlist in the tree to browse it, double-click to play; rename, move, or delete it from the tree or the File menu
- File ▸ Open Recent lists what you have actually opened — playlists and loose tracks alike — and every `.m3u` / `.m3u8` under your library is searchable

### Internet radio

- Icecast / SHOUTcast streams with in-band ICY now-playing metadata
- Manage your stations right in the Streams tab: add, edit, reorder, and delete, with optional per-station art. Saved to a plain `.m3u8` you can also hand-edit or share
- Starts with a writable list on first run; point it at any existing `.m3u` / `.m3u8`, or a remote `http(s)` URL (read-only)
- Automatic reconnect with backoff; pausing disconnects, resuming rejoins the live edge
- `.pls` / `.m3u` playlist URLs resolve automatically

### Equalizer & visualizer

- 10-band graphic equalizer (32 Hz – 16 kHz) running in the audio engine as a cascade of RBJ peaking biquads plus a preamp
- The equalizer bars glow with the real per-band energy of what's playing, which is just dang nifty
- Visualizer: an oldschool neon oscilloscope over a starfield, toggled from View ▸ Visualizer

### Interface

- Light and dark themes, each with a variety of flavors, and can auto-switch with the macOS light / dark setting
- Compact mini player mode (double click now playing)
- Zen Mode (View ▸ Zen Mode) expands the Now Playing view (album art or visualizer) to fill the window and hide all chrome. Try it with fullscreen!
- Window size and position remembered separately for mini and normal modes
- [Keyboard shortcuts](../website/src/content/documentation.md#keyboard-shortcuts) for playback, volume, seeking, and navigation
- macOS system integration: Now Playing in Control Center and the lock screen (with album art), plus hardware media keys and lock-screen controls for play/pause, next/previous, and scrubbing

## Install

No prebuilt release yet. Requires [Rust](https://www.rust-lang.org/tools/install), [Node](https://nodejs.org/), and [pnpm](https://pnpm.io/).

```sh
pnpm install
pnpm tauri build
```

On macOS the dmg auto-opens. Drag Pudding into Applications and you're good to go.

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
- Help > Licenses lists every bundled dependency and its license text, generated from the real cargo and pnpm dependency graphs by `scripts/gen-licenses.mjs` (run by `pnpm dev` and `pnpm build`). It covers the statically linked Rust standard library and vendored artwork such as the Lucide icons too, and the build fails if any dependency would ship without attribution

## Screenshot library

Generate a deterministic library of fictional artists, albums, tracks, and
abstract cover art with no third-party tools:

```sh
pnpm gen:screenshot-library
```

The default output is `~/Pudding Screenshot Library`. Pass a different location
after `--`, for example `pnpm gen:screenshot-library -- --out /tmp/pudding-mock`.
The generated WAV files have realistic durations, a short preview tone, complete
metadata, and embedded cover art. The full library is about 120 MB.

## AI Disclaimer

This app was created using AI development tools. If you're not into that, no judgement, namaste.

Some more questions and answers on the topic:

**How much of it is AI-written?** Most of the code. I specified every feature, reviewed changes, debated architecture, agonized about margins, and tested the results. I'm an professional software engineer with multimedia experience and I don't ship things I don't understand. 

**Does the app itself use AI?** No. There's no model in Pudding, no AI features, and no telemetry. The only network traffic is the radio streams you add yourself.

**Is it safe to run?** Same answer as any small open source app: the source is all here, every bundled dependency and its license is listed under Help > Licenses, and you can build it yourself.

**Who's responsible when it breaks?** Me. It's my app and the bugs are mine. You can report issues on [GitHub](https://github.com/incompl/pudding/issues).

**Does this change the license?** No. It's Apache-2.0, same as it would be otherwise. Dependencies keep their own licenses and are attributed in Help > Licenses.

**Do you take AI-assisted contributions?** Sure, as long as you understand what you're sending and it works. That said, I am the auteur of this project and I am very strict about features and scope. If you want to add something new, opening an issue for discussion first is best.

## Some streams I like

This project is not affiliated with these, but I listened to them a lot while working on it.

- **[SomaFM](https://somafm.com/listen/)** ambient, downtempo, etc.
- **[Nightride FM](https://nightride.fm)** synthwave, etc.

Both run on listener support, so consider throwing them a few bucks.
