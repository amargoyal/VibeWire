import { defineConfig } from 'vite'

/// `base: './'` is the whole reason this repository does not need to know the
/// name of the GitHub Pages site it will be served from.
///
/// A Pages project site lives at `https://<user>.github.io/<repo>/`, a user site
/// at `https://<user>.github.io/`, and a custom domain at the root of that
/// domain. An absolute base would have to be rewritten for each of those; every
/// asset reference here is relative to the document instead, so the same
/// `dist/` is correct at any of the three — and at `http://<mac>:8787/`, where
/// the host serves the identical bundle.
export default defineConfig({
  base: './',
  root: '.',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    // One file each. The host's static server is 60 lines of Swift and the
    // whole client is well under a megabyte; a chunk graph would buy nothing
    // and cost a request per chunk over a relay.
    rollupOptions: {
      output: {
        manualChunks: undefined,
      },
    },
  },
  server: {
    port: 5273,
    host: true,
  },
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'preact',
  },
})
