/**
 * The terminal session: what a suspended goal remembers.
 */
import { describe, expect, it } from 'vitest';
import { answer, startSession, suspend } from '../../src/model/session';

describe('startSession', () => {
  it('starts with the goal and no answers', () => {
    expect(startSession('mulai.')).toEqual({ goal: 'mulai.', answers: [], waiting: false });
  });
});

describe('suspend', () => {
  it('marks the session as waiting', () => {
    expect(suspend(startSession('mulai.')).waiting).toBe(true);
  });

  it('keeps the goal, which is what a resume re-enters', () => {
    expect(suspend(startSession('mulai.')).goal).toBe('mulai.');
  });

  it('does not modify the session it is given', () => {
    const session = startSession('mulai.');
    suspend(session);
    expect(session.waiting).toBe(false);
  });
});

describe('answer', () => {
  /**
   * The one that actually bit.
   *
   * Seeding a resume with only the answers past the suspension point looks right and
   * is not: the replay starts at the top of the goal, so it takes the newest answer
   * at the *first* question and every later question goes unfed. The questionnaire
   * then asks its first question over and over. Answers therefore accumulate and the
   * whole list is offered every time.
   */
  it('accumulates rather than consuming, so a replay is fed from the top', () => {
    let session = suspend(startSession('mulai.'));
    session = answer(session, 'y');
    expect(session.answers).toEqual(['y']);

    session = suspend(session);
    session = answer(session, 't');
    expect(session.answers).toEqual(['y', 't']);

    session = suspend(session);
    session = answer(session, 'y');
    expect(session.answers).toEqual(['y', 't', 'y']);
  });

  it('keeps the goal, so the session can still be resumed', () => {
    expect(answer(startSession('mulai.'), 'y').goal).toBe('mulai.');
  });

  it('clears the waiting flag, since the goal is on its way to the next question', () => {
    expect(answer(suspend(startSession('mulai.')), 'y').waiting).toBe(false);
  });

  it('copies the answers, so later mutation cannot reach in', () => {
    const first = answer(startSession('mulai.'), 'y');
    first.answers.push('t');
    expect(answer(startSession('mulai.'), 'y').answers).toEqual(['y']);
  });
});