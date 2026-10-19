/**
 * The program editor.
 *
 * A `<textarea>` with a syntax-highlighted `<pre>` painted underneath, rather
 * than a full editor component. That choice is deliberate: the thing being
 * edited is one shared `Y.Text`, and a textarea gives exact control over
 * selection, undo, IME, mobile keyboards and screen readers without fighting a
 * component library over who owns the document. The cost is that the highlight
 * layer has to be kept in lockstep with the textarea's scroll and metrics, which
 * is what the rest of this file does.
 *
 * Collaboration is character-level through Yjs: two people typing in different
 * clauses merge as text insertions, and clause order — which decides Prolog's
 * solution order — stays identical on every peer. Remote carets are drawn in the
 * highlight layer from awareness, so a peer's position is visible without
 * needing a second copy of the text.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as Y from 'yjs';
import { tokenize, type TokenKind } from './tokenize';
import { presenceInk } from '../collab/identity';

export interface RemoteCaret {
  clientId: number;
  name: string;
  color: string;
  position: number;
}

interface Props {
  ytext: Y.Text;
  /** Called whenever the local caret moves, so presence can publish it. */
  onCursor: (position: number) => void;
  /** Remote carets to draw, already filtered to peers in this room. */
  carets: RemoteCaret[];
  /** Line number to mark, from a syntax error. */
  errorLine: number | null;
  /** A peer's caret colour is drawn as a thin bar; this is its width in px. */
  readOnly?: boolean;
}

const TOKEN_CLASS: Record<TokenKind, string> = {
  comment: 'tok tok--comment',
  string: 'tok tok--string',
  atom: 'tok tok--atom',
  variable: 'tok tok--variable',
  number: 'tok tok--number',
  keyword: 'tok tok--keyword',
  operator: 'tok tok--operator',
  punctuation: 'tok tok--punctuation',
  plain: '',
};

