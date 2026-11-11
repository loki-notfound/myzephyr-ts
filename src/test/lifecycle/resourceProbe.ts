/**
 * Bounded lookahead resource probe, one measurement case per Node process.
 *
 *   resourceProbe --module release|test --module-file <file> --case <name> [--major N --minor N] --out <file>
 *
 * Creates a disposable random wallet with the given subaddress lookahead (or the core default
 * when no pair is given), serializes it, reopens it from keys and cache bytes and from keys
 * bytes only, and restores it from its seed with the same lookahead. Records elapsed times,
 * byte sizes, WASM linear memory and (test module only) allocator bytes in use. The values are
 * bounded by the caller (run-resources.sh); this probe refuses pairs above its own hard cap so a
 * typo cannot allocate an extreme table. No network, no file writes besides the result.
 */
import fs from "fs";
import * as F from "../../main/ts/index";
import * as Internal from "../../main/ts/wallet/ZephyrWallet"; // not exported by the package entry
import LibraryUtils from "../../main/ts/common/LibraryUtils";
import { useTestModule } from "./testSupport";
import { randomPassword } from "./LifecycleChecks";

const HARD_CAP_PER_VALUE = 400;
const HARD_CAP_PRODUCT = 20000;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function ms(start: bigint): number {
  return Number((process.hrtime.bigint() - start) / BigInt(1000)) / 1000;
}

