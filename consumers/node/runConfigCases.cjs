"use strict";
// Runs the configuration cases of configCases.ts against the run-time validation through the installed package
// (see that file). The TypeScript source is transpiled in memory with the given compiler and run as CommonJS,
// resolving the package from the given directory; meant to run under offlineGuard.cjs (no network access).
//   node --require offlineGuard.cjs runConfigCases.cjs --typescript <dir with node_modules/typescript> --from <dir with node_modules/@loki-notfound/zephyr-ts>
// Prints the counts per function and kind and every difference; exits 1 on any difference.
const fs = require("fs");
const path = require("path");
const Module = require("module");

const a = process.argv.slice(2);
const arg = (n) => { const i = a.indexOf("--" + n); return i >= 0 ? a[i + 1] : undefined; };
const tsDir = arg("typescript");
const from = arg("from");
if (!tsDir || !from) { console.error("usage: runConfigCases.cjs --typescript <dir> --from <dir>"); process.exit(2); }
const ts = require(require.resolve("typescript", { paths: [path.resolve(tsDir)] }));
const source = fs.readFileSync(path.join(__dirname, "configCases.ts"), "utf8");
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const filename = path.join(path.resolve(from), "configCases.run.cjs");
const m = new Module(filename, module);
m.filename = filename;
m.paths = Module._nodeModulePaths(path.dirname(filename));
m._compile(js, filename);
m.exports.runConfigCases().then((r) => {
  console.log("configuration cases: " + r.total + " (" + Object.keys(r.byKind).sort().map((k) => k + " " + r.byKind[k]).join(", ") + ")");
  for (const d of r.differences) console.log("DIFFERENCE " + d);
  console.log(r.differences.length === 0 ? "every configuration type agrees with its validation" : r.differences.length + " difference(s)");
  process.exit(r.differences.length === 0 ? 0 : 1);
}, (e) => { console.log("configuration cases failed to run: " + (e && e.name)); process.exit(1); });
