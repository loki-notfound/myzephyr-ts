/**
 * Node runner of the relay checks against constructed daemons (test only): starts the loopback servers of
 * redirectServers.cjs in this process (their /sink/<mode> daemons) and a closed loopback port, makes the instrumented
 * test module this context's module, and runs RelayChecks.ts with a wallet in the main thread.
 *
 *   node --require nodeMonitor.cjs runRelayNode.js --test-module dist/zephyr.test.js --out report.json
 *
 * The preloaded network monitor blocks every connection except to the two servers and the closed port, whose
 * addresses it learns from LIFECYCLE_MONITOR_ALLOW_CONNECT (set here before any wallet starts). Exit code 0 only if
 * the check passed.
 */
import crypto from "crypto";
import fs from "fs";
import net from "net";
import path from "path";
import { useTestModule, useTestModuleFile } from "../lifecycle/testSupport";
import { runRelayChecks } from "./RelayChecks";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<number> {
  const out = arg("out");
  const testModule = arg("test-module");
  if (out === undefined || testModule === undefined) {
    process.stderr.write("usage: runRelayNode --test-module file --out report.json\n");
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
  useTestModuleFile(moduleFile.replace(/\.js$/, ".wasm"));
  await useTestModule(() => require(moduleFile));
  let result;
  try {
    result = await runRelayChecks({ first: servers.first, closed: "http://127.0.0.1:" + closedPort, marker: RELAY_MARKER as string,
      sinkStats: async () => { const s = servers.snapshot().sink; return { requests: s.requests, bodyLengths: s.bodyLengths }; } });
  } finally {
    await servers.close();
  }
  const sinkStats = servers.snapshot().sink;
  const report = { checks: [result.check], relay: { outcomes: result.outcomes, submitsPerCall: result.submitsPerCall, permits: result.permits, sinkRequests: result.sinkRequests, sinkByMode: sinkStats.byMode,
    sinkBodyLengthsDistinct: Array.from(new Set(sinkStats.bodyLengths as number[])).length, passedInTransport: result.passedInTransport, refusedInTransport: result.refusedInTransport },
    node: process.version, artifacts: { "zephyr.test.js": crypto.createHash("sha256").update(fs.readFileSync(moduleFile)).digest("hex") } };
  fs.writeFileSync(out, JSON.stringify(report, null, 2) + "\n");
  process.stdout.write("checks: " + report.checks.map((c) => c.id + "=" + c.status).join(" ") + "\n");
  for (const c of report.checks) if (c.status === "fail") process.stdout.write(c.id + ": " + c.notes.join("; ").substring(0, 1200) + "\n");
  return report.checks.every((c) => c.status === "pass") ? 0 : 1;
}

main().then((code) => process.exit(code), (err) => { process.stderr.write("relay runner failed: " + (err && err.name) + "\n"); process.exit(1); });
