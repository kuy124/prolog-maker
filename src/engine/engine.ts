/**
 * The Prolog engine, as a module that does not know it is in a worker.
 *
 * Everything interesting lives here: validate, load, open, next, error
 * extraction. `engine.worker.ts` is a message shim over it, and the unit tests
 * drive it directly in Node against the same `swipl-wasm` build the browser
 * loads — so a change in the engine's JSON bridge breaks a test here rather than
 * a user's session, and the worker cannot quietly diverge from what was tested.
 *
 * Three behaviours of this particular build are surprising enough to state
 * before the code, because each one was found by a failing test rather than
 * guessed at:
 *
 *   1. **Only one query may be open at a time, and it must be closed.** The JS
 *      bridge keeps a single engine slot. Opening a second query while the first
 *      still has alternatives does not fail politely — it makes *every* later
 *      call report `Unknown procedure`, including calls to predicates that are
 *      demonstrably loaded. Abandoning a query without closing it has the same
 *      effect. So `OpenQuery` always closes its underlying query, on exhaustion,
 *      on error, and on an explicit `close()`, and the engine refuses to start a
 *      second query while one is live rather than silently corrupting itself.
 *
 *   2. **`consult/1` must be module-qualified as `user:consult/1`.** With a query
 *      open, a bare `consult/1` resolves against the wrong context and fails with
 *      `permission_error(load, source, ...)`.
 *
 *   3. **A syntax error half-loads the file.** Both `consult/1` and
 *      `load_files/2` load the clauses before the bad one and then report the
 *      error, so loading a broken edit silently replaces a working program with
 *      a truncated one. The program is therefore validated first, by loading it
 *      into a throwaway module from a unique path; only if that produces no
 *      syntax error is the real load attempted. A bad edit then leaves the
 *      previous program running, which is what an editor should do.
 *
 * A fourth detail: the syntax error is *printed*, not thrown. `read_term/3` with
 * `syntax_errors(error)` truncates silently and `atom_to_term/3` fails without a
 * position, depending on which is asked. Loading into a scratch module is the one
 * path that reports `FILE:LINE:COL: Syntax error: Reason` on stderr with the
 * position intact, so that message is what gets parsed.
 */

import type { WireBindings, WireTerm } from './protocol';

/**
 * The slice of the Emscripten module this app uses.
 *
 * Typed by hand rather than imported from `swipl-wasm`, whose declarations
 * describe an Emscripten module and would drag `@types/emscripten` into the
 * browser build for three method signatures.
 */
export interface SwiplInstance {
  prolog: {
    query: (
      goal: string,
      input?: Record<string, unknown>,
    ) => {
      next: () => Record<string, unknown>;
      once: () => Record<string, unknown>;
      /** Frees the bridge's single engine slot. Undocumented but essential. */
      close: () => void;
    };
    call: (goal: string) => unknown;
  };
  FS: {
    writeFile: (path: string, data: string) => void;
  };
}

/**
 * A swappable destination for the engine's output.
 *
 * The sink itself cannot be replaced after boot, so the callback installed at
 * boot is a fixed indirection and this holder decides where the text goes. That
 * is what lets the engine capture stderr for the duration of one call.
 */
export interface OutputSink {
  current: (text: string) => void;
}

/**
 * Boots SWI-Prolog with its output routed through `sink`.
 *
 * The engine has to own instance creation, not merely receive an instance. Its
 * `print` and `printErr` callbacks are fixed when the module is constructed and
 * cannot be replaced afterwards — and reading a syntax error *means* reading
 * stderr, because this build reports a bad load by printing rather than
 * throwing. An engine handed an already-booted instance would therefore be
 * blind to exactly the errors it exists to report.
 *
 * `load` is the Emscripten module factory (`SWIPL` in the browser, the npm
 * default in Node), passed in so this module has no opinion about where the
 * engine came from.
 */
export async function bootEngine(
  load: (options: Record<string, unknown>) => Promise<unknown>,
  sink: OutputSink,
  options: Record<string, unknown> = {},
): Promise<SwiplInstance> {
  const instance = (await load({
    ...options,
    print: (text: string) => sink.current(text),
    printErr: (text: string) => sink.current(text),
  })) as SwiplInstance;
  return instance;
}

export interface Solution {
  bindings: WireBindings;
  /** False once the engine has no alternatives left. */
  more: boolean;
}

export interface OpenResult {
  /** Column names, in the order the goal mentions them. */
  variables: string[];
  handle: OpenQuery;
}

/** Where a program failed to parse. */
export interface SyntaxIssue {
  /** 1-based line. */
  line: number;
  message: string;
}