export function ProgramEditor({ ytext, onCursor, carets, errorLine, readOnly = false }: Props) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState(() => ytext.toString());
  const [scroll, setScroll] = useState({ top: 0, left: 0 });
  const [caret, setCaret] = useState(0);
  /**
   * Where to put the caret after a remote edit lands.
   *
   * The textarea is controlled, so React resets its selection whenever the value
   * changes from outside — to the end of the text. Without this, somebody typing
   * in one clause would have their cursor yanked to the bottom of the file every
   * time a peer edited a different one, which is the single most disruptive thing
   * a collaborative editor can do.
   */
  const pendingSelection = useRef<{ start: number; end: number } | null>(null);

  // The shared text is the source of truth. A remote edit arrives as a Yjs
  // update; a local edit arrives through the textarea handler below. Both end up
  // here, so the highlight layer never disagrees with the value being edited.
  useEffect(() => {
    const update = (_event: unknown, transaction: { local: boolean }) => {
      // A local transaction already set the state from the textarea's own value,
      // and its selection is authoritative — snapshotting it would fight the
      // caret the browser has just placed.
      if (!transaction.local) {
        const element = textareaRef.current;
        if (element) {
          pendingSelection.current = {
            start: element.selectionStart ?? 0,
            end: element.selectionEnd ?? 0,
          };
        }
      }
      setText(ytext.toString());
    };
    ytext.observe(update);
    update(undefined, { local: true });
    return () => ytext.unobserve(update);
  }, [ytext]);

  /**
   * Restores the caret after a remote edit changed the text underneath it.
   *
   * Clamped, because a peer deleting text before the cursor should move the cursor
   * back by the same amount rather than leave it past the end. A layout effect,
   * so it runs after the new value is in the DOM and the positions it refers to
   * still mean something.
   */
  useLayoutEffect(() => {
    const wanted = pendingSelection.current;
    const element = textareaRef.current;
    if (!wanted || !element) return;
    pendingSelection.current = null;
    const end = Math.min(wanted.end, text.length);
    const start = Math.min(wanted.start, end);
    if (element.selectionStart !== start || element.selectionEnd !== end) {
      element.setSelectionRange(start, end);
    }
    setCaret(start);
    // Republished, because the position just changed without the user touching
    // anything: peers would otherwise keep drawing the old one.
    onCursor(start);
  }, [text, onCursor]);

  /**
   * Applies a local edit as a minimal Yjs delta.
   *
   * A whole-text replacement would work, but it would destroy every other
   * person's concurrent edit and collapse the undo history on each keystroke.
   * Computing the common prefix and suffix turns a one-character insertion into
   * a one-character insert, which is what makes merging possible at all.
   */
  const applyLocal = useCallback(
    (next: string) => {
      const previous = ytext.toString();
      if (next === previous) return;
      let start = 0;
      while (start < previous.length && start < next.length && previous[start] === next[start]) start += 1;
      let endPrev = previous.length;
      let endNext = next.length;
      while (endPrev > start && endNext > start && previous[endPrev - 1] === next[endNext - 1]) {
        endPrev -= 1;
        endNext -= 1;
      }
      ytext.doc?.transact(() => {
        if (endPrev > start) ytext.delete(start, endPrev - start);
        if (endNext > start) ytext.insert(start, next.slice(start, endNext));
      });
      setText(next);
    },
    [ytext],
  );

  const handleInput = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    applyLocal(event.target.value);
    const position = event.target.selectionStart ?? 0;
    setCaret(position);
    onCursor(position);
  };

  const handleSelection = () => {
    const element = textareaRef.current;
    if (!element) return;
    const position = element.selectionStart ?? 0;
    setCaret(position);
    onCursor(position);
  };

  const handleScroll = () => {
    const element = textareaRef.current;
    if (!element) return;
    setScroll({ top: element.scrollTop, left: element.scrollLeft });
  };

  // Keep the highlight layer aligned when the textarea is resized by the window
  // or by a panel opening, not just when it scrolls.
  useLayoutEffect(() => {
    handleScroll();
  }, [text]);

  const lines = useMemo(() => {
    const tokens = tokenize(text);
    const out: React.ReactNode[] = [];
    let key = 0;
    for (const token of tokens) {
      const className = TOKEN_CLASS[token.kind];
      out.push(
        className ? (
          <span key={key++} className={className}>
            {token.text}
          </span>
        ) : (
          <span key={key++}>{token.text}</span>
        ),
      );
    }
    // A trailing newline needs a character to occupy, or the final empty line
    // has no height and the highlight drifts one line above the text.
    out.push(<span key="tail">{'\n'}</span>);
    return out;
  }, [text]);

  const caretLine = useMemo(() => {
    if (errorLine === null) return null;
    return errorLine;
  }, [errorLine]);

  /*
   * The editor's real metrics, measured from the rendered font.
   *
   * These used to be constants — `CHAR_WIDTH = 8.4`, `LINE_HEIGHT = 22` — which is
   * only correct for IBM Plex Mono at 13px. The app named that font but never
   * loaded it, so most machines rendered a fallback and every remote caret was
   * placed at the wrong column: about 1.25px of drift per character, a quarter of
   * a screen by the end of a long clause. Measuring once, after the fonts settle,
   * is correct for whatever face actually rendered.
   *
   * Measured once rather than per caret: a layout read on every remote cursor move
   * is the cost the constants existed to avoid. A ResizeObserver covers the other
   * case, where a zoom or a theme change alters the metrics underneath us.
   */
  const metrics = useEditorMetrics(textareaRef);

  return (
    <div className="editor">
      <div className="editor__gutter" aria-hidden="true">
        {/*
          The numbers scroll with the text. They are a ruler: a line number that
          has drifted out of step with the clause it labels is worse than no line
          number, because it points at the wrong line and looks authoritative.
          The offset is negative scrollTop, taken from the same state that moves
          the text layer, so the two cannot disagree.
        */}
        <div className="editor__gutter-inner" style={{ transform: `translateY(${-scroll.top}px)` }}>
          {Array.from({ length: Math.max(1, text.split('\n').length) }, (_, index) => {
            const line = index + 1;
            return (
              <div
                key={line}
                className={
                  line === caretLine ? 'editor__lineno editor__lineno--error' : 'editor__lineno'
                }
                style={{ height: metrics.lineHeight }}
              >
                {line}
              </div>
            );
          })}
        </div>
      </div>

      <div className="editor__body">
        {/*
          Highlight and remote carets share one transformed layer, so a peer's
          cursor scrolls with the code instead of staying pinned to the top of the
          pane while the clause it marks moves up out of view.
        */}
        <div
          className="editor__layer"
          aria-hidden="true"
          style={{ transform: `translate(${-scroll.left}px, ${-scroll.top}px)` }}
        >
          <pre className="editor__highlight">{lines}</pre>

          {carets.map((peer) => (
            <span
              key={peer.clientId}
              className="editor__caret"
              style={{
                ...caretPosition(text, peer.position, metrics),
                background: peer.color,
                color: presenceInk(peer.color),
              }}
              title={peer.name}
            >
              <span className="editor__caret-name">{peer.name}</span>
            </span>
          ))}
        </div>

        <textarea
          ref={textareaRef}
          className="editor__input"
          value={text}
          onChange={handleInput}
          onSelect={handleSelection}
          onKeyUp={handleSelection}
          onClick={handleSelection}
          onScroll={handleScroll}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          readOnly={readOnly}
          aria-label="Prolog program"
          aria-describedby="editor-hint"
          wrap="off"
        />
      </div>

      <p id="editor-hint" className="visually-hidden">
        Shared Prolog source. Everyone in this room edits the same program. Press Control or Command
        and Enter to run the goal in the console.
      </p>

      <span className="visually-hidden" aria-live="polite">
        {caret === 0 ? '' : `Cursor at character ${caret}`}
      </span>
    </div>
  );
}

