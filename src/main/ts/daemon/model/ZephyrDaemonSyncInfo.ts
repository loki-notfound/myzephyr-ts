import ZephyrConnectionSpan from "./ZephyrConnectionSpan";
import ZephyrPeer from "./ZephyrPeer";

/**
 * Models daemon synchronization information.
 */
export default class ZephyrDaemonSyncInfo {

  height: number;
  peers: ZephyrPeer[];
  spans: ZephyrConnectionSpan[];
  targetHeight: number;
  nextNeededPruningSeed: number;
  overview: string;
  credits: bigint;
  topBlockHash: string;
  
  constructor(info?: Partial<ZephyrDaemonSyncInfo>) {
    Object.assign(this, info);

    // deserialize bigints
    if (this.credits !== undefined && typeof this.credits !== "bigint") this.credits = BigInt(this.credits);
    
    // copy peers
    if (this.peers) {
      for (let i = 0; i < this.peers.length; i++) {
        this.peers[i] = new ZephyrPeer(this.peers[i]);
      }
    }

    // copy spans
    if (this.spans) {
      for (let i = 0; i < this.spans.length; i++) {
        this.spans[i] = new ZephyrConnectionSpan(this.spans[i]);
      }
    }
  }
  
  toJson() {
    let json: any = Object.assign({}, this);
    if (json.peers !== undefined) {
      for (let i = 0; i < json.peers.length; i++) {
        json.peers[i] = json.peers[i].toJson();
      }
    }
    if (json.spans !== undefined) {
      for (let i = 0; i < json.spans.length; i++) {
        json.spans[i] = json.spans[i].toJson();
      }
    }
    if (json.credits !== undefined) json.credits = json.credits.toString();
    return json;
  }
  
  getHeight(): number {
    return this.height;
  }
  
  setHeight(height: number): ZephyrDaemonSyncInfo {
    this.height = height;
    return this;
  }
  
  getPeers(): ZephyrPeer[] {
    return this.peers;
  }
  
  setPeers(peers: ZephyrPeer[]): ZephyrDaemonSyncInfo {
    this.peers = peers;
    return this;
  }
  
  getSpans(): ZephyrConnectionSpan[] {
    return this.spans;
  }
  
  setSpans(spans: ZephyrConnectionSpan[]): ZephyrDaemonSyncInfo {
    this.spans = spans;
    return this;
  }
  
  getTargetHeight(): number {
    return this.targetHeight;
  }
  
  setTargetHeight(targetHeight: number): ZephyrDaemonSyncInfo {
    this.targetHeight = targetHeight;
    return this;
  }
  
  getNextNeededPruningSeed(): number {
    return this.nextNeededPruningSeed;
  }
  
  setNextNeededPruningSeed(nextNeededPruningSeed: number): ZephyrDaemonSyncInfo {
    this.nextNeededPruningSeed = nextNeededPruningSeed;
    return this;
  }
  
  getOverview(): string {
    return this.overview;
  }
  
  setOverview(overview: string): ZephyrDaemonSyncInfo {
    this.overview = overview;
    return this;
  }
  
  getCredits(): bigint {
    return this.credits;
  }
  
  setCredits(credits: bigint): ZephyrDaemonSyncInfo {
    this.credits = credits;
    return this;
  }
  
  getTopBlockHash(): string {
    return this.topBlockHash;
  }
  
  setTopBlockHash(topBlockHash: string): ZephyrDaemonSyncInfo {
    this.topBlockHash = topBlockHash;
    return this;
  }
}
