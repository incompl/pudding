#!/usr/bin/env bash
# Generate a stress library for testing Songs-list virtualization (windowed-list.ts).
#
# Creates N distinctly-named entries pointing at one tiny fixture, so the flat Songs
# list has N rows. Uses hardlinks (distinct paths, ~zero extra disk) when the target
# is on the same filesystem as the fixture, else falls back to copies.
#
# Usage:   scripts/gen-stress-library.sh [COUNT] [OUT_DIR] [SOURCE_FILE]
# Default: 50000 copies of e2e/fixtures/tone.m4a into ~/pudding-stress-lib
#
# Then in Pudding: add OUT_DIR as a library folder, let the scan finish, open the
# Songs lens, and scroll. Rows read 1..N (no tags -> positional number + filename),
# so the gutter is a live check that row i lands at slot i.
set -euo pipefail

COUNT="${1:-50000}"
OUT_DIR="${2:-$HOME/pudding-stress-lib}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${3:-$REPO_ROOT/e2e/fixtures/tone.m4a}"

[ -f "$SRC" ] || { echo "source file not found: $SRC" >&2; exit 1; }
ext="${SRC##*.}"

mkdir -p "$OUT_DIR"
# Width for zero-padded, sortable names (so on-disk order matches row order).
width=${#COUNT}

# Try one hardlink to detect same-filesystem; fall back to copy otherwise.
link_cmd="ln"
if ! ln "$SRC" "$OUT_DIR/.__probe.$ext" 2>/dev/null; then
  link_cmd="cp"
  echo "cross-device: falling back to cp (uses ~$((COUNT * $(stat -f%z "$SRC") / 1024 / 1024)) MB)"
fi
rm -f "$OUT_DIR/.__probe.$ext"

echo "generating $COUNT entries in $OUT_DIR (via $link_cmd)..."
for ((i = 1; i <= COUNT; i++)); do
  printf -v name "%0${width}d.%s" "$i" "$ext"
  "$link_cmd" "$SRC" "$OUT_DIR/$name"
  (( i % 5000 == 0 )) && echo "  $i / $COUNT"
done
echo "done. Add this folder to Pudding's library: $OUT_DIR"
