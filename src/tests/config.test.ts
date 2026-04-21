/**
 * Config loading and environment overlay tests.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig, ConfigError } from "../config.js";

// -- Helpers ----------------------------------------------------------------

function writeConfig(content: string): string {
  const filePath = path.join(
    os.tmpdir(),
    `lace-test-config-${Date.now()}-${Math.random().toString(36).slice(2)}.config`,
  );
  fs.writeFileSync(filePath, content, "utf-8");
  return filePath;
}

const tempFiles: string[] = [];

function writeTempConfig(content: string): string {
  const p = writeConfig(content);
  tempFiles.push(p);
  return p;
}

afterEach(() => {
  for (const f of tempFiles) {
    try { fs.unlinkSync(f); } catch { /* ignore */ }
  }
  tempFiles.length = 0;
});

// -- Tests ------------------------------------------------------------------

describe("ConfigDefaults", () => {
  it("returns defaults when no file", () => {
    const cfg = loadConfig();
    expect(cfg.executor.maxRedirects).toBe(10);
    expect(cfg.executor.maxTimeoutMs).toBe(300_000);
    expect(cfg.executor.extensions).toEqual([]);
  });
});

describe("ExplicitPath", () => {
  it("loads from explicit path", () => {
    const p = writeTempConfig(`
[executor]
maxRedirects = 5
`);
    const cfg = loadConfig(null, p);
    expect(cfg.executor.maxRedirects).toBe(5);
    expect(cfg.executor.maxTimeoutMs).toBe(300_000); // default
  });

  it("throws when explicit path not found", () => {
    expect(() => loadConfig(null, "/nonexistent/lace.config")).toThrow(ConfigError);
    expect(() => loadConfig(null, "/nonexistent/lace.config")).toThrow(/not found/);
  });
});

describe("EnvOverlay", () => {
  it("applies env overlay", () => {
    const p = writeTempConfig(`
[executor]
maxRedirects = 10
maxTimeoutMs = 300000

[lace.config.staging]
[lace.config.staging.executor]
maxTimeoutMs = 60000
`);
    const cfg = loadConfig(null, p, "staging");
    expect(cfg.executor.maxTimeoutMs).toBe(60000);
    expect(cfg.executor.maxRedirects).toBe(10); // inherited
  });

  it("returns base when env section does not exist", () => {
    const p = writeTempConfig(`
[executor]
maxRedirects = 10
`);
    const cfg = loadConfig(null, p, "nonexistent");
    expect(cfg.executor.maxRedirects).toBe(10);
  });
});

describe("EnvVarSubstitution", () => {
  it("uses fallback when env var not set", () => {
    const p = writeTempConfig(`
[executor]
user_agent = "env:LACE_TEST_UA:fallback-ua"
`);
    const cfg = loadConfig(null, p);
    expect(cfg.executor.user_agent).toBe("fallback-ua");
  });

  it("uses env var when set", () => {
    const p = writeTempConfig(`
[executor]
user_agent = "env:LACE_TEST_UA_12345:fallback-ua"
`);
    process.env.LACE_TEST_UA_12345 = "custom-ua";
    try {
      const cfg = loadConfig(null, p);
      expect(cfg.executor.user_agent).toBe("custom-ua");
    } finally {
      delete process.env.LACE_TEST_UA_12345;
    }
  });

  it("throws when env var unset and no default", () => {
    const p = writeTempConfig(`
[executor]
user_agent = "env:LACE_MISSING_VAR_12345"
`);
    expect(() => loadConfig(null, p)).toThrow(ConfigError);
    expect(() => loadConfig(null, p)).toThrow(/not set/);
  });
});

describe("ExtensionConfig", () => {
  it("forwards extension config", () => {
    const p = writeTempConfig(`
[executor]
extensions = ["laceNotifications"]

[extensions.laceNotifications]
level = "all"
`);
    const cfg = loadConfig(null, p);
    expect(cfg.extensions.laceNotifications.level).toBe("all");
  });
});
