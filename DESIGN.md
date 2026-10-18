# Design

The visual thesis is a drafting sheet: a sheet of paper, ink on it, and a single
teal used for one thing only — selection. Nothing glows, nothing gradients, and
the only shadows are the ones that say *this floats above the page*.

Read this before changing a token or adding a surface.

## Rules

1. **A theme is a palette, never a layout.** Every colour the app draws comes from
   a token in `src/ui/theme.ts`. The stylesheet contains no literal colour except
   two `rgba()` shadows and a transparent rule.

2. **Colour means one thing.** Teal marks selection and nothing else. Danger red
   marks a failure and nothing else. A colour that appears in two unrelated
   meanings is a colour readers can no longer rely on.

3. **Text is always ink on paper.** Never a colour on a colour for anything a
   reader has to parse. The four ink levels exist so that hierarchy comes from
   weight and size first, and colour last.

4. **A surface is a step in lightness.** `--paper`, `--paper-raised` and
   `--paper-sunken` are three steps, not three accents. A panel that wants a
   fourth surface wants less contrast instead.

5. **Prolog is a programming language, so it is set like code.** Monospace at
   13px with a 22px line height, a 4-space tab, and no wrapping. A clause that
   wraps is a clause that is harder to read than it needs to be.

6. **The gutter is a ruler, not a decoration.** Line numbers exist because a
   syntax error is reported by line, and a line number the reader cannot see is
   an error they cannot act on.

## Fonts

IBM Plex Sans for prose, IBM Plex Mono for everything Prolog. Both are the fonts
IBM publishes for exactly this kind of work, and they are not loaded from a
third party — the stacks fall back to the system UI and monospace fonts.

## Accessibility floor

`tests/unit/theme.test.ts` enforces it, so it cannot rot:

| What | Floor | Why |
| --- | --- | --- |
| Body ink on any paper | 4.5:1 | Read as prose |
| Faint ink on any paper | 4.5:1 | It labels the room code and the result index |
| Signal ink on paper | 4.5:1 | It is used for links |
| Danger, ok, warn text | 3:1 | Short status words |
| Every syntax token on the editor | 3:1 | Code is read for longer than prose |
| Ink on a filled accent button | 4.5:1 | The label is the whole control |

Two consequences worth keeping:

- **Ink on an accent is a token, not white.** The dark palette's accents are
  light, so white on them is 2.2:1. `--on-signal` and `--on-danger` are separate
  tokens because Solarized needs dark ink on its blue and light ink on its red.
- **A red for a button is not a red for text.** `--danger-fill` is darker than
  `--danger`, because a red dark enough to carry white text is too dark to read
  as text on a dark background.

`tests/e2e/access.spec.ts` runs axe over the whole app in the light theme, the
dark theme, and with a dialog open. The unit test would not catch a button whose
label is white on a coloured background, because that pair only exists in the
rendered page.

## Layout

The workspace is a two-pane split: the program on the left, the console and facts
on the right. The editor takes the space because it is where the work happens,
and the console is bounded because solutions are read, not scrolled.

Below 860px the split becomes a row, and the side pane is capped at 46vh so the
editor never disappears behind the keyboard.

Every control has a minimum 32px target, and every icon-only control carries a
visible text alternative or an accessible name.

## Motion

Only two transitions exist: buttons lighten on hover over 120ms, and the editor's
highlight layer moves with the textarea. Both are disabled under
`prefers-reduced-motion`, and neither is needed to understand the app, so a reader
who turns motion off loses nothing.

## The editor's one trick

The editor is a `<textarea>` with a syntax-highlighted `<pre>` painted behind it.
The textarea holds the text and all the native behaviour — selection, undo, IME,
the mobile keyboard, screen readers. The highlight layer is `aria-hidden` and
kept in lockstep by measuring nothing: the caret positions for remote peers are
computed from a monospace font's known metrics, which keeps a peer's cursor
moving without a layout read.

A full editor component would fight over who owns the shared document. This one
does not, which is why the collaboration works.