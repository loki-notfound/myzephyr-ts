# Platforms

What is built where, what is tested automatically on which system and runtime, what only by hand,
and what is not tested. One package tarball is built on Linux and consumed unchanged on every
platform: `zephyr.wasm` is the same file everywhere and is never rebuilt per platform.

## Built

| What | Where |
|---|---|
| WebAssembly modules, TypeScript build, package tarball (`bin/build.sh`, `bin/pack.sh`) | Linux x86_64 only: the workflow's build job (Ubuntu 24.04, Node.js 22.23.4) and maintainer builds (Debian 13). Both give byte-identical outputs and the same tarball (compared by the hashes in each run's summary). Building on macOS or Windows is not supported. |

## Tested automatically

The workflow (`.github/workflows/build.yml`) runs on every pull request to `main` and every push to
`main`. Its build job runs the full offline suites on the built tree (`bin/test_offline.sh`: Node.js
22 and the runner's Chromium, Linux x86_64). Every other job downloads the tarball of that build as
a workflow artifact, checks its SHA-256 and builds nothing; it installs the tarball into the
consumers in `consumers/` from their lockfiles (`bin/platform_prepare.sh`) and runs the offline
platform checks K01 to K11 (`consumers/vite/src/offlineChecks.js`) through the package entry only:
the exported names, random wallets on the three networks, a fixed key vector that must give the same
address everywhere, seed and key restores, wallet bytes, wrong passwords and damaged bytes, password
change, configuration rejections, accounts and subaddresses, offline history and daemon calls, close
and forced stop. No job uses a daemon or the network for a test.

| Job | Runner (system, architecture) | Runtime | What runs |
|---|---|---|---|
| node | `ubuntu-24.04` (x86_64) | Node.js 22.23.4, 24.22.2, 26.13.0 | the checks with `require` and with `import`, each in the main thread and with a worker per wallet, network access blocked; the shipped declarations type-checked without Node.js types (`bin/test_platform_node.sh`) |
| node | `windows-latest` (x86_64) | Node.js 22.23.4, 26.13.0 | as above |
| node | `macos-15-intel` (x86_64), `macos-15` (arm64) | Node.js 22.23.4, 26.13.0 | as above |
| browser | `ubuntu-24.04` | Chromium (the runner's, started directly), Google Chrome, Firefox | the Vite production build of `consumers/vite`, built on the runner from the tarball, served from `127.0.0.1` under the policies of `DEPLOYMENT.md`, the checks with the wallet in a worker (`bin/test_platform_browser.sh`) |
| browser | `windows-latest` | Google Chrome, Microsoft Edge, Firefox | as above |
| browser | `macos-15` (arm64) | Google Chrome, Safari, Firefox | as above |
| browser | `macos-15-intel` | Safari | as above |
| electron | `ubuntu-24.04` (under Xvfb), `windows-latest`, `macos-15-intel`, `macos-15` | Electron 45.2.1 (current stable major) and 43.8.6 (oldest supported major) | `consumers/electron`: the checks in the main process through the Node.js entry (directly and with a worker per wallet) and in a sandboxed renderer (context isolation, no Node.js integration) that loads the Vite build from a privileged `app://` scheme, wallet in a worker (`bin/test_platform_electron.sh`) |

Browsers other than the runner's Chromium are driven through the WebDriver endpoint of the driver
the runner image provides (chromedriver, msedgedriver, geckodriver, safaridriver), with Node.js's
own `fetch`; no test dependency is added. Browser and driver versions are those of the runner image
on the day of the run, and every job prints the system, architecture, runtime and browser versions
and the tarball's SHA-256. The outcome of a job is that of the run of the commit: a platform whose
job fails or did not run is not tested.

## Tested by hand

Some systems are older than any runner image and are tested by hand with the same checks, on a
package tarball identified by its SHA-256:

| System | Tested on 2026-11-16 | Not run |
|---|---|---|
| Windows 10 Pro 22H2 (build 19045, x86_64) | Node.js 24.19.0: the offline checks through `require` and `import`, main thread and worker. Microsoft Edge 157 and Google Chrome 155: the offline checks with the wallet in a worker under the page policy of `docs/DEPLOYMENT.md`; then, in both, a connection to a public daemon through a same-origin proxy and the first synchronization of a new wallet. All passed. | Firefox, Electron, Node.js 22 |
| macOS 26.7 on an Intel Mac (x86_64) | Node.js 24.21.0: the same four runs. Google Chrome 157 and Safari 27 (from `http://127.0.0.1`, a secure context): the same offline checks and the same connection and first synchronization. All passed. | Firefox, Electron, Node.js 22 |

Both ran the package of commit `8931043c` (tarball SHA-256
`341e024ab5803b88ac6df42616029917898b1a6c55e41c0afb12b6e4343c75d9`, module
`229b1534d60258c4be2f734f89effd38fba7a2ebf8ee7f95c33e96b9eda80333`). Later commits that change only
documentation change the tarball's hash, not the tested code.

## Verified on the maintainer's Linux machine

Debian 13 x86_64, with the tarball of a local build: the Node.js checks with Node.js 22.23.4,
24.22.2 and 26.13.0, Chromium 156 (started directly), Firefox 160 (geckodriver
0.37.1), Electron 45.2.1 and 43.8.6 under Xvfb (main process and renderer).

## Not tested

* Linux on arm64, Windows on arm64, 32-bit systems;
* Node.js below 22 is not supported (the `engines` field requires 22 or newer) and not tested by the
  workflow. A probe on Linux found the technical floor lower: Node.js 20.20.2 passed every check;
  Node.js 18.20.8 rejects the first construction with `NATIVE_ERROR`/`WASM_MODULE_UNVERIFIED`
  because it has no global Web Crypto API. Node.js 27 and later are not tested;
* browsers on phones and tablets (Safari on iOS, Android), browsers older than those of the runner
  images, Firefox ESR, other Chromium-based browsers;
* Electron below 43, an Electron renderer that loads the page from `file://` or from a loopback
  server (only the privileged `app://` scheme is tested), an Electron renderer with Node.js
  integration;
* the webpack consumer outside the build job's Linux packaging tests (the platform jobs use the Vite
  build);
* everything that needs a daemon outside Linux x86_64, except the connection and first
  synchronization of a new wallet in the two manual tests above: history after a sync, building and
  relaying transactions (the network suites run on Linux only, by hand, see `BUILDING.md`);
* building the package on any system other than Linux x86_64.

## Requirements found by these tests

* Node.js 22 or newer, as `engines` states (Node.js 18 and older fail closed: no global Web
  Crypto API for the module check).
* A browser page needs a secure context for the module check (`https://`, `localhost` or
  `127.0.0.1`, see `DEPLOYMENT.md`).
* Firefox needs `script-src 'wasm-unsafe-eval'` in the policy of the worker script; Chromium does
  not (`DEPLOYMENT.md`, Content-Security-Policy).
* An Electron renderer can load the browser build from a scheme registered as privileged
  (`standard`, `secure`, `supportFetchAPI`) through `protocol.handle`, with the page policies of
  `DEPLOYMENT.md` sent as response headers.
