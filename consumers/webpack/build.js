"use strict";
// Builds the consumer with webpack's Node API and the configuration in webpack.config.js, and writes
// the compilation's errors and warnings to the file given as the first argument.
const fs = require("fs");
const webpack = require("webpack");
webpack(require("./webpack.config.js"), (err, stats) => {
  if (err) { process.stderr.write("webpack failed: " + err.message + "\n"); process.exit(1); }
  const s = stats.toJson({ all: false, errors: true, warnings: true, assets: true, version: true });
  fs.writeFileSync(process.argv[2], JSON.stringify(s, null, 1) + "\n");
  process.stdout.write(stats.toString({ colors: false, modules: false }) + "\n");
  process.exit(stats.hasErrors() ? 1 : 0);
});
