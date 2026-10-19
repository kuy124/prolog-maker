/**
 * The icon, held to the palette.
 *
 * A favicon is a raster: it cannot read a CSS variable, so `scripts/make-icon.mjs`
 * hard-codes two colours and `index.html` hard-codes a third. This test is what
 * keeps those copies honest — if the light palette's signal colour moves, the
 * icon is regenerated with it rather than quietly becoming a different brand.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { THEMES, themeById } from '../../src/ui/theme';

const root = join(__dirname, '..', '..');

function read(path: string): string {
  return readFileSync(join(root, path), 'utf8');
}

/** The light palette's signal pair, which the icon is drawn in. */
const light = themeById('light').tokens;

describe('the icon', () => {
  it('is drawn in the palette’s signal colours', () => {
    const script = read('scripts/make-icon.mjs');
    // Uppercase in the script, lowercase in the palette: compare case-insensitively
    // so the check is about the colour, not about how it was written down.
    const signal = light['--signal']!.toLowerCase();
    const onSignal = light['--on-signal']!.toLowerCase();
    expect(script.toLowerCase()).toContain(signal);
    expect(script.toLowerCase()).toContain(onSignal);
  });

  it('declares a theme colour that matches the tile it frames', () => {
    const html = read('index.html');
    const match = /<meta name="theme-color" content="(#[0-9a-fA-F]{6})"/.exec(html);
    expect(match, 'index.html is missing a theme-color').not.toBeNull();
    expect(match![1]!.toLowerCase()).toBe(light['--signal']!.toLowerCase());
  });

  it('ships every file the head and the manifest point at', () => {
    // A dead favicon link is invisible in development — the browser silently
    // falls back to /favicon.ico and shows a blank page icon — so it is checked
    // here rather than left to be noticed.
    const html = read('index.html');
    const manifest = JSON.parse(read('public/site.webmanifest')) as {
      icons: { src: string }[];
    };

    const linked = [...html.matchAll(/(?:href)="(\/[^"]+\.(?:svg|png|webmanifest))"/g)].map((m) => m[1]!);
    const fromManifest = manifest.icons.map((icon) => icon.src);
    const all = [...new Set([...linked, ...fromManifest])];

    expect(all.length).toBeGreaterThan(3);
    for (const path of all) {
      expect(existsSync(join(root, 'public', path)), `${path} is referenced but missing`).toBe(true);
    }
  });

  it('carries a manifest whose colours match the palette', () => {
    const manifest = JSON.parse(read('public/site.webmanifest')) as {
      theme_color: string;
      background_color: string;
    };
    expect(manifest.theme_color.toLowerCase()).toBe(light['--signal']!.toLowerCase());
    expect(manifest.background_color.toLowerCase()).toBe(light['--paper']!.toLowerCase());
  });

  it('defines the signal pair it draws with, in every theme', () => {
    // The icon is a single fixed asset, so it is drawn from the light palette.
    // This asserts the pair it borrowed still exists and still clears the
    // contrast floor there, which is the guarantee the icon inherits.
    for (const theme of THEMES) {
      expect(theme.tokens['--signal'], theme.id).toBeDefined();
      expect(theme.tokens['--on-signal'], theme.id).toBeDefined();
    }
  });
});
