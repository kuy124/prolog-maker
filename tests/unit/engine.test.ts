import { describe, expect, it } from 'vitest';
import SWIPL from 'swipl-wasm';
import {
  PrologEngine,
  PrologError,
  bootEngine,
  describeError,
  parseSyntaxError,
  type OutputSink,
  type SwiplInstance,
} from '../../src/engine/engine';
import { decodeBindings, formatTerm } from '../../src/model/term';

/**
 * These tests run the real WebAssembly build in Node.
 *
 * Not a mock: it is the same `swipl-wasm` binary the browser loads, so a change
 * in the engine's JSON bridge breaks a test here rather than a user's session.
 * Boot costs a few hundred milliseconds, shared across the file.
 *
 * Every test gets a fresh engine over the *same* instance, because several of
 * them are about repeated loading leaving no residue. The instance is booted
 * through `bootEngine` rather than directly, because the output routing it sets
 * up is part of what is being tested: a syntax error is reported on stderr, so
 * an engine that cannot see stderr cannot report one.
 */
const sink: OutputSink = { current: () => {} };
const instance = (await bootEngine(
  SWIPL as unknown as (options: Record<string, unknown>) => Promise<unknown>,
  sink,
  { arguments: ['-q'] },
)) as SwiplInstance;

const PROGRAM = [
  'likes(ada, prolog).',
  'likes(ada, tea).',
  'likes(bo, prolog).',
  'pair(X, Y) :- likes(X, Z), likes(Y, Z), X \\== Y.',
  '',
].join('\n');

function engine(): PrologEngine {
  return new PrologEngine(instance, sink);
}

/**
 * Every solution of a goal, as decoded text per variable.
 *
 * The handle is closed in a `finally`. That is not tidiness: the engine bridge
 * has one query slot, so a handle abandoned part-way leaves every later call
 * failing with `Unknown procedure` — including calls to predicates that are
 * still loaded. A test helper that forgot this would poison the rest of the file.
 */
function solutions(prolog: PrologEngine, goal: string): Array<Record<string, string>> {
  const { handle } = prolog.open(goal);
  const rows: Array<Record<string, string>> = [];
  try {
    for (let solution = handle.next(); solution; solution = handle.next()) {
      const decoded = decodeBindings(solution.bindings as Record<string, unknown>);
      rows.push(Object.fromEntries(Object.entries(decoded).map(([k, v]) => [k, formatTerm(v)])));
    }
  } finally {
    handle.close();
  }
  return rows;
}

/**
 * One named binding from every solution.
 *
 * `findall/3` reports its template variable as unbound alongside the list, so
 * asserting on the whole row would be asserting on that quirk rather than on the
 * thing under test.
 */
function column(prolog: PrologEngine, goal: string, name: string): string[] {
  return solutions(prolog, goal).map((row) => row[name] ?? '');
}

describe('check', () => {
  it('accepts a valid program', () => {
    expect(engine().check(PROGRAM)).toBeNull();
  });

  it('accepts an empty program', () => {
    expect(engine().check('')).toBeNull();
    expect(engine().check('   \n\n  ')).toBeNull();
  });

  it('reports the line of a syntax error', () => {
    expect(engine().check('a(1).\nb(2.\nc(3).\n')).toMatchObject({ line: 2 });
  });

  it('reports a line for an unterminated quote', () => {
    expect(engine().check("a(1).\nb('oops).\n")).toMatchObject({ line: 2 });
  });

  it('reports the line of a late error, not the first line', () => {
    expect(engine().check('a(1).\nb(2).\nc(3).\nd(4).\nbad(.\n')).toMatchObject({ line: 5 });
  });

  it('accepts directives and operator syntax', () => {
    expect(engine().check(':- dynamic(foo/1).\nfoo(1).\nx is 1 + 2.\n')).toBeNull();
  });

  it('accepts a program that is mostly blank lines', () => {
    expect(engine().check('\n\n  \na(1).\n\n')).toBeNull();
  });
});

describe('consult', () => {
  it('loads a program and makes its predicates callable', () => {
    const prolog = engine();
    prolog.consult(PROGRAM);
    expect(solutions(prolog, 'likes(ada, X).')).toEqual([{ X: 'prolog' }, { X: 'tea' }]);
  });

  it('replaces rather than appends, so re-consulting is idempotent', () => {
    const prolog = engine();
    prolog.consult('v(1).\n');
    prolog.consult('v(2).\n');
    expect(column(prolog, 'findall(X, v(X), L).', 'L')).toEqual(['[2]']);
  });

  it('keeps working when a previous query still has alternatives pending', () => {
    // This is the state the console is always in: a solution shown, `Next` not
    // yet pressed. The bridge holds one query slot, so a second query would fail
    // outright — consulting closes the open handle instead of corrupting the
    // engine, and the program still loads.
    const prolog = engine();
    prolog.consult(PROGRAM);
    const { handle } = prolog.open('likes(ada, X).');
    expect(handle.next()).not.toBeNull();

    expect(() => prolog.consult('v(7).\n')).not.toThrow();
    expect(column(prolog, 'v(X).', 'X')).toEqual(['7']);
    // Consulting closed the stale handle rather than leaving it dangling.
    expect(handle.closed).toBe(true);
    expect(handle.next()).toBeNull();
  });

  it('leaves the previous program loaded when the new one does not parse', () => {
    const prolog = engine();
    prolog.consult(PROGRAM);
    expect(() => prolog.consult('w(1).\nbroken(.\n')).toThrow(PrologError);
    // Still the old program, not a half-loaded one.
    expect(solutions(prolog, 'likes(ada, X).')).toHaveLength(2);
  });

  it('reports the line of the error it refused', () => {
    const prolog = engine();
    try {
      prolog.consult('ok(1).\nbroken(.\n');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(PrologError);
      expect((error as PrologError).line).toBe(2);
    }
  });

  it('loads a knowledge base written as ordinary clauses', () => {
    // Facts are clauses now, so a program may read a predicate it also defines —
    // which the old separate facts file could not express.
    const prolog = engine();
    prolog.consult('person(ada, 36).\nperson(kid, 9).\nadult(X) :- person(X, A), A >= 18.\n');
    expect(solutions(prolog, 'adult(X).')).toEqual([{ X: 'ada' }]);
  });

  it('survives many reloads without the knowledge base growing', () => {
    const prolog = engine();
    for (let i = 0; i < 5; i += 1) prolog.consult('v(1).\n');
    expect(column(prolog, 'findall(X, v(X), L).', 'L')).toEqual(['[1]']);
  });
});

