# Changes of the declared surface

Changes of what the package declares and exports, compared with the release `2.3.0-sec.2-ts.1`
(tag `v2.3.0-sec.2-ts.1`), each with what a caller has to change. The newest section is on top.

## Unreleased

Not released yet: the package version in the repository is still `2.3.0-sec.2-ts.1`, and the release
of that name does not contain these changes. They make the shipped declarations say what the library
does, remove internal members and names from them and remove the unsupported wallet RPC client from the
package; apart from the one diagnostic and the keys-only `server: ""` below, the library behaves as
before.

### Getters that can resolve to `undefined`

`getSeed()`, `getSeedLanguage()` and `getPrivateSpendKey()` are declared `Promise<string | undefined>`
instead of `Promise<string>`. They resolve to `undefined` for a view-only wallet (full or keys-only), as
they did before; the declarations now say so. Every other getter resolves as its declaration states
(table in the guide's reference, [ZephyrWallet](guide/reference/wallet.md#what-the-getters-return)).

What to change: in TypeScript with `strictNullChecks`, handle `undefined` where the result is used as a
string (check `isViewOnly()` first, or test the result). JavaScript callers: nothing.

### Construction configuration types

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

### `validateAddress` takes a string

`validateAddress(address: string, networkType, proxyToWorker?)` instead of `address: unknown`. The
run-time check is unchanged: anything that is not a non-empty string still rejects with
`INVALID_ADDRESS`/`ADDRESS_TYPE`.

What to change: pass a `string` (narrow a value of unknown type first). JavaScript callers: nothing.

### `setDaemonConnection` takes the address forms of the configurations

`setDaemonConnection(address?: string | { uri: string })` instead of
`address?: string | { uri: string; trusted?: boolean }`, as the construction configurations declare
`server`. The run-time check is unchanged: `trusted: true` is still accepted without effect, and
`trusted: false` still rejects with `UNSUPPORTED_CAPABILITY`/`UNTRUSTED_DAEMON`.

What to change: in TypeScript, delete `trusted` from the object (every daemon is trusted). JavaScript
callers: nothing.

### An empty `server` for a keys-only wallet means no daemon

`createKeysWallet` with `server: ""` now constructs the wallet, as the full wallets treat an empty
`server` as no daemon; before, the validation accepted it and the construction then rejected with
`NATIVE_ERROR`/`UNCLASSIFIED_ERROR`. A non-empty `server` still rejects with
`UNSUPPORTED_CAPABILITY`/`KEYS_ONLY_DAEMON`. `ZephyrKeysOnlyWalletConfig` does not declare `server`
(a value without effect, like the others listed above).

What to change: nothing, unless code relied on that rejection.

### `setWorkerDistPath` without an argument

`setWorkerDistPath(path?: string)`: the parameter is optional, as for `setWasmModuleUrl`. A call without
an argument restores the default worker location, as the library already did.

What to change: nothing.

### Internal members removed from the declarations

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

### Names the entry does not export removed from the declarations

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

### The wallet RPC client removed

The inherited wallet RPC client of monero-ts (`ZephyrWalletRpc`, with `SslOptions`, which only it used)
is no longer in the source or the package. The library never exported or supported it. The daemon RPC
client and the other unported classes stay in the source.

What to change: nothing for code that imports the package entry. A port that used monero-ts's wallet RPC
client talks to its wallet RPC server directly or uses a `ZephyrWallet`.

### `docs/CHANGES.md` in the package

The package carries this file beside `docs/LIMITATIONS.md` and `docs/DEPLOYMENT.md`.

What to change: nothing.

### Firefox's worker policy reported as `WASM_MODULE_REJECTED`

With a worker script policy without `'wasm-unsafe-eval'`, Firefox does not deliver the compiled module
to the wallet worker. The first construction now rejects with `NATIVE_ERROR`/`WASM_MODULE_REJECTED`, as
for a page policy without `'wasm-unsafe-eval'`, instead of `NATIVE_ERROR`/`WASM_MODULE_UNAVAILABLE`. The
library tells the case apart by where it occurs (a message the worker could not receive in the place of
the module message), never by an error text or the browser's name. Chromium, Node.js and a page policy
without `'wasm-unsafe-eval'` give the same results as before.

What to change: code that treated `WASM_MODULE_UNAVAILABLE` as "the worker policy lacks
`'wasm-unsafe-eval'`" in Firefox matches `WASM_MODULE_REJECTED` instead.

### Comments in the declarations

Corrected without a change for callers: the history types state what the mainnet test of 2026-11-15
proved (outgoing transfers, fees and conversions read as the transactions stated them) instead of
calling them unproven; `setWorkerDistPath`, `setWasmModuleUrl`, `validateAddress` and the three getters
above describe what the code does.
