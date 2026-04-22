/**
 * Reference TypeScript executor for the Lace probe scripting language.
 */

export const __version__ = "0.1.0";
export const __ast_version__ = "0.9.1";

export { LaceExecutor, LaceProbe, LaceExtension } from "./api.js";
export { runScript } from "./executor.js";
export { loadConfig } from "./config.js";
