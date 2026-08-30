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
