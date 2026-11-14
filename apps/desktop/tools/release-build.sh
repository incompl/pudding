#!/usr/bin/env bash
# One command from a checkout to the artifact you can test and upload: a
# distribution-signed, universal, sandboxed Pudding.app and the signed .pkg
# beside it.
#
# `pnpm build:mas:distribution` already builds that app. What it cannot do is
# tell you whether what came out is uploadable, and almost every way a Mac App
# Store build goes wrong is silent at build time and loud days later in App
# Store Connect or in review:
#
#   * the signature verifies, but the sandbox entitlement never made it in, so
#     the app runs fine here and fails review
#   * the binary is one architecture because a rustup target was missing
#   * Tauri's generated Info.plist won the merge, every audio type is back to
#     LSHandlerRank=Default, and the app seizes mp3 from Music on first launch
#   * the build number was already used, so the upload is rejected outright
#   * the profile expired, or was issued to a different Team ID than the cert
#
# So this script builds and then PROVES the result, failing on anything that
# would be rejected or would ship wrong. Every check reads the app that was just
# built — never the config that was supposed to produce it.
#
# Unlike tools/gen-distribution-entitlements.sh, this does not ask for TEAM_ID.
# It reads it out of AppStore.provisionprofile, the one copy that has to agree
# with Apple. A Team ID typed into an environment can disagree with the profile;
# a Team ID read from the profile cannot. TEAM_ID in the environment is still
# honoured, and a disagreement with the profile is an error rather than a silent
# override. The signing identities are discovered the same way: by matching the
# profile's Team ID, so a second developer account in the keychain cannot be
# picked up by accident.
#
# Usage:
#   tools/release-build.sh --install    build the LOCAL build and install it
#                                       (sudo: needs your password and a tty)
#   tools/release-build.sh --submit     build the SUBMISSION build, bump the
#                                       build number, package it for upload
#   tools/release-build.sh              build, verify and package the submission
#                                       build without bumping or installing
#   tools/release-build.sh --bump       increment the build number first
#   tools/release-build.sh --clean      discard the release target dirs first
#   tools/release-build.sh --no-pkg     stop at the verified .app
#
# There are two builds here, and the flag picks which one:
#
#   --install  signs src-tauri/Entitlements.plist and embeds no provisioning
#              profile. Sandboxed, universal, and it LAUNCHES on this Mac, so
#              it is the app the sandbox section of test-plan.md is testing.
#              Not uploadable: the store requires the profile.
#   --submit   signs Entitlements.distribution.plist, which adds
#              com.apple.application-identifier and
#              com.apple.developer.team-identifier, and embeds
#              AppStore.provisionprofile. Uploadable, and it CANNOT launch
#              here.
#
# The second build is not a choice, and what it costs is local launchability.
# Those two added entitlements are RESTRICTED: only a provisioning profile may
# authorise them, and a Mac App Store production profile names no devices, so
# this Mac is not among them. taskgated-helper rules the profile ineligible
# ("Only Development Provisioning Profiles can be installed in System
# Settings"), amfid answers "No matching profile found" (-413), and the kernel
# kills the process at exec. All the user sees is "Pudding.app couldn't be
# opened"; `log show --last 5m` has the real reason. How the app is installed
# changes none of this -- it is the signature, not the delivery.
#
# Otherwise the two are the same app: same source, same compile, same sandbox
# entitlements, same Info.plist, same two architectures, and every check below
# runs over both. They differ in two entitlement strings and one embedded file,
# none of which is code. What neither build can reproduce is the store receipt:
# Apple strips this signature on upload, re-signs the app with its own
# certificate, and injects Contents/_MASReceipt/receipt, so a store-signed
# Pudding exists only after processing -- on a tester's machine, via TestFlight.
# Anything that reads the receipt is tested there rather than here.
#
# Both builds land in the same bundle/macos directory, so whichever ran last is
# what is in it; the Done summary says which. --install never packages, so a
# .pkg in that directory is always a submission package.
#
# --install copies the app into /Applications rather than installing a .pkg.
# productbuild emits a <relocate> entry for the bundle, which tells installd to
# find any existing copy of com.incompl.pudding on the disk and install THERE
# instead of at the package's own install-location: a debug build sitting in
# target/debug was enough to make installer(8) report success, overwrite that
# debug bundle, and leave /Applications empty. The submission .pkg is left
# exactly as Apple will receive it rather than restructured for local testing;
# the Install step explains why copying gives up nothing.
#
# Overrides: APPLE_SIGNING_IDENTITY, INSTALLER_SIGNING_IDENTITY, TEAM_ID.
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "FAIL: macOS only" >&2; exit 1
fi

