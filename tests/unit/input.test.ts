import { describe, expect, it } from 'vitest';
import SWIPL from 'swipl-wasm';
import {
  PrologEngine,
  bootEngine,
  encodeAnswer,
  type OpenQuery,
  type OutputSink,
  type SwiplInstance,
} from '../../src/engine/engine';
import { decodeBindings, formatTerm } from '../../src/model/term';

/**
 * Interactive input and the transcript.
 *
 * Both of these exist because of how the WebAssembly build behaves, and neither
 * could have been guessed:
 *
 *   - `read/1` cannot be fed from JavaScript. Emscripten's stdin hook only reads
 *     `process.stdin` under Node or `window.prompt` in a window; a Web Worker has
 *     neither, so `user_input` is permanently at end-of-file. Answers therefore go
 *     in through a Prolog string stream.
 *
 *   - Newlines never reach the `print` callback. Emscripten's TTY flushes on
 *     character 10 and then discards the character, which is right for a terminal
 *     and wrong for a transcript. Output is therefore read from a file.
 *
 * The program used here is a real questionnaire, because "the transcript looks
 * right" is only meaningful for output that is mostly prose and line breaks.
 */
const sink: OutputSink = { current: () => {} };
const instance = (await bootEngine(
  SWIPL as unknown as (options: Record<string, unknown>) => Promise<unknown>,
  sink,
  { arguments: ['-q'] },
)) as SwiplInstance;

/** A miniature expert system: ask, read, decide. */
const QUESTIONNAIRE = [
  'ask(Q, A) :-',
  '    write(Q), nl,',
  '    read(A),',
  '    (   A == y',
  '    ->  write(yes), nl',
  '    ;   write(no), nl',
  '    ).',
  'start :- ask(pertama, _), ask(kedua, _), write(selesai), nl.',
  '',
].join('\n');

/** Reads one bound variable out of a solution, the way the console renders it. */
function answer(handle: OpenQuery, name: string): string {
  const solution = handle.next();
  if (!solution?.bindings) return '<no solution>';
  const decoded = decodeBindings(solution.bindings as Record<string, unknown>);
  const term = decoded[name];
  return term ? formatTerm(term) : '<unbound>';
}

function fresh(): PrologEngine {
  const engine = new PrologEngine(instance, sink);
  engine.consult(QUESTIONNAIRE, '');
  engine.resetOutput();
  return engine;
}

describe('encodeAnswer', () => {
  it('terminates a bare atom, because read/1 parses a term', () => {
    // `read/1` needs the full stop: `y` on its own is an unterminated term and
    // the read fails with a syntax error rather than reading the next answer.
    expect(encodeAnswer('y')).toBe('y.');
  });

  it('leaves a line that is already terminated alone', () => {
    expect(encodeAnswer('y.')).toBe('y.');
  });

  it('accepts a compound answer', () => {
    expect(encodeAnswer('person(ada)')).toBe('person(ada).');
  });

  it('trims surrounding whitespace', () => {
    expect(encodeAnswer('  t \n')).toBe('t.');
  });

  it('drops a blank line rather than encoding an empty term', () => {
    // There is no term for an empty line, so a stray Enter must not become a
    // syntax error partway through a questionnaire.
    expect(encodeAnswer('')).toBeNull();
    expect(encodeAnswer('   ')).toBeNull();
  });
});

describe('reading answers', () => {
  it('reads answers in the order they were queued', () => {
    const engine = fresh();
    engine.setInput(['y', 't', 'y']);
    const { handle } = engine.open('start.');
    try {
      expect(handle.next()).not.toBeNull();
    } finally {
      handle.close();
    }
    expect(engine.takeOutput()).toBe('pertama\nyes\nkedua\nno\nselesai\n');
  });

  it('returns end_of_file once the answers run out', () => {
    const engine = fresh();
    engine.setInput(['y']);
    const { handle } = engine.open('ask(pertama, A).');
    let first: ReturnType<PrologEngine['open']>['handle'] | null = handle;
    try {
      expect(answer(handle, 'A')).toBe('y');
    } finally {
      handle.close();
    }
    // A terminal top-level loop ends when input ends, and so does this one, which
    // is what lets a program written for a terminal still work.
    const second = engine.open('ask(kedua, A).');
    first = second.handle;
    try {
      expect(answer(first, 'A')).toBe('end_of_file');
    } finally {
      first.close();
    }
  });

  it('treats an empty queue as end-of-file rather than as an error', () => {
    const engine = fresh();
    engine.setInput([]);
    const { handle } = engine.open('ask(pertama, A).');
    try {
      expect(answer(handle, 'A')).toBe('end_of_file');
    } finally {
      handle.close();
    }
  });

  it('replaces the answers on a second run rather than appending', () => {
    const engine = fresh();
    engine.setInput(['y', 'y']);
    const first = engine.open('start.');
    try {
      first.handle.next();
    } finally {
      first.handle.close();
    }
    expect(engine.takeOutput()).toContain('selesai');

    engine.resetOutput();
    engine.setInput(['t']);
    const second = engine.open('ask(pertama, _).');
    try {
      second.handle.next();
    } finally {
      second.handle.close();
    }
    expect(engine.takeOutput()).toBe('pertama\nno\n');
  });
});

