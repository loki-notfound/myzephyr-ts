/**
 * Loading of the separately shipped WebAssembly module (test only), shared by the Node probe and the
 * browser page. One case per fresh runtime, because a runtime compiles the module once:
 *   ok          default location: a wallet is created, answers and closes; one compilation in this runtime
 *   missing     a location without a file: NATIVE_ERROR/WASM_MODULE_UNAVAILABLE before any worker starts
 *   invalid     a file that is not WebAssembly: NATIVE_ERROR/WASM_MODULE_MISMATCH, nothing compiled
 *   foreign     a valid WebAssembly module of another program: NATIVE_ERROR/WASM_MODULE_MISMATCH
 *   changed     zephyr.wasm with one byte changed: NATIVE_ERROR/WASM_MODULE_MISMATCH
 *   otherbuild  a valid module of another build of this program: NATIVE_ERROR/WASM_MODULE_MISMATCH
 *   rejected    a file that is not WebAssembly, declared as the expected digest (test override of
 *               the embedded digest): NATIVE_ERROR/WASM_MODULE_REJECTED after one compilation attempt
 *   recover     missing first, then the default location: the failure is not cached
 *   unverified  the default location in a runtime without Web Crypto (globalThis.crypto hidden, as on
 *               a page outside a secure context): NATIVE_ERROR/WASM_MODULE_UNVERIFIED, nothing compiled
 * Every failure is reported before any worker starts.
 */
import * as F from "../../main/ts/index";
import LibraryUtils from "../../main/ts/common/LibraryUtils";

export type ModuleCase = "ok" | "missing" | "invalid" | "foreign" | "changed" | "otherbuild" | "rejected" | "recover" | "unverified";

export const MODULE_CASES: readonly ModuleCase[] = ["ok", "missing", "invalid", "foreign", "changed", "otherbuild", "rejected", "recover", "unverified"];

export interface ModuleLocations {
  readonly missing: string;
  readonly invalid: string;
  readonly foreign: string;
  readonly changed: string;
  readonly otherbuild: string;
  /** SHA-256 (hex) of the invalid file, declared as the expected digest in the case "rejected" */
  readonly invalidDigest: string;
}

export interface ModuleOutcome {
  readonly case: ModuleCase;
  readonly proxyToWorker: boolean;
  /** "ok" or CODE/DIAGNOSTIC of the first construction */
  readonly first: string;
  /** recover: outcome of the second construction at the default location */
  readonly second?: string;
  /** workers started by the SDK during the case */
  readonly workersStarted: number;
  /** compilations of the module in this runtime */
  readonly compilations: number;
}

function outcomeOf(err: unknown): string {
  return err instanceof F.ZephyrWalletError ? err.code + "/" + (err.diagnostic ?? "") : "other:" + (err instanceof Error ? err.name : typeof err);
}

async function construct(proxy: boolean): Promise<string> {
  let w: F.ZephyrWallet | undefined;
  try {
    w = await F.createRandomWallet({ networkType: 0, password: "", proxyToWorker: proxy });
    const address = await w.getPrimaryAddress();
    if (typeof address !== "string" || address.length < 90) return "bad-address";
    await w.close();
    return "ok";
  } catch (err) {
    if (w !== undefined) await w.close().catch(() => undefined);
    return outcomeOf(err);
  }
}

export async function runModuleCase(kind: ModuleCase, proxy: boolean, locations: ModuleLocations): Promise<ModuleOutcome> {
  const startedBefore = LibraryUtils.getWorkerAccounting().workersStarted;
  let first: string;
  let second: string | undefined;
  if (kind === "ok") first = await construct(proxy);
  else if (kind === "unverified") {
    Object.defineProperty(globalThis, "crypto", { value: undefined, configurable: true, writable: true });
    first = await construct(proxy);
  } else {
    if (kind === "rejected") LibraryUtils.WASM_DIGEST_LOADER = () => locations.invalidDigest;
    F.setWasmModuleUrl(kind === "recover" ? locations.missing : kind === "rejected" ? locations.invalid : locations[kind]);
    first = await construct(proxy);
    if (kind === "recover") {
      F.setWasmModuleUrl(undefined);
      second = await construct(proxy);
    }
  }
  const outcome: ModuleOutcome = { case: kind, proxyToWorker: proxy, first, second, workersStarted: LibraryUtils.getWorkerAccounting().workersStarted - startedBefore, compilations: LibraryUtils.WASM_COMPILATIONS };
  await F.terminateWorker();
  return outcome;
}
