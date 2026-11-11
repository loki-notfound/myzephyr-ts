/**
 * Browser page for the loading of the WebAssembly module and its Content-Security-Policy (test only).
 * Query: case=<a case of moduleScenario.ts>|policy, optional otherbuild=<path> (default /otherbuild.wasm).
 * The page uses the release worker bundle and the module at its default location /zephyr.wasm;
 * /index.html serves as a file that is not WebAssembly, /foreign.wasm as a module of another
 * program, /changed.wasm as zephyr.wasm with one byte changed and /otherbuild.wasm as a module of
 * another build. The case "policy" creates a wallet
 * in a worker with a daemon on another origin (http://localhost:<port>, which resolves to nothing
 * in the contained browser), so the worker's daemon request meets its connect-src. The outcome and
 * every policy violation the page sees are posted to /result.
 */
import { createRandomWallet, setWorkerDistPath, terminateWorker, ZephyrWalletError } from "../../../main/ts/index";
import LibraryUtils from "../../../main/ts/common/LibraryUtils";
import { ModuleCase, runModuleCase } from "../moduleScenario";

async function run(): Promise<void> {
  const violations: string[] = [];
  document.addEventListener("securitypolicyviolation", (e: SecurityPolicyViolationEvent) => { violations.push(e.effectiveDirective + " " + e.blockedURI.substring(0, 60)); });
  const kind = new URLSearchParams(location.search).get("case") as ModuleCase;
  setWorkerDistPath("/zephyr.worker.js");
  let payload: unknown;
  try {
    const query = new URLSearchParams(location.search);
    const outcome = (kind as string) === "policy" ? await policyCase() : await runModuleCase(kind, true, { missing: "/absent/zephyr.wasm", invalid: "/index.html", foreign: "/foreign.wasm",
      changed: "/changed.wasm", otherbuild: query.get("otherbuild") ?? "/otherbuild.wasm", invalidDigest: kind === "rejected" ? await digestOf("/index.html") : "" });
    payload = { env: "chromium-worker", userAgent: navigator.userAgent, outcome, violations };
  } catch (err) {
    payload = { env: "chromium-worker", fatal: err instanceof Error ? err.name : typeof err, violations };
  }
  await fetch("/result", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
}

/** SHA-256 (hex) of a file served by the runner (the case "rejected" declares it as the expected digest). */
async function digestOf(url: string): Promise<string> {
  const bytes = await (await fetch(url, { cache: "no-store" })).arrayBuffer();
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (b) => (b < 16 ? "0" : "") + b.toString(16)).join("");
}

/** A wallet with a daemon on another origin: created, not connected, answers and closes. */
async function policyCase(): Promise<unknown> {
  let first: string;
  try {
    const w = await createRandomWallet({ networkType: 0, password: "", server: "http://localhost:" + location.port });
    const connected = await w.isConnectedToDaemon();
    const address = await w.getPrimaryAddress();
    await w.close();
    first = connected === false && typeof address === "string" && address.length > 90 ? "ok-not-connected" : "unexpected";
  } catch (err) {
    first = err instanceof ZephyrWalletError ? err.code + "/" + (err.diagnostic ?? "") : "other";
  }
  const outcome = { case: "policy", proxyToWorker: true, first, workersStarted: LibraryUtils.getWorkerAccounting().workersStarted, compilations: LibraryUtils.WASM_COMPILATIONS };
  await terminateWorker();
  return outcome;
}

run();
