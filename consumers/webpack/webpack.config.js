"use strict";
// Minimal webpack configuration of the browser consumer: an entry and an output directory. No
// resolve fallback, alias, polyfill, plugin or loader: the package's browser entry needs none, and
// webpack emits the worker script and the WebAssembly module from the package's defaults.
const path = require("path");
module.exports = {
  mode: "production",
  entry: "./src/main.js",
  output: { path: path.resolve(__dirname, "dist"), filename: "main.js", clean: true }
};
