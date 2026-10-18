import { describe, expect, it } from 'vitest';
import { THEMES, themeById } from '../../src/ui/theme';

/** Relative luminance, per WCAG 2.x. */
function luminance(hex: string): number {
  const clean = hex.replace('#', '');
  const channels = [0, 2, 4].map((i) => parseInt(clean.slice(i, i + 2), 16) / 255);
  const linear = channels.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
}

function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

describe('themes', () => {
  it('defines the same tokens in every theme', () => {
    // A theme that forgot a token would fall back to whatever the stylesheet
    // declared, which is how one palette ends up with another's text colour.
    const reference = Object.keys(THEMES[0]!.tokens).sort();
    for (const theme of THEMES) {
      expect(Object.keys(theme.tokens).sort()).toEqual(reference);
    }
  });

  it('clears 4.5:1 for body text on every surface', () => {
    for (const theme of THEMES) {
      const ink = theme.tokens['--ink']!;
      for (const surface of ['--paper', '--paper-raised', '--paper-sunken']) {
        const ratio = contrast(ink, theme.tokens[surface]!);
        expect(ratio, `${theme.id} ink on ${surface}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('clears 4.5:1 for text drawn on a filled accent button', () => {
    // The primary and danger buttons are filled with an accent colour. In the
    // dark palette those accents are light, so the usual near-white label reads
    // at 2.2:1 — the exact failure a single fixed colour would hide. The two are
    // checked separately because the Solarized palettes need different ink for
    // their blue and their red, and a red dark enough to carry white text is too
    // dark to read as text itself, hence `--danger-fill`.
    for (const theme of THEMES) {
      const signal = contrast(theme.tokens['--on-signal']!, theme.tokens['--signal']!);
      expect(signal, `${theme.id} on-signal`).toBeGreaterThanOrEqual(4.5);
      const danger = contrast(theme.tokens['--on-danger']!, theme.tokens['--danger-fill']!);
      expect(danger, `${theme.id} on-danger`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('clears 4.5:1 for faint ink, which carries real labels', () => {
    // Faint ink is not decoration: it labels the room code, the result index and
    // the fact authors. A theme that lets it drop below 4.5:1 on the sunken
    // surface fails a reader looking at the gutter or the log.
    for (const theme of THEMES) {
      for (const surface of ['--paper', '--paper-raised', '--paper-sunken']) {
        const ratio = contrast(theme.tokens['--ink-faint']!, theme.tokens[surface]!);
        expect(ratio, `${theme.id} faint ink on ${surface}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('clears 4.5:1 for soft ink, which is used for real sentences', () => {
    for (const theme of THEMES) {
      const ratio = contrast(theme.tokens['--ink-soft']!, theme.tokens['--paper']!);
      expect(ratio, `${theme.id} soft ink`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('clears 4.5:1 for the signal colour on paper, since it is used for links', () => {
    for (const theme of THEMES) {
      const ratio = contrast(theme.tokens['--signal-ink']!, theme.tokens['--paper']!);
      expect(ratio, `${theme.id} signal ink`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('clears 3:1 for danger and ok text, which appear as short status words', () => {
    for (const theme of THEMES) {
      for (const token of ['--danger', '--ok', '--warn'] as const) {
        const ratio = contrast(theme.tokens[token]!, theme.tokens['--paper']!);
        expect(ratio, `${theme.id} ${token}`).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it('clears 3:1 for every syntax token against the editor background', () => {
    // Code is read for longer than prose, so a colour that is merely pretty is
    // not enough.
    const tokens = [
      '--tok-comment',
      '--tok-string',
      '--tok-atom',
      '--tok-variable',
      '--tok-number',
      '--tok-keyword',
      '--tok-operator',
      '--tok-punctuation',
    ];
    for (const theme of THEMES) {
      for (const token of tokens) {
        const ratio = contrast(theme.tokens[token]!, theme.tokens['--paper-raised']!);
        expect(ratio, `${theme.id} ${token}`).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it('uses only six-digit hex colours', () => {
    // Anything else would break the luminance maths above and the stylesheet's
    // expectations about what a token contains.
    for (const theme of THEMES) {
      for (const [token, value] of Object.entries(theme.tokens)) {
        if (token === '--shadow' || token === '--shadow-lifted') continue;
        expect(value, `${theme.id} ${token}`).toMatch(/^#[0-9A-Fa-f]{6}$/);
      }
    }
  });

  it('has a unique id and name per theme', () => {
    expect(new Set(THEMES.map((t) => t.id)).size).toBe(THEMES.length);
    expect(new Set(THEMES.map((t) => t.name)).size).toBe(THEMES.length);
  });

  it('marks exactly the dark palettes as dark', () => {
    const dark = THEMES.filter((theme) => theme.dark).map((theme) => theme.id);
    expect(dark).toEqual(['dark', 'solarized-dark']);
  });

  it('falls back to the first theme for an unknown id', () => {
    expect(themeById('nope')).toBe(THEMES[0]);
  });
});
