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
* Proven on real data: incoming transfers in ZPH, ZSD, ZRS and ZYS at two accounts and, after the
  mainnet test of 2026-11-15, outgoing transfers with their destinations, the fees paid, transfers with a
  destination at the sending account and conversions with their burnt and minted amounts: heights,
  confirmations, amounts, the balances they sum to, read the same by zephyr-javascript (destinations, fees
  and the outgoing assets included). Not proven on real data: own transactions in the pool and failed ones;
  their decoding follows the core's records and is tested with constructed records only.
* An amount sent to an address of the sending account in the source asset is not listed as an incoming
  transfer: the core counts it with the account's change (zephyr `wallet2.cpp`,
  `wallet2::process_new_transaction`), and it stays in the account's balance. An amount received at the
  sending account in another asset, such as a conversion's minted amount, is listed as incoming.
* The core reports no fee asset. `feeAsset` is the asset of the outgoing transfer (fees are paid in
  the source asset); a transaction without an outgoing transfer has no `feeAsset`, although its
  `fee` (paid by the sender) is reported.
* For an outgoing transfer the core computes the amount as inputs minus change minus fee, and the
  fee as inputs minus outputs, from its own records; for a conversion, whose outputs are in another
  asset, these values come from that computation as well. On the four relayed conversions the amount
  equalled the burnt amount and the fee the fee charged. `conversion` is derived from the outgoing
  transfer's asset and its destinations' asset and amounts.
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
  bridge fixes the core's relay flag to `false` in every build, and the transport refuses the daemon's
  submit and relay requests (`/sendrawtransaction`, `/send_raw_transaction`, JSON-RPC `relay_tx`,
  `submit_block`) before sending, also if the core itself tried, except the one submit request of a
  relay call (see "Relaying a prepared transaction" below). The public build and the tests check this.
* Same-asset transfers in the four V2 assets only. Conversions (see `buildConversion`), sweeps,
  integrated addresses and payment identifiers, an unlock time and "subtract the fee from a destination"
  (the core's wrapper does not pass it) are not supported.
* The fee is the core's, in the source asset: the transaction's weight times a per-byte fee of the
  daemon's fee estimate, rounded up to the estimate's quantization (zephyr `wallet2.cpp`,
  `wallet2::create_transactions_2` with `calculate_fee_from_weight`). For a same-asset transfer the core
  does not convert it, so the fee has the same number of atomic units in every asset for the same weight.
  The tier of the estimate follows the priority; with `"default"` the core chooses it (README,
  `priority`). Observed on mainnet with one input and two outputs at the default priority: 200,000 atomic
  units per byte of weight, about 0.000307 to 0.000309 in each of ZPH, ZSD, ZRS and ZYS (built on
  2026-11-13; charged on 2026-11-15 in ZPH, ZSD and ZRS), 0.000427 with two destinations (built) and
  0.0005628 with two destinations and two inputs (charged). Once in the nine relayed transactions of 2026-11-15 the default
  priority took the second tier, 790,000 per byte: 0.00121581 ZYS for a ZYS transfer of the same shape.
  Fees vary with the daemon's fee estimate and with the transaction's weight, which changes by a few bytes
  between two builds of the same transfer (the ring members are chosen anew).
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
  build, direct and proxied. What the network accepted is under "Relaying a prepared transaction".

## Building conversions without relay

* `buildConversion` builds one conversion transaction inside the module and discards it; it cannot
  relay, under the same guards as `buildTransfer` (`prepareConversion` keeps it for `relayPrepared`). The six V2 pairs only, one destination, an amount in
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
* A conversion transaction has four outputs: the destination, the change and two outputs of zero amount
  that the core adds to random addresses, one in the source asset and one in the destination asset
  (zephyr `wallet2.cpp`, `transfer_selected_rct`). The SDK makes no claim about their purpose; the
  core's own comment there gives one (the amount-burnt verification uses the sum of the change outputs'
  masks, and the minted amount is not tied to the destination output), which this project has not
  verified.
* Fees are in the source asset: the core computes the fee in ZPH as for a transfer (200,000 atomic units
  per byte of weight observed) and, for a source asset other than ZPH, converts it with the pricing record
  the conversion names (zephyr `cryptonote_tx_utils.cpp`, `get_fee_in_asset_equivalent`, called from
  `wallet2::create_transactions_2`): with the ZSD moving average into ZSD, with the ZRS moving average into
  ZRS, and into ZYS first with the ZSD moving average and then with the ZYS price. A conversion from ZPH
  pays the ZPH fee unconverted. Observed with one input and a weight of about 2,290 (built on 2026-11-13):
  0.000458 ZPH for ZPH to ZRS, 0.0000548 ZSD for ZSD to ZPH and ZSD to ZYS, 0.0000275 ZYS for ZYS to ZSD.
  Charged on 2026-11-15: 0.000052645533 ZSD (ZSD to ZPH), 0.0005942 ZPH (ZPH to ZRS, two inputs),
  0.000052846797 ZSD (ZSD to ZYS), 0.000034350652 ZYS (ZYS to ZSD).
