# @pudding/lib

Things the Pudding apps share.

- `default-streams.m3u8`: the stations a fresh install starts with. Desktop
  embeds it at compile time (`include_str!` in `src-tauri/src/lib.rs`); mobile's
  "Bundle web build" phase copies it into the app for `Stations.swift` to seed
  from. Read the header before adding a station: each one needs the operator's
  permission on record.
