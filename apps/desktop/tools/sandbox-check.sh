#!/usr/bin/env bash
# Proof that Pudding actually works under a REAL App Sandbox.
#
# Drives the shipping path, not a parallel one: root_access::bookmark_root (what
# the folder picker calls) and RootAccess::hold (what startup calls), over the
# bookmarks.rs primitive — and it signs with src-tauri/Entitlements.plist itself,
# the same file the Mac App Store build uses, rather than a copy of the list.
#
# `cargo test` runs unsandboxed, where plain paths work anyway: a completely broken
# bookmark implementation passes those tests. This script is the one that can fail
# for the right reason.
#
# The method throughout is strip-and-retest. Granting an entitlement and watching
# something succeed proves nothing on its own — it may have been succeeding for an
# unrelated reason. So each capability is also exercised with its entitlement
# REMOVED from the very same bundle, and has to fail there.
#
# The open panel cannot be automated, so the user's grant is stood in for by an
# entitlement — com.apple.security.assets.music.read-write, which Pudding ships
# anyway so that ~/Music needs no picker at all.
#
#   sign FULL (every shipping entitlement)
#     1 deny      a path with no grant is EPERM     -> the sandbox is really enforcing
#     2 create    bookmark a dir under ~/Music, reachable via the music entitlement
#     3 socket    where a single-instance socket can and cannot live
#     4 network   loopback connect succeeds
#   re-sign WITHOUT network.client
#     5 control   that same connect is now denied      <- makes 4 mean something
#   re-sign WITHOUT the music entitlement
#     6 control   that same dir is now denied directly <- makes 7 mean something
#     7 resolve   a SEPARATE process reads it via the bookmark alone
#
# Five things that are not obvious and are encoded here (credit to
# apple-scoped-bookmarks, which hit the first four — see the header of bookmarks.rs):
#
#   * A BARE Mach-O CANNOT be sandboxed. Putting com.apple.security.app-sandbox on
#     a loose executable gets it killed at launch with SIGTRAP (exit 133): the
#     sandbox needs a container, and a container needs a bundle id. Hence the .app.
#   * temporary-exception.* entitlements are RESTRICTED — ad-hoc signing does not
#     honour them, and the app launches but is denied anyway. Ordinary entitlements
#     like assets.music.read-write do work ad-hoc, which is why the granted
#     directory has to live under ~/Music.
#   * The bookmark blob must be persisted in the app CONTAINER ($HOME inside the
#     sandbox), not in the granted directory — after the re-sign, the resolve phase
#     could not read its own blob back out of a directory it no longer has access to.
#   * The deny probe must distinguish PermissionDenied from NotFound. Accepting any
#     error means a typo'd path passes for free and the whole run proves nothing.
#   * network.client gates LOOPBACK too, so phase 4 needs no internet: a listener
#     started out here, outside the sandbox, is a target the sandboxed process is
#     just as forbidden to reach.
#
# Usage: tools/sandbox-check.sh
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "skip: macOS only"; exit 0
fi

ENTITLEMENTS="src-tauri/Entitlements.plist"
STAMP="pudding-sbx-$$"
GRANTED="$HOME/Music/$STAMP"          # reachable via the music entitlement
WORK="$(mktemp -d "${TMPDIR:-/tmp}/$STAMP-XXXXXX")"
UNGRANTED="$WORK/ungranted"           # never granted by anything
APP="$WORK/SandboxCheck.app"
BUNDLE_ID="com.incompl.pudding.sandboxcheck"
LISTENER_PID=""

mkdir -p "$GRANTED" "$UNGRANTED" "$APP/Contents/MacOS"
echo "hello-from-the-test" > "$GRANTED/canary.txt"
echo "must-not-be-readable" > "$UNGRANTED/secret.txt"
# Phase 6 re-points the deny probe at GRANTED, and that probe insists on
# PermissionDenied rather than NotFound — so the probe file has to exist here too,
# or the control step fails as a missing path instead of a denied one.
echo "must-not-be-readable" > "$GRANTED/secret.txt"
cleanup() {
  if [[ -n "$LISTENER_PID" ]]; then
    { kill "$LISTENER_PID" && wait "$LISTENER_PID"; } >/dev/null 2>&1 || true
  fi
  rm -rf "$WORK" "$GRANTED"
  # containermanagerd owns metadata inside the container and refuses to let even
  # its creator unlink it, so this is best-effort. What is left behind is an empty
  # container for a bundle id nothing else uses.
  rm -rf "$HOME/Library/Containers/$BUNDLE_ID" 2>/dev/null || true
}
trap cleanup EXIT

echo "==> building the example"
cargo build --manifest-path src-tauri/Cargo.toml --example sandbox_check >/dev/null
TARGET_DIR=$(cargo metadata --manifest-path src-tauri/Cargo.toml --format-version 1 --no-deps \
  | python3 -c 'import json,sys;print(json.load(sys.stdin)["target_directory"])')
BIN="$TARGET_DIR/debug/examples/sandbox_check"
[[ -x "$BIN" ]] || { echo "FAIL: example binary not found at $BIN"; exit 1; }

cp "$BIN" "$APP/Contents/MacOS/sandbox_check"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
  <key>CFBundleExecutable</key><string>sandbox_check</string>
  <key>CFBundleName</key><string>SandboxCheck</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
