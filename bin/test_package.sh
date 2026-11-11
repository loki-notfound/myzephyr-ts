#!/usr/bin/env bash
# Packaging tests: the packed package installed into the minimal consumers in consumers/, each with
# its own lockfile and nothing else (no devDependencies of this repository), then run through the
# package entry only. Run bin/build.sh first; this script packs with bin/pack.sh.
#   node     require() and import of the Node entry, and a type check of the shipped declarations
#            (module resolution node16, and bundler with the browser condition)
#   webpack  a production bundle of the browser entry with no resolve fallback, run in Chromium
#   vite     the Vite development server and a Vite production build, without a configuration file,
#            each run in Chromium
# Every run creates a wallet with the daemon (it starts at the daemon height; no sync), saves it,
# reopens it from its bytes and syncs a saved disposable wallet once. Chromium runs headless and
# contained, as in bin/test_network.sh: it reaches only the loopback forwarder, which serves the
# consumer under the page policy of docs/DEPLOYMENT.md and relays the daemon under the base path /rpc.
#
# Configuration (environment):
#   ZEPHYR_TS_TEST_DAEMON       required: http(s)://host:port of a daemon you may query (as for
#                               bin/test_network.sh; ZEPHYR_TS_TEST_DAEMON_HTTPS is not used here)
#   ZEPHYR_TS_TEST_WALLET_DIR   required: a saved disposable wallet without funds (keys.bin, cache.bin,
#                               password.txt) at most 2,000 blocks below the daemon height, for example
#                               the one bin/test_network.sh keeps with ZEPHYR_TS_TEST_KEEP_WALLET
#   CHROMIUM                    browser binary (default: chromium)
#   OFFLINE=1                   install the consumers from the npm cache only
# Load: five syncs of the saved wallet bytes, no block hash download, at most two concurrent upstream
# connections in the browser runs. Results (codes, counts, heights, file names, sizes and digests)
# go to build/test-results/package/; sizes.json lists every file each consumer ships.
set -euo pipefail
. "$(dirname "$0")/pins.sh"
cd "$ROOT"
export TZ=UTC
node -e 'require(process.argv[1]).requireTestEndpoints()' "$ROOT/src/test/network/testEndpoints.cjs"
WALLET=${ZEPHYR_TS_TEST_WALLET_DIR:-}
[ -n "$WALLET" ] && [ -s "$WALLET/keys.bin" ] && [ -s "$WALLET/cache.bin" ] && [ -s "$WALLET/password.txt" ] \
  || die "set ZEPHYR_TS_TEST_WALLET_DIR to a saved disposable wallet (keys.bin, cache.bin, password.txt); see BUILDING.md"
CHROMIUM=${CHROMIUM:-chromium}
command -v "$CHROMIUM" > /dev/null || die "$CHROMIUM not found; set CHROMIUM"
OUT=$ROOT/build/test-results/package; WORK=$ROOT/build/consumers; SEED=$ROOT/build/test-wallets/package-seed
rm -rf "$OUT" "$WORK" "$SEED"; mkdir -p "$OUT" "$WORK" "$(dirname "$SEED")"; chmod 700 "$OUT" "$(dirname "$SEED")"
mkdir -m 700 "$SEED"; cp "$WALLET/keys.bin" "$WALLET/cache.bin" "$WALLET/password.txt" "$SEED/"
trap 'rm -rf "$SEED"' EXIT
UPSTREAM=$(node -e 'console.log(require(process.argv[1]).requireTestEndpoints().upstream.url)' "$ROOT/src/test/network/testEndpoints.cjs")

