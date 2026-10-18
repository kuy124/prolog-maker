/**
 * Design tokens.
 *
 * One sheet of paper and the ink on it. A theme is a palette, never a layout:
 * every colour the app draws comes from a token named here, so a new surface
 * cannot invent a colour and a new theme cannot forget one.
 *
 * `tests/unit/design-tokens.test.ts` holds this to two rules — every `var()` a
 * rule reads is defined somewhere, and every theme clears 4.5:1 for body text.
 * Read that test before adding a token.
 */

export interface Theme {
  id: string;
  name: string;
  /** True when the theme is dark, so the browser can be told. */
  dark: boolean;
  tokens: Record<string, string>;
}

const LIGHT = {
  '--paper': '#fbfaf7',
  '--paper-raised': '#ffffff',
  '--paper-sunken': '#f2f0ea',
  '--grid': '#e6e2d9',
  '--ink': '#1c1f22',
  '--ink-soft': '#4a5056',
  '--ink-faint': '#5c6369',
  '--rule': '#ddd8cc',
  '--rule-strong': '#c3bcab',
  '--signal': '#0f7b8a',
  '--signal-soft': '#e2f0f1',
  '--signal-ink': '#0b5b66',
  // Ink for text drawn on a filled signal or danger surface. Two tokens, not
  // one: in the Solarized palettes the blue needs dark ink and the red needs
  // light, so a single shared value cannot clear 4.5:1 on both.
  '--on-signal': '#fbfcfb',
  '--on-danger': '#fbfcfb',
  '--danger': '#a3341f',
  '--danger-fill': '#a3341f',
  '--danger-soft': '#fbe9e5',
  '--warn': '#8a5a00',
  '--warn-soft': '#fbf0d9',
  '--ok': '#2f6b3a',
  '--ok-soft': '#e6f2e7',
  '--shadow': '0 1px 2px rgba(28, 31, 34, 0.06), 0 4px 12px rgba(28, 31, 34, 0.06)',
  '--shadow-lifted': '0 2px 4px rgba(28, 31, 34, 0.08), 0 12px 32px rgba(28, 31, 34, 0.12)',
  // Syntax
  '--tok-comment': '#6d747a',
  '--tok-string': '#8a3e6b',
  '--tok-atom': '#7a4a12',
  '--tok-variable': '#0b5b66',
  '--tok-number': '#2f5da8',
  '--tok-keyword': '#8a2f2f',
  '--tok-operator': '#4a5056',
  '--tok-punctuation': '#4a5056',
} as const;

const DARK: Record<keyof typeof LIGHT, string> = {
  '--paper': '#16191c',
  '--paper-raised': '#1e2226',
  '--paper-sunken': '#111417',
  '--grid': '#262b30',
  '--ink': '#e8e6e1',
  '--ink-soft': '#b6b2a9',
  '--ink-faint': '#8d8a83',
  '--rule': '#2e343a',
  '--rule-strong': '#454d55',
  '--signal': '#4fbcc9',
  '--signal-soft': '#173338',
  '--signal-ink': '#8ad9e2',
  // The dark palette's accents are light, so ink on them must be dark.
  '--on-signal': '#14171a',
  '--on-danger': '#14171a',
  '--danger': '#f08a76',
  '--danger-fill': '#f08a76',
  '--danger-soft': '#3a201b',
  '--warn': '#e0b055',
  '--warn-soft': '#382c15',
  '--ok': '#7fc98c',
  '--ok-soft': '#1c2f21',
  '--shadow': '0 1px 2px rgba(0, 0, 0, 0.4), 0 4px 12px rgba(0, 0, 0, 0.3)',
  '--shadow-lifted': '0 2px 4px rgba(0, 0, 0, 0.5), 0 12px 32px rgba(0, 0, 0, 0.4)',
  '--tok-comment': '#8d8a83',
  '--tok-string': '#d79ac2',
  '--tok-atom': '#d9a86a',
  '--tok-variable': '#8ad9e2',
  '--tok-number': '#9dbcf0',
  '--tok-keyword': '#e89b9b',
  '--tok-operator': '#b6b2a9',
  '--tok-punctuation': '#b6b2a9',
};