* The reserve ratio decides at build time which pairs are possible (README). With the ratio near 1.66
  on 2026-11-13 and near 1.75 on 2026-11-15, ZPH to ZSD and ZRS to ZPH were refused
  (`TX_NOT_POSSIBLE`/`RESERVE_RATIO`); ZPH to ZRS, ZSD to ZPH, ZSD to ZYS and ZYS to ZSD built.
* Requests: a conversion build sends what a transfer build sends plus the block header with the pricing
  record of the wallet's top block (`getblockheaderbyheight`) and one more circulating supply and
  pricing record history read. The node learns the wallet's height and that it builds a conversion; a
  refused conversion sends the reads up to the refusal and no ring member request.
* A refused conversion releases everything, as a built conversion does (measured in the test module with
  the core's refusals injected as the core throws them, check `T22`). Every typed failure of the core goes
  through one function of the core (`tools::error::throw_wallet_ex`), whose exception cleanups the module
  keeps; without them each refusal left its message behind, 40 to 136 bytes.
* Relayed on mainnet on 2026-11-15: ZSD to ZPH, ZPH to ZRS, ZSD to ZYS and ZYS to ZSD, each mined one or
  two blocks after the block of its pricing record, with the fee charged and the minted amount received as
  described. Not proven: ZPH to ZSD and ZRS to ZPH (refused by the ratio), and a conversion whose pricing
  record aged before inclusion: the rate is fixed by the pricing record the transaction names, and the
  chain accepts that record only while it is at most 10 blocks old when the transaction is mined
  (`tx_pr_height_valid`); a conversion relayed later is rejected, and the reserve ratio is checked again
  against the block that includes it.

## Relaying a prepared transaction

* Proven on mainnet on 2026-11-15 with a funded test wallet (a wallet in the Node.js main thread, the
  default priority, 0.1 or 0.05 of the source asset, only the wallet's own addresses, one transaction at a
  time): one transfer per V2 asset, a transfer with two destinations (one of them at the sending account),
  and the conversions ZSD to ZPH, ZPH to ZRS, ZSD to ZYS and ZYS to ZSD were accepted by the daemon on the
  first submit, mined, and after ten confirmations (eleven in two cases) equal to their descriptions: the
  fee charged, the change, the balances and unlocked balances per asset in both accounts, and for a
  conversion the minted amount received. ZPH to ZSD and ZRS to ZPH were refused at build time by the
  reserve ratio.
* Not proven: a refusal by a daemon on real data, a transfer the core splits, a conversion whose pricing
  record aged before inclusion, the two conversions the ratio refused, relay from a browser or from a
  wallet in a worker (`proxyToWorker`), and platforms other than Node.js on Linux x86_64. The refusal and
  failure paths are proven against a local sink that answers as the daemon does (acceptance, every refusal
  flag, a busy daemon, an HTTP error, an unreadable answer, a dropped connection, a late answer, a refused
  connection), with transactions built on copies of a funded test wallet and with a synthetic transaction
  in the test module; nothing of those reached the network.
* The fee charged is the fee of the description. With the default priority it may be of the second tier
  of the daemon's estimate (README, `priority`); a wallet should show the fee with its asset, the total
  debited and the destinations before `relayPrepared`, and relay only what the user confirmed.
* The daemon's reasons come from the module's own transport, not from the core: the wrapper's
  `relay_txs`, the only commit path the core offers without a source change, turns every commit failure
  into one text. The transport reads the reply's status (compared with the core's constants) and its
  boolean flags for that one request; the reply's reason text is never read.
* A kept build holds the transaction and its secret transaction key in the module's memory until it is
  relayed or void; anything that can call the wallet can relay its token. The token itself is not a
  secret and carries no information. It survives `setDaemonConnection` and is relayed to the daemon
  configured when `relayPrepared` is called (check `S03`).
* The submit request goes to the wallet's configured daemon, which, like every daemon, is trusted by the
  core; it learns the transaction and the client that sent it. An HTTP error is reported as an unknown
  outcome, not as a refusal, because a proxy in front of the daemon may have forwarded the request.
* After acceptance the record lives in the wallet's cache only until the bytes are saved. A transaction
  that never appears in the pool stays pending; the core marks it failed, and its outputs unspent, only
  after 500 seconds and a refresh that reads the pool (`wallet2::update_pool_state`).
* A transfer that the core splits into several transactions is relayed in order and stops at the first
  that is not accepted; this path is proven by code reading and with single transactions only (the
  funded test wallet cannot produce a split within its limits).
