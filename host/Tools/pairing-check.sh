#!/bin/sh
# Pairs a simulated phone with a throwaway Mac host and prints what each end saw.
# The checks themselves are in VirtualPhone.swift.
#
#     host/Tools/pairing-check.sh
#
# The host it starts keeps its settings and devices in a temporary folder
# (VIBEWIRE_CONFIG_DIR) with its trust in files there (VIBEWIRE_SECRET_STORE=file),
# so the installed VibeWire, its devices and the login keychain are never touched.
# Accounts go to fake-account-server.mjs rather than the real project, and the web
# client it serves is built into the temporary folder pointed at the same place,
# so web/dist is left as it was. It listens on 8899 and 9955 unless
# VIBEWIRE_CHECK_PORT and VIBEWIRE_CHECK_ACCOUNTS_PORT say otherwise. It may open
# its own setup window while it runs.
set -eu

here=$(cd "$(dirname "$0")/.." && pwd)
repo=$(dirname "$here")
port=${VIBEWIRE_CHECK_PORT:-8899}
accounts_port=${VIBEWIRE_CHECK_ACCOUNTS_PORT:-9955}
accounts=http://127.0.0.1:$accounts_port
work=$(mktemp -d "${TMPDIR:-/tmp}/vibewire-pairing-check.XXXXXX")
host_pid=
accounts_pid=

finish() {
  if [ -n "$host_pid" ]; then kill "$host_pid" 2>/dev/null || true; fi
  if [ -n "$accounts_pid" ]; then kill "$accounts_pid" 2>/dev/null || true; fi
  rm -rf "$work"
}
trap finish EXIT

export DEVELOPER_DIR=${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}
echo "building"
(cd "$repo/web" && npx tsc --noEmit &&
  VITE_SUPABASE_URL="$accounts" VITE_SUPABASE_KEY=test \
    npx vite build --outDir "$work/web" --emptyOutDir >/dev/null)
(cd "$here" && swift build >/dev/null)
xcrun swiftc -O "$here/Tools/VirtualPhone.swift" -o "$work/VirtualPhone"

node "$here/Tools/fake-account-server.mjs" "$accounts_port" >"$work/accounts.log" 2>&1 &
accounts_pid=$!

VIBEWIRE_CONFIG_DIR="$work/config" \
VIBEWIRE_SECRET_STORE=file \
VIBEWIRE_WEB_ROOT="$work/web" \
VIBEWIRE_ACCOUNT_URL="$accounts" \
VIBEWIRE_ACCOUNT_KEY=test \
VIBEWIRE_DISABLE_CLAUDE=1 \
VIBEWIRE_VERBOSE=1 \
  "$here/.build/debug/VibeWireHost" --port "$port" --dashboard-url >"$work/url" 2>"$work/host.log" &
host_pid=$!

# The host writes its own key as it starts. One that did not write it into the
# temporary folder is using some other folder, possibly the installed app's,
# and nothing gets paired with it.
tries=0
until [ -s "$work/url" ] && [ -f "$work/config/host-identity.secret" ]; do
  tries=$((tries + 1))
  if [ "$tries" -gt 60 ] || ! kill -0 "$host_pid" 2>/dev/null; then
    echo "the test host did not start in $work/config; stopping before anything pairs" >&2
    tail -20 "$work/host.log" >&2
    exit 1
  fi
  sleep 0.5
done

status=0
VIRTUALPHONE_ACCOUNTS=1 "$work/VirtualPhone" "$(cat "$work/url")" || status=$?
echo
echo "host log"
grep -E "pair (accepted|rejected)|paired|folded|revoked|handshake complete|account|belongs" "$work/host.log" || true
exit "$status"