BUMP=0 CLEAN=0 INSTALL=0 SUBMIT=0 MAKE_PKG=1
for arg in "$@"; do
  case "$arg" in
    --bump) BUMP=1 ;;
    --clean) CLEAN=1 ;;
    --install) INSTALL=1 ;;
    --submit) SUBMIT=1 ;;
    --no-pkg) MAKE_PKG=0 ;;
    -h|--help) sed -n '/^# Usage:/,/^# Overrides:/p' "$0" | cut -c3-; exit 0 ;;
    *) echo "FAIL: unknown option '$arg' (try --help)" >&2; exit 1 ;;
  esac
done
# The modes are exclusive because they are two differently signed builds of the
# same app and one directory holds the result. --submit also spends a build
# number that cannot be spent twice, so it is the step taken once the local
# build has been tested -- in an earlier run.
if (( INSTALL && SUBMIT )); then
  echo "FAIL: --install and --submit build differently signed apps and cannot" >&2
  echo "      be combined. Test with --install, then re-run with --submit." >&2
  exit 1
fi
# LOCAL is how the app is signed; INSTALL is what is done with it afterwards.
# One flag sets both today, and they are kept apart because every check below
# that branches is branching on the signature, not on the install.
LOCAL=$INSTALL
if (( LOCAL )); then MODE=local; else MODE=submission; fi
# An upload is rejected outright if the build number was used before, so
# --submit bumps rather than leaving that to be remembered.
if (( SUBMIT )); then BUMP=1; fi
# --submit uploads the package, so it needs one built.
if (( SUBMIT && ! MAKE_PKG )); then
  echo "FAIL: --no-pkg contradicts --submit" >&2; exit 1
fi
# A local build is never packaged, and nothing is lost by that: the Install step
# copies the app in, and a package built from a local build is not submittable.
# Leaving one in the output directory, named exactly like the real thing, is a
# trap rather than a convenience.
if (( LOCAL )); then MAKE_PKG=0; fi

TAURI_CONF="src-tauri/tauri.conf.json"
PROFILE="src-tauri/AppStore.provisionprofile"
BASE_ENT="src-tauri/Entitlements.plist"
DIST_ENT="src-tauri/Entitlements.distribution.plist"
OUT_DIR="src-tauri/target/universal-apple-darwin/release/bundle/macos"
APP="$OUT_DIR/Pudding.app"
PKG="$OUT_DIR/Pudding.pkg"

step() { printf '\n==> %s\n' "$1"; }
fail() { echo "FAIL: $1" >&2; exit 1; }

# A local build neither embeds the profile nor signs anything the profile has to
# authorise, so a stale or mismatched profile cannot affect its result. The
# profile is still read in that mode, because it is where the Team ID and
# therefore the signing identity come from; what changes is that a problem with
# it is reported instead of fatal.
profile_problem() {
  if (( LOCAL )); then
    printf 'warn %s\n' "$1" >&2
  else
    fail "$1"
  fi
}

# ---------------------------------------------------------------- preflight

step "Preflight"

for f in "$TAURI_CONF" "$BASE_ENT"; do
  [[ -f "$f" ]] || fail "$f is missing"
