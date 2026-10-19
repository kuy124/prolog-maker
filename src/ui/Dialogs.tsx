/**
 * Dialogs: share, export, and help.
 *
 * The share dialog makes one distinction that matters more than any styling: a
 * short link and a snapshot link are different promises. A short link needs
 * somebody online to hand over the room; a snapshot link opens a copy with nobody
 * online. Both are offered, and the difference is stated rather than left for the
 * reader to discover when a link appears broken.
 */

import { useState } from 'react';
import type { LogEntry } from '../collab/ydoc';
import type { RoomFile } from '../model/snapshot';

export function Modal({
  title,
  onClose,
  children,
  footer,
  wide = false,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <div className="scrim" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div
        className={wide ? 'modal modal--wide' : 'modal'}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onKeyDown={(event) => event.key === 'Escape' && onClose()}
      >
        <header className="modal__header">
          <h2 className="modal__title">{title}</h2>
          <button type="button" className="btn btn--quiet btn--small" onClick={onClose} aria-label="Close">
            Close
          </button>
        </header>
        <div className="modal__body">{children}</div>
        {footer ? <footer className="modal__footer">{footer}</footer> : null}
      </div>
    </div>
  );
}

async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

export function ShareDialog({
  room,
  link,
  snapshotLink,
  onClose,
  onDownload,
  peerCount,
}: {
  room: string;
  link: string;
  snapshotLink: string;
  onClose: () => void;
  onDownload: () => void;
  peerCount: number;
}) {
  const [copied, setCopied] = useState<'link' | 'room' | 'snapshot' | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [includeSnapshot, setIncludeSnapshot] = useState(false);

  const active = includeSnapshot ? snapshotLink : link;

  const copy = async (value: string, what: 'link' | 'room' | 'snapshot') => {
    const ok = await copyText(value);
    if (ok) {
      setCopied(what);
      setCopyError(null);
    } else {
      setCopyError(
        'Clipboard access was blocked. Select the ' +
          (what === 'room' ? 'room code' : 'link') +
          ' above and copy it manually.',
      );
    }
  };

  return (
    <Modal
      title="Share this room"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn--primary" onClick={() => copy(active, includeSnapshot ? 'snapshot' : 'link')}>
            {copied === (includeSnapshot ? 'snapshot' : 'link') ? 'Copied' : 'Copy link'}
          </button>
          <button type="button" className="btn" onClick={() => copy(room, 'room')}>
            {copied === 'room' ? 'Code copied' : 'Copy room code'}
          </button>
          <button type="button" className="btn btn--quiet" onClick={onDownload}>
            Save a copy
          </button>
        </>
      }
    >
      <p className="field__help">
        Everyone with this link edits the same program. Keep this tab open until they join — a new
        peer receives the room from someone already in it.
        {peerCount > 0 ? ` ${peerCount} ${peerCount === 1 ? 'person is' : 'people are'} connected now.` : ''}
      </p>

      <label className="field">
        <span className="field__label">Room code</span>
        <input className="field__input" value={room} readOnly onFocus={(event) => event.target.select()} />
      </label>

      <label className="field">
        <span className="field__label">Link</span>
        <input
          className="field__input"
          value={active}
          readOnly
          onFocus={(event) => event.target.select()}
          aria-describedby="share-help"
        />
      </label>

      <label className="field field--check">
        <input
          type="checkbox"
          checked={includeSnapshot}
          onChange={(event) => setIncludeSnapshot(event.target.checked)}
        />
        <span>
          Include the program in the link
          <span className="field__help" id="share-help">
            A longer link that opens a copy even when nobody else is online. Without it, a visitor
            who arrives while the room is empty sees a waiting message instead of an empty editor.
          </span>
        </span>
      </label>

      {copyError ? (
        <p className="note note--warn" role="alert">
          {copyError}
        </p>
      ) : null}

      <p className="note">
        There is no server, so a room lives in the browser that made it. <strong>Save a copy</strong>{' '}
        writes a JSON file that needs nobody online and cannot be truncated by a chat app.
      </p>
    </Modal>
  );
}

