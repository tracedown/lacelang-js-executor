/**
 * High-level library API for running Lace scripts programmatically.
 *
 * Provides LaceExecutor (config + extension holder) and LaceProbe
 * (prepared script with auto-prev tracking, bound to its executor).
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { loadConfig, type LaceConfig } from "./config.js";
import { runScript } from "./executor.js";

// Validator imports — may not yet be fully available.
let parse: (source: string) => Record<string, unknown>;
let validate: (
  ast: Record<string, unknown>,
  variables?: string[] | null,
  context?: { maxRedirects?: number; maxTimeoutMs?: number } | null,
  prevResultsAvailable?: boolean,
  activeExtensions?: string[] | null,
) => { errors: Array<{ code: string }>; warnings: Array<{ code: string }> };

try {
  const mod = await import("@lacelang/validator");
  parse = (mod as Record<string, unknown>).parse as typeof parse;
  validate = (mod as Record<string, unknown>).validate as typeof validate;
} catch {
  parse = (_source: string) => ({ calls: [] });
  validate = () => ({ errors: [], warnings: [] });
}

// ─── Helpers ──────────────────────────────────────────────────────────

function loadJson(
  pathOrDict: string | Record<string, unknown>,
): Record<string, unknown> {
  if (typeof pathOrDict === "object") {
    return pathOrDict;
  }
  const content = fs.readFileSync(pathOrDict, "utf-8");
  return JSON.parse(content) as Record<string, unknown>;
}

function readSource(pathOrSource: string): [string, string | null] {
  if (
    pathOrSource.trimEnd().endsWith(".lace") ||
    fs.existsSync(pathOrSource)
  ) {
    const content = fs.readFileSync(pathOrSource, "utf-8");
    return [content, path.resolve(pathOrSource)];
  }
  return [pathOrSource, null];
}

// ─── LaceProbe ────────────────────────────────────────────────────────

export class LaceProbe {
  private _executor: LaceExecutor;
  private _ast: Record<string, unknown>;
  private _prev: Record<string, unknown> | null = null;
  private _alwaysReparse = false;
  scriptPath: string | null;
  name: string | null;

  constructor(
    executor: LaceExecutor,
    ast: Record<string, unknown>,
    options?: { scriptPath?: string | null; name?: string | null },
  ) {
    this._executor = executor;
    this._ast = ast;
    this.scriptPath = options?.scriptPath ?? null;
    this.name = options?.name ?? null;
  }

  get prev(): Record<string, unknown> | null {
    return this._prev;
  }

  set prev(value: Record<string, unknown> | null) {
    this._prev = value;
  }

  async run(
    vars?: string | Record<string, unknown> | null,
    prev?: string | Record<string, unknown> | null,
    options?: { reparse?: boolean },
  ): Promise<Record<string, unknown>> {
    if (
      (options?.reparse || this._alwaysReparse) &&
      this.scriptPath
    ) {
      const content = fs.readFileSync(this.scriptPath, "utf-8");
      this._ast = parse(content);
    }

    const scriptVars =
      vars !== null && vars !== undefined ? loadJson(vars) : {};

    let prevResult: Record<string, unknown> | null = null;
    if (prev !== null && prev !== undefined) {
      prevResult = loadJson(prev);
    } else if (this._executor.trackPrev && this._prev !== null) {
      prevResult = this._prev;
    }

    const result = await runScript(
      this._ast,
      scriptVars,
      prevResult,
      undefined,
      this._executor._activeExtNames.length > 0
        ? this._executor._activeExtNames
        : undefined,
      this._executor._extensionPaths.length > 0
        ? this._executor._extensionPaths
        : undefined,
      this._executor._config.executor.user_agent,
      this._executor._config as unknown as Record<string, unknown>,
    );

    if (this._executor.trackPrev) {
      this._prev = result;
    }

    return result;
  }

  /** @internal */
  _setAlwaysReparse(val: boolean): void {
    this._alwaysReparse = val;
  }
}

// ─── LaceExtension ────────────────────────────────────────────────────

export class LaceExtension {
  path: string;
  configPath: string | null;
  name: string;

  constructor(extPath: string, configPath?: string | null) {
    this.path = path.resolve(extPath);
    this.configPath = configPath ? path.resolve(configPath) : null;
    this.name = path.basename(extPath, path.extname(extPath));
  }
}

// ─── LaceExecutor ─────────────────────────────────────────────────────

export class LaceExecutor {
  private _root: string | null;
  _config: LaceConfig;
  trackPrev: boolean;
  _activeExtNames: string[];
  _extensionPaths: string[];
  private _extensions: LaceExtension[];
  private _probes: Map<string, LaceProbe>;

  constructor(
    root?: string | null,
    options?: {
      config?: string | null;
      env?: string | null;
      extensions?: string[] | null;
      trackPrev?: boolean;
    },
  ) {
    if (root !== undefined && root !== null) {
      this._root = path.resolve(root);
    } else {
      this._root = null;
    }

    // Config: explicit path > {root}/lace.config > cwd discovery.
    let configPath = options?.config ?? null;
    if (configPath === null && this._root) {
      const candidate = path.join(this._root, "lace.config");
      if (fs.existsSync(candidate)) {
        configPath = candidate;
      }
    }

    this._config = loadConfig(null, configPath, options?.env ?? null);
    this.trackPrev = options?.trackPrev ?? true;

    // Built-in extensions from config + constructor arg.
    const cfgExts = [...this._config.executor.extensions];
    const extraExts = [...(options?.extensions ?? [])];
    const merged: string[] = [];
    for (const name of [...extraExts, ...cfgExts]) {
      if (!merged.includes(name)) {
        merged.push(name);
      }
    }
    this._activeExtNames = merged;

    this._extensionPaths = [];
    this._extensions = [];
    this._probes = new Map();
  }

