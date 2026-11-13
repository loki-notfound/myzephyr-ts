import GenUtils from "./GenUtils";
import LibraryUtils from "./LibraryUtils";
import ThreadPool from "./ThreadPool";
import ZephyrWalletError from "./ZephyrWalletError";
import { matchRoute, routeKey } from "./ZephyrDaemonAddress";
import http from "http";
import https from "https";
import axios, { AxiosError } from "axios";

/**
 * Handle HTTP requests with a uniform interface.
 */
export default class HttpClient {

  static MAX_REQUESTS_PER_SECOND = 50; // positive requests per second, or Infinity to disable throttling

  /**
   * Network guard (an allowlist). A request is sent only if its URI
   * addresses a daemon route that a wallet of this context configured (scheme, host, effective
   * port and a path below the route's base path); every other request is counted and rejected
   * before any connection is attempted. With no route configured (offline lifecycle work) every
   * request is blocked, and the bridge rejects an unset daemon host before
   * reaching this client, so the expected count is zero. Only the HTTP method, the endpoint path
   * relative to the base path and a validated JSON-RPC method token are recorded: never a host,
   * URI, credentials, query string or body.
   */
  static NETWORK_ENABLED = false; // true while at least one daemon route is configured
  static BLOCKED_REQUESTS = 0;
  static BLOCKED_REQUEST_SUMMARY: Record<string, number> = Object.create(null); // "METHOD rpc-method" -> count
  static ALLOWED_REQUESTS = 0;
  static ALLOWED_REQUEST_SUMMARY: Record<string, number> = Object.create(null); // "METHOD /endpoint rpc-method" -> count
  /**
   * No relay: a request to a daemon endpoint or JSON-RPC method that submits or relays a transaction or
   * a block is refused before anything is sent, also on a configured route and also when the core itself
   * would send it (wallet2's commit path), and counted here. This version of the SDK never relays.
   */
  static readonly RELAY_ENDPOINTS: readonly string[] = ["/sendrawtransaction", "/send_raw_transaction"];
  static readonly RELAY_METHODS: readonly string[] = ["relay_tx", "submit_block", "submitblock", "send_raw_transaction", "sendrawtransaction"];
  static REFUSED_RELAY_REQUESTS = 0;
  protected static DAEMON_ROUTES = new Map<string, { origin: string; basePath: string; count: number }>();

  /** Allow requests to a daemon route (one registration per wallet that uses it). */
  static addDaemonRoute(route: { origin: string; basePath: string }): void {
    const key = routeKey(route);
    const entry = HttpClient.DAEMON_ROUTES.get(key);
    if (entry) entry.count++;
    else HttpClient.DAEMON_ROUTES.set(key, { origin: route.origin, basePath: route.basePath, count: 1 });
    HttpClient.NETWORK_ENABLED = true;
  }

  /** Release one registration of a daemon route. */
  static removeDaemonRoute(route: { origin: string; basePath: string }): void {
    const key = routeKey(route);
    const entry = HttpClient.DAEMON_ROUTES.get(key);
    if (entry && --entry.count <= 0) HttpClient.DAEMON_ROUTES.delete(key);
    HttpClient.NETWORK_ENABLED = HttpClient.DAEMON_ROUTES.size > 0;
  }

  /** Number of distinct configured daemon routes in this context. */
  static daemonRouteCount(): number {
    return HttpClient.DAEMON_ROUTES.size;
  }

  protected static guardRequest(request: any): void {
    const rpcMatch = typeof request?.body === "string" ? request.body.match(/"method"\s*:\s*"([A-Za-z0-9_]{1,64})"/) : null;
    const httpMethod = typeof request?.method === "string" && /^[A-Z]{1,7}$/.test(request.method) ? request.method : "OTHER";
    let endpoint: string | undefined = undefined;
    for (const route of HttpClient.DAEMON_ROUTES.values()) {
      endpoint = matchRoute(request?.uri, route);
      if (endpoint !== undefined) break;
    }
    if ((endpoint !== undefined && HttpClient.RELAY_ENDPOINTS.includes(endpoint.toLowerCase())) || (rpcMatch !== null && HttpClient.RELAY_METHODS.includes(rpcMatch[1].toLowerCase()))
        || (typeof request?.uri === "string" && HttpClient.RELAY_ENDPOINTS.some((e) => request.uri.split("?")[0].toLowerCase().endsWith(e)))) {
      HttpClient.REFUSED_RELAY_REQUESTS++;
      HttpClient.BLOCKED_REQUESTS++;
      const key = httpMethod + " relay";
      HttpClient.BLOCKED_REQUEST_SUMMARY[key] = (HttpClient.BLOCKED_REQUEST_SUMMARY[key] ?? 0) + 1;
      throw ZephyrWalletError.unsupported("RELAY_REQUEST");
    }
    if (endpoint === undefined) {
      HttpClient.BLOCKED_REQUESTS++;
      const key = httpMethod + " " + (rpcMatch ? rpcMatch[1] : "-");
      HttpClient.BLOCKED_REQUEST_SUMMARY[key] = (HttpClient.BLOCKED_REQUEST_SUMMARY[key] ?? 0) + 1;
      throw ZephyrWalletError.unsupported("NETWORK_REQUEST");
    }
    HttpClient.ALLOWED_REQUESTS++;
    const key = httpMethod + " " + endpoint + " " + (rpcMatch ? rpcMatch[1] : "-");
    HttpClient.ALLOWED_REQUEST_SUMMARY[key] = (HttpClient.ALLOWED_REQUEST_SUMMARY[key] ?? 0) + 1;
  }

