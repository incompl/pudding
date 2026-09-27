#!/usr/bin/env bash
# Generates the Mac App Store DISTRIBUTION entitlements from the shipping ones.
#
# A distribution build needs two entitlements the local sandbox build does not:
#
#   com.apple.application-identifier    = TEAM_ID.<bundle id>
#   com.apple.developer.team-identifier = TEAM_ID
#
# Both have to agree with the embedded provisioning profile; App Store Connect
# rejects the upload when they don't.
#
# Both also carry an account-specific Team ID, which is why neither is written
# into src-tauri/Entitlements.plist. That file is a signing input read by
# tools/sandbox-check.sh and by every MAS build; hand-editing it before a release
# is how a Team ID ends up committed, or how a release gets signed with a stale
# one. So the sandbox entitlements keep exactly one source, and the extra two are
# added here from $TEAM_ID at build time. The output is generated and ignored by
# Git.
#
# Run by `pnpm build:mas:distribution`; safe to run on its own to inspect the
# result.
#
# Usage: TEAM_ID=ABCDE12345 tools/gen-distribution-entitlements.sh
set -euo pipefail

cd "$(dirname "$0")/.."

BASE="src-tauri/Entitlements.plist"
OUT="src-tauri/Entitlements.distribution.plist"

if [[ -z "${TEAM_ID:-}" ]]; then
  echo "FAIL: TEAM_ID is not set. It is the Team ID (App ID Prefix) shown under" >&2
  echo "      Membership in the Apple Developer account, and the prefix of the" >&2
  echo "      App ID the provisioning profile was issued for." >&2
  exit 1
fi

# Ten uppercase alphanumerics. Catching the shape here beats finding the typo in
# a rejected upload, where it surfaces as a profile mismatch rather than a typo.
if [[ ! "$TEAM_ID" =~ ^[A-Z0-9]{10}$ ]]; then
  echo "FAIL: TEAM_ID '$TEAM_ID' is not 10 uppercase alphanumeric characters" >&2
  exit 1
fi

[[ -f "$BASE" ]] || { echo "FAIL: $BASE is missing"; exit 1; }

# The bundle id is read from the Tauri config rather than repeated here: the
# application-identifier has to name the app that is actually signed, and that
# same id is what the App ID and its profile were registered for.
BUNDLE_ID=$(python3 -c "
import json; print(json.load(open('src-tauri/tauri.conf.json'))['identifier'])")
[[ -n "$BUNDLE_ID" ]] || { echo "FAIL: no identifier in src-tauri/tauri.conf.json"; exit 1; }

cp "$BASE" "$OUT"

set_string() { # $1=key  $2=value
  /usr/libexec/PlistBuddy -c "Delete :$1" "$OUT" >/dev/null 2>&1 || true
  /usr/libexec/PlistBuddy -c "Add :$1 string $2" "$OUT" >/dev/null
}
set_string com.apple.application-identifier "$TEAM_ID.$BUNDLE_ID"
set_string com.apple.developer.team-identifier "$TEAM_ID"

# The sandbox switch is the one entitlement whose loss would be silent: the build
# would sign, upload and run, just unsandboxed, and fail review instead of here.
/usr/libexec/PlistBuddy -c "Print :com.apple.security.app-sandbox" "$OUT" >/dev/null 2>&1 \
  || { echo "FAIL: $OUT lost com.apple.security.app-sandbox"; exit 1; }

plutil -lint "$OUT" >/dev/null
echo "wrote $OUT (application-identifier $TEAM_ID.$BUNDLE_ID)"
