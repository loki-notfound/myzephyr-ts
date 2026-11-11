/** Node measurement worker (worker_threads through web-worker) with the release module. */
import { installMeasureWorker } from "./measureWorkerCore";

installMeasureWorker(() => {
  const v8 = require("v8");
  const s = v8.getHeapStatistics();
  return { used: s.used_heap_size, total: s.total_heap_size };
});
