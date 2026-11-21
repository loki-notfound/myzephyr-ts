# 7. Sending

This chapter covers same-asset transfers: building one to inspect it, preparing and relaying it in
two explicit steps, what to show the user, fees and priorities, the life of a kept build, every
outcome of a relay, saving afterwards, and sweeping the unlocked balance of an account. Conversions
follow in [chapter 8](08-conversions.md).

Building and relaying need a full wallet with spend keys and a daemon. Keys-only wallets reject with
`UNSUPPORTED_CAPABILITY`/`KEYS_ONLY_TX`, view-only wallets with `VIEW_ONLY_TX`.

## Two steps

zephyr-ts has no call that builds and sends in one go. Sending is:

1. **Prepare.** `prepareTransfer(config)` builds and signs the transaction inside the WebAssembly
   module, describes it, and keeps it there under an opaque token. Nothing is sent.
2. **Show and confirm.** Your application shows the description and the user confirms exactly that.
3. **Relay.** `relayPrepared(token)` sends exactly the kept transaction, as it was described.

`buildTransfer(config)` builds and describes the same way but discards the result; use it to show a
fee estimate before the user commits. No byte of a built transaction (its hex, key images or
transaction key) ever reaches your JavaScript.

## The configuration

`ZephyrTransferConfig` is a plain object of own data properties; unknown fields reject with
`INVALID_CONFIG`/`UNKNOWN_FIELD`.

| Field | Meaning | Rejections |
|---|---|---|
| `asset` | `"ZPH"`, `"ZSD"`, `"ZRS"` or `"ZYS"` | `ASSET_TYPE`; a V1 name `TX_ASSET` |
| `destinationAsset` | optional; equal to `asset` | another asset: `UNSUPPORTED_CAPABILITY`/`CONVERSION` |
| `destinations` | 1 to 15 `{ address, amount }` | `DESTINATIONS`, `TOO_MANY_DESTINATIONS` |
| `amount` (of each) | `bigint` above zero; each and their sum at most 2^64-1 | `FIELD_TYPE`, `AMOUNT_ZERO`, `AMOUNT_RANGE` |
| `address` (of each) | an address of the wallet's network | `INVALID_ADDRESS`: `CORE_INVALID_ADDRESS`, `ADDRESS_NETWORK`; integrated addresses `UNSUPPORTED_CAPABILITY`/`INTEGRATED_ADDRESS` |
| `accountIndex` | the account to spend from | `ADDRESS_INDEX_RANGE`, `ACCOUNT_NOT_FOUND` |
| `subaddressIndices` | optional; spend only from these subaddresses of the account | `SUBADDRESS_INDICES`, `SUBADDRESS_NOT_FOUND` |
| `priority` | optional; `"default"`, `"unimportant"`, `"normal"` or `"elevated"` | `TX_PRIORITY` |

