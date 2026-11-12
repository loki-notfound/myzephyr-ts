#!/usr/bin/env bash
# Read-only network suite against daemons you are allowed to query. Run bin/build.sh first.
# Configuration comes from the environment only (see src/test/network/testEndpoints.cjs):
#   ZEPHYR_TS_TEST_DAEMON          http(s)://host:port of a daemon reached directly (required)
#   ZEPHYR_TS_TEST_DAEMON_HTTPS    optional https://host[:port] of a daemon that serves the same chain;
#                                  without it check N03 is reported as not run
#   ZEPHYR_TS_TEST_FORWARD_UPSTREAM  optional upstream of the loopback forwarder (default: the first)
# Without ZEPHYR_TS_TEST_DAEMON, or with a malformed value, the suite stops with exit status 2 and
# names the variable.
#
# Exit status: 0 if every requested check ran and passed; 3 if every check that ran passed and at
# least one was not run (the summary names it and the reason); 1 if a check failed; 2 for missing or
# malformed configuration. The status is derived from the written reports, not only from the runners.
#
# Three runs: Node directly, Node through wallet workers and Chromium (wallet worker, headless,
# network contained; it reaches only a loopback forwarder that relays an allowlist of read-only
# daemon requests to the upstream). Load: at most two concurrent upstream connections, every sync
# starts at most 2,000 blocks below the daemon height; the block hashes (about 29 MB) are downloaded
# only by the first syncs of new wallets in the Node direct run: the fresh restore of N02, the HTTPS
# restore of N03 and the new wallet of N17; every other sync reopens the saved wallet bytes; about
# 15 syncs in total (two of them, N18 in the worker runs, are stopped after 400 ms). A disposable wallet
# without funds is kept in build/test-wallets/ between the runs. Results (codes, counts, heights and
# timings only) go to build/test-results/network/.
#
# Environment (optional): CHROMIUM=<browser binary> (default: chromium); DIRECT_CHECKS, WORKER_CHECKS
# and BROWSER_CHECKS select a subset of the checks per run (checks after N02 that reopen the measured
# wallet need N02 in DIRECT_CHECKS); ZEPHYR_TS_TEST_KEEP_WALLET=<new directory> keeps a copy of the
# saved disposable wallet there for bin/test_package.sh (it holds no funds; delete it afterwards).
set -euo pipefail
. "$(dirname "$0")/pins.sh"
cd "$ROOT"
export TZ=UTC
node -e 'require(process.argv[1]).requireTestEndpoints()' "$ROOT/src/test/network/testEndpoints.cjs" # exit 2 with a clear message if incomplete
[ -s dist/src/test/network/runNetworkNode.js ] && [ -s dist/lifecycle-consumer/consumer.network.js ] || die "build output missing; run bin/build.sh first"
CHROMIUM=${CHROMIUM:-chromium}
OUT=$ROOT/build/test-results/network; SEED=$ROOT/build/test-wallets/network-seed
rm -rf "$OUT" "$SEED"; mkdir -p "$OUT" "$(dirname "$SEED")"; chmod 700 "$OUT" "$(dirname "$SEED")"
MARKER=MARKERnodetext
DIRECT_CHECKS=${DIRECT_CHECKS:-N01,N02,N03,N04,N08,N09,N10,N11,N14,N15,N16,N17,N18}
WORKER_CHECKS=${WORKER_CHECKS:-N01,N05,N08,N10,N11,N12,N13,N18,N15,N16}
BROWSER_CHECKS=${BROWSER_CHECKS:-N01,N02,N05,N06,N07,N08,N10,N11,N18,N14,N15,N16}
UPSTREAM=$(node -e 'console.log(require(process.argv[1]).requireTestEndpoints().upstream.url)' "$ROOT/src/test/network/testEndpoints.cjs")

NOT_RUN=$OUT/not-run.txt; : > "$NOT_RUN"
report_status() { # report.json requested-checks label: every requested check is in the report and passed or was not run
  node - "$1" "$2" "$3" "$NOT_RUN" <<'JS' || die "$3: the report does not show every requested check as passed or not run"
const fs = require("fs"); const [file, want, label, notRun] = process.argv.slice(2);
const report = JSON.parse(fs.readFileSync(file, "utf8")); const checks = Array.isArray(report.checks) ? report.checks : [];
const ids = want.split(",").filter((c) => c !== "");
if (report.fatal !== undefined || checks.map((c) => c.id).sort().join() !== ids.slice().sort().join()) process.exit(1);
for (const c of checks) {
  if (c.status === "not-run") fs.appendFileSync(notRun, label + " " + c.id + ": " + (c.notes || []).filter((n) => n.startsWith("NOT RUN: ")).map((n) => n.slice(9)).join("; ") + "\n");
  else if (c.status !== "pass") process.exit(1);
}
JS
}

