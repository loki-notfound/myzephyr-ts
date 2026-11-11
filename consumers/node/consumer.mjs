// Node consumer of the package entry through import (named exports of the CommonJS entry).
// Usage: node consumer.mjs <wallet dir> <result.json>; daemon: ZEPHYR_TS_TEST_DAEMON.
import { createRequire } from "module";
import * as z from "@loki-notfound/zephyr-ts";
import { ZephyrWalletError, createRandomWallet, openWalletData, setWasmModuleUrl } from "@loki-notfound/zephyr-ts";

const { run } = createRequire(import.meta.url)("./flow.cjs");
const named = [createRandomWallet, openWalletData, setWasmModuleUrl].every((f) => typeof f === "function") && typeof ZephyrWalletError === "function";
try {
  await run(z, "import", process.argv[2], process.argv[3], { namedExports: named });
  process.exit(0);
} catch (e) {
  process.stderr.write("consumer failed: " + (e instanceof ZephyrWalletError ? e.code + "/" + e.diagnostic : e && e.name) + "\n");
  process.exit(1);
}
