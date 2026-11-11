/**
 * Monero hard fork info.
 */
export default class ZephyrHardForkInfo {

  earliestHeight: number;
  isEnabled: boolean;
  state: string;
  threshold: number;
  version: number;
  numVotes: number;
  window: number;
  voting: number;
  credits: bigint;
  topBlockHash: string;

  constructor(info?: Partial<ZephyrHardForkInfo>) {
    Object.assign(this, info);
    if (this.credits !== undefined && typeof this.credits !== "bigint") this.credits = BigInt(this.credits);
  }
  
  toJson(): any {
    let json: any = Object.assign({}, this);
    if (json.credits !== undefined) json.credits = json.credits.toString();
    return json;
  }
  
  getEarliestHeight(): number {
    return this.earliestHeight;
  }

  setEarliestHeight(earliestHeight: number): ZephyrHardForkInfo {
    this.earliestHeight = earliestHeight;
    return this;
  }

  getIsEnabled(): boolean {
    return this.isEnabled;
  }

  setIsEnabled(isEnabled: boolean): ZephyrHardForkInfo {
    this.isEnabled = isEnabled;
    return this;
  }

  getState(): string {
    return this.state;
  }

  setState(state: string): ZephyrHardForkInfo {
    this.state = state;
    return this;
  }

  getThreshold(): number {
    return this.threshold;
  }

  setThreshold(threshold: number): ZephyrHardForkInfo {
    this.threshold = threshold;
    return this;
  }

  getVersion(): number {
    return this.version;
  }

  setVersion(version: number): ZephyrHardForkInfo {
    this.version = version;
    return this;
  }

  getNumVotes(): number {
    return this.numVotes;
  }

  setNumVotes(numVotes: number): ZephyrHardForkInfo {
    this.numVotes = numVotes;
    return this;
  }

  getWindow(): number {
    return this.window;
  }

  setWindow(window: number): ZephyrHardForkInfo {
    this.window = window;
    return this;
  }

  getVoting(): number {
    return this.voting;
  }

  setVoting(voting: number): ZephyrHardForkInfo {
    this.voting = voting;
    return this;
  }
  
  getCredits(): bigint{
    return this.credits;
  }
  
  setCredits(credits: bigint): ZephyrHardForkInfo {
    this.credits = credits;
    return this;
  }
  
  getTopBlockHash(): string {
    return this.topBlockHash;
  }
  
  setTopBlockHash(topBlockHash: string): ZephyrHardForkInfo {
    this.topBlockHash = topBlockHash;
    return this;
  }
}
