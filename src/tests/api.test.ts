/**
 * Tests for the high-level LaceExecutor / LaceProbe API.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LaceExecutor } from "../api.js";

// -- Helpers ----------------------------------------------------------------

let tempDir: string;

function createLaceRoot(): string {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lace-test-"));

  const scriptsDir = path.join(tempDir, "scripts", "ping");
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.writeFileSync(
    path.join(scriptsDir, "ping.lace"),
    'get("https://httpbin.org/status/200")\n    .expect(status: 200)\n',
    "utf-8",
  );
  fs.writeFileSync(
    path.join(scriptsDir, "vars.json"),
    '{"base_url": "https://httpbin.org"}',
    "utf-8",
  );

  fs.writeFileSync(
    path.join(tempDir, "lace.config"),
    "[executor]\nmaxRedirects = 10\nmaxTimeoutMs = 300000\n",
    "utf-8",
  );

  return tempDir;
}

function rmrf(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch { /* ignore */ }
}

afterEach(() => {
  if (tempDir) {
    rmrf(tempDir);
  }
});

// -- Tests ------------------------------------------------------------------

describe("LaceExecutor", () => {
  it("discovers config from root", () => {
    const root = createLaceRoot();
    const executor = new LaceExecutor(root);
    expect(executor.config.executor.maxRedirects).toBe(10);
    expect(executor.root).toBe(path.resolve(root));
  });

  it("works with no root", () => {
    const executor = new LaceExecutor();
    expect(executor.root).toBeNull();
    expect(executor.config.executor.maxRedirects).toBe(10); // defaults
  });

  it("track_prev defaults to true", () => {
    const root = createLaceRoot();
    const executor = new LaceExecutor(root);
    expect(executor.trackPrev).toBe(true);
  });

  it("track_prev can be disabled", () => {
    const root = createLaceRoot();
    const executor = new LaceExecutor(root, { trackPrev: false });
    expect(executor.trackPrev).toBe(false);
  });
});

describe("LaceProbe", () => {
  it("resolves name-based script", () => {
    const root = createLaceRoot();
    const executor = new LaceExecutor(root);
    const probe = executor.probe("ping");
    expect(probe.name).toBe("ping");
    expect(probe.scriptPath).not.toBeNull();
    expect(probe.scriptPath!.endsWith("ping.lace")).toBe(true);
  });

  it("inline source has no name or path", () => {
    const executor = new LaceExecutor();
    const probe = executor.probe(
      'get("https://httpbin.org/status/200")\n    .expect(status: 200)\n',
    );
    expect(probe.name).toBeNull();
    expect(probe.scriptPath).toBeNull();
  });

  it("file path probe has no name", () => {
    const root = createLaceRoot();
    const executor = new LaceExecutor(root);
    const filePath = path.join(root, "scripts", "ping", "ping.lace");
    const probe = executor.probe(filePath);
    expect(probe.scriptPath).toBe(path.resolve(filePath));
    expect(probe.name).toBeNull(); // file path -> no name
  });
});

describe("LaceExtension", () => {
  it("registers extension file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lace-ext-test-"));
    try {
      const extFile = path.join(dir, "myext.laceext");
      fs.writeFileSync(
        extFile,
        '[extension]\nname = "myext"\nversion = "1.0.0"\n',
        "utf-8",
      );
      const executor = new LaceExecutor();
      const ext = executor.extension(extFile);
      expect(ext.name).toBe("myext");
      expect(ext.path).toBe(path.resolve(extFile));
      expect(executor._extensionPaths).toContain(path.resolve(extFile));
    } finally {
      rmrf(dir);
    }
  });

  it("registers extension directory", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lace-ext-test-"));
    try {
      const extDir = path.join(dir, "myext");
      fs.mkdirSync(extDir, { recursive: true });
      fs.writeFileSync(
        path.join(extDir, "myext.laceext"),
        '[extension]\nname = "myext"\nversion = "1.0.0"\n',
        "utf-8",
      );
      fs.writeFileSync(
        path.join(extDir, "myext.config"),
        '[extension]\nname = "myext"\nversion = "1.0.0"\n\n[config]\nkey = "value"\n',
        "utf-8",
      );
      const executor = new LaceExecutor();
      const ext = executor.extension(extDir);
      expect(ext.name).toBe("myext");
      expect(ext.configPath).not.toBeNull();
    } finally {
      rmrf(dir);
    }
  });

  it("throws when extension not found", () => {
    const executor = new LaceExecutor();
    expect(() => executor.extension("/nonexistent/ext.laceext")).toThrow();
  });
});
