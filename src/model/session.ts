/**
 * The terminal session: what a suspended goal remembers.
 *
 * A goal that stops at a `read/1` is resumed by re-entering it with one more answer.
 * The replay takes every answer again from the start, which reproduces the output
 * already shown and carries on to the next question.
 */

export interface Session {
  goal: string;
  /** Every answer given, in order. Replayed from the top on each attempt. */
  answers: string[];
  /** True when the last attempt stopped because it wanted another answer. */
  waiting: boolean;
}

export function startSession(goal: string): Session {
  return { goal, answers: [], waiting: false };
}

/**
 * Adds one answer.
 *
 * Answers accumulate rather than being consumed. A resumed attempt replays the goal
 * from the beginning and takes them again from the start, so the whole list is needed
 * every time; offering only the newest one would answer the *first* question with it
 * and leave every later question unfed.
 */
export function answer(session: Session, term: string): Session {
  return { ...session, answers: [...session.answers, term], waiting: false };
}

/** Records that the attempt stopped and wants an answer. */
export function suspend(session: Session): Session {
  return { ...session, waiting: true };
}