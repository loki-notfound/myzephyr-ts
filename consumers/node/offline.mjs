// Offline platform checks of the package entry loaded through import.
// Usage: node --require ./offlineGuard.cjs offline.mjs --mode direct|worker --out <report.json>
import { createRequire } from "module";
import * as z from "@loki-notfound/zephyr-ts";

const { run } = createRequire(import.meta.url)("./offlineRun.cjs");
try {
  process.exit((await run(z, "import", process.argv.slice(2))) ? 0 : 1);
} catch (e) {
  process.stderr.write("offline checks failed to run: " + (e instanceof z.ZephyrWalletError ? e.code + "/" + e.diagnostic : e && e.message) + "\n");
  process.exit(1);
}
