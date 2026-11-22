#!/bin/sh
# Builds one small notifier app per backend, so macOS shows that backend's icon on
# lane alerts. Icons are copied from the apps already installed on this Mac, and
# nothing leaves it. Without these bundles, alerts fall back to osascript.
set -eu

[ "$(uname -s)" = Darwin ] || { echo "notifiers are macOS only; Linux uses notify-send" >&2; exit 1; }
case "$#:${1:-}" in
  0:|1:--no-request) ;;
  *) echo 'usage: install-notifiers.sh [--no-request]' >&2; exit 2 ;;
esac

here=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
dest=${DELEGATE_NOTIFIERS:-$HOME/Applications/Delegate}
lsregister=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

xcrun swiftc -O "$here/notifier/notifier.swift" -o "$work/notifier"

# app_path BUNDLE_ID: the installed app with this bundle id, if there is one
app_path() {
  mdfind "kMDItemCFBundleIdentifier == '$1'" 2>/dev/null | grep -m1 '\.app$' || true
}

# allow KEY DISPLAY_NAME: ask macOS for permission, waiting for the answer
allow() {
  echo "$2: click Allow on the notification macOS shows now. With Focus on, it is in Notification Center."
  if "$dest/$1.app/Contents/MacOS/notifier" --request; then
    echo "$2: allowed"
  else
    echo "$2: not allowed, or no answer in time, which macOS records as a refusal. Alerts use osascript until you turn it on in System Settings > Notifications."
  fi
}

# build KEY DISPLAY_NAME BACKEND_BUNDLE_ID ICON_NAMES...
build() {
  key=$1 display=$2 backend=$3
  shift 3
  app="$dest/$key.app"
  # Replace only a bundle this script made: DELEGATE_NOTIFIERS=/Applications would otherwise delete the real Claude.app.
  if [ -e "$app" ]; then
    id=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$app/Contents/Info.plist" 2>/dev/null || true)
    if [ "$id" != "io.github.ansumanshah.delegate.notifier.$key" ]; then
      echo "delegate: $app exists and is not a delegate notifier; refusing to replace it. Pick another DELEGATE_NOTIFIERS folder." >&2
      exit 1
    fi
  fi
  rm -rf "$app"
  mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources" "$app/Contents/Library/Sounds"
  cp "$work/notifier" "$app/Contents/MacOS/notifier"
  [ -f /System/Library/Sounds/Glass.aiff ] && cp /System/Library/Sounds/Glass.aiff "$app/Contents/Library/Sounds/"

  icon_key=""
  source=$(app_path "$backend")
  if [ -n "$source" ]; then
    for name in "$@"; do
      if [ -f "$source/Contents/Resources/$name" ]; then
        cp "$source/Contents/Resources/$name" "$app/Contents/Resources/AppIcon.icns"
        icon_key="<key>CFBundleIconFile</key><string>AppIcon</string>"
        break
      fi
    done
  fi

  cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>io.github.ansumanshah.delegate.notifier.$key</string>
<key>CFBundleName</key><string>$display</string>
<key>CFBundleDisplayName</key><string>$display</string>
<key>CFBundleExecutable</key><string>notifier</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>1.0</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSUIElement</key><true/>
$icon_key
</dict></plist>
PLIST

  if ! codesign --force --sign - "$app" >/dev/null 2>&1; then
    echo "$display: codesign failed, so this app was removed and its alerts use osascript" >&2
    rm -rf "$app"
    exit 1
  fi
  if ! "$lsregister" -f "$app"; then
    echo "$display: macOS couldn't register this app, so it was removed and its alerts use osascript" >&2
    rm -rf "$app"
    exit 1
  fi
  # System Settings only lists apps Spotlight can see, which rules out hidden folders
  mdimport "$app" 2>/dev/null || true
  if [ -n "$icon_key" ]; then echo "$display: $app"; else echo "$display: $app (no icon, $backend not installed)"; fi
}

build claude "Delegate Claude" com.anthropic.claudefordesktop electron.icns
build codex "Delegate Codex" com.openai.codex app.icns electron.icns
build gemini "Delegate Gemini" com.google.GeminiMacOS AppIcon.icns electron.icns
build agy "Delegate Antigravity" com.google.antigravity icon.icns AppIcon.icns electron.icns
if [ "$#" -eq 0 ]; then
  allow claude "Delegate Claude"
  allow codex "Delegate Codex"
  allow gemini "Delegate Gemini"
  allow agy "Delegate Antigravity"
fi
