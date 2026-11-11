import ConnectionType from "./ConnectionType";

/**
 * Models a peer to the daemon.
 */
export default class ZephyrPeer {

  id: string;
  address: string;
  host: string;
  port: number;
  isOnline: boolean;
  lastSeenTimestamp: number;
  pruningSeed: number;
  rpcPort: number;
  rpcCreditsPerHash: bigint;
  avgDownload: number;
  avgUpload: number;
  currentDownload: number;
  currentUpload: number;
  height: number;
  isIncoming: boolean;
  liveTime: number;
  isLocalIp: boolean;
  isLocalHost: boolean;
  numReceives: number;
  numSends: number;
  receiveIdleTime: number;
  sendIdleTime: number;
  state: string;
  numSupportFlags: number;
  type: ConnectionType;
  
  constructor(peer?: ZephyrPeer) {
    Object.assign(this, peer);
    if (this.rpcCreditsPerHash !== undefined && typeof this.rpcCreditsPerHash !== "bigint") this.rpcCreditsPerHash = BigInt(this.rpcCreditsPerHash);
  }
  
  toJson(): any {
    let json: any = Object.assign({}, this);
    if (json.rpcCreditsPerHash !== undefined) json.rpcCreditsPerHash = json.rpcCreditsPerHash.toString();
    return json;
  }
  
  getId(): string {
    return this.id;
  }

  setId(id: string): ZephyrPeer {
    this.id = id;
    return this;
  }

  getAddress(): string {
    return this.address;
  }

  setAddress(address: string): ZephyrPeer {
    this.address = address;
    return this;
  }

  getHost(): string {
    return this.host;
  }

  setHost(host: string): ZephyrPeer {
    this.host = host;
    return this;
  }

  getPort(): number {
    return this.port;
  }

  setPort(port: number): ZephyrPeer {
    this.port = port;
    return this;
  }
  
  /**
   * Indicates if the peer was online when last checked (aka "white listed" as
   * opposed to "gray listed").
   * 
   * @return {boolean} true if peer was online when last checked, false otherwise
   */
  getIsOnline(): boolean {
    return this.isOnline;
  }
  
  setIsOnline(isOnline: boolean): ZephyrPeer {
    this.isOnline = isOnline;
    return this;
  }
  
  getLastSeenTimestamp(): number {
    return this.lastSeenTimestamp;
  }
  
  setLastSeenTimestamp(lastSeenTimestamp: number): ZephyrPeer {
    this.lastSeenTimestamp = lastSeenTimestamp;
    return this;
  }
  
  getPruningSeed(): number {
    return this.pruningSeed;
  }
  
  setPruningSeed(pruningSeed: number): ZephyrPeer {
    this.pruningSeed = pruningSeed;
    return this;
  }
  
  getRpcPort(): number {
    return this.rpcPort;
  }

  setRpcPort(rpcPort: number): ZephyrPeer {
    this.rpcPort = rpcPort;
    return this;
  }
  
  getRpcCreditsPerHash(): bigint {
    return this.rpcCreditsPerHash;
  }
  
  setRpcCreditsPerHash(rpcCreditsPerHash: bigint): ZephyrPeer {
    this.rpcCreditsPerHash = rpcCreditsPerHash;
    return this;
  }
  
  getAvgDownload(): number {
    return this.avgDownload;
  }

  setAvgDownload(avgDownload: number): ZephyrPeer {
    this.avgDownload = avgDownload;
    return this;
  }

  getAvgUpload(): number {
    return this.avgUpload;
  }

  setAvgUpload(avgUpload: number): ZephyrPeer {
    this.avgUpload = avgUpload;
    return this;
  }

  getCurrentDownload(): number {
    return this.currentDownload;
  }

  setCurrentDownload(currentDownload: number): ZephyrPeer {
    this.currentDownload = currentDownload;
    return this;
  }

  getCurrentUpload(): number {
    return this.currentUpload;
  }

  setCurrentUpload(currentUpload: number): ZephyrPeer {
    this.currentUpload = currentUpload;
    return this;
  }

  getHeight(): number {
    return this.height;
  }

  setHeight(height: number): ZephyrPeer {
    this.height = height;
    return this;
  }

  getIsIncoming(): boolean {
    return this.isIncoming;
  }

  setIsIncoming(isIncoming: boolean): ZephyrPeer {
    this.isIncoming = isIncoming;
    return this;
  }

  getLiveTime(): number {
    return this.liveTime;
  }

  setLiveTime(liveTime: number) {
    this.liveTime = liveTime;
    return this;
  }

  getIsLocalIp(): boolean {
    return this.isLocalIp;
  }

  setIsLocalIp(isLocalIp: boolean): ZephyrPeer {
    this.isLocalIp = isLocalIp;
    return this;
  }

  getIsLocalHost(): boolean {
    return this.isLocalHost;
  }

  setIsLocalHost(isLocalHost: boolean): ZephyrPeer {
    this.isLocalHost = isLocalHost;
    return this;
  }

  getNumReceives(): number {
    return this.numReceives;
  }

  setNumReceives(numReceives: number): ZephyrPeer {
    this.numReceives = numReceives;
    return this;
  }

  getNumSends(): number {
    return this.numSends;
  }

  setNumSends(numSends: number): ZephyrPeer {
    this.numSends = numSends;
    return this;
  }

  getReceiveIdleTime(): number {
    return this.receiveIdleTime;
  }

  setReceiveIdleTime(receiveIdleTime: number): ZephyrPeer {
    this.receiveIdleTime = receiveIdleTime;
    return this;
  }

  getSendIdleTime(): number {
    return this.sendIdleTime;
  }

  setSendIdleTime(sendIdleTime: number): ZephyrPeer {
    this.sendIdleTime = sendIdleTime;
    return this;
  }

  getState(): string {
    return this.state;
  }

  setState(state: string): ZephyrPeer {
    this.state = state;
    return this;
  }

  getNumSupportFlags(): number {
    return this.numSupportFlags;
  }

  setNumSupportFlags(numSupportFlags: number): ZephyrPeer {
    this.numSupportFlags = numSupportFlags;
    return this;
  }
  
  getType(): ConnectionType {
    return this.type;
  }
  
  setType(type: ConnectionType): ZephyrPeer {
    this.type = type;
    return this;
  }
}
