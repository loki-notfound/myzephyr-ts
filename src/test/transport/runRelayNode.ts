/**
 * Node runner of the relay checks against constructed daemons (test only): starts the loopback servers of
 * redirectServers.cjs in this process (their /sink/<mode> daemons) and a closed loopback port, makes the instrumented
 * test module this context's module, and runs RelayChecks.ts: with --mode direct (the default) S03 and S04 with a
 * wallet in the main thread, with --mode worker S04 with a wallet in its own test worker (the Node test worker, which
 * loads the same test module).
 *
 *   node --require nodeMonitor.cjs runRelayNode.js --test-module dist/zephyr.test.js --out report.json [--mode direct|worker]
 *
 * The preloaded network monitor blocks every connection except to the two servers and the closed port, whose
 * addresses it learns from LIFECYCLE_MONITOR_ALLOW_CONNECT (set here before any wallet starts). Exit code 0 only if
 * the check passed.
 */
import crypto from "crypto";
import fs from "fs";
import net from "net";
import path from "path";
import LibraryUtils from "../../main/ts/common/LibraryUtils";
import { DirectInstrumentation, WorkerInstrumentation, useTestModule, useTestModuleFile } from "../lifecycle/testSupport";
import { runRelayAllocationCheck, runRelayChecks } from "./RelayChecks";
import type { RelayAllocationResult, RelayCheckResult } from "./RelayChecks";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<number> {
  const out = arg("out");
  const testModule = arg("test-module");
  const mode = arg("mode") ?? "direct";
  if (out === undefined || testModule === undefined || (mode !== "direct" && mode !== "worker")) {
    process.stderr.write("usage: runRelayNode --test-module file --out report.json [--mode direct|worker]\n");
    return 2;
  }
  const { startRedirectServers, RELAY_MARKER } = require(path.resolve(__dirname, "../../../../src/test/transport/redirectServers.cjs"));
  process.env.LIFECYCLE_MONITOR_LOOPBACK_LISTEN = "1";
  const servers = await startRedirectServers();
  const closedServer = net.createServer();
  const closedPort = await new Promise<number>((resolve) => closedServer.listen(0, "127.0.0.1", () => resolve((closedServer.address() as net.AddressInfo).port)));
  await new Promise((resolve) => closedServer.close(resolve));
  process.env.LIFECYCLE_MONITOR_ALLOW_CONNECT = "127.0.0.1:" + servers.ports.first + ",127.0.0.1:" + servers.ports.second + ",127.0.0.1:" + closedPort;
  const moduleFile = path.resolve(testModule);
  useTestModuleFile(moduleFile.replace(/\.js$/, ".wasm")); // compiled once here; worker mode posts it to the test worker
  if (mode === "worker") {
    process.env.LIFECYCLE_TEST_MODULE = moduleFile;
    LibraryUtils.setWorkerDistPath(path.join(__dirname, "../lifecycle/testWorkerNode.js"));
  } else {
    await useTestModule(() => require(moduleFile));
  }
  const targets = { first: servers.first, closed: "http://127.0.0.1:" + closedPort, marker: RELAY_MARKER as string,
    sinkStats: async () => { const s = servers.snapshot().sink; return { requests: s.requests, bodyLengths: s.bodyLengths }; } };
  let result: RelayCheckResult | undefined;
  let allocation: RelayAllocationResult | undefined;
  let sinkStats: { byMode: unknown; bodyLengths: number[] } | undefined;
  try {
    if (mode === "direct") result = await runRelayChecks(targets);
    sinkStats = JSON.parse(JSON.stringify(servers.snapshot().sink)); // the sink's counts of S03 alone
    allocation = await runRelayAllocationCheck(targets, mode === "worker" ? new WorkerInstrumentation() : new DirectInstrumentation(), mode === "worker");
  } finally {
    await servers.close();
    if (LibraryUtils.WORKER) await LibraryUtils.terminateWorker();
  }
  if (allocation === undefined || sinkStats === undefined) return 1;
  const relay = result === undefined ? undefined : { outcomes: result.outcomes, submitsPerCall: result.submitsPerCall, permits: result.permits, sinkRequests: result.sinkRequests, sinkByMode: sinkStats.byMode,
    sinkBodyLengthsDistinct: Array.from(new Set(sinkStats.bodyLengths)).length, passedInTransport: result.passedInTransport, refusedInTransport: result.refusedInTransport };
  const report = { mode, checks: (result === undefined ? [] : [result.check]).concat([allocation.check]), relay, relayAllocation: { mode, deltas: allocation.deltas },
    node: process.version, artifacts: { "zephyr.test.js": crypto.createHash("sha256").update(fs.readFileSync(moduleFile)).digest("hex") } };
  fs.writeFileSync(out, JSON.stringify(report, null, 2) + "\n");
  process.stdout.write("checks: " + report.checks.map((c) => c.id + "=" + c.status).join(" ") + "\n");
  for (const c of report.checks) if (c.status === "fail") process.stdout.write(c.id + ": " + c.notes.join("; ").substring(0, 1200) + "\n");
  return report.checks.every((c) => c.status === "pass") ? 0 : 1;
}

main().then((code) => process.exit(code), (err) => { process.stderr.write("relay runner failed: " + (err && err.name) + "\n"); process.exit(1); });
