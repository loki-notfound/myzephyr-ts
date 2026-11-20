# 10. Coming from monero-ts

zephyr-ts is a port of [monero-ts](https://github.com/woodser/monero-ts) v0.11.22 (commit
`f6569ca616c4723645a7bfae3a843a0358f5fca9`), and the git history of monero-ts is kept in its
repository. Unlike a rename, though, the package exports a small, new entry: one wallet class, a few
functions and plain result types. This chapter lists what stays the same, what was renamed or
reshaped, and what is not ported.

## What is the same

- **The core and its rules.** Keys, seeds, addresses, wallet bytes, fees, ring sizes and
  synchronization are decided by the wallet core (`wallet2`), as in monero-ts, here Zephyr's.
- **Wallet bytes.** `getData()` returns the keys and cache bytes and `openWalletData` opens them, like
  `openWalletFull({ keysData, cacheData })`.
- **Workers and WebAssembly.** Wallets run in workers by default (`proxyToWorker`), and the module is
  WebAssembly.
- **Familiar names** for the wallet getters: `getPrimaryAddress`, `getAddress`, `getSeed`,
  `getSeedLanguage`, `getPrivateViewKey`, `getPrivateSpendKey`, `getPublicViewKey`,
  `getPublicSpendKey`, `isViewOnly`, `getNetworkType`, `getRestoreHeight`, `getHeight`,
  `getDaemonHeight`, `isConnectedToDaemon`, `setDaemonConnection`, `sync`, `changePassword`,
  `close`, `getAccounts`, `getAccount`, `createAccount`, `getSubaddresses`, `getSubaddress`,
  `createSubaddress`, `setSubaddressLabel`, `getAddressIndex`, `getTxs`, `getTransfers`, `getTx`.
  Their arguments and results differ in many cases (below). `getSeed`, `getSeedLanguage` and
  `getPrivateSpendKey` are declared `Promise<string | undefined>`: a view-only wallet has no seed and
  no spend key.
- **Amounts** are `bigint` in atomic units, 10^12 per coin.
- **The construction configuration** keeps the field names of `MoneroWalletConfig` that it supports:
  `networkType`, `password`, `seed`, `seedOffset`, `primaryAddress`, `privateViewKey`,
  `privateSpendKey`, `restoreHeight`, `language`, `accountLookahead`, `subaddressLookahead`,
  `proxyToWorker`, `server`, `keysData`, `cacheData`. Each construction function declares its own
  configuration type with only the fields it accepts (`ZephyrRandomWalletConfig`,
  `ZephyrSeedWalletConfig`, `ZephyrKeysWalletConfig`, `ZephyrKeysOnlyWalletConfig`,
  `ZephyrOpenWalletConfig`); `MoneroWalletConfig` fields without effect here, such as
  `isTrustedDaemon: true` or `path: ""`, are not declared and TypeScript reports them.

## What was renamed or reshaped

