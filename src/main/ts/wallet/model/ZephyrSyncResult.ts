/**
 * Result from syncing a Monero wallet.
 */
export default class ZephyrSyncResult {

  numBlocksFetched: number;
  receivedMoney!: boolean;
  
  constructor(numBlocksFetched: number, receivedMoney: boolean) {
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
  
  getReceivedMoney(): boolean {
    return this.receivedMoney;
  }
  
  setReceivedMoney(receivedMoney: boolean): ZephyrSyncResult {
    this.receivedMoney = receivedMoney;
    return this;
  }
}