async function main(): Promise<number> {
  const kind = arg("module"); const moduleFile = arg("module-file"); const caseName = arg("case"); const out = arg("out");
  const majorArg = arg("major"); const minorArg = arg("minor");
  if ((kind !== "release" && kind !== "test") || moduleFile === undefined || caseName === undefined || out === undefined || (majorArg === undefined) !== (minorArg === undefined)) {
    process.stderr.write("usage: resourceProbe --module release|test --module-file f --case name [--major N --minor N] --out f\n");
    return 2;
  }
  const major = majorArg === undefined ? undefined : Number(majorArg);
  const minor = minorArg === undefined ? undefined : Number(minorArg);
  if (major !== undefined && minor !== undefined) {
    if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || major < 1 || minor < 1 || major > HARD_CAP_PER_VALUE || minor > HARD_CAP_PER_VALUE || major * minor > HARD_CAP_PRODUCT) {
      process.stderr.write("lookahead pair outside the probe's hard cap\n");
      return 2;
    }
  }
  const tLoad = process.hrtime.bigint();
  if (kind === "test") await useTestModule(() => require(moduleFile), moduleFile.replace(/\.js$/, ".wasm"));
  else { LibraryUtils.setWasmModuleLocation(moduleFile.replace(/\.js$/, ".wasm")); await LibraryUtils.loadWasmModule(); }
  const module = LibraryUtils.getWasmModule();
  const loadMs = ms(tLoad);
  const mem = (): number => module.HEAPU8.length;
  const heap = (): number | undefined => (kind === "test" ? module.test_heap_in_use() : undefined);
  const lookahead = major === undefined ? {} : { accountLookahead: major, subaddressLookahead: minor };
  const pw = randomPassword();
  const result: Record<string, unknown> = { case: caseName, module: kind, major: major ?? null, minor: minor ?? null, node: process.version, platform: process.platform + "-" + process.arch };
  result.loadMs = loadMs;
  result.memBefore = mem(); result.heapBefore = heap();

  let t = process.hrtime.bigint();
  const w = await F.createRandomWallet({ networkType: 0, password: pw, proxyToWorker: false, ...lookahead });
  result.createMs = ms(t); result.memAfterCreate = mem(); result.heapAfterCreate = heap();
  const seed = await w.getSeed();
  const address = await w.getPrimaryAddress();
  const lastMajor = (major ?? 50) - 1; const lastMinor = (minor ?? 200) - 1;
  const edge = await w.getAddress(lastMajor, lastMinor); // inside the lookahead table
  t = process.hrtime.bigint();
  const d = await w.getData();
  result.getDataMs = ms(t); result.keysBytes = d.keys.length; result.cacheBytes = d.cache.length;
  t = process.hrtime.bigint();
  await w.close();
  result.closeMs = ms(t); result.memAfterClose = mem(); result.heapAfterClose = heap();

  t = process.hrtime.bigint();
  const o = await F.openWalletData({ networkType: 0, password: pw, keysData: d.keys, cacheData: d.cache, proxyToWorker: false });
  result.openMs = ms(t); result.memAfterOpen = mem(); result.heapAfterOpen = heap();
  result.openAddressMatch = (await o.getPrimaryAddress()) === address && (await o.getAddress(lastMajor, lastMinor)) === edge;
  await o.close();
  result.heapAfterOpenClose = heap();

  t = process.hrtime.bigint();
  const k = await F.openWalletData({ networkType: 0, password: pw, keysData: d.keys, cacheData: new Uint8Array(0), proxyToWorker: false });
  result.openKeysOnlyMs = ms(t); result.memAfterOpenKeysOnly = mem(); result.heapAfterOpenKeysOnly = heap();
  const kd = await k.getData();
  result.cacheBytesAfterKeysOnlyOpen = kd.cache.length;
  result.keysOnlyAddressMatch = (await k.getPrimaryAddress()) === address;
  await k.close();

  t = process.hrtime.bigint();
  const r = await F.restoreWalletFromSeed({ networkType: 0, password: pw, seed, proxyToWorker: false, ...lookahead });
  result.restoreMs = ms(t); result.memAfterRestore = mem(); result.heapAfterRestore = heap();
  const rd = await r.getData();
  result.restoreCacheBytes = rd.cache.length;
  result.restoreAddressMatch = (await r.getPrimaryAddress()) === address && (await r.getAddress(lastMajor, lastMinor)) === edge;
  await r.close();
  result.memFinal = mem(); result.heapFinal = heap();

  // bounded failure accounting (test module, default case only): allocator bytes in use after
  // repeated rejected opens (wrong password) and rejected seed restores (bad checksum)
  if (kind === "test" && major === undefined) {
    const failures = 5;
    const h0 = heap() as number;
    for (let i = 0; i < failures; i++) {
      try { await F.openWalletData({ networkType: 0, password: pw + "-wrong", keysData: d.keys, cacheData: d.cache, proxyToWorker: false }); result.failedOpenUnexpected = true; } catch (err) { /* expected WRONG_PASSWORD */ }
    }
    const h1 = heap() as number;
    const words = seed.split(" ");
    const replacement = words.slice(0, 24).find((x) => x.substring(0, 3) !== words[24].substring(0, 3)) as string;
    const badSeed = words.slice(0, 24).concat([replacement]).join(" ");
    for (let i = 0; i < failures; i++) {
      try { await F.restoreWalletFromSeed({ networkType: 0, password: pw, seed: badSeed, proxyToWorker: false }); result.failedRestoreUnexpected = true; } catch (err) { /* expected INVALID_RECOVERY_MATERIAL */ }
    }
    const h2 = heap() as number;
    result.failureAccounting = { failures, wrongPasswordOpenHeapDelta: h1 - h0, badSeedRestoreHeapDelta: h2 - h1 };
  }
  const guard = await Internal.getNetworkGuardReport();
  result.httpClientRequests = guard.mainBlockedRequests;
  result.status = result.openAddressMatch === true && result.keysOnlyAddressMatch === true && result.restoreAddressMatch === true && guard.mainBlockedRequests === 0 && result.failedOpenUnexpected === undefined && result.failedRestoreUnexpected === undefined ? "ok" : "mismatch";
  fs.writeFileSync(out, JSON.stringify(result, null, 1) + "\n");
  return result.status === "ok" ? 0 : 1;
}

main().then((code) => process.exit(code), (err) => {
  process.stderr.write("probe failed: " + (err instanceof Error ? err.name : typeof err) + " " + (err && typeof err === "object" && "code" in err ? String((err as { code: unknown }).code) : "") + "\n");
  process.exit(1);
});
