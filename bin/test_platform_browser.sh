#!/usr/bin/env bash
# Offline platform checks of the packed package in one browser on this machine (run
# bin/platform_prepare.sh first): the Vite build of consumers/vite served from loopback under the
# page policy of docs/DEPLOYMENT.md, the page at ?offline (the checks of offlineChecks.js, the wallet
# in a worker), driven by src/test/platform/runBrowser.cjs.
#
# Usage: bin/test_platform_browser.sh <label> --launch <Chromium-family binary>
#        bin/test_platform_browser.sh <label> --webdriver <driver binary> --browser chrome|msedge|firefox|safari [--browser-binary <path>]
# Results: build/test-results/platform/browser-<label>/ (report.json, summary.json).
# Runs on Linux, macOS and Windows (Git Bash).
set -euo pipefail
. "$(dirname "$0")/pins.sh"
# a time bound that also works where GNU timeout is missing (macOS)
bounded() { local s=$1; shift; if command -v timeout > /dev/null 2>&1; then timeout "$s" "$@"; else perl -e '$SIG{ALRM} = sub { kill "TERM", $pid; exit 124 }; alarm shift @ARGV; $pid = fork // die; if (!$pid) { exec @ARGV or exit 127 } waitpid($pid, 0); exit($? >> 8)' "$s" "$@"; fi; }
[ $# -ge 3 ] || die "usage: bin/test_platform_browser.sh <label> (--launch <binary> | --webdriver <driver> --browser <name>)"
LABEL=$1; shift
[[ "$LABEL" =~ ^[a-z0-9-]+$ ]] || die "the label must be lower-case letters, digits and dashes"
P=$ROOT/build/platform; DIST=$P/consumers/vite/dist
[ -s "$DIST/index.html" ] || die "run bin/platform_prepare.sh first"
OUT=$ROOT/build/test-results/platform/browser-$LABEL; rm -rf "$OUT"; mkdir -p "$OUT"
TARBALL=$(node -e 'process.stdout.write(require("crypto").createHash("sha256").update(require("fs").readFileSync(process.argv[1])).digest("hex"))' "$P/consumers/zephyr-ts.tgz")
log "browser $LABEL: offline checks of the Vite consumer (tarball $TARBALL)"
rc=0
bounded 1500 node "$ROOT/src/test/platform/runBrowser.cjs" --root "$DIST" --out "$OUT" --wasm-sha256 "$(cat "$P/wasm.sha256")" --tarball-sha256 "$TARBALL" --timeout-ms 1200000 "$@" \
  > "$OUT/runner.log" 2>&1 || rc=$?
cat "$OUT/runner.log"
[ "$rc" = 0 ] || die "browser $LABEL: the offline checks failed"
echo "browser $LABEL: offline checks passed"
