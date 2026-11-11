/**
 * Network-stage page (test only). Served by the test-owned loopback forwarder with
 * an explicit CSP; the worker is the release worker bundle /zephyr.worker.js. The page learns the
 * forwarder's ports from /targets.json, fetches the disposable seed wallet from /seed/*, runs the
 * shared network checks in real browser workers and posts the sanitized report to /result.
 */
import { setWorkerDistPath } from "../../../main/ts/index";
import LibraryUtils from "../../../main/ts/common/LibraryUtils";
import { NetworkTargets, runNetworkChecks } from "../NetworkChecks";

function status(text: string): void {
  const el = document.getElementById("status");
  if (el) el.textContent = text;
}

async function bytes(path: string): Promise<Uint8Array> {
  const r = await fetch(path, { cache: "no-store" });
  if (!r.ok) throw new Error("fetch failed");
  return new Uint8Array(await r.arrayBuffer());
}

async function main(): Promise<void> {
  const requests: string[] = [];
  let payload: unknown;
  try {
    const config = await (await fetch("/targets.json", { cache: "no-store" })).json() as { targets: NetworkTargets; marker: string; checks: string[] };
    // the seed wallet of the measured restore; a run of checks that do not reopen it has none (404)
    const seed = (await fetch("/seed/keys", { method: "GET", cache: "no-store" })).ok
      ? { keys: await bytes("/seed/keys"), cache: await bytes("/seed/cache"), password: new TextDecoder().decode(await bytes("/seed/password")) } : undefined;
    const origFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url !== "/result") requests.push("fetch " + url.substring(0, 60));
      return origFetch(input, init);
    };
    setWorkerDistPath("/zephyr.worker.js");
    status("running");
    const report = await runNetworkChecks({ env: "chromium-worker", proxyToWorker: true, targets: config.targets, marker: config.marker, checks: config.checks, seed, log: (line: string) => status(line), deadlineMs: 600000 });
    payload = Object.assign({}, report, { userAgent: navigator.userAgent, pageLocation: location.origin, workerScript: LibraryUtils.WORKER_DIST_PATH, pageRequests: requests });
  } catch (err) {
    payload = { suite: "network", env: "chromium-worker", fatal: err instanceof Error ? err.name : typeof err, pageRequests: requests };
  }
  await fetch("/result", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  status("done");
}

main();
