/**
 * Making the room's facts dynamic.
 *
 * A fact in the Facts panel becomes a clause in `facts.pl`, and the engine consults
 * that file as a program. A predicate defined by clauses is static. So a fact named
 * `observation(ada)` made `observation/1` static, and the next `assert(observation(X))`
 * in a program was refused:
 *
 *     assert/1: No permission to modify static procedure observation/1
 *     Defined at /tmp/room/facts.pl:1
 *
 * That is correct Prolog given what the file said, and it made the Facts panel a
 * trap: any fact whose name a program also wanted to assert into broke that program,
 * with an error that points at a file the user never wrote.
 *
 * The fix is one line in front of the clauses declaring each of their predicates
 * dynamic. Declared here rather than in each program because these predicates are not
 * part of any program: peers add and remove them at runtime and the engine re-consults
 * on every keystroke, so they were never static in any meaningful sense, and a
 * program that wants to `assert/1` into one should not have to know where it came
 * from.
 *
 * `Name/Arity` is read off the front of each fact rather than by parsing the term.
 * Only the head and the argument count are needed, and both are visible in the text;
 * anything harder to read is skipped rather than guessed, since a wrong indicator
 * declares the wrong predicate.
 */

/** The indicators of the predicates `facts` defines, in the order first seen. */
export function dynamicIndicators(facts: string): string[] {
  const seen = new Set<string>();
  for (const fact of facts.split('\n')) {
    const found = indicator(fact);
    if (found) seen.add(found);
  }
  return [...seen];
}

/**
 * The facts, preceded by a directive declaring their predicates dynamic.
 *
 * Unchanged when nothing is recognised, so a facts file with nothing declarable in it
 * stays byte-for-byte what the room asked for.
 */
export function factsWithDynamic(facts: string): string {
  const indicators = dynamicIndicators(facts);
  if (indicators.length === 0) return facts;
  // Each declaration is caught on its own. A fact named `fail` or `not` would
  // otherwise produce `dynamic(fail/0)`, which raises a permission error and takes the
  // whole consult down — trading one broken program for a room that cannot load at all.
  const declare = indicators.map((i) => `catch(dynamic(${i}), _, true)`).join(', ');
  return `:- ${declare}.\n${facts}`;
}

/**
 * The `Name/Arity` one fact defines, or null when it cannot be read with confidence.
 *
 * Null rather than a guess. A clause with a body, an operator term, or anything
 * unparseable yields nothing, which costs one declaration; a wrong one would declare
 * a predicate the fact never defined and quietly break an unrelated program.
 */
function indicator(fact: string): string | null {
  const text = fact.trim().replace(/\.$/, '').trim();
  if (text.length === 0 || text.includes(':-')) return null;

  const open = text.indexOf('(');
  if (open < 0) {
    // A zero-arity fact. Only a plain atom, so `X = 1` is not read as one.
    return /^[a-z][A-Za-z0-9_]*$/.test(text) ? `${text}/0` : null;
  }

  const head = text.slice(0, open).trim();
  if (!/^[a-z][A-Za-z0-9_]*$/.test(head)) return null;

  const arity = countArguments(text, open);
  return arity === null ? null : `${head}/${arity}`;
}

/** How many arguments the parenthesised list at `open` holds. */

/**
 * How many arguments the parenthesised list at `open` holds.
 *
 * Commas inside nested brackets, inside quoted atoms, and inside `{}/1` blocks do not
 * separate arguments — `point(1, 2)`, `name('Ada, Lovelace')` and `data({a,b})` are
 * one argument, one argument and one argument respectively. Returns null if the
 * parentheses do not balance, which means the term is malformed and the consult will
 * say so far more clearly than a wrong declaration would.
 */
function countArguments(text: string, open: number): number | null {
  let depth = 0;
  let count = 0;
  let filled = false;
  let quote = '';

  for (let index = open; index < text.length; index += 1) {
    const char = text[index] as string;

    if (quote) {
      // An escaped quote does not close the atom: 'it\'s' is one atom.
      if (char === '\\') index += 1;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      filled = true;
      continue;
    }
    if (char === '(' || char === '[' || char === '{' || char === '|') {
      depth += 1;
      if (depth > 1) filled = true;
      continue;
    }
    if (char === ')' || char === ']' || char === '}' || char === '|') {
      depth -= 1;
      if (depth === 0) return count + (filled ? 1 : 0);
      if (depth < 0) return null;
      continue;
    }
    if (depth === 1) {
      if (char === ',') count += filled ? 1 : 0;
      else if (!/\s/.test(char)) filled = true;
    }
  }
  return null;
}
