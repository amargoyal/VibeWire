#!/usr/bin/env bash
#
# Builds the host as VibeWire.app and installs it to /Applications.
#
# `swift build` produces a bare Mach-O executable. macOS will happily run one,
# but Spotlight and Finder only know about applications that are bundles, so a
# host started that way can never be found by typing its name — it exists only
# as a path someone has to remember. This wraps the same binary in the bundle
# macOS is looking for.
#
# The signature matters as much as the bundle. Screen Recording and
# Accessibility are granted to a code signature, not to a path, so an unsigned
# or ad-hoc-signed binary is a different app to TCC after every rebuild and asks
# for both permissions again. Signing with a real Apple Development certificate
# gives the app one stable identity, and the grants survive.
#
#   ./package-app.sh                 build, sign, install to /Applications
#   ./package-app.sh --no-install    leave the bundle in host/build/
#   ./package-app.sh --debug         package the debug build (faster to make)
#
# VIBEWIRE_SIGN_IDENTITY overrides the certificate; if no certificate is found
# the script falls back to an ad-hoc signature and says what that costs.

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"

configuration=release
install=1

while [ $# -gt 0 ]; do
  case "$1" in
    --debug)      configuration=debug ;;
    --release)    configuration=release ;;
    --no-install) install=0 ;;
    -h|--help)    sed -n '2,25p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)            echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

bundle_id="com.vibewire.host"
staging="$here/build/VibeWire.app"
installed="/Applications/VibeWire.app"

# One source of truth for the version: the Swift constant the host already
# reports over the wire. A second copy in a plist would drift.
version="$(sed -n 's/.*static let hostVersion = "\([^"]*\)".*/\1/p' \
  "$here/Sources/VibeWireHost/Core/Config.swift" | head -1)"
if [ -z "$version" ]; then
  echo "could not read hostVersion from Core/Config.swift" >&2
  exit 1
fi

# ---------------------------------------------------------------- build

echo "building ${configuration}…"
swift build --package-path "$here" -c "$configuration"
binary="$(swift build --package-path "$here" -c "$configuration" --show-bin-path)/VibeWireHost"
if [ ! -x "$binary" ]; then
  echo "no binary at $binary" >&2
  exit 1
fi

# ---------------------------------------------------------------- assemble

rm -rf "$staging"
mkdir -p "$staging/Contents/MacOS" "$staging/Contents/Resources"

# The staging copy is a build artefact, and Spotlight indexes application
# bundles wherever it finds them — without this, typing "VibeWire" offers two
# apps and the wrong one is as likely to be picked as the installed one.
touch "$here/build/.metadata_never_index"

# CFBundleExecutable says VibeWire, so the process is called VibeWire in
# Activity Monitor and in the permission prompts rather than VibeWireHost.
cp "$binary" "$staging/Contents/MacOS/VibeWire"
sed "s/__VERSION__/$version/g" "$here/Resources/Info.plist" \
  > "$staging/Contents/Info.plist"
printf 'APPL????' > "$staging/Contents/PkgInfo"

# The icon: one 1024 master, resampled to the sizes the Finder asks for. The
# @2x entries are not duplicates — macOS picks between them by display scale.
iconset="$(mktemp -d)/AppIcon.iconset"
mkdir -p "$iconset"
for size in 16 32 128 256 512; do
  sips -z $size $size "$here/Resources/AppIcon.png" \
    --out "$iconset/icon_${size}x${size}.png" >/dev/null
  sips -z $((size * 2)) $((size * 2)) "$here/Resources/AppIcon.png" \
    --out "$iconset/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$iconset" -o "$staging/Contents/Resources/AppIcon.icns"
rm -rf "$(dirname "$iconset")"

# The web client and the dashboard, if they have been built. Config.webRoot and
# Config.dashboardRoot look inside the bundle last, after the checkout, so this
# changes nothing for a host run out of the tree — it is what keeps the copy in
# /Applications working if the checkout is ever moved or deleted.
for pair in "dist:web" "dist-dashboard:dashboard"; do
  source_dir="$root/web/${pair%%:*}"
  if [ -f "$source_dir/index.html" ]; then
    cp -R "$source_dir" "$staging/Contents/Resources/${pair##*:}"
    echo "bundled web/${pair%%:*}"
  else
    echo "skipped web/${pair%%:*} — not built"
  fi
done

# ---------------------------------------------------------------- sign

identity="${VIBEWIRE_SIGN_IDENTITY:-}"
if [ -z "$identity" ]; then
  identity="$(security find-identity -v -p codesigning 2>/dev/null \
    | sed -n 's/.*"\(Developer ID Application:.*\)"/\1/p' | head -1)"
fi
if [ -z "$identity" ]; then
  identity="$(security find-identity -v -p codesigning 2>/dev/null \
    | sed -n 's/.*"\(Apple Development:.*\)"/\1/p' | head -1)"
fi

if [ -z "$identity" ]; then
  echo "no signing certificate found — signing ad-hoc"
  echo "  Screen Recording and Accessibility will have to be granted again after every rebuild."
  codesign --force --sign - --identifier "$bundle_id" "$staging"
else
  echo "signing as: $identity"
  codesign --force --options runtime --sign "$identity" \
    --identifier "$bundle_id" "$staging"
fi
codesign --verify --strict "$staging"

# ---------------------------------------------------------------- install

if [ "$install" -eq 0 ]; then
  echo
  echo "built $staging (not installed)"
  exit 0
fi

# Replace only a bundle that is actually this app. Anything else sharing the
# name in /Applications is someone else's and is not this script's to delete.
if [ -e "$installed" ]; then
  existing="$(defaults read "$installed/Contents/Info" CFBundleIdentifier 2>/dev/null || true)"
  if [ "$existing" != "$bundle_id" ]; then
    echo "$installed exists and is not $bundle_id — refusing to replace it" >&2
    exit 1
  fi
  # A running copy holds its own binary open; replacing it underneath would
  # leave a half-updated bundle and a process from the old one.
  if pgrep -f "$installed/Contents/MacOS/VibeWire" >/dev/null 2>&1; then
    echo "quitting the running VibeWire…"
    osascript -e 'tell application id "com.vibewire.host" to quit' 2>/dev/null || \
      pkill -f "$installed/Contents/MacOS/VibeWire" || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      pgrep -f "$installed/Contents/MacOS/VibeWire" >/dev/null 2>&1 || break
      sleep 0.5
    done
  fi
  rm -rf "$installed"
fi

cp -R "$staging" "$installed"

# Spotlight picks up /Applications on its own, but not always within the few
# seconds someone spends typing the name right after running this.
mdimport "$installed" 2>/dev/null || true

echo
echo "installed $installed ($version)"
echo "open it from Spotlight or Finder — it runs in the menu bar, with no Dock icon."
if [ -n "$identity" ]; then
  echo "the first launch will ask for Screen Recording and Accessibility once; the grants stick from then on."
else
  echo "grant Screen Recording and Accessibility to VibeWire.app in System Settings › Privacy & Security."
fi
