/**
 * Environment overrides — how config, env, and runtime interact.
 *
 * Config resolution works in layers:
 *
 *   1. A single lace.config file is loaded (from root or explicit path).
 *   2. The base sections ([executor], [result], [extensions]) are read.
 *   3. If env is set, the [lace.config.{env}] section is deep-merged
 *      on top of the base — only keys present in the env section are
 *      overridden; everything else is inherited from the base.
 *   4. After merging, env:VARNAME references in string values are
 *      resolved against process.env.
 *
 * The env parameter selects a SECTION WITHIN the config file — it does
 * NOT select a different file.
 */

import { LaceExecutor } from "../src/api.js";

// Base config (no env)
const base = new LaceExecutor("lace");
console.error("Base config:");
console.error(`  maxTimeoutMs = ${base.config.executor.maxTimeoutMs}`);
console.error(`  user_agent   = ${base.config.executor.user_agent ?? null}`);
console.error();

// Staging overlay
const staging = new LaceExecutor("lace", { env: "staging" });
console.error("Staging config (env='staging'):");
console.error(`  maxTimeoutMs = ${staging.config.executor.maxTimeoutMs}`);
console.error(`  maxRedirects = ${staging.config.executor.maxRedirects}`);
console.error("  ^ maxTimeoutMs overridden, maxRedirects inherited from base");
console.error();

// Production overlay
const prod = new LaceExecutor("lace", { env: "production" });
console.error("Production config (env='production'):");
console.error(`  maxTimeoutMs = ${prod.config.executor.maxTimeoutMs}`);
console.error(`  user_agent   = ${prod.config.executor.user_agent}`);
console.error("  ^ maxTimeoutMs inherited, user_agent overridden");
