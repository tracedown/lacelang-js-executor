/**
 * Loader for .laceext TOML files (lace-extensions.md §2).
 *
 * Extracts:
 *   - [extension] metadata (name, version)
 *   - [schema.*] field registrations (passed to validator)
 *   - [types.*] custom type declarations — used to derive tag-constructor
 *     functions for one_of types
 *   - [result.*] result-shape additions
 *   - [functions.*] DSL function bodies (parsed at load time)
 *   - [[rules.rule]] rule definitions with on hook list and body
 *
 * Parses all DSL bodies eagerly so errors surface at load, not at dispatch.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseToml } from "smol-toml";
import { parseFunctionBody, parseRuleBody } from "./dsl-parser.js";

// ─── Valid hook names ─────────────────────────────────────────────────

const HOOK_NAMES = new Set<string>([
  "before script",
  "script",
  "before call",
  "call",
  "before expect",
  "expect",
  "before check",
  "check",
  "before assert",
  "assert",
  "before store",
  "store",
]);

// ─── Data structures ─────────────────────────────────────────────────

export interface HookRegistration {
  hook: string;
  after: string[];
  before: string[];
}

export interface RuleDef {
  name: string;
  hooks: HookRegistration[];
  body: Record<string, unknown>[];
  declarationIndex: number;
}

export interface FunctionDef {
  name: string;
  params: string[];
  body: Record<string, unknown>[];
  exposed: boolean;
}

export interface OneOfType {
  name: string;
  variants: Array<{ tag: string; fields: Record<string, unknown> }>;
}

export interface Extension {
  name: string;
  version: string;
  path: string | null;
  requires: string[];
  schema: Record<string, unknown>;
  result: Record<string, unknown>;
  functions: Record<string, FunctionDef>;
  oneOfTypes: Record<string, OneOfType>;
  rules: RuleDef[];
  configDefaults: Record<string, unknown>;

  tagConstructors(): Record<string, (args: unknown[]) => unknown>;
  functionSpecs(): Record<string, Record<string, unknown>>;
  exposedFunctionSpecs(): Record<string, Record<string, unknown>>;
}

function makeTagCtor(
  tag: string,
  fieldNames: string[],
): (args: unknown[]) => Record<string, unknown> {
  return (args: unknown[]) => {
    const out: Record<string, unknown> = { tag };
    for (let i = 0; i < fieldNames.length; i++) {
      out[fieldNames[i]] = i < args.length ? args[i] : null;
    }
    return out;
  };
}

function createExtension(
  name: string,
  version: string,
  extPath: string | null,
): Extension {
  const ext: Extension = {
    name,
    version,
    path: extPath,
    requires: [],
    schema: {},
    result: {},
    functions: {},
    oneOfTypes: {},
    rules: [],
    configDefaults: {},

    tagConstructors(): Record<string, (args: unknown[]) => unknown> {
      const out: Record<string, (args: unknown[]) => unknown> = {};
      for (const t of Object.values(this.oneOfTypes)) {
        for (const variant of t.variants) {
          const tag = variant.tag;
          const fieldNames = Object.keys(variant.fields || {});
          out[tag] = makeTagCtor(tag, fieldNames);
        }
      }
      return out;
    },

    functionSpecs(): Record<string, Record<string, unknown>> {
      const out: Record<string, Record<string, unknown>> = {};
      for (const [n, f] of Object.entries(this.functions)) {
        out[n] = { params: f.params, body: f.body, exposed: f.exposed };
      }
      return out;
    },

    exposedFunctionSpecs(): Record<string, Record<string, unknown>> {
      const out: Record<string, Record<string, unknown>> = {};
      for (const [n, f] of Object.entries(this.functions)) {
        if (f.exposed) {
          out[n] = { params: f.params, body: f.body, exposed: true };
        }
      }
      return out;
    },
  };
  return ext;
}

// ─── AST walking helpers ──────────────────────────────────────────────

function* walkNodes(node: unknown): Generator<Record<string, unknown>> {
  if (typeof node === "object" && node !== null) {
    if (Array.isArray(node)) {
      for (const item of node) {
        yield* walkNodes(item);
      }
    } else {
      yield node as Record<string, unknown>;
      for (const v of Object.values(node as Record<string, unknown>)) {
        yield* walkNodes(v);
      }
    }
  }
}

function bodyContainsKind(
  body: Record<string, unknown>[],
  kind: string,
): boolean {
  for (const n of walkNodes(body)) {
    if (n.kind === kind) return true;
  }
  return false;
}

function checkNoRecursion(
  filePath: string,
  functions: Record<string, FunctionDef>,
): void {
  const graph: Record<string, Set<string>> = {};
  for (const [fname, fdef] of Object.entries(functions)) {
    const targets = new Set<string>();
    for (const n of walkNodes(fdef.body)) {
      if (n.kind === "call") {
        const target = n.name as string;
        if (target in functions) {
          targets.add(target);
        }
      }
    }
    graph[fname] = targets;
  }

  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const color: Record<string, number> = {};
  for (const f of Object.keys(graph)) {
    color[f] = WHITE;
  }
  const stack: string[] = [];

  function dfs(u: string): void {
    color[u] = GREY;
    stack.push(u);
    for (const v of graph[u] || []) {
      if (color[v] === GREY) {
        const idx = stack.indexOf(v);
        const cycle = [...stack.slice(idx), v];
        throw new Error(
          `${filePath}: function recursion detected: ${cycle.join(" -> ")} (recursion is forbidden per lace-extensions.md §6)`,
        );
      }
      if (color[v] === WHITE) {
        dfs(v);
      }
    }
    stack.pop();
    color[u] = BLACK;
  }

  for (const fname of Object.keys(graph)) {
    if (color[fname] === WHITE) {
      dfs(fname);
    }
  }
}

// ─── Hook entry parsing ──────────────────────────────────────────────

function parseOnEntry(entry: string): HookRegistration {
  if (typeof entry !== "string") {
    throw new Error(`on-entry must be string, got ${typeof entry}`);
  }
  const trimmed = entry.trim();
  const tokens = trimmed.split(/\s+/);
  if (tokens.length === 0) {
    throw new Error("empty on-entry");
  }

  let hook: string | null = null;
  let remaining: string[];

  if (tokens.length >= 2 && HOOK_NAMES.has(`${tokens[0]} ${tokens[1]}`)) {
    hook = `${tokens[0]} ${tokens[1]}`;
    remaining = tokens.slice(2);
  } else if (HOOK_NAMES.has(tokens[0])) {
    hook = tokens[0];
    remaining = tokens.slice(1);
  } else {
    throw new Error(`unknown hook in on-entry '${entry}'`);
  }

  const after: string[] = [];
  const before: string[] = [];
  let i = 0;
  while (i < remaining.length) {
    const kw = remaining[i];
    if (kw !== "after" && kw !== "before") {
      throw new Error(
        `expected 'after' or 'before' in on-entry '${entry}', got '${kw}'`,
      );
    }
    if (i + 1 >= remaining.length) {
      throw new Error(`dangling qualifier in on-entry '${entry}'`);
    }
    const extName = remaining[i + 1];
    if (kw === "after") {
      after.push(extName);
    } else {
      before.push(extName);
    }
    i += 2;
  }

  return { hook, after, before };
}

// ─── Config defaults loading ──────────────────────────────────────────

function loadConfigDefaults(
  laceextPath: string,
  extName: string,
  extVersion: string,
): Record<string, unknown> {
  const dir = path.dirname(laceextPath);
  const configPath = path.join(dir, `${extName}.config`);
  if (!fs.existsSync(configPath)) {
    return {};
  }
  try {
    const content = fs.readFileSync(configPath, "utf-8");
    const doc = parseToml(content) as Record<string, unknown>;
    const meta = (doc.extension as Record<string, unknown>) || {};
    const cfgName = meta.name as string | undefined;
    const cfgVersion = meta.version as string | undefined;
    if (cfgName && cfgName !== extName) {
      process.stderr.write(
        `warning: ${configPath}: config name '${cfgName}' does not match extension name '${extName}'\n`,
      );
    }
    if (cfgVersion && cfgVersion !== extVersion) {
      process.stderr.write(
        `warning: ${configPath}: config version '${cfgVersion}' does not match extension version '${extVersion}'\n`,
      );
    }
    return (doc.config as Record<string, unknown>) || {};
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `${configPath}: failed to parse extension config: ${msg}`,
    );
  }
}

// ─── Main loader ──────────────────────────────────────────────────────

export function loadExtension(filePath: string): Extension {
  const text = fs.readFileSync(filePath, "utf-8");
  const doc = parseToml(text) as Record<string, unknown>;

  // Warn on unrecognized top-level sections
  const knownTopLevel = new Set([
    "extension",
    "schema",
    "result",
    "types",
    "functions",
    "rules",
  ]);
  for (const key of Object.keys(doc)) {
    if (!knownTopLevel.has(key)) {
      process.stderr.write(
        `warning: ${filePath}: unknown top-level section [${key}] ` +
          `(known: ${[...knownTopLevel].sort().join(", ")})\n`,
      );
    }
  }

  const meta = (doc.extension as Record<string, unknown>) || {};
  const name = meta.name as string | undefined;
  const version = (meta.version as string) || "0.0.0";
  if (!name) {
    throw new Error(`${filePath}: [extension].name is required`);
  }
  if (!/^[a-z][A-Za-z0-9]*$/.test(name)) {
    throw new Error(
      `${filePath}: [extension].name must match [a-z][A-Za-z0-9]* (camelCase), got '${name}'`,
    );
  }

  const ext = createExtension(name, version, filePath);

  // Optional require
  const req = meta.require;
  if (req !== undefined) {
    if (
      !Array.isArray(req) ||
      !req.every((r) => typeof r === "string")
    ) {
      throw new Error(
        `${filePath}: [extension].require must be an array of strings`,
      );
    }
    ext.requires = [...(req as string[])];
  }

  // Schema additions
  if (typeof doc.schema === "object" && doc.schema !== null) {
    ext.schema = doc.schema as Record<string, unknown>;
  }

  // Result additions
  if (typeof doc.result === "object" && doc.result !== null) {
    ext.result = doc.result as Record<string, unknown>;
  }

  // Custom types
  const typesSection =
    (doc.types as Record<string, unknown>) || {};
  for (const [tname, tdef] of Object.entries(typesSection)) {
    if (
      typeof tdef === "object" &&
      tdef !== null &&
      Array.isArray((tdef as Record<string, unknown>).one_of)
    ) {
      const variants: Array<{
        tag: string;
        fields: Record<string, unknown>;
      }> = [];
      for (const v of (tdef as Record<string, unknown>).one_of as Record<string, unknown>[]) {
        if (typeof v !== "object" || v === null || !("tag" in v)) continue;
        variants.push({
          tag: v.tag as string,
          fields: (v.fields as Record<string, unknown>) || {},
        });
      }
      ext.oneOfTypes[tname] = { name: tname, variants };
    }
  }

  // Functions
  const funcsSection =
    (doc.functions as Record<string, unknown>) || {};
  for (const [fname, fdef] of Object.entries(funcsSection)) {
    if (typeof fdef !== "object" || fdef === null) continue;
    const fd = fdef as Record<string, unknown>;
    const params = Array.isArray(fd.params)
      ? (fd.params as string[])
      : [];
    const bodyText = (fd.body as string) || "";
    const exposed = Boolean(fd.exposed ?? false);
    let bodyAst: Record<string, unknown>[];
    try {
      bodyAst = parseFunctionBody(bodyText);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(
        `${filePath}: error parsing function '${fname}': ${msg}`,
      );
    }
    // Safety checks
    if (bodyContainsKind(bodyAst, "exit")) {
      throw new Error(
        `${filePath}: function '${fname}' contains an 'exit' statement; ` +
          `exit is only valid in rule bodies (use 'return null' to early-exit a function)`,
      );
    }
    if (!exposed && bodyContainsKind(bodyAst, "emit")) {
      throw new Error(
        `${filePath}: function '${fname}' contains an 'emit' statement ` +
          `but is not exposed; declare [functions.${fname}].exposed = true to allow emit on behalf of this extension`,
      );
    }
    ext.functions[fname] = {
      name: fname,
      params: [...params],
      body: bodyAst,
      exposed,
    };
  }

  // Recursion check
  checkNoRecursion(filePath, ext.functions);

  // Rules
  const rulesSection =
    (doc.rules as Record<string, unknown>) || {};
  let ruleList = rulesSection.rule;
  if (ruleList !== undefined && !Array.isArray(ruleList)) {
    ruleList = [ruleList];
  }
  if (Array.isArray(ruleList)) {
    for (let declIdx = 0; declIdx < ruleList.length; declIdx++) {
      const rdef = ruleList[declIdx] as Record<string, unknown>;
      if (typeof rdef !== "object" || rdef === null) continue;
      const rname = (rdef.name as string) || "<unnamed>";
      let rawHooks = rdef.on;
      if (typeof rawHooks === "string") {
        rawHooks = [rawHooks];
      }
      if (!Array.isArray(rawHooks)) {
        rawHooks = [];
      }
      const parsedHooks: HookRegistration[] = [];
      for (const entry of rawHooks as string[]) {
        try {
          parsedHooks.push(parseOnEntry(entry));
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          throw new Error(
            `${filePath}: rule '${rname}': ${msg}`,
          );
        }
      }
      const bodyText = (rdef.body as string) || "";
      let bodyAst: Record<string, unknown>[];
      try {
        bodyAst = parseRuleBody(bodyText);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(
          `${filePath}: error parsing rule '${rname}': ${msg}`,
        );
      }
      ext.rules.push({
        name: rname,
        hooks: parsedHooks,
        body: bodyAst,
        declarationIndex: declIdx,
      });
    }
  }

  // Sibling config
  ext.configDefaults = loadConfigDefaults(filePath, ext.name, ext.version);

  return ext;
}
