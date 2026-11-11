/**
 * Shared page logic of the static browser consumers (test only). Runs one suite through the
 * real browser worker under an explicit same-origin CSP and posts the sanitized report to the
 * same-origin /result endpoint. Every fetch/XHR other than that post, and every CSP violation
 * event, is recorded in the report (a passing run has only the one fetch of the WebAssembly module).
 */
import { LifecycleReport, runLifecycleChecks } from "../LifecycleChecks";
import { runInstrumentedChecks } from "../InstrumentedChecks";
import { setWasmModuleUrl, setWorkerDistPath } from "../../../main/ts/index";
import LibraryUtils from "../../../main/ts/common/LibraryUtils";
import { RawWorker } from "../testSupport";

interface PageMonitor {
  readonly requests: string[];
  readonly violations: string[];
}

const monitor: PageMonitor = { requests: [], violations: [] };

function installPageMonitor(): void {
  const origFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const isResultPost = url === "/result" && init !== undefined && init.method === "POST";
    if (!isResultPost) monitor.requests.push("fetch " + (url.startsWith("data:") ? "data:" : url.substring(0, 80)));
    return origFetch(input, init);
  };
  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
    monitor.requests.push("xhr " + method + " " + String(url).substring(0, 80));
    return (origOpen as (...a: unknown[]) => void).call(this, method, url, ...rest);
  } as typeof XMLHttpRequest.prototype.open;
  document.addEventListener("securitypolicyviolation", (e: SecurityPolicyViolationEvent) => {
    monitor.violations.push(e.effectiveDirective + " " + (e.blockedURI.startsWith("data:") ? "data:" : e.blockedURI.substring(0, 80)));
  });
}

function status(text: string): void {
  const el = document.getElementById("status");
  if (el) el.textContent = text;
}

/**
 * Count workers the page constructs and terminates (independent of the SDK's accounting).
 * A browser reports no event when a worker thread ends, so "ended" counts terminate() calls.
 */
function installWorkerCounter(): void {
  const NativeWorker = globalThis.Worker;
  let created = 0;
  let terminated = 0;
  class CountedWorker extends NativeWorker {
    constructor(url: string | URL, options?: WorkerOptions) { super(url, options); created++; }
    terminate(): void { terminated++; super.terminate(); }
  }
  (globalThis as unknown as { Worker: typeof Worker }).Worker = CountedWorker;
  (globalThis as unknown as { __lifecyclePageWorkers: () => { created: number; terminated: number } }).__lifecyclePageWorkers = () => ({ created, terminated });
}

export async function runPage(suite: "release" | "instrumented", workerPath: string, wasmUrl?: string): Promise<void> {
  installPageMonitor();
  installWorkerCounter();
  setWorkerDistPath(workerPath);
  if (wasmUrl !== undefined) setWasmModuleUrl(wasmUrl);
  status("running");
  let payload: unknown;
  try {
    const opts = { env: "chromium-worker", proxyToWorker: true, log: (line: string) => status(line), deadlineMs: 600000 };
    const report: LifecycleReport = suite === "release" ? await runLifecycleChecks(opts) : await runInstrumentedChecks(opts);
    payload = Object.assign({}, report, {
      rawWorkersStarted: RawWorker.started,
      userAgent: navigator.userAgent,
      workerConstructed: LibraryUtils.WORKER instanceof Worker,
      workerScript: LibraryUtils.WORKER_DIST_PATH,
      pageLocation: location.origin,
      pageMonitor: monitor
    });
  } catch (err) {
    payload = { suite, env: "chromium-worker", fatal: err instanceof Error ? err.name : typeof err, pageMonitor: monitor };
  }
  await fetch("/result", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  status("done");
}
