#!/usr/bin/env bash
# Pack the npm package into build/package/ (nothing is published) and check the tarball against
# the allowlist: only the entry module and the modules it loads, their declarations, the browser
# entry, the release glue, module and browser worker, the license and the documentation. No test output, test
# module, test hook, source map or unported entry point. Run bin/build.sh first.
#
# The tarball does not depend on the packing host or time: npm writes a fixed date into every
# entry and no owner, and this script packs a staged copy of the package files whose modes are
# fixed (0644 for every file, 0755 for directories), so neither the host's umask nor an execute bit
# left by a build tool reaches the archive; npm itself marks the files named in package.json "bin"
# executable (0755; the package has none). Packing the same tree twice, on any host with the same
# Node.js and npm, gives the same SHA-256.
set -euo pipefail
. "$(dirname "$0")/pins.sh"
cd "$ROOT"
OUT=$ROOT/build/package; rm -rf "$OUT"; mkdir -p "$OUT"
STAGE=$OUT/stage
npm pack --dry-run --json --ignore-scripts > "$OUT/files.json" 2> "$OUT/pack-list.log" || { tail -n 20 "$OUT/pack-list.log"; die "npm pack --dry-run failed"; }
node - "$OUT/files.json" "$ROOT" "$STAGE" <<'JS'
// copy the files npm would pack into the stage, with fixed modes; nothing else
const fs = require("fs"); const path = require("path");
const [list, root, stage] = process.argv.slice(2);
const report = JSON.parse(fs.readFileSync(list, "utf8"));
if (!Array.isArray(report) || report.length !== 1 || !Array.isArray(report[0].files)) { console.log("unexpected npm pack --dry-run output"); process.exit(1); }
fs.mkdirSync(stage, { mode: 0o755 });
fs.chmodSync(stage, 0o755);
for (const f of report[0].files) {
  const rel = f.path;
  if (typeof rel !== "string" || rel.length === 0 || path.isAbsolute(rel) || rel.split("/").some((p) => p === "" || p === "." || p === "..")) { console.log("unexpected path in the pack list"); process.exit(1); }
  const src = path.join(root, rel); const dst = path.join(stage, rel);
  const st = fs.lstatSync(src);
  if (!st.isFile()) { console.log("not a regular file: " + rel); process.exit(1); }
  let dir = stage;
  for (const part of path.dirname(rel).split("/").filter((p) => p !== ".")) {
    dir = path.join(dir, part);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);
    fs.chmodSync(dir, 0o755);
  }
  fs.copyFileSync(src, dst);
  fs.chmodSync(dst, 0o644);
}
console.log(report[0].files.length + " files staged with fixed modes");
JS
( cd "$STAGE" && npm pack --ignore-scripts --pack-destination "$OUT" ) > "$OUT/pack.log" 2>&1 || { tail -n 20 "$OUT/pack.log"; die "npm pack failed"; }
TGZ=$(ls "$OUT"/*.tgz); [ "$(ls "$OUT"/*.tgz | wc -l)" = 1 ] || die "expected one tarball"
tar -tzf "$TGZ" | sort > "$OUT/contents.txt"
# every entry has the fixed mode 0644 (the package declares no "bin"), no owner and npm's fixed date
tar -tvzf "$TGZ" --numeric-owner --utc | awk '{ if ($1 != "-rw-r--r--" || $2 != "0/0" || $4 != "1985-10-26" || $5 != "08:15") { print "unexpected entry metadata: " $0; bad = 1 } } END { exit bad }' \
  || die "the tarball's entry metadata depends on the host"
node - "$OUT/contents.txt" "$TGZ" <<'JS'
const fs = require("fs");
const files = fs.readFileSync(process.argv[2], "utf8").split("\n").filter(Boolean);
const allowed = [/^package\/(package\.json|README\.md|LICENSE\.txt)$/, /^package\/docs\/(LIMITATIONS|DEPLOYMENT)\.md$/,
  /^package\/dist\/zephyr\.(js|wasm|digest\.js|worker\.js|worker\.js\.LICENSE\.txt)$/, /^package\/dist\/zephyr-ts\.browser\.mjs$/,
  /^package\/dist\/src\/main\/ts\/[A-Za-z0-9_/]+\.(js|d\.ts)$/];
const bad = files.filter((f) => !allowed.some((re) => re.test(f)));
const required = ["package/package.json", "package/dist/zephyr.js", "package/dist/zephyr.wasm", "package/dist/zephyr.digest.js", "package/dist/zephyr.worker.js", "package/dist/zephyr-ts.browser.mjs",
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
for (const f of ["package/dist/zephyr.worker.js", "package/dist/zephyr-ts.browser.mjs"]) if (!fs.readFileSync(path.join(process.argv[1], f), "utf8").includes(wasm)) { console.log(f + " does not embed the SHA-256 of the packed zephyr.wasm"); process.exit(1); }
console.log(p.name + " " + p.version + ": exports " + Object.keys(p.exports).join(" ") + " resolve");' "$TMP"
sha256sum "$TGZ"
echo "package check passed"
