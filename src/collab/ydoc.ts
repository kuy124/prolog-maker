/**
 * The shared document.
 *
 * Layout of the Yjs document:
 *
 *   doc.getText('program')      the Prolog source, one string
 *   doc.getMap('facts')         id -> { term, author, at }   asserted facts
 *   doc.getArray('log')         { id, who, goal, count, at }  the query log
 *   doc.getMap('seeds')         clientId -> program          every seed attempt
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
 *
 * The seed is the one thing here that two peers can do at the same time without
 * meaning to, and it is additive: a `Y.Text` insert is never deduplicated by a
 * merge. See `seedProgram` and `reconcileProgram`.
 */

import * as Y from 'yjs';

export const PROGRAM = 'program';
export const FACTS = 'facts';
export const LOG = 'log';
export const META = 'meta';
/** Key holding every seed attempt, keyed by the client that made it. */
export const SEEDS = 'seeds';

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

/**
 * One peer's attempt to give an empty room its first program, keyed by the client
 * id that made it. The source text is kept exactly as it was inserted, because
 * that is the only thing that identifies the copy a merge may have to remove.
 */
export type Seed = string;

export function emptyDocument(doc: Y.Doc): void {
  doc.transact(() => {
    doc.getText(PROGRAM).delete(0, doc.getText(PROGRAM).length);
    const facts = doc.getMap<Fact>(FACTS);
    for (const key of [...facts.keys()]) facts.delete(key);
    doc.getArray<LogEntry>(LOG).delete(0, doc.getArray<LogEntry>(LOG).length);
    const seeds = doc.getMap<Seed>(SEEDS);
    for (const key of [...seeds.keys()]) seeds.delete(key);
    doc.getMap(META).set('name', 'Untitled room');
  });
}

/**
 * The program text, seeded only if nobody has written anything yet.
 *
 * Seeding is the one write here that two peers can make at the same moment
 * without meaning to. Somebody opens a room, somebody else opens the same link
 * before the first peer's text has reached them, and both find an empty document.
 * A `Y.Text` insert is additive — Yjs keeps both, side by side — so without care
 * the room shows the program twice. That is the duplicate this exists to prevent.
 *
 * A guard alone cannot prevent it: before the two peers meet there is nothing to
 * guard against. So the attempt is *recorded* as well as applied. `seeds` is a
 * `Y.Map` written once per client, so two attempts merge into two entries rather
 * than into one item of duplicated text, and every peer can afterwards see that
 * the room was seeded more than once. `reconcileProgram` uses that record to
 * collapse the copies.
 */
export function seedProgram(doc: Y.Doc, source: string): void {
  const text = doc.getText(PROGRAM);
  // An empty source is nothing at all: recording it would block the real seed.
  if (text.length > 0 || source.length === 0) return;
  const seeds = doc.getMap<Seed>(SEEDS);
  if (seeds.size > 0) return;
  doc.transact(() => {
    seeds.set(String(doc.clientID), source);
    text.insert(0, source);
  });
}

/** Every seed attempt in the document, ordered by client id so all peers agree. */
function readSeeds(doc: Y.Doc): { by: number; source: string }[] {
  const out: { by: number; source: string }[] = [];
  doc.getMap<Seed>(SEEDS).forEach((source, key) => {
    if (typeof source !== 'string' || source.length === 0) return;
    out.push({ by: Number(key), source });
  });
  return out.sort((a, b) => a.by - b.by);
}

/**
 * Removes the copies left behind when two peers seeded the same room at once.
 *
 * Yjs never drops a concurrent insert, so a room seeded by two peers before they
 * met holds the program twice and stays that way forever. The winner is the
 * lowest client id, which every peer computes identically, and every peer deletes
 * the same range, so the repaired text converges.
 *
 * Only the seed itself is removed, and only where a second copy is provably
 * sitting next to the first. A program that merely begins to look like the seed
 * is left alone: this repairs a merge artefact, and it is not allowed to eat
 * somebody's typing.
 */
export function reconcileProgram(doc: Y.Doc): void {
  const text = doc.getText(PROGRAM);
  const seeds = doc.getMap<Seed>(SEEDS);
  // One copy and one record go per pass, so three peers seeded at once take two
  // passes and the loop still cannot run away. Clearing the records matters as
  // much as deleting the copies: a record left behind would let this repair a
  // program the user has since typed on purpose.
  for (;;) {
    const attempts = readSeeds(doc);
    if (attempts.length < 2) return;
    const winner = attempts[0]!;
    const loser = attempts[attempts.length - 1]!;
    const program = text.toString();
    // Which of the two copies sits first depends on the order Yjs gave the
    // concurrent inserts, so both orders have to be tried.
    const after = program.indexOf(winner.source + loser.source);
    const before = after === -1 ? program.indexOf(loser.source + winner.source) : -1;
    if (after === -1 && before === -1) return;
    doc.transact(() => {
      text.delete(after === -1 ? before : after + winner.source.length, loser.source.length);
      seeds.delete(String(loser.by));
    });
  }
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
