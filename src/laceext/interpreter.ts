/**
 * Tree-walking interpreter for the .laceext rule body DSL.
 *
 * Implements:
 *   - null-propagating field/index/filter access
 *   - for / when / let / emit / exit / return semantics
 *   - ternary, boolean, arithmetic, comparison, equality
 *   - function dispatch: primitives, extension-defined functions, and
 *     implicit type-tag constructors (from [types.T] one_of entries)
 *   - emit-target validation (only result.actions.* and result.runVars)
 */

import { PRIMITIVES, compare } from "./primitives.js";

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object") return a === b;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (Array.isArray(a) || Array.isArray(b)) return false;
  const keysA = Object.keys(a as Record<string, unknown>);
  const keysB = Object.keys(b as Record<string, unknown>);
  if (keysA.length !== keysB.length) return false;
  for (const k of keysA) {
    if (!deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  }
  return true;
}

// ─── Control flow exceptions ──────────────────────────────────────────

class ExitRule extends Error {
  constructor() {
    super("exit");
    this.name = "ExitRule";
  }
}

class ReturnValue extends Error {
  value: unknown;
  constructor(value: unknown) {
    super("return");
    this.name = "ReturnValue";
    this.value = value;
  }
}

// ─── Scope ────────────────────────────────────────────────────────────

export class Scope {
  vars: Record<string, unknown> = {};
  parent: Scope | null;

  constructor(parent: Scope | null = null) {
    this.parent = parent;
  }

  get(name: string): unknown {
    let cur: Scope | null = this;
    while (cur !== null) {
      if (name in cur.vars) return cur.vars[name];
      cur = cur.parent;
    }
    return null;
  }

  has(name: string): boolean {
    let cur: Scope | null = this;
    while (cur !== null) {
      if (name in cur.vars) return true;
      cur = cur.parent;
    }
    return false;
  }

  put(name: string, value: unknown): void {
    this.vars[name] = value;
  }

  set(name: string, value: unknown): boolean {
    let cur: Scope | null = this;
    while (cur !== null) {
      if (name in cur.vars) {
        cur.vars[name] = value;
        return true;
      }
      cur = cur.parent;
    }
    return false;
  }

  child(): Scope {
    return new Scope(this);
  }
}

// ─── Interpreter ──────────────────────────────────────────────────────

export class Interpreter {
  private extName: string;
  private functions: Record<string, Record<string, unknown>>;
  private tagConstructors: Record<string, (args: unknown[]) => unknown>;
  private emitCallback: (target: string[], payload: Record<string, unknown>) => void;
  private config: Record<string, unknown>;
  private requireView: Record<string, Record<string, unknown>>;
  private qualifiedCall:
    | ((ext: string, name: string, args: unknown[]) => unknown)
    | null;
  private requires: Set<string>;

  constructor(
    extensionName: string,
    functions: Record<string, Record<string, unknown>>,
    tagConstructors: Record<string, (args: unknown[]) => unknown>,
    emitCallback: (target: string[], payload: Record<string, unknown>) => void,
    config?: Record<string, unknown>,
    requireView?: Record<string, Record<string, unknown>>,
    qualifiedCall?: ((ext: string, name: string, args: unknown[]) => unknown) | null,
    requires?: string[],
  ) {
    this.extName = extensionName;
    this.functions = functions;
    this.tagConstructors = tagConstructors;
    this.emitCallback = emitCallback;
    this.config = config || {};
    this.requireView = requireView || {};
    this.qualifiedCall = qualifiedCall ?? null;
    this.requires = new Set(requires || []);
  }

  // ── public: run one rule body ────────────────────────────────────

  runRule(body: Record<string, unknown>[], context: Record<string, unknown>): void {
    const scope = new Scope();
    for (const [k, v] of Object.entries(context)) {
      scope.put(k, v);
    }
    try {
      this.runStmts(body, scope);
    } catch (e) {
      if (e instanceof ExitRule) return;
      throw e;
    }
  }

  // ── statements ──────────────────────────────────────────────────

  private runStmts(stmts: Record<string, unknown>[], scope: Scope): void {
    for (const st of stmts) {
      this.runStmt(st, scope);
    }
  }

