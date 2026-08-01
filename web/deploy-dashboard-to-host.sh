#!/usr/bin/env bash
#
# Installs the built Mac dashboard where the host serves it from.
#
# The sibling of deploy-to-host.sh, and the same three-place resolution: the host
# looks at VIBEWIRE_DASHBOARD_ROOT, then ~/.config/vibewire/dashboard, then
# <checkout>/web/dist-dashboard. This fills the middle one, which is what an
# installed host uses. A host run straight out of the checkout needs none of it —
# it finds web/dist-dashboard by itself.
#
# The dashboard is the host's own window: it is served on a per-launch secret path
# and reached from the menu bar, never from a bookmark. Nothing here needs to know
# that path.

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
target="${VIBEWIRE_DASHBOARD_ROOT:-$HOME/.config/vibewire/dashboard}"

if [ ! -f "$here/dist-dashboard/index.html" ]; then
  echo "no dashboard build to install — run 'npm ci && npm run build:dashboard' in $here first" >&2
  exit 1
fi

mkdir -p "$target"

# Mirror, so a rename in a fingerprinted asset does not leave the old file behind
# to be served forever under an immutable cache header.
if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete "$here/dist-dashboard/" "$target/"
else
  rm -rf "${target:?}/"*
  cp -R "$here/dist-dashboard/." "$target/"
fi

echo "installed $(find "$target" -type f | wc -l | tr -d ' ') files to $target"
echo "restart the host, then open it from the menu bar: VibeWire → Open VibeWire"
