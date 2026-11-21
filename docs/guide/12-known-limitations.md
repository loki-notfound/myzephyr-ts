# 12. Known limitations

The limitations below follow from the pinned core and from the current scope of the library. They are
deliberate or not yet addressed; none of them is hidden behind a default. This chapter is a digest of
[docs/LIMITATIONS.md](../LIMITATIONS.md), which is the authoritative list; read it before you use the
library with real funds or public nodes. [docs/PLATFORMS.md](../PLATFORMS.md) lists what is tested
where.

## What was proven on mainnet on 2026-11-15

A funded test wallet relayed nine transactions to its own addresses: one transfer per V2 asset (ZPH,
ZSD, ZRS, ZYS), a transfer with two destinations (one of them at the sending account), and the
conversions ZSD to ZPH, ZPH to ZRS, ZSD to ZYS and ZYS to ZSD. Each was accepted by the daemon on the
first submit, mined, and after ten confirmations (eleven in two cases) equal to its description: the
fee charged, the change, the balances and unlocked balances per asset in both accounts, and for a
conversion the minted amount received. ZPH to ZSD and ZRS to ZPH were refused at build time by the
reserve ratio.

The conditions of that test: a wallet in the Node.js main thread, on Linux x86_64, the default
priority, 0.1 or 0.05 of the source asset, only the wallet's own addresses, one transaction at a time.
Once in the nine transactions the default priority took the second fee tier.

Also proven on real data: incoming transfers in ZPH, ZSD, ZRS and ZYS at two accounts; outgoing
transfers with their destinations and fees; conversions with their burnt and minted amounts; the
balance maps of the wallet, its accounts and subaddresses equal to the sums of its history.

## What was not proven

- a refusal by a daemon on real data; the refusal and failure paths of relay are proven against a
  local sink that answers as the daemon does;
- a transfer or a sweep the core splits into several transactions;
- a sweep relayed to the network;
- a conversion whose pricing record aged before inclusion;
- the conversions ZPH to ZSD and ZRS to ZPH;
- relay from a browser or from a wallet in a worker (`proxyToWorker`);
- anything that needs a daemon on a platform other than Linux x86_64, except the connection and
  first synchronization of a new wallet in the manual tests on Windows 10 and macOS 26;
- an incoming transfer in the pool, own transactions in the pool and failed ones (tested with
  constructed records only);
- how a locked balance appears in the balance maps;
- the core's "not enough" failures, too few ring members and an oversized transaction (tested with
  injected failures only).

## The daemon

