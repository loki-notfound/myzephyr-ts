# 6. History

A full wallet lists its transactions and transfers per asset. This chapter explains what a listing
returns, the query and its filters, paging, incoming transfers in the pool, what a conversion
looks like, and the payment proofs and transaction keys a wallet can give for its transactions.

## Reading the history

`getTxs(query?)`, `getTransfers(query?)` and `getTx(hash)` return what the wallet stored at its last
sync and its last pool refresh. They send no request to the daemon: sync first to see new
transactions, and call `refreshPool()` to see incoming transfers that are still in the pool.
Keys-only wallets reject with `UNSUPPORTED_CAPABILITY`/`KEYS_ONLY_HISTORY`.

```ts
declare function formatAmount(atomic: bigint, asset: string): string; // the helper of chapter 4

await wallet.sync();
for (const transfer of await wallet.getTransfers({ accountIndex: 0 })) {
  const sign = transfer.direction === "incoming" ? "+" : "-";
  const amount = formatAmount(transfer.amount, transfer.asset ?? "(asset not reported)");
  const where = transfer.height === undefined ? "pending" : `height ${transfer.height}`;
  console.log(`${sign}${amount} ${where}, ${transfer.confirmations} confirmations, tx ${transfer.txHash}`);
}
```

Results are frozen plain objects and arrays with `bigint` amounts in atomic units. A value the core
does not report is absent, never zero or a default asset.

## Transactions

A transaction (`ZephyrWalletTx`) carries:

| Field | Meaning |
|---|---|
| `hash` | 64 lowercase hexadecimal characters |
| `height`, `timestamp` | block height and block time in seconds; absent while unconfirmed |
| `confirmations` | at the wallet's height; 0 while unconfirmed |
| `isConfirmed`, `inPool`, `isFailed` | the state; see "Own pending and failed transactions" below |
| `isLocked` | whether the core considers it locked at the wallet's height |
| `isMinerTx` | a coinbase transaction |
| `fee` | the core's fee, paid by the sender; absent when the core reports none |
| `feeAsset` | the asset of the outgoing transfer (fees are paid in the source asset); absent without one |
| `unlockTime` | as stored: a height, or a timestamp at or above 500,000,000 |
| `incomingTransfers` | in account, then subaddress order |
| `outgoingTransfer` | the wallet's outgoing transfer, if it sent the transaction |
| `conversion` | present when the outgoing asset differs from its destinations' asset |

`getTxs` returns confirmed transactions by height, then hash, and the unconfirmed ones (own pending
and failed) after them. With transfer filters it returns the transactions with at least one matching
transfer, each with all of its transfers.

## Transfers

A transfer (`ZephyrWalletTransfer`) is an incoming transfer to one subaddress or the outgoing transfer
of a transaction. It carries `direction` (`"incoming"` or `"outgoing"`), `asset`, `amount`,
`accountIndex`, `txHash`, `height` and `confirmations`; an incoming transfer also `subaddressIndex`, an
outgoing one `subaddressIndices` (the subaddresses whose outputs were spent) and `destinations`.
`getTransfers` returns per transaction the outgoing transfer first, then the incoming ones.

