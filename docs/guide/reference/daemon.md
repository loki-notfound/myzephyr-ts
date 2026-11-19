# ZephyrDaemonRpc

```ts signature
class ZephyrDaemonRpc
```

`ZephyrDaemonRpc` talks to a Zephyr daemon's JSON-RPC interface, read-only. It offers what a wallet needs before
it offers a conversion and what was checked against a Zephyr daemon: the node's information, its height and block
headers with the oracle's pricing record. The names and shapes follow the Java port's `ZephyrDaemonRpc`
(chapter 11 of the Java port's guide), in TypeScript's idiom: frozen plain objects with fields where Java has
getters, `bigint` where Java has `BigInteger`, `number` where Java has `Long` or `Integer`.

Rules that hold for every call:

- It runs in the calling context (a page, a worker of your own, Node.js, Electron's main process); it is never
  proxied to a wallet worker and needs no WebAssembly module.
- It uses the library's transport under the rules of a wallet's daemon access
  ([Connecting to a daemon](../03-connecting-to-a-daemon.md)): requests only to the configured address (allowed
  for this context while a request runs), no credentials, no proxy taken from the environment, no redirect
  followed, each request bounded (30 s, answers up to 1 MiB).
- Every supported call sends exactly one `POST <address>/json_rpc` request; the constructor sends none.
- The node's answers are untrusted: every field is checked for type and range, and an integer that can exceed
  2^53 goes from the JSON text to a `bigint` without passing through a JavaScript `number`.
- Failures reject with a [`ZephyrWalletError`](errors.md): `DAEMON_ERROR` with `DAEMON_UNREACHABLE` (no answer
  in time), `DAEMON_BUSY` (the status BUSY) or `DAEMON_RESPONSE` (an HTTP status other than 200, a redirect, a
  body that is not a JSON-RPC answer, an error member, another status, a field of the wrong type or range). Text
  of the node never reaches an error or a log.

In a browser page the daemon must allow the page's origin (CORS), or the page uses its same-origin proxy, as a
wallet does; the paths the class needs are listed in [docs/DEPLOYMENT.md](../../DEPLOYMENT.md).

## Constructor

### `constructor`

```ts signature
constructor(address: string | {
    readonly uri: string;
});
```

A client of the daemon at `address`: a URL string or `{ uri }`, with the forms and the fixed rejections of a
wallet's daemon address: `INVALID_CONFIG`/`DAEMON_ADDRESS` for a malformed address, `UNSUPPORTED_CAPABILITY`
with `DAEMON_CREDENTIALS`, `DAEMON_PROXY` or `UNTRUSTED_DAEMON` for credentials, a proxy or `trusted: false`.
The constructor contacts no daemon. Java's `new ZephyrDaemonRpc(uri, username, password)` has no counterpart:
the library sends no credentials.

```ts run
import { ZephyrDaemonRpc, ZephyrWalletError } from "@loki-notfound/zephyr-ts";

const daemon = new ZephyrDaemonRpc({ uri: "http://127.0.0.1:17767" }); // contacts nothing
for (const address of ["http://user:secret@127.0.0.1:17767", "not an address"]) {
  try {
    new ZephyrDaemonRpc(address);
  } catch (err) {
    if (!(err instanceof ZephyrWalletError)) throw err;
    console.log(err.code, err.diagnostic); // UNSUPPORTED_CAPABILITY DAEMON_CREDENTIALS, then INVALID_CONFIG DAEMON_ADDRESS
  }
}
try {
  await daemon.getBlockHeaderByHeight(-1);
} catch (err) {
  if (!(err instanceof ZephyrWalletError)) throw err;
  console.log(err.code, err.diagnostic); // INVALID_CONFIG BLOCK_HEIGHT, before any request
}
```

## Methods

### `getInfo`

```ts signature
getInfo(): Promise<ZephyrDaemonInfo>;
```

The node's information (one `get_info` request), the fields a wallet uses
([`ZephyrDaemonInfo`](#zephyrdaemoninfo)). Java: `getInfo()`, a `ZephyrDaemonInfo` with more fields.

### `getHeight`

```ts signature
getHeight(): Promise<number>;
```

The node's height: the number of blocks of its chain (one `get_block_count` request). The top block's height is
one less. Java: `getHeight()`.

### `getLastBlockHeader`

```ts signature
getLastBlockHeader(): Promise<ZephyrBlockHeader>;
```

The header of the node's top block with its pricing record (one `get_last_block_header` request). Java:
`getLastBlockHeader()`.

```ts
import { ZephyrDaemonRpc } from "@loki-notfound/zephyr-ts";

const daemon = new ZephyrDaemonRpc("https://node.example.org");
const record = (await daemon.getLastBlockHeader()).pricingRecord;
if (record !== undefined) console.log(record.reserve); // the price of one ZRS in ZPH, times 10^12
```

### `getBlockHeaderByHeight`

```ts signature
getBlockHeaderByHeight(height: number): Promise<ZephyrBlockHeader>;
```

The header of the block at `height`, a safe integer from 0 (`INVALID_CONFIG`/`BLOCK_HEIGHT` otherwise, before any
request; one `get_block_header_by_height` request). A height the node does not have rejects with
`DAEMON_ERROR`/`DAEMON_RESPONSE`. Java: `getBlockHeaderByHeight(long)`.

### `getBlockHeaderByHash`

```ts signature
getBlockHeaderByHash(blockHash: string): Promise<ZephyrBlockHeader>;
```

The header of the block with this hash, 64 lowercase hexadecimal characters (`INVALID_CONFIG`/`BLOCK_HASH`
otherwise, before any request; one `get_block_header_by_hash` request). A hash the node does not have rejects
with `DAEMON_ERROR`/`DAEMON_RESPONSE`. Java: `getBlockHeaderByHash(String)`.

## Types

### `ZephyrDaemonInfo`

```ts signature
interface ZephyrDaemonInfo {
    readonly version?: string;
    readonly height?: number;
    readonly targetHeight?: number;
    readonly topBlockHash?: string;
    readonly networkType?: 0 | 1 | 2;
    readonly isSynchronized?: boolean;
    readonly isBusySyncing?: boolean;
    readonly isOffline?: boolean;
    readonly isRestricted?: boolean;
    readonly updateAvailable?: boolean;
    readonly adjustedTimestamp?: number;
    readonly target?: number;
    readonly difficulty?: bigint;
    readonly cumulativeDifficulty?: bigint;
    readonly numTxs?: number;
    readonly numTxsPool?: number;
    readonly numAltBlocks?: number;
    readonly blockSizeLimit?: number;
    readonly blockSizeMedian?: number;
    readonly blockWeightLimit?: number;
    readonly blockWeightMedian?: number;
}
```

The fields of the node's `get_info` answer that a wallet uses, with Java's names. A field the answer does not carry
is absent, never zero. `networkType` is 0 (mainnet), 1 (testnet) or 2 (stagenet), as `ZephyrWallet.getNetworkType`
(Java: an enum). `difficulty` and `cumulativeDifficulty` come from the 128-bit `wide_difficulty` and
`wide_cumulative_difficulty`; the cumulative difficulty is above 2^53 on mainnet. `topBlockHash` is absent when the
daemon answers `""`. A restricted daemon (a public node) reports `version` as `""`. Java's fields about the node
itself (free space, database size, start time, peer and connection counts, bootstrap daemon, RPC payment credits)
are not offered: a restricted daemon hides them, and a wallet does not need them.

### `ZephyrBlockHeader`

```ts signature
interface ZephyrBlockHeader {
    readonly hash: string;
    readonly height: number;
    readonly timestamp: number;
    readonly size: number;
    readonly weight: number;
    readonly longTermWeight: number;
    readonly depth: number;
    readonly difficulty: bigint;
    readonly cumulativeDifficulty: bigint;
    readonly majorVersion: number;
    readonly minorVersion: number;
    readonly nonce: number;
    readonly minerTxHash: string;
    readonly numTxs: number;
    readonly orphanStatus: boolean;
    readonly prevHash: string;
    readonly reward: bigint;
    readonly powHash?: string;
    readonly pricingRecord?: ZephyrPricingRecord;
}
```

A block header as the daemon reports it, with Java's names; every field is required except two.
`pricingRecord` is absent for a block without a pricing record: the core's empty record (every value 0 and a zero
signature, as in the blocks before the oracle) or no `pricing_record` member (Java gives the zeros). `powHash` is
absent when the daemon answers `""`, as it does for headers. `reward` is in atomic ZPH.

### `ZephyrPricingRecord`

```ts signature
interface ZephyrPricingRecord {
    readonly spot: bigint;
    readonly movingAverage: bigint;
    readonly stable: bigint;
    readonly stableMa: bigint;
    readonly reserve: bigint;
    readonly reserveMa: bigint;
    readonly reserveRatio: bigint;
    readonly reserveRatioMa: bigint;
    readonly yieldPrice: bigint;
    readonly timestamp: bigint;
    readonly signature: string;
}
```

The oracle prices a block was built with, as the daemon serializes the header's `pricing_record`, with Java's
names. Every price is a `bigint` in the chain's fixed-point units, times 10^12: `spot` and `movingAverage` are the
price of ZPH in USD; `stable` and `stableMa` the rate of ZSD, `reserve` and `reserveMa` the rate of ZRS (each with
its moving average); `reserveRatio` and `reserveRatioMa` the reserve ratio; `yieldPrice` the price of ZYS.
`timestamp` is the oracle's timestamp in seconds, a `bigint` like Java's `BigInteger` and like every other field of
the record (an unsigned 64-bit value of the chain, never rounded); `signature` the oracle's signature, 128
lowercase hexadecimal characters. Guide: [The pricing record](../07-conversions.md#the-pricing-record).

## Not offered

The inherited monero-ts daemon client had about seventy more calls. They are not checked against a Zephyr daemon,
so this class does not offer them: they are not declared, and called anyway (from JavaScript) they reject with
`UNSUPPORTED_CAPABILITY`/`DAEMON_RPC_METHOD` before any request. On an instance: `addListener`, `checkForUpdate`,
`downloadUpdate`, `flushTxPool`, `getAltBlockHashes`, `getAltChains`, `getBlockByHash`, `getBlockByHeight`,
`getBlockHash`, `getBlockHashes`, `getBlockHeadersByRange`, `getBlockTemplate`, `getBlocksByHash`,
`getBlocksByHeight`, `getBlocksByRange`, `getBlocksByRangeChunked`, `getDownloadLimit`, `getFeeEstimate`,
`getHardForkInfo`, `getKeyImageSpentStatus`, `getKeyImageSpentStatuses`, `getKnownPeers`, `getListeners`,
`getMinerTxSum`, `getMiningStatus`, `getOutputDistribution`, `getOutputHistogram`, `getOutputs`, `getPeerBans`,
`getPeers`, `getPollInterval`, `getProcess`, `getRpcConnection`, `getSyncInfo`, `getTx`, `getTxHex`,
`getTxHexes`, `getTxPool`, `getTxPoolHashes`, `getTxPoolStats`, `getTxs`, `getUploadLimit`, `getVersion`,
`isConnected`, `isTrusted`, `pruneBlockchain`, `relayTxByHash`, `relayTxsByHash`, `removeListener`,
`resetDownloadLimit`, `resetUploadLimit`, `setDownloadLimit`, `setIncomingPeerLimit`, `setOutgoingPeerLimit`,
`setPeerBan`, `setPeerBans`, `setUploadLimit`, `startMining`, `stop`, `stopMining`, `stopProcess`, `submitBlock`,
`submitBlocks`, `submitTxHex`, `waitForNextBlockHeader`; on the class: `connectToDaemonRpc`. Java offers them
untested; this library does not.
