# 3. Connecting to a daemon

A full wallet reads the chain from a Zephyr daemon (`zephyrd`) over its RPC interface. This chapter
covers the daemon address, what the transport does and refuses, what it means that every daemon is
trusted, the proxy a browser wallet needs, synchronization and heights.

The examples in this chapter need a daemon and are type-checked only. `https://node.example.org` is
a placeholder; the library contains no default daemon.

## Setting the daemon

Give the address at construction (`server`) or later with `setDaemonConnection`:

```ts
import { createRandomWallet } from "@loki-notfound/zephyr-ts";

const wallet = await createRandomWallet({
  networkType: "mainnet",
  password: "a long passphrase",
  server: "https://node.example.org"
});
console.log("connected:", await wallet.isConnectedToDaemon());
console.log(wallet.getDaemonConnection()); // { uri: "https://node.example.org", trusted: true }
```

```ts
await wallet.setDaemonConnection("https://node.example.org");
await wallet.setDaemonConnection({ uri: "https://node.example.org" });
await wallet.setDaemonConnection(undefined); // clear it
```

Construction itself is offline; the daemon is set right after it. A random wallet whose daemon
answers the connection check starts at the daemon height ([chapter 2](02-wallets.md#creating-a-random-wallet)).
An unreachable daemon fails neither the construction nor `setDaemonConnection`:
`isConnectedToDaemon()` then returns `false`, and calls that need the daemon reject with
`DAEMON_ERROR`. `getDaemonConnection()` returns the normalized address the library holds, or
`undefined`, without a request. Keys-only wallets take no daemon
(`UNSUPPORTED_CAPABILITY`/`KEYS_ONLY_DAEMON`).

## Address forms

A daemon address is `http` or `https`, a host, an optional port and an optional base path. It has
no credentials, query, fragment, percent-encoding or dot segments, and is at most 512 characters.
Three deployment forms work, in Node.js and in the browser:

1. **Host and port, no path:** `https://node.example.org` or `http://192.0.2.10:17767`. The daemon,
   or a proxy in front of it, is addressed directly.
2. **A base path on the application's own origin:** `https://wallet.example.org/rpc`. Requests go to
   `/rpc/json_rpc`, `/rpc/getblocks.bin` and so on, and your web server forwards `/rpc/` to the
   daemon. The browser calls its own origin, so CORS does not apply. This is the simplest form for a
   hosted web wallet.
3. **A separate host or subdomain:** `https://rpc.wallet.example.org`. This is another origin for the
   browser, so the daemon or its proxy must send CORS headers that allow the wallet's origin.

A malformed address rejects with `INVALID_CONFIG`/`DAEMON_ADDRESS`; the address text is never copied
into the error.

## What the transport does and refuses

- **No credentials.** A user name or password, in the URL or as `username`/`password` fields,
  rejects with `UNSUPPORTED_CAPABILITY`/`DAEMON_CREDENTIALS`. The transport has no authentication.
- **No proxy.** Proxy settings (`proxy`, `proxyUri`) reject with
  `UNSUPPORTED_CAPABILITY`/`DAEMON_PROXY`. In Node.js and Electron the transport never uses a proxy,
  also not one named by `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY` or `NO_PROXY`: a request goes
  directly to the configured address. In a browser the browser's own proxy settings apply, which a
  page cannot see or change.
- **No certificate settings.** `rejectUnauthorized` rejects with
  `UNSUPPORTED_CAPABILITY`/`CONFIG_FIELD`.
- **No redirects.** An HTTP redirect is never followed, in Node.js, Electron and the browser, in the
  page and in a wallet worker. Configure the address that answers the daemon's requests itself: if
  `http://` is redirected to `https://`, configure the `https://` address. A redirect answer counts as
  a daemon failure, with no second request.
- **Only the configured daemon.** The transport sends a request only to a route below the configured
  address, checked before each request.
- **Bounded requests.** JSON requests take at most 30 s and binary requests at most 120 s (the core's
  shorter limit where it has one); the core retries a failed block download up to four times. There
  is no cancellation of a running request; a worker-mode wallet can be stopped with `terminate()`
  ([chapter 2](02-wallets.md#stopping-a-wallet-at-once)).
- **No submit outside a relay.** The transport refuses every request that would submit or relay a
  transaction or a block, except the one submit request of a relay call
  ([chapter 6](06-sending.md#preparing-and-relaying)).

In a browser the transport uses `fetch` with redirect mode `manual`; `XMLHttpRequest` is not used.

## Every daemon is trusted

The core's wallet wrapper marks every daemon connection as trusted, and the library cannot turn this
off. An explicit `trusted: false` or `isTrustedDaemon: false` rejects with
`UNSUPPORTED_CAPABILITY`/`UNTRUSTED_DAEMON` instead of being ignored, and `getDaemonConnection()`
always reports `trusted: true`.

With a trusted daemon the core skips protections it keeps for untrusted nodes. For the operations
this library supports, the consequences are:

- the first synchronization of a wallet asks the daemon for a dense short chain history;
- the core would pass text from the daemon into its errors; the library never does: every daemon
  failure becomes `DAEMON_ERROR` with a fixed diagnostic.

What a daemon learns and can do:

- **It learns** the client's IP address and when it synchronizes; the wallet's height; that it
  builds a transaction and in which asset (the ring member request names it), and that it builds a
  conversion; the pool transactions a pool refresh asks for, and those it leaves out (the ones the
  wallet sent or already recorded);
  and, at relay, the transaction itself and that this client sent it.
- **It can** serve stale or wrong chain data, refuse requests, and report itself synchronized or
  not.
- **It does not receive** the wallet's keys, seed or password. Ordinary synchronization, building
  and the pool refresh send no key image and no address.

Operations that would send key images or the wallet's own transactions to the daemon (spent-output
rescans, key image import, transaction rescans) are not supported. For a wallet with funds, use a
daemon you run yourself or one you trust.

## Browsers: CORS and a same-origin proxy

A browser wallet calls the daemon from its worker. Two things decide whether that works:

- **The worker's Content-Security-Policy:** the response that serves `zephyr.worker.js` must allow
  the daemon origin in `connect-src` ([chapter 9](09-deploying-a-web-wallet.md#content-security-policy)).
- **CORS:** a daemon on another origin must allow the wallet's origin. The library cannot work around
  a missing CORS header. A browser does not tell a request blocked by CORS from an unreachable host,
  so both report `DAEMON_ERROR`/`DAEMON_NOT_CONNECTED`.

The simplest setup is form 2: your web server forwards a path such as `/rpc/` on the wallet's own
origin to the daemon, and the wallet uses `https://wallet.example.org/rpc`. Such a reverse proxy must:

- forward the read-only paths of synchronization: `/json_rpc`, `/getheight` (`/get_height`),
  `/getinfo` (`/get_info`), `/getblocks.bin` (`/get_blocks.bin`), `/gethashes.bin`
  (`/get_hashes.bin`), `/get_transaction_pool_hashes.bin` and `/get_o_indexes.bin`;
- for the pool refresh, building and relaying, also forward what those calls request:
  `/gettransactions`, `/get_output_distribution.bin`, `/get_outs.bin` and `POST /sendrawtransaction`;
- forward request bodies with a `Content-Length`: the daemon does not accept chunked request bodies,
  and a proxy that re-sends them chunked makes every connection check fail;
- allow binary answers of tens of megabytes and requests of up to 120 s;
- answer itself, never with a redirect.

A public node should run in restricted RPC mode. [docs/DEPLOYMENT.md](../DEPLOYMENT.md) describes the
proxy requirements in full.

## Synchronizing

`sync(startHeight?)` is one blocking synchronization. It resolves with `{ numBlocksFetched,
receivedMoney }` when the wallet has caught up with the daemon. There is no progress callback and no
background synchronization; other calls of the wallet, `close` included, wait until it is done.

```ts
const result = await wallet.sync();
console.log("blocks:", result.numBlocksFetched, "received money:", result.receivedMoney);
console.log("wallet height:", await wallet.getHeight(), "daemon height:", await wallet.getDaemonHeight());
const { keys, cache } = await wallet.getData(); // save after a sync
```

What to know before the first sync:

- **It downloads every block hash** from the genesis block up to the wallet's restore height, 10,000
  hashes per request: near height 900,000 about 91 requests and 29 MB, growing by 32 bytes per
  block. This applies to every new or restored wallet, also to a new wallet that starts at the
  daemon height. The hashes become part of the cache: save `getData()` after the first sync, and
  later openings from those bytes do not download them again.
- **A height below the restore height** passed as `startHeight` lowers the stored restore height.
- **A daemon that reports itself not synchronized** makes a sync return zero blocks without an error.
  `isDaemonSynced()` tells you which case you are in.
- **After a failed connection check** the core caches the state: later calls report
  `DAEMON_ERROR`/`DAEMON_NOT_CONNECTED` until the connection is set again with
  `setDaemonConnection`.

A sync can take minutes. In a user interface, show that the wallet is synchronizing, and offer to
stop it with `terminate()` for a worker-mode wallet; synchronized blocks since the last `getData()`
are then lost.

## Heights

| Call | Request | Meaning |
|---|---|---|
| `getHeight()` | none | the wallet's height, as far as it has synchronized |
| `getRestoreHeight()` | none | the height the wallet's first sync starts from |
| `getDaemonHeight()` | yes | the daemon's height |
| `isDaemonSynced()` | yes | whether the daemon reports itself synchronized with its peers |
| `isConnectedToDaemon()` | yes | whether the core reaches the daemon now |


## Failures and timeouts

Every daemon failure rejects with `DAEMON_ERROR` and a fixed diagnostic:

| Diagnostic | Meaning |
|---|---|
| `DAEMON_NOT_CONNECTED` | no daemon configured, the connection check failed, or a browser blocked the request (CORS, policy) |
| `DAEMON_UNREACHABLE` | no answer: unreachable, refused or timed out |
| `DAEMON_RESPONSE` | the daemon answered, but with an error, an HTTP status or a body the core could not use; also a redirect during a sync |
| `DAEMON_BUSY` | at relay: the daemon did not process the transaction |

Another failure of a sync rejects with `NATIVE_ERROR`/`SYNC_FAILED`. Text supplied by a node never
reaches an error ([chapter 8](08-errors.md#no-node-text-in-errors)).
