/**
 * Instrumented lifecycle checks, run only against the separately built test
 * module (ZEPHYR_TS_TEST_INSTRUMENTATION) in direct Node, the Node test worker and the Chromium
 * test worker. They use a deterministic native barrier, failure injection and allocator
 * accounting that the release module does not contain. Disposable wallets only; results hold
 * outcomes, counts and codes, never recovery material, passwords, keys or wallet bytes.
 */
import * as F from "../../main/ts/index";
import * as Internal from "../../main/ts/wallet/ZephyrWallet"; // not exported by the package entry
import LibraryUtils from "../../main/ts/common/LibraryUtils";
import { CheckFailure, CheckResult, LifecycleCheckOptions, LifecycleReport, brokenChecksumSeed, codeOf, copyBytes, diagnosticOf, expect, expectCode, openingPasswords, randomPassword, scanText, waitUntil, waitWorkerMonitor, withDeadline, workerMonitor } from "./LifecycleChecks";
import { DirectInstrumentation, Instrumentation, InstrumentationState, WorkerInstrumentation, channelOf, combinedGuard, innerOf, installGuardLedger, newMessageId, postRawWorkerMessage, walletIdOf } from "./testSupport";
import HttpClient from "../../main/ts/common/HttpClient";
import ZephyrWalletFull from "../../main/ts/wallet/ZephyrWalletFull";
import ZephyrWalletConfig from "../../main/ts/wallet/model/ZephyrWalletConfig";

