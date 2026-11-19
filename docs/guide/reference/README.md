# API reference

Every name the package `@loki-notfound/zephyr-ts` exports, version `2.3.0-sec.2-ts.1`, written from the
package entry (`src/main/ts/index.ts`) and the declarations it ships (`dist/src/main/ts/index.d.ts` and
the files it re-exports). The signatures are copied from those declarations, and
`bin/check_guide.sh` checks that each one appears there and that this list matches the exports.

- [Functions](functions.md): the construction functions and the utilities.
- [ZephyrWallet](wallet.md): the wallet class, every property and method.
- [Types](types.md): configurations, results and their parts.
- [Errors](errors.md): `ZephyrWalletError`, its codes and its diagnostics.

The package has named exports only. Types are exported with `export type` and exist at compile time
only.

| Name | Kind | Reference |
|---|---|---|
| `ZephyrWallet` | class | [ZephyrWallet](wallet.md) |
| `ZephyrWalletError` | class | [ZephyrWalletError](errors.md#zephyrwalleterror) |
| `createRandomWallet` | function | [createRandomWallet](functions.md#createrandomwallet) |
| `restoreWalletFromSeed` | function | [restoreWalletFromSeed](functions.md#restorewalletfromseed) |
| `restoreWalletFromKeys` | function | [restoreWalletFromKeys](functions.md#restorewalletfromkeys) |
| `createKeysWallet` | function | [createKeysWallet](functions.md#createkeyswallet) |
| `openWalletData` | function | [openWalletData](functions.md#openwalletdata) |
| `validateAddress` | function | [validateAddress](functions.md#validateaddress) |
| `setWorkerDistPath` | function | [setWorkerDistPath](functions.md#setworkerdistpath) |
| `setWasmModuleUrl` | function | [setWasmModuleUrl](functions.md#setwasmmoduleurl) |
| `terminateWorker` | function | [terminateWorker](functions.md#terminateworker) |
| `ZephyrNetworkTypeInput` | type | [ZephyrNetworkTypeInput](types.md#zephyrnetworktypeinput) |
| `ZephyrWalletData` | type | [ZephyrWalletData](types.md#zephyrwalletdata) |
| `ZephyrWalletConstructionOptions` | type | [ZephyrWalletConstructionOptions](types.md#zephyrwalletconstructionoptions) |
| `ZephyrDaemonConnection` | type | [ZephyrDaemonConnection](types.md#zephyrdaemonconnection) |
| `ZephyrWalletSyncResult` | type | [ZephyrWalletSyncResult](types.md#zephyrwalletsyncresult) |
| `ZephyrRandomWalletConfig` | type | [ZephyrRandomWalletConfig](types.md#zephyrrandomwalletconfig) |
| `ZephyrSeedWalletConfig` | type | [ZephyrSeedWalletConfig](types.md#zephyrseedwalletconfig) |
| `ZephyrKeysWalletConfig` | type | [ZephyrKeysWalletConfig](types.md#zephyrkeyswalletconfig) |
| `ZephyrKeysOnlyWalletConfig` | type | [ZephyrKeysOnlyWalletConfig](types.md#zephyrkeysonlywalletconfig) |
| `ZephyrOpenWalletConfig` | type | [ZephyrOpenWalletConfig](types.md#zephyropenwalletconfig) |
| `ZephyrAssetBalances` | type | [ZephyrAssetBalances](types.md#zephyrassetbalances) |
| `ZephyrAccountBalances` | type | [ZephyrAccountBalances](types.md#zephyraccountbalances) |
| `ZephyrAccount` | type | [ZephyrAccount](types.md#zephyraccount) |
| `ZephyrSubaddress` | type | [ZephyrSubaddress](types.md#zephyrsubaddress) |
| `ZephyrAddressIndex` | type | [ZephyrAddressIndex](types.md#zephyraddressindex) |
| `ZephyrAccountOptions` | type | [ZephyrAccountOptions](types.md#zephyraccountoptions) |
| `ZephyrWalletTx` | type | [ZephyrWalletTx](types.md#zephyrwallettx) |
| `ZephyrWalletTransfer` | type | [ZephyrWalletTransfer](types.md#zephyrwallettransfer) |
| `ZephyrTransferDestination` | type | [ZephyrTransferDestination](types.md#zephyrtransferdestination) |
| `ZephyrTxConversion` | type | [ZephyrTxConversion](types.md#zephyrtxconversion) |
| `ZephyrHistoryQuery` | type | [ZephyrHistoryQuery](types.md#zephyrhistoryquery) |
| `ZephyrTransferDirection` | type | [ZephyrTransferDirection](types.md#zephyrtransferdirection) |
| `ZephyrHistoryStatus` | type | [ZephyrHistoryStatus](types.md#zephyrhistorystatus) |
| `ZephyrTxPriority` | type | [ZephyrTxPriority](types.md#zephyrtxpriority) |
| `ZephyrTransferDestinationInput` | type | [ZephyrTransferDestinationInput](types.md#zephyrtransferdestinationinput) |
| `ZephyrTransferConfig` | type | [ZephyrTransferConfig](types.md#zephyrtransferconfig) |
| `ZephyrBuiltTx` | type | [ZephyrBuiltTx](types.md#zephyrbuilttx) |
| `ZephyrTransferBuild` | type | [ZephyrTransferBuild](types.md#zephyrtransferbuild) |
| `ZephyrConversionDestinationInput` | type | [ZephyrConversionDestinationInput](types.md#zephyrconversiondestinationinput) |
| `ZephyrConversionConfig` | type | [ZephyrConversionConfig](types.md#zephyrconversionconfig) |
| `ZephyrConversionBuild` | type | [ZephyrConversionBuild](types.md#zephyrconversionbuild) |
| `ZephyrPreparedTransfer` | type | [ZephyrPreparedTransfer](types.md#zephyrpreparedtransfer) |
| `ZephyrPreparedConversion` | type | [ZephyrPreparedConversion](types.md#zephyrpreparedconversion) |
| `ZephyrRelayOutcome` | type | [ZephyrRelayOutcome](types.md#zephyrrelayoutcome) |
| `ZephyrRelayedTx` | type | [ZephyrRelayedTx](types.md#zephyrrelayedtx) |
| `ZephyrRelayResult` | type | [ZephyrRelayResult](types.md#zephyrrelayresult) |
| `ZephyrWalletErrorCode` | type | [ZephyrWalletErrorCode](errors.md#zephyrwalleterrorcode) |
| `ZephyrWalletErrorDiagnostic` | type | [ZephyrWalletErrorDiagnostic](errors.md#zephyrwalleterrordiagnostic) |

Every declaration file the entry's declarations reach exports only names of this list (the error
module's default export is `ZephyrWalletError`). The parsers, validators, constants, worker data shapes
and test support the library uses are in internal modules that the entry does not export and that no
declaration the entry reaches refers to.
The changes of the declared surface since the release are listed in
[docs/CHANGES.md](../../CHANGES.md).
