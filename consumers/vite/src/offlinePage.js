// The offline platform page (index.html?offline): runs offlineChecks.js with the wallet in a worker,
// shows PASS or FAIL per check, the browser and system the page detected and a short result block
// to copy, and posts the result to /result. No daemon is used.
//
// Optional online step, never automatic: when the serving process forwards a daemon under the base
// path /rpc of this origin (GET /info.json says so), the page offers a button for a read-only step:
// connect, read the daemon height, create a new wallet at that height (or, when the server offers
// one at /seed/*, open a saved disposable wallet instead) and sync it. Nothing is built or submitted.
// ?online starts that step right after the offline checks (for a test of the page itself).
import * as z from "@loki-notfound/zephyr-ts";
import { CHECKS, runOfflineChecks } from "./offlineChecks.js";

const ONLINE = [
  ["O01", "The daemon answers through this origin: connected, height, synchronized"],
  ["O02", "A new wallet starts at the daemon height (a saved wallet: at most 2,000 blocks below it)"],
  ["O03", "One sync reaches the daemon height; balances and history of a wallet without funds"]
];

const el = (tag, text, parent) => { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (parent) parent.appendChild(e); return e; };

async function detectEnvironment() {
  const env = { userAgent: navigator.userAgent, platform: navigator.platform, language: navigator.language, secureContext: globalThis.isSecureContext === true,
    cores: navigator.hardwareConcurrency, webCrypto: !!(globalThis.crypto && globalThis.crypto.subtle) };
  const uad = navigator.userAgentData;
  if (uad && typeof uad.getHighEntropyValues === "function") {
    try {
      const h = await uad.getHighEntropyValues(["platformVersion", "architecture", "bitness", "fullVersionList"]);
      env.clientHints = { platform: h.platform, platformVersion: h.platformVersion, architecture: h.architecture, bitness: h.bitness,
        brands: (h.fullVersionList || []).filter((b) => !/Not.?A.?Brand/i.test(b.brand)).map((b) => b.brand + " " + b.version) };
    } catch (e) { env.clientHints = { unavailable: true }; }
  }
  env.summary = summarize(env);
  return env;
}

