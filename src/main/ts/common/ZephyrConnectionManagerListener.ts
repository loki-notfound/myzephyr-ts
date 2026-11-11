import ZephyrRpcConnection from "./ZephyrRpcConnection";

/**
 * Default connection manager listener which takes no action on notifications.
 */
export default class ZephyrConnectionManagerListener {
  
  /**
   * Notified on connection change events.
   * 
   * @param {ZephyrRpcConnection | undefined} connection - the connection manager's current connection
   * @return {Promise<void>}
   */
  async onConnectionChanged(connection: ZephyrRpcConnection | undefined): Promise<void> { }
}
