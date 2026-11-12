/**
 * Node runner of the redirect checks (test only): starts the two loopback servers of
 * redirectServers.cjs in this process and runs RedirectChecks.ts with a wallet in the main thread
 * (--mode direct) or in its own worker (--mode worker), with the release module.
 *
 *   node --require nodeMonitor.cjs runRedirectNode.js --mode direct|worker --out report.json
 *
 * The preloaded network monitor blocks every connection except to the two servers, whose addresses
 * it learns from LIFECYCLE_MONITOR_ALLOW_CONNECT (set here before any wallet or worker starts).
 * Exit code 0 only if every check passed.
 */
import fs from "fs";
import path from "path";
import { runRedirectChecks } from "./RedirectChecks";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<number> {
  const mode = arg("mode");
  const out = arg("out");
  if ((mode !== "direct" && mode !== "worker") || out === undefined) {
    process.stderr.write("usage: runRedirectNode --mode direct|worker --out report.json\n");
    return 2;
  }
  // the servers module is plain CommonJS beside this file's source
  const { startRedirectServers } = require(path.resolve(__dirname, "../../../../src/test/transport/redirectServers.cjs"));
  process.env.LIFECYCLE_MONITOR_LOOPBACK_LISTEN = "1";
  const servers = await startRedirectServers();
  process.env.LIFECYCLE_MONITOR_ALLOW_CONNECT = "127.0.0.1:" + servers.ports.first + ",127.0.0.1:" + servers.ports.second;
  let report;
  try {
    report = await runRedirectChecks("node-" + mode, mode, { first: servers.first, stats: async () => servers.snapshot() });
  } finally {
    await servers.close();
  }
  const final = Object.assign({}, report, { servers: { redirectsSent: servers.stats.redirectsSent, secondRequests: Object.values(servers.stats.second as Record<string, { requests: number }>).reduce((n, v) => n + v.requests, 0),
    landedRequests: Object.values(servers.stats.landed as Record<string, { requests: number }>).reduce((n, v) => n + v.requests, 0) } });
  fs.writeFileSync(out, JSON.stringify(final, null, 2) + "\n");
  process.stdout.write("checks: " + report.checks.map((c) => c.id + "=" + c.status).join(" ") + "\n");
  for (const c of report.checks) if (c.status === "fail") process.stdout.write(c.id + ": " + c.notes.join("; ").substring(0, 600) + "\n");
  return report.checks.every((c) => c.status === "pass") ? 0 : 1;
}

main().then((code) => process.exit(code), (err) => { process.stderr.write("redirect runner failed: " + (err && err.name) + "\n"); process.exit(1); });
