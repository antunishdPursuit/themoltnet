/**
 * Runs Secretlint over the files one Nx project owns. Invoked by the targets
 * that `./index.ts` infers.
 *
 *   node --import tsx tools/nx-plugins/secretlint/run.ts \
 *     --config .secretlintrc.json --root libs/foo [--exclude libs/foo/bar]...
 *
 * Files come from `git ls-files` (tracked plus untracked, minus gitignored)
 * minus `.nxignore`, so the scanned set is exactly the set Nx hashes for the
 * target: a file Nx cannot see would otherwise be served stale cache. The
 * Secretlint CLI cannot express "this directory minus nested project roots":
 * it ignores negated globs and takes a single ignore file.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { createEngine } from '@secretlint/node';
import ignore from 'ignore';

/** Files under `root` that do not belong to a nested project root. */
export function ownedFiles(
  files: readonly string[],
  root: string,
  excluded: readonly string[],
): string[] {
  const prefixes = excluded.map((dir) => `${dir}/`);
  return files.filter(
    (file) =>
      (root === '.' || file.startsWith(`${root}/`)) &&
      !prefixes.some((prefix) => file.startsWith(prefix)),
  );
}

function listFiles(cwd: string, root: string): string[] {
  const nxignore = join(cwd, '.nxignore');
  const ignored = ignore().add(
    existsSync(nxignore) ? readFileSync(nxignore, 'utf8') : '',
  );
  const output = execFileSync(
    'git',
    [
      'ls-files',
      '-z',
      '--cached',
      '--others',
      '--exclude-standard',
      '--',
      root,
    ],
    { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  );
  const files = output.split('\0').filter(Boolean);
  return [...new Set(files)].filter((file) => {
    if (ignored.ignores(file)) return false;
    // Tracked files deleted in the working tree, and submodule gitlinks.
    const path = resolve(cwd, file);
    return existsSync(path) && statSync(path).isFile();
  });
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      config: { type: 'string' },
      root: { type: 'string' },
      exclude: { type: 'string', multiple: true, default: [] },
    },
  });
  if (!values.config || !values.root) {
    process.stderr.write(
      'secretlint runner: --config and --root are required\n',
    );
    return 2;
  }
  const cwd = process.cwd();
  const files = ownedFiles(
    listFiles(cwd, values.root),
    values.root,
    values.exclude,
  );
  if (files.length === 0) return 0;

  const engine = await createEngine({
    cwd,
    configFilePath: resolve(cwd, values.config),
    formatter: 'stylish',
    color: process.stdout.isTTY,
    maskSecrets: true,
  });
  const { ok, output } = await engine.executeOnFiles({
    filePathList: files.map((file) => resolve(cwd, file)),
  });
  if (output) process.stdout.write(`${output}\n`);
  return ok ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
