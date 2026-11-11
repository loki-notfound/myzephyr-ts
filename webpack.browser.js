"use strict";

// The two browser bundles the package ships, built from the same sources as the Node entry:
//   dist/zephyr.worker.js       the wallet worker (a classic worker script, minified)
//   dist/zephyr-ts.browser.mjs  the browser entry: one ES module selected by the "browser" condition
//                               of the package exports, left unminified for the application's bundler
// Neither needs a Node.js built-in. The Node-only branches of the shared sources (file system,
// Node workers, HTTP agents) are never taken in a browser, so these modules resolve to empty
// modules here instead of browser polyfills. The shared sources do use assert, process and
// Buffer; small browser implementations of these three are bundled. The browser entry keeps its
// two `new URL("./...", import.meta.url)` expressions untouched (no URL or import.meta handling
// here), so that the application's bundler finds the worker script and zephyr.wasm beside it.
const path = require("path");
const webpack = require("webpack");

const NODE_ONLY = ["fs", "path", "http", "https", "crypto", "os", "url", "stream", "zlib", "net", "tls", "dns", "child_process",
  "worker_threads", "perf_hooks", "ws", "web-worker"];

const common = {
  mode: "production",
  target: ["web", "es2021"],
  context: __dirname,
  module: {
    rules: [{ test: /\.ts$/, loader: "ts-loader", exclude: /node_modules/ }]
  },
  resolve: {
    extensions: [".ts", ".js"],
    fallback: Object.fromEntries(NODE_ONLY.map((name) => [name, false]))
  },
  plugins: [
    new webpack.ProvidePlugin({ process: require.resolve("process/browser"), Buffer: [require.resolve("buffer/"), "Buffer"] })
  ],
  node: { global: true, __filename: "mock", __dirname: "mock" },
  performance: { hints: false },
  cache: false
};

const worker = Object.assign({}, common, {
  name: "Wallet worker",
  entry: "./src/main/ts/common/ZephyrWebWorker.ts",
  devtool: "hidden-source-map", // dist/zephyr.worker.js.map for debugging; the shipped worker names no map file
  output: { path: path.resolve(__dirname, "dist"), filename: "zephyr.worker.js" }
});

const entry = Object.assign({}, common, {
  name: "Browser entry (ES module)",
  entry: "./src/main/ts/index.browser.ts",
  devtool: false,
  experiments: { outputModule: true },
  output: { path: path.resolve(__dirname, "dist"), filename: "zephyr-ts.browser.mjs", module: true, library: { type: "module" } },
  module: Object.assign({}, common.module, { parser: { javascript: { url: false, importMeta: false, worker: false } } }),
  optimization: { minimize: false }
});

module.exports = [worker, entry];
