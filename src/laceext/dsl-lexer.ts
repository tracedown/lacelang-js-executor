/**
 * Lexer for the .laceext rule body DSL (lace-extensions.md §5.1).
 *
 * Indentation-sensitive (INDENT/DEDENT tokens at block boundaries). Comments start with # and run to end-of-line.
 */

export type TokenType =
  | "IDENT"
  | "STRING"
  | "INT"
  | "FLOAT"
  | "BINDING"
  | "NEWLINE"
  | "INDENT"
  | "DEDENT"
  | "LPAREN"
  | "RPAREN"
  | "LBRACK"
  | "RBRACK"
  | "LBRACE"
  | "RBRACE"
  | "COMMA"
  | "COLON"
  | "DOT"
  | "QDOT"
  | "QBRACK"
  | "ARROW"
  | "EQ"
  | "PLUS"
  | "MINUS"
  | "STAR"
  | "SLASH"
  | "QUESTION"
  | "KW_FOR"
  | "KW_IN"
  | "KW_WHEN"
  | "KW_LET"
  | "KW_SET"
  | "KW_EMIT"
  | "KW_EXIT"
  | "KW_RETURN"
  | "KW_AND"
  | "KW_OR"
  | "KW_NOT"
  | "KW_TRUE"
  | "KW_FALSE"
  | "KW_NULL"
  | "KW_RESULT"
  | "KW_PREV"
  | "KW_THIS"
  | "KW_CONFIG"
  | "KW_REQUIRE"
  | "KW_EQ"
  | "KW_NEQ"
  | "KW_LT"
  | "KW_LTE"
  | "KW_GT"
  | "KW_GTE"
  | "EOF";

export const KEYWORDS: Record<string, TokenType> = {
  for: "KW_FOR",
  in: "KW_IN",
  when: "KW_WHEN",
  let: "KW_LET",
  set: "KW_SET",
  emit: "KW_EMIT",
  exit: "KW_EXIT",
  return: "KW_RETURN",
  and: "KW_AND",
  or: "KW_OR",
  not: "KW_NOT",
  true: "KW_TRUE",
  false: "KW_FALSE",
  null: "KW_NULL",
  result: "KW_RESULT",
  prev: "KW_PREV",
  this: "KW_THIS",
  config: "KW_CONFIG",
  require: "KW_REQUIRE",
  eq: "KW_EQ",
  neq: "KW_NEQ",
  lt: "KW_LT",
  lte: "KW_LTE",
  gt: "KW_GT",
  gte: "KW_GTE",
};

export interface Token {
  type: TokenType;
  value: string;
  line: number;
  col: number;
}

export class DSLLexError extends Error {
  line: number;
  col: number;
  constructor(msg: string, line: number, col: number) {
    super(`${msg} (line ${line}, col ${col})`);
    this.name = "DSLLexError";
    this.line = line;
    this.col = col;
  }
}

export class DSLLexer {
  private src: string;
  private pos: number = 0;
  private line: number = 1;
  private col: number = 1;
  private indentStack: number[] = [0];
  private parenDepth: number = 0;
  private tokens: Token[] = [];
  private atLineStart: boolean = true;

  constructor(source: string) {
    this.src = source;
  }

  private peek(off: number = 0): string {
    const p = this.pos + off;
    return p < this.src.length ? this.src[p] : "";
  }

  private advance(n: number = 1): string {
    const chunk = this.src.slice(this.pos, this.pos + n);
    for (const ch of chunk) {
      if (ch === "\n") {
        this.line++;
        this.col = 1;
      } else {
        this.col++;
      }
    }
    this.pos += n;
    return chunk;
  }

