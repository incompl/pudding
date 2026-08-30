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
