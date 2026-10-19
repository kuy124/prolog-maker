import { describe, expect, it } from 'vitest';
import SWIPL from 'swipl-wasm';
import { EXAMPLES, exampleById } from '../../src/model/examples';
import { PrologEngine, bootEngine, type OutputSink } from '../../src/engine/engine';

/**
 * Every example is loaded and its goal is run, against the real engine.
 *
 * An example that has quietly stopped working is worse than no example: it is the
 * first thing a visitor tries, and it fails in front of them. Running them here
 * means a broken example fails the build instead.
 */
const sink: OutputSink = { current: () => {} };
const instance = await bootEngine(
  SWIPL as unknown as (o: Record<string, unknown>) => Promise<unknown>,
  sink,
  { arguments: ['-q'] },
);

describe('examples', () => {
  it('has a unique id and name for each', () => {
    expect(new Set(EXAMPLES.map((e) => e.id)).size).toBe(EXAMPLES.length);
    expect(new Set(EXAMPLES.map((e) => e.name)).size).toBe(EXAMPLES.length);
  });

  it('looks one up by id', () => {
    expect(exampleById('family')?.name).toBe('Family tree');
    expect(exampleById('nope')).toBeUndefined();
  });

  for (const example of EXAMPLES) {
    it(`${example.id}: loads without a syntax error`, () => {
      const prolog = new PrologEngine(instance, sink);
      expect(prolog.check(example.program)).toBeNull();
      expect(() => prolog.consult(example.program)).not.toThrow();
    });

    it(`${example.id}: its goal produces at least one solution`, () => {
      const prolog = new PrologEngine(instance, sink);
      prolog.consult(example.program);
      const { handle } = prolog.open(example.goal);
      try {
        expect(handle.next(), `${example.id}: ${example.goal}`).not.toBeNull();
      } finally {
        handle.close();
      }
    });
  }

  it('the eight queens example finds a real solution', () => {
    const prolog = new PrologEngine(instance, sink);
    prolog.consult(exampleById('queens')!.program);
    const { handle } = prolog.open('queens(8, Qs).');
    try {
      const solution = handle.next();
      expect(solution).not.toBeNull();
      // The bridge encodes a list of integers as a plain array.
      const queens = solution!.bindings.Qs as unknown as number[];
      expect(queens).toHaveLength(8);
      // A solution is a permutation of 1..8, which is the cheapest strong check.
      expect([...queens].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    } finally {
      handle.close();
    }
  });

  it('the grammar example accepts the sentence it claims to', () => {
    const prolog = new PrologEngine(instance, sink);
    prolog.consult(exampleById('grammar')!.program);
    const { handle } = prolog.open(exampleById('grammar')!.goal);
    try {
      expect(handle.next()).not.toBeNull();
    } finally {
      handle.close();
    }
  });

  it('the grammar example rejects a sentence that does not parse', () => {
    const prolog = new PrologEngine(instance, sink);
    prolog.consult(exampleById('grammar')!.program);
    // `the cat chases` is grammatical — `verb_phrase --> verb` needs no object —
    // so the sentence that must fail is one with a word left over.
    const { handle } = prolog.open('phrase(sentence, [the, cat, chases, a, dog, cat], []).');
    try {
      expect(handle.next()).toBeNull();
    } finally {
      handle.close();
    }
  });

  it('the family example answers a recursive query', () => {
    const prolog = new PrologEngine(instance, sink);
    prolog.consult(exampleById('family')!.program);
    const { handle } = prolog.open('ancestor(ada, Who).');
    const found: unknown[] = [];
    try {
      for (let solution = handle.next(); solution; solution = handle.next()) {
        found.push(solution.bindings.Who);
      }
    } finally {
      handle.close();
    }
    expect(found).toContain('cy');
    expect(found).toContain('dee');
  });
});
