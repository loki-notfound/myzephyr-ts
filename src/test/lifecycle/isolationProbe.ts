/**
 * Node worker isolation measurement (test only): one fresh process per run, N live wallets in
 * dedicated measurement workers (release module) or, for comparison, in direct mode. Host memory
 * is sampled from /proc/self at each mark; worker threads are counted by the preloaded monitor.
 *
 *   node --require nodeMonitor.cjs isolationProbe.js --wallets N --mode worker|direct --out file.json
 */
import fs from "fs";
import path from "path";
import LibraryUtils from "../../main/ts/common/LibraryUtils";
import { runIsolationScenario } from "./isolationScenario";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function procFields(file: string, names: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = /^([A-Za-z_]+):\s+(\d+)/.exec(line);
    if (m && names.includes(m[1])) out[m[1]] = Number(m[2]);
  }
  return out;
}

async function main(): Promise<number> {
  const n = Number(arg("wallets"));
  const mode = arg("mode");
  const out = arg("out");
  if (![1, 2, 5].includes(n) || (mode !== "worker" && mode !== "direct") || out === undefined) {
    process.stderr.write("usage: isolationProbe --wallets 1|2|5 --mode worker|direct --out file.json\n");
    return 2;
  }
  if (mode === "worker") LibraryUtils.setWorkerDistPath(path.join(__dirname, "measureWorkerNode.js"));
  const samples: Record<string, unknown> = {};
  const g = globalThis as unknown as { __lifecycleWorkerThreads?: () => { created: number; exited: number } };
  const mark = async (label: string): Promise<void> => {
    const status = procFields("/proc/self/status", ["VmRSS", "VmHWM", "Threads"]);
    const rollup = procFields("/proc/self/smaps_rollup", ["Rss", "Pss", "Private_Clean", "Private_Dirty", "Anonymous"]);
    const mu = process.memoryUsage();
    samples[label] = { status, rollup, memoryUsage: { rss: mu.rss, heapTotal: mu.heapTotal, heapUsed: mu.heapUsed, external: mu.external, arrayBuffers: mu.arrayBuffers },
      workerThreads: g.__lifecycleWorkerThreads ? g.__lifecycleWorkerThreads() : undefined, at: new Date().toISOString() };
  };
  const result = await runIsolationScenario(n, mode === "worker", mark);
  await LibraryUtils.terminateWorker();
  fs.writeFileSync(out, JSON.stringify({ env: "node", node: process.version, platform: process.platform + "-" + process.arch, mode, result, samples, wasmCompilations: LibraryUtils.WASM_COMPILATIONS }, null, 2) + "\n");
  return 0;
}

main().then((code) => process.exit(code), (err) => {
  process.stderr.write("probe failed: " + (err instanceof Error ? err.name : typeof err) + "\n");
  process.exit(1);
});
