/**
 * Extension registry — central coordinator for loaded .laceext files.
 *
 * Instantiated per runScript() call. Responsibilities:
 *   - Hold the collection of loaded Extensions.
 *   - Validate each extension's require list resolves to a loaded peer.
 *   - Aggregate emit results: result.actions.* arrays and namespaced
 *     result.runVars entries.
 *   - Fire hooks in the topologically-sorted order specified by per-rule
 *     after / before qualifiers, with silent-drop semantics when an
 *     ordering constraint references an extension that contributed no rules
 *     to the hook (see lace-extensions.md §8.1.1).
 *   - Expose each dependent extension's required-extension variable view
 *     via the DSL require[...] base.
 */

import { Interpreter } from "./interpreter.js";
import {
  type Extension,
  type HookRegistration,
  type RuleDef,
  loadExtension,
} from "./loader.js";

type RuleTriple = [string, Extension, RuleDef, HookRegistration];

export class ExtensionRegistry {
  extensions: Extension[] = [];
  actions: Record<string, unknown[]> = {};
  extRunVars: Record<string, unknown> = {};
  perExtRunVars: Record<string, Record<string, unknown>> = {};
  warnings: string[] = [];
  extensionConfig: Record<string, unknown>;

  constructor(config?: Record<string, unknown>) {
    this.extensionConfig = config || {};
  }

  // ── loading ─────────────────────────────────────────────────────

  load(filePath: string): Extension {
    const ext = loadExtension(filePath);
    this.extensions.push(ext);
    if (!(ext.name in this.perExtRunVars)) {
      this.perExtRunVars[ext.name] = {};
    }
    return ext;
  }

  finalize(): void {
    const loaded = new Set(this.extensions.map((e) => e.name));

    // 1. require presence
    for (const ext of this.extensions) {
      for (const dep of ext.requires) {
        if (!loaded.has(dep)) {
          throw new Error(
            `extension '${ext.name}' requires '${dep}', but '${dep}' is not loaded`,
          );
        }
      }
    }

    // 2. after/before name resolution
    for (const ext of this.extensions) {
      for (const rule of ext.rules) {
        for (const reg of rule.hooks) {
          for (const target of [...reg.after, ...reg.before]) {
            if (!loaded.has(target)) {
              throw new Error(
                `extension '${ext.name}' rule '${rule.name}' ` +
                  `on hook '${reg.hook}': unknown extension '${target}' in 'after'/'before' qualifier`,
              );
            }
          }
        }
      }
    }

    // 3. cross-extension function call graph cycle check
    checkCrossExtRecursion(this.extensions);
  }

  isActive(name: string): boolean {
    return this.extensions.some((e) => e.name === name);
  }

  tagConstructors(): Record<string, (args: unknown[]) => unknown> {
    const out: Record<string, (args: unknown[]) => unknown> = {};
    for (const e of this.extensions) {
      Object.assign(out, e.tagConstructors());
    }
    return out;
  }

  // ── hook dispatch (topo-sorted) ─────────────────────────────────

