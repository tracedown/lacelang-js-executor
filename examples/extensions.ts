/**
 * Extension registration — built-in and third-party.
 */

import { LaceExecutor } from "../src/api.js";

// Built-in extensions — declared in lace.config under
// [executor].extensions, or passed at construction time.
const executor = new LaceExecutor("lace", {
  extensions: ["laceNotifications"],
});

// Third-party extensions — registered via executor.extension().
// Directory-based: finds myext.laceext and myext.config inside.
// executor.extension("lace/extensions/myext");

// Explicit paths:
// executor.extension("path/to/custom.laceext", "path/to/custom.config");

// Extension config is merged into the executor's [extensions] block
// so the extension's rules can access it via the `config` base in
// the DSL.

console.error("Extensions loaded:", executor.config.executor.extensions);
