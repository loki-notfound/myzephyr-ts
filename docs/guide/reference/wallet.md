# ZephyrWallet

```ts signature
class ZephyrWallet
```

The wallet class. Instances come from the construction functions ([functions](functions.md)); the
constructor is private. Every method that returns a promise rejects with a
[`ZephyrWalletError`](errors.md). Rules that hold for all of them:

- After `close()` or `terminate()`, every call rejects with `WALLET_CLOSED` (after a forced stop with
  the diagnostic `WALLET_TERMINATED`).
- A wallet's calls run one at a time, in order. Arguments are checked before anything is dispatched.
- Calls that need a full wallet reject on a keys-only wallet with `UNSUPPORTED_CAPABILITY` and the
  diagnostic named in the entry (`KEYS_ONLY_*`).
- Account and subaddress indices are integers from 0 to 2^32-1 (`INVALID_CONFIG`/`ADDRESS_INDEX_RANGE`).
- Results are frozen plain objects and arrays; amounts are `bigint` in atomic units.

## Properties

### `kind`

```ts signature
readonly kind: "full" | "keys";
```

`"full"` for a wallet from `createRandomWallet`, `restoreWalletFromSeed`, `restoreWalletFromKeys` or
`openWalletData`; `"keys"` for one from `createKeysWallet`. Guide:
[Kinds of wallets](../02-wallets.md#kinds-of-wallets).

### `proxied`

```ts signature
readonly proxied: boolean;
```

`true` when the wallet runs in its own worker (`proxyToWorker`, the default). Guide:
[One worker per wallet](../02-wallets.md#one-worker-per-wallet).

### `wrap`

```ts signature
static wrap(inner: InnerWallet, kind: "full" | "keys", proxied: boolean, daemon?: ZephyrDaemonRoute): ZephyrWallet;
```

Marked `@internal` in the declarations: the construction functions use it to create the facade. Its
parameter types are not exported. Applications do not call it.

## Lifecycle

### `isClosed`

```ts signature
isClosed(): boolean;
```

Whether `close()` or `terminate()` was called. Synchronous; never throws. Guide:
[Closing a wallet](../02-wallets.md#closing-a-wallet).

### `close`

```ts signature
close(): Promise<void>;
```

Idempotent close. New calls reject with `WALLET_CLOSED` from the moment it is called; queued calls that
have not started reject with `WALLET_CLOSED`; a running call finishes first. Concurrent calls share one
attempt. It does not save. Resolves after a forced stop.

Rejects with: `NATIVE_ERROR`/`CORE_CLOSE_FAILED` when the native close fails; the wallet stays closed
to new work and a later `close()` retries. Guide: [Closing a wallet](../02-wallets.md#closing-a-wallet).

### `terminate`

```ts signature
terminate(): Promise<void>;
```

Forced stop of a worker-mode wallet: its worker is ended at once, without a native close and without
waiting for a running call. Unsaved state is lost. Every pending and later call rejects with
`WALLET_CLOSED`/`WALLET_TERMINATED`; `close()` resolves. Idempotent; after a completed close it does
nothing.

Rejects with: `UNSUPPORTED_CAPABILITY`/`TERMINATE` in direct mode. Guide:
[Stopping a wallet at once](../02-wallets.md#stopping-a-wallet-at-once).

### `getData`

```ts signature
getData(): Promise<ZephyrWalletData>;
```

The wallet's keys and cache bytes, encrypted with the wallet password, for you to store. No file is
written. Encrypts afresh on every call.

Rejects with: `UNSUPPORTED_CAPABILITY`/`KEYS_ONLY_DATA`. Guide:
[Saving and opening wallet bytes](../02-wallets.md#saving-and-opening-wallet-bytes).

### `changePassword`

```ts signature
changePassword(oldPassword: string, newPassword: string): Promise<void>;
```

Re-encrypts in memory; the next `getData()` carries the new password. The library verifies the old
password. Changes issued without awaiting run in order. Voids a kept build.

Rejects with: `INVALID_CONFIG`/`PASSWORD_TYPE` for a non-string; `WRONG_PASSWORD` for a wrong old
password (nothing changes); `NATIVE_ERROR`/`PASSWORD_CHANGED_WITH_ERROR` (the new password was
adopted); `NATIVE_ERROR`/`PASSWORD_STATE_UNKNOWN`, after which every call but `close` rejects with that
diagnostic; `UNSUPPORTED_CAPABILITY`/`KEYS_ONLY_PASSWORD`. Guide: [The password](../02-wallets.md#the-password).

## Keys and addresses

### `getPrimaryAddress`

```ts signature
getPrimaryAddress(): Promise<string>;
```

The address of account 0, subaddress 0. Full and keys-only wallets. Guide:
[A first program in Node.js](../01-getting-started.md#a-first-program-in-nodejs).

### `getAddress`

```ts signature
getAddress(accountIdx: number, subaddressIdx: number): Promise<string>;
```

The address of a subaddress. Full and keys-only wallets.

Rejects with: `INVALID_CONFIG`/`ADDRESS_INDEX_RANGE`. Guide:
[Accounts and subaddresses](../04-assets-and-balances.md#accounts-and-subaddresses).

### `getAddressIndex`

```ts signature
getAddressIndex(address: string): Promise<ZephyrAddressIndex>;
```

The account and subaddress an address of this wallet belongs to; also subaddresses of the lookahead
window that were not created yet.

Rejects with: `INVALID_ADDRESS`/`ADDRESS_TYPE` (not a string, empty or longer than 256),
`INVALID_ADDRESS`/`CORE_INVALID_ADDRESS` (malformed or another network),
`INVALID_ADDRESS`/`ADDRESS_NOT_IN_WALLET`, `UNSUPPORTED_CAPABILITY`/`KEYS_ONLY_ACCOUNTS`. Guide:
[Accounts and subaddresses](../04-assets-and-balances.md#accounts-and-subaddresses).

### `getNetworkType`

```ts signature
getNetworkType(): Promise<number>;
```

`0` (mainnet), `1` (testnet) or `2` (stagenet).

Rejects with: `UNSUPPORTED_CAPABILITY`/`KEYS_ONLY_NETWORK_TYPE`. Guide:
[Network types](../02-wallets.md#network-types).

### `getSeed`

```ts signature
getSeed(): Promise<string>;
```

The 25-word seed. Full and keys-only wallets. A view-only wallet has no seed; with the release package
the promise resolves to `undefined` in that case. Guide:
[Creating a random wallet](../02-wallets.md#creating-a-random-wallet).

### `getSeedLanguage`

```ts signature
getSeedLanguage(): Promise<string>;
```

The language of the seed, for example `"English"`. Full and keys-only wallets.

### `getPrivateViewKey`

```ts signature
getPrivateViewKey(): Promise<string>;
```

The private view key, 64 hexadecimal characters. Full and keys-only wallets. Guide:
[Restoring from keys](../02-wallets.md#restoring-from-keys).

### `getPrivateSpendKey`

```ts signature
getPrivateSpendKey(): Promise<string>;
```

The private spend key, 64 hexadecimal characters. Full and keys-only wallets. A view-only wallet has
none; with the release package the promise resolves to `undefined` in that case. Guide:
[Restoring from keys](../02-wallets.md#restoring-from-keys).

### `getPublicViewKey`

```ts signature
getPublicViewKey(): Promise<string>;
```

The public view key, 64 hexadecimal characters. Full and keys-only wallets.

### `getPublicSpendKey`

```ts signature
getPublicSpendKey(): Promise<string>;
```

The public spend key, 64 hexadecimal characters. Full and keys-only wallets.

### `isViewOnly`

```ts signature
isViewOnly(): Promise<boolean>;
```

Whether the wallet has no private spend key. Guide: [Kinds of wallets](../02-wallets.md#kinds-of-wallets).

### `getRestoreHeight`

```ts signature
getRestoreHeight(): Promise<number>;
```

The height the first sync starts from, as a safe integer.

Rejects with: `UNSUPPORTED_CAPABILITY`/`KEYS_ONLY_RESTORE_HEIGHT`; `NATIVE_ERROR`/
`RESTORE_HEIGHT_UNREPRESENTABLE` for a height above `Number.MAX_SAFE_INTEGER`. Guide:
[Creating a random wallet](../02-wallets.md#creating-a-random-wallet).

## Daemon

All daemon methods are for full wallets; keys-only wallets reject with
`UNSUPPORTED_CAPABILITY`/`KEYS_ONLY_DAEMON`. Daemon failures reject with `DAEMON_ERROR` and
`DAEMON_NOT_CONNECTED`, `DAEMON_UNREACHABLE` or `DAEMON_RESPONSE`.

### `setDaemonConnection`

```ts signature
setDaemonConnection(address?: string | {
        uri: string;
        trusted?: boolean;
    }): Promise<void>;
```

Sets the daemon, or clears it with `undefined`. Resolves when the core holds the address; an
unreachable daemon is not an error here. A kept build survives it.

Rejects with: `INVALID_CONFIG`/`DAEMON_ADDRESS`, `CONFIG_TYPE`, `FIELD_TYPE`, `UNKNOWN_FIELD`;
`UNSUPPORTED_CAPABILITY`/`DAEMON_CREDENTIALS`, `DAEMON_PROXY`, `UNTRUSTED_DAEMON` (`trusted: false`),
`CONFIG_FIELD` (`rejectUnauthorized`). Guide:
[Setting the daemon](../03-connecting-to-a-daemon.md#setting-the-daemon).

### `getDaemonConnection`

```ts signature
getDaemonConnection(): ZephyrDaemonConnection | undefined;
```

The daemon address the library holds, normalized, with `trusted: true`, or `undefined`. Synchronous;
no request; never throws.

### `isConnectedToDaemon`

```ts signature
isConnectedToDaemon(): Promise<boolean>;
```

Whether the core reaches the configured daemon now; a request. `false` without a daemon or when it is
unreachable. Guide: [Setting the daemon](../03-connecting-to-a-daemon.md#setting-the-daemon).

### `getDaemonHeight`

```ts signature
getDaemonHeight(): Promise<number>;
```

The daemon's height; a request. Guide: [Heights](../03-connecting-to-a-daemon.md#heights).

### `isDaemonSynced`

```ts signature
isDaemonSynced(): Promise<boolean>;
```

Whether the daemon reports itself synchronized with the network (its height is at least the highest
height of its peers, and above 1); a request. A daemon that is not synchronized makes a sync fetch
nothing. Guide: [Synchronizing](../03-connecting-to-a-daemon.md#synchronizing).

### `getHeight`

```ts signature
getHeight(): Promise<number>;
```

The wallet's height; no request. Guide: [Heights](../03-connecting-to-a-daemon.md#heights).

### `sync`

```ts signature
sync(startHeight?: number): Promise<ZephyrWalletSyncResult>;
```

One blocking synchronization, from `startHeight` or from the core's default start. Other calls of the
wallet wait for it. A kept build is voided if the wallet's height afterwards differs from the height
at the build by more than 10 blocks.

Rejects with: `INVALID_CONFIG`/`SYNC_START_HEIGHT` (not a safe integer from 0),
`UNSUPPORTED_CAPABILITY`/`SYNC` (more than one argument), `DAEMON_ERROR`, `NATIVE_ERROR`/`SYNC_FAILED`.
Guide: [Synchronizing](../03-connecting-to-a-daemon.md#synchronizing).

### `refreshPool`

```ts signature
refreshPool(): Promise<number>;
```

Asks the daemon for its pool and updates the wallet's view of its incoming unconfirmed transfers;
resolves with the number of incoming pool transactions the wallet holds (at most 1,000). Requests
`/get_transaction_pool_hashes.bin` and `/gettransactions`.

Rejects with: `INVALID_CONFIG`/`FIELD_TYPE` (an argument), `INVALID_CONFIG`/`LISTING_LIMIT`,
`DAEMON_ERROR`, `UNSUPPORTED_CAPABILITY`/`KEYS_ONLY_DAEMON`. Guide:
[Incoming transfers in the pool](../05-history.md#incoming-transfers-in-the-pool).

## Balances

### `getBalance`

```ts signature
getBalance(): Promise<ZephyrAssetBalances>;
getBalance(accountIdx: number): Promise<ZephyrAccountBalances>;
getBalance(assetType: string, accountIdx: number, subaddressIdx?: number): Promise<bigint>;
```

The wallet's balance by asset (the core's keys, zeros included); an account's balances by subaddress
index (only what the core reports); or one asset's balance in an account or subaddress. No request.

Rejects with: `INVALID_CONFIG`/`ASSET_TYPE`, `ADDRESS_INDEX_RANGE`, `ACCOUNT_NOT_FOUND`,
`SUBADDRESS_NOT_FOUND`, `FIELD_TYPE` (other argument shapes); `UNSUPPORTED_CAPABILITY`/`BALANCE` for the
asset-less `(accountIdx, subaddressIdx)` form; `UNSUPPORTED_CAPABILITY`/`KEYS_ONLY_DAEMON`. Guide:
[Balances](../04-assets-and-balances.md#balances).

### `getUnlockedBalance`

```ts signature
getUnlockedBalance(): Promise<ZephyrAssetBalances>;
getUnlockedBalance(accountIdx: number): Promise<ZephyrAccountBalances>;
getUnlockedBalance(assetType: string, accountIdx: number, subaddressIdx?: number): Promise<bigint>;
```

The spendable balance, in the same three shapes and with the same rejections as `getBalance`. Guide:
[Unlocked balance](../04-assets-and-balances.md#unlocked-balance).

## Accounts and subaddresses

Full wallets only; keys-only wallets reject with `UNSUPPORTED_CAPABILITY`/`KEYS_ONLY_ACCOUNTS`. Labels
are strings of at most 255 UTF-8 bytes without control characters or unpaired surrogates
(`INVALID_CONFIG`: `LABEL_TYPE`, `LABEL_LENGTH`, `LABEL_CHARACTERS`). Guide:
[Accounts and subaddresses](../04-assets-and-balances.md#accounts-and-subaddresses).

### `getAccounts`

```ts signature
getAccounts(options?: ZephyrAccountOptions): Promise<ReadonlyArray<ZephyrAccount>>;
```

Every account in index order; with `{ includeSubaddresses: true }` each with its subaddresses.

Rejects with: `INVALID_CONFIG`/`LISTING_LIMIT` (more than 1,000 accounts, or more than 1,000
subaddresses in total), and `INVALID_CONFIG` for malformed options.

### `getAccount`

```ts signature
getAccount(accountIdx: number, options?: ZephyrAccountOptions): Promise<ZephyrAccount>;
```

One account; with `{ includeSubaddresses: true }` its subaddresses (at most 1,000).

Rejects with: `INVALID_CONFIG`/`ADDRESS_INDEX_RANGE`, `ACCOUNT_NOT_FOUND`, `LISTING_LIMIT`.

### `createAccount`

```ts signature
createAccount(label?: string): Promise<ZephyrAccount>;
```

Creates one account with an optional label (default `""`) and returns it.

Rejects with: the label rejections.

### `getSubaddresses`

```ts signature
getSubaddresses(accountIdx: number, subaddressIndices?: readonly number[]): Promise<ReadonlyArray<ZephyrSubaddress>>;
```

Every subaddress of an account in index order (at most 1,000), or the given indices in the given order:
a non-empty array of at most 1,000 distinct indices.

Rejects with: `INVALID_CONFIG`/`ADDRESS_INDEX_RANGE`, `ACCOUNT_NOT_FOUND`, `SUBADDRESS_NOT_FOUND`,
`SUBADDRESS_INDICES`, `LISTING_LIMIT`.

### `getSubaddress`

```ts signature
getSubaddress(accountIdx: number, subaddressIdx: number): Promise<ZephyrSubaddress>;
```

One subaddress.

Rejects with: `INVALID_CONFIG`/`ADDRESS_INDEX_RANGE`, `ACCOUNT_NOT_FOUND`, `SUBADDRESS_NOT_FOUND`.

### `createSubaddress`

```ts signature
createSubaddress(accountIdx: number, label?: string): Promise<ZephyrSubaddress>;
```

Creates one subaddress of an account with an optional label (default `""`) and returns it.

Rejects with: `INVALID_CONFIG`/`ADDRESS_INDEX_RANGE`, `ACCOUNT_NOT_FOUND`, the label rejections.

### `setSubaddressLabel`

```ts signature
setSubaddressLabel(accountIdx: number, subaddressIdx: number, label: string): Promise<void>;
```

Sets, or with `""` clears, the label of a subaddress; subaddress 0 carries the account's label.

Rejects with: `INVALID_CONFIG`/`ADDRESS_INDEX_RANGE`, `ACCOUNT_NOT_FOUND`, `SUBADDRESS_NOT_FOUND`, the
label rejections.

## History

Full wallets only; keys-only wallets reject with `UNSUPPORTED_CAPABILITY`/`KEYS_ONLY_HISTORY`. No
request is sent. Guide: [History](../05-history.md).

### `getTxs`

```ts signature
getTxs(query?: ZephyrHistoryQuery): Promise<ReadonlyArray<ZephyrWalletTx>>;
```

The wallet's transactions: confirmed by height then hash, unconfirmed after them. With transfer
filters, the transactions with at least one matching transfer, each with all of its transfers.

Rejects with: `INVALID_CONFIG` and `CONFIG_TYPE`, `UNKNOWN_FIELD`, `FIELD_TYPE`, `ASSET_TYPE`,
`ADDRESS_INDEX_RANGE`, `QUERY_ACCOUNT_REQUIRED`, `HEIGHT_RANGE`, `TX_HASHES`, `TX_HASH`, `TX_NOT_FOUND`,
`LISTING_LIMIT` (more than 1,000 transactions or 2,000 transfers). Guide:
[The query](../05-history.md#the-query).

### `getTransfers`

```ts signature
getTransfers(query?: ZephyrHistoryQuery): Promise<ReadonlyArray<ZephyrWalletTransfer>>;
```

The transfers that match the query; per transaction the outgoing transfer first, then the incoming
ones. Same rejections as `getTxs`. Guide: [Transfers](../05-history.md#transfers).

### `getTx`

```ts signature
getTx(hash: string): Promise<ZephyrWalletTx>;
```

One transaction by its hash.

Rejects with: `INVALID_CONFIG`/`TX_HASH` (not 64 lowercase hexadecimal characters),
`INVALID_CONFIG`/`TX_NOT_FOUND` (also for an incoming pool transaction the last `refreshPool` did not
see). Guide: [The query](../05-history.md#the-query).

## Building and relaying

Full wallets with spend keys only: keys-only wallets reject with `UNSUPPORTED_CAPABILITY`/`KEYS_ONLY_TX`,
view-only wallets with `UNSUPPORTED_CAPABILITY`/`VIEW_ONLY_TX`. A second argument rejects with
`INVALID_CONFIG`/`FIELD_TYPE`.

### `buildTransfer`

```ts signature
buildTransfer(config: ZephyrTransferConfig): Promise<ZephyrTransferBuild>;
```

Builds the transactions of a same-asset transfer, describes them and discards them. Nothing is relayed
or stored.

Rejects with: `INVALID_CONFIG` (`CONFIG_TYPE`, `UNKNOWN_FIELD`, `FIELD_TYPE`, `ASSET_TYPE`, `TX_ASSET`,
`DESTINATIONS`, `TOO_MANY_DESTINATIONS`, `AMOUNT_ZERO`, `AMOUNT_RANGE`, `ADDRESS_INDEX_RANGE`,
`ACCOUNT_NOT_FOUND`, `SUBADDRESS_INDICES`, `SUBADDRESS_NOT_FOUND`, `TX_PRIORITY`); `INVALID_ADDRESS`
(`ADDRESS_TYPE`, `CORE_INVALID_ADDRESS`, `ADDRESS_NETWORK`); `UNSUPPORTED_CAPABILITY` (`CONVERSION`,
`INTEGRATED_ADDRESS`); `TX_NOT_POSSIBLE` (`NOT_ENOUGH_UNLOCKED`, `NOT_ENOUGH_MONEY`,
`NOT_ENOUGH_FOR_FEE`, `NOT_ENOUGH_OUTS_TO_MIX`, `TX_TOO_LARGE`); `DAEMON_ERROR`;
`NATIVE_ERROR`/`TX_BUILD_FAILED`. Guide: [Building to inspect](../06-sending.md#building-to-inspect).

### `buildConversion`

```ts signature
buildConversion(config: ZephyrConversionConfig): Promise<ZephyrConversionBuild>;
```

Builds the one transaction of a conversion between two V2 assets, describes it and discards it.

Rejects with: the configuration rejections of `buildTransfer` as they apply, `INVALID_CONFIG`/
`CONVERSION_PAIR`, `CONVERSION_DESTINATIONS`, `AMOUNT_PRECISION`; `TX_NOT_POSSIBLE` (`RESERVE_RATIO`,
`PRICING_RECORD`, `CONVERSION_SPLIT`, `CONVERSION_AMOUNT`, and the build failures of `buildTransfer`);
`DAEMON_ERROR`; `NATIVE_ERROR`/`TX_BUILD_FAILED`. Guide:
[What a conversion build describes](../07-conversions.md#what-a-conversion-build-describes).

### `prepareTransfer`

```ts signature
prepareTransfer(config: ZephyrTransferConfig): Promise<ZephyrPreparedTransfer>;
```

As `buildTransfer`, but keeps the built transactions in the wallet's one slot under a new token; the
previous kept build is voided, also when this prepare fails. Nothing is relayed. Same rejections as
`buildTransfer`. Guide: [Preparing and relaying](../06-sending.md#preparing-and-relaying).

### `prepareConversion`

```ts signature
prepareConversion(config: ZephyrConversionConfig): Promise<ZephyrPreparedConversion>;
```

As `buildConversion`, but keeps the built transaction under a new token. Same rejections as
`buildConversion`. Guide: [Relaying a conversion](../07-conversions.md#relaying-a-conversion).

### `relayPrepared`

```ts signature
relayPrepared(token: string): Promise<ZephyrRelayResult>;
```

Relays exactly the kept build the token names, one `POST /sendrawtransaction` per transaction to the
wallet's configured daemon. Resolves when at least one transaction was accepted in this call.

Rejects with: `INVALID_CONFIG`/`RELAY_TOKEN` (not a token), `RELAY_TOKEN_VOID`;
`TX_NOT_POSSIBLE`/`PRICING_RECORD_AGE`; `TX_REJECTED` with the daemon's first reason;
`DAEMON_ERROR`/`DAEMON_BUSY`, `DAEMON_UNREACHABLE`; `RELAY_UNKNOWN`/`NO_ANSWER`, `HTTP_STATUS`,
`ANSWER_UNREADABLE`; `NATIVE_ERROR`/`RELAY_HASH_MISMATCH`, `RELAY_REQUEST`, `RELAY_FAILED`. Guide:
[Outcomes of a relay](../06-sending.md#outcomes-of-a-relay).

### `discardPrepared`

```ts signature
discardPrepared(token: string): Promise<boolean>;
```

Voids the kept build the token names (wiped and released inside the module); `false` when it named
none.

Rejects with: `INVALID_CONFIG`/`RELAY_TOKEN`. Guide:
[The life of a kept build](../06-sending.md#the-life-of-a-kept-build).

## Unsupported inherited calls

These names remain from monero-ts so that a port finds them. Each rejects with
`UNSUPPORTED_CAPABILITY` before any native code runs. Guide:
[What is not ported](../10-coming-from-monero-ts.md#what-is-not-ported).

### `startSyncing`

```ts signature
startSyncing(): Promise<never>;
```

Background synchronization. Rejects with `UNSUPPORTED_CAPABILITY`/`SYNC`.

### `createTxs`

```ts signature
createTxs(): Promise<never>;
```

The inherited transaction creation. Rejects with `UNSUPPORTED_CAPABILITY`/`TRANSACTIONS`.

### `addListener`

```ts signature
addListener(): Promise<never>;
```

Listeners. Rejects with `UNSUPPORTED_CAPABILITY`/`LISTENERS`.

### `getReserveProofWallet`

```ts signature
getReserveProofWallet(): Promise<never>;
```

Reserve proofs. Rejects with `UNSUPPORTED_CAPABILITY`/`RESERVE_PROOF`.

### `rescanSpent`

```ts signature
rescanSpent(): Promise<never>;
```

Spent-output rescans. Rejects with `UNSUPPORTED_CAPABILITY`/`DAEMON_SETTINGS`.

### `importKeyImages`

```ts signature
importKeyImages(): Promise<never>;
```

Key image import. Rejects with `UNSUPPORTED_CAPABILITY`/`DAEMON_SETTINGS`.
