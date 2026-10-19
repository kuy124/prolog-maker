/**
 * The console: one goal at a time, stepped solution by solution, and a prompt you
 * can answer.
 *
 * The shape of this component is dictated by the engine. A goal is opened once and
 * stepped with `next()`, so a query with a million solutions shows its first few
 * without computing the rest. Because the bridge allows only one open query,
 * starting a new goal closes the previous one — which is also why the results table
 * is a snapshot of what has been collected rather than a live view.
 *
 * A goal that calls `read/1` suspends and comes back here for an answer. From the
 * outside a suspension is indistinguishable from a failure, so the console is told
 * about it separately and shows a prompt; treating it as an error would tell people
 * their programme crashed when it is waiting for them.
 *
 * Stop restarts the engine rather than interrupting it: a Prolog goal cannot be
 * interrupted in this build, so the worker is terminated and replaced. Results
 * already collected stay on screen, because losing them would punish stopping a goal
 * that was merely taking too long.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { decodeBindings, formatTerm, isEmptySolution, type Term } from '../model/term';
import type { WireBindings } from '../engine/protocol';
import type { LogEntry } from '../collab/ydoc';

export interface ConsoleProps {
  /** Runs `goal`. */
  onRun: (goal: string) => void;
  /** Continues a suspended goal after an answer has been given. */
  onAnswer: (answer: string) => void;
  onNext: () => void;
  onStop: () => void;
  onClear: () => void;
  /** Solutions collected so far for the current goal. */
  rows: WireBindings[];
  variables: string[];
  /** True once the engine has no more solutions. */
  exhausted: boolean;
  /** True while the engine is working, so Run becomes Stop. */
  busy: boolean;
  error: string | null;
  /** Engine output from `write/1` and `format/2`, in arrival order. */
  output: string[];
  /** Set when the engine is still booting, so Run can be disabled honestly. */
  ready: boolean;
  /**
   * True while the goal is stopped at a `read/1`.
   *
   * This is what turns the input row into a prompt: the terminal is waiting for the
   * next line, exactly as it would be in a real Prolog session.
   */
  waiting: boolean;
  /** The goal last typed, so it survives being answered. */
  goal: string;
  /**
   * Reports the typed text upward as it changes.
   *
   * The goal is not read from this input directly, because the global Control+Enter
   * shortcut can fire while focus is anywhere on the page and must run what is on
   * screen. Without this the shortcut runs whatever was typed last, which is the
   * wrong goal whenever the two have drifted apart.
   */
  onGoalChange: (goal: string) => void;
  /**
   * What has been asked in this room, newest first.
   *
   * The log is shared, so this is the one place a group can see what everyone else
   * tried — including the goal somebody else already solved. Without a way to read
   * it, the log was written, capped and exported but never seen, and the promise
   * that a group could re-run each other's queries was not kept.
   */
  log: LogEntry[];
}

const PAGE = 100;

