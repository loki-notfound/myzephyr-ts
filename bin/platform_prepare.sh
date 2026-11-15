#!/usr/bin/env bash
# Prepare the platform tests on this machine from a packed tarball built elsewhere: no build, no
# WebAssembly compilation. Verifies the tarball's SHA-256, installs it into copies of the Node and
# Vite consumers (consumers/node, consumers/vite) from their lockfiles, checks that each installed
# package equals the tarball, and builds the Vite consumer (production build, no configuration
# file). The platform test scripts then use build/platform/.
#
# Usage: bin/platform_prepare.sh <package tarball> <file with its SHA-256 ("<hash>  <name>")>
# Environment (optional): OFFLINE=1 installs from the npm cache only.
# Runs on Linux, macOS and Windows (Git Bash) with Node.js and npm.
set -euo pipefail
. "$(dirname "$0")/pins.sh"
[ $# = 2 ] || die "usage: bin/platform_prepare.sh <tarball> <sha256 file>"
TGZ_IN=$1; SUM=$2
[ -s "$TGZ_IN" ] && [ -s "$SUM" ] || die "tarball or SHA-256 file missing"
TOOL=$ROOT/src/test/platform/platformTool.cjs
P=$ROOT/build/platform
log "platform: system, runtime and tarball"
node "$TOOL" env
node "$TOOL" verify "$TGZ_IN" "$SUM"
rm -rf "$P"; mkdir -p "$P/consumers" "$P/logs"
cp "$TGZ_IN" "$P/consumers/zephyr-ts.tgz"
node "$TOOL" verify "$P/consumers/zephyr-ts.tgz" "$SUM" > /dev/null
node "$TOOL" wasm-sha256 "$P/consumers/zephyr-ts.tgz" > "$P/wasm.sha256"
echo "module:   $(cat "$P/wasm.sha256")  dist/zephyr.wasm in the tarball"
offline=(); [ "${OFFLINE:-0}" = 1 ] && offline=(--offline) # expanded as ${a[@]+"${a[@]}"}: bash 3.2 (macOS) rejects an empty array under set -u
for c in node vite; do
  log "platform: install the $c consumer from its lockfile"
  cp -R "$ROOT/consumers/$c" "$P/consumers/$c"
  ( cd "$P/consumers/$c" && npm ci ${offline[@]+"${offline[@]}"} --omit=dev --ignore-scripts --no-audit --no-fund ) > "$P/logs/$c-install.log" 2>&1 \
    || { tail -n 20 "$P/logs/$c-install.log"; die "$c consumer: install failed"; }
  node "$TOOL" installed "$P/consumers/zephyr-ts.tgz" "$P/consumers/$c/node_modules/@loki-notfound/zephyr-ts" || die "$c consumer: the installed package differs from the tarball"
done
log "platform: Vite production build of the browser consumer"
( cd "$P/consumers/vite" && node node_modules/vite/bin/vite.js build ) > "$P/logs/vite-build.log" 2>&1 || { tail -n 30 "$P/logs/vite-build.log"; die "Vite consumer: build failed"; }
! grep -qiE "error|externalized for browser|doesn't exist at build time" "$P/logs/vite-build.log" || { cat "$P/logs/vite-build.log"; die "Vite consumer: the build reported a problem"; }
grep -E '\.(wasm|js) ' "$P/logs/vite-build.log" | sed 's/^/  /' || true
echo "platform tests prepared in build/platform/"
