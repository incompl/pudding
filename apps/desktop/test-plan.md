# Pudding Desktop — manual test plan

Release smoke pass. Each line is one check, run once. `[ ]` boxes are for a
single pass; copy the file per release if you want a record.

Build under test: `pnpm desktop:build` (release), not `desktop:dev` — dev-profile
decode throughput and the unsandboxed profile both hide real bugs. Repeat §1 and
§15 on the sandboxed MAS build.

Fixtures: one real library (mixed formats, multi-disc album, untagged files,
ReplayGain-tagged files), one cloud-backed root (Proton/iCloud) with evicted
files, `pnpm gen:screenshot-library` for the big-library checks, one real
Icecast URL, one `.pls` URL.

`pnpm gen:format-library` writes one short tone per format to
`~/Pudding Format Fixtures` for the §2 format, sample-rate and corrupt-file
checks. Files are numbered in play order and rise in pitch, so the row playing
is visible and audible. macOS covers wav/aiff/flac/m4a/aac on its own; mp3,
ogg, opus and the MPEG-4 ADTS variant need `brew install ffmpeg`, and anything
missing is skipped and listed. They all come from one encoder chain, so they are a format checklist,
not a substitute for the real library above.

---

## 1. First run / cold start

- [x] Fresh profile → empty state shows **Choose Music Folder** and **Play Sample**
- [x] Play Sample plays the bundled track
- [x] Choose a folder → scan progress bar in Files footer, app stays usable during scan
- [x] Scan completes → tree populated, footer progress gone
- [x] Relaunch → roots still readable (bookmark restore), no re-pick prompt
- [x] Relaunch → open tab (Files/Streams) restored; a Files view drill reopens at same page

## 2. Playback engine

- [x] Play one of each: mp3, flac, wav, m4a/aac, alac, ogg, opus, aiff
- [x] Alias extensions play too: `.oga`, `.aif`, and raw ADTS `.aac` (check its duration and seek)
- [x] Both raw-ADTS markers play: `11 aac adts.aac` (MPEG-2, afconvert) and
      `15 aac adts mpeg4.aac` (MPEG-4, ffmpeg)
