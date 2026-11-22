# zephyr-ts user guide

This guide explains how to build a Zephyr wallet with zephyr-ts: a web wallet, a desktop wallet with
Electron, or a Node.js service. It assumes you know TypeScript; it does not assume you know monero-ts.
The [README](../../README.md) has the status and the supported surface in short, and the
[API reference](reference/README.md) lists every exported name.

zephyr-ts is an independent project, not affiliated with or endorsed by ZephyrProtocol. This guide
describes version `2.3.0-sec.2-ts.2`.

| Chapter | What it covers |
|---|---|
| [1. Getting started](01-getting-started.md) | what the library is and is not, requirements, installing from the signed release, a first program in Node.js and in a browser |
| [2. Wallets](02-wallets.md) | creating, restoring and opening wallets, saving their bytes, the password, closing, one worker per wallet, a forced stop |
| [3. Connecting to a daemon](03-connecting-to-a-daemon.md) | address forms, the transport, trust, CORS and the same-origin proxy, synchronizing, heights |
| [4. Syncing and listeners](04-syncing-and-listeners.md) | the four forms of a sync, its progress, listeners and their callbacks, where they run and what a throwing one does, background synchronization, closing a wallet that syncs |
| [5. Assets, accounts and balances](05-assets-and-balances.md) | the four assets, amounts in atomic units, balance maps, accounts and subaddresses, labels |
| [6. History](06-history.md) | transactions and transfers per asset, the query, paging, the pool refresh, conversions in the history, payment proofs and transaction keys |
| [7. Sending](07-sending.md) | building to inspect, preparing and relaying, what to show, fees and priorities, every relay outcome, saving, sweeping |
| [8. Conversions](08-conversions.md) | the six pairs, the reserve ratio, the reserve info, the supply and the pricing record, burnt and minted amounts, the pricing record and its age |
| [9. Errors](09-errors.md) | the error class, codes and diagnostics, the codes a wallet must handle |
| [10. Deploying a web wallet](10-deploying-a-web-wallet.md) | the Content-Security-Policy of page and worker, `zephyr.wasm`, Vite, webpack, Electron, the daemon proxy |
| [11. Coming from monero-ts](11-coming-from-monero-ts.md) | what is the same, what was renamed or reshaped, what is not ported |
| [12. Known limitations](12-known-limitations.md) | a digest of the limitations, what was proven on mainnet and what was not |
| [13. Building and verifying](13-building-and-verifying.md) | verifying a release, the signed tag, `manifest.json`, reproducing the build, the core pins |
| [API reference](reference/README.md) | every exported function, class (the wallet, the daemon client, the error), method, type and error code |

Statements about the core and the network in this guide come from the repository's documents
([docs/LIMITATIONS.md](../LIMITATIONS.md), [docs/DEPLOYMENT.md](../DEPLOYMENT.md),
[docs/PLATFORMS.md](../PLATFORMS.md)), from the pinned sources and from test runs against mainnet in
2026-11. Where they state a limit, this guide states it too.

The examples are checked: every TypeScript block is type-checked against the release package under
`strict`, and the blocks that need no daemon are run in Node.js with network access blocked
(`bin/check_guide.sh`). Fragments use `wallet`, an open full wallet, without creating it.