export function ExportDialog({
  room,
  program,
  log,
  onClose,
}: {
  room: string;
  program: string;
  log: LogEntry[];
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);

  const download = (name: string, text: string, type: string) => {
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const asJson = () => {
    const file: RoomFile = { version: 2, name: room, program, log };
    download(`${room}.json`, JSON.stringify(file, null, 2) + '\n', 'application/json');
  };

  return (
    <Modal
      title="Export"
      onClose={onClose}
      wide
      footer={
        <>
          <button type="button" className="btn btn--primary" onClick={() => download(`${room}.pl`, program, 'text/plain')}>
            Download program
          </button>
          <button type="button" className="btn" onClick={asJson}>
            Download room
          </button>
          <button
            type="button"
            className="btn"
            onClick={async () => {
              setCopied(await copyText(program));
            }}
          >
            {copied ? 'Copied' : 'Copy program'}
          </button>
        </>
      }
    >
      <p className="field__help">
        The program is plain SWI-Prolog, so it runs unchanged in a terminal. The room file also
        carries the query log and can be imported to restore both.
      </p>
      <pre className="export__preview" aria-label="Program source">
        {program}
      </pre>
      <p className="note">
        {log.length} log {log.length === 1 ? 'entry' : 'entries'}
      </p>
    </Modal>
  );
}

const TOPICS = [
  {
    title: 'What this is',
    body: (
      <>
        <p>
          A shared SWI-Prolog workspace. Everyone in a room edits one program and runs goals
          against their own copy of the engine.
        </p>
        <p>
          There is no server. The engine is compiled to WebAssembly and runs in this tab, which is
          why a query works instantly and why the whole thing can be hosted on GitHub Pages for
          free.
        </p>
      </>
    ),
  },
  {
    title: 'Running a goal',
    body: (
      <>
        <p>
          Type a goal in the console and press Enter. Solutions arrive one at a time — press{' '}
          <strong>Next solution</strong> for more, or <strong>Stop</strong> to abandon the rest.
        </p>
        <p>
          Because a goal cannot be interrupted once it starts, <strong>Stop</strong> replaces the
          engine and reloads the program. Results already on screen are kept.
        </p>
        <p>
          The <strong>query log</strong> under the console records what everyone in the room has
          asked, with the number of solutions each goal had. Click an entry to run it again.
        </p>
      </>
    ),
  },
  {
    title: 'Sharing',
    body: (
      <>
        <p>
          A room code is the whole address. Share the short link and keep your tab open until the
          other person joins; they receive the program from you.
        </p>
        <p>
          A link that includes the program is longer but works with nobody online. Use it for
          homework, a handout, or anything that has to outlive your browser tab.
        </p>
      </>
    ),
  },
  {
    title: 'Who can run what',
    body: (
      <>
        <p>
          Everyone in a room can edit the program, and the program runs in <em>your</em> browser.
          That is the same trust you extend by opening somebody&apos;s <code>.pl</code> file: a
          clause can call <code>js_run_script/1</code> and run JavaScript in this page.
        </p>
        <p>
          Treat a room code like a password to a shared document, and only join rooms from people
          you would run code from. The engine has no sandbox: the WebAssembly build is
          unrestricted by design.
        </p>
      </>
    ),
  },
  {
    title: 'Keyboard',
    body: (
      <table className="keys">
        <tbody>
          <tr>
            <td>
              <kbd>Ctrl</kbd> or <kbd>⌘</kbd> + <kbd>Enter</kbd>
            </td>
            <td>Run the goal in the console</td>
          </tr>
          <tr>
            <td>
              <kbd>Enter</kbd>
            </td>
            <td>Run the goal, from the console</td>
          </tr>
          <tr>
            <td>
              <kbd>Ctrl</kbd> or <kbd>⌘</kbd> + <kbd>S</kbd>
            </td>
            <td>Download the program</td>
          </tr>
          <tr>
            <td>
              <kbd>?</kbd>
            </td>
            <td>Open this help</td>
          </tr>
          <tr>
            <td>
              <kbd>Escape</kbd>
            </td>
            <td>Close a dialog</td>
          </tr>
        </tbody>
      </table>
    ),
  },
];

export function HelpPanel({ onClose }: { onClose: () => void }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <Modal title="Help" onClose={onClose} wide>
      <div className="help">
        {TOPICS.map((topic) => {
          const expanded = open === topic.title;
          return (
            <section key={topic.title} className="help__topic">
              <h3 className="help__heading">
                <button
                  type="button"
                  className="help__toggle"
                  aria-expanded={expanded}
                  onClick={() => setOpen(expanded ? null : topic.title)}
                >
                  {topic.title}
                </button>
              </h3>
              {expanded ? <div className="help__body">{topic.body}</div> : null}
            </section>
          );
        })}
      </div>
    </Modal>
  );
}
