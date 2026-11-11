"use strict";
// Node consumer of the package entry through require(). Creates a wallet with the daemon, saves it,
// reopens it from its bytes, then syncs a saved disposable wallet once (its bytes already hold the
// block hashes). Usage: node consumer.cjs <wallet dir> <result.json>; daemon: ZEPHYR_TS_TEST_DAEMON.
const z = require("@loki-notfound/zephyr-ts");
require("./flow.cjs").run(z, "require", process.argv[2], process.argv[3]).then(() => process.exit(0), (e) => {
  process.stderr.write("consumer failed: " + (e instanceof z.ZephyrWalletError ? e.code + "/" + e.diagnostic : e && e.name) + "\n");
  process.exit(1);
});
