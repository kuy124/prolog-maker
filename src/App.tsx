/**
 * The app.
 *
 * One room is one `RoomHandle`: a Yjs document, its IndexedDB cache, and a
 * WebRTC provider. Switching rooms tears the whole thing down and builds a new
 * one, which is why the room lives in a session object rather than being mutated
 * in place.
 *
 * The engine is deliberately *not* shared state. Every peer runs its own copy of
 * SWI-Prolog in its own worker, so a query is never queued behind somebody else's.
 * What is shared is the source: the program, the facts, and the log of what has
 * been asked.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Y from 'yjs';
import { ProgramEditor, type RemoteCaret } from './editor/ProgramEditor';
import { Console } from './ui/Console';
import { FactsPanel } from './ui/FactsPanel';
import { PresenceBar } from './ui/PresenceBar';
import { ExportDialog, HelpPanel, ShareDialog } from './ui/Dialogs';
import { ThemePicker } from './ui/ThemePicker';
import { EngineClient } from './engine/client';
import { createRoom, readPeers, connectedPeerCount, type PeerState, type RoomHandle } from './collab/provider';
import { createLocalIdentity, rememberIdentity, type Identity } from './collab/identity';
import {
  PROGRAM,
  addFact,
  appendLog,
  factsSource,
  readFacts,
  readLog,
  reconcileProgram,
  removeFact,
  seedProgram,
  type Fact,
  type LogEntry,
} from './collab/ydoc';
import {
  buildShareUrl,
  newRoomId,
  parseRoomFile,
  parseShareHash,
  serializeRoom,
  type RoomFile,
} from './model/snapshot';
import { EXAMPLES, exampleById } from './model/examples';
import {
  answer,
  startSession,
  suspend,
  type Session as ReplSession,
} from './model/session';
import { savedTheme, rememberTheme, applyTheme } from './ui/theme';
import type { WireBindings } from './engine/protocol';

type Session = { room: string; seed: { program: string; facts: Fact[] } | null; fromLink: boolean };

/** The room this browser was last in, so a reload returns to it. */
const LAST_ROOM = 'prolog:last-room';

/**
 * Reads the room from the URL, or resumes the last one, or makes a new one.
 *
 * The last-room fallback is what makes a reload keep the program. A room lives in
 * IndexedDB keyed by its id, so without remembering the id a reload would build a
 * new room and show a new empty document — the old one still on disk, unreachable.
 * The hash is not enough on its own, because the first visit has no hash until
 * the app writes one.
 */
function readSession(): Session {
  if (typeof window === 'undefined') return { room: newRoomId(), seed: null, fromLink: false };
  const parsed = parseShareHash(window.location.hash);
  if (parsed.room) {
    return {
      room: parsed.room,
      seed: parsed.program !== undefined ? { program: parsed.program, facts: parsed.facts ?? [] } : null,
      fromLink: true,
    };
  }
  try {
    const stored = localStorage.getItem(LAST_ROOM);
    if (stored && stored.trim().length > 0) {
      return { room: stored.trim(), seed: null, fromLink: false };
    }
  } catch {
    // Private mode; a new room is a reasonable outcome.
  }
  return { room: newRoomId(), seed: null, fromLink: false };
}

function rememberRoom(room: string): void {
  try {
    localStorage.setItem(LAST_ROOM, room);
  } catch {
    // Non-fatal: the room still works, it just will not be resumed.
  }
}

const START_PROGRAM = `% Welcome. This program is shared with everyone in the room.
% Press Run, or edit this text — everyone sees the change as you type.

likes(ada, prolog).
likes(ada, tea).
likes(bo, prolog).

both(X, Y) :-
    likes(X, Z),
    likes(Y, Z),
    X \\== Y.
`;

const START_GOAL = 'both(ada, Who).';

export function App() {
  const [session, setSession] = useState<Session>(readSession);
  const [theme, setTheme] = useState(savedTheme);

  useEffect(() => {
    applyTheme(theme);
    rememberTheme(theme);
    if (theme !== 'system') return;
    // `system` has no tokens of its own; re-apply when the machine changes.
    const query = window.matchMedia?.('(prefers-color-scheme: dark)');
    const onChange = () => applyTheme('system');
    query?.addEventListener('change', onChange);
    return () => query?.removeEventListener('change', onChange);
  }, [theme]);

  const openRoom = useCallback(
    (room: string, seed: Session['seed'], fromLink: boolean) => {
      rememberRoom(room);
      window.location.hash = `room=${encodeURIComponent(room)}`;
      setSession({ room, seed, fromLink });
    },
    [],
  );

  const newRoom = useCallback(() => {
    openRoom(newRoomId(), null, false);
  }, [openRoom]);

  return (
    <Editor
      key={session.room}
      session={session}
      theme={theme}
      onTheme={setTheme}
      onNewRoom={newRoom}
    />
  );
}

