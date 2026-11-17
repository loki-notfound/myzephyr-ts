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
4. `bin/build_ts.sh`: `npm ci`, a TypeScript check, the Babel output in `dist/src/` (the Node.js
   build), the declarations of the package entry, the browser worker `dist/zephyr.worker.js` and
   the browser entry `dist/zephyr-ts.browser.mjs` (`webpack.browser.js`), and the browser test
   pages; it checks that the browser entry loads no other module and that no shipped file contains
   test instrumentation.

It ends by writing `dist/SHA256SUMS` and `dist/MANIFEST.json` (the source commit, every pinned input
and the output identities). The build applies the core patches inside the submodule's
working tree and places dependency sources there; `.gitmodules` marks the submodule as
`ignore = dirty` for that reason.

The compile runs from the repository root with relative paths (`bin/relpath_launcher.sh`) and maps
the root to a fixed name, so the outputs do not depend on where the repository is checked out. On
the same toolchain, two builds of the same commit produce identical `dist/zephyr.js`,
`dist/zephyr.wasm`, `dist/zephyr.worker.js` and `dist/zephyr-ts.browser.mjs`.

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
its allowlist: the package entry and the modules it loads with their declarations, the browser
entry, the release glue, `zephyr.wasm`, the browser worker with its license file, `README.md`,
`LICENSE.txt` and the two documents in `docs/`. The exports map exposes only the entry (the
CommonJS build, and the browser entry under the `browser` condition), `zephyr.wasm`,
`zephyr.worker.js` and `package.json`.

The tarball depends neither on the host's umask nor on the time: the script packs a staged copy of
the package files with fixed modes (0644 for files, 0755 for directories; npm would mark the files
named in `"bin"` executable, and the package has none), and npm writes a fixed date and no owner
into every entry. The same tree packed with the same Node.js and npm gives the same SHA-256 on any
host.

## Offline tests

    bin/test_offline.sh

runs, with no network access:

* the lifecycle suite (checks `C01`-`C39`) with the release module and the instrumented suite
  (`T00`-`T23`) with the test module, in Node.js directly and through wallet workers, under a
  preloaded monitor that blocks every connection and records unexpected file writes (among them `C38`
  and `C39`: the relay calls' rejections before dispatch and the strict decoding of their results and
  worker messages; `T23`: the life of a kept build with a synthetic transaction, its void causes and
  the allocator);
* the module loading cases in Node.js, directly and through workers: a missing `zephyr.wasm`,
  a file that is not WebAssembly, a module of another program or build, a changed byte and a
  runtime without Web Crypto reject with fixed diagnostics before any worker starts, and a failed
  load is not cached;
* the redirect checks (`R00`-`R04`) in Node.js, in the main thread and in a wallet worker: two
  loopback servers started by the runner (the only connections the monitor lets through), the
  first answering 301, 302, 303, 307 and 308 to JSON requests with a body, to the same origin and
  to the binary request of a running sync; the redirect target must receive nothing and the call
  must fail with the fixed daemon diagnostic; then `H01`: with a wallet connected to the first
  server, the history calls `getTxs`, `getTransfers` and `getTx` send no request; and `P01`: the
  first server's constructed pool daemons (an empty pool, two pool transactions that do not parse,
  a node status with a marker text), against which `refreshPool` must send exactly the pool hashes
  request and then the transactions request, skip what does not parse, keep the node's text out of
  its error and leave the history empty; `S02` (main thread): the transport passes a submit request
  only with the id of an open relay scope, as POST to exactly that scope's address, once, and refuses
  every other form before sending;
* `S03`: the relay checks with the test module in the main thread against the first server's
  constructed sink daemons (`/sink/<mode>`, answered by `src/test/network/relaySink.cjs`): a wallet
  without funds keeps a synthetic transaction (a test-module hook; it spends nothing and no chain
  would accept it) and relays it to an accepting sink, to one refusing with each reason of the daemon's
  reply, to a busy one, one answering HTTP 500, an unreadable answer, a dropped connection and a late
  answer, and to a closed port; every outcome must have its fixed pair, every relay call exactly one
  submit request (none for a void token), a retry the same bytes, and no error the sink's node text; a
  kept build prepared while the closed port was configured must reach the accepting sink configured with
  `setDaemonConnection` before the relay call;
