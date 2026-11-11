# Deployment notes

How to serve zephyr-ts in a web application and how to reach a daemon from it. Node.js and
Electron main-process code reach the daemon directly; only the bundling, CORS and policy sections
are browser-specific.

## Bundling and the files the page loads

The package exports two builds of one entry. Node.js gets the CommonJS build in `dist/src/`. A
bundler that resolves the `browser` condition of the exports map gets `dist/zephyr-ts.browser.mjs`:
one ES module with no import of another module, so it needs no Node.js built-in, polyfill, alias
or fallback in your bundler configuration. It contains the library, the WebAssembly glue and small
browser implementations of `assert`, `process` and `Buffer` that the shared sources use; leave it
unminified in your sources and let your bundler minify it.

Two files stay separate, and the page loads them at run time:

* `zephyr.worker.js`: the wallet worker, a classic worker script started with `new Worker(url)`;
* `zephyr.wasm`: the WebAssembly module.

The browser entry names both with `new URL("./zephyr.worker.js", import.meta.url)` and
`new URL("./zephyr.wasm", import.meta.url)`. Vite and webpack 5 recognize this form: they emit both
files with your application (with content hashes in their names) and rewrite the URLs, so nothing
needs to be configured. Vite copies both files unchanged; webpack's production minimizer minifies
the already minified worker script once more, and that copy works the same. Tested: Vite 8 with its development server and its production build,
without a configuration file, and webpack 5 without any resolve fallback, both in Chromium. To
serve the files from another place, set their URLs before the first construction with
`setWorkerDistPath(url)` and `setWasmModuleUrl(url)` (`@loki-notfound/zephyr-ts/zephyr.worker.js`
and `@loki-notfound/zephyr-ts/zephyr.wasm` name them in the package). The worker script must have
the page's origin, as for every worker.

The page fetches `zephyr.wasm` once, compiles it once and passes the compiled module to every
wallet worker; workers never fetch or compile it themselves. The module is compiled from its
bytes, so any content type works; `application/wasm` is the correct one. The JavaScript carries
the SHA-256 of the `zephyr.wasm` it was built with, and the page checks the fetched bytes against
it once, before compiling. If the file is missing or is not this module, the first construction
rejects with `NATIVE_ERROR` and the diagnostic `WASM_MODULE_UNAVAILABLE` (not readable),
`WASM_MODULE_MISMATCH` (not the `zephyr.wasm` of this release: another release, a stale cached
copy, a damaged file) or `WASM_MODULE_REJECTED` (the right file does not compile, for example under
a policy without `'wasm-unsafe-eval'`) before any worker starts. Serve the two files from the same
release, and make sure a cache cannot keep an old `zephyr.wasm` next to new JavaScript.

The integrity check detects a mismatched or stale file; it is not a signature and does not prove
where the files came from (whoever can change `zephyr.wasm` on your server can usually change the
JavaScript too). The digest is computed with the Web Crypto API, which browsers offer only in a
secure context (`https://` or `localhost`). On a plain `http://` origin the page cannot check the
module, and the first construction rejects with `NATIVE_ERROR`/`WASM_MODULE_UNVERIFIED` before
anything is compiled: serve the wallet over `https://`.

A bundler that ignores the `browser` condition would take the CommonJS build, which is meant for
Node.js and Electron main processes and is not supported in a browser bundle.

## Daemon address forms

A daemon address is `http` or `https`, a host, an optional port and an optional base path; no
credentials, query or fragment. Three deployment forms work, in Node.js and in the browser:

1. **Host and port, no path**: `https://node.example.org` or `http://192.0.2.10:17767`. The
   daemon, or a proxy in front of it, is addressed directly.
2. **A base path on the application's own origin**: `https://wallet.example.org/rpc`. Requests go
   to `/rpc/json_rpc`, `/rpc/getblocks.bin` and so on, and your web server forwards `/rpc/` to the
   daemon. The browser calls its own origin, so CORS does not apply. This is the simplest form for
   a hosted web wallet.
3. **A separate host or subdomain**: `https://rpc.wallet.example.org`. This is another origin for
   the browser, even on the same site, so the daemon or its proxy must send CORS headers that
   allow the wallet's origin (the daemon has an option for allowed origins). The library cannot
   work around a missing CORS header: a blocked request reports the fixed connection diagnostic
   `DAEMON_ERROR`/`DAEMON_NOT_CONNECTED`, the same as an unreachable host, because the browser does
   not tell the two apart.

The library contains no default daemon and no deployment-specific host.

## Proxies in front of a daemon

* Forward these read-only paths: `/json_rpc`, `/getheight` (also `/get_height`), `/getinfo`
  (`/get_info`), `/getblocks.bin` (`/get_blocks.bin`), `/gethashes.bin` (`/get_hashes.bin`),
  `/get_transaction_pool_hashes.bin` and `/get_o_indexes.bin`. A public node should run in
  restricted RPC mode.
* Send request bodies with a `Content-Length`. The daemon's HTTP server does not accept chunked
  request bodies; a proxy that re-sends the wallet's requests chunked makes every connection check
  fail. The library's own requests carry a length.
* Allow binary responses of tens of megabytes and requests of up to 120 s: the first
  synchronization of a wallet downloads all block hashes (about 29 MB near height 900,000, see
  `LIMITATIONS.md`).
* For form 3, answer the CORS preflight and the requests with
  `Access-Control-Allow-Origin: <wallet origin>`.

## Content-Security-Policy

A page that uses the library needs these sources, in addition to what the application itself
needs:

| Directive (page) | Value | Without it |
|---|---|---|
| `script-src` | `'self'` (the origin of your scripts) | the page's scripts do not run |
| `script-src` | `'wasm-unsafe-eval'` | the page cannot compile `zephyr.wasm`: `NATIVE_ERROR`/`WASM_MODULE_REJECTED` |
| `worker-src` | the origin of `zephyr.worker.js` (or leave `worker-src` out and let `script-src` allow it) | no wallet worker starts: `NATIVE_ERROR`/`WORKER_FAILED` |
| `connect-src` | the origin of `zephyr.wasm` | the page cannot fetch the module: `NATIVE_ERROR`/`WASM_MODULE_UNAVAILABLE` |

The daemon requests run in the wallet workers, so they are governed by the policy of the response
that serves `zephyr.worker.js`, not by the page's policy:

| Directive (worker script response) | Value | Without it |
|---|---|---|
| `connect-src` | every daemon origin you use (form 2: the application's own origin) | every daemon request is blocked; the wallet reports `isConnectedToDaemon() === false` and network calls reject with `DAEMON_ERROR` |

The workers instantiate the module the page compiled; they need no `'wasm-unsafe-eval'` and no
script source. A worker script served without any policy is not restricted at all (the page's
policy does not carry over), so send one.

These statements are verified in Chromium only. Firefox and Safari apply policies to workers
differently and have not been tested; check the policy in every engine you support.

Policies used by the tests (Chromium; `<daemon origins>` stands for your daemons):

    page:   default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'
    worker: default-src 'none'; connect-src <daemon origins>

Each row of the tables was checked by running with that source removed: the run failed as shown
and the browser reported the violation of exactly that directive. No `'unsafe-eval'`,
`'unsafe-inline'`, `blob:` or `data:` source is needed.