/** Solarized Light, using the values the Solarized project publishes. */
const SOLARIZED_LIGHT: Record<keyof typeof LIGHT, string> = {
  '--paper': '#fdf6e3',
  '--paper-raised': '#fffbf0',
  '--paper-sunken': '#eee8d5',
  '--grid': '#e6dfc8',
  '--ink': '#073642',
  '--ink-soft': '#41595f',
  '--ink-faint': '#526a72',
  '--rule': '#ded8c4',
  '--rule-strong': '#c9c2ab',
  '--signal': '#268bd2',
  '--signal-soft': '#e3eef8',
  '--signal-ink': '#1c6ba3',
  // Solarized's blue is light enough to need dark ink; its red is dark enough to
  // need light ink. One shared value cannot serve both.
  '--on-signal': '#14171a',
  '--on-danger': '#fbfcfb',
  '--danger': '#dc322f',
  '--danger-soft': '#fbe6e5',
  '--danger-fill': '#cf2f2c',
  '--warn': '#9a7300',
  '--warn-soft': '#fbf2d6',
  '--ok': '#6f7f00',
  '--ok-soft': '#eef2d6',
  '--shadow': '0 1px 2px rgba(7, 54, 66, 0.07), 0 4px 12px rgba(7, 54, 66, 0.07)',
  '--shadow-lifted': '0 2px 4px rgba(7, 54, 66, 0.1), 0 12px 32px rgba(7, 54, 66, 0.14)',
  // Solarized's own comment grey (#93a1a1) is only 2.6:1 on this paper, which is
  // too low for code read at length. Darkened toward base01 until it clears 3:1.
  '--tok-comment': '#5f7276',
  '--tok-string': '#2aa198',
  '--tok-atom': '#b58900',
  '--tok-variable': '#268bd2',
  '--tok-number': '#d33682',
  '--tok-keyword': '#859900',
  '--tok-operator': '#657b83',
  '--tok-punctuation': '#657b83',
};

const SOLARIZED_DARK: Record<keyof typeof LIGHT, string> = {
  '--paper': '#002b36',
  '--paper-raised': '#073642',
  '--paper-sunken': '#00212b',
  '--grid': '#0a3f4d',
  '--ink': '#eee8d5',
  '--ink-soft': '#c3bda8',
  '--ink-faint': '#93a1a1',
  '--rule': '#0e4a5a',
  '--rule-strong': '#1a5f72',
  '--signal': '#2aa198',
  '--signal-soft': '#0a4443',
  '--signal-ink': '#6fd6cd',
  '--on-signal': '#14171a',
  '--on-danger': '#fbfcfb',
  '--danger': '#dc322f',
  '--danger-soft': '#3d1a1a',
  '--danger-fill': '#cf2f2c',
  '--warn': '#b58900',
  '--warn-soft': '#3a2f0a',
  '--ok': '#859900',
  '--ok-soft': '#25300a',
  '--shadow': '0 1px 2px rgba(0, 0, 0, 0.4), 0 4px 12px rgba(0, 0, 0, 0.3)',
  '--shadow-lifted': '0 2px 4px rgba(0, 0, 0, 0.5), 0 12px 32px rgba(0, 0, 0, 0.4)',
  '--tok-comment': '#7b9099',
  '--tok-string': '#2aa198',
  '--tok-atom': '#b58900',
  '--tok-variable': '#6fc3e8',
  '--tok-number': '#e05fa0',
  '--tok-keyword': '#859900',
  '--tok-operator': '#93a1a1',
  '--tok-punctuation': '#93a1a1',
};

export const THEMES: Theme[] = [
  { id: 'system', name: 'System', dark: false, tokens: LIGHT },
  { id: 'light', name: 'Paper', dark: false, tokens: LIGHT },
  { id: 'dark', name: 'Ink', dark: true, tokens: DARK },
  { id: 'solarized-light', name: 'Solarized Light', dark: false, tokens: SOLARIZED_LIGHT },
  { id: 'solarized-dark', name: 'Solarized Dark', dark: true, tokens: SOLARIZED_DARK },
];

export const DEFAULT_THEME = 'system';

export function themeById(id: string): Theme {
  return THEMES.find((theme) => theme.id === id) ?? THEMES[0]!;
}

const STORAGE_KEY = 'prolog:theme';

export function savedTheme(): string {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && THEMES.some((theme) => theme.id === stored)) return stored;
  } catch {
    // Private mode; the default is fine.
  }
  return DEFAULT_THEME;
}

export function rememberTheme(id: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // Non-fatal.
  }
}

/**
 * Applies a theme to the document root.
 *
 * `system` removes the override rather than writing the light palette, so the
 * stylesheet's `prefers-color-scheme` rule keeps following the machine as the
 * user changes it. Writing the tokens would freeze whichever scheme was active
 * when the page loaded.
 */
export function applyTheme(id: string, root: HTMLElement = document.documentElement): void {
  const theme = themeById(id);
  const dark =
    theme.id === 'system'
      ? window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
      : theme.dark;

  root.dataset.theme = theme.id;
  root.style.colorScheme = dark ? 'dark' : 'light';

  if (theme.id === 'system') {
    for (const token of Object.keys(LIGHT)) root.style.removeProperty(token);
    return;
  }
  for (const [token, value] of Object.entries(theme.tokens)) {
    root.style.setProperty(token, value);
  }
}
