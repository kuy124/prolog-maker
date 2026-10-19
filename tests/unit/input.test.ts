import { describe, expect, it } from 'vitest';
import SWIPL from 'swipl-wasm';
import {
  PrologEngine,
  bootEngine,
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
 *     neither, so `user_input` is permanently at end-of-file. Answers go in
 *     through the shim's own queue instead, and running out of them suspends the
 *     goal rather than yielding `end_of_file` — see `REPL_SHIM`.
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
  engine.consult(QUESTIONNAIRE);
  engine.resetOutput();
  return engine;
}


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
    expect(engine.takeOutput()).toBe('?- start.\npertama\n|: y.\nyes\nkedua\n|: t.\nno\nselesai\n');
  });

  /*
   * An exhausted queue suspends rather than yielding `end_of_file`.
   *
   * It used to yield `end_of_file`, from the string-stream approach this was built on
   * before the terminal existed. Suspending is the better behaviour and the reason it
   * changed is not obvious: `end_of_file` is a *term*, so a questionnaire that tests
   * its answer against `y` simply stops recording and falls through — which is right.
   * But a programme that loops on `repeat, read(X), ...` never terminates, because
   * `end_of_file` is just another value to loop over. A real terminal's stdin
   * *blocks*, and blocking is what a questionnaire wants.
   *
   * So these two assert the current contract: no answers, and the query suspends.
   */
  it('suspends once the answers run out', () => {
    const engine = fresh();
    engine.setInput(['y']);
    expect(answer(engine.open('ask(pertama, A).').handle, 'A')).toBe('y');

    const second = engine.open('ask(kedua, A).');
    // The host re-enters the goal, so the outcome is a suspension the caller has to
    // recognise. `isWaitingForInput/0` is what tells the two apart.
    expect(() => second.handle.next()).toThrow(/repl_need_input/);
    expect(engine.isWaitingForInput()).toBe(true);
  });

  it('suspends on an empty queue rather than failing or looping', () => {
    // Not `end_of_file`: a goal reading in a loop would take that forever instead of
    // waiting for a person.
    const engine = fresh();
    engine.setInput([]);
    const { handle } = engine.open('ask(pertama, A).');
    try {
      expect(() => handle.next()).toThrow(/repl_need_input/);
      expect(engine.isWaitingForInput()).toBe(true);
    } finally {
      handle.close();
    }
  });

  it('is not waiting when a goal never read anything', () => {
    const engine = fresh();
    engine.setInput([]);
    const { handle } = engine.open('true.');
    try {
      handle.next();
    } finally {
      handle.close();
    }
    expect(engine.isWaitingForInput()).toBe(false);
  });

  it('answers are taken in order, and only once each', () => {
    // A dynamic predicate would backtrack here and offer the first answer again, so
    // the second read would report `y` twice. The shim's queue is not a choicepoint.
    const engine = fresh();
    engine.setInput(['y', 't']);
    const { handle } = engine.open('ask(pertama, A).');
    try {
      expect(answer(handle, 'A')).toBe('y');
    } finally {
      handle.close();
    }
    const second = engine.open('ask(kedua, A).');
    try {
      expect(answer(second.handle, 'A')).toBe('t');
    } finally {
      second.handle.close();
    }
    expect(engine.isWaitingForInput()).toBe(false);
  });

  it('a term with a trailing stop is the same answer as without', () => {
    // The queue is a list literal, and the parser reads a stop there as the end of
    // the whole clause: `repl_load([a.])` is "Syntax error: Unbalanced operator". So
    // the stop is stripped, which makes an answer typed the way Prolog is normally
    // written work rather than blow up.
    //
    // Checked through `write/1` rather than through the returned bindings, so what is
    // asserted is that the answer reached Prolog as a compound term.
    const engine = new PrologEngine(instance, sink);
    engine.consult('echo(A) :- read(A), write(got(A)), nl.\n');
    engine.resetOutput();
    engine.setInput(['person(ada, prolog).']);
    const { handle } = engine.open('echo(_).');
    try {
      handle.next();
    } finally {
      handle.close();
    }
    expect(engine.takeOutput()).toBe('?- echo(_).\n|: person(ada,prolog).\ngot(person(ada,prolog))\n');
  });

  it('blank lines are dropped rather than being a parse error', () => {
    const engine = fresh();
    engine.setInput(['', '  ', 'y', '']);
    const { handle } = engine.open('ask(pertama, A).');
    try {
      expect(answer(handle, 'A')).toBe('y');
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
    expect(engine.takeOutput()).toBe('?- ask(pertama, _).\npertama\n|: t.\nno\n');
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
    expect(engine.takeOutput()).toBe('?- start.\npertama\n|: y.\nyes\nkedua\n|: t.\nno\nselesai\n');
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
    engine.consult('step(1).\nstep(2).\nstep(3).\nsay(N) :- step(N), write(sol(N)), nl.\n');
    engine.resetOutput();

    const { handle } = engine.open('say(N).');
    try {
      expect(handle.next()?.bindings).toMatchObject({ N: 1 });
      // The reader runs while the query is open and still has alternatives.
      expect(engine.takeOutput()).toBe('?- say(N).\nsol(1)\n');
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
    expect(engine.takeOutput()).toBe('?- start.\npertama\n|: y.\nyes\nkedua\n|: y.\nyes\nselesai\n');
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
    expect(engine.takeOutput()).toBe('?- ask(satu, _).\nsatu\n|: y.\nyes\n');

    engine.resetOutput();
    engine.setInput(['t']);
    const second = engine.open('ask(dua, _).');
    try {
      second.handle.next();
    } finally {
      second.handle.close();
    }
    // A reset really resets: the second run shows only its own line.
    expect(engine.takeOutput()).toBe('?- ask(dua, _).\ndua\n|: t.\nno\n');
  });

  it('keeps whatever a failing goal managed to write before it failed', () => {
    const engine = fresh();
    engine.setInput(['y']);
    const { handle } = engine.open('ask(pertama, _), nope(1).');
    expect(() => handle.next()).toThrow(/Unknown procedure/);
    // A goal that writes and then dies still leaves a transcript: the text before
    // the failure is the part a person needs in order to see what went wrong.
    expect(engine.takeOutput()).toBe('?- ask(pertama, _), nope(1).\npertama\n|: y.\nyes\n');
  });

  it('writes nothing for a goal that fails before it prints', () => {
    const engine = fresh();
    const { handle } = engine.open('nope(1).');
    expect(() => handle.next()).toThrow(/Unknown procedure/);
    // The goal is echoed even though it printed nothing: the transcript is a
    // record of the session, and "I ran this and it failed" is part of it.
    expect(engine.takeOutput()).toBe('?- nope(1).\n');
  });
});

