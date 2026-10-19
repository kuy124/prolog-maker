import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  LOG_LIMIT,
  PROGRAM,
  appendLog,
  readLog,
  reconcileProgram,
  seedProgram,
  type LogEntry,
} from '../../src/collab/ydoc';

function doc(): Y.Doc {
  return new Y.Doc();
}

describe('program', () => {
  it('seeds an empty document', () => {
    const d = doc();
    seedProgram(d, 'likes(ada, tea).\n');
    expect(d.getText(PROGRAM).toString()).toBe('likes(ada, tea).\n');
  });

  it('does not overwrite a program that already has content', () => {
    const d = doc();
    seedProgram(d, 'first.');
    seedProgram(d, 'second.');
    expect(d.getText(PROGRAM).toString()).toBe('first.');
  });

  it('seeds an empty string without leaving the document unseeded', () => {
    const d = doc();
    seedProgram(d, '');
    seedProgram(d, 'later.');
    // An empty seed leaves nothing behind, so the next seed is free to apply.
    expect(d.getText(PROGRAM).toString()).toBe('later.');
  });

  it('collapses the duplicate two peers make by seeding the same room', () => {
    // The reported bug. Both peers open the link before either has seen the
    // other, both find an empty document, and both seed. Yjs keeps both
    // concurrent inserts, so the program arrives written twice.
    const a = doc();
    const b = doc();
    seedProgram(a, 'likes(ada, tea).\n');
    seedProgram(b, 'likes(ada, tea).\n');
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));

    reconcileProgram(a);
    reconcileProgram(b);
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));

    expect(a.getText(PROGRAM).toString()).toBe('likes(ada, tea).\n');
    expect(b.getText(PROGRAM).toString()).toBe('likes(ada, tea).\n');
  });

  it('collapses the duplicate whichever order Yjs put the two inserts in', () => {
    // Same as above with the client ids swapped, so the losing copy lands first.
    const a = doc();
    const b = doc();
    seedProgram(a, 'likes(ada, tea).\n');
    seedProgram(b, 'likes(ada, tea).\n');
    if (a.clientID < b.clientID) Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    else Y.applyUpdate(a, Y.encodeStateAsUpdate(b));

    reconcileProgram(a);
    reconcileProgram(b);
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));

    expect(a.getText(PROGRAM).toString()).toBe('likes(ada, tea).\n');
    expect(b.getText(PROGRAM).toString()).toBe('likes(ada, tea).\n');
  });

  it('keeps one program when two peers seeded a room with different ones', () => {
    const a = doc();
    const b = doc();
    seedProgram(a, 'first.\n');
    seedProgram(b, 'second.\n');
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));

    reconcileProgram(a);
    reconcileProgram(b);
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));

    // One of them survives, and both peers agree on which.
    const kept = a.getText(PROGRAM).toString();
    expect([ 'first.\n', 'second.\n' ]).toContain(kept);
    expect(b.getText(PROGRAM).toString()).toBe(kept);
  });

  it('leaves a program alone once the duplicate has been collapsed', () => {
    // The repair must not keep eating a program that legitimately repeats.
    const d = doc();
    seedProgram(d, 'likes(ada, tea).\n');
    d.getText(PROGRAM).insert(0, 'likes(ada, tea).\n');
    reconcileProgram(d);
    expect(d.getText(PROGRAM).toString()).toBe('likes(ada, tea).\nlikes(ada, tea).\n');
  });

  it('collapses a duplicate that a late third peer produced', () => {
    const a = doc();
    const b = doc();
    const c = doc();
    for (const d of [a, b, c]) seedProgram(d, 'likes(ada, tea).\n');
    for (const d of [a, b, c]) {
      Y.applyUpdate(d, Y.encodeStateAsUpdate(a));
      Y.applyUpdate(d, Y.encodeStateAsUpdate(b));
      Y.applyUpdate(d, Y.encodeStateAsUpdate(c));
    }

    for (const d of [a, b, c]) {
      reconcileProgram(d);
      Y.applyUpdate(d, Y.encodeStateAsUpdate(a));
      Y.applyUpdate(d, Y.encodeStateAsUpdate(b));
      Y.applyUpdate(d, Y.encodeStateAsUpdate(c));
    }

    expect(a.getText(PROGRAM).toString()).toBe('likes(ada, tea).\n');
    expect(b.getText(PROGRAM).toString()).toBe('likes(ada, tea).\n');
    expect(c.getText(PROGRAM).toString()).toBe('likes(ada, tea).\n');
  });

  it('merges concurrent typing in different places without losing either edit', () => {
    const a = doc();
    const b = doc();
    a.getText(PROGRAM).insert(0, 'foo.');
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    a.getText(PROGRAM).insert(4, 'bar.');
    b.getText(PROGRAM).insert(4, 'baz.');
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    expect(a.getText(PROGRAM).toString()).toBe(b.getText(PROGRAM).toString());
    expect(a.getText(PROGRAM).toString()).toContain('bar');
    expect(a.getText(PROGRAM).toString()).toContain('baz');
  });
});

/*
 * Facts are clauses now, so there is no separate fact API to test. What used to
 * be the point of that API is still worth holding: a knowledge base shared by two
 * peers must converge, and clause order must be identical on both, because
 * Prolog's solution order depends on it. As program text it does — and it merges
 * at the character level, so two people adding different facts at once keep both.
 */
describe('facts as program text', () => {
  it('converges when two peers add different facts', () => {
    const a = doc();
    const b = doc();
    a.getText(PROGRAM).insert(0, 'a(1).\n');
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    a.getText(PROGRAM).insert(a.getText(PROGRAM).length, 'b(2).\n');
    b.getText(PROGRAM).insert(b.getText(PROGRAM).length, 'c(3).\n');
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    const text = a.getText(PROGRAM).toString();
    expect(text).toBe(b.getText(PROGRAM).toString());
    for (const clause of ['a(1).', 'b(2).', 'c(3).']) expect(text).toContain(clause);
  });

  it('lets a fact be a rule, which the old panel could not express', () => {
    // A fact with a body was rejected by the panel's own validation. As program
    // text there is no such distinction to enforce.
    const d = doc();
    seedProgram(d, 'grandparent(X, Z) :- parent(X, Y), parent(Y, Z).\n');
    expect(d.getText(PROGRAM).toString()).toContain(':-');
  });
});

describe('log', () => {
  const entry = (id: string): LogEntry => ({ id, who: 'ada', goal: 'likes(X, Y).', count: 2, error: null, at: 1 });

  it('appends an entry', () => {
    const d = doc();
    appendLog(d, entry('l1'));
    expect(readLog(d)).toHaveLength(1);
  });

  it('keeps entries in the order they were added', () => {
    const d = doc();
    appendLog(d, entry('l1'));
    appendLog(d, entry('l2'));
    expect(readLog(d).map((e) => e.id)).toEqual(['l1', 'l2']);
  });

  it('drops the oldest entries past the limit', () => {
    const d = doc();
    for (let i = 0; i < LOG_LIMIT + 5; i += 1) appendLog(d, entry(`l${i}`));
    const log = readLog(d);
    expect(log).toHaveLength(LOG_LIMIT);
    expect(log[0]!.id).toBe('l5');
    expect(log[log.length - 1]!.id).toBe(`l${LOG_LIMIT + 4}`);
  });

  it('converges when two peers append concurrently', () => {
    const a = doc();
    const b = doc();
    appendLog(a, entry('l1'));
    appendLog(b, entry('l2'));
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    expect(readLog(a)).toHaveLength(2);
    expect(readLog(a).map((e) => e.id).sort()).toEqual(['l1', 'l2']);
  });
});
