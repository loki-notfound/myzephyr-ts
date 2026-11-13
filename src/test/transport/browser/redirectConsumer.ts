/**
 * Browser page of the redirect checks (test only), served by runChromium.cjs --redirect with the
 * release worker bundle. Runs RedirectChecks.ts with a wallet in the page itself (direct) and with a
 * wallet in its own worker, against the loopback servers whose origins the runner allows in
 * connect-src, then the history check of HistoryRequestCheck.ts and the pool refresh check of
 * PoolRefreshCheck.ts in both, and posts the reports and
 * every policy violation to /result.
 */
import { setWorkerDistPath, terminateWorker } from "../../../main/ts/index";
import { RedirectReport, RedirectServerStats, runRedirectChecks } from "../RedirectChecks";
import { runHistoryRequestCheck } from "../HistoryRequestCheck";
import { runPoolRefreshCheck } from "../PoolRefreshCheck";
import { runRelayRefusalCheck } from "../RelayRefusalCheck";

async function run(): Promise<void> {
  const violations: string[] = [];
  document.addEventListener("securitypolicyviolation", (e: SecurityPolicyViolationEvent) => { violations.push(e.effectiveDirective); });
  setWorkerDistPath("/zephyr.worker.js");
  let payload: unknown;
  try {
    const targets = await (await fetch("/redirect-targets.json", { cache: "no-store" })).json() as { first: string; marker: string };
    const stats = async (): Promise<RedirectServerStats> => (await fetch(targets.first + "/__stats", { cache: "no-store" })).json() as Promise<RedirectServerStats>;
    const reports: RedirectReport[] = [];
    for (const [env, mode] of [["chromium-page", "direct"], ["chromium-worker", "worker"]] as const) {
      const r = await runRedirectChecks(env, mode, { first: targets.first, stats });
      const h = await runHistoryRequestCheck(mode, { first: targets.first, stats });
      const p = await runPoolRefreshCheck(mode, { first: targets.first, stats, marker: targets.marker });
      const s = mode === "direct" ? await runRelayRefusalCheck({ first: targets.first, stats }) : undefined;
      reports.push(Object.assign({}, r, { checks: r.checks.concat([h.check, p.check], s === undefined ? [] : [s.check]),
        relay: s === undefined ? undefined : { refused: s.refused, attempts: s.attempts, daemonRequestsDuringAttempts: s.daemonRequestsDuringAttempts, controlRequests: s.controlRequests }, history: { requestsBeforeHistory: h.requestsBeforeHistory, requestsDuringHistory: h.requestsDuringHistory, historyCalls: h.historyCalls },
        pool: { steps: p.steps, poolTxRequests: p.poolTxRequests } }));
    }
    await terminateWorker();
    const checks = reports.flatMap((r) => r.checks.map((c) => Object.assign({}, c, { id: c.id + "-" + r.mode })));
    payload = { env: "chromium", userAgent: navigator.userAgent, reports, checks, violations };
  } catch (err) {
    payload = { env: "chromium", fatal: err instanceof Error ? err.name : typeof err, violations };
  }
  await fetch("/result", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
}

run();
