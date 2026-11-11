/**
 * Models the result of checking for a daemon update.
 */
export default class ZephyrDaemonUpdateCheckResult {

  isUpdateAvailable: boolean;
  version: string;
  hash: string;
  autoUri: string;
  userUri: string;
  
  constructor(result?: ZephyrDaemonUpdateCheckResult) {
    Object.assign(this, result);
  }
  
  /**
   * Indicates if an update is available.
   * 
   * @return {boolean} true if an update is available, false otherwise
   */
  getIsUpdateAvailable(): boolean {
    return this.isUpdateAvailable;
  }
  
  setIsUpdateAvailable(isUpdateAvailable: boolean): ZephyrDaemonUpdateCheckResult {
    this.isUpdateAvailable = isUpdateAvailable;
    return this;
  }
  
  /**
   * Get the update's version.
   * 
   * @return {string} is the update's version
   */
  getVersion(): string {
    return this.version;
  }
  
  setVersion(version: string): ZephyrDaemonUpdateCheckResult {
    this.version = version;
    return this;
  }
  
  /**
   * Get the update's hash.
   * 
   * @return {string} is the update's hash
   */
  getHash(): string {
    return this.hash;
  }
  
  setHash(hash: string): ZephyrDaemonUpdateCheckResult {
    this.hash = hash;
    return this;
  }
  
  /**
   * Get the uri to automatically download the update.
   * 
   * @return {string} is the uri to automatically download the update
   */
  getAutoUri(): string {
    return this.autoUri;
  }
  
  setAutoUri(autoUri: string): ZephyrDaemonUpdateCheckResult {
    this.autoUri = autoUri;
    return this;
  }
  
  /**
   * Get the uri to manually download the update.
   * 
   * @return {string} is the uri to manually download the update
   */
  getUserUri(): string {
    return this.userUri;
  }
  
  setUserUri(userUri: string): ZephyrDaemonUpdateCheckResult {
    this.userUri = userUri;
    return this;
  }
}