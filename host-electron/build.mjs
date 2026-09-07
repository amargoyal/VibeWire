// esbuild, not tsc, produces the JavaScript: three bundles out of one tree, each
// for a different runtime, with `tsc --noEmit` run first so a type error cannot
// ship. `--tests` also bundles `test/*.test.ts` for `node --test`.
import { build } from 'esbuild'
import { cpSync, mkdirSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const tests = process.argv.includes('--tests')

const common = {
  bundle: true,
  sourcemap: true,
  logLevel: 'info',
  target: 'node22',
}

await build({
  ...common,
  entryPoints: ['src/main/index.ts'],
  outfile: 'dist/main.js',
  platform: 'node',
  format: 'cjs',
  external: ['electron', 'koffi'],
})

if (existsSync('src/preload/capture.ts')) {
  await build({
    ...common,
    entryPoints: ['src/preload/capture.ts'],
    outfile: 'dist/preload/capture.js',
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
  })
}

if (existsSync('src/capture/capture.ts')) {
  await build({
    ...common,
    entryPoints: ['src/capture/capture.ts'],
    outfile: 'dist/capture/capture.js',
    platform: 'browser',
    format: 'esm',
    target: 'es2022',
  })
  mkdirSync('dist/capture', { recursive: true })
  cpSync('src/capture/index.html', 'dist/capture/index.html')
}

if (tests) {
  const entryPoints = readdirSync('test')
    .filter((name) => name.endsWith('.test.ts'))
    .map((name) => join('test', name))
  await build({
    ...common,
    entryPoints,
    outdir: 'dist/test',
    platform: 'node',
    format: 'cjs',
    external: ['electron', 'koffi'],
  })
}
