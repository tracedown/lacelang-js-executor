/**
 * Basic library usage — single probe, auto-prev tracking.
 */

import { LaceExecutor } from "../src/api.js";

// Point to the lace/ directory.  Config is loaded once from
// lace/lace.config; scripts resolve by name from lace/scripts/.
const executor = new LaceExecutor("lace");

// Prepare the "health" probe.
// Resolves to lace/scripts/health/health.lace, parses and validates
// the AST once.  The probe is bound to this executor and reuses the
// same config and extension set.
const probe = executor.probe("health");

// First run — no prev result yet.
const r1 = await probe.run({ base_url: "https://httpbin.org" });
console.error(`Run 1: ${r1.outcome}  (calls: ${(r1.calls as unknown[]).length})`);

// Second run — prev is automatically injected from the first run.
const r2 = await probe.run({ base_url: "https://httpbin.org" });
console.error(`Run 2: ${r2.outcome}  (prev was injected: ${probe.prev !== null})`);

// Override prev explicitly when needed.
const r3 = await probe.run(
  { base_url: "https://httpbin.org" },
  { outcome: "success", calls: [] },
);
console.error(`Run 3: ${r3.outcome}  (explicit prev)`);
