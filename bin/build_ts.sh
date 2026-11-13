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
#   no-relay check  the built bridge assigns m_relay only to false and calls no submit, relay, sweep or
#                sign function; no release binding or module name can submit or relay; the shipped
#                transport carries the refusal of relay requests
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
log "no-relay check: no submit or relay binding, relay fixed to false, the transport refuses relay requests"
node - src/main/cpp/zephyr_wasm_bridge.cpp src/main/cpp/index.cpp dist/zephyr.wasm dist/zephyr.worker.js dist/zephyr-ts.browser.mjs dist/src/main/ts/common/HttpClient.js <<'JS' || die "no-relay check failed"
const fs = require("fs");
const [bridgeFile, indexFile, wasmFile, ...shipped] = process.argv.slice(2);
const bad = [];
// the bridge as compiled: without the blocks of inherited code that is not built
const bridge = fs.readFileSync(bridgeFile, "utf8").replace(/#if defined\(ZEPHYR_WASM_BRIDGE_UNPORTED\)[\s\S]*?#endif/g, "");
const relayAssignments = bridge.match(/\bm_relay\s*=[^=][^;]*;/g) || [];
if (relayAssignments.length !== 1 || !/^m_relay\s*=\s*false;$/.test(relayAssignments[0])) bad.push("m_relay is not assigned exactly once, to false: " + JSON.stringify(relayAssignments));
for (const call of ["relay_txs(", "relay_tx(", "commit_tx(", "submit_txs(", "sweep_unlocked(", "sweep_output(", "sweep_dust(", "sign_txs(", "submit_multisig_tx_hex(", "start_mining("]) {
  if (bridge.includes(call)) bad.push("the built bridge calls " + call);
}
// the release bindings: none can submit, relay, sweep or sign
const FORBIDDEN = /relay|submit|sweep|commit|send_raw|sign_txs|create_txs|mining/;
const bindings = (fs.readFileSync(indexFile, "utf8").replace(/#if defined\(ZEPHYR_TS_TEST_INSTRUMENTATION\)[\s\S]*?#endif/g, "").match(/^[ \t]*emscripten::function\("([A-Za-z0-9_]+)"/gm) || []).map((l) => l.replace(/^.*\("/, "").replace(/"$/, ""));
for (const b of bindings) if (FORBIDDEN.test(b)) bad.push("release binding " + b);
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
if (!names.has("build_txs") || !names.has("validate_address")) bad.push("the module name check is not effective");
// the shipped transport carries the refusal of relay requests
for (const f of shipped) {
  const t = fs.readFileSync(f, "utf8");
  if (!t.includes("/sendrawtransaction") || !t.includes("RELAY_REQUEST") || !t.includes("submit_block")) bad.push(f + " lacks the transport's relay refusal");
}
if (bad.length) { console.log(bad.join("\n")); process.exit(1); }
console.log("no relay: " + bindings.length + " release bindings, relay fixed to false, transport refusal in " + shipped.length + " shipped files");
JS
log "embedded digest check"
H=$(sha256sum dist/zephyr.wasm | cut -d' ' -f1)
grep -qF "\"$H\"" dist/zephyr.digest.js || die "dist/zephyr.digest.js does not carry the SHA-256 of dist/zephyr.wasm"
grep -qF "$H" dist/zephyr.worker.js || die "the browser worker does not embed the SHA-256 of dist/zephyr.wasm"
grep -qF "$H" dist/zephyr-ts.browser.mjs || die "the browser entry does not embed the SHA-256 of dist/zephyr.wasm"
echo "TypeScript build complete"
