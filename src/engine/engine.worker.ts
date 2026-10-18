/**
 * The engine worker: a message shim over `PrologEngine`.
 *
 * All the interesting logic — validation, loading, term decoding, error wording —
 * lives in `engine.ts`, which the unit tests drive directly in Node against the
 * same WebAssembly build. This file only carries messages across the boundary,
 * so there is nothing here that the tests do not already cover.
 *
 * The worker exists for two reasons. A Prolog goal can run for a long time, and
 * running it on the main thread would freeze the editor. And a goal cannot be
 * interrupted — this build has no `call_with_time_limit/2` and no `alarm/4`,
 * because both need threads — so the only way to stop one is to terminate the
 * worker and start another. Keeping the engine in a worker makes that
 * replacement invisible: the main thread just gets a fresh worker.
 */

import { PrologEngine, bootEngine, type OutputSink } from './engine';
import { isNeedingInput } from './repl-shim';
import type { EngineRequest, EngineResponse } from './protocol';

declare const SWIPL: (options: Record<string, unknown>) => Promise<unknown>;

const scope = self as unknown as {
  location: { href: string };
  postMessage: (message: EngineResponse) => void;
  onmessage: ((event: MessageEvent<EngineRequest>) => void) | null;
};

/**
 * The vendored engine sits beside the built assets.
 *
 * The worker itself is emitted into `assets/`, so `../engine/` reaches
 * `public/engine/` after Vite has copied it. This is the one path in the app that
 * depends on the build layout, which is why it is stated once.
 */
const ENGINE_URL = new URL('../engine/', scope.location.href).href;

const sink: OutputSink = { current: () => {} };
let engine: PrologEngine | null = null;
let booting: Promise<PrologEngine> | null = null;
let currentRequest = 0;

/** Open queries by the id the main thread uses, so a `next` can find its own. */
const open = new Map<number, ReturnType<PrologEngine['open']>['handle']>();
let nextQueryId = 1;

function reply(message: EngineResponse): void {
  scope.postMessage(message);
}

/**
 * Forwards whatever the goal has written since the last call.
 *
 * Output is read from a transcript file rather than from the bridge's `print`
 * callback, because Emscripten discards the newline character when it flushes a
 * line. See `TRANSCRIPT_FILE` in engine.ts for the detail.
 *
 * Reads the booted engine directly rather than awaiting `ready()`: this runs after
 * a step has already completed, so the engine necessarily exists, and awaiting
 * would add a microtask between the step and its output.
 */
function emit(): void {
  if (!engine) return;
  const text = engine.takeOutput();
  if (text.length > 0) reply({ id: currentRequest, kind: 'output', text });
}

/**
 * Boots the engine and loads the program.
 *
 * `importScripts` rather than `import`: `swipl-web.js` is Emscripten output, a
 * classic script that assigns a global `SWIPL` and exports nothing. `locateFile`
 * is required because Emscripten normally derives its base URL from
 * `document.currentScript`, and a worker has no `document` — without it the
 * `.wasm` and `.data` fetches resolve against the worker's own directory and 404.
 */
async function boot(): Promise<PrologEngine> {
  if (engine) return engine;
  if (booting) return booting;

  booting = (async () => {
    const started = performance.now();
    importScripts(new URL('swipl-web.js', ENGINE_URL).href);
    const instance = await bootEngine(
      SWIPL,
      sink,
      { arguments: ['-q'], locateFile: (path: string) => new URL(path, ENGINE_URL).href },
    );
    const prolog = new PrologEngine(instance, sink);
    prolog.onOutput((text) => reply({ id: currentRequest, kind: 'output', text }));
    engine = prolog;
    const bootMs = Math.round(performance.now() - started);
    reply({ id: currentRequest, kind: 'booted', version: prolog.version(), bootMs });
    return prolog;
  })();

  return booting;
}

async function ready(): Promise<PrologEngine> {
  return engine ?? boot();
}

scope.onmessage = (event: MessageEvent<EngineRequest>) => {
  const request = event.data;
  currentRequest = request.id;

  void (async () => {
    try {
      switch (request.kind) {
        case 'boot': {
          await boot();
          break;
        }
        case 'consult': {
          const prolog = await ready();
          try {
            prolog.consult(request.program, request.facts);
            reply({ id: request.id, kind: 'consulted' });
          } catch (error) {
            const failure = error as { message?: string; line?: number | null };
            reply({
              id: request.id,
              kind: 'consultError',
              message: String(failure?.message ?? 'The program could not be loaded.'),
              line: typeof failure?.line === 'number' ? failure.line : null,
            });
          }
          break;
        }
        case 'input': {
          const prolog = await ready();
          try {
            prolog.setInput(request.lines);
            reply({ id: request.id, kind: 'inputSet' });
          } catch (error) {
            reply({
              id: request.id,
              kind: 'failed',
              message: String((error as Error)?.message ?? 'The answers could not be installed.'),
            });
          }
          break;
        }
        case 'open': {
          const prolog = await ready();
          try {
            prolog.resetOutput();
            const { variables, handle } = prolog.open(request.goal);
            const queryId = nextQueryId++;
            open.set(queryId, handle);
            reply({ id: request.id, kind: 'opened', query: queryId, variables });
          } catch (error) {
            reply({
              id: request.id,
              kind: 'openError',
              message: String((error as Error)?.message ?? 'That goal could not be parsed.'),
            });
          }
          break;
        }
        case 'next': {
          const handle = open.get(request.query);
          if (!handle) {
            reply({ id: request.id, kind: 'done', query: request.query });
            break;
          }
          try {
            const solution = handle.next();
            // Output is drained before every reply, so a goal that writes before
            // it stops still leaves its transcript behind.
            emit();
            if (!solution) {
              open.delete(request.query);
              reply({ id: request.id, kind: 'done', query: request.query });
              break;
            }
            reply({
              id: request.id,
              kind: 'solution',
              query: request.query,
              bindings: solution.bindings as Record<string, never>,
              more: solution.more,
            });
            if (!solution.more) {
              open.delete(request.query);
              reply({ id: request.id, kind: 'done', query: request.query });
            }
          } catch (error) {
            emit();
            open.delete(request.query);
            const message = String((error as Error)?.message ?? 'The goal failed.');
            // A suspension arrives as an exception, because that is the only thing
            // that stops a goal mid-execution in a worker. It is reported as itself
            // rather than as a failure: the program asked a question, and it is
            // waiting for an answer, which is not an error.
            if (isNeedingInput(message)) {
              reply({ id: request.id, kind: 'needsInput' });
              break;
            }
            reply({
              id: request.id,
              kind: 'queryError',
              query: request.query,
              message,
            });
          }
          break;
        }
        case 'close': {
          open.get(request.query)?.close();
          open.delete(request.query);
          break;
        }
        default:
          break;
      }
    } catch (error) {
      reply({
        id: request.id,
        kind: 'failed',
        message: String((error as Error)?.message ?? 'The engine stopped unexpectedly.'),
      });
    }
  })();
};