export function Console({
  onRun,
  onAnswer,
  onNext,
  onStop,
  onClear,
  rows,
  variables,
  exhausted,
  busy,
  error,
  output,
  ready,
  waiting,
  goal,
  onGoalChange,
  log,
}: ConsoleProps) {
  const [shown, setShown] = useState(PAGE);
  const [draft, setDraft] = useState('');
  const outputRef = useRef<HTMLPreElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setShown(PAGE);
  }, [rows.length === 0]);

  // Keep the newest output in view, the way a terminal does.
  useEffect(() => {
    const element = outputRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [output]);

  /*
   * Focus follows the prompt.
   *
   * When the programme asks a question, the only useful thing to do is answer it,
   * so the caret goes there without being asked. Without this, a questionnaire runs
   * to its first question and waits for a click that has no obvious target.
   */
  useEffect(() => {
    if (waiting) inputRef.current?.focus();
  }, [waiting]);

  

  const submit = useCallback(() => {
    const trimmed = draft.trim();
    if (trimmed.length === 0) return;
    setDraft('');
    if (waiting) onAnswer(trimmed);
    else {
      onGoalChange(trimmed);
      onRun(trimmed);
    }
  }, [draft, waiting, onAnswer, onGoalChange, onRun]);

  /*
   * Every keystroke is reported upward, not just on submit, so the global
   * Control+Enter shortcut runs what is on screen even if the goal has never been
   * submitted. While the programme is waiting the text is an answer rather than a
   * goal, so it is not reported — otherwise answering a questionnaire would quietly
   * replace the goal it belongs to.
   */
  const onDraft = useCallback(
    (text: string) => {
      setDraft(text);
      if (!waiting) onGoalChange(text);
    },
    [waiting, onGoalChange],
  );

  /*
   * Once the programme is waiting, the goal is already running: the text typed here
   * is an answer, not a new goal. Keeping the goal around and letting the app
   * remember it avoids the alternative, which is this input going blank the moment a
   * question is asked, and the goal being lost with it.
   */

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      submit();
    }
  };

  const columns = variables.length > 0 ? variables : inferColumns(rows);
  const visible = rows.slice(0, shown);
  // A goal that binds nothing still has an answer, and Prolog's top level prints
  // `true.` for it. Rendering it as a bare row number would lose that, so the table
  // grows a single Result column when there is nothing to show bindings in.
  const heading = columns.length > 0 ? columns : ['Result'];

  return (
    <section className="console" aria-label="Query console">
      {output.length > 0 ? (
        <div className="terminal">
          <p className="terminal__label" id="output-label">
            Output
          </p>
          <pre ref={outputRef} className="terminal__text" aria-labelledby="output-label" tabIndex={0}>
            {output.join('')}
          </pre>
        </div>
      ) : null}

      {/*
        One input, for both jobs.

        It runs a goal when nothing is pending, and answers a question when something
        is. That is how a Prolog top level behaves — one prompt, and what it means
        depends on what the programme last did — and it is why there is no separate box
        for "answers" that has to be filled in before anything can run.
      */}
      <form
        className={waiting ? 'console__prompt console__prompt--waiting' : 'console__prompt'}
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <span className="console__sigil" aria-hidden="true">
          {waiting ? '|' : '?-'}
        </span>
        <input
          ref={inputRef}
          className="console__input"
          // While the programme is waiting, this is its prompt and must not be
          // re-seeded with the goal text: overwriting a half-typed answer with a
          // remembered goal is the kind of thing that loses work.
          value={draft}
          onChange={(event) => onDraft(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={waiting ? 'answer, then press Enter' : 'likes(ada, X)'}
          aria-label={waiting ? 'Answer' : 'Goal'}
          autoComplete="off"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          disabled={!ready && !waiting}
        />
        {waiting ? (
          <>
            <button type="submit" className="btn btn--primary">
              Answer
            </button>
            {/*
              The way out of a questionnaire.

              Every line typed at a waiting prompt is an answer, so without this there
              is no way to abandon one — a mistyped answer or a goal nobody wants any
              more leaves the console waiting forever, with no way to run anything
              else. Stopping a waiting goal costs nothing: there is nothing running.
            */}
            <button type="button" className="btn" onClick={onStop}>
              Stop
            </button>
          </>
        ) : busy ? (
          <button type="button" className="btn btn--danger" onClick={onStop}>
            Stop
          </button>
        ) : (
          <button type="submit" className="btn btn--primary" disabled={!ready}>
            Run
          </button>
        )}
      </form>

      {waiting ? (
        <p className="note note--waiting" role="status">
          <code className="note__goal">{goal}</code> is waiting for an answer.
        </p>
      ) : null}

      {!ready ? <p className="note">Starting the engine…</p> : null}

      {error ? (
        <p className="note note--error" role="alert">
          {error}
        </p>
      ) : null}

      {rows.length > 0 ? (
        <div className="console__results">
          <table className="results">
            <thead>
              <tr>
                {heading.map((column) => (
                  <th key={column} scope="col">
                    {column}
                  </th>
                ))}
                <th scope="col" className="results__index">
                  #
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map((row, index) => {
                const decoded = decodeBindings(row as Record<string, unknown>);
                const empty = isEmptySolution(decoded);
                return (
                  <tr key={index}>
                    {columns.map((column) => (
                      <td key={column}>
                        {empty ? (
                          <span className="results__yes">yes</span>
                        ) : (
                          <code>{renderCell(decoded[column])}</code>
                        )}
                      </td>
                    ))}
                    {columns.length === 0 ? (
                      <td>
                        <span className="results__yes">yes</span>
                      </td>
                    ) : null}
                    <td className="results__index">{index + 1}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          <div className="console__footer">
            <span className="console__count">
              {rows.length} {rows.length === 1 ? 'solution' : 'solutions'}
              {exhausted ? '' : ' so far'}
            </span>
            {!exhausted && !busy ? (
              <button type="button" className="btn" onClick={onNext}>
                Next solution
              </button>
            ) : null}
            {rows.length > shown ? (
              <button type="button" className="btn" onClick={() => setShown((n) => n + PAGE)}>
                Show {Math.min(PAGE, rows.length - shown)} more
              </button>
            ) : null}
            <button type="button" className="btn btn--quiet" onClick={onClear}>
              Clear
            </button>
          </div>
        </div>
      ) : null}

      {rows.length === 0 && exhausted && !error ? <p className="note">No solutions.</p> : null}

      {/*
        What the room has asked.
        
        Collapsed, because the answer to the current goal is what the eye is here
        for and a growing history underneath it would push the results table up
        and off the screen. It opens on demand, newest first, and each entry runs
        again when clicked — which is the whole reason a shared log is worth
        keeping: somebody else's working query is a better starting point than a
        blank prompt.
      */}
      <details className="log" open={false}>
        <summary className="log__summary">
          Query log
          <span className="log__count">{log.length === 0 ? 'empty' : log.length}</span>
        </summary>
        {log.length === 0 ? (
          <p className="note">
            Nothing asked yet. Goals you run appear here for everyone in the room.
          </p>
        ) : (
          <ul className="log__list">
            {[...log].reverse().map((entry) => (
              <li key={entry.id} className="log__item">
                <button
                  type="button"
                  className="log__goal"
                  onClick={() => {
                    onGoalChange(entry.goal);
                    onRun(entry.goal);
                  }}
                  title={`Run ${entry.goal} again`}
                >
                  <code>{entry.goal}</code>
                </button>
                <span className="log__meta">
                  {entry.error ? (
                    <span className="log__failed">failed</span>
                  ) : entry.count === null ? (
                    <span className="log__running">ran</span>
                  ) : (
                    `${entry.count} ${entry.count === 1 ? 'solution' : 'solutions'}`
                  )}
                  {' · '}
                  {entry.who}
                </span>
              </li>
            ))}
          </ul>
        )}
      </details>
    </section>
  );
}

/** Column names when the goal exposed none but the rows carry bindings. */
function inferColumns(rows: WireBindings[]): string[] {
  const first = rows[0];
  if (!first) return [];
  return Object.keys(first).filter((key) => key !== '$tag' && key !== 'success');
}

function renderCell(term: Term | undefined): string {
  return term ? formatTerm(term) : '—';
}


