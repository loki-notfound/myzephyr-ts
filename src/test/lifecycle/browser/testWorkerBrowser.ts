/** Browser test worker bundle; webpack.lifecycle-consumer.js aliases the module import to the test module. */
import { installTestWorker } from "../testWorkerCore";

installTestWorker(() => require("#zephyr-sdk/zephyr.js"));
