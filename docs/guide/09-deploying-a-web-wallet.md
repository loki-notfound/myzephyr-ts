# 9. Deploying a web wallet

This chapter covers what a browser or Electron wallet must serve and allow: the files the page loads,
the Content-Security-Policy of the page and of the worker script, `zephyr.wasm`, the secure context,
the tested bundlers, Electron and the daemon proxy. [docs/DEPLOYMENT.md](../DEPLOYMENT.md) is the
reference this chapter follows.

## Files the page loads

A bundler that resolves the `browser` condition of the exports map gets `dist/zephyr-ts.browser.mjs`:
one ES module with no import of another module. It contains the library, the WebAssembly glue and
small browser implementations of `assert`, `process` and `Buffer`, so it needs no Node.js built-in,
polyfill, alias or fallback in your bundler configuration. Leave it unminified in your sources and
let your bundler minify it.

Two files stay separate:

- `zephyr.worker.js`: the wallet worker, a classic worker script started with `new Worker(url)`. It
  must have the page's origin, as every worker.
- `zephyr.wasm`: the WebAssembly module.

The page fetches `zephyr.wasm` once, compiles it once and passes the compiled module to every wallet
worker; workers never fetch or compile it themselves. A bundler that ignores the `browser` condition
would take the CommonJS build, which is meant for Node.js and Electron main processes and is not
supported in a browser bundle.

## Content Security Policy

The page needs these sources, in addition to what your application needs:

| Directive (page) | Value | Without it |
|---|---|---|
| `script-src` | `'self'` (the origin of your scripts) | the page's scripts do not run |
| `script-src` | `'wasm-unsafe-eval'` | the page cannot compile `zephyr.wasm`: `NATIVE_ERROR`/`WASM_MODULE_REJECTED` |
| `worker-src` | the origin of `zephyr.worker.js` (or leave `worker-src` out and let `script-src` allow it) | no wallet worker starts: `NATIVE_ERROR`/`WORKER_FAILED` |
| `connect-src` | the origin of `zephyr.wasm` | the page cannot fetch the module: `NATIVE_ERROR`/`WASM_MODULE_UNAVAILABLE` |

The daemon requests run in the wallet workers, so they are governed by the policy of the response that
serves `zephyr.worker.js`, not by the page's policy:

