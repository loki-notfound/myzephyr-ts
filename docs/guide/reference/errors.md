# Errors

The error class, its codes and its diagnostics. [Chapter 9](../09-errors.md) explains how a wallet
handles them.

## ZephyrWalletError

```ts signature
class ZephyrWalletError extends Error
```

Every failure of the library is a `ZephyrWalletError`. It extends `Error`; its `name` is
`"ZephyrWalletError"` and its `message` a fixed text per code (below). It carries no native text, no
daemon text, no request text, no stack of another error and no cause. Only the code and the diagnostic
cross the worker boundary.

### `constructor`

```ts signature
constructor(code: ZephyrWalletErrorCode, diagnostic?: ZephyrWalletErrorDiagnostic);
```

Creates an error. An unknown code becomes `NATIVE_ERROR`, and a diagnostic outside the list is dropped.
Applications rarely create one; it is useful in tests.

### `code`

```ts signature
readonly code: ZephyrWalletErrorCode;
```

One of the thirteen [codes](#codes).

### `diagnostic`

```ts signature
readonly diagnostic: ZephyrWalletErrorDiagnostic | undefined;
```

One of the [diagnostics](#diagnostics), or `undefined`.

### `isCode`

```ts signature
static isCode(value: unknown): value is ZephyrWalletErrorCode;
```

Whether a value is one of the codes.

### `isDiagnostic`

```ts signature
static isDiagnostic(value: unknown): value is ZephyrWalletErrorDiagnostic;
```

Whether a value is one of the diagnostics.

The static helpers the library uses to create and map errors (`unsupported`, `walletClosed`,
`fromBridge`, `fromBridgeResult`, `checkBridgeResult`, `fromUnknown`, `isEnvelope`, `fromEnvelope`) and
the method `toEnvelope`, which made the plain object `{ type: "ZephyrWalletError", code, diagnostic? }`
that crosses the worker boundary, were members of the class in version `2.3.0-sec.2-ts.1`; they are
internal now and no longer on the class ([docs/CHANGES.md](../../CHANGES.md)). The worker boundary
carries the same object as before.

## Error types

### `ZephyrWalletErrorCode`

```ts signature
type ZephyrWalletErrorCode = "UNSUPPORTED_CAPABILITY" | "INVALID_CONFIG" | "INVALID_RECOVERY_MATERIAL" | "WRONG_PASSWORD" | "INVALID_WALLET_DATA" | "INVALID_ADDRESS" | "WALLET_CLOSED" | "MALFORMED_MESSAGE" | "NATIVE_ERROR" | "DAEMON_ERROR" | "TX_NOT_POSSIBLE" | "TX_REJECTED" | "RELAY_UNKNOWN";
```

The thirteen codes, listed below.

### `ZephyrWalletErrorDiagnostic`

```ts signature
type ZephyrWalletErrorDiagnostic = typeof ZEPHYR_WALLET_ERROR_DIAGNOSTICS[number];
```

The union of the diagnostics listed below. The constant it is derived from is not exported.

## Codes

| Code | Message | Meaning |
|---|---|---|
| `UNSUPPORTED_CAPABILITY` | Unsupported capability | outside the supported surface, or not available for this kind of wallet; raised before any native code runs |
| `INVALID_CONFIG` | Invalid wallet configuration or argument | a configuration or argument was rejected, also an index, a transaction or a token the wallet does not have |
| `INVALID_RECOVERY_MATERIAL` | Recovery material was rejected | a seed or keys were rejected |
| `WRONG_PASSWORD` | Wrong wallet password | the password does not open the bytes, or the old password is wrong |
| `INVALID_WALLET_DATA` | Wallet data could not be opened | the wallet bytes could not be opened |
| `INVALID_ADDRESS` | Invalid address | an address is malformed, of another network or not of this wallet |
| `WALLET_CLOSED` | Wallet is closed | the wallet was closed or stopped |
| `MALFORMED_MESSAGE` | Malformed worker message | a worker message did not have the expected form |
| `NATIVE_ERROR` | Native wallet operation failed | a native operation, the module or a worker failed |
| `DAEMON_ERROR` | Daemon request failed | a daemon request failed |
| `TX_NOT_POSSIBLE` | Transaction not possible | the wallet's funds or the chain's state do not allow the transaction |
| `TX_REJECTED` | Transaction rejected by the daemon | the daemon refused a relayed transaction |
| `RELAY_UNKNOWN` | Relay outcome unknown | a relay request was sent and no usable answer came |

## Diagnostics

Each diagnostic is a fixed identifier chosen by the library. The code column gives the code it comes
with. A diagnostic of the core or the bridge without a fixed meaning takes the code of the call
instead: `INVALID_WALLET_DATA` when opening bytes, `INVALID_RECOVERY_MATERIAL` when restoring,
`INVALID_ADDRESS` for an address call, `NATIVE_ERROR` otherwise.

### Unsupported capabilities

| Diagnostic | Code | Meaning |
|---|---|---|
| `FILE_PATH` | `UNSUPPORTED_CAPABILITY` | a file path; wallets have no files |
| `DAEMON_CONNECTION` | `UNSUPPORTED_CAPABILITY` | a daemon field where the core's configuration takes none |
| `UNTRUSTED_DAEMON` | `UNSUPPORTED_CAPABILITY` | `trusted: false` or `isTrustedDaemon: false`; every daemon is trusted |
| `REGTEST` | `UNSUPPORTED_CAPABILITY` | `regtest: true` |
| `MULTISIG` | `UNSUPPORTED_CAPABILITY` | `isMultisig: true`, or a multisig wallet at build time |
| `SAVE_CURRENT` | `UNSUPPORTED_CAPABILITY` | `saveCurrent: true` |
| `CONFIG_FIELD` | `UNSUPPORTED_CAPABILITY` | `connectionManager`, `fs`, `cmd` or `rejectUnauthorized` |
| `KEYS_ONLY_RESTORE_HEIGHT` | `UNSUPPORTED_CAPABILITY` | a restore height for, or asked of, a keys-only wallet |
| `KEYS_ONLY_LOOKAHEAD` | `UNSUPPORTED_CAPABILITY` | a lookahead for a keys-only wallet |
| `KEYS_ONLY_DATA` | `UNSUPPORTED_CAPABILITY` | `getData` of a keys-only wallet |
| `KEYS_ONLY_PASSWORD` | `UNSUPPORTED_CAPABILITY` | a password change of a keys-only wallet |
| `KEYS_ONLY_NETWORK_TYPE` | `UNSUPPORTED_CAPABILITY` | `getNetworkType` of a keys-only wallet |
| `KEYS_ONLY_DAEMON` | `UNSUPPORTED_CAPABILITY` | a daemon, balance or pool call of a keys-only wallet |
| `KEYS_ONLY_ACCOUNTS` | `UNSUPPORTED_CAPABILITY` | an account or subaddress call of a keys-only wallet |
| `KEYS_ONLY_HISTORY` | `UNSUPPORTED_CAPABILITY` | a history call of a keys-only wallet |
| `KEYS_ONLY_TX` | `UNSUPPORTED_CAPABILITY` | a build or relay call of a keys-only wallet |
| `VIEW_ONLY_TX` | `UNSUPPORTED_CAPABILITY` | a build or relay call of a view-only wallet |
| `NETWORK_REQUEST` | `UNSUPPORTED_CAPABILITY` | a request outside the configured daemon routes, refused by the transport |
| `WORKER_FUNCTION` | `UNSUPPORTED_CAPABILITY` | a worker function outside the supported set |
| `WALLET_KIND` | `UNSUPPORTED_CAPABILITY` | a worker function not available for the wallet's kind |
| `NATIVE_EXPORT` | `UNSUPPORTED_CAPABILITY` | a native function that is not built into the module |
| `LISTENER` | `INVALID_CONFIG`, `UNSUPPORTED_CAPABILITY` | `INVALID_CONFIG`: a listener argument that is not an object or has a callback that is not a function (`addListener`, `sync`); `UNSUPPORTED_CAPABILITY`: an inherited native listener handle (never sent by the library) |
| `LISTENERS` | `UNSUPPORTED_CAPABILITY` | not reported since listeners are supported; the identifier stays valid |
| `SAVE_ON_CLOSE` | `UNSUPPORTED_CAPABILITY` | saving on close |
| `BALANCE` | `UNSUPPORTED_CAPABILITY` | the asset-less `getBalance(accountIdx, subaddressIdx)` |
| `SYNC` | `UNSUPPORTED_CAPABILITY` | `sync` with more than two arguments |
| `TRANSACTIONS` | `UNSUPPORTED_CAPABILITY` | the inherited transaction creation (`createTxs`), `sweepOutput` and `sweepDust` |
| `DAEMON_SETTINGS` | `UNSUPPORTED_CAPABILITY` | rescans and key image import |
| `RESERVE_PROOF` | `UNSUPPORTED_CAPABILITY` | reserve proofs |
| `CONVERSION` | `UNSUPPORTED_CAPABILITY` | a `destinationAsset` other than `asset` in a transfer or a sweep |
| `KEYS_ONLY_PROOF` | `UNSUPPORTED_CAPABILITY` | a proof or transaction key call of a keys-only wallet |
| `VIEW_ONLY_PROOF` | `UNSUPPORTED_CAPABILITY` | `getSpendProof` of a view-only wallet |
| `PROOF_CHECK` | `UNSUPPORTED_CAPABILITY` | `checkTxKey`, `checkTxProof` and `checkSpendProof`: the core's check reports amount 0 |
| `INTEGRATED_ADDRESS` | `UNSUPPORTED_CAPABILITY` | an integrated address as a destination or as the address of a transaction proof |
| `TERMINATE` | `UNSUPPORTED_CAPABILITY` | `terminate` of a direct-mode wallet |
| `DAEMON_CREDENTIALS` | `UNSUPPORTED_CAPABILITY` | a user name or password for the daemon |
| `DAEMON_PROXY` | `UNSUPPORTED_CAPABILITY` | a proxy for the daemon |
| `DAEMON_RPC_METHOD` | `UNSUPPORTED_CAPABILITY` | an inherited method `ZephyrDaemonRpc` does not offer (undeclared; rejected before any request) |
| `RELAY_REQUEST` | `UNSUPPORTED_CAPABILITY`, `NATIVE_ERROR` | a submit or relay request refused by the transport: outside a relay call `UNSUPPORTED_CAPABILITY`; during `relayPrepared` `NATIVE_ERROR`, nothing sent |

### Configuration and arguments

| Diagnostic | Code | Meaning |
|---|---|---|
| `CONFIG_TYPE` | `INVALID_CONFIG` | a configuration, query or options value that is not a plain object of own data properties |
| `UNKNOWN_FIELD` | `INVALID_CONFIG` | an unknown field |
| `FIELD_TYPE` | `INVALID_CONFIG` | a field or argument of the wrong type, or too many arguments |
| `BLOCK_HEIGHT` | `INVALID_CONFIG` | a block height that is not a safe integer from 0 (`ZephyrDaemonRpc.getBlockHeaderByHeight`) |
| `BLOCK_HASH` | `INVALID_CONFIG` | a block hash that is not 64 lowercase hexadecimal characters (`ZephyrDaemonRpc.getBlockHeaderByHash`) |
| `LISTENER_NOT_REGISTERED` | `INVALID_CONFIG` | `removeListener` with a listener that is not added |
| `SYNC_PERIOD` | `INVALID_CONFIG` | a `startSyncing` period that is not an integer from 1,000 to 86,400,000 milliseconds |
| `NETWORK_TYPE` | `INVALID_CONFIG` | a missing or unknown network type |
| `CREATE_MODE` | `INVALID_CONFIG` | recovery fields that do not fit the construction function |
| `SEED_AND_KEYS` | `INVALID_CONFIG` | a seed together with keys |
| `SEED_OFFSET` | `INVALID_CONFIG` | a seed offset without a seed |
| `SEED_LANGUAGE` | `INVALID_CONFIG` | a language with a seed |
| `RANDOM_RESTORE_HEIGHT` | `INVALID_CONFIG` | a restore height for a random wallet |
| `RESTORE_HEIGHT_RANGE` | `INVALID_CONFIG` | a restore height that is not a safe integer from 0 |
| `LOOKAHEAD_PAIR` | `INVALID_CONFIG` | only one of the two lookahead values |
| `LOOKAHEAD_RANGE` | `INVALID_CONFIG` | a lookahead value outside 1 to 2^32-1 |
| `LOOKAHEAD_LIMIT` | `INVALID_CONFIG` | a lookahead value or their product above 20,000 |
| `CORE_LOOKAHEAD` | `INVALID_CONFIG` | a lookahead the core rejected |
| `CORE_UNKNOWN_LANGUAGE` | `INVALID_CONFIG` | a seed language the core does not know |
| `LOG_LEVEL_RANGE` | `INVALID_CONFIG` | a native log level out of range (not offered by the entry) |
| `PASSWORD_TYPE` | `INVALID_CONFIG` | a password that is not a string |
| `ADDRESS_INDEX_RANGE` | `INVALID_CONFIG` | an account or subaddress index outside 0 to 2^32-1 |
| `DAEMON_ADDRESS` | `INVALID_CONFIG` | a malformed daemon address |
| `SYNC_START_HEIGHT` | `INVALID_CONFIG` | a sync start height that is not a safe integer from 0 |
| `ASSET_TYPE` | `INVALID_CONFIG` | an asset name that is malformed, or not one the call accepts |
| `ACCOUNT_NOT_FOUND` | `INVALID_CONFIG` | an account the wallet does not have |
| `SUBADDRESS_NOT_FOUND` | `INVALID_CONFIG` | a subaddress the wallet does not have |
| `LABEL_TYPE` | `INVALID_CONFIG` | a label that is not a string |
| `LABEL_LENGTH` | `INVALID_CONFIG` | a label longer than 255 UTF-8 bytes |
| `LABEL_CHARACTERS` | `INVALID_CONFIG` | a label with a control character or an unpaired surrogate |
| `SUBADDRESS_INDICES` | `INVALID_CONFIG` | subaddress indices that are not a non-empty array of distinct indices |
| `LISTING_LIMIT` | `INVALID_CONFIG` | a listing or selection above the per-call bounds |
| `TX_HASH` | `INVALID_CONFIG` | a transaction hash that is not 64 lowercase hexadecimal characters |
| `TX_HASHES` | `INVALID_CONFIG` | hashes that are not a non-empty array of distinct hashes, at most 1,000 |
| `HEIGHT_RANGE` | `INVALID_CONFIG` | heights that are not safe integers from low to high |
| `QUERY_ACCOUNT_REQUIRED` | `INVALID_CONFIG` | a subaddress filter without an account |
| `TX_NOT_FOUND` | `INVALID_CONFIG` | a transaction the wallet has no record of |
| `TX_ASSET` | `INVALID_CONFIG` | a V1 asset for a transaction |
| `DESTINATIONS` | `INVALID_CONFIG` | destinations that are not a non-empty array |
| `TOO_MANY_DESTINATIONS` | `INVALID_CONFIG` | more than 15 destinations |
| `AMOUNT_ZERO` | `INVALID_CONFIG` | an amount of zero |
| `AMOUNT_RANGE` | `INVALID_CONFIG` | an amount, or the sum of the amounts, outside 1 to 2^64-1 |
| `TX_PRIORITY` | `INVALID_CONFIG` | a priority other than the four |
| `CONVERSION_PAIR` | `INVALID_CONFIG` | assets that are not one of the six conversion pairs |
| `CONVERSION_DESTINATIONS` | `INVALID_CONFIG` | a conversion destination that is not exactly one object |
| `AMOUNT_PRECISION` | `INVALID_CONFIG` | a conversion amount with more than four decimals |
| `RELAY_TOKEN` | `INVALID_CONFIG` | a value that is not a relay token |
| `RELAY_TOKEN_VOID` | `INVALID_CONFIG` | a token that names no kept build (unknown, used or void) |

### Recovery material, wallet data and addresses

| Diagnostic | Code | Meaning |
|---|---|---|
| `SEED_EMPTY` | `INVALID_RECOVERY_MATERIAL` | an empty seed |
| `SEED_WORD_COUNT` | `INVALID_RECOVERY_MATERIAL` | a seed that does not have 12, 13, 24 or 25 words |
| `KEY_EMPTY` | `INVALID_RECOVERY_MATERIAL` | an empty key or address |
| `KEY_FORMAT` | `INVALID_RECOVERY_MATERIAL` | a private key that is not 64 hexadecimal characters |
| `VIEW_KEY_WITHOUT_ADDRESS` | `INVALID_RECOVERY_MATERIAL` | a private view key without an address |
| `KEYS_MISSING` | `INVALID_RECOVERY_MATERIAL` | neither an address nor a private spend key |
| `CORE_INVALID_MNEMONIC` | the call's | a seed the core cannot decode |
| `CORE_INVALID_KEY` | the call's | a key the core rejected |
| `WALLET_BYTES` | `INVALID_WALLET_DATA` | wallet bytes that are missing, empty or not a `Uint8Array` |
| `CORE_WALLET_DATA` | the call's | wallet bytes the core could not open |
| `CORE_INVALID_PASSWORD` | `WRONG_PASSWORD` | a password the core rejected |
| `ADDRESS_TYPE` | `INVALID_ADDRESS` | an address that is not a non-empty string of the expected form |
| `CORE_INVALID_ADDRESS` | `INVALID_ADDRESS` | an address the core's parser rejects, or of another network |
| `ADDRESS_NETWORK` | `INVALID_ADDRESS` | a valid address of another network as a destination or as the address of a transaction proof |
| `ADDRESS_NOT_IN_WALLET` | `INVALID_ADDRESS` | an address of another wallet |

### Daemon

| Diagnostic | Code | Meaning |
|---|---|---|
| `DAEMON_NOT_CONNECTED` | `DAEMON_ERROR` | no daemon configured or connected; also a browser request blocked by CORS or a policy |
| `DAEMON_UNREACHABLE` | `DAEMON_ERROR` | no answer: unreachable, refused or timed out; at relay, nothing was sent |
| `DAEMON_RESPONSE` | `DAEMON_ERROR` | an answer the core could not use: an error, an HTTP status, a body, a redirect |
| `DAEMON_BUSY` | `DAEMON_ERROR` | at relay, the daemon did not process the transaction; for `ZephyrDaemonRpc`, the daemon answered with the status BUSY |
| `PRICING_RECORD_UNAVAILABLE` | `DAEMON_ERROR` | `getReserveInfo`: the core could not read a usable pricing record of the daemon's top block and computed nothing |
| `SYNC_FAILED` | `NATIVE_ERROR` | another failure of a sync |

### Proofs and transaction keys

| Diagnostic | Code | Meaning |
|---|---|---|
| `PROOF_MESSAGE` | `INVALID_CONFIG` | a proof message that is not a string of at most 1,024 UTF-8 bytes without U+0000 or an unpaired surrogate |
| `TX_FAILED` | `INVALID_CONFIG` | a proof of a transaction the wallet holds as failed (no daemon has it) |
| `TX_KEY_UNAVAILABLE` | `INVALID_CONFIG` | the wallet holds no secret key for the transaction: it did not send it, or it was restored from its seed or from bytes saved before the send |
| `ADDRESS_NOT_IN_TX` | `INVALID_CONFIG` | `getTxProof`: the address received nothing in the transaction |
| `TX_NOT_SENT` | `INVALID_CONFIG` | `getSpendProof`: the wallet spent nothing in the transaction |
| `PROOF_FAILED` | `NATIVE_ERROR` | another failure of the core's proof |

### Building, conversions and relay

| Diagnostic | Code | Meaning |
|---|---|---|
| `NOT_ENOUGH_UNLOCKED` | `TX_NOT_POSSIBLE` | the unlocked balance of the asset does not cover the amounts; a sweep: nothing of the selected outputs is unlocked (or worth more than the fee of spending it) |
| `NOT_ENOUGH_MONEY` | `TX_NOT_POSSIBLE` | even the balance with locked outputs does not cover the amounts; a sweep: the balance of the selected outputs is zero |
| `NOT_ENOUGH_FOR_FEE` | `TX_NOT_POSSIBLE` | the fee cannot be covered; a sweep: the swept outputs cannot pay their own fee |
| `NOT_ENOUGH_OUTS_TO_MIX` | `TX_NOT_POSSIBLE` | the chain has too few outputs for the rings |
| `TX_TOO_LARGE` | `TX_NOT_POSSIBLE` | the transaction would be too large |
| `RESERVE_RATIO` | `TX_NOT_POSSIBLE` | the reserve ratio does not allow the conversion pair |
| `PRICING_RECORD` | `TX_NOT_POSSIBLE` | no usable pricing record, also when it could not be read |
| `CONVERSION_SPLIT` | `TX_NOT_POSSIBLE` | the conversion would need more than one transaction |
| `CONVERSION_AMOUNT` | `TX_NOT_POSSIBLE` | the converted amount would be zero |
| `PRICING_RECORD_AGE` | `TX_NOT_POSSIBLE` | a kept conversion's pricing record has aged; the token is void |
| `TX_BUILD_FAILED` | `NATIVE_ERROR` | another failure of the core's build |
| `RELAY_HASH_MISMATCH` | `NATIVE_ERROR` | a kept transaction does not hash to the described hash; nothing sent, the token is void |
| `RELAY_FAILED` | `NATIVE_ERROR` | the core's commit failed before any request; the token is void |
| `RELAY_RECORD_FAILED` | `NATIVE_ERROR` | on an accepted entry: the daemon has the transaction, the wallet could not record it |
| `LOW_RING_SIZE` | `TX_REJECTED` | the daemon refused it: ring size too low |
| `DOUBLE_SPEND` | `TX_REJECTED` | the daemon refused it: a double spend |
| `INVALID_INPUT` | `TX_REJECTED` | the daemon refused it: an invalid input |
| `INVALID_OUTPUT` | `TX_REJECTED` | the daemon refused it: an invalid output |
| `TOO_BIG` | `TX_REJECTED` | the daemon refused it: too big |
| `OVERSPEND` | `TX_REJECTED` | the daemon refused it: overspend |
| `FEE_TOO_LOW` | `TX_REJECTED` | the daemon refused it: fee too low |
| `TOO_FEW_OUTPUTS` | `TX_REJECTED` | the daemon refused it: too few outputs |
| `TX_EXTRA_TOO_BIG` | `TX_REJECTED` | the daemon refused it: extra field too big |
| `SANITY_CHECK_FAILED` | `TX_REJECTED` | the daemon refused it: its sanity check failed |
| `NOT_RELAYED` | `TX_REJECTED` | the daemon refused it with the not-relayed flag |
| `REJECTED` | `TX_REJECTED` | the daemon refused it without a known flag |
| `NO_ANSWER` | `RELAY_UNKNOWN` | sent; no answer came |
| `HTTP_STATUS` | `RELAY_UNKNOWN` | sent; the answer was an HTTP error |
| `ANSWER_UNREADABLE` | `RELAY_UNKNOWN` | sent; the answer could not be read |

### Module, workers and wallet state

| Diagnostic | Code | Meaning |
|---|---|---|
| `WASM_MODULE_UNAVAILABLE` | `NATIVE_ERROR` | `zephyr.wasm` could not be read or fetched (in Firefox also a worker policy without `'wasm-unsafe-eval'`) |
| `WASM_MODULE_REJECTED` | `NATIVE_ERROR` | the module did not compile or instantiate, for example under a policy without `'wasm-unsafe-eval'` |
| `WASM_MODULE_MISMATCH` | `NATIVE_ERROR` | not the `zephyr.wasm` whose SHA-256 the build embedded |
| `WASM_MODULE_UNVERIFIED` | `NATIVE_ERROR` | no Web Crypto digest in this runtime, so the module cannot be checked |
| `CONSTRUCTION_ABORTED` | `NATIVE_ERROR` | a construction was aborted by its signal or by `terminateWorker` |
| `WORKER_FAILED` | `NATIVE_ERROR` | a worker could not start, reported an uncaught error or exited unexpectedly |
| `WALLET_TERMINATED` | `WALLET_CLOSED` | the wallet was stopped with `terminate` or `terminateWorker` |
| `CORE_CLOSE_FAILED` | `NATIVE_ERROR` | the native close failed; `close` can be retried |
| `PASSWORD_CHANGED_WITH_ERROR` | `NATIVE_ERROR` | a failed password change that adopted the new password |
| `PASSWORD_STATE_UNKNOWN` | `NATIVE_ERROR` | the password state is unknown; every call but `close` rejects |
| `CORE_UNCLASSIFIED` | the call's | a core failure without a more specific identifier |
| `UNCLASSIFIED_ERROR` | the call's | a failure that is neither a wallet error nor a bridge result |
| `UNEXPECTED_RESULT` | `NATIVE_ERROR` | a native result that did not have the expected form |
| `UNEXPECTED_ASSET_TYPE` | `NATIVE_ERROR` | a balance key outside the core's asset types |
| `RESTORE_HEIGHT_UNREPRESENTABLE` | `NATIVE_ERROR` | a restore height above `Number.MAX_SAFE_INTEGER` |
| `BUFFER_ALLOCATION_FAILED` | the call's | the bridge could not allocate a byte buffer |
| `NATIVE_BUFFER_FAILED` | the call's | the bridge could not provide a byte buffer |
| `BUFFER_FORMAT_FAILED` | the call's | the bridge could not format a byte buffer |
| `BUFFER_TOO_LARGE` | the call's | a byte buffer is too large |
| `BUFFER_EMPTY` | `NATIVE_ERROR` | a byte buffer is empty |
| `BUFFER_COPY_FAILED` | `NATIVE_ERROR` | a byte buffer could not be copied |
| `BUFFER_RESULT` | `NATIVE_ERROR` | a byte buffer result did not have the expected form |
| `MESSAGE_SHAPE` | `MALFORMED_MESSAGE` | a worker message or error envelope of the wrong shape |
| `ARGUMENT_COUNT` | `MALFORMED_MESSAGE` | a worker call with the wrong number of arguments |
| `ARGUMENT_TYPE` | `MALFORMED_MESSAGE` | a worker call argument of the wrong type |
| `WALLET_ID` | `MALFORMED_MESSAGE` | a malformed or unknown wallet identifier in a worker message |
| `DUPLICATE_WALLET_ID` | `MALFORMED_MESSAGE` | a wallet identifier used twice in a worker |
