import { defineConfig } from 'vite'

/// The Mac dashboard is a second build out of this same project, not a second
/// project.
///
/// It shares `src/design/nightshift.css` and `src/design/components.tsx` with the
/// phone client by importing them directly, which is the whole reason it lives
/// here: the two surfaces draw the same instrument, and the last time this
/// codebase had two copies of one palette they drifted a step apart. One
/// `node_modules`, one TypeScript config, one design system, two `dist`s.
///
/// `base: './'` for the same reason the client has it — the host serves this
/// bundle from `/dashboard/<key>/`, and the key changes every launch, so no
/// absolute base could ever be right.
export default defineConfig({
  base: './',
  root: 'dashboard',
  build: {
    outDir: '../dist-dashboard',
    emptyOutDir: true,
    target: 'es2022',
    rollupOptions: {
      output: {
        manualChunks: undefined,
      },
    },
  },
  server: {
    port: 5274,
    // The shared design system lives one level up, outside this build's root.
    // Rollup follows the relative import without being told; the dev server has
    // to be given permission to serve from there.
    fs: { allow: ['..'] },
  },
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'preact',
  },
})
