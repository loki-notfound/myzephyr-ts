/**
 * Monero banhammer.
 */
export default class ZephyrBan {

  host: string;
  ip: string;
  isBanned: boolean;
  seconds: number;
  
  constructor(ban?: Partial<ZephyrBan>) {
    Object.assign(this, ban);
  }
  
  toJson(): any {
    return Object.assign({}, this);
  }
  
  getHost(): string {
    return this.host;
  }
  
  setHost(host: string): ZephyrBan {
    this.host = host;
    return this;
  }
  
  getIp(): string {
    return this.ip;
  }
  
  setIp(ip: string): ZephyrBan {
    this.ip = ip;
    return this;
  }
  
  getIsBanned(): boolean {
    return this.isBanned;
  }
  
  setIsBanned(isBanned: boolean): ZephyrBan {
    this.isBanned = isBanned;
    return this;
  }
  
  getSeconds(): number {
    return this.seconds;
  }
  
  setSeconds(seconds: number): ZephyrBan {
    this.seconds = seconds;
    return this;
  }
}