done
[[ -f "$PROFILE" ]] || fail "$PROFILE is missing. Download the Mac App Store
      Connect provisioning profile for the app and save it there (it is
      account-specific and deliberately not committed — see MAS-BUILD.md)."

command -v pnpm >/dev/null || fail "pnpm is not on PATH"
command -v rustup >/dev/null || fail "rustup is not on PATH"

# The profile is the source of truth for who this build belongs to. Read the
# Team ID, the app it was issued for, and how long it is still valid.
PROFILE_FACTS=$(security cms -D -i "$PROFILE" 2>/dev/null | python3 -c '
import datetime, plistlib, sys
try:
    p = plistlib.loads(sys.stdin.buffer.read())
except Exception as e:
    sys.exit(f"could not decode the provisioning profile: {e}")
try:
    appid = p["Entitlements"]["com.apple.application-identifier"]
    exp = p["ExpirationDate"]
except KeyError as e:
    sys.exit(f"the profile has no {e}")
if exp.tzinfo is None:
    exp = exp.replace(tzinfo=datetime.timezone.utc)
left = (exp - datetime.datetime.now(datetime.timezone.utc)).days
print(appid, exp.date().isoformat(), left, p.get("Name", "?").replace(" ", "_"))
') || fail "$PROFILE could not be read"

read -r PROFILE_APPID PROFILE_EXPIRY PROFILE_DAYS PROFILE_NAME <<<"$PROFILE_FACTS"
TEAM_FROM_PROFILE="${PROFILE_APPID%%.*}"
BUNDLE_FROM_PROFILE="${PROFILE_APPID#*.}"

(( PROFILE_DAYS > 0 )) || profile_problem "the provisioning profile expired on
      $PROFILE_EXPIRY. Download a fresh Mac App Store Connect profile and
      replace $PROFILE."

# An environment TEAM_ID is allowed, but only if it agrees with the profile.
# Disagreement means one of them is stale, and signing with the stale one is
# exactly the failure this script exists to catch early.
if [[ -n "${TEAM_ID:-}" && "$TEAM_ID" != "$TEAM_FROM_PROFILE" ]]; then
  fail "TEAM_ID=$TEAM_ID disagrees with the profile's $TEAM_FROM_PROFILE.
      Unset TEAM_ID to use the profile, or install the matching profile."
fi
TEAM_ID="$TEAM_FROM_PROFILE"
export TEAM_ID

BUNDLE_ID=$(python3 -c "
import json; print(json.load(open('$TAURI_CONF'))['identifier'])")
[[ -n "$BUNDLE_ID" ]] || fail "no identifier in $TAURI_CONF"
[[ "$BUNDLE_ID" == "$BUNDLE_FROM_PROFILE" ]] || profile_problem \
  "the profile was issued for '$BUNDLE_FROM_PROFILE' but this app is
      '$BUNDLE_ID'. App Store Connect rejects that mismatch."

# Identity discovery, scoped to the profile's team. Exactly one match is the
# only safe outcome: zero means nothing can sign, and more than one means the
# script would be choosing which account ships.
pick_identity() { # $1=label  $2=cert-prefix regex  $3=find-identity args...
  local label="$1" pattern="$2"; shift 2
  local found count
  found=$(security find-identity -v "$@" 2>/dev/null \
    | sed -nE 's/.*"((('"$pattern"')): .*\('"$TEAM_ID"'\))".*/\1/p' | sort -u)
  count=$(printf '%s' "$found" | grep -c . || true)
  if (( count == 0 )); then
    echo "FAIL: no $label certificate for team $TEAM_ID in the keychain." >&2
    echo "      Expected one matching: $pattern ... ($TEAM_ID)" >&2
    echo "      Installed identities:" >&2
    security find-identity -v "$@" >&2
    exit 1
  fi
  if (( count > 1 )); then
    echo "FAIL: $count $label certificates for team $TEAM_ID; pick one explicitly." >&2
    printf '      %s\n' $found >&2
    exit 1
  fi
  printf '%s' "$found"
}

if [[ -z "${APPLE_SIGNING_IDENTITY:-}" ]]; then
  APPLE_SIGNING_IDENTITY=$(pick_identity "application signing" \
    'Apple Distribution|3rd Party Mac Developer Application' -p codesigning)
fi
export APPLE_SIGNING_IDENTITY

if (( MAKE_PKG )) && [[ -z "${INSTALLER_SIGNING_IDENTITY:-}" ]]; then
  # Not a codesigning identity: productbuild signs with an installer cert, and
  # signing the .pkg with the application cert is a silently accepted mistake.
  INSTALLER_SIGNING_IDENTITY=$(pick_identity "installer signing" \
    'Mac Installer Distribution|3rd Party Mac Developer Installer')
fi

# BOTH signing keys have to be usable WITHOUT a dialog, and that is checked
# here, on throwaway data, rather than discovered 20 minutes into a build.
#
# Signing asks the keychain for a private key. If the key's ACL does not already
# list the signing tool, the Security framework raises a prompt — and the tool
# then blocks inside CMS signing for as long as the prompt goes unanswered,
# which is forever when the dialog is dismissed or the SecurityAgent drawing it
# gets orphaned. There is no timeout and no message: the build simply stops,
# mid-sign, looking like a slow link step.
#
# Both keys are probed because they are different keys with separate ACLs, and
# the installer key is not reached until productbuild runs — after the whole
# universal app has been compiled and signed. Answering a prompt in the first
# seconds of a run with "Always Allow" fixes every later build.
#
# The wait is long enough for someone to find the dialog, and short enough that
# a stuck one is not a build.
PROMPT_TIMEOUT=120

# $1 = what is being signed with, rest = the command that uses the key.
run_signing_probe() {
  local label="$1"; shift
  local log pid waited=0
  log=$(mktemp "${TMPDIR:-/tmp}/pudding-probe.XXXXXX")

  "$@" >"$log" 2>&1 &
  pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    if (( waited >= PROMPT_TIMEOUT )); then
      kill -9 "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
      rm -f "$log"
      echo "FAIL: signing hung for ${PROMPT_TIMEOUT}s asking the keychain for" >&2
      echo "      $label." >&2
      echo >&2
      echo "      It is waiting on a keychain prompt that is not being answered." >&2
      echo "      If a dialog is on screen, answer it with Always Allow and re-run." >&2
      echo "      If no dialog is on screen, the SecurityAgent drawing it is stuck:" >&2
      echo >&2
      echo "        pkill -9 SecurityAgent        # macOS respawns it on demand" >&2
      echo >&2
      echo "      To authorise the keys once and never be prompted again (this asks" >&2
      echo "      for the LOGIN KEYCHAIN password, so run it yourself in a terminal):" >&2
      echo >&2
      echo "        security set-key-partition-list \\" >&2
      echo "          -S apple-tool:,apple:,codesign: -s \\" >&2
      echo "          ~/Library/Keychains/login.keychain-db" >&2
      exit 1
    fi
    sleep 1; (( waited++ ))
  done
  if ! wait "$pid"; then
    echo "FAIL: cannot sign with $label:" >&2
    sed 's/^/      /' "$log" >&2
    rm -f "$log"
    exit 1
  fi
  rm -f "$log"
  # A few seconds is ordinary first-use keychain overhead; a long wait means a
  # dialog was answered, and saying so is how the Always Allow hint gets seen.
  if (( waited > 5 )); then
    echo "ok   $label usable (took ${waited}s — if that was a prompt, answering"
    echo "     it with Always Allow stops it coming back)"
  else
    echo "ok   $label usable without a prompt"
  fi
}

probe_signing_keys() {
  local dir
  dir=$(mktemp -d "${TMPDIR:-/tmp}/pudding-signprobe.XXXXXX")

  # The application key, through the tool that will really use it.
  cp /bin/echo "$dir/probe"       # any Mach-O; --force replaces its signature
  chmod u+w "$dir/probe"
  run_signing_probe "the application signing key" \
    codesign --force -s "$APPLE_SIGNING_IDENTITY" "$dir/probe"

  # The installer key. productbuild signs the package with a CMS signature, so
  # `security cms -S` exercises the same key down the same path in milliseconds
  # — running productbuild itself would need a built app, which is the thing
  # this check exists to run before.
  if (( MAKE_PKG )); then
    printf 'probe' >"$dir/data"
    run_signing_probe "the installer signing key" \
      security cms -S -N "$INSTALLER_SIGNING_IDENTITY" \
        -i "$dir/data" -o "$dir/data.cms"
  fi

  rm -rf "$dir"
}
probe_signing_keys

for target in aarch64-apple-darwin x86_64-apple-darwin; do
  rustup target list --installed | grep -qx "$target" \
    || fail "rust target $target is not installed (the universal build needs both):
      rustup target add aarch64-apple-darwin x86_64-apple-darwin"
done

MARKETING_VERSION=$(python3 -c "
import json; print(json.load(open('$TAURI_CONF'))['version'])")

echo "profile          $PROFILE_NAME ($PROFILE_APPID), expires $PROFILE_EXPIRY ($PROFILE_DAYS days)"
echo "team             $TEAM_ID"
echo "app identity     $APPLE_SIGNING_IDENTITY"
(( MAKE_PKG )) && echo "pkg identity     $INSTALLER_SIGNING_IDENTITY"
echo "version          $MARKETING_VERSION"

# ---------------------------------------------------------------- build number

# Sequential integer build numbers, incremented before every upload including a
# replacement for the same marketing version. Opt-in, because a local test build
# should not burn one and the file is committed.
if (( BUMP )); then
  step "Build number"
  OLD_BUILD=$(python3 -c "
import json; print(json.load(open('$TAURI_CONF'))['bundle']['macOS']['bundleVersion'])")
  [[ "$OLD_BUILD" =~ ^[0-9]+$ ]] || fail \
    "bundleVersion '$OLD_BUILD' is not an integer; --bump only increments integers"
  NEW_BUILD=$(( OLD_BUILD + 1 ))
  # A targeted text edit, not a JSON round-trip: re-serializing would reformat
  # the whole committed config as a side effect of changing one number.
  python3 - "$TAURI_CONF" "$OLD_BUILD" "$NEW_BUILD" <<'PY'
import json, re, sys
path, old, new = sys.argv[1], sys.argv[2], sys.argv[3]
text = open(path).read()
pattern = r'("bundleVersion"\s*:\s*")' + re.escape(old) + r'(")'
text, n = re.subn(pattern, r'\g<1>' + new + r'\g<2>', text)
if n != 1:
    sys.exit(f"expected exactly one bundleVersion to replace, found {n}")
json.loads(text)  # refuse to write a config that stopped parsing
open(path, "w").write(text)
PY
  echo "bundleVersion $OLD_BUILD -> $NEW_BUILD (commit this with the release)"
fi

BUILD_NUMBER=$(python3 -c "
import json; print(json.load(open('$TAURI_CONF'))['bundle']['macOS']['bundleVersion'])")

# ---------------------------------------------------------------- build

if (( CLEAN )); then
  step "Clean"
  # Only the release profile for the three macOS targets, so dev builds and the
  # dependency cache survive. This is the "fresh target dir per upload" rule.
  for t in universal-apple-darwin aarch64-apple-darwin x86_64-apple-darwin; do
    rm -rf "src-tauri/target/$t/release"
    echo "removed src-tauri/target/$t/release"
  done
fi

# Always clear the bundle output, so a failed build cannot leave the previous
# app in place for the verification below to pass on.
rm -rf "$OUT_DIR"

# Neither build command is restated here: the package.json scripts own them,
# including which entitlements file gets signed and whether the profile is
# embedded. build:mas:distribution also regenerates
# Entitlements.distribution.plist from $TEAM_ID.
if (( LOCAL )); then
  step "Build (universal, sandboxed, locally launchable)"
  pnpm build:mas:local
else
  step "Build (universal, sandboxed, distribution-signed)"
  pnpm build:mas:distribution
fi

# ---------------------------------------------------------------- verify

step "Verify the bundle"

[[ -d "$APP" ]] || fail "the build produced no $APP"

# 1. The embedded profile: required in the submission build, forbidden in the
#    local one. A production profile in a locally signed app is exactly what
#    makes macOS refuse to launch it, so this is not tidiness -- it is the check
#    that the app under test can run at all.
EMBEDDED="$APP/Contents/embedded.provisionprofile"
if (( LOCAL )); then
  [[ ! -e "$EMBEDDED" ]] || fail "the local build embedded a provisioning
      profile. A Mac App Store profile names no devices, so this Mac cannot
      launch what it authorises. Only tauri.mas.distribution.conf.json should
      embed one."
  echo "ok   no embedded profile, so this Mac will launch it"
else
  [[ -f "$EMBEDDED" ]] || fail "$EMBEDDED is missing; the app cannot be uploaded"
  cmp -s "$EMBEDDED" "$PROFILE" \
    || fail "the embedded profile differs from $PROFILE"
  echo "ok   embedded.provisionprofile matches $PROFILE"
fi

# 2. Signature.
codesign --verify --deep --strict --verbose=2 "$APP" 2>&1 | sed 's/^/     /'
echo "ok   signature verifies"

AUTHORITY=$(codesign -dvvv "$APP" 2>&1 | sed -nE 's/^Authority=(.*)$/\1/p' | head -1)
[[ "$AUTHORITY" == "$APPLE_SIGNING_IDENTITY" ]] \
  || fail "signed by '$AUTHORITY', expected '$APPLE_SIGNING_IDENTITY'"
echo "ok   signing authority $AUTHORITY"

# 3. Entitlements, read back off the signed app. The submission build is checked
#    as a whole against the generated distribution list, which is in turn
#    checked against the one committed source plus exactly the two identifier
#    keys; the local build is checked against that committed source alone, which
#    is also what proves it has none of the restricted entitlements that would
#    stop it launching. No list is restated here, so neither check can drift
#    from what the sandbox check tests.
ENT_DUMP=$(mktemp "${TMPDIR:-/tmp}/pudding-ent.XXXXXX")
trap 'rm -f "$ENT_DUMP"' EXIT
codesign -d --entitlements - --xml "$APP" >"$ENT_DUMP" 2>/dev/null \
  || codesign -d --entitlements :- "$APP" >"$ENT_DUMP" 2>/dev/null \
  || fail "could not read the entitlements back off $APP"

python3 - "$MODE" "$BASE_ENT" "$DIST_ENT" "$ENT_DUMP" "$TEAM_ID" "$BUNDLE_ID" <<'PY'
import plistlib, sys

mode, base_p, dist_p, signed_p, team, bundle = sys.argv[1:7]

def load(path):
    with open(path, "rb") as f:
        data = f.read()
    start = data.find(b"<?xml")          # codesign may prefix its own header
    if start > 0:
        data = data[start:]
    return plistlib.loads(data)

base, signed = load(base_p), load(signed_p)

def diff(label, got, want):
    problems = []
    for k in sorted(set(want) | set(got)):
        if k not in got:
            problems.append(f"{label} is missing {k} = {want[k]!r}")
        elif k not in want:
            problems.append(f"{label} has unexpected {k} = {got[k]!r}")
        elif got[k] != want[k]:
            problems.append(f"{label} has {k} = {got[k]!r}, expected {want[k]!r}")
    return problems

if mode == "local":
    # The committed list and nothing besides. The two identifier keys are
    # RESTRICTED entitlements: with no profile to authorise them the kernel
    # refuses to exec the app, so their absence is what makes this build
    # testable rather than a detail of it.
    problems = diff("the signed app", signed, base)
    summary = f"ok   {len(signed)} entitlements match {base_p} exactly, sandbox on"
else:
    expected = dict(base)
    expected["com.apple.application-identifier"] = f"{team}.{bundle}"
    expected["com.apple.developer.team-identifier"] = team
    dist = load(dist_p)
    problems = diff("the generated distribution list", dist, expected)
    problems += diff("the signed app", signed, dist)
    summary = (f"ok   {len(signed)} entitlements match, sandbox on, "
               f"application-identifier {expected['com.apple.application-identifier']}")

if problems:
    for p in problems:
        print(f"FAIL: {p}", file=sys.stderr)
    sys.exit(1)

# Stated separately from the comparison above: losing the sandbox is the one
# failure that would sign, upload, launch and run, and only fail in review.
if signed.get("com.apple.security.app-sandbox") is not True:
    sys.exit("FAIL: the signed app is NOT sandboxed")

print(summary)
PY

# 4. Both architectures. A missing rustup target is caught in preflight, but a
#    lipo that silently produced one slice is not.
BIN=$(ls "$APP/Contents/MacOS/" | head -1)
ARCHS=$(lipo -archs "$APP/Contents/MacOS/$BIN")
for arch in arm64 x86_64; do
  grep -qw "$arch" <<<"$ARCHS" || fail "$BIN is missing $arch (got: $ARCHS)"
done
echo "ok   universal binary $BIN ($ARCHS)"

# 5. Info.plist, as merged into the built app.
python3 - "$APP/Contents/Info.plist" "$MARKETING_VERSION" "$BUILD_NUMBER" <<'PY'
import plistlib, sys

path, version, build = sys.argv[1], sys.argv[2], sys.argv[3]
with open(path, "rb") as f:
    info = plistlib.load(f)

problems = []

def want(key, value):
    if info.get(key) != value:
        problems.append(f"{key} = {info.get(key)!r}, expected {value!r}")

want("CFBundleShortVersionString", version)
want("CFBundleVersion", build)
want("LSApplicationCategoryType", "public.app-category.music")
want("ITSAppUsesNonExemptEncryption", False)

# Pudding appears in "Open With" and never seizes the system default. Tauri's
# generated fileAssociations hardcode LSHandlerRank=Default, so src-tauri's own
# Info.plist overrides them — and if that override ever loses the merge, the
# first launch of a release build takes mp3 away from Music. Silent, and only
# visible on a real user's machine, so it is checked on the merged result.
types = info.get("CFBundleDocumentTypes") or []
if not types:
    problems.append("CFBundleDocumentTypes is empty; file associations were lost")
for t in types:
    rank = t.get("LSHandlerRank")
    if rank != "Alternate":
        name = t.get("CFBundleTypeName", "?")
        problems.append(f"{name} has LSHandlerRank={rank!r}, expected 'Alternate'")

if problems:
    for p in problems:
        print(f"FAIL: {p}", file=sys.stderr)
    sys.exit(1)

print(f"ok   Info.plist: {version} ({build}), category Music, "
      f"{len(types)} document types all Alternate")
PY

# ---------------------------------------------------------------- package

if (( MAKE_PKG )); then
  step "Package"
  rm -f "$PKG"
  xcrun productbuild \
    --sign "$INSTALLER_SIGNING_IDENTITY" \
    --component "$APP" /Applications \
    "$PKG"
  pkgutil --check-signature "$PKG" | sed 's/^/     /'
  echo "ok   $PKG"
fi

if (( INSTALL )); then
  step "Install"
  # There is no .pkg in this mode, and nothing is given up by copying instead
  # of installing one. A package has no install scripts, declares
  # postinstall-action="none", and its entire payload is this one bundle, so
  # installer(8) and this copy would place the identical app in the identical
  # place -- except that installer(8) also obeys the package's <relocate> entry
  # and would put it over some other copy of com.incompl.pudding. The header
  # has the full account.
  #
  # ditto, not cp: it is the tool that reproduces a bundle exactly, including
  # xattrs, ACLs and resource forks, so the copy's signature still verifies.
  INSTALLED="/Applications/$(basename "$APP")"
  BUILT_CDHASH=$(codesign -dvvv "$APP" 2>&1 | sed -nE 's/^CDHash=([0-9a-f]+)$/\1/p' | head -1)
  [[ -n "$BUILT_CDHASH" ]] || fail "could not read the CDHash of $APP"

  # A guard, because the next command is `sudo rm -rf`. $INSTALLED is derived,
  # so this can only fail if something above changed, and the cost of being
  # wrong here is somebody else's /Applications.
  [[ "$INSTALLED" == /Applications/*.app ]] || fail \
    "refusing to remove '$INSTALLED': not an app bundle in /Applications"

  echo "installing $APP to $INSTALLED"
  echo "(sudo asks for $(id -un)'s password on this terminal)"
  # Replaced rather than copied over: a stale file from an older build that no
  # longer ships would otherwise survive inside the bundle and be signed for.
  sudo rm -rf "$INSTALLED"
  sudo ditto "$APP" "$INSTALLED"
  # ditto run under sudo keeps the source's ownership, which would leave the
  # app owned by the building user. A store-installed app is root:wheel.
  sudo chown -R root:wheel "$INSTALLED"

  [[ -d "$INSTALLED" ]] || fail "$INSTALLED does not exist after the copy"

  # The installed copy is read back rather than assumed -- the same rule as
  # every other check here, and the check that caught the relocation above.
  INSTALLED_CDHASH=$(codesign -dvvv "$INSTALLED" 2>&1 \
    | sed -nE 's/^CDHash=([0-9a-f]+)$/\1/p' | head -1)
  [[ "$INSTALLED_CDHASH" == "$BUILT_CDHASH" ]] || fail \
    "$INSTALLED is not the app that was just built: CDHash $INSTALLED_CDHASH,
      expected $BUILT_CDHASH. The copy did not land, so section 15 would test
      the wrong app."
  codesign --verify --strict --deep "$INSTALLED" 2>/dev/null || fail \
    "$INSTALLED does not verify after being copied in. The bundle was damaged
      in transit, so it is not the app that was just built."
  echo "ok   installed $INSTALLED ($BUILT_CDHASH)"
fi

# ---------------------------------------------------------------- summary

step "Done"
echo "app              $APP"
if (( LOCAL )); then
  echo "build            local: sandboxed, launches here, NOT uploadable"
else
  echo "build            submission: uploadable, will NOT launch here"
fi
if (( MAKE_PKG )); then echo "pkg              $PKG"; fi
echo "version          $MARKETING_VERSION ($BUILD_NUMBER)"
echo "team             $TEAM_ID"
echo
echo "Next:"
if (( SUBMIT )); then
  echo "  * Commit the bundleVersion bump with the release."
  echo "  * Upload the .pkg with Transporter or xcrun altool, then select the"
  echo "    processed build in App Store Connect. See src-tauri/MAS-BUILD.md."
  echo "  * This app will not launch on this Mac, by design: it is signed"
  echo "    against a profile that names no devices. --install builds the one"
  echo "    that does."
  echo "  * Apple re-signs the app and injects the store receipt as it"
  echo "    processes the upload, so test anything that reads the receipt"
  echo "    through TestFlight — no build here can reproduce it."
elif (( INSTALL )); then
  echo "  * Test the installed app — apps/desktop/test-plan.md section 15."
  echo "  * Same code, same sandbox and same entitlements as the submission"
  echo "    build, which differs only in the two identifier entitlements and"
  echo "    the embedded profile. Once this passes, re-run with --submit."
else
  echo "  * This build will not launch on this Mac, by design. Run again with"
  echo "    --install to build and install the one that will — test-plan.md"
  echo "    section 15."
  if (( MAKE_PKG )); then
    echo "  * Once it passes, re-run with --submit to prepare the upload."
    echo "    See src-tauri/MAS-BUILD.md."
  fi
fi