describe('open', () => {
  it('names the variables in the order the goal mentions them', () => {
    const prolog = engine();
    prolog.consult(PROGRAM);
    expect(prolog.open('pair(From, To).').variables).toEqual(['From', 'To']);
  });

  it('omits anonymous variables', () => {
    const prolog = engine();
    prolog.consult(PROGRAM);
    expect(prolog.open('likes(X, _).').variables).toEqual(['X']);
  });

  it('reports no variables for a ground goal', () => {
    const prolog = engine();
    prolog.consult(PROGRAM);
    expect(prolog.open('fail.').variables).toEqual([]);
  });
});

describe('enumeration', () => {
  it('walks every solution and then stops', () => {
    const prolog = engine();
    prolog.consult(PROGRAM);
    expect(solutions(prolog, 'likes(ada, X).')).toHaveLength(2);
  });

  it('marks the final solution as having no alternatives left', () => {
    const prolog = engine();
    prolog.consult('one(1).\n');
    expect(prolog.open('one(X).').handle.next()).toMatchObject({ more: false });
  });

  it('marks an earlier solution as having more', () => {
    const prolog = engine();
    prolog.consult(PROGRAM);
    const { handle } = prolog.open('likes(ada, X).');
    expect(handle.next()).toMatchObject({ more: true });
    handle.close();
  });

  it('returns null for a goal with no solutions', () => {
    const prolog = engine();
    prolog.consult(PROGRAM);
    expect(prolog.open('likes(zed, X).').handle.next()).toBeNull();
  });

  it('returns one solution with no bindings for a ground goal that succeeds', () => {
    const prolog = engine();
    prolog.consult(PROGRAM);
    expect(solutions(prolog, 'likes(ada, prolog).')).toEqual([{}]);
  });

  it('stops returning solutions after close', () => {
    const prolog = engine();
    prolog.consult(PROGRAM);
    const { handle } = prolog.open('likes(ada, X).');
    expect(handle.next()).not.toBeNull();
    handle.close();
    expect(handle.next()).toBeNull();
  });

  it('does not leave the engine unusable after an abandoned query', () => {
    // The failure this guards against is silent and looks like the program
    // vanished: every later goal reports `Unknown procedure`.
    const prolog = engine();
    prolog.consult(PROGRAM);
    const { handle } = prolog.open('likes(ada, X).');
    handle.next();
    handle.close();
    expect(column(prolog, 'likes(ada, X).', 'X')).toEqual(['prolog', 'tea']);
  });
});

describe('errors', () => {
  it('raises an undefined procedure as an error, not as no solutions', () => {
    const prolog = engine();
    prolog.consult(PROGRAM);
    expect(() => prolog.open('nope(1).').handle.next()).toThrow(/Unknown procedure/);
  });

  it('raises a division by zero from the goal body', () => {
    const prolog = engine();
    prolog.consult(PROGRAM);
    expect(() => prolog.open('X is 1/0.').handle.next()).toThrow(/Division by zero/);
  });
});

describe('parseSyntaxError', () => {
  it('reads the line, column and reason out of a load message', () => {
    expect(
      parseSyntaxError('ERROR: [Thread main] /tmp/room/check1.pl:2:8: Syntax error: Unexpected end of clause'),
    ).toEqual({ line: 2, message: 'Unexpected end of clause' });
  });

  it('does not confuse a colon in the message for a position', () => {
    expect(parseSyntaxError('ERROR: x.pl:7:2: Syntax error: Operator expected: check this')).toEqual({
      line: 7,
      message: 'Operator expected: check this',
    });
  });

  it('returns null for output with no error in it', () => {
    expect(parseSyntaxError('')).toBeNull();
    expect(parseSyntaxError('Warning: something')).toBeNull();
  });
});

describe('describeError', () => {
  it('names a syntax error', () => {
    expect(describeError('syntax_error(operator_expected)').message).toBe('Syntax error: operator expected.');
  });

  it('names an unknown procedure and drops the bridge prefix', () => {
    expect(describeError('wasm:wasm_call_string/3: Unknown procedure: likes/2').message).toBe(
      'Unknown procedure: likes/2',
    );
  });

  it('keeps an unrecognised message rather than inventing one', () => {
    expect(describeError('something odd').message).toBe('something odd');
  });
});
