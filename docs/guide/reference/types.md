# Types

The types the package exports, all with `export type`: they exist at compile time only. Import them
with `import type { ... } from "@loki-notfound/zephyr-ts"`. Result types describe frozen plain
objects and arrays; amounts are `bigint` in atomic units (10^12 per coin). The error types are in the
[error reference](errors.md#zephyrwalleterrorcode).

## Wallets

### `ZephyrNetworkTypeInput`

```ts signature
type ZephyrNetworkTypeInput = 0 | 1 | 2 | "mainnet" | "testnet" | "stagenet";
```

A network type as a construction or `validateAddress` takes it: `0` mainnet, `1` testnet, `2` stagenet.
`getNetworkType()` returns the number. Guide: [Network types](../02-wallets.md#network-types).

### `ZephyrWalletData`

```ts signature
interface ZephyrWalletData {
    readonly keys: Uint8Array;
    readonly cache: Uint8Array;
}
```

The wallet bytes `getData()` returns and `openWalletData` takes (as `keysData` and `cacheData`): the
keys file and the cache, encrypted with the wallet password. Guide:
[Saving and opening wallet bytes](../02-wallets.md#saving-and-opening-wallet-bytes).

### `ZephyrWalletConstructionOptions`

```ts signature
interface ZephyrWalletConstructionOptions {
    readonly signal?: AbortSignal;
}
```

The second argument of a construction function. `signal` cancels that construction only: in worker
mode an abort ends its worker and rejects with `NATIVE_ERROR`/`CONSTRUCTION_ABORTED`; in direct mode
only an already aborted signal is honored. The signal is detached once the wallet is returned. Guide:
[Cancelling a construction](../02-wallets.md#cancelling-a-construction).

### `ZephyrDaemonConnection`

```ts signature
interface ZephyrDaemonConnection {
    readonly uri: string;
    readonly trusted: true;
}
```

What `getDaemonConnection()` returns: the normalized address without credentials, and `trusted`, always
`true` because the core treats every daemon as trusted. Guide:
[Every daemon is trusted](../03-connecting-to-a-daemon.md#every-daemon-is-trusted).

### `ZephyrWalletSyncResult`

```ts signature
interface ZephyrWalletSyncResult {
    readonly numBlocksFetched: number;
    readonly receivedMoney: boolean;
}
```

The result of `sync()`: the number of blocks fetched and whether the wallet received money in them.
Guide: [Synchronizing](../03-connecting-to-a-daemon.md#synchronizing).

## Construction configurations

One configuration type per construction function. Each lists exactly the fields the function's run-time
validation accepts, with the types it accepts; the validation stays the authority and rejects everything
else with the same fixed errors whatever the declared type (see [Functions](functions.md#constructing-wallets)).
Value domains and rules between fields are checked at run time only: the seed's word count, the key
format, the lookahead limit and pair, the daemon address, which keys a keys restore needs. Not declared,
although the validation accepts them, are values that have no effect: `path: ""`, `isTrustedDaemon: true`
(every daemon is trusted), `regtest`, `isMultisig` and `saveCurrent` `false`, in the object form of
`server` `trusted: true` and empty `username`, `password`, `proxyUri` or `proxy`, and `server: ""` for a
keys-only wallet. A field whose value is
`undefined` counts as absent at run time. The repository checks each type against its validation with
one table of accepted and rejected object literals (`consumers/node/configCases.ts`).

### `ZephyrRandomWalletConfig`

```ts signature
interface ZephyrRandomWalletConfig {
        readonly networkType: ZephyrNetworkTypeInput;
        readonly password?: string;
        readonly language?: string;
        readonly accountLookahead?: number;
    readonly subaddressLookahead?: number;
        readonly proxyToWorker?: boolean;
        readonly server?: string | {
        readonly uri: string;
    };
}
```

The configuration of `createRandomWallet`. `server` is a daemon address (`""` means none) or an object
with the address in `uri`. Guide: [Creating a random wallet](../02-wallets.md#creating-a-random-wallet).

### `ZephyrSeedWalletConfig`

```ts signature
interface ZephyrSeedWalletConfig {
        readonly networkType: ZephyrNetworkTypeInput;
        readonly password?: string;
        readonly seed: string;
        readonly seedOffset?: string;
        readonly restoreHeight?: number;
        readonly accountLookahead?: number;
    readonly subaddressLookahead?: number;
        readonly proxyToWorker?: boolean;
        readonly server?: string | {
        readonly uri: string;
    };
}
```

The configuration of `restoreWalletFromSeed`: `seed` is required (12, 13, 24 or 25 words). Guide:
[Restoring from a seed](../02-wallets.md#restoring-from-a-seed).

### `ZephyrKeysWalletConfig`

```ts signature
interface ZephyrKeysWalletConfig {
        readonly networkType: ZephyrNetworkTypeInput;
        readonly password?: string;
        readonly primaryAddress?: string;
        readonly privateViewKey?: string;
        readonly privateSpendKey?: string;
        readonly restoreHeight?: number;
        readonly language?: string;
        readonly accountLookahead?: number;
    readonly subaddressLookahead?: number;
        readonly proxyToWorker?: boolean;
        readonly server?: string | {
        readonly uri: string;
    };
}
```

The configuration of `restoreWalletFromKeys`. Every key field is optional in the type; at run time at
least one is required, a private view key needs `primaryAddress`, and an address with a view key and
no spend key restores a view-only wallet. Guide: [Restoring from keys](../02-wallets.md#restoring-from-keys).

### `ZephyrKeysOnlyWalletConfig`

```ts signature
type ZephyrKeysOnlyWalletConfig = {
    readonly networkType: ZephyrNetworkTypeInput;
    readonly password?: string;
        readonly language?: string;
    readonly proxyToWorker?: boolean;
    readonly seed?: undefined;
    readonly seedOffset?: undefined;
    readonly primaryAddress?: undefined;
    readonly privateViewKey?: undefined;
    readonly privateSpendKey?: undefined;
} | {
    readonly networkType: ZephyrNetworkTypeInput;
    readonly password?: string;
        readonly seed: string;
    readonly seedOffset?: string;
    readonly proxyToWorker?: boolean;
    readonly language?: undefined;
    readonly primaryAddress?: undefined;
    readonly privateViewKey?: undefined;
    readonly privateSpendKey?: undefined;
} | {
    readonly networkType: ZephyrNetworkTypeInput;
    readonly password?: string;
    readonly primaryAddress?: string;
    readonly privateViewKey?: string;
    readonly privateSpendKey?: string;
        readonly language?: string;
    readonly proxyToWorker?: boolean;
    readonly seed?: undefined;
    readonly seedOffset?: undefined;
};
```

The configuration of `createKeysWallet`: one of three forms, chosen by the fields present: random (no
recovery field; `language` allowed), from a `seed` (with an optional `seedOffset`; no `language`), or
from keys. A field marked `?: undefined` belongs to another form. A keys-only wallet takes no restore
height, lookahead or daemon. Guide: [Keys-only wallets](../02-wallets.md#keys-only-wallets).

### `ZephyrOpenWalletConfig`

```ts signature
interface ZephyrOpenWalletConfig {
        readonly networkType: ZephyrNetworkTypeInput;
        readonly password?: string;
        readonly keysData: Uint8Array;
    readonly cacheData?: Uint8Array;
        readonly proxyToWorker?: boolean;
        readonly server?: string | {
        readonly uri: string;
    };
}
```

The configuration of `openWalletData`: the bytes `getData()` returned (`keysData` required and not
empty) and the password they were saved with; no lookahead, the bytes carry their own. Guide:
[Saving and opening wallet bytes](../02-wallets.md#saving-and-opening-wallet-bytes).

## Balances, accounts and subaddresses

### `ZephyrAssetBalances`

```ts signature
type ZephyrAssetBalances = ReadonlyMap<string, bigint>;
```

A balance by asset name. `getBalance()` gives the core's keys with zeros included (eight assets for a
new wallet); the maps of accounts and subaddresses hold only assets with outputs there. Guide:
[Balances](../04-assets-and-balances.md#balances).

### `ZephyrAccountBalances`

```ts signature
type ZephyrAccountBalances = ReadonlyMap<number, ZephyrAssetBalances>;
```

An account's balances by subaddress index, as `getBalance(accountIdx)` returns them; only subaddresses
the core reports are present. Guide: [Balances](../04-assets-and-balances.md#balances).

### `ZephyrAccount`

```ts signature
interface ZephyrAccount {
    readonly index: number;
    readonly primaryAddress: string;
    readonly label: string;
    readonly subaddressCount: number;
    readonly balance: ZephyrAssetBalances;
    readonly unlockedBalance: ZephyrAssetBalances;
    readonly subaddresses?: ReadonlyArray<ZephyrSubaddress>;
}
```

One account of a full wallet. `primaryAddress` is the address of its subaddress 0 and `label` that
subaddress's label (`"Primary account"` for account 0 of a new wallet, `""` when none was set).
`subaddressCount` is at least 1. `balance` and `unlockedBalance` sum over its subaddresses by asset.
`subaddresses` is present only when requested with `includeSubaddresses`. Guide:
[Accounts and subaddresses](../04-assets-and-balances.md#accounts-and-subaddresses).

### `ZephyrSubaddress`

```ts signature
interface ZephyrSubaddress {
    readonly accountIndex: number;
    readonly index: number;
    readonly address: string;
    readonly label: string;
    readonly balance: ZephyrAssetBalances;
    readonly unlockedBalance: ZephyrAssetBalances;
    readonly isUsed: boolean;
    readonly numUnspentOutputs: number;
}
```

One subaddress. `label` is `""` when none was set; `isUsed` tells whether the wallet has received any
output there; `numUnspentOutputs` counts its unspent outputs as the core counts them. Labels are
untrusted display text. Guide:
[Labels are untrusted display text](../04-assets-and-balances.md#labels-are-untrusted-display-text).

### `ZephyrAddressIndex`

```ts signature
interface ZephyrAddressIndex {
    readonly accountIndex: number;
    readonly subaddressIndex: number;
}
```

Where an address of the wallet belongs, as `getAddressIndex` returns it.

### `ZephyrAccountOptions`

```ts signature
interface ZephyrAccountOptions {
    readonly includeSubaddresses?: boolean;
}
```

Options of `getAccounts` and `getAccount`. Other fields reject with `INVALID_CONFIG`/`UNKNOWN_FIELD`.

## History

### `ZephyrWalletTx`

```ts signature
interface ZephyrWalletTx {
    readonly hash: string;
    readonly height?: number;
    readonly timestamp?: number;
    readonly confirmations: number;
    readonly isConfirmed: boolean;
    readonly inPool: boolean;
    readonly isFailed: boolean;
    readonly isLocked: boolean;
    readonly isMinerTx: boolean;
    readonly fee?: bigint;
    readonly feeAsset?: string;
    readonly unlockTime: bigint;
    readonly incomingTransfers: ReadonlyArray<ZephyrWalletTransfer>;
    readonly outgoingTransfer?: ZephyrWalletTransfer;
    readonly conversion?: ZephyrTxConversion;
}
```

One transaction of the wallet with all of its transfers. `height` and `timestamp` (seconds) are absent
while unconfirmed; `fee` is absent when the core reports none; `feeAsset` is the outgoing transfer's
asset and absent without one; `conversion` is present when the outgoing asset differs from its
destinations' asset. Guide: [Transactions](../05-history.md#transactions).

### `ZephyrWalletTransfer`

```ts signature
interface ZephyrWalletTransfer {
    readonly direction: ZephyrTransferDirection;
    readonly asset?: string;
    readonly amount: bigint;
    readonly accountIndex: number;
    readonly subaddressIndex?: number;
    readonly subaddressIndices?: ReadonlyArray<number>;
    readonly destinations?: ReadonlyArray<ZephyrTransferDestination>;
    readonly txHash: string;
    readonly height?: number;
    readonly confirmations: number;
}
```

An incoming transfer to one subaddress (`subaddressIndex`) or the outgoing transfer of a transaction
(`subaddressIndices` spent from, `destinations` as stored). `asset` is absent when the core reports
none. Guide: [Transfers](../05-history.md#transfers).

### `ZephyrTransferDestination`

```ts signature
interface ZephyrTransferDestination {
    readonly address?: string;
    readonly amount: bigint;
    readonly asset?: string;
}
```

One destination of an outgoing transfer as the sending wallet stored it. `address` is absent when the
stored text does not have the form of an address, and is untrusted text otherwise; `amount` is in the
destination asset. Guide: [Transfers](../05-history.md#transfers).

### `ZephyrTxConversion`

```ts signature
interface ZephyrTxConversion {
    readonly sourceAsset: string;
    readonly destinationAsset: string;
    readonly sourceAmount: bigint;
    readonly destinationAmount: bigint;
}
```

The conversion of a transaction: `sourceAmount` is the outgoing transfer's amount as the core computes
it, `destinationAmount` the sum of the destinations' amounts in the destination asset. Guide:
[Conversions in the history](../05-history.md#conversions-in-the-history).

### `ZephyrHistoryQuery`

```ts signature
interface ZephyrHistoryQuery {
    readonly asset?: string;
    readonly accountIndex?: number;
    readonly subaddressIndex?: number;
    readonly direction?: ZephyrTransferDirection;
    readonly status?: ZephyrHistoryStatus;
    readonly minHeight?: number;
    readonly maxHeight?: number;
    readonly hashes?: ReadonlyArray<string>;
}
```

The query of `getTxs` and `getTransfers`; every field is optional and unknown fields reject. Guide:
[The query](../05-history.md#the-query).

### `ZephyrTransferDirection`

```ts signature
type ZephyrTransferDirection = "incoming" | "outgoing";
```

The direction of a transfer, and the `direction` filter of a query.

### `ZephyrHistoryStatus`

```ts signature
type ZephyrHistoryStatus = "confirmed" | "pool" | "failed";
```

The `status` filter of a query: confirmed transactions; own outgoing transactions in the pool and the
incoming ones the last `refreshPool` saw; failed transactions. Guide:
[Own pending and failed transactions](../05-history.md#own-pending-and-failed-transactions).

## The reserve

### `ZephyrReserveInfo`

```ts signature
interface ZephyrReserveInfo {
    readonly zephReserve: bigint;
    readonly numStables: bigint;
    readonly numReserves: bigint;
    readonly assets: bigint;
    readonly assetsMa: bigint;
    readonly liabilities: bigint;
    readonly equity: bigint;
    readonly equityMa: bigint;
    readonly reserveRatio: string;
    readonly reserveRatioMa: string;
    readonly hfVersion: number;
    readonly zyieldCirc: bigint;
    readonly zyieldRsv: bigint;
}
```

The result of `getReserveInfo`, with the field names of the Java port's `ZephyrReserveInfo`. Amounts in
atomic units, exactly (the core computes them as unsigned 128-bit integers, so they can exceed 2^64); the two
ratios as the shortest decimal text, without exponent, that reads back as exactly the core's `double` (Java:
`BigDecimal`); `hfVersion` the daemon's hard fork version. `assetsMa` and `equityMa` are 0 on the current hard
fork. Units and warnings: [The reserve and the pricing record](../07-conversions.md#the-reserve-and-the-pricing-record).

## Listeners

### `ZephyrWalletListener`

```ts signature
interface ZephyrWalletListener {
    onSyncProgress?(height: number, startHeight: number, endHeight: number, percentDone: number, message: string): void;
    onNewBlock?(height: number): void;
    onBalancesChanged?(balance: bigint, unlockedBalance: bigint, assetType: string): void;
    onOutputReceived?(output: ZephyrWalletOutput): void;
    onOutputSpent?(output: ZephyrWalletOutput): void;
    onSyncError?(error: ZephyrWalletError): void;
}
```

The listener of `addListener` and `sync(listener)`, with the callbacks of the Java port's `ZephyrWalletListener` and
`onSyncError`; each optional. `onSyncProgress` and `onNewBlock` once per scanned block (`percentDone` from 0 to 1, `message`
always `"Synchronizing"`), `onBalancesChanged` once per asset whose balance changed (the wallet's totals), the output callbacks
for an output in the pool, at confirmation and at unlock (repeated: count each transaction once), `onSyncError` for a failed
background iteration or a notification the library could not read. Callbacks never run inside the core; whatever they throw or
reject is dropped unread. Guide: [Syncing and listeners](../03-connecting-to-a-daemon.md#synchronizing).

### `ZephyrWalletOutput`

```ts signature
interface ZephyrWalletOutput {
    readonly amount: bigint;
    readonly accountIndex?: number;
    readonly subaddressIndex?: number;
    readonly txHash: string;
    readonly height?: number;
    readonly assetType?: string;
}
```

The output of `onOutputReceived` and `onOutputSpent`, a frozen plain object. A field the core does not report is absent: the
asset of a pool output and of the outputs notified at unlock, the height of a pool output, the subaddress of a spent summary
taken from several subaddresses.

## Building and relaying

### `ZephyrTxPriority`

```ts signature
type ZephyrTxPriority = "default" | "unimportant" | "normal" | "elevated";
```

The fee priority: the core's own choice, then the first, second and third tier of the daemon's fee
estimate. Guide: [Fees and priorities](../06-sending.md#fees-and-priorities).

### `ZephyrTransferDestinationInput`

```ts signature
interface ZephyrTransferDestinationInput {
    readonly address: string;
    readonly amount: bigint;
}
```

One destination of a transfer: an address of the wallet's network and an amount above zero.

### `ZephyrTransferConfig`

```ts signature
interface ZephyrTransferConfig {
    readonly asset: string;
    readonly destinationAsset?: string;
    readonly destinations: ReadonlyArray<ZephyrTransferDestinationInput>;
    readonly accountIndex: number;
    readonly subaddressIndices?: ReadonlyArray<number>;
    readonly priority?: ZephyrTxPriority;
}
```

The configuration of `buildTransfer` and `prepareTransfer`: a V2 `asset`, 1 to 15 `destinations`, the
account to spend from, optionally the subaddresses to spend from and the priority. Guide:
[The configuration](../06-sending.md#the-configuration).

### `ZephyrBuiltTx`

```ts signature
interface ZephyrBuiltTx {
    readonly hash: string;
    readonly sourceAsset: string;
    readonly destinationAsset: string;
    readonly destinations?: ReadonlyArray<{
        readonly address: string;
        readonly amount: bigint;
    }>;
    readonly amount: bigint;
    readonly fee: bigint;
    readonly feeAsset: string;
    readonly totalDebited: bigint;
    readonly change: bigint;
    readonly ringSize: number;
    readonly inputs: number;
    readonly outputs: number;
    readonly weight: number;
    readonly unlockTime: bigint;
}
```

One built transaction as the core built it. `destinations` is present only when the build needed one
transaction; `totalDebited` is `amount` plus `fee`, in the source asset; `outputs` includes the change.
Guide: [Building to inspect](../06-sending.md#building-to-inspect).

### `ZephyrTransferBuild`

```ts signature
interface ZephyrTransferBuild {
    readonly txs: ReadonlyArray<ZephyrBuiltTx>;
    readonly multipleTxs: boolean;
}
```

The result of `buildTransfer`: the built transactions and whether more than one was needed.

### `ZephyrConversionDestinationInput`

```ts signature
interface ZephyrConversionDestinationInput {
    readonly address: string;
    readonly amount: bigint;
}
```

The destination of a conversion: an address and the amount converted, in atomic units of the source
asset, a multiple of 10^8 (at most four decimals).

### `ZephyrConversionConfig`

```ts signature
interface ZephyrConversionConfig {
    readonly sourceAsset: string;
    readonly destinationAsset: string;
    readonly destination: ZephyrConversionDestinationInput;
    readonly accountIndex: number;
    readonly subaddressIndices?: ReadonlyArray<number>;
    readonly priority?: ZephyrTxPriority;
}
```

The configuration of `buildConversion` and `prepareConversion`: one of the six pairs and exactly one
destination. Guide: [The configuration](../07-conversions.md#the-configuration).

### `ZephyrConversionBuild`

```ts signature
interface ZephyrConversionBuild {
    readonly hash: string;
    readonly sourceAsset: string;
    readonly destinationAsset: string;
    readonly destination: {
        readonly address: string;
        readonly amount: bigint;
    };
    readonly amountBurnt: bigint;
    readonly amountMinted: bigint;
    readonly fee: bigint;
    readonly feeAsset: string;
    readonly totalDebited: bigint;
    readonly change: bigint;
    readonly ringSize: number;
    readonly inputs: number;
    readonly outputs: number;
    readonly weight: number;
    readonly unlockTime: bigint;
    readonly pricingRecordHeight: number;
}
```

The one transaction of a conversion: `amountBurnt` in the source asset and `amountMinted` in the
destination asset, as the transaction states them; `totalDebited` is `amountBurnt` plus `fee`;
`outputs` is four; `pricingRecordHeight` names the block whose pricing record sets the rate. The
library computes no rate. Guide:
[What a conversion build describes](../07-conversions.md#what-a-conversion-build-describes).

### `ZephyrPreparedTransfer`

```ts signature
interface ZephyrPreparedTransfer {
    readonly token: string;
    readonly build: ZephyrTransferBuild;
}
```

The result of `prepareTransfer`: the token of the kept build (32 lowercase hexadecimal characters, not
a secret) and its description. Guide: [Preparing and relaying](../06-sending.md#preparing-and-relaying).

### `ZephyrPreparedConversion`

```ts signature
interface ZephyrPreparedConversion {
    readonly token: string;
    readonly build: ZephyrConversionBuild;
}
```

The result of `prepareConversion`. Guide: [Relaying a conversion](../07-conversions.md#relaying-a-conversion).

### `ZephyrRelayOutcome`

```ts signature
type ZephyrRelayOutcome = "accepted" | "rejected" | "unknown" | "notSent";
```

What happened to one kept transaction in a relay call: accepted by the daemon (now or by an earlier
call with the same token), rejected by it, unknown (sent, no usable answer: it may have reached the
network), or not sent (not attempted, refused before sending, or not processed by a busy daemon).

### `ZephyrRelayedTx`

```ts signature
interface ZephyrRelayedTx {
    readonly hash: string;
    readonly outcome: ZephyrRelayOutcome;
    readonly notRelayed: boolean;
    readonly code?: ZephyrWalletErrorCode;
    readonly diagnostic?: ZephyrWalletErrorDiagnostic;
}
```

One entry of a relay result: the hash described at prepare time, the outcome, `notRelayed` (accepted,
but the daemon kept it without relaying it), and on a failed entry, also an accepted one whose record
failed in the wallet, its `code` and `diagnostic`.

### `ZephyrRelayResult`

```ts signature
interface ZephyrRelayResult {
    readonly txs: ReadonlyArray<ZephyrRelayedTx>;
    readonly complete: boolean;
}
```

The result of `relayPrepared`: one entry per kept transaction in the build's order; `complete` when
every one was accepted. Guide: [Outcomes of a relay](../06-sending.md#outcomes-of-a-relay).