/** A Prolog error, already worded the way the engine words it. */
export class PrologError extends Error {
  /** 1-based line in the program, when the error came from loading it. */
  readonly line: number | null;

  constructor(message: string, line: number | null = null) {
    super(message);
    this.name = 'PrologError';
    this.line = line;
  }
}

const PROGRAM_FILE = '/tmp/room/program.pl';
const FACTS_FILE = '/tmp/room/facts.pl';

/**
 * Pulls `FILE:LINE:COL: Syntax error: Reason` out of the engine's stderr.
 *
 * The path contains slashes and the message may contain colons of its own, so
 * the line and column are matched as the two numeric fields immediately before
 * the phrase rather than by splitting on `:`.
 */
export function parseSyntaxError(text: string): SyntaxIssue | null {
  const match = /:(\d+):(\d+):\s*Syntax error:\s*([\s\S]*?)(?:\n|$)/.exec(text);
  if (!match) {
    if (/Syntax error/.test(text)) return { line: 1, message: 'Syntax error' };
    return null;
  }
  return { line: Number(match[1]), message: match[3]!.trim() || 'Syntax error' };
}

/**
 * Normalises an arithmetic or evaluation error into a sentence.
 *
 * The engine words these as `(/)/2: Arithmetic: evaluation error: 'zero_divisor'`,
 * which names the internal predicate before saying anything a reader wants. The
 * specific reason is what matters, so it is lifted out and the rest dropped.
 */
