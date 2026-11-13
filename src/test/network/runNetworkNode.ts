/**
 * Node runner of the network stage (test only).
 *
 *   --mode direct|worker --out report.json --targets targets.json --marker TEXT --checks N01,N02,...
 *   [--seed-in dir] [--seed-out dir] [--funded-in dir --funded-expect file [--funded-out dir] [--funded-build-out dir]]
 *   [--test-module file --funded-synced dir]
 *
 * --funded-in names a copy of a funded test wallet (keys.bin, cache.bin, password.txt) and
 * --funded-expect its expected history (JSON, FundedExpectations); both come from outside the public
 * tree and select checks N20 and N22, which are reported as not run without them. --funded-out receives the
 * synced bytes of N20 (0600) for a later comparison with another implementation, --funded-build-out those
 * of N22 (with the password) for N23; the inputs are never written. N23 runs in direct mode with the test
 * module (--test-module, the instrumented module) and opens --funded-synced without a sync.
 *
 * The seed directory (test output only, never published) holds a disposable wallet without funds saved
 * by the measured fresh sync, so later runs reopen it and sync a few blocks only. Writes a
 * sanitized JSON report; exit code 0 only if every requested check ran and passed, 3 if every check
 * that ran passed and at least one was not run (missing optional configuration), 1 otherwise.
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";
import LibraryUtils from "../../main/ts/common/LibraryUtils";
import { useTestModule, useTestModuleFile } from "../lifecycle/testSupport";
import { FundedExpectations, FundedInputs, NetworkTargets, RequestRecorder, SeedWallet, installRequestRecorder, runNetworkChecks } from "./NetworkChecks";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<number> {
  const mode = arg("mode");
  const out = arg("out");
  const targetsFile = arg("targets");
  const marker = arg("marker");
  const checks = (arg("checks") ?? "").split(",").filter((c) => /^N[0-9]{2}$/.test(c));
  if ((mode !== "direct" && mode !== "worker") || out === undefined || targetsFile === undefined || marker === undefined || checks.length === 0) {
    process.stderr.write("usage: runNetworkNode --mode direct|worker --out f --targets f --marker t --checks N01,... [--seed-in d] [--seed-out d]\n");
    return 2;
  }
  const targets = JSON.parse(fs.readFileSync(targetsFile, "utf8")) as NetworkTargets;
  const seedIn = arg("seed-in");
  const seedOut = arg("seed-out");
  let seed: SeedWallet | undefined = undefined;
  if (seedIn !== undefined) seed = { keys: new Uint8Array(fs.readFileSync(path.join(seedIn, "keys.bin"))), cache: new Uint8Array(fs.readFileSync(path.join(seedIn, "cache.bin"))), password: fs.readFileSync(path.join(seedIn, "password.txt"), "utf8") };
  const saveSeed = seedOut === undefined ? undefined : async (s: SeedWallet): Promise<void> => {
    fs.mkdirSync(seedOut, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(seedOut, "keys.bin"), s.keys, { mode: 0o600 });
    fs.writeFileSync(path.join(seedOut, "cache.bin"), s.cache, { mode: 0o600 });
    fs.writeFileSync(path.join(seedOut, "password.txt"), s.password, { mode: 0o600 });
  };
  const fundedIn = arg("funded-in");
  const fundedExpect = arg("funded-expect");
  const fundedOut = arg("funded-out");
  let funded: FundedInputs | undefined = undefined;
  if (fundedIn !== undefined && fundedExpect !== undefined) {
    const wallet = { keys: new Uint8Array(fs.readFileSync(path.join(fundedIn, "keys.bin"))), cache: new Uint8Array(fs.readFileSync(path.join(fundedIn, "cache.bin"))), password: fs.readFileSync(path.join(fundedIn, "password.txt"), "utf8").replace(/\n$/, "") };
    const expect = JSON.parse(fs.readFileSync(fundedExpect, "utf8")) as FundedExpectations;
    const saveSynced = fundedOut === undefined ? undefined : async (s: SeedWallet): Promise<void> => {
      if (fs.existsSync(fundedOut)) throw new Error("--funded-out must name a new directory");
      fs.mkdirSync(fundedOut, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(fundedOut, "keys.bin"), s.keys, { mode: 0o600 });
      fs.writeFileSync(path.join(fundedOut, "cache.bin"), s.cache, { mode: 0o600 });
    };
    funded = { wallet, expect, saveSynced };
  } else if (fundedIn !== undefined || fundedExpect !== undefined) {
    process.stderr.write("--funded-in and --funded-expect go together\n");
    return 2;
  }
  const buildOut = arg("funded-build-out");
  const saveBuildSynced = buildOut === undefined ? undefined : async (s: SeedWallet): Promise<void> => {
    if (fs.existsSync(buildOut)) throw new Error("--funded-build-out must name a new directory");
    fs.mkdirSync(buildOut, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(buildOut, "keys.bin"), s.keys, { mode: 0o600 });
    fs.writeFileSync(path.join(buildOut, "cache.bin"), s.cache, { mode: 0o600 });
    fs.writeFileSync(path.join(buildOut, "password.txt"), s.password, { mode: 0o600 });
  };
  const syncedIn = arg("funded-synced");
  const fundedSynced: SeedWallet | undefined = syncedIn === undefined ? undefined : { keys: new Uint8Array(fs.readFileSync(path.join(syncedIn, "keys.bin"))), cache: new Uint8Array(fs.readFileSync(path.join(syncedIn, "cache.bin"))),
    password: fs.readFileSync(path.join(syncedIn, "password.txt"), "utf8").replace(/\n$/, "") };
  const testModule = arg("test-module");
  const artifacts: Record<string, string> = {};
  if (testModule !== undefined) {
    if (mode !== "direct") { process.stderr.write("--test-module needs --mode direct\n"); return 2; }
    const moduleFile = path.resolve(testModule);
    useTestModuleFile(moduleFile.replace(/\.js$/, ".wasm"));
    await useTestModule(() => require(moduleFile));
    artifacts["zephyr.test.js"] = crypto.createHash("sha256").update(fs.readFileSync(moduleFile)).digest("hex");
  }
  let recorder: RequestRecorder | undefined = undefined;
  if (mode === "direct") recorder = installRequestRecorder(async (b: Uint8Array) => crypto.createHash("sha256").update(b).digest("hex"));
  const log = (line: string): void => { process.stdout.write(line + "\n"); };
  const report = await runNetworkChecks({ env: mode === "direct" ? "node-direct" : "node-worker", proxyToWorker: mode === "worker", targets, marker, checks, seed, saveSeed, funded, saveBuildSynced, fundedSynced, recorder, log });
  const output = Object.assign({}, report, { node: process.version, platform: process.platform + "-" + process.arch, artifacts: { ...artifacts, "zephyr.js": crypto.createHash("sha256").update(fs.readFileSync(path.resolve(__dirname, "../../../zephyr.js"))).digest("hex"), ...(mode === "worker" ? { "ZephyrWebWorker.js": crypto.createHash("sha256").update(fs.readFileSync(LibraryUtils.WORKER_DIST_PATH)).digest("hex") } : {}) } });
  fs.writeFileSync(out, JSON.stringify(output, null, 2) + "\n");
  process.stdout.write("checks: " + report.checks.map((c) => c.id + "=" + c.status).join(" ") + "\n");
  if (LibraryUtils.WORKER) await LibraryUtils.terminateWorker();
  if (report.checks.length !== checks.length || report.checks.some((c) => c.status !== "pass" && c.status !== "not-run")) return 1;
  return report.checks.every((c) => c.status === "pass") ? 0 : 3;
}

main().then((code) => process.exit(code), (err) => {
  process.stderr.write("runner failed: " + (err instanceof Error ? err.name : typeof err) + "\n");
  process.exit(1);
});