  fireHook(hook: string, context: Record<string, unknown>): void {
    let triples = this.gatherRulesForHook(hook);
    if (triples.length === 0) return;

    // --- step 3: silent drop ---
    while (true) {
      const extHasRulesHere = new Set(triples.map((t) => t[0]));
      const survivors: RuleTriple[] = [];
      let droppedSome = false;

      for (const [extName, extObj, rule, reg] of triples) {
        let ok = true;
        for (const target of reg.after) {
          if (!extHasRulesHere.has(target)) {
            ok = false;
            break;
          }
        }
        if (ok) {
          for (const target of reg.before) {
            if (!extHasRulesHere.has(target)) {
              ok = false;
              break;
            }
          }
        }
        if (ok) {
          survivors.push([extName, extObj, rule, reg]);
        } else {
          droppedSome = true;
        }
      }

      if (!droppedSome) break;
      triples = survivors;
      if (triples.length === 0) return;
    }

    // --- step 2: add implicit after-edges from require ---
    const extHasRulesHere = new Set(triples.map((t) => t[0]));
    const edges: Array<[number, number]> = [];
    const indexByExt: Record<string, number[]> = {};

    for (let idx = 0; idx < triples.length; idx++) {
      const name = triples[idx][0];
      (indexByExt[name] ??= []).push(idx);
    }

    for (let idx = 0; idx < triples.length; idx++) {
      const [_name, extObj, _rule, reg] = triples[idx];

      // Explicit after
      for (const target of reg.after) {
        for (const src of indexByExt[target] || []) {
          edges.push([src, idx]);
        }
      }
      // Explicit before
      for (const target of reg.before) {
        for (const dst of indexByExt[target] || []) {
          edges.push([idx, dst]);
        }
      }
      // Implicit after from require
      for (const dep of extObj.requires) {
        if (!extHasRulesHere.has(dep)) continue;
        if (reg.before.includes(dep)) continue;
        for (const src of indexByExt[dep] || []) {
          const key = `${src}-${idx}`;
          if (!edges.some(([a, b]) => a === src && b === idx)) {
            edges.push([src, idx]);
          }
        }
      }
    }

    const order = topoSort(triples.length, edges, triples);

    // --- step 5: execute ---
    for (const i of order) {
      const [name, extObj, rule, _reg] = triples[i];
      const interp = this.buildInterpreter(extObj);
      try {
        interp.runRule(rule.body, { ...context });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.warnings.push(
          `extension '${name}' rule '${rule.name}' on '${hook}': ${msg}`,
        );
      }
    }
  }

  private gatherRulesForHook(hook: string): RuleTriple[] {
    const out: RuleTriple[] = [];
    for (const ext of this.extensions) {
      for (const rule of ext.rules) {
        for (const reg of rule.hooks) {
          if (reg.hook === hook) {
            out.push([ext.name, ext, rule, reg]);
          }
        }
      }
    }
    return out;
  }

  private buildInterpreter(ext: Extension): Interpreter {
    // Scope the dep view to this extension's declared requires only.
    const depView: Record<string, Record<string, unknown>> = {};
    for (const dep of ext.requires) {
      depView[dep] = { ...(this.perExtRunVars[dep] || {}) };
    }

    // Per-extension config: merge .config defaults with lace.config overrides.
    let userCfg: Record<string, unknown> =
      typeof this.extensionConfig === "object" &&
      this.extensionConfig !== null
        ? ((this.extensionConfig as Record<string, unknown>)[ext.name] as Record<string, unknown>) || {}
        : {};
    if (typeof userCfg !== "object" || userCfg === null) {
      userCfg = {};
    }
    // Remove internal keys
    const filteredUserCfg: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(userCfg)) {
      if (k !== "laceext") {
        filteredUserCfg[k] = v;
      }
    }
    const extCfg = { ...ext.configDefaults, ...filteredUserCfg };

    return new Interpreter(
      ext.name,
      ext.functionSpecs(),
      this.tagConstructors(),
      this.emit.bind(this),
      extCfg,
      depView,
      this.invokeExposed.bind(this),
      [...ext.requires],
    );
  }

  // ── exposed function dispatch ────────────────────────────────────

  private invokeExposed(
    extName: string,
    fnName: string,
    args: unknown[],
  ): unknown {
    const owner = this.extensions.find((e) => e.name === extName);
    if (!owner) {
      throw new Error(
        `qualified call to unknown extension '${extName}'`,
      );
    }
    const fn = owner.functions[fnName];
    if (!fn || !fn.exposed) {
      throw new Error(
        `${extName}.${fnName} is not an exposed function ` +
          `(declare [functions.${fnName}].exposed = true)`,
      );
    }
    const ownerInterp = this.buildInterpreter(owner);
    return ownerInterp._callFunction(fnName, [...args]);
  }

  // ── emit target routing ─────────────────────────────────────────

  private emit(
    target: string[],
    payload: Record<string, unknown>,
  ): void {
    if (
      target.length === 3 &&
      target[0] === "result" &&
      target[1] === "actions"
    ) {
      const key = target[2];
      (this.actions[key] ??= []).push(payload);
      return;
    }
    if (
      target.length === 2 &&
      target[0] === "result" &&
      target[1] === "runVars"
    ) {
      Object.assign(this.extRunVars, payload);
      for (const [key, value] of Object.entries(payload)) {
        const owner = key.split(".")[0];
        (this.perExtRunVars[owner] ??= {})[key] = value;
      }
      return;
    }
    this.warnings.push(
      `emit to disallowed target: ${target.join(".")}`,
    );
  }
}

