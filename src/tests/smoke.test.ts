/**
 * Executor smoke tests -- pure runtime behaviour, no network.
 *
 * Uses fabricated ASTs and internal helpers. The validator's own tests
 * live in lacelang-js-validator.
 */

import { describe, it, expect } from "vitest";
import { Env, interp, evalExpr } from "../executor.js";
import { ExtensionRegistry } from "../laceext/registry.js";

// -- Helpers ----------------------------------------------------------------

function makeEnv(scriptVars: Record<string, unknown> = {}): Env {
  return new Env(scriptVars, null, "/tmp", new ExtensionRegistry());
}

// -- String interpolation ---------------------------------------------------

describe("StringInterpolation", () => {
  it("interpolates script var", () => {
    const env = makeEnv({ name: "Max" });
    expect(interp("hello $name!", env)).toBe("hello Max!");
  });

  it("interpolates run var", () => {
    const env = makeEnv();
    env.runVars["token"] = "abc";
    expect(interp("auth=$$token", env)).toBe("auth=abc");
  });

  it("interpolates braced script var", () => {
    const env = makeEnv({ host: "example.com" });
    expect(interp("${$host}:8080", env)).toBe("example.com:8080");
  });

  it("interpolates braced run var", () => {
    const env = makeEnv();
    env.runVars["id"] = "42";
    expect(interp("item-${$$id}-detail", env)).toBe("item-42-detail");
  });

  it("leaves literal dollar with no match", () => {
    const env = makeEnv({ foo: "bar" });
    // $ not followed by an identifier is left as-is
    expect(interp("price=$100", env)).toBe("price=$100");
    // $ at end of string
    expect(interp("cost$", env)).toBe("cost$");
  });

  it("missing var becomes null with warning", () => {
    const env = makeEnv();
    const warnings: string[] = [];
    const result = interp("val=$missing", env, warnings);
    expect(result).toBe("val=null");
    expect(warnings.length).toBe(1);
  });
});

// -- Expression evaluation --------------------------------------------------

describe("ExpressionEvaluation", () => {
  it("binary comparison gt", () => {
    const env = makeEnv();
    const expr = {
      kind: "binary",
      op: "gt",
      left: { kind: "literal", valueType: "int", value: 5 },
      right: { kind: "literal", valueType: "int", value: 3 },
    };
    expect(evalExpr(expr, env)).toBe(true);
  });

  it("thisRef path resolution", () => {
    const env = makeEnv();
    env.this_ = { body: { count: 42 } };
    const expr = { kind: "thisRef", path: ["body", "count"] };
    expect(evalExpr(expr, env)).toBe(42);
  });

  it("null arithmetic returns null", () => {
    const env = makeEnv();
    const expr = {
      kind: "binary",
      op: "+",
      left: { kind: "literal", valueType: "int", value: 5 },
      right: { kind: "scriptVar", name: "missing" },
    };
    expect(evalExpr(expr, env)).toBeNull();
  });

  it("null eq null is true", () => {
    const env = makeEnv();
    const expr = {
      kind: "binary",
      op: "eq",
      left: { kind: "scriptVar", name: "a" },
      right: { kind: "scriptVar", name: "b" },
    };
    expect(evalExpr(expr, env)).toBe(true);
  });

  it("and short-circuits returning deciding operand", () => {
    const env = makeEnv();
    const expr = {
      kind: "binary",
      op: "and",
      left: { kind: "literal", valueType: "int", value: 0 },
      right: { kind: "literal", valueType: "int", value: 42 },
    };
    // 0 is falsy -> returns 0 (the left operand), not false
    expect(evalExpr(expr, env)).toBe(0);
  });

  it("or short-circuits returning deciding operand", () => {
    const env = makeEnv();
    const expr = {
      kind: "binary",
      op: "or",
      left: { kind: "literal", valueType: "string", value: "hello" },
      right: { kind: "literal", valueType: "string", value: "world" },
    };
    // "hello" is truthy -> returns "hello", not true
    expect(evalExpr(expr, env)).toBe("hello");
  });
});