A destination (`ZephyrTransferDestination`) is what the sending wallet stored: `amount` in the
destination asset, `asset` when the core reports one, and `address` only if the stored text has the
form of an address. That text is untrusted display text
([chapter 5](05-assets-and-balances.md#labels-are-untrusted-display-text)).

An amount sent to an address of the sending account in the source asset is not listed as an
incoming transfer: the core counts it with the account's change, and it stays in the account's
balance. An amount received at the sending account in another asset, such as a conversion's minted
amount, is listed as incoming.

Not returned: transaction notes, payment identifiers, outputs and key images. Transaction keys and
proofs have their own calls ([Proofs and transaction keys](#proofs-and-transaction-keys)).

## The query

The query (`ZephyrHistoryQuery`) has optional fields only:

| Field | Filters |
|---|---|
| `asset` | transfers in this asset |
| `accountIndex` | transfers of this account |
| `subaddressIndex` | with `accountIndex`: incoming transfers received at it and outgoing transfers that spent from it |
| `direction` | `"incoming"` or `"outgoing"` |
| `status` | `"confirmed"`, `"pool"` or `"failed"` |
| `minHeight`, `maxHeight` | inclusive; confirmed transactions only |
| `hashes` | these transactions; a hash the selection does not contain rejects with `TX_NOT_FOUND` |

Unknown fields and bad values reject with `INVALID_CONFIG` before any native call: `UNKNOWN_FIELD`,
`FIELD_TYPE`, `ASSET_TYPE`, `ADDRESS_INDEX_RANGE`, `QUERY_ACCOUNT_REQUIRED` (a subaddress without an
account), `HEIGHT_RANGE`, `TX_HASHES`, `TX_HASH`. The query must be a plain object of own data
properties; a getter, a setter or a symbol key rejects with `CONFIG_TYPE`. A filter on an account or
subaddress the wallet does not have matches nothing and returns an empty list.

```ts
const zsdReceived = await wallet.getTransfers({ direction: "incoming", asset: "ZSD" });
const fromAccount1 = await wallet.getTxs({ accountIndex: 1, direction: "outgoing" });
const failed = await wallet.getTxs({ status: "failed" });
const one = await wallet.getTx("0000example0000hash0000placeholder00000000000000000000000000000000");
console.log(zsdReceived.length, fromAccount1.length, failed.length, one.hash);
```

`getTx(hash)` takes a hash of 64 lowercase hexadecimal characters (`INVALID_CONFIG`/`TX_HASH`
otherwise) and rejects with `INVALID_CONFIG`/`TX_NOT_FOUND` for a hash the wallet has no transaction
for.

```ts run
import { createRandomWallet, ZephyrWalletError } from "@loki-notfound/zephyr-ts";

const wallet = await createRandomWallet({ networkType: "mainnet", password: "a long passphrase" });
console.log("transactions:", (await wallet.getTxs()).length, "transfers:", (await wallet.getTransfers()).length);

async function expectRejection(call: () => Promise<unknown>, label: string): Promise<void> {
  try {
    await call();
  } catch (err) {
    if (!(err instanceof ZephyrWalletError)) throw err;
    console.log(label, err.code, err.diagnostic);
    return;
  }
  throw new Error(label + " resolved");
}
await expectRejection(() => wallet.getTx("00".repeat(32)), "unknown hash:");
await expectRejection(() => wallet.getTx("ABC"), "malformed hash:");
await expectRejection(() => wallet.getTxs({ subaddressIndex: 1 }), "subaddress without account:");
await expectRejection(() => wallet.getTxs({ minHeight: 10, maxHeight: 5 }), "height range:");
await wallet.close();
```

## Paging

One call selects at most 1,000 transactions with at most 2,000 transfers; a larger selection rejects
with `INVALID_CONFIG`/`LISTING_LIMIT`. The core has no cursor: page by height range.

```ts
const pageSize = 10000;
const top = await wallet.getHeight();
for (let low = 0; low < top; low += pageSize) {
  const page = await wallet.getTxs({ minHeight: low, maxHeight: low + pageSize - 1 });
  console.log(low, page.length);
}
```

Every listing walks all of the wallet's stored transfers in the core; the height range narrows what
is returned, not what is read. Each listing call of the core also keeps 944 bytes it never frees
(plus about 104 bytes per requested hash). A wallet in its own worker returns that memory when it is
closed; with `proxyToWorker: false` it stays until the page or process ends. Avoid listing in a tight
loop: list after a sync, and keep the result.

## Incoming transfers in the pool

The core finds incoming transfers that are still in the pool only by fetching the pool. That is a
daemon request, so it happens only when you call `refreshPool()`:

```ts
const inPool = await wallet.refreshPool();          // a daemon request
const pending = await wallet.getTransfers({ status: "pool", direction: "incoming" });
console.log(inPool, pending.length);
```

`refreshPool()` resolves with the number of incoming pool transactions the wallet holds. Afterwards
the history lists them with `inPool: true`, no height and zero confirmations, until the next
`refreshPool()` or until the wallet holds the transaction as confirmed after a sync. A pool
transaction that leaves the pool without being confirmed stays listed until the next refresh, and a
failed refresh leaves none listed. `getTx` of an incoming transaction still in the pool rejects with
`TX_NOT_FOUND` unless the last refresh saw it. The incoming part of an own pending transaction to
another account of the same wallet is not listed from the pool (the outgoing transaction is).

The request asks for the hashes in the pool (`/get_transaction_pool_hashes.bin`) and then for the
pool transactions the wallet has not scanned before (`/gettransactions`). It sends no key image and
no address, but the node can see which pool transactions the wallet does not ask for: those it sent
itself or already recorded. Failures reject with `DAEMON_ERROR`. An incoming transfer in the pool on
real data is not proven yet ([chapter 12](12-known-limitations.md)).

## Own pending and failed transactions

After `relayPrepared` is accepted, the wallet lists the transaction as its own unconfirmed outgoing
transaction (`isConfirmed: false`), selected by status `"pool"`. After a sync that sees it in a block it is
confirmed. A transaction that never appears in the pool stays pending; the core marks it failed
(`isFailed: true`, status `"failed"`) and its outputs unspent again only after 500 seconds and a
refresh that reads the pool. Own transactions in the pool and failed ones are tested with constructed
records only, not on real data.

## Conversions in the history

A conversion appears as one transaction with an outgoing transfer in the source asset and a
`conversion` field:

```ts
for (const tx of await wallet.getTxs({ direction: "outgoing" })) {
  if (tx.conversion === undefined) continue;
  const c = tx.conversion;
  console.log(`${tx.hash}: ${c.sourceAmount} ${c.sourceAsset} to ${c.destinationAmount} ${c.destinationAsset}, fee ${tx.fee} ${tx.feeAsset}`);
}
```

- `conversion.sourceAsset` and `destinationAsset` come from the outgoing transfer's asset and its
  destinations' asset.
- `sourceAmount` is the outgoing transfer's amount, which the core computes as inputs minus change
  minus fee; `destinationAmount` is the sum of the destinations' amounts in the destination asset.
- `fee` is the core's fee (inputs minus outputs) and `feeAsset` the source asset.
- If the minted amount went to an address of the sending account, it is also listed as an incoming
  transfer in the destination asset.

On the four conversions relayed on mainnet on 2026-11-15, the amount equalled the burnt amount and
the fee the fee charged, and the minted amount was received as described.

## Proofs and transaction keys

A payment proof lets someone who does not have your wallet check a payment: an explorer, a shop or a
support desk. The names are the Java port's:

| Call | Result | Made with |
|---|---|---|
| `getTxProof(txHash, address, message?)` | `"OutProofV2..."` when the address is another wallet's, `"InProofV2..."` when it is one of this wallet's | the transaction's secret key (outbound), the view key (inbound) |
| `getSpendProof(txHash, message?)` | `"SpendProofV1..."` | the spend key of the inputs the wallet spent |
| `getTxKey(txHash)` | the transaction's secret key: 64 hexadecimal characters, more for a transaction with additional keys | the wallet's cache |

```ts
declare const txHash: string;            // a transaction this wallet sent
declare const shopAddress: string;       // the address it paid

const proof = await wallet.getTxProof(txHash, shopAddress, "order 1234");
// give the shop the transaction hash, the proof and the message; it checks them with a proof checker
console.log(proof.startsWith("OutProofV2"), proof.length);
const spent = await wallet.getSpendProof(txHash, "order 1234");
console.log(spent.startsWith("SpendProofV1"));
```

**What a proof shows.** A transaction proof shows that the transaction paid the address: a checker
with the transaction hash, the address and the same message finds the outputs that went to the
address and their amounts, per asset. It does not show who controls the address or who sent the
transaction. The message ties the proof to something, such as an order number; a checker given
another message rejects the proof. A spend proof shows that the maker of the proof spent the
transaction's inputs, without an address or an amount. Anyone who holds a proof can check it, so a
proof given away reveals what it proves.

**Outbound or inbound.** The core decides by the address. For an address of another wallet it makes
an outbound proof with the transaction's secret key: only the wallet that sent the transaction can
make it. For an address of this wallet (any subaddress, also one the wallet watches but has not
created yet) it makes an inbound proof with the view key: the receiver proves what it received. A
payment a wallet sent to one of its own addresses therefore gives an inbound proof.

**The transaction key.** `getTxKey` returns the secret key itself. With it, anyone who also knows
the transaction can see what it paid to any address, so it is a secret like the private keys. Prefer
a proof, which is bound to one address and a message.

**Where keys and proofs come from.** The transaction's secret key exists only in the cache of the
wallet that sent the transaction. A wallet restored from its seed, or opened from bytes saved before
the send, has no key for it: `getTxKey` and an outbound proof reject with
`INVALID_CONFIG`/`TX_KEY_UNAVAILABLE`. Save the wallet after `relayPrepared` resolves
([When to save](02-wallets.md#when-to-save)): the key, like the record of the sent transaction, is
in the bytes you save then. An inbound proof and a spend proof need only the wallet's keys and its
synced history, so a restored wallet can make them.

**Before any request** the library checks with the wallet's own records:

| Case | Rejects with |
|---|---|
| the wallet does not hold the transaction | `INVALID_CONFIG`/`TX_NOT_FOUND` |
| the wallet holds it as failed (no daemon has it) | `INVALID_CONFIG`/`TX_FAILED` |
| the address received nothing in it (no output or incoming transfer of the wallet there, no destination of its outgoing transfer) | `INVALID_CONFIG`/`ADDRESS_NOT_IN_TX` |
| an outbound proof or `getTxKey` without the transaction's key | `INVALID_CONFIG`/`TX_KEY_UNAVAILABLE` |
| a spend proof of a transaction the wallet spent nothing in | `INVALID_CONFIG`/`TX_NOT_SENT` |
| a spend proof of a view-only wallet | `UNSUPPORTED_CAPABILITY`/`VIEW_ONLY_PROOF` |
| a keys-only wallet | `UNSUPPORTED_CAPABILITY`/`KEYS_ONLY_PROOF` |

The address is checked with the core's parser for the wallet's network (`INVALID_ADDRESS`); give the
standard address of an integrated address (`UNSUPPORTED_CAPABILITY`/`INTEGRATED_ADDRESS`). A message
is at most 1,024 bytes in UTF-8, without U+0000 or an unpaired surrogate (`INVALID_CONFIG`/
`PROOF_MESSAGE`), so that a checker can reproduce the bytes that were signed. `getTxKey` sends no
request. `getTxProof` asks the daemon for the transaction (`/gettransactions`), `getSpendProof` for
the transaction and the ring members of its inputs (`/get_outs.bin`); failures reject with
`DAEMON_ERROR`. A result is returned only in the form the core writes, and it never appears in an
error. The check of the wallet's records uses the core's listing of the history, with its memory
cost ([Paging](#paging)): one listing call for a confirmed transaction, two otherwise.

```ts run
import { createRandomWallet, createKeysWallet, ZephyrWalletError } from "@loki-notfound/zephyr-ts";

const wallet = await createRandomWallet({ networkType: "mainnet", password: "a long passphrase" });
const other = await createKeysWallet({ networkType: "mainnet" });
const elsewhere = await other.getPrimaryAddress();
await other.close();

async function expectRejection(call: () => Promise<unknown>, label: string): Promise<void> {
  try {
    await call();
  } catch (err) {
    if (!(err instanceof ZephyrWalletError)) throw err;
    console.log(label, err.code, err.diagnostic);
    return;
  }
  throw new Error(label + " resolved");
}
const unknown = "00".repeat(32);
await expectRejection(() => wallet.getTxKey(unknown), "key of an unknown transaction:");
await expectRejection(() => wallet.getTxProof(unknown, elsewhere, "order 1234"), "proof of an unknown transaction:");
await expectRejection(() => wallet.getSpendProof(unknown), "spend proof of an unknown transaction:");
await expectRejection(() => wallet.getTxProof(unknown, elsewhere, "\ud800"), "message with an unpaired surrogate:");
await expectRejection(() => wallet.checkTxProof(), "checking a proof:");
await wallet.close();
```

### Why the library does not check proofs

The core has check functions, but they cannot confirm a Zephyr payment. `checkTxKey` and
`checkTxProof` report a received amount of 0 for every current transaction: the core reads the
amount of the V1 asset `ZEPH` only, and since hard fork 11 (height 536,000) no output is `ZEPH`.
`checkTxKey` also reports a good result whenever it does not fail, even when the transaction paid
nothing to the address. So `checkTxKey`, `checkTxProof` and `checkSpendProof` reject with
`UNSUPPORTED_CAPABILITY`/`PROOF_CHECK`. Checking is the task of a separate checker, which reads the
amounts per asset. Your own wallet does not need a proof: it reads a payment from its history, where
every transfer carries its asset ([Transfers](#transfers)).

The core's transaction proof itself would also be made for an address that received nothing (its
check that funds were received does not refuse that case); the library refuses it before the core
runs (`ADDRESS_NOT_IN_TX`), from the wallet's records.

The forms and every refusal are tested offline. Proofs of real transactions are made and checked
on copies of the funded test wallet, whose transactions all paid the wallet's own addresses: they
give inbound proofs, so an outbound proof on real data is not proven yet
([chapter 12](12-known-limitations.md)).
