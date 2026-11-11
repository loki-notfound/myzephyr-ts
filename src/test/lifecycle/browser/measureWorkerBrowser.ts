/** Browser measurement worker bundle with the release module (test only). */
import { installMeasureWorker } from "../measureWorkerCore";

installMeasureWorker(() => {
  const memory = (performance as unknown as { memory?: { usedJSHeapSize: number; totalJSHeapSize: number } }).memory;
  return { used: memory ? memory.usedJSHeapSize : undefined, total: memory ? memory.totalJSHeapSize : undefined };
});
