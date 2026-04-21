/**
 * Built-in primitive functions available inside rule bodies and functions.
 *
 * Implements lace-extensions.md §7 exactly — all implementations of the
 * .laceext processor share this surface.
 */

export function compare(a: unknown, b: unknown): string | null {
  if (a === null || a === undefined || b === null || b === undefined) {
    return null;
  }
  // Bool: only eq/neq meaningful per spec
  if (typeof a === "boolean" || typeof b === "boolean") {
    if (typeof a !== typeof b) return null;
    return a === b ? "eq" : "neq";
  }
  // Mixed types: numbers are OK together; everything else incomparable
  if (typeof a !== typeof b) {
    if (!(typeof a === "number" && typeof b === "number")) {
      if ((typeof a === "string") !== (typeof b === "string")) {
        return null;
      }
    }
  }
  try {
    if ((a as number) < (b as number)) return "lt";
    if ((a as number) > (b as number)) return "gt";
    if (a === b) return "eq";
  } catch {
    return null;
  }
  return "neq";
}

export function mapGet(m: unknown, key: unknown): unknown {
  if (typeof m !== "object" || m === null || Array.isArray(m)) {
    return null;
  }
  const obj = m as Record<string, unknown>;
  if (key !== null && key !== undefined && String(key) in obj) {
    return obj[String(key)];
  }
  if ("default" in obj) {
    return obj.default;
  }
  return null;
}

export function mapMatch(
  m: unknown,
  actual: unknown,
  expected: unknown,
  _op: unknown,
): unknown {
  if (typeof m !== "object" || m === null || Array.isArray(m)) {
    return null;
  }
  const obj = m as Record<string, unknown>;
  const actualKey = scalarToKey(actual);
  if (actualKey !== null && actualKey in obj) {
    return obj[actualKey];
  }
  const rel = compare(actual, expected);
  if (rel !== null && rel in obj) {
    return obj[rel];
  }
  if ("default" in obj) {
    return obj.default;
  }
  return null;
}

function scalarToKey(v: unknown): string | null {
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return v;
  return null;
}

export function isNull(v: unknown): boolean {
  return v === null || v === undefined;
}

export function typeOf(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean") return "bool";
  if (typeof v === "number") {
    return Number.isInteger(v) ? "int" : "float";
  }
  if (typeof v === "string") return "string";
  if (Array.isArray(v)) return "array";
  if (typeof v === "object") return "object";
  return "any";
}

export function toString(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "string") return v;
  return String(v);
}

export function replace(
  s: unknown,
  pattern: unknown,
  replacement: unknown,
): unknown {
  if (s === null || s === undefined || pattern === null || pattern === undefined) {
    return s;
  }
  return String(s).split(String(pattern)).join(toString(replacement));
}

export const PRIMITIVES: Record<string, (...args: unknown[]) => unknown> = {
  compare,
  map_get: mapGet,
  map_match: mapMatch,
  is_null: isNull,
  type_of: typeOf,
  to_string: toString,
  replace,
};
