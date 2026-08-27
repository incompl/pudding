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

### Edit file metadata

Phase 1 shipped: a single-track "Edit metadata…" verb in the tree context menu
opens the row as an inline editor (reusing `buildInlineEditor`, same as station
editing) over Title / Artist / Album / Album Artist / Disc / Track. The
`write_tags` command (`src-tauri/src/lib.rs`) mutates the file's primary tag via
lofty — creating a native tag for untagged files — then syncs the `tracks` cache
row so the library views update without a rescan. `save_to_path` rewrites the
file in place, which would corrupt the decode of a track the engine is holding
open, so any track is editable but **Save is gated** (disabled, with a note)
while that track is the one playing — checked reactively, since playback can
advance into the edited track after the editor opens.

Remaining:

- **Batch edit for a multi-track selection** (set Album/Artist/Album Artist
  across the whole selection). The wrinkle is mixed values: the inline editor
  has no "leave unchanged" state, so fields whose selected tracks disagree need a
  distinct placeholder (e.g. "Multiple values") that only writes the field the
  user actually touches. `write_tags` already takes one path; loop it, or add a
  batch command. The multi-select branch of the tree context menu
  (`src/main.ts`, `Add N to queue`) is where the verb would attach.

- **Genre and Year.** Not in the `tracks` schema, so surfacing them in the
  Songs/Artists/Albums views (or search) means a schema migration (bump
  `SCHEMA_VERSION`, add columns, extend `read_tags`/`write_tags`). Cheap to write
  to the file; the cost is the indexed columns.

- **Album art embedding.** Add/replace/remove the front-cover picture (lofty
  `Picture` + MIME + `PictureType::CoverFront`). A separate affordance from the
  text fields — closer to the station-image "Choose…" browse than a text input —
  and interacts with `get_art`, which reads the first embedded picture.

- **Saving edits to the now-playing file.** Save is currently blocked while the
  edited track is playing. Could be allowed by pausing + releasing the engine's
  file handle, saving, then reopening at the saved position — only worth it if
  users hit the block often.

### Virtualize lists