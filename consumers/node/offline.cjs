"use strict";
// Offline platform checks of the package entry loaded through require().
// Usage: node --require ./offlineGuard.cjs offline.cjs --mode direct|worker --out <report.json>
const z = require("@loki-notfound/zephyr-ts");
require("./offlineRun.cjs").run(z, "require", process.argv.slice(2)).then((ok) => process.exit(ok ? 0 : 1), (e) => {
  process.stderr.write("offline checks failed to run: " + (e instanceof z.ZephyrWalletError ? e.code + "/" + e.diagnostic : e && e.message) + "\n");
  process.exit(1);
});