</dict></plist>
PLIST

# ---------------------------------------------------------------- entitlements
# The bundle is signed with the app's real entitlements file, so an entitlement
# added there is under test here automatically. The converse needs asserting: if
# one is REMOVED from that file, the phase below it would start passing vacuously,
# so require each one this script relies on to actually be present.
[[ -f "$ENTITLEMENTS" ]] || { echo "FAIL: $ENTITLEMENTS is missing"; exit 1; }
for key in com.apple.security.app-sandbox \
           com.apple.security.files.user-selected.read-write \
           com.apple.security.files.bookmarks.app-scope \
           com.apple.security.assets.music.read-write \
           com.apple.security.network.client; do
  /usr/libexec/PlistBuddy -c "Print :$key" "$ENTITLEMENTS" >/dev/null 2>&1 \
    || { echo "FAIL: $ENTITLEMENTS no longer grants $key — this check would pass vacuously"; exit 1; }
done

cp "$ENTITLEMENTS" "$WORK/full.entitlements"
variant() { # $1=output  $2..=entitlement keys to strip
  local out="$1"; shift
  cp "$WORK/full.entitlements" "$out"
  for key in "$@"; do
    /usr/libexec/PlistBuddy -c "Delete :$key" "$out" >/dev/null
  done
}
variant "$WORK/no-network.entitlements" com.apple.security.network.client
variant "$WORK/no-music.entitlements"   com.apple.security.assets.music.read-write

sign() { # $1=entitlements file
  codesign --force --sign - --entitlements "$1" "$APP"
  codesign -d --entitlements - "$APP" 2>/dev/null | grep -q "app-sandbox" \
    || { echo "FAIL: entitlements did not stick"; exit 1; }
}
refute_entitlement() { # $1=substring that must NOT be in the signature
  if codesign -d --entitlements - "$APP" 2>/dev/null | grep -q "$1"; then
    echo "FAIL: $1 survived the re-sign"; exit 1
  fi
}

# ------------------------------------------------------------------ the target
# A listener out here in the unsandboxed world. network.client gates loopback the
# same as anything else, so this is a valid target for the entitlement check and
# costs no network.
python3 - > "$WORK/port" <<'PY' &
import socket, sys, time
s = socket.socket(); s.bind(("127.0.0.1", 0)); s.listen(16)
print(s.getsockname()[1], flush=True)
deadline = time.time() + 300
while time.time() < deadline:
    s.settimeout(5)
    try: s.accept()
    except Exception: pass
PY
LISTENER_PID=$!
for _ in $(seq 1 50); do [[ -s "$WORK/port" ]] && break; sleep 0.1; done
PROBE_PORT=$(head -1 "$WORK/port")
[[ -n "$PROBE_PORT" ]] || { echo "FAIL: could not start the loopback listener"; exit 1; }

# The plugin derives its socket name from the bundle identifier with dots and
# dashes replaced by underscores; derive it the same way so renaming the app can
# never leave the socket phase probing a path nothing would use.
SI_SOCKET=$(python3 -c "
import json; print('/tmp/%s_si.sock' % json.load(open('src-tauri/tauri.conf.json'))['identifier'].replace('.','_').replace('-','_'))")

EXE="$APP/Contents/MacOS/sandbox_check"
export PUDDING_GRANTED_DIR="$GRANTED"
export PUDDING_UNGRANTED_DIR="$UNGRANTED"
export PUDDING_PROBE_ADDR="127.0.0.1:$PROBE_PORT"
export PUDDING_SI_SOCKET="$SI_SOCKET"
# A name in /tmp that cannot already exist. The bind probe needs the sandbox to
# refuse it outright; a leftover socket from a `tauri dev` run would fail the bind
# with AddrInUse instead, which is a different fact entirely.
export PUDDING_SI_SOCKET_FRESH="/tmp/$STAMP-si.sock"

echo "==> signing with the shipping entitlements ($ENTITLEMENTS)"
sign "$WORK/full.entitlements"

echo "==> phase 1: the sandbox is actually enforcing"
"$EXE" deny

echo "==> phase 2: create + persist a bookmark (into the app container)"
"$EXE" create

echo "==> phase 3: the single-instance rendezvous socket"
"$EXE" socket

echo "==> phase 4: loopback reaches the listener WITH network.client"
PUDDING_EXPECT_NET=allow "$EXE" network

echo "==> re-signing WITHOUT network.client"
sign "$WORK/no-network.entitlements"
refute_entitlement "network.client"

echo "==> phase 5: CONTROL — that same connect must now be denied"
PUDDING_EXPECT_NET=deny "$EXE" network

echo "==> re-signing WITHOUT the music entitlement"
sign "$WORK/no-music.entitlements"
refute_entitlement "assets.music"

echo "==> phase 6: CONTROL — that same directory must now be denied directly"
PUDDING_UNGRANTED_DIR="$GRANTED" "$EXE" deny

echo "==> phase 7: resolve in a SEPARATE process, via the bookmark alone"
"$EXE" resolve

echo
echo "PASS: with the granting entitlement removed, the directory is denied"
echo "      directly and reachable only through the persisted bookmark;"
echo "      the network is reachable only with network.client."