* Allocation, measured in the test module (check `S04`, whole cycles of prepare, failed relay and void
  token with a synthetic kept transaction, in the main thread and in a wallet worker): a relay the daemon
  refuses, a relay to an unreachable daemon and a relay with a void token leave nothing (the transport's
  record of the daemon's last answer, which the next request replaces, aside). The module keeps the
  exception cleanups of the core's commit (`wallet2::commit_tx`), of its check of the daemon's answer
  (`wallet2::throw_on_rpc_response_error`) and of the function every typed failure of the core goes
  through (`tools::error::throw_wallet_ex`). Before the last two were kept, a relay the daemon refused left
  about 2.1 KB (the refusal's copy of the transaction; measured with transactions built on the funded
  copies, check `N28`) and a relay to an unreachable daemon about 136 bytes; before the commit's cleanups
  were kept, 3 to 5 KB more.

## The reserve, the supply and the daemon client

* `getReserveInfo` returns what the pinned core computes (zephyr-cpp `monero_wallet_full::get_reserve_info`,
  zephyr `cryptonote::get_reserve_info`), from the daemon's circulating supply, the pricing record of the block
  below the daemon's height (the core caches that height for 30 s, so the record can be up to 30 s behind the
  tip) and the pricing record history. The SDK computes nothing itself. `assetsMa` and `equityMa` are 0 on every
  hard fork after version 4 (the core's code path sets them to 0) and stay raw zero; when no ZSD circulates both
  ratios and the yield values are 0; before hard fork 6 the yield values are 0.
* When the core cannot read a usable pricing record of that block, its `get_reserve_info` returns without an
  exception and without computing (every value but the hard fork version 0). The bridge tells that case apart
  without reading the values: it starts both ratios with a NaN bit pattern that no computation of the core
  produces and that every computing path overwrites, and a ratio that still carries it is that failed read
  (`DAEMON_ERROR`/`PRICING_RECORD_UNAVAILABLE`). The Java port returns the zeros instead.
* The ratios are the core's `double`, given as the shortest decimal text that reads back as exactly that value;
  they are not more precise than the core's integer quotient divided by 10^12.
* `getCirculatingSupply` passes the daemon's tally on: labels as the daemon names them (on mainnet `ZPH`, `ZSD`,
  `ZRS`, `ZYS`, `DJED`, `YIELD`), amounts up to 2^128 - 1; anything else rejects with `DAEMON_RESPONSE`.
* Both calls trust the daemon like every other daemon read of the core. A wrong supply or pricing record from a
  node gives a wrong reserve; the core and the SDK cannot detect it.
* `ZephyrDaemonRpc` offers the node's information (21 fields of `get_info`), its height and block headers. Its
  other inherited calls are not offered (`UNSUPPORTED_CAPABILITY`/`DAEMON_RPC_METHOD`). It reads at most 1 MiB per
  answer and waits at most 30 s; the size is checked after the answer arrived, not while it arrives. It checks
  what a node sends for type and range, not for truth: the pricing record's signature is passed on, not verified.
  A header with the core's empty pricing record (every value 0) has no `pricingRecord`.
* Checked against the Zephyr daemon of the tests (mainnet, restricted RPC) and against constructed answers; not
  checked against a daemon in unrestricted mode, on testnet or stagenet, or behind other proxies than the tests'.

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
  four assets (ZPH, ZSD, ZRS, ZYS) at two accounts and relayed nine transactions on mainnet on
  2026-11-15: the wallet, account and subaddress maps equal the sums of its history (check `N20`), and
  spent outputs, change and the balances after each spend were verified after confirmation.
  Not verified on real data: how a locked balance appears in the maps (the comparisons ran at ten
  confirmations, when nothing was locked).
* Account and subaddress calls check every index against the wallet's own listings, because the
  core's wallet wrapper has no count of them: a call with a subaddress index, or one that lists
  subaddresses, takes time proportional to the account's number of subaddresses times the wallet's
  number of outputs. Wallet bytes made elsewhere can hold any number of accounts and subaddresses and
  labels of any length; the listing bounds limit what one call returns, not what the core holds.
* The core resolves addresses of the wallet's lookahead window with `getAddressIndex` before those
  subaddresses are created; listings show only created subaddresses (the core creates them when an
  output arrives at one).
* Runtime coverage: everything that needs a daemon (synchronization, history after a sync, building
  and relaying) is tested on Linux x86_64 only, with Node.js 22 and headless Chromium. The offline
  checks of the packed package run in the workflow on Windows, macOS (Intel and arm64) and Linux, in
  Node.js 22 to 26, Chrome, Edge, Firefox, Safari and Electron 43 and 45; a platform counts as
  tested only where its job passed. By hand, on 2026-11-16: Windows 10 (Node.js 24, Edge, Chrome) and
  macOS 26 on an Intel Mac (Node.js 24, Chrome, Safari), the same offline checks and the first
  synchronization of a new wallet in the browsers.
  `docs/PLATFORMS.md` in the repository lists each system, runtime and version, and what is not
  tested. The browser entry is tested with Vite 8 and webpack 5 only.
* Firefox needs `script-src 'wasm-unsafe-eval'` in the policy of the worker script, unlike
  Chromium; without it the first construction rejects with `NATIVE_ERROR`/`WASM_MODULE_REJECTED`, as
  for a page policy without it (`DEPLOYMENT.md`; up to `2.3.0-sec.2-ts.1` it was reported as
  `WASM_MODULE_UNAVAILABLE`). Verified with Firefox 160 on Linux.
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
