#!/bin/sh
# Build Pudding Mobile and run it in the iOS Simulator.
#
# PUDDING_SIM=<device name or UDID> picks the simulator; by default it's the
# newest iPhone available.
set -eu
cd "$(dirname "$0")/.."

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
xcrun simctl launch --terminate-running-process "$device" "$bundle_id"
