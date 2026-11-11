#!/usr/bin/env bash
# Offline test suites; no request leaves the machine. Run bin/build.sh first.
#   Node      lifecycle suite (release module) and instrumented suite (test module), each directly
#             and through wallet workers, under a preloaded monitor that blocks network access and
#             records file writes
#   Node      loading of the WebAssembly module: missing, invalid, foreign, changed and other-build
#             files (integrity pin), a rejected compilation, recovery
#   Chromium  lifecycle and instrumented suites in a wallet worker under a same-origin
#             Content-Security-Policy, and the module loading cases (headless, network contained)
# Each runner exits nonzero if a check fails; this script stops at the first failure.
# Results (codes, counts and timings only) are written to build/test-results/offline/.
#
# Environment (optional): CHROMIUM=<browser binary> (default: chromium); SKIP_BROWSER=1 runs the
# Node suites only.
set -euo pipefail
. "$(dirname "$0")/pins.sh"
cd "$ROOT"
export TZ=UTC
OUT=$ROOT/build/test-results/offline
rm -rf "$OUT"; mkdir -p "$OUT"; chmod 700 "$OUT"
CHROMIUM=${CHROMIUM:-chromium}
for f in dist/zephyr.js dist/zephyr.wasm dist/zephyr.test.js dist/zephyr.test.wasm dist/zephyr.worker.js dist/src/test/lifecycle/runNode.js; do
  [ -s "$f" ] || die "$f is missing; run bin/build.sh first"
done
MON=(--require "$ROOT/src/test/lifecycle/nodeMonitor.cjs")

node_suite() { # release|instrumented direct|worker
  local run=$OUT/node-$1-$2 extra=() rc=0
  mkdir -p "$run"; [ "$1" = instrumented ] && extra=(--test-module "$ROOT/dist/zephyr.test.js")
  log "Node $1 suite, $2"
  ( cd "$run" && LIFECYCLE_MONITOR_LOG=$run/monitor.jsonl LIFECYCLE_MONITOR_ALLOW_WRITE=$run/report.json:$run/monitor.jsonl \
      timeout 1800 node "${MON[@]}" "$ROOT/dist/src/test/lifecycle/runNode.js" --suite "$1" --mode "$2" --out "$run/report.json" "${extra[@]}" ) \
      > "$run/stdout.txt" 2> "$run/stderr.txt" || rc=$?
  grep -E '^checks:' "$run/stdout.txt" || true
  [ "$rc" = 0 ] || { tail -n 5 "$run/stderr.txt"; die "Node $1 suite ($2) failed"; }
  ! grep -q '"kind":"\(connect\|dns\|fetch\|write\)"' "$run/monitor.jsonl" || die "Node $1 suite ($2): the monitor recorded network access or an unexpected write"
}

MODULE_CASES="ok missing invalid foreign changed otherbuild rejected recover"
module_files() { # dir: the wrong files of the module cases
  printf 'not a WebAssembly module\n' > "$1/invalid.wasm"
  printf '\000asm\001\000\000\000' > "$1/foreign.wasm" # a valid empty module of another program
  node -e 'const fs = require("fs"); const b = fs.readFileSync(process.argv[1]); b[b.length >> 1] ^= 1; fs.writeFileSync(process.argv[2], b);' "$ROOT/dist/zephyr.wasm" "$1/changed.wasm"
  cp "$ROOT/dist/zephyr.test.wasm" "$1/otherbuild.wasm" # a valid module of another build of this program
}

module_cases_node() {
  local run=$OUT/node-module rc
  mkdir -p "$run"
  module_files "$run"
  for mode in direct worker; do
    for c in $MODULE_CASES; do
      rc=0
      ( cd "$run" && LIFECYCLE_MONITOR_LOG=$run/monitor-$c-$mode.jsonl LIFECYCLE_MONITOR_ALLOW_WRITE=$run/$c-$mode.json \
          timeout 600 node "${MON[@]}" "$ROOT/dist/src/test/lifecycle/moduleProbe.js" --case "$c" --mode "$mode" --invalid "$run/invalid.wasm" --foreign "$run/foreign.wasm" \
          --changed "$run/changed.wasm" --otherbuild "$run/otherbuild.wasm" --out "$run/$c-$mode.json" ) \
          > "$run/$c-$mode.stdout" 2> "$run/$c-$mode.stderr" || rc=$?
      [ "$rc" = 0 ] || die "module case $c ($mode) did not run"
      expect_module_case "$run/$c-$mode.json" "$c"
    done
  done
}

