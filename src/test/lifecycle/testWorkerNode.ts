/** Node test worker (worker_threads through web-worker): loads the test module named by LIFECYCLE_TEST_MODULE. */
import { installTestWorker } from "./testWorkerCore";

installTestWorker(() => require(process.env.LIFECYCLE_TEST_MODULE as string));
