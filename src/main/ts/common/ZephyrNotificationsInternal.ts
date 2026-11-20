/**
 * Parsers, worker data shapes, the delivery and the background loop of the wallet notifications
 * (common/ZephyrNotifications.ts holds the public types). Internal: the package entry does not export this module, and
 * no declaration the entry reaches refers to it.
 *
 * Path of a notification: the core calls the bridge's listener inside a sync, a pool refresh or a relay; the bridge
 * hands a fixed-format JSON text to the wallet's native sink (ZephyrWalletFull), which parses it strictly here and
 * passes the notification on without running any callback: in direct mode into the wallet facade's queue, which is
 * delivered once the native call has yielded or returned; in a worker into one message to the owner, which validates it
 * like an error envelope (every field typed and bounded, MALFORMED_MESSAGE otherwise) and queues it the same way.
 * deliverNotification then calls the listeners and drops whatever they throw or reject, without reading it.
 */
import ZephyrWalletError from "./ZephyrWalletError";
import * as WalletErrors from "./ZephyrWalletErrorMapping";
import type { ZephyrWalletErrorEnvelope } from "./ZephyrWalletErrorMapping";
import { SYNC_PERIOD_DEFAULT_MS, isAddressIndex, isSyncPeriod, isWorkerId } from "./ZephyrLifecycleContract";
import type { ZephyrWalletListener, ZephyrWalletOutput } from "./ZephyrNotifications";

/** The callback names of a listener, as the public interface lists them. */
export const LISTENER_CALLBACKS = ["onSyncProgress", "onNewBlock", "onBalancesChanged", "onOutputReceived", "onOutputSpent", "onSyncError"] as const;

/** The callback id under which a wallet worker posts notifications to the wallet's owner. */
export const NOTIFICATION_CALLBACK_ID = "zephyrNotification";

/** The progress texts of the pinned core (zephyr-cpp wallet2_listener sends only this one); any other text is replaced by it. */
export const SYNC_PROGRESS_MESSAGES: readonly string[] = ["Synchronizing"];

const UINT64_MAX = BigInt("18446744073709551615");
const DECIMAL = /^(0|[1-9][0-9]{0,19})$/;
const ASSET_TOKEN = /^[A-Z0-9]{1,16}$/;
const TX_HASH = /^[0-9a-f]{64}$/;
/** the bridge's fraction text: printf "%.17g" of a finite double from 0 to 1 */
const FRACTION_TEXT = /^(0|[1-9][0-9]*)(\.[0-9]+)?(e[+-][0-9]+)?$/;
const MAX_MESSAGE_LENGTH = 256;
const MAX_BRIDGE_TEXT = 4096;

/** A notification inside the library (bigint amounts, number heights, frozen outputs). */
export type ZephyrNotification =
  | { readonly type: "syncProgress"; readonly height: number; readonly startHeight: number; readonly endHeight: number; readonly percentDone: number; readonly message: string }
  | { readonly type: "newBlock"; readonly height: number }
  | { readonly type: "balancesChanged"; readonly balance: bigint; readonly unlockedBalance: bigint; readonly assetType: string }
  | { readonly type: "outputReceived" | "outputSpent"; readonly output: ZephyrWalletOutput }
  | { readonly type: "syncError"; readonly error: ZephyrWalletError };

/** Worker DTO of a notification: decimal text for every amount and height, numbers for indices and the fraction. */
export type ZephyrNotificationDto = Readonly<Record<string, string | number | ZephyrWalletErrorEnvelope>>;

function unexpected(): never {
  throw new ZephyrWalletError("NATIVE_ERROR", "UNEXPECTED_RESULT");
}

function malformed(): never {
  throw new ZephyrWalletError("MALFORMED_MESSAGE", "MESSAGE_SHAPE");
}

function plainObject(value: unknown, fail: () => never): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail();
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) fail();
  if (Object.getOwnPropertySymbols(value).length !== 0 || Object.getOwnPropertyNames(value).length !== Object.keys(value).length) fail();
  return value as Record<string, unknown>;
}

/** The object has exactly the required names and, of the optional names, only some. */
function exactKeys(fields: Record<string, unknown>, required: readonly string[], optional: readonly string[], fail: () => never): void {
  for (const name of required) if (!Object.prototype.hasOwnProperty.call(fields, name)) fail();
  for (const name of Object.keys(fields)) if (!required.includes(name) && !optional.includes(name)) fail();
}