expect_module_case() { # report case
  node -e '
const r = require(process.argv[1]); const c = process.argv[2]; const o = r.outcome || {};
const M = "NATIVE_ERROR/WASM_MODULE_MISMATCH";
const want = { ok: ["ok", undefined, 1], missing: ["NATIVE_ERROR/WASM_MODULE_UNAVAILABLE", undefined, 0], invalid: [M, undefined, 0], foreign: [M, undefined, 0],
  changed: [M, undefined, 0], otherbuild: [M, undefined, 0], rejected: ["NATIVE_ERROR/WASM_MODULE_REJECTED", undefined, 1],
  recover: ["NATIVE_ERROR/WASM_MODULE_UNAVAILABLE", "ok", 1] }[c];
// every failed load is reported before any worker starts
const workersOk = c === "ok" || c === "recover" || o.workersStarted === 0;
const pass = o.first === want[0] && o.second === want[1] && o.compilations === want[2] && workersOk;
console.log("module case " + c + " " + r.env + ": " + o.first + (o.second ? " then " + o.second : "") + ", compilations " + o.compilations + ", workers " + o.workersStarted + (pass ? "" : "  (expected " + JSON.stringify(want) + ")"));
process.exit(pass ? 0 : 1);' "$1" "$2" || die "module case $2: unexpected outcome"
}

browser_root() { # dir consumer-bundle worker-bundle [wasm...]
  local dir=$1; shift
  rm -rf "$dir"; mkdir -p "$dir"
  cp "$ROOT/src/test/lifecycle/browser/index.html" "$dir/index.html"
  cp "$ROOT/dist/lifecycle-consumer/$1" "$dir/consumer.js"
  cp "$2" "$dir/$(basename "$2")"; shift 2
  for f in "$@"; do cp "$f" "$dir/$(basename "$f")"; done
}

browser_suite() { # release|instrumented
  local root=$OUT/browser-root-$1 run=$OUT/chromium-$1 rc=0
  if [ "$1" = release ]; then browser_root "$root" consumer.js "$ROOT/dist/zephyr.worker.js" "$ROOT/dist/zephyr.wasm"
  else browser_root "$root" consumer.instrumented.js "$ROOT/dist/lifecycle-consumer/zephyr.test.worker.js" "$ROOT/dist/zephyr.test.wasm"; fi
  log "Chromium $1 suite"
  timeout 2400 node "$ROOT/src/test/lifecycle/browser/runChromium.cjs" --root "$root" --out "$run" --chromium "$CHROMIUM" --timeout-ms 1800000 \
    > "$run.stdout.txt" 2> "$run.stderr.txt" || rc=$?
  grep -E '^checks:' "$run.stdout.txt" || true
  [ "$rc" = 0 ] || { tail -n 5 "$run.stderr.txt"; die "Chromium $1 suite failed"; }
}

module_cases_browser() {
  local root=$OUT/browser-root-module
  browser_root "$root" consumer.module.js "$ROOT/dist/zephyr.worker.js" "$ROOT/dist/zephyr.wasm"
  module_files "$root"
  for c in $MODULE_CASES; do
    local run=$OUT/chromium-module-$c rc=0
    timeout 900 node "$ROOT/src/test/lifecycle/browser/runChromium.cjs" --root "$root" --out "$run" --chromium "$CHROMIUM" --timeout-ms 300000 --query "case=$c" --record \
      > "$run.stdout.txt" 2> "$run.stderr.txt" || rc=$?
    [ "$rc" = 0 ] || die "Chromium module case $c did not run"
    expect_module_case "$run/report.json" "$c"
    node -e 'const s = require(process.argv[1]); if (s.cspReports.length) { console.log("policy reports: " + JSON.stringify(s.cspReports)); process.exit(1); }' "$run/browser-summary.json" \
      || die "Chromium module case $c: policy violation"
  done
}

node_suite release direct
node_suite release worker
node_suite instrumented direct
node_suite instrumented worker
log "Node module loading cases"
module_cases_node
if [ "${SKIP_BROWSER:-0}" != 1 ]; then
  command -v "$CHROMIUM" >/dev/null || die "$CHROMIUM not found; set CHROMIUM or SKIP_BROWSER=1"
  browser_suite release
  browser_suite instrumented
  log "Chromium module loading cases"
  module_cases_browser
fi
echo "offline suites passed"
