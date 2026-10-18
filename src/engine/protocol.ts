/**
 * Wire types for the engine worker.
 *
 * The worker is deliberately dumb: it owns a SWI-Prolog instance and nothing
 * else. It knows how to consult a program, run a goal, and hand back solutions
 * one at a time. It does not know what a room is, who is in it, or how the
 * program got there.
 *
 * That split matters because the engine cannot be interrupted. There is no
 * `call_with_time_limit/2` and no `alarm/4` in the WASM build (they need
 * threads), so the only way to stop a goal that has run away is to terminate
 * the worker and start a new one. Keeping the worker stateless apart from the
 * engine is what makes that replacement invisible to the rest of the app.
 */

/** A term as the engine's JSON bridge reports it. */
export type WireTerm =
  | string
  | number
  | boolean
  | null
  | WireTerm[]
  /** Compound: functor name, arguments. */
  | { $t: 't'; [functor: string]: unknown }
  /** Partial list: head elements and a tail. */
  | { $t: 'l'; v: WireTerm[]; t: WireTerm }
  /** Unbound variable, identified by its internal number. */
  | { $t: 'v'; v: number }
  /** Blob (engine, stream, ...): opaque, shown but not interpreted. */
  | { $t: 'b' };

/** Variable name to value, as returned for one solution. */
export type WireBindings = Record<string, WireTerm>;

export type EngineRequest =
  | { id: number; kind: 'boot' }
  | { id: number; kind: 'consult'; program: string; facts: string }
  | { id: number; kind: 'open'; goal: string }
  | { id: number; kind: 'next'; query: number }
  | { id: number; kind: 'close'; query: number };

export type EngineResponse =
  | { id: number; kind: 'booted'; version: string; bootMs: number }
  | { id: number; kind: 'consulted' }
  | { id: number; kind: 'consultError'; message: string; line: number | null }
  | { id: number; kind: 'opened'; query: number; variables: string[] }
  | { id: number; kind: 'openError'; message: string }
  | { id: number; kind: 'solution'; query: number; bindings: WireBindings; more: boolean }
  | { id: number; kind: 'done'; query: number }
  | { id: number; kind: 'queryError'; query: number; message: string }
  | { id: number; kind: 'output'; text: string }
  | { id: number; kind: 'failed'; message: string };
