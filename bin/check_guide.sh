#!/usr/bin/env bash
# Check the guide's examples and API reference against an installed package (site/check_guide.cjs):
# every TypeScript block of docs/guide/ is type-checked under strict, the blocks marked "run" are run in
# Node.js under consumers/node/offlineGuard.cjs (no network access), reference signatures must appear in
# the shipped declarations, and the reference must name exactly the package's public surface.
#
#   bin/check_guide.sh <directory with node_modules/@loki-notfound/zephyr-ts>
#
# The TypeScript compiler and the Node.js types come from the repository's own devDependencies
# (node_modules/typescript, node_modules/@types/node, installed by bin/build_ts.sh); set TYPESCRIPT_DIR to
# another directory that holds both. The scratch files go to build/guide-check/.
set -euo pipefail
. "$(dirname "$0")/pins.sh"
cd "$ROOT"
[ $# -eq 1 ] || die "usage: bin/check_guide.sh <directory with node_modules/@loki-notfound/zephyr-ts>"
[ -f "$1/node_modules/@loki-notfound/zephyr-ts/package.json" ] || die "no installed package under $1/node_modules/@loki-notfound/zephyr-ts"
TS_DIR=${TYPESCRIPT_DIR:-$ROOT}
[ -f "$TS_DIR/node_modules/typescript/package.json" ] || die "no TypeScript compiler under $TS_DIR/node_modules (run bin/build_ts.sh or set TYPESCRIPT_DIR)"
log "guide examples and reference"
node site/check_guide.cjs --package "$1" --typescript "$TS_DIR" --work "$ROOT/build/guide-check"
