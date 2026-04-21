/**
 * Parser for the .laceext rule body DSL (lace-extensions.md §5.1).
 *
 * Produces a tree of typed dict nodes. Precedence (lowest to highest):
 *
 *   ternary (? :) < or < and < eq/neq < lt/lte/gt/gte < add/sub < mul/div
 *   < unary (not, -) < access < primary
 */

import { type Token, tokenize } from "./dsl-lexer.js";

export class DSLParseError extends Error {
  line: number;
  constructor(msg: string, line: number) {
    super(`line ${line}: ${msg}`);
    this.name = "DSLParseError";
    this.line = line;
  }
}

export class DSLParser {
  private toks: Token[];
  private pos: number = 0;
  private inFunction: boolean;

  constructor(tokens: Token[], inFunction: boolean = false) {
    this.toks = tokens;
    this.inFunction = inFunction;
  }

  private get tok(): Token {
    return this.toks[this.pos];
  }

  private peek(off: number = 0): Token {
    return this.toks[this.pos + off];
  }

  private advance(): Token {
    const t = this.toks[this.pos];
    if (this.pos < this.toks.length - 1) {
      this.pos++;
    }
    return t;
  }

  private check(...types: string[]): boolean {
    return types.includes(this.tok.type);
  }

  private match(...types: string[]): Token | null {
    if (types.includes(this.tok.type)) {
      return this.advance();
    }
    return null;
  }

  private expect(ttype: string): Token {
    if (this.tok.type !== ttype) {
      throw new DSLParseError(
        `expected ${ttype}, got '${this.tok.type}' ('${this.tok.value}')`,
        this.tok.line,
      );
    }
    return this.advance();
  }

  // ── program ──────────────────────────────────────────────────────

  parseBody(): Record<string, unknown>[] {
    const stmts: Record<string, unknown>[] = [];
    while (!this.check("EOF", "DEDENT")) {
      if (this.check("NEWLINE")) {
        this.advance();
        continue;
      }
      stmts.push(this.parseStatement());
    }
    return stmts;
  }

  private parseStatement(): Record<string, unknown> {
    const t = this.tok;
    if (t.type === "KW_FOR") return this.parseFor();
    if (t.type === "KW_WHEN") return this.parseWhen();
    if (t.type === "KW_LET") return this.parseLet();
    if (t.type === "KW_SET") return this.parseSet();
    if (t.type === "KW_EMIT") return this.parseEmit();
    if (t.type === "KW_EXIT") {
      this.advance();
      this.expectStmtEnd();
      return { kind: "exit", line: t.line };
    }
    if (t.type === "KW_RETURN") {
      if (!this.inFunction) {
        throw new DSLParseError(
          "return is only valid in function bodies",
          t.line,
        );
      }
      this.advance();
      const e = this.parseExpr();
      this.expectStmtEnd();
      return { kind: "return", expr: e, line: t.line };
    }
    if (t.type === "IDENT") {
      const call = this.parseFuncCallExpr();
      this.expectStmtEnd();
      return { kind: "call_stmt", call, line: t.line };
    }
    throw new DSLParseError(
      `unexpected token at statement start: ${t.type} '${t.value}'`,
      t.line,
    );
  }

  private expectStmtEnd(): void {
    if (this.check("NEWLINE")) {
      this.advance();
      return;
    }
    if (this.check("EOF", "DEDENT")) return;
    throw new DSLParseError(
      `expected end of statement, got ${this.tok.type}`,
      this.tok.line,
    );
  }

  // ── for / when / let / emit ─────────────────────────────────────

  private parseFor(): Record<string, unknown> {
    const start = this.advance(); // for
    const binding = this.expect("BINDING").value;
    this.expect("KW_IN");
    const iterExpr = this.parseExpr();
    this.expect("COLON");
    this.expect("NEWLINE");
    this.expect("INDENT");
    const body = this.parseBody();
    this.expect("DEDENT");
    return {
      kind: "for",
      binding,
      iter: iterExpr,
      body,
      line: start.line,
    };
  }

