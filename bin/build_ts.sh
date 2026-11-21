#!/usr/bin/env bash
# Install the locked npm dependencies and build the TypeScript layer (run bin/build_wasm.sh first):
#   dist/zephyr.digest.js, dist/zephyr.test.digest.js  SHA-256 of dist/zephyr.wasm and of the test
#                module, embedded in the JavaScript and checked before the module is compiled
#   type check   tsc with tsconfig.json (must report no diagnostic)
#   dist/src/    Babel output of src/ (CommonJS for Node; dist/src/test/ is test output, never shipped)
#   dist/**.d.ts declarations of the public entry and the modules it uses (tsconfig.types.json)
#   dist/zephyr.worker.js, dist/zephyr-ts.browser.mjs  the browser wallet worker and the browser
#                entry, an ES module (webpack.browser.js)
#   dist/lifecycle-consumer/ browser test pages and the browser test worker (webpack.lifecycle-consumer.js)
#   relay check  one way only: the built bridge assigns m_relay only to false, calls the core's commit
#                (relay_txs) exactly once, inside relay_prepared, the core's sweep (sweep_unlocked) exactly
#                once, after the relay flag was fixed to false, and no other submit, relay, sweep or sign
#                function; relay_prepared is the only release binding that relays; the module's HTTP client
#                passes a submit request only under the bridge's permit; the shipped transport carries the
#                refusal of submit and relay requests and its scoped pass
#
# Environment (optional): OFFLINE=1 installs from the npm cache only (npm ci --offline).
set -euo pipefail
. "$(dirname "$0")/pins.sh"
cd "$ROOT"
export TZ=UTC
LOGS=$ROOT/build/logs; mkdir -p "$LOGS"
[ -s dist/zephyr.js ] && [ -s dist/zephyr.wasm ] || die "dist/zephyr.js and dist/zephyr.wasm are missing; run bin/build_wasm.sh first"
[ -s dist/zephyr.test.js ] && [ -s dist/zephyr.test.wasm ] || die "dist/zephyr.test.js and dist/zephyr.test.wasm are missing; run bin/build_wasm.sh first"

log "embedded module digests"
digest_module() { # module output
  local h; h=$(sha256sum "$1" | cut -d' ' -f1)
  printf '// SHA-256 of %s, written by bin/build_ts.sh; the runtime checks the module against it before compiling.\nmodule.exports = "%s";\n' "$(basename "$1")" "$h" > "$2"
  echo "$2: $h"
}
digest_module dist/zephyr.wasm dist/zephyr.digest.js
digest_module dist/zephyr.test.wasm dist/zephyr.test.digest.js

log "npm ci"
offline=(); [ "${OFFLINE:-0}" = 1 ] && offline=(--offline)
npm ci "${offline[@]}" --ignore-scripts --no-audit --no-fund > "$LOGS/npm-ci.log" 2>&1 || { tail -n 20 "$LOGS/npm-ci.log"; die "npm ci failed"; }

log "type check (tsconfig.json)"
node_modules/.bin/tsc -p tsconfig.json --noEmit > "$LOGS/tsc.log" 2>&1 || { head -n 40 "$LOGS/tsc.log"; die "type check failed"; }

log "Babel (src -> dist/src)"
rm -rf dist/src
node_modules/.bin/babel ./src --extensions ".js,.ts" --out-dir ./dist/src > "$LOGS/babel.log" 2>&1 || { tail -n 20 "$LOGS/babel.log"; die "Babel failed"; }

log "declarations (tsconfig.types.json)"
node_modules/.bin/tsc -p tsconfig.types.json > "$LOGS/tsc-types.log" 2>&1 || { head -n 40 "$LOGS/tsc-types.log"; die "declaration build failed"; }

