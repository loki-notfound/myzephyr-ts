# 4. Syncing and listeners

A full wallet catches up with its daemon by syncing. This chapter covers the four forms of `sync`, the
progress of a sync, listeners and their six callbacks, where the callbacks run and what happens when
one throws, background synchronization, and closing a wallet that syncs. The names and semantics are
those of the Java port (`ZephyrWalletListener`, `sync(startHeight, listener)`, `startSyncing`,
`stopSyncing`); where this library behaves differently, the text says so.

The first example runs without a daemon; the others need one and are type-checked only.
`https://node.example.org` is a placeholder; the library contains no default daemon.

## Syncing

`sync()` fetches the blocks since the wallet's height, scans them for the wallet's outputs and
resolves with `{ numBlocksFetched, receivedMoney }` when the wallet has caught up with the daemon.
There are four forms, as in the Java port:

| Form | Starts at | Notifies |
|---|---|---|
| `sync()` | the larger of the wallet's height and its restore height | the added listeners |
| `sync(listener)` | the same | the added listeners and `listener` |
| `sync(startHeight)` | `startHeight` | the added listeners |
| `sync(startHeight, listener)` | `startHeight` | the added listeners and `listener` |

The listener of `sync(listener)` receives the notifications of that sync only. It is not registered:
`getListeners()` does not list it, and it gets nothing after the sync resolved. If it is also an added
listener, it gets each notification once.

What to know before syncing:

- **The first sync of a new or restored wallet downloads every block hash** from the genesis block up
  to its restore height, 10,000 hashes per request: near height 900,000 about 91 requests and 29 MB.
  Save `getData()` after it; bytes saved after that sync do not download the hashes again.
