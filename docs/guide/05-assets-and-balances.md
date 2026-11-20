# 5. Assets, accounts and balances

A Zephyr wallet holds several assets at once, so every balance is a balance per asset. This chapter
names the assets, shows how amounts are represented, explains the balance shapes and covers
accounts, subaddresses and labels.

## The assets

Since the V2 hard fork the network has four assets:

| Asset | What it is |
|---|---|
| `ZPH` | the base coin |
| `ZSD` | the stable asset |
| `ZRS` | the reserve asset |
| `ZYS` | the yield asset |

Before that fork the same assets had other names: `ZEPH`, `ZEPHUSD`, `ZEPHRSV` and `ZYIELD` (the V1
names). They still appear as entries of a wallet's balance and in the history of wallets that
received funds before the fork. The chain no longer accepts V1 names for new outputs, and a transfer
in a V1 asset rejects with `INVALID_CONFIG`/`TX_ASSET`. A user interface shows the four V2 assets.

In the API an asset is always a string, the core's own name. Historical names pass through
unchanged, and an asset the core does not report stays absent; it never becomes a default.

## Amounts in atomic units

Every amount is a `bigint` in atomic units: 10^12 atomic units are one coin, for every asset. Amounts
you pass in, such as transfer amounts, must be `bigint` too; a `number` is rejected. Conversions take
amounts with at most four decimals ([chapter 8](08-conversions.md#the-configuration)).

## Formatting and parsing amounts

Never convert amounts through `number`: a `number` cannot hold every value of 12 decimals exactly.
Two small helpers, with `bigint` arithmetic only:

```ts run
const ATOMIC_PER_COIN = 10n ** 12n;

/** "1.500000000000 ZPH" from 1500000000000n: all twelve decimals, as a send review needs. */
export function formatAmount(atomic: bigint, asset: string): string {
  const sign = atomic < 0n ? "-" : "";
  const abs = atomic < 0n ? -atomic : atomic;
  const fraction = (abs % ATOMIC_PER_COIN).toString().padStart(12, "0");
  return `${sign}${abs / ATOMIC_PER_COIN}.${fraction} ${asset}`;
}

/** 1500000000000n from "1.5"; throws on anything but digits with at most twelve decimals. */
export function parseAmount(text: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,12}))?$/.exec(text.trim());
  if (match === null) throw new Error("Enter an amount with at most 12 decimals, for example 1.5");
  return BigInt(match[1]) * ATOMIC_PER_COIN + BigInt((match[2] ?? "").padEnd(12, "0"));
}

console.log(formatAmount(parseAmount("1.5"), "ZPH"));     // 1.500000000000 ZPH
console.log(formatAmount(307400000n, "ZSD"));              // 0.000307400000 ZSD
console.log(parseAmount("0.0001") === 100000000n);         // true
```

Show every digit of an amount and a fee before the user confirms a transaction. In an overview a
shorter form is fine, as long as a fee or a small balance is never rounded to zero.

## Balances

A full wallet has three balance shapes, and `getUnlockedBalance` has the same three:

```ts
import type { ZephyrAccountBalances, ZephyrAssetBalances } from "@loki-notfound/zephyr-ts";

const all: ZephyrAssetBalances = await wallet.getBalance();              // the wallet, by asset
const byAddress: ZephyrAccountBalances = await wallet.getBalance(0);     // account 0, by subaddress index
const zsd: bigint = await wallet.getBalance("ZSD", 0);                   // one asset, one account
const zsdAtOne: bigint = await wallet.getBalance("ZSD", 0, 1);           // one asset, one subaddress
const spendable: bigint = await wallet.getUnlockedBalance("ZSD", 0);
console.log(all.get("ZPH"), byAddress.get(0)?.get("ZSD"), zsd, zsdAtOne, spendable);
```

- **`getBalance()`** returns a `ReadonlyMap<string, bigint>` with exactly the core's keys, zero
  entries included. A new wallet lists eight assets, the four V2 and the four V1 names, all `0n`.
  Filter by the V2 names for display.
- **`getBalance(accountIndex)`** returns a `ReadonlyMap<number, ReadonlyMap<string, bigint>>` keyed by
  subaddress index. It lists only the subaddresses and assets the core reports; for an account
  without funds the map is empty.
- **`getBalance(asset, accountIndex, subaddressIndex?)`** returns one `bigint` for one of the core's
  assets.

The balance calls read the wallet's local state and send no request; call them after a `sync()`.
An asset name that is not upper-case letters and digits rejects with `INVALID_CONFIG`/`ASSET_TYPE`.
An account or subaddress the wallet does not have rejects with `INVALID_CONFIG` and
`ACCOUNT_NOT_FOUND` or `SUBADDRESS_NOT_FOUND`. The two-number form of monero-ts,
`getBalance(accountIndex, subaddressIndex)` without an asset, rejects with
`UNSUPPORTED_CAPABILITY`/`BALANCE`. Keys-only wallets reject every balance call with
`UNSUPPORTED_CAPABILITY`/`KEYS_ONLY_DAEMON`.

```ts run
import { createRandomWallet } from "@loki-notfound/zephyr-ts";

const V2_ASSETS = ["ZPH", "ZSD", "ZRS", "ZYS"];
const wallet = await createRandomWallet({ networkType: "mainnet", password: "a long passphrase" });
const balances = await wallet.getBalance();
console.log("assets reported:", [...balances.keys()].join(" "));
for (const asset of V2_ASSETS) console.log(asset, balances.get(asset) ?? 0n);
console.log("account 0 by subaddress:", (await wallet.getBalance(0)).size);
await wallet.close();
```

## Unlocked balance

The **balance** counts everything the wallet owns, including funds that are not yet spendable. The
**unlocked balance** counts what can be spent now: received outputs and change unlock after the
confirmations the core requires. A transaction can spend only unlocked funds, and a build checks the
unlocked balance of the asset first ([chapter 7](07-sending.md#what-a-build-checks-and-asks)).

While a sent transaction is pending, the source account's balance falls by the debited total and
its unlocked balance by the spent inputs; the change counts in the balance and unlocks later.
[Chapter 7](07-sending.md#after-acceptance-save-the-wallet) describes the balances after a relay.

Balances other than zero were verified with a funded test wallet on mainnet, at ten confirmations.
How a locked balance appears in the maps is not verified on real data
([chapter 12](12-known-limitations.md)).

## Accounts and subaddresses

A wallet has accounts, and each account has subaddresses. Account 0 always exists; its subaddress 0
is the wallet's primary address. Each subaddress has its own address, so you can give every payer
or purpose its own address and still spend from the account.

```ts run
import { createRandomWallet, ZephyrWalletError } from "@loki-notfound/zephyr-ts";

const wallet = await createRandomWallet({ networkType: "mainnet", password: "a long passphrase" });
const account = await wallet.createAccount("Savings");                // index 1
const sub = await wallet.createSubaddress(account.index, "Shop");     // index 1 of account 1
await wallet.setSubaddressLabel(account.index, sub.index, "Online shop");

const accounts = await wallet.getAccounts({ includeSubaddresses: true });
for (const a of accounts) {
  console.log(a.index, a.label, a.subaddressCount, a.subaddresses?.map((s) => s.label));
}
const where = await wallet.getAddressIndex(sub.address);
console.log("address index:", where.accountIndex, where.subaddressIndex);
console.log("same address:", (await wallet.getAddress(1, 1)) === sub.address);

try {
  await wallet.getAccount(7);
} catch (err) {
  if (!(err instanceof ZephyrWalletError)) throw err;
  console.log("no account 7:", err.code, err.diagnostic);
}
await wallet.close();
```

An account (`ZephyrAccount`) carries its `index`, `primaryAddress` (the address of its subaddress 0),
`label` (the label of its subaddress 0; `Primary account` for account 0 of a new wallet),
`subaddressCount`, and the maps `balance` and `unlockedBalance` by asset; with
`{ includeSubaddresses: true }` also its `subaddresses`. A subaddress (`ZephyrSubaddress`) carries
`accountIndex`, `index`, `address`, `label`, `balance` and `unlockedBalance` by asset, `isUsed` and
`numUnspentOutputs`. The maps hold the core's keys only: an asset without outputs there is absent.
Results are frozen plain objects and arrays.

Rules of these calls:

- Indices are integers from 0 to 2^32-1, checked before any native call
  (`INVALID_CONFIG`/`ADDRESS_INDEX_RANGE`).
- Creation is one account or subaddress per call. Save the wallet bytes afterwards.
- A listing returns at most 1,000 accounts and at most 1,000 subaddresses, also counted over all
  accounts of `getAccounts` with subaddresses; a larger one rejects with
  `INVALID_CONFIG`/`LISTING_LIMIT`. Page through an account's subaddresses with
  `getSubaddresses(accountIndex, indices)`, at most 1,000 distinct indices per call, using the
  account's `subaddressCount`.
- `getAddressIndex(address)` returns `{ accountIndex, subaddressIndex }` for an address of the wallet.
  A malformed address, or one of another network, rejects with `INVALID_ADDRESS`/`CORE_INVALID_ADDRESS`;
  an address of another wallet with `INVALID_ADDRESS`/`ADDRESS_NOT_IN_WALLET`. The core also resolves
  subaddresses of its lookahead window that were not created yet; listings show only created ones.
- Account and subaddress calls check every index against the wallet's own listings, so a call with a
  subaddress index takes time proportional to the account's number of subaddresses times the
  wallet's number of outputs.
- Keys-only wallets reject every account call with `UNSUPPORTED_CAPABILITY`/`KEYS_ONLY_ACCOUNTS`.

## Labels are untrusted display text

A label is a string of at most 255 bytes in UTF-8, without control characters (U+0000 to U+001F,
U+007F to U+009F) and without unpaired surrogates (`INVALID_CONFIG`: `LABEL_TYPE`, `LABEL_LENGTH`,
`LABEL_CHARACTERS`); `""` clears a label. Those rules apply to labels you set. Labels read from wallet
bytes made elsewhere are returned as stored, and may contain bidirectional controls (U+202A to
U+202E, U+2066 to U+2069), zero-width characters and characters that look like others or like markup.
The same holds for destination addresses in the history and every other text from wallet bytes or
the chain.

A wallet application should therefore:

- render such text as text, never as markup (set `textContent`, never `innerHTML`);
- isolate its direction, for example with a `bdi` element or Unicode isolates;
- show it apart from the application's own strings, so that a label cannot pass for a button, an
  amount or an address.

```ts
function showLabel(cell: HTMLElement, label: string): void {
  const isolated = document.createElement("bdi");
  isolated.textContent = label === "" ? "(no label)" : label;
  cell.replaceChildren(isolated);
}
```

The library never copies a label into an error or a log line.
