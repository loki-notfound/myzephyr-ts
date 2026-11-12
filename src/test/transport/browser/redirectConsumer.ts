/**
 * Browser page of the redirect checks (test only), served by runChromium.cjs --redirect with the
 * release worker bundle. Runs RedirectChecks.ts with a wallet in the page itself (direct) and with a
 * wallet in its own worker, against the loopback servers whose origins the runner allows in
 * connect-src, and posts the reports and every policy violation to /result.
 */
import { setWorkerDistPath, terminateWorker } from "../../../main/ts/index";
import { RedirectReport, RedirectServerStats, runRedirectChecks } from "../RedirectChecks";

async function run(): Promise<void> {
  const violations: string[] = [];
  document.addEventListener("securitypolicyviolation", (e: SecurityPolicyViolationEvent) => { violations.push(e.effectiveDirective); });
  setWorkerDistPath("/zephyr.worker.js");
  let payload: unknown;
  try {
    const targets = await (await fetch("/redirect-targets.json", { cache: "no-store" })).json() as { first: string };
    const stats = async (): Promise<RedirectServerStats> => (await fetch(targets.first + "/__stats", { cache: "no-store" })).json() as Promise<RedirectServerStats>;
    const reports: RedirectReport[] = [];
    reports.push(await runRedirectChecks("chromium-page", "direct", { first: targets.first, stats }));
    reports.push(await runRedirectChecks("chromium-worker", "worker", { first: targets.first, stats }));
    await terminateWorker();
    const checks = reports.flatMap((r) => r.checks.map((c) => Object.assign({}, c, { id: c.id + "-" + r.mode })));
    payload = { env: "chromium", userAgent: navigator.userAgent, reports, checks, violations };
  } catch (err) {
    payload = { env: "chromium", fatal: err instanceof Error ? err.name : typeof err, violations };
  }
  await fetch("/result", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
}

run();
