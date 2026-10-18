import { describe, expect, it } from 'vitest';
import SWIPL from 'swipl-wasm';
import {
  PrologEngine,
  bootEngine,
  type OutputSink,
  type SwiplInstance,
} from '../../src/engine/engine';
import { dynamicIndicators, factsWithDynamic } from '../../src/engine/facts';

const sink: OutputSink = { current: () => {} };
const instance = (await bootEngine(
  SWIPL as unknown as (o: Record<string, unknown>) => Promise<unknown>,
  sink,
  { arguments: ['-q'] },
)) as SwiplInstance;

/**
 * No setInput: the shim's queue only exists once a program has been consulted,
 * and nothing in this file reads.
 */
function fresh(): PrologEngine {
  return new PrologEngine(instance, sink);
}

describe('dynamicIndicators', () => {
  it('reads the head and the arity', () => {
    expect(dynamicIndicators('observation(ada).')).toEqual(['observation/1']);
    expect(dynamicIndicators('parent(bo, eli).')).toEqual(['parent/2']);
  });

  it('handles a zero-arity fact', () => {
    expect(dynamicIndicators('sede.')).toEqual(['sede/0']);
  });

  it('does not split on a comma inside a quoted atom', () => {
    // The reason a plain `split(',')` is wrong: this is one argument, not two.
    expect(dynamicIndicators("name('Ada, Lovelace').")).toEqual(['name/1']);
  });

  it('does not split on a comma inside a nested list', () => {
    expect(dynamicIndicators('data([a, b, c]).')).toEqual(['data/1']);
    expect(dynamicIndicators('data({a, b}).')).toEqual(['data/1']);
  });

  it('counts a nested argument as one', () => {
    expect(dynamicIndicators('at(point(1, 2), top).')).toEqual(['at/2']);
  });

  it('skips anything it cannot read with confidence', () => {
    // Wrong indicators would declare predicates the facts never defined and break an
    // unrelated program, so these yield nothing rather than a guess.
    expect(dynamicIndicators('p(a) :- q.')).toEqual([]);
    expect(dynamicIndicators('X = Y.')).toEqual([]);
    expect(dynamicIndicators("'Ada'.  ")).toEqual([]);
    expect(dynamicIndicators('this is (not prolog')).toEqual([]);
  });

  it('de-duplicates a predicate defined by several facts', () => {
    expect(dynamicIndicators('parent(ada, bo).\nparent(ada, eli).')).toEqual(['parent/2']);
  });

  it('has nothing to declare for an empty facts file', () => {
    expect(dynamicIndicators('')).toEqual([]);
    expect(dynamicIndicators('\n\n')).toEqual([]);
  });
});

describe('factsWithDynamic', () => {
  it('puts the declaration before the clauses', () => {
    // Order matters: a predicate defined by clauses is static, so a declaration that
    // comes after the clauses is too late to matter.
    expect(factsWithDynamic('observation(ada).')).toBe(
      ':- catch(dynamic(observation/1), _, true).\nobservation(ada).',
    );
  });

  it('catches each declaration separately', () => {
    // A fact named `fail` would otherwise raise a permission error from `dynamic/0`
    // and take the whole consult down with it.
    expect(factsWithDynamic('fail.\nnot(a).')).toBe(
      ':- catch(dynamic(fail/0), _, true), catch(dynamic(not/1), _, true).\nfail.\nnot(a).',
    );
  });

  it('leaves a facts file with nothing declarable untouched', () => {
    expect(factsWithDynamic('')).toBe('');
    expect(factsWithDynamic('X = Y.')).toBe('X = Y.');
  });
});

/**
 * The reported failure, as it happened.
 *
 * A fact in the Facts panel became a clause in `facts.pl`, which made the predicate
 * static, and the program's `assert/1` was refused:
 *
 *     assert/1: No permission to modify static procedure observation/1
 *     Defined at /tmp/room/facts.pl:1
 *
 * The program had no `:- dynamic(observation/1).` of its own, which is the point: the
 * facts panel supplied one, and that ought to be enough.
 */
describe('a fact whose name a program asserts into', () => {
  /** Runs a goal to completion, returning whether it had a solution. */
  const solves = (goal: string): boolean => {
    const query = instance.prolog.query(goal);
    try {
      return query.next() != null;
    } finally {
      query.close();
    }
  };

  it('lets the program assert into it', () => {
    const engine = fresh();
    engine.consult('', 'observation(ada).');
    const { handle } = engine.open('assert(observation(pnj)).');
    try {
      // Before the fix this threw a permission error naming facts.pl.
      expect(() => handle.next()).not.toThrow();
    } finally {
      handle.close();
    }
  });

  it('keeps the fact and the assertion both', () => {
    const engine = fresh();
    engine.consult('', 'observation(ada).');
    const { handle } = engine.open('assert(observation(pnj)).');
    try {
      handle.next();
    } finally {
      handle.close();
    }
    expect(solves('observation(ada).')).toBe(true);
    expect(solves('observation(pnj).')).toBe(true);
  });

  it('stays dynamic when a keystroke re-consults the same facts', () => {
    // The editor re-consults on every debounced keystroke, so a declaration that were
    // lost on the second load would leave the program broken on the next character.
    const engine = fresh();
    engine.consult('', 'observation(ada).');
    engine.consult('', 'observation(ada).');
    const { handle } = engine.open('assert(observation(pnj)).');
    try {
      expect(() => handle.next()).not.toThrow();
    } finally {
      handle.close();
    }
  });

  it('consult replaces rather than appends, so nothing accumulates', () => {
    // One instance is shared by the whole file, so anything a previous test asserted is
    // still around. That is why each test that counts starts from a predicate no other
    // test touches.
    const engine = fresh();
    engine.consult('', 'sekali(1).');
    engine.consult('', 'sekali(1).');
    engine.consult('hitung(N) :- findall(X, sekali(X), L), length(L, N).', 'sekali(1).');
    const { handle } = engine.open('hitung(N).');
    try {
      expect(handle.next()?.bindings).toMatchObject({ N: 1 });
    } finally {
      handle.close();
    }
  });

  it('is unaffected by a program that declares the predicate itself', () => {
    const engine = fresh();
    engine.consult(':- dynamic(observation/1).', 'observation(ada).');
    const { handle } = engine.open('assert(observation(pnj)).');
    try {
      expect(() => handle.next()).not.toThrow();
    } finally {
      handle.close();
    }
  });

  it('leaves facts alone when the program only reads them', () => {
    const engine = fresh();
    engine.consult('hitung(X) :- sideways(bo, X).', 'sideways(bo, eli).');
    const { handle } = engine.open('hitung(Y).');
    try {
      expect(handle.next()?.bindings).toMatchObject({ Y: 'eli' });
    } finally {
      handle.close();
    }
  });
});
