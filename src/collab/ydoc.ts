/**
 * The shared document.
 *
 * Layout of the Yjs document:
 *
 *   doc.getText('program')      the Prolog source, one string
 *   doc.getMap('facts')         id -> { term, author, at }   asserted facts
 *   doc.getArray('log')         { id, who, goal, count, at }  the query log
 *   doc.getMap('meta')          { name }
 *
 * The program is a `Y.Text` rather than a map of clauses because it is edited as
 * text, with a cursor: two people typing in different places must merge as text
 * insertions, and clause order must be identical on every peer, since Prolog's
 * solution order depends on it. A map keyed by clause id would let one person's
 * edit reorder another's results.
 *
 * Facts are structured rather than asserted into the engine, because the engine
 * is local. A fact written by one peer has to arrive as data and be re-asserted
 * into every peer's own instance. Keeping them as terms in a map — not as lines
 * in the program text — means the program can be rewritten without losing the
 * knowledge base, and a fact can carry who wrote it.
 *
 * The log is append-only and shared so a group can see each other's queries and
 * re-run one. It is capped: a room left open for a day should not accumulate
 * thousands of rows in everyone's IndexedDB.
 */

import * as Y from 'yjs';

export const PROGRAM = 'program';
export const FACTS = 'facts';
export const LOG = 'log';
export const META = 'meta';

/** How many log entries to keep. Old entries fall off the front. */
export const LOG_LIMIT = 200;

export interface Fact {
  id: string;
  /** The Prolog term, as source text, e.g. `parent(ada, bo)`. */
  term: string;
  author: string;
  at: number;
}

export interface LogEntry {
  id: string;
  who: string;
  goal: string;
  /** Number of solutions found, or null while it is still running. */
  count: number | null;
  /** Set when the goal failed, so a reader can tell "none" from "broke". */
  error: string | null;
  at: number;
}

export function emptyDocument(doc: Y.Doc): void {
  doc.transact(() => {
    doc.getText(PROGRAM).delete(0, doc.getText(PROGRAM).length);
    const facts = doc.getMap<Fact>(FACTS);
    for (const key of [...facts.keys()]) facts.delete(key);
    doc.getArray<LogEntry>(LOG).delete(0, doc.getArray<LogEntry>(LOG).length);
    doc.getMap(META).set('name', 'Untitled room');
  });
}

/** The program text, seeded only if nobody has written anything yet. */
export function seedProgram(doc: Y.Doc, source: string): void {
  const text = doc.getText(PROGRAM);
  if (text.length > 0) return;
  doc.transact(() => {
    text.insert(0, source);
  });
}

export function readFacts(doc: Y.Doc): Fact[] {
  const facts = doc.getMap<Fact>(FACTS);
  const out: Fact[] = [];
  facts.forEach((value) => {
    // A peer can send any shape; only a well-formed fact is usable.
    if (!value || typeof value.term !== 'string' || value.term.trim().length === 0) return;
    out.push({
      id: typeof value.id === 'string' ? value.id : 'unknown',
      term: value.term,
      author: typeof value.author === 'string' ? value.author : 'someone',
      at: typeof value.at === 'number' ? value.at : 0,
    });
  });
  // Sorted so every peer asserts them in the same order, which keeps
  // `findall/3` results identical across peers.
  return out.sort((a, b) => (a.term < b.term ? -1 : a.term > b.term ? 1 : 0));
}

export function addFact(doc: Y.Doc, fact: Fact): void {
  doc.getMap<Fact>(FACTS).set(fact.id, fact);
}

export function removeFact(doc: Y.Doc, id: string): void {
  doc.getMap<Fact>(FACTS).delete(id);
}

export function readLog(doc: Y.Doc): LogEntry[] {
  const log = doc.getArray<LogEntry>(LOG);
  return log.toArray().filter((entry): entry is LogEntry => Boolean(entry) && typeof entry.goal === 'string');
}

export function appendLog(doc: Y.Doc, entry: LogEntry): void {
  const log = doc.getArray<LogEntry>(LOG);
  doc.transact(() => {
    log.push([entry]);
    const overflow = log.length - LOG_LIMIT;
    if (overflow > 0) log.delete(0, overflow);
  });
}

/**
 * The facts file handed to the engine.
 *
 * Each fact is written as a clause terminated by a full stop. The term is not
 * re-quoted or re-parsed here: it was validated when it was added, and rewriting
 * it would risk changing what it means. A term that somehow arrives malformed
 * makes the whole consult fail, which is visible, rather than being silently
 * dropped, which is not.
 */
export function factsSource(facts: Fact[]): string {
  return facts.map((fact) => (fact.term.trimEnd().endsWith('.') ? fact.term : `${fact.term}.`)).join('\n');
}