  private runStmt(st: Record<string, unknown>, scope: Scope): void {
    const k = st.kind as string;

    if (k === "when_inline") {
      if (!this.truthy(this.eval(st.cond as Record<string, unknown>, scope))) {
        throw new ExitRule();
      }
      return;
    }
    if (k === "when_block") {
      if (this.truthy(this.eval(st.cond as Record<string, unknown>, scope))) {
        this.runStmts(st.body as Record<string, unknown>[], scope.child());
      }
      return;
    }
    if (k === "for") {
      const it = this.eval(st.iter as Record<string, unknown>, scope);
      if (it === null || it === undefined) return;
      if (!Array.isArray(it)) return;
      for (const v of it) {
        const inner = scope.child();
        inner.put(st.binding as string, v);
        try {
          this.runStmts(st.body as Record<string, unknown>[], inner);
        } catch (e) {
          if (e instanceof ExitRule) throw e;
          throw e;
        }
      }
      return;
    }
    if (k === "let") {
      if (scope.has(st.name as string)) {
        throw new Error(`let: name $${st.name as string} already bound in this scope`);
      }
      scope.put(st.name as string, this.eval(st.expr as Record<string, unknown>, scope));
      return;
    }
    if (k === "set") {
      const name = st.name as string;
      if (!scope.set(name, this.eval(st.expr as Record<string, unknown>, scope))) {
        throw new Error(`set: name $${name} is not bound in any enclosing scope`);
      }
      return;
    }
    if (k === "emit") {
      this.runEmit(st, scope);
      return;
    }
    if (k === "exit") {
      throw new ExitRule();
    }
    if (k === "return") {
      throw new ReturnValue(this.eval(st.expr as Record<string, unknown>, scope));
    }
    if (k === "call_stmt") {
      this.eval(st.call as Record<string, unknown>, scope);
      return;
    }
    throw new Error(`unknown statement kind: ${k}`);
  }

