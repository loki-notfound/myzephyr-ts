# Known limitations

These follow from the pinned core and from the current scope of this library. They are
deliberate or not yet addressed; none of them is hidden behind a default.

## Every daemon is trusted

The core's wallet wrapper marks every daemon connection as trusted, and the library cannot turn
that off: an explicit `trusted: false` (or `isTrustedDaemon: false`) is rejected with
`UNSUPPORTED_CAPABILITY`/`UNTRUSTED_DAEMON` instead of being ignored. With a trusted daemon the
core skips protections it keeps for untrusted nodes. For the operations this library supports
(connection check, heights, synchronization, balances) the consequences are:

* the first synchronization of a wallet asks the daemon for a dense short chain history;
* the core would pass text from the daemon into its errors; the library never does: every daemon
  failure becomes `DAEMON_ERROR` with a fixed diagnostic.

Operations that would send a wallet's key images or its own recent transactions to the daemon
(spent-output rescans, key image import, transaction rescans, multisig import) are not supported.
When they are added they will require an explicit statement that the daemon is the user's own.
Ordinary synchronization does not send key images. Use a daemon you run yourself, or one you
trust, for wallets with funds.

## The first synchronization downloads all block hashes

Before the first block, the core downloads the hash of every block from the genesis block up to
the wallet's restore height, 10,000 hashes per request. Near height 900,000 that is about 91
requests and 29 MB, and it grows by 32 bytes per block. This applies to every new or restored
wallet, also to a new wallet that starts at the daemon height, and it is the dominant cost of a
first synchronization on slow connections; every new wallet puts that load on its daemon. The
hashes are part of the wallet's cache bytes: persist `getData()` after the first synchronization,
and later openings from those bytes do not download them again. The core has a bounded refresh
that its wallet wrapper does not use.

## Restore height of a new wallet

A random wallet created with a daemon (`server`) that answers the core's connection check starts
at the daemon height, as in the core's own random-wallet creation. Without a daemon, or when the
daemon does not answer, the core's estimate from the local date stays: about a month of blocks
below the chain tip, so a first synchronization also scans those older blocks. It is an estimate,
not the wallet's creation height. Restores from a seed or keys use the `restoreHeight` you give
(default 0).

## Synchronization semantics passed through from the core

* `sync(startHeight)` with a height below the restore height lowers the stored restore height.
* When the daemon reports that it is itself not synchronized, a sync returns zero blocks without
  an error.
* The core caches its connection state: after a failed connection check, later calls report
  `DAEMON_ERROR`/`DAEMON_NOT_CONNECTED` until the connection is set again.
* An unreachable daemon fails neither the construction nor `setDaemonConnection`;
  `isConnectedToDaemon` then reports `false` and network calls reject.
* A browser cannot tell a request blocked by CORS from an unreachable host; both report a fixed
  connection diagnostic.

## No cancellation of a running request