| Directive (worker script response) | Value | Without it |
|---|---|---|
| `connect-src` | every daemon origin you use (form 2: the application's own origin) | every daemon request is blocked: `isConnectedToDaemon()` is `false` and network calls reject with `DAEMON_ERROR` |
| `script-src` | `'wasm-unsafe-eval'` (no script source) | Firefox: the worker cannot instantiate the module; the first construction rejects with `NATIVE_ERROR`/`WASM_MODULE_UNAVAILABLE`. Chromium does not need it |

The policies the platform tests use in every browser (`<daemon origins>` stands for your daemons):

```text
page:   default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'
worker: default-src 'none'; script-src 'wasm-unsafe-eval'; connect-src <daemon origins>
```

A worker script served without any policy is not restricted at all (the page's policy does not carry
over), so send one. No `'unsafe-eval'`, `'unsafe-inline'`, `blob:` or `data:` source is needed. Note
Firefox: without `'wasm-unsafe-eval'` in the worker's policy, the first construction rejects with
`WASM_MODULE_UNAVAILABLE`, not with `WASM_MODULE_REJECTED` as for a page policy without it. The page
rows and the first worker row were verified in Chromium, the last worker row in Firefox 160; check the
policy in every engine you support.

A small Node.js server that sends both policies, as an illustration:

```ts
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const ROOT = "dist"; // the bundler's output directory
const PAGE_POLICY = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'";
const WORKER_POLICY = "default-src 'none'; script-src 'wasm-unsafe-eval'; connect-src 'self'"; // daemon under /rpc of this origin
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".wasm": "application/wasm" };

createServer(async (req, res) => {
  const path = normalize(new URL(req.url ?? "/", "http://localhost").pathname).replace(/^(\.\.[/\\])+/, "");
  const file = join(ROOT, path === "/" ? "index.html" : path);
  try {
    const body = await readFile(file);
    const isWorker = /zephyr\.worker[^/]*\.js$/.test(file);
    res.writeHead(200, {
      "Content-Type": TYPES[extname(file)] ?? "application/octet-stream",
      "Content-Security-Policy": isWorker ? WORKER_POLICY : PAGE_POLICY,
      "X-Content-Type-Options": "nosniff"
    });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
}).listen(8080, "127.0.0.1");
```

Bundlers add a content hash to the worker's file name, so match the name by pattern, as above.

## Serving zephyr.wasm

The module is compiled from its bytes, so any content type works; `application/wasm` is the correct
one. The JavaScript carries the SHA-256 of the `zephyr.wasm` it was built with and checks the fetched
bytes against it once, before compiling. If the file is missing or is not this module, the first
construction rejects with `NATIVE_ERROR` and:

| Diagnostic | Cause |
|---|---|
| `WASM_MODULE_UNAVAILABLE` | the file could not be read or fetched |
| `WASM_MODULE_MISMATCH` | not the `zephyr.wasm` of this release: another release, a stale cached copy, a damaged file |
| `WASM_MODULE_REJECTED` | the right file does not compile, for example under a policy without `'wasm-unsafe-eval'` |
| `WASM_MODULE_UNVERIFIED` | the runtime has no Web Crypto digest, so the file cannot be checked |

Serve the two files from the same release, and make sure a cache cannot keep an old `zephyr.wasm` next
to new JavaScript. The check detects a mismatched or stale file; it is not a signature and does not
prove where the files came from.

## Secure context

The digest is computed with the Web Crypto API, which browsers offer only in a secure context:
`https://`, `localhost` or `127.0.0.1`. On a plain `http://` origin the page cannot check the module,
and the first construction rejects with `NATIVE_ERROR`/`WASM_MODULE_UNVERIFIED` before anything is
compiled. Serve the wallet over `https://`.

## Vite

Vite 8 is tested with its development server and its production build, without a configuration file.
It recognizes the `new URL("./...", import.meta.url)` form, emits `zephyr.worker.js` and `zephyr.wasm`
with content hashes in their names and rewrites the URLs. Nothing needs to be configured;
[chapter 1](01-getting-started.md#the-same-in-a-browser-with-vite) has a first page.

## webpack

webpack 5 is tested with a production build without any resolve fallback, alias, polyfill, plugin or
loader. A minimal configuration is enough:

```js
// webpack.config.js
const path = require("path");

module.exports = {
  mode: "production",
  entry: "./src/main.js",
  output: { path: path.resolve(__dirname, "dist"), filename: "main.js", clean: true }
};
```

webpack emits the worker script and the module from the package's defaults. Its production minimizer
minifies the already minified worker script once more, and that copy works the same. The webpack
build is tested in Chromium on Linux only; the platform jobs use the Vite build.

## Electron

Two ways are tested, with Electron 45.2.1 and 43.8.6:

- **The main process** uses the Node.js entry (`require`), directly and with a worker per wallet, like
  any Node.js program.
- **A sandboxed renderer** (context isolation, no Node.js integration) loads the Vite build from a
  privileged `app://` scheme, registered as `standard`, `secure` and `supportFetchAPI` and served with
  `protocol.handle`, with the page and worker policies above sent as response headers. The wallet runs
  in a worker in the renderer.

Not tested: a renderer that loads the page from `file://` or from a loopback server, a renderer with
Node.js integration, and Electron below 43.

A sketch of the main process, after `consumers/electron/main.cjs` of the repository:

```js
const { app, BrowserWindow, protocol } = require("electron");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "renderer"); // the Vite build
const PAGE_POLICY = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'";
const WORKER_POLICY = "default-src 'none'; script-src 'wasm-unsafe-eval'; connect-src https://node.example.org";
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".wasm": "application/wasm" };

protocol.registerSchemesAsPrivileged([{ scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

app.whenReady().then(() => {
  protocol.handle("app", (request) => {
    const url = new URL(request.url);
    const file = path.join(ROOT, path.normalize(url.pathname === "/" ? "/index.html" : url.pathname));
    if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file)) return new Response(null, { status: 404 });
    const isWorker = /zephyr\.worker[^/]*\.js$/.test(file);
    return new Response(fs.readFileSync(file), { headers: {
      "Content-Type": TYPES[path.extname(file)] || "application/octet-stream",
      "Content-Security-Policy": isWorker ? WORKER_POLICY : PAGE_POLICY
    } });
  });
  const win = new BrowserWindow({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  win.loadURL("app://bundle/index.html");
});
```

The renderer's daemon requests are governed by the worker's policy. The Electron tests are offline:
a daemon connection from an Electron renderer is not tested.

## The daemon proxy

A hosted web wallet is simplest with the daemon behind a base path on its own origin (form 2 of
[chapter 3](03-connecting-to-a-daemon.md#address-forms)), so that CORS does not apply and the worker
policy names only `'self'`. The proxy must forward the paths the wallet requests, send request bodies
with a `Content-Length`, allow large binary answers and long requests, and never answer with a
redirect. [Chapter 3](03-connecting-to-a-daemon.md#browsers-cors-and-a-same-origin-proxy) has the
list, and [docs/DEPLOYMENT.md](../DEPLOYMENT.md) the details.
