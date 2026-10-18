/**
 * The console: one goal at a time, stepped solution by solution.
 *
 * The shape of this component is dictated by the engine. A goal is opened once
 * and stepped with `next()`, so a query with a million solutions shows its first
 * ten without computing the rest. Because the engine bridge allows only one open
 * query, starting a new goal closes the previous one — which is also why the
 * results table is a snapshot of what has been collected so far rather than a
 * live view of the engine.
 *
 * Stop restarts the engine rather than interrupting it: a Prolog goal cannot be
 * interrupted in this build, so the worker is terminated and replaced. The
 * results already collected stay on screen, because losing them would punish the
 * user for stopping a goal that was simply taking too long.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { decodeBindings, formatTerm, isEmptySolution, type Term } from '../model/term';
import type { WireBindings } from '../engine/protocol';

export interface ConsoleProps {
  /** Runs `goal`, returning a handle the console can step. Null when it failed. */
  onRun: (goal: string) => void;
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
   * The goal text, controlled by the app.
   *
   * It lives in the app rather than in this component so the global
   * Control+Enter shortcut and the Run button cannot disagree about which goal
   * to run. A local copy made them drift: typing a goal and pressing the
   * shortcut would run the previous one.
   */
  goal: string;
  onGoalChange: (goal: string) => void;
  /**
   * Answers queued for `read/1`, in the order the program will consume them.
   *
   * `read/1` cannot be fed live: this WebAssembly build has no way to deliver a
   * keystroke to a goal that is already blocked inside it, because stopping a goal
   * means terminating the worker. So answers are queued first and attached to the
   * run, which is how a terminal session reads anyway — you have the answers
   * before the questions start.
   */
  answers: string[];
  onAnswersChange: (answers: string[]) => void;
}

const PAGE = 100;

export function Console({
  onRun,
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
  goal,
  onGoalChange,
  answers,
  onAnswersChange,
}: ConsoleProps) {
  const [shown, setShown] = useState(PAGE);
  const [draftAnswer, setDraftAnswer] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const outputRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    setShown(PAGE);
  }, [rows.length === 0]);

  // Keep the newest output in view, the way a terminal does.
  useEffect(() => {
    const element = outputRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [output]);

  const run = useCallback(() => {
    const trimmed = goal.trim();
    if (trimmed.length === 0) return;
    onRun(trimmed);
  }, [goal, onRun]);

  /**
   * Queues one answer.
   *
   * Enter commits rather than submitting, so a questionnaire can be filled in
   * quickly — six `y` presses instead of six tab-and-button round trips. The
   * draft is cleared either way, because leaving the text in place invites the
   * same answer being queued twice by accident.
   */
  const queueAnswer = useCallback(() => {
    const value = draftAnswer.trim();
    setDraftAnswer('');
    if (value.length === 0) return;
    onAnswersChange([...answers, value]);
  }, [draftAnswer, answers, onAnswersChange]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      run();
    }
  };

  const onAnswerKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      queueAnswer();
    }
  };

  const columns = variables.length > 0 ? variables : inferColumns(rows);
  const visible = rows.slice(0, shown);
  // A goal that binds nothing still has an answer, and Prolog's top level prints
  // `true.` for it. Rendering it as a bare row number would lose that, so the
  // table grows a single Result column when there is nothing to show bindings in.
  const heading = columns.length > 0 ? columns : ['Result'];

  return (
    <section className="console" aria-label="Query console">
      <div className="console__prompt">
        <span className="console__sigil" aria-hidden="true">
          ?-
        </span>
        <input
          ref={inputRef}
          className="console__input"
          value={goal}
          onChange={(event) => onGoalChange(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder="likes(ada, X)"
          aria-label="Goal"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
        />
        {busy ? (
          <button type="button" className="btn btn--danger" onClick={onStop}>
            Stop
          </button>
        ) : (
          <button type="button" className="btn btn--primary" onClick={run} disabled={!ready}>
            Run
          </button>
        )}
      </div>

      {!ready ? <p className="note">Starting the engine…</p> : null}

      {error ? (
        <p className="note note--error" role="alert">
          {error}
        </p>
      ) : null}

      {output.length > 0 ? (
        <div className="terminal">
          <p className="terminal__label" id="output-label">
            Output
          </p>
          <pre
            ref={outputRef}
            className="terminal__text"
            aria-labelledby="output-label"
            tabIndex={0}
          >
            {output.join('')}
          </pre>
        </div>
      ) : null}

      {/*
        The answer queue. It sits directly under the transcript because that is
        where the program's questions appear, and it stays in place after a run so
        the same questionnaire can be re-run with different answers — which is the
        whole point of an expert system.
      */}
      <div className="answers">
        <label className="answers__label" htmlFor="answer-input">
          Answers for <code>read/1</code>
        </label>
        <div className="answers__row">
          <input
            id="answer-input"
            className="answers__input"
            value={draftAnswer}
            onChange={(event) => setDraftAnswer(event.target.value)}
            onKeyDown={onAnswerKeyDown}
            placeholder="y"
            aria-describedby="answers-help"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            autoComplete="off"
          />
          <button type="button" className="btn btn--small" onClick={queueAnswer}>
            Add
          </button>
          {answers.length > 0 ? (
            <button
              type="button"
              className="btn btn--quiet btn--small"
              onClick={() => onAnswersChange([])}
            >
              Clear
            </button>
          ) : null}
        </div>

        {answers.length > 0 ? (
          <ul className="answers__list">
            {answers.map((answer, index) => (
              <li key={`${index}-${answer}`} className="answers__chip">
                <code>{answer}</code>
                <button
                  type="button"
                  onClick={() => onAnswersChange(answers.filter((_, i) => i !== index))}
                  aria-label={`Remove answer ${index + 1}, ${answer}`}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        ) : null}

        <p className="answers__help" id="answers-help">
          {answers.length > 0
            ? `${answers.length} queued, in order. Press Run to attach them.`
            : 'A goal that calls read/1 needs its answers queued first — they cannot be typed into a goal that is already waiting.'}
        </p>
      </div>

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

      {rows.length === 0 && exhausted && !error ? (
        <p className="note">No solutions.</p>
      ) : null}
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