  /**
   * The daemon address contract (ZephyrDaemonAddress.ts) rejects credentials and proxies before any
   * native call, and the bridge passes neither, so a request never carries them. This client has no
   * authentication or proxy support either: a request that names credentials or a proxy is
   * rejected with the contract's diagnostic before anything is sent, and a proxy named by the
   * process environment is never used (see axiosRequest).
   */
  protected static rejectUnsupported(request: any): void {
    if ((request?.username !== undefined && request.username !== "") || (request?.password !== undefined && request.password !== "")) throw ZephyrWalletError.unsupported("DAEMON_CREDENTIALS");
    if (request?.proxyUri !== undefined && request.proxyUri !== "") throw ZephyrWalletError.unsupported("DAEMON_PROXY");
  }

  // default request config
  protected static DEFAULT_REQUEST = {
    method: "GET",
    resolveWithFullResponse: false,
    rejectUnauthorized: true
  }

  // rate limit requests per host
  protected static REQUEST_START_TIMES = []; // recent request start times per host
  protected static TASK_QUEUES = [];
  protected static CONNECT_TIMEOUT = 180000; // ms to establish a connection, matching monero-java's default (0 to disable)
  protected static READ_TIMEOUT = 180000; // ms of socket inactivity before timing out

  protected static HTTP_AGENT: any;
  protected static HTTPS_AGENT: any;
  protected static HTTPS_AGENT_UNVERIFIED: any;

  /**
   * <p>Make a HTTP request.<p>
   * 
   * @param {object} request - configures the request to make
   * @param {string} request.method - HTTP method ("GET", "PUT", "POST", "DELETE", etc)
   * @param {string} request.uri - uri to request
   * @param {string|Uint8Array|object} request.body - request body
   * @param {string} [request.username] - must be empty or absent: credentials are rejected (DAEMON_CREDENTIALS)
   * @param {string} [request.password] - must be empty or absent: credentials are rejected (DAEMON_CREDENTIALS)
   * @param {object} [request.headers] - headers to add to the request (optional)
   * @param {string} [request.proxyUri] - must be empty or absent: proxies are rejected (DAEMON_PROXY)
   * @param {boolean} [request.resolveWithFullResponse] - return full response if true, else body only (default false)
   * @param {boolean} [request.rejectUnauthorized] - whether or not to reject self-signed certificates (default true)
   * @param {object} [request.cancelToken] - token to cancel a queued or active request (optional)
   * @param {number} request.timeout - maximum time allowed in milliseconds
   * @param {number} request.proxyToWorker - proxy request to worker thread
   * @return {object} response - the response object
   * @return {string|Uint8Array|object} response.body - the response body
   * @return {number} response.statusCode - the response code
   * @return {String} response.statusText - the response message
   * @return {object} response.headers - the response headers
   */
  static async request(request) {
    HttpClient.guardRequest(request); // throws for anything but a configured daemon route
    HttpClient.rejectUnsupported(request); // no credentials or proxy, as in the daemon address contract

    // proxy to worker if configured
    if (request.proxyToWorker) {
      try {
        return await LibraryUtils.invokeWorker(undefined, "httpRequest", request);
      } catch (err: any) {
        if (err.message.length > 0 && err.message.charAt(0) === "{") {
          let parsed = JSON.parse(err.message);
          err.message = parsed.statusMessage;
          err.statusCode = parsed.statusCode;
        }
        throw err;
      }
    }

    // assign defaults
    request = Object.assign({}, HttpClient.DEFAULT_REQUEST, request);

    // validate request
    try { request.host = new URL(request.uri).host; } // hostname:port
    catch (err) { throw new Error("Invalid request URL: " + request.uri); }
    if (request.body && !(typeof request.body === "string" || typeof request.body === "object")) {
      throw new Error("Request body type is not string or object");
    }

    // initialize one task queue per host
    if (!HttpClient.TASK_QUEUES[request.host]) HttpClient.TASK_QUEUES[request.host] = new ThreadPool(1);

    // initialize one rate limit window per host
    if (!HttpClient.REQUEST_START_TIMES[request.host]) HttpClient.REQUEST_START_TIMES[request.host] = [];

    // connection and response inactivity are bounded in the agents
    let requestPromise = HttpClient.requestAxios(request);
    return request.timeout ? GenUtils.executeWithTimeout(requestPromise, request.timeout) : requestPromise;
  }

