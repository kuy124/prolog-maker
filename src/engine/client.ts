/**
 * The main thread's handle on the engine worker.
 *
 * This is where "Stop" lives. A Prolog goal cannot be interrupted in this build —
 * there is no `call_with_time_limit/2` and no `alarm/4`, because both need
 * threads — so stopping means terminating the worker and starting a new one.
 * That is why the client, not the worker, owns the lifetime: it can throw the
 * whole engine away and boot a replacement without the rest of the app noticing.
 *
 * The subtle part is that a replacement worker starts with an empty engine. The
 * program has to be reloaded into it, and that reload has to complete before the
 * next goal runs, or the goal is answered by a worker that has never heard of the
 * program. The client therefore tracks the reload itself rather than leaving it to
 * the caller: `restart()` posts the program as soon as the replacement reports
 * booted, and `open()` waits for that consult to be acknowledged before it starts
 * the goal.
 */

import EngineWorker from './engine.worker.ts?worker';
import type { EngineRequest, EngineResponse, WireBindings } from './protocol';

export interface EngineStatus {
  ready: boolean;
  version: string;
  bootMs: number;
  /** True while a goal is being evaluated in the worker. */
  busy: boolean;
}

export interface SolutionMessage {
  bindings: WireBindings;
  more: boolean;
}

type Handler = {
  onBooted: (version: string, bootMs: number) => void;
  onConsulted: () => void;
  onConsultError: (message: string, line: number | null) => void;
  onOpened: (query: number, variables: string[]) => void;
  onOpenError: (message: string) => void;
  onSolution: (query: number, solution: SolutionMessage) => void;
  onDone: (query: number) => void;
  onQueryError: (query: number, message: string) => void;
  /** The goal suspended at a `read/1` and is waiting for an answer. */
  onNeedsInput: () => void;
  onOutput: (text: string) => void;
  onFailed: (message: string) => void;
};

export class EngineClient {
  #worker: Worker | null = null;
  #handlers: Handler;
  #nextId = 1;
  /**
   * The program the worker should be running.
   *
   * Kept separately from what has actually been loaded, because a consult can be
   * rejected — a syntax error — and the worker is then still running the previous
   * program. Restarting has to reload the last program that *worked*, not the one
   * that was refused, or Stop would silently wipe a room's knowledge base.
   */
  #pending: { program: string; facts: string } | null = null;
  /** The last program the worker accepted, which is what it is running now. */
  #loadedProgram: { program: string; facts: string } | null = null;
  /** Resolvers waiting for the engine to be ready to accept a goal. */
  #ready: Array<() => void> = [];
  /** True once the current worker has loaded a program. */
  #loaded = false;

  constructor(handlers: Handler) {
    this.#handlers = handlers;
  }

  /** Boots the worker. */
  start(): void {
    if (this.#worker) return;
    const worker = new EngineWorker();
    worker.onmessage = (event: MessageEvent<EngineResponse>) => this.#receive(event.data);
    worker.onerror = (event) => this.#handlers.onFailed(event.message || 'The engine failed to start.');
    this.#worker = worker;
    this.#loaded = false;
    this.#send({ id: this.#nextId++, kind: 'boot' });
  }

  /**
   * Replaces the worker with a fresh one and reloads the program into it.
   *
   * The old worker is terminated rather than asked to stop, because a running
   * Prolog goal cannot be interrupted. The program reloaded is the last one that
   * was *accepted*, so a refused edit cannot be resurrected by Stop.
   */
  restart(): void {
    this.#worker?.terminate();
    this.#worker = null;
    this.#ready = [];
    this.start();
    // The last program the worker accepted. When every edit so far had a syntax
    // error there is nothing accepted, and the replacement engine is genuinely
    // empty — which is correct: there is no working program to go back to.
    const program = this.#loadedProgram;
    if (program) {
      this.#send({ id: this.#nextId++, kind: 'consult', program: program.program, facts: program.facts });
    } else {
      this.#markReady();
    }
  }

  /** Throws the current goal away by replacing the engine. */
  stop(): void {
    this.restart();
  }

  consult(program: string, facts: string): void {
    this.#pending = { program, facts };
    this.#loaded = false;
    this.#send({ id: this.#nextId++, kind: 'consult', program, facts });
  }

  /**
   * Installs the answers `read/1` will consume, in order.
   *
   * Sent as its own message so it can be queued ahead of `open`. The worker
   * handles messages in order, so the answers are in place before the goal that
   * asks for them starts.
   */
  input(lines: string[]): void {
    this.#send({ id: this.#nextId++, kind: 'input', lines });
  }

  /**
   * Starts a goal, once the worker has a program loaded.
   *
   * Deferring is what makes Stop usable: the replacement worker needs a few
   * hundred milliseconds to boot and reload, and a goal sent before then would be
   * answered with "unknown procedure" for every predicate in the program.
   */
  open(goal: string): void {
    if (this.#loaded) {
      this.#send({ id: this.#nextId++, kind: 'open', goal });
      return;
    }
    this.#ready.push(() => this.#send({ id: this.#nextId++, kind: 'open', goal }));
  }

  next(query: number): void {
    this.#send({ id: this.#nextId++, kind: 'next', query });
  }

  close(query: number): void {
    this.#send({ id: this.#nextId++, kind: 'close', query });
  }

  destroy(): void {
    this.#worker?.terminate();
    this.#worker = null;
    this.#ready = [];
  }

  #markReady(): void {
    this.#loaded = true;
    const waiting = this.#ready;
    this.#ready = [];
    for (const resume of waiting) resume();
  }

  #send(request: EngineRequest): void {
    this.#worker?.postMessage(request);
  }

  #receive(message: EngineResponse): void {
    const handler = this.#handlers;
    switch (message.kind) {
      case 'booted':
        handler.onBooted(message.version, message.bootMs);
        break;
      case 'consulted':
        // A consult that lands means the worker now knows the program, so any
        // goal waiting on it can start.
        this.#loadedProgram = this.#pending;
        this.#markReady();
        handler.onConsulted();
        break;
      case 'consultError':
        // Still mark ready: the goal will fail with a clear message rather than
        // hanging forever waiting for a consult that will never succeed.
        this.#markReady();
        handler.onConsultError(message.message, message.line);
        break;
      case 'inputSet':
        break;
      case 'needsInput':
        handler.onNeedsInput();
        break;
      case 'opened':
        handler.onOpened(message.query, message.variables);
        break;
      case 'openError':
        handler.onOpenError(message.message);
        break;
      case 'solution':
        handler.onSolution(message.query, { bindings: message.bindings, more: message.more });
        break;
      case 'done':
        handler.onDone(message.query);
        break;
      case 'queryError':
        handler.onQueryError(message.query, message.message);
        break;
      case 'output':
        handler.onOutput(message.text);
        break;
      case 'failed':
        handler.onFailed(message.message);
        break;
      default:
        break;
    }
  }
}
