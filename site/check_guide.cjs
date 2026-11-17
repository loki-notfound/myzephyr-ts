"use strict";
// Checks the examples and the API reference of the guide (docs/guide/) against an installed package.
// Usage: node site/check_guide.cjs --package <dir> [--typescript <dir>] [--work <dir>]
//   --package     a directory with node_modules/@loki-notfound/zephyr-ts (the package under test)
//   --typescript  a directory with node_modules/typescript and node_modules/@types/node
//                 (default: the repository root, whose devDependencies install both)
//   --work        scratch directory (default: build/guide-check), emptied first
//
// Code blocks are found with the guide's own Markdown parser (site/markdown.cjs). The info string says
// what happens to a block:
//   ts / typescript           type-checked under strict against the package
//   ts run                    type-checked, then run in Node.js with network access blocked
//   ts signature              a declaration: must appear verbatim (comments and whitespace aside) in
//                             the package's shipped declarations; not compiled
//   ts no-check: <reason>     opted out; counted and printed with its reason
//   js / javascript [run]     parsed (syntax only); run like a TypeScript block when marked
// Fragments may use `wallet`, an open full wallet, declared for every block. Runnable blocks run one
// at a time under consumers/node/offlineGuard.cjs (preloaded in the main thread and every worker), must
// exit with status 0 within the time limit and must not attempt any network access.
//
// The reference check compares the names documented in docs/guide/reference/ with the package's
// exports (index.d.ts), the public members of ZephyrWallet and ZephyrWalletError, the error codes and
// the diagnostics, and fails on any name missing or extra.
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const md = require("./markdown.cjs");

const ROOT = path.resolve(__dirname, "..");
const GUIDE = path.join(ROOT, "docs", "guide");
const RUN_TIMEOUT_MS = 300000;

function args() {
  const a = process.argv.slice(2);
  const get = (n, d) => { const i = a.indexOf("--" + n); return i >= 0 && a[i + 1] ? a[i + 1] : d; };
  const pkgDir = get("package");
  if (!pkgDir) { console.error("usage: check_guide.cjs --package <dir with node_modules/@loki-notfound/zephyr-ts> [--typescript <dir>] [--work <dir>]"); process.exit(2); }
  return { pkgDir: path.resolve(pkgDir), tsDir: path.resolve(get("typescript", ROOT)), work: path.resolve(get("work", path.join(ROOT, "build", "guide-check"))) };
}

function guideFiles() {
  const out = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((x, y) => x.name.localeCompare(y.name))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else if (e.name.endsWith(".md")) out.push(p);
    }
  })(GUIDE);
  return out;
}

function classify(block, where) {
  const words = block.info.split(/\s+/);
  const lang = words[0];
  const rest = block.info.slice(lang.length).trim();
  const kind = /^(ts|typescript)$/.test(lang) ? "ts" : /^(js|javascript)$/.test(lang) ? "js" : "other";
  const c = { kind, lang, run: false, signature: false, optOut: undefined, where };
  if (kind === "other") { if (rest) throw new Error(`${where}: flags on a ${lang} block`); return c; }
  if (rest === "") return c;
  if (rest === "run") { c.run = true; return c; }
  if (rest === "signature" && kind === "ts") { c.signature = true; return c; }
  const opt = /^no-check: *(.+)$/.exec(rest);
  if (opt && opt[1].trim().length >= 10) { c.optOut = opt[1].trim(); return c; }
  throw new Error(`${where}: unknown code block flags "${rest}" (run, signature, or no-check: <reason>)`);
}

function stripComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}
const normalize = (s) => stripComments(s).replace(/\s+/g, " ").trim();