  get root(): string | null {
    return this._root;
  }

  get config(): LaceConfig {
    return this._config;
  }

  // ── Extension registration ──────────────────────────────────────

  extension(
    extPath: string,
    configPath?: string | null,
  ): LaceExtension {
    // If path is a directory, resolve the manifest inside it.
    if (fs.existsSync(extPath) && fs.statSync(extPath).isDirectory()) {
      const name = path.basename(path.resolve(extPath));
      const manifest = path.join(extPath, `${name}.laceext`);
      if (!fs.existsSync(manifest)) {
        throw new Error(
          `no ${name}.laceext found in directory ${extPath}`,
        );
      }
      if (configPath === undefined || configPath === null) {
        const candidate = path.join(extPath, `${name}.config`);
        if (fs.existsSync(candidate)) {
          configPath = candidate;
        }
      }
      extPath = manifest;
    }

    if (!fs.existsSync(extPath)) {
      throw new Error(`extension not found: ${extPath}`);
    }

    const ext = new LaceExtension(extPath, configPath);
    this._extensions.push(ext);
    this._extensionPaths.push(ext.path);

    // Merge extension config
    if (ext.configPath) {
      this._mergeExtensionConfig(ext);
    }

    return ext;
  }

  private _mergeExtensionConfig(ext: LaceExtension): void {
    if (!ext.configPath) return;
    try {
      const { parse: parseToml } = require("smol-toml") as { parse: (s: string) => Record<string, unknown> };
      const content = fs.readFileSync(ext.configPath, "utf-8");
      const raw = parseToml(content);
      const extSection =
        (raw.config as Record<string, unknown>) || {};
      if (Object.keys(extSection).length > 0) {
        const exts = ((this._config as unknown as Record<string, Record<string, unknown>>).extensions ??= {});
        (exts as Record<string, unknown>)[ext.name] = extSection;
      }
    } catch {
      // Config loading is best-effort.
    }
  }

  // ── Probe creation ──────────────────────────────────────────────

  probe(
    script: string,
    options?: {
      vars?: string | Record<string, unknown> | null;
      alwaysReparse?: boolean;
    },
  ): LaceProbe {
    const [source, scriptPath, name] = this._resolveScript(script);
    const ast = parse(source);

    // Validate at preparation time.
    const ctx = {
      maxRedirects: this._config.executor.maxRedirects,
      maxTimeoutMs: this._config.executor.maxTimeoutMs,
    };
    const sink = validate(
      ast,
      undefined,
      ctx,
      false,
      this._activeExtNames.length > 0 ? this._activeExtNames : undefined,
    );
    if (sink.errors.length > 0) {
      const codes = sink.errors.map((d) => d.code).join(", ");
      throw new Error(`validation failed: ${codes}`);
    }

    const p = new LaceProbe(this, ast, { scriptPath, name });
    if (options?.alwaysReparse) {
      p._setAlwaysReparse(true);
    }

    if (name) {
      this._probes.set(name, p);
    }

    return p;
  }

  async run(
    script: string,
    vars?: string | Record<string, unknown> | null,
    prev?: string | Record<string, unknown> | null,
  ): Promise<Record<string, unknown>> {
    const [source, _scriptPath, _name] = this._resolveScript(script);
    const ast = parse(source);

    const scriptVars =
      vars !== null && vars !== undefined ? loadJson(vars) : {};
    const prevResult =
      prev !== null && prev !== undefined ? loadJson(prev) : null;

    return runScript(
      ast,
      scriptVars,
      prevResult,
      undefined,
      this._activeExtNames.length > 0 ? this._activeExtNames : undefined,
      this._extensionPaths.length > 0 ? this._extensionPaths : undefined,
      this._config.executor.user_agent,
      this._config as unknown as Record<string, unknown>,
    );
  }

  // ── Internal ────────────────────────────────────────────────────

  private _resolveScript(
    script: string,
  ): [string, string | null, string | null] {
    // 1. Explicit .lace path
    if (script.trimEnd().endsWith(".lace")) {
      const content = fs.readFileSync(script, "utf-8");
      return [content, path.resolve(script), null];
    }

    // 2. Name-based lookup: {root}/scripts/{name}/{name}.lace
    if (this._root) {
      const candidate = path.join(
        this._root,
        "scripts",
        script,
        `${script}.lace`,
      );
      if (fs.existsSync(candidate)) {
        const content = fs.readFileSync(candidate, "utf-8");
        return [content, path.resolve(candidate), script];
      }
    }

    // 3. Existing file on disk
    if (fs.existsSync(script)) {
      const content = fs.readFileSync(script, "utf-8");
      return [content, path.resolve(script), null];
    }

    // 4. Inline source
    return [script, null, null];
  }
}
