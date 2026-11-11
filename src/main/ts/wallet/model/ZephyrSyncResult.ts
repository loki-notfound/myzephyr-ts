/**
 * Result from syncing a Monero wallet.
 */
export default class ZephyrSyncResult {

  numBlocksFetched: number;
  receivedMoney: bigint;
  
  constructor(numBlocksFetched: number, receivedMoney: bigint) {
    this.setNumBlocksFetched(numBlocksFetched);
    this.setReceivedMoney(receivedMoney);
  }
  
  getNumBlocksFetched(): number {
    return this.numBlocksFetched;
  }
  
  setNumBlocksFetched(numBlocksFetched: number): ZephyrSyncResult {
    this.numBlocksFetched = numBlocksFetched;
    return this;
  }
  
  getReceivedMoney(): bigint {
    return this.receivedMoney;
  }
  
  setReceivedMoney(receivedMoney: bigint): ZephyrSyncResult {
    this.receivedMoney = receivedMoney;
    return this;
  }
}