function uint64Of(text: unknown, fail: () => never): bigint {
  if (typeof text !== "string" || !DECIMAL.test(text)) fail();
  const value = BigInt(text);
  if (value > UINT64_MAX) fail();
  return value;
}

function heightOf(text: unknown, fail: () => never): number {
  const value = uint64Of(text, fail);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) fail();
  return Number(value);
}

function assetOf(value: unknown, fail: () => never): string {
  if (typeof value !== "string" || !ASSET_TOKEN.test(value)) fail();
  return value;
}

function indexOf(value: unknown, fail: () => never): number {
  if (!isAddressIndex(value)) fail();
  return value;
}

function fractionOf(value: unknown, fail: () => never): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) fail();
  return value;
}

/** A progress text: one of the fixed set passes, any other text is replaced (a non-string or an overlong one is malformed). */
function messageOf(value: unknown, fail: () => never): string {
  if (typeof value !== "string" || value.length > MAX_MESSAGE_LENGTH) fail();
  return SYNC_PROGRESS_MESSAGES.includes(value) ? value : SYNC_PROGRESS_MESSAGES[0];
}

const PROGRESS_FIELDS = ["type", "height", "startHeight", "endHeight", "percentDone", "message"];
const BLOCK_FIELDS = ["type", "height"];
const BALANCE_FIELDS = ["type", "balance", "unlockedBalance", "assetType"];
const OUTPUT_FIELDS = ["type", "amount", "txHash"];
const OUTPUT_OPTIONAL = ["accountIndex", "subaddressIndex", "height", "assetType"];

/** The notification of one parsed object (bridge text or worker DTO); percentDone is read by the caller's rule. */
function notificationOf(fields: Record<string, unknown>, fraction: (value: unknown) => number, extra: readonly string[], fail: () => never): ZephyrNotification {
  switch (fields.type) {
    case "syncProgress": {
      exactKeys(fields, PROGRESS_FIELDS, extra, fail);
      const height = heightOf(fields.height, fail), startHeight = heightOf(fields.startHeight, fail), endHeight = heightOf(fields.endHeight, fail);
      if (height < startHeight || endHeight <= startHeight || height >= endHeight) fail();
      return Object.freeze({ type: "syncProgress", height, startHeight, endHeight, percentDone: fraction(fields.percentDone), message: messageOf(fields.message, fail) });
    }
    case "newBlock":
      exactKeys(fields, BLOCK_FIELDS, extra, fail);
      return Object.freeze({ type: "newBlock", height: heightOf(fields.height, fail) });
    case "balancesChanged":
      exactKeys(fields, BALANCE_FIELDS, extra, fail);
      return Object.freeze({ type: "balancesChanged", balance: uint64Of(fields.balance, fail), unlockedBalance: uint64Of(fields.unlockedBalance, fail), assetType: assetOf(fields.assetType, fail) });
    case "outputReceived":
    case "outputSpent": {
      exactKeys(fields, OUTPUT_FIELDS, [...OUTPUT_OPTIONAL, ...extra], fail);
      if (typeof fields.txHash !== "string" || !TX_HASH.test(fields.txHash)) fail();
      const output: { amount: bigint; accountIndex?: number; subaddressIndex?: number; txHash: string; height?: number; assetType?: string } = { amount: uint64Of(fields.amount, fail), txHash: fields.txHash };
      if (Object.prototype.hasOwnProperty.call(fields, "accountIndex")) output.accountIndex = indexOf(fields.accountIndex, fail);
      if (Object.prototype.hasOwnProperty.call(fields, "subaddressIndex")) output.subaddressIndex = indexOf(fields.subaddressIndex, fail);
      if (Object.prototype.hasOwnProperty.call(fields, "height")) output.height = heightOf(fields.height, fail);
      if (Object.prototype.hasOwnProperty.call(fields, "assetType")) output.assetType = assetOf(fields.assetType, fail);
      return Object.freeze({ type: fields.type, output: Object.freeze(output) });
    }
    default:
      return fail();
  }
}

/**
 * One notification text of the bridge (src/main/cpp/zephyr_wasm_bridge.cpp, wallet notifications) to a notification.
 * {"type":"unreadable"} (a notification the bridge could not write) and any text that is not exactly one of the formats
 * become a syncError with NATIVE_ERROR/UNEXPECTED_RESULT; this never throws.
 */