function describeEvaluation(text: string): string | null {
  const match = /evaluation error:\s*`?'?([a-z_]+)'?/.exec(text);
  if (!match) return null;
  const reason: Record<string, string> = {
    zero_divisor: 'Division by zero.',
    float_overflow: 'Number too large.',
    int_overflow: 'Integer too large.',
    undefined: 'Undefined arithmetic expression.',
    type_error: 'Type error in arithmetic.',
  };
  return reason[match[1]!] ?? `Arithmetic error: ${match[1]!.replace(/_/g, ' ')}.`;
}

/** Turns a Prolog error term into the sentence shown to the user. */
export function describeError(raw: string): { message: string; line: number | null } {
  const evaluation = describeEvaluation(raw);
  if (evaluation) return { message: evaluation, line: null };
  const syntax = /syntax_error\(([a-z_]+)\)/.exec(raw);
  if (syntax) {
    const kind = syntax[1]!.replace(/_/g, ' ');
    return { message: `Syntax error: ${kind}.`, line: null };
  }
  if (/existence_error\(procedure/.test(raw)) {
    const name = /procedure,\s*([^)\]]+)/.exec(raw)?.[1] ?? 'that predicate';
    return { message: `Unknown procedure: ${name}`, line: null };
  }
  if (/existence_error\(variable/.test(raw)) return { message: 'A variable is unbound.', line: null };
  if (/type_error/.test(raw)) {
    const detail = /type_error\(([a-z_]+),\s*([^)\]]+)\)/.exec(raw);
    return {
      message: detail ? `Type error: expected ${detail[1]}, got ${detail[2]}.` : 'Type error.',
      line: null,
    };
  }
  if (/permission_error/.test(raw)) {
    const detail = /permission_error\(([a-z_]+),\s*([a-z_]+)/.exec(raw);
    return {
      message: detail ? `Not allowed to ${detail[1]} ${detail[2]}.` : 'Permission error.',
      line: null,
    };
  }
  if (/instantiation_error/.test(raw)) return { message: 'An argument is not bound.', line: null };
  // The engine prefixes its own bridge frames; they are noise to a reader.
  const cleaned = raw
    .replace(/^wasm:wasm_call_string\/3:\s*/, '')
    .replace(/^wasm:/, '')
    .replace(/\s*However, there are definitions for:[\s\S]*$/, '')
    .trim();
  return { message: cleaned || 'Prolog error.', line: null };
}

/**
 * Flattens the engine's irregular answer shape.
 *
 * `next()` returns `{value, done}` where the *last* solution is `{done: true,
 * value}` — so `done` cannot be read as "there is nothing here". A Prolog
 * exception arrives as `{error: true, message}` instead. This is the only place
 * that knows all three, so nothing downstream has to.
 */
function step(raw: Record<string, unknown>): {
  bindings: WireBindings | null;
  more: boolean;
  error: string | null;
} {
  if (raw.error) {
    return { bindings: null, more: false, error: String(raw.message ?? 'Prolog error') };
  }
  const value = (raw.value ?? raw) as WireBindings;
  const isBindings = (value as { $tag?: string }).$tag === 'bindings';
  return { bindings: isBindings ? value : null, more: raw.done !== true, error: null };
}

/**
 * Reads the variable names out of a goal without running it.
 *
 * `read_term_from_atom/3` parses the text the same way the engine will when the
 * goal is called, so the names are the ones the user typed. `variable_names/1`
 * already omits `_`, which is what makes `?- likes(X, _)` show one column.
 */
const READ_VARIABLES = `catch(read_term_from_atom(Goal, _, [variable_names(Ns)]), _, fail).`;

export class PrologEngine {
  #instance: SwiplInstance;
  #program = '';
  #facts = '';
  #scratch = 0;
  /** Text the engine printed while the current capture was running. */
  #captured: string[] | null = null;
  /** The one query allowed to be open, if any. */
  #live: OpenQuery | null = null;

  constructor(instance: SwiplInstance, sink: OutputSink) {
    this.#instance = instance;
    // Everything printed outside a capture goes wherever the host put it — the
    // results pane in the browser, the console in a test.
    sink.current = (text) => {
      if (this.#captured) this.#captured.push(text);
      else this.#idle(text);
    };
  }

  /** Replaces the destination for output produced outside a capture. */
  onOutput(handler: (text: string) => void): void {
    this.#idle = handler;
  }

  #idle: (text: string) => void = () => {};

  /**
   * Runs a goal to completion and returns its single answer.
   *
   * `once()` is used rather than `next()`, and the query is closed afterwards.
   * Both matter: the bridge holds one engine slot, and a query left open makes
   * every later call fail with `Unknown procedure` — permanently, since a second
   * query cannot be opened to recover. This helper is the only place that runs a
   * goal for its side effect or for one answer, which keeps that discipline in
   * one place instead of scattered across the file.
   */
  #ask(goal: string, input?: Record<string, unknown>): Record<string, unknown> {
    this.closeAll();
    const query = this.#instance.prolog.query(goal, input);
    try {
      return query.once() as Record<string, unknown>;
    } finally {
      try {
        query.close();
      } catch {
        // Already closed because the goal exhausted it.
      }
    }
  }

  /** The running SWI-Prolog version, as 10000*major + 100*minor + patch. */
  version(): string {
    const answer = this.#ask('current_prolog_flag(version, V).') as { V?: number };
    return String(answer?.V ?? 0);
  }

  /**
   * Parses a program without loading it into `user`.
   *
   * Returns where the first syntax error is, or `null` when the whole program
   * parses. This is what keeps a broken edit from replacing a working program:
   * both `consult/1` and `load_files/2` would load the clauses before the error
   * and stop, leaving a truncated knowledge base behind.
   *
   * The check works by loading into a throwaway module from a unique path. A
   * given file may only ever be loaded into one module, which is why the path
   * carries a counter — reusing it fails with `permission_error` rather than
   * telling us anything about the program.
   */
  check(source: string): SyntaxIssue | null {
    if (source.trim().length === 0) return null;
    const id = this.#scratch++;
    const file = `/tmp/room/check${id}.pl`;
    this.#instance.prolog.call("catch(make_directory('/tmp/room'), _, true)");
    this.#instance.FS.writeFile(file, source);
    const captured = this.#captureOutput(() => {
      this.#ask(`catch(load_files(check${id}:'${file}', [if(true)]), _, true).`);
    });
    return parseSyntaxError(captured);
  }
  /**
   * Replaces the loaded program and facts.
   *
   * `consult/1` replaces a file's clauses rather than appending, so calling this
   * repeatedly is idempotent — which is what lets the editor re-consult on every
   * debounced keystroke without the knowledge base growing. Predicates that the
   * new program no longer mentions are removed, because `consult/1` treats the
   * file as the whole definition of what it declares.
   *
   * Any open query is closed first: the bridge cannot consult while one is live.
   *
   * Throws a `PrologError` when the program does not parse, having left the
   * previously loaded program untouched.
   */
  consult(program: string, facts: string): void {
    const issue = this.check(program);
    if (issue) {
      // The status line already shows the line number separately, so the message
      // carries the reason only rather than repeating "line 2" twice.
      throw new PrologError(issue.message, issue.line);
    }

    this.#live?.close();

    this.#program = program;
    this.#facts = facts;

    this.#instance.prolog.call("catch(make_directory('/tmp/room'), _, true)");
    this.#instance.FS.writeFile(PROGRAM_FILE, program);
    this.#instance.FS.writeFile(FACTS_FILE, facts);

    // Qualified as `user:` so the load lands in the module the console queries.
    // See the note at the top of the file.
    const loaded = this.#captureOutput(() => {
      this.#ask(
        `catch((user:consult('${PROGRAM_FILE}'), user:consult('${FACTS_FILE}')), E, ` +
          `(write_canonical(E), nl, fail)).`,
      );
    });
    const failure =
      parseSyntaxError(loaded) ?? (/error\(/.test(loaded) ? { line: 0, message: loaded } : null);
    if (failure) {
      throw new PrologError(`Could not load the program: ${failure.message.trim()}`, failure.line || null);
    }
  }

  /**
   * Collects whatever the engine writes to stdout/stderr while `run` executes.
   *
   * The bridge has no per-call output stream — `print`/`printErr` are fixed when
   * the module is created — so the indirection installed at boot redirects text
   * into a buffer for the duration of the call. This is only safe because the
   * engine is single threaded and `run` is synchronous.
   */
  #captureOutput(run: () => void): string {
    const previous = this.#captured;
    const chunks: string[] = [];
    this.#captured = chunks;
    try {
      run();
    } finally {
      this.#captured = previous;
    }
    return chunks.join('');
  }

  /**
   * Parses a goal and reports the variables it exposes.
   *
   * A goal that will not parse throws here rather than at the first `next()`,
   * so the console can show the error next to the input the user is still
   * looking at.
   *
   * Starting a query closes whatever was open first. That ordering is required,
   * not merely tidy: opening a second query while the first still has
   * alternatives does not fail politely, it leaves the engine reporting
   * `Unknown procedure` for everything afterwards, and no amount of closing
   * recovers it. The close has to happen before the new query is created.
   */
  open(goal: string): OpenResult {
    this.closeAll();
    const variables = this.#variableNames(goal);
    const query = this.#instance.prolog.query(goal);
    const handle = new OpenQuery(query, () => {
      if (this.#live === handle) this.#live = null;
    });
    this.#live = handle;
    return { variables, handle };
  }

  #variableNames(goal: string): string[] {
    const answer = this.#ask(READ_VARIABLES, { Goal: goal }) as { Ns?: WireTerm };
    if (!answer || !Array.isArray(answer.Ns)) return [];
    const names: string[] = [];
    for (const pair of answer.Ns) {
      // Each entry is `Name = Var`, encoded as a compound whose functor is `=`.
      const compound = pair as { $t?: string; '='?: unknown };
      if (compound.$t !== 't') continue;
      const args = compound['='];
      if (!Array.isArray(args) || !Array.isArray(args[0])) continue;
      const name = args[0][0];
      if (typeof name === 'string') names.push(name);
    }
    return names;
  }

  /** Closes any open query, freeing the bridge's engine slot. */
  closeAll(): void {
    this.#live?.close();
  }

  get program(): string {
    return this.#program;
  }

  get facts(): string {
    return this.#facts;
  }
}

/** One running goal, stepped solution by solution. */
export class OpenQuery {
  #query: ReturnType<SwiplInstance['prolog']['query']> | null;
  #closed = false;
  #onClose: () => void;

  constructor(query: ReturnType<SwiplInstance['prolog']['query']>, onClose: () => void = () => {}) {
    this.#query = query;
    this.#onClose = onClose;
  }

  /**
   * The next solution, or `null` when there are none left.
   *
   * A Prolog exception thrown by the goal is raised here as a `PrologError`, not
   * returned as a solution, because a caller that ignored it would silently read
   * "undefined procedure" as "no solutions".
   */
  next(): Solution | null {
    if (this.#closed || !this.#query) return null;
    let raw: Record<string, unknown>;
    try {
      raw = this.#query.next() as Record<string, unknown>;
    } catch (error) {
      const described = describeError(String((error as Error).message)).message;
      this.close();
      throw new PrologError(described);
    }
    const { bindings, more, error } = step(raw);
    if (error) {
      const described = describeError(error).message;
      this.close();
      throw new PrologError(described);
    }
    if (!bindings) {
      this.close();
      return null;
    }
    if (!more) this.close();
    return { bindings, more };
  }

  /**
   * Abandons the remaining solutions and frees the bridge's engine slot.
   *
   * This is not tidiness. The bridge has one slot, so a query that is abandoned
   * without being closed leaves the engine unable to run anything — every later
   * goal reports `Unknown procedure`, even for predicates that are loaded. That
   * failure mode is silent and looks like the program vanished, so closing is
   * done here rather than left to the caller.
   */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    const query = this.#query;
    this.#query = null;
    try {
      query?.close();
    } catch {
      // Already closed by the engine exhausting it; nothing to recover.
    }
    this.#onClose();
  }

  get closed(): boolean {
    return this.#closed;
  }
}
