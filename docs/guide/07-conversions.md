# 7. Conversions

A conversion turns an amount of one V2 asset into another at the rate the chain's pricing record
sets. This chapter covers the six pairs, the configuration, the reserve ratio, what a conversion
build describes, the age of its pricing record, fees, relaying and pending balances.

Conversions use the same steps as transfers ([chapter 6](06-sending.md)): `buildConversion` to
inspect, `prepareConversion` and `relayPrepared` to send. Everything there about kept builds, relay
outcomes and saving applies here too.

## The six pairs

| Source | Destination | Gated by the reserve ratio |
|---|---|---|
| `ZPH` | `ZSD` | yes: the ratio must be at least 4.0 after the conversion |
| `ZSD` | `ZPH` | not by the ratio; it needs only assets in the reserve |
| `ZPH` | `ZRS` | yes: the ratio must be below 8.0 (or fewer than 100 ZSD in circulation) |
| `ZRS` | `ZPH` | yes: the ratio must be at least 4.0 after the conversion |
| `ZSD` | `ZYS` | no |
| `ZYS` | `ZSD` | no |

These are the rules of the pinned core, applied to the spot and the moving-average ratio. Any other
combination, the same asset included, rejects with `INVALID_CONFIG`/`CONVERSION_PAIR`.

## The configuration

`ZephyrConversionConfig` is a plain object of own data properties; unknown fields reject with
`INVALID_CONFIG`/`UNKNOWN_FIELD`.

| Field | Meaning | Rejections |
|---|---|---|
| `sourceAsset`, `destinationAsset` | one of the six pairs | `CONVERSION_PAIR`; `ASSET_TYPE` and `TX_ASSET` as for a transfer |
| `destination` | exactly one `{ address, amount }`, not an array | `CONVERSION_DESTINATIONS` |
| `amount` | what is converted, in atomic units of the source asset, a `bigint` above zero and at most 2^64-1, with at most four decimals: a multiple of 10^8 | `AMOUNT_PRECISION`, `AMOUNT_ZERO`, `AMOUNT_RANGE` |
| `address` | as for a transfer | as for a transfer |
| `accountIndex`, `subaddressIndices`, `priority` | as for a transfer | as for a transfer |

The core never splits a conversion. A conversion that would need more than one transaction rejects
with `TX_NOT_POSSIBLE`/`CONVERSION_SPLIT`.

```ts run
import { createRandomWallet, ZephyrWalletError } from "@loki-notfound/zephyr-ts";
import type { ZephyrConversionConfig } from "@loki-notfound/zephyr-ts";

const wallet = await createRandomWallet({ networkType: "mainnet", password: "a long passphrase" });
const address = await wallet.getPrimaryAddress();

async function tryConversion(label: string, config: unknown): Promise<void> {
  try {
    await wallet.buildConversion(config as ZephyrConversionConfig);
    throw new Error(label + ": built");
  } catch (err) {
    if (!(err instanceof ZephyrWalletError)) throw err;
    console.log(label, err.code, err.diagnostic);
  }
}
const amount = 100000000000n; // 0.1, a multiple of 10^8
await tryConversion("five decimals:", { sourceAsset: "ZPH", destinationAsset: "ZRS", destination: { address, amount: amount + 10000000n }, accountIndex: 0 });
await tryConversion("not a pair:", { sourceAsset: "ZPH", destinationAsset: "ZYS", destination: { address, amount }, accountIndex: 0 });
await tryConversion("an array:", { sourceAsset: "ZSD", destinationAsset: "ZYS", destination: [{ address, amount }], accountIndex: 0 });
await tryConversion("no funds:", { sourceAsset: "ZSD", destinationAsset: "ZYS", destination: { address, amount }, accountIndex: 0 });
await wallet.close();
```

## The reserve ratio

The core decides at build time whether a gated pair is possible. It reads the pricing record of the
wallet's top block (`getblockheaderbyheight`), the circulating supply and the pricing record history,
and refuses a pair the reserve ratio does not allow with `TX_NOT_POSSIBLE`/`RESERVE_RATIO`. The ratio
and every other part of the core's message stay inside the module; the library does not report the
ratio. A refused conversion sends the reads up to the refusal and no ring member request.

With the ratio near 1.66 on 2026-11-13 and near 1.75 on 2026-11-15, ZPH to ZSD and ZRS to ZPH were
refused; ZPH to ZRS, ZSD to ZPH, ZSD to ZYS and ZYS to ZSD built. A user interface should expect a
pair to be refused and say so plainly, for example: "Converting ZPH to ZSD is not possible at the
current reserve ratio."

Other failures of a conversion build: `TX_NOT_POSSIBLE`/`PRICING_RECORD` (no usable pricing record,
also when it could not be read) and `TX_NOT_POSSIBLE`/`CONVERSION_AMOUNT` (the converted amount would
be zero); the build's own failures as for a transfer; any other `NATIVE_ERROR`/`TX_BUILD_FAILED`. A
refusal leaves nothing in the module.

