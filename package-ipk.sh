#!/bin/sh
# package-ipk.sh — build a single webOS IPK containing the Sendspin Cinema app
# AND the background audio daemon service (com.sendspin.cinema.service).
#
# Stages clean app/ and service/ trees (so dev/build/test files, docs, native/,
# and the repo layout don't leak into the package), then runs ares-package.
#
# Requires a host with ares-cli + node/npx. Run from the repo root.
set -e
ROOT="$(cd "$(dirname "$0")" && pwd)"
SVC="$ROOT/services/com.sendspin.cinema.service"
STAGE="$ROOT/.ipk-stage"
DIST="$ROOT/dist"

# 1. Ensure the service is built: bundled `ws` + transpiled sendspin-core.js.
if [ ! -f "$SVC/sendspin-core.js" ] || [ ! -d "$SVC/node_modules/ws" ]; then
  echo "[pkg] building service (build.sh)"
  ( cd "$SVC" && ./build.sh )
fi

rm -rf "$STAGE"
mkdir -p "$STAGE/app" "$STAGE/service/node_modules" "$DIST"

# 2. Stage the app — only the runtime files appinfo.json points at.
cp "$ROOT/appinfo.json" \
   "$ROOT/index.html" \
   "$ROOT/sendspin-lib.js" \
   "$ROOT/Vibrant.min.js" \
   "$ROOT/icon.png" \
   "$STAGE/app/"

# 3. Stage the service — runtime files + bundled deps only. Explicitly omit
#    build.sh, build-core.mjs, src/, smoke-test.js, test-real-sink.js, .gitignore.
cp "$SVC/package.json" \
   "$SVC/services.json" \
   "$SVC/service.js" \
   "$SVC/sendspin-core.js" \
   "$SVC/node-env.js" \
   "$SVC/gst-sink.js" \
   "$SVC/ma-login.js" \
   "$STAGE/service/"
cp -R "$SVC/node_modules/ws" "$STAGE/service/node_modules/"

# 4. Validate, then package both into one IPK.
echo "[pkg] validating staged app + service"
ares-package --check "$STAGE/app" "$STAGE/service"
echo "[pkg] packaging -> $DIST"
# -n/--no-minify: the app ships sendspin-lib.js as a native ES module; terser
# (ares' bundled minifier) can't parse ESM import/export and aborts the build.
ares-package -n "$STAGE/app" "$STAGE/service" -o "$DIST"

echo "[pkg] done:"
ls -la "$DIST"/*.ipk
