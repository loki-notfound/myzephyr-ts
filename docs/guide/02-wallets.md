# 2. Wallets

This chapter covers the life of a wallet: creating and restoring it, saving and opening its bytes,
the password, closing it, the worker it runs in and a forced stop.

## Kinds of wallets

A `ZephyrWallet` is one of two kinds, shown by its read-only `kind` property:

- **A full wallet** (`kind === "full"`) is created by `createRandomWallet`, `restoreWalletFromSeed`,
  `restoreWalletFromKeys` or `openWalletData`. It has a network type, a restore height and wallet
  bytes, can use a daemon, and offers balances, accounts, history, building and relaying.
- **A keys-only wallet** (`kind === "keys"`) is created by `createKeysWallet`. It derives addresses,
  the seed and the keys, and nothing else: no daemon, no bytes, no password, no accounts, no history
  and no transactions. Those calls reject with `UNSUPPORTED_CAPABILITY` and a `KEYS_ONLY_*`
  diagnostic.

A full wallet restored from an address and a private view key is **view-only**: `isViewOnly()`
returns `true`, and building or relaying rejects with `UNSUPPORTED_CAPABILITY`/`VIEW_ONLY_TX`.
`getSeed()`, `getSeedLanguage()` and `getPrivateSpendKey()` of a view-only wallet (full or keys-only)
resolve to `undefined`, and their declared type is `Promise<string | undefined>`. The
[reference](reference/wallet.md#what-the-getters-return) lists what every getter returns for every kind
of wallet.

## Network types

Every construction takes `networkType`: `"mainnet"`, `"testnet"`, `"stagenet"`, or the numbers
`0`, `1`, `2` (`ZephyrNetworkTypeInput`). It is required; a missing or other value rejects with
`INVALID_CONFIG`/`NETWORK_TYPE`. `getNetworkType()` of a full wallet returns the number. Wallet bytes
opened with another network type than the one they were created for reject with
`INVALID_WALLET_DATA`.

## The construction configuration

The construction functions take one plain object. Its type is `unknown` in the declarations: every
field is checked at run time, before any native call, and an unknown field rejects with
`INVALID_CONFIG`/`UNKNOWN_FIELD`. The fields:

| Field | Used by | Meaning |
|---|---|---|
| `networkType` | all | required, see above |
| `password` | full wallets | encrypts the wallet bytes; a string, default `""` |
| `seed` | `restoreWalletFromSeed`, `createKeysWallet` | 12, 13, 24 or 25 words |
| `seedOffset` | with `seed` | an optional passphrase that changes the derived wallet |
| `primaryAddress`, `privateViewKey`, `privateSpendKey` | `restoreWalletFromKeys`, `createKeysWallet` | keys as 64 hexadecimal characters |
| `restoreHeight` | `restoreWalletFromSeed`, `restoreWalletFromKeys` | the height the first sync starts from, default `0` |
| `language` | `createRandomWallet`, `restoreWalletFromKeys`, `createKeysWallet` | the seed language, for example `"English"` |
| `accountLookahead`, `subaddressLookahead` | creating and restoring full wallets | a pair of integers; each and their product at most 20,000 |
| `proxyToWorker` | all | `true` (default): the wallet runs in its own worker |
| `server` | full wallets | a daemon address ([chapter 3](03-connecting-to-a-daemon.md)) |
| `keysData`, `cacheData` | `openWalletData` | the wallet bytes |

`path` (a file path), `regtest`, `isMultisig`, `saveCurrent` and `isTrustedDaemon: false` reject
with `UNSUPPORTED_CAPABILITY`. Each function also rejects a field that belongs to another kind of
construction: a random wallet with a `seed` or a `restoreHeight`, a seed restore with keys or a
`language`. The [reference](reference/functions.md) lists every rejection.

## Creating a random wallet

```ts run
import { createRandomWallet } from "@loki-notfound/zephyr-ts";

const wallet = await createRandomWallet({ networkType: "mainnet", password: "a long passphrase" });
console.log("kind:", wallet.kind, "in a worker:", wallet.proxied);
console.log("seed words:", (await wallet.getSeed() ?? "").split(" ").length, await wallet.getSeedLanguage());
console.log("restore height:", await wallet.getRestoreHeight());
await wallet.close();
```

A new wallet has a 25-word seed. Its restore height depends on whether it was given a daemon:

- with a daemon (`server`) that answers the core's connection check, it starts at the daemon height;
- without one, the core estimates the height from the local date, about a month of blocks below
  the chain tip. It is an estimate, not the wallet's creation height, and a first sync also scans
  those older blocks.

Show the seed to the user once and ask them to write it down. Anyone with the 25 words can spend
every asset of the wallet. Never send a seed to a server and never write it to a log.

## Restoring from a seed

```ts
import { restoreWalletFromSeed } from "@loki-notfound/zephyr-ts";

const seed = "word01 word02 word03 word04 word05 word06 word07 word08 word09 word10 word11 word12 word13 word14 word15 word16 word17 word18 word19 word20 word21 word22 word23 word24 word25";
const restored = await restoreWalletFromSeed({
  networkType: "mainnet",
  password: "a long passphrase",
  seed,
  restoreHeight: 850000
});
```

A restore never falls back to a random wallet. Spaces around and between the words are normalized.
A seed with another number of words than 12, 13, 24 or 25 rejects with
`INVALID_RECOVERY_MATERIAL`/`SEED_WORD_COUNT`; a seed the core cannot decode, for example one with a
wrong checksum word, rejects with `INVALID_RECOVERY_MATERIAL`. The seed's language comes from the
seed itself, so `language` is rejected here.

`restoreHeight` defaults to 0, which makes the first sync scan the whole chain. If the user knows
roughly when the wallet was created, pass a height a little before that.

## Restoring from keys

`restoreWalletFromKeys` takes one of these combinations:

- `privateSpendKey` alone, or with `primaryAddress`: a full wallet that can spend;
- `primaryAddress` and `privateViewKey`: a view-only wallet;
- all three.

A private view key without an address rejects with `INVALID_RECOVERY_MATERIAL`/
`VIEW_KEY_WITHOUT_ADDRESS`; keys that are not 64 hexadecimal characters with `KEY_FORMAT`.

```ts run
import { createRandomWallet, restoreWalletFromKeys } from "@loki-notfound/zephyr-ts";

const original = await createRandomWallet({ networkType: "testnet", password: "first passphrase" });
const address = await original.getPrimaryAddress();

const viewOnly = await restoreWalletFromKeys({
  networkType: "testnet",
  password: "second passphrase",
  primaryAddress: address,
  privateViewKey: await original.getPrivateViewKey(),
  restoreHeight: 1000
});
console.log("same address:", (await viewOnly.getPrimaryAddress()) === address);
console.log("view-only:", await viewOnly.isViewOnly());

await viewOnly.close();
await original.close();
```

## Keys-only wallets

`createKeysWallet` takes the network type and either nothing (a random wallet), a `seed` (with an
optional `seedOffset`) or keys. It takes no password, restore height, lookahead or daemon. Use it to
derive addresses or to check recovery material without the cost of a full wallet.

```ts run
import { createKeysWallet, createRandomWallet } from "@loki-notfound/zephyr-ts";

const full = await createRandomWallet({ networkType: "mainnet", password: "a long passphrase" });
const seed = await full.getSeed(); // undefined only for a view-only wallet
if (seed === undefined) throw new Error("a view-only wallet has no seed");
const keys = await createKeysWallet({ networkType: "mainnet", seed });
console.log("kind:", keys.kind);
console.log("same address:", (await keys.getPrimaryAddress()) === (await full.getPrimaryAddress()));
console.log("subaddress 0/1 equal:", (await keys.getAddress(0, 1)) === (await full.getAddress(0, 1)));
await keys.close();
await full.close();
```

## Saving and opening wallet bytes

zephyr-ts never writes a file. `getData()` returns the wallet's bytes, and you store them yourself:

- `keys`: the keys file, encrypted with the wallet password;
- `cache`: the cache, with what the wallet learned from the chain (its outputs, history, block
  hashes, accounts, subaddresses and labels).

`openWalletData` opens them again. `cacheData` is optional; without it the wallet starts from its
restore height again.

```ts run
import { createRandomWallet, openWalletData } from "@loki-notfound/zephyr-ts";

const password = "a long passphrase";
const wallet = await createRandomWallet({ networkType: "mainnet", password });
await wallet.createAccount("Savings");
const { keys, cache } = await wallet.getData();
const address = await wallet.getPrimaryAddress();
await wallet.close();

// store keys and cache, for example in IndexedDB or in files; later:
const reopened = await openWalletData({ networkType: "mainnet", password, keysData: keys, cacheData: cache });
console.log("same address:", (await reopened.getPrimaryAddress()) === address);
console.log("accounts:", (await reopened.getAccounts()).length);
await reopened.close();
```

In Node.js, writing the bytes to files is your code's job:

```ts
import { writeFile, readFile } from "node:fs/promises";
import { openWalletData } from "@loki-notfound/zephyr-ts";

const { keys, cache } = await wallet.getData();
await writeFile("wallet.keys", keys, { mode: 0o600 });
await writeFile("wallet.cache", cache, { mode: 0o600 });

const reopened = await openWalletData({
  networkType: "mainnet",
  password: process.env.WALLET_PASSWORD ?? "",
  keysData: new Uint8Array(await readFile("wallet.keys")),
  cacheData: new Uint8Array(await readFile("wallet.cache"))
});
```

`getData` encrypts afresh on every call, so its bytes differ even when nothing changed. Open bytes
only from sources you trust as much as the wallet itself: the settings stored in wallet bytes made
elsewhere, such as the subaddress lookahead, are used as stored, and the 20,000-entry limit applies
only to wallets this library creates or restores.

## When to save

Nothing is saved for you, and `close()` does not save. Call `getData()` and store the result:

- after creating or restoring a wallet;
- after the first synchronization, which downloads the hash of every block up to the restore height
  (about 29 MB near height 900,000) and keeps it in the cache: bytes saved afterwards open without
  that download ([chapter 3](03-connecting-to-a-daemon.md#synchronizing));
- after later synchronizations, so that a reopened wallet does not scan the same blocks again;
- after `createAccount`, `createSubaddress`, `setSubaddressLabel` and `changePassword`;
- after `relayPrepared` resolves: the wallet's record of the sent transaction lives only in its
  cache until the bytes are saved ([chapter 6](06-sending.md#after-acceptance-save-the-wallet)).

## The password

The password encrypts the keys file. `changePassword(oldPassword, newPassword)` re-encrypts in
memory; the next `getData()` carries the new password. The library checks the old password itself,
because the core does not in this build: a wrong one rejects with `WRONG_PASSWORD` and changes
nothing.

```ts run
import { createRandomWallet, openWalletData, ZephyrWalletError } from "@loki-notfound/zephyr-ts";

const wallet = await createRandomWallet({ networkType: "mainnet", password: "old passphrase" });
await wallet.changePassword("old passphrase", "new passphrase");
const { keys, cache } = await wallet.getData();
await wallet.close();

try {
  await openWalletData({ networkType: "mainnet", password: "old passphrase", keysData: keys, cacheData: cache });
} catch (err) {
  if (!(err instanceof ZephyrWalletError) || err.code !== "WRONG_PASSWORD") throw err;
  console.log("the old password is rejected:", err.code);
}
const reopened = await openWalletData({ networkType: "mainnet", password: "new passphrase", keysData: keys, cacheData: cache });
await reopened.close();
```

If the native change fails in a way that leaves the password state unknown, the call rejects with
`NATIVE_ERROR`/`PASSWORD_STATE_UNKNOWN` and the wallet refuses every later call except `close`.
Close it and open the bytes you saved before, with the password that was valid for them. A failed
change whose new state is known adopts the new password and rejects with
`NATIVE_ERROR`/`PASSWORD_CHANGED_WITH_ERROR`.

Opening bytes with a wrong password rejects with `WRONG_PASSWORD`, and damaged bytes with
`INVALID_WALLET_DATA`. Failed openings of wrong-password bytes leave a few kilobytes inside the
core; in worker mode they go away with the construction's worker.

## Closing a wallet

`close()` is idempotent:

- from the moment it is called, every new call of the wallet rejects with `WALLET_CLOSED`;
- calls queued before it that have not started reject with `WALLET_CLOSED`;
- a call already running, such as a sync, finishes first; then the native wallet is freed;
- concurrent `close()` calls share one attempt and return the same promise;
- if the native close fails, `close()` rejects with `NATIVE_ERROR`/`CORE_CLOSE_FAILED`, the wallet
  stays closed to new work and a later `close()` retries.

`isClosed()` tells whether `close()` or `terminate()` was called. A wallet's calls run one at a time,
so `close()` waits for a running request; the core has no cancellation.

## One worker per wallet

By default (`proxyToWorker: true`) each construction starts a new worker with its own WebAssembly
instance, which the returned wallet owns until it is closed. The `proxied` property shows the mode.

- A crash or runaway in one wallet does not corrupt another, and a failed construction discards
  only its own worker.
- At most two constructions run at once; further constructions wait in order. Open wallets do not
  count against that limit.
- Workers share the host process (the browser renderer, the Node.js or Electron process). This is
  not a security boundary and not a memory limit. Memory grows with the number of open wallets,
  about 15 to 30 MiB per open wallet on Linux.

With `proxyToWorker: false` the wallet runs in the calling context. All such wallets share one
instance, nothing is isolated, a running call cannot be interrupted, and a failed construction
leaks into that context. Use it where workers are not available or for short scripts.

## Stopping a wallet at once

`terminate()` ends a worker-mode wallet's worker at once, without a native close and without
waiting, also during a sync stalled on a slow daemon. Every pending and later call rejects with
`WALLET_CLOSED`/`WALLET_TERMINATED`, `close()` resolves, and other wallets are not affected. State
that was not saved is lost: synchronized blocks since the last `getData()`, a password change, a
kept build. In direct mode `terminate()` rejects with `UNSUPPORTED_CAPABILITY`/`TERMINATE`.

```ts run
import { createRandomWallet, ZephyrWalletError } from "@loki-notfound/zephyr-ts";

const wallet = await createRandomWallet({ networkType: "mainnet", password: "a long passphrase" });
const pending = wallet.getData();
await wallet.terminate();
try {
  await pending;
} catch (err) {
  if (!(err instanceof ZephyrWalletError) || err.code !== "WALLET_CLOSED") throw err;
  console.log("pending call:", err.code, err.diagnostic);
}
await wallet.close(); // resolves after a forced stop
```

[`terminateWorker()`](reference/functions.md#terminateworker) stops every worker the library started
in the runtime at once: the utility worker, running constructions and every worker-mode wallet.
Call it when your program shuts down. In Node.js, a program that called `validateAddress` in worker
mode keeps running until `terminateWorker()` is called, because the utility worker stays open.

## Cancelling a construction

Every construction function takes a second argument, `{ signal }`, with an `AbortSignal` for that
construction only. In worker mode, an abort while the construction waits or runs ends only that
construction's worker and rejects with `NATIVE_ERROR`/`CONSTRUCTION_ABORTED`. In direct mode only a
signal that is already aborted is honored. Once the wallet is returned, the signal has no effect.

```ts run
import { createRandomWallet, ZephyrWalletError } from "@loki-notfound/zephyr-ts";

const controller = new AbortController();
controller.abort();
try {
  await createRandomWallet({ networkType: "mainnet", password: "a long passphrase" }, { signal: controller.signal });
} catch (err) {
  if (!(err instanceof ZephyrWalletError)) throw err;
  console.log("construction:", err.code, err.diagnostic);
}
```

## Validating an address

`validateAddress(address, networkType)` checks an address with the core's own parser and rejects
with `INVALID_ADDRESS` if it is malformed or belongs to another network. It runs in a utility worker
by default; pass `false` as the third argument to run it in the calling context.

```ts run
import { createRandomWallet, terminateWorker, validateAddress, ZephyrWalletError } from "@loki-notfound/zephyr-ts";

const wallet = await createRandomWallet({ networkType: "testnet", password: "a long passphrase" });
const address = await wallet.getPrimaryAddress();
await wallet.close();

await validateAddress(address, "testnet");
try {
  await validateAddress(address, "mainnet");
} catch (err) {
  if (!(err instanceof ZephyrWalletError) || err.code !== "INVALID_ADDRESS") throw err;
  console.log("a testnet address on mainnet:", err.code);
}
await terminateWorker(); // ends the utility worker, so that Node.js can exit
```
