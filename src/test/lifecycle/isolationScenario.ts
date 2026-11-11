/**
 * Worker isolation measurement scenario (test only), shared by the Node probe and the Chromium
 * measurement page: cold creation of N disposable random wallets, steady state, close of all,
 * with host-memory samples taken by the caller at each mark. Results hold timings, sizes and
 * counts only; no wallet material.
 */
import * as F from "../../main/ts/index";
import LibraryUtils from "../../main/ts/common/LibraryUtils";
import { randomPassword } from "./LifecycleChecks";
import { newMessageId, postRawWorkerMessage } from "./testSupport";

export interface WorkerMemory {
  readonly linearMemoryBytes: number;
  readonly jsHeapUsed: number | undefined;
  readonly jsHeapTotal: number | undefined;
  /** compilations of the WebAssembly module in that worker (0: it instantiated the runtime's shared module) */
  readonly wasmCompilations: number;
  readonly sharedModule: boolean;
}

export interface ScenarioResult {
  readonly wallets: number;
  readonly proxyToWorker: boolean;
  readonly createMs: number[];
  readonly closeMs: number[];
  readonly totalCreateMs: number;
  readonly workerMemory: WorkerMemory[];
  readonly accountingSteady: unknown;
  readonly accountingAfterClose: unknown;
  /** compilations of the WebAssembly module in the calling runtime (the page or the Node main thread) */
  readonly wasmCompilations: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runIsolationScenario(n: number, proxy: boolean, mark: (label: string) => Promise<void>): Promise<ScenarioResult> {
  await mark("baseline");
  const wallets: F.ZephyrWallet[] = [];
  const createMs: number[] = [];
  const t0 = Date.now();
  for (let i = 0; i < n; i++) {
    const t = Date.now();
    wallets.push(await F.createRandomWallet({ networkType: 0, password: randomPassword(), proxyToWorker: proxy }));
    createMs.push(Date.now() - t);
  }
  const totalCreateMs = Date.now() - t0;
  for (const w of wallets) await w.getPrimaryAddress(); // every wallet answers
  await sleep(2000);
  await mark("steady");
  const workerMemory: WorkerMemory[] = [];
  if (proxy) {
    for (const w of wallets) {
      const r = await postRawWorkerMessage([newMessageId(), "__measure", newMessageId()], 10000, w);
      if (!r.replied || r.error !== undefined) throw new Error("measurement worker did not answer");
      workerMemory.push(r.result as WorkerMemory);
    }
  }
  const accountingSteady = LibraryUtils.getWorkerAccounting();
  const closeMs: number[] = [];
  for (const w of wallets) {
    const t = Date.now();
    await w.close();
    closeMs.push(Date.now() - t);
  }
  await sleep(2000);
  await mark("after-close");
  return { wallets: n, proxyToWorker: proxy, createMs, closeMs, totalCreateMs, workerMemory, accountingSteady, accountingAfterClose: LibraryUtils.getWorkerAccounting(), wasmCompilations: LibraryUtils.WASM_COMPILATIONS };
}
