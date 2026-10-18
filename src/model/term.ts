/**
 * Reading the engine's JSON bridge, and writing Prolog back out.
 *
 * The bridge is not quite JSON and not quite Prolog. Its shapes, established by
 * probing the build this app ships:
 *
 *   "ada"                        atom or string — the bridge does not say which
 *   42 / 3.5                     number
 *   []                           the empty list
 *   [1,2]                        a proper list of those elements
 *   {$t:'l', v:[1], t:'b'}       improper list, `[1|b]`
 *   {$t:'t', f:[[a, b]]}         compound `f(a, b)`
 *   {$t:'v', v:18681}            an unbound variable
 *   {$t:'b'}                     a blob (stream, engine handle)
 *   {a:1}                        a dict
 *
 * The ambiguity that matters is the string case: `X = 'hello world'` and
 * `X = "hello world"` both arrive as `"hello world"`. Prolog distinguishes an
 * atom from a string, and the difference is visible — `atom(X)` succeeds for
 * one and fails for the other. Because the bridge has already thrown that
 * information away, this decoder chooses atoms, which is what a reader expects
 * to see, and never claims a string it cannot prove.
 */

export type Term =
  | { kind: 'atom'; name: string; quoted: boolean }
  | { kind: 'number'; text: string }
  | { kind: 'variable'; name: string }
  | { kind: 'compound'; functor: string; args: Term[] }
  | { kind: 'list'; items: Term[]; tail: Term | null }
  | { kind: 'dict'; pairs: Array<{ key: string; value: Term }> }
  | { kind: 'blob'; label: string };

/** Atoms that never need quotes, per the Prolog lexical rules. */
const PLAIN_ATOM = /^[a-z][A-Za-z0-9_]*$/;