  private runEmit(st: Record<string, unknown>, scope: Scope): void {
    const target = st.target as string[];
    if (target.length < 2 || target[0] !== "result") {
      throw new Error(`invalid emit target: ${target.join(".")}`);
    }
    const payload: Record<string, unknown> = {};
    for (const f of st.fields as Array<Record<string, unknown>>) {
      payload[f.key as string] = this.eval(f.value as Record<string, unknown>, scope);
    }
    // Namespace guard on runVars
    if (target[0] === "result" && target[1] === "runVars" && target.length === 2) {
      const prefixed: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(payload)) {
        if (!k.startsWith(`${this.extName}.`)) {
          throw new Error(
            `extension '${this.extName}' emitted run_vars key '${k}' without required prefix`,
          );
        }
        prefixed[k] = v;
      }
      this.emitCallback(target, prefixed);
      return;
    }
    this.emitCallback(target, payload);
  }

  // ── expressions ─────────────────────────────────────────────────

  private eval(node: Record<string, unknown>, scope: Scope): unknown {
    const k = node.kind as string;

    if (k === "literal") return node.value;
    if (k === "base") {
      const n = node.name as string;
      if (n === "this") return scope.get("this");
      if (n === "prev") return scope.get("prev");
      if (n === "result") return scope.get("result");
      if (n === "config") return this.config;
      if (n === "require") return this.requireView;
      return null;
    }
    if (k === "binding") return scope.get(node.name as string);
    if (k === "ident") return scope.get(node.name as string);
    if (k === "access_field") {
      const base = this.eval(node.base as Record<string, unknown>, scope);
      if (base === null || base === undefined) return null;
      if (typeof base === "object" && !Array.isArray(base)) {
        return (base as Record<string, unknown>)[node.name as string] ?? null;
      }
      return null;
    }
    if (k === "access_index") {
      const base = this.eval(node.base as Record<string, unknown>, scope);
      if (base === null || base === undefined) return null;
      const idx = this.eval(node.index as Record<string, unknown>, scope);
      if (Array.isArray(base) && typeof idx === "number" && idx >= 0 && idx < base.length) {
        return base[idx];
      }
      if (typeof base === "object" && !Array.isArray(base) && typeof idx === "string") {
        return (base as Record<string, unknown>)[idx] ?? null;
      }
      return null;
    }
    if (k === "access_filter") {
      const base = this.eval(node.base as Record<string, unknown>, scope);
      if (!Array.isArray(base)) return null;
      for (const item of base) {
        const inner = scope.child();
        inner.put("$", item);
        if (this.truthy(this.eval(node.cond as Record<string, unknown>, inner))) {
          return item;
        }
      }
      return null;
    }
    if (k === "ternary") {
      return this.truthy(this.eval(node.cond as Record<string, unknown>, scope))
        ? this.eval(node.then as Record<string, unknown>, scope)
        : this.eval(node.else as Record<string, unknown>, scope);
    }
    if (k === "binop") return this.evalBinop(node, scope);
    if (k === "unop") return this.evalUnop(node, scope);
    if (k === "call" || k === "qualified_call") return this.evalCall(node, scope);
    if (k === "object_lit") {
      const result: Record<string, unknown> = {};
      for (const f of (node.fields as Array<Record<string, unknown>>) || []) {
        result[f.key as string] = this.eval(f.value as Record<string, unknown>, scope);
      }
      return result;
    }
    throw new Error(`unknown expression kind: ${k}`);
  }

  private evalBinop(node: Record<string, unknown>, scope: Scope): unknown {
    const op = node.op as string;

    if (op === "and") {
      const left = this.eval(node.left as Record<string, unknown>, scope);
      if (!this.truthy(left)) return left === null ? null : false;
      return this.eval(node.right as Record<string, unknown>, scope);
    }
    if (op === "or") {
      const left = this.eval(node.left as Record<string, unknown>, scope);
      if (this.truthy(left)) return left;
      return this.eval(node.right as Record<string, unknown>, scope);
    }

    const a = this.eval(node.left as Record<string, unknown>, scope);
    const b = this.eval(node.right as Record<string, unknown>, scope);

    if (op === "eq") return deepEqual(a, b);
    if (op === "neq") return !deepEqual(a, b);

    // Arithmetic + ordered compare: null propagates
    if (a === null || a === undefined || b === null || b === undefined) return null;

    try {
      if (op === "lt") return (a as number) < (b as number);
      if (op === "lte") return (a as number) <= (b as number);
      if (op === "gt") return (a as number) > (b as number);
      if (op === "gte") return (a as number) >= (b as number);
      if (op === "+") {
        if (typeof a === "string" && typeof b === "string") return a + b;
        if (
          typeof a === "number" &&
          typeof b === "number" &&
          typeof a !== "boolean" &&
          typeof b !== "boolean"
        ) {
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
          if (Number.isInteger(a) && Number.isInteger(b)) {
            return Math.trunc(a / b);
          }
          return a / b;
        }
        return null;
      }
    } catch {
      return null;
    }
    return null;
  }

  private evalUnop(node: Record<string, unknown>, scope: Scope): unknown {
    const op = node.op as string;
    const v = this.eval(node.operand as Record<string, unknown>, scope);
    if (op === "not") return !this.truthy(v);
    if (op === "-") {
      if (typeof v === "number" && typeof v !== "boolean") return -v;
      return null;
    }
    return null;
  }

  private evalCall(node: Record<string, unknown>, scope: Scope): unknown {
    const kind = node.kind as string;
    if (kind === "qualified_call") {
      const ext = node.ext as string;
      const name = node.name as string;
      const args = ((node.args as Record<string, unknown>[]) || []).map((a) =>
        this.eval(a, scope),
      );
      if (!this.requires.has(ext)) {
        throw new Error(
          `extension '${this.extName}' called ${ext}.${name}(...) ` +
            `but does not require '${ext}' (add it to [extension].require)`,
        );
      }
      if (this.qualifiedCall === null) {
        throw new Error("qualified function call unavailable in this context");
      }
      return this.qualifiedCall(ext, name, args);
    }
    const name = node.name as string;
    const args = ((node.args as Record<string, unknown>[]) || []).map((a) =>
      this.eval(a, scope),
    );
    if (name in PRIMITIVES) {
      return PRIMITIVES[name](...args);
    }
    if (name in this.tagConstructors) {
      return this.tagConstructors[name](args);
    }
    if (name in this.functions) {
      return this.callFunction(name, args);
    }
    throw new Error(`unknown function in .laceext rule: '${name}'`);
  }

  /** @internal — also called by registry for exposed function dispatch */
  _callFunction(name: string, args: unknown[]): unknown {
    return this.callFunction(name, args);
  }

  private callFunction(name: string, args: unknown[]): unknown {
    const spec = this.functions[name];
    const body = spec.body as Record<string, unknown>[];
    const params = (spec.params as string[]) || [];
    if (args.length !== params.length) {
      throw new Error(
        `function '${name}' expected ${params.length} args, got ${args.length}`,
      );
    }
    const scope = new Scope();
    for (let i = 0; i < params.length; i++) {
      scope.put(params[i], args[i]);
    }
    try {
      this.runStmts(body, scope);
    } catch (e) {
      if (e instanceof ReturnValue) return e.value;
      throw e;
    }
    return null;
  }

  // ── helpers ─────────────────────────────────────────────────────

  private truthy(v: unknown): boolean {
    if (v === null || v === undefined) return false;
    if (typeof v === "boolean") return v;
    return true;
  }
}