interface EditorProps {
  session: Session;
  theme: string;
  onTheme: (id: string) => void;
  onNewRoom: () => void;
}

function Editor({ session, theme, onTheme, onNewRoom }: EditorProps) {
  const [room, setRoom] = useState<RoomHandle | null>(null);
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [peers, setPeers] = useState<PeerState[]>([]);
  const [networkPeers, setNetworkPeers] = useState(0);

  const [ready, setReady] = useState(false);
  const [version, setVersion] = useState('');
  const [bootMs, setBootMs] = useState(0);
  const [busy, setBusy] = useState(false);

  const [facts, setFacts] = useState<Fact[]>([]);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [program, setProgram] = useState('');
  const [syntaxError, setSyntaxError] = useState<{ message: string; line: number | null } | null>(null);

  const [rows, setRows] = useState<WireBindings[]>([]);
  const [variables, setVariables] = useState<string[]>([]);
  const [exhausted, setExhausted] = useState(false);
  const [queryError, setQueryError] = useState<string | null>(null);
  const [output, setOutput] = useState<string[]>([]);
  const [currentQuery, setCurrentQuery] = useState<number | null>(null);
  const [goal, setGoal] = useState(START_GOAL);
  /**
   * The suspended goal, or null when nothing is waiting for an answer.
   *
   * This is what turns a questionnaire into a terminal. A goal that calls `read/1`
   * cannot be paused and resumed directly in a worker — no input path, `await/2` is
   * gated, and a blocking wait needs headers a static host cannot send. Instead the
   * goal is re-entered with one more answer available, which replays the deterministic
   * prefix and carries on from the question. The prefix produces the same output it
   * did last time, so only what follows the question is new and the user sees one
   * continuous session.
   */
  const [repl, setRepl] = useState<ReplSession | null>(null);

  const [dialog, setDialog] = useState<'share' | 'export' | 'help' | 'examples' | null>(null);

  const engineRef = useRef<EngineClient | null>(null);
  const outputBuffer = useRef<string[]>([]);
  const programRef = useRef('');
  const factsRef = useRef<Fact[]>([]);
  /**
   * The session, in a ref as well as state.
   *
   * The engine callbacks are created once, when the engine starts, so they cannot
   * close over state that changes. A ref is what lets them see the current session
   * without being rebuilt on every answer.
   */
  const sessionRef = useRef<ReplSession | null>(null);

  // ---------------------------------------------------------------- the room

  useEffect(() => {
    const handle = createRoom(session.room);
    setRoom(handle);
    // Remember the room before anything can go wrong, so a reload always returns
    // here rather than to a new empty room.
    rememberRoom(session.room);
    if (!window.location.hash.includes('room=')) {
      window.location.hash = `room=${encodeURIComponent(session.room)}`;
    }

    const local = createLocalIdentity(handle.ydoc.clientID);
    setIdentity(local);
    handle.awareness.setLocalStateField('name', local.name);
    handle.awareness.setLocalStateField('color', local.color);
    handle.awareness.setLocalStateField('cursor', null);
    handle.awareness.setLocalStateField('goal', null);
    handle.awareness.setLocalStateField('running', false);

    void handle.whenLoaded.then(() => {
      const text = handle.ydoc.getText(PROGRAM);
      // A snapshot link wins over an empty document, so opening a shared copy
      // shows the sender's program rather than a blank one.
      if (text.length === 0 && session.seed) {
        seedProgram(handle.ydoc, session.seed.program);
        for (const fact of session.seed.facts) addFact(handle.ydoc, fact);
      } else if (text.length === 0) {
        seedProgram(handle.ydoc, START_PROGRAM);
      }
    });

    /*
     * Two peers can seed the same room before they have seen each other, which
     * Yjs merges into the program written twice rather than once. The repair is
     * registered first so it deletes the extra copy before the render below
     * reads the text, and so no peer ever sees the doubled program.
     */
    const reconcile = () => reconcileProgram(handle.ydoc);
    handle.ydoc.on('update', reconcile);

    const sync = () => {
      setFacts(readFacts(handle.ydoc));
      setLog(readLog(handle.ydoc));
      setProgram(handle.ydoc.getText(PROGRAM).toString());
    };
    handle.ydoc.on('update', sync);
    sync();

    const awarenessChange = () => {
      setPeers(readPeers(handle.awareness, handle.ydoc.clientID));
      setNetworkPeers(connectedPeerCount(handle.provider));
    };
    handle.awareness.on('change', awarenessChange);
    const poll = window.setInterval(awarenessChange, 1000);

    return () => {
      window.clearInterval(poll);
      handle.awareness.off('change', awarenessChange);
      handle.ydoc.off('update', reconcile);
      handle.ydoc.off('update', sync);
      handle.destroy();
      setRoom(null);
    };
  }, [session]);

  // -------------------------------------------------------------- the engine

  useEffect(() => {
    const client = new EngineClient({
      onBooted: (engineVersion, engineBootMs) => {
        setReady(true);
        setVersion(engineVersion);
        setBootMs(engineBootMs);
        // The client reloads the program into a replacement worker itself, so
        // there is nothing to re-send here.
      },
      onConsulted: () => setSyntaxError(null),
      onConsultError: (message, line) => {
        // The engine reports the reason; the app adds the line, so the sentence
        // reads once rather than twice.
        setSyntaxError({ message: `Syntax error: ${message.replace(/\.$/, '')}`, line });
        setBusy(false);
      },
      onOpened: (query, columns) => {
        setCurrentQuery(query);
        setVariables(columns);
        setRows([]);
        setExhausted(false);
        setQueryError(null);
        client.next(query);
      },
      onOpenError: (message) => {
        setBusy(false);
        setQueryError(message);
      },
      onSolution: (query, solution) => {
        if (query !== currentQueryRef.current) return;
        setRows((previous) => [...previous, solution.bindings]);
        // The worker is idle between solutions: it has stopped computing and is
        // waiting to be asked for the next one. So `busy` clears here even when
        // alternatives remain — otherwise Next would never appear, because the
        // console only offers it while the engine is not busy.
        setBusy(false);
        if (!solution.more) setExhausted(true);
      },
      onDone: () => {
        setBusy(false);
        setExhausted(true);
      },
      onQueryError: (_query, message) => {
        setBusy(false);
        setExhausted(true);
        setQueryError(message);
      },
      onNeedsInput: () => {
        // The programme asked a question. It is not busy — it is waiting — so the
        // console shows a prompt rather than a Stop button, and Stop is not offered
        // because there is nothing to interrupt: the worker is idle between steps.
        const current = sessionRef.current;
        sessionRef.current = current ? suspend(current) : startSession('');
        setRepl(sessionRef.current);
        setBusy(false);
      },
      onOutput: (text) => {
        outputBuffer.current = [...outputBuffer.current, text];
        setOutput(outputBuffer.current);
      },
      onFailed: (message) => {
        setBusy(false);
        setQueryError(message);
      },
    });
    engineRef.current = client;
    client.start();
    return () => {
      client.destroy();
      engineRef.current = null;
    };
    // The engine outlives room changes on purpose: it belongs to the browser,
    // not to the room.
  }, []);

  // The handlers above need the current query without re-creating the client.
  const currentQueryRef = useRef<number | null>(null);
  useEffect(() => {
    currentQueryRef.current = currentQuery;
  }, [currentQuery]);

  /**
   * Re-consults whenever the program or the facts change.
   *
   * Debounced, because a consult parses the whole program and a keystroke is not a
   * reason to do that. The first consult is the exception: it runs immediately, so
   * the room's program is in the engine as soon as the engine is up. Debouncing it
   * too would mean an edit made in that first window is consulted while the
   * previous program was still loading — and since a bad edit is rejected, the
   * engine would end up with nothing loaded at all and the room would look broken.
   */
  const consultTimer = useRef<number | null>(null);
  const firstConsultDone = useRef(false);
  useEffect(() => {
    programRef.current = program;
    factsRef.current = facts;
    if (!ready) return;
    if (consultTimer.current !== null) window.clearTimeout(consultTimer.current);

    if (!firstConsultDone.current) {
      firstConsultDone.current = true;
      engineRef.current?.consult(program, factsSource(facts));
      return;
    }
    consultTimer.current = window.setTimeout(() => {
      engineRef.current?.consult(program, factsSource(facts));
    }, 400);
    return () => {
      if (consultTimer.current !== null) window.clearTimeout(consultTimer.current);
    };
  }, [program, facts, ready]);

  // ---------------------------------------------------------------- actions

  /**
   * Clears the transcript.
   *
   * Called on a fresh run, and on a resume — which looks like the opposite of what
   * it should be, and is not. A resumed goal is re-entered, so the engine reprints
   * everything it printed last time, identically, before carrying on past the
   * question. The buffer therefore has to start empty for the new attempt, or the
   * replayed prefix lands on top of the original and the user sees each line twice.
   * What they end up seeing is the whole session, exactly once, which is what a
   * terminal shows.
   */
  const resetOutput = useCallback(() => {
    outputBuffer.current = [];
    setOutput([]);
  }, []);

  const run = useCallback(
    (goalText: string) => {
      const client = engineRef.current;
      if (!client) return;
      setRows([]);
      setVariables([]);
      setExhausted(false);
      setQueryError(null);
      // Busy is set here rather than on the worker's reply, because a goal that
      // never returns never produces one — and without this, Stop would never
      // appear for exactly the goals that need it.
      setBusy(true);
      // Consult immediately so the goal sees the text on screen, not the version
      // from up to 400ms ago.
      client.consult(programRef.current, factsSource(factsRef.current));
      // No answers to begin with: a goal that asks one suspends and comes back
      // through `answer`, which is what makes it a terminal rather than a form.
      client.input([]);
      client.open(goalText);
      // Set through the ref as well as the state: the engine callbacks were created
      // once, when the engine started, so they read `sessionRef` rather than this
      // render's state. Leaving the ref empty means a suspension has no goal to
      // resume and the resume tries to run nothing.
      const started = startSession(goalText);
      sessionRef.current = started;
      setRepl(started);
      resetOutput();

      if (identity) room?.awareness.setLocalStateField('goal', goalText);
      room?.awareness.setLocalStateField('running', true);
      appendLog(room!.ydoc, {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        who: identity?.name ?? 'someone',
        goal: goalText,
        count: null,
        error: null,
        at: Date.now(),
      });
    },
    [identity, room],
    );

  /**
   * Sends one answer and resumes.
   *
   * Every answer so far goes to the engine, not just the new one. The goal is
   * re-entered from the top, so it takes them again in order — reproducing the
   * output already shown — and stops at the next question.
   */
  const sendAnswer = useCallback(
    (line: string) => {
      const client = engineRef.current;
      const current = sessionRef.current;
      if (!client || !current) return;
      const withAnswer = answer(current, line);
      sessionRef.current = withAnswer;
      setRepl(withAnswer);
      resetOutput();
      client.input(withAnswer.answers);
      client.open(current.goal);
      setBusy(true);
    },
    [resetOutput],
  );

  const next = useCallback(() => {
    if (currentQuery === null) return;
    setBusy(true);
    engineRef.current?.next(currentQuery);
  }, [currentQuery]);

  const stop = useCallback(() => {
    // A goal stopped at a question has nothing running to interrupt — the worker is
    // idle between steps — so restarting the engine would be pure cost. Only the
    // session is dropped, which is what puts the prompt back into goal mode.
    if (sessionRef.current?.waiting) {
      sessionRef.current = null;
      setRepl(null);
      setBusy(false);
      return;
    }
    engineRef.current?.stop();
    setBusy(false);
    room?.awareness.setLocalStateField('running', false);
  }, [room]);

  const clearConsole = useCallback(() => {
    setRows([]);
    setVariables([]);
    setExhausted(false);
    setQueryError(null);
    outputBuffer.current = [];
    setOutput([]);
  }, []);

  const addFactTerm = useCallback(
    (term: string) => {
      if (!room || !identity) return;
      addFact(room.ydoc, {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        term,
        author: identity.name,
        at: Date.now(),
      });
    },
    [room, identity],
  );

  const validateFact = useCallback(
    (term: string): string | null => {
      // Validated by the engine itself, so the rule for what a fact is cannot
      // drift from the rule for what the program accepts.
      const text = term.trimEnd().endsWith('.') ? term : `${term}.`;
      const issue = engineRef.current ? null : null;
      void issue;
      if (!/\.$/.test(text)) return 'A fact must end with a full stop.';
      if (text.split('(').length !== text.split(')').length) return 'Unbalanced parentheses.';
      if (text.split("'").length % 2 === 0) return 'Unbalanced quote.';
      return null;
    },
    [],
  );

  const shareUrl = useMemo(() => {
    if (typeof window === 'undefined') return '';
    return buildShareUrl(window.location.href.split('#')[0]!, session.room, program, facts, false);
  }, [session.room, program, facts]);

  const snapshotUrl = useMemo(() => {
    if (typeof window === 'undefined') return '';
    return buildShareUrl(window.location.href.split('#')[0]!, session.room, program, facts, true);
  }, [session.room, program, facts]);

  const carets: RemoteCaret[] = useMemo(
    () =>
      peers
        .filter((peer) => peer.cursor !== null)
        .map((peer) => ({
          clientId: peer.clientId,
          name: peer.name,
          color: peer.color,
          position: peer.cursor!,
        })),
    [peers],
  );

  const onCursor = useCallback(
    (position: number) => room?.awareness.setLocalStateField('cursor', position),
    [room],
  );

  const rename = useCallback(
    (name: string) => {
      setIdentity((previous) => {
        if (!previous) return previous;
        const next = { ...previous, name };
        rememberIdentity(next);
        room?.awareness.setLocalStateField('name', name);
        return next;
      });
    },
    [room],
  );

  const download = useCallback(
    (name: string, text: string, type: string) => {
      const blob = new Blob([text], { type });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = name;
      anchor.click();
      URL.revokeObjectURL(url);
    },
    [],
  );

  const saveCopy = useCallback(() => {
    const file: RoomFile = { version: 1, name: session.room, program, facts, log };
    download(`${session.room}.json`, serializeRoom(file), 'application/json');
  }, [session.room, program, facts, log, download]);

  const importFile = useCallback(
    async (file: File) => {
      const text = await file.text();
      const parsed = parseRoomFile(text);
      if (!parsed || !room) {
        setQueryError('That file is not a Prolog Room file.');
        return;
      }
      const ytext = room.ydoc.getText(PROGRAM);
      room.ydoc.transact(() => {
        ytext.delete(0, ytext.length);
        ytext.insert(0, parsed.program);
      });
      for (const fact of parsed.facts) addFact(room.ydoc, fact);
      setDialog(null);
    },
    [room],
  );

  // ---------------------------------------------------------------- keyboard

  /**
   * The keyboard handler reads the goal from a ref, not from the closure.
   *
   * The effect that installs the listener must not re-run on every keystroke in
   * the console — that would tear down and rebuild a window listener while
   * somebody is typing. A ref lets the handler always see the current goal
   * without the listener being reinstalled, which is what fixes Control+Enter
   * running the previous goal.
   */
  const goalRef = useRef(goal);
  useEffect(() => {
    goalRef.current = goal;
  }, [goal]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        // Dialogs are portalled to the body, so Escape has to be handled here
        // rather than by whichever element happens to hold focus.
        setDialog((current) => (current ? null : current));
        return;
      }
      const meta = event.metaKey || event.ctrlKey;
      if (meta && event.key === 'Enter') {
        event.preventDefault();
        run(goalRef.current);
      } else if (meta && event.key.toLowerCase() === 's') {
        event.preventDefault();
        download(`${session.room}.pl`, programRef.current, 'text/plain');
      } else if (event.key === '?' && !isTyping(event.target)) {
        event.preventDefault();
        setDialog('help');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [run, download, session.room]);

  const me = identity ?? createLocalIdentity(0);

  return (
    <div className="app">
      <header className="app__header">
        <div className="app__brand">
          <span className="app__mark" aria-hidden="true">
            ?-
          </span>
          <div>
            <h1 className="app__title">Prolog Room</h1>
            <p className="app__room">
              Room <code>{session.room}</code>
            </p>
          </div>
        </div>

        <div className="app__actions">
          <PresenceBar
            me={me}
            peers={peers}
            networkPeers={networkPeers}
            signaling
            onRename={rename}
          />
          <button type="button" className="btn" onClick={() => setDialog('share')}>
            Share
          </button>
          <button type="button" className="btn btn--quiet" onClick={() => setDialog('export')}>
            Export
          </button>
          <button type="button" className="btn btn--quiet" onClick={() => setDialog('help')}>
            Help
          </button>
          <ThemePicker value={theme} onChange={onTheme} />
        </div>
      </header>

      <main className="app__main">
        <section className="pane pane--editor" aria-label="Program">
          <div className="pane__header">
            <h2 className="pane__title">Program</h2>
            <div className="pane__tools">
              {syntaxError ? (
                <span className="status status--error" role="status">
                  {syntaxError.line ? `Line ${syntaxError.line}: ` : ''}
                  {syntaxError.message}
                </span>
              ) : ready ? (
                <span className="status status--ok">
                  Engine ready{version ? ` · SWI-Prolog ${formatVersion(version)}` : ''}
                  {bootMs ? ` · ${bootMs} ms` : ''}
                </span>
              ) : (
                <span className="status status--idle">Starting engine…</span>
              )}
            </div>
          </div>
          <ProgramEditor
            ytext={room?.ydoc.getText(PROGRAM) ?? newEmptyText()}
            onCursor={onCursor}
            carets={carets}
            errorLine={syntaxError?.line ?? null}
          />
        </section>

        <section className="pane pane--side" aria-label="Console and facts">
          <Console
            onRun={run}
            onNext={next}
            onStop={stop}
            onClear={clearConsole}
            rows={rows}
            variables={variables}
            exhausted={exhausted}
            busy={busy}
            error={queryError}
            output={output}
            ready={ready}
            goal={goal}
            onGoalChange={setGoal}
            onAnswer={sendAnswer}
            waiting={repl?.waiting ?? false}
          />
          <FactsPanel
            facts={facts}
            me={me.name}
            onAdd={addFactTerm}
            onRemove={(id) => room && removeFact(room.ydoc, id)}
            validate={validateFact}
          />
        </section>
      </main>

      <footer className="app__footer">
        <button type="button" className="btn btn--quiet btn--small" onClick={onNewRoom}>
          New room
        </button>
        <button type="button" className="btn btn--quiet btn--small" onClick={() => setDialog('examples')}>
          Examples
        </button>
        <label className="btn btn--quiet btn--small">
          Import
          <input
            type="file"
            accept="application/json,.json"
            className="visually-hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void importFile(file);
            }}
          />
        </label>
        <span className="app__hint">
          No account, no server. The engine runs in this tab; the program is shared peer to peer.
        </span>
      </footer>

      {dialog === 'share' ? (
        <ShareDialog
          room={session.room}
          link={shareUrl}
          snapshotLink={snapshotUrl}
          peerCount={peers.length}
          onClose={() => setDialog(null)}
          onDownload={saveCopy}
        />
      ) : null}

      {dialog === 'export' ? (
        <ExportDialog
          room={session.room}
          program={program}
          facts={facts}
          log={log}
          onClose={() => setDialog(null)}
        />
      ) : null}

      {dialog === 'help' ? <HelpPanel onClose={() => setDialog(null)} /> : null}

      {dialog === 'examples' ? (
        <ExamplesDialog
          onClose={() => setDialog(null)}
          onPick={(id) => {
            const example = exampleById(id);
            if (!example || !room) return;
            const ytext = room.ydoc.getText(PROGRAM);
            room.ydoc.transact(() => {
              ytext.delete(0, ytext.length);
              ytext.insert(0, example.program);
            });
            setGoal(example.goal);
            setDialog(null);
          }}
        />
      ) : null}
    </div>
  );
}