  static createCancelToken() {
    return axios.CancelToken.source();
  }

  // ----------------------------- PRIVATE HELPERS ----------------------------


  /**
   * Get a singleton instance of an HTTP client to share.
   *
   * @return {http.Agent} a shared agent for network requests among library instances
   */
  protected static getHttpAgent() {
    if (!HttpClient.HTTP_AGENT) HttpClient.HTTP_AGENT = HttpClient.applyTimeouts(new http.Agent({
      keepAlive: true,
      family: 4 // use IPv4
    }));
    return HttpClient.HTTP_AGENT;
  }

  /**
   * Get a shared HTTPS client for the given SSL configuration.
   *
   * @return {https.Agent} a shared agent for network requests among library instances
   */
  protected static getHttpsAgent(rejectUnauthorized?: boolean) {
    rejectUnauthorized = rejectUnauthorized !== false;
    const key = rejectUnauthorized ? "HTTPS_AGENT" : "HTTPS_AGENT_UNVERIFIED";
    if (!HttpClient[key]) HttpClient[key] = HttpClient.applyTimeouts(new https.Agent({
      keepAlive: true,
      family: 4, // use IPv4
      rejectUnauthorized: rejectUnauthorized
    }));
    return HttpClient[key];
  }

  // bound the whole request where node agent socket timeouts do not apply
  protected static getNonAgentTimeout() {
    return GenUtils.isBrowser() || GenUtils.isDeno() ? Math.max(HttpClient.CONNECT_TIMEOUT, HttpClient.READ_TIMEOUT) : 0;
  }

  // bound the connection phase and socket inactivity
  protected static applyTimeouts(agent: any) {
    if (typeof agent.createConnection !== "function") return agent; // no-op in browser shims
    const createConnection = agent.createConnection.bind(agent);
    agent.createConnection = function(options, callback) {
      const socket = createConnection(options, callback);
      if (HttpClient.CONNECT_TIMEOUT > 0) {
        const timer = setTimeout(() => socket.destroy(new Error("Connection timed out in " + HttpClient.CONNECT_TIMEOUT + " ms")), HttpClient.CONNECT_TIMEOUT);
        const clearConnectTimer = () => clearTimeout(timer);
        socket.once("connect", clearConnectTimer).once("secureConnect", clearConnectTimer).once("error", clearConnectTimer).once("close", clearConnectTimer);
      }
      if (HttpClient.READ_TIMEOUT > 0) socket.setTimeout(HttpClient.READ_TIMEOUT, () => socket.destroy(new Error("Socket timed out after " + HttpClient.READ_TIMEOUT + " ms of inactivity")));
      return socket;
    };
    return agent;
  }

  // defer only when a host exceeds the rate limit since browsers throttle timers in background tabs
  protected static async awaitRateLimit(host: string) {
    const rate = HttpClient.MAX_REQUESTS_PER_SECOND;
    if (!(rate > 0)) throw new Error("Max requests per second must be greater than 0 or Infinity");
    const startTimes = HttpClient.REQUEST_START_TIMES[host];
    if (rate === Infinity) {
      startTimes.length = 0;
      return;
    }

    // allow whole requests per window, extending the window to preserve fractional limits
    const maxRequests = Math.ceil(rate);
    const windowMs = 1000 * maxRequests / rate;
    while (startTimes.length > 0 && startTimes[0] + windowMs <= Date.now()) startTimes.shift(); // bound history to the current window
    while (startTimes.length >= maxRequests) {
      const waitMs = Math.ceil(startTimes[0] + windowMs - Date.now());
      if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
      else startTimes.shift();
    }
    startTimes.push(Date.now());
  }

