import ZephyrError from "../../common/ZephyrError";

/**
 * Defines the Zephyr network types (mainnet, testnet, and stagenet).
 */
export default class ZephyrNetworkType {

  /**
   * Mainnet (value=0).
   */
  static readonly MAINNET = 0;

  /**
   * Testnet (value=1).
   */
  static readonly TESTNET = 1;

  /**
   * Stagnet (value=2).
   */
  static readonly STAGENET = 2;

  /**
   * Validate and normalize the given network type.
   * 
   * @param {ZephyrNetworkType | number | string} networkType - the network type to validate and normalize
   * @return {ZephyrNetworkType} the given network type
   */
    static from(networkType: ZephyrNetworkType | number | string): ZephyrNetworkType {
      if (typeof networkType === "string") return ZephyrNetworkType.parse(networkType);
      ZephyrNetworkType.validate(networkType);
      return networkType;
    }
  
  /**
   * Validate the given network type.
   * 
   * @param {ZephyrNetworkType} networkType - the network type to validate as a numeric
   */
  static validate(networkType: ZephyrNetworkType | number | string) {
    if (typeof networkType === "string") ZephyrNetworkType.parse(networkType);
    else if (networkType !== 0 && networkType !== 1 && networkType !== 2) throw new ZephyrError("Network type is invalid: " + networkType);
  }
  
  /**
   * Indicates if the given network type is valid or not.
   * 
   * @param {ZephyrNetworkType | number} networkType - the network type to validate as a numeric
   * @return {boolean} true if the network type is valid, false otherwise
   */
  static isValid(networkType: ZephyrNetworkType | number | string): boolean {
    try {
      ZephyrNetworkType.validate(networkType);
      return true;
    } catch(err) {
      return false;
    }
  }

  /**
   * Parse the given string as a network type.
   * 
   * @param {string} networkTypeStr - "mainnet", "testnet", or "stagenet" (case insensitive)
   * @return {ZephyrNetworkType} the network type as a numeric
   */
  static parse(networkTypeStr: string): ZephyrNetworkType {
    let str = ("" + networkTypeStr).toLowerCase();
    switch (str) {
      case "mainnet": return ZephyrNetworkType.MAINNET;
      case "testnet": return ZephyrNetworkType.TESTNET;
      case "stagenet": return ZephyrNetworkType.STAGENET;
      default: throw new ZephyrError("Invalid network type to parse: '" + networkTypeStr + "'");
    }
  }

  /**
   * Get the network type in human-readable form.
   *
   * @return {string} the network type in human-readable form
   */
  static toString(networkType: ZephyrNetworkType | number): string {
    if (networkType === 0) return "mainnet";
    if (networkType === 1) return "testnet";
    if (networkType === 2) return "stagenet";
    throw new ZephyrError("Invalid network type: " + networkType);
  }
}