log "pack"
bash "$ROOT/bin/pack.sh" > "$OUT/pack.log" 2>&1 || { tail -n 20 "$OUT/pack.log"; die "pack failed"; }
TGZ=$(ls "$ROOT"/build/package/*.tgz); cp "$TGZ" "$WORK/zephyr-ts.tgz"
sha256sum "$WORK/zephyr-ts.tgz" | cut -d' ' -f1 > "$OUT/tarball.sha256"

install_consumer() { # name: copy consumers/<name> into build/consumers/<name> and install it from its lockfile
  local c=$WORK/$1 offline=()
  cp -a "$ROOT/consumers/$1" "$c"
  [ "${OFFLINE:-0}" = 1 ] && offline=(--offline)
  ( cd "$c" && npm ci "${offline[@]}" --omit=dev --ignore-scripts --no-audit --no-fund ) > "$OUT/$1-install.log" 2>&1 \
    || { tail -n 20 "$OUT/$1-install.log"; die "$1 consumer: install failed"; }
  # the installed package is the packed tarball, file by file
  node - "$WORK/zephyr-ts.tgz" "$c/node_modules/@loki-notfound/zephyr-ts" <<'JS' || die "$1 consumer: the installed package differs from the tarball"
const fs = require("fs"); const path = require("path"); const zlib = require("zlib");
const tar = zlib.gunzipSync(fs.readFileSync(process.argv[2])); const dir = process.argv[3]; let n = 0;
for (let off = 0; off + 512 <= tar.length;) {
  const h = tar.subarray(off, off + 512); const name = h.toString("utf8", 0, 100).replace(/\0.*$/s, "");
  if (!name) break;
  const prefix = h.toString("utf8", 345, 500).replace(/\0.*$/s, ""); const size = parseInt(h.toString("utf8", 124, 136).replace(/\0.*$/s, "").trim() || "0", 8);
  const full = (prefix ? prefix + "/" : "") + name;
  if (h[156] === 48 || h[156] === 0) {
    const want = tar.subarray(off + 512, off + 512 + size); const file = path.join(dir, full.replace(/^package\//, ""));
    if (!fs.existsSync(file) || Buffer.compare(fs.readFileSync(file), want) !== 0) { console.log("differs: " + full); process.exit(1); }
    n++;
  }
  off += 512 + Math.ceil(size / 512) * 512;
}
console.log("installed package equals the tarball (" + n + " files)");
JS
}

sizes() { # name dir: every file the consumer ships, with its size and gzip size
  node - "$1" "$2" "$OUT/sizes-$1.json" <<'JS'
const fs = require("fs"); const path = require("path"); const zlib = require("zlib"); const crypto = require("crypto");
const [name, dir, out] = process.argv.slice(2); const files = [];
const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else files.push(p); } };
walk(dir);
const list = files.sort().map((f) => { const b = fs.readFileSync(f); return { file: path.relative(dir, f), bytes: b.length, gzipBytes: zlib.gzipSync(b, { level: 9 }).length, sha256: crypto.createHash("sha256").update(b).digest("hex") }; });
fs.writeFileSync(out, JSON.stringify({ consumer: name, files: list, totalBytes: list.reduce((a, f) => a + f.bytes, 0) }, null, 1) + "\n");
for (const f of list) console.log("  " + f.file + " " + f.bytes + " bytes (gzip " + f.gzipBytes + ")");
JS
}

browser_run() { # label consumer-output-dir|- (--root dir | --app url): one consumer page in contained Chromium
  local label=$1 shipped=$2 rc=0; shift 2
  timeout 1500 node "$ROOT/src/test/network/browser/runChromiumNetwork.cjs" "$@" --seed "$SEED" --out "$OUT/$label" --checks P01 \
    --upstream "$UPSTREAM" --chromium "$CHROMIUM" --timeout-ms 1200000 > "$OUT/$label.stdout.txt" 2> "$OUT/$label.stderr.txt" || rc=$?
  cat "$OUT/$label.stdout.txt"
  [ "$rc" = 0 ] || { tail -n 5 "$OUT/$label.stderr.txt"; die "$label: the consumer page failed"; }
  # the page used the package's module and its worker script, whatever names the bundler gave them: the
  # served worker is the package's file (the development server appends an inline source map to it),
  # or the copy the consumer ships (webpack's minimizer rewrites it), which still embeds the module digest
  node - "$OUT/$label/fwd/forwarder.json" "$WORK/$CONSUMER/node_modules/@loki-notfound/zephyr-ts/dist" "$shipped" <<'JS' || die "$label: the page did not use the package's worker and module"
const fs = require("fs"); const crypto = require("crypto"); const path = require("path");
const [fwd, dist, shipped] = process.argv.slice(2); const f = JSON.parse(fs.readFileSync(fwd, "utf8"));
const sha = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const digest = sha(path.join(dist, "zephyr.wasm")); const workers = new Map([[sha(path.join(dist, "zephyr.worker.js")), "the package's file"]]);
if (shipped !== "-") for (const n of fs.readdirSync(shipped, { recursive: true })) {
  const file = path.join(shipped, n);
  if (fs.statSync(file).isFile() && /\.js$/.test(n) && fs.readFileSync(file, "utf8").includes(digest) && !workers.has(sha(file))) workers.set(sha(file), "a copy shipped by the consumer");
}
const worker = f.pageRequests.filter((r) => r.dest === "worker" && r.status === 200); const wasm = f.pageRequests.filter((r) => r.path.endsWith(".wasm") && r.status === 200);
const id = (r) => workers.has(r.sha256) ? r.sha256 : r.sha256WithoutInlineMap;
const ok = worker.length >= 1 && worker.every((r) => workers.has(id(r))) && new Set(worker.map(id)).size === 1 && wasm.length === 1 && wasm[0].sha256 === digest && f.cspReports.length === 0;
console.log("  worker script " + Array.from(new Set(worker.map((r) => r.path))).join(" ") + " x" + worker.length + " (" + (worker.length ? workers.get(id(worker[0])) : "none")
  + (worker.length && worker[0].sha256 !== id(worker[0]) ? ", with an inline source map appended" : "") + "), module "
  + wasm.map((r) => r.path).join(" ") + ", policy reports " + f.cspReports.length);
process.exit(ok ? 0 : 1);
JS
}

# ------------------------------------------------------------------------------------------- node
log "Node consumer"
CONSUMER=node; install_consumer node; C=$WORK/node
for loader in cjs mjs; do
  rc=0
  ( cd "$C" && ZEPHYR_TS_TEST_DAEMON=$ZEPHYR_TS_TEST_DAEMON NETWORK_MONITOR_LOG=$OUT/node-$loader-monitor.jsonl timeout 1200 \
      node --require "$ROOT/src/test/network/netMonitor.cjs" "consumer.$loader" "$SEED" "$OUT/node-$loader.json" ) > "$OUT/node-$loader.stdout.txt" 2> "$OUT/node-$loader.stderr.txt" || rc=$?
  [ "$rc" = 0 ] || { grep -v '^20[0-9][0-9]-' "$OUT/node-$loader.stderr.txt" | tail -n 5; die "Node consumer ($loader) failed"; }
  ! grep -q '"allowed":false' "$OUT/node-$loader-monitor.jsonl" || die "Node consumer ($loader): a connection outside the configured daemon was blocked"
  node - "$OUT/node-$loader.json" <<'JS' || die "Node consumer ($loader): unexpected result"
const r = JSON.parse(require("fs").readFileSync(process.argv[2], "utf8"));
const want = ["ZephyrWallet", "ZephyrWalletError", "createKeysWallet", "createRandomWallet", "openWalletData", "restoreWalletFromKeys", "restoreWalletFromSeed",
  "setWasmModuleUrl", "setWorkerDistPath", "terminateWorker", "validateAddress"];
const ok = r.steps.join() === "create,save,reopen,sync of the saved wallet bytes" && r.restoreAtDaemonHeight && r.sameAddress && r.syncedToDaemon && r.onlyNewBlocks
  && r.savedBlocksBelowDaemon >= 0 && r.savedBlocksBelowDaemon <= 2000 && r.balanceKeys.length === 8 && r.rejectsUnknown && r.deepImport === "blocked"
  && r.exports.join() === want.join() && (r.loader === "require" || r.namedExports === true);
console.log("  " + r.loader + ": synced " + r.numBlocksFetched + " blocks, " + r.balanceKeys.length + " balance keys, exports " + r.exports.length + (ok ? "" : " (unexpected)"));
process.exit(ok ? 0 : 1);
JS
done
for cfg in tsconfig.json tsconfig.bundler.json; do
  ( cd "$C" && node node_modules/typescript/bin/tsc -p "$cfg" ) > "$OUT/node-types-$cfg.txt" 2>&1 || { head -n 20 "$OUT/node-types-$cfg.txt"; die "type check of the shipped declarations failed ($cfg)"; }
done
echo "  declarations: type check clean (node16, bundler with the browser condition)"

# ---------------------------------------------------------------------------------------- webpack
log "webpack consumer"
CONSUMER=webpack; install_consumer webpack; C=$WORK/webpack
( cd "$C" && node build.js "$OUT/webpack-stats.json" ) > "$OUT/webpack-build.log" 2>&1 || { tail -n 30 "$OUT/webpack-build.log"; die "webpack consumer: build failed"; }
node - "$OUT/webpack-stats.json" <<'JS' || die "webpack consumer: the build reported an error or a warning"
const s = JSON.parse(require("fs").readFileSync(process.argv[2], "utf8"));
const warnings = (s.warnings || []).filter((w) => !/exceed the recommended size limit|can impact web performance|You can limit the size/.test(w.message || String(w)));
console.log("  webpack " + s.version + ": " + (s.errors || []).length + " errors, " + warnings.length + " warnings other than the size hints, " + (s.warnings || []).length + " in all");
process.exit((s.errors || []).length === 0 && warnings.length === 0 ? 0 : 1);
JS
cp "$C/index.html" "$C/dist/index.html"
sizes webpack "$C/dist"
browser_run webpack-build "$C/dist" --root "$C/dist"

# ------------------------------------------------------------------------------------------- vite
log "Vite consumer: production build"
CONSUMER=vite; install_consumer vite; C=$WORK/vite
( cd "$C" && node node_modules/vite/bin/vite.js build ) > "$OUT/vite-build.log" 2>&1 || { tail -n 30 "$OUT/vite-build.log"; die "Vite consumer: build failed"; }
! grep -qiE "error|externalized for browser|doesn't exist at build time" "$OUT/vite-build.log" || { cat "$OUT/vite-build.log"; die "Vite consumer: the build reported a problem"; }
sizes vite "$C/dist"
browser_run vite-build "$C/dist" --root "$C/dist"

log "Vite consumer: development server"
PORT=$(node -e 'const s = require("net").createServer().listen(0, "127.0.0.1", () => { console.log(s.address().port); s.close(); })')
( cd "$C" && exec node node_modules/vite/bin/vite.js --host 127.0.0.1 --port "$PORT" --strictPort ) > "$OUT/vite-dev.log" 2>&1 &
VITE=$!
trap 'kill -TERM "$VITE" 2>/dev/null || true; rm -rf "$SEED"' EXIT
for i in $(seq 1 100); do grep -q "ready in" "$OUT/vite-dev.log" 2>/dev/null && break; sleep 0.2; done
grep -q "ready in" "$OUT/vite-dev.log" || die "Vite development server did not start"
browser_run vite-dev - --app "http://127.0.0.1:$PORT"
kill -TERM "$VITE"; wait "$VITE" || true
trap 'rm -rf "$SEED"' EXIT
! grep -qiE "error|externalized for browser" "$OUT/vite-dev.log" || { cat "$OUT/vite-dev.log"; die "Vite development server reported a problem"; }
echo "packaging tests passed"