export function parseBridgeNotification(text: unknown): ZephyrNotification {
  try {
    if (typeof text !== "string" || text.charAt(0) !== "{" || text.length > MAX_BRIDGE_TEXT) unexpected();
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch (ignored) { unexpected(); }
    const fields = plainObject(parsed, unexpected);
    return notificationOf(fields, (value) => {
      if (typeof value !== "string" || value.length > 40 || !FRACTION_TEXT.test(value)) unexpected();
      return fractionOf(Number(value), unexpected);
    }, [], unexpected);
  } catch (err) {
    return Object.freeze({ type: "syncError", error: err instanceof ZephyrWalletError ? err : new ZephyrWalletError("NATIVE_ERROR", "UNEXPECTED_RESULT") });
  }
}

/** The worker DTO of a notification; tag names the sync of a per-sync listener (a worker id). */
export function toNotificationDto(notification: ZephyrNotification, tag: string | undefined): ZephyrNotificationDto {
  const out: Record<string, string | number | ZephyrWalletErrorEnvelope> = { type: notification.type };
  switch (notification.type) {
    case "syncProgress":
      out.height = String(notification.height); out.startHeight = String(notification.startHeight); out.endHeight = String(notification.endHeight);
      out.percentDone = notification.percentDone; out.message = notification.message;
      break;
    case "newBlock":
      out.height = String(notification.height);
      break;
    case "balancesChanged":
      out.balance = notification.balance.toString(); out.unlockedBalance = notification.unlockedBalance.toString(); out.assetType = notification.assetType;
      break;
    case "outputReceived":
    case "outputSpent": {
      const o = notification.output;
      out.amount = o.amount.toString(); out.txHash = o.txHash;
      if (o.accountIndex !== undefined) out.accountIndex = o.accountIndex;
      if (o.subaddressIndex !== undefined) out.subaddressIndex = o.subaddressIndex;
      if (o.height !== undefined) out.height = String(o.height);
      if (o.assetType !== undefined) out.assetType = o.assetType;
      break;
    }
    case "syncError":
      out.error = WalletErrors.toEnvelope(notification.error);
      break;
  }
  if (tag !== undefined) out.sync = tag;
  return out;
}

/**
 * The arguments of a notification message from a wallet worker ([dto]) to the notification and its sync tag. The DTO
 * must be a plain object with exactly the fields of its type, each typed and bounded, and optionally the tag (a worker
 * id); a syncError carries a strictly valid error envelope. Anything else rejects with MALFORMED_MESSAGE/MESSAGE_SHAPE.
 */
export function fromNotificationMessage(args: readonly unknown[]): { readonly notification: ZephyrNotification; readonly tag: string | undefined } {
  if (args.length !== 1) malformed();
  const fields = plainObject(args[0], malformed);
  let tag: string | undefined = undefined;
  if (Object.prototype.hasOwnProperty.call(fields, "sync")) {
    if (!isWorkerId(fields.sync)) malformed();
    tag = fields.sync;
  }
  if (fields.type === "syncError") {
    exactKeys(fields, ["type", "error"], ["sync"], malformed);
    if (!WalletErrors.isEnvelope(fields.error)) malformed();
    return { notification: Object.freeze({ type: "syncError", error: WalletErrors.fromEnvelope(fields.error) }), tag };
  }
  return { notification: notificationOf(fields, (value) => fractionOf(value, malformed), ["sync"], malformed), tag };
}

/**
 * A listener argument: an object (or a function object) whose callbacks, where present, are functions. Anything else
 * rejects with INVALID_CONFIG/LISTENER; a property read that throws counts as not a listener.
 */
export function checkListener(listener: unknown): ZephyrWalletListener {
  if (listener === null || (typeof listener !== "object" && typeof listener !== "function") || Array.isArray(listener)) throw new ZephyrWalletError("INVALID_CONFIG", "LISTENER");
  for (const name of LISTENER_CALLBACKS) {
    let callback: unknown;
    try { callback = (listener as Record<string, unknown>)[name]; } catch (ignored) { throw new ZephyrWalletError("INVALID_CONFIG", "LISTENER"); }
    if (callback !== undefined && typeof callback !== "function") throw new ZephyrWalletError("INVALID_CONFIG", "LISTENER");
  }
  return listener as ZephyrWalletListener;
}

/** startSyncing's period: undefined gives the default; otherwise an integer within the range (INVALID_CONFIG/SYNC_PERIOD). */
export function checkSyncPeriod(value: unknown): number {
  if (value === undefined) return SYNC_PERIOD_DEFAULT_MS;
  if (!isSyncPeriod(value)) throw new ZephyrWalletError("INVALID_CONFIG", "SYNC_PERIOD");
  return value;
}