The core has no cancellation. A wallet's calls run one at a time; `close` waits for a running
request. Each request is bounded: JSON requests by at most 30 s, binary requests by at most 120 s
(the core's shorter limit where it has one), and the core retries a failed block download up to
four times.

A wallet that runs in its own worker (the default) can be stopped at once with `terminate()`: its
worker is ended without a native close and without waiting, also during a sync stalled on a slow
daemon. Wallet state that was not persisted before is lost, for example a password change or
synchronized blocks since the last `getData()`; every pending and later call rejects with
`WALLET_CLOSED`/`WALLET_TERMINATED`, and `close()` resolves. Other wallets are not affected. In direct mode (`proxyToWorker: false`) a running call
cannot be interrupted, and `terminate()` rejects with `UNSUPPORTED_CAPABILITY`/`TERMINATE`.
`terminateWorker()` stops every wallet worker of the runtime at once.

## Worker isolation is not process isolation

Each wallet runs in its own worker with its own WebAssembly instance, so a crash or runaway in one
wallet does not corrupt another. Workers share the host process (the browser renderer, the Node or
Electron process): this is not a security boundary and not a hard memory limit. Memory grows with
the number of open wallets (about 15 to 30 MiB per live wallet on Linux in the shipped layout).
With `proxyToWorker: false` all wallets share one instance in the calling context and nothing is
isolated.

## Wallet bytes are not certified resource-safe

`openWalletData` opens the keys and cache bytes you give it. Their stored settings, for example
the subaddress lookahead, are used as stored: the 20,000-entry lookahead limit applies to wallets
created or restored by this library, not to imported bytes. Open bytes only from sources you trust
to the same degree as the wallet itself, and prefer the worker mode, which confines a failure to
that wallet's worker.

## History

* The history reads what the wallet stored at its last sync and its last `refreshPool`; no listing
  sends a request. Incoming transfers that are still in the pool are listed only after
  `refreshPool`, an explicit daemon request: the core finds them only by fetching the pool. The
  listing keeps what that refresh saw: a pool transaction that later leaves the pool without being
  confirmed stays listed until the next `refreshPool`, and one the wallet holds as confirmed after a
  sync is listed as confirmed. The incoming part of an own pending transaction to another account
  of the same wallet is not listed from the pool (the outgoing transaction is). Own outgoing
  transactions in the pool and failed ones are listed (`status` `"pool"` and `"failed"`); `getTx`
  of an incoming transaction still in the pool rejects with `TX_NOT_FOUND` unless the last
  `refreshPool` saw it.
* `refreshPool` sends the node the hashes of the pool transactions the wallet has not scanned
  before (`/gettransactions`) after asking for the pool's hashes; it leaves out the transactions the
  wallet sent itself or already recorded as received, which the node can relate to the wallet. It
  sends no key image and no address. The core trusts every daemon (see above); a pool transaction
  that does not parse is skipped. Not proven on real data: an incoming transfer in the pool (that
  needs a transaction sent to a test wallet); the request set and the empty case are proven against
  the permitted daemon, the listing with constructed records in the test module. The asset of an
  incoming pool transfer is what the core recorded (the core's listener reports none for pool
  outputs; the history record carries one when the core stored it); when it is missing the field
  is absent.
* Proven on real data: incoming transfers in ZPH, ZSD, ZRS and ZYS at two accounts, their heights,
  confirmations, amounts and the sums per asset against the balances, read the same by
  zephyr-javascript. Not proven on real data, because no test wallet has sent anything: outgoing
  transfers and their destinations, conversions, fees paid, change, own transactions in the pool and
  failed ones. Their decoding follows the core's records and is tested with constructed records only.
* The core reports no fee asset. `feeAsset` is the asset of the outgoing transfer (fees are paid in
  the source asset); a transaction without an outgoing transfer has no `feeAsset`, although its
  `fee` (paid by the sender) is reported.
* For an outgoing transfer the core computes the amount as inputs minus change minus fee, and the
  fee as inputs minus outputs, from its own records; for a conversion, whose outputs are in another
  asset, these values come from that computation as well and are unproven. `conversion` is derived
  from the outgoing transfer's asset and its destinations' asset and amounts.
* Not returned: transaction notes, payment identifiers, outputs and their assets (the core does not
  store the asset of an output), key images, transaction keys and proofs (`checkTxKey` reads zero
  amounts in this core).
* A destination address is the text the sending wallet stored; it is returned only if it has the
  form of an address (else the field is absent) and is otherwise untrusted.
* Cost: every listing walks all of the wallet's stored transfers in the core (the height range
  narrows what is returned, not what is read), and the bound is checked after the core built the
  selection. A wallet with a long history therefore pays for its whole history on every call.
* Memory: each listing call of the core keeps 944 bytes it never frees (plus about 104 bytes per
  requested hash): the core copies the query into two objects that refer to each other. `getTxs()`,
  `getTx` and listings without `status` make two such calls, the others one; a `"pool"` listing makes
  one more while the last `refreshPool` holds entries, and `refreshPool` itself makes one. A wallet in its own worker
  returns this memory when it is closed or stopped; with `proxyToWorker: false` it stays until the
  page or process ends. Avoid listing in a tight loop.

## Building transactions without relay

