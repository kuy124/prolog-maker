import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  FACTS,
  LOG_LIMIT,
  PROGRAM,
  addFact,
  appendLog,
  factsSource,
  readFacts,
  readLog,
  reconcileProgram,
  removeFact,
  seedProgram,
  type Fact,
  type LogEntry,
} from '../../src/collab/ydoc';

function doc(): Y.Doc {
  return new Y.Doc();
}

const fact = (id: string, term: string, author = 'ada'): Fact => ({ id, term, author, at: 1 });

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

describe('facts', () => {
  it('adds and reads a fact', () => {
    const d = doc();
    addFact(d, fact('f1', 'parent(ada, bo)'));
    expect(readFacts(d)).toEqual([fact('f1', 'parent(ada, bo)')]);
  });

  it('removes a fact', () => {
    const d = doc();
    addFact(d, fact('f1', 'a(1)'));
    removeFact(d, 'f1');
    expect(readFacts(d)).toEqual([]);
  });

  it('sorts facts so every peer asserts them in the same order', () => {
    // Order matters: `findall/3` results depend on clause order, so two peers
    // asserting the same facts in different orders would disagree.
    const d = doc();
    addFact(d, fact('f2', 'zebra(1)'));
    addFact(d, fact('f1', 'apple(1)'));
    expect(readFacts(d).map((entry) => entry.term)).toEqual(['apple(1)', 'zebra(1)']);
  });

  it('ignores a malformed fact rather than rendering a broken row', () => {
    const d = doc();
    d.getMap(FACTS).set('bad', { id: 'bad' } as never);
    d.getMap(FACTS).set('blank', { id: 'blank', term: '   ' } as never);
    expect(readFacts(d)).toEqual([]);
  });

  it('converges when two peers add different facts', () => {
    const a = doc();
    const b = doc();
    addFact(a, fact('f1', 'a(1)'));
    addFact(b, fact('f2', 'b(2)'));
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    expect(readFacts(a).map((f) => f.term)).toEqual(readFacts(b).map((f) => f.term));
    expect(readFacts(a)).toHaveLength(2);
  });
});

describe('factsSource', () => {
  it('writes each fact as a clause', () => {
    expect(factsSource([fact('f1', 'a(1)'), fact('f2', 'b(2)')])).toBe('a(1).\nb(2).');
  });

  it('does not double the full stop of a fact that already ends in one', () => {
    expect(factsSource([fact('f1', 'a(1).')])).toBe('a(1).');
  });

  it('produces an empty string for no facts', () => {
    expect(factsSource([])).toBe('');
  });

  it('leaves a rule-shaped fact alone, so a fact may define a rule', () => {
    expect(factsSource([fact('f1', 'grandparent(X, Z) :- parent(X, Y), parent(Y, Z)')])).toBe(
      'grandparent(X, Z) :- parent(X, Y), parent(Y, Z).',
    );
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