function ExamplesDialog({ onClose, onPick }: { onClose: () => void; onPick: (id: string) => void }) {
  return (
    <div className="scrim" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="modal modal--wide" role="dialog" aria-modal="true" aria-label="Examples">
        <header className="modal__header">
          <h2 className="modal__title">Open an example</h2>
          <button type="button" className="btn btn--quiet btn--small" onClick={onClose}>
            Close
          </button>
        </header>
        <div className="modal__body">
          <p className="field__help">
            Each example replaces the program in <strong>this room</strong>, so anyone else here
            receives it too. Undo is not available across a replace, so save a copy first if you
            need one.
          </p>
          <ul className="examples">
            {EXAMPLES.map((example) => (
              <li key={example.id}>
                <button type="button" className="examples__item" onClick={() => onPick(example.id)}>
                  <span className="examples__name">{example.name}</span>
                  <span className="examples__description">{example.description}</span>
                  <code className="examples__goal">?- {example.goal}</code>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

/** A placeholder Y.Text for the first render, before the room exists. */
function newEmptyText() {
  return new Y.Text();
}

/** SWI-Prolog reports its version as 10000*major + 100*minor + patch. */
function formatVersion(raw: string): string {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return raw;
  const major = Math.floor(value / 10000);
  const minor = Math.floor((value % 10000) / 100);
  const patch = value % 100;
  return `${major}.${minor}.${patch}`;
}

function isTyping(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element) return false;
  const tag = element.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || element.isContentEditable;
}

export { isTyping };