  private parseWhen(): Record<string, unknown> {
    const start = this.advance(); // when
    const cond = this.parseExpr();
    if (this.match("COLON")) {
      this.expect("NEWLINE");
      this.expect("INDENT");
      const body = this.parseBody();
      this.expect("DEDENT");
      return { kind: "when_block", cond, body, line: start.line };
    }
    this.expectStmtEnd();
    return { kind: "when_inline", cond, line: start.line };
  }

  private parseLet(): Record<string, unknown> {
    const start = this.advance(); // let
    const name = this.expect("BINDING").value;
    this.expect("EQ");
    const expr = this.parseExpr();
    this.expectStmtEnd();
    return { kind: "let", name, expr, line: start.line };
  }

  private parseSet(): Record<string, unknown> {
    const start = this.advance(); // set
    if (!this.inFunction) {
      throw new DSLParseError(
        "set is only valid in function bodies; rule bindings are immutable",
        start.line,
      );
    }
    const name = this.expect("BINDING").value;
    this.expect("EQ");
    const expr = this.parseExpr();
    this.expectStmtEnd();
    return { kind: "set", name, expr, line: start.line };
  }

  private parseEmit(): Record<string, unknown> {
    const start = this.advance(); // emit
    this.expect("KW_RESULT");
    const path: string[] = ["result"];
    while (this.match("DOT")) {
      path.push(this.expect("IDENT").value);
    }
    this.expect("ARROW");
    this.expect("LBRACE");
    const fields: Record<string, unknown>[] = [];
    if (!this.check("RBRACE")) {
      while (true) {
        const keyTok = this.tok;
        let key: string;
        if (keyTok.type === "STRING") {
          this.advance();
          key = keyTok.value;
        } else if (keyTok.type === "IDENT") {
          this.advance();
          key = keyTok.value;
        } else {
          throw new DSLParseError(
            `expected field key, got ${keyTok.type}`,
            keyTok.line,
          );
        }
        this.expect("COLON");
        const val = this.parseExpr();
        fields.push({ key, value: val });
        if (!this.match("COMMA")) break;
        if (this.check("RBRACE")) break;
      }
    }
    this.expect("RBRACE");
    this.expectStmtEnd();
    return { kind: "emit", target: path, fields, line: start.line };
  }

  // ── expressions (precedence climb) ───────────────────────────────

  private parseExpr(): Record<string, unknown> {
    const cond = this.parseOr();
    if (this.match("QUESTION")) {
      const then = this.parseExpr();
      this.expect("COLON");
      const else_ = this.parseExpr();
      return { kind: "ternary", cond, then, else: else_ };
    }
    return cond;
  }

  private parseOr(): Record<string, unknown> {
    let left = this.parseAnd();
    while (this.check("KW_OR")) {
      this.advance();
      const right = this.parseAnd();
      left = { kind: "binop", op: "or", left, right };
    }
    return left;
  }

  private parseAnd(): Record<string, unknown> {
    let left = this.parseEq();
    while (this.check("KW_AND")) {
      this.advance();
      const right = this.parseEq();
      left = { kind: "binop", op: "and", left, right };
    }
    return left;
  }

  private parseEq(): Record<string, unknown> {
    let left = this.parseOrd();
    if (this.check("KW_EQ", "KW_NEQ")) {
      const opTok = this.advance();
      const op = opTok.value;
      const right = this.parseOrd();
      left = { kind: "binop", op, left, right };
      if (this.check("KW_EQ", "KW_NEQ")) {
        throw new DSLParseError(
          "chained comparison: comparisons do not associate; " +
            "use 'and'/'or' with parentheses to combine",
          this.tok.line,
        );
      }
    }
    return left;
  }

  private parseOrd(): Record<string, unknown> {
    let left = this.parseAddSub();
    if (this.check("KW_LT", "KW_LTE", "KW_GT", "KW_GTE")) {
      const opTok = this.advance();
      const op = opTok.value;
      const right = this.parseAddSub();
      left = { kind: "binop", op, left, right };
      if (this.check("KW_LT", "KW_LTE", "KW_GT", "KW_GTE")) {
        throw new DSLParseError(
          "chained comparison: comparisons do not associate; " +
            "use 'and'/'or' with parentheses to combine",
          this.tok.line,
        );
      }
    }
    return left;
  }

