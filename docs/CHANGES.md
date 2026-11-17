# Changes of the declared surface

Changes of what the package declares and exports, compared with the release `2.3.0-sec.2-ts.1`
(tag `v2.3.0-sec.2-ts.1`), each with what a caller has to change. The newest section is on top.

## Unreleased

Not released yet: the package version in the repository is still `2.3.0-sec.2-ts.1`, and the release
of that name does not contain these changes. They make the shipped declarations say what the library
does and remove internal members from them; apart from the one diagnostic below, the library behaves as
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

### `setWorkerDistPath` without an argument

`setWorkerDistPath(path?: string)`: the parameter is optional, as for `setWasmModuleUrl`. A call without
an argument restores the default worker location, as the library already did.

What to change: nothing.

### Internal members removed from the declarations

No longer declared, and no longer properties of the classes at run time: `ZephyrWallet.wrap`, and the
static members `unsupported`, `walletClosed`, `fromBridge`, `fromBridgeResult`, `checkBridgeResult`,
`fromUnknown`, `isEnvelope` and `fromEnvelope` of `ZephyrWalletError`, with the type
`ZephyrNativeErrorContext` that only they used. They served the library itself, were not part of the
documented surface for applications, and now live in a module the package entry does not export.
`ZephyrWalletError` keeps its constructor, `code`, `diagnostic`, `isCode`, `isDiagnostic` and
`toEnvelope`. Removing `wrap` also removes the inherited wallet classes and the daemon route type from
what the entry's declarations refer to.

What to change: code that called one of these members creates its errors with
`new ZephyrWalletError(code, diagnostic)` and obtains wallets from the construction functions only.

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