  protected static async requestAxios(req) {
    if (req.headers) throw new Error("Custom headers not implemented in XHR request");  // TODO

    // collect params from request which change on await
    const method = req.method;
    const uri = req.uri;
    const host = req.host;
    const body = req.body;
    const rejectUnauthorized = req.rejectUnauthorized;
    const isBinary = body instanceof Uint8Array;
    const cancelToken = req.cancelToken;
    if (cancelToken) cancelToken.throwIfRequested();

    // queue and throttle requests to execute in serial and rate limited per host
    const response = HttpClient.TASK_QUEUES[host].submit(async function() {
      if (cancelToken) cancelToken.throwIfRequested();
      await HttpClient.awaitRateLimit(host);
      return new Promise(function(resolve, reject) {
        HttpClient.axiosRequest(method, uri, body, rejectUnauthorized, cancelToken).then(function(resp) {
          resolve(resp);
        }).catch(function(error: AxiosError) {
          if (error.response?.status) resolve(error.response);
          else {
            const message = "Request failed without response: " + method + " " + uri + " due to underlying error: " + error.message;
            LibraryUtils.log(2, message + "\n" + error.stack); // the stack cannot follow the cause across the wasm bridge
            const cause = Object.assign(new Error(error.message), {name: error.name, code: error.code, stack: error.stack}); // omit request data from the cause
            reject(new Error(message, {cause}));
          }
        });
      });
    });

    // reject cancellation immediately even when queued behind another wallet's request
    let onCancel;
    let resp;
    try {
      resp = cancelToken ? await Promise.race([response, new Promise((resolve, reject) => {
        onCancel = reject;
        cancelToken.subscribe(onCancel);
      })]) : await response;
    } finally {
      if (cancelToken) cancelToken.unsubscribe(onCancel);
    }

    // a redirect is never followed (see axiosRequest): its answer reaches the core as a failed answer
    // without headers or body, so its Location value (and anything else in it) is never read or copied
    if (HttpClient.isRedirect(resp.status)) return { statusCode: resp.status, statusText: "", headers: {}, body: isBinary ? new Uint8Array(0) : "" };

    // normalize response
    let normalizedResponse: any = {};
    normalizedResponse.statusCode = resp.status;
    normalizedResponse.statusText = resp.statusText;
    normalizedResponse.headers = {...resp.headers};
    normalizedResponse.body = isBinary ? new Uint8Array(resp.data) : resp.data;
    if (normalizedResponse.body instanceof ArrayBuffer) normalizedResponse.body = new Uint8Array(normalizedResponse.body);  // handle empty binary request
    return normalizedResponse;
  }

  /**
   * Whether an answer is a redirect: a 3xx status (Node.js, Deno), or status 0, which fetch reports
   * only for the opaque answer of a redirect it did not follow (redirect "manual"; a request in the
   * default "cors" mode never yields another status-0 answer, a network failure rejects instead).
   */
  static isRedirect(status: unknown): boolean {
    return status === 0 || (typeof status === "number" && status >= 300 && status <= 399);
  }

  // one request, with the shared agents in Node.js (a browser has no agents); axios rejects a status
  // outside 2xx with the response attached, which requestAxios passes on as a response. proxy: false
  // switches off axios's proxy support in Node.js, including the proxy it would otherwise take from
  // the process environment (HTTP_PROXY, HTTPS_PROXY, ALL_PROXY, NO_PROXY and their lower-case forms):
  // a request goes directly to the configured daemon or not at all. Browsers apply their own proxy
  // settings, which a page cannot see or change.
  //
  // Redirects are never followed, for any request: the daemon address must be the final address. In
  // Node.js maxRedirects 0 makes axios use the plain http and https modules instead of its redirect
  // follower, so a 3xx answer is returned as it is. In a browser (page or worker) the request goes
  // through fetch with redirect "manual": the browser does not follow the redirect and returns an
  // opaque answer with status 0 and no headers or body, so no second request leaves the page; the
  // caller cannot see the status code or the Location. XMLHttpRequest always follows redirects and is
  // therefore not used. A cross-origin redirect whose answer lacks CORS headers that admit the page is
  // reported by the browser as a network failure instead, again without a second request.
  protected static async axiosRequest(method: string, url: string, body: any, rejectUnauthorized?: boolean, cancelToken?: any) {
    const nodeAgents = LibraryUtils.isNodeRuntime();
    return axios.request({
      url: url,
      method: method,
      headers: {
        'Content-Type': 'application/json'
      },
      responseType: body instanceof Uint8Array ? 'arraybuffer' : undefined,
      httpAgent: url.startsWith("https") || !nodeAgents ? undefined : HttpClient.getHttpAgent(),
      httpsAgent: url.startsWith("https") && nodeAgents ? HttpClient.getHttpsAgent(rejectUnauthorized) : undefined,
      timeout: HttpClient.getNonAgentTimeout(),
      proxy: false,
      maxRedirects: 0,
      fetchOptions: { redirect: "manual" },
      cancelToken: cancelToken,
      data: body,
      transformResponse: res => res,
      adapter: GenUtils.isDeno() ? ['fetch'] : ['http', 'fetch']
    });
  }
}