* the same two suites and the module loading cases in headless Chromium, in a wallet worker,
  with every non-loopback request sent to a closed proxy port and under the page policy of
  `docs/DEPLOYMENT.md`, and the redirect checks in the page and in a wallet worker (the policy then
  also admits both loopback servers, so that a followed redirect would reach its target).

Some checks do not apply in direct mode and are reported as `not-run` there. Results with codes,
counts and timings only are written to `build/test-results/offline/`. Set `SKIP_BROWSER=1` to run
the Node.js parts only.

## File compatibility with zephyr-javascript

    bin/test_crossopen.sh

clones zephyr-javascript at its pinned, signed tag `v2.3.0-sec.1` into `build/`, then moves a
disposable wallet both ways: created here, opened, changed and saved there, opened here again and
checked there. A second wallet carries accounts, subaddresses and labels: created, changed and
cleared on each side and read on the other. Both sides run offline under the monitor.

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
misbehaving daemons, daemon text that must not reach errors, close and a forced stop during a sync,
the daemon's synchronization state and the restore height of a new wallet. Load: at most two
concurrent upstream connections, every sync starts at most 2,000 blocks below the daemon height,
about 15 syncs (two of them stopped after 400 ms). Only three of them download the block hashes
(about 29 MB each near height 900,000), all in the Node.js direct run: the fresh restore of `N02`,
the HTTPS restore of `N03` and the new wallet of `N17`; every other sync reopens the wallet bytes
saved by `N02`. Set `DIRECT_CHECKS` without `N17` (and without `ZEPHYR_TS_TEST_DAEMON_HTTPS`) to
keep it to one. A disposable wallet without funds lives in `build/test-wallets/` during the run and
is removed afterwards; set `ZEPHYR_TS_TEST_KEEP_WALLET` to a new directory to keep a copy for the
packaging tests.

