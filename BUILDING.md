# Building and testing zephyr-ts

The build compiles the WebAssembly modules from the pinned, signed core with a pinned
Emscripten, then builds the TypeScript layer from the locked npm dependencies. Every input is
identified by a commit or a SHA-256 (`bin/pins.sh`, `package-lock.json`); a mismatch stops the
build. Nothing is installed outside the repository: the toolchain, downloads and build output go
to `build/` and `dist/`, both ignored by git.

## Requirements

Tested on Debian 13 x86_64. The build needs:

* git, gpg, curl, tar, python3, perl, make;
* gcc and g++ (a host build of the zephyr translations and the OpenSSL header generation);
* Node.js 22 and npm 10 (Babel targets the running Node.js version, so another major version can
  produce different output);
* for the browser tests: Chromium (set `CHROMIUM` to its binary if it is not `chromium` on the
  path).

Emscripten 3.1.10 (emsdk `d7b4130688bfa348392b921ab04015aa15c4f154`), CMake 3.27.9, Boost 1.84.0,
OpenSSL 3.6.5 headers and Unbound 1.19.1 headers are fetched by the build.

## Build from a fresh clone

    git clone https://github.com/loki-notfound/myzephyr-ts.git
    cd myzephyr-ts
    bin/build.sh

`bin/build.sh` runs, in order:

1. `bin/verify_sources.sh`: initializes the submodule `external/zephyr-cpp` (only this one; do
   not run a recursive submodule update), clones zephyr at its pinned commit into
   `external/zephyr-cpp/external/zephyr` and initializes its two needed submodules, checks every
   commit and verifies the signed tags against `keys/zephyr-backports.asc`;
2. `bin/fetch_toolchain.sh`: emsdk at the pinned commit with Emscripten 3.1.10, CMake and the
   dependency archives, each checked against its SHA-256;
3. `bin/build_wasm.sh`: applies the two build-only patches of `patches/core/`, builds the
   dependencies and links `dist/zephyr.js` with `dist/zephyr.wasm` (release) and
   `dist/zephyr.test.js` with `dist/zephyr.test.wasm` (test module with instrumentation, for the
   test suites only);
4. `bin/build_ts.sh`: `npm ci`, a TypeScript check, the Babel output in `dist/src/`, the
   declarations of the package entry, the browser worker `dist/zephyr.worker.js` and the browser
   test pages; it checks that no shipped file contains test instrumentation.

It ends by writing `dist/SHA256SUMS` and `dist/MANIFEST.json` (the source commit, every pinned input
and the output identities). The build applies the core patches inside the submodule's
working tree and places dependency sources there; `.gitmodules` marks the submodule as
`ignore = dirty` for that reason.

The compile runs from the repository root with relative paths (`bin/relpath_launcher.sh`) and maps
the root to a fixed name, so the outputs do not depend on where the repository is checked out. On
the same toolchain, two builds of the same commit produce identical `dist/zephyr.js`,
`dist/zephyr.wasm` and `dist/zephyr.worker.js`.

## Offline build from local copies

Each step can take its inputs from local copies; the identities are checked in the same way:

* `ZEPHYR_CPP_URL`, `ZEPHYR_URL`, `RANDOMX_URL`, `RAPIDJSON_URL`: clone from local mirrors;
* `EMSDK_SOURCE_DIR`: an existing emsdk checkout at the pinned commit with Emscripten 3.1.10
  installed (it is copied into `build/toolchain/`, never used in place);
* `ARCHIVE_DIR`: a directory with the CMake, Boost, OpenSSL and Unbound archives;
* `npm_config_cache` with `OFFLINE=1`: install the npm packages from a local cache
  (`npm ci --offline`);
* `OFFLINE=1` makes the scripts fail instead of downloading.

## Package

    bin/pack.sh

packs the npm package into `build/package/` (nothing is published) and checks the tarball against
its allowlist: the package entry and the modules it loads with their declarations, the release
glue, `zephyr.wasm`, the browser worker with its license file, `README.md`, `LICENSE.txt` and the
two documents in `docs/`. The exports map exposes only the entry, `zephyr.wasm`,
`zephyr.worker.js` and `package.json`.

## Offline tests

    bin/test_offline.sh

runs, with no network access:

* the lifecycle suite (checks `C01`-`C25`) with the release module and the instrumented suite
  (`T00`-`T16`) with the test module, in Node.js directly and through wallet workers, under a
  preloaded monitor that blocks every connection and records unexpected file writes;
* the module loading cases in Node.js, directly and through workers: a missing `zephyr.wasm`,
  a file that is not WebAssembly, a module of another program or build, a changed byte and a
  runtime without Web Crypto reject with fixed diagnostics before any worker starts, and a failed
  load is not cached;
* the same two suites and the module loading cases in headless Chromium, in a wallet worker,
  with every non-loopback request sent to a closed proxy port and under the page policy of
  `docs/DEPLOYMENT.md`.

Some checks do not apply in direct mode and are reported as `not-run` there. Results with codes,
counts and timings only are written to `build/test-results/offline/`. Set `SKIP_BROWSER=1` to run
the Node.js parts only.

## File compatibility with zephyr-javascript

    bin/test_crossopen.sh

clones zephyr-javascript at its pinned, signed tag `v2.3.0-sec.1` into `build/`, then moves a
disposable wallet both ways: created here, opened, changed and saved there, opened here again and
checked there. Both sides run offline under the monitor.

## Network tests

The network suite talks to real daemons, read-only. It names no daemon itself; give it daemons you
may query:

    export ZEPHYR_TS_TEST_DAEMON=http://<host>:17767            # a daemon reached directly
    export ZEPHYR_TS_TEST_DAEMON_HTTPS=https://<host>           # optional: the same chain over HTTPS
    bin/test_network.sh

Without `ZEPHYR_TS_TEST_DAEMON`, or with a malformed value, it stops with exit status 2 and names
the variable. `ZEPHYR_TS_TEST_DAEMON_HTTPS` is optional: without it check `N03` (a sync over HTTPS
and the comparison of its answers with the direct daemon) is reported as not run, never as passed,
the summary names it, and the suite exits with status 3 instead of 0. Exit status 1 means a check
failed.

It runs Node.js directly, Node.js through workers and Chromium (through a loopback forwarder that
relays an allowlist of read-only requests to the daemon, `ZEPHYR_TS_TEST_FORWARD_UPSTREAM`, by
default the first address). It covers the three daemon address forms, unreachable, silent and
misbehaving daemons, daemon text that must not reach errors, close during a sync, and the restore
height of a new wallet. Load: at most two concurrent upstream connections, every sync starts at most
2,000 blocks below the daemon height, about 13 syncs. Only three of them download the block hashes
(about 29 MB each near height 900,000), all in the Node.js direct run: the fresh restore of `N02`,
the HTTPS restore of `N03` and the new wallet of `N17`; every other sync reopens the wallet bytes
saved by `N02`. Set `DIRECT_CHECKS` without `N17` (and without `ZEPHYR_TS_TEST_DAEMON_HTTPS`) to
keep it to one. A disposable wallet without funds lives in `build/test-wallets/` during the run and
is removed afterwards.

## Continuous integration

The repository has no CI workflow yet. A workflow that runs `bin/build.sh`, `bin/pack.sh` and
`bin/test_offline.sh` on a Linux runner with Chromium needs about 4 GB of disk for the toolchain and
build, about 15 minutes of build and about 25 minutes of tests per run, or less with a cache of
`build/toolchain/` and `build/downloads/` keyed by `bin/pins.sh`.
