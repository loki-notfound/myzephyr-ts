import ZephyrDaemonUpdateCheckResult from "./ZephyrDaemonUpdateCheckResult";

/**
 * Models the result of downloading an update.
 */
export default class ZephyrDaemonUpdateDownloadResult extends ZephyrDaemonUpdateCheckResult {

  downloadPath: string;
  
  constructor(state: ZephyrDaemonUpdateDownloadResult) {
    super(state);
  }
  
  /**
   * Get the path the update was downloaded to.
   * 
   * @return {string} is the path the update was downloaded to
   */
  getDownloadPath(): string {
    return this.downloadPath;
  }
  
  setDownloadPath(downloadPath: string): ZephyrDaemonUpdateDownloadResult {
    this.downloadPath = downloadPath;
    return this;
  }
}