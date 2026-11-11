/**
 * Result of pruning the blockchain.
 */
export default class ZephyrPruneResult {

  isPruned: boolean;
  pruningSeed: number;
  
  constructor(result?: Partial<ZephyrPruneResult>) {
    Object.assign(this, result);
  }
  
  toJson(): any {
    let json = Object.assign({}, this);
    if (this.getIsPruned()) json.isPruned = this.getIsPruned();
    if (this.getPruningSeed()) json.pruningSeed = this.getPruningSeed();
    return json;
  }
  
  getIsPruned(): boolean {
    return this.isPruned;
  }
  
  setIsPruned(isPruned: boolean): ZephyrPruneResult {
    this.isPruned = isPruned;
    return this;
  }
  
  getPruningSeed(): number {
    return this.pruningSeed;
  }
  
  setPruningSeed(pruningSeed: number): ZephyrPruneResult {
    this.pruningSeed = pruningSeed;
    return this;
  }
}
