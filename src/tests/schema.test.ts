/**
 * Schema validation and size parsing tests.
 */

import { describe, it, expect } from "vitest";
import { parseSize, validateSchema } from "../executor.js";

// -- parseSize (spec S4.3 pattern) ------------------------------------------

describe("parseSize", () => {
  it("plain int", () => {
    expect(parseSize("500")).toBe(500);
  });

  it("k suffix", () => {
    expect(parseSize("10k")).toBe(10 * 1024);
  });

  it("kb suffix", () => {
    expect(parseSize("2kb")).toBe(2 * 1024);
  });

  it("mb suffix", () => {
    expect(parseSize("1MB")).toBe(1024 ** 2);
  });

  it("gb suffix", () => {
    expect(parseSize("1GB")).toBe(1024 ** 3);
  });

  it("m suffix case insensitive", () => {
    expect(parseSize("5m")).toBe(5 * 1024 ** 2);
  });

  it("rejects B suffix", () => {
    // B is not in the spec pattern -- should return the string
    expect(parseSize("500B")).toBe("500B");
  });

  it("rejects spaces", () => {
    expect(parseSize("2 MB")).toBe("2 MB");
  });

  it("rejects float", () => {
    expect(parseSize("1.5MB")).toBe("1.5MB");
  });

  it("non-string passthrough", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(parseSize(1024 as any)).toBe(1024);
  });
});

// -- validateSchema ---------------------------------------------------------

describe("validateSchema", () => {
  it("type string", () => {
    expect(validateSchema("hello", { type: "string" })).toBe("passed");
    expect(validateSchema(42, { type: "string" })).toBe("failed");
  });

  it("type integer", () => {
    expect(validateSchema(42, { type: "integer" })).toBe("passed");
    expect(validateSchema(true, { type: "integer" })).toBe("failed");
  });

  it("type object", () => {
    expect(validateSchema({ a: 1 }, { type: "object" })).toBe("passed");
    expect(validateSchema("str", { type: "object" })).toBe("failed");
  });

  it("required", () => {
    const schema = { type: "object", required: ["name"] };
    expect(validateSchema({ name: "x" }, schema)).toBe("passed");
    expect(validateSchema({}, schema)).toBe("failed");
  });

  it("enum", () => {
    const schema = { type: "string", enum: ["a", "b", "c"] };
    expect(validateSchema("a", schema)).toBe("passed");
    expect(validateSchema("z", schema)).toBe("failed");
  });

  it("nested properties", () => {
    const schema = {
      type: "object",
      properties: {
        name: { type: "string" },
        age: { type: "integer" },
      },
    };
    expect(validateSchema({ name: "x", age: 1 }, schema)).toBe("passed");
    expect(validateSchema({ name: "x", age: "old" }, schema)).toBe("failed");
  });

  it("strict mode rejects extra keys", () => {
    const schema = {
      type: "object",
      properties: { a: { type: "string" } },
    };
    const body = { a: "x", b: "extra" };
    expect(validateSchema(body, schema)).toBe("passed"); // non-strict
    expect(validateSchema(body, schema, "", true)).toBe("failed"); // strict
  });

  it("strict mode passes when no extras", () => {
    const schema = {
      type: "object",
      properties: { a: { type: "string" } },
    };
    expect(validateSchema({ a: "x" }, schema, "", true)).toBe("passed");
  });

  it("strict mode recursive", () => {
    const schema = {
      type: "object",
      properties: {
        nested: {
          type: "object",
          properties: { x: { type: "integer" } },
        },
      },
    };
    const body = { nested: { x: 1, y: 2 } };
    expect(validateSchema(body, schema)).toBe("passed");
    expect(validateSchema(body, schema, "", true)).toBe("failed");
  });

  it("array items", () => {
    const schema = { type: "array", items: { type: "integer" } };
    expect(validateSchema([1, 2, 3], schema)).toBe("passed");
    expect(validateSchema([1, "two"], schema)).toBe("failed");
  });

  it("null body fails", () => {
    expect(validateSchema(null, { type: "object" })).toBe("failed");
  });

  it("null schema indeterminate", () => {
    expect(validateSchema({ a: 1 }, null)).toBe("indeterminate");
  });
});
