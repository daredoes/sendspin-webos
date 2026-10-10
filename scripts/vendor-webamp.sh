#!/bin/sh
# vendor-webamp.sh — refresh vendor/webamp.bundle.js from the webamp npm package.
#
# The published bundle uses syntax (optional chaining, ??) newer than the
# Chromium 79 in webOS 6, so it is re-emitted for chrome79 with esbuild.
# Usage: scripts/vendor-webamp.sh [version]   (default 2.3.1)
set -e
VER="${1:-2.3.1}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

( cd "$TMP" && npm pack "webamp@$VER" --silent >/dev/null && tar xzf webamp-*.tgz )
mkdir -p "$ROOT/vendor"
npx -y esbuild@0.24.0 "$TMP/package/built/webamp.bundle.min.js" \
  --target=chrome79 --minify --legal-comments=inline \
  --outfile="$ROOT/vendor/webamp.bundle.js" --log-level=warning
cp "$TMP/package/README.md" "$ROOT/vendor/webamp.README.md"
echo "vendored webamp@$VER -> vendor/webamp.bundle.js ($(wc -c < "$ROOT/vendor/webamp.bundle.js") bytes)"