node_run() { # mode checks [seed args...]
  local mode=$1 checks=$2; shift 2
  local run=$OUT/node-$mode rc=0 fwd i
  mkdir -p "$run"
  node "$ROOT/src/test/network/forwarder.cjs" --upstream "$UPSTREAM" --out "$run/fwd" --marker "$MARKER" --slow-ms 1500 > "$run/fwd.stdout" 2> "$run/fwd.stderr" &
  fwd=$!
  for i in $(seq 1 100); do grep -q '"ready"' "$run/fwd.stdout" 2>/dev/null && break; sleep 0.1; done
  grep -q '"ready"' "$run/fwd.stdout" || { kill -TERM "$fwd" || true; die "forwarder did not start"; }
  node -e '
const fs = require("fs"); const e = require(process.argv[1]).requireTestEndpoints();
const p = JSON.parse(fs.readFileSync(process.argv[2], "utf8").split("\n")[0]).ports; const root = "http://127.0.0.1:" + p.daemon;
fs.writeFileSync(process.argv[3], JSON.stringify({ direct: e.direct.url, lb: e.tls === undefined ? undefined : e.tls.url, root, base: root + "/rpc", slow: root + "/slow",
  fakeStatus: root + "/fake/status", fakeMalformed: root + "/fake/malformed", fakeNodeStatus: root + "/fake/nodestatus",
  closed: "http://127.0.0.1:" + p.closed, silent: "http://127.0.0.1:" + p.silent }));' "$ROOT/src/test/network/testEndpoints.cjs" "$run/fwd.stdout" "$run/targets.json"
  log "Node network run, $mode"
  NETWORK_MONITOR_LOG=$run/monitor.jsonl timeout 2400 node --require "$ROOT/src/test/network/netMonitor.cjs" "$ROOT/dist/src/test/network/runNetworkNode.js" \
    --mode "$mode" --out "$run/report.json" --targets "$run/targets.json" --marker "$MARKER" --checks "$checks" "$@" > "$run/stdout.txt" 2> "$run/stderr.txt" || rc=$?
  kill -TERM "$fwd"; wait "$fwd" || true
  grep -E '^checks:' "$run/stdout.txt" || true
  [ "$rc" = 0 ] || [ "$rc" = 3 ] || { tail -n 5 "$run/stderr.txt"; die "Node network run ($mode) failed"; }
  report_status "$run/report.json" "$checks" "Node $mode"
  ! grep -q '"allowed":false' "$run/monitor.jsonl" || die "Node network run ($mode): a connection outside the configured daemons was blocked"
}

node_run direct "$DIRECT_CHECKS" --seed-out "$SEED"
if [[ ",$DIRECT_CHECKS," == *",N02,"* ]]; then
  [ -s "$SEED/keys.bin" ] || die "seed wallet missing after the direct run"
  node_run worker "$WORKER_CHECKS" --seed-in "$SEED"
else
  mkdir -p "$SEED"; chmod 700 "$SEED"   # a subset without the measured restore: the later runs get no seed wallet
  node_run worker "$WORKER_CHECKS"
fi

ROOT_PAGE=$OUT/browser-root; RUN=$OUT/chromium; mkdir -p "$ROOT_PAGE" "$RUN"
cp src/test/network/browser/index.html "$ROOT_PAGE/index.html"
cp dist/lifecycle-consumer/consumer.network.js dist/zephyr.worker.js dist/zephyr.wasm "$ROOT_PAGE/"
log "Chromium network run"
rc=0
timeout 2400 node src/test/network/browser/runChromiumNetwork.cjs --root "$ROOT_PAGE" --seed "$SEED" --out "$RUN" --checks "$BROWSER_CHECKS" \
  --upstream "$UPSTREAM" --marker "$MARKER" --chromium "$CHROMIUM" --timeout-ms 1800000 > "$RUN/stdout.txt" 2> "$RUN/stderr.txt" || rc=$?
cat "$RUN/stdout.txt"
[ "$rc" = 0 ] || [ "$rc" = 3 ] || { tail -n 5 "$RUN/stderr.txt"; die "Chromium network run failed"; }
report_status "$RUN/report.json" "$BROWSER_CHECKS" "Chromium"
if [ -n "${ZEPHYR_TS_TEST_KEEP_WALLET:-}" ] && [ -s "$SEED/keys.bin" ]; then
  [ ! -e "$ZEPHYR_TS_TEST_KEEP_WALLET" ] || die "ZEPHYR_TS_TEST_KEEP_WALLET must name a new directory"
  mkdir -m 700 -p "$ZEPHYR_TS_TEST_KEEP_WALLET"; cp "$SEED/keys.bin" "$SEED/cache.bin" "$SEED/password.txt" "$ZEPHYR_TS_TEST_KEEP_WALLET/"
  log "saved wallet kept in $ZEPHYR_TS_TEST_KEEP_WALLET"
fi
rm -rf "$SEED"
if [ -s "$NOT_RUN" ]; then
  echo "network suite: every check that ran passed; NOT RUN:"
  sed 's/^/  /' "$NOT_RUN"
  exit 3
fi
echo "network suite passed"