`N22` (Node.js direct, with the funded inputs below) builds transactions without relay on a copy of
the funded wallet: one per V2 asset to its own second account, one back, two destinations and a
repeated build, every request through the forwarder, which forwards only its read allowlist and
counts submit and relay requests (there must be none); balances, history and the reopened bytes must
be unchanged and the proxied descriptions equal except the fields random by nature. `N23` builds
again in the test module (`--test-module`, its own direct run on the bytes `N22` synced, no sync) and
requires the allocator to return to its level after every build. `N24` (after `N22`, from the bytes
`N22` holds, one more sync) builds each of the six conversions without relay, 0.1 of the source asset
to the wallet's own primary address: for each pair it reads the chain's reserve state through the
forwarder (the pricing record of the wallet's top block, the circulating supply, the pricing record
history), derives with the pinned core's reserve rule whether the pair builds or is refused, and
requires exactly that outcome (a description, or `TX_NOT_POSSIBLE`/`RESERVE_RATIO`); it recomputes the
minted amount with the core's formula from the pricing record the transaction names and requires it to
be equal, repeats the six in a worker, and requires balances, history and the reopened bytes to be
unchanged. `N26` (after `N22`, from its bytes, no sync) builds a same-asset transfer and a conversion
through forwarder mounts that answer the circulating supply or the pricing record history with a JSON-RPC
error or HTTP 500 carrying node text, and requires `DAEMON_ERROR`/`DAEMON_RESPONSE` without that text, then
a working build through the plain forwarder. The transport check `S01` (offline,
in the redirect runners' main thread and page) shows that the transport refuses every submit and
relay request before sending it outside a relay call, `S02` and `S03` the one way a relay passes.

Relay is tested against a local sink only; this suite relays nothing to the network. What the network
accepted was shown separately, by a funded test on mainnet on 2026-11-15 (docs/LIMITATIONS.md). Before the runs,
`src/test/network/sinkSelfTest.cjs` starts the forwarder against a counting loopback upstream and
sends every submit and relay form to every mount: the plain mounts refuse them, the `/sink/<mode>`
mounts answer them, and the upstream must receive none of them. `N27` (Node.js direct, after `N26`,
from the bytes `N22` holds, fresh copies, the wallet connected to a sink mount that forwards only the
read allowlist) prepares and relays, per V2 asset, a same-asset transfer to the wallet's own second
account, a two-destination transfer from that account back, each conversion the chain allows at that
moment, and two of them in a worker (0.1 of the source asset, only the wallet's own addresses): the
prepared description must equal a build's except the fields random by nature, the accepting sink must
receive exactly one submit request and the upstream none, and afterwards the history must list the
unconfirmed outgoing transaction with the described hash, fee and asset, the source account's balance
must have fallen by the debited total (less what the core counts back for a pending transfer to the
account's own addresses) and its unlocked balance by the spent inputs, the saved bytes
must reopen to the same state, and a sync and a pool refresh must leave it pending. Then a refusing
sink (the token void, the wallet unchanged), a dropped connection and a late answer (unknown outcomes,
the wallet unchanged, the token kept; its retry sends the same bytes and is accepted). `N28` follows
`N25` in the test module's run and measures the allocator around a relay the sink refuses, a relay to
an unreachable daemon and a relay with a void token.

`N19` (every run) counts the requests at the forwarder and in the request allowlist while the
history calls run: there must be none. `N21` (every run) calls `refreshPool` twice through the
forwarder: only the pool hashes and pool transactions may be requested, nothing refused, and the
history of the disposable wallet stays empty. `N20` reads the history of a funded test wallet and runs only
in the Node.js direct run with inputs you keep outside this repository:

    export FUNDED_WALLET_IN=<directory with a copy of the wallet: keys.bin, cache.bin, password.txt>
    export FUNDED_EXPECT=<its expected history, JSON: {"transfers":[{hash, height, direction, asset, amount, accountIndex, subaddressIndex}], "txs":[...], "balances":{...}}>

`transfers` lists every transfer (an outgoing transfer has no `subaddressIndex`); the optional `txs` list
every transaction with its `fee`, `feeAsset`, `incoming` transfers, `outgoing` transfer (its destinations
by their index in the wallet, never an address) and `conversion`, and the optional `balances` the balance
and unlocked balance per account index and asset, amounts as decimal strings (`FundedExpectations` in
`src/test/network/NetworkChecks.ts`). It syncs the copy (never the input), compares every transfer and,
when given, every transaction and the balances with the expectations, and derives the balances of the
wallet, its accounts and subaddresses from the history: incoming transfers add, an outgoing transfer takes
its amount and fee from the sending account, and a destination at the sending account in the source asset,
which the core does not list as incoming, stays in its balance. It applies every query filter, compares
direct and worker results field by field, and syncs again after the next block to see the confirmations
grow (two more syncs; up to twenty minutes of waiting).
`FUNDED_WALLET_OUT=<new directory>` receives the synced bytes. Without the two variables `N20` is
reported as not run.

## Packaging tests

    ZEPHYR_TS_TEST_KEEP_WALLET=build/test-wallets/saved bin/test_network.sh   # or reuse a saved wallet
    ZEPHYR_TS_TEST_WALLET_DIR=build/test-wallets/saved bin/test_package.sh

packs the package and installs the tarball into the three minimal consumers in `consumers/`, each
from its own lockfile and with nothing else (the consumers' tools are their own dependencies, not
the package's): `node` (`require` and `import` of the entry, and a type check of the shipped
declarations with library checking and without Node.js types), `webpack` (a production bundle
without any resolve fallback) and `vite` (the development server and a production build, without
a configuration file). The three browser runs use headless Chromium behind the loopback forwarder
of the network suite, under the page policy of `docs/DEPLOYMENT.md`. Every run creates a wallet
with the daemon, saves it, reopens it and syncs the saved wallet once, through the package entry
only; the browser runs also check that the page
loaded the package's module and its worker script (webpack's minimizer rewrites the worker, and
the development server appends an inline source map to it). `ZEPHYR_TS_TEST_WALLET_DIR` names a saved
disposable wallet (`keys.bin`, `cache.bin`, `password.txt`) at most 2,000 blocks below the daemon
height, so that the five syncs download no block hashes. Results, including the size of every file
each consumer ships, go to `build/test-results/package/`. With `OFFLINE=1` the consumers install
from the npm cache only.

## Platform tests

The platform tests take a packed tarball built elsewhere (on Linux, by `bin/pack.sh`) to the machine
they run on and test it there without building anything: no WebAssembly compilation, no TypeScript
build. They need Node.js 22 or newer and npm, and run on Linux, macOS and Windows (in Git Bash).
`docs/PLATFORMS.md` lists where the workflow runs them.

    bin/platform_prepare.sh <tarball> <file with its SHA-256>
    bin/test_platform_node.sh
    bin/test_platform_browser.sh <label> --launch <Chromium-family binary>
    bin/test_platform_browser.sh <label> --webdriver <driver binary>|auto --browser chrome|msedge|firefox|safari [--browser-binary <path>]
    bin/test_platform_electron.sh

1. `bin/platform_prepare.sh` prints the system, architecture and runtime versions, checks the
   tarball's SHA-256 against the file (`<hash>  <name>`, as `sha256sum` writes it), installs the
   tarball into copies of `consumers/node` and `consumers/vite` under `build/platform/` from their
   lockfiles (with `OFFLINE=1` from the npm cache only), checks that each installed package equals
   the tarball file by file, and builds the Vite consumer (production build, no configuration file).
2. `bin/test_platform_node.sh` runs the offline checks K01 to K11 of
   `consumers/vite/src/offlineChecks.js` through the package entry: loaded with `require` and with
   `import`, each in the main thread and with a worker per wallet, under a preload that blocks and
   counts every network access in the main thread and the workers (`consumers/node/offlineGuard.cjs`);
   a run passes only with every check passed, the package's `zephyr.wasm` installed and no network
   access attempted. Then it type-checks the shipped declarations without Node.js types.
3. `bin/test_platform_browser.sh` serves the Vite build from `127.0.0.1` under the policies of
   `docs/DEPLOYMENT.md` (`src/test/platform/pageServer.cjs`) and opens `index.html?offline`, which runs
   the same checks with the wallet in a worker and posts the result. A Chromium-family browser can be
   started directly (`--launch`, headless, network contained as in the offline suites); any browser
   can be driven through the WebDriver endpoint of its driver (`--webdriver`; `auto` takes the driver
   named by `CHROMEWEBDRIVER`, `EDGEWEBDRIVER` or `GECKOWEBDRIVER`, as the hosted runner images set
   them, else the one on the `PATH`, and `/usr/bin/safaridriver` for Safari, which needs
   `safaridriver --enable` once). The runner (`src/test/platform/runBrowser.cjs`) uses no dependency:
   it speaks WebDriver with Node.js's own `fetch`. A run passes only with every check passed, exactly
   one WebAssembly module loaded (the package's, by SHA-256), the worker script served and no policy
   violation reported other than the browser's own request for `/favicon.ico`.
4. `bin/test_platform_electron.sh` installs `consumers/electron` from its lockfile, which pins the
   current stable Electron (45.2.1) and the oldest supported major (43.8.6); the package's own
   installer downloads each Electron archive and checks it against the package's `checksums.json`,
   and the script prints that SHA-256 and compares it again. Each Electron runs the checks in its
   main process through the Node.js entry (directly and with a worker per wallet) and in a sandboxed
   renderer that loads the Vite build from a privileged `app://` scheme under the same policies
   (`consumers/electron/main.cjs`). On Linux without a display it runs under `xvfb-run`.

Results go to `build/test-results/platform/`. With `?offline`, the page of the Vite consumer shows
PASS or FAIL per check, the browser and system it detected and a short result block; when its server
forwards a daemon under `/rpc` of the same origin, it also offers an optional, read-only online step
(connect, height, a new wallet at that height and its sync). The platform tests never use it.

## The guide and its site

The user guide is Markdown in `docs/guide/`, readable on GitHub as it is. Its examples are checked
against an installed package:

    bin/check_guide.sh <directory with node_modules/@loki-notfound/zephyr-ts>

type-checks every TypeScript block of the guide under `strict` (a block may opt out only with a
`no-check: <reason>` marker, which the check counts and prints), runs the blocks marked `run` in Node.js
under `consumers/node/offlineGuard.cjs` (each must exit with status 0 and attempt no network access),
checks that every declaration in the API reference appears in the package's shipped declarations, and
that the reference names exactly the package's exports, the public members of `ZephyrWallet` and
`ZephyrWalletError`, the error codes and the diagnostics (`site/check_guide.cjs`). It uses the TypeScript
compiler and the Node.js types of the repository's devDependencies, which `bin/build_ts.sh` installs;
`TYPESCRIPT_DIR` names another directory that holds both. To check against a packed or released tarball,
install it into an empty project first:

    mkdir -p build/guide-consumer
    echo '{ "name": "guide-consumer", "private": true }' > build/guide-consumer/package.json
    (cd build/guide-consumer && npm install ../package/*.tgz)
    bin/check_guide.sh build/guide-consumer

The guide is also published as a static site:

    bin/build_site.sh
    bin/check_site.sh

write the site to `build/site/` (`site/build_site.cjs`: one page per Markdown file, relative links only,
no JavaScript, with a converter for exactly the Markdown the guide uses that fails on anything else) and
check it (`site/check_site.cjs`): a page for every guide file, the page policy
`default-src 'none'; style-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'` in every
page, no script, style attribute, external resource or absolute path, one level-1 heading and no skipped
heading level, and every relative link and anchor resolves. Both need only Node.js and git. The site
takes its look from the lateo house style: `site/assets/` holds unchanged copies of its stylesheets and
favicons (`STYLE-VERSION`, `NOTICE.txt`), and `site/assets/site.css` the site's own additions.

The build job of the workflow runs `bin/check_guide.sh` with the packed tarball, `bin/build_site.sh` and
`bin/check_site.sh` after `bin/pack.sh`. `.github/workflows/pages.yml` builds and checks the site from
`main` and publishes it with GitHub Pages at `https://loki-notfound.github.io/myzephyr-ts/`, on pushes
that change the guide, the site tooling or that workflow, and by manual dispatch.

## Continuous integration

`.github/workflows/build.yml` runs on every pull request to `main` and on every push to `main`. The
build job on an `ubuntu-24.04` runner with Node.js 22 checks out the tested commit (the pull request's
head, not a merge commit), runs `bin/build.sh` from that fresh checkout, `bin/pack.sh` and
`bin/test_offline.sh` with the runner's Chromium (`CHROMIUM`), and keeps the package tarball with
its SHA-256 as a workflow artifact (three days). The platform jobs `node`, `browser` and `electron`
then run on Linux, Windows and macOS runners (`docs/PLATFORMS.md`): each downloads that artifact,
runs `bin/platform_prepare.sh` on it and one of the platform test scripts, and builds nothing. The
network suite, the packaging tests and the file compatibility test are not part of the workflow:
they need a daemon or another repository.

* The workflow reads the repository only (`permissions: contents: read`), uses no secret and
  does not run for `pull_request_target`; the checkout keeps no credentials.
* Nothing is cached between runs: every input is fetched and verified by commit or SHA-256 as in
  a local build.
* Every action is pinned by its full commit, with the release in a comment.
* The job prints the versions of Node.js, npm and Chromium, and writes `dist/SHA256SUMS` and the
  SHA-256 of the package tarball to its summary, so that a build on another machine and
  operating system can be compared with them. If the commit carries `.github/package.sha256`
  (the tarball hash recorded from a build of that commit, `<hash>  <file name>`), the summary also
  prints it and whether the run's tarball equals it. A difference does not fail the job.
* Ubuntu 24.04 denies unprivileged user namespaces to the runner's Chromium, which the tests run
  with its sandbox; the job lifts that restriction on its disposable runner.
* Every platform job prints the system, architecture, runtime and browser versions and the
  tarball's SHA-256, and stops at its first failed step. On Windows the checkout keeps the committed
  line endings (`core.autocrlf false`), so that the scripts run in Git Bash; the Safari job enables
  `safaridriver` first; the Linux browser and Electron jobs lift the user namespace restriction as
  the build job does.
* The build job stops after 150 minutes, each platform job after 45. A newer push to the same pull
  request cancels that pull request's run still in progress; a push to `main` never cancels or
  replaces another run, so every landed commit keeps its run and its hashes.

A run needs about 4 GB of disk. Measured on an 11-core machine with the inputs already on disk:
the build about 7 minutes, the offline tests about 19 minutes. A runner also downloads the
toolchain and sources, and a 4-core runner compiles more slowly.
