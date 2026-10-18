import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // simple-peer (used by y-webrtc) expects a Node-style `global`.
  define: {
    global: 'globalThis',
  },
  // Relative asset URLs so the same build works at a user page, a project
  // page, or a custom domain without a second configuration.
  base: './',
  resolve: {
    /**
     * TypeScript first, JavaScript second.
     *
     * Vite puts `.js` ahead of `.ts` by default, so a stray compiled file left
     * behind by a careless `tsc` run is silently preferred over the source it
     * came from and the build ships stale code with no error. Sources first
     * makes that harmless rather than invisible.
     */
    extensions: ['.ts', '.tsx', '.mts', '.mjs', '.js', '.jsx', '.json'],
  },
  build: {
    target: 'es2022',
    sourcemap: false,
  },
  worker: {
    /**
     * The engine worker is built as a classic script, not an ES module.
     *
     * `swipl-web.js` is Emscripten output: a plain script that assigns a
     * global `SWIPL` and does not `export`. Loading it from an ES module
     * worker would need a dynamic `import()` of a file that has no exports.
     * A classic worker lets the engine be pulled in with `importScripts()`,
     * which is the mechanism Emscripten itself expects.
     */
    format: 'iife',
  },
  server: {
    port: 5173,
  },
});
