#!/usr/bin/env bash
# Complete build from a fresh clone: verify and fetch the pinned sources, acquire the pinned
# toolchain, build the WebAssembly modules and the TypeScript layer, and record the SHA-256 of
# every output in dist/SHA256SUMS. See BUILDING.md for requirements and offline use.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
bash "$HERE/verify_sources.sh"
bash "$HERE/fetch_toolchain.sh"
bash "$HERE/build_wasm.sh"
bash "$HERE/build_ts.sh"
. "$HERE/pins.sh"
cd "$ROOT"
sha256sum dist/zephyr.js dist/zephyr.wasm dist/zephyr.digest.js dist/zephyr.worker.js dist/zephyr-ts.browser.mjs dist/zephyr.test.js dist/zephyr.test.wasm wasm_exception_whitelist.txt > dist/SHA256SUMS
cat dist/SHA256SUMS
# build manifest: the source commit, every pinned input and the output identities
export ZEPHYR_COMMIT ZEPHYR_TAG ZEPHYR_CPP_COMMIT ZEPHYR_CPP_TAG RANDOMX_COMMIT RAPIDJSON_COMMIT BACKPORTS_KEY_FINGERPRINT EMSDK_COMMIT EMSCRIPTEN_VERSION \
  CMAKE_ARCHIVE CMAKE_SHA256 BOOST_ARCHIVE BOOST_SHA256 OPENSSL_ARCHIVE OPENSSL_SHA256 UNBOUND_ARCHIVE UNBOUND_SHA256 \
  CORE_PATCH_ZEPHYR CORE_PATCH_ZEPHYR_SHA256 CORE_PATCH_ZEPHYR_CPP CORE_PATCH_ZEPHYR_CPP_SHA256
SOURCE_COMMIT=$(git rev-parse HEAD 2>/dev/null || echo unknown) SOURCE_DIRTY=$(git status --porcelain --ignore-submodules=dirty 2>/dev/null | grep -c . || true) node - <<'JS'
const fs = require("fs"); const crypto = require("crypto"); const e = process.env;
const sha = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const outputs = {};
for (const f of ["dist/zephyr.js", "dist/zephyr.wasm", "dist/zephyr.digest.js", "dist/zephyr.worker.js", "dist/zephyr-ts.browser.mjs", "dist/zephyr.test.js", "dist/zephyr.test.wasm"]) outputs[f] = { bytes: fs.statSync(f).size, sha256: sha(f) };
const manifest = {
  package: { name: pkg.name, version: pkg.version },
  source: { commit: e.SOURCE_COMMIT, uncommittedChanges: Number(e.SOURCE_DIRTY) },
  core: { zephyr: { tag: e.ZEPHYR_TAG, commit: e.ZEPHYR_COMMIT }, "zephyr-cpp": { tag: e.ZEPHYR_CPP_TAG, commit: e.ZEPHYR_CPP_COMMIT },
    randomx: e.RANDOMX_COMMIT, rapidjson: e.RAPIDJSON_COMMIT, releaseKey: e.BACKPORTS_KEY_FINGERPRINT,
    buildOnlyPatches: { [e.CORE_PATCH_ZEPHYR]: e.CORE_PATCH_ZEPHYR_SHA256, [e.CORE_PATCH_ZEPHYR_CPP]: e.CORE_PATCH_ZEPHYR_CPP_SHA256 } },
  toolchain: { emsdk: e.EMSDK_COMMIT, emscripten: e.EMSCRIPTEN_VERSION, node: process.version,
    archives: { [e.CMAKE_ARCHIVE]: e.CMAKE_SHA256, [e.BOOST_ARCHIVE]: e.BOOST_SHA256, [e.OPENSSL_ARCHIVE]: e.OPENSSL_SHA256, [e.UNBOUND_ARCHIVE]: e.UNBOUND_SHA256 } },
  npmLockSha256: sha("package-lock.json"), exceptionWhitelistSha256: sha("wasm_exception_whitelist.txt"), outputs
};
fs.writeFileSync("dist/MANIFEST.json", JSON.stringify(manifest, null, 2) + "\n");
console.log("dist/MANIFEST.json written");
JS
echo "build complete"
