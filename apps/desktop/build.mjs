// Bundles the Electron main process (TypeScript + shared package + ws) into one small file.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/main.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['electron', 'bufferutil', 'utf-8-validate'],
  minify: !process.argv.includes('--dev'),
  sourcemap: false,
  logLevel: 'warning',
});
