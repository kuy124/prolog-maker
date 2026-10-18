/**
 * A Prolog syntax mode for the textarea overlay.
 *
 * Written by hand because no ready-made one exists: `@codemirror/legacy-modes`
 * ships about ninety languages and Prolog is not among them, and the one
 * community package is a 0.1.0 stub. The rules here are the ones that make Prolog
 * *look* like Prolog — `%` comments, quoted atoms, variables that start with a
 * capital, and the handful of directives that matter at a glance.
 *
 * This is deliberately a tokeniser and not a parser. Colouring a clause is a
 * presentation problem; whether the clause is *valid* is answered by the engine,
 * which is the only thing that can answer it correctly.
 */

export type TokenKind =
  | 'comment'
  | 'string'
  | 'atom'
  | 'variable'
  | 'number'
  | 'keyword'
  | 'operator'
  | 'punctuation'
  | 'plain';

export interface Token {
  kind: TokenKind;
  text: string;
  start: number;
}

const KEYWORDS = new Set([
  'is', 'not', 'mod', 'rem', 'div', 'true', 'false', 'fail', 'repeat',
]);

const DIRECTIVE = /^:-/;

/**
 * Splits Prolog source into tokens.
 *
 * Order matters: a `%` inside a quoted atom is not a comment, and a quote inside
 * a comment does not open a string. The scanner therefore walks the source once,
 * left to right, and each rule consumes as much as it claims — which is the only
 * way to get nested cases right without a full grammar.
 */
export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  const push = (kind: TokenKind, start: number, end: number) => {
    tokens.push({ kind, text: source.slice(start, end), start });
  };

  while (i < source.length) {
    const char = source[i]!;
    const start = i;

    // Whitespace is emitted as plain so the renderer can reproduce spacing.
    if (/\s/.test(char)) {
      while (i < source.length && /\s/.test(source[i]!)) i += 1;
      push('plain', start, i);
      continue;
    }

    // A line comment runs to the end of the line.
    if (char === '%') {
      while (i < source.length && source[i] !== '\n') i += 1;
      push('comment', start, i);
      continue;
    }

    // A block comment does not nest in Prolog, and may span lines.
    if (char === '/' && source[i + 1] === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i = Math.min(i + 2, source.length);
      push('comment', start, i);
      continue;
    }

    // A quoted atom: '' is an escaped quote, and it may span lines.
    if (char === "'") {
      i += 1;
      while (i < source.length) {
        if (source[i] === "'" && source[i + 1] === "'") {
          i += 2;
          continue;
        }
        if (source[i] === "'") {
          i += 1;
          break;
        }
        i += 1;
      }
      push('atom', start, i);
      continue;
    }

    // A string: \" is an escape.
    if (char === '"') {
      i += 1;
      while (i < source.length) {
        if (source[i] === '\\') {
          i += 2;
          continue;
        }
        if (source[i] === '"') {
          i += 1;
          break;
        }
        i += 1;
      }
      push('string', start, i);
      continue;
    }

    // A variable: capital or underscore, then letters, digits and underscores.
    if (/[A-Z_]/.test(char)) {
      i += 1;
      while (i < source.length && /[A-Za-z0-9_]/.test(source[i]!)) i += 1;
      push('variable', start, i);
      continue;
    }

    // A number, including floats and exponents.
    if (/[0-9]/.test(char)) {
      i += 1;
      while (i < source.length && /[0-9]/.test(source[i]!)) i += 1;
      if (source[i] === '.' && /[0-9]/.test(source[i + 1] ?? '')) {
        i += 1;
        while (i < source.length && /[0-9]/.test(source[i]!)) i += 1;
      }
      if (/[eE]/.test(source[i] ?? '')) {
        i += 1;
        if (/[+-]/.test(source[i] ?? '')) i += 1;
        while (i < source.length && /[0-9]/.test(source[i]!)) i += 1;
      }
      push('number', start, i);
      continue;
    }

    // An unquoted atom, or a keyword such as `is`.
    if (/[a-z]/.test(char)) {
      i += 1;
      while (i < source.length && /[A-Za-z0-9_]/.test(source[i]!)) i += 1;
      const word = source.slice(start, i);
      push(KEYWORDS.has(word) ? 'keyword' : 'plain', start, i);
      continue;
    }

    // A directive is the one two-character sequence worth its own colour.
    if (char === ':' && source[i + 1] === '-') {
      i += 2;
      push('keyword', start, i);
      continue;
    }

    // Symbolic operators, greedily. A lone `.` is excluded: it ends a clause, so
    // it must reach the punctuation rule below rather than becoming an operator.
    if (/[+\-*/\\^<>=~:.?@#&$!;|]/.test(char)) {
      i += 1;
      while (i < source.length && /[+\-*/\\^<>=~:.?@#&$!;|]/.test(source[i]!)) i += 1;
      const text = source.slice(start, i);
      push(text === '.' ? 'punctuation' : 'operator', start, i);
      continue;
    }

    // Brackets, commas and full stops.
    if (/[()[\]{},]/.test(char)) {
      i += 1;
      push('punctuation', start, i);
      continue;
    }

    i += 1;
    push('plain', start, i);
  }

  void DIRECTIVE;
  return tokens;
}
