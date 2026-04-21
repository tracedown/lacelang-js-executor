/**
 * Multiple probes on one executor — each tracks its own prev.
 */

import { LaceExecutor } from "../src/api.js";

const executor = new LaceExecutor("lace");

// Each probe has its own AST (parsed once) and its own prev chain.
const health = executor.probe("health");
const auth = executor.probe("auth-flow");

// Run health probe twice — prev chains automatically.
const r1 = await health.run({ vars: "lace/scripts/health/vars.json" });
const r2 = await health.run({ vars: "lace/scripts/health/vars.json" });
console.error(`health run 1: ${r1.outcome}`);
console.error(`health run 2: ${r2.outcome}  (prev injected)`);

// Auth probe has its own independent prev.
const r3 = await auth.run({ vars: "lace/scripts/auth-flow/vars.json" });
console.error(`auth run 1:   ${r3.outcome}  (no prev — independent)`);

// Verify prev isolation: health's prev is from r2, not r3.
console.error(`health.prev === r2: ${health.prev === r2}`);
console.error(`auth.prev === r3:   ${auth.prev === r3}`);

// Reset prev manually.
health.prev = null;
const r4 = await health.run({ vars: "lace/scripts/health/vars.json" });
console.error(`health run 3: ${r4.outcome}  (prev reset to null)`);

// Disable auto-tracking entirely.
const executorNoTrack = new LaceExecutor("lace", { trackPrev: false });
const probe = executorNoTrack.probe("health");
await probe.run({ vars: "lace/scripts/health/vars.json" });
console.error(`no-track prev: ${probe.prev}`); // null
