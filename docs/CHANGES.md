# Changes of the declared surface

Changes of what the package declares and exports, and of what its documented calls do, from one release
to the next, each with what a caller has to change. The newest release is on top.

There is no stability promise yet, and the version cannot signal a breaking change (README, "Versions").
What the project promises instead: every change of the documented surface in a release is listed here,
in the section of that release, with what a caller has to change, and the release notes point to it.
Install an exact version and read the sections up to it before you upgrade.

## 2.3.0-sec.2-ts.2

Compared with 2.3.0-sec.2-ts.1 (tag `v2.3.0-sec.2-ts.1`). The core is the same: the signed tags zephyr
`v2.3.0-sec.2` and zephyr-cpp `v2.3.0-sec.1`, compiled unchanged apart from the same two build-only patches.

**New.** Payment proofs and transaction keys (`getTxProof`, `getSpendProof`, `getTxKey`); sweeping the
unlocked balance of one asset in one account (`buildSweepUnlocked`, `prepareSweepUnlocked`); the progress of
a sync, listeners and background synchronization (`sync(listener)`, `addListener`, `removeListener`,
`getListeners`, `startSyncing`, `stopSyncing`); the reserve and the circulating supply (`getReserveInfo`,
`getCirculatingSupply`); a supported read-only daemon client, `ZephyrDaemonRpc`, with the oracle's pricing
record; a configuration type for each construction function. The entry exports fifteen more names and none
fewer. These calls follow the Java port's names and shapes, with the deviations each section names.

**Changed.** In TypeScript: the construction functions take their configuration types, so a field a
function does not accept no longer compiles; `getSeed`, `getSeedLanguage` and `getPrivateSpendKey` are
declared to resolve to `undefined` (for a view-only wallet); `validateAddress` takes a `string`;
`setDaemonConnection` no longer declares `trusted`. At run time: `startSyncing` and `addListener` work instead
of rejecting, and `sync` takes a listener as its second argument; a build at the default priority whose
reads for the fee tier fail goes on with the first tier instead of rejecting with `DAEMON_ERROR`; in Firefox
a worker policy without `'wasm-unsafe-eval'` is reported as `WASM_MODULE_REJECTED`; a keys-only wallet with
`server: ""` constructs. Apart from these and the additions, the calls of 2.3.0-sec.2-ts.1 give the same
results.

**Removed.** What served the library itself and was not part of the documented surface: `ZephyrWallet.wrap`,
the static helpers and the method `toEnvelope` of `ZephyrWalletError`, and the internal tables, parsers and
test support from the declarations; the unsupported wallet RPC client, the inherited daemon client and the
inherited filter class from the package. The entry exported none of the removed classes and names; the
removed members were members of the two exported classes.

**`zephyr.wasm` changed.** It has eight new bindings (two for the reserve, one for the core's wallet
notifications, two for sweeps, three for proofs and transaction keys), and its exception whitelist keeps the
cleanups of more of the core's functions (the one every typed failure of the core goes through, the check of
a daemon's answer, the sweep and proof paths and the fee tier fallback), so that a failure or refusal of the
core no longer leaves memory behind in the module and the fallback works as in a native build. This is allowed: the bytes of the module are fixed
within a release, not across releases; the core sources stay the pinned signed tags, and the change is in the
bridge and the build's whitelist, both in this repository. The JavaScript checks `zephyr.wasm` against the
SHA-256 it was built with, so an application that serves the file itself must deploy the new `zephyr.wasm`
together with the new JavaScript; the old file rejects with `NATIVE_ERROR`/`WASM_MODULE_MISMATCH`.

### New

#### Payment proofs and transaction keys

New on `ZephyrWallet`, for full wallets, with the names of the Java port: `getTxKey(txHash)`, `getTxProof(txHash,
address, message?)` and `getSpendProof(txHash, message?)`, each resolving with a string (an `OutProofV2` or
`InProofV2`, a `SpendProofV1`, the transaction key). New diagnostics `KEYS_ONLY_PROOF` and `VIEW_ONLY_PROOF`
(`UNSUPPORTED_CAPABILITY`), `PROOF_MESSAGE`, `TX_FAILED`, `TX_KEY_UNAVAILABLE`, `ADDRESS_NOT_IN_TX` and
`TX_NOT_SENT` (`INVALID_CONFIG`), `PROOF_FAILED` (`NATIVE_ERROR`); `TX_NOT_FOUND`, `TX_HASH`, `INTEGRATED_ADDRESS` and
`ADDRESS_NETWORK` are reported by these calls too. New rejecting members `checkTxKey()`, `checkTxProof()` and
`checkSpendProof()` (`UNSUPPORTED_CAPABILITY` with the new diagnostic `PROOF_CHECK`: the core's checks report
amount 0), so that a port finds them. Guide chapter 6, "Proofs and transaction keys".