  private parseAddSub(): Record<string, unknown> {
    let left = this.parseMulDiv();
    while (this.check("PLUS", "MINUS")) {
      const op = this.advance().value;
      const right = this.parseMulDiv();
      left = { kind: "binop", op, left, right };
    }
    return left;
  }

  private parseMulDiv(): Record<string, unknown> {
    let left = this.parseUnary();
    while (this.check("STAR", "SLASH")) {
      const op = this.advance().value;
      const right = this.parseUnary();
      left = { kind: "binop", op, left, right };
    }
    return left;
  }

  private parseUnary(): Record<string, unknown> {
    if (this.check("KW_NOT")) {
      this.advance();
      return { kind: "unop", op: "not", operand: this.parseUnary() };
    }
    if (this.check("MINUS")) {
      this.advance();
      return { kind: "unop", op: "-", operand: this.parseUnary() };
    }
    return this.parseAccess();
  }

  private parseAccess(): Record<string, unknown> {
    let base = this.parsePrimary();
    while (true) {
      if (this.match("DOT") || this.match("QDOT")) {
        const tok = this.tok;
        if (tok.type === "IDENT" || tok.type.startsWith("KW_")) {
          this.advance();
          base = { kind: "access_field", base, name: tok.value };
        } else {
          throw new DSLParseError(
            `expected field name, got ${tok.type}`,
            tok.line,
          );
        }
      } else if (this.match("LBRACK")) {
        const idx = this.parseExpr();
        this.expect("RBRACK");
        base = { kind: "access_index", base, index: idx };
      } else if (this.match("QBRACK")) {
        const cond = this.parseExpr();
        this.expect("RBRACK");
        base = { kind: "access_filter", base, cond };
      } else {
        break;
      }
    }
    return base;
  }

  private parsePrimary(): Record<string, unknown> {
    const t = this.tok;
    if (t.type === "LPAREN") {
      this.advance();
      const e = this.parseExpr();
      this.expect("RPAREN");
      return e;
    }
    if (t.type === "LBRACE") {
      return this.parseObjectLit();
    }
    if (t.type === "STRING") {
      this.advance();
      return { kind: "literal", valueType: "string", value: t.value };
    }
    if (t.type === "INT") {
      this.advance();
      return { kind: "literal", valueType: "int", value: parseInt(t.value, 10) };
    }
    if (t.type === "FLOAT") {
      this.advance();
      return { kind: "literal", valueType: "float", value: parseFloat(t.value) };
    }
    if (t.type === "KW_TRUE") {
      this.advance();
      return { kind: "literal", valueType: "bool", value: true };
    }
    if (t.type === "KW_FALSE") {
      this.advance();
      return { kind: "literal", valueType: "bool", value: false };
    }
    if (t.type === "KW_NULL") {
      this.advance();
      return { kind: "literal", valueType: "null", value: null };
    }
    if (t.type === "KW_RESULT") {
      this.advance();
      return { kind: "base", name: "result" };
    }
    if (t.type === "KW_PREV") {
      this.advance();
      return { kind: "base", name: "prev" };
    }
    if (t.type === "KW_THIS") {
      this.advance();
      return { kind: "base", name: "this" };
    }
    if (t.type === "KW_CONFIG") {
      this.advance();
      return { kind: "base", name: "config" };
    }
    if (t.type === "KW_REQUIRE") {
      this.advance();
      return { kind: "base", name: "require" };
    }
    if (t.type === "BINDING") {
      this.advance();
      return { kind: "binding", name: t.value };
    }
    if (t.type === "IDENT") {
      if (this.peek(1).type === "LPAREN") {
        return this.parseFuncCallExpr();
      }
      if (this.looksLikeQualifiedCall()) {
        return this.parseFuncCallExpr();
      }
      this.advance();
      return { kind: "ident", name: t.value };
    }
    throw new DSLParseError(
      `unexpected token in expression: ${t.type} '${t.value}'`,
      t.line,
    );
  }

