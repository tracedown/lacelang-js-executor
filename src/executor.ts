/**
 * Spec-compliant Lace runtime executor.
 *
 * Implements lace-spec.md §7 (Failure Semantics), §9 (ProbeResult wire
 * format), §3.2 (redirects), §3.3 (cookie jars), §3.4 (Response Object),
 * §4.1–4.8 (chain methods).
 *
 * Covers the full core spec: variable resolution ($var, $$var), string
 * interpolation, all HTTP methods, redirect following, TLS verification,
 * timeout handling (fail/warn/retry), cookie jars (all modes), scope
 * evaluation (.expect/.check), custom assertions (.assert), store with
 * run-scope/writeback distinction ($var write-back), .wait, failure
 * cascade, per-phase timing, body storage, and schema() validation.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const __version__ = "0.1.0";
import {
  type HttpResult,
  sendRequest,
  probeTlsVerify,
} from "./http-timing.js";
import { ExtensionRegistry } from "./laceext/registry.js";

// Validator imports — the validator package may not yet have all exports.
// We use dynamic typing to avoid build failures during early development.
// Once @lacelang/validator exports these, switch to direct imports.
let fmtExpr: (node: unknown) => string;
try {
  const mod = await import("@lacelang/validator");
  fmtExpr = (mod as Record<string, unknown>).fmt as typeof fmtExpr;
} catch {
  fmtExpr = (_node: unknown) => "<expr>";
}

// ─── Bundled extension mapping ────────────────────────────────────────

export const BUILTIN_EXTENSIONS: Record<string, string> = {
  // default/ — bundled with every executor
  laceNotifications: "default/laceNotifications/laceNotifications.laceext",
  laceBaseline: "default/laceBaseline/laceBaseline.laceext",
  // test/ — conformance suite only
  notifCounter: "test/notifCounter/notifCounter.laceext",
  notifWatch: "test/notifWatch/notifWatch.laceext",
  notifRelay: "test/notifRelay/notifRelay.laceext",
  hookTrace: "test/hookTrace/hookTrace.laceext",
  badNamespace: "test/badNamespace/badNamespace.laceext",
  configDemo: "test/configDemo/configDemo.laceext",
};

// ─── Variable interpolation regex ─────────────────────────────────────
// Groups: 1=${$$runvar}, 2=${$scriptvar}, 3=$$runvar, 4=$scriptvar
const INTERP_RE =
  /\$\{(\$\$[a-zA-Z_][a-zA-Z0-9_]*)\}|\$\{(\$[a-zA-Z_][a-zA-Z0-9_]*)\}|\$\$([a-zA-Z_][a-zA-Z0-9_]*)|\$([a-zA-Z_][a-zA-Z0-9_]*)/g;

// ─── Constants ────────────────────────────────────────────────────────

const DEFAULT_USER_AGENT = `lace-probe/${__version__} (lacelang-js)`;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_TIMEOUT_ACTION = "fail";
const DEFAULT_TIMEOUT_RETRIES = 0;
const DEFAULT_REJECT_INVALID_CERTS = true;
const DEFAULT_FOLLOW_REDIRECTS = true;

// ─── MIME → extension map ────────────────────────────────────────────

const MIME_EXT: Record<string, string> = {
  "application/json": ".json",
  "application/ld+json": ".json",
  "application/problem+json": ".json",
  "text/html": ".html",
  "application/xhtml+xml": ".html",
  "text/xml": ".xml",
  "application/xml": ".xml",
  "text/plain": ".txt",
  "text/css": ".css",
  "text/javascript": ".js",
  "application/javascript": ".js",
  "text/csv": ".csv",
  "application/x-www-form-urlencoded": ".form",
  "application/pdf": ".pdf",
  "application/zip": ".zip",
  "application/gzip": ".gz",
  "application/octet-stream": ".bin",
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
  "image/x-icon": ".ico",
};

// ─── Size regex ──────────────────────────────────────────────────────

const SIZE_RE = /^(\d+)(k|kb|m|mb|g|gb)?$/i;

// ─── Default scope operators ─────────────────────────────────────────

const DEFAULT_OP: Record<string, string> = {
  status: "eq",
  body: "eq",
  headers: "eq",
  size: "eq",
  bodySize: "lt",
  totalDelayMs: "lt",
  dns: "lt",
  connect: "lt",
  tls: "lt",
  ttfb: "lt",
  transfer: "lt",
};

const SCOPE_ACTUAL_KEY: Record<string, string> = {
  status: "status",
  body: "body",
  headers: "headers",
  bodySize: "sizeBytes",
  totalDelayMs: "responseTimeMs",
  dns: "dnsMs",
  connect: "connectMs",
  tls: "tlsMs",
  ttfb: "ttfbMs",
  transfer: "transferMs",
  size: "sizeBytes",
};

// ═══════════════════════════════════════════════════════════════════
// Runtime state
// ═══════════════════════════════════════════════════════════════════

export class Env {
  scriptVars: Record<string, unknown>;
  runVars: Record<string, unknown>;
  prev: Record<string, unknown>;
  this_: Record<string, unknown> | null;
  bodiesDir: string;
  cookieJars: Record<string, Record<string, string>>;
  registry: ExtensionRegistry;
  tagCtors: Record<string, (args: unknown[]) => unknown>;
  userAgent: string;
  defaultMaxRedirects: number;

  constructor(
    scriptVars: Record<string, unknown>,
    prev: Record<string, unknown> | null,
    bodiesDir: string,
    registry: ExtensionRegistry,
    userAgent?: string,
  ) {
    this.scriptVars = scriptVars;
    this.runVars = {};
    this.prev = prev || {};
    this.this_ = null;
    this.bodiesDir = bodiesDir;
    this.cookieJars = { __default__: {} };
    this.registry = registry;
    this.tagCtors = registry.tagConstructors();
    this.userAgent = userAgent || DEFAULT_USER_AGENT;
    this.defaultMaxRedirects = 10;
  }
}

// ═══════════════════════════════════════════════════════════════════
// Public entry point
// ═══════════════════════════════════════════════════════════════════

export async function runScript(
  ast: Record<string, unknown>,
  scriptVars?: Record<string, unknown> | null,
  prev?: Record<string, unknown> | null,
  bodiesDir?: string | null,
  activeExtensions?: string[] | null,
  extensionPaths?: string[] | null,
  userAgent?: string | null,
  config?: Record<string, unknown> | null,
): Promise<Record<string, unknown>> {
  // Resolve bodies dir: explicit arg > config result.bodies.dir > env default.
  let dir: string;
  if (bodiesDir) {
    dir = bodiesDir;
  } else if (config && typeof (config as Record<string, unknown>).result === "object") {
    const result = (config as Record<string, unknown>).result as Record<string, unknown>;
    const bodies = result?.bodies as Record<string, unknown> | undefined;
    const cfgDir = bodies?.dir;
    dir =
      typeof cfgDir === "string" && cfgDir
        ? cfgDir
        : defaultBodiesDir();
  } else {
    dir = defaultBodiesDir();
  }
  fs.mkdirSync(dir, { recursive: true });

  // Forward [extensions] subtree of lace.config so each rule's config
  // base sees per-extension settings.
  const extCfg =
    (config as Record<string, unknown>)?.extensions as Record<string, unknown> ?? {};
  const registry = loadExtensions(
    activeExtensions || [],
    extensionPaths || [],
    extCfg,
  );
  const env = new Env(
    scriptVars || {},
    prev ?? null,
    dir,
    registry,
    userAgent ?? undefined,
  );
  env.defaultMaxRedirects = defaultMaxRedirectsFrom(config ?? null);
  const startedAt = nowIso();
  const startedMono = performance.now();

  const scriptCalls = (ast.calls as Record<string, unknown>[]) || [];

  // Fire "on before script" hook
  registry.fireHook("before script", {
    script: {
      callCount: scriptCalls.length,
      startedAt,
    },
    prev: prev ?? null,
  });

  const calls: Record<string, unknown>[] = [];
  const writeback: Record<string, unknown> = {};
  let overall = "success";
  let cascadeOutcome: string | null = null;

  for (let i = 0; i < scriptCalls.length; i++) {
    const call = scriptCalls[i];
    if (cascadeOutcome !== null) {
      calls.push(skippedRecord(i));
      continue;
    }

    const record = await runCall(call, i, env, writeback);
    calls.push(record);

    const callAction =
      ((record.config as Record<string, unknown>)?.timeout as Record<string, unknown>)?.action as string ??
      DEFAULT_TIMEOUT_ACTION;
    if (record.outcome === "failure") {
      cascadeOutcome = "failure";
      overall = "failure";
    } else if (record.outcome === "timeout" && callAction !== "warn") {
      cascadeOutcome = "timeout";
      overall = "timeout";
    }

    const chain = (call as Record<string, unknown>).chain as Record<string, unknown> | undefined;
    const wait = chain?.wait;
    if (typeof wait === "number" && wait > 0 && cascadeOutcome === null) {
      await sleep(wait);
    }
  }

  const endedAt = nowIso();
  const elapsedMs = Math.round(performance.now() - startedMono);

  const actions: Record<string, unknown> = {};
  if (Object.keys(writeback).length > 0) {
    actions.variables = writeback;
  }
  for (const [key, events] of Object.entries(registry.actions)) {
    actions[key] = events;
  }

  let mergedRunVars: Record<string, unknown> = { ...env.runVars };
  Object.assign(mergedRunVars, registry.extRunVars);

  // Fire "on script" hook
  registry.fireHook("script", {
    script: {
      callCount: scriptCalls.length,
      startedAt,
      endedAt,
    },
    result: {
      outcome: overall,
      calls,
      runVars: mergedRunVars,
      actions,
    },
    prev: prev ?? null,
  });

  // Re-merge any emits from the "on script" hook
  for (const [key, events] of Object.entries(registry.actions)) {
    actions[key] = events;
  }
  mergedRunVars = { ...env.runVars };
  Object.assign(mergedRunVars, registry.extRunVars);

  return {
    outcome: overall,
    startedAt,
    endedAt,
    elapsedMs,
    runVars: mergedRunVars,
    calls,
    actions,
  };
}

function loadExtensions(
  names: string[],
  paths: string[],
  extensionConfig?: Record<string, unknown>,
): ExtensionRegistry {
  const reg = new ExtensionRegistry(extensionConfig);
  for (const name of names) {
    if (!(name in BUILTIN_EXTENSIONS)) {
      throw new Error(`unknown builtin extension: '${name}'`);
    }
    reg.load(builtinPath(BUILTIN_EXTENSIONS[name]));
  }
  for (const p of paths) {
    reg.load(p);
  }
  reg.finalize();
  return reg;
}

function builtinPath(filename: string): string {
  const name = filename.replace(/\.laceext$/, "");
  // Resolve relative to this module's location
  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  const subdir = path.join(thisDir, "extensions", name, filename);
  if (fs.existsSync(subdir)) {
    return subdir;
  }
  return path.join(thisDir, "extensions", filename);
}

// ═══════════════════════════════════════════════════════════════════
// Per-call execution
// ═══════════════════════════════════════════════════════════════════

async function runCall(
  call: Record<string, unknown>,
  idx: number,
  env: Env,
  writeback: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const callStarted = nowIso();
  const cfg = (call.config as Record<string, unknown>) || {};
  const method = call.method as string;

  const resolvedCfg = resolveCallConfig(cfg, env);

  // Fire "on before call"
  env.registry.fireHook("before call", {
    call: { index: idx, config: resolvedCfg },
    prev: env.prev,
  });

  const warnings: string[] = [];

  const url = interp(call.url as string, env, warnings);
  const headers: Record<string, string> = {};
  const cfgHeaders = (cfg.headers as Record<string, unknown>) || {};
  for (const [k, v] of Object.entries(cfgHeaders)) {
    headers[toHeaderName(k)] = interpHeaderValue(v, env, warnings);
  }

  const [bodyBytes, bodyCt] = resolveBody(
    cfg.body as Record<string, unknown> | undefined,
    env,
    warnings,
  );
  if (bodyCt && !Object.keys(headers).some((k) => k.toLowerCase() === "content-type")) {
    headers["Content-Type"] = bodyCt;
  }

  // User-Agent: script-set wins, otherwise env.userAgent
  if (!Object.keys(headers).some((k) => k.toLowerCase() === "user-agent")) {
    headers["User-Agent"] = env.userAgent;
  }

  // Apply cookie jar
  const activeJar = applyCookiesToRequest(cfg, env, url, headers);

  // Timeout + retries
  const [timeoutS, action, retries] = resolveTimeout(cfg);

  // TLS verification
  const verify = (resolvedCfg.security as Record<string, unknown>)
    ?.rejectInvalidCerts as boolean;
  if (!verify && url.startsWith("https://")) {
    try {
      await probeTlsVerify(url, timeoutS);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      warnings.push(
        `TLS certificate invalid: ${msg}; proceeding with rejectInvalidCerts=false`,
      );
    }
  }

  // Redirect policy
  const follow = (resolvedCfg.redirects as Record<string, unknown>)
    ?.follow as boolean;
  const maxRedirects = Number(
    (resolvedCfg.redirects as Record<string, unknown>)?.max,
  );

  // Write request body to file
  const requestCt = headers["Content-Type"] || bodyCt;
  const requestBodyPath = writeBodyFile(
    env,
    bodyBytes,
    true,
    requestCt ?? undefined,
    idx,
  );

  // Issue request with redirects + retries
  const { result: httpResult, finalUrl, hops: redirectHops, redirectExceeded } =
    await issueWithRedirectsAndRetries(
      method.toUpperCase(),
      url,
      headers,
      bodyBytes,
      timeoutS,
      verify,
      follow,
      maxRedirects,
      retries > 0 && action === "retry" ? retries : 0,
      activeJar,
      env,
    );

  // Build request record
  const requestRec: Record<string, unknown> = {
    url,
    method,
    headers,
    bodyPath: requestBodyPath,
  };

  // Redirect list: every hop after the initial URL
  const redirectsList: string[] =
    redirectHops.length > 1 ? redirectHops.slice(1) : [];

  let callOutcome = "success";
  let responseRec: Record<string, unknown> | null = null;
  let error: string | null = null;

  if (httpResult.timedOut) {
    callOutcome = "timeout";
    error = action === "warn" ? null : httpResult.error;
  } else if (httpResult.error !== null) {
    callOutcome = "failure";
    error = httpResult.error;
  } else if (httpResult.response === null) {
    callOutcome = "failure";
    error = "no response and no error — internal inconsistency";
  } else if (redirectExceeded) {
    callOutcome = "failure";
    error = `redirect limit ${maxRedirects} exceeded`;
  } else {
    // Success path
    const resp = httpResult.response;
    const respCtRaw = resp.headers["content-type"];
    const respCt: string | undefined = typeof respCtRaw === "string"
      ? respCtRaw
      : Array.isArray(respCtRaw) && respCtRaw.length > 0
        ? respCtRaw[0]
        : undefined;

    const chain = (call as Record<string, unknown>).chain as Record<string, unknown> | undefined;
    const bodyCap = bodyCaptureLimit(chain || {}, env);
    const bodyTooLarge =
      bodyCap !== null && resp.body.length > bodyCap;
    let bodyPath: string | null = null;
    if (!bodyTooLarge) {
      bodyPath = writeBodyFile(env, resp.body, false, respCt, idx);
    }

    responseRec = buildResponseRec(resp, bodyPath);
    if (bodyTooLarge) {
      responseRec.bodyNotCapturedReason = "bodyTooLarge";
    } else if (bodyPath === null) {
      responseRec.bodyNotCapturedReason = "notRequested";
    }

    absorbResponseCookies(activeJar, env, resp.headers);
    env.this_ = buildThis(resp, responseRec, redirectsList);
  }

  // Evaluate chain — .expect / .check / .assert / .store
  let assertions: Record<string, unknown>[] = [];
  let scopeHardFail = false;
  const chain = (call as Record<string, unknown>).chain as Record<string, unknown> | undefined;

  if (responseRec !== null) {
    const [sf, recs] = evaluateScopeBlocks(chain || {}, env, responseRec, idx);
    scopeHardFail = sf;
    assertions = recs;

    const [condHardFail, condAsserts] = evaluateAssertBlock(chain || {}, env, idx);
    assertions.push(...condAsserts);
    if (condHardFail && !scopeHardFail) {
      scopeHardFail = true;
    }

    if (scopeHardFail) {
      callOutcome = "failure";
    }

    if (!scopeHardFail && chain && "store" in chain) {
      applyStore(
        { ...(chain.store as Record<string, unknown>), __call_index: idx },
        env,
        writeback,
        warnings,
      );
    }
  }

  const record: Record<string, unknown> = {
    index: idx,
    outcome: callOutcome,
    startedAt: callStarted,
    endedAt: nowIso(),
    request: requestRec,
    response: responseRec,
    redirects: redirectsList,
    assertions,
    config: resolvedCfg,
    warnings,
    error,
  };

  // Fire "on call" post-hook — hooks see the full resolved config
  env.registry.fireHook("call", {
    call: {
      index: idx,
      outcome: callOutcome,
      response: responseRec,
      assertions,
      config: resolvedCfg,
    },
    prev: env.prev,
  });

  return record;
}

function skippedRecord(idx: number): Record<string, unknown> {
  return {
    index: idx,
    outcome: "skipped",
    startedAt: null,
    endedAt: null,
    request: null,
    response: null,
    redirects: [],
    assertions: [],
    config: {},
    warnings: [],
    error: null,
  };
}

// ═══════════════════════════════════════════════════════════════════
// Request dispatch (redirects + retries)
// ═══════════════════════════════════════════════════════════════════

interface IssueResult {
  result: HttpResult;
  finalUrl: string;
  hops: string[];
  redirectExceeded: boolean;
}

async function issueWithRedirectsAndRetries(
  method: string,
  url: string,
  headers: Record<string, string>,
  body: Buffer | null,
  timeoutS: number,
  verify: boolean,
  follow: boolean,
  maxRedirects: number,
  retries: number,
  jarName: string = "__default__",
  env?: Env,
): Promise<IssueResult> {
  let attempt = 0;

  while (true) {
    const hops: string[] = [url];
    let curUrl = url;
    let curMethod = method;
    let curBody = body;
    let redirects = 0;
    let r: HttpResult | null = null;

    while (true) {
      r = await sendRequest(curMethod, curUrl, headers, curBody, timeoutS, verify);
      if (r.response === null) {
        break;
      }
      const status = r.response.status;
      if (follow && [301, 302, 303, 307, 308].includes(status)) {
        // Absorb cookies from redirect responses
        if (env) {
          absorbResponseCookies(jarName, env, r.response.headers);
          const jar = env.cookieJars[jarName] || {};
          if (Object.keys(jar).length > 0) {
            headers["Cookie"] = Object.entries(jar)
              .map(([k, v]) => `${k}=${v}`)
              .join("; ");
          }
        }
        if (redirects >= maxRedirects) {
          return { result: r, finalUrl: curUrl, hops, redirectExceeded: true };
        }
        redirects++;
        let loc = r.response.headers["location"];
        if (Array.isArray(loc)) {
          loc = loc[0];
        }
        if (!loc) {
          break;
        }
        curUrl = new URL(loc as string, curUrl).toString();
        hops.push(curUrl);
        if (
          status === 303 ||
          ((status === 301 || status === 302) && curMethod === "POST")
        ) {
          curMethod = "GET";
          curBody = null;
        }
        continue;
      }
      // Final response
      return { result: r, finalUrl: curUrl, hops, redirectExceeded: false };
    }

    // Transport error — possibly retry
    if (r && r.timedOut && attempt < retries) {
      attempt++;
      continue;
    }
    return {
      result: r!,
      finalUrl: curUrl,
      hops,
      redirectExceeded: false,
    };
  }
}

// ═══════════════════════════════════════════════════════════════════
// Body handling
// ═══════════════════════════════════════════════════════════════════

function resolveBody(
  bodyNode: Record<string, unknown> | undefined | null,
  env: Env,
  warnings?: string[],
): [Buffer | null, string | null] {
  if (!bodyNode) {
    return [null, null];
  }
  const t = bodyNode.type as string;
  const v = bodyNode.value;
  if (t === "json") {
    const val = evalExpr(v, env);
    return [Buffer.from(JSON.stringify(val), "utf-8"), "application/json"];
  }
  if (t === "form") {
    const data = evalExpr(v, env);
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      return [Buffer.from("", "utf-8"), "application/x-www-form-urlencoded"];
    }
    const params = new URLSearchParams();
    for (const [fk, fv] of Object.entries(data as Record<string, unknown>)) {
      params.set(fk, stringify(fv));
    }
    return [
      Buffer.from(params.toString(), "utf-8"),
      "application/x-www-form-urlencoded",
    ];
  }
  if (t === "raw") {
    return [
      Buffer.from(interp(v as string, env, warnings ?? null), "utf-8"),
      null,
    ];
  }
  return [null, null];
}

function writeBodyFile(
  env: Env,
  body: Buffer | null,
  request: boolean,
  contentType?: string,
  callIndex: number = 0,
): string | null {
  if (body === null || body.length === 0) {
    return null;
  }
  const kind = request ? "request" : "response";
  const ext = extForContentType(contentType ?? null);
  const name = `call_${callIndex}_${kind}${ext}`;
  const filePath = path.join(env.bodiesDir, name);
  fs.writeFileSync(filePath, body);
  return filePath;
}

function extForContentType(ct: string | null): string {
  if (!ct) {
    return ".bin";
  }
  const base = ct.split(";")[0].trim().toLowerCase();
  if (base in MIME_EXT) {
    return MIME_EXT[base];
  }
  // Structured suffixes (RFC 6839)
  if (base.includes("+")) {
    const suffix = "+" + base.split("+")[1];
    const compound: Record<string, string> = {
      "+json": ".json",
      "+xml": ".xml",
      "+yaml": ".yaml",
      "+zip": ".zip",
    };
    if (suffix in compound) {
      return compound[suffix];
    }
  }
  // Fallback
  return ".bin";
}

// ═══════════════════════════════════════════════════════════════════
// Response shaping
// ═══════════════════════════════════════════════════════════════════

function buildResponseRec(
  resp: NonNullable<HttpResult["response"]>,
  bodyPath: string | null,
): Record<string, unknown> {
  const t = resp.timings;
  const dnsObj: Record<string, unknown> = {
    resolvedIps: resp.dns ? [...resp.dns.resolvedIps] : [],
    resolvedIp: resp.dns ? resp.dns.resolvedIp : null,
  };
  let tlsObj: Record<string, unknown> | null = null;
  if (resp.tls !== null) {
    tlsObj = {
      protocol: resp.tls.protocol,
      cipher: resp.tls.cipher,
      alpn: resp.tls.alpn,
      certificate: resp.tls.certificate,
    };
  }
  return {
    status: resp.status,
    statusText: resp.statusText,
    headers: lowerHeaders(resp.headers),
    bodyPath,
    responseTimeMs: t.responseTimeMs,
    dnsMs: t.dnsMs,
    connectMs: t.connectMs,
    tlsMs: t.tlsMs,
    ttfbMs: t.ttfbMs,
    transferMs: t.transferMs,
    sizeBytes: resp.body.length,
    dns: dnsObj,
    tls: tlsObj,
  };
}

function lowerHeaders(
  h: Record<string, string | string[]>,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(h)) {
    out[k.toLowerCase()] = v;
  }
  return out;
}

function buildThis(
  resp: NonNullable<HttpResult["response"]>,
  rec: Record<string, unknown>,
  redirects: string[],
): Record<string, unknown> {
  let ctype = "";
  for (const [k, v] of Object.entries(resp.headers)) {
    if (k.toLowerCase() === "content-type") {
      ctype = typeof v === "string" ? v : Array.isArray(v) && v.length > 0 ? v[0] : "";
      break;
    }
  }

  let decoded: string | null = null;
  try {
    decoded = resp.body.toString("utf-8");
  } catch {
    decoded = null;
  }

  let body: unknown = decoded;
  if (decoded !== null && ctype.toLowerCase().includes("application/json")) {
    try {
      body = JSON.parse(decoded);
    } catch {
      body = decoded;
    }
  }

  return {
    status: rec.status,
    statusText: rec.statusText,
    headers: rec.headers,
    body,
    size: rec.sizeBytes,
    redirects,
    responseTime: rec.responseTimeMs,
    responseTimeMs: rec.responseTimeMs,
    totalDelayMs: rec.responseTimeMs,
    connect: rec.connectMs,
    ttfb: rec.ttfbMs,
    transfer: rec.transferMs,
    dns: rec.dns,
    tls: rec.tls,
    dnsMs: rec.dnsMs,
    tlsMs: rec.tlsMs,
  };
}

// ═══════════════════════════════════════════════════════════════════
// Cookie jar handling
// ═══════════════════════════════════════════════════════════════════

function applyCookiesToRequest(
  cfg: Record<string, unknown>,
  env: Env,
  _url: string,
  headers: Record<string, string>,
): string {
  const jarSpec = (cfg.cookieJar as string) ?? "inherit";
  const clearCookies = (cfg.clearCookies as string[]) ?? [];
  const [jarName, fresh, selective, clearList] = resolveJarSpec(
    jarSpec,
    clearCookies,
  );

  if (fresh) {
    env.cookieJars[jarName] = {};
  } else if (selective) {
    const jar = (env.cookieJars[jarName] ??= {});
    for (const c of clearList) {
      delete jar[c];
    }
  } else {
    env.cookieJars[jarName] ??= {};
  }

  // Static per-request cookies from cfg.cookies
  const staticCookies: Record<string, string> = {};
  const cfgCookies = (cfg.cookies as Record<string, unknown>) || {};
  for (const [name, expr] of Object.entries(cfgCookies)) {
    staticCookies[name] = stringify(evalExpr(expr, env));
  }

  const combined = { ...env.cookieJars[jarName], ...staticCookies };
  if (Object.keys(combined).length > 0) {
    headers["Cookie"] = Object.entries(combined)
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
  }
  return jarName;
}

function resolveJarSpec(
  spec: string,
  clearList: string[],
): [string, boolean, boolean, string[]] {
  if (spec === "inherit") return ["__default__", false, false, []];
  if (spec === "fresh") return ["__default__", true, false, []];
  if (spec === "selective_clear")
    return ["__default__", false, true, clearList];
  if (spec.startsWith("named:"))
    return [spec.slice("named:".length), false, false, []];
  if (spec.endsWith(":selective_clear"))
    return [
      spec.slice(0, -":selective_clear".length),
      false,
      true,
      clearList,
    ];
  return ["__default__", false, false, []];
}

function absorbResponseCookies(
  jarName: string,
  env: Env,
  headers: Record<string, string | string[]>,
): void {
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() !== "set-cookie") continue;
    const values = Array.isArray(v) ? v : [v];
    for (const raw of values) {
      // Simple Set-Cookie parser: extract name=value from the first segment
      const eqIdx = raw.indexOf("=");
      if (eqIdx < 0) continue;
      const cookieName = raw.slice(0, eqIdx).trim();
      const rest = raw.slice(eqIdx + 1);
      const semiIdx = rest.indexOf(";");
      const cookieValue = semiIdx >= 0 ? rest.slice(0, semiIdx).trim() : rest.trim();
      if (cookieName) {
        (env.cookieJars[jarName] ??= {})[cookieName] = cookieValue;
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// Timeout / retries
// ═══════════════════════════════════════════════════════════════════

function resolveTimeout(cfg: Record<string, unknown>): [number, string, number] {
  const t = (cfg.timeout as Record<string, unknown>) || {};
  const ms = Number(t.ms ?? DEFAULT_TIMEOUT_MS);
  const action = (t.action as string) ?? DEFAULT_TIMEOUT_ACTION;
  const retries =
    action === "retry" ? Number(t.retries ?? DEFAULT_TIMEOUT_RETRIES) : 0;
  return [ms / 1000.0, action, retries];
}

function resolveCallConfig(
  cfg: Record<string, unknown>,
  env: Env,
): Record<string, unknown> {
  const resolved = resolveNode(cfg, env) as Record<string, unknown>;

  // Timeout defaults (§3.2)
  let timeoutSection =
    typeof resolved.timeout === "object" && resolved.timeout !== null
      ? { ...(resolved.timeout as Record<string, unknown>) }
      : {};
  if (timeoutSection.ms === undefined) timeoutSection.ms = DEFAULT_TIMEOUT_MS;
  if (timeoutSection.action === undefined)
    timeoutSection.action = DEFAULT_TIMEOUT_ACTION;
  if (timeoutSection.retries === undefined)
    timeoutSection.retries = DEFAULT_TIMEOUT_RETRIES;
  resolved.timeout = timeoutSection;

  // Redirect defaults (§3.2, §11)
  let redirectSection =
    typeof resolved.redirects === "object" && resolved.redirects !== null
      ? { ...(resolved.redirects as Record<string, unknown>) }
      : {};
  if (redirectSection.follow === undefined)
    redirectSection.follow = DEFAULT_FOLLOW_REDIRECTS;
  if (redirectSection.max === undefined)
    redirectSection.max = env.defaultMaxRedirects;
  resolved.redirects = redirectSection;

  // Security defaults (§3.2)
  let securitySection =
    typeof resolved.security === "object" && resolved.security !== null
      ? { ...(resolved.security as Record<string, unknown>) }
      : {};
  if (securitySection.rejectInvalidCerts === undefined)
    securitySection.rejectInvalidCerts = DEFAULT_REJECT_INVALID_CERTS;
  resolved.security = securitySection;

  return resolved;
}

// ═══════════════════════════════════════════════════════════════════
// Scope / assertion evaluation (AssertionRecord shape)
// ═══════════════════════════════════════════════════════════════════

function evaluateScopeBlocks(
  chain: Record<string, unknown>,
  env: Env,
  response: Record<string, unknown>,
  callIndex: number,
): [boolean, Record<string, unknown>[]] {
  let hardFail = false;
  const records: Record<string, unknown>[] = [];

  for (const method of ["expect", "check"] as const) {
    const block = chain[method] as Record<string, unknown> | undefined;
    if (!block) continue;

    for (const field of Object.keys(block).filter((k) => !k.startsWith("__"))) {
      // Skip TLS scope when no TLS phase (plain HTTP)
      if (field === "tls" && ((env.this_ || {}) as Record<string, unknown>).tlsMs === 0) {
        continue;
      }

      const sv = (block as Record<string, Record<string, unknown>>)[field];
      const expected = evalExpr(sv.value, env);
      const op = (sv.op as string) || DEFAULT_OP[field] || "eq";
      const matchSel = sv.match as string | undefined;
      const resolvedOptions = resolveOptions(
        sv.options as Record<string, unknown> | undefined,
        env,
      );

      // Fire "on before {method}" hook
      fireScopeHook(
        env,
        `before ${method}`,
        callIndex,
        field,
        expected,
        op,
        resolvedOptions,
        null,
        null,
      );

      const mode = sv.mode as string | undefined;
      const [actual, outcome] = evaluateScope(
        field,
        op,
        expected,
        env,
        response,
        matchSel ?? null,
        mode ?? null,
      );

      const rec: Record<string, unknown> = {
        method,
        scope: field,
        op,
        outcome,
        actual: jsonable(actual),
        expected: jsonable(expected),
        options: resolvedOptions || null,
      };
      if (field === "redirects") {
        rec.match = matchSel || "any";
      }
      records.push(rec);

      // Fire "on {method}" post-hook
      fireScopeHook(
        env,
        method,
        callIndex,
        field,
        expected,
        op,
        resolvedOptions,
        actual,
        outcome,
      );

      if (outcome === "failed" && method === "expect") {
        hardFail = true;
      }
    }
  }
  return [hardFail, records];
}

function fireScopeHook(
  env: Env,
  hook: string,
  callIndex: number,
  scopeName: string,
  expected: unknown,
  op: string,
  options: Record<string, unknown> | null,
  actual: unknown,
  outcome: string | null,
): void {
  const scopeCtx: Record<string, unknown> = {
    name: scopeName,
    value: expected,
    op,
    options,
  };
  if (outcome !== null) {
    scopeCtx.actual = actual;
    scopeCtx.outcome = outcome;
  }
  env.registry.fireHook(hook, {
    call: { index: callIndex },
    scope: scopeCtx,
    this: env.this_,
    prev: env.prev,
  });
}

function resolveOptions(
  options: Record<string, unknown> | undefined | null,
  env: Env,
): Record<string, unknown> | null {
  if (!options) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(options)) {
    out[k] = evalExpr(v, env);
  }
  return out;
}

function evaluateScope(
  field: string,
  op: string,
  expected: unknown,
  env: Env,
  response: Record<string, unknown>,
  matchSel: string | null,
  mode: string | null,
): [unknown, string] {
  if (field === "redirects") {
    const redirects: string[] =
      ((env.this_ || {}) as Record<string, unknown>).redirects as string[] || [];
    const sel = matchSel || "any";
    if (sel === "any") {
      const passed = redirects.includes(expected as string);
      return [redirects, passed ? "passed" : "failed"];
    }
    if (sel === "first") {
      const actual = redirects.length > 0 ? redirects[0] : null;
      return [actual, actual === expected ? "passed" : "failed"];
    }
    if (sel === "last") {
      const actual =
        redirects.length > 0 ? redirects[redirects.length - 1] : null;
      return [actual, actual === expected ? "passed" : "failed"];
    }
    return [redirects, "indeterminate"];
  }

  let actual = resolveScopeActual(field, env, response);
  let exp = expected;

  // bodySize scope accepts human size strings
  if (field === "bodySize" && typeof exp === "string") {
    exp = parseSize(exp);
  }

  // body: schema($var)
  if (
    field === "body" &&
    typeof exp === "object" &&
    exp !== null &&
    (exp as Record<string, unknown>).__lace_schema__
  ) {
    const schemaDoc = (exp as Record<string, unknown>).schema;
    if (schemaDoc === null || schemaDoc === undefined) {
      return [actual, "failed"];
    }
    const strict = mode === "strict";
    return [actual, validateSchema(actual, schemaDoc, "", strict)];
  }

  return [actual, applyOp(op, actual, exp)];
}

export function validateSchema(
  body: unknown,
  schema: unknown,
  _path: string = "",
  strict: boolean = false,
): string {
  if (body === null && schema !== null) {
    return "failed";
  }
  if (typeof schema !== "object" || schema === null) {
    return "indeterminate";
  }
  const s = schema as Record<string, unknown>;
  const t = s.type;

  const typeCheck: Record<string, (v: unknown) => boolean> = {
    string: (v) => typeof v === "string",
    integer: (v) => typeof v === "number" && Number.isInteger(v) && !isBool(v),
    number: (v) => typeof v === "number" && !isBool(v),
    boolean: (v) => typeof v === "boolean",
    object: (v) => typeof v === "object" && v !== null && !Array.isArray(v),
    array: (v) => Array.isArray(v),
    null: (v) => v === null,
  };

  if (t) {
    const types = Array.isArray(t) ? t as string[] : [t as string];
    if (!types.some((tt) => typeCheck[tt]?.(body))) {
      return "failed";
    }
  }

  if (s.enum !== undefined && !(s.enum as unknown[]).includes(body)) {
    return "failed";
  }

  if (typeof body === "object" && body !== null && !Array.isArray(body)) {
    const obj = body as Record<string, unknown>;
    const required = (s.required as string[]) || [];
    for (const req of required) {
      if (!(req in obj)) {
        return "failed";
      }
    }
    const declared = (s.properties as Record<string, unknown>) || {};
    if (strict && Object.keys(declared).length > 0) {
      const extra = Object.keys(obj).filter((k) => !(k in declared));
      if (extra.length > 0) {
        return "failed";
      }
    }
    for (const [k, sub] of Object.entries(declared)) {
      if (k in obj) {
        const childPath = _path ? `${_path}.${k}` : `.${k}`;
        const out = validateSchema(obj[k], sub, childPath, strict);
        if (out !== "passed") return out;
      }
    }
  }

  if (Array.isArray(body)) {
    const items = s.items;
    if (typeof items === "object" && items !== null) {
      for (let idx = 0; idx < body.length; idx++) {
        const childPath = `${_path}[${idx}]`;
        const out = validateSchema(body[idx], items, childPath, strict);
        if (out !== "passed") return out;
      }
    }
  }

  if (typeof body === "string") {
    const pat = s.pattern;
    if (pat !== undefined) {
      const re = new RegExp(pat as string);
      if (!re.test(body)) {
        return "failed";
      }
    }
  }

  return "passed";
}

function isBool(v: unknown): boolean {
  return typeof v === "boolean";
}

function bodyCaptureLimit(
  chain: Record<string, unknown>,
  env: Env,
): number | null {
  for (const method of ["expect", "check"]) {
    const block = (chain[method] as Record<string, unknown>) || {};
    const sv = (block as Record<string, Record<string, unknown>>).bodySize;
    if (!sv) continue;
    let expected = evalExpr(sv.value, env);
    if (typeof expected === "string") {
      expected = parseSize(expected);
    }
    if (typeof expected === "number") {
      return Math.floor(expected);
    }
  }
  return null;
}

export function parseSize(s: string): number | string {
  if (typeof s !== "string") return s;
  const m = s.trim().match(SIZE_RE);
  if (!m) return s;
  const num = parseInt(m[1], 10);
  const suf = (m[2] || "").toUpperCase();
  const multipliers: Record<string, number> = {
    "": 1,
    K: 1024,
    KB: 1024,
    M: 1024 ** 2,
    MB: 1024 ** 2,
    G: 1024 ** 3,
    GB: 1024 ** 3,
  };
  return num * (multipliers[suf] ?? 1);
}

function resolveScopeActual(
  field: string,
  env: Env,
  response: Record<string, unknown>,
): unknown {
  const key = SCOPE_ACTUAL_KEY[field];
  if (key === "body") {
    return (env.this_ || ({} as Record<string, unknown>)).body;
  }
  if (key === "headers") {
    return response.headers;
  }
  if (key === undefined) {
    return null;
  }
  return response[key];
}

function evaluateAssertBlock(
  chain: Record<string, unknown>,
  env: Env,
  callIndex: number,
): [boolean, Record<string, unknown>[]] {
  let hardFail = false;
  const records: Record<string, unknown>[] = [];

  const block = chain.assert as Record<string, unknown> | undefined;
  if (!block) return [false, records];

  for (const kind of ["expect", "check"]) {
    const items =
      (block[kind] as Record<string, unknown>[]) || [];
    for (let idx = 0; idx < items.length; idx++) {
      const item = items[idx];
      const cond = item.condition;
      const expressionSrc = fmtExpr?.(cond) ?? "<expr>";
      const resolvedOptions = resolveOptions(
        item.options as Record<string, unknown> | undefined,
        env,
      );

      fireAssertHook(
        env,
        "before assert",
        callIndex,
        idx,
        kind,
        expressionSrc,
        resolvedOptions,
        null,
        null,
        null,
      );

      const [lhsNode, rhsNode] = splitOperands(cond);
      const actualLhs = lhsNode !== null ? evalExpr(lhsNode, env) : null;
      const actualRhs = rhsNode !== null ? evalExpr(rhsNode, env) : null;

      const opName =
        typeof cond === "object" && cond !== null
          ? (cond as Record<string, unknown>).op
          : null;
      const INDETERMINATE_OPS = [
        "lt",
        "lte",
        "gt",
        "gte",
        "add",
        "sub",
        "mul",
        "div",
        "mod",
      ];
      let outcome: string;
      if (
        typeof opName === "string" &&
        INDETERMINATE_OPS.includes(opName) &&
        (actualLhs === null || actualRhs === null)
      ) {
        outcome = "indeterminate";
      } else {
        const result = evalExpr(cond, env);
        outcome = isTruthy(result) ? "passed" : "failed";
      }

      const rec: Record<string, unknown> = {
        method: "assert",
        kind,
        index: idx,
        outcome,
        expression: expressionSrc,
        actualLhs: jsonable(actualLhs),
        actualRhs: jsonable(actualRhs),
        options: resolvedOptions || null,
      };
      records.push(rec);

      fireAssertHook(
        env,
        "assert",
        callIndex,
        idx,
        kind,
        expressionSrc,
        resolvedOptions,
        actualLhs,
        actualRhs,
        outcome,
      );

      if (outcome === "failed" && kind === "expect") {
        hardFail = true;
      }
    }
  }
  return [hardFail, records];
}

function fireAssertHook(
  env: Env,
  hook: string,
  callIndex: number,
  index: number,
  kind: string,
  expressionSrc: string,
  options: Record<string, unknown> | null,
  actualLhs: unknown,
  actualRhs: unknown,
  outcome: string | null,
): void {
  const condCtx: Record<string, unknown> = {
    index,
    kind,
    expression: expressionSrc,
    options,
  };
  if (outcome !== null) {
    condCtx.actualLhs = actualLhs;
    condCtx.actualRhs = actualRhs;
    condCtx.outcome = outcome;
  }
  env.registry.fireHook(hook, {
    call: { index: callIndex },
    condition: condCtx,
    this: env.this_,
    prev: env.prev,
  });
}

function splitOperands(expr: unknown): [unknown, unknown] {
  if (
    typeof expr === "object" &&
    expr !== null &&
    (expr as Record<string, unknown>).kind === "binary"
  ) {
    return [
      (expr as Record<string, unknown>).left,
      (expr as Record<string, unknown>).right,
    ];
  }
  return [expr, null];
}

function applyOp(op: string, actual: unknown, expected: unknown): string {
  if (Array.isArray(expected)) {
    return expected.some((e) => deepEqual(actual, e)) ? "passed" : "failed";
  }
  if (actual === null || actual === undefined || expected === null || expected === undefined) {
    if (op === "eq" || op === "neq") {
      const eq = actual === expected;
      return (op === "eq" ? eq : !eq) ? "passed" : "failed";
    }
    return "indeterminate";
  }
  try {
    if (op === "eq") return deepEqual(actual, expected) ? "passed" : "failed";
    if (op === "neq") return !deepEqual(actual, expected) ? "passed" : "failed";
    if (op === "lt") return (actual as number) < (expected as number) ? "passed" : "failed";
    if (op === "lte") return (actual as number) <= (expected as number) ? "passed" : "failed";
    if (op === "gt") return (actual as number) > (expected as number) ? "passed" : "failed";
    if (op === "gte") return (actual as number) >= (expected as number) ? "passed" : "failed";
  } catch {
    return "indeterminate";
  }
  return "indeterminate";
}

// ═══════════════════════════════════════════════════════════════════
// .store
// ═══════════════════════════════════════════════════════════════════

function applyStore(
  block: Record<string, unknown>,
  env: Env,
  writeback: Record<string, unknown>,
  warnings: string[],
): void {
  const callIndex = (block.__call_index as number) ?? 0;
  for (const key of Object.keys(block).filter((k) => !k.startsWith("__"))) {
    const entry = block[key] as Record<string, unknown>;
    const scope = entry.scope === "run" ? "run" : "writeback";
    const val = evalExpr(entry.value, env);

    env.registry.fireHook("before store", {
      call: { index: callIndex },
      entry: { key, value: val, scope },
      this: env.this_,
      prev: env.prev,
    });

    let written = true;
    if (entry.scope === "run") {
      const bare = key.startsWith("$$") ? key.slice(2) : key;
      if (bare in env.runVars) {
        warnings.push(
          `run-scope var '${bare}' already assigned; write-once skip`,
        );
        written = false;
      } else {
        env.runVars[bare] = val;
      }
    } else {
      const wbKey = key.startsWith("$") ? key.slice(1) : key;
      writeback[wbKey] = val;
    }

    env.registry.fireHook("store", {
      call: { index: callIndex },
      entry: { key, value: val, scope, written },
      this: env.this_,
      prev: env.prev,
    });
  }
}

// ═══════════════════════════════════════════════════════════════════
// Expression evaluation
// ═══════════════════════════════════════════════════════════════════

export function evalExpr(node: unknown, env: Env): unknown {
  if (typeof node !== "object" || node === null) {
    return node;
  }
  const n = node as Record<string, unknown>;
  const k = n.kind as string;

  if (k === "literal") {
    if (n.valueType === "string") {
      return interp(n.value as string, env);
    }
    return n.value;
  }
  if (k === "scriptVar") {
    return walkVarPath(
      (env.scriptVars as Record<string, unknown>)[n.name as string],
      n.path as Array<Record<string, unknown>> | undefined,
    );
  }
  if (k === "runVar") {
    return walkVarPath(
      (env.runVars as Record<string, unknown>)[n.name as string],
      n.path as Array<Record<string, unknown>> | undefined,
    );
  }
  if (k === "thisRef") {
    return walkPath(env.this_, (n.path as string[]) || []);
  }
  if (k === "prevRef") {
    let cur: unknown = env.prev;
    for (const seg of (n.path as Array<Record<string, unknown>>) || []) {
      if (seg.type === "field") {
        cur =
          typeof cur === "object" && cur !== null
            ? (cur as Record<string, unknown>)[seg.name as string]
            : null;
      } else {
        const i = seg.index as number;
        cur =
          Array.isArray(cur) && i >= 0 && i < cur.length ? cur[i] : null;
      }
    }
    return cur ?? null;
  }
  if (k === "unary") {
    const op = (n.op as string) || "not";
    const v = evalExpr(n.operand, env);
    if (op === "not") {
      return !isTruthy(v);
    }
    if (op === "-") {
      if (typeof v === "number" && typeof v !== "boolean") {
        return -v;
      }
      return null;
    }
    return null;
  }
  if (k === "binary") {
    return evalBinary(n, env);
  }
  if (k === "funcCall") {
    return evalFunc(n, env);
  }
  if (k === "objectLit") {
    const entries = (n.entries as Array<Record<string, unknown>>) || [];
    const out: Record<string, unknown> = {};
    for (const e of entries) {
      out[e.key as string] = evalExpr(e.value, env);
    }
    return out;
  }
  if (k === "arrayLit") {
    return ((n.items as unknown[]) || []).map((i) => evalExpr(i, env));
  }
  return null;
}

function evalBinary(node: Record<string, unknown>, env: Env): unknown {
  const op = node.op as string;

  // Short-circuit: and/or return deciding operand
  if (op === "and") {
    const left = evalExpr(node.left, env);
    return isTruthy(left) ? evalExpr(node.right, env) : left;
  }
  if (op === "or") {
    const left = evalExpr(node.left, env);
    return isTruthy(left) ? left : evalExpr(node.right, env);
  }

  const a = evalExpr(node.left, env);
  const b = evalExpr(node.right, env);

  if (a === null || a === undefined || b === null || b === undefined) {
    if (op === "eq") return deepEqual(a, b);
    if (op === "neq") return !deepEqual(a, b);
    return null;
  }

  try {
    if (op === "eq") return deepEqual(a, b);
    if (op === "neq") return !deepEqual(a, b);
    if (op === "lt") return (a as number) < (b as number);
    if (op === "lte") return (a as number) <= (b as number);
    if (op === "gt") return (a as number) > (b as number);
    if (op === "gte") return (a as number) >= (b as number);
    if (op === "+") {
      // String concat: only if LEFT operand is a string (coerce right).
      // number + string => TypeError (null), matching Python semantics.
      if (typeof a === "string") {
        return String(a) + String(b);
      }
      if (typeof a === "number" && typeof b === "number") {
        return a + b;
      }
      return null;
    }
    if (op === "-") {
      if (typeof a === "number" && typeof b === "number") return a - b;
      return null;
    }
    if (op === "*") {
      if (typeof a === "number" && typeof b === "number") return a * b;
      return null;
    }
    if (op === "/") {
      if (typeof a === "number" && typeof b === "number") {
        if (b === 0) return null;
        return a / b;
      }
      return null;
    }
    if (op === "%") {
      if (typeof a === "number" && typeof b === "number") {
        if (b === 0) return null;
        return a % b;
      }
      return null;
    }
  } catch {
    return null;
  }
  return null;
}

function evalFunc(node: Record<string, unknown>, env: Env): unknown {
  const name = node.name as string;
  const argsNodes = (node.args as unknown[]) || [];

  if (name === "json" || name === "form") {
    return argsNodes.length > 0 ? evalExpr(argsNodes[0], env) : null;
  }
  if (name === "schema") {
    const val = argsNodes.length > 0 ? evalExpr(argsNodes[0], env) : null;
    return { __lace_schema__: true, schema: val };
  }
  // Extension-registered tag constructors
  if (name in env.tagCtors) {
    const args = argsNodes.map((a) => evalExpr(a, env));
    return env.tagCtors[name](args);
  }
  return null;
}

function walkVarPath(
  value: unknown,
  path: Array<Record<string, unknown>> | undefined | null,
): unknown {
  if (!path) return value ?? null;
  let cur: unknown = value;
  for (const seg of path) {
    if (cur === null || cur === undefined) return null;
    if (seg.type === "field") {
      cur =
        typeof cur === "object" && cur !== null && !Array.isArray(cur)
          ? (cur as Record<string, unknown>)[seg.name as string]
          : null;
    } else {
      const i = seg.index as number;
      cur = Array.isArray(cur) && i >= 0 && i < cur.length ? cur[i] : null;
    }
  }
  return cur ?? null;
}

function walkPath(obj: unknown, path: string[]): unknown {
  let cur: unknown = obj;
  for (const p of path) {
    if (typeof cur === "object" && cur !== null && !Array.isArray(cur)) {
      cur = (cur as Record<string, unknown>)[p];
    } else {
      return null;
    }
  }
  return cur ?? null;
}

// ═══════════════════════════════════════════════════════════════════
// String interpolation
// ═══════════════════════════════════════════════════════════════════

function interpHeaderValue(
  v: unknown,
  env: Env,
  warnings: string[],
): string {
  const val = evalExpr(v, env);
  if (val === null || val === undefined) {
    warnings.push('null value interpolated as "null"');
  }
  return stringify(val);
}

export function interp(s: string, env: Env, warnings?: string[] | null): string {
  return s.replace(INTERP_RE, (match, g1, g2, g3, g4) => {
    let val: unknown;
    let name: string;

    if (g1) {
      // ${$$runvar} — strip leading $$
      const varname = g1.slice(2);
      val = env.runVars[varname];
      name = g1;
    } else if (g2) {
      // ${$scriptvar} — strip leading $
      const varname = g2.slice(1);
      val = env.scriptVars[varname];
      name = g2;
    } else if (g3) {
      val = env.runVars[g3];
      name = "$$" + g3;
    } else {
      val = env.scriptVars[g4];
      name = "$" + g4;
    }

    if ((val === null || val === undefined) && warnings) {
      warnings.push(`null variable '${name}' interpolated as "null"`);
    }
    return stringify(val);
  });
}

function stringify(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number" || typeof v === "string") return String(v);
  return JSON.stringify(v);
}

function toHeaderName(s: string): string {
  return s;
}

// ═══════════════════════════════════════════════════════════════════
// Utilities
// ═══════════════════════════════════════════════════════════════════

function nowIso(): string {
  return new Date().toISOString().replace(/(\.\d{3})\d*Z$/, "$1Z");
}

function defaultBodiesDir(): string {
  return (
    process.env.LACE_BODIES_DIR ||
    path.join(os.tmpdir(), "lacelang-bodies")
  );
}

function defaultMaxRedirectsFrom(
  config: Record<string, unknown> | null,
): number {
  if (!config) return 10;
  const executorCfg =
    (config.executor as Record<string, unknown>) || {};
  try {
    return Number(executorCfg.maxRedirects ?? 10);
  } catch {
    return 10;
  }
}

function resolveNode(node: unknown, env: Env): unknown {
  if (typeof node === "object" && node !== null) {
    if (Array.isArray(node)) {
      return node.map((i) => resolveNode(i, env));
    }
    const n = node as Record<string, unknown>;
    if ("kind" in n) {
      return evalExpr(n, env);
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(n)) {
      if (k.startsWith("__")) continue;
      if (k === "extensions" && typeof v === "object" && v !== null && !Array.isArray(v)) {
        // Preserve extensions sub-object structure (spec §3.2)
        const extOut: Record<string, unknown> = {};
        for (const [ek, ev] of Object.entries(v as Record<string, unknown>)) {
          extOut[ek] = resolveNode(ev, env);
        }
        out.extensions = extOut;
        continue;
      }
      out[k] = resolveNode(v, env);
    }
    return out;
  }
  return node;
}

function jsonable(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === "boolean" || typeof v === "number" || typeof v === "string")
    return v;
  if (Array.isArray(v)) return v.map(jsonable);
  if (typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[String(k)] = jsonable(val);
    }
    return out;
  }
  return String(v);
}

function isTruthy(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === "boolean") return v;
  if (v === 0) return false;
  if (v === "") return false;
  return true;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return a === b;
  if (a === undefined || b === undefined) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a === "number" || typeof a === "string" || typeof a === "boolean") {
    return a === b;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const keysA = Object.keys(a as Record<string, unknown>);
    const keysB = Object.keys(b as Record<string, unknown>);
    if (keysA.length !== keysB.length) return false;
    for (const k of keysA) {
      if (!deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
    }
    return true;
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
