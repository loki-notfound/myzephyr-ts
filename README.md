# zephyr-ts

A TypeScript wallet library for Zephyr, for Node.js, browsers and Electron.

zephyr-ts is an independent project. It is not affiliated with or endorsed by the Zephyr
Protocol project. It is a port of [monero-ts](https://github.com/woodser/monero-ts) v0.11.22
(commit `f6569ca616c4723645a7bfae3a843a0358f5fca9`) onto the signed
[zephyr-backports](https://github.com/zephyr-backports) wallet core. The core decides keys,
wallet files, transactions, fees and network rules; this library adapts the TypeScript API, the
worker and transport layers and the WebAssembly bridge around it and does not change those rules.

The package is `@loki-notfound/zephyr-ts`, version `2.3.0-sec.2-ts.1`. It is not on the npm registry.
Each release on GitHub carries the package tarball with signed checksums: download it, verify it and
install it by path (`npm install ./loki-notfound-zephyr-ts-2.3.0-sec.2-ts.1.tgz`), as
[the guide](docs/guide/01-getting-started.md#installing-from-the-signed-release) describes. To build it
from source, see [BUILDING.md](BUILDING.md).

## Documentation

The user guide is Markdown under [docs/guide/](docs/guide/README.md), published as a site at
[https://loki-notfound.github.io/myzephyr-ts/](https://loki-notfound.github.io/myzephyr-ts/). It explains how to build a wallet with the library, from
installation to sending and deployment, and its API reference lists every exported name. Its examples
are type-checked against the package and the offline ones are run (`bin/check_guide.sh`).

## Status

The supported surface is the wallet lifecycle, read-only daemon access, accounts and subaddresses,
the read-only history of transactions and transfers, an explicit pool refresh, building same-asset
transactions and conversions to inspect them, and relaying a prepared transaction or conversion in two
explicit steps (below). Relay was proven on mainnet on 2026-11-15 for transfers in the four V2 assets
and four of the six conversions; its failure paths are proven against a local sink only.
Sweeps and listeners are not supported. Read
[docs/LIMITATIONS.md](docs/LIMITATIONS.md) before you use it with real funds or public nodes.
Which systems, runtimes and browsers are tested, automatically or by hand, is in
[docs/PLATFORMS.md](docs/PLATFORMS.md).

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
  cache bytes; no file paths; each takes a configuration type of its own that lists the fields it
  accepts (`ZephyrRandomWalletConfig`, `ZephyrSeedWalletConfig`, `ZephyrKeysWalletConfig`,
  `ZephyrKeysOnlyWalletConfig`, `ZephyrOpenWalletConfig`), and every field is still checked at run
  time;
* on a wallet (`ZephyrWallet`): primary address and subaddresses, seed and seed language, private and public keys,
  view-only state (a view-only wallet has no seed, seed language or private spend key: those three
  getters resolve to `undefined` there, as their declarations say); for full wallets also the network type, restore height, `getData` (keys and
  cache bytes) and `changePassword`; `close` (idempotent, retried after a failed close) and, for a
  wallet in its own worker, `terminate` (a forced stop that does not wait; unsaved state is lost);
* read-only daemon access for full wallets: a daemon address at construction (`server`) or with
  `setDaemonConnection`, `isConnectedToDaemon`, `getDaemonHeight`, `isDaemonSynced`, `getHeight`, one blocking
  `sync(startHeight?)`, and the balances `getBalance()` (map by asset), `getBalance(accountIdx)`
  (map by subaddress index) and `getBalance(assetType, accountIdx, subaddressIdx?)`, with the same
  shapes for `getUnlockedBalance`; amounts are `bigint`; an account or subaddress index the wallet
  does not have rejects with `ACCOUNT_NOT_FOUND` or `SUBADDRESS_NOT_FOUND`; the daemon address must
  be the final address: HTTP redirects are never followed, so a redirecting address or proxy fails
  by design ([docs/DEPLOYMENT.md](docs/DEPLOYMENT.md));
* read-only history of full wallets: `getTxs`, `getTransfers` and `getTx`, transactions and
  transfers per asset from what the last sync and the last `refreshPool` stored (no daemon request),
  and `refreshPool`, an explicit daemon request for the incoming transfers still in the pool, with
  the types
  `ZephyrWalletTx`, `ZephyrWalletTransfer`, `ZephyrTransferDestination`, `ZephyrTxConversion`,
  `ZephyrHistoryQuery`, `ZephyrTransferDirection` and `ZephyrHistoryStatus`;
* accounts and subaddresses of full wallets: `getAccounts`, `getAccount`, `createAccount`,
  `getSubaddresses`, `getSubaddress`, `createSubaddress`, `setSubaddressLabel` and
  `getAddressIndex`; results are read-only plain objects with the balance maps by asset (see
  below);
* building and relaying for full wallets: `buildTransfer` and `buildConversion` (build, describe, discard),
  `prepareTransfer` and `prepareConversion` (build, describe, keep under a token), `relayPrepared` and
  `discardPrepared`, with the types `ZephyrTransferConfig`, `ZephyrTransferDestinationInput`,
  `ZephyrTxPriority`, `ZephyrTransferBuild`, `ZephyrBuiltTx`, `ZephyrConversionConfig`,
  `ZephyrConversionDestinationInput`, `ZephyrConversionBuild`, `ZephyrPreparedTransfer`,
  `ZephyrPreparedConversion`, `ZephyrRelayResult`, `ZephyrRelayedTx` and `ZephyrRelayOutcome` (below);
* `validateAddress`, `ZephyrWalletError` (a fixed code and an optional fixed diagnostic; no
  native or daemon text, no secrets; the constructor, `code`, `diagnostic`, `isCode` and
  `isDiagnostic`), `setWorkerDistPath`, `setWasmModuleUrl` and `terminateWorker` (both setters
  restore their default when called without an argument);
* the types `ZephyrWalletData`, `ZephyrDaemonConnection`, `ZephyrWalletSyncResult`,
  `ZephyrWalletConstructionOptions`, `ZephyrNetworkTypeInput`, the five construction configurations
  above, `ZephyrAssetBalances` (the map by
  asset), `ZephyrAccountBalances` (the map by subaddress index), `ZephyrAccount`,
  `ZephyrSubaddress`, `ZephyrAddressIndex`, `ZephyrAccountOptions`, `ZephyrWalletErrorCode` and
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
The changes of the declared surface since the release `2.3.0-sec.2-ts.1` are listed, with what a
caller has to change, in [docs/CHANGES.md](docs/CHANGES.md).

### Accounts and subaddresses

An account (`ZephyrAccount`) carries its `index`, `primaryAddress` (the address of its subaddress
0), `label` (the label of its subaddress 0, where the core stores it; account 0 of a new wallet is
labelled `Primary account`), `subaddressCount` and the maps `balance` and `unlockedBalance` by asset;
with `{ includeSubaddresses: true }` also its `subaddresses`. A subaddress (`ZephyrSubaddress`)
carries `accountIndex`, `index`, `address`, `label`, `balance` and `unlockedBalance` by asset,
`isUsed` and `numUnspentOutputs`. The maps hold the core's keys only: an asset without outputs at
that account or subaddress is absent (a wallet without funds has empty account and subaddress maps,
while `getBalance()` lists every asset with `0n`); reported zeros stay `0n`; historical asset names
pass through. Results are frozen plain objects and arrays.

* Indices are integers from 0 to 2^32-1, checked before any native call
  (`INVALID_CONFIG`/`ADDRESS_INDEX_RANGE`); an account or subaddress the wallet does not have rejects
  with `INVALID_CONFIG` and `ACCOUNT_NOT_FOUND` or `SUBADDRESS_NOT_FOUND`.
* A label is a string of at most 255 bytes in UTF-8, without control characters (U+0000 to U+001F,
  U+007F to U+009F) and without unpaired surrogates (`INVALID_CONFIG`: `LABEL_TYPE`, `LABEL_LENGTH`,
  `LABEL_CHARACTERS`); `""` clears a label. Labels read from wallet bytes made elsewhere are returned
  as stored. The library never copies a label into an error or a log line.
* Creation is one account or subaddress per call. A listing returns at most 1,000 accounts and at
  most 1,000 subaddresses (also counted over all accounts of `getAccounts` with subaddresses); a
  larger one rejects with `INVALID_CONFIG`/`LISTING_LIMIT`. Page through an account's subaddresses
  with `getSubaddresses(accountIdx, indices)`, at most 1,000 distinct indices per call, using the
  account's `subaddressCount`.
* `getAddressIndex(address)` returns `{ accountIndex, subaddressIndex }` for an address of the
  wallet; a malformed address or one of another network rejects with
  `INVALID_ADDRESS`/`CORE_INVALID_ADDRESS`, an address of another wallet with
  `INVALID_ADDRESS`/`ADDRESS_NOT_IN_WALLET`. The core also resolves the subaddresses of the wallet's
  lookahead window that were not created yet.
* Keys-only wallets reject every account call with `UNSUPPORTED_CAPABILITY`/`KEYS_ONLY_ACCOUNTS`.

```typescript
const account = await wallet.createAccount("Savings");                 // { index: 1, label: "Savings", ... }
const sub = await wallet.createSubaddress(account.index, "Shop");      // { accountIndex: 1, index: 1, address, ... }
await wallet.setSubaddressLabel(account.index, sub.index, "Online shop");
const all = await wallet.getAccounts({ includeSubaddresses: true });
const where = await wallet.getAddressIndex(sub.address);               // { accountIndex: 1, subaddressIndex: 1 }
```

Balances other than zero are tested with a funded test wallet: incoming transfers in four assets
and two accounts, and the nine transactions it relayed on mainnet on 2026-11-15 (see "Relaying a
prepared transaction"); see [docs/LIMITATIONS.md](docs/LIMITATIONS.md) for what is not proven yet.

### History

`getTxs(query?)`, `getTransfers(query?)` and `getTx(hash)` return the wallet's transactions and
transfers per asset as the wallet stored them at its last sync and its last pool refresh. They send
no request to the daemon; sync first to see new transactions, and call `refreshPool()` to see
incoming transfers that are still in the pool. Full wallets only; keys-only wallets reject with
`UNSUPPORTED_CAPABILITY`/`KEYS_ONLY_HISTORY`.

A transaction (`ZephyrWalletTx`) carries its `hash`, `height` and `timestamp` (absent while
unconfirmed), `confirmations` (at the wallet's height), `isConfirmed`, `inPool`, `isFailed`,
`isLocked`, `isMinerTx`, the core's `fee` with `feeAsset` (the asset of its outgoing transfer: fees
are paid in the source asset; absent for a transaction without one), `unlockTime`, its
`incomingTransfers` and its `outgoingTransfer`, and `conversion` (`sourceAsset`,
`destinationAsset`, `sourceAmount`, `destinationAmount`) when the outgoing asset differs from the
asset of its destinations. A transfer (`ZephyrWalletTransfer`) carries `direction`, `asset`,
`amount`, `accountIndex`, `subaddressIndex` (incoming) or `subaddressIndices` and `destinations`
(outgoing), and `txHash`, `height` and `confirmations` of its transaction. Amounts are `bigint` in
atomic units; the asset is the core's string, historical names included; a value the core does not
report is absent, never zero or a default asset. Results are frozen plain objects and arrays.

* The query (`ZephyrHistoryQuery`) has optional fields only: `asset`, `accountIndex`,
  `subaddressIndex` (with `accountIndex`; it matches incoming transfers received at that subaddress
  and outgoing transfers that spent from it, by their `subaddressIndices`), `direction` (`"incoming"` or `"outgoing"`), `status`
  (`"confirmed"`, `"pool"` for own outgoing transactions in the pool and the incoming ones the last
  `refreshPool` saw, `"failed"`), `minHeight` and `maxHeight` (inclusive, confirmed transactions only)
  and `hashes`. Unknown fields and bad values reject with `INVALID_CONFIG` before any native call
  (`UNKNOWN_FIELD`, `FIELD_TYPE`, `ASSET_TYPE`, `ADDRESS_INDEX_RANGE`, `QUERY_ACCOUNT_REQUIRED`,
  `HEIGHT_RANGE`, `TX_HASHES`, `TX_HASH`); the query must be a plain object of own data properties
  (a getter, a setter or a symbol key rejects with `CONFIG_TYPE` before anything is read).
  `getTxs` returns the transactions with at least one matching transfer, each with all of its
  transfers; `getTransfers` returns the matching transfers. A filter on an account or subaddress
  the wallet does not have matches nothing and returns an empty list (the balance calls, which look
  an index up, reject it with `ACCOUNT_NOT_FOUND`).
* A hash is 64 lowercase hexadecimal characters (`INVALID_CONFIG`/`TX_HASH`); a requested hash the
  wallet has no transaction for rejects with `INVALID_CONFIG`/`TX_NOT_FOUND`.
* One call selects at most 1,000 transactions with at most 2,000 transfers; a larger selection
  rejects with `INVALID_CONFIG`/`LISTING_LIMIT`. The core has no cursor: page by height range.
* Incoming transfers that are still in the pool are listed only after `refreshPool()`, a daemon
  request you choose (below); until then they appear once they are confirmed.

`refreshPool()` asks the daemon for its transaction pool and updates the wallet's view of its
incoming unconfirmed transfers, then resolves with the number of incoming pool transactions the
wallet holds. Afterwards the history lists them as transactions with `inPool: true`, no height and
zero confirmations (status `"pool"`, direction incoming) until the next `refreshPool` or until the
wallet holds the transaction as confirmed after a sync; a failed refresh leaves none listed. The
core sends two kinds of request: the hashes in the pool (`/get_transaction_pool_hashes.bin`) and
then the pool transactions it has not scanned before (`/gettransactions`, pruned, up to 100 hashes
per request). No key image and no address is sent, but the node can see which pool transactions the
wallet does not ask for: those it sent itself or already recorded. The asset of an incoming pool
transfer is the one the core recorded; when it recorded none the field is absent. Failures reject
like the other daemon calls (`DAEMON_ERROR`); keys-only wallets reject with
`UNSUPPORTED_CAPABILITY`/`KEYS_ONLY_DAEMON`.

```typescript
await wallet.sync();
const received = await wallet.getTransfers({ direction: "incoming", asset: "ZSD" });
const page = await wallet.getTxs({ minHeight: 905000, maxHeight: 905999 });
const tx = await wallet.getTx(received[0].txHash);                     // { hash, height, incomingTransfers, ... }
await wallet.refreshPool();                                            // a daemon request
const pending = await wallet.getTransfers({ status: "pool", direction: "incoming" });
```

Labels, destination addresses and any other text that comes from wallet bytes or the chain are
untrusted display text: see "Text from wallets and the chain" in
[docs/LIMITATIONS.md](docs/LIMITATIONS.md).

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

The package has one entry with two builds, chosen by the conditions of its exports map. Node.js
(`require` and `import`) gets the CommonJS build, which finds the worker script and `zephyr.wasm`
inside the package. A browser bundler gets `dist/zephyr-ts.browser.mjs` through the `browser`
condition: one ES module, built from the same sources, that needs no Node.js built-in, polyfill or
bundler setting. It names the worker script and `zephyr.wasm` with
`new URL("./...", import.meta.url)`, so the bundler emits both files with the application and the
library loads them from there. Vite 8 (development server and production build, without a
configuration file) and webpack 5 (without any resolve fallback) are tested. To serve the two files
from another place, set their URLs before the first construction:

```typescript
import { setWorkerDistPath, setWasmModuleUrl } from "@loki-notfound/zephyr-ts";
setWorkerDistPath("/static/zephyr.worker.js");
setWasmModuleUrl("/static/zephyr.wasm");
```

The page needs a Content-Security-Policy that allows WebAssembly compilation and the daemon
origin; see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for the policy, the three daemon address forms
and proxy requirements.

### Building transactions without relay

`buildTransfer(config)` builds the transactions of a same-asset transfer, describes them and
discards them. The core builds and signs them inside the WebAssembly module; nothing is relayed and
nothing is stored: the bridge passes the core's relay flag as the constant `false` in every build, the
transport refuses every request to the daemon's submit and relay endpoints outside a relay call
(`UNSUPPORTED_CAPABILITY`/`RELAY_REQUEST`), and no byte of a built transaction (hex, signed set, key
images, transaction key) leaves the module. To relay, prepare the same configuration and relay its token
(below, "Relaying a prepared transaction"). Full wallets with spend keys only: keys-only and
view-only wallets reject with `UNSUPPORTED_CAPABILITY`/`KEYS_ONLY_TX` or `VIEW_ONLY_TX`.

The configuration (`ZephyrTransferConfig`, a plain object of own data properties; unknown fields
reject with `INVALID_CONFIG`/`UNKNOWN_FIELD`):

* `asset`: `"ZPH"`, `"ZSD"`, `"ZRS"` or `"ZYS"` (`INVALID_CONFIG`/`ASSET_TYPE`; the V1 names reject
  with `TX_ASSET`, the chain no longer accepts them as outputs);
* `destinationAsset` (optional): equal to `asset`; another asset is a conversion and rejects with
  `UNSUPPORTED_CAPABILITY`/`CONVERSION` (conversions are built by `buildConversion`, below);
* `destinations`: 1 to 15 `{ address, amount }` (`DESTINATIONS`, `TOO_MANY_DESTINATIONS`), amounts
  `bigint` in atomic units above zero, each and their sum at most 2^64-1 (`AMOUNT_ZERO`,
  `AMOUNT_RANGE`); addresses are checked with the core's own parser for the wallet's network
  (`INVALID_ADDRESS`/`CORE_INVALID_ADDRESS`, `ADDRESS_NETWORK` for an address of another network;
  integrated addresses reject with `UNSUPPORTED_CAPABILITY`/`INTEGRATED_ADDRESS`);
* `accountIndex`: the account to spend from (`ADDRESS_INDEX_RANGE`, `ACCOUNT_NOT_FOUND`);
* `subaddressIndices` (optional): spend only from these subaddresses of the account
  (`SUBADDRESS_INDICES`, `SUBADDRESS_NOT_FOUND`);
* `priority` (optional): `"default"` (the core's choice), `"unimportant"`, `"normal"` or
  `"elevated"` (`TX_PRIORITY`). The last three take the first, second and third tier of the daemon's
  fee estimate (zephyr `wallet2.cpp`, `wallet2::get_base_fee`). With `"default"` the core chooses
  (`wallet2::adjust_priority`, called by the wrapper's `create_txs`): while the wallet's automatic low
  priority is on and it stores no default priority (as for a wallet this library creates), the first
  tier, or the second tier when the pool holds a backlog at the first tier's fee or the last ten blocks
  fill more than 80 % of the full reward zone; when those reads fail, the first tier. A wallet whose keys
  file turns the automatic low priority off or stores a default priority gets the first tier (the stored
  priority is not applied on this path). So `"default"` is not always the cheapest tier: on mainnet on
  2026-11-15 it took the second tier once in nine transactions.

Every value is checked before the build is dispatched; then the wallet's unlocked balance of the
asset in the selected account or subaddresses must cover the amounts, or the build rejects with
`TX_NOT_POSSIBLE`/`NOT_ENOUGH_UNLOCKED` (`NOT_ENOUGH_MONEY` when even the balance with locked outputs
is short) without any request. The core then asks the daemon for heights and fork rules, the fee
estimate and the pool's backlog, recent block headers, the circulating supply and the pricing record
history (it reads them for every transaction it constructs), and the output distribution and ring
members (`/get_output_distribution.bin`, `/get_outs.bin`); it sends no key image and no address.
Failures of the core's build: `TX_NOT_POSSIBLE`/`NOT_ENOUGH_UNLOCKED`, `NOT_ENOUGH_MONEY`,
`NOT_ENOUGH_FOR_FEE`, `NOT_ENOUGH_OUTS_TO_MIX`, `TX_TOO_LARGE`; daemon failures as the other daemon
calls (`DAEMON_ERROR`), including a failed read of the circulating supply or of the pricing record history
(`DAEMON_RESPONSE` when the daemon answered with an error, `DAEMON_UNREACHABLE` when no answer came); any
other failure `NATIVE_ERROR`/`TX_BUILD_FAILED`.

The result (`ZephyrTransferBuild`) is `{ txs, multipleTxs }`; each `ZephyrBuiltTx` carries `hash`,
`sourceAsset` and `destinationAsset` (read from the built transaction), `destinations` (when one
transaction was built), `amount`, `fee`, `feeAsset` (the source asset), `totalDebited` (amount and
fee), `change`, `ringSize`, `inputs`, `outputs` (change included), `weight` and `unlockTime`. Two
builds of the same transfer differ in `hash` (a new transaction key) and by a few bytes in `weight`,
with `fee` and `change` following it (the ring members are chosen anew each time).

```typescript
const account1 = await wallet.getAddress(1, 0);
const build = await wallet.buildTransfer({ asset: "ZSD", destinations: [{ address: account1, amount: 100000000000n }], accountIndex: 0 });
console.log(build.txs[0].fee, build.txs[0].feeAsset, build.txs[0].ringSize);   // e.g. 307400000n "ZSD" 16
```

### Building conversions without relay

`buildConversion(config)` builds the one transaction of a conversion between two V2 assets, describes
it and discards it, under the same rules as `buildTransfer`: built and signed inside the module, never
relayed, nothing stored, no byte of the transaction leaves the module, full wallets with spend keys only.
The six conversions are ZPH to ZSD and back, ZPH to ZRS and back, and ZSD to ZYS and back.

The configuration (`ZephyrConversionConfig`, a plain object of own data properties; unknown fields
reject with `INVALID_CONFIG`/`UNKNOWN_FIELD`):

* `sourceAsset`, `destinationAsset`: one of the six pairs (`INVALID_CONFIG`/`CONVERSION_PAIR` for any
  other combination, the same asset included; `ASSET_TYPE` and `TX_ASSET` as for `buildTransfer`);
* `destination`: exactly one `{ address, amount }` (an array rejects with `CONVERSION_DESTINATIONS`);
  `amount` is what is converted, in atomic units of the source asset, with at most four decimals: a
  multiple of 10^8 (`AMOUNT_PRECISION`), above zero and at most 2^64-1; the address as for
  `buildTransfer`;
* `accountIndex`, `subaddressIndices` (optional), `priority` (optional): as for `buildTransfer`.

The core decides at build time. It reads the pricing record of the wallet's top block
(`getblockheaderbyheight`), the circulating supply and the pricing record history, and refuses a pair
the reserve ratio does not allow: `TX_NOT_POSSIBLE`/`RESERVE_RATIO` (the ratio and every other part of
the core's message stay inside the module). Under the pinned core, ZPH to ZSD and ZRS to ZPH need a
reserve ratio (spot and moving average) of at least 4.0 after the conversion, ZPH to ZRS one below 8.0
(or fewer than 100 ZSD in circulation), ZSD to ZPH only assets in the reserve, and the ZSD-ZYS pairs are
not gated by the ratio. Other failures of a conversion: `TX_NOT_POSSIBLE`/`PRICING_RECORD` (no usable
pricing record, also when it could not be read), `CONVERSION_SPLIT` (it would need more than one
transaction), `CONVERSION_AMOUNT` (the converted amount would be zero); the build's own failures as for
`buildTransfer`; any other `NATIVE_ERROR`/`TX_BUILD_FAILED`.

The result (`ZephyrConversionBuild`) carries `hash`, `sourceAsset` and `destinationAsset` (read from the
built transaction), `destination` (the caller's), `amountBurnt` and `amountMinted` (the transaction's own
fields: what is taken in the source asset and what the destination output carries in the destination
asset), `fee` and `feeAsset` (the source asset), `totalDebited` (`amountBurnt` and `fee`), `change`,
`ringSize`, `inputs`, `outputs` (four: the destination, the change and two outputs of zero amount the core
adds to every conversion, one in each asset; docs/LIMITATIONS.md), `weight`, `unlockTime` and `pricingRecordHeight` (the block whose
pricing record sets the rate). The SDK computes no rate: the rate and its conversion fee follow from that
pricing record by the core's formula (docs/LIMITATIONS.md).

```typescript
const primary = await wallet.getPrimaryAddress();
const c = await wallet.buildConversion({ sourceAsset: "ZPH", destinationAsset: "ZRS", destination: { address: primary, amount: 100000000000n }, accountIndex: 0 });
console.log(c.amountBurnt, c.amountMinted, c.fee, c.feeAsset, c.pricingRecordHeight);
```

### Relaying a prepared transaction

Relay is two explicit steps. `prepareTransfer(config)` and `prepareConversion(config)` take the
configurations of `buildTransfer` and `buildConversion`, run the same checks and requests and return the
same description, but keep the built transactions inside the WebAssembly module instead of discarding
them, together with an opaque `token` (32 lowercase hexadecimal characters):
`{ token, build }` (`ZephyrPreparedTransfer`, `ZephyrPreparedConversion`). `relayPrepared(token)` then
relays exactly what that token names, as it was described; `discardPrepared(token)` voids it (`true`, or
`false` when the token named nothing). `buildTransfer` and `buildConversion` keep discarding what they build.

* One kept build per wallet. It is void, wiped and released inside the module, after it was relayed
  completely, after the daemon refused it, after `discardPrepared`, `close`, a password change, a newer
  prepare (also one that fails), a sync after which the wallet's height differs from the height at the
  build by more than 10 blocks, a conversion whose pricing record has aged, and after three relay calls.
  A forced stop ends the worker that holds it. It is never part of the wallet bytes. It survives
  `setDaemonConnection`: `relayPrepared` sends it to the daemon configured when it is called, not to the
  daemon the build read from. A void or unknown
  token rejects with `INVALID_CONFIG`/`RELAY_TOKEN_VOID` before any request; a value that is not a token
  with `INVALID_CONFIG`/`RELAY_TOKEN`.
* What is relayed is what was described: before the request the module checks that the kept transaction
  hashes to the described hash (`NATIVE_ERROR`/`RELAY_HASH_MISMATCH` otherwise, the token is void), and its
  transport passes the submit request only after checking the hash of the transaction it carries.
* A conversion is accepted by the chain only while its pricing record is at most 10 blocks old. When the
  wallet's own height shows that it has aged, `relayPrepared` rejects with
  `TX_NOT_POSSIBLE`/`PRICING_RECORD_AGE` before any request and the token is void; prepare it again.
* The request: one `POST <daemon>/sendrawtransaction` per kept transaction to the wallet's configured
  daemon, with the body `{"client":"","tx_as_hex":"<the transaction>"}` exactly as the core sends it (its
  do-not-relay flag is false and its sanity-check flag true, both left out as the defaults the daemon
  applies). It reveals the transaction itself (what the chain will show) and that this client sent it.
  Every other submit or relay request (`/send_raw_transaction`, `relay_tx`, `submit_block`, ...) stays
  refused by the transport.

`relayPrepared` resolves when at least one transaction was accepted in that call; for one transaction
(conversions always, transfers nearly always) resolving means accepted. The result (`ZephyrRelayResult`)
has per kept transaction its described `hash`, the `outcome` (`accepted`, `rejected`, `unknown`,
`notSent`), `notRelayed` (accepted, but the daemon kept it without relaying it) and, on the entry that
failed, `code` and `diagnostic`; `complete` is true when every transaction is accepted. When nothing was
accepted it rejects:

* `TX_REJECTED`: the daemon refused the transaction, with the first reason of its reply (`LOW_RING_SIZE`,
  `DOUBLE_SPEND`, `INVALID_INPUT`, `INVALID_OUTPUT`, `TOO_BIG`, `OVERSPEND`, `FEE_TOO_LOW`,
  `TOO_FEW_OUTPUTS`, `TX_EXTRA_TOO_BIG`, `SANITY_CHECK_FAILED`, `NOT_RELAYED`) or `REJECTED`; the token is
  void. Sync, then prepare again (for a double spend the outputs may be spent elsewhere).
* `DAEMON_ERROR`/`DAEMON_BUSY` (the daemon did not process it) or `DAEMON_UNREACHABLE` (the connection was
  refused, nothing was sent): the token stays; relay it again later or discard it.
* `RELAY_UNKNOWN`/`NO_ANSWER`, `HTTP_STATUS`, `ANSWER_UNREADABLE`: the request was sent and no usable answer
  came, so the transaction may have reached the network. This is never reported as not sent. The token
  stays: relaying it again sends exactly the same transaction (a daemon that already has it answers that it
  kept it without relaying it, and the wallet then records it). Otherwise discard it, call `refreshPool()`
  and sync before building again: the wallet has not recorded the transaction and would select the same
  outputs.
* `NATIVE_ERROR`/`RELAY_REQUEST` (the transport refused the submit request) and `RELAY_FAILED` (the core's
  commit failed before any request): nothing was sent, the token is void.

After acceptance the core records the transaction as the wallet's own: an unconfirmed outgoing
transaction in the history (`isConfirmed` false), its transaction key, and the spent outputs. The source
account's balance falls by the debited total (amount and fee; the change counts while pending) and its
unlocked balance by the spent inputs. While it is pending the core counts an amount sent to an address of
the same account back into that account's balance (in the source asset, also for a conversion to such an
address, whose source-asset balance then falls only by the fee until the transaction is confirmed). The
mainnet test of 2026-11-15 confirmed the final balances: after confirmation an amount sent to the same
account stays in its balance, and a conversion's source asset has fallen by the burnt amount and the fee
while the minted amount is received. This lives in the wallet's cache: save the wallet bytes (`getData`)
after `relayPrepared` resolves; bytes saved before reopen without the record, with the outputs unspent,
until a sync sees the transaction in a block. A transaction that never reaches the pool stays pending; the
core marks it failed (and its outputs unspent again) only after 500 seconds and a refresh that reads the
pool. If the core accepted the daemon's answer but could not record the transaction, the accepted entry
carries `NATIVE_ERROR`/`RELAY_RECORD_FAILED`: the daemon has it; sync.

```typescript
const p = await wallet.prepareTransfer({ asset: "ZPH", destinations: [{ address, amount: 100000000000n }], accountIndex: 0 });
console.log(p.build.txs[0].hash, p.build.txs[0].fee);          // inspect, then relay exactly this
const r = await wallet.relayPrepared(p.token);                 // rejects unless accepted
const saved = await wallet.getData();                          // keep the wallet's record of it
```

What a wallet should show before `relayPrepared`: the description is what will be relayed and charged.
Show the destinations and amounts, the fee with its asset (the source asset) and the total debited, and
for a conversion the burnt and minted amounts; then relay only after the user confirmed exactly that. With
the default priority the fee may be of the second tier (see `priority` above); a wallet that wants the
cheapest tier passes `"unimportant"`.

Proven on mainnet on 2026-11-15, with a funded test wallet (a wallet in the Node.js main thread, the default
priority, 0.1 or 0.05 of the source asset to the wallet's own addresses): one transfer per V2 asset, a
transfer with two destinations, and the conversions ZSD to ZPH, ZPH to ZRS, ZSD to ZYS and ZYS to ZSD were
accepted by the daemon, mined, and after ten confirmations equal to their descriptions: the fee charged,
the change and the balances and unlocked balances per asset in both accounts, and for a conversion the
minted amount received. ZPH to ZSD and ZRS to ZPH were refused at build time by the reserve ratio. Not
proven: a refusal by a daemon on real data, a transfer the core splits, a conversion whose pricing record
aged before the relay, the two pairs the ratio refused, relay from a browser or from a wallet in a worker,
and other platforms (docs/LIMITATIONS.md). The failure paths of relay are proven against a local sink that
plays the daemon.

## Not ported

Everything else inherited from monero-ts stays in the source as unported classes under
`src/main/ts/` and is not exported by the package: the daemon RPC client, the
connection manager, background synchronization, listeners, the inherited query-based history,
the inherited transaction creation, its relay and sweeps, outputs, key images, rescans, proofs, multisig and file-system wallets (`src/main/ts/daemon/`,
most of `src/main/ts/wallet/`, including the inherited abstract wallet `ZephyrWalletBase` and the
inherited account and subaddress models, renamed `ZephyrAccountInherited` and
`ZephyrSubaddressInherited` because the entry's own results carry the names `ZephyrAccount` and
`ZephyrSubaddress`). The inherited wallet RPC client is not part of the source or the package any more
(docs/CHANGES.md). The
inherited Monero test suite and its root entry point are not part of this repository's tree; the
tests are under `src/test/lifecycle/`, `src/test/network/` and `src/test/transport/`.

## Building and testing

[BUILDING.md](BUILDING.md) describes the requirements, the build from a fresh clone, offline
builds from local caches, the offline test suites, the optional file compatibility test with
zephyr-javascript, the network suite, the packaging tests with Vite, webpack and Node.js
consumers, and the platform tests that take the packed tarball to other systems, browsers and
Electron.

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
The guide site uses the lateo house stylesheet (`site/assets/content.css` and `print.css`), under the
BSD 3-Clause License with its notice in `site/assets/LICENSE-style.txt`; the lateo name, the mark in the
site's family bar and the favicon files in `site/assets/` are not covered by this repository's MIT
license: they identify the lateo projects, and all rights in them are reserved by their owner
(`site/assets/NOTICE.txt`, `site/assets/TRADEMARKS.txt`).