function summarize(env) {
  const ua = env.userAgent;
  let browser = "unknown browser";
  let m;
  if ((m = /Edg\/([\d.]+)/.exec(ua))) browser = "Edge " + m[1];
  else if ((m = /Firefox\/([\d.]+)/.exec(ua))) browser = "Firefox " + m[1];
  else if ((m = /Electron\/([\d.]+)/.exec(ua))) browser = "Electron " + m[1] + (/Chrome\/([\d.]+)/.exec(ua) ? " (Chromium " + /Chrome\/([\d.]+)/.exec(ua)[1] + ")" : "");
  else if ((m = /Chrome\/([\d.]+)/.exec(ua))) browser = (/Chromium\//.test(ua) ? "Chromium " : "Chrome ") + m[1];
  else if ((m = /Version\/([\d.]+).*Safari\//.exec(ua))) browser = "Safari " + m[1];
  if (env.clientHints && Array.isArray(env.clientHints.brands) && env.clientHints.brands.length && !/^Electron/.test(browser)) {
    const b = env.clientHints.brands.find((x) => /^(Google Chrome|Microsoft Edge|Chromium|Opera|Brave)/.test(x));
    if (b) browser = b;
  }
  let system = "unknown system";
  if ((m = /Windows NT ([\d.]+)/.exec(ua))) system = "Windows NT " + m[1];
  else if ((m = /Mac OS X ([\d_.]+)/.exec(ua))) system = "macOS (reported " + m[1].replace(/_/g, ".") + ")";
  else if (/Linux/.test(ua)) system = "Linux";
  const ch = env.clientHints;
  if (ch && ch.platform) {
    let v = ch.platformVersion;
    if (ch.platform === "Windows" && v) v = Number(v.split(".")[0]) >= 13 ? v + " (Windows 11)" : Number(v.split(".")[0]) > 0 ? v + " (Windows 10)" : v;
    system = ch.platform + (v ? " " + v : "") + (ch.architecture ? " " + ch.architecture + (ch.bitness ? "-" + ch.bitness : "") : "");
  }
  return browser + " on " + system;
}

function renderChecks(table, list, results) {
  table.textContent = "";
  for (const [id, title] of list) {
    const r = results.find((x) => x.id === id);
    const row = el("tr", undefined, table);
    const s = el("td", r ? (r.status === "pass" ? "PASS" : "FAIL") : "...", row);
    s.style.fontWeight = "bold";
    s.style.color = r ? (r.status === "pass" ? "#0a7a0a" : "#b00020") : "#666";
    el("td", id, row);
    el("td", title + (r && r.status !== "pass" ? " (" + (r.notes || []).slice(-1).join("") + ")" : ""), row);
  }
}

function resultBlock(state) {
  const line = (list, results) => list.map(([id]) => { const r = results.find((x) => x.id === id); return id + "=" + (r ? r.status : "not-run"); }).join(" ");
  const ok = (results, list) => results.length === list.length && results.every((r) => r.status === "pass");
  const out = ["zephyr-ts platform check, " + new Date().toISOString(),
    "tarball sha256: " + (state.info.tarballSha256 || "unknown"),
    "module sha256: " + (state.info.wasmSha256 || "unknown"),
    "detected: " + state.env.summary,
    "user agent: " + state.env.userAgent,
    "secure context: " + state.env.secureContext + ", cores: " + state.env.cores,
    "offline: " + (state.offline ? (ok(state.offline, CHECKS) ? "PASS " : "FAIL ") + line(CHECKS, state.offline) : "running")];
  if (state.online) out.push("online: " + (ok(state.online.checks, ONLINE) ? "PASS " : "FAIL ") + line(ONLINE, state.online.checks) + "; " + state.online.facts);
  else out.push("online: not run");
  return out.join("\n");
}

async function post(body) {
  try { await fetch("/result", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); } catch (e) { /* shown on the page anyway */ }
}

async function runOnline(info, useSeed) {
  const checks = [];
  const facts = [];
  const add = (id, pass, note) => checks.push({ id, title: ONLINE.find((o) => o[0] === id)[1], status: pass ? "pass" : "fail", notes: [note] });
  const server = location.origin + "/rpc";
  let wallet;
  try {
    const password = "disposable platform check";
    if (useSeed) {
      const get = async (p) => new Uint8Array(await (await fetch(p, { cache: "no-store" })).arrayBuffer());
      wallet = await z.openWalletData({ networkType: "mainnet", password: new TextDecoder().decode(await get("/seed/password")), keysData: await get("/seed/keys"), cacheData: await get("/seed/cache"), server });
    } else {
      wallet = await z.createRandomWallet({ networkType: "mainnet", password, server });
    }
    const connected = await wallet.isConnectedToDaemon();
    const daemonHeight = await wallet.getDaemonHeight();
    const synced = await wallet.isDaemonSynced();
    add("O01", connected && Number.isSafeInteger(daemonHeight) && daemonHeight > 0 && synced, "connected " + connected + ", height " + daemonHeight + ", synchronized " + synced);
    facts.push("daemon height " + daemonHeight);
    const start = useSeed ? await wallet.getHeight() : await wallet.getRestoreHeight();
    add("O02", useSeed ? daemonHeight - start <= 2000 && start <= daemonHeight : start <= daemonHeight && daemonHeight - start <= 3, (useSeed ? "saved wallet at " : "restore height ") + start);
    facts.push((useSeed ? "saved wallet at " : "new wallet at ") + start);
    const t0 = Date.now();
    const sync = await wallet.sync();
    const height = await wallet.getHeight();
    const daemonHeight2 = await wallet.getDaemonHeight();
    const balances = await wallet.getBalance();
    const history = (await wallet.getTxs()).length;
    const zero = balances.size === 8 && Array.from(balances.values()).every((v) => v === 0n);
    add("O03", daemonHeight2 - height <= 1 && zero && history === 0, "synced to " + height + " (daemon " + daemonHeight2 + "), " + sync.numBlocksFetched + " blocks fetched in " + Math.round((Date.now() - t0) / 1000) + " s");
    facts.push("synced " + sync.numBlocksFetched + " blocks to " + height + " in " + Math.round((Date.now() - t0) / 1000) + " s");
  } catch (e) {
    const code = e instanceof z.ZephyrWalletError ? e.code + (e.diagnostic ? "/" + e.diagnostic : "") : e && e.name;
    for (const [id] of ONLINE) if (!checks.find((c) => c.id === id)) add(id, false, "FAILED: " + code);
  } finally {
    if (wallet) await wallet.close().catch(() => undefined);
  }
  return { checks, facts: facts.join(", "), seed: useSeed };
}

export async function runOfflinePage() {
  const status = document.getElementById("status");
  document.title = "zephyr-ts platform check";
  const head = el("h1", "zephyr-ts platform check");
  document.body.insertBefore(head, status);
  const detected = el("p", "detecting the browser", undefined);
  document.body.insertBefore(detected, status);
  const table = el("table", undefined, document.body);
  const onlineBox = el("div", undefined, document.body);
  el("p", "Result to copy:", document.body);
  const block = el("textarea", undefined, document.body);
  block.readOnly = true; block.rows = 10; block.cols = 100; block.style.fontFamily = "monospace";
  const state = { env: await detectEnvironment(), info: {}, offline: undefined, online: undefined };
  detected.textContent = "Detected: " + state.env.summary;
  try { state.info = await (await fetch("/info.json", { cache: "no-store" })).json(); } catch (e) { state.info = {}; }
  renderChecks(table, CHECKS, []);
  block.value = resultBlock(state);
  status.textContent = "running the offline checks";
  let report;
  try {
    report = await runOfflineChecks(z, { proxyToWorker: true, log: (line) => { status.textContent = "running the offline checks: " + line; } });
  } catch (e) {
    report = { checks: [], fatal: e && e.name };
  }
  state.offline = report.checks;
  renderChecks(table, CHECKS, report.checks);
  block.value = resultBlock(state);
  const passed = report.checks.length === CHECKS.length && report.checks.every((c) => c.status === "pass");
  status.textContent = passed ? "offline checks: PASS" : "offline checks: FAIL";
  await post({ phase: "offline", env: state.env, checks: report.checks, fatal: report.fatal });
  const online = state.info.online;
  if (online && online.available) {
    const query = new URLSearchParams(location.search);
    const button = el("button", "Run the online step (read-only, through this page's server to " + online.upstream + ")", onlineBox);
    const onlineTable = el("table", undefined, onlineBox);
    const go = async () => {
      button.disabled = true;
      status.textContent = "running the online step";
      renderChecks(onlineTable, ONLINE, []);
      state.online = await runOnline(state.info, online.seed === true);
      renderChecks(onlineTable, ONLINE, state.online.checks);
      block.value = resultBlock(state);
      const ok = state.online.checks.every((c) => c.status === "pass");
      status.textContent = (passed ? "offline checks: PASS" : "offline checks: FAIL") + "; online step: " + (ok ? "PASS" : "FAIL");
      await post({ phase: "online", env: state.env, checks: state.online.checks, facts: state.online.facts, seed: state.online.seed });
    };
    button.addEventListener("click", go);
    if (query.has("online")) await go();
  }
}
