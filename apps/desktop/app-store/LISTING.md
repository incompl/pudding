# App Store listing copy

Draft. Copy each field below into App Store Connect. Every field is one
paragraph per line, so a paste keeps its line breaks. Apple's limit is in each
heading; re-count with `wc -m` after editing, since the subtitle and keywords
are close to theirs.

The description exists to answer Guideline 4.3 on the product page itself: a
reviewer who never opens the README has to be able to tell from the first
paragraph and the bullet list below it what Pudding does that the other
file-based players and the streaming clients don't. Keep that ordering — the
differentiators come before the feature inventory, not after it.

---

## App name (30 max)

Pudding

## Subtitle (30 max)

Music player for files & radio

## Promotional text (170 max)

A music player with the practicality of an oldschool player and the modern style and features of a streaming app.

## Keywords (100 max, comma separated, no spaces)

mp3,flac,alac,m3u,id3,tag,editor,radio,icecast,shoutcast,gapless,equalizer,replaygain,library

## Copyright

2026 Greg Smith

## Description (4000 max)

Own your music.
Play it in Pudding.

It is a player for the audio files already on your Mac — MP3, FLAC, ALAC, AAC, Ogg Vorbis, Opus, WAV, AIFF — and for the internet radio stations you add yourself. There is no catalog, no account, no subscription, and nothing to sign in to. Point it at your folders and it plays what is there.

WHAT MAKES PUDDING DIFFERENT

Most file players hand you a database to maintain. Most modern players hand you a service to join. Pudding takes the conveniences people expect from a streaming app and gives them to the files you own:

• No import step. Choose your library folders once. Pudding watches them and picks up what you change on disk, with no manual rescan.
• Search-first navigation. Press Command-F, type an album name, press Return, and you are in it.
• Relational navigation. Right-click any track to jump to its artist or its album.
• A first-class queue. Right-click anything to start one, then Play Next or Add to Queue, and drag rows to reorder.
• Playlists are files, not rows in someone's database. Each one is an ordinary .m3u8 on your disk that autosaves as you edit it and opens in any other player.
• Tag editing in the app. Fix one file or a whole selection at once, artwork included, then review the update and revert it from the same screen.
• Six views of one library. Browse the real folder tree, or the same files as Songs, Artists, Albums, Genres, or Decades.
• Album art is central in the presentation.

PLAYBACK

• Gapless playback from a custom audio engine: consecutive tracks are joined sample to sample in one continuous output stream
• High-quality resampling, or Match Source Sample Rate to send a 44.1 kHz file to your output device at 44.1 kHz
• A 10-band equalizer whose bars glow with the real energy in each band
• ReplayGain volume normalization by track or album, with peak-based clip prevention; untagged files play unchanged
• Shuffle, repeat off/all/one, and an autoadvance toggle for listening one track at a time

LIBRARY

• A fast local metadata cache, scanned in the background and tested up to 500,000 tracks
• Use the default columns or choose your own, with sortable headers
• Multiple selection, where every menu action — play, queue, add to playlist, edit tags — applies to everything selected
• Cloud-friendly: a library in iCloud Drive, Proton Drive, or Dropbox scans without downloading anything, and files whose bytes are not on this Mac are marked "(Not downloaded)" until you play them
• Drag music in from Finder, or open audio files you double-click there

INTERNET RADIO

• Icecast and SHOUTcast streams with in-band ICY now-playing metadata
• Your own station list, edited in the app with optional per-station art and saved as a plain .m3u8 you can share or hand-edit
• Automatic reconnect; pausing disconnects, resuming rejoins the live edge

MAC INTEGRATION

• Now Playing in Control Center and on the lock screen, with album art
• Hardware media keys and lock-screen transport controls
• Light and dark themes, each with several flavors, following the system setting
• A compact mini player, and Zen Mode for album art or the visualizer filling the window with no chrome
• Retro visualizer for when you just want to vibe out for a bit

PRIVACY

Pudding collects nothing. No account, no telemetry, no crash reporting, no advertising. Your library index, playlists, settings, and station list stay on your Mac. Pudding reads only the folders and files you pick in a system picker, and the only network traffic is the radio streams, station lists, and artwork you point it at yourself.

---

## Posters

`apps/desktop/app-store/posters/`, uploaded in filename order. Every one is
2560 × 1600 with no alpha, composed by `e2e/screenshots/poster.mjs` from real
captures — regenerate with `pnpm screenshots:update`, never by hand.

The set is the description's argument in pictures, so each poster is here to
carry one claim from it. A reviewer reading Guideline 4.3 off the product page
sees the differentiator in the caption and the proof in the window below it,
without opening the README or the app.

| # | Poster | Caption | The claim it carries |
|---|---|---|---|
| 01 | `01-library.png` | Simple Yet Powerful. | The app as it opens, and "six views of one library" — Browse, Songs, Artists, Albums, Genres, Decades are the Files index itself, with the playlists under them. Also the album-art presentation. |
| 02 | `02-sizes.png` | Big or small. Make it yours. | Three real windows from three launches: the mini player, Zen Mode with the visualizer, and the dense sortable Songs table with chosen columns. Answers the question 01 provokes — the simple view is not all of it. |
| 03 | `03-tags.png` | Bulk edit file metadata. | "Tag editing in the app", artwork included. The one thing the streaming clients cannot do to files you own. |
| 04 | `04-playlists.png` | Playlists are files. | "Playlists are files, not rows in someone's database", and the queue — the pane in the shot is both. Named in the Playlists section and again over the table, with track count and running time. |
| 05 | `05-themes.png` | Light or dark mode. | Light and dark, each with flavors. One window shape wearing four appearances, so the split down the middle reads as a setting rather than four screens. |
| 06 | `06-search.png` | Fast search. No manual rescan. | "No import step" and "search-first navigation" at once: one query answered by an album, its folder, a station and the tracks, which is also the only place the set shows radio. |
| 07 | `07-equalizer.png` | 10 Band EQ. | The audio path — the only claim here about how it sounds rather than what it holds. Eleven sliders at the window's full height, so the curve still reads at search-result size. |

Claims no poster carries, on purpose:

- **Internet radio.** The Streams tab is the same window as 01 with a station
  list in the left pane, so a poster of it would repeat 01 and spend a slot to
  do it. Radio stays in the subtitle, the promotional text and its own
  description section, and the station hit in 06 is the picture of it.
- **Gapless playback, ReplayGain, resampling, the metadata cache.** Nothing to
  photograph: a still frame of continuous audio is a still frame. These are
  description copy and review-notes material.
- **Relational navigation, drag from Finder, Now Playing in Control Center.**
  Each needs a context menu, a drag, or a surface outside the app — a poster of
  a menu reads as a menu, not as the feature.
