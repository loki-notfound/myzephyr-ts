/**
 * Node runner for the lifecycle checks.
 *
 *   --suite release      --mode direct|worker   release module (dist/zephyr.js) and release worker
 *   --suite instrumented --mode direct|worker   test module (--test-module) and the Node test worker
 *
 * Writes a sanitized JSON report to --out with the SHA256 of the module and worker files used.
 * Exit code 0 only if every executed check passed; a separate validation can require
 * the exact applicable check set.
 */
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { LifecycleReport, runLifecycleChecks } from "./LifecycleChecks";
import { runInstrumentedChecks } from "./InstrumentedChecks";
import { RawWorker, useTestModule, useTestModuleFile } from "./testSupport";
import LibraryUtils from "../../main/ts/common/LibraryUtils";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function sha256(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

async function main(): Promise<number> {
  const mode = arg("mode");
  const suite = arg("suite");
  const out = arg("out");
  const testModule = arg("test-module");
  if ((mode !== "direct" && mode !== "worker") || (suite !== "release" && suite !== "instrumented") || out === undefined || (suite === "instrumented" && testModule === undefined)) {
    process.stderr.write("usage: runNode --suite release|instrumented --mode direct|worker --out report.json [--test-module file]\n");
    return 2;
  }
  const proxy = mode === "worker";
  const distRoot = path.resolve(__dirname, "../../..");
  const artifacts: Record<string, string> = {};
  if (suite === "release") {
    artifacts["zephyr.js"] = sha256(path.join(distRoot, "zephyr.js"));
    artifacts["zephyr.wasm"] = sha256(path.join(distRoot, "zephyr.wasm"));
    if (proxy) artifacts["ZephyrWebWorker.js"] = sha256(LibraryUtils.WORKER_DIST_PATH);
  } else {
    const moduleFile = path.resolve(testModule as string);
    const wasmFile = moduleFile.replace(/\.js$/, ".wasm");
    artifacts["zephyr.test.js"] = sha256(moduleFile);
    artifacts["zephyr.test.wasm"] = sha256(wasmFile);
    useTestModuleFile(wasmFile); // compiled once here; worker mode posts it to every test worker
    if (proxy) {
      process.env.LIFECYCLE_TEST_MODULE = moduleFile;
      const workerFile = path.join(__dirname, "testWorkerNode.js");
      LibraryUtils.setWorkerDistPath(workerFile);
      artifacts["testWorkerNode.js"] = sha256(workerFile);
    } else {
      await useTestModule(() => require(moduleFile));
    }
  }
  const log = (line: string): void => { process.stdout.write(line + "\n"); };
  const opts = { env: "node-" + mode, proxyToWorker: proxy, log };
  const report: LifecycleReport = suite === "release" ? await runLifecycleChecks(opts) : await runInstrumentedChecks(opts);
  const workerLoaded = LibraryUtils.WORKER !== undefined;
  const output = Object.assign({}, report, { rawWorkersStarted: RawWorker.started, node: process.version, platform: process.platform + "-" + process.arch, workerLoaded, workerPath: proxy ? LibraryUtils.WORKER_DIST_PATH.replace(os.homedir(), "~") : undefined, artifacts });
  fs.writeFileSync(out, JSON.stringify(output, null, 2) + "\n");
  const failed = report.checks.filter((c) => c.status === "fail").length;
  process.stdout.write("checks: " + report.checks.map((c) => c.id + "=" + c.status).join(" ") + "\n");
  if (LibraryUtils.WORKER) await LibraryUtils.terminateWorker();
  return failed === 0 ? 0 : 1;
}

main().then((code) => process.exit(code), (err) => {
  process.stderr.write("runner failed: " + (err instanceof Error ? err.name : typeof err) + "\n");
  process.exit(1);
});
