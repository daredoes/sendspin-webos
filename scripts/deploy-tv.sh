#!/bin/sh
# deploy-tv.sh — build + install the Sendspin Cinema IPK onto a webOS TV over SSH.
#
# WHY THIS EXISTS
#   `ares-install -d <device>` needs the LG dev-mode SSH *key*, which often isn't
#   loaded (it failed with "All configured authentication methods failed"). This
#   script instead uses plain root SSH (dev-mode root password, classically
#   'alpine') + the on-TV dev install Luna service, which is reliable.
#
# GOTCHAS BAKED IN (learned the hard way — don't re-derive these):
#   - luna-send -i streams its install status ONLY over a real PTY. Without
#     `ssh -tt` the call returns EXIT=0 but installs NOTHING and prints nothing.
#   - The TV's busybox `timeout` syntax VARIES by firmware: older builds want
#     `timeout -t SECONDS` (GNU `timeout 25 cmd` errors with "can't execute '25'"),
#     newer builds (busybox >=1.30) want GNU `timeout SECONDS` and reject `-t`.
#     We probe with `timeout 1 true` and pick the right form per TV.
#   - dev/install reads the ipk from the TV's filesystem, so scp it to
#     /media/developer first; ipkUrl must be that on-device path.
#   - busybox `ls` has no --time-style/--full-time-friendly flags worth relying
#     on; use plain `ls -l` and size to confirm a fresh copy landed.
#
# USAGE
#   scripts/deploy-tv.sh [HOST] [PASSWORD]
#   TV_HOST=192.168.1.32 TV_PASS=alpine scripts/deploy-tv.sh
#   SKIP_BUILD=1 scripts/deploy-tv.sh        # reuse the existing dist/*.ipk
#
set -e

HOST="${1:-${TV_HOST:-192.168.1.32}}"
PASS="${2:-${TV_PASS:-alpine}}"
APP_ID="${APP_ID:-com.sendspin.cinema}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APPDIR="/media/developer/apps/usr/palm/applications/$APP_ID"
REMOTE_IPK="/media/developer/${APP_ID}.deploy.ipk"

SSH_OPTS="-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null"
ssh_run()  { sshpass -p "$PASS" ssh  $SSH_OPTS "root@$HOST" "$@"; }
ssh_tty()  { sshpass -p "$PASS" ssh -tt $SSH_OPTS "root@$HOST" "$@"; }
ssh_scp()  { sshpass -p "$PASS" scp $SSH_OPTS "$1" "root@$HOST:$2"; }

command -v sshpass >/dev/null || { echo "[deploy] need sshpass (brew install sshpass)"; exit 1; }

# 1. Build (unless told to reuse the existing artifact).
if [ "$SKIP_BUILD" != "1" ]; then
  echo "[deploy] building IPK"
  ( cd "$ROOT" && ./package-ipk.sh >/dev/null )
fi

IPK="$(ls -t "$ROOT"/dist/*.ipk 2>/dev/null | head -1)"
[ -n "$IPK" ] || { echo "[deploy] no IPK in dist/ — run without SKIP_BUILD"; exit 1; }
echo "[deploy] artifact: $IPK"

# 2. Copy it to the TV.
echo "[deploy] scp -> $HOST:$REMOTE_IPK"
ssh_scp "$IPK" "$REMOTE_IPK" >/dev/null

# 3. Install via the dev Luna service. ssh -tt is mandatory (see header).
#    Probe the TV's busybox timeout syntax (varies by firmware) and use it.
echo "[deploy] installing $APP_ID (streaming status)…"
INSTALL_CMD="if timeout 1 true 2>/dev/null; then TO='timeout 90'; else TO='timeout -t 90'; fi; \
\$TO luna-send -i -f luna://com.webos.appInstallService/dev/install \
'{\"id\":\"$APP_ID\",\"ipkUrl\":\"$REMOTE_IPK\",\"subscribe\":true}'"
OUT="$(ssh_tty "$INSTALL_CMD" 2>&1 | tr -d '\r')"

# Show only the meaningful state transitions, not every byte of the stream.
echo "$OUT" | grep -o '"state": "[^"]*"' | awk '!seen[$0]++ { print "   • " $0 }'

# 4. Verdict + cleanup.
ssh_run "rm -f '$REMOTE_IPK'" >/dev/null 2>&1 || true

if echo "$OUT" | grep -q '"state": "installed"'; then
  SIZE="$(ssh_run "ls -l '$APPDIR/index.html' 2>/dev/null | awk '{print \$5}'" | tr -d '\r')"
  echo "[deploy] ✅ installed — index.html now ${SIZE:-?} bytes on TV"
  echo "[deploy] relaunch the app on the TV to load the new build."
else
  echo "[deploy] ❌ did not reach state \"installed\" — full stream:"
  echo "$OUT"
  exit 1
fi
