/**
 * The facts panel.
 *
 * Facts are shared data, not engine state. The engine is local to each browser,
 * so a fact one person asserts has to arrive as data and be re-asserted into
 * everyone else's instance. Keeping them as terms in a shared map — rather than
 * as lines in the program, or as `assertz/1` calls into a local engine — is what
 * makes that work: the program can be rewritten without losing the knowledge
 * base, a fact can carry who wrote it, and the same fact list produces the same
 * clause order on every peer.
 *
 * A fact is validated by the engine before it is added, so a typo is refused at
 * the point of entry rather than silently breaking the whole room's consult.
 */

import { useState } from 'react';
import type { Fact } from '../collab/ydoc';

interface Props {
  facts: Fact[];
  /** The local user's name, shown on facts they added. */
  me: string;
  onAdd: (term: string) => void;
  onRemove: (id: string) => void;
  /** Validates a term; returns an error message, or null when it is fine. */
  validate: (term: string) => string | null;
}

export function FactsPanel({ facts, me, onAdd, onRemove, validate }: Props) {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const term = draft.trim();
    if (term.length === 0) return;
    const problem = validate(term);
    if (problem) {
      setError(problem);
      return;
    }
    onAdd(term);
    setDraft('');
    setError(null);
  };

  return (
    <section className="facts" aria-label="Shared facts">
      <div className="facts__header">
        <h2 className="pane__title">Facts</h2>
        {facts.length > 0 ? (
          <span className="facts__count">
            {facts.length} {facts.length === 1 ? 'fact' : 'facts'}
          </span>
        ) : null}
      </div>

      <form className="facts__form" onSubmit={submit}>
        <input
          className="facts__input"
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            setError(null);
          }}
          placeholder="parent(ada, bo)"
          aria-label="New fact"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? 'fact-error' : 'fact-help'}
        />
        <button type="submit" className="btn">
          Add fact
        </button>
      </form>

      {error ? (
        <p id="fact-error" className="note note--error" role="alert">
          {error}
        </p>
      ) : (
        /*
         * The explanation belongs where it is needed, not above the form.
         *
         * It used to sit at the top of the panel, where it pushed the input down
         * and was read before anyone had a reason to care. Below the field it is
         * available exactly when a first-time reader is deciding what to type,
         * and a returning reader is not made to step over it.
         */
        <p id="fact-help" className="facts__intro">
          Shared with everyone here. Asserted after the program, so a fact can use a predicate
          the program defines.
        </p>
      )}

      {facts.length === 0 ? (
        <p className="note">
          No facts yet. A fact is a clause with no body, such as <code>parent(ada, bo)</code>.
        </p>
      ) : (
        <ul className="facts__list">
          {facts.map((fact) => (
            <li key={fact.id} className="facts__item">
              <code className="facts__term">{fact.term}</code>
              <span className="facts__author" title={`Added by ${fact.author}`}>
                {fact.author === me ? 'you' : fact.author}
              </span>
              <button
                type="button"
                className="btn btn--quiet btn--small"
                onClick={() => onRemove(fact.id)}
                aria-label={`Remove ${fact.term}`}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
