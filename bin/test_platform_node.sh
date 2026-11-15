#!/usr/bin/env bash
# Offline platform checks of the packed package in Node.js on this machine (run
# bin/platform_prepare.sh first): the checks of consumers/vite/src/offlineChecks.js through the
# package entry, loaded with require() and with import, each in the main thread and with a worker per
# wallet, under a preload that blocks and counts every network access (consumers/node/offlineGuard.cjs);
# then the type check of the shipped declarations without Node.js types. No daemon, no request.
# Results: build/test-results/platform/node-<loader>-<mode>.json.
# Runs on Linux, macOS and Windows (Git Bash).
set -euo pipefail
. "$(dirname "$0")/pins.sh"
# a time bound that also works where GNU timeout is missing (macOS)
bounded() { local s=$1; shift; if command -v timeout > /dev/null 2>&1; then timeout "$s" "$@"; else perl -e '$SIG{ALRM} = sub { kill "TERM", $pid; exit 124 }; alarm shift @ARGV; $pid = fork // die; if (!$pid) { exec @ARGV or exit 127 } waitpid($pid, 0); exit($? >> 8)' "$s" "$@"; fi; }
P=$ROOT/build/platform; C=$P/consumers/node; TOOL=$ROOT/src/test/platform/platformTool.cjs
[ -d "$C/node_modules/@loki-notfound/zephyr-ts" ] || die "run bin/platform_prepare.sh first"
OUT=$ROOT/build/test-results/platform; mkdir -p "$OUT"
node "$TOOL" env
echo "tarball:  $(node -e 'process.stdout.write(require("crypto").createHash("sha256").update(require("fs").readFileSync(process.argv[1])).digest("hex"))' "$P/consumers/zephyr-ts.tgz")"
reports=()
for loader in cjs mjs; do
  for mode in direct worker; do
    log "Node.js offline checks: $loader, $mode"
    r=$OUT/node-$loader-$mode
    rm -f "$r.json" "$r.guard.json"
    rc=0
    ( cd "$C" && OFFLINE_GUARD_OUT=$r.guard.json bounded 1200 node --require ./offlineGuard.cjs "offline.$loader" --mode "$mode" --out "$r.json" ) > "$r.log" 2>&1 || rc=$?
    grep -E '^checks:' "$r.log" || true
    [ "$rc" = 0 ] || { tail -n 15 "$r.log"; die "Node.js offline checks ($loader, $mode) failed"; }
    reports+=("$r.json")
  done
done
node "$TOOL" judge "$P/consumers/zephyr-ts.tgz" "${reports[@]}" || die "Node.js offline checks: unexpected results"
log "type check of the shipped declarations without Node.js types"
[ ! -e "$C/node_modules/@types/node" ] || die "@types/node is installed in the Node consumer"
d=$C; while [ "$d" != "$(dirname "$d")" ]; do d=$(dirname "$d"); [ ! -e "$d/node_modules/@types/node" ] || die "$d/node_modules holds @types/node; the check needs a directory without Node.js types"; done
for cfg in tsconfig.json tsconfig.bundler.json; do
  ( cd "$C" && node node_modules/typescript/bin/tsc -p "$cfg" ) > "$OUT/node-types-$cfg.txt" 2>&1 || { head -n 20 "$OUT/node-types-$cfg.txt"; die "type check of the shipped declarations failed ($cfg)"; }
done
echo "Node.js platform checks passed"