/**
 * Converts a character offset into a position inside the highlight layer.
 *
 * Pure: it takes the metrics it needs rather than reading the DOM, so a room with
 * a dozen people typing does not re-measure the page on every keystroke. The
 * metrics are measured once, in `useEditorMetrics`.
 */
function caretPosition(
  text: string,
  offset: number,
  metrics: EditorMetrics,
): { top: number; left: number } {
  const clamped = Math.max(0, Math.min(offset, text.length));
  const before = text.slice(0, clamped);
  const line = before.split('\n').length - 1;
  const column = clamped - (before.lastIndexOf('\n') + 1);
  return {
    top: line * metrics.lineHeight + metrics.padding,
    left: column * metrics.charWidth + metrics.padding,
  };
}

export interface EditorMetrics {
  /** Advance width of one character in the rendered monospace face, in px. */
  charWidth: number;
  /** Height of one line, in px. */
  lineHeight: number;
  /** The layer's padding, which both axes offset by. */
  padding: number;
}

/**
 * The metrics used to place a remote caret.
 *
 * The values fall back to the ones the stylesheet specifies, so the very first
 * frame is not drawn at zero, and are then replaced by what the browser actually
 * rendered. That matters because the app cannot assume its font loaded: a blocked
 * or unavailable font falls back to the system monospace, whose advance width is
 * different — 7.15px against 8.4px for IBM Plex Mono at 13px, which puts a caret
 * a quarter of a screen off by column 200.
 *
 * Measurement is done once per font change rather than per caret. `document.fonts`
 * is watched so the metrics are recomputed when a face finishes loading or fails,
 * and a ResizeObserver covers a zoom that changes the computed font size.
 */
function useEditorMetrics(ref: React.RefObject<HTMLTextAreaElement>): EditorMetrics {
  const [metrics, setMetrics] = useState<EditorMetrics>(DEFAULT_METRICS);

  const measure = useCallback(() => {
    const element = ref.current;
    if (!element) return;
    const style = getComputedStyle(element);
    const lineHeight = Number.parseFloat(style.lineHeight);
    const padding = Number.parseFloat(style.paddingTop);

    // A hidden span in the same face is the honest way to ask how wide a
    // character is: `1ch` is defined against the font's own "0" advance and
    // rounds, and `measureText` needs a canvas in the matching font.
    const probe = document.createElement('span');
    probe.style.cssText = [
      'position:absolute',
      'visibility:hidden',
      'white-space:pre',
      'pointer-events:none',
      `font-family:${style.fontFamily}`,
      `font-size:${style.fontSize}`,
      `font-weight:${style.fontWeight}`,
    ].join(';');
    // A long run averages away sub-pixel rounding on a single glyph.
    probe.textContent = '0'.repeat(200);
    document.body.appendChild(probe);
    const charWidth = probe.getBoundingClientRect().width / 200;
    probe.remove();

    setMetrics({
      charWidth: Number.isFinite(charWidth) && charWidth > 0 ? charWidth : DEFAULT_METRICS.charWidth,
      lineHeight:
        Number.isFinite(lineHeight) && lineHeight > 0 ? lineHeight : DEFAULT_METRICS.lineHeight,
      padding: Number.isFinite(padding) ? padding : DEFAULT_METRICS.padding,
    });
  }, [ref]);

  useLayoutEffect(() => {
    measure();
    // A face arriving (or failing to) changes the metrics with no resize event.
    const fonts = document.fonts;
    fonts?.addEventListener?.('loadingdone', measure);
    const observer = new ResizeObserver(measure);
    if (ref.current) observer.observe(ref.current);
    return () => {
      fonts?.removeEventListener?.('loadingdone', measure);
      observer.disconnect();
    };
  }, [measure, ref]);

  return metrics;
}

/**
 * The values `.editor__highlight` declares in the stylesheet.
 *
 * A starting point, not a source of truth: they are replaced by measurement as
 * soon as the element exists. Keeping them means the first paint places a caret
 * plausibly instead of at the origin.
 */
const DEFAULT_METRICS: EditorMetrics = { charWidth: 8.4, lineHeight: 22, padding: 8 };
