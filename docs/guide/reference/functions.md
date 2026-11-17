# Functions

The nine functions the package exports. Every function that returns a promise rejects with a
[`ZephyrWalletError`](errors.md); none throws synchronously. Each construction function takes a
configuration type of its own ([Types](types.md#construction-configurations)) that lists the fields its
validation accepts; the validation still checks every field at run time, before any native call, and
stays the authority: a JavaScript caller, or a value cast past the type, gets the same rejections.

## Constructing wallets

The five construction functions share these rules:

- The first argument is a plain object; anything else rejects with `INVALID_CONFIG`/`CONFIG_TYPE`. A
  field with the value `undefined` counts as absent.
- `networkType` is required: `"mainnet"`, `"testnet"`, `"stagenet"`, `0`, `1` or `2`
  (`INVALID_CONFIG`/`NETWORK_TYPE`).
- An unknown field rejects with `INVALID_CONFIG`/`UNKNOWN_FIELD`; a field of the wrong type with
  `INVALID_CONFIG`/`FIELD_TYPE`.
- Unsupported fields reject with `UNSUPPORTED_CAPABILITY`: a non-empty `path` (`FILE_PATH`),
  `regtest: true` (`REGTEST`), `isMultisig: true` (`MULTISIG`), `saveCurrent: true` (`SAVE_CURRENT`),
  `isTrustedDaemon: false` (`UNTRUSTED_DAEMON`), and `connectionManager`, `fs`, `cmd` or
  `rejectUnauthorized` (`CONFIG_FIELD`). The configuration types do not declare these fields. Nor do they
  declare the values the validation accepts without effect: `path: ""`, `isTrustedDaemon: true`,
  `regtest`, `isMultisig` and `saveCurrent` `false`, and in the object form of `server` `trusted: true`
  and empty `username`, `password`, `proxyUri` or `proxy`; at run time these are still accepted.
- `proxyToWorker` (default `true`) runs the wallet in its own worker.
- The second argument, `options`, is `undefined` or `{ signal }` with an `AbortSignal`
  ([`ZephyrWalletConstructionOptions`](types.md#zephyrwalletconstructionoptions)); another field rejects
  with `INVALID_CONFIG`/`UNKNOWN_FIELD`. An abort rejects with `NATIVE_ERROR`/`CONSTRUCTION_ABORTED`.
- Failures to load the module reject the first construction with `NATIVE_ERROR` and
  `WASM_MODULE_UNAVAILABLE`, `WASM_MODULE_MISMATCH`, `WASM_MODULE_REJECTED` or `WASM_MODULE_UNVERIFIED`;
  a worker that cannot start with `NATIVE_ERROR`/`WORKER_FAILED`.
- For full wallets, `server` is a daemon address ([chapter 3](../03-connecting-to-a-daemon.md)),
  validated before construction (`INVALID_CONFIG`/`DAEMON_ADDRESS`, `UNSUPPORTED_CAPABILITY`/
  `DAEMON_CREDENTIALS` or `DAEMON_PROXY`); `""` means none.
- `accountLookahead` and `subaddressLookahead`, where accepted, come as a pair (`LOOKAHEAD_PAIR`), each
  an integer from 1 (`LOOKAHEAD_RANGE`), each and their product at most 20,000 (`LOOKAHEAD_LIMIT`),
  all `INVALID_CONFIG`.

### `createRandomWallet`

```ts signature
function createRandomWallet(config: ZephyrRandomWalletConfig, options?: ZephyrWalletConstructionOptions): Promise<ZephyrWallet>;
```

Creates a random full wallet ([`ZephyrRandomWalletConfig`](types.md#zephyrrandomwalletconfig)). Accepted
fields: `networkType`, `password` (default `""`), `language`
(the seed language, default English), `accountLookahead`, `subaddressLookahead`, `proxyToWorker`,
`server`. With a daemon that answers the connection check, the restore height is the daemon height;
otherwise it is the core's date-based estimate, about a month of blocks below the chain tip.

Rejects with: `INVALID_CONFIG`/`CREATE_MODE` when a `seed` or key field is present,
`RANDOM_RESTORE_HEIGHT` when `restoreHeight` is given, `CORE_UNKNOWN_LANGUAGE` for an unknown
language, `SEED_OFFSET` for a `seedOffset`; and the shared rejections above.

Guide: [Creating a random wallet](../02-wallets.md#creating-a-random-wallet).

### `restoreWalletFromSeed`

```ts signature
function restoreWalletFromSeed(config: ZephyrSeedWalletConfig, options?: ZephyrWalletConstructionOptions): Promise<ZephyrWallet>;
```

Restores a full wallet from a seed ([`ZephyrSeedWalletConfig`](types.md#zephyrseedwalletconfig)); it
never falls back to a random wallet. Accepted fields:
`networkType`, `password`, `seed` (required), `seedOffset`, `restoreHeight` (a safe integer from 0,
default 0), `accountLookahead`, `subaddressLookahead`, `proxyToWorker`, `server`. Spaces in the seed are
normalized.

Rejects with: `INVALID_CONFIG`/`CREATE_MODE` without a `seed`, `SEED_AND_KEYS` with key fields,
`SEED_LANGUAGE` with a `language`, `RESTORE_HEIGHT_RANGE`; `INVALID_RECOVERY_MATERIAL`/`SEED_EMPTY` or
`SEED_WORD_COUNT` (not 12, 13, 24 or 25 words), and `INVALID_RECOVERY_MATERIAL` when the core rejects
the seed; and the shared rejections.

Guide: [Restoring from a seed](../02-wallets.md#restoring-from-a-seed).

### `restoreWalletFromKeys`

```ts signature
function restoreWalletFromKeys(config: ZephyrKeysWalletConfig, options?: ZephyrWalletConstructionOptions): Promise<ZephyrWallet>;
```

Restores a full wallet from keys ([`ZephyrKeysWalletConfig`](types.md#zephyrkeyswalletconfig)); it never
falls back to a random wallet. Accepted fields:
`networkType`, `password`, `primaryAddress`, `privateViewKey`, `privateSpendKey`, `restoreHeight`,
`language`, `accountLookahead`, `subaddressLookahead`, `proxyToWorker`, `server`. A private spend key
gives a wallet that can spend; an address with a private view key gives a view-only wallet. Which keys
a restore needs is checked at run time only: the type declares every key field optional.

Rejects with: `INVALID_CONFIG`/`CREATE_MODE` without any key field or with a `seed`;
`INVALID_RECOVERY_MATERIAL` with `KEY_EMPTY`, `KEY_FORMAT` (not 64 hexadecimal characters),
`VIEW_KEY_WITHOUT_ADDRESS`, `KEYS_MISSING` (neither an address nor a spend key), or when the core
rejects the keys (for example `CORE_INVALID_KEY`, `CORE_INVALID_ADDRESS`); and the shared rejections.

Guide: [Restoring from keys](../02-wallets.md#restoring-from-keys).

### `createKeysWallet`

```ts signature
function createKeysWallet(config: ZephyrKeysOnlyWalletConfig, options?: ZephyrWalletConstructionOptions): Promise<ZephyrWallet>;
```

Creates a keys-only wallet: random without recovery fields, from a `seed` (with an optional
`seedOffset`), or from keys, chosen by the fields present
([`ZephyrKeysOnlyWalletConfig`](types.md#zephyrkeysonlywalletconfig), a union of the three forms). It
has no password, restore height, lookahead, daemon or bytes. Accepted fields: `networkType`, `seed`,
`seedOffset`, `primaryAddress`, `privateViewKey`, `privateSpendKey`, `language`, `proxyToWorker`, and
`password` (accepted; a keys-only wallet has no password). A `server` of `""` passes the validation, but
the construction then rejects with `NATIVE_ERROR`/`UNCLASSIFIED_ERROR`; the type does not declare
`server`.

Rejects with: `UNSUPPORTED_CAPABILITY`/`KEYS_ONLY_DAEMON` for a non-empty `server`,
`KEYS_ONLY_RESTORE_HEIGHT` for `restoreHeight`, `KEYS_ONLY_LOOKAHEAD` for a lookahead; the seed and key
rejections of the two restore functions; and the shared rejections.

Guide: [Keys-only wallets](../02-wallets.md#keys-only-wallets).

### `openWalletData`

```ts signature
function openWalletData(config: ZephyrOpenWalletConfig, options?: ZephyrWalletConstructionOptions): Promise<ZephyrWallet>;
```

Opens a full wallet from its keys and cache bytes, as returned by
[`getData`](wallet.md#getdata) ([`ZephyrOpenWalletConfig`](types.md#zephyropenwalletconfig)). Accepted
fields: `networkType`, `password`, `keysData` (a non-empty
`Uint8Array`, required), `cacheData` (a `Uint8Array`, optional), `proxyToWorker`, `server`. No lookahead
field: the bytes carry their own.

Rejects with: `INVALID_WALLET_DATA`/`WALLET_BYTES` for missing or non-byte data, `WRONG_PASSWORD` for a
wrong password, `INVALID_WALLET_DATA` for bytes that do not open (damaged, of another network); and the
shared rejections.

Guide: [Saving and opening wallet bytes](../02-wallets.md#saving-and-opening-wallet-bytes).

## Utilities

### `validateAddress`

```ts signature
function validateAddress(address: string, networkType: ZephyrNetworkTypeInput, proxyToWorker?: boolean): Promise<void>;
```

Checks an address with the core's own parser for a network type. Resolves when it is valid. By default
it runs in a utility worker; with `proxyToWorker` `false` in the calling context. In Node.js the utility
worker keeps the process alive until [`terminateWorker`](#terminateworker) is called.

Rejects with: `INVALID_ADDRESS`/`ADDRESS_TYPE` for an empty or (at run time) non-string address, `INVALID_ADDRESS`
(for example `CORE_INVALID_ADDRESS`) for a malformed address or one of another network,
`INVALID_CONFIG`/`NETWORK_TYPE`, `INVALID_CONFIG`/`FIELD_TYPE` for a non-boolean third argument.

Guide: [Validating an address](../02-wallets.md#validating-an-address).

### `setWorkerDistPath`

```ts signature
function setWorkerDistPath(path: string): void;
```

Sets where the wallet worker script is loaded from: a URL in the browser (default: the
`zephyr.worker.js` beside the browser entry, which a bundler emits and rewrites), a file path in Node.js
(default: the file in the package). Call it before the first construction. The worker script must have
the page's origin. The declaration comment says that calling it without an argument restores the
default, but the declared parameter is required.

Throws nothing documented; a wrong location shows at the next construction (`NATIVE_ERROR`/
`WORKER_FAILED`).

Guide: [Where the WebAssembly module and the worker come from](../01-getting-started.md#where-the-webassembly-module-and-the-worker-come-from).

### `setWasmModuleUrl`

```ts signature
function setWasmModuleUrl(location?: string): void;
```

Sets where `zephyr.wasm` is loaded from: a URL in the browser (default: the file beside the browser
entry), a file path in Node.js (default: the file in the package). Without an argument the default is
restored. The module is compiled once per runtime and shared with every wallet worker; set the
location before the first construction.

A missing or unusable file rejects the first construction with `NATIVE_ERROR` and
`WASM_MODULE_UNAVAILABLE`, `WASM_MODULE_UNVERIFIED`, `WASM_MODULE_MISMATCH` or `WASM_MODULE_REJECTED`
(also when a wallet worker cannot receive the compiled module: Firefox, a worker policy without
`'wasm-unsafe-eval'`).

Guide: [Serving zephyr.wasm](../09-deploying-a-web-wallet.md#serving-zephyrwasm).

### `terminateWorker`

```ts signature
function terminateWorker(): Promise<void>;
```

Terminates every worker the library started in this runtime: the utility worker, running
constructions and the worker of every open worker-mode wallet, and rejects queued constructions. Open
worker-mode wallets lose their native state without a native close: later calls reject with
`WALLET_CLOSED` and `close()` resolves. Pending constructions reject with
`NATIVE_ERROR`/`CONSTRUCTION_ABORTED`, other pending calls with `WALLET_CLOSED`. Direct-mode wallets are
not affected. Call it when the program or page shuts down.

Guide: [Stopping a wallet at once](../02-wallets.md#stopping-a-wallet-at-once).
