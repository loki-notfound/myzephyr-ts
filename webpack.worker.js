"use strict"

const path = require("path");
const configBase = require("./webpack.base.js");

let configZephyrWebWorker = Object.assign({}, configBase, {
  name: "Zephyr web worker config",
  entry: "./src/main/ts/common/ZephyrWebWorker.ts",
  output: {
    path: path.resolve(__dirname, "dist"),
    filename: "zephyr.worker.js"
  },
});

module.exports = configZephyrWebWorker;