* `buildTransfer` builds and signs inside the module and discards the result; it cannot relay. The
  bridge fixes the core's relay flag to `false`, no binding can submit or relay, and the transport
  refuses the daemon's submit and relay requests (`/sendrawtransaction`, `/send_raw_transaction`,
  JSON-RPC `relay_tx`, `submit_block`) before sending, also if the core itself tried. The core's commit
  code is still linked into the module (it is part of the wrapper's build function); it is not
  reachable from any binding of this version. The public build and the tests check all of this.
* Same-asset transfers in the four V2 assets only. Conversions, sweeps, integrated addresses and
  payment identifiers, an unlock time, "subtract the fee from a destination" (the core's wrapper does
  not pass it) and relaying are not supported.
* The fee is the core's, in the source asset: for a same-asset transfer the core computes the same
  per-byte fee in every asset (no conversion). Observed on mainnet on 2026-11-13 with one input and
  two outputs at the default priority: about 0.000307 to 0.000309 in each of ZPH, ZSD, ZRS and ZYS
  (200 atomic units per byte of weight), 0.000427 with two destinations. Fees vary with the daemon's
  fee estimate and with the transaction's weight, which changes by a few bytes between two builds of
  the same transfer (the ring members are chosen anew).
* The bridge first checks the wallet's own unlocked balance of the asset in the selected account or
  subaddresses (a necessary condition, without any request); the core's check with the fee stays
  authoritative. The core's own "not enough" failures, too few ring members and an oversized
  transaction are mapped to fixed diagnostics; they are tested with injected failures, not on real
  data (the test wallet's funds cannot provoke them within the small amounts the tests may use).
* Building is a set of daemon requests the caller chooses (see the README): heights and fork rules,
  fee estimate, pool backlog, recent block headers, circulating supply, pricing record history,
  output distribution and ring members. The node learns that the wallet builds a transaction and in
  which asset (the ring member request names it); no key image or address is sent.
* Nothing persists: after a build the balances, the history and the wallet's state are unchanged and
  a second build of the same transfer works. `getData` encrypts afresh on every call, so its bytes
  differ even without a change; before and after a build they have the same lengths and open to the
  same state. The built transactions are wiped and released inside the module before the call
  returns (the test module's allocator returns to its level after every build).
* Proven on real data (a funded test wallet, copies only, nothing relayed): one build per V2 asset
  to the wallet's own second account, one from that account back, two destinations, a repeated
  build, direct and proxied. Not proven: what the network accepts (nothing was relayed).

## Building conversions without relay

* `buildConversion` builds one conversion transaction inside the module and discards it; it cannot
  relay, under the same guards as `buildTransfer`. The six V2 pairs only, one destination, an amount in
  the source asset with at most four decimals; the core never splits a conversion.
* What a description means: `amountBurnt` and `amountMinted` are the built transaction's own fields
  (what the transaction takes in the source asset and what its destination output carries in the
  destination asset), `pricingRecordHeight` names the block whose pricing record sets the rate. The SDK
  computes no rate and reports none. The core's formula (zephyr `cryptonote_tx_utils.cpp`,
  `zeph_to_zephusd`, `zephusd_to_zeph`, `zeph_to_zephrsv`, `zephrsv_to_zeph`, `zephusd_to_zyield`,
  `zyield_to_zephusd`) uses, from that record, the side of the spot and moving-average price that gives
  the converter less, minus a conversion fee of 0.1 % (ZSD and ZYS pairs) or 1 % (ZRS pairs); the yield
  pairs use the chain's own ZYS price. Observed on mainnet on 2026-11-13: the minted amount equalled
  that formula exactly for every pair that built.
* A conversion transaction has four outputs: the destination, the change and two outputs of zero that
  the core adds (one per asset) so that the minted output cannot be singled out.
* Fees are in the source asset: the core computes the fee in ZPH (200 atomic units per byte of weight
  observed, as for a transfer) and converts it into the source asset with the moving-average price
  (ZSD, ZRS) or the ZYS price. Observed with one input and a weight of about 2,290: 0.000458 ZPH for
  ZPH to ZRS, 0.0000548 ZSD for ZSD to ZPH and ZSD to ZYS, 0.0000275 ZYS for ZYS to ZSD.
* The reserve ratio decides at build time which pairs are possible (README). With the ratio near 1.66
  on 2026-11-13, ZPH to ZSD and ZRS to ZPH were refused (`TX_NOT_POSSIBLE`/`RESERVE_RATIO`); ZPH to ZRS,
  ZSD to ZPH, ZSD to ZYS and ZYS to ZSD built.
* Requests: a conversion build sends what a transfer build sends plus the block header with the pricing
  record of the wallet's top block (`getblockheaderbyheight`) and one more circulating supply and
  pricing record history read. The node learns the wallet's height and that it builds a conversion; a
  refused conversion sends the reads up to the refusal and no ring member request.
* A refused conversion is a typed failure of the core; each refusal leaves about 136 bytes in the
  module (measured in the test module). A built conversion releases everything.
* Not proven: a relayed conversion and what the network charges for it, the amount actually received,
  and the slippage between build and inclusion: the rate is fixed by the pricing record the transaction
  names, and the chain accepts that record only while it is at most 10 blocks old when the transaction
  is mined (`tx_pr_height_valid`); a conversion relayed later is rejected, and the reserve ratio is
  checked again against the block that includes it.

## Text from wallets and the chain

Labels, destination addresses and every other text that comes from wallet bytes or from the chain
are untrusted display text. Wallet bytes made elsewhere are returned as stored, and a label may
contain bidirectional controls (U+202A to U+202E, U+2066 to U+2069), zero-width characters and
characters that look like others or like markup. A wallet application should render such text as
text, never as markup (no `innerHTML`), isolate its direction (for example `<bdi>` or Unicode
isolates), and show it apart from the application's own strings, so that a label cannot pass for a
button, an amount or an address. The library never copies such text into an error or a log line.

## Other limits

* The core's `change_password` does not verify the old password in the WebAssembly build; the
  library verifies it before the change. A failed native change can leave the password state
  unknown; the wallet then refuses every operation except `close`.
* Failed openings of wrong-password bytes leak a few kilobytes inside the core; in worker mode the
  leak goes away with the construction's worker.
* Balances other than zero are verified with a funded test wallet that received five transfers in
  four assets (ZPH, ZSD, ZRS, ZYS) at two accounts: the wallet, account and subaddress maps,
  `isUsed` and `numUnspentOutputs` equal the received transfers. Nothing has been sent from a test
  wallet, so spent outputs, change and balances after a spend are not verified, nor how a locked
  balance appears in the maps (nothing was locked in the funded wallet when it was observed).
* Account and subaddress calls check every index against the wallet's own listings, because the
  core's wallet wrapper has no count of them: a call with a subaddress index, or one that lists
  subaddresses, takes time proportional to the account's number of subaddresses times the wallet's
  number of outputs. Wallet bytes made elsewhere can hold any number of accounts and subaddresses and
  labels of any length; the listing bounds limit what one call returns, not what the core holds.
* The core resolves addresses of the wallet's lookahead window with `getAddressIndex` before those
  subaddresses are created; listings show only created subaddresses (the core creates them when an
  output arrives at one).
* Runtime coverage so far: Node.js 22 and headless Chromium on Linux x86_64. Firefox, Safari,
  Electron, Windows and macOS have not been tested. The browser entry is tested with Vite 8 and
  webpack 5 only.
* The runtime dependencies are the packages the entry's modules load. The HTTP transport has no
  authentication or proxy support: credentials and proxies are rejected by the address contract and
  again by the transport. In Node.js and Electron it never uses a proxy, also not one named by the
  process environment (`HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY`): a daemon request goes
  directly to the configured address. In a browser the browser's own proxy settings apply, which a
  page cannot see or change. HTTP redirects are never followed (in a browser through `fetch` with
  redirect mode `manual`): a daemon address that redirects fails, so the configured address must be
  the final one (`DEPLOYMENT.md`). The browser transport therefore needs `fetch`; `XMLHttpRequest` is
  not used. The shipped declarations need no Node.js types. The browser entry bundles
  what it needs and loads none of the runtime dependencies at run time.