What to change: nothing; new calls.

#### Sweeping the unlocked balance of an account

New on `ZephyrWallet`, for full wallets with spend keys: `buildSweepUnlocked(config)` (build, describe, discard)
and `prepareSweepUnlocked(config)` (build, describe, keep under a token for `relayPrepared`), the Java port's
`sweepUnlocked` in two explicit steps. New types `ZephyrSweepUnlockedConfig` (`asset`, optional `destinationAsset`
equal to it, `address`, `accountIndex`, optional `subaddressIndices` and `priority`), `ZephyrSweepBuild` (`txs`,
`multipleTxs`, `totalAmount`, `totalFee`) and `ZephyrPreparedSweep`. The account index is required (the Java
port's core sweeps every account without it); a converting sweep rejects with `UNSUPPORTED_CAPABILITY`/
`CONVERSION`. The sweep's refusals use the existing diagnostics: `NOT_ENOUGH_MONEY`, `NOT_ENOUGH_UNLOCKED`,
`NOT_ENOUGH_FOR_FEE` and the other build failures. New rejecting members `sweepOutput()` and `sweepDust()`
(`UNSUPPORTED_CAPABILITY`/`TRANSACTIONS`), so that a port from the Java port finds them. `ZephyrBuiltTx` is
unchanged; its `destinations` is present on every transaction of a sweep. Guide chapter 7, "Sweeping".

What to change: nothing; new calls.

#### Progress of a sync, listeners and background synchronization

New on `ZephyrWallet`, for full wallets, with the names and semantics of the Java port: the four forms of `sync`
(`sync()`, `sync(listener)`, `sync(startHeight)`, `sync(startHeight, listener)`), `addListener`, `removeListener`,
`getListeners`, `startSyncing(periodInMs?)` and `stopSyncing()`. New types `ZephyrWalletListener` (the five callbacks
of the Java port's listener and `onSyncError`, each optional) and `ZephyrWalletOutput` (the output of an output
notification). New diagnostics `LISTENER_NOT_REGISTERED` and `SYNC_PERIOD` (both `INVALID_CONFIG`); the existing
`LISTENER` now also comes with `INVALID_CONFIG` for a value that is not a listener. Keys-only wallets reject with
`UNSUPPORTED_CAPABILITY`/`KEYS_ONLY_DAEMON`. Callbacks never run inside the core, and whatever they throw or reject
is dropped. Background failures reach `onSyncError` instead of being printed. Guide chapter 4.

Changed rejections: `startSyncing()` and `addListener()` rejected with `UNSUPPORTED_CAPABILITY` (`SYNC`,
`LISTENERS`); they now work. `sync` with two arguments rejected with `UNSUPPORTED_CAPABILITY`/`SYNC`; the second
argument is now a listener (`INVALID_CONFIG`/`LISTENER` when it is not one), and three or more arguments reject with
`SYNC`. `LISTENERS` is no longer reported.

What to change: code that expected `startSyncing` or `addListener` to reject. Otherwise nothing; new calls.

#### The reserve and the circulating supply

New on `ZephyrWallet`, for full wallets with a daemon: `getReserveInfo(): Promise<ZephyrReserveInfo>` and
`getCirculatingSupply(): Promise<Readonly<Record<string, bigint>>>`, with the names and fields of the Java port's
`getReserveInfo` and `getCirculatingSupply`. New type `ZephyrReserveInfo`; new diagnostic
`PRICING_RECORD_UNAVAILABLE` (`DAEMON_ERROR`): the core could not read a usable pricing record and computed
nothing. Keys-only wallets reject with `UNSUPPORTED_CAPABILITY`/`KEYS_ONLY_DAEMON`.

What to change: nothing; new calls.

#### `ZephyrDaemonRpc` supported and exported

The inherited daemon RPC client is replaced by a supported, exported class `ZephyrDaemonRpc`:
`new ZephyrDaemonRpc(address)` (the wallet's address forms and rejections; it contacts nothing), `getInfo`,
`getHeight`, `getLastBlockHeader`, `getBlockHeaderByHeight` and `getBlockHeaderByHash`, with the new types
`ZephyrDaemonInfo`, `ZephyrBlockHeader` and `ZephyrPricingRecord`. It runs in the calling context on the
library's transport. Every other inherited method is undeclared and rejects with
`UNSUPPORTED_CAPABILITY`/`DAEMON_RPC_METHOD` (new diagnostic) before any request; `INVALID_CONFIG`/`BLOCK_HEIGHT`
and `BLOCK_HASH` are new for the arguments. The inherited daemon base class, its models that nothing else used
and the wallet worker's inherited daemon functions left the source and the package; none was exported.

What to change: nothing for users of the package entry (the inherited class was not exported).

### Changed

#### Construction configuration types

The five construction functions take a configuration type each instead of `unknown`:

| Function | Parameter type (new export) |
|---|---|
| `createRandomWallet` | `ZephyrRandomWalletConfig` |
| `restoreWalletFromSeed` | `ZephyrSeedWalletConfig` |
| `restoreWalletFromKeys` | `ZephyrKeysWalletConfig` |
| `createKeysWallet` | `ZephyrKeysOnlyWalletConfig` (a union of its three forms) |
| `openWalletData` | `ZephyrOpenWalletConfig` |

Each type lists exactly the fields that function's run-time validation accepts, with the types it
accepts. The validation is unchanged and still decides: a JavaScript caller, or a value cast to the
type, gets the same rejections as before. Not declared, although the validation still accepts them, are
values without effect: `path: ""`, `isTrustedDaemon: true`, `regtest: false`, `isMultisig: false`,
`saveCurrent: false`, and in the object form of `server` `trusted: true` and empty `username`,
`password`, `proxyUri` or `proxy`.

What to change: TypeScript now reports a field the function does not accept, including the values
without effect above; delete them. A configuration held in a variable of a wider type (for example
`Record<string, unknown>` or an object shaped like monero-ts's `MoneroWalletConfig`) has to be typed as
the function's configuration type. JavaScript callers: nothing.

#### Getters that can resolve to `undefined`

`getSeed()`, `getSeedLanguage()` and `getPrivateSpendKey()` are declared `Promise<string | undefined>`
instead of `Promise<string>`. They resolve to `undefined` for a view-only wallet (full or keys-only), as
they did before; the declarations now say so. Every other getter resolves as its declaration states
(table in the guide's reference, [ZephyrWallet](guide/reference/wallet.md#what-the-getters-return)).

What to change: in TypeScript with `strictNullChecks`, handle `undefined` where the result is used as a
string (check `isViewOnly()` first, or test the result). JavaScript callers: nothing.

#### `validateAddress` takes a string

`validateAddress(address: string, networkType, proxyToWorker?)` instead of `address: unknown`. The
run-time check is unchanged: anything that is not a non-empty string still rejects with
`INVALID_ADDRESS`/`ADDRESS_TYPE`.

What to change: pass a `string` (narrow a value of unknown type first). JavaScript callers: nothing.

#### `setDaemonConnection` takes the address forms of the configurations

`setDaemonConnection(address?: string | { uri: string })` instead of
`address?: string | { uri: string; trusted?: boolean }`, as the construction configurations declare
`server`. The run-time check is unchanged: `trusted: true` is still accepted without effect, and
`trusted: false` still rejects with `UNSUPPORTED_CAPABILITY`/`UNTRUSTED_DAEMON`.

What to change: in TypeScript, delete `trusted` from the object (every daemon is trusted). JavaScript
callers: nothing.

#### The default priority falls back to the first tier when the core's reads fail

At the default priority the core reads the pool's backlog and the recent block headers to choose the fee tier,
and keeps the first tier when a read fails (`wallet2::adjust_priority`). In the module that fallback was not
active, so a failed read rejected the whole build (`buildTransfer`, `buildConversion`, `buildSweepUnlocked` and
their prepare calls) with `DAEMON_ERROR`, unlike a native build and unlike what README and the guide said. Now the
build goes on with the first tier and ends with its own result: a build, or the build's own refusal (for example
`TX_NOT_POSSIBLE`/`NOT_ENOUGH_MONEY`). Explicit priorities are unchanged; they make neither read.

What to change: code that treated `DAEMON_ERROR` from a build at the default priority as "the daemon cannot give a
fee tier" gets a build or the build's own refusal instead.

#### An empty `server` for a keys-only wallet means no daemon

`createKeysWallet` with `server: ""` now constructs the wallet, as the full wallets treat an empty
`server` as no daemon; before, the validation accepted it and the construction then rejected with
`NATIVE_ERROR`/`UNCLASSIFIED_ERROR`. A non-empty `server` still rejects with
`UNSUPPORTED_CAPABILITY`/`KEYS_ONLY_DAEMON`. `ZephyrKeysOnlyWalletConfig` does not declare `server`
(a value without effect, like the others listed above).

What to change: nothing, unless code relied on that rejection.

#### Firefox's worker policy reported as `WASM_MODULE_REJECTED`

With a worker script policy without `'wasm-unsafe-eval'`, Firefox does not deliver the compiled module
to the wallet worker. The first construction now rejects with `NATIVE_ERROR`/`WASM_MODULE_REJECTED`, as
for a page policy without `'wasm-unsafe-eval'`, instead of `NATIVE_ERROR`/`WASM_MODULE_UNAVAILABLE`. The
library tells the case apart by where it occurs (a message the worker could not receive in the place of
the module message), never by an error text or the browser's name. Chromium, Node.js and a page policy
without `'wasm-unsafe-eval'` give the same results as before.

What to change: code that treated `WASM_MODULE_UNAVAILABLE` as "the worker policy lacks
`'wasm-unsafe-eval'`" in Firefox matches `WASM_MODULE_REJECTED` instead.

#### `setWorkerDistPath` without an argument

`setWorkerDistPath(path?: string)`: the parameter is optional, as for `setWasmModuleUrl`. A call without
an argument restores the default worker location, as the library already did.

What to change: nothing.

#### `docs/CHANGES.md` in the package

The package carries this file beside `docs/LIMITATIONS.md` and `docs/DEPLOYMENT.md`.

What to change: nothing.

#### Comments in the declarations

Corrected without a change for callers: the history types state what the mainnet test of 2026-11-15
proved (outgoing transfers, fees and conversions read as the transactions stated them) instead of
calling them unproven; `setWorkerDistPath`, `setWasmModuleUrl`, `validateAddress` and the three getters
above describe what the code does.

### Removed

#### Internal members removed from the declarations

No longer declared, and no longer properties of the classes at run time: `ZephyrWallet.wrap`, the
static members `unsupported`, `walletClosed`, `fromBridge`, `fromBridgeResult`, `checkBridgeResult`,
`fromUnknown`, `isEnvelope` and `fromEnvelope` of `ZephyrWalletError`, with the type
`ZephyrNativeErrorContext` that only they used, and the method `toEnvelope` of `ZephyrWalletError`,
with the type `ZephyrWalletErrorEnvelope`. They served the library itself, were not part of the
documented surface for applications, and now live in a module the package entry does not export. The
object a wallet worker posts for an error is unchanged. `ZephyrWalletError` keeps its constructor,
`code`, `diagnostic`, `isCode` and `isDiagnostic`. Removing `wrap` also removes the inherited wallet
classes and the daemon route type from what the entry's declarations refer to.

What to change: code that called one of these members creates its errors with
`new ZephyrWalletError(code, diagnostic)` and obtains wallets from the construction functions only.
Code that called `error.toEnvelope()` builds the object from `error.code` and `error.diagnostic`.

#### Names the entry does not export removed from the declarations

The declaration files that the entry's declarations reach export only the names the entry exports (the
error module's default export is `ZephyrWalletError`). No longer exported by them: the code, message
and diagnostic tables of the error module (`ZEPHYR_WALLET_ERROR_CODES`, `ZEPHYR_WALLET_ERROR_MESSAGES`,
`ZEPHYR_WALLET_ERROR_DIAGNOSTICS`), the bridge identifiers and their helpers (`BRIDGE_ERROR_IDENTIFIERS`,
`ZephyrBridgeErrorIdentifier`, `ZephyrBridgePasswordState`, `isBridgeErrorIdentifier`, `bridgeErrorOf`,
`bridgePasswordErrorOf`), the test support of the wallet module (`createWallet`,
`getNetworkGuardReport`, `ZephyrNetworkGuardReport`), and the parsers, validators, constants and worker
data shapes of the account, balance, conversion, history, relay and transfer modules. They live in
internal modules of the library now; `ZephyrWalletErrorDiagnostic` is still derived from the diagnostic
table, which is no longer exported.

What to change: nothing for code that imports the package entry: the entry never exported these names,
and the package's exports map refuses deep imports.

#### The wallet RPC client removed

The inherited wallet RPC client of monero-ts (`ZephyrWalletRpc`, with `SslOptions`, which only it used)
is no longer in the source or the package. The library never exported or supported it. The daemon RPC
client and the other unported classes stay in the source.

What to change: nothing for code that imports the package entry. A port that used monero-ts's wallet RPC
client talks to its wallet RPC server directly or uses a `ZephyrWallet`.

#### The unused inherited filter class removed

`dist/src/main/ts/common/Filter.js`, the inherited filter base class that nothing imported, is no longer in
the package. It was not exported. What to change: nothing.
