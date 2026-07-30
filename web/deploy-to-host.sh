#!/usr/bin/env bash
#
# Installs the built web client where the Mac host serves it from.
#
# The host looks in three places (see Config.webRoot); this fills the middle one,
# ~/.config/vibewire/web, which is the copy an installed host uses. Running the host
# straight out of the checkout needs none of this — it finds web/dist by itself.
#
# After this, http://<mac>:8787/ serves the client on the same origin as the
# protocol, which is the only way to use it over Tailscale or the LAN: a page on
# https:// may not open ws://, so the GitHub Pages copy can only reach the Mac
# through the Cloudflare tunnel.

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
target="${VIBEWIRE_WEB_ROOT:-$HOME/.config/vibewire/web}"

if [ ! -f "$here/dist/index.html" ]; then
  echo "no build to install — run 'npm ci && npm run build' in $here first" >&2
  exit 1
fi

mkdir -p "$target"

# Mirror, so a rename in a fingerprinted asset does not leave the old file behind to
# be served forever under an immutable cache header.
if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete "$here/dist/" "$target/"
else
  rm -rf "${target:?}/"*
  cp -R "$here/dist/." "$target/"
fi

echo "installed $(find "$target" -type f | wc -l | tr -d ' ') files to $target"
echo "restart the host, then open http://<this-mac>:8787/"
