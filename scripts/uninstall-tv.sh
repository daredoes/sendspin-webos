#!/bin/sh
# uninstall-tv.sh — remove a Sendspin app from a webOS TV over root SSH.
#
# Mainly the migration helper for the package rename: the old app id
# (com.sendspin.cinema) stays installed after switching to
# com.sendspin.webos, so remove it once. Defaults to the OLD id.
#
# Same SSH approach + gotchas as deploy-tv.sh (ssh -tt for the streamed Luna
# response; busybox `timeout` syntax varies by firmware).
#
# Usage:
#   scripts/uninstall-tv.sh [HOST] [PASSWORD] [APP_ID]
#   TV_HOST=192.168.1.32 TV_PASS=alpine scripts/uninstall-tv.sh
#   TV_KEY=~/.ssh/lgtv scripts/uninstall-tv.sh   # key auth (default when ~/.ssh/lgtv exists)
#
set -e
HOST="${1:-${TV_HOST:-192.168.1.32}}"
PASS="${2:-${TV_PASS:-alpine}}"
APP_ID="${3:-${APP_ID:-com.sendspin.cinema}}"
KEY="${TV_KEY:-$HOME/.ssh/lgtv}"
SSH_OPTS="-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null"
if [ -f "$KEY" ]; then
  tv_tty() { ssh -tt $SSH_OPTS -i "$KEY" -o IdentitiesOnly=yes -o BatchMode=yes "root@$HOST" "$@"; }
else
  command -v sshpass >/dev/null || { echo "[uninstall] no key at $KEY and no sshpass (brew install sshpass)"; exit 1; }
  tv_tty() { sshpass -p "$PASS" ssh -tt $SSH_OPTS "root@$HOST" "$@"; }
fi

echo "[uninstall] removing $APP_ID from $HOST"
REMOVE_CMD="if timeout 1 true 2>/dev/null; then TO='timeout 60'; else TO='timeout -t 60'; fi; \
\$TO luna-send -i -f luna://com.webos.appInstallService/dev/remove '{\"id\":\"$APP_ID\",\"subscribe\":true}'"
OUT="$(tv_tty "$REMOVE_CMD" 2>&1 | tr -d '\r')"
echo "$OUT" | grep -o '"state": "[^"]*"\|"statusValue": [0-9]*' | awk '!seen[$0]++ { print "   • " $0 }'

if echo "$OUT" | grep -qi 'removed\|"returnValue": *false.*not.*exist\|FAILED_REMOVE'; then
  echo "[uninstall] done (or already absent)."
else
  echo "[uninstall] stream:"; echo "$OUT"
fi
