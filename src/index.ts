/**
 * Reference TypeScript executor for the Lace probe scripting language.
 */

import { createRequire } from "node:module";

const _require = createRequire(import.meta.url);
const { version } = _require("../package.json");

export const __version__: string = version;
export const __ast_version__ = "0.9.2";

export { LaceExecutor, LaceProbe, LaceExtension } from "./api.js";
export { runScript } from "./executor.js";
export { loadConfig } from "./config.js";
