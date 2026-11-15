#!/usr/bin/env bash
# Offline platform checks of the packed package in Electron on this machine (run
# bin/platform_prepare.sh first): the consumer in consumers/electron, installed from its lockfile,
# for the current stable Electron and the oldest supported major (both pinned there). The Electron
# archive is downloaded by the package's own installer, which checks it against the package's
# checksums.json; this script prints that SHA-256 and compares it again. Each Electron runs the
# checks of consumers/vite/src/offlineChecks.js in its main process (directly and with a worker per
# wallet) and in a sandboxed renderer with the wallet in a worker (consumers/electron/main.cjs).
# On Linux without a display it runs under xvfb-run.
# Results: build/test-results/platform/electron-<current|oldest>/.
# Runs on Linux, macOS and Windows (Git Bash).
set -euo pipefail
. "$(dirname "$0")/pins.sh"
# a time bound that also works where GNU timeout is missing (macOS)
bounded() { local s=$1; shift; if command -v timeout > /dev/null 2>&1; then timeout "$s" "$@"; else perl -e '$SIG{ALRM} = sub { kill "TERM", $pid; exit 124 }; alarm shift @ARGV; $pid = fork // die; if (!$pid) { exec @ARGV or exit 127 } waitpid($pid, 0); exit($? >> 8)' "$s" "$@"; fi; }
P=$ROOT/build/platform; C=$P/consumers/electron; TOOL=$ROOT/src/test/platform/platformTool.cjs
[ -s "$P/consumers/vite/dist/index.html" ] && [ -d "$P/consumers/node/node_modules" ] || die "run bin/platform_prepare.sh first"
OUT=$ROOT/build/test-results/platform; mkdir -p "$OUT"
node "$TOOL" env
log "install the Electron consumer from its lockfile"
rm -rf "$C"; cp -R "$ROOT/consumers/electron" "$C"
offline=(); [ "${OFFLINE:-0}" = 1 ] && offline=(--offline) # expanded as ${a[@]+"${a[@]}"}: bash 3.2 (macOS) rejects an empty array under set -u
( cd "$C" && npm ci ${offline[@]+"${offline[@]}"} --omit=dev --ignore-scripts --no-audit --no-fund ) > "$P/logs/electron-install.log" 2>&1 \
  || { tail -n 20 "$P/logs/electron-install.log"; die "Electron consumer: install failed"; }
node "$TOOL" installed "$P/consumers/zephyr-ts.tgz" "$C/node_modules/@loki-notfound/zephyr-ts" || die "Electron consumer: the installed package differs from the tarball"
export electron_config_cache=${electron_config_cache:-$P/electron-cache}
wrap=()
if [ "$(uname -s)" = Linux ] && [ -z "${DISPLAY:-}" ]; then command -v xvfb-run > /dev/null || die "no display and no xvfb-run"; wrap=(xvfb-run -a -s "-screen 0 1280x1024x24"); fi
for e in current oldest; do
  log "Electron ($e): download through the package's installer"
  ( cd "$C" && bounded 900 node "node_modules/electron-$e/install.js" ) > "$P/logs/electron-$e-download.log" 2>&1 || { tail -n 20 "$P/logs/electron-$e-download.log"; die "Electron ($e): download or checksum failed"; }
  node "$TOOL" electron-archive "$C/node_modules/electron-$e" "$electron_config_cache" || die "Electron ($e): archive checksum"
  BIN=$(cd "$C" && node -e 'process.stdout.write(require(process.argv[1]))' "electron-$e")
  if command -v cygpath > /dev/null 2>&1; then BIN=$(cygpath -u "$BIN"); fi # Git Bash: the Windows path of electron.exe
  [ -x "$BIN" ] || die "Electron ($e): no executable at $BIN"
  log "Electron ($e) $(cat "$C/node_modules/electron-$e/dist/version"): offline checks in the main process and a renderer"
  R_OUT=$OUT/electron-$e; rm -rf "$R_OUT"; mkdir -p "$R_OUT"
  rc=0
  ( cd "$C" && ELECTRON_ENABLE_LOGGING=0 bounded 1800 ${wrap[@]+"${wrap[@]}"} "$BIN" main.cjs --checks "$P/consumers/vite/src/offlineChecks.js" --root "$P/consumers/vite/dist" \
      --guard "$P/consumers/node/offlineGuard.cjs" --page-server "$ROOT/src/test/platform/pageServer.cjs" --out "$R_OUT" --timeout-ms 1200000 ) > "$R_OUT/electron.log" 2>&1 || rc=$?
  grep -E '^(electron |main (direct|worker) checks|renderer )' "$R_OUT/electron.log" || true
  [ "$rc" = 0 ] || { tail -n 20 "$R_OUT/electron.log"; die "Electron ($e): the offline checks failed (exit $rc)"; }
  node "$TOOL" judge "$P/consumers/zephyr-ts.tgz" "$R_OUT/electron-main-direct.json" "$R_OUT/electron-main-worker.json" "$R_OUT/electron-renderer.json" || die "Electron ($e): unexpected results"
done
echo "Electron platform checks passed"