  private handleLineStart(): void {
    while (true) {
      let indent = 0;
      let scan = this.pos;
      while (scan < this.src.length && (this.src[scan] === " " || this.src[scan] === "\t")) {
        indent++;
        scan++;
      }
      if (scan >= this.src.length) return;
      const ch = this.src[scan];
      if (ch === "\n") {
        this.advance(scan - this.pos + 1);
        continue;
      }
      if (ch === "#") {
        while (scan < this.src.length && this.src[scan] !== "\n") {
          scan++;
        }
        this.advance(scan - this.pos);
        if (this.pos < this.src.length && this.peek() === "\n") {
          this.advance();
        }
        continue;
      }
      break;
    }

    // Count indent at the current position
    let indent = 0;
    let scan = this.pos;
    while (scan < this.src.length && (this.src[scan] === " " || this.src[scan] === "\t")) {
      indent++;
      scan++;
    }
    this.advance(indent);
    const curIndent = this.indentStack[this.indentStack.length - 1];
    if (indent > curIndent) {
      this.indentStack.push(indent);
      this.tokens.push({ type: "INDENT", value: "", line: this.line, col: 1 });
    } else if (indent < curIndent) {
      while (
        this.indentStack.length > 0 &&
        this.indentStack[this.indentStack.length - 1] > indent
      ) {
        this.indentStack.pop();
        this.tokens.push({ type: "DEDENT", value: "", line: this.line, col: 1 });
      }
      if (this.indentStack[this.indentStack.length - 1] !== indent) {
        throw new DSLLexError("inconsistent indentation", this.line, 1);
      }
    }
    this.atLineStart = false;
  }

  private lexIdent(): Token {
    const startLine = this.line;
    const startCol = this.col;
    const start = this.pos;
    while (
      this.pos < this.src.length &&
      (this.isAlnum(this.peek()) || this.peek() === "_")
    ) {
      this.advance();
    }
    const text = this.src.slice(start, this.pos);
    const kw = KEYWORDS[text];
    return kw
      ? { type: kw, value: text, line: startLine, col: startCol }
      : { type: "IDENT", value: text, line: startLine, col: startCol };
  }

  private lexBinding(): Token {
    const startLine = this.line;
    const startCol = this.col;
    this.advance(); // $
    if (!this.isAlpha(this.peek()) && this.peek() !== "_") {
      return { type: "BINDING", value: "$", line: startLine, col: startCol };
    }
    const start = this.pos;
    while (
      this.pos < this.src.length &&
      (this.isAlnum(this.peek()) || this.peek() === "_")
    ) {
      this.advance();
    }
    return {
      type: "BINDING",
      value: this.src.slice(start, this.pos),
      line: startLine,
      col: startCol,
    };
  }

  private lexNumber(): Token {
    const startLine = this.line;
    const startCol = this.col;
    const start = this.pos;
    while (this.pos < this.src.length && this.isDigit(this.peek())) {
      this.advance();
    }
    if (this.peek() === "." && this.isDigit(this.peek(1))) {
      this.advance();
      while (this.pos < this.src.length && this.isDigit(this.peek())) {
        this.advance();
      }
      return {
        type: "FLOAT",
        value: this.src.slice(start, this.pos),
        line: startLine,
        col: startCol,
      };
    }
    return {
      type: "INT",
      value: this.src.slice(start, this.pos),
      line: startLine,
      col: startCol,
    };
  }

  private lexString(): Token {
    const startLine = this.line;
    const startCol = this.col;
    const quote = this.peek();
    this.advance();
    const chars: string[] = [];
    while (this.pos < this.src.length) {
      const ch = this.peek();
      if (ch === quote) {
        this.advance();
        return {
          type: "STRING",
          value: chars.join(""),
          line: startLine,
          col: startCol,
        };
      }
      if (ch === "\\") {
        const nxt = this.peek(1);
        const mapping: Record<string, string> = {
          n: "\n",
          t: "\t",
          r: "\r",
          "\\": "\\",
          '"': '"',
          "'": "'",
        };
        if (nxt in mapping) {
          chars.push(mapping[nxt]);
          this.advance(2);
          continue;
        }
        throw new DSLLexError(`invalid escape \\${nxt}`, this.line, this.col);
      }
      if (ch === "\n") {
        throw new DSLLexError(
          "unterminated string literal",
          startLine,
          startCol,
        );
      }
      chars.push(ch);
      this.advance();
    }
    throw new DSLLexError(
      "unterminated string literal",
      startLine,
      startCol,
    );
  }