log "browser wallet worker and browser entry (webpack.browser.js)"
rm -f dist/zephyr-ts.browser.mjs
node_modules/.bin/webpack --config ./webpack.browser.js > "$LOGS/webpack-browser.log" 2>&1 || { tail -n 30 "$LOGS/webpack-browser.log"; die "browser bundles failed"; }
! grep -q 'ERROR' "$LOGS/webpack-browser.log" || die "browser bundles reported an error"
log "browser entry check: an ES module that names no Node.js module and keeps its asset URLs"
node - dist/zephyr-ts.browser.mjs <<'JS' || die "the browser entry is not self-contained"
const s = require("fs").readFileSync(process.argv[2], "utf8");
const bad = [];
if (/^\s*import\s/m.test(s) || /\bimport\s*\(/.test(s)) bad.push("an import of another module");
// a require of a module name outside a comment (webpack resolved every other require into the bundle)
if (s.split("\n").some((l) => !/^\s*(\/\/|\*|\/\*)/.test(l) && /(?<![.\w$])require\s*\(\s*["'][^"']+["']\s*\)/.test(l.replace(/\/\/.*$/, "")))) bad.push("a require call");
for (const u of ["./zephyr.worker.js", "./zephyr.wasm"]) if (s.split("new URL(\"" + u + "\", import.meta.url)").length !== 2) bad.push("the default URL of " + u);
if ((s.match(/import\.meta/g) || []).length !== 2) bad.push("another use of import.meta");
if (!/^export \{/m.test(s)) bad.push("no export statement");
if (bad.length) { console.log(bad.join("; ")); process.exit(1); }
console.log("dist/zephyr-ts.browser.mjs: " + require("fs").statSync(process.argv[2]).size + " bytes, self-contained");
JS

log "browser test pages and test worker (webpack.lifecycle-consumer.js)"
rm -rf dist/lifecycle-consumer
NODE_OPTIONS=--max-old-space-size=6144 node_modules/.bin/webpack --config ./webpack.lifecycle-consumer.js > "$LOGS/webpack-test.log" 2>&1 || { tail -n 30 "$LOGS/webpack-test.log"; die "test bundles failed"; }
! grep -q 'ERROR' "$LOGS/webpack-test.log" || die "test bundles reported an error"

log "release bundle check: no test instrumentation in shipped files"
for f in dist/zephyr.js dist/zephyr.worker.js dist/zephyr-ts.browser.mjs dist/src/main/ts/index.js dist/src/main/ts/common/ZephyrWebWorker.js dist/src/main/ts/common/LibraryUtils.js; do
  for token in __zephyrTsTestHooks __testInstall __testNativeChangePassword __testReply test_heap_in_use __testCrash __measure; do
    ! grep -q "$token" "$f" || die "$f contains test-only $token"
  done
done
log "relay check: one way only (relay fixed to false in every build, the core's commit in one bridge function and one binding, the transport's scoped pass)"
node - src/main/cpp/zephyr_wasm_bridge.cpp src/main/cpp/index.cpp src/main/cpp/http_client_wasm.cpp dist/zephyr.wasm dist/zephyr.worker.js dist/zephyr-ts.browser.mjs dist/src/main/ts/common/HttpClient.js <<'JS' || die "relay check failed"
const fs = require("fs");
const [bridgeFile, indexFile, httpFile, wasmFile, ...shipped] = process.argv.slice(2);
const bad = [];
// the bridge as compiled: without the blocks of inherited code that is not built
const bridge = fs.readFileSync(bridgeFile, "utf8").replace(/#if defined\(ZEPHYR_WASM_BRIDGE_UNPORTED\)[\s\S]*?#endif/g, "");
const relayAssignments = bridge.match(/\bm_relay\s*=[^=][^;]*;/g) || [];
if (relayAssignments.length !== 1 || !/^m_relay\s*=\s*false;$/.test(relayAssignments[0])) bad.push("m_relay is not assigned exactly once, to false: " + JSON.stringify(relayAssignments));
// the core's commit (monero_wallet_full::relay_txs) is called exactly once, inside relay_prepared; nothing else submits
const commits = bridge.match(/\brelay_txs\(/g) || [];
const relayFn = (bridge.match(/void zephyr_wasm_bridge::relay_prepared\([\s\S]*?\n\}\n/) || [""])[0];
if (commits.length !== 1 || (relayFn.match(/\brelay_txs\(/g) || []).length !== 1) bad.push("the core's commit is not called exactly once, in relay_prepared (" + commits.length + " calls)");
for (const call of ["relay_tx(", "commit_tx(", "submit_txs(", "sweep_output(", "sweep_dust(", "sign_txs(", "submit_multisig_tx_hex(", "start_mining("]) {
  if (bridge.includes(call)) bad.push("the built bridge calls " + call);
}
// the core's sweep (monero_wallet_full::sweep_unlocked) is called exactly once, inside sweep_result, after the relay flag
// was fixed to false in the same function
const sweeps = bridge.match(/->sweep_unlocked\(/g) || [];
const sweepFn = (bridge.match(/\n  string sweep_result\([\s\S]*?\n  \}\n/) || [""])[0];
const sweepCall = sweepFn.indexOf("->sweep_unlocked("), sweepFix = sweepFn.indexOf("fix_relay_false(config);");
if (sweeps.length !== 1 || sweepCall < 0 || sweepFix < 0 || sweepFix > sweepCall) bad.push("the core's sweep is not called exactly once, in sweep_result after fix_relay_false (" + sweeps.length + " calls)");
if ((bridge.replace(/zephyr_wasm_bridge::(build|prepare)_sweep_unlocked\(/g, "").replace(/->sweep_unlocked\(/g, "").match(/\bsweep_unlocked\(/g) || []).length !== 0) bad.push("the built bridge calls sweep_unlocked otherwise");
// the release bindings: exactly one relays (relay_prepared); none submits by hex, signs or mines; the only sweeps are the
// two that build (build_sweep_unlocked, prepare_sweep_unlocked), each bound to the bridge function of its name
const FORBIDDEN = /relay|submit|sweep|commit|send_raw|sign_txs|create_txs|mining/;
const SWEEP_BUILDS = ["build_sweep_unlocked", "prepare_sweep_unlocked"];
const indexText = fs.readFileSync(indexFile, "utf8");
const bindings = (indexText.replace(/#if defined\(ZEPHYR_TS_TEST_INSTRUMENTATION\)[\s\S]*?#endif/g, "").match(/^[ \t]*emscripten::function\("([A-Za-z0-9_]+)"/gm) || []).map((l) => l.replace(/^.*\("/, "").replace(/"$/, ""));
const relaying = bindings.filter((b) => FORBIDDEN.test(b) && !SWEEP_BUILDS.includes(b));
if (relaying.length !== 1 || relaying[0] !== "relay_prepared") bad.push("release bindings that relay or submit: " + JSON.stringify(relaying));
if (!/emscripten::function\("relay_prepared", &zephyr_wasm_bridge::relay_prepared\)/.test(indexText)) bad.push("relay_prepared is not bound to the bridge function relay_prepared");
for (const b of SWEEP_BUILDS) if (bindings.includes(b) && !indexText.includes("emscripten::function(\"" + b + "\", &zephyr_wasm_bridge::" + b + ");")) bad.push(b + " is not bound to the bridge function " + b);
if (!bindings.includes("build_txs")) bad.push("the binding check is not effective (build_txs not found)");
// the module's registered names (NUL-terminated strings): none of the inherited submit or relay bindings
const wasm = fs.readFileSync(wasmFile);
const names = new Set();
let start = -1;
for (let i = 0; i < wasm.length; i++) {
  const c = wasm[i];
  if (c >= 0x21 && c <= 0x7e) { if (start < 0) start = i; } else { if (start >= 0 && c === 0 && i - start >= 6) names.add(wasm.toString("latin1", start, i)); start = -1; }
}
for (const n of ["relay_txs", "relay_tx", "submit_txs", "create_txs", "sweep_unlocked", "sweep_output", "sweep_dust", "sign_txs", "submit_multisig_tx_hex", "start_mining"]) if (names.has(n)) bad.push("the module registers " + n);
if (!names.has("build_txs") || !names.has("relay_prepared")) bad.push("the module name check is not effective");
// the module's HTTP client passes a submit request only under the bridge's permit, after checking the transaction's hash
const http = fs.readFileSync(httpFile, "utf8");
if (!/relay_scope_for\(/.test(http) || !/expected_hash/.test(http) || !/parse_and_validate_tx_from_blob/.test(http) || !/relay\.remaining--/.test(http)) bad.push("the module's HTTP client lacks the permit check");
// the shipped transport refuses submit and relay requests except under an open scope
for (const f of shipped) {
  const t = fs.readFileSync(f, "utf8");
  if (!t.includes("/sendrawtransaction") || !t.includes("RELAY_REQUEST") || !t.includes("submit_block") || !t.includes("relayScope")) bad.push(f + " lacks the transport's relay refusal and scoped pass");
}
if (bad.length) { console.log(bad.join("\n")); process.exit(1); }
console.log("one way only: " + bindings.length + " release bindings, one relays; relay fixed to false; the commit in relay_prepared; the scoped pass in the module's client and in " + shipped.length + " shipped files");
JS
log "embedded digest check"
H=$(sha256sum dist/zephyr.wasm | cut -d' ' -f1)
grep -qF "\"$H\"" dist/zephyr.digest.js || die "dist/zephyr.digest.js does not carry the SHA-256 of dist/zephyr.wasm"
grep -qF "$H" dist/zephyr.worker.js || die "the browser worker does not embed the SHA-256 of dist/zephyr.wasm"
grep -qF "$H" dist/zephyr-ts.browser.mjs || die "the browser entry does not embed the SHA-256 of dist/zephyr.wasm"
echo "TypeScript build complete"