// ─── Topological sort ─────────────────────────────────────────────────

function topoSort(
  n: number,
  edges: Array<[number, number]>,
  nodes: RuleTriple[],
): number[] {
  const indeg = new Array(n).fill(0);
  const adj: number[][] = Array.from({ length: n }, () => []);

  for (const [a, b] of edges) {
    adj[a].push(b);
    indeg[b]++;
  }

  const sortKey = (i: number): [number, string] => {
    return [nodes[i][2].declarationIndex, nodes[i][0]];
  };

  const compareKeys = (a: number, b: number): number => {
    const [ai, an] = sortKey(a);
    const [bi, bn] = sortKey(b);
    if (ai !== bi) return ai - bi;
    return an < bn ? -1 : an > bn ? 1 : 0;
  };

  const ready = [];
  for (let i = 0; i < n; i++) {
    if (indeg[i] === 0) ready.push(i);
  }
  ready.sort(compareKeys);

  const out: number[] = [];
  while (ready.length > 0) {
    const i: number = ready.shift()!;
    out.push(i);
    for (const j of adj[i] as number[]) {
      indeg[j]--;
      if (indeg[j] === 0) {
        ready.push(j);
        ready.sort(compareKeys);
      }
    }
  }

  if (out.length !== n) {
    const stuck = [];
    for (let i = 0; i < n; i++) {
      if (indeg[i] > 0) stuck.push(nodes[i]);
    }
    const desc = stuck
      .map(([name, , rule]) => `${name}:${rule.name}`)
      .join(", ");
    throw new Error(`extension hook cycle among rules: ${desc}`);
  }
  return out;
}

// ─── Cross-extension function recursion check (lace-extensions.md §6) ─────────────

function walkCallTargets(
  node: unknown,
  owner: string,
  edges: Set<string>,
  caller: [string, string],
): void {
  if (typeof node === "object" && node !== null) {
    if (Array.isArray(node)) {
      for (const it of node) {
        walkCallTargets(it, owner, edges, caller);
      }
    } else {
      const n = node as Record<string, unknown>;
      const kind = n.kind as string | undefined;
      if (kind === "call") {
        edges.add(`${caller[0]}:${caller[1]}->${owner}:${n.name}`);
      } else if (kind === "qualified_call") {
        edges.add(
          `${caller[0]}:${caller[1]}->${n.ext}:${n.name}`,
        );
      }
      for (const v of Object.values(n)) {
        walkCallTargets(v, owner, edges, caller);
      }
    }
  }
}

function checkCrossExtRecursion(extensions: Extension[]): void {
  const edgeStrs = new Set<string>();
  const nodeSet = new Set<string>();

  for (const ext of extensions) {
    for (const [fname, fdef] of Object.entries(ext.functions)) {
      const caller: [string, string] = [ext.name, fname];
      const key = `${ext.name}:${fname}`;
      nodeSet.add(key);
      walkCallTargets(fdef.body, ext.name, edgeStrs, caller);
    }
  }

  // Build adjacency list
  const adj: Record<string, string[]> = {};
  for (const n of nodeSet) {
    adj[n] = [];
  }
  for (const edgeStr of edgeStrs) {
    const [from, to] = edgeStr.split("->");
    if (!(from in adj)) adj[from] = [];
    if (!(to in adj)) adj[to] = [];
    adj[from].push(to);
  }

  // DFS three-coloring
  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const color: Record<string, number> = {};
  for (const n of Object.keys(adj)) {
    color[n] = WHITE;
  }

  function visit(n: string, stack: string[]): void {
    color[n] = GREY;
    stack.push(n);
    for (const m of adj[n] || []) {
      if (color[m] === GREY) {
        const idx = stack.indexOf(m);
        const cycle = [...stack.slice(idx), m];
        const pathStr = cycle
          .map((s) => s.replace(":", "."))
          .join(" -> ");
        throw new Error(`function call cycle: ${pathStr}`);
      }
      if ((color[m] ?? WHITE) === WHITE) {
        visit(m, stack);
      }
    }
    stack.pop();
    color[n] = BLACK;
  }

  for (const n of Object.keys(adj)) {
    if (color[n] === WHITE) {
      visit(n, []);
    }
  }
}
