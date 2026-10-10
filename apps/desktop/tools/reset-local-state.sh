#!/usr/bin/env bash
# Resets this machine's Pudding installation to factory settings — the state a
# first launch after a fresh install would see.
#
# Everything Pudding persists lives under one per-identifier app-data directory
# (see app_data_dir() in src-tauri/src/lib.rs): settings.json (the plugin-store
# file holding library roots, bookmarks, playback prefs, recents), metadata.db
# plus its -wal/-shm, streams.m3u8, and the metadata-recovery / inflight-writes
# scratch dirs. Deleting that directory is the whole reset; the app recreates it,
# re-seeds streams.m3u8 from the bundled template, and rebuilds the database on
# the next launch.
#
# The rest of what we remove is macOS-side state that outlives an app delete and
# can keep a "fresh" launch from behaving like one:
#
#   Preferences/<id>.plist        window frame, NSUserDefaults
#   WebKit/<id>, HTTPStorages/<id>  WKWebView local storage and caches
#   Caches/<id>                   on-disk URL/art cache
#   Saved Application State/<id>  restored window state
#   Containers/<id>               the sandboxed (MAS build) copy of ALL of the above
#
# A sandboxed build never reads the unsandboxed paths and vice versa, so both are
# cleared: whichever build you run next starts clean. Library files themselves are
# never touched — your music, playlists, and .m3u8 files on disk are Finder's, not
# ours. Only Pudding's own state goes.
#
# Run via `pnpm reset` (or `pnpm reset -- --dry-run`); safe to run directly.
#
# Usage: tools/reset-local-state.sh [--dry-run] [--yes] [--all]
#   --dry-run  list what would be removed, remove nothing
#   --yes      skip the confirmation prompt (required when stdin isn't a TTY)
#   --all      also reset the E2E, screenshot, and legacy identifiers
set -euo pipefail

cd "$(dirname "$0")/.."

DRY_RUN=0
ASSUME_YES=0
ALL=0

for arg in "$@"; do
  case "$arg" in
    --dry-run|-n) DRY_RUN=1 ;;
    --yes|-y) ASSUME_YES=1 ;;
    --all) ALL=1 ;;
    # pnpm forwards the argument separator verbatim through a filtered run.
    --) ;;
    -h|--help) sed -n '/^# Usage:/,/^#   --all/p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "FAIL: unknown option '$arg' (see --help)" >&2; exit 1 ;;
  esac
done

# The identifiers from the tauri configs. The main one is what `tauri dev` and a
# release build both use; the other two are test profiles, and com.gregsmith.pudding
# is the pre-rename identifier some machines still have a stale settings.json under.
IDS=("com.incompl.pudding")
if [[ $ALL -eq 1 ]]; then
  IDS+=("com.incompl.pudding.e2e" "com.incompl.pudding.screenshots" "com.gregsmith.pudding")
fi

# Deleting metadata.db out from under a live SQLite connection loses whatever is
# still in the WAL and leaves the running app writing to an unlinked file, so the
# reset only happens with the app closed. `pudding` is the dev binary (tauri dev),
# `Pudding` the bundled app.
# `pgrep -x` compares against more than the process name on macOS, so match
# loosely and compare the name column ourselves.
RUNNING="$(pgrep -l '[Pp]udding' | awk '$2 == "Pudding" || $2 == "pudding" { printf "%s ", $1 }' || true)"
if [[ -n "$RUNNING" && $DRY_RUN -eq 0 ]]; then
  echo "FAIL: Pudding is running (pid ${RUNNING% })." >&2
  echo "      Quit it first — removing the database under a live connection loses" >&2
  echo "      unflushed writes." >&2
  exit 1
fi

TARGETS=()
for id in "${IDS[@]}"; do
  TARGETS+=(
    "$HOME/Library/Application Support/$id"
    "$HOME/Library/Preferences/$id.plist"
    "$HOME/Library/Caches/$id"
    "$HOME/Library/WebKit/$id"
    "$HOME/Library/HTTPStorages/$id"
    "$HOME/Library/HTTPStorages/$id.binarycookies"
    "$HOME/Library/Saved Application State/$id.savedState"
    "$HOME/Library/Containers/$id"
  )
done

# The one path we can only partly clear. containermanagerd owns
# ~/Library/Containers/<id> and the .com.apple.containermanagerd.metadata.plist
# inside it, and denies the delete to the file's own owner AND to root under SIP
# (only a process holding Full Disk Access, like Finder, may remove it — not worth
# asking for, to delete a stub). Everything that holds state lives in Data/ inside
# the container, which IS ours, so we clear the contents and leave the shell: a
# sandboxed launch repopulates it, which is exactly the reset. A container already
# down to that plist therefore counts as clean, not as something still to remove.
CONTAINER_STUB=".com.apple.containermanagerd.metadata.plist"
container_is_empty() {
  [[ -z "$(find "$1" -mindepth 1 -maxdepth 1 ! -name "$CONTAINER_STUB" -print -quit)" ]]
}

PRESENT=()
for path in "${TARGETS[@]}"; do
  [[ -e "$path" ]] || continue
  if [[ "$path" == "$HOME/Library/Containers/"* ]] && container_is_empty "$path"; then
    continue
  fi
  PRESENT+=("$path")
done

if [[ ${#PRESENT[@]} -eq 0 ]]; then
  echo "Already at factory settings: no Pudding state found for ${IDS[*]}."
  exit 0
fi

echo "Pudding state to remove:"
for path in "${PRESENT[@]}"; do
  size="$(du -sh "$path" 2>/dev/null | cut -f1 || true)"
  printf '  %-6s %s\n' "${size:-?}" "$path"
done

if [[ $DRY_RUN -eq 1 ]]; then
  echo
  echo "--dry-run: nothing was removed."
  exit 0
fi

if [[ $ASSUME_YES -eq 0 ]]; then
  if [[ ! -t 0 ]]; then
    echo "FAIL: not a TTY and --yes was not passed; refusing to delete unprompted." >&2
    exit 1
  fi
  echo
  read -r -p "Delete these permanently? This cannot be undone. [y/N] " reply
  [[ "$reply" == [yY]* ]] || { echo "Aborted; nothing was removed."; exit 1; }
fi

for id in "${IDS[@]}"; do
  # cfprefsd caches preferences in memory and will write the plist back out after
  # we delete it, so the domain has to be dropped through defaults as well. The
  # domain usually doesn't exist for a sandboxed build; a failure here is not fatal.
  defaults delete "$id" 2>/dev/null || true
done

FAILED=0
for path in "${PRESENT[@]}"; do
  if [[ "$path" == "$HOME/Library/Containers/"* ]]; then
    find "$path" -mindepth 1 -maxdepth 1 ! -name "$CONTAINER_STUB" -exec rm -rf {} + || FAILED=1
    echo "cleared $path (its macOS-owned stub stays; it holds no state)"
  elif rm -rf "$path"; then
    echo "removed $path"
  else
    echo "FAIL: could not remove $path" >&2
    FAILED=1
  fi
done

echo
echo "Done — the next launch starts as a fresh install (empty library, no roots,"
echo "default stream list, prefs at their defaults)."
exit $FAILED
