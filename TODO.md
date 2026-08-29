### "Play Next" verb
Every context menu only offers **Add to queue** (append to the tail): tree
tracks (`src/main.ts:989`), folders (`src/main.ts:959`), queue rows
(`src/main.ts:1191`), playlists (`src/main.ts:936`). Spotify and Apple Music
both split this into **Play Next** (insert right after the current track) and
**Add to Queue** (append). Today the only way to make something play next is to
drag it up the list. This is the missing half of the "Play Next / Add to queue"
pair in the original design.

- Add a `playNext(tracks)` alongside `addToQueue` (`src/main.ts:2977`) that
  inserts after the current row instead of at the tail — reuse the seed-from-
  current path (`seedQueueFromCurrent`) and the engine sync in
  `appendTracksToActiveQueue` (`src/main.ts:2885`), inserting at
  `queuePlayingIndex + 1` rather than pushing.

### Restore queue + playback state on relaunch
The active queue, current track, playhead position, and play/pause are all
in-memory signals; quitting loses the whole queue and your place. Persisted keys
today are only volume / window / autoadvance / recent playlists / library root
(`src/main.ts:16-32`). Spotify/Apple always resume the queue and position.

- Persist `activeQueue`, current track path, and `currentTime` (debounced) to the
  settings store; rehydrate on startup. Decide whether to auto-resume paused or
  just restore the queue + playhead without playing.

### Shuffle back-history
`skipPrev` under shuffle just restarts the current track (`src/main.ts:1798`); it
can't return to the track you actually just heard. This is the shuffle behavior
users most notice missing.

- Keep a played-order stack as the shuffle bag is consumed; have `skipPrev` pop
  it instead of seeking to 0 when shuffle is on.

### Undo for playlist edits
Every curation is destructive and immediate: reorder, remove, drag-in, and rename
all autosave the `.m3u8` on the spot (`applyCuration` -> `saveOpenPlaylist`), and
`delete_playlist` removes the file outright behind only an OS confirm. There's no
way back from a fat-fingered remove or a wrong-list drop. Autosave is the whole
point (a playlist is its file), so undo has to layer on top of it, not replace it.

- Keep a bounded per-playlist snapshot stack of the track-path list (cheap —
  paths only), pushed before each `applyCuration` write; a ⌘Z pops it and
  re-saves. Decide whether delete participates (soft-delete to a trash dir, or
  just keep it as a hard action outside undo).

### Virtualize lists

### Search should no longer auto play

### Replace context menu "play artist" and "play album" with "go to"

### Doing anything that changes right panel should dismiss settings/about