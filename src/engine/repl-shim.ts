/**
 * The `read/1` shim: what makes a terminal possible.
 *
 * A terminal stops a goal in the middle of it and carries on when somebody presses
 * Enter. In a Web Worker that is not possible directly, and every direct route was
 * tried and ruled out:
 *
 *   - `read/1` cannot be fed from JavaScript. Emscripten's stdin hook
 *     (`FS_stdin_getChar`) only reads `process.stdin` under Node or `window.prompt`
 *     in a window. A worker has neither, so `user_input` sits at end-of-file and
 *     every `read/1` yields `end_of_file` immediately.
 *
 *   - `await/2`, which would suspend a goal and resume it with a value, raises
 *     `permission_error(run, ...)` whatever `set_prolog_flag/2` is given.
 *
 *   - `Atomics.wait` would block the worker, but SharedArrayBuffer needs
 *     cross-origin isolation, and a static host cannot send the COOP and COEP
 *     headers that enable it. Measured against the deployed site:
 *     `crossOriginIsolated` is false there, so SharedArrayBuffer is undefined.
 *
 * What does work is an exception. Throwing stops the query at exactly that point,
 * which is what suspension means here. The host catches it, keeps the output printed
 * so far, and re-enters the same goal with one more answer available. The work
 * before a read is deterministic, so it replays identically and the user sees only
 * what is genuinely new.
 *
 * It throws rather than fails, and the difference is the whole design. This is the
 * questionnaire from the IKM PNJ expert system:
 *
 *     data_pengamatan :-
 *         pertanyaan(Tanya, Obs),
 *         write(Tanya), nl,
 *         read(Yatidak),
 *         Yatidak = y,
 *         assert(observation(Obs)),
 *         fail.
 *     data_pengamatan.
 *
 * If `read/1` fails when it has no answer, the `fail` at the end backtracks into
 * `pertanyaan/2` and asks the *next* question instead of waiting. The questionnaire
 * runs away in a single pass and the user is never asked anything. Throwing is what
 * stops it at the first question.
 *
 * The answers live in a non-backtrackable global and are popped with `nb_setval/2`.
 * An earlier version used a dynamic predicate, which backtracked: the second read
 * found the first answer again and the program reported its first answer twice.
 * `nb_getval`/`nb_setval` is not a choicepoint, so a read consumes exactly one answer
 * and never offers it again.
 *
 * Inlined here rather than kept as a `.pl` file beside the app because it must be
 * re-consulted together with the programme on every edit. As clauses in the loaded
 * file it cannot be dropped by the build, and a programme that wants its own
 * `read/1` is not silently overruled by a stale copy of this one.
 */
export const REPL_SHIM = `
% Makes read/1 suspend instead of failing. The reasoning is in repl-shim.ts.

:- redefine_system_predicate(read(_)).

read(Term) :-
    repl_next(Term).

% Pop one answer, or throw. The throw is the suspension: it stops the goal at exactly
% this point rather than failing past it.
repl_next(Term) :-
    nb_getval(repl_queue, Queue),
    (   Queue = [Term|Rest]
    ->  nb_setval(repl_queue, Rest)
    ;   nb_setval(repl_waiting, true),
        throw(repl_need_input)
    ).

% Whether the last attempt stopped for input.
%
% Unifies with a variable rather than being asked as a plain question, because the
% bridge returns a ground goal's bindings as a bare boolean: repl_waiting. reads
% back as true whether it succeeded or failed, and success carries no value.
repl_waiting_state(V) :-
    nb_getval(repl_waiting, V).

% Seeding the queue resets the attempt, so a stale "waiting" from the previous one
% cannot be mistaken for this one's.
repl_load(Queue) :-
    nb_setval(repl_queue, Queue),
    nb_setval(repl_waiting, false).
`;

/**
 * The error the shim throws to suspend a goal.
 *
 * Matched by name rather than by shape: the bridge turns a Prolog condition into a
 * message string, and the atom is all that survives.
 */
export const NEED_INPUT = 'repl_need_input';

/** True when a failure is the shim asking for input rather than a real error. */
export function isNeedingInput(message: string): boolean {
  return message.includes(NEED_INPUT);
}