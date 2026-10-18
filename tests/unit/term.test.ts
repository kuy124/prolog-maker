import { describe, expect, it } from 'vitest';
import {
  decodeTerm,
  decodeBindings,
  formatTerm,
  formatNumber,
  quoteAtom,
  needsQuotes,
  isEmptySolution,
  type Term,
} from '../../src/model/term';

describe('quoteAtom', () => {
  it('leaves a plain lowercase atom alone', () => {
    expect(quoteAtom('ada')).toBe('ada');
    expect(quoteAtom('person_2')).toBe('person_2');
  });

  it('quotes an atom that starts with a capital, so it does not read as a variable', () => {
    expect(quoteAtom('Ada')).toBe("'Ada'");
  });

  it('quotes an atom with a space', () => {
    expect(quoteAtom('hello world')).toBe("'hello world'");
  });

  it('doubles an embedded single quote', () => {
    expect(quoteAtom("it's")).toBe("'it''s'");
  });

  it('escapes a backslash', () => {
    expect(quoteAtom('a\\b')).toBe("'a\\\\b'");
  });

  it('escapes a newline rather than emitting a raw one', () => {
    expect(quoteAtom('a\nb')).toBe("'a\\nb'");
  });

  it('leaves symbolic atoms unquoted', () => {
    expect(quoteAtom('+')).toBe('+');
    expect(quoteAtom('=..')).toBe('=..');
  });

  it('leaves the empty list and cut alone', () => {
    expect(quoteAtom('[]')).toBe('[]');
    expect(quoteAtom('!')).toBe('!');
  });

  it('quotes the empty atom, which is otherwise unwritable', () => {
    expect(quoteAtom('')).toBe("''");
  });

  it('agrees with needsQuotes', () => {
    expect(needsQuotes('ada')).toBe(false);
    expect(needsQuotes('Ada')).toBe(true);
  });
});

describe('formatNumber', () => {
  it('prints an integer without a decimal point', () => {
    expect(formatNumber(42)).toBe('42');
  });

  it('prints a negative integer', () => {
    expect(formatNumber(-7)).toBe('-7');
  });

  it('prints a float', () => {
    expect(formatNumber(3.5)).toBe('3.5');
  });

  it('does not switch a large safe integer to exponent notation', () => {
    expect(formatNumber(10000000000)).toBe('10000000000');
  });
});

describe('decodeTerm', () => {
  it('decodes a string as an atom', () => {
    expect(formatTerm(decodeTerm('ada'))).toBe('ada');
  });

  it('quotes a string that would not read back as the same atom', () => {
    expect(formatTerm(decodeTerm('hello world'))).toBe("'hello world'");
  });

  it('decodes a number', () => {
    expect(formatTerm(decodeTerm(42))).toBe('42');
  });

  it('decodes an empty list', () => {
    expect(formatTerm(decodeTerm([]))).toBe('[]');
  });

  it('decodes a proper list', () => {
    expect(formatTerm(decodeTerm([1, 2, 3]))).toBe('[1,2,3]');
  });

  it('decodes an improper list', () => {
    expect(formatTerm(decodeTerm({ $t: 'l', v: ['a'], t: 'b' }))).toBe('[a|b]');
  });

  it('decodes a compound with one argument', () => {
    expect(formatTerm(decodeTerm({ $t: 't', f: [['a']] }))).toBe('f(a)');
  });

  it('decodes a compound with several arguments', () => {
    expect(formatTerm(decodeTerm({ $t: 't', f: [['a', 'b']] }))).toBe('f(a,b)');
  });

  it('decodes a nested compound', () => {
    expect(formatTerm(decodeTerm({ $t: 't', f: [[{ $t: 't', g: [['a']] }, [1, 2]]] }))).toBe('f(g(a),[1,2])');
  });

  it('prints an unbound variable with the name it was bound to', () => {
    const variables = new Map([[7, 'X']]);
    expect(formatTerm(decodeTerm({ $t: 'v', v: 7 }, variables))).toBe('X');
  });

  it('gives an unnamed variable a stable generated name', () => {
    const variables = new Map<number, string>();
    const first = formatTerm(decodeTerm({ $t: 'v', v: 12 }, variables));
    const second = formatTerm(decodeTerm({ $t: 'v', v: 12 }, variables));
    expect(first).toBe('_G12');
    expect(second).toBe('_G12');
  });

  it('prints two occurrences of the same variable the same way', () => {
    const variables = new Map<number, string>();
    const term = { $t: 't', '=': [[{ $t: 'v', v: 3 }, { $t: 'v', v: 3 }]] };
    expect(formatTerm(decodeTerm(term, variables))).toBe('_G3 = _G3');
  });

  it('decodes a blob without trying to interpret it', () => {
    expect(formatTerm(decodeTerm({ $t: 'b' }))).toBe('<blob>');
  });

  it('decodes a dict', () => {
    expect(formatTerm(decodeTerm({ a: 1, b: 'two' }))).toBe('_{a:1,b:two}');
  });

  it('decodes the empty dict', () => {
    expect(formatTerm(decodeTerm({}))).toBe('_{}');
  });
});

describe('formatTerm operators', () => {
  it('prints an arithmetic compound infix', () => {
    const term: Term = {
      kind: 'compound',
      functor: '+',
      args: [
        { kind: 'number', text: '1' },
        { kind: 'number', text: '2' },
      ],
    };
    expect(formatTerm(term)).toBe('1 + 2');
  });

  it('prints a prefix operator with a space', () => {
    const term: Term = {
      kind: 'compound',
      functor: '\\+',
      args: [{ kind: 'atom', name: 'foo', quoted: false }],
    };
    expect(formatTerm(term)).toBe('\\+ foo');
  });

  it('parenthesises a nested operator so the meaning cannot change', () => {
    const term: Term = {
      kind: 'compound',
      functor: '*',
      args: [
        {
          kind: 'compound',
          functor: '+',
          args: [
            { kind: 'number', text: '1' },
            { kind: 'number', text: '2' },
          ],
        },
        { kind: 'number', text: '3' },
      ],
    };
    expect(formatTerm(term)).toBe('(1 + 2) * 3');
  });

  it('prints a unary minus compound with a space, so it is not read as a negative number', () => {
    const term: Term = {
      kind: 'compound',
      functor: '-',
      args: [{ kind: 'number', text: '1' }],
    };
    expect(formatTerm(term)).toBe('- 1');
  });
});

describe('decodeBindings', () => {
  it('names an unbound variable after the binding that holds it', () => {
    // `?- X = Y.` binds both to the same variable, so they must print as X and Y
    // rather than as two different generated names.
    const decoded = decodeBindings({ $tag: 'bindings', X: { $t: 'v', v: 5 }, Y: { $t: 'v', v: 5 } });
    expect(formatTerm(decoded.X!)).toBe('X');
    expect(formatTerm(decoded.Y!)).toBe('Y');
  });

  it('drops the bridge tag and success flag', () => {
    const decoded = decodeBindings({ $tag: 'bindings', success: true, X: 'ada' });
    expect(Object.keys(decoded)).toEqual(['X']);
  });

  it('returns an empty record for a ground goal', () => {
    expect(isEmptySolution(decodeBindings({ $tag: 'bindings', success: true }))).toBe(true);
  });
});
