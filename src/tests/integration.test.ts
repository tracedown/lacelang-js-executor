/**
 * Integration tests -- require network access (httpbin.org).
 *
 * Run with: NETWORK=1 npx vitest run src/integration.test.ts
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runScript } from "../executor.js";
import { LaceExecutor } from "../api.js";

// Dynamically import the validator's parse function.
let parse: (source: string) => Record<string, unknown>;
try {
  const mod = await import("@lacelang/validator");
  parse = (mod as Record<string, unknown>).parse as typeof parse;
} catch {
  parse = (_source: string) => ({ calls: [] });
}

// -- Helpers ----------------------------------------------------------------

async function run(
  source: string,
  scriptVars?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const ast = parse(source);
  return runScript(ast, scriptVars ?? null);
}

// -- Conditional skip -------------------------------------------------------

const NETWORK = !!process.env.NETWORK;

describe.skipIf(!NETWORK)("BasicHTTP", () => {
  it("GET 200", async () => {
    const result = await run(
      'get("https://httpbin.org/status/200")\n    .expect(status: 200)',
    );
    expect(result.outcome).toBe("success");
    expect((result.calls as Record<string, unknown>[]).length).toBe(1);
    const call = (result.calls as Record<string, unknown>[])[0];
    expect(call.outcome).toBe("success");
    expect(
      (call.response as Record<string, unknown>).status,
    ).toBe(200);
  });

  it("GET 404 expect fails", async () => {
    const result = await run(
      'get("https://httpbin.org/status/404")\n    .expect(status: 200)',
    );
    expect(result.outcome).toBe("failure");
    const call = (result.calls as Record<string, unknown>[])[0];
    const assertions = call.assertions as Record<string, unknown>[];
    expect(assertions[0].outcome).toBe("failed");
  });

  it("GET 404 check continues", async () => {
    const result = await run(
      'get("https://httpbin.org/status/404")\n'
      + '    .check(status: 200)\n'
      + 'get("https://httpbin.org/status/200")\n'
      + '    .expect(status: 200)',
    );
    expect(result.outcome).toBe("success");
    const calls = result.calls as Record<string, unknown>[];
    expect((calls[0].assertions as Record<string, unknown>[])[0].outcome).toBe("failed");
    expect(calls[1].outcome).toBe("success");
  });

  it("POST with json body", async () => {
    const result = await run(
      'post("https://httpbin.org/post", {\n'
      + '    body: json({ key: "value" })\n'
      + '})\n'
      + '.expect(status: 200)',
    );
    expect(result.outcome).toBe("success");
  });

  it("PUT method", async () => {
    const result = await run(
      'put("https://httpbin.org/put")\n    .expect(status: 200)',
    );
    expect(result.outcome).toBe("success");
  });

  it("PATCH method", async () => {
    const result = await run(
      'patch("https://httpbin.org/patch")\n    .expect(status: 200)',
    );
    expect(result.outcome).toBe("success");
  });

  it("DELETE method", async () => {
    const result = await run(
      'delete("https://httpbin.org/delete")\n    .expect(status: 200)',
    );
    expect(result.outcome).toBe("success");
  });
});

describe.skipIf(!NETWORK)("ResultStructure", () => {
  it("has required top-level fields", async () => {
    const result = await run(
      'get("https://httpbin.org/status/200")\n    .expect(status: 200)',
    );
    for (const field of ["outcome", "startedAt", "endedAt", "elapsedMs", "runVars", "calls", "actions"]) {
      expect(result).toHaveProperty(field);
    }
  });

  it("elapsedMs is non-negative number", async () => {
    const result = await run(
      'get("https://httpbin.org/status/200")\n    .expect(status: 200)',
    );
    expect(typeof result.elapsedMs).toBe("number");
    expect(result.elapsedMs as number).toBeGreaterThanOrEqual(0);
  });

  it("call record has required fields", async () => {
    const result = await run(
      'get("https://httpbin.org/status/200")\n    .expect(status: 200)',
    );
    const call = (result.calls as Record<string, unknown>[])[0];
    for (const field of [
      "index", "outcome", "startedAt", "endedAt", "request",
      "response", "redirects", "assertions", "config", "warnings", "error",
    ]) {
      expect(call).toHaveProperty(field);
    }
  });

  it("response has timing fields", async () => {
    const result = await run(
      'get("https://httpbin.org/status/200")\n    .expect(status: 200)',
    );
    const resp = (result.calls as Record<string, unknown>[])[0]
      .response as Record<string, unknown>;
    for (const field of [
      "status", "statusText", "headers", "bodyPath",
      "responseTimeMs", "dnsMs", "connectMs", "tlsMs",
      "ttfbMs", "transferMs", "sizeBytes", "dns", "tls",
    ]) {
      expect(resp).toHaveProperty(field);
    }
  });

  it("dns metadata", async () => {
    const result = await run(
      'get("https://httpbin.org/status/200")\n    .expect(status: 200)',
    );
    const dnsInfo = (
      (result.calls as Record<string, unknown>[])[0]
        .response as Record<string, unknown>
    ).dns as Record<string, unknown>;
    expect(dnsInfo).toHaveProperty("resolvedIps");
    expect(dnsInfo).toHaveProperty("resolvedIp");
  });

  it("tls metadata", async () => {
    const result = await run(
      'get("https://httpbin.org/status/200")\n    .expect(status: 200)',
    );
    const tlsInfo = (
      (result.calls as Record<string, unknown>[])[0]
        .response as Record<string, unknown>
    ).tls as Record<string, unknown>;
    expect(tlsInfo).not.toBeNull();
    expect(tlsInfo).toHaveProperty("protocol");
    expect(tlsInfo).toHaveProperty("cipher");
    expect(tlsInfo).toHaveProperty("certificate");
    const cert = tlsInfo.certificate as Record<string, unknown>;
    expect(cert).toHaveProperty("subject");
    expect(cert).toHaveProperty("notBefore");
    expect(cert).toHaveProperty("notAfter");
  });

  it("config emits only AST-present keys", async () => {
    // Script with no config block → emitted config is empty.
    const r1 = await run(
      'get("https://httpbin.org/status/200")\n    .expect(status: 200)',
    );
    const cfg1 = (r1.calls as Record<string, unknown>[])[0]
      .config as Record<string, unknown>;
    expect(Object.keys(cfg1).length).toBe(0);

    // Script with explicit timeout → only timeout appears.
    const r2 = await run(
      'get("https://httpbin.org/status/200", { timeout: { ms: 15000 } })\n    .expect(status: 200)',
    );
    const cfg2 = (r2.calls as Record<string, unknown>[])[0]
      .config as Record<string, unknown>;
    expect(cfg2.timeout).toBeDefined();
    expect((cfg2.timeout as Record<string, unknown>).ms).toBe(15000);
    expect(cfg2.redirects).toBeUndefined();
    expect(cfg2.security).toBeUndefined();
  });

  it("skipped call record", async () => {
    const result = await run(
      'get("https://httpbin.org/status/500")\n'
      + '    .expect(status: 200)\n'
      + 'get("https://httpbin.org/status/200")\n'
      + '    .expect(status: 200)',
    );
    expect(result.outcome).toBe("failure");
    const calls = result.calls as Record<string, unknown>[];
    expect(calls[1].outcome).toBe("skipped");
  });
});

describe.skipIf(!NETWORK)("Variables", () => {
  it("script var interpolation in URL", async () => {
    const result = await run(
      'get("$base_url/status/200")\n    .expect(status: 200)',
      { base_url: "https://httpbin.org" },
    );
    expect(result.outcome).toBe("success");
    const req = (result.calls as Record<string, unknown>[])[0]
      .request as Record<string, unknown>;
    expect((req.url as string)).toContain("httpbin.org");
  });

  it("store run var", async () => {
    const result = await run(
      'get("https://httpbin.org/status/200")\n'
      + '    .expect(status: 200)\n'
      + '    .store({ $$code: this.status })',
    );
    expect((result.runVars as Record<string, unknown>).code).toBe(200);
  });

  it("store writeback", async () => {
    const result = await run(
      'get("https://httpbin.org/status/200")\n'
      + '    .expect(status: 200)\n'
      + '    .store({ $code: this.status })',
    );
    expect(
      ((result.actions as Record<string, unknown>).variables as Record<string, unknown>).code,
    ).toBe(200);
  });

  it("run var chaining", async () => {
    const result = await run(
      'get("https://httpbin.org/status/200")\n'
      + '    .expect(status: 200)\n'
      + '    .store({ $$code: this.status })\n'
      + 'get("https://httpbin.org/headers", {\n'
      + '    headers: { "X-Code": "$$code" }\n'
      + '})\n'
      + '    .expect(status: 200)',
    );
    expect(result.outcome).toBe("success");
    expect((result.runVars as Record<string, unknown>).code).toBe(200);
  });
});

describe.skipIf(!NETWORK)("Redirects", () => {
  it("redirect followed", async () => {
    const result = await run(
      'get("https://httpbin.org/redirect/1")\n'
      + '    .expect(status: 200)',
    );
    expect(result.outcome).toBe("success");
    const call = (result.calls as Record<string, unknown>[])[0];
    expect((call.redirects as string[]).length).toBeGreaterThan(0);
  });

  it("redirect limit exceeded", async () => {
    const result = await run(
      'get("https://httpbin.org/redirect/5", {\n'
      + '    redirects: { max: 2 }\n'
      + '})\n'
      + '    .expect(status: 200)',
    );
    expect(result.outcome).toBe("failure");
    const call = (result.calls as Record<string, unknown>[])[0];
    expect((call.error as string) || "").toContain("redirect limit");
  });
});

describe.skipIf(!NETWORK)("Timeout", () => {
  it("timeout fails", async () => {
    const result = await run(
      'get("https://httpbin.org/delay/5", {\n'
      + '    timeout: { ms: 1000, action: "fail" }\n'
      + '})\n'
      + '    .expect(status: 200)',
    );
    expect(result.outcome).toBe("timeout");
    const call = (result.calls as Record<string, unknown>[])[0];
    expect(call.outcome).toBe("timeout");
  });

  it("timeout warn continues", async () => {
    const result = await run(
      'get("https://httpbin.org/delay/5", {\n'
      + '    timeout: { ms: 1000, action: "warn" }\n'
      + '})\n'
      + '    .expect(status: 200)\n'
      + 'get("https://httpbin.org/status/200")\n'
      + '    .expect(status: 200)',
    );
    expect(result.outcome).toBe("success");
    const calls = result.calls as Record<string, unknown>[];
    expect(calls[0].outcome).toBe("timeout");
    expect(calls[1].outcome).toBe("success");
  });
});

describe.skipIf(!NETWORK)("Assertions", () => {
  it("status array match", async () => {
    const result = await run(
      'get("https://httpbin.org/status/200")\n'
      + '    .expect(status: [200, 201])',
    );
    expect(result.outcome).toBe("success");
  });

  it("body contains match", async () => {
    const result = await run(
      'get("https://httpbin.org/get")\n'
      + '    .expect(status: 200)\n'
      + '    .expect(body: { op: "contains", value: "httpbin.org" })',
    );
    expect(result.outcome).toBe("success");
  });

  it("custom assert", async () => {
    const result = await run(
      'get("https://httpbin.org/status/200")\n'
      + '    .assert({\n'
      + '        expect: [\n'
      + '            this.status eq 200\n'
      + '        ]\n'
      + '    })',
    );
    expect(result.outcome).toBe("success");
    const call = (result.calls as Record<string, unknown>[])[0];
    expect((call.assertions as Record<string, unknown>[])[0].outcome).toBe("passed");
  });

  it("custom assert indeterminate on null", async () => {
    const result = await run(
      'get("https://httpbin.org/status/200")\n'
      + '    .assert({\n'
      + '        check: [\n'
      + '            $missing gt 0\n'
      + '        ]\n'
      + '    })',
    );
    const call = (result.calls as Record<string, unknown>[])[0];
    expect((call.assertions as Record<string, unknown>[])[0].outcome).toBe("indeterminate");
  });
});

describe.skipIf(!NETWORK)("LaceExecutorAPI", () => {
  it("one-shot run", async () => {
    const executor = new LaceExecutor();
    const result = await executor.run(
      'get("https://httpbin.org/status/200")\n    .expect(status: 200)',
    );
    expect(result.outcome).toBe("success");
  });

  it("probe auto-prev tracking", async () => {
    const executor = new LaceExecutor();
    const probe = executor.probe(
      'get("https://httpbin.org/status/200")\n    .expect(status: 200)',
    );
    const r1 = await probe.run();
    expect(probe.prev).toBe(r1);
    const r2 = await probe.run();
    expect(probe.prev).toBe(r2);
  });

  it("probe no prev tracking when disabled", async () => {
    const executor = new LaceExecutor(null, { trackPrev: false });
    const probe = executor.probe(
      'get("https://httpbin.org/status/200")\n    .expect(status: 200)',
    );
    await probe.run();
    expect(probe.prev).toBeNull();
  });

  it("run with vars file", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lace-vars-"));
    try {
      const varsFile = path.join(dir, "vars.json");
      fs.writeFileSync(
        varsFile,
        '{"url": "https://httpbin.org/status/200"}',
        "utf-8",
      );
      const executor = new LaceExecutor();
      const result = await executor.run(
        'get("$url")\n    .expect(status: 200)',
        varsFile,
      );
      expect(result.outcome).toBe("success");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