- [x] Gapless: a continuous album crosses a track boundary with no click or gap
      (AAC doesn't work, known bug)
- [x] Pause/resume mid-track, seek by scrub, seek by `←`/`→` (10s)
- [ ] Volume `⌘↑`/`⌘↓` and `+`/`-`; `M` mutes and unmutes; menu Mute check tracks
- [ ] Mute keeps the slider where it was and crosses out the glyph; unmute returns
      to that level; volume up unmutes, volume down stays muted
- [ ] Slider dragged slowly to zero: menu Mute is checked, and unchecking it comes
      back at the pre-drag level (not 1%)
- [ ] Quit muted → relaunch is audible (mute isn't persisted). Quit with the slider
      at zero → relaunch is silent, and unmuting returns to the pre-zero level, not 100%
- [ ] Shuffle on mid-track: current track keeps playing, next pick is random
- [ ] Repeat off / all / one each behave at end of context
- [ ] Autoadvance off → stops at end of track; Repeat One still repeats; manual skip still advances
- [ ] ReplayGain off/track/album: level changes on a tagged file, untagged file unchanged, no clipping on a hot file
- [ ] Match Source Sample Rate on: play 44.1k then 96k, device rate follows, rate restored on quit
- [ ] EQ (`⌥⌘E`): move a band → audible; preamp works; bars glow with band energy; EQ off is bypassed
- [ ] Switch output device while playing (unplug headphones) → playback continues or recovers, no crash
- [ ] Sleep/wake while playing → recovers
- [ ] A DRM/corrupt file errors with a message rather than silence or a hang
      (`13 corrupt truncated.flac` claims 4s and ends early; `14 corrupt garbage.mp3` never decodes)
- [ ] A file that cannot be decoded says so instead of leaving a dead row:
      a toast naming the file, and the queue moves on to the next track
      (`14 corrupt garbage.mp3` is the one that fails at open)

## 3. Library views

- [ ] Root menu lists Browse / Songs / Artists / Albums / Genres / Decades + playlists
- [ ] Browse drills the real folder tree; "Play folder" plays it as an album
- [ ] Songs: flat list, scroll deep into it (windowing — no blank rows, no jank)
- [ ] Artists → artist detail (albums + all tracks) → album → tracks; Back at each level
- [ ] Albums drills straight to tracks; multi-disc album sorts by disc then track
- [ ] Genres and Decades open onto tracks; decade label reads `1990s`
- [ ] Click the Files tab while showing → pops to root
- [ ] Live watching: add, edit and delete a file on disk with the app open → tree and views update with no manual rescan
- [ ] Rename a folder on disk → updates
- [ ] Big library (500k fixture): root menu, Songs, and column sort all stay responsive

## 4. Selection and row state

- [ ] `⌘`-click and `⇧`-click multi-select; `Esc` clears
- [ ] `↑`/`↓` move selection, `Enter` activates
- [ ] Every verb acts on the whole selection: play, queue, add to playlist, edit tags
- [ ] Playing track draws eq-bars glyph; the row the right pane is about draws accent text — independently
- [ ] Playing playlist row gets the glyph; open playlist row gets the accent

## 5. Columns

- [ ] Right-click list → toggle header on, sort by each column type (text, number, time, date)
- [ ] Add/remove each column; automatic mode picks per-list defaults
- [ ] Drag dividers to resize; undo widths from the context menu
- [ ] Narrow the pane until rows fold to one line, then widen back

## 6. Search

- [ ] `⌘F` focuses; results cover tracks, folders, artists, albums, playlists, streams
- [ ] Type an album name + `Enter` → plays it
- [ ] Arrow keys + `Enter` through results; right-click a result gets the same verbs
- [ ] Blur then refocus → query, caret and results restored
- [ ] Fast typing never shows a stale slower result

## 7. Queue

- [ ] No queue → context menu offers only **Create queue**
- [ ] With a queue → **Play next** inserts after playhead, **Add to queue** appends
- [ ] Counts in labels are right for a multi-select (`Play 5 next`)
- [ ] Drag to reorder; `Delete` removes selected rows
- [ ] `⌘Z` / `⌘⇧Z` undo and redo a reorder, an insert and a remove; playing track stays found across undo
- [ ] Queue ends → stops, no playhead; pressing play restarts from the top
- [ ] **Clear** tears the queue down (native Stop)
- [ ] `⌘S` saves the queue as a playlist

## 8. Playlists

- [ ] File ▸ New Playlist → empty saved `.m3u8` appears in the tree
- [ ] Drag tracks (and a multi-select) in from the left; file autosaves — verify bytes on disk
- [ ] Right-click anything (track, album, artist, playlist) ▸ Add to playlist ▸ existing / new
- [ ] Single-click opens for browsing; double-click plays
- [ ] Rename in tree → edits `#PLAYLIST` in the file; File ▸ Move Playlist File moves/renames the file
- [ ] Delete → goes to Trash, recoverable
- [ ] Reorder and remove rows inside an open playlist; undo works
- [ ] Hand-edit the `.m3u8` externally → app notices ("changed on disk")
- [ ] A one-station `.m3u8` opened → tunes in as radio; a station among tracks shows "(Stream)" with its own play button
- [ ] Playlist with a missing/moved path → clear error, no crash

## 9. Streams

- [ ] Default list seeded and writable on a fresh profile
- [ ] Add, edit, reorder, delete a station; per-station art shows
- [ ] Play an Icecast stream → ICY now-playing updates, Live Broadcast replaces the seek bar
- [ ] Pause disconnects, resume rejoins live edge
- [ ] Kill the network mid-stream → reconnect with backoff, then recovers
- [ ] A `.pls` and a `.m3u` stream URL resolve
- [ ] Point Settings at a remote `http(s)` list → loads read-only (no add/edit/delete)
- [ ] Point it at a local file → writable again
- [ ] Bad URL → error, list intact

## 10. Metadata editing

- [ ] Edit one file: every field + artwork; verify on disk with another tagger
- [ ] Bulk edit a selection: heading shows the count, disagreeing fields left untouched
- [ ] Progress and result screen name the fields and tracks changed
- [ ] **Revert update** restores only the fields that save wrote; a file a third party changed since is skipped
- [ ] Done dismisses the revert affordance; it does not come back
- [ ] File identity preserved: inode unchanged after a save (`stat`), Proton Drive shows a new version
- [ ] Cancel a long bulk write mid-run → consistent state
- [ ] Kill the app mid-write → next launch recovers or keeps the recovery copy and says so
- [ ] Read-only file / no permission → error, original untouched

## 11. Now Playing and interface

- [ ] Album art, title/artist/album; clicking each navigates to its context
- [ ] Nav bar flips between Now Playing and the open list while playing a list
- [ ] Double-click art → mini player; `⌘⇧M` and Window ▸ Mini Player too; just resizing small switches it
- [ ] Mini and normal window sizes/positions remembered separately across a quit
- [ ] Visualizer `⌘T` on/off, menu check stays in sync, reacts to the signal
- [ ] Zen Mode `⌘⇧F` hides all chrome including the nav bar; compose with `⌃⌘F` fullscreen; exits cleanly
- [ ] Settings ▸ themes: pick a dark and a light flavor, toggle Match system, flip macOS appearance → follows
- [ ] Overflowing titles ellipsize/marquee correctly at narrow widths
- [ ] Toasts appear for the failure paths above and auto-dismiss

## 12. Menus and shortcuts

- [ ] Every item in Pudding / Edit / Playback / View / File / Window / Help fires
- [ ] Check-item state (shuffle, repeat, autoadvance, mute, RG, sample rate, mini, viz, zen) matches the UI after changing it from the UI side
- [ ] `⌘S` / Move Playlist File disabled when there's nothing to save/move
- [ ] `⌘Z` in a text field does text undo, not curation undo
- [ ] Bare-key shortcuts (`Space`, `M`, `+`/`-`, arrows) do not fire while typing in search, a rename, or an editor field
- [ ] Help ▸ Website, Privacy Policy, Support open; Licenses lists deps with full text; About shows the version

## 13. OS integration

- [ ] Double-click an audio file in Finder → plays here; second file while running reuses the one instance
- [ ] "Open With" a `.m3u8` → opens for browsing
- [ ] `⌘O` opens a track and a playlist
- [ ] Drop from Finder: one audio file → lone playback; one playlist → browse; a folder → plays as queue; several files → plays as queue; overlay shows during the drag
- [ ] Media keys and lock-screen controls: play/pause, next/prev, scrub
- [ ] Control Center / lock screen shows title, artist, album art, and progress
- [ ] Open Recent lists what you actually opened; a row survives relaunch and reopens (bookmark); an unreachable row explains itself instead of vanishing; Clear Menu empties it
- [ ] Show in Finder reveals the file

## 14. Cloud / dataless

- [ ] Scan a cloud root → no downloads triggered (watch provider activity)
- [ ] Evicted files marked "(Not downloaded)"
- [ ] Play one → fetches, then plays; UI not frozen during the fetch
- [ ] Let the OS evict it again, run a full scan → marking returns to "(Not downloaded)"
- [ ] Unplug/eject a root's volume → graceful errors, no hang

## 15. Sandbox / release build

- [ ] Distribution-signed app launches; roots restore from bookmarks after relaunch
- [ ] Stream list path, playlist writes, and tag writes all succeed under the sandbox
- [ ] External links open from the sandboxed build
- [ ] App icon correct in Dock, Finder, and About
- [ ] Quit with playback running → clean exit, sample rate restored, state persisted
