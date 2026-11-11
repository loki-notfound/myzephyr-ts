/** Instrumented-suite browser consumer: test worker bundle /zephyr.test.worker.js (test only). */
import { runPage } from "./pageRunner";

runPage("instrumented", "/zephyr.test.worker.js", "/zephyr.test.wasm");