- **Every daemon is trusted** by the core, and the library cannot turn that off. The first
  synchronization asks the daemon for a dense short chain history. Operations that would send key
  images or the wallet's own transactions to the daemon are not supported. Use a daemon you run
  yourself, or one you trust, for wallets with funds
  ([chapter 3](03-connecting-to-a-daemon.md#every-daemon-is-trusted)).
- **The first synchronization downloads all block hashes** up to the restore height, about 29 MB
  near height 900,000, for every new or restored wallet. Persist `getData()` afterwards.
- **A new wallet without a daemon** starts at the core's date-based estimate, about a month below the
  chain tip.
- **Synchronization semantics** pass through from the core: a start height below the restore height
  lowers it; a daemon that is not synchronized makes a sync return zero blocks without an error; after
  a failed connection check the core reports `DAEMON_NOT_CONNECTED` until the connection is set again or
  `isConnectedToDaemon()` succeeds;
  a browser cannot tell a request blocked by CORS from an unreachable host.
- **No cancellation** of a running request. Requests are bounded (30 s JSON, 120 s binary). A
  worker-mode wallet can be stopped with `terminate()`, losing unsaved state. `stopSyncing` and `close`
  wait for a running background iteration.
- **Listener notifications are the core's**: the output notifications repeat (count each transaction
  once), outputs in the pool and at unlock carry no asset, and the notifications at unlock come only
  for transactions within 70 blocks of the wallet's height. A direct-mode callback runs on the scanning
  thread, so a slow one delays the scan ([chapter 4](04-syncing-and-listeners.md)).
- **The transport** has no authentication and no proxy support and follows no redirect.

## Wallets and workers

- **Worker isolation is not process isolation.** Workers share the host process; this is not a
  security boundary or a memory limit (about 15 to 30 MiB per open wallet on Linux). With
  `proxyToWorker: false` nothing is isolated.
- **Wallet bytes are not certified resource-safe.** Bytes made elsewhere are opened with their stored
  settings; open bytes only from sources you trust as much as the wallet.
- **Password changes**: the core does not verify the old password in this build; the library does. A
  failed native change can leave the password state unknown; the wallet then refuses every call but
  `close`.
- Failed openings of wrong-password bytes leak a few kilobytes inside the core; in worker mode they go
  away with the construction's worker.

## History

- A listing reads what the last sync and the last `refreshPool` stored; incoming pool transfers appear
  only after `refreshPool`, an explicit daemon request.
- Not returned: notes, payment identifiers, outputs, key images, transaction keys and proofs.
- The core reports no fee asset; `feeAsset` is the asset of the outgoing transfer.
- An amount sent to the sending account in the source asset is not listed as incoming.
- Every listing walks the whole stored history in the core, and each listing call keeps 944 bytes the
  core never frees (returned when a worker-mode wallet closes).

## Building, conversions and relay

- Same-asset transfers in the four V2 assets, the six conversions and the sweep of the unlocked balance
  of one asset in one account only; no converting sweep, no sweep of one output or of dust, no integrated
  addresses, payment identifiers, unlock times or "subtract the fee from a destination".
- A sweep always names its account (the Java port's `sweepUnlocked` without one sweeps every account) and
  leaves outputs worth less than the fee of spending them where they are.
- With the default priority the core chooses the fee tier and may take the second tier.
- The library computes no conversion rate. The reserve ratio decides at build time which pairs are
  possible, and the chain checks it again at inclusion; a pricing record older than 10 blocks at
  inclusion makes the chain reject a conversion.
- `getReserveInfo` returns what the core computes from the daemon's data: `assetsMa` and `equityMa` are 0
  on the current hard fork; a failed read of the pricing record rejects with `PRICING_RECORD_UNAVAILABLE`
  instead of the core's zeros. The reserve and the pricing record are as true as the daemon; the oracle's
  signature is passed on, not verified.
- A kept build holds the transaction and its secret transaction key in the module's memory until it
  is relayed or void; anything that can call the wallet can relay its token.
- After acceptance the record lives in the wallet's cache until the bytes are saved. A transaction
  that never reaches the pool stays pending until the core marks it failed, after 500 seconds and a
  refresh that reads the pool.
- A refused build or relay leaves nothing in the module (measured in the test module).

## Text from wallets and the chain

Labels, destination addresses and other text from wallet bytes or the chain are untrusted display
text and may contain bidirectional controls, zero-width characters and look-alike characters. Render
them as text, isolate their direction, and keep them apart from your own strings
([chapter 5](05-assets-and-balances.md#labels-are-untrusted-display-text)).

## Platforms

- Everything that needs a daemon is tested on Linux x86_64 only, with Node.js 22 and headless
  Chromium.
- The offline checks of the packed package run automatically on Windows, macOS (Intel and arm64) and
  Linux, in Node.js 22 to 26, Chrome, Edge, Firefox, Safari and Electron 43 and 45; a platform counts
  as tested only where its job passed. By hand on 2026-11-16: Windows 10 and macOS 26 on an Intel Mac.
- Not tested: Linux and Windows on arm64, 32-bit systems, Node.js below 22 and from 27, browsers on
  phones and tablets, Firefox ESR, other Chromium-based browsers, Electron below 43, an Electron
  renderer from `file://` or a loopback server or with Node.js integration.
- The browser entry is tested with Vite 8 and webpack 5 only.
- Firefox needs `script-src 'wasm-unsafe-eval'` in the policy of the worker script
  ([chapter 10](10-deploying-a-web-wallet.md#content-security-policy)).
