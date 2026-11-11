import ZephyrWalletError from "./ZephyrWalletError";

/**
 * Daemon address contract of the read-only daemon access.
 *
 * Accepted input: a URL string, or a plain object { uri, trusted? }. The URL has the scheme http or
 * https, a host, an optional port and an optional base path (for example https://example.org/rpc,
 * which gives /rpc/json_rpc and /rpc/getblocks.bin). No query, fragment, percent-encoding, dot
 * segments or credentials. Rejected with UNSUPPORTED_CAPABILITY before any native call:
 * credentials (DAEMON_CREDENTIALS, in the URL or as username/password fields), proxy settings
 * (DAEMON_PROXY), an explicit untrusted flag (UNTRUSTED_DAEMON) and a certificate setting
 * (CONFIG_FIELD). The fixed core treats every daemon as trusted; trust unset or true is accepted
 * and reported as true. Address errors reject with INVALID_CONFIG/DAEMON_ADDRESS; the input text
 * is never echoed. The SDK contains no default or deployment host.
 */
export interface ZephyrDaemonRoute {
  /** normalized address: scheme://host[:port][base path], without a trailing slash */
  readonly uri: string;
  /** scheme://host:port with an explicit port; the only part the core receives */
  readonly origin: string;
  /** "" or a validated base path such as "/rpc"; prefixed to every endpoint path by the bridge transport */
  readonly basePath: string;
  /** always true: the fixed core treats every daemon as trusted */
  readonly trusted: true;
}

const MAX_ADDRESS_LENGTH = 512;
const BASE_PATH = /^(\/[A-Za-z0-9._~-]+)+$/;

function invalid(): never {
  throw new ZephyrWalletError("INVALID_CONFIG", "DAEMON_ADDRESS");
}

/** Parse and normalize a daemon address; throws a wallet error before any native call. */
export function parseDaemonAddress(input: unknown): ZephyrDaemonRoute {
  let text: unknown = input;
  if (input !== null && typeof input === "object" && !Array.isArray(input)) {
    const proto = Object.getPrototypeOf(input);
    if (proto !== Object.prototype && proto !== null) throw new ZephyrWalletError("INVALID_CONFIG", "CONFIG_TYPE");
    const fields = input as Record<string, unknown>;
    for (const key of Object.keys(fields)) {
      if (key === "uri" || key === "trusted") continue;
      if (key === "username" || key === "password") { if (fields[key] !== undefined && fields[key] !== "") throw ZephyrWalletError.unsupported("DAEMON_CREDENTIALS"); continue; }
      if (key === "proxyUri" || key === "proxy") { if (fields[key] !== undefined && fields[key] !== "") throw ZephyrWalletError.unsupported("DAEMON_PROXY"); continue; }
      if (key === "rejectUnauthorized") { if (fields[key] !== undefined) throw ZephyrWalletError.unsupported("CONFIG_FIELD"); continue; }
      throw new ZephyrWalletError("INVALID_CONFIG", "UNKNOWN_FIELD");
    }
    const trusted = fields.trusted;
    if (trusted !== undefined && typeof trusted !== "boolean") throw new ZephyrWalletError("INVALID_CONFIG", "FIELD_TYPE");
    if (trusted === false) throw ZephyrWalletError.unsupported("UNTRUSTED_DAEMON");
    text = fields.uri;
  }
  if (typeof text !== "string") throw new ZephyrWalletError("INVALID_CONFIG", "FIELD_TYPE");
  if (text.length === 0 || text.length > MAX_ADDRESS_LENGTH) invalid();
  if (!/^[\x21-\x7e]+$/.test(text)) invalid(); // no whitespace, control or non-ASCII characters
  if (/[?#%\\]/.test(text)) invalid();
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(text);
  if (scheme === null) invalid();
  const protocol = scheme[1].toLowerCase();
  if (protocol !== "http" && protocol !== "https") invalid();
  const rest = text.substring(scheme[0].length);
  const slash = rest.indexOf("/");
  const authority = slash < 0 ? rest : rest.substring(0, slash);
  const rawPath = slash < 0 ? "" : rest.substring(slash);
  if (authority.includes("@")) throw ZephyrWalletError.unsupported("DAEMON_CREDENTIALS");
  if (/(^|\/)\.\.?(\/|$)/.test(rawPath)) invalid(); // dot segments would be resolved silently
  let url: URL;
  try { url = new URL(text); } catch (err) { invalid(); }
  if (url.username !== "" || url.password !== "") throw ZephyrWalletError.unsupported("DAEMON_CREDENTIALS");
  if (url.search !== "" || url.hash !== "" || url.hostname === "") invalid();
  if (url.protocol !== protocol + ":") invalid();
  let basePath = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");
  if (basePath !== "" && (!BASE_PATH.test(basePath) || basePath.length > 256)) invalid();
  if (rawPath.replace(/\/$/, "") !== basePath) invalid(); // the URL parser changed the path
  const port = url.port !== "" ? url.port : protocol === "https" ? "443" : "80";
  const host = url.hostname;
  if (!/^[A-Za-z0-9.\-[\]:]+$/.test(host)) invalid();
  return Object.freeze({ uri: protocol + "://" + url.host + basePath, origin: protocol + "://" + host + ":" + port, basePath, trusted: true as const });
}

/** Origin and base path key of a route, for the request allowlist. */
export function routeKey(route: { origin: string; basePath: string }): string {
  return route.origin + route.basePath;
}

/**
 * Whether a request URI addresses a configured route: the same scheme, host and effective port,
 * and a path below the route's base path. Returns the endpoint path relative to the base path, or
 * undefined. Only well-formed endpoint paths are returned; the full URI is never kept.
 */
export function matchRoute(uri: unknown, route: { origin: string; basePath: string }): string | undefined {
  if (typeof uri !== "string") return undefined;
  let url: URL;
  try { url = new URL(uri); } catch (err) { return undefined; }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") return undefined;
  const protocol = url.protocol === "https:" ? "https" : url.protocol === "http:" ? "http" : undefined;
  if (protocol === undefined) return undefined;
  const port = url.port !== "" ? url.port : protocol === "https" ? "443" : "80";
  if (protocol + "://" + url.hostname + ":" + port !== route.origin) return undefined;
  if (!url.pathname.startsWith(route.basePath + "/")) return undefined;
  const endpoint = url.pathname.substring(route.basePath.length);
  return /^\/[A-Za-z0-9_.]{1,64}$/.test(endpoint) ? endpoint : undefined;
}
