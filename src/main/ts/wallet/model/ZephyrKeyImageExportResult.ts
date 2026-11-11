import ZephyrKeyImage from "../../daemon/model/ZephyrKeyImage";

/**
 * Models results from exporting signed key images.
 */
export default class ZephyrKeyImageExportResult {

  offset: number;
  keyImages: ZephyrKeyImage[];

  constructor(result?: Partial<ZephyrKeyImageExportResult>) {
    Object.assign(this, result);
    if (this.keyImages) this.keyImages = this.keyImages.map(keyImage => keyImage instanceof ZephyrKeyImage ? keyImage : new ZephyrKeyImage(keyImage));
  }

  toJson(): any {
    let json: any = Object.assign({}, this);
    if (this.getKeyImages() !== undefined) json.keyImages = this.getKeyImages().map(keyImage => keyImage.toJson());
    return json;
  }

  getOffset(): number {
    return this.offset;
  }

  setOffset(offset: number): ZephyrKeyImageExportResult {
    this.offset = offset;
    return this;
  }

  getKeyImages(): ZephyrKeyImage[] {
    return this.keyImages;
  }

  setKeyImages(keyImages: ZephyrKeyImage[]): ZephyrKeyImageExportResult {
    this.keyImages = keyImages;
    return this;
  }
}
