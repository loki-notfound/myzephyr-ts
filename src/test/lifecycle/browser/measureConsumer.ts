/**
 * Chromium worker isolation measurement page (test only). Runs the shared scenario with N live
 * wallets (from the page query) in dedicated measurement workers; at each mark it asks the
 * same-origin runner to sample the browser's processes, then posts the result to /result.
 */
import { setWorkerDistPath } from "../../../main/ts/index";
import { runIsolationScenario } from "../isolationScenario";

async function run(): Promise<void> {
  const n = Number(new URLSearchParams(location.search).get("wallets"));
  setWorkerDistPath("/zephyr.measure.worker.js");
  let payload: unknown;
  try {
    const mark = async (label: string): Promise<void> => { await fetch("/mark?label=" + encodeURIComponent(label), { method: "GET", cache: "no-store" }); };
    const result = await runIsolationScenario(n, true, mark);
    const memory = (performance as unknown as { memory?: { usedJSHeapSize: number; totalJSHeapSize: number } }).memory;
    payload = { env: "chromium", userAgent: navigator.userAgent, result, pageJsHeap: memory ? { used: memory.usedJSHeapSize, total: memory.totalJSHeapSize } : undefined };
  } catch (err) {
    payload = { env: "chromium", fatal: err instanceof Error ? err.name : typeof err };
  }
  await fetch("/result", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
}

run();