function main() {
  const opt = args();
  const pkgRoot = path.join(opt.pkgDir, "node_modules", "@loki-notfound", "zephyr-ts");
  if (!fs.existsSync(path.join(pkgRoot, "package.json"))) throw new Error("no package at " + pkgRoot);
  const ts = require(require.resolve("typescript", { paths: [opt.tsDir] }));
  const typeRoot = path.join(opt.tsDir, "node_modules", "@types");
  if (!fs.existsSync(path.join(typeRoot, "node"))) throw new Error("no @types/node under " + opt.tsDir);
  const guard = path.join(ROOT, "consumers", "node", "offlineGuard.cjs");
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgRoot, "package.json"), "utf8"));
  console.log(`package ${pkg.name} ${pkg.version}; TypeScript ${ts.version}; Node.js ${process.version}`);

  fs.rmSync(opt.work, { recursive: true, force: true });
  fs.mkdirSync(path.join(opt.work, "blocks"), { recursive: true });
  fs.symlinkSync(path.join(opt.pkgDir, "node_modules"), path.join(opt.work, "node_modules"), "dir");
  // a package scope of its own: under the repository, the package name would otherwise resolve to the
  // repository itself (package self-reference) instead of the installed package
  fs.writeFileSync(path.join(opt.work, "package.json"), JSON.stringify({ name: "zephyr-ts-guide-check", private: true }) + "\n");

  // ---------------------------------------------------------------- collect
  const blocks = [];
  const docs = {};
  for (const file of guideFiles()) {
    const rel = path.relative(ROOT, file);
    const parsed = md.parse(fs.readFileSync(file, "utf8"), rel);
    docs[path.relative(GUIDE, file)] = parsed;
    for (const b of parsed) if (b.type === "code") blocks.push(Object.assign({ file: rel, text: b.text, line: b.line }, classify(b, `${rel}:${b.line}`)));
  }
  const tsBlocks = blocks.filter((b) => b.kind === "ts");
  const jsBlocks = blocks.filter((b) => b.kind === "js");
  console.log(`${blocks.length} code blocks: ${tsBlocks.length} TypeScript, ${jsBlocks.length} JavaScript, ${blocks.length - tsBlocks.length - jsBlocks.length} other (not checked)`);

  const failures = [];

  // ---------------------------------------------------------------- signatures
  const indexDts = path.join(pkgRoot, "dist", "src", "main", "ts", "index.d.ts");
  const dtsFiles = new Set([indexDts]);
  for (const m of fs.readFileSync(indexDts, "utf8").matchAll(/from "(\.[^"]+)"/g)) dtsFiles.add(path.join(path.dirname(indexDts), m[1] + ".d.ts"));
  const declText = [...dtsFiles].map((f) => normalize(fs.readFileSync(f, "utf8"))).join(" \n ");
  const signatures = tsBlocks.filter((b) => b.signature);
  for (const b of signatures) if (!declText.includes(normalize(b.text))) failures.push(`${b.where}: signature not found in the shipped declarations`);
  console.log(`signatures: ${signatures.length} compared with ${dtsFiles.size} declaration files`);

  // ---------------------------------------------------------------- type check
  const optOuts = tsBlocks.filter((b) => b.optOut !== undefined);
  const compiled = [];
  fs.writeFileSync(path.join(opt.work, "blocks", "guide-globals.d.ts"),
    'import type { ZephyrWallet } from "@loki-notfound/zephyr-ts";\ndeclare global {\n  /** an open full wallet, as the guide\'s fragments assume */\n  const wallet: ZephyrWallet;\n}\nexport {};\n');
  blocks.forEach((b, n) => {
    if (b.kind === "other" || b.signature || b.optOut !== undefined) return;
    const isModule = /^\s*(import|export)\s/m.test(b.text);
    let ext = ".ts";
    if (b.kind === "js") ext = /\brequire\(/.test(b.text) && !/^\s*import\s/m.test(b.text) ? ".cjs" : ".mjs";
    const name = `b${String(n).padStart(3, "0")}${ext}`;
    const body = b.kind === "ts" && !isModule ? b.text + "\nexport {};\n" : b.text + "\n";
    fs.writeFileSync(path.join(opt.work, "blocks", name), body);
    b.name = name;
    compiled.push(b);
  });
  const program = ts.createProgram(
    [path.join(opt.work, "blocks", "guide-globals.d.ts"), ...compiled.map((b) => path.join(opt.work, "blocks", b.name))],
    { strict: true, noEmit: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
      lib: ["lib.es2022.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"], types: ["node"], typeRoots: [typeRoot], allowJs: true, checkJs: false,
      skipLibCheck: true, forceConsistentCasingInFileNames: true, isolatedModules: true });
  const byName = new Map(compiled.map((b) => [b.name, b]));
  for (const d of ts.getPreEmitDiagnostics(program)) {
    const msg = ts.flattenDiagnosticMessageText(d.messageText, " ");
    if (!d.file) { failures.push(`TypeScript: ${msg}`); continue; }
    const b = byName.get(path.basename(d.file.fileName));
    if (!b) { failures.push(`${path.basename(d.file.fileName)}: ${msg}`); continue; }
    const { line } = d.file.getLineAndCharacterOfPosition(d.start || 0);
    failures.push(`${b.file}:${b.line + 1 + line}: ${msg}`);
  }
  console.log(`type check: ${compiled.filter((b) => b.kind === "ts").length} TypeScript blocks under strict, ${compiled.filter((b) => b.kind === "js").length} JavaScript blocks parsed`);
  console.log(`opt-outs: ${optOuts.length}`);
  for (const b of optOuts) console.log(`  ${b.where}: ${b.optOut}`);

  // ---------------------------------------------------------------- run
  const runnable = compiled.filter((b) => b.run);
  let ran = 0;
  if (failures.length === 0) {
    for (const b of runnable) {
      let file = path.join(opt.work, "blocks", b.name);
      if (b.kind === "ts") {
        const js = ts.transpileModule(fs.readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
        file = file.replace(/\.ts$/, ".run.mjs");
        fs.writeFileSync(file, js);
      }
      const guardOut = file + ".guard.json";
      const t0 = Date.now();
      const r = spawnSync(process.execPath, ["--require", guard, file], { cwd: opt.work, encoding: "utf8", timeout: RUN_TIMEOUT_MS,
        env: Object.assign({}, process.env, { OFFLINE_GUARD_OUT: guardOut }) });
      const ms = Date.now() - t0;
      fs.writeFileSync(file + ".log", `exit ${r.status} signal ${r.signal}\n--- stdout\n${r.stdout}\n--- stderr\n${r.stderr}\n`);
      let counts;
      try { counts = JSON.parse(fs.readFileSync(guardOut, "utf8")).counts; } catch (e) { counts = undefined; }
      const network = counts === undefined ? "no guard report" : Object.values(counts).reduce((x, y) => x + y, 0) === 0 ? "" : "network access attempted " + JSON.stringify(counts);
      const ok = r.status === 0 && !r.error && network === "";
      console.log(`  run ${b.where}: ${ok ? "pass" : "FAIL"} (${ms} ms)`);
      if (!ok) failures.push(`${b.where}: run failed (${r.error ? r.error.code : "exit " + r.status}${network ? "; " + network : ""}); log ${path.relative(ROOT, file + ".log")}\n${(r.stderr || "").split("\n").slice(-8).join("\n")}`);
      ran++;
    }
  }
  console.log(`run: ${ran} of ${runnable.length} runnable blocks`);

  // ---------------------------------------------------------------- reference
  failures.push(...checkReference(ts, indexDts, docs));

  if (failures.length) {
    console.log(`\n${failures.length} failure(s):`);
    for (const f of failures) console.log("- " + f);
    process.exit(1);
  }
  console.log("guide check passed");
}

/** Names documented as h3 headings of the form `name` in one reference document. */
function documented(blocks) {
  return blocks.filter((b) => b.type === "heading" && b.level === 3 && b.inline.length === 1 && b.inline[0].t === "code").map((b) => b.inline[0].v);
}

/** First cells of the tables under the h2 heading `section` (and its h3 subsections). */
function tableNames(blocks, section) {
  const out = [];
  let inside = false;
  for (const b of blocks) {
    if (b.type === "heading" && b.level <= 2) inside = b.text === section;
    if (inside && b.type === "table") for (const r of b.rows) if (r[0].length === 1 && r[0][0].t === "code") out.push(r[0][0].v);
  }
  return out;
}

function compareSets(label, expected, actual) {
  const e = new Set(expected); const a = new Set(actual);
  const missing = [...e].filter((x) => !a.has(x)); const extra = [...a].filter((x) => !e.has(x));
  const dup = actual.filter((x, i) => actual.indexOf(x) !== i);
  console.log(`reference ${label}: ${e.size} declared, ${a.size} documented${missing.length || extra.length || dup.length ? "" : ", equal"}`);
  const out = [];
  if (missing.length) out.push(`reference ${label}: not documented: ${missing.join(", ")}`);
  if (extra.length) out.push(`reference ${label}: documented but not declared: ${extra.join(", ")}`);
  if (dup.length) out.push(`reference ${label}: documented twice: ${dup.join(", ")}`);
  return out;
}

function checkReference(ts, indexDts, docs) {
  const program = ts.createProgram([indexDts], { noEmit: true, target: ts.ScriptTarget.ES2022, types: [], skipLibCheck: true, lib: ["lib.es2022.d.ts", "lib.dom.d.ts"] });
  const checker = program.getTypeChecker();
  const sf = program.getSourceFile(indexDts);
  const exports = checker.getExportsOfModule(checker.getSymbolAtLocation(sf));
  const resolve = (s) => (s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s);
  const names = exports.map((s) => s.name);
  const functions = []; const types = []; const classes = {};
  for (const s of exports) {
    const r = resolve(s);
    if (r.flags & ts.SymbolFlags.Class) classes[s.name] = r;
    else if (r.flags & ts.SymbolFlags.Function) functions.push(s.name);
    else if (r.flags & (ts.SymbolFlags.Interface | ts.SymbolFlags.TypeAlias)) types.push(s.name);
    else throw new Error("unexpected export kind: " + s.name);
  }
  const members = (sym) => {
    const decl = sym.declarations.find((d) => ts.isClassDeclaration(d));
    const out = [];
    for (const m of decl.members) {
      const mods = ts.getCombinedModifierFlags(m);
      if (mods & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)) continue;
      const name = ts.isConstructorDeclaration(m) ? "constructor" : m.name.getText();
      if (!out.includes(name)) out.push(name);
    }
    return out;
  };
  const unionLiterals = (name) => {
    const s = resolve(exports.find((x) => x.name === name));
    const t = checker.getDeclaredTypeOfSymbol(s);
    return (t.isUnion() ? t.types : [t]).map((x) => x.value);
  };
  const ref = (f) => docs[path.join("reference", f)];
  const errorTypes = ["ZephyrWalletErrorCode", "ZephyrWalletErrorDiagnostic"];
  const errDoc = documented(ref("errors.md"));
  const out = [];
  out.push(...compareSets("exports (reference/README.md)", names, tableNames(ref("README.md"), "API reference")));
  out.push(...compareSets("functions (functions.md)", functions, documented(ref("functions.md"))));
  out.push(...compareSets("types (types.md, errors.md)", types, documented(ref("types.md")).concat(errDoc.filter((n) => errorTypes.includes(n)))));
  out.push(...compareSets("ZephyrWallet members (wallet.md)", members(classes.ZephyrWallet), documented(ref("wallet.md"))));
  out.push(...compareSets("ZephyrWalletError members (errors.md)", members(classes.ZephyrWalletError), errDoc.filter((n) => !errorTypes.includes(n))));
  out.push(...compareSets("error codes (errors.md)", unionLiterals("ZephyrWalletErrorCode"), tableNames(ref("errors.md"), "Codes")));
  out.push(...compareSets("diagnostics (errors.md)", unionLiterals("ZephyrWalletErrorDiagnostic"), tableNames(ref("errors.md"), "Diagnostics")));
  if (Object.keys(classes).sort().join() !== "ZephyrWallet,ZephyrWalletError") out.push("reference: unexpected classes " + Object.keys(classes).join(", "));
  return out;
}

try { main(); } catch (e) { console.error("guide check failed: " + (e && e.message)); process.exit(1); }
