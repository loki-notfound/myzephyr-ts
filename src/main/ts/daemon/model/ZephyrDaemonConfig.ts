import ZephyrRpcConnection from "../../common/ZephyrRpcConnection";

/**
 * Configuration to connect to monerod.
 */
export default class ZephyrDaemonConfig {

  /** Server config to monerod. */
  server: string | Partial<ZephyrRpcConnection>;

  /** Proxy requests to monerod to a worker (default true). */
  proxyToWorker: boolean;

  /** Command to start monerod as a child process. */
  cmd: string[];

  /** Interval in milliseconds to poll the daemon for updates (default 20000). */
  pollInterval: number;
  
  /**
   * Construct a configuration to open or create a wallet.
   * 
   * @param {Partial<ZephyrDaemonConfig>} [config] - ZephyrDaemonConfig to construct from (optional)
   * @param {string|Partial<ZephyrRpcConnection>} [config.server] - uri or ZephyrRpcConnection to the daemon (optional)
   * @param {boolean} [config.proxyToWorker] - proxy daemon requests to a worker (default true)
   * @param {string[]} [config.cmd] - command to start monerod (optional)
   * @param {number} [config.pollInterval] - interval in milliseconds to poll the daemon for updates (default 20000)
   */
  constructor(config?: Partial<ZephyrDaemonConfig>) {
    Object.assign(this, config);
    if (this.server) this.setServer(this.server);
    this.setProxyToWorker(this.proxyToWorker);
  }

  copy(): ZephyrDaemonConfig {
    return new ZephyrDaemonConfig(this);
  }
  
  toJson(): any {
    let json: any = Object.assign({}, this);
    if (json.server) json.server = json.server.toJson();
    return json;
  }
  
  getServer(): ZephyrRpcConnection {
    return this.server as ZephyrRpcConnection;
  }
  
  setServer(server: Partial<ZephyrRpcConnection> | string): ZephyrDaemonConfig {
    if (server && !(server instanceof ZephyrRpcConnection)) server = new ZephyrRpcConnection(server);
    this.server = server as ZephyrRpcConnection;
    return this;
  }
  
  getProxyToWorker(): boolean {
    return this.proxyToWorker;
  }
  
  setProxyToWorker(proxyToWorker: boolean): ZephyrDaemonConfig {
    this.proxyToWorker = proxyToWorker;
    return this;
  }

  getCmd(): string[] {
    return this.cmd;
  }

  setCmd(cmd: string[]): ZephyrDaemonConfig {
    this.cmd = cmd;
    return this;
  }

  getPollInterval(): number {
    return this.pollInterval;
  }

  setPollInterval(pollInterval: number): ZephyrDaemonConfig {
    this.pollInterval = pollInterval;
    return this;
  }
}