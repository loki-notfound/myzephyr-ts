/**
 * Node runner of the fee tier check against a constructed daemon (test only): starts priorityDaemon.cjs in this process,
 * makes the instrumented test module this context's module and runs PriorityChecks.ts (V03) with a wallet in the main
 * thread.
 *
 *   node --require nodeMonitor.cjs runPriorityNode.js --test-module dist/zephyr.test.js --out report.json
 *
 * The preloaded network monitor blocks every connection except to the daemon, whose address it learns from
 * LIFECYCLE_MONITOR_ALLOW_CONNECT (set here before any wallet starts). The report holds outcomes, request names and
 * counts only. Exit code 0 only if the check passed.
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { useTestModule, useTestModuleFile } from "../lifecycle/testSupport";
import { ZephyrWalletError } from "../../main/ts/index";
import { runPriorityChecks } from "./PriorityChecks";
import type { PriorityCheckResult } from "./PriorityChecks";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<number> {
  const out = arg("out");
  const testModule = arg("test-module");
  if (out === undefined || testModule === undefined) {
    process.stderr.write("usage: runPriorityNode --test-module file --out report.json\n");
    return 2;
  }
  const { startPriorityDaemon } = require(path.resolve(__dirname, "../../../../src/test/transport/priorityDaemon.cjs"));
  process.env.LIFECYCLE_MONITOR_LOOPBACK_LISTEN = "1";
  const daemon = await startPriorityDaemon();
  process.env.LIFECYCLE_MONITOR_ALLOW_CONNECT = "127.0.0.1:" + daemon.port;
  const moduleFile = path.resolve(testModule);
  useTestModuleFile(moduleFile.replace(/\.js$/, ".wasm"));
  await useTestModule(() => require(moduleFile));
  let result: PriorityCheckResult | undefined;
  try {
    result = await runPriorityChecks(daemon);
  } finally {
    await daemon.close();
  }
  const report = { mode: "direct", checks: [result.check], priority: { outcomes: result.outcomes, requests: result.requests, heightAfterSync: result.heightAfterSync, hooksPresent: result.hooksPresent },
    node: process.version, artifacts: { "zephyr.test.js": crypto.createHash("sha256").update(fs.readFileSync(moduleFile)).digest("hex") } };
  fs.writeFileSync(out, JSON.stringify(report, null, 2) + "\n");
  process.stdout.write("checks: " + report.checks.map((c) => c.id + "=" + c.status).join(" ") + "\n");
  for (const c of report.checks) if (c.status === "fail") process.stdout.write(c.id + ": " + c.notes.join("; ").substring(0, 2000) + "\n");
  return report.checks.every((c) => c.status === "pass") ? 0 : 1;
}

main().then((code) => process.exit(code), (err) => {
  const fixed = err instanceof ZephyrWalletError ? " " + err.code + "/" + String(err.diagnostic) : "";
  process.stderr.write("priority runner failed: " + (err && err.name) + fixed + "\n");
  process.exit(1);
});
