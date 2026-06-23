#!/bin/sh
# check-ids.sh — guard against package-ID drift. Fails (non-zero) if:
#   1. the old "com.sendspin.cinema" id reappears in functional files,
#   2. the service id is not the app id + ".service",
#   3. appinfo.json and the service package.json versions disagree.
# Run from the repo root (npm run check:ids). POSIX sh.
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
fail=0

# 1. No lingering old id in functional files. docs/ keep the historical record;
#    the migration helpers (this script + uninstall-tv.sh) reference the old id on
#    purpose so they can remove a prior install.
HITS="$(grep -rIl 'com\.sendspin\.cinema' \
  --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=.ipk-stage \
  --exclude-dir=dist --exclude-dir=docs \
  --exclude=check-ids.sh --exclude=uninstall-tv.sh . || true)"
if [ -n "$HITS" ]; then
  echo "✗ old id 'com.sendspin.cinema' still present in:"; echo "$HITS" | sed 's/^/    /'
  fail=1
fi

# 2. service id must be "<appId>.service".
APP_ID="$(node -e "process.stdout.write(require('./appinfo.json').id)")"
SVC_ID="$(node -e "process.stdout.write(require('./services/${APP_ID}.service/services.json').id)")"
if [ "$SVC_ID" != "${APP_ID}.service" ]; then
  echo "✗ service id '$SVC_ID' is not '${APP_ID}.service'"
  fail=1
fi

# 3. versions must match.
APP_VER="$(node -e "process.stdout.write(require('./appinfo.json').version)")"
SVC_VER="$(node -e "process.stdout.write(require('./services/${APP_ID}.service/package.json').version)")"
if [ "$APP_VER" != "$SVC_VER" ]; then
  echo "✗ version drift: appinfo.json=$APP_VER service package.json=$SVC_VER"
  fail=1
fi

if [ "$fail" -eq 0 ]; then
  echo "✓ ids consistent: app=$APP_ID service=$SVC_ID version=$APP_VER"
fi
exit $fail
