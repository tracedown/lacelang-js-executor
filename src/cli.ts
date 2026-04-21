#!/usr/bin/env node

/**
 * CLI for lacelang-executor — supports the full parse / validate / run
 * testkit contract. Parse and validate delegate to the lacelang-validator
 * dependency; run is the executor-specific entry point.
 *
 * Exit codes:
 *   0 on processed request (errors are in the JSON body)
 *   2 on tool/arg errors
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";

import { __version__ } from "./index.js";
import { loadConfig, ConfigError } from "./config.js";

// Validator CLI imports — may not yet be fully available.
let cmdParse: ((args: Record<string, unknown>) => number) | null = null;
let cmdValidate: ((args: Record<string, unknown>) => number) | null = null;

try {
  const mod = await import("@lacelang/validator");
  cmdParse = (mod as Record<string, unknown>).cmdParse as typeof cmdParse;
  cmdValidate = (mod as Record<string, unknown>).cmdValidate as typeof cmdValidate;
} catch {
  // Validator not available yet
}

// Validator parser import
let parse: (source: string) => Record<string, unknown>;
let validate: (
  ast: Record<string, unknown>,
  variables?: string[] | null,
  context?: { maxRedirects?: number; maxTimeoutMs?: number } | null,
  prevResultsAvailable?: boolean,
  activeExtensions?: string[] | null,
) => { errors: Array<{ code: string }>; warnings: Array<{ code: string; toDict?: () => Record<string, unknown> }> };

try {
  const mod = await import("@lacelang/validator");
  parse = (mod as Record<string, unknown>).parse as typeof parse;
  validate = (mod as Record<string, unknown>).validate as typeof validate;
} catch {
  parse = (_source: string) => ({ calls: [] });
  validate = () => ({ errors: [], warnings: [] });
}

// ─── Helpers ──────────────────────────────────────────────────────────

function emit(result: Record<string, unknown>, pretty: boolean): void {
  if (pretty) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    process.stdout.write(JSON.stringify(result) + "\n");
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function stripMetadata(node: any): any {
  if (node === null || node === undefined) return node;
  if (Array.isArray(node)) return node.map(stripMetadata);
  if (typeof node === "object") {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === "__order" || k === "__duplicates") continue;
      out[k] = stripMetadata(v);
    }
    return out;
  }
  return node;
}

function readText(filepath: string): string {
  if (filepath === "-") {
    // Read from stdin — not supported in this simple implementation
    throw new Error("stdin reading not supported");
  }
  return fs.readFileSync(filepath, "utf-8");
}

function readJson(filepath: string): Record<string, unknown> {
  const text = readText(filepath);
  return JSON.parse(text) as Record<string, unknown>;
}

function parseVarKv(raw: string): [string, unknown] {
  if (!raw.includes("=")) {
    throw new Error(`--var expects KEY=VALUE, got '${raw}'`);
  }
  const eqIdx = raw.indexOf("=");
  const key = raw.slice(0, eqIdx);
  const value = raw.slice(eqIdx + 1);
  if (!key) {
    throw new Error(`--var KEY must be non-empty: '${raw}'`);
  }
  try {
    return [key, JSON.parse(value)];
  } catch {
    return [key, value];
  }
}

function saveResult(
  result: Record<string, unknown>,
  target: string | false,
  pretty: boolean,
): void {
  if (target === false || (typeof target === "string" && target.toLowerCase() === "false")) {
    return;
  }
  if (typeof target !== "string") {
    return;
  }

  let outPath: string;
  if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
    const stamp = new Date()
      .toISOString()
      .replace(/T/, "_")
      .replace(/:/g, "-")
      .replace(/\..+/, "");
    outPath = path.join(target, `${stamp}.json`);
  } else {
    const parent = path.dirname(path.resolve(target));
    if (parent) {
      fs.mkdirSync(parent, { recursive: true });
    }
    outPath = target;
  }

  const content = pretty
    ? JSON.stringify(result, null, 2)
    : JSON.stringify(result);
  fs.writeFileSync(outPath, content, "utf-8");
}

// ─── Run subcommand ──────────────────────────────────────────────────

async function cmdRun(args: {
  script: string;
  vars?: string;
  var_entries?: string[];
  prev_results?: string;
  config?: string;
  env?: string;
  save_to?: string;
  bodies_dir?: string;
  pretty?: boolean;
  enable_extensions?: string[];
}): Promise<number> {
  const { runScript } = await import("./executor.js");

  let source: string;
  try {
    source = readText(args.script);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`error reading script: ${msg}\n`);
    return 2;
  }

  // lace.config loading
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig(args.script, args.config, args.env);
  } catch (e) {
    if (e instanceof ConfigError) {
      const now = new Date().toISOString().replace(/(\.\d{3})\d*Z$/, "$1Z");
      emit(
        {
          outcome: "failure",
          error: `config error: ${e.message}`,
          startedAt: now,
          endedAt: now,
          elapsedMs: 0,
          runVars: {},
          calls: [],
          actions: {},
        },
        args.pretty ?? false,
      );
      return 0;
    }
    throw e;
  }

  const scriptVars: Record<string, unknown> = {};
  let prev: Record<string, unknown> | null = null;

  try {
    if (args.vars) {
      Object.assign(scriptVars, readJson(args.vars));
    }
    for (const raw of args.var_entries ?? []) {
      try {
        const [k, v] = parseVarKv(raw);
        scriptVars[k] = v;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        process.stderr.write(`error: ${msg}\n`);
        return 2;
      }
    }
    if (args.prev_results) {
      prev = readJson(args.prev_results);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`error reading aux input: ${msg}\n`);
    return 2;
  }

  let ast: Record<string, unknown>;
  try {
    ast = parse(source);
  } catch (e) {
    const err = e as { line?: number; message?: string };
    emit(
      {
        outcome: "failure",
        error: `parse error on line ${err.line ?? "?"}: ${err.message ?? String(e)}`,
      },
      args.pretty ?? false,
    );
    return 0;
  }

  // Merge CLI-enabled extensions with config-declared extensions
  const cliExts = args.enable_extensions ?? [];
  const cfgExts = config.executor.extensions;
  const mergedExts: string[] = [];
  for (const name of [...cliExts, ...cfgExts]) {
    if (!mergedExts.includes(name)) {
      mergedExts.push(name);
    }
  }

  // Validate
  const ctx = {
    maxRedirects: config.executor.maxRedirects,
    maxTimeoutMs: config.executor.maxTimeoutMs,
  };
  const sink = validate(
    ast,
    undefined,
    ctx,
    prev !== null,
    mergedExts.length > 0 ? mergedExts : undefined,
  );
  if (sink.errors.length > 0) {
    const now = new Date().toISOString().replace(/(\.\d{3})\d*Z$/, "$1Z");
    const codes = sink.errors.map((d) => d.code).join(",");
    emit(
      {
        outcome: "failure",
        error: `validation failed: ${codes}`,
        startedAt: now,
        endedAt: now,
        elapsedMs: 0,
        runVars: {},
        calls: [],
        actions: {},
      },
      args.pretty ?? false,
    );
    return 0;
  }

  const result = await runScript(
    ast,
    scriptVars,
    prev,
    args.bodies_dir,
    mergedExts.length > 0 ? mergedExts : undefined,
    undefined,
    config.executor.user_agent,
    config as unknown as Record<string, unknown>,
  );

  // Surface validator warnings
  if (sink.warnings.length > 0) {
    (result as Record<string, unknown>).validationWarnings = sink.warnings.map(
      (d) => (d.toDict ? d.toDict() : { code: d.code }),
    );
  }
  emit(result, args.pretty ?? false);

  // Persist to disk
  let saveTarget: string | false = false;
  let shouldSave = false;

  if (args.save_to !== undefined) {
    saveTarget = args.save_to;
    shouldSave = true;
  } else if (config._meta?.source_path) {
    saveTarget = config.result.path as string | false;
    shouldSave = true;
  }

  if (shouldSave) {
    try {
      saveResult(result, saveTarget, args.pretty ?? false);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      process.stderr.write(`warning: failed to save result: ${msg}\n`);
    }
  }

  return 0;
}

// ─── Main CLI entry point ────────────────────────────────────────────

export async function main(argv?: string[]): Promise<number> {
  const args = argv ?? process.argv.slice(2);

  if (args.length === 0) {
    process.stderr.write(
      "Usage: lacelang-executor <parse|validate|run> [options] <script>\n",
    );
    return 2;
  }

  if (args[0] === "--version") {
    process.stdout.write(`lacelang-executor ${__version__}\n`);
    return 0;
  }

  const command = args[0];
  const rest = args.slice(1);

  if (command === "parse") {
    if (cmdParse) {
      return cmdParse({ script: rest[0], pretty: rest.includes("--pretty") });
    }
    // Fallback: basic parse
    const script = rest.find((a) => !a.startsWith("--"));
    if (!script) {
      process.stderr.write("error: script argument required\n");
      return 2;
    }
    const source = readText(script);
    const pretty = rest.includes("--pretty");
    try {
      const ast = parse(source);
      emit({ ast: stripMetadata(ast) }, pretty);
    } catch (e) {
      if (e && typeof e === "object" && "line" in e) {
        emit({ errors: [{ code: "PARSE_ERROR", line: (e as { line: number }).line }] }, pretty);
      } else {
        throw e;
      }
    }
    return 0;
  }

  if (command === "validate") {
    if (cmdValidate) {
      return cmdValidate({
        script: rest.find((a) => !a.startsWith("--")),
        pretty: rest.includes("--pretty"),
      });
    }
    const script = rest.find((a) => !a.startsWith("--"));
    if (!script) {
      process.stderr.write("error: script argument required\n");
      return 2;
    }
    const source = readText(script);
    const ast = parse(source);
    const pretty = rest.includes("--pretty");

    // Parse --vars-list and --context flags
    let variables: string[] | undefined;
    let context: { maxRedirects?: number; maxTimeoutMs?: number } | undefined;
    const varsListIdx = rest.indexOf("--vars-list");
    if (varsListIdx >= 0 && rest[varsListIdx + 1]) {
      variables = readJson(rest[varsListIdx + 1]) as unknown as string[];
    }
    const contextIdx = rest.indexOf("--context");
    if (contextIdx >= 0 && rest[contextIdx + 1]) {
      context = readJson(rest[contextIdx + 1]) as { maxRedirects?: number; maxTimeoutMs?: number };
    }

    const sink = validate(ast, variables, context);
    emit(
      { errors: sink.errors, warnings: sink.warnings },
      pretty,
    );
    return 0;
  }

  if (command === "run") {
    // Parse run arguments
    let script: string | undefined;
    let vars: string | undefined;
    const varEntries: string[] = [];
    let prevResults: string | undefined;
    let configPath: string | undefined;
    let env: string | undefined;
    let saveTo: string | undefined;
    let bodiesDir: string | undefined;
    let pretty = false;
    const enableExtensions: string[] = [];

    let i = 0;
    while (i < rest.length) {
      const arg = rest[i];
      if (arg === "--pretty") {
        pretty = true;
      } else if (arg === "--vars" && i + 1 < rest.length) {
        vars = rest[++i];
      } else if (arg === "--var" && i + 1 < rest.length) {
        varEntries.push(rest[++i]);
      } else if (
        (arg === "--prev-results" || arg === "--prev") &&
        i + 1 < rest.length
      ) {
        prevResults = rest[++i];
      } else if (arg === "--config" && i + 1 < rest.length) {
        configPath = rest[++i];
      } else if (arg === "--env" && i + 1 < rest.length) {
        env = rest[++i];
      } else if (arg === "--save-to" && i + 1 < rest.length) {
        saveTo = rest[++i];
      } else if (arg === "--bodies-dir" && i + 1 < rest.length) {
        bodiesDir = rest[++i];
      } else if (arg === "--enable-extension" && i + 1 < rest.length) {
        enableExtensions.push(rest[++i]);
      } else if (!arg.startsWith("--")) {
        script = arg;
      }
      i++;
    }

    if (!script) {
      process.stderr.write("error: script argument required\n");
      return 2;
    }

    return cmdRun({
      script,
      vars,
      var_entries: varEntries,
      prev_results: prevResults,
      config: configPath,
      env,
      save_to: saveTo,
      bodies_dir: bodiesDir,
      pretty,
      enable_extensions: enableExtensions,
    });
  }

  process.stderr.write(`error: unknown command '${command}'\n`);
  return 2;
}

// Run if executed directly
const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith("cli.js") ||
    process.argv[1].endsWith("cli.ts"));
if (isMain) {
  main().then((code) => process.exit(code));
}