| monero-ts | zephyr-ts |
|---|---|
| `moneroTs.createWalletFull(config)` | `createRandomWallet`, `restoreWalletFromSeed` or `restoreWalletFromKeys`: one function per intent; the wrong fields reject |
| `moneroTs.openWalletFull({ keysData, cacheData })` | `openWalletData({ keysData, cacheData })`; no `path` |
| `moneroTs.createWalletKeys(config)` | `createKeysWallet(config)` |
| `MoneroWalletFull`, `MoneroWalletKeys` | one class, `ZephyrWallet`, with `kind` `"full"` or `"keys"` |
| `MoneroError` | `ZephyrWalletError` with a fixed `code` and `diagnostic`, no native text; its public members are the constructor, `code`, `diagnostic`, `isCode` and `isDiagnostic` |
| `MoneroUtils.validateAddress(address, networkType)` | `validateAddress(address, networkType)` |
| `LibraryUtils.setWorkerDistPath(path)` | `setWorkerDistPath(path?)` (no argument: the default), and `setWasmModuleUrl(location?)` for the separate module |
| `moneroTs.shutdown()` | `terminateWorker()` |
| `MoneroNetworkType.MAINNET` | `"mainnet"` or `0` |
| `getBalance(accountIdx?, subaddressIdx?)`: one `bigint` | `getBalance()`: a map by asset; `getBalance(accountIdx)`: a map by subaddress index; `getBalance(asset, accountIdx, subaddressIdx?)`: one `bigint` |
| `getTxs(query)` with `MoneroTxQuery`, results `MoneroTxWallet` | `getTxs(query)` with `ZephyrHistoryQuery`, results frozen plain objects |
| `MoneroAccount`, `MoneroSubaddress` model classes | `ZephyrAccount`, `ZephyrSubaddress` plain objects with balance maps |
| `sync(listener?, startHeight?)` | `sync()`, `sync(listener)`, `sync(startHeight)`, `sync(startHeight, listener)` (the Java port's order); the listener is any object with some of the callbacks |
| `MoneroWalletListener` (a class to extend) | `ZephyrWalletListener` (an interface, each callback optional), `onBalancesChanged` names the asset; `onSyncError` reports background failures |
| `createTx(config)` and `relayTx(...)` | `buildTransfer(config)` to inspect; `prepareTransfer(config)` and `relayPrepared(token)` to send |
| `getDaemonConnection()`: a connection object | `getDaemonConnection()`: `{ uri, trusted: true }`, without a request |
| one shared worker for all wallets | one worker per wallet, with `terminate()` for one wallet |

The package has named exports only. `import * as zephyr from "@loki-notfound/zephyr-ts"` works; there
is no `moneroTs`-style default object with model classes.

Differences that are not renames:

- **Balances are per asset.** Every balance is a map or names an asset; the asset-less two-number form
  rejects with `UNSUPPORTED_CAPABILITY`/`BALANCE` ([chapter 4](04-assets-and-balances.md#balances)).
- **No file system.** There is no `path` and no `fs`; a file path rejects with
  `UNSUPPORTED_CAPABILITY`/`FILE_PATH`. `close()` takes no argument and never saves.
- **Strict configurations.** The core's configuration parser ignores keys it does not know, and an
  empty seed without keys makes it create a random wallet. zephyr-ts checks every field first: an
  unknown field rejects with `INVALID_CONFIG`/`UNKNOWN_FIELD`, and a restore never falls back to a
  random wallet.
- **A different transport.** The daemon address takes no user name, password, proxy or certificate
  setting; redirects are not followed; every daemon is trusted by the core
  ([chapter 3](03-connecting-to-a-daemon.md)).
- **Errors carry no text.** Code that matched on `err.message` must match on `err.code` and
  `err.diagnostic` instead ([chapter 8](08-errors.md)).
- **Sending is two steps.** There is no `relay: true` and no build-and-send call. A transaction is
  relayed only by `relayPrepared` with the token of a prepared build.
- **Assets and conversions.** Transfers name an `asset`; conversions are their own calls
  (`buildConversion`, `prepareConversion`).

## What is not ported

Everything else inherited from monero-ts stays in the repository's source as unported classes and
is not exported by the package:

- most of the daemon RPC client and the connection manager: `ZephyrDaemonRpc` is exported, constructed with
  `new ZephyrDaemonRpc(address)` (there is no `connectToDaemonRpc`), and offers the node's information, its height
  and block headers with their pricing record ([ZephyrDaemonRpc](reference/daemon.md)); its other inherited calls
  reject with `UNSUPPORTED_CAPABILITY`/`DAEMON_RPC_METHOD`;
- the inherited query-based history model, transaction creation, its relay and sweeps;
- outputs, key images, rescans, proofs and multisig;
- file-system wallets.

The wallet RPC client (`connectToWalletRpc`, `MoneroWalletRpc`) is not ported and is no longer in the
source or the package: a port that used it talks to a wallet RPC server directly or uses a
`ZephyrWallet`.

A few inherited method names remain on `ZephyrWallet` and reject with `UNSUPPORTED_CAPABILITY`, so
that a port finds them: `createTxs`, `getReserveProofWallet`, `rescanSpent` and `importKeyImages`.

```ts run
import { createRandomWallet, ZephyrWalletError } from "@loki-notfound/zephyr-ts";

const wallet = await createRandomWallet({ networkType: "mainnet", password: "a long passphrase" });
for (const call of [() => wallet.createTxs(), () => wallet.getReserveProofWallet(), () => wallet.rescanSpent()]) {
  try {
    await call();
  } catch (err) {
    if (!(err instanceof ZephyrWalletError) || err.code !== "UNSUPPORTED_CAPABILITY") throw err;
    console.log(err.code, err.diagnostic);
  }
}
await wallet.close();
```

The repository's README, section "Not ported", names the source directories.
