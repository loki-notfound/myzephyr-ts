/**
 * Measurement worker wrapper (test only): the production lifecycle worker with the
 * release module, plus one read-only "__measure" message that reports the size of this worker's
 * WebAssembly linear memory and its JavaScript heap. Every other message goes unchanged to the
 * production dispatcher. Never part of the release worker bundle.
 */
import "../../main/ts/common/ZephyrWebWorker";
import LibraryUtils from "../../main/ts/common/LibraryUtils";

declare const self: any;

export function installMeasureWorker(heapUsage: () => { used: number | undefined; total: number | undefined }): void {
  const production = self.onmessage;
  self.onmessage = async (e: MessageEvent) => {
    const data = e.data;
    if (Array.isArray(data) && data[1] === "__measure") {
      const module = LibraryUtils.getWasmModule();
      const heap = heapUsage();
      self.postMessage([data[0], data[2], { result: { linearMemoryBytes: module && module.HEAP8 ? module.HEAP8.length : 0, jsHeapUsed: heap.used, jsHeapTotal: heap.total,
        wasmCompilations: LibraryUtils.WASM_COMPILATIONS, sharedModule: LibraryUtils.WASM_SHARED_REQUIRED && LibraryUtils.WASM_COMPILED_VALUE !== undefined } }]);
      return;
    }
    return production(e);
  };
}
