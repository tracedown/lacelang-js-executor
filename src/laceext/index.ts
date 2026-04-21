/**
 * Generic .laceext processor.
 *
 * Implements lace-extensions.md:
 *   - TOML file loading + schema/result/functions/rules extraction
 *   - Rule-body DSL lexer, parser, and tree-walking interpreter
 *   - Hook dispatch at on [before] call | expect | check | assert | store
 *   - Tag-constructor function registration from [types] sections
 *   - Primitives: compare, map_get, map_match, is_null, type_of, to_string, replace
 */

export { Extension, loadExtension } from "./loader.js";
export { ExtensionRegistry } from "./registry.js";