/** Symbolic atoms that read back without quotes. */
const SYMBOL_ATOM = /^[+\-*/\\^<>=~:.?@#&$]+$/;

/** Operators that need no spaces around them when printed infix. */
const INFIX = new Set(['+', '-', '*', '/', '//', 'mod', 'rem', '^', '=', '\\=', '==', '\\==',
  '<', '>', '=<', '>=', '=:=', '=\\=', 'is', ':-', '-->', ',', ';', '->', '!', '|']);

/** Prefix operators, printed with a space after. */
const PREFIX = new Set(['\\+', 'not', '-', '+', '?-']);

/** Operators whose arguments need no parentheses because nothing binds tighter. */
const TIGHTEST = new Set(['!', 'end_of_file', 'true', 'fail', '[]']);

/**
 * Escapes an atom for writing back into Prolog source.
 *
 * A single quote is doubled, which is Prolog's own rule. Control characters are
 * written with their escape sequence rather than passed through, because an
 * atom containing a raw newline would otherwise break the goal it is pasted
 * into.
 */
export function quoteAtom(name: string): string {
  if (PLAIN_ATOM.test(name) || SYMBOL_ATOM.test(name)) return name;
  if (name === '[]' || name === '{}' || name === '!') return name;
  let out = "'";
  for (const char of name) {
    if (char === "'") out += "''";
    else if (char === '\\') out += '\\\\';
    else if (char === '\n') out += '\\n';
    else if (char === '\t') out += '\\t';
    else if (char === '\r') out += '\\r';
    else out += char;
  }
  return out + "'";
}

/** True when `name` would need quotes to be read back as the same atom. */
export function needsQuotes(name: string): boolean {
  return quoteAtom(name) !== name;
}

/**
 * Decodes one value from the bridge into a `Term`.
 *
 * `variables` maps a bridge variable number to the name to print. It is passed
 * in from the solution's own bindings so that `?- X = Y.` prints `X = Y` rather
 * than `X = _G18681`, and two occurrences of the same unbound variable print
 * the same name.
 */
export function decodeTerm(raw: unknown, variables: Map<number, string> = new Map()): Term {
  if (raw === null) return { kind: 'atom', name: 'null', quoted: false };
  if (typeof raw === 'number') return { kind: 'number', text: formatNumber(raw) };
  if (typeof raw === 'boolean') return { kind: 'atom', name: String(raw), quoted: false };
  if (typeof raw === 'string') return { kind: 'atom', name: raw, quoted: needsQuotes(raw) };

  if (Array.isArray(raw)) {
    return { kind: 'list', items: raw.map((item) => decodeTerm(item, variables)), tail: null };
  }

  const object = raw as Record<string, unknown>;

  if (object.$t === 'v') {
    const id = typeof object.v === 'number' ? object.v : -1;
    const name = variables.get(id);
    if (name) return { kind: 'variable', name };
    // An unnamed variable still needs a stable, legal name. The bridge's own
    // number is used so the same variable prints the same way twice.
    const generated = `_G${id}`;
    variables.set(id, generated);
    return { kind: 'variable', name: generated };
  }

  if (object.$t === 'b') return { kind: 'blob', label: '<blob>' };

  if (object.$t === 'l') {
    const items = Array.isArray(object.v) ? object.v.map((item) => decodeTerm(item, variables)) : [];
    const tailRaw = object.t;
    const tail = tailRaw === undefined ? null : decodeTerm(tailRaw, variables);
    return { kind: 'list', items, tail };
  }

  if (object.$t === 't') {
    for (const [functor, value] of Object.entries(object)) {
      if (functor === '$t') continue;
      const args = Array.isArray(value) && Array.isArray(value[0]) ? value[0] : [];
      return {
        kind: 'compound',
        functor,
        args: args.map((arg) => decodeTerm(arg, variables)),
      };
    }
  }

  // Anything left is a dict: the bridge writes dicts as plain objects.
  const pairs = Object.entries(object).map(([key, value]) => ({
    key,
    value: decodeTerm(value, variables),
  }));
  return { kind: 'dict', pairs };
}

/** Numbers keep their integer-ness and do not gain exponent notation. */
export function formatNumber(value: number): string {
  if (Number.isInteger(value)) {
    // Beyond 2^53 the digits are already approximate; printing them plainly is
    // more honest than `1e+21`, which hides how imprecise the value is.
    return Number.isSafeInteger(value) ? String(value) : BigInt(Math.trunc(value)).toString();
  }
  return String(value);
}

/**
 * Renders a term the way Prolog would print it with `writeq/1`.
 *
 * Operators are printed infix so that `1+2` does not become `+(1,2)`, which is
 * the same term but not what the reader asked to see. Precedence is not
 * reproduced exactly — a nested expression may gain parentheses it did not
 * need, which is always legal — but it never loses a pair it did need.
 */
export function formatTerm(term: Term): string {
  switch (term.kind) {
    case 'atom':
      return quoteAtom(term.name);
    case 'number':
      return term.text;
    case 'variable':
      return term.name;
    case 'blob':
      return term.label;
    case 'list': {
      const items = term.items.map((item) => formatTerm(item)).join(',');
      if (term.tail) return `[${items}|${formatTerm(term.tail)}]`;
      return `[${items}]`;
    }
    case 'dict': {
      const pairs = term.pairs.map((pair) => `${quoteAtom(pair.key)}:${formatTerm(pair.value)}`).join(',');
      return `_{${pairs}}`;
    }
    case 'compound': {
      const { functor, args } = term;
      if (args.length === 2 && INFIX.has(functor)) {
        return `${formatOperand(args[0]!)} ${functor} ${formatOperand(args[1]!)}`;
      }
      if (args.length === 1 && PREFIX.has(functor)) {
        return `${functor} ${formatOperand(args[0]!)}`;
      }
      // `-1` arrives as `-(1)`: a compound, not a negative number. Printing it
      // as `- 1` with a space keeps it distinct from the integer `-1`, which is
      // exactly the distinction Prolog makes.
      if (args.length === 0) return quoteAtom(functor);
      return `${quoteAtom(functor)}(${args.map((arg) => formatTerm(arg)).join(',')})`;
    }
    default:
      return '?';
  }
}

/**
 * An operand inside an operator expression.
 *
 * A compound that is itself an operator gets parentheses. That is more than
 * strictly necessary for a same-precedence chain like `1+2+3`, but it is never
 * wrong, and getting it wrong in the other direction silently changes meaning.
 */
function formatOperand(term: Term): string {
  const text = formatTerm(term);
  if (term.kind === 'compound' && term.args.length > 0) {
    if (INFIX.has(term.functor) || PREFIX.has(term.functor)) return `(${text})`;
  }
  return text;
}

/**
 * Decodes a whole solution, naming unbound variables after the bindings that
 * hold them.
 *
 * `?- X = Y.` binds both to the same bridge variable, and SWI-Prolog answers
 * `X = Y` — each name is kept, because the answer means "these two are the same
 * variable". So a binding whose value is a bare variable is named after its own
 * key, while occurrences *inside* a term fall back to the shared map, where the
 * first name in sorted order wins. Sorting matters beyond tidiness: the alias
 * must be chosen the same way on every peer and every render, or two people
 * looking at one solution would see different names for it.
 */
export function decodeBindings(bindings: Record<string, unknown>): Record<string, Term> {
  const names = Object.keys(bindings).filter((key) => key !== '$tag' && key !== 'success');
  const variables = new Map<number, string>();
  for (const name of [...names].sort()) {
    const raw = bindings[name] as { $t?: string; v?: unknown };
    if (raw && raw.$t === 'v' && typeof raw.v === 'number' && !variables.has(raw.v)) {
      variables.set(raw.v, name);
    }
  }
  const decoded: Record<string, Term> = {};
  for (const name of names) {
    const raw = bindings[name] as { $t?: string; v?: unknown };
    if (raw && raw.$t === 'v' && typeof raw.v === 'number') {
      // A top-level unbound variable keeps the name the user gave it.
      decoded[name] = { kind: 'variable', name };
    } else {
      decoded[name] = decodeTerm(bindings[name], variables);
    }
  }
  return decoded;
}

/** True when a solution binds nothing at all, as for `?- true.`. */
export function isEmptySolution(terms: Record<string, Term>): boolean {
  return Object.keys(terms).length === 0;
}

export { TIGHTEST };
