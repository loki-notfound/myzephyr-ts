import ZephyrBlockHeader from "./ZephyrBlockHeader";

/**
 * Receives notifications as a daemon is updated.
 */
export default class ZephyrDaemonListener {

  protected lastHeader: ZephyrBlockHeader;
  
  /**
   * Called when a new block is added to the chain.
   * 
   * @param {ZephyrBlockHeader} header - the header of the block added to the chain
   */
  async onBlockHeader(header: ZephyrBlockHeader) {
    this.lastHeader = header;
  }
  
  /**
   * Get the last notified block header.
   * 
   * @return {ZephyrBlockHeader} the last notified block header
   */
  getLastBlockHeader(): ZephyrBlockHeader {
    return this.lastHeader;
  }
}
