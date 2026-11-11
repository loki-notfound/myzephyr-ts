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
  protected static SOCKS_AGENTS: any = {}; // shared socks agents keyed by proxy uri and ssl config

  /**
   * <p>Make a HTTP request.<p>
   * 
   * @param {object} request - configures the request to make
   * @param {string} request.method - HTTP method ("GET", "PUT", "POST", "DELETE", etc)
   * @param {string} request.uri - uri to request
   * @param {string|Uint8Array|object} request.body - request body
   * @param {string} [request.username] - username to authenticate the request (optional)
   * @param {string} [request.password] - password to authenticate the request (optional)
   * @param {object} [request.headers] - headers to add to the request (optional)
   * @param {string} [request.proxyUri] - proxy the request through a SOCKS5 server, e.g. a local Tor proxy (Node.js only, optional)
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

  /**
   * Get a singleton agent to route requests through a SOCKS5 proxy; hostnames are resolved by the proxy to avoid DNS leaks.
   *
   * @return {SocksProxyAgent} a shared agent for the given proxy and ssl config
   */
  protected static getSocksAgent(proxyUri: string, rejectUnauthorized: boolean) {
    if (GenUtils.isBrowser() || GenUtils.isDeno()) throw new Error("Proxied requests are only supported in Node.js");
    const key = proxyUri + "_" + rejectUnauthorized;
    if (!HttpClient.SOCKS_AGENTS[key]) {
      const { SocksProxyAgent } = require("socks-proxy-agent");
      const parsed = new URL(GenUtils.normalizeUri(proxyUri));
      const auth = parsed.username ? parsed.username + ":" + parsed.password + "@" : "";
      HttpClient.SOCKS_AGENTS[key] = new SocksProxyAgent("socks5h://" + auth + parsed.host, { // socks establishment and inactivity are bounded by timeout
        keepAlive: true,
        timeout: Math.max(HttpClient.CONNECT_TIMEOUT, HttpClient.READ_TIMEOUT),
        rejectUnauthorized: rejectUnauthorized
      });
    }
    return HttpClient.SOCKS_AGENTS[key];
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
    const username = req.username;
    const password = req.password;
    const body = req.body;
    const proxyUri = req.proxyUri;
    const rejectUnauthorized = req.rejectUnauthorized;
    const isBinary = body instanceof Uint8Array;
    const cancelToken = req.cancelToken;
    if (cancelToken) cancelToken.throwIfRequested();

    // queue and throttle requests to execute in serial and rate limited per host
    const response = HttpClient.TASK_QUEUES[host].submit(async function() {
      if (cancelToken) cancelToken.throwIfRequested();
      await HttpClient.awaitRateLimit(host);
      return new Promise(function(resolve, reject) {
        HttpClient.axiosDigestAuthRequest(method, uri, username, password, body, proxyUri, rejectUnauthorized, cancelToken).then(function(resp) {
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

    // normalize response
    let normalizedResponse: any = {};
    normalizedResponse.statusCode = resp.status;
    normalizedResponse.statusText = resp.statusText;
    normalizedResponse.headers = {...resp.headers};
    normalizedResponse.body = isBinary ? new Uint8Array(resp.data) : resp.data;
    if (normalizedResponse.body instanceof ArrayBuffer) normalizedResponse.body = new Uint8Array(normalizedResponse.body);  // handle empty binary request
    return normalizedResponse;
  }

  protected static axiosDigestAuthRequest = async function(method, url, username, password, body, proxyUri?, rejectUnauthorized?, cancelToken?) {
    if (typeof CryptoJS === 'undefined' && typeof require === 'function') {
      var CryptoJS = require('crypto-js');
    }

    // route through socks proxy if configured, otherwise use direct agents (Node only: a browser has no agents)
    const socksAgent = proxyUri ? HttpClient.getSocksAgent(proxyUri, rejectUnauthorized !== false) : undefined;
    const nodeAgents = LibraryUtils.isNodeRuntime();
    const httpAgent = socksAgent ?? (url.startsWith("https") || !nodeAgents ? undefined : HttpClient.getHttpAgent());
    const httpsAgent = socksAgent ?? (url.startsWith("https") && nodeAgents ? HttpClient.getHttpsAgent(rejectUnauthorized) : undefined);

    const generateCnonce = function(): string {
      const characters = 'abcdef0123456789';
      let token = '';
      for (let i = 0; i < 16; i++) {
        const randNum = Math.round(Math.random() * characters.length);
        token += characters.slice(randNum, randNum+1);
      }
      return token;
    }

    let count = 0;
    return axios.request({
      url: url,
      method: method,
      headers: {
        'Content-Type': 'application/json'
      },
      responseType: body instanceof Uint8Array ? 'arraybuffer' : undefined,
      httpAgent: httpAgent,
      httpsAgent: httpsAgent,
      proxy: socksAgent ? false : undefined, // env proxies must not bypass the socks agent
      timeout: HttpClient.getNonAgentTimeout(),
      cancelToken: cancelToken,
      data: body,
      transformResponse: res => res,
      adapter: GenUtils.isDeno() ? ['fetch'] : ['http', 'xhr', 'fetch']
    }).catch(async (err) => {
      if (err.response?.status === 401) {
        let authHeader = err.response.headers['www-authenticate'].replace(/,\sDigest.*/, "");
        if (!authHeader) {
          throw err;
        }

        // Digest qop="auth",algorithm=MD5,realm="monero-rpc",nonce="hBZ2rZIxElv4lqCRrUylXA==",stale=false
        const authHeaderMap = authHeader.replace("Digest ", "").replaceAll('"', "").split(",").reduce((prev, curr) => ({...prev, [curr.split("=")[0]]: curr.split("=").slice(1).join('=')}), {})

        ++count;

        const cnonce = generateCnonce();
        const HA1 = CryptoJS.MD5(username+':'+authHeaderMap.realm+':'+password).toString();
        const HA2 = CryptoJS.MD5(method+':'+url).toString();

        const response = CryptoJS.MD5(HA1+':'+
          authHeaderMap.nonce+':'+
          ('00000000' + count).slice(-8)+':'+
          cnonce+':'+
          authHeaderMap.qop+':'+
          HA2).toString();
        const digestAuthHeader = 'Digest'+' '+
          'username="'+username+'", '+
          'realm="'+authHeaderMap.realm+'", '+
          'nonce="'+authHeaderMap.nonce+'", '+
          'uri="'+url+'", '+
          'response="'+response+'", '+
          'opaque="'+(authHeaderMap.opaque ?? null)+'", '+
          'qop='+authHeaderMap.qop+', '+
          'nc='+('00000000' + count).slice(-8)+', '+
          'cnonce="'+cnonce+'"';

        const finalResponse = await axios.request({
          url: url,
          method: method,
          headers: {
            'Authorization': digestAuthHeader,
            'Content-Type': 'application/json'
          },
          responseType: body instanceof Uint8Array ? 'arraybuffer' : undefined,
          httpAgent: httpAgent,
          httpsAgent: httpsAgent,
          proxy: socksAgent ? false : undefined, // env proxies must not bypass the socks agent
          timeout: HttpClient.getNonAgentTimeout(),
          cancelToken: cancelToken,
          data: body,
          transformResponse: res => res,
          adapter: GenUtils.isDeno() ? ['fetch'] : ['http', 'xhr', 'fetch']
        });

        return finalResponse;
      }
      throw err;
    }).catch(err => {
      throw err;
    });
  }
}
