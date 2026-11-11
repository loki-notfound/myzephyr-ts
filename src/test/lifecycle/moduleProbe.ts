/**
 * Node probe for the loading of the WebAssembly module (test only): one case per fresh process.
 *
 *   node --require nodeMonitor.cjs moduleProbe.js --case <case> --mode direct|worker --invalid <file that is not WebAssembly>
 *        --foreign <WebAssembly module of another program> --changed <zephyr.wasm with one byte changed>
 *        --otherbuild <WebAssembly module of another build> --out file.json
 *
 * Cases: see moduleScenario.ts.
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { MODULE_CASES, ModuleCase, runModuleCase } from "./moduleScenario";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<number> {
  const kind = arg("case") as ModuleCase;
  const mode = arg("mode");
  const out = arg("out");
  const files = { invalid: arg("invalid"), foreign: arg("foreign"), changed: arg("changed"), otherbuild: arg("otherbuild") };
  if (!MODULE_CASES.includes(kind) || (mode !== "direct" && mode !== "worker") || out === undefined || Object.values(files).some((f) => f === undefined)) {
    process.stderr.write("usage: moduleProbe --case " + MODULE_CASES.join("|") + " --mode direct|worker --invalid f --foreign f --changed f --otherbuild f --out file.json\n");
    return 2;
  }
  const invalid = path.resolve(files.invalid as string);
  const outcome = await runModuleCase(kind, mode === "worker", { missing: path.join(path.dirname(path.resolve(out)), "absent", "zephyr.wasm"), invalid,
    foreign: path.resolve(files.foreign as string), changed: path.resolve(files.changed as string), otherbuild: path.resolve(files.otherbuild as string),
    invalidDigest: crypto.createHash("sha256").update(fs.readFileSync(invalid)).digest("hex") });
  fs.writeFileSync(out, JSON.stringify({ env: "node-" + mode, node: process.version, outcome }, null, 2) + "\n");
  return 0;
}

main().then((code) => process.exit(code), (err) => {
  process.stderr.write("probe failed: " + (err instanceof Error ? err.name : typeof err) + "\n");
  process.exit(1);
});