  private parseFuncCallExpr(): Record<string, unknown> {
    const headTok = this.expect("IDENT");
    const head = headTok.value;

    let qualified: string | null = null;
    if (
      this.check("DOT") &&
      this.peek(1).type === "IDENT" &&
      this.peek(2).type === "LPAREN"
    ) {
      this.advance(); // DOT
      qualified = this.advance().value; // IDENT
    }

    this.expect("LPAREN");
    const args: Record<string, unknown>[] = [];
    if (!this.check("RPAREN")) {
      while (true) {
        args.push(this.parseExpr());
        if (!this.match("COMMA")) break;
        if (this.check("RPAREN")) break;
      }
    }
    this.expect("RPAREN");
    if (qualified !== null) {
      return {
        kind: "qualified_call",
        ext: head,
        name: qualified,
        args,
        line: headTok.line,
      };
    }
    return { kind: "call", name: head, args, line: headTok.line };
  }

  private parseObjectLit(): Record<string, unknown> {
    const start = this.expect("LBRACE");
    const fields: Record<string, unknown>[] = [];
    if (!this.check("RBRACE")) {
      while (true) {
        const keyTok = this.tok;
        let key: string;
        if (keyTok.type === "STRING") {
          this.advance();
          key = keyTok.value;
        } else if (keyTok.type === "IDENT") {
          this.advance();
          key = keyTok.value;
        } else {
          throw new DSLParseError(
            `expected object-literal key, got ${keyTok.type}`,
            keyTok.line,
          );
        }
        this.expect("COLON");
        const val = this.parseExpr();
        fields.push({ key, value: val });
        if (!this.match("COMMA")) break;
        if (this.check("RBRACE")) break;
      }
    }
    this.expect("RBRACE");
    return { kind: "object_lit", fields, line: start.line };
  }

  private looksLikeQualifiedCall(): boolean {
    const i = this.pos;
    return (
      i + 3 < this.toks.length &&
      this.toks[i].type === "IDENT" &&
      this.toks[i + 1].type === "DOT" &&
      this.toks[i + 2].type === "IDENT" &&
      this.toks[i + 3].type === "LPAREN"
    );
  }
}

// ─── Inline when expansion ────────────────────────────────────────────

function expandInlineWhens(src: string): string {
  const lines = src.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const stripped = line.trimStart();
    if (
      stripped.startsWith("when ") &&
      !stripped.trimEnd().endsWith(":") &&
      !stripped.startsWith("when:")
    ) {
      const indent = line.slice(0, line.length - stripped.length);
      const bodyLines: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const nxt = lines[j];
        if (nxt.trim() === "") break;
        const nxtIndent = nxt.length - nxt.trimStart().length;
        if (nxtIndent < indent.length) break;
        bodyLines.push(nxt);
        j++;
      }
      if (bodyLines.length === 0) {
        out.push(line.trimEnd() + ":");
        out.push(indent + "    exit");
        i++;
        continue;
      }
      out.push(line.trimEnd() + ":");
      const extra = "    ";
      const bodySrc = bodyLines.join("\n");
      const expanded = expandInlineWhens(bodySrc);
      for (const bl of expanded.split("\n")) {
        out.push(bl.trim() ? indent + extra + bl : bl);
      }
      i = j;
      continue;
    }
    out.push(line);
    i++;
  }
  return out.join("\n");
}

export function parseRuleBody(src: string): Record<string, unknown>[] {
  const expanded = expandInlineWhens(src);
  const tokens = tokenize(expanded);
  return new DSLParser(tokens, false).parseBody();
}

export function parseFunctionBody(src: string): Record<string, unknown>[] {
  const expanded = expandInlineWhens(src);
  const tokens = tokenize(expanded);
  return new DSLParser(tokens, true).parseBody();
}
