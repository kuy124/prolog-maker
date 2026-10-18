import { describe, expect, it } from 'vitest';
import { tokenize, type Token } from '../../src/editor/tokenize';

/** The token kinds, ignoring whitespace, for compact assertions. */
function kinds(source: string): string[] {
  return tokenize(source)
    .filter((token) => token.kind !== 'plain' || token.text.trim().length > 0)
    .map((token) => `${token.kind}:${token.text}`);
}

function kindsOnly(source: string): string[] {
  return tokenize(source)
    .filter((token) => token.text.trim().length > 0)
    .map((token) => token.kind);
}

describe('tokenize', () => {
  it('marks a line comment to the end of the line only', () => {
    const tokens = tokenize('% a comment\nfoo.');
    expect(tokens[0]).toMatchObject({ kind: 'comment', text: '% a comment' });
    expect(tokens.some((token) => token.text === 'foo')).toBe(true);
  });

  it('marks a block comment, including across lines', () => {
    const tokens = tokenize('/* one\ntwo */ foo.');
    expect(tokens[0]).toMatchObject({ kind: 'comment', text: '/* one\ntwo */' });
  });

  it('does not treat a % inside a quoted atom as a comment', () => {
    const tokens = tokenize("'50% off'.");
    expect(tokens[0]).toMatchObject({ kind: 'atom', text: "'50% off'" });
    expect(tokens.some((token) => token.kind === 'comment')).toBe(false);
  });

  it('does not treat a quote inside a comment as a string', () => {
    const tokens = tokenize("% it's fine\nfoo.");
    expect(tokens[0]).toMatchObject({ kind: 'comment' });
    expect(tokens.some((token) => token.kind === 'string')).toBe(false);
  });

  it('reads an escaped quote inside a quoted atom', () => {
    expect(kinds("'it''s'.")[0]).toBe("atom:'it''s'");
  });

  it('reads a string with an escaped quote', () => {
    expect(kindsOnly('"a\\"b"')).toEqual(['string']);
  });

  it('marks variables, including underscore-prefixed ones', () => {
    expect(kindsOnly('X _Y Foo')).toEqual(['variable', 'variable', 'variable']);
  });

  it('marks integers and floats', () => {
    expect(kindsOnly('1 3.5 1.0e10')).toEqual(['number', 'number', 'number']);
  });

  it('does not swallow a full stop that follows a number as part of the number', () => {
    // `foo(1).` must end with a punctuation token, or the clause end is invisible.
    const tokens = tokenize('foo(1).');
    expect(tokens[tokens.length - 1]).toMatchObject({ kind: 'punctuation', text: '.' });
  });

  it('marks a keyword', () => {
    expect(kinds('X is 1 + 2')).toContain('keyword:is');
  });

  it('marks a directive', () => {
    expect(kindsOnly(':- dynamic(foo/1).')[0]).toBe('keyword');
  });

  it('marks symbolic operators greedily', () => {
    expect(kinds('a =\\= b')).toContain('operator:=\\=');
  });

  it('marks brackets, commas and braces as punctuation', () => {
    expect(kindsOnly('f(a,b)')).toEqual(['plain', 'punctuation', 'plain', 'punctuation', 'plain', 'punctuation']);
  });

  it('preserves the source exactly when the tokens are concatenated', () => {
    const source = "foo(X) :- bar(X), % note\n  X > 1. /* end */\n'quoted atom'.";
    const joined = tokenize(source)
      .map((token) => token.text)
      .join('');
    expect(joined).toBe(source);
  });

  it('reports the start offset of every token', () => {
    const source = 'foo(X).';
    for (const token of tokenize(source)) {
      expect(source.slice(token.start, token.start + token.text.length)).toBe(token.text);
    }
  });

  it('handles an unterminated quote without looping', () => {
    const tokens: Token[] = tokenize("foo('unterminated");
    expect(tokens.length).toBeGreaterThan(0);
    expect(tokens[tokens.length - 1]!.text).toBe("'unterminated");
  });

  it('handles empty input', () => {
    expect(tokenize('')).toEqual([]);
  });
});