/** Ignore a returned promise's outcome (also a thenable); its reason is never read. Never throws. */
function ignoreOutcome(value: unknown): void {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return;
  try {
    const then = (value as { then?: unknown }).then;
    if (typeof then === "function") then.call(value, undefined, () => undefined);
  } catch (ignored) {
    // a throwing then is dropped like a throwing callback
  }
}

/** Call one callback of one listener; whatever it throws or rejects is dropped unread. Never throws. */
function invoke(listener: ZephyrWalletListener, name: typeof LISTENER_CALLBACKS[number], args: readonly unknown[]): void {
  let callback: unknown;
  try { callback = (listener as Record<string, unknown>)[name]; } catch (ignored) { return; }
  if (typeof callback !== "function") return;
  let result: unknown;
  try {
    result = (callback as (...a: unknown[]) => unknown).apply(listener, args as unknown[]);
  } catch (ignored) {
    return; // dropped without reading it: the sync, the other listeners and the rest of the block's notifications go on
  }
  ignoreOutcome(result);
}

/**
 * Deliver one notification to the listeners in their order. Each listener gets every notification whatever another one
 * throws; a syncError gives each listener a new error object with the same code and diagnostic. Never throws.
 */
export function deliverNotification(listeners: readonly ZephyrWalletListener[], notification: ZephyrNotification): void {
  for (const listener of listeners) {
    switch (notification.type) {
      case "syncProgress": invoke(listener, "onSyncProgress", [notification.height, notification.startHeight, notification.endHeight, notification.percentDone, notification.message]); break;
      case "newBlock": invoke(listener, "onNewBlock", [notification.height]); break;
      case "balancesChanged": invoke(listener, "onBalancesChanged", [notification.balance, notification.unlockedBalance, notification.assetType]); break;
      case "outputReceived": invoke(listener, "onOutputReceived", [notification.output]); break;
      case "outputSpent": invoke(listener, "onOutputSpent", [notification.output]); break;
      case "syncError": invoke(listener, "onSyncError", [new ZephyrWalletError(notification.error.code, notification.error.diagnostic)]); break;
    }
  }
}

/**
 * The background loop of one wallet (startSyncing): runs iterate at once, then again each period after the previous
 * iteration started (at once when it took longer), until stop. iterate reports its own failures and must not throw.
 * One iteration at a time: the next one starts only after the previous one settled. stop ends the loop and resolves
 * once the running iteration (if any) has settled; no iteration of that loop starts afterwards. The waiting timer keeps a
 * Node.js process alive while the loop runs.
 */
export class ZephyrSyncLoop {

  private readonly iterate: () => Promise<void>;
  private periodMs = SYNC_PERIOD_DEFAULT_MS;
  private current: { active: boolean; wake: (() => void) | undefined; done: Promise<void> } | undefined = undefined;

  constructor(iterate: () => Promise<void>) {
    this.iterate = iterate;
  }

  /** Whether a loop runs (started and not stopped). */
  isActive(): boolean {
    return this.current !== undefined && this.current.active;
  }

  /** Start the loop, or set the period of the running one (taking effect at its next wait). */
  start(periodMs: number): void {
    this.periodMs = periodMs;
    if (this.current !== undefined && this.current.active) return;
    const run: { active: boolean; wake: (() => void) | undefined; done: Promise<void> } = { active: true, wake: undefined, done: Promise.resolve() };
    this.current = run;
    run.done = this.loop(run);
  }

  /** Stop the loop; resolves when its running iteration has settled. */
  async stop(): Promise<void> {
    const run = this.current;
    if (run === undefined) return;
    run.active = false;
    if (run.wake !== undefined) run.wake();
    await run.done;
    if (this.current === run) this.current = undefined;
  }

  private async loop(run: { active: boolean; wake: (() => void) | undefined; done: Promise<void> }): Promise<void> {
    while (run.active) {
      const started = Date.now();
      try { await this.iterate(); } catch (ignored) { /* iterate reports its own failures */ }
      if (!run.active) break;
      const wait = Math.max(0, this.periodMs - (Date.now() - started));
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { run.wake = undefined; resolve(); }, wait);
        run.wake = () => { clearTimeout(timer); run.wake = undefined; resolve(); };
      });
    }
  }
}
