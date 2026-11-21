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

## What the getters return

Tested offline for every kind of wallet (check `C40` of the repository's lifecycle suite, in Node.js and
in a browser, directly and in workers). Only `getSeed`, `getSeedLanguage`, `getPrivateSpendKey` and
`getDaemonConnection` can resolve to `undefined`, and their declarations say so. Kinds: full wallets
created at random, restored from a seed, from keys with a spend key, from a spend key alone, opened from
bytes; view-only wallets (an address and a view key, full, opened from bytes, or keys-only); keys-only
wallets of each form.

| Getter | Full wallet | View-only full wallet | Keys-only wallet | View-only keys-only wallet |
|---|---|---|---|---|
| `getPrimaryAddress`, `getAddress` | address | address | address | address |
| `getSeed` | 25 words | `undefined` | 25 words | `undefined` |
| `getSeedLanguage` | language | `undefined` | language | `undefined` |
| `getPrivateViewKey` | key | key | key | key |
| `getPrivateSpendKey` | key | `undefined` | key | `undefined` |
| `getPublicViewKey`, `getPublicSpendKey` | key | key | key | key |
| `isViewOnly` | `false` | `true` | `false` | `true` |
| `getNetworkType` | number | number | rejects `KEYS_ONLY_NETWORK_TYPE` | rejects `KEYS_ONLY_NETWORK_TYPE` |
| `getRestoreHeight` | number | number | rejects `KEYS_ONLY_RESTORE_HEIGHT` | rejects `KEYS_ONLY_RESTORE_HEIGHT` |
| `getData` | bytes | bytes | rejects `KEYS_ONLY_DATA` | rejects `KEYS_ONLY_DATA` |
| `getHeight`, `getBalance`, `getUnlockedBalance`, `isConnectedToDaemon` | value | value | rejects `KEYS_ONLY_DAEMON` | rejects `KEYS_ONLY_DAEMON` |
| `getDaemonHeight`, `isDaemonSynced`, `getReserveInfo`, `getCirculatingSupply` without a daemon | rejects `DAEMON_NOT_CONNECTED` | rejects `DAEMON_NOT_CONNECTED` | rejects `KEYS_ONLY_DAEMON` | rejects `KEYS_ONLY_DAEMON` |
| `getDaemonConnection` without a daemon | `undefined` | `undefined` | `undefined` | `undefined` |
| `getAccounts`, `getAccount`, `getSubaddresses`, `getSubaddress` | value | value | rejects `KEYS_ONLY_ACCOUNTS` | rejects `KEYS_ONLY_ACCOUNTS` |
| `getTxs`, `getTransfers` | value | value | rejects `KEYS_ONLY_HISTORY` | rejects `KEYS_ONLY_HISTORY` |
| `isClosed` | `false` until closed | `false` until closed | `false` until closed | `false` until closed |

