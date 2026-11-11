#!/usr/bin/env bash
# Pack the npm package into build/package/ (nothing is published) and check the tarball against
# the allowlist: only the entry module and the modules it loads, their declarations, the release
# glue, module and browser worker, the license and the documentation. No test output, test
# module, test hook, source map or unported entry point. Run bin/build.sh first.
set -euo pipefail
. "$(dirname "$0")/pins.sh"
cd "$ROOT"
OUT=$ROOT/build/package; rm -rf "$OUT"; mkdir -p "$OUT"
npm pack --ignore-scripts --pack-destination "$OUT" > "$OUT/pack.log" 2>&1 || { tail -n 20 "$OUT/pack.log"; die "npm pack failed"; }
TGZ=$(ls "$OUT"/*.tgz); [ "$(ls "$OUT"/*.tgz | wc -l)" = 1 ] || die "expected one tarball"
tar -tzf "$TGZ" | sort > "$OUT/contents.txt"
node - "$OUT/contents.txt" "$TGZ" <<'JS'
const fs = require("fs");
const files = fs.readFileSync(process.argv[2], "utf8").split("\n").filter(Boolean);
const allowed = [/^package\/(package\.json|README\.md|LICENSE\.txt)$/, /^package\/docs\/(LIMITATIONS|DEPLOYMENT)\.md$/,
  /^package\/dist\/zephyr\.(js|wasm|digest\.js|worker\.js|worker\.js\.LICENSE\.txt)$/, /^package\/dist\/src\/main\/ts\/[A-Za-z0-9_/]+\.(js|d\.ts)$/];
const bad = files.filter((f) => !allowed.some((re) => re.test(f)));
const required = ["package/package.json", "package/dist/zephyr.js", "package/dist/zephyr.wasm", "package/dist/zephyr.digest.js", "package/dist/zephyr.worker.js",
  "package/dist/src/main/ts/index.js", "package/dist/src/main/ts/index.d.ts", "package/dist/src/main/ts/common/ZephyrWebWorker.js"];
const missing = required.filter((f) => !files.includes(f));
if (bad.length || missing.length) { console.log("not allowed: " + JSON.stringify(bad) + "\nmissing: " + JSON.stringify(missing)); process.exit(1); }
console.log(files.length + " files, all allowed; required files present");
JS
# shipped files carry no test instrumentation
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
tar -xzf "$TGZ" -C "$TMP"
for token in __zephyrTsTestHooks __testInstall __testNativeChangePassword __testReply test_heap_in_use __testCrash __measure; do
  ! grep -rqF "$token" "$TMP/package" || die "the tarball contains test-only $token"
done
node -e '
const p = require(process.argv[1] + "/package/package.json"); const fs = require("fs"); const path = require("path");
if (p.private !== true) { console.log("package must stay private"); process.exit(1); }
const targets = [p.main, p.types].concat(Object.values(p.exports).flatMap((v) => typeof v === "string" ? [v] : Object.values(v)));
const absent = targets.concat(Object.values(p.imports)).filter((t) => !fs.existsSync(path.join(process.argv[1], "package", t)));
if (absent.length) { console.log("exports or imports without a file: " + absent); process.exit(1); }
const wasm = require("crypto").createHash("sha256").update(fs.readFileSync(path.join(process.argv[1], "package/dist/zephyr.wasm"))).digest("hex");
if (require(path.join(process.argv[1], "package/dist/zephyr.digest.js")) !== wasm) { console.log("the embedded digest is not the SHA-256 of the packed zephyr.wasm"); process.exit(1); }
console.log(p.name + " " + p.version + ": exports " + Object.keys(p.exports).join(" ") + " resolve");' "$TMP"
sha256sum "$TGZ"
echo "package check passed"
