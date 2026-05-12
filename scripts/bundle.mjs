#!/usr/bin/env node
// Bundle helper for the clawborrator-cli CJS distribution.
//
// Invoked by `npm run bundle`. Replaces the previous one-liner esbuild
// command so we can inject the package.json version into the bundle
// via --define (cross-platform; the bash `$()` substitution that did
// this inline doesn't work on cmd.exe). Single source of truth for
// the binary's reported version is package.json.

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));

await build({
  entryPoints: [resolve(root, 'src/index.ts')],
  outfile:     resolve(root, 'dist-bundled/claw.cjs'),
  bundle:      true,
  platform:    'node',
  format:      'cjs',
  target:      'node20',
  banner:      { js: '#!/usr/bin/env node' },
  define: {
    __CLAW_VERSION__: JSON.stringify(pkg.version),
  },
});

console.log(`bundled clawborrator-cli@${pkg.version} → dist-bundled/claw.cjs`);