Rejections without another code are `INVALID_CONFIG`. Payment identifiers, an unlock time and
"subtract the fee from a destination" are not supported. Sending everything has its own calls
([Sweeping](#sweeping)).

## Building to inspect

```ts
const destination = await wallet.getAddress(1, 0); // the wallet's own second account
const build = await wallet.buildTransfer({
  asset: "ZSD",
  destinations: [{ address: destination, amount: 100000000000n }], // 0.1 ZSD
  accountIndex: 0
});
const tx = build.txs[0];
console.log(tx.hash, tx.fee, tx.feeAsset, tx.totalDebited, tx.change, tx.ringSize, tx.weight);
```

The result (`ZephyrTransferBuild`) is `{ txs, multipleTxs }`. Nearly always the core builds one
transaction; it splits a transfer only when it must, and then `multipleTxs` is `true` and the
transactions carry no `destinations`. Each `ZephyrBuiltTx` carries `hash`, `sourceAsset` and
`destinationAsset` (read from the built transaction), `destinations` (when one transaction was
built), `amount`, `fee`, `feeAsset` (the source asset), `totalDebited` (amount and fee), `change`,
`ringSize`, `inputs`, `outputs` (change included), `weight` and `unlockTime`.

Two builds of the same transfer differ in `hash` and by a few bytes in `weight`, with `fee` and
`change` following it, because the ring members are chosen anew each time. Nothing persists after a
build: balances, history and wallet bytes are unchanged, and the next build works the same.

The validation runs offline, before anything is dispatched:

```ts run
import { createRandomWallet, ZephyrWalletError } from "@loki-notfound/zephyr-ts";
import type { ZephyrTransferConfig } from "@loki-notfound/zephyr-ts";

const wallet = await createRandomWallet({ networkType: "mainnet", password: "a long passphrase" });
const address = await wallet.getAddress(0, 1);

async function tryBuild(label: string, config: unknown): Promise<void> {
  try {
    await wallet.buildTransfer(config as ZephyrTransferConfig);
    throw new Error(label + ": built");
  } catch (err) {
    if (!(err instanceof ZephyrWalletError)) throw err;
    console.log(label, err.code, err.diagnostic);
  }
}
await tryBuild("zero amount:", { asset: "ZPH", destinations: [{ address, amount: 0n }], accountIndex: 0 });
await tryBuild("number amount:", { asset: "ZPH", destinations: [{ address, amount: 1 }], accountIndex: 0 });
await tryBuild("V1 asset:", { asset: "ZEPH", destinations: [{ address, amount: 1n }], accountIndex: 0 });
await tryBuild("conversion:", { asset: "ZPH", destinationAsset: "ZSD", destinations: [{ address, amount: 1n }], accountIndex: 0 });
await tryBuild("unknown field:", { asset: "ZPH", destinations: [{ address, amount: 1n }], accountIndex: 0, fee: 1n });
// a new wallet has no funds: rejected by the balance check, before any daemon request
await tryBuild("no funds:", { asset: "ZPH", destinations: [{ address, amount: 1n }], accountIndex: 0 });
await wallet.close();
```

## What a build checks and asks

1. Every value is checked; then the wallet's own unlocked balance of the asset in the selected
   account or subaddresses must cover the amounts, or the build rejects with
   `TX_NOT_POSSIBLE`/`NOT_ENOUGH_UNLOCKED` (`NOT_ENOUGH_MONEY` when even the balance with locked
   outputs is short). No request is sent before this point.
2. The core then asks the daemon for heights and fork rules, the fee estimate and the pool's
   backlog, recent block headers, the circulating supply and the pricing record history, the output
   distribution and ring members (`/get_output_distribution.bin`, `/get_outs.bin`). It sends no key
   image and no address. The node learns that the wallet builds a transaction and in which asset.
3. The core builds and signs. Its own failures reject with `TX_NOT_POSSIBLE`: `NOT_ENOUGH_UNLOCKED`,
   `NOT_ENOUGH_MONEY`, `NOT_ENOUGH_FOR_FEE` (the fee is not covered), `NOT_ENOUGH_OUTS_TO_MIX` (too few
   ring members), `TX_TOO_LARGE`. Daemon failures reject with `DAEMON_ERROR`. Any other failure is
   `NATIVE_ERROR`/`TX_BUILD_FAILED`.

The core's own "not enough" failures, too few ring members and an oversized transaction are tested
with injected failures, not on real data.

## Preparing and relaying

```ts
const prepared = await wallet.prepareTransfer({
  asset: "ZPH",
  destinations: [{ address: "ZEPHs0000EXAMPLE0000PLACEHOLDER", amount: 100000000000n }],
  accountIndex: 0,
  priority: "unimportant"
});
// show prepared.build to the user; on confirmation:
const result = await wallet.relayPrepared(prepared.token);
const saved = await wallet.getData(); // keep the wallet's record of the transaction
console.log(result.complete, result.txs[0].hash, saved.keys.length);
```

`prepareTransfer` and `prepareConversion` take the configurations of `buildTransfer` and
`buildConversion`, run the same checks and requests and return the same description, together with a
`token` of 32 lowercase hexadecimal characters: `{ token, build }`. The token is not a secret and
carries no information.

`relayPrepared(token)` sends one `POST /sendrawtransaction` per kept transaction to the wallet's
configured daemon. Before the request the module checks that the kept transaction hashes to the
described hash (`NATIVE_ERROR`/`RELAY_HASH_MISMATCH` otherwise, and the token is void), and the
transport passes the request only after checking the hash of the transaction it carries. The request
reveals the transaction (what the chain will show) and that this client sent it. Every other submit
or relay request stays refused by the transport.

`discardPrepared(token)` voids a kept build and returns `true`, or `false` when the token named
nothing.

## What to show before relaying

The description is what will be relayed and charged. Before calling `relayPrepared`, show:

- each destination address and amount, with the asset;
- the fee with its asset (the source asset), with all twelve decimals;
- the total debited (`totalDebited`: amount and fee);
- for a conversion, the burnt and minted amounts ([chapter 8](08-conversions.md)).

Then relay only after the user confirmed exactly that, for example with a button that names the
action and the amount, such as `Send 0.100000000000 ZPH`. If the user changes anything, prepare
again; the newer prepare voids the older token.

## Fees and priorities

The fee is the core's, in the source asset: the transaction's weight times a per-byte fee from the
daemon's fee estimate, rounded up to the estimate's quantization. For a same-asset transfer the core
does not convert it, so the fee has the same number of atomic units in every asset for the same
weight. Fees vary with the daemon's estimate and with the transaction's weight.

The priority chooses the tier of the daemon's fee estimate:

| `priority` | Tier |
|---|---|
| `"unimportant"` | the first (lowest) tier |
| `"normal"` | the second tier |
| `"elevated"` | the third tier |
| `"default"` or absent | the core chooses |

With `"default"` the core takes the first tier, or the second tier when the pool holds a backlog at
the first tier's fee or the last ten blocks fill more than 80 % of the full reward zone; when those
reads fail, the first tier. A wallet whose keys file turns the automatic low priority off or stores
a default priority gets the first tier. So `"default"` is not always the cheapest tier: in the nine
transactions relayed on mainnet on 2026-11-15 it took the second tier once. A wallet that wants the
cheapest tier passes `"unimportant"`. Whatever the priority, the prepared description states the fee
that will be charged.

Observed on mainnet with one input and two outputs at the default priority: 200,000 atomic units per
byte of weight, about 0.000307 to 0.000309 in each of ZPH, ZSD, ZRS and ZYS; at the second tier
790,000 per byte, 0.00121581 ZYS for a transfer of the same shape. These are observations, not
constants.

## The life of a kept build

A wallet holds one kept build at a time. It is voided (wiped and released inside the module):

- after it was relayed completely, or after the daemon refused it;
- after `discardPrepared`, `close`, a password change, or a newer prepare (also one that fails);
- after a sync after which the wallet's height differs from the height at the build by more than
  10 blocks;
- for a conversion, when its pricing record has aged ([chapter 8](08-conversions.md#the-pricing-record-and-its-age));
- after three relay calls.

A forced stop ends the worker that holds it, and it is never part of the wallet bytes. It survives
`setDaemonConnection`: `relayPrepared` sends it to the daemon configured when it is called, not to the
daemon the build read from. A kept build holds the transaction and its secret transaction key in the
module's memory until it is relayed or voided; anything that can call the wallet can relay its token.

A void or unknown token rejects with `INVALID_CONFIG`/`RELAY_TOKEN_VOID` before any request; a value
that is not a token with `INVALID_CONFIG`/`RELAY_TOKEN`.

```ts run
import { createRandomWallet, ZephyrWalletError } from "@loki-notfound/zephyr-ts";

const wallet = await createRandomWallet({ networkType: "mainnet", password: "a long passphrase" });
for (const token of ["not a token", "0".repeat(32)]) {
  try {
    await wallet.relayPrepared(token);
  } catch (err) {
    if (!(err instanceof ZephyrWalletError)) throw err;
    console.log("relay:", err.code, err.diagnostic);
  }
}
console.log("discard of an unknown token:", await wallet.discardPrepared("0".repeat(32)));
await wallet.close();
```

## Outcomes of a relay

`relayPrepared` resolves when at least one transaction was accepted in that call. For one transaction
(conversions always, transfers nearly always) resolving means accepted. The result
(`ZephyrRelayResult`) lists per kept transaction its described `hash`, its `outcome` (`"accepted"`,
`"rejected"`, `"unknown"`, `"notSent"`), `notRelayed` (accepted, but the daemon kept it without
relaying it) and, on the entry that failed, `code` and `diagnostic`; `complete` is `true` when every
transaction was accepted.

When nothing was accepted, it rejects. What each rejection means and what the wallet does next:

| Rejection | What happened | The token | What to do |
|---|---|---|---|
| `TX_REJECTED` with `LOW_RING_SIZE`, `DOUBLE_SPEND`, `INVALID_INPUT`, `INVALID_OUTPUT`, `TOO_BIG`, `OVERSPEND`, `FEE_TOO_LOW`, `TOO_FEW_OUTPUTS`, `TX_EXTRA_TOO_BIG`, `SANITY_CHECK_FAILED`, `NOT_RELAYED` or `REJECTED` | the daemon refused it (the first reason of its reply) | void | tell the user it was refused; sync, then prepare again (after a double spend the outputs may be spent elsewhere) |
| `DAEMON_ERROR`/`DAEMON_BUSY` | the daemon did not process it | kept | relay again later, or discard it |
| `DAEMON_ERROR`/`DAEMON_UNREACHABLE` | the connection was refused; nothing was sent | kept | relay again later, or discard it |
| `RELAY_UNKNOWN` with `NO_ANSWER`, `HTTP_STATUS` or `ANSWER_UNREADABLE` | the request was sent and no usable answer came: the transaction may have reached the network | kept | never report it as not sent; relay the same token again (a daemon that already has it answers that it kept it, and the wallet records it), or discard it, call `refreshPool()` and sync before building again |
| `NATIVE_ERROR`/`RELAY_REQUEST` | the transport refused the submit request; nothing was sent | void | prepare again |
| `NATIVE_ERROR`/`RELAY_FAILED` | the core's commit failed before any request; nothing was sent | void | prepare again |
| `NATIVE_ERROR`/`RELAY_HASH_MISMATCH` | the kept transaction is not the described one; nothing was sent | void | prepare again |
| `TX_NOT_POSSIBLE`/`PRICING_RECORD_AGE` | a conversion's pricing record has aged; nothing was sent | void | prepare again |
| `INVALID_CONFIG`/`RELAY_TOKEN_VOID` | the token names no kept build | void | prepare again |

An HTTP error is reported as an unknown outcome, not as a refusal, because a proxy in front of the
daemon may have forwarded the request. After an unknown outcome, building again without a sync would
select the same outputs, because the wallet has not recorded the transaction.

If the daemon accepted the transaction but the core could not record it, the accepted entry carries
`NATIVE_ERROR`/`RELAY_RECORD_FAILED`: the daemon has it; sync.

```ts
import { ZephyrWalletError } from "@loki-notfound/zephyr-ts";
import type { ZephyrRelayResult } from "@loki-notfound/zephyr-ts";

type SendOutcome = "sent" | "refused" | "retry" | "unknown" | "prepare again";

async function relayConfirmed(token: string): Promise<SendOutcome> {
  let result: ZephyrRelayResult;
  try {
    result = await wallet.relayPrepared(token);
  } catch (err) {
    if (!(err instanceof ZephyrWalletError)) throw err;
    if (err.code === "TX_REJECTED") return "refused";
    if (err.code === "RELAY_UNKNOWN") return "unknown";
    if (err.code === "DAEMON_ERROR" && (err.diagnostic === "DAEMON_BUSY" || err.diagnostic === "DAEMON_UNREACHABLE")) return "retry";
    return "prepare again";
  }
  await saveWalletBytes(await wallet.getData()); // the record lives in the cache until saved
  if (!result.complete) console.log("not every transaction was accepted:", result.txs.map((t) => t.outcome));
  return "sent";
}

declare function saveWalletBytes(data: { keys: Uint8Array; cache: Uint8Array }): Promise<void>;
```

## After acceptance: save the wallet

After acceptance the core records the transaction as the wallet's own: an unconfirmed outgoing
transaction in the history, its transaction key, and the spent outputs. The source account's balance
falls by the debited total (amount and fee; the change counts while pending) and its unlocked balance
by the spent inputs. While it is pending the core counts an amount sent to an address of the same
account back into that account's balance.

This record lives in the wallet's cache. Save the wallet bytes (`getData`) right after
`relayPrepared` resolves. Bytes saved before reopen without the record, with the outputs unspent,
until a sync sees the transaction in a block; a build from them would spend the same outputs again.

## Sweeping

`buildSweepUnlocked` and `prepareSweepUnlocked` send everything unlocked of one asset in one account (or
in chosen subaddresses of it) to one address, in the same asset: to empty an account, to move funds to
another wallet, or to leave no small remainder behind. The name is the Java port's `sweepUnlocked`; as
for transfers there are two explicit steps instead of its relay flag:

```ts
const prepared = await wallet.prepareSweepUnlocked({
  asset: "ZRS",
  address: await wallet.getAddress(1, 0), // the wallet's own second account
  accountIndex: 0                          // always required
});
const sweep = prepared.build;
console.log(sweep.txs.length, sweep.totalAmount, sweep.totalFee); // show these; on confirmation:
const result = await wallet.relayPrepared(prepared.token);
console.log(result.complete, (await wallet.getData()).keys.length); // save the wallet bytes afterwards
```

`ZephyrSweepUnlockedConfig` takes the fields of a transfer, with one `address` instead of
`destinations` and no amount; any other field (an amount, destinations, a key image, a relay flag,
`sweepEachSubaddress`, a threshold) rejects with `INVALID_CONFIG`/`UNKNOWN_FIELD`.

| Field | Meaning | Rejections |
|---|---|---|
| `asset` | `"ZPH"`, `"ZSD"`, `"ZRS"` or `"ZYS"` | `ASSET_TYPE`; a V1 name `TX_ASSET` |
| `destinationAsset` | optional; equal to `asset` | another asset (a converting sweep): `UNSUPPORTED_CAPABILITY`/`CONVERSION` |
| `address` | the one destination, an address of the wallet's network | `INVALID_ADDRESS`: `ADDRESS_TYPE`, `CORE_INVALID_ADDRESS`, `ADDRESS_NETWORK`; integrated addresses `UNSUPPORTED_CAPABILITY`/`INTEGRATED_ADDRESS` |
| `accountIndex` | required: the account to sweep | `ADDRESS_INDEX_RANGE` (also when it is missing), `ACCOUNT_NOT_FOUND` |
| `subaddressIndices` | optional; sweep only these subaddresses of the account | `SUBADDRESS_INDICES`, `SUBADDRESS_NOT_FOUND` |
| `priority` | optional, as for a transfer | `TX_PRIORITY` |

**The account index is required.** The Java port's `sweepUnlocked` without an account index sweeps every
account that has an unlocked balance of the asset, one sweep per account; this library always names one
account and rejects a configuration without one. With an account index and no subaddress list the core
sweeps every subaddress of the account that has an unlocked balance of the asset. With
`subaddressIndices` it sweeps the outputs of exactly those subaddresses; a listed subaddress without
funds adds nothing.

**What is swept.** Every unlocked output of the asset in the selected subaddresses, except outputs worth
less than the fee of spending them, which the core leaves where they are; locked outputs stay too. The
description (`ZephyrSweepBuild`) lists the transactions as `buildTransfer` describes them, each with its
one destination (the address and that transaction's amount) and no change, and the totals
`totalAmount` (what the address receives) and `totalFee`, both in the asset. Their sum is the unlocked
balance of the swept outputs. The core puts as many outputs into one transaction as fit and builds
another when they do not; `multipleTxs` is then `true`, `relayPrepared` relays the transactions in order
and reports each one, and `complete` is `true` only when every one was accepted
([Outcomes of a relay](#outcomes-of-a-relay)). A sweep is kept, voided and relayed exactly as a
transfer ([The life of a kept build](#the-life-of-a-kept-build)).

**Refusals.** Before any request: `TX_NOT_POSSIBLE`/`NOT_ENOUGH_MONEY` when the balance of the asset
in the selected outputs is zero, `NOT_ENOUGH_UNLOCKED` when nothing of it is unlocked. From the core:
`NOT_ENOUGH_UNLOCKED` also when every unlocked output is worth less than its fee, `NOT_ENOUGH_FOR_FEE`
when the swept outputs cannot pay their own fee, and the build failures of a transfer
(`NOT_ENOUGH_OUTS_TO_MIX`, `TX_TOO_LARGE`, `DAEMON_ERROR`, `NATIVE_ERROR`/`TX_BUILD_FAILED`).

```ts run
import { createRandomWallet, ZephyrWalletError } from "@loki-notfound/zephyr-ts";
import type { ZephyrSweepUnlockedConfig } from "@loki-notfound/zephyr-ts";

const wallet = await createRandomWallet({ networkType: "mainnet", password: "a long passphrase" });
const address = await wallet.getAddress(0, 1);

async function trySweep(label: string, config: unknown): Promise<void> {
  try {
    await wallet.buildSweepUnlocked(config as ZephyrSweepUnlockedConfig);
    throw new Error(label + ": built");
  } catch (err) {
    if (!(err instanceof ZephyrWalletError)) throw err;
    console.log(label, err.code, err.diagnostic);
  }
}
await trySweep("no account index:", { asset: "ZPH", address });
await trySweep("an amount:", { asset: "ZPH", address, accountIndex: 0, amount: 1n });
await trySweep("converting:", { asset: "ZPH", destinationAsset: "ZRS", address, accountIndex: 0 });
// a new wallet has no funds: rejected by the balance check, before any daemon request
await trySweep("no funds:", { asset: "ZPH", address, accountIndex: 0 });
await trySweep("no funds in subaddress 0:", { asset: "ZSD", address, accountIndex: 0, subaddressIndices: [0] });
for (const call of [() => wallet.sweepOutput(), () => wallet.sweepDust()]) {
  await call().catch((err: ZephyrWalletError) => console.log("not offered:", err.code, err.diagnostic));
}
await wallet.close();
```

**Requests.** As for a transfer (read in the core's code): heights and fork rules, the fee estimate and
the pool's backlog, recent block headers, the circulating supply and the pricing record history (read for
every transaction the core constructs), the output distribution and the ring members. The node learns
that the wallet builds a transaction and in which asset, and, when it is relayed, what the chain shows.

**Listeners.** When a prepared sweep is relayed, the core notifies the added listeners as for a relayed
transfer (read in the core's code): `onBalancesChanged` for the asset, with the wallet's new balances,
and `onOutputSpent` once per relayed transaction with its amount plus its fee, the asset and the swept
account ([chapter 4](04-syncing-and-listeners.md)).

**Not offered.** A converting sweep (a `destinationAsset` other than `asset`): the core would convert
everything in one transaction and add what lies below the fourth decimal to the fee; it rejects with
`UNSUPPORTED_CAPABILITY`/`CONVERSION`. Convert with `buildConversion` and an amount rounded down to
four decimals ([chapter 8](08-conversions.md)). `sweepOutput` and `sweepDust` reject with
`UNSUPPORTED_CAPABILITY`/`TRANSACTIONS`: the core's `sweepOutput` validates with the V1 asset `ZEPH`
(as the Java port found) and needs a key image, which this library does not expose; `sweepDust` spends
only outputs without RingCT, and every output on Zephyr's chain has RingCT, so it would find nothing
(what it would build, in `ZEPH` with a ring size of one, the chain refuses).

**What is proven.** Sweeps are checked offline (every rejection, a wallet without funds, the kept build
shared with transfers and conversions, nothing left in the module after a refused or discarded sweep).
A sweep has not been relayed on mainnet ([chapter 12](12-known-limitations.md)).

## What is proven

Proven on mainnet on 2026-11-15 with a funded test wallet (a wallet in the Node.js main thread, the
default priority, 0.1 or 0.05 of the source asset, only the wallet's own addresses, one transaction at
a time): one transfer per V2 asset and a transfer with two destinations were accepted by the daemon,
mined, and after ten confirmations equal to their descriptions (the fee charged, the change, the
balances and unlocked balances per asset).

Not proven: a refusal by a daemon on real data, a transfer the core splits, relay from a browser or
from a wallet in a worker (`proxyToWorker`), and platforms other than Node.js on Linux x86_64. The
refusal and failure paths are proven against a local sink that answers as the daemon does. See
[chapter 12](12-known-limitations.md).