## What a conversion build describes

```ts
import type { ZephyrConversionBuild } from "@loki-notfound/zephyr-ts";

const primary = await wallet.getPrimaryAddress();
const c: ZephyrConversionBuild = await wallet.buildConversion({
  sourceAsset: "ZPH",
  destinationAsset: "ZRS",
  destination: { address: primary, amount: 100000000000n }, // 0.1 ZPH
  accountIndex: 0
});
console.log(c.amountBurnt, c.amountMinted, c.fee, c.feeAsset, c.totalDebited, c.pricingRecordHeight);
```

The result (`ZephyrConversionBuild`) carries:

- `hash`, `sourceAsset` and `destinationAsset`, read from the built transaction;
- `destination`, the caller's;
- `amountBurnt`: what the transaction takes in the source asset (equal to the destination's amount);
- `amountMinted`: what the destination output carries in the destination asset;
- `fee` and `feeAsset` (the source asset), and `totalDebited` (`amountBurnt` and `fee`);
- `change`, `ringSize`, `inputs`, `weight`, `unlockTime`;
- `outputs`: four, the destination, the change and two outputs of zero amount the core adds to every
  conversion, one in each asset;
- `pricingRecordHeight`: the block whose pricing record sets the rate.

**The library computes no rate and reports none.** The amounts are the built transaction's own
fields. The core's formula uses, from the named pricing record, the side of the spot and
moving-average price that gives the converter less, minus a conversion fee of 0.1 % (ZSD and ZYS
pairs) or 1 % (ZRS pairs); the yield pairs use the chain's own ZYS price. On mainnet on 2026-11-13 the
minted amount equalled that formula exactly for every pair that built. If you show a rate, derive it
from `amountMinted` and `amountBurnt` of the build, and say that it is the rate of this transaction.

## The pricing record and its age

The rate is fixed by the pricing record the transaction names. The chain accepts that record only
while it is at most 10 blocks old when the transaction is mined, and checks the reserve ratio again
against the block that includes it. So:

- relay a prepared conversion soon after the user confirms it;
- when the wallet's own height shows that the record has aged, `relayPrepared` rejects with
  `TX_NOT_POSSIBLE`/`PRICING_RECORD_AGE` before any request, and the token is void: prepare again and
  show the new amounts;
- a conversion relayed in time can still be rejected by the chain if its record ages before it is
  mined, or if the ratio no longer allows it at the including block.

A conversion whose pricing record aged before inclusion is not proven on real data.

## Fees of a conversion

Fees are paid in the source asset. The core computes the fee in ZPH as for a transfer and, for a
source asset other than ZPH, converts it with the pricing record the conversion names: with the ZSD
moving average into ZSD, with the ZRS moving average into ZRS, and into ZYS first with the ZSD moving
average and then with the ZYS price. A conversion from ZPH pays the ZPH fee unconverted.

Charged on mainnet on 2026-11-15: 0.000052645533 ZSD (ZSD to ZPH), 0.0005942 ZPH (ZPH to ZRS, two
inputs), 0.000052846797 ZSD (ZSD to ZYS), 0.000034350652 ZYS (ZYS to ZSD).

## Relaying a conversion

```ts
const prepared = await wallet.prepareConversion({
  sourceAsset: "ZSD",
  destinationAsset: "ZYS",
  destination: { address: await wallet.getPrimaryAddress(), amount: 100000000000n },
  accountIndex: 0,
  priority: "unimportant"
});
const b = prepared.build;
console.log(`convert ${b.amountBurnt} ${b.sourceAsset} to ${b.amountMinted} ${b.destinationAsset}, fee ${b.fee} ${b.feeAsset}`);
// after the user confirmed exactly these amounts:
await wallet.relayPrepared(prepared.token);
await wallet.getData(); // then store the bytes
```

Show the burnt amount, the minted amount, the fee with its asset and the total debited, all with
twelve decimals, before relaying. A conversion is always one transaction, so `relayPrepared` resolves
only when it was accepted.

## Balances while a conversion is pending

While a conversion is pending, the source account's balance falls by the debited total. For a conversion to an address of the same account, the core
counts the amount back into the account's source-asset balance while it is pending, so that balance
falls only by the fee until the transaction is confirmed. After confirmation the source asset has
fallen by the burnt amount and the fee, and the minted amount is received in the destination asset.
The mainnet test of 2026-11-15 confirmed these final balances.

## What is proven

Relayed on mainnet on 2026-11-15: ZSD to ZPH, ZPH to ZRS, ZSD to ZYS and ZYS to ZSD, each mined one or
two blocks after the block of its pricing record, with the fee charged and the minted amount received
as described. Not proven: ZPH to ZSD and ZRS to ZPH (refused by the ratio), and a conversion whose
pricing record aged before inclusion. See [chapter 11](11-known-limitations.md).