- **A start below the restore height lowers the restore height** (the core's rule). A start below the
  wallet's height does not scan the blocks it already has again; it only changes where the progress
  counts from.
- **A wallet already at the daemon's height gets no progress call**: the core fetches nothing. Do not
  wait for one. The same holds for a new random wallet, which starts at the daemon's height.
- **A daemon that reports itself not synchronized gives an empty sync.** The core syncs only when the
  daemon's height is at least the highest height of its peers. Otherwise `sync()` resolves at once
  with `numBlocksFetched` 0 and `receivedMoney` false, sends no notification, and the wallet stays
  where it was (read in the core's code). Check `isDaemonSynced()` before you trust a sync, and show
  the user that the node is behind.
- **Other calls of the wallet wait for a sync**, `close` included; there is no native cancellation. A
  wallet in its own worker can be stopped at once with `terminate()`
  ([chapter 2](02-wallets.md#stopping-a-wallet-at-once)).

## Progress of a sync

`onSyncProgress(height, startHeight, endHeight, percentDone, message)` comes once per block the sync
scans:

- `height` is the block, counted from the wallet's height (the first block it fetches) upwards;
- `startHeight` is where the sync started, `endHeight` the daemon's height when it started (one above
  its top block; when a block arrives during the sync it becomes that block's height plus one);
- `percentDone` is `(height - startHeight + 1) / (endHeight - startHeight)`, from just above 0 to 1,
  and exactly 1 at the last block;
- `message` is always `"Synchronizing"`. The core sends only that text; any other text of the core
  would be replaced by it, as the library replaces every native text.

`onNewBlock(height)` comes once per scanned block as well, just before its progress call.

```ts
const result = await wallet.sync({
  onSyncProgress(height, startHeight, endHeight, percentDone) {
    console.log(`block ${height} of ${endHeight - 1}: ${Math.round(percentDone * 100)} %`);  // percentDone: 0 to 1
  }
});
console.log("blocks:", result.numBlocksFetched);
```

## Listeners

`addListener(listener)` registers a listener for every later notification of the wallet,
`removeListener(listener)` removes it, and `getListeners()` returns the added listeners, first added
first (a frozen copy). A listener is any object with some of the six callbacks; there is no
class to extend. Adding the same object twice keeps it once, as in the Java port; removing one that
was not added rejects with `INVALID_CONFIG`/`LISTENER_NOT_REGISTERED`, as the Java port's error does.
A value that is not a listener (not an object, or a callback that is not a function) rejects with
`INVALID_CONFIG`/`LISTENER`. Keys-only wallets have no daemon and reject with
`UNSUPPORTED_CAPABILITY`/`KEYS_ONLY_DAEMON`.

```ts run
import { createRandomWallet, ZephyrWalletError, type ZephyrWalletListener } from "@loki-notfound/zephyr-ts";

const wallet = await createRandomWallet({ networkType: "mainnet", password: "a long passphrase" });
const listener: ZephyrWalletListener = {
  onNewBlock(height) { console.log("block", height); },
  onBalancesChanged(balance, unlockedBalance, assetType) { console.log(assetType, balance, unlockedBalance); }
};
await wallet.addListener(listener);
await wallet.addListener(listener);                        // kept once
console.log("listeners:", wallet.getListeners().length);   // 1
try {
  await wallet.sync(listener);                             // no daemon: the core cannot sync
} catch (err) {
  if (err instanceof ZephyrWalletError) console.log(err.code, err.diagnostic); // DAEMON_ERROR DAEMON_NOT_CONNECTED
}
await wallet.removeListener(listener);
await wallet.close();
```

The core sends notifications while the wallet syncs (a call of `sync` or a background iteration),
refreshes the pool (`refreshPool`) or relays (`relayPrepared`). While no listener is added, the wallet
does not ask the core for notifications at all, which saves the core the per-block balance checks they
need. A listener added while a sync runs gets that sync's notifications only if another listener was
added before the sync started; otherwise its first notifications come from the next sync.

## The callbacks

| Callback | When | What it carries |
|---|---|---|
| `onSyncProgress(height, startHeight, endHeight, percentDone, message)` | once per scanned block | the block, the range, a fraction from 0 to 1, `"Synchronizing"` |
| `onNewBlock(height)` | once per scanned block | the block's height |
| `onBalancesChanged(balance, unlockedBalance, assetType)` | once per asset whose balance or unlocked balance changed | the wallet's new balance and unlocked balance of that asset, `bigint` |
| `onOutputReceived(output)` | an output for the wallet in the pool, in a scanned block, and when it unlocked | a `ZephyrWalletOutput` |
| `onOutputSpent(output)` | an output of the wallet spent in a scanned block, and when that transaction unlocked | a `ZephyrWalletOutput` |
| `onSyncError(error)` | a background iteration failed, or a notification could not be read | a `ZephyrWalletError` (not in the Java port) |

A `ZephyrWalletOutput` is a frozen plain object: `amount` (`bigint`, atomic units), `accountIndex`,
`subaddressIndex`, `txHash`, `height` and `assetType`. A field the core does not report is absent,
never `""` or 0.

## The output notifications repeat

The core notifies one output several times, as the Java port documents:

- **received:** when the transaction is seen in the pool (during a sync or `refreshPool`), when its
  block is scanned, and when it unlocks;
- **spent:** when the spending transaction's block is scanned, and when that transaction unlocks. The
  second time is one summary for the whole transaction: the outgoing amount plus the fee, in the source
  asset, at the outgoing account (the subaddress only when the transfer came from one), not the real
  inputs.

Received outputs include the change of the wallet's own transactions. **Count each transaction once,
by its hash, and do not add up the notifications**: use them as a signal, and read the amounts from
`getBalance()` or the transaction from `getTx(hash)`.

Read in the core's code: the notifications at unlock come only for transactions the core finds among
those confirmed in the **70 blocks below the wallet's height** when it checks, and the check runs
during a sync only once the wallet has completed a sync in this session (otherwise at the end of the
sync). A wallet that syncs from far behind gets no unlock notification for its older transactions.

## Outputs without an asset

**The asset of a pool output, and of the outputs notified when a transaction unlocks, is absent.** The
core's callback for pool payments has no asset parameter, and at unlock it reads the outputs from its
own history, whose outputs carry no asset. The notification at confirmation carries the asset. Use
`onBalancesChanged` (which names the asset) or `getTxs()` (which reports the asset of the same
transfer).

## Where the callbacks run

**No callback runs inside the WebAssembly core.** The core hands each notification to a small sink of
the library, which only records it; the callbacks run afterwards, in the context that owns the wallet:

- **A wallet in its own worker (the default):** the worker posts each notification to your context as
  a message, which the library checks as strictly as a reply. Your callbacks run there as the messages
  arrive, and the worker does not wait for them: a slow callback does not slow the scan. If your
  context's event loop is blocked for a while, the messages wait in its queue and are delivered in
  order once it runs again; the sync's own result comes after them.
- **Direct mode (`proxyToWorker: false`):** the callbacks run in the calling context in a microtask,
  between the core's steps (at its network requests) and when the core's call returns. A slow callback
  delays the scan there, because both share one thread.

In both modes every notification of a sync is delivered before the sync resolves, and the callbacks of
one notification run in the sequence the listeners were added, the per-sync listener last. Callbacks may
call the wallet: the call waits until the running sync is done. Keep callbacks short anyway, and hand
heavy work to your own queue.

## A callback that throws

A callback that throws, or returns a promise that rejects, changes nothing else:

- the sync goes on and resolves with its result;
- the other listeners still get the notification;
- the rest of that block's notifications still come, to that listener too;
- the exception never reaches the caller of `sync` and is never an unhandled rejection; the library
  drops it without reading it.

The Java port's runs of 2026-11-17 showed the opposite on the JVM (skipped notifications and a native
thread that kept the JVM alive), so its guide asks you to catch everything in a callback. Here that is
not needed for the wallet's sake, but your own code may still want to log its failures.

## Background synchronization

`startSyncing(periodInMs?)` keeps the wallet in sync in the background: a sync at once, then one every
`periodInMs` (10,000 by default, as in the Java port) after the previous one started, or at once when
one took longer. The period is an integer from 1,000 to 86,400,000; anything else rejects with
`INVALID_CONFIG`/`SYNC_PERIOD`. Calling it while the loop runs only sets the period. A wallet without a
daemon rejects with `DAEMON_ERROR`/`DAEMON_NOT_CONNECTED`. `startSyncing` resolves once the loop runs;
the added listeners receive the notifications of every iteration.

```ts
await wallet.addListener({
  onNewBlock(height) { console.log("new block", height); },
  onSyncError(error) { console.log("background sync failed:", error.code, error.diagnostic); }
});
await wallet.startSyncing(30000);
```

- **One sync at a time.** Every iteration goes through the wallet's one queue: a call made while an
  iteration runs waits for it, and an iteration does not start while another call runs.
- **Failures are reported, not printed.** A failed iteration reaches the listeners' `onSyncError` with
  the code and diagnostic a sync would reject with, and the loop goes on with the next period; the
  caller of `startSyncing` has returned and sees nothing. The Java port prints such failures on standard
  output instead. After `DAEMON_NOT_CONNECTED` (the core's state since its last connection check) the
  next iteration checks the connection first, so the loop recovers when the daemon answers again.
- **`stopSyncing()` resolves when the loop is stopped and its running iteration has finished.** The
  iteration is not ended (the core has no cancellation); a call made after `stopSyncing` resolved runs
  with no background sync. This answers what the Java port leaves open: you know the background sync
  has stopped when `stopSyncing` resolves.
- **What keeps a process alive.** The loop waits between iterations with a timer. In Node.js that timer
  keeps the process alive until `stopSyncing()` or `close()`; a wallet in its own worker keeps it alive
  anyway until it is closed. A wallet in its own worker runs its loop in that worker. Browsers throttle
  the timers of a hidden page, so a direct-mode loop there may run less often than its period (not
  measured here).

## Closing a wallet that syncs

`close()` waits for a running sync, also for a background iteration: it stops the loop, waits until
the running iteration has finished and then closes the native wallet. No notification is delivered
after `close()` was called. `terminate()` of a wallet in its own worker ends the worker at once, also
during an iteration; every pending call rejects with `WALLET_CLOSED`/`WALLET_TERMINATED`.

```ts
await wallet.stopSyncing();                 // resolves once no iteration runs
const { keys, cache } = await wallet.getData();
await wallet.close();
```

The Java port's runs showed crashes when a wallet was closed during a sync, and no reliable signal that
a background scan had stopped. Here the queue makes both safe: `close` and `getData` wait for the
running sync, and `stopSyncing` tells you when the loop is done.
