"use strict"

const path = require("path");
const configBase = require("./webpack.base.js");

// Static browser consumers of the SDK and the browser test worker
// (test only). The release consumer uses the release worker bundle (webpack.worker.js). The
// instrumented consumer uses the test worker bundle, in which the module import resolves to
// the separately built test module dist/zephyr.test.js; no release bundle contains it.
const out = path.resolve(__dirname, "dist/lifecycle-consumer");

const release = Object.assign({}, configBase, {
  name: "Lifecycle consumer (release suite)",
  entry: "./src/test/lifecycle/browser/consumer.ts",
  output: { path: out, filename: "consumer.js" }
});

// the instrumented page compiles the test module, so its embedded digest is the test module's
const testDigest = { "#zephyr-sdk/zephyr.digest.js": path.resolve(__dirname, "dist/zephyr.test.digest.js") };

const instrumented = Object.assign({}, configBase, {
  name: "Lifecycle consumer (instrumented suite)",
  entry: "./src/test/lifecycle/browser/consumerInstrumented.ts",
  output: { path: out, filename: "consumer.instrumented.js" },
  resolve: Object.assign({}, configBase.resolve, { alias: Object.assign({}, configBase.resolve.alias, testDigest) })
});

const testWorker = Object.assign({}, configBase, {
  name: "Lifecycle test worker (instrumented module)",
  entry: "./src/test/lifecycle/browser/testWorkerBrowser.ts",
  output: { path: out, filename: "zephyr.test.worker.js" },
  resolve: Object.assign({}, configBase.resolve, {
    alias: Object.assign({}, configBase.resolve.alias, testDigest, { "#zephyr-sdk/zephyr.js": path.resolve(__dirname, "dist/zephyr.test.js") })
  })
});

// worker isolation and memory measurements (test only): page and measurement worker with the release module
const measure = Object.assign({}, configBase, {
  name: "Lifecycle isolation measurement page",
  entry: "./src/test/lifecycle/browser/measureConsumer.ts",
  output: { path: out, filename: "consumer.measure.js" }
});

const measureWorker = Object.assign({}, configBase, {
  name: "Lifecycle measurement worker (release module)",
  entry: "./src/test/lifecycle/browser/measureWorkerBrowser.ts",
  output: { path: out, filename: "zephyr.measure.worker.js" }
});

// network tests (test only): page with the release worker bundle; the daemon is reached
// through the task-owned loopback forwarder that also serves the page
const network = Object.assign({}, configBase, {
  name: "Network stage consumer (release worker)",
  entry: "./src/test/network/browser/networkConsumer.ts",
  output: { path: out, filename: "consumer.network.js" }
});

// loading of the WebAssembly module and its Content-Security-Policy (test only), with the release worker bundle
const moduleLoading = Object.assign({}, configBase, {
  name: "Module loading and policy page",
  entry: "./src/test/lifecycle/browser/moduleConsumer.ts",
  output: { path: out, filename: "consumer.module.js" }
});

// redirect checks of the transport (test only): page and wallet worker with the release worker bundle
const redirect = Object.assign({}, configBase, {
  name: "Redirect checks page",
  entry: "./src/test/transport/browser/redirectConsumer.ts",
  output: { path: out, filename: "consumer.redirect.js" }
});

module.exports = [release, instrumented, testWorker, measure, measureWorker, network, moduleLoading, redirect];
