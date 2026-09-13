#!/usr/bin/env node
// Spawns tsx on src/cli.ts so `npx exhibit <command>` and `npm run exhibit -- <command>` behave the same
// regardless of the caller's working directory. All paths are resolved relative to this file, not cwd.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, '..', 'src', 'cli.ts');
const tsxBin = join(here, '..', 'node_modules', '.bin', 'tsx');

if (!existsSync(tsxBin)) {
  console.error(
    'exhibit: could not find tsx (' + tsxBin + ').\n' +
    'Run "npm install" in the exhibit repo (' + join(here, '..') + ') first, then try again.'
  );
  process.exit(1);
}

const result = spawnSync(process.execPath, [tsxBin, cli, ...process.argv.slice(2)], {
  stdio: 'inherit',
});

if (result.error) {
  console.error('exhibit: failed to launch tsx: ' + result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
