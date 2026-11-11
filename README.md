# zephyr-ts

A TypeScript wallet library for Zephyr, for Node.js, browsers and Electron.

zephyr-ts is an independent project. It is not affiliated with or endorsed by the Zephyr
Protocol project. It is a port of [monero-ts](https://github.com/woodser/monero-ts) v0.11.22
(commit `f6569ca616c4723645a7bfae3a843a0358f5fca9`) onto the signed
[zephyr-backports](https://github.com/zephyr-backports) wallet core. The core decides keys,
wallet files, transactions, fees and network rules; this library adapts the TypeScript API, the
worker and transport layers and the WebAssembly bridge around it and does not change those rules.

The package is `@loki-notfound/zephyr-ts`, version `2.3.0-sec.2-ts.1`. It is not published yet
(`"private": true`); build it from source as described in [BUILDING.md](BUILDING.md).

## Status

The supported surface is the wallet lifecycle and read-only daemon access (below). There are no
transactions, transfers, conversions, history or listeners yet. Read
[docs/LIMITATIONS.md](docs/LIMITATIONS.md) before you use it with real funds or public nodes.

## Core and pinned sources

| Component | Version | Commit |
|---|---|---|
| zephyr-cpp (git submodule `external/zephyr-cpp`) | tag `v2.3.0-sec.1` | `3a2ee602ee28e6b7941b617ad4706349ad992641` |
| zephyr (cloned by the build at the pinned commit) | tag `v2.3.0-sec.2` | `8c6a120256b4bd887d6e7167d929d76e3507e0e5` |
| monero-ts (base of this repository's history) | `v0.11.22` | `f6569ca616c4723645a7bfae3a843a0358f5fca9` |

Both core tags are signed by the zephyr-backports release key,
`FB39 94F0 997C A6F0 43D7  2491 9EFF 03F5 27D2 40A1` (`keys/zephyr-backports.asc`). The core is
compiled unchanged apart from two build-only patches in `patches/core/`, which select the portable
wallet-crypto backend and add a missing `#include <map>`. Every other build input (toolchain,
archives, npm packages) is pinned by commit or SHA-256 in `bin/pins.sh` and `package-lock.json`.

To verify the core sources and their signatures:

    bin/verify_sources.sh

It fetches the pinned trees when they are absent, checks every commit, and verifies both tags
against the release key in a temporary keyring. By hand, in a checkout of each repository:

    gpg --import keys/zephyr-backports.asc
    git -C external/zephyr-cpp verify-tag v2.3.0-sec.1
    git -C external/zephyr-cpp/external/zephyr verify-tag v2.3.0-sec.2

and check that `git rev-parse <tag>^{commit}` gives the commits above.

## Supported surface

The package entry (`src/main/ts/index.ts`) exports:

* `createRandomWallet`, `restoreWalletFromSeed`, `restoreWalletFromKeys` and `createKeysWallet`
  (mainnet, testnet, stagenet), and `openWalletData` to open a full wallet from its keys and
  cache bytes; no file paths;
* on a wallet (`ZephyrWallet`): primary address and subaddresses, seed and seed language, private and public keys,
  view-only state; for full wallets also the network type, restore height, `getData` (keys and
  cache bytes) and `changePassword`; `close` (idempotent, retried after a failed close);
* read-only daemon access for full wallets: a daemon address at construction (`server`) or with
  `setDaemonConnection`, `isConnectedToDaemon`, `getDaemonHeight`, `getHeight`, one blocking
  `sync(startHeight?)`, and the balances `getBalance()` (map by asset), `getBalance(accountIdx)`
  (map by subaddress index) and `getBalance(assetType, accountIdx, subaddressIdx?)`, with the same
  shapes for `getUnlockedBalance`; amounts are `bigint`;
* `validateAddress`, `ZephyrWalletError` (a fixed code and an optional fixed diagnostic; no
  native or daemon text, no secrets), `setWorkerDistPath`, `setWasmModuleUrl` and
  `terminateWorker`;
* the types `ZephyrWalletData`, `ZephyrDaemonConnection`, `ZephyrWalletSyncResult`,
  `ZephyrWalletConstructionOptions`, `ZephyrNetworkTypeInput`, `ZephyrAssetBalances` (the map by
  asset), `ZephyrAccountBalances` (the map by subaddress index), `ZephyrWalletErrorCode` and
  `ZephyrWalletErrorDiagnostic`.

By default each wallet runs in its own worker with its own WebAssembly instance
(`proxyToWorker: false` runs it in the calling context instead). The WebAssembly module
`zephyr.wasm` is a separate file; each runtime compiles it once and shares the compiled module
with its workers. The build embeds the SHA-256 of `zephyr.wasm` in the JavaScript, and the runtime
checks the file against it before compiling: a stale or mismatched file is rejected with
`NATIVE_ERROR`/`WASM_MODULE_MISMATCH`, and a runtime without the Web Crypto digest (a browser page
on a plain `http://` origin other than `localhost`) with `NATIVE_ERROR`/`WASM_MODULE_UNVERIFIED`.
This detects a wrong file next to the JavaScript; it is not a signature.

Calls outside this surface reject with `UNSUPPORTED_CAPABILITY` before any native code runs.

```typescript
import { createRandomWallet, openWalletData, ZephyrWalletError } from "@loki-notfound/zephyr-ts";

// a new wallet that starts at the daemon's height
const wallet = await createRandomWallet({ networkType: "mainnet", password: "a strong password",
  server: "https://node.example.org" });
console.log(await wallet.getPrimaryAddress(), await wallet.getRestoreHeight());
await wallet.sync();                                   // { numBlocksFetched, receivedMoney }
const balances = await wallet.getBalance();            // ReadonlyMap<string, bigint>
const { keys, cache } = await wallet.getData();        // persist these bytes yourself
await wallet.close();

// reopen from bytes, offline
const reopened = await openWalletData({ networkType: "mainnet", password: "a strong password", keysData: keys, cacheData: cache });
try {
  await reopened.createTxs();
} catch (err) {
  if (err instanceof ZephyrWalletError) console.log(err.code); // UNSUPPORTED_CAPABILITY
}
await reopened.close();
```

In Node.js the worker script and `zephyr.wasm` are found inside the package. In a browser, serve
`zephyr.worker.js` and `zephyr.wasm` from the package (`@loki-notfound/zephyr-ts/zephyr.worker.js`
and `@loki-notfound/zephyr-ts/zephyr.wasm`) and tell the library where they are, before the first
construction:

```typescript
import { setWorkerDistPath, setWasmModuleUrl } from "@loki-notfound/zephyr-ts";
setWorkerDistPath("/assets/zephyr.worker.js"); // default "/zephyr.worker.js"
setWasmModuleUrl("/assets/zephyr.wasm");       // default "/zephyr.wasm"
```

The page needs a Content-Security-Policy that allows WebAssembly compilation and the daemon
origin; see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for the policy, the three daemon address forms
and proxy requirements.

## Not ported

Everything else inherited from monero-ts stays in the source as unported classes under
`src/main/ts/` and is not exported by the package: the daemon and wallet RPC clients, the
connection manager, background synchronization, listeners, history, transactions, transfers,
outputs, key images, rescans, proofs, multisig and file-system wallets (`src/main/ts/daemon/`,
most of `src/main/ts/wallet/`, including the inherited abstract wallet `ZephyrWalletBase`). The
inherited Monero test suite and its root entry point are not part of this repository's tree; the
tests are under `src/test/lifecycle/` and `src/test/network/`. Transactions and conversions need
further work and their own tests with funded wallets.

## Building and testing

[BUILDING.md](BUILDING.md) describes the requirements, the build from a fresh clone, offline
builds from local caches, the offline test suites, the optional file compatibility test with
zephyr-javascript and the network suite.

## Versions

Releases are tagged `v<zephyr version>-sec.<N>-ts.<M>`: `sec.<N>` is the zephyr-backports tag
of the pinned core, `ts.<M>` counts releases of this library on that core and restarts at 1 with
a new core tag. The package version is the tag without the `v`. Versions are semver
prereleases, so install an exact version. The version does not encode API compatibility; breaking
changes are announced in the release notes. Tags are annotated and signed by the maintainer key
`31DA 39AB 43E0 CA67 F1F3  A661 BA2A FF22 DF8A 4A13`.

## License and provenance

zephyr-ts is distributed under the MIT license of monero-ts (`LICENSE.txt`, copyright woodser);
the git history of monero-ts is kept. The WebAssembly module is compiled from zephyr-cpp (MIT,
`external/zephyr-cpp/LICENSE.txt`) and zephyr (BSD 3-Clause, The Monero Project, with notices for
parts from CryptoNote and Boolberry, `external/zephyr-cpp/external/zephyr/LICENSE`), together with
the third-party code those trees include (among others Boost under the Boost Software License
1.0 and parts of libsodium under the ISC license); their license files are in the pinned sources.