export async function runInstrumentedChecks(opts: LifecycleCheckOptions): Promise<LifecycleReport> {
  const log = opts.log ?? (() => undefined);
  const proxy = opts.proxyToWorker;
  const report: LifecycleReport = { suite: "instrumented", env: opts.env, proxyToWorker: proxy, startedUtc: new Date().toISOString(), finishedUtc: "", checks: [], networkGuard: undefined, workerProof: undefined, nativeCloseCalls: undefined };
  const deadline = opts.deadlineMs ?? 180000;
  const hooks: Instrumentation = proxy ? new WorkerInstrumentation() : new DirectInstrumentation();
  installGuardLedger(); // Guard counts of each proxied wallet's worker are read by the test layer before its close

  async function check(id: string, title: string, fn: (notes: string[]) => Promise<void>, enabled = true): Promise<void> {
    const result: CheckResult = { id, title, status: "not-run", notes: [] };
    report.checks.push(result);
    if (!enabled) { result.notes.push("not applicable in this environment"); return; }
    try {
      await withDeadline(fn(result.notes), deadline, id);
      result.status = "pass";
    } catch (err) {
      result.status = "fail";
      result.notes.push("FAILED: " + (err instanceof CheckFailure ? err.message : codeOf(err) + (err instanceof F.ZephyrWalletError && err.diagnostic ? "/" + err.diagnostic : "")));
    }
    log(id + " " + result.status);
  }

  const pw = randomPassword();
  let keys = new Uint8Array(0);
  let cache = new Uint8Array(0);
  let address = "";
  const open = (password = pw): Promise<F.ZephyrWallet> => F.openWalletData({ networkType: 0, password, keysData: copyBytes(keys), cacheData: copyBytes(cache), proxyToWorker: proxy });
  const nativeCalls = (s: InstrumentationState, name: string): number => s.nativeCalls[name] ?? 0;

  await check("T00", "Test module loaded and instrumented in the execution context", async (notes) => {
    await hooks.install(); // worker mode: every SDK worker is started through the instrumenting test loader
    if (proxy) {
      const ping = await postRawWorkerMessage([newMessageId(), "getNetworkGuardReport", newMessageId()], 30000); // starts the utility test worker
      expect(ping.replied && ping.error === undefined, "test worker answers production messages");
      await hooks.targetUtility();
    }
    const s = await hooks.state();
    expect(typeof s.heapInUse === "number" && s.heapInUse > 0, "test_heap_in_use available");
    const w = await F.createRandomWallet({ networkType: 0, password: pw, proxyToWorker: proxy });
    address = await w.getPrimaryAddress();
    const d = await w.getData();
    keys = copyBytes(d.keys); cache = copyBytes(d.cache);
    await w.close();
    notes.push("instrumented module in the " + hooks.mode + " context; disposable wallet created");
  });

  await check("T01", "Close during a suspended native operation waits; new work rejects; queued work rejects; one free", async (notes) => {
    const w = await open();
    await hooks.target(w);
    await hooks.resetCounters();
    await hooks.arm({ barrier: "change_password" });
    const newPw = randomPassword();
    const order: string[] = [];
    const op = w.changePassword(pw, newPw).then(() => { order.push("op-fulfilled"); }, (err) => { order.push("op-rejected:" + codeOf(err)); });
    expect(await hooks.waitBarrierEntered(30000), "operation entered the native barrier");
    order.push("barrier-entered");
    const queued = w.getPrimaryAddress().then(() => "fulfilled", (err) => codeOf(err)); // issued before close, waits behind the active operation
    const closing = w.close().then(() => { order.push("close-resolved"); }, (err) => { order.push("close-rejected:" + codeOf(err)); });
    await expectCode(w.getData(), "WALLET_CLOSED", "new work after close", notes);
    await new Promise((r) => setTimeout(r, 300));
    let s = await hooks.state(false);
    expect(nativeCalls(s, "close") === 0 && (await hooks.handlePresent(w)), "native close not called and handle present while the operation is suspended");
    expect(order.join(",") === "barrier-entered", "neither the operation nor close settled before release: " + order.join(","));
    order.push("released");
    await hooks.release();
    await op; await closing;
    const queuedOutcome = await queued;
    s = await hooks.state();
    notes.push("order: " + order.join(" > ") + "; queued call: " + queuedOutcome + "; native close calls: " + nativeCalls(s, "close"));
    expect(order.join(",") === "barrier-entered,released,op-fulfilled,close-resolved", "operation settled before close completed");
    expect(queuedOutcome === "WALLET_CLOSED", "work queued before close rejects with WALLET_CLOSED");
    expect(nativeCalls(s, "close") === 1 && !(await hooks.handlePresent(w)), "native close exactly once, handle freed");
    const evs = s.events.filter((e) => e.startsWith("barrier-"));
    expect(evs.join(",") === "barrier-entered:change_password,barrier-left:change_password", "native barrier entered and left once");
    await w.close();
    s = await hooks.state();
    expect(nativeCalls(s, "close") === 1, "later close does not free again");
  });

  await check("T02", "Native operation failure under the barrier: close waits; failure surfaces; one free", async (notes) => {
    const w = await open();
    await hooks.target(w);
    await hooks.resetCounters();
    await hooks.arm({ barrier: "change_password", fail: { "change_password": 1 } }); // the suspended native call then fails
    const order: string[] = [];
    const op = w.changePassword(pw, randomPassword()).then(() => { order.push("op-fulfilled"); }, (err) => { order.push("op-rejected:" + codeOf(err)); });
    expect(await hooks.waitBarrierEntered(30000), "native operation entered the barrier");
    const closing = w.close().then(() => { order.push("close-resolved"); }, (err) => { order.push("close-rejected:" + codeOf(err)); });
    await new Promise((r) => setTimeout(r, 300));
    let s = await hooks.state(false);
    expect(nativeCalls(s, "close") === 0 && order.length === 0 && (await hooks.handlePresent(w)), "nothing settled, no native close and handle present before release");
    await hooks.release();
    await op; await closing;
    s = await hooks.state();
    notes.push("order: " + order.join(" > ") + "; injected native failures: " + s.injected + "; native close calls: " + nativeCalls(s, "close"));
    expect(s.injected === 1 && s.events.includes("injected:change_password"), "the suspended native operation failed by injection");
    expect(order.join(",") === "op-rejected:NATIVE_ERROR,close-resolved", "operation failure surfaced before close completed");
    expect(nativeCalls(s, "close") === 1 && !(await hooks.handlePresent(w)), "native close exactly once after the failed operation");
  });

  await check("T03", "Close failure keeps the handle and admission stopped; retry frees exactly once", async (notes) => {
    const w = await open();
    await hooks.target(w);
    await hooks.resetCounters();
    await hooks.arm({ fail: { "close.native": 1 } });
    const first = await expectCode(w.close(), "NATIVE_ERROR", "first close with injected native failure", notes, "CORE_CLOSE_FAILED");
    void first;
    let s = await hooks.state();
    expect(s.injected === 1 && s.events.includes("injected:close.native"), "failure injected inside native close");
    expect(await hooks.handlePresent(w), "handle retained after the failed close");
    await expectCode(w.getPrimaryAddress(), "WALLET_CLOSED", "new work after a failed close", notes);
    await w.close();
    s = await hooks.state();
    notes.push("native close calls: " + nativeCalls(s, "close") + " (one failed, one freed)");
    expect(nativeCalls(s, "close") === 2 && !(await hooks.handlePresent(w)), "retry closed and freed the handle");
    await w.close();
    s = await hooks.state();
    expect(nativeCalls(s, "close") === 2, "close after success does not reach native code");
  });

  await check("T04", "Wrong old password: TS gate rejects before native; the native bridge also rejects; encryption unchanged", async (notes) => {
    const w = await open();
    await hooks.target(w);
    await hooks.resetCounters();
    await expectCode(w.changePassword(pw + "-wrong", randomPassword()), "WRONG_PASSWORD", "facade change with wrong old password", notes);
    let s = await hooks.state();
    expect(nativeCalls(s, "change_wallet_password") === 0, "TS gate rejected before the native call");
    const attempted = randomPassword();
    await expectCode(hooks.nativeChangePassword(w, pw + "-wrong", attempted), "WRONG_PASSWORD", "native bridge change with wrong old password (TS gate bypassed)", notes, "CORE_INVALID_PASSWORD");
    s = await hooks.state();
    expect(nativeCalls(s, "change_wallet_password") === 1, "exactly one native call was made");
    expect((await w.getPrimaryAddress()) === address, "wallet usable after the native rejection");
    const d = await w.getData();
    const reopened = await F.openWalletData({ networkType: 0, password: pw, keysData: copyBytes(d.keys), cacheData: copyBytes(d.cache), proxyToWorker: proxy });
    expect((await reopened.getPrimaryAddress()) === address, "bytes still open with the original password");
    await reopened.close();
    await expectCode(F.openWalletData({ networkType: 0, password: attempted, keysData: copyBytes(d.keys), cacheData: copyBytes(d.cache), proxyToWorker: proxy }), "WRONG_PASSWORD", "attempted new password does not open", notes);
    const p2 = randomPassword();
    await hooks.nativeChangePassword(w, pw, p2);
    const p3 = randomPassword();
    await hooks.nativeChangePassword(w, p2, p3);
    await expectCode(hooks.nativeChangePassword(w, p2, randomPassword()), "WRONG_PASSWORD", "native change with the superseded password", notes);
    await w.close();
    notes.push("native rejection keeps the original encryption; two serialized correct native changes applied; a superseded old password is rejected natively");
  });

  await check("T05", "Buffer ownership: balanced allocation/free over repeated getData/open/close and injected failures", async (notes) => {
    const w = await open();
    await hooks.target(w);
    for (let i = 0; i < 3; i++) await w.getData(); // warm-up
    { const o = await open(); await o.getData(); await o.close(); } // warm-up of open/close
    await hooks.resetCounters();
    const repeats = 25;
    const h0 = (await hooks.state()).heapInUse;
    for (let i = 0; i < repeats; i++) await w.getData();
    let s = await hooks.state();
    notes.push("repeated getData x" + repeats + ": allocated " + s.allocated + ", freed " + s.freed + ", live " + s.live + ", double frees " + s.doubleFrees + ", allocator bytes in use delta " + (s.heapInUse - h0));
    expect(s.allocated === 2 * repeats && s.freed === s.allocated && s.live === 0 && s.doubleFrees === 0, "every getData buffer released exactly once");
    expect(s.heapInUse === h0, "allocator bytes in use unchanged after repeated getData (a per-call string copy that is never freed would grow it)");
    const h1 = s.heapInUse;
    const cycles = 5;
    const startedBefore = hooks.started().length;
    for (let i = 0; i < cycles; i++) { const o = await open(); await o.getData(); await o.close(); }
    s = await hooks.state();
    notes.push("open/getData/close x" + cycles + ": allocated " + s.allocated + ", freed " + s.freed + ", live " + s.live + ", allocator bytes in use delta " + (s.heapInUse - h1));
    if (proxy) {
      // Each cycle runs in its own worker; the observed wallet's worker sees none of it
      const cycleWorkers = hooks.started().slice(startedBefore);
      const balanced = cycleWorkers.filter((t) => t.terminated && t.telemetry !== undefined && t.telemetry.allocated === 2 && t.telemetry.freed === 2 && t.telemetry.live === 0 && t.telemetry.doubleFrees === 0).length;
      notes.push("each open/getData/close cycle ran in its own worker: " + cycleWorkers.length + " workers, " + balanced + " terminated with 2 allocated / 2 freed buffers");
      expect(cycleWorkers.length === cycles && balanced === cycles, "every cycle balanced in its own terminated worker");
      expect(s.allocated === 2 * repeats && s.freed === s.allocated && s.live === 0 && s.doubleFrees === 0 && s.heapInUse === h1, "the observed wallet's worker is untouched by the cycles");
    } else {
      expect(s.allocated === 2 * (repeats + cycles) && s.freed === s.allocated && s.live === 0 && s.doubleFrees === 0, "open/close cycles balanced");
      expect(s.heapInUse <= h1, "allocator bytes in use did not grow over open/close cycles");
    }
    const before = s;
    const injected: Array<[string, { fail?: Record<string, number>; skip?: Record<string, number>; copyFailure?: "first" | "second" }, string]> = [
      ["allocation failure of the first (cache) buffer", { fail: { "buffer.alloc": 1 } }, "BUFFER_ALLOCATION_FAILED"],
      ["allocation failure of the second (keys) buffer", { skip: { "buffer.alloc": 1 }, fail: { "buffer.alloc": 1 } }, "BUFFER_ALLOCATION_FAILED"],
      ["native failure of the first buffer", { fail: { "buffer.native": 1 } }, "NATIVE_BUFFER_FAILED"],
      ["native failure of the second buffer", { skip: { "buffer.native": 1 }, fail: { "buffer.native": 1 } }, "NATIVE_BUFFER_FAILED"],
      ["empty first buffer", { fail: { "buffer.empty": 1 } }, "BUFFER_EMPTY"],
      ["empty second buffer", { skip: { "buffer.empty": 1 }, fail: { "buffer.empty": 1 } }, "BUFFER_EMPTY"],
      ["copy failure of the first buffer", { copyFailure: "first" }, "BUFFER_COPY_FAILED"],
      ["copy failure of the second buffer", { copyFailure: "second" }, "BUFFER_COPY_FAILED"]
    ];
    for (const [label, arm, diagnostic] of injected) {
      const a = await hooks.state();
      await hooks.arm(arm);
      await expectCode(w.getData(), "NATIVE_ERROR", label, notes, diagnostic);
      const b = await hooks.state();
      expect(b.freed - a.freed === b.allocated - a.allocated && b.live === 0, label + ": every allocated buffer released (" + (b.allocated - a.allocated) + " allocated)");
      expect(b.injected === a.injected + 1, label + ": exactly one failure was injected");
      expect((await w.getPrimaryAddress()) === address, "usable after " + label);
      await hooks.arm({ fail: {}, skip: {} });
    }
    for (let i = 0; i < repeats; i++) await w.getData();
    const beforeClose = await hooks.state(); // worker mode: the worker ends with the close, so the allocator is sampled here
    await w.close();
    s = await hooks.state();
    notes.push("after injected failures, " + repeats + " more saves and close: allocated " + s.allocated + ", freed " + s.freed + ", live " + s.live + ", double frees " + s.doubleFrees + ", allocator bytes in use delta " + (s.heapInUse - before.heapInUse) + (proxy ? " (from the worker's final telemetry after the native close; before the close the live wallet's delta was " + (beforeClose.heapInUse - before.heapInUse) + ")" : ""));
    expect(s.freed === s.allocated && s.live === 0 && s.doubleFrees === 0, "balanced after injected failures");
    expect(s.heapInUse >= 0 && s.heapInUse <= before.heapInUse, "allocator bytes in use did not grow after failures and closing the wallet");
  });

  await check("T06", "Rejected requests make no native call and allocate no wallet handle", async (notes) => {
    const w = await open();
    await hooks.target(w);
    await hooks.resetCounters();
    const walletsBefore = (await hooks.state()).wallets;
    const startedBefore = LibraryUtils.getWorkerAccounting().workersStarted;
    await expectCode(w.getAddress(4294967296, 0), "INVALID_CONFIG", "index 2^32", notes);
    await expectCode(w.getAddress(0, -1), "INVALID_CONFIG", "index -1", notes);
    await expectCode(F.restoreWalletFromSeed({ networkType: 0, password: pw, seed: "abbey abbey", proxyToWorker: proxy }), "INVALID_RECOVERY_MATERIAL", "two-word seed", notes);
    await expectCode(F.createRandomWallet({ networkType: 0, password: pw, restoreHeight: 5, proxyToWorker: proxy }), "INVALID_CONFIG", "random with restoreHeight", notes);
    await expectCode(F.createRandomWallet({ networkType: 0, password: pw, accountLookahead: 4294967296, subaddressLookahead: 1, proxyToWorker: proxy }), "INVALID_CONFIG", "lookahead 2^32", notes);
    await expectCode(F.createRandomWallet({ networkType: 0, password: pw, path: "wallet-file", proxyToWorker: proxy }), "UNSUPPORTED_CAPABILITY", "path", notes);
    await expectCode(F.openWalletData({ networkType: 0, password: pw, keysData: new Uint8Array(0), proxyToWorker: proxy }), "INVALID_WALLET_DATA", "empty keys bytes", notes);
    if (proxy) {
      const raw: unknown[][] = [
        [newMessageId(), "createWalletFull", newMessageId(), { networkType: 0, password: pw, path: "wallet-file" }],
        [newMessageId(), "openWalletData", newMessageId(), "wallet-file", pw, 0, copyBytes(keys), copyBytes(cache), undefined, undefined],
        [newMessageId(), "createWalletFull", newMessageId(), { networkType: 0, password: pw, restoreHeight: 9007199254740992, seed: "x" }],
        [newMessageId(), "getBalance", newMessageId()], [newMessageId(), "constructor", newMessageId()], [newMessageId(), "getAddress", newMessageId(), 0]
      ];
      for (const m of raw) {
        const r = await postRawWorkerMessage(m, 30000, w); // the wallet's own worker
        expect(r.replied && r.error !== undefined, "raw request rejected");
      }
      notes.push(raw.length + " rejected raw worker requests in the wallet's worker");
    }
    expect(LibraryUtils.getWorkerAccounting().workersStarted === startedBefore, "rejected constructions started no worker");
    const s = await hooks.state();
    const total = Object.values(s.nativeCalls).reduce((a, b) => a + b, 0);
    notes.push("native export calls during rejected requests: " + total + "; wallet handles before/after: " + String(walletsBefore) + "/" + String(s.wallets));
    expect(total === 0, "no native export was called: " + JSON.stringify(s.nativeCalls));
    expect(s.wallets === walletsBefore, "no wallet handle allocated");
    expect((await w.getPrimaryAddress()) === address, "existing wallet usable");
    await w.close();
  });


  await check("T07", "Password queue under a native barrier: queued changes and getData chain; failure, changed-state failure, active close and close retry stay consistent", async (notes) => {
    // 1. A-B suspended in native code; B-C and getData queued behind it
    let w = await open();
    await hooks.target(w);
    await hooks.resetCounters();
    const pB = randomPassword(); const pC = randomPassword();
    await hooks.arm({ barrier: "change_password" });
    const order: string[] = [];
    const ab = w.changePassword(pw, pB).then(() => { order.push("A-B"); });
    expect(await hooks.waitBarrierEntered(30000), "A-B entered the native barrier");
    const bc = w.changePassword(pB, pC).then(() => { order.push("B-C"); }, (err) => { order.push("B-C:" + codeOf(err)); });
    const gd = w.getData().then((d) => { order.push("getData"); return d; });
    await new Promise((r) => setTimeout(r, 200));
    expect(order.length === 0, "nothing settled while A-B is suspended: " + order.join(","));
    await hooks.release();
    await ab; await bc;
    const d1 = await gd;
    notes.push("barrier: " + order.join(" > "));
    expect(order.join(",") === "A-B,B-C,getData", "B-C observed the completed A-B; getData followed both");
    let opened = await openingPasswords(d1, [pw, pB, pC], proxy);
    expect(opened.join(",") === "2", "queued getData opens only with C, got " + opened.join(","));
    // 2. injected native failure of a suspended change; a valid change and getData queued behind it
    const pD = randomPassword();
    await hooks.resetCounters();
    await hooks.arm({ barrier: "change_password", fail: { "change_password": 1 }, kind: { "change_password": 1 } });
    const failing = w.changePassword(pC, pD).then(() => "fulfilled", (err) => codeOf(err) + diagnosticOf(err));
    expect(await hooks.waitBarrierEntered(30000), "the failing change entered the barrier");
    const retry = w.changePassword(pC, pD).then(() => "fulfilled", (err) => codeOf(err));
    const gd2 = w.getData();
    await hooks.release();
    const failingOutcome = await failing; const retryOutcome = await retry; const d2 = await gd2;
    notes.push("injected failure before verification -> " + failingOutcome + "; queued C-D -> " + retryOutcome);
    expect(failingOutcome === "NATIVE_ERROR/CORE_UNCLASSIFIED", "the injected failure surfaced with a fixed identifier");
    expect(retryOutcome === "fulfilled", "TypeScript kept C after the failure, so the queued C-D succeeded");
    opened = await openingPasswords(d2, [pC, pD], proxy);
    expect(opened.join(",") === "1", "getData after the failure and the valid change opens only with D, got " + opened.join(","));
    // 3. failure after the core changed the password: the bridge reports "changed"; TypeScript follows
    const pE = randomPassword(); const pF = randomPassword();
    await hooks.resetCounters();
    await hooks.arm({ fail: { "change_password.after": 1 } });
    await expectCode(w.changePassword(pD, pE), "NATIVE_ERROR", "failure after the native change", notes, "PASSWORD_CHANGED_WITH_ERROR");
    const d3 = await w.getData();
    opened = await openingPasswords(d3, [pD, pE], proxy);
    expect(opened.join(",") === "1", "after a changed-state failure the bytes open only with the new password, got " + opened.join(","));
    await expectCode(w.changePassword(pD, pF), "WRONG_PASSWORD", "superseded password after a changed-state failure", notes);
    await w.changePassword(pE, pF);
    opened = await openingPasswords(await w.getData(), [pE, pF], proxy);
    expect(opened.join(",") === "1", "TypeScript and native state agree after the changed-state failure");
    // 4. active close: a change suspended in native code completes; queued changes reject; one free
    await hooks.resetCounters();
    await hooks.arm({ barrier: "change_password" });
    const pG = randomPassword();
    const closeOrder: string[] = [];
    const active = w.changePassword(pF, pG).then(() => { closeOrder.push("active-fulfilled"); }, (err) => { closeOrder.push("active:" + codeOf(err)); });
    expect(await hooks.waitBarrierEntered(30000), "the change entered the barrier");
    const queued = w.changePassword(pG, randomPassword()).then(() => "fulfilled", (err) => codeOf(err));
    const queuedData = w.getData().then(() => "fulfilled", (err) => codeOf(err));
    const closing = w.close().then(() => { closeOrder.push("close-resolved"); }, (err) => { closeOrder.push("close:" + codeOf(err)); });
    await expectCode(w.changePassword(pG, pF), "WALLET_CLOSED", "new change after close", notes);
    let st = await hooks.state(false);
    expect(nativeCalls(st, "close") === 0 && (await hooks.handlePresent(w)), "no native close while the change is suspended");
    await hooks.release();
    await active; await closing;
    const queuedOutcome = await queued; const queuedDataOutcome = await queuedData;
    st = await hooks.state();
    notes.push("active close: " + closeOrder.join(" > ") + "; queued change " + queuedOutcome + ", queued getData " + queuedDataOutcome + ", native close calls " + nativeCalls(st, "close"));
    expect(closeOrder.join(",") === "active-fulfilled,close-resolved", "the active change completed before close");
    expect(queuedOutcome === "WALLET_CLOSED" && queuedDataOutcome === "WALLET_CLOSED", "work queued behind the active change rejects WALLET_CLOSED");
    expect(nativeCalls(st, "close") === 1 && !(await hooks.handlePresent(w)), "one native close, handle freed");
    // 5. close failure with a suspended change, then retry
    w = await open();
    await hooks.target(w);
    await hooks.resetCounters();
    await hooks.arm({ barrier: "change_password", fail: { "close.native": 1 } });
    const pH = randomPassword();
    const op = w.changePassword(pw, pH).then(() => "fulfilled", (err) => codeOf(err));
    expect(await hooks.waitBarrierEntered(30000), "the change entered the barrier");
    const firstClose = w.close().then(() => "resolved", (err) => codeOf(err) + diagnosticOf(err));
    await hooks.release();
    const opOutcome = await op; const firstCloseOutcome = await firstClose;
    expect(opOutcome === "fulfilled", "the suspended change completed");
    expect(firstCloseOutcome === "NATIVE_ERROR/CORE_CLOSE_FAILED", "the injected close failure surfaced with a fixed identifier, got " + firstCloseOutcome);
    expect(await hooks.handlePresent(w), "handle retained after the failed close");
    await expectCode(w.changePassword(pH, pw), "WALLET_CLOSED", "change after a failed close", notes);
    await w.close();
    st = await hooks.state();
    notes.push("close failure then retry: native close calls " + nativeCalls(st, "close"));
    expect(nativeCalls(st, "close") === 2 && !(await hooks.handlePresent(w)), "retry freed the handle once");
  });

  await check("T08", "Injected native failures report fixed identifiers; injected input text never reaches errors, envelopes or results", async (notes) => {
    const marker = "Zq-INJECT-" + randomPassword().substring(0, 10);
    const w = await open();
    await hooks.target(w);
    const seed = await w.getSeed();
    const spend = await w.getPrivateSpendKey();
    const view = await w.getPrivateViewKey();
    const secrets = [marker, pw, seed.split(" ").slice(0, 3).join(" "), spend, view];
    const leaks: string[] = [];
    const scan = (label: string, value: unknown): void => { const t = scanText(value); for (const m of secrets) if (t.includes(m.toLowerCase())) leaks.push(label); };
    const cases: Array<[string, string, number, () => Promise<unknown>, string, string]> = [
      ["create random, runtime_error with the config", "error.create", 1, () => F.createRandomWallet({ networkType: 0, password: marker, proxyToWorker: proxy }), "NATIVE_ERROR", "CORE_UNCLASSIFIED"],
      ["seed restore, runtime_error with the config", "error.create", 1, () => F.restoreWalletFromSeed({ networkType: 0, password: marker, seed, proxyToWorker: proxy }), "INVALID_RECOVERY_MATERIAL", "CORE_UNCLASSIFIED"],
      ["seed restore, non-standard exception", "error.create", 2, () => F.restoreWalletFromSeed({ networkType: 0, password: marker, seed, proxyToWorker: proxy }), "INVALID_RECOVERY_MATERIAL", "CORE_UNCLASSIFIED"],
      ["keys restore, bad_alloc", "error.create", 3, () => F.restoreWalletFromKeys({ networkType: 0, password: marker, primaryAddress: address, privateViewKey: view, privateSpendKey: spend, proxyToWorker: proxy }), "INVALID_RECOVERY_MATERIAL", "CORE_UNCLASSIFIED"],
      ["keys-only seed, runtime_error with the config", "error.create", 1, () => F.createKeysWallet({ networkType: 0, seed, proxyToWorker: proxy }), "INVALID_RECOVERY_MATERIAL", "CORE_UNCLASSIFIED"],
      ["open, runtime_error with the password", "error.open", 1, () => open(marker), "INVALID_WALLET_DATA", "CORE_WALLET_DATA"],
      ["open, non-standard exception", "error.open", 2, () => open(marker), "INVALID_WALLET_DATA", "CORE_UNCLASSIFIED"],
      ["open, bad_alloc", "error.open", 3, () => open(marker), "INVALID_WALLET_DATA", "CORE_WALLET_DATA"],
      ["open, typed invalid_password", "error.open", 4, () => open(marker), "WRONG_PASSWORD", "CORE_INVALID_PASSWORD"],
      ["getSeed, runtime_error with the seed", "error.getter", 1, () => w.getSeed(), "NATIVE_ERROR", "CORE_UNCLASSIFIED"],
      ["getPrivateSpendKey, runtime_error with the key", "error.getter", 1, () => w.getPrivateSpendKey(), "NATIVE_ERROR", "CORE_UNCLASSIFIED"],
      ["getPrivateViewKey, non-standard exception", "error.getter", 2, () => w.getPrivateViewKey(), "NATIVE_ERROR", "CORE_UNCLASSIFIED"],
      ["getAddress, runtime_error with the spend key", "error.getter", 1, () => w.getAddress(0, 1), "NATIVE_ERROR", "CORE_UNCLASSIFIED"],
      ["getRestoreHeight, runtime_error with the spend key", "error.getter", 1, () => w.getRestoreHeight(), "NATIVE_ERROR", "CORE_UNCLASSIFIED"],
      ["getNetworkType, integer failure result", "error.getter", 1, () => w.getNetworkType(), "NATIVE_ERROR", "CORE_UNCLASSIFIED"],
      ["isViewOnly, integer failure result", "error.getter", 1, () => w.isViewOnly(), "NATIVE_ERROR", "CORE_UNCLASSIFIED"],
      ["validateAddress, runtime_error with the address", "error.address", 1, () => F.validateAddress(address, "mainnet", proxy), "INVALID_ADDRESS", "CORE_UNCLASSIFIED"],
      ["changePassword before verification, runtime_error with both passwords", "change_password", 1, () => w.changePassword(pw, marker), "NATIVE_ERROR", "CORE_UNCLASSIFIED"],
      ["changePassword before verification, typed invalid_password", "change_password", 4, () => w.changePassword(pw, marker), "WRONG_PASSWORD", "CORE_INVALID_PASSWORD"],
      ["getData, native buffer failure with the password", "buffer.native", 1, () => w.getData(), "NATIVE_ERROR", "NATIVE_BUFFER_FAILED"],
      ["getData, native buffer bad_alloc", "buffer.native", 3, () => w.getData(), "NATIVE_ERROR", "NATIVE_BUFFER_FAILED"]
    ];
    for (const [label, point, kind, call, code, diagnostic] of cases) {
      // A construction runs in a new worker (armed before its first message); proxied address validation uses the utility worker
      const where = point === "error.create" || point === "error.open" ? "next" : point === "error.address" && proxy ? "utility" : "wallet";
      if (where === "utility") await hooks.targetUtility(); else await hooks.target(w);
      await hooks.resetCounters();
      if (where === "next") await hooks.armNext({ fail: { [point]: 1 }, kind: { [point]: kind } });
      else await hooks.arm({ fail: { [point]: 1 }, kind: { [point]: kind } });
      const err = await expectCode(call(), code, label, notes, diagnostic);
      scan(label, err);
      const s = where === "next" ? await hooks.lastStartedState() : await hooks.state(false);
      expect(s.injected === 1, label + ": exactly one injected failure");
      await hooks.target(w);
      expect((await w.getPrimaryAddress()) === address, "wallet usable after " + label);
    }
    // the password is unchanged after the injected change failures
    const opened = await openingPasswords(await w.getData(), [pw, marker], proxy);
    expect(opened.join(",") === "0", "injected change failures left the password unchanged");
    // log-level failure through the supported setter
    await hooks.resetCounters();
    await hooks.arm({ fail: { "error.utility": 1 } });
    const logErr = await expectCode(LibraryUtils.setLogLevel(0), "NATIVE_ERROR", "setLogLevel, injected native failure", notes, "CORE_UNCLASSIFIED");
    scan("setLogLevel", logErr);
    await LibraryUtils.setLogLevel(0);
    // close failures of both kinds, each retried
    for (const kind of [1, 2]) {
      const c = await open();
      await hooks.target(c);
      await hooks.resetCounters();
      await hooks.arm({ fail: { "close.native": 1 }, kind: { "close.native": kind } });
      const e = await expectCode(c.close(), "NATIVE_ERROR", "close failure kind " + kind, notes, "CORE_CLOSE_FAILED");
      scan("close kind " + kind, e);
      await c.close();
      expect(c.isClosed() && !(await hooks.handlePresent(c)), "close retry after kind " + kind + " freed the handle");
    }
    await hooks.target(w);
    if (proxy) {
      // raw envelopes from the worker carry only type, code and diagnostic
      await hooks.resetCounters();
      await hooks.arm({ fail: { "error.getter": 1 } });
      const r = await postRawWorkerMessage([walletIdOf(w), "getSeed", newMessageId()], 30000, w);
      scan("raw worker envelope", r.raw);
      const keys = r.error ? Object.keys(r.error).sort().join(",") : "none";
      expect(r.replied && r.error !== undefined && r.error.code === "NATIVE_ERROR" && r.error.diagnostic === "CORE_UNCLASSIFIED" && keys === "code,diagnostic,type", "raw worker envelope is fixed and minimal, got " + keys);
      // crafted replies through the real worker channel are validated strictly
      const crafted: Array<[string, string]> = [["envelope-message", "MALFORMED_MESSAGE"], ["envelope-stack", "MALFORMED_MESSAGE"], ["envelope-invalid-diagnostic", "MALFORMED_MESSAGE"],
        ["envelope-undefined-diagnostic", "MALFORMED_MESSAGE"], ["reply-extra-field", "MALFORMED_MESSAGE"], ["reply-result-and-error", "MALFORMED_MESSAGE"], ["reply-not-object", "MALFORMED_MESSAGE"],
        ["valid-error", "WRONG_PASSWORD"], ["valid-result", "RESULT"]];
      for (const [variant, want] of crafted) {
        let got: string;
        try { await LibraryUtils.invokeWorker(undefined, "__testReply", [variant, marker]); got = "RESULT"; } catch (err) { got = codeOf(err); scan("crafted " + variant, err); }
        expect(got === want, "crafted worker reply " + variant + ": expected " + want + ", got " + got);
      }
      notes.push(crafted.length + " crafted worker replies through the real channel: malformed envelopes and replies reject MALFORMED_MESSAGE, valid ones are accepted");
    } else {
      // direct: the raw bridge result itself is the fixed token
      const module = LibraryUtils.getWasmModule();
      await hooks.resetCounters();
      await hooks.arm({ fail: { "error.getter": 1 } });
      const raw = module.get_seed(innerOf(w).cppAddress);
      scan("raw get_seed result", raw);
      expect(raw === '{"error":"CORE_UNCLASSIFIED"}', "raw bridge result is the fixed token, got " + (typeof raw === "string" && raw.startsWith("{") ? raw : "<other>"));
      await hooks.arm({ fail: { "error.address": 1 } });
      const rawAddress = module.validate_address(marker, 0);
      scan("raw validate_address result", rawAddress);
      expect(rawAddress === '{"error":"CORE_UNCLASSIFIED"}', "raw validate_address under injection is the fixed token");
    }
    await w.close();
    expect(leaks.length === 0, "injected text found in: " + leaks.join(", "));
    notes.push("injected runtime_error (carrying passwords, seed, keys, address), non-standard, bad_alloc and typed failures: fixed identifiers only; no injected text in any error, envelope or raw result");
  });

  await check("T09", "Unknown or malformed password state stops ordinary admission; queued work rejects before native access; other wallets, close and close retry unaffected; recovery from saved bytes", async (notes) => {
    const UNKNOWN = "NATIVE_ERROR/PASSWORD_STATE_UNKNOWN";
    const outcome = (p: Promise<unknown>): Promise<string> => p.then(() => "fulfilled", (err) => codeOf(err) + diagnosticOf(err));
    const ordinaryNativeCalls = (s: InstrumentationState): number => Object.entries(s.nativeCalls).filter(([k]) => k !== "change_wallet_password" && k !== "close").reduce((a, [, v]) => a + v, 0);
    const other = await open(); // another live wallet (in its own worker when proxied; same module in direct mode)
    const otherAddress = await other.getPrimaryAddress();
    // 1. bridge-reported unknown state: the core changes the password, then fails; the probe is forced to report unknown
    const w = await open();
    await hooks.target(w);
    const snapshot = await w.getData(); // saved bytes before the change, valid with pw
    const pB = randomPassword(); const pC = randomPassword();
    await hooks.resetCounters();
    await hooks.arm({ barrier: "change_password", fail: { "change_password.after": 1, "password_probe": 1 } });
    const failing = outcome(w.changePassword(pw, pB));
    expect(await hooks.waitBarrierEntered(30000), "the change entered the native barrier");
    const queued = [outcome(w.getData()), outcome(w.changePassword(pB, pC)), outcome(w.changePassword(pw, pC)), outcome(w.getPrimaryAddress()), outcome(w.getSeed())];
    await new Promise((r) => setTimeout(r, 200));
    await hooks.release();
    const failingOutcome = await failing; const queuedOutcomes = await Promise.all(queued);
    let st = await hooks.state();
    notes.push("bridge unknown state: change -> " + failingOutcome + "; queued getData, changePassword x2, getPrimaryAddress, getSeed -> " + queuedOutcomes.join(","));
    expect(failingOutcome === UNKNOWN, "the change with an unknown native state rejects PASSWORD_STATE_UNKNOWN");
    expect(st.events.includes("injected:change_password.after") && st.events.includes("injected:password_probe"), "both native injections fired");
    expect(queuedOutcomes.every((o) => o === UNKNOWN), "every already queued ordinary operation rejects PASSWORD_STATE_UNKNOWN");
    expect(ordinaryNativeCalls(st) === 0 && (st.nativeCalls["change_wallet_password"] ?? 0) === 1, "queued work made no native call: " + JSON.stringify(st.nativeCalls));
    // 2. later ordinary calls reject before native access; neither password is admitted
    const later = [outcome(w.getData()), outcome(w.changePassword(pw, pC)), outcome(w.changePassword(pB, pC)), outcome(w.getAddress(0, 1)), outcome(w.getPrivateViewKey()), outcome(w.isViewOnly()), outcome(w.getRestoreHeight())];
    const laterOutcomes = await Promise.all(later);
    st = await hooks.state();
    notes.push("later getData, changePassword (old and new password), getAddress, getPrivateViewKey, isViewOnly, getRestoreHeight -> " + Array.from(new Set(laterOutcomes)).join(","));
    expect(laterOutcomes.every((o) => o === UNKNOWN), "later ordinary operations reject PASSWORD_STATE_UNKNOWN");
    expect(ordinaryNativeCalls(st) === 0 && (st.nativeCalls["change_wallet_password"] ?? 0) === 1, "no native call after the unknown state");
    expect(!w.isClosed() && (await hooks.handlePresent(w)), "the wallet is not freed implicitly");
    // 3. the other live wallet is unaffected
    const otherData = await other.getData();
    const pX = randomPassword();
    await other.changePassword(pw, pX);
    let opened = await openingPasswords(await other.getData(), [pw, pX], proxy);
    expect((await other.getPrimaryAddress()) === otherAddress && otherData.keys.length > 0 && opened.join(",") === "1", "the other live wallet keeps working (getData, changePassword)");
    notes.push("other live wallet: getData and changePassword succeed; bytes open only with its new password");
    // 4. close failure and retry stay available
    await hooks.resetCounters();
    await hooks.arm({ fail: { "close.native": 1 } });
    const firstClose = await outcome(w.close());
    expect(firstClose === "NATIVE_ERROR/CORE_CLOSE_FAILED", "injected close failure surfaces, got " + firstClose);
    expect(await hooks.handlePresent(w), "handle retained after the failed close");
    await expectCode(w.getData(), "WALLET_CLOSED", "getData after the failed close", notes);
    await w.close();
    st = await hooks.state();
    notes.push("close failure then retry: native close calls " + nativeCalls(st, "close"));
    expect(nativeCalls(st, "close") === 2 && !(await hooks.handlePresent(w)), "close retry freed the handle once");
    // 5. recovery from bytes saved before the change
    const recovered = await F.openWalletData({ networkType: 0, password: pw, keysData: copyBytes(snapshot.keys), cacheData: copyBytes(snapshot.cache), proxyToWorker: proxy });
    expect((await recovered.getPrimaryAddress()) === address, "the saved snapshot reopens with the password valid for it");
    await recovered.close();
    opened = await openingPasswords(snapshot, [pw, pB, pC], proxy);
    expect(opened.join(",") === "0", "the saved snapshot opens only with its own password");
    notes.push("recovery: bytes saved before the change reopen with their password; the uncertain in-memory wallet was only closed");
    // 6. malformed results (the native change runs, its result is replaced) with a concurrent close
    const malformed: Array<[string, unknown]> = [["invalid state", '{"error":"CORE_UNCLASSIFIED","passwordState":"maybe"}'], ["unapproved identifier", '{"error":"NOT_APPROVED","passwordState":"unchanged"}'],
      ["missing state", '{"error":"CORE_UNCLASSIFIED"}'], ["non-string", 7]];
    for (let i = 0; i < malformed.length; i++) {
      const [label, value] = malformed[i];
      const m = await open();
      await hooks.target(m);
      await hooks.resetCounters();
      const concurrentClose = i === 0;
      await hooks.arm(concurrentClose ? { barrier: "change_password", passwordResult: { value } } : { passwordResult: { value } });
      const change = outcome(m.changePassword(pw, randomPassword()));
      let queuedData: Promise<string> | undefined; let closing: Promise<string> | undefined;
      if (concurrentClose) {
        expect(await hooks.waitBarrierEntered(30000), "the change entered the barrier");
        queuedData = outcome(m.getData());
        closing = outcome(m.close());
        await new Promise((r) => setTimeout(r, 200));
        st = await hooks.state(false);
        expect(nativeCalls(st, "close") === 0 && (await hooks.handlePresent(m)), "no native close while the change is suspended");
        await hooks.release();
      }
      const changeOutcome = await change;
      expect(changeOutcome === UNKNOWN, "malformed result (" + label + ") rejects PASSWORD_STATE_UNKNOWN, got " + changeOutcome);
      if (concurrentClose) {
        const queuedOutcome = await (queuedData as Promise<string>); const closeOutcome = await (closing as Promise<string>);
        st = await hooks.state();
        notes.push("malformed result (" + label + ") with a concurrent close: change -> " + changeOutcome + ", queued getData -> " + queuedOutcome + ", close -> " + closeOutcome + ", native close calls " + nativeCalls(st, "close"));
        expect(queuedOutcome === "WALLET_CLOSED" && closeOutcome === "fulfilled", "queued getData rejects WALLET_CLOSED; close completes");
      } else {
        const after = await Promise.all([outcome(m.getData()), outcome(m.changePassword(pw, randomPassword())), outcome(m.getPrimaryAddress())]);
        expect(after.every((o) => o === UNKNOWN), "after a malformed result (" + label + ") ordinary operations reject PASSWORD_STATE_UNKNOWN");
        await m.close();
        st = await hooks.state();
        notes.push("malformed result (" + label + "): change -> " + changeOutcome + "; later getData, changePassword, getPrimaryAddress -> " + Array.from(new Set(after)).join(",") + "; close native calls " + nativeCalls(st, "close"));
      }
      expect(st.events.includes("injected:password-result"), "the malformed result was injected");
      expect(ordinaryNativeCalls(st) === 0 && nativeCalls(st, "close") === 1 && !(await hooks.handlePresent(m)), "no ordinary native call; one native close; handle freed");
    }
    // 7. the native call throws instead of reporting a result
    const t = await open();
    await hooks.target(t);
    await hooks.resetCounters();
    await hooks.arm({ passwordThrow: true });
    let thrownErr: unknown = undefined;
    try { await t.changePassword(pw, randomPassword()); } catch (err) { thrownErr = err; }
    const thrown = codeOf(thrownErr) + diagnosticOf(thrownErr);
    const afterThrow = await outcome(t.getData());
    st = await hooks.state();
    notes.push("native call throws: change -> " + thrown + "; later getData -> " + afterThrow);
    expect(thrown === UNKNOWN && afterThrow === UNKNOWN && st.events.includes("injected:password-throw"), "a change without a native result stops admission");
    expect(!scanText(thrownErr).includes("injected"), "the thrown native text is not carried by the error");
    await t.close();
    // 8. verified states keep the reject-and-adopt behavior (no quarantine)
    const v = await open();
    await hooks.target(v);
    const pV = randomPassword(); const pW = randomPassword();
    await hooks.resetCounters();
    await hooks.arm({ fail: { "change_password": 1 } });
    await expectCode(v.changePassword(pw, pV), "NATIVE_ERROR", "failure before verification (state unchanged)", notes, "CORE_UNCLASSIFIED");
    await v.changePassword(pw, pV);
    await hooks.arm({ fail: { "change_password.after": 1 } });
    await expectCode(v.changePassword(pV, pW), "NATIVE_ERROR", "verified changed state", notes, "PASSWORD_CHANGED_WITH_ERROR");
    opened = await openingPasswords(await v.getData(), [pV, pW], proxy);
    expect(opened.join(",") === "1", "verified states stay admitted and consistent");
    await v.close();
    await other.close();
  });

  await check("T10", "Lookahead limit: over-limit and invalid pairs reject before dispatch with no native call, handle or allocation in facade, direct and raw worker paths", async (notes) => {
    const w = await open();
    await hooks.target(w);
    const seedText = await w.getSeed();
    const spend = await w.getPrivateSpendKey();
    await hooks.resetCounters();
    const before = await hooks.state();
    const startedBefore = LibraryUtils.getWorkerAccounting().workersStarted;
    const over: Array<[string, number, number]> = [["20001 x 1", 20001, 1], ["1 x 20001", 1, 20001], ["101 x 200", 101, 200], ["200 x 101", 200, 101], ["141 x 142", 141, 142],
      ["20000 x 2", 20000, 2], ["2^32-1 x 2^32-1", 4294967295, 4294967295], ["2^31 x 2^31", 2147483648, 2147483648]];
    const started = Date.now();
    let rejected = 0;
    for (const [label, a, b] of over) {
      await expectCode(F.createRandomWallet({ networkType: 0, password: pw, accountLookahead: a, subaddressLookahead: b, proxyToWorker: proxy }), "INVALID_CONFIG", "facade random " + label, notes, "LOOKAHEAD_LIMIT");
      await expectCode(F.restoreWalletFromSeed({ networkType: 0, password: pw, seed: seedText, accountLookahead: a, subaddressLookahead: b, proxyToWorker: proxy }), "INVALID_CONFIG", "facade seed " + label, notes, "LOOKAHEAD_LIMIT");
      await expectCode(F.restoreWalletFromKeys({ networkType: 0, password: pw, primaryAddress: address, privateSpendKey: spend, accountLookahead: a, subaddressLookahead: b, proxyToWorker: proxy }), "INVALID_CONFIG", "facade keys " + label, notes, "LOOKAHEAD_LIMIT");
      await expectCode(ZephyrWalletFull.createWallet(new ZephyrWalletConfig({ networkType: 0, password: pw, seed: seedText, accountLookahead: a, subaddressLookahead: b, proxyToWorker: proxy })), "INVALID_CONFIG", "inherited createWallet " + label, notes, "LOOKAHEAD_LIMIT");
      rejected += 4;
      if (proxy) {
        const r = await postRawWorkerMessage([newMessageId(), "createWalletFull", newMessageId(), { networkType: 0, password: pw, seed: seedText, accountLookahead: a, subaddressLookahead: b }], 30000, w);
        expect(r.replied && r.error !== undefined && r.error.code === "INVALID_CONFIG" && r.error.diagnostic === "LOOKAHEAD_LIMIT", "raw worker createWalletFull " + label + " rejects LOOKAHEAD_LIMIT");
        rejected++;
      }
    }
    // ABI/type errors keep their earlier diagnostics; keys-only wallets keep rejecting any lookahead
    await expectCode(F.createRandomWallet({ networkType: 0, password: pw, accountLookahead: 4294967296, subaddressLookahead: 20001, proxyToWorker: proxy }), "INVALID_CONFIG", "2^32 x 20001 (ABI first)", notes, "LOOKAHEAD_RANGE");
    await expectCode(F.createRandomWallet({ networkType: 0, password: pw, accountLookahead: 20001, proxyToWorker: proxy }), "INVALID_CONFIG", "20001 without its pair", notes, "LOOKAHEAD_PAIR");
    await expectCode(F.createKeysWallet({ networkType: 0, password: pw, accountLookahead: 20001, subaddressLookahead: 1, proxyToWorker: proxy }), "UNSUPPORTED_CAPABILITY", "keys-only wallet with 20001 x 1", notes, "KEYS_ONLY_LOOKAHEAD");
    rejected += 3;
    const elapsed = Date.now() - started;
    const s = await hooks.state();
    const total = Object.values(s.nativeCalls).reduce((a, b) => a + b, 0);
    notes.push(rejected + " rejections in " + (elapsed < 5000 ? "under 5 s" : "over 5 s") + "; native export calls " + total + "; wallet handles before/after " + String(before.wallets) + "/" + String(s.wallets) + "; allocator bytes in use delta " + (s.heapInUse - before.heapInUse));
    expect(total === 0, "no native export was called: " + JSON.stringify(s.nativeCalls));
    expect(s.wallets === before.wallets, "no wallet handle allocated");
    expect(s.heapInUse === before.heapInUse, "allocator bytes in use unchanged by the rejections");
    expect(LibraryUtils.getWorkerAccounting().workersStarted === startedBefore, "the rejections started no worker");
    expect(elapsed < 30000, "rejections complete without table allocation");
    expect((await w.getPrimaryAddress()) === address, "existing wallet usable");
    await w.close();
  });

  // ------------------------------ dedicated wallet workers ------------------------------
  const acc = () => LibraryUtils.getWorkerAccounting();
  const wi = proxy ? hooks as WorkerInstrumentation : undefined;
  const isNode = typeof process !== "undefined" && typeof process.versions === "object" && process.versions.node !== undefined && typeof (globalThis as { window?: unknown }).window === "undefined";
  const LONG = { networkType: 0, password: pw, accountLookahead: 20000, subaddressLookahead: 1, proxyToWorker: proxy }; // bounded synchronous native workload (policy maximum)
  const outcomeOf = (p: Promise<F.ZephyrWallet>): Promise<string> => p.then(async (x) => { await x.close(); return "fulfilled"; }, (err) => codeOf(err) + diagnosticOf(err));

  await check("T11", "Construction admission: FIFO order with two slots, abort while queued, abort during synchronous native construction, success/abort race at hand-off", async (notes) => {
    const w = wi as WorkerInstrumentation;
    // 1. FIFO: two long constructions take both slots; three wait; the middle one is aborted while queued
    const n0 = w.started().length;
    const pA = F.createRandomWallet(LONG); const pB = F.createRandomWallet(LONG);
    expect(await waitUntil(() => acc().activeConstructions === 2, 10000), "two constructions active");
    const dCtl = new AbortController();
    const pC = open(); const pD = outcomeOf(F.openWalletData({ networkType: 0, password: pw, keysData: copyBytes(keys), cacheData: copyBytes(cache), proxyToWorker: proxy }, { signal: dCtl.signal })); const pE = open();
    expect(await waitUntil(() => acc().queuedConstructions === 3, 10000), "three constructions queued behind two slots");
    expect(acc().constructionWorkers === 2, "only two construction workers exist while three wait");
    dCtl.abort();
    const dOutcome = await pD;
    expect(dOutcome === "NATIVE_ERROR/CONSTRUCTION_ABORTED" && acc().queuedConstructions === 2, "the aborted queued construction left the queue: " + dOutcome);
    const [A, B, C, E] = await Promise.all([pA, pB, pC, pE]);
    const idx = [A, B, C, E].map((x) => w.workerIndexOf(x) - n0);
    notes.push("FIFO: worker start order (relative) A " + idx[0] + ", B " + idx[1] + ", C " + idx[2] + ", E " + idx[3] + "; aborted queued D -> " + dOutcome + "; workers started " + (w.started().length - n0));
    expect(idx[0] + idx[1] === 1 && idx[2] === 2 && idx[3] === 3 && w.started().length - n0 === 4, "C started before E and D never started a worker");
    for (const x of [A, B, C, E]) await x.close();
    expect([A, B, C, E].every((x) => !channelOf(x).isOpen()), "closing terminated their workers");
    // 2. abort during synchronous native construction: the worker reported entering create_full_wallet and never left it
    let entered = -1;
    w.onNativeEnter = (index, name) => { if (name === "create_full_wallet" && entered < 0) entered = index; };
    const aCtl = new AbortController();
    const pX = outcomeOf(F.createRandomWallet(LONG, { signal: aCtl.signal }));
    expect(await waitUntil(() => entered >= 0, 30000), "the construction entered native code");
    await new Promise((r) => setTimeout(r, 300)); // table generation takes seconds; the worker is now blocked in native code
    const t0 = Date.now();
    aCtl.abort();
    const xOutcome = await pX;
    const ms = Date.now() - t0;
    w.onNativeEnter = undefined;
    const info = w.started()[entered];
    notes.push("abort during synchronous native construction: " + xOutcome + " after " + ms + " ms; native create_full_wallet entered " + info.nativeEntered.length + ", left " + info.nativeLeft.length + "; worker terminated " + info.terminated);
    expect(xOutcome === "NATIVE_ERROR/CONSTRUCTION_ABORTED" && info.terminated && info.nativeLeft.length === 0 && ms < 2000, "terminated from the caller context while native construction ran");
    expect(acc().constructionWorkers === 0 && acc().activeConstructions === 0, "slot and worker released");
    // 3. success/abort race: the abort arrives after the core constructed the wallet but before the reply is handled
    const rCtl = new AbortController();
    const target = w.started().length;
    let raced = false;
    w.onTelemetry = (index) => { if (index === target && !raced) { raced = true; rCtl.abort(); } }; // the telemetry precedes the construction reply
    const rOutcome = await outcomeOf(F.openWalletData({ networkType: 0, password: pw, keysData: copyBytes(keys), cacheData: copyBytes(cache), proxyToWorker: proxy }, { signal: rCtl.signal }));
    w.onTelemetry = undefined;
    const rInfo = w.started()[target];
    notes.push("abort racing the success reply: " + rOutcome + "; the discarded worker held " + String(rInfo.telemetry?.wallets) + " constructed wallet(s); terminated " + rInfo.terminated);
    expect(raced && rOutcome === "NATIVE_ERROR/CONSTRUCTION_ABORTED" && rInfo.terminated && rInfo.telemetry !== undefined && rInfo.telemetry.wallets === 1, "abort before hand-off discards the constructed wallet with its worker");
    // 4. abort after the wallet was returned has no effect
    const sCtl = new AbortController();
    const kept = await F.openWalletData({ networkType: 0, password: pw, keysData: copyBytes(keys), cacheData: copyBytes(cache), proxyToWorker: proxy }, { signal: sCtl.signal });
    sCtl.abort();
    await new Promise((r) => setTimeout(r, 100));
    expect((await kept.getPrimaryAddress()) === address && channelOf(kept).isOpen(), "the returned wallet survives a later abort");
    await kept.close();
    const a = acc();
    expect(a.constructionWorkers === 0 && a.activeConstructions === 0 && a.queuedConstructions === 0, "no construction state remains");
  }, proxy);

  await check("T12", "Worker start failure and unexpected worker death: pending requests settle exactly once with WORKER_FAILED; registry, callbacks and slots are released", async (notes) => {
    const w = wi as WorkerInstrumentation;
    // 1. the worker fails during its own start (Node: the thread exits; browser: an uncaught error during script evaluation)
    const before = acc();
    w.nameNext(isNode ? "zephyr-ts-startup-exit" : "zephyr-ts-startup-throw");
    await expectCode(open(), "NATIVE_ERROR", "worker fails during start", notes, "WORKER_FAILED");
    let a = acc();
    expect(a.workersFailed === before.workersFailed + 1 && a.constructionWorkers === 0 && a.activeConstructions === 0, "start failure: worker failed and removed, slot released");
    // 2. a construction worker crashes before its construction runs
    const crashNext = (index: number) => { w.postTo(index, [newMessageId(), "__testCrash", newMessageId(), isNode ? "exit" : "uncaught"]); };
    w.onStart = (index) => { w.onStart = undefined; crashNext(index); }; // posted before the SDK's construction message
    await expectCode(open(), "NATIVE_ERROR", "construction worker crashes", notes, "WORKER_FAILED");
    a = acc();
    expect(a.workersFailed === before.workersFailed + 2 && a.constructionWorkers === 0 && a.activeConstructions === 0, "crashed construction: slot released");
    // 3. a live wallet's worker crashes with a change suspended at the native barrier and calls queued behind it
    const victim = await open();
    await hooks.target(victim);
    const ch = channelOf(victim);
    const walletsBefore = acc().walletWorkers;
    await hooks.arm({ barrier: "change_password" });
    const counts = [0, 0, 0, 0];
    const outcomes: string[] = ["", "", "", ""];
    const track = (i: number, p: Promise<unknown>) => p.then(() => { counts[i]++; outcomes[i] = "fulfilled"; }, (err) => { counts[i]++; outcomes[i] = codeOf(err) + diagnosticOf(err); });
    const p0 = track(0, victim.changePassword(pw, randomPassword()));
    expect(await hooks.waitBarrierEntered(30000), "the change entered the native barrier");
    const rest = [track(1, victim.getData()), track(2, victim.getPrimaryAddress()), track(3, victim.changePassword(pw, randomPassword()))];
    expect(ch.pendingCount() >= 1, "requests pending in the worker");
    crashNext(w.workerIndexOf(victim));
    await Promise.all([p0, ...rest]);
    await new Promise((r) => setTimeout(r, 300)); // a late reply would show up as a second settlement or a callback
    a = acc();
    const reg = ch.registrationCounts();
    notes.push("live worker crash: pending/queued outcomes " + outcomes.join(",") + "; settlements " + counts.join(",") + "; channel " + ch.state + ", pending " + ch.pendingCount() + ", objects " + reg.objects + ", callbacks " + reg.callbacks);
    expect(outcomes.every((o) => o === "NATIVE_ERROR/WORKER_FAILED") && counts.every((c) => c === 1), "every pending and queued request settled exactly once with WORKER_FAILED");
    expect(ch.state === "failed" && ch.pendingCount() === 0 && reg.objects === 0 && reg.callbacks === 0 && a.walletWorkers === walletsBefore - 1, "no request, callback or registry entry remains");
    await expectCode(victim.getData(), "NATIVE_ERROR", "call after the crash", notes, "WORKER_FAILED");
    await victim.close();
    expect(victim.isClosed(), "close resolves after the worker died (no reachable native handle)");
    const m = workerMonitor();
    if (m !== undefined) notes.push("independent monitor (" + m.source + "): created " + m.created + ", ended " + m.ended);
  }, proxy);

  await check("T13", "A live wallet stays usable and its allocator unchanged while ten wrong-password opens, ten invalid restores and one aborted construction fail in fresh workers (direct: shared-instance growth shown)", async (notes) => {
    const live = await open();
    await hooks.target(live);
    for (let i = 0; i < 3; i++) await live.getData(); // warm-up
    const seedText = await live.getSeed(); // also warm-up: the first seed call lazily builds the core's word lists (about 2.5 MB, once per instance)
    const aux = await F.createRandomWallet({ networkType: 0, password: pw, proxyToWorker: proxy }); // supplies a spend key of another wallet
    const otherSpend = await aux.getPrivateSpendKey();
    await aux.close();
    const s0 = await hooks.state();
    const n0 = hooks.started().length;
    const a0 = acc();
    for (let i = 0; i < 10; i++) await expectCode(open(pw + "-wrong-" + i), "WRONG_PASSWORD", "wrong-password open " + (i + 1), i === 0 ? notes : []);
    for (let i = 0; i < 5; i++) {
      await expectCode(F.restoreWalletFromSeed({ networkType: 0, password: pw, seed: brokenChecksumSeed(seedText, i * 5), proxyToWorker: proxy }), "INVALID_RECOVERY_MATERIAL", "broken seed checksum " + (i + 1), i === 0 ? notes : []);
      await expectCode(F.restoreWalletFromKeys({ networkType: 0, password: pw, primaryAddress: address, privateSpendKey: otherSpend, proxyToWorker: proxy }), "INVALID_RECOVERY_MATERIAL", "mismatched spend key " + (i + 1), i === 0 ? notes : []);
    }
    // one aborted construction: during native construction (worker) or already aborted (direct)
    const ctl = new AbortController();
    let abortedOutcome: string;
    if (wi !== undefined) {
      let entered = -1;
      wi.onNativeEnter = (index, name) => { if (name === "create_full_wallet" && entered < 0) entered = index; };
      const p = outcomeOf(F.createRandomWallet(LONG, { signal: ctl.signal }));
      await waitUntil(() => entered >= 0, 30000);
      ctl.abort();
      abortedOutcome = await p;
      wi.onNativeEnter = undefined;
    } else {
      ctl.abort();
      abortedOutcome = await outcomeOf(F.createRandomWallet(LONG, { signal: ctl.signal }));
    }
    expect(abortedOutcome === "NATIVE_ERROR/CONSTRUCTION_ABORTED", "the aborted construction rejects CONSTRUCTION_ABORTED: " + abortedOutcome);
    const s1 = await hooks.state();
    const d = await live.getData();
    expect((await live.getPrimaryAddress()) === address && d.keys.length > 0, "live wallet usable");
    const delta = s1.heapInUse - s0.heapInUse;
    if (wi !== undefined) {
      const failed = wi.started().slice(n0);
      const a1 = acc();
      notes.push("live wallet allocator bytes in use: before " + s0.heapInUse + ", after " + s1.heapInUse + " (delta " + delta + "); fresh workers " + failed.length + " (20 failed, 1 aborted), all terminated " + failed.every((t) => t.terminated) + "; wallet workers " + a0.walletWorkers + " -> " + a1.walletWorkers);
      expect(delta === 0, "no allocator growth in the live wallet's instance");
      expect(failed.length === 21 && failed.every((t) => t.terminated) && a1.constructionWorkers === 0 && a1.walletWorkers === a0.walletWorkers, "each attempt had its own worker, and each was terminated");
      expect(failed.slice(0, 20).every((t) => t.telemetry !== undefined && t.telemetry.wallets === 0), "no failed worker held a wallet");
    } else {
      notes.push("direct mode (one shared instance, non-isolating): allocator bytes in use grew by " + delta + " over the 20 failed constructions (fixed-core constructor leak; positive control of the measurement)");
      expect(delta > 0, "direct mode shows the shared-instance growth that worker isolation discards");
    }
    await live.close();
  });

  await check("T14", "Two live wallets concurrently: queued password changes and getData on both, unknown password state in one, close of one leaves the other and its worker untouched", async (notes) => {
    const a = await open(); const b = await open();
    if (proxy) expect(channelOf(a) !== channelOf(b) && channelOf(a).isOpen() && channelOf(b).isOpen(), "each wallet owns its worker");
    const pa1 = randomPassword(); const pa2 = randomPassword(); const pb1 = randomPassword(); const pb2 = randomPassword();
    const qa = [a.changePassword(pw, pa1), a.getData(), a.changePassword(pa1, pa2), a.getData()];
    const qb = [b.changePassword(pw, pb1), b.getData(), b.changePassword(pb1, pb2), b.getData()];
    const r = await Promise.all([...qa, ...qb]);
    const ga1 = await openingPasswords(r[1] as F.ZephyrWalletData, [pw, pa1, pa2], proxy);
    const ga2 = await openingPasswords(r[3] as F.ZephyrWalletData, [pw, pa1, pa2], proxy);
    const gb1 = await openingPasswords(r[5] as F.ZephyrWalletData, [pw, pb1, pb2], proxy);
    const gb2 = await openingPasswords(r[7] as F.ZephyrWalletData, [pw, pb1, pb2], proxy);
    notes.push("interleaved queues: a getData open with " + ga1.join("") + " then " + ga2.join("") + "; b with " + gb1.join("") + " then " + gb2.join(""));
    expect(ga1.join(",") === "1" && ga2.join(",") === "2" && gb1.join(",") === "1" && gb2.join(",") === "2", "each wallet's queue kept its own order");
    // unknown password state in a; b keeps working
    await hooks.target(a);
    await hooks.resetCounters();
    await hooks.arm({ fail: { "change_password.after": 1, "password_probe": 1 } });
    await expectCode(a.changePassword(pa2, randomPassword()), "NATIVE_ERROR", "a: change with an unknown native state", notes, "PASSWORD_STATE_UNKNOWN");
    await expectCode(a.getData(), "NATIVE_ERROR", "a: getData after the unknown state", notes, "PASSWORD_STATE_UNKNOWN");
    const pb3 = randomPassword();
    await b.changePassword(pb2, pb3);
    const gb3 = await openingPasswords(await b.getData(), [pb2, pb3], proxy);
    expect(gb3.join(",") === "1", "b unaffected by a's unknown state");
    // close a: only a's worker ends
    await a.close();
    if (proxy) expect(!channelOf(a).isOpen() && channelOf(b).isOpen(), "closing a terminated only a's worker");
    expect((await b.getPrimaryAddress()) === address, "b usable after a closed");
    await b.close();
    if (proxy) expect(!channelOf(b).isOpen(), "closing b terminated its worker");
  });

  await check("T15", "The pinned core's wallet_internal_error \"invalid password\" maps to WRONG_PASSWORD in the open context only", async (notes) => {
    const w = await open();
    const cases: Array<[string, string, "next" | "wallet", () => Promise<unknown>, string, string]> = [
      ["open, wallet_internal_error \"invalid password\"", "error.open", "next", () => open(pw), "WRONG_PASSWORD", "CORE_INVALID_PASSWORD"],
      ["open, wallet_internal_error \"invalid password\" with an empty password", "error.open", "next", () => open(""), "WRONG_PASSWORD", "CORE_INVALID_PASSWORD"],
      ["random creation, the same exception", "error.create", "next", () => F.createRandomWallet({ networkType: 0, password: pw, proxyToWorker: proxy }), "NATIVE_ERROR", "CORE_UNCLASSIFIED"],
      ["getter, the same exception", "error.getter", "wallet", () => w.getSeed(), "NATIVE_ERROR", "CORE_UNCLASSIFIED"]
    ];
    for (const [label, point, where, call, code, diagnostic] of cases) {
      await hooks.target(w);
      await hooks.resetCounters();
      if (where === "next") await hooks.armNext({ fail: { [point]: 1 }, kind: { [point]: 5 } });
      else await hooks.arm({ fail: { [point]: 1 }, kind: { [point]: 5 } });
      await expectCode(call(), code, label, notes, diagnostic);
      const st = where === "next" ? await hooks.lastStartedState() : await hooks.state(false);
      expect(st.injected === 1, label + ": exactly one injected failure");
    }
    await hooks.target(w);
    expect((await w.getPrimaryAddress()) === address, "wallet usable after the injected failures");
    await w.close();
  });

  await check("T16", "A failing step after hand-off (daemon connection) closes the native wallet and retires its worker before the construction rejects", async (notes) => {
    const before = acc();
    const routesBefore = HttpClient.daemonRouteCount();
    if (!proxy) await hooks.resetCounters(); // worker mode: the construction starts a fresh, armed worker
    // the injected failure fires at the start of set_daemon_connection: no request is made (offline suite)
    await hooks.armNext({ fail: { "error.daemon": 1 }, kind: { "error.daemon": 1 } });
    await expectCode(F.openWalletData({ networkType: 0, password: pw, keysData: copyBytes(keys), cacheData: copyBytes(cache), server: "http://127.0.0.1:9", proxyToWorker: proxy }), "DAEMON_ERROR", "open with a failing connection step", notes, "DAEMON_RESPONSE");
    const st = await hooks.lastStartedState();
    const after = acc();
    notes.push("native calls of the construction: open " + nativeCalls(st, "open_wallet_full") + ", set_daemon_connection " + nativeCalls(st, "set_daemon_connection") + ", close " + nativeCalls(st, "close") + "; injected " + st.injected);
    expect(st.injected === 1 && nativeCalls(st, "open_wallet_full") === 1 && nativeCalls(st, "set_daemon_connection") === 1, "the construction succeeded and the connection step failed once");
    expect(nativeCalls(st, "close") === 1, "the native wallet was closed before the construction rejected");
    if (proxy) {
      expect(after.walletWorkers === before.walletWorkers && after.constructionWorkers === 0 && after.activeConstructions === 0 && after.workersStarted === before.workersStarted + 1 && after.workersTerminated === before.workersTerminated + 1, "its worker was retired: no live worker without an owner");
    } else {
      expect(HttpClient.daemonRouteCount() === routesBefore, "the direct wallet's daemon route was released with its close");
    }
    const t = await open();
    const seedText = await t.getSeed();
    await t.close();
    if (!proxy) await hooks.resetCounters();
    await hooks.armNext({ fail: { "error.daemon": 1 }, kind: { "error.daemon": 2 } });
    await expectCode(F.restoreWalletFromSeed({ networkType: 0, password: pw, seed: seedText, restoreHeight: 1, server: { uri: "http://127.0.0.1:9/rpc" }, proxyToWorker: proxy }), "DAEMON_ERROR", "seed restore with a failing connection step (non-standard exception)", notes, "DAEMON_RESPONSE");
    const st2 = await hooks.lastStartedState();
    expect(st2.injected === 1 && nativeCalls(st2, "close") === 1, "second case: one injected failure and one native close");
    const after2 = acc();
    if (proxy) expect(after2.walletWorkers === before.walletWorkers && after2.constructionWorkers === 0, "no worker left after the second case");
  });

  report.networkGuard = combinedGuard(await Internal.getNetworkGuardReport()); // open workers now plus the test layer's reads before each close
  report.workerAccounting = acc();
  report.workerMonitor = await waitWorkerMonitor(acc().utilityWorkers, 10000); // exit events of the last closed workers may still be pending
  report.finishedUtc = new Date().toISOString();
  if (LibraryUtils.WORKER === undefined) report.nativeCloseCalls = undefined;
  return report;
}