A key is 64 hexadecimal characters; every rejection in the table is `UNSUPPORTED_CAPABILITY` with the
named diagnostic, except `DAEMON_ERROR`/`DAEMON_NOT_CONNECTED`.

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
[Accounts and subaddresses](../05-assets-and-balances.md#accounts-and-subaddresses).

### `getAddressIndex`

```ts signature
getAddressIndex(address: string): Promise<ZephyrAddressIndex>;
```

The account and subaddress an address of this wallet belongs to; also subaddresses of the lookahead
window that were not created yet.

Rejects with: `INVALID_ADDRESS`/`ADDRESS_TYPE` (not a string, empty or longer than 256),
`INVALID_ADDRESS`/`CORE_INVALID_ADDRESS` (malformed or another network),
`INVALID_ADDRESS`/`ADDRESS_NOT_IN_WALLET`, `UNSUPPORTED_CAPABILITY`/`KEYS_ONLY_ACCOUNTS`. Guide:
[Accounts and subaddresses](../05-assets-and-balances.md#accounts-and-subaddresses).

### `getNetworkType`

```ts signature
getNetworkType(): Promise<number>;
```

`0` (mainnet), `1` (testnet) or `2` (stagenet).

Rejects with: `UNSUPPORTED_CAPABILITY`/`KEYS_ONLY_NETWORK_TYPE`. Guide:
[Network types](../02-wallets.md#network-types).

### `getSeed`

```ts signature
getSeed(): Promise<string | undefined>;
```

The 25-word seed. Full and keys-only wallets; `undefined` for a view-only wallet, which has no seed.
Guide:
[Creating a random wallet](../02-wallets.md#creating-a-random-wallet).

### `getSeedLanguage`

```ts signature
getSeedLanguage(): Promise<string | undefined>;
```

The language of the seed, for example `"English"`. Full and keys-only wallets; `undefined` for a
view-only wallet.

### `getPrivateViewKey`

```ts signature
getPrivateViewKey(): Promise<string>;
```

The private view key, 64 hexadecimal characters. Full and keys-only wallets. Guide:
[Restoring from keys](../02-wallets.md#restoring-from-keys).

### `getPrivateSpendKey`

```ts signature
getPrivateSpendKey(): Promise<string | undefined>;
```

The private spend key, 64 hexadecimal characters. Full and keys-only wallets; `undefined` for a
view-only wallet, which has none. Guide:
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
    }): Promise<void>;
```

Sets the daemon, or clears it with `undefined`: an address, or an object with the address in `uri`, as
the construction configurations declare `server`. Resolves when the core holds the address; an
unreachable daemon is not an error here. A kept build survives it. At run time the object form still
accepts `trusted: true` without effect; the type does not declare it.

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
nothing. Guide: [Syncing](../04-syncing-and-listeners.md#syncing).

### `getReserveInfo`

```ts signature
getReserveInfo(): Promise<ZephyrReserveInfo>;
```

The state of the Zephyr reserve as the core computes it ([`ZephyrReserveInfo`](types.md#zephyrreserveinfo)): from
the daemon's circulating supply, the pricing record of the block below the daemon's height and the pricing
record history. Requests: `get_info` (cached by the core for 30 s), `hard_fork_info`, `getblockheaderbyheight`,
`get_circulating_supply` and `get_pricing_record_history`. When the core cannot read a usable pricing record of
that block it computes nothing, and this rejects with `DAEMON_ERROR`/`PRICING_RECORD_UNAVAILABLE` instead of
returning zeros. Java: `ZephyrWallet.getReserveInfo()`. Guide:
[The reserve and the pricing record](../08-conversions.md#the-reserve-and-the-pricing-record).

### `getCirculatingSupply`

```ts signature
getCirculatingSupply(): Promise<Readonly<Record<string, bigint>>>;
```

The circulating supply per label as the daemon reports it (one `get_circulating_supply` request), in atomic
units, as a frozen object. On mainnet six keys: `ZPH`, `ZSD`, `ZRS`, `ZYS`, and `DJED` (the ZPH held in the
reserve, equal to `zephReserve`) and `YIELD` (the yield reserve, equal to `zyieldRsv`), which are not assets a
wallet can hold. A label that is not an upper-case token, an amount above 2^128 - 1 or a label twice rejects
with `DAEMON_ERROR`/`DAEMON_RESPONSE`. Java: `ZephyrWallet.getCirculatingSupply()` (a `Map`).

### `getHeight`

```ts signature
getHeight(): Promise<number>;
```

The wallet's height; no request. Guide: [Heights](../03-connecting-to-a-daemon.md#heights).

### `sync`

```ts signature
sync(startHeight?: number, listener?: ZephyrWalletListener): Promise<ZephyrWalletSyncResult>;
sync(listener: ZephyrWalletListener): Promise<ZephyrWalletSyncResult>;
```

One synchronization, as the Java port's four forms: `sync()`, `sync(listener)`, `sync(startHeight)` and
`sync(startHeight, listener)`. It starts at `startHeight` or at the core's default start (the larger of the
wallet's height and its restore height); a start below the restore height lowers it. `listener` receives the
notifications of this sync only, after the added listeners (once if it is one of them); it is not registered.
Every notification of the sync is delivered before it resolves. A wallet at the daemon's height gets no progress
call; a daemon that is itself not synchronized makes it resolve with 0 blocks and no notification. Other calls of
the wallet wait for it, close and background iterations included. A kept build is voided if the wallet's height
afterwards differs from the height at the build by more than 10 blocks.

Rejects with: `INVALID_CONFIG`/`SYNC_START_HEIGHT` (not a safe integer from 0), `INVALID_CONFIG`/`LISTENER`
(a second argument that is not a listener), `UNSUPPORTED_CAPABILITY`/`SYNC` (more than two arguments),
`DAEMON_ERROR`, `NATIVE_ERROR`/`SYNC_FAILED`. Guide: [Syncing](../04-syncing-and-listeners.md#syncing).

### `refreshPool`

```ts signature
refreshPool(): Promise<number>;
```

Asks the daemon for its pool and updates the wallet's view of its incoming unconfirmed transfers;
resolves with the number of incoming pool transactions the wallet holds (at most 1,000). Requests
`/get_transaction_pool_hashes.bin` and `/gettransactions`.

Rejects with: `INVALID_CONFIG`/`FIELD_TYPE` (an argument), `INVALID_CONFIG`/`LISTING_LIMIT`,
`DAEMON_ERROR`, `UNSUPPORTED_CAPABILITY`/`KEYS_ONLY_DAEMON`. Guide:
[Incoming transfers in the pool](../06-history.md#incoming-transfers-in-the-pool).

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
[Balances](../05-assets-and-balances.md#balances).

### `getUnlockedBalance`

```ts signature
getUnlockedBalance(): Promise<ZephyrAssetBalances>;
getUnlockedBalance(accountIdx: number): Promise<ZephyrAccountBalances>;
getUnlockedBalance(assetType: string, accountIdx: number, subaddressIdx?: number): Promise<bigint>;
```

The spendable balance, in the same three shapes and with the same rejections as `getBalance`. Guide:
[Unlocked balance](../05-assets-and-balances.md#unlocked-balance).

## Accounts and subaddresses

Full wallets only; keys-only wallets reject with `UNSUPPORTED_CAPABILITY`/`KEYS_ONLY_ACCOUNTS`. Labels
are strings of at most 255 UTF-8 bytes without control characters or unpaired surrogates
(`INVALID_CONFIG`: `LABEL_TYPE`, `LABEL_LENGTH`, `LABEL_CHARACTERS`). Guide:
[Accounts and subaddresses](../05-assets-and-balances.md#accounts-and-subaddresses).

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
request is sent. Guide: [History](../06-history.md).

### `getTxs`

```ts signature
getTxs(query?: ZephyrHistoryQuery): Promise<ReadonlyArray<ZephyrWalletTx>>;
```

The wallet's transactions: confirmed by height then hash, unconfirmed after them. With transfer
filters, the transactions with at least one matching transfer, each with all of its transfers.

Rejects with: `INVALID_CONFIG` and `CONFIG_TYPE`, `UNKNOWN_FIELD`, `FIELD_TYPE`, `ASSET_TYPE`,
`ADDRESS_INDEX_RANGE`, `QUERY_ACCOUNT_REQUIRED`, `HEIGHT_RANGE`, `TX_HASHES`, `TX_HASH`, `TX_NOT_FOUND`,
`LISTING_LIMIT` (more than 1,000 transactions or 2,000 transfers). Guide:
[The query](../06-history.md#the-query).

### `getTransfers`

```ts signature
getTransfers(query?: ZephyrHistoryQuery): Promise<ReadonlyArray<ZephyrWalletTransfer>>;
```

The transfers that match the query; per transaction the outgoing transfer first, then the incoming
ones. Same rejections as `getTxs`. Guide: [Transfers](../06-history.md#transfers).

### `getTx`

```ts signature
getTx(hash: string): Promise<ZephyrWalletTx>;
```

One transaction by its hash.

Rejects with: `INVALID_CONFIG`/`TX_HASH` (not 64 lowercase hexadecimal characters),
`INVALID_CONFIG`/`TX_NOT_FOUND` (also for an incoming pool transaction the last `refreshPool` did not
see). Guide: [The query](../06-history.md#the-query).

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
`NATIVE_ERROR`/`TX_BUILD_FAILED`. Guide: [Building to inspect](../07-sending.md#building-to-inspect).

### `buildConversion`

```ts signature
buildConversion(config: ZephyrConversionConfig): Promise<ZephyrConversionBuild>;
```

Builds the one transaction of a conversion between two V2 assets, describes it and discards it.

Rejects with: the configuration rejections of `buildTransfer` as they apply, `INVALID_CONFIG`/
`CONVERSION_PAIR`, `CONVERSION_DESTINATIONS`, `AMOUNT_PRECISION`; `TX_NOT_POSSIBLE` (`RESERVE_RATIO`,
`PRICING_RECORD`, `CONVERSION_SPLIT`, `CONVERSION_AMOUNT`, and the build failures of `buildTransfer`);
`DAEMON_ERROR`; `NATIVE_ERROR`/`TX_BUILD_FAILED`. Guide:
[What a conversion build describes](../08-conversions.md#what-a-conversion-build-describes).

### `buildSweepUnlocked`

```ts signature
buildSweepUnlocked(config: ZephyrSweepUnlockedConfig): Promise<ZephyrSweepBuild>;
```

Builds the transactions that send everything unlocked of one V2 asset in one account (or in the given
subaddresses of it) to one address in the same asset, describes them with their totals and discards them.
Nothing is relayed or stored. The account index is required.

Rejects with: the configuration rejections of `buildTransfer` as they apply (one `address` instead of
`destinations`); `UNSUPPORTED_CAPABILITY`/`CONVERSION` (a destination asset other than the asset: a converting
sweep); `TX_NOT_POSSIBLE` (`NOT_ENOUGH_MONEY` when the balance of the selected outputs is zero,
`NOT_ENOUGH_UNLOCKED` when nothing of it is unlocked, and the build failures of `buildTransfer`);
`DAEMON_ERROR`; `NATIVE_ERROR`/`TX_BUILD_FAILED`. Guide: [Sweeping](../07-sending.md#sweeping).

### `prepareTransfer`

```ts signature
prepareTransfer(config: ZephyrTransferConfig): Promise<ZephyrPreparedTransfer>;
```

As `buildTransfer`, but keeps the built transactions in the wallet's one slot under a new token; the
previous kept build is voided, also when this prepare fails. Nothing is relayed. Same rejections as
`buildTransfer`. Guide: [Preparing and relaying](../07-sending.md#preparing-and-relaying).

### `prepareConversion`

```ts signature
prepareConversion(config: ZephyrConversionConfig): Promise<ZephyrPreparedConversion>;
```

As `buildConversion`, but keeps the built transaction under a new token. Same rejections as
`buildConversion`. Guide: [Relaying a conversion](../08-conversions.md#relaying-a-conversion).

### `prepareSweepUnlocked`

```ts signature
prepareSweepUnlocked(config: ZephyrSweepUnlockedConfig): Promise<ZephyrPreparedSweep>;
```

As `buildSweepUnlocked`, but keeps the built transactions under a new token for `relayPrepared`; the previous
kept build is voided, also when this prepare fails. Same rejections as `buildSweepUnlocked`. Guide:
[Sweeping](../07-sending.md#sweeping).

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
[Outcomes of a relay](../07-sending.md#outcomes-of-a-relay).

### `discardPrepared`

```ts signature
discardPrepared(token: string): Promise<boolean>;
```

Voids the kept build the token names (wiped and released inside the module); `false` when it named
none.

Rejects with: `INVALID_CONFIG`/`RELAY_TOKEN`. Guide:
[The life of a kept build](../07-sending.md#the-life-of-a-kept-build).

## Listeners and background synchronization

Full wallets, direct and proxied, with the names of the Java port. Keys-only wallets reject with
`UNSUPPORTED_CAPABILITY`/`KEYS_ONLY_DAEMON`, closed ones with `WALLET_CLOSED`. Callbacks never run inside the
core; whatever a callback throws or rejects is dropped unread. The callbacks: `ZephyrWalletListener` in
[Types](types.md#zephyrwalletlistener). Guide: [Syncing and listeners](../04-syncing-and-listeners.md).

### `addListener`

```ts signature
addListener(listener: ZephyrWalletListener): Promise<void>;
```

Registers a listener for every later notification of the wallet (syncs, background iterations, pool refreshes,
relays). A listener already added is kept once. In a proxied wallet resolves after the worker was told.

Rejects with: `INVALID_CONFIG`/`LISTENER` (not an object, or a callback that is not a function).

### `removeListener`

```ts signature
removeListener(listener: ZephyrWalletListener): Promise<void>;
```

Removes an added listener; it gets no notification delivered after this call. With the last listener gone the
wallet stops asking the core for notifications.

Rejects with: `INVALID_CONFIG`/`LISTENER_NOT_REGISTERED` (a listener that is not added).

### `getListeners`

```ts signature
getListeners(): ReadonlyArray<ZephyrWalletListener>;
```

The added listeners, first added first, as a frozen copy; empty after close and for a keys-only wallet. A
per-sync listener is not listed.

### `startSyncing`

```ts signature
startSyncing(periodInMs?: number): Promise<void>;
```

Background synchronization: a sync at once, then one every `periodInMs` (default 10,000) after the previous one
started, each through the wallet's one queue. Called while the loop runs it only sets the period. A failed
iteration is delivered to the listeners' `onSyncError`, and the loop goes on. Resolves once the loop runs. The
loop's timer keeps a Node.js process alive until `stopSyncing` or `close`.

Rejects with: `INVALID_CONFIG`/`SYNC_PERIOD` (not an integer from 1,000 to 86,400,000),
`INVALID_CONFIG`/`FIELD_TYPE` (more than one argument), `DAEMON_ERROR`/`DAEMON_NOT_CONNECTED` (no daemon).

### `stopSyncing`

```ts signature
stopSyncing(): Promise<void>;
```

Stops background synchronization. Resolves when no further iteration will start and the running one, if any, has
finished (it is not ended); resolves at once when no loop runs.

Rejects with: `INVALID_CONFIG`/`FIELD_TYPE` (an argument).

## Payment proofs and transaction keys

Full wallets only; keys-only wallets reject with `UNSUPPORTED_CAPABILITY`/`KEYS_ONLY_PROOF`. The hash is 64 lowercase
hexadecimal characters (`INVALID_CONFIG`/`TX_HASH`); a message is optional, at most 1,024 UTF-8 bytes, without U+0000 or an
unpaired surrogate (`INVALID_CONFIG`/`PROOF_MESSAGE`); an extra argument rejects with `INVALID_CONFIG`/`FIELD_TYPE`. Before
any request the wallet's records decide: `INVALID_CONFIG`/`TX_NOT_FOUND` for a transaction the wallet does not hold,
`INVALID_CONFIG`/`TX_FAILED` for one it holds as failed. Results are strings and never appear in an error; the library makes
proofs and does not check them. Guide: [Proofs and transaction keys](../06-history.md#proofs-and-transaction-keys).

### `getTxKey`

```ts signature
getTxKey(txHash: string): Promise<string>;
```

The secret key of a transaction the wallet sent, with its additional keys if it has them (64 lowercase hexadecimal
characters each), from the wallet's cache. No request. A secret: prefer `getTxProof`.

Rejects with: the common rejections above, `INVALID_CONFIG`/`TX_KEY_UNAVAILABLE` (the wallet holds no key for the
transaction: it did not send it, or it was restored from its seed or from bytes saved before the send).

### `getTxProof`

```ts signature
getTxProof(txHash: string, address: string, message?: string): Promise<string>;
```

A proof that the transaction paid the address: `"OutProofV2..."` for an address of another wallet (made with the
transaction's key), `"InProofV2..."` for an address of this wallet (made with the view key; also for a payment the wallet
sent to itself). One daemon request (`/gettransactions`).

Rejects with: the common rejections above, `INVALID_ADDRESS`/`ADDRESS_TYPE` (not a string of 90 to 140 base58 characters),
`CORE_INVALID_ADDRESS`, `ADDRESS_NETWORK`, `UNSUPPORTED_CAPABILITY`/`INTEGRATED_ADDRESS`, `INVALID_CONFIG`/`ADDRESS_NOT_IN_TX`
(the address received nothing in the transaction), `INVALID_CONFIG`/`TX_KEY_UNAVAILABLE` (an outbound proof without the
transaction's key), `DAEMON_ERROR`, `NATIVE_ERROR`/`PROOF_FAILED`.

### `getSpendProof`

```ts signature
getSpendProof(txHash: string, message?: string): Promise<string>;
```

A proof that the wallet spent in the transaction: `"SpendProofV1..."`, one signature per ring member of each input. Daemon
requests (`/gettransactions`, `/get_outs.bin`).

Rejects with: the common rejections above, `UNSUPPORTED_CAPABILITY`/`VIEW_ONLY_PROOF` (a view-only wallet),
`INVALID_CONFIG`/`TX_NOT_SENT` (the wallet spent nothing in the transaction), `DAEMON_ERROR`, `NATIVE_ERROR`/`PROOF_FAILED`.

## Unsupported inherited calls

These names remain from monero-ts so that a port finds them. Each rejects with
`UNSUPPORTED_CAPABILITY` before any native code runs. Guide:
[What is not ported](../11-coming-from-monero-ts.md#what-is-not-ported).

### `createTxs`

```ts signature
createTxs(): Promise<never>;
```

The inherited transaction creation. Rejects with `UNSUPPORTED_CAPABILITY`/`TRANSACTIONS`.

### `sweepOutput`

```ts signature
sweepOutput(): Promise<never>;
```

Sweeping one output by its key image, as in the Java port. Not offered: the core validates it with the V1 asset
`ZEPH`, and the library exposes no key images. Rejects with `UNSUPPORTED_CAPABILITY`/`TRANSACTIONS`. Guide:
[Sweeping](../07-sending.md#sweeping).

### `sweepDust`

```ts signature
sweepDust(): Promise<never>;
```

Sweeping outputs without RingCT, as in the Java port. Not offered: every output on Zephyr's chain has RingCT, so
the core would find nothing to sweep. Rejects with `UNSUPPORTED_CAPABILITY`/`TRANSACTIONS`. Guide:
[Sweeping](../07-sending.md#sweeping).

### `getReserveProofWallet`

```ts signature
getReserveProofWallet(): Promise<never>;
```

Reserve proofs. Rejects with `UNSUPPORTED_CAPABILITY`/`RESERVE_PROOF`.

### `checkTxKey`

```ts signature
checkTxKey(): Promise<never>;
```

Checking a transaction with its key. Not offered: the core reports a received amount of 0 for every current transaction
(it reads the amount of the V1 asset `ZEPH` only) and a good result whenever the call does not fail. Rejects with
`UNSUPPORTED_CAPABILITY`/`PROOF_CHECK`. Guide: [Proofs and transaction keys](../06-history.md#why-the-library-does-not-check-proofs).

### `checkTxProof`

```ts signature
checkTxProof(): Promise<never>;
```

Checking a transaction proof. Not offered: the core reports a received amount of 0, as for `checkTxKey`. Rejects with
`UNSUPPORTED_CAPABILITY`/`PROOF_CHECK`.

### `checkSpendProof`

```ts signature
checkSpendProof(): Promise<never>;
```

Checking a spend proof. Not offered: proofs are checked by a separate checker. Rejects with
`UNSUPPORTED_CAPABILITY`/`PROOF_CHECK`.

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
