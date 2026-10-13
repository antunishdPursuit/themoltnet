// Fails when a bundled project's build output imports a package it does not
// declare.
//
// Vite inlines most dependencies into a bundle and leaves the rest as bare
// imports, resolved from node_modules at runtime. Which ones stay external
// depends on the Vite config and on what resolves from the top-level
// node_modules, so source-level checks such as @nx/dependency-checks cannot
// predict it. Images install only what the project declares (`pnpm deploy
// --prod`), so an undeclared external fails at startup with
// ERR_MODULE_NOT_FOUND. This reads the bundle itself.
//
// Usage: node tools/check-bundle-externals.mjs <projectRoot> [distDir]

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join, relative } from 'node:path';
import process from 'node:process';

import { init, parse } from 'es-module-lexer';

const [projectRoot, distDir = 'dist'] = process.argv.slice(2);
if (!projectRoot) {
  process.stderr.write(
    'usage: check-bundle-externals.mjs <projectRoot> [distDir]\n',
  );
  process.exit(2);
}

const builtins = new Set(builtinModules);
const packageName = (specifier) =>
  specifier.startsWith('@')
    ? specifier.split('/').slice(0, 2).join('/')
    : specifier.split('/')[0];

function bundleFiles(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return bundleFiles(path);
    return /\.(c|m)?js$/.test(entry) ? [path] : [];
  });
}

/** Bare specifiers a file imports, mapped to their package names. */
function externalsOf(source) {
  const [imports] = parse(source);
  const names = new Set();
  for (const { n: specifier } of imports) {
    // `n` is undefined for dynamic imports of non-literal expressions.
    if (!specifier || /^(\.|\/|node:|data:|#)/.test(specifier)) continue;
    const name = packageName(specifier);
    if (!builtins.has(name)) names.add(name);
  }
  return names;
}

await init;
const manifest = JSON.parse(
  readFileSync(join(projectRoot, 'package.json'), 'utf8'),
);
const declared = new Set(
  ['dependencies', 'peerDependencies', 'optionalDependencies'].flatMap(
    (section) => Object.keys(manifest[section] ?? {}),
  ),
);

const undeclared = new Map();
for (const file of bundleFiles(join(projectRoot, distDir))) {
  for (const name of externalsOf(readFileSync(file, 'utf8'))) {
    if (declared.has(name) || name === manifest.name) continue;
    const files = undeclared.get(name) ?? [];
    files.push(relative(projectRoot, file));
    undeclared.set(name, files);
  }
}

if (undeclared.size > 0) {
  process.stderr.write(
    `${manifest.name}: the build output imports packages missing from "dependencies":\n`,
  );
  for (const [name, files] of [...undeclared].sort()) {
    process.stderr.write(`  - ${name} (${files.slice(0, 3).join(', ')})\n`);
  }
  process.exit(1);
}
process.stdout.write(
  `${manifest.name}: every external import in ${distDir}/ is declared\n`,
);