  tokenize(): Token[] {
    while (this.pos < this.src.length) {
      if (this.atLineStart && this.parenDepth === 0) {
        this.handleLineStart();
        if (this.pos >= this.src.length) break;
      }
      const ch = this.peek();
      if (ch === "\n") {
        this.advance();
        if (this.parenDepth === 0) {
          if (
            this.tokens.length === 0 ||
            this.tokens[this.tokens.length - 1].type !== "NEWLINE"
          ) {
            this.tokens.push({
              type: "NEWLINE",
              value: "",
              line: this.line,
              col: this.col,
            });
          }
          this.atLineStart = true;
        }
        continue;
      }
      if (ch === " " || ch === "\t") {
        this.advance();
        continue;
      }
      if (ch === "#") {
        while (this.pos < this.src.length && this.peek() !== "\n") {
          this.advance();
        }
        continue;
      }
      if (ch === "$") {
        this.tokens.push(this.lexBinding());
        continue;
      }
      if (this.isAlpha(ch) || ch === "_") {
        this.tokens.push(this.lexIdent());
        continue;
      }
      if (this.isDigit(ch)) {
        this.tokens.push(this.lexNumber());
        continue;
      }
      if (ch === '"' || ch === "'") {
        this.tokens.push(this.lexString());
        continue;
      }
      // 2-char punct
      const two = this.src.slice(this.pos, this.pos + 2);
      const startLine = this.line;
      const startCol = this.col;
      if (two === "<-") {
        this.advance(2);
        this.tokens.push({ type: "ARROW", value: "<-", line: startLine, col: startCol });
        continue;
      }
      if (two === "?.") {
        this.advance(2);
        this.tokens.push({ type: "QDOT", value: "?.", line: startLine, col: startCol });
        continue;
      }
      if (two === "[?") {
        this.advance(2);
        this.parenDepth++;
        this.tokens.push({ type: "QBRACK", value: "[?", line: startLine, col: startCol });
        continue;
      }
      const single: Record<string, TokenType> = {
        "(": "LPAREN",
        ")": "RPAREN",
        "[": "LBRACK",
        "]": "RBRACK",
        "{": "LBRACE",
        "}": "RBRACE",
        ",": "COMMA",
        ":": "COLON",
        ".": "DOT",
        "+": "PLUS",
        "-": "MINUS",
        "*": "STAR",
        "/": "SLASH",
        "?": "QUESTION",
        "=": "EQ",
      };
      if (ch in single) {
        if ("([{".includes(ch)) this.parenDepth++;
        if (")]}".includes(ch)) this.parenDepth--;
        this.advance();
        this.tokens.push({
          type: single[ch],
          value: ch,
          line: startLine,
          col: startCol,
        });
        continue;
      }
      throw new DSLLexError(
        `unexpected character '${ch}'`,
        this.line,
        this.col,
      );
    }
    // Final newline + dedents
    if (
      this.tokens.length > 0 &&
      this.tokens[this.tokens.length - 1].type !== "NEWLINE"
    ) {
      this.tokens.push({
        type: "NEWLINE",
        value: "",
        line: this.line,
        col: this.col,
      });
    }
    while (this.indentStack.length > 1) {
      this.indentStack.pop();
      this.tokens.push({
        type: "DEDENT",
        value: "",
        line: this.line,
        col: this.col,
      });
    }
    this.tokens.push({
      type: "EOF",
      value: "",
      line: this.line,
      col: this.col,
    });
    return this.tokens;
  }

  private isAlpha(ch: string): boolean {
    return /[a-zA-Z]/.test(ch);
  }

  private isAlnum(ch: string): boolean {
    return /[a-zA-Z0-9]/.test(ch);
  }

  private isDigit(ch: string): boolean {
    return /[0-9]/.test(ch);
  }
}

export function tokenize(source: string): Token[] {
  return new DSLLexer(source).tokenize();
}
