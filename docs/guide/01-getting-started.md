# 1. Getting started

This chapter explains what zephyr-ts is, what it needs, how to install it from the signed release
and how to run a first program in Node.js and in a browser.

## What zephyr-ts is

zephyr-ts is a TypeScript wallet library for Zephyr, for Node.js, browsers and Electron. It is a
port of [monero-ts](https://github.com/woodser/monero-ts) v0.11.22 onto the signed zephyr-backports
wallet core (zephyr-cpp over Zephyr's `wallet2`), compiled to one WebAssembly module. The core
decides keys, wallet files, transactions, fees and network rules. The library adapts the
TypeScript API, the worker and transport layers and the WebAssembly bridge around it, and does not
change those rules.

zephyr-ts is an independent project. It is not affiliated with or endorsed by ZephyrProtocol.

What it does:

- creates, restores and opens wallets, keeps their bytes in memory and gives them to you to store;
- reads from a Zephyr daemon: heights, one blocking synchronization, balances per asset;
- lists accounts and subaddresses, and reads the history of transactions and transfers per asset;
- builds same-asset transfers in the four V2 assets and the six conversions between them, to
  inspect them, and relays a prepared build in two explicit steps.

What it does not do: sweeps, listeners and background synchronization, outputs, key images,
rescans, proofs, multisig, wallet files on disk, the daemon and wallet RPC clients, and
transactions in the V1 assets. A call outside the supported surface rejects with
`UNSUPPORTED_CAPABILITY` before any native code runs. Read
[chapter 11](11-known-limitations.md) before you use the library with real funds or public nodes.

## Requirements

- **Node.js 22 or newer.** The package's `engines` field requires it. The automatic platform jobs
  run Node.js 22, 24 and 26 ([docs/PLATFORMS.md](../PLATFORMS.md)).
- **Browsers:** the offline checks of the package run automatically in Chromium, Google Chrome,
  Microsoft Edge, Firefox and Safari, as provided by the runner images on the day of the run, and by
  hand in Edge 157 and Chrome 155 on Windows 10 and in Chrome 157 and Safari 27 on macOS 26
  (2026-11-16). Browsers on phones and tablets, Firefox ESR and other Chromium-based browsers are
  not tested.
- **A secure context in the browser:** the page must be served over `https://`, from `localhost`
  or from `127.0.0.1`, because the module check needs the Web Crypto API
  ([chapter 9](09-deploying-a-web-wallet.md#secure-context)).
- **Electron 43 or 45:** the main process through the Node.js entry, and a sandboxed renderer that
  loads the page from a privileged `app://` scheme. `file://` pages are not tested
  ([chapter 9](09-deploying-a-web-wallet.md#electron)).
- **Bundlers:** Vite 8 and webpack 5 are tested, without configuration.

Everything that needs a daemon (synchronization, history after a sync, building and relaying) is
tested on Linux x86_64 only. The other systems run the offline checks.

## Installing from the signed release

The package `@loki-notfound/zephyr-ts` is not on the npm registry. Each release on GitHub carries
the package tarball, `manifest.json`, `SHA256SUMS`, its signature `SHA256SUMS.asc` and the
maintainer key `KEYS.asc`. Download the five files of the release into an empty directory:

```sh
for f in loki-notfound-zephyr-ts-2.3.0-sec.2-ts.1.tgz manifest.json SHA256SUMS SHA256SUMS.asc KEYS.asc; do
  curl -fLO "https://github.com/loki-notfound/myzephyr-ts/releases/download/v2.3.0-sec.2-ts.1/$f"
done
```

Verify the signature and the checksums, as the release notes do:

```sh
gpg --import KEYS.asc
gpg --verify SHA256SUMS.asc SHA256SUMS
sha256sum -c SHA256SUMS
```

`KEYS.asc` must be the maintainer key `31DA 39AB 43E0 CA67 F1F3  A661 BA2A FF22 DF8A 4A13`; compare
the primary key fingerprint that `gpg --verify` prints. The same key signs the release tag and every commit of
the library. [Chapter 12](12-building-and-verifying.md) explains the other checks.

Then copy the tarball into your project and install it by path:

```sh
npm install ./loki-notfound-zephyr-ts-2.3.0-sec.2-ts.1.tgz
```

npm records the dependency as a `file:` path in `package.json` and the tarball's integrity hash in
`package-lock.json`, so a later `npm ci` fails if the file changes. Keep the tarball in the project,
or in a place your build always reads, and commit both files. The version is a semver prerelease
by its form, so a version range does not select it; always name the exact file.

The package's runtime dependencies (`@babel/runtime`, `async`, `axios`, `decimal.js`,
`web-worker`) are installed from the registry, as your lockfile pins them. `manifest.json` records
the versions the release was built with. The browser entry bundles what it needs and loads none of
them at run time.

## A first program in Node.js

This program creates a random wallet without a daemon, prints its primary address and closes it.
It needs no network.

```ts run
import { createRandomWallet } from "@loki-notfound/zephyr-ts";

const wallet = await createRandomWallet({ networkType: "mainnet", password: "a long passphrase" });
try {
  const address = await wallet.getPrimaryAddress();
  console.log("primary address:", address);
} finally {
  await wallet.close();
}
```

Run it as an ES module (`first.mjs` after compiling, or with any TypeScript runner). The package
also works with `require`:

```js run
const { createRandomWallet } = require("@loki-notfound/zephyr-ts");

async function main() {
  const wallet = await createRandomWallet({ networkType: "testnet", password: "a long passphrase" });
  console.log("testnet address:", await wallet.getPrimaryAddress());
  await wallet.close();
}

main();
```

Each wallet runs in its own worker with its own WebAssembly instance
([chapter 2](02-wallets.md#one-worker-per-wallet)). The first construction in a runtime reads and
compiles `zephyr.wasm`, which can take a few seconds; later constructions reuse the compiled module.

## The same in a browser with Vite

A Vite project needs no configuration file and no plugin. Install the tarball as above and import
the package:

```ts
// src/main.ts
import { createRandomWallet, ZephyrWalletError } from "@loki-notfound/zephyr-ts";

const output = document.getElementById("address");

async function showNewAddress(): Promise<void> {
  if (output === null) return;
  try {
    const wallet = await createRandomWallet({ networkType: "mainnet", password: "a long passphrase" });
    output.textContent = await wallet.getPrimaryAddress();
    await wallet.close();
  } catch (err) {
    output.textContent = err instanceof ZephyrWalletError ? `Wallet error: ${err.code}` : "Wallet error";
  }
}

void showNewAddress();
```

Serve it with `npx vite` (development) or build it with `npx vite build`. The page must be in a
secure context, and its Content-Security-Policy must allow WebAssembly compilation and the worker:
[chapter 9](09-deploying-a-web-wallet.md) has the policy for the page and for the worker script.

## Where the WebAssembly module and the worker come from

The package has one entry with two builds, chosen by the conditions of its exports map:

- **Node.js and the Electron main process** (`require` and `import`) get the CommonJS build in
  `dist/src/`. It finds the worker script and `zephyr.wasm` inside the installed package.
- **A browser bundler** gets `dist/zephyr-ts.browser.mjs` through the `browser` condition: one ES
  module that needs no Node.js built-in, polyfill or bundler setting. It names the worker script
  and the module with `new URL("./zephyr.worker.js", import.meta.url)` and
  `new URL("./zephyr.wasm", import.meta.url)`. Vite and webpack recognize this form, emit both
  files with your application and rewrite the URLs.

Two files therefore stay separate and are loaded at run time: `zephyr.worker.js`, a classic worker
script, and `zephyr.wasm`, the WebAssembly module. Each runtime compiles the module once and passes
the compiled module to every wallet worker. The JavaScript carries the SHA-256 of the
`zephyr.wasm` it was built with and checks the file before compiling it. A stale or mismatched file
rejects the first construction with `NATIVE_ERROR`/`WASM_MODULE_MISMATCH`. This detects a wrong file
next to the JavaScript; it is not a signature.

To serve the two files from another place, set their locations before the first construction with
[`setWorkerDistPath`](reference/functions.md#setworkerdistpath) and
[`setWasmModuleUrl`](reference/functions.md#setwasmmoduleurl):

```ts
import { setWasmModuleUrl, setWorkerDistPath } from "@loki-notfound/zephyr-ts";

setWorkerDistPath("/static/zephyr.worker.js");
setWasmModuleUrl("/static/zephyr.wasm");
```

In Node.js these are file paths; in a browser, URLs. The worker script must have the page's origin.

## Amounts

Every amount is a `bigint` in atomic units: 10^12 atomic units are one coin, for every asset.
[Chapter 4](04-assets-and-balances.md#formatting-and-parsing-amounts) has a small helper to format
and parse amounts exactly.

## Conventions in this guide

- Code blocks marked as TypeScript are type-checked against the release package under `strict`.
  The blocks that create wallets offline are also run, in Node.js, with network access blocked.
- Fragments use `wallet`, an open full wallet (a `ZephyrWallet`), without creating it. Everything
  else a fragment uses, it imports or defines.
- Daemon addresses such as `https://node.example.org` are placeholders. The library contains no
  default daemon.
- Dates are in UTC.

The [API reference](reference/README.md) lists every exported name with its signature.
