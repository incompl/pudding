# Pudding

Vibe coded media player.

I made this for myself but you're welcome to check it out.

## TODO

- Gapless playback (currently auto-advance has a small gap while the next file loads)
- Watch the library folder and auto-rescan when files are added, removed, or retagged (today metadata only refreshes on explicit rescan, and `list_dir` shows new files with empty tags until then)
- Batch the per-file metadata lookups in `list_dir` and `get_metadata` (currently N+1 SELECTs per folder)
