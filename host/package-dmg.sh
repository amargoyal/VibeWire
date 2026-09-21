#!/usr/bin/env bash
# Build both web surfaces and a universal Mac app; package a drag-to-install DMG.
# Does not install or launch the app. Output stays under host/build/.
# Requires Xcode command line tools, Node/npm, and Python 3.9+.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"

npm ci --prefix "$root/web"
npm run build:all --prefix "$root/web"
"$here/package-app.sh" --release --universal --no-install
app="$here/build/VibeWire.app"
version=$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$app/Contents/Info.plist")
for asset in web dashboard; do
  test -f "$app/Contents/Resources/$asset/index.html"
done
architectures="$(lipo -archs "$app/Contents/MacOS/VibeWire")"
for required in arm64 x86_64; do
  case " $architectures " in
    *" $required "*) ;;
    *) echo "Missing required architecture: $required" >&2; exit 1 ;;
  esac
done
codesign --verify --strict "$app"

# Isolated, pinned tooling; never installs packages into the system Python.
python3 -m venv "$here/build/dmg-tools"
"$here/build/dmg-tools/bin/python" -m pip install -r "$here/dmg-requirements.txt"
cp "$here/Resources/Install.txt" "$here/build/Start here.txt"
dmg="$here/build/VibeWire-$version-mac-universal.dmg"
"$here/build/dmg-tools/bin/dmgbuild" -s "$here/dmg-settings.py" \
  -D "app=$app" -D "instructions=$here/build/Start here.txt" \
  "Install VibeWire" "$dmg"
hdiutil verify "$dmg"
shasum -a 256 "$dmg"
echo "Ready: $dmg"
echo "Distribution signing and Apple notarization are separate from DMG packaging."
