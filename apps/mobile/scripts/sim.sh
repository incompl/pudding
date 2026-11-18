#!/bin/sh
# Build Pudding Mobile and run it in the iOS Simulator.
#
#   pnpm sim        bundle the web build into the app (what ships)
#   pnpm sim:dev    load the Vite dev server instead; start `pnpm dev` first.
#                   Edits to src/ then show up on reload, with no rebuild.
#
# PUDDING_SIM=<device name or UDID> picks the simulator; by default it's the
# newest iPhone available.
set -eu
cd "$(dirname "$0")/.."

dev=0
[ "${1:-}" = "--dev" ] && dev=1
dev_url="http://localhost:5174/"

if [ "$dev" = 1 ]; then
  curl -sf -o /dev/null "$dev_url" || {
    echo "No dev server at $dev_url; run 'pnpm --filter @pudding/mobile dev' first." >&2
    exit 1
  }
else
  pnpm build
fi

device="${PUDDING_SIM:-}"
if [ -z "$device" ]; then
  device=$(xcrun simctl list devices available -j | node -e '
    const { devices } = JSON.parse(require("fs").readFileSync(0, "utf8"));
    const ios = Object.keys(devices).filter((r) => r.includes("iOS")).sort().reverse();
    for (const r of ios) {
      const phone = devices[r].find((d) => d.name.startsWith("iPhone"));
      if (phone) { console.log(phone.udid); process.exit(0); }
    }
    process.exit(1);
  ') || {
    echo "No iPhone simulator found. Install one: xcodebuild -downloadPlatform iOS" >&2
    exit 1
  }
fi

xcodebuild -quiet \
  -project ios/PuddingMobile.xcodeproj \
  -target PuddingMobile \
  -configuration Debug \
  -sdk iphonesimulator \
  ARCHS=arm64 \
  SYMROOT="$PWD/ios/build"

app="ios/build/Debug-iphonesimulator/PuddingMobile.app"
bundle_id=$(/usr/libexec/PlistBuddy -c "Print CFBundleIdentifier" "$app/Info.plist")

xcrun simctl boot "$device" 2>/dev/null || true  # already booted is fine
open -a Simulator
xcrun simctl install "$device" "$app"
if [ "$dev" = 1 ]; then
  # simctl hands SIMCTL_CHILD_* variables to the app with the prefix dropped.
  SIMCTL_CHILD_PUDDING_DEV_URL="$dev_url" xcrun simctl launch --terminate-running-process "$device" "$bundle_id"
else
  xcrun simctl launch --terminate-running-process "$device" "$bundle_id"
fi
