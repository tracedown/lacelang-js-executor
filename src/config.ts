/**
 * lace.config TOML loader — spec §11.
 *
 * Resolution order (first match wins unless explicit_path is provided):
 *
 * 1. explicit_path (from --config), if set.
 * 2. lace.config in the script's directory.
 * 3. lace.config in the current working directory.
 * 4. Defaults-only (no file).
 *
 * If LACE_ENV or env_selector (from --env) is set, any
 * [lace.config.{env}] section is merged on top of the base sections
 * (base over defaults, env over base).
 *
 * Every string value supports env:VARNAME and env:VARNAME:default
 * substitution — resolved against process.env at load time.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseToml } from "smol-toml";

// ─── Defaults (spec §11 table) ───────────────────────────────────────

const DEFAULT_MAX_REDIRECTS = 10;
const DEFAULT_MAX_TIMEOUT_MS = 300_000;
const DEFAULT_RESULT_PATH = ".";

// ─── Error class ─────────────────────────────────────────────────────

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

// ─── Public entry point ──────────────────────────────────────────────

export interface LaceConfig {
  executor: {
    extensions: string[];
    maxRedirects: number;
    maxTimeoutMs: number;
    user_agent?: string;
  };
  result: {
    path: string | false;
    bodies: { dir: string };
  };
  extensions: Record<string, Record<string, unknown>>;
  _meta: { source_path: string | null };
}

export function loadConfig(
  scriptPath?: string | null,
  explicitPath?: string | null,
  envSelector?: string | null,
): LaceConfig {
  const foundPath = resolvePath(scriptPath ?? null, explicitPath ?? null);
  const raw = readToml(foundPath);

  const envName = envSelector || process.env.LACE_ENV || null;
  const merged = mergeWithEnv(raw, envName);
  const resolved = resolveEnvRefs(merged) as Record<string, unknown>;
  const cfg = applyDefaults(resolved);
  cfg._meta = { source_path: foundPath };
  return cfg;
}

// ─── File discovery + parse ──────────────────────────────────────────

function resolvePath(
  scriptPath: string | null,
  explicitPath: string | null,
): string | null {
  if (explicitPath) {
    if (!fs.existsSync(explicitPath)) {
      throw new ConfigError(`config file not found: ${explicitPath}`);
    }
    return explicitPath;
  }

  const candidates: string[] = [];
  if (scriptPath) {
    const scriptDir = path.dirname(path.resolve(scriptPath));
    candidates.push(path.join(scriptDir, "lace.config"));
  }
  candidates.push(path.join(process.cwd(), "lace.config"));

  for (const c of candidates) {
    if (fs.existsSync(c)) {
      return c;
    }
  }
  return null;
}

function readToml(filePath: string | null): Record<string, unknown> {
  if (filePath === null) {
    return {};
  }
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return parseToml(content) as Record<string, unknown>;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new ConfigError(`failed to parse config ${filePath}: ${msg}`);
  }
}

// ─── Section merging (base + [lace.config.{env}]) ────────────────────

function mergeWithEnv(
  raw: Record<string, unknown>,
  envName: string | null,
): Record<string, unknown> {
  // Copy top-level (excluding the lace.config.* namespace).
  const base: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k !== "lace") {
      base[k] = deepCopy(v);
    }
  }

  if (envName === null) {
    return base;
  }

  const lace = raw.lace;
  if (typeof lace !== "object" || lace === null) {
    return base;
  }
  const config = (lace as Record<string, unknown>).config;
  if (typeof config !== "object" || config === null) {
    return base;
  }
  const envSection = (config as Record<string, unknown>)[envName];
  if (typeof envSection !== "object" || envSection === null) {
    return base;
  }

  return deepMerge(base, envSection as Record<string, unknown>);
}

function deepCopy(v: unknown): unknown {
  if (typeof v === "object" && v !== null) {
    if (Array.isArray(v)) {
      return v.map(deepCopy);
    }
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      out[k] = deepCopy(x);
    }
    return out;
  }
  return v;
}

function deepMerge(
  base: Record<string, unknown>,
  overlay: Record<string, unknown>,
): Record<string, unknown> {
  const out = deepCopy(base) as Record<string, unknown>;
  for (const [k, v] of Object.entries(overlay)) {
    if (
      typeof v === "object" &&
      v !== null &&
      !Array.isArray(v) &&
      typeof out[k] === "object" &&
      out[k] !== null &&
      !Array.isArray(out[k])
    ) {
      out[k] = deepMerge(
        out[k] as Record<string, unknown>,
        v as Record<string, unknown>,
      );
    } else {
      out[k] = deepCopy(v);
    }
  }
  return out;
}

// ─── env: substitution ───────────────────────────────────────────────

function resolveEnvRefs(node: unknown): unknown {
  if (typeof node === "object" && node !== null) {
    if (Array.isArray(node)) {
      return node.map(resolveEnvRefs);
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      out[k] = resolveEnvRefs(v);
    }
    return out;
  }
  if (typeof node === "string") {
    return resolveEnvString(node);
  }
  return node;
}

function resolveEnvString(s: string): string {
  if (!s.startsWith("env:")) {
    return s;
  }
  const body = s.slice(4);
  if (body.includes(":")) {
    const idx = body.indexOf(":");
    const varName = body.slice(0, idx);
    const defaultVal = body.slice(idx + 1);
    return process.env[varName] ?? defaultVal;
  }
  const val = process.env[body];
  if (val === undefined) {
    throw new ConfigError(
      `config references env var '${body}' but it is not set ` +
        `(use 'env:${body}:default' to supply a fallback)`,
    );
  }
  return val;
}

// ─── Defaults ────────────────────────────────────────────────────────

function applyDefaults(cfg: Record<string, unknown>): LaceConfig {
  const executor =
    typeof cfg.executor === "object" && cfg.executor !== null
      ? (cfg.executor as Record<string, unknown>)
      : {};
  if (typeof executor !== "object") {
    throw new ConfigError("config [executor] must be a table");
  }

  let extensionsList = executor.extensions;
  if (extensionsList === undefined || extensionsList === null) {
    extensionsList = [];
  }
  if (!Array.isArray(extensionsList)) {
    throw new ConfigError("config executor.extensions must be an array");
  }
  const extensions = extensionsList.map(String);

  const maxRedirects = Number(executor.maxRedirects ?? DEFAULT_MAX_REDIRECTS);
  const maxTimeoutMs = Number(executor.maxTimeoutMs ?? DEFAULT_MAX_TIMEOUT_MS);
  const userAgent = executor.user_agent;
  if (userAgent !== undefined && userAgent !== null && typeof userAgent !== "string") {
    throw new ConfigError("config executor.user_agent must be a string");
  }

  const result =
    typeof cfg.result === "object" && cfg.result !== null
      ? (cfg.result as Record<string, unknown>)
      : {};
  if (typeof result !== "object") {
    throw new ConfigError("config [result] must be a table");
  }

  let resultPath: string | false = (result.path as string) ?? DEFAULT_RESULT_PATH;
  // $LACE_RESULT_PATH overrides config when set.
  const envResultPath = process.env.LACE_RESULT_PATH;
  if (envResultPath !== undefined) {
    resultPath = envResultPath;
  }
  if (typeof resultPath === "string" && resultPath.toLowerCase() === "false") {
    resultPath = false;
  }

  const bodies =
    typeof result.bodies === "object" && result.bodies !== null
      ? (result.bodies as Record<string, unknown>)
      : {};
  if (typeof bodies !== "object") {
    throw new ConfigError("config [result.bodies] must be a table");
  }

  let defaultBodiesDir: string;
  if (typeof resultPath === "string") {
    defaultBodiesDir = resultPath;
  } else {
    defaultBodiesDir = process.env.LACE_BODIES_DIR || DEFAULT_RESULT_PATH;
  }
  const bodiesDir = (bodies.dir as string) ?? defaultBodiesDir;

  const extBlock =
    typeof cfg.extensions === "object" && cfg.extensions !== null
      ? (cfg.extensions as Record<string, Record<string, unknown>>)
      : {};
  if (typeof extBlock !== "object") {
    throw new ConfigError("config [extensions] must be a table");
  }

  return {
    executor: {
      extensions,
      maxRedirects,
      maxTimeoutMs,
      user_agent: typeof userAgent === "string" ? userAgent : undefined,
    },
    result: {
      path: resultPath,
      bodies: { dir: bodiesDir },
    },
    extensions: extBlock,
    _meta: { source_path: null },
  };
}