describe('the transcript', () => {
  it('keeps the newlines that nl/0 writes', () => {
    // This is the whole reason output is read from a file. Emscripten's TTY
    // discards character 10 when it flushes, so through the bridge's `print`
    // callback this output arrives as 'pertimayeskeduanoselesai' — one run-on
    // paragraph with every line break gone.
    const engine = fresh();
    engine.setInput(['y', 't']);
    const { handle } = engine.open('start.');
    try {
      handle.next();
    } finally {
      handle.close();
    }
    expect(engine.takeOutput()).toBe('pertama\nyes\nkedua\nno\nselesai\n');
  });

  it('does not end a query when the transcript is read mid-enumeration', () => {
    // The bridge permits one open query at a time, so reading the transcript by
    // running a Prolog goal would close the query being stepped and silently end
    // its enumeration after the first solution. The transcript is line-buffered and
    // read from JavaScript precisely so this cannot happen — and it did, once,
    // which is why there is a test for it rather than only a comment.
    //
    // The goal has to be nondeterministic: a deterministic one has no second
    // solution to lose, and the test would pass whether or not the reader closed
    // the query.
    const engine = new PrologEngine(instance, sink);
    // `step(N)` first, so N is bound before it is printed: writing an unbound variable
// prints `_10862`, which would say nothing about which solution produced it.
    engine.consult('step(1).\nstep(2).\nstep(3).\nsay(N) :- step(N), write(sol(N)), nl.\n', '');
    engine.resetOutput();

    const { handle } = engine.open('say(N).');
    try {
      expect(handle.next()?.bindings).toMatchObject({ N: 1 });
      // The reader runs while the query is open and still has alternatives.
      expect(engine.takeOutput()).toBe('sol(1)\n');
      // Without the fix these never arrive: reading closed the query.
      expect(handle.next()?.bindings).toMatchObject({ N: 2 });
      expect(engine.takeOutput()).toBe('sol(2)\n');
      expect(handle.next()?.bindings).toMatchObject({ N: 3 });
      expect(engine.takeOutput()).toBe('sol(3)\n');
    } finally {
      handle.close();
    }
  });

  it('reports only what is new, so a long run streams instead of repeating', () => {
    const engine = fresh();
    engine.setInput(['y', 'y']);
    const { handle } = engine.open('start.');
    try {
      handle.next();
    } finally {
      handle.close();
    }
    expect(engine.takeOutput()).toBe('pertama\nyes\nkedua\nyes\nselesai\n');
    // Nothing has happened since, so a second drain is empty rather than a copy.
    expect(engine.takeOutput()).toBe('');
  });

  it('starts a run from a clean page', () => {
    const engine = fresh();
    engine.setInput(['y']);
    const first = engine.open('ask(satu, _).');
    try {
      first.handle.next();
    } finally {
      first.handle.close();
    }
    expect(engine.takeOutput()).toBe('satu\nyes\n');

    engine.resetOutput();
    engine.setInput(['t']);
    const second = engine.open('ask(dua, _).');
    try {
      second.handle.next();
    } finally {
      second.handle.close();
    }
    // A reset really resets: the second run shows only its own line.
    expect(engine.takeOutput()).toBe('dua\nno\n');
  });

  it('keeps whatever a failing goal managed to write before it failed', () => {
    const engine = fresh();
    engine.setInput(['y']);
    const { handle } = engine.open('ask(pertama, _), nope(1).');
    expect(() => handle.next()).toThrow(/Unknown procedure/);
    // A goal that writes and then dies still leaves a transcript: the text before
    // the failure is the part a person needs in order to see what went wrong.
    expect(engine.takeOutput()).toBe('pertama\nyes\n');
  });

  it('writes nothing for a goal that fails before it prints', () => {
    const engine = fresh();
    const { handle } = engine.open('nope(1).');
    expect(() => handle.next()).toThrow(/Unknown procedure/);
    expect(engine.takeOutput()).toBe('');
  });
});

