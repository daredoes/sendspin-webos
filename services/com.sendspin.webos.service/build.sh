#!/bin/sh
# build.sh — produce the shippable, node-8-compatible service tree.
#
#   1. install runtime deps (pure-JS ws; --no-optional skips native addons so the
#      tree stays portable to the TV's armv7 softfp node 8).
#   2. regenerate the ESM core entry from sendspin-lib.js (build-core.mjs).
#   3. transpile+bundle it to node8.12 CommonJS (sendspin-core.js) via esbuild.
#
# Requires a host with node + npx (run on the dev machine, not the TV).
set -e
cd "$(dirname "$0")"

echo "[build] installing runtime deps (ws, no native optional addons)"
npm install --no-optional --no-audit --no-fund

echo "[build] regenerating src/sendspin-core.entry.mjs from ../../sendspin-lib.js"
node build-core.mjs

echo "[build] bundling -> sendspin-core.js (cjs, target node8.12)"
npx --yes esbuild@0.21.5 src/sendspin-core.entry.mjs \
  --bundle --platform=node --format=cjs --target=node8.12 \
  --outfile=sendspin-core.js

echo "[build] done. node --check:"
node --check sendspin-core.js && echo "[build] sendspin-core.js OK"
