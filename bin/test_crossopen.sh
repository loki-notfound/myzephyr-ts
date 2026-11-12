#!/usr/bin/env bash
# Optional two-way file compatibility test with the reference wallet library zephyr-javascript
# (tag ZEPHYR_JAVASCRIPT_TAG, signed by the zephyr-backports release key): a disposable wallet
# created here is opened, re-saved and changed there and opened here again, offline on both sides
# under the network-blocking monitor. One wallet carries accounts, subaddresses and labels (created,
# changed and cleared on each side and read on the other). Run bin/build.sh first.
#
# Environment (optional): ZEPHYR_JAVASCRIPT_URL to clone from a local mirror; OFFLINE=1 installs its
# npm dependencies from the npm cache only.
set -euo pipefail
. "$(dirname "$0")/pins.sh"
cd "$ROOT"
export TZ=UTC
ZJ=$ROOT/build/zephyr-javascript
if [ ! -e "$ZJ/.git" ]; then
  git clone -q --no-checkout "$ZEPHYR_JAVASCRIPT_URL" "$ZJ"
  git -C "$ZJ" -c advice.detachedHead=false checkout -q --detach "$ZEPHYR_JAVASCRIPT_COMMIT"
fi
[ "$(git -C "$ZJ" rev-parse HEAD)" = "$ZEPHYR_JAVASCRIPT_COMMIT" ] || die "build/zephyr-javascript is not at $ZEPHYR_JAVASCRIPT_COMMIT"
GNUPGHOME=$(mktemp -d); export GNUPGHOME; trap 'gpgconf --kill gpg-agent >/dev/null 2>&1 || true; rm -rf "$GNUPGHOME"' EXIT
echo "$BACKPORTS_KEY_FILE_SHA256  $ROOT/keys/zephyr-backports.asc" | sha256sum -c --quiet -
gpg --batch --quiet --import "$ROOT/keys/zephyr-backports.asc" 2>/dev/null
[ "$(git -C "$ZJ" rev-parse "refs/tags/$ZEPHYR_JAVASCRIPT_TAG^{commit}")" = "$ZEPHYR_JAVASCRIPT_COMMIT" ] || die "tag $ZEPHYR_JAVASCRIPT_TAG does not point to the pinned commit"
git -C "$ZJ" -c gpg.program=gpg verify-tag --raw "$ZEPHYR_JAVASCRIPT_TAG" 2>&1 | grep -q "^\[GNUPG:\] VALIDSIG .* $BACKPORTS_KEY_FINGERPRINT$" || die "tag $ZEPHYR_JAVASCRIPT_TAG is not signed by the release key"
if [ ! -d "$ZJ/node_modules" ]; then
  offline=(); [ "${OFFLINE:-0}" = 1 ] && offline=(--offline)
  ( cd "$ZJ" && npm ci "${offline[@]}" --ignore-scripts --no-audit --no-fund --omit=dev > "$ROOT/build/logs/npm-ci-zephyr-javascript.log" 2>&1 ) || die "npm ci in build/zephyr-javascript failed"
fi
W=$ROOT/build/test-wallets/cross; OUT=$ROOT/build/test-results/crossopen
rm -rf "$W" "$OUT"; mkdir -p "$W" "$OUT"; chmod 700 "$W" "$OUT"
MON=(--require "$ROOT/src/test/lifecycle/nodeMonitor.cjs")
export LIFECYCLE_MONITOR_LOG=$OUT/monitor.jsonl LIFECYCLE_MONITOR_ALLOW_WRITE_DIR=$W LIFECYCLE_MONITOR_ALLOW_WRITE=
step() { # name command...
  local name=$1 rc=0; shift
  log "$name"
  ( cd "$OUT" && timeout 900 "$@" ) > "$OUT/$name.out" 2> "$OUT/$name.err" || rc=$?
  [ "$rc" = 0 ] || { grep -h '^FAILED' "$OUT/$name.out" "$OUT/$name.err" | cut -c1-200 || true; die "step $name failed"; }
}
step 1-sdk-export node "${MON[@]}" "$ROOT/dist/src/test/lifecycle/crossOpenSdk.js" --dir "$W" --phase export
step 2-reference-import-export node "${MON[@]}" "$ROOT/src/test/lifecycle/crossOpenZj.cjs" --zj "$ZJ" --dir "$W" --phase import-export
step 3-sdk-import node "${MON[@]}" "$ROOT/dist/src/test/lifecycle/crossOpenSdk.js" --dir "$W" --phase import
step 4-reference-final node "${MON[@]}" "$ROOT/src/test/lifecycle/crossOpenZj.cjs" --zj "$ZJ" --dir "$W" --phase final
! grep -q '"kind":"\(connect\|dns\|fetch\)"' "$OUT/monitor.jsonl" || die "the monitor recorded network access"
node - "$OUT" <<'JS' || die "file compatibility results differ"
const fs = require("fs"); const out = process.argv[2];
const res = (st) => { const l = fs.readFileSync(out + "/" + st + ".out", "utf8").split("\n").filter((x) => x.startsWith("RESULT ")); if (l.length !== 1) throw new Error(st); return JSON.parse(l[0].slice(7)).out; };
const bad = [];
for (const st of ["2-reference-import-export", "4-reference-final"]) {
  for (const [id, r] of Object.entries(res(st).results)) {
    if (id === "zj-mainnet-seed-created") { if (r.restoreHeight333333 !== true) bad.push(st + " " + id); continue; }
    for (const k of ["addressMatch", "networkMatch", "restoreHeightMatch", "seedMatch"]) if (r[k] !== true) bad.push(st + " " + id + " " + k);
    if (/accounts/.test(id) && r.accountsMatch !== true) bad.push(st + " " + id + " accounts and labels");
    if (st === "2-reference-import-export" && r.zjReopenAfterResave !== true) bad.push(st + " " + id + " reopen after re-save");
    if (!String(r.wrongPassword || "").toLowerCase().startsWith("invalid password")) bad.push(st + " " + id + " wrong password");
  }
}
const imp = res("3-sdk-import");
if (Object.keys(imp).length !== 7) bad.push("import count " + Object.keys(imp).length);
const final = res("4-reference-final").results;
if (!Object.keys(final).some((id) => /accounts/.test(id))) bad.push("the reference library did not reopen the accounts wallet");
for (const [id, r] of Object.entries(imp)) {
  for (const m of ["direct", "worker"]) for (const k of ["AddressMatch", "NetworkMatch", "RestoreHeightMatch", "SeedMatch"]) if (r[m + k] !== true) bad.push("import " + id + " " + m + k);
  if (/accounts/.test(id)) {
    for (const m of ["direct", "worker"]) for (const k of ["AccountsAddressesMatch", "AccountsLabelsMatch", "AccountsGetAddressMatch", "AccountsFieldsMatch"]) if (r[m + k] !== true) bad.push("import " + id + " " + m + k);
    if (r.sdkAccountsAfterResave !== true) bad.push("import " + id + " re-saved accounts");
  }
  if (r.wrongPassword !== "WRONG_PASSWORD") bad.push("import " + id + " wrong password");
}
if (bad.length) { console.log("mismatches: " + bad.join("; ")); process.exit(1); }
console.log("addresses, networks, restore heights, seeds, accounts, subaddresses and labels match both ways; wrong passwords rejected");
JS
rm -rf "$W"
echo "two-way file compatibility passed"
