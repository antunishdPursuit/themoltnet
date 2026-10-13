/**
 * Local Nx plugin: infers a cached `secretlint` target for every project.
 *
 * Each target scans only the files its project owns: files under a nested
 * project root belong to the nested project, never to its parent. Files that
 * belong to no project are scanned by one extra target on a host project
 * (`tools` by default), so the whole workspace is covered without a full scan
 * on every run.
 *
 * Config: `{projectRoot}/.secretlintrc.json` when present, otherwise the
 * workspace-root `.secretlintrc.json`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, matchesGlob } from 'node:path';

import type {
  CreateNodesContextV2,
  CreateNodesResult,
  CreateNodesV2,
  TargetConfiguration,
} from '@nx/devkit';
import { parse as parseYaml } from 'yaml';

export interface SecretlintPluginOptions {
  targetName?: string;
  /** Target scanning files that belong to no project. */
  workspaceTargetName?: string;
  /** Root of the project that hosts the workspace target. */
  workspaceTargetProjectRoot?: string;
}

export const CONFIG_FILE = '.secretlintrc.json';
export const RUNNER = 'tools/nx-plugins/secretlint/run.ts';

// Rule packages referenced by `.secretlintrc.json`; a version bump must
// invalidate the cache.
const EXTERNAL_DEPENDENCIES = [
  '@secretlint/node',
  '@secretlint/secretlint-rule-preset-recommend',
  '@secretlint/secretlint-rule-pattern',
  '@secretlint/secretlint-rule-azure',
];

/**
 * Nx project roots among the matched files. A `project.json` always defines a
 * project; a `package.json` only when it is a pnpm workspace member, which is
 * how Nx's package-json inference decides. Returning a node for any other
 * directory would create a project, so this must not over-match.
 */
export function findProjectRoots(
  configFiles: readonly string[],
  workspacePackageGlobs: readonly string[],
): string[] {
  const roots = new Set<string>();
  for (const file of configFiles) {
    const root = dirname(file);
    if (root === '.') continue;
    if (file.endsWith('project.json')) {
      roots.add(root);
    } else if (workspacePackageGlobs.some((glob) => matchesGlob(root, glob))) {
      roots.add(root);
    }
  }
  return [...roots].sort();
}

/** Roots strictly nested under `root` (every root when `root` is `.`). */
export function nestedRoots(root: string, allRoots: readonly string[]) {
  if (root === '.') return [...allRoots];
  return allRoots.filter((other) => other.startsWith(`${root}/`));
}

export function readWorkspacePackageGlobs(workspaceRoot: string): string[] {
  const file = join(workspaceRoot, 'pnpm-workspace.yaml');
  if (!existsSync(file)) return [];
  const parsed = parseYaml(readFileSync(file, 'utf8')) as {
    packages?: unknown;
  } | null;
  return Array.isArray(parsed?.packages)
    ? parsed.packages.filter((glob): glob is string => typeof glob === 'string')
    : [];
}

function configFor(root: string, workspaceRoot: string): string {
  const own = root === '.' ? CONFIG_FILE : `${root}/${CONFIG_FILE}`;
  return existsSync(join(workspaceRoot, own)) ? own : CONFIG_FILE;
}

const quote = (value: string) =>
  /^[\w@./-]+$/.test(value) ? value : JSON.stringify(value);

export function buildTarget(
  root: string,
  allRoots: readonly string[],
  workspaceRoot: string,
): TargetConfiguration {
  const config = configFor(root, workspaceRoot);
  const excluded = nestedRoots(root, allRoots);
  const args = [
    `--config ${quote(config)}`,
    `--root ${quote(root)}`,
    ...excluded.map((dir) => `--exclude ${quote(dir)}`),
  ];
  const files =
    root === '.'
      ? [
          '{workspaceRoot}/**/*',
          ...excluded.map((dir) => `!{workspaceRoot}/${dir}/**/*`),
        ]
      : ['default'];
  return {
    executor: 'nx:run-commands',
    cache: true,
    inputs: [
      ...files,
      `{workspaceRoot}/${config}`,
      `{workspaceRoot}/${RUNNER}`,
      // The runner skips `.nxignore`d files, so it shapes the scanned set.
      '{workspaceRoot}/.nxignore',
      { externalDependencies: EXTERNAL_DEPENDENCIES },
    ],
    outputs: [],
    options: {
      command: `node --import tsx ${RUNNER} ${args.join(' ')}`,
    },
    metadata: {
      description:
        root === '.'
          ? 'Scan files outside every project for committed secrets'
          : 'Scan project files for committed secrets',
      technologies: ['secretlint'],
    },
  };
}

export const createNodesV2: CreateNodesV2<SecretlintPluginOptions> = [
  '**/{project.json,package.json}',
  (configFiles, options, context: CreateNodesContextV2) => {
    const targetName = options?.targetName ?? 'secretlint';
    const workspaceTargetName =
      options?.workspaceTargetName ?? `${targetName}:workspace`;
    const hostRoot = options?.workspaceTargetProjectRoot ?? 'tools';
    const { workspaceRoot } = context;

    const roots = findProjectRoots(
      configFiles,
      readWorkspacePackageGlobs(workspaceRoot),
    );
    const results: Array<readonly [string, CreateNodesResult]> = [];
    const emitted = new Set<string>();
    for (const file of configFiles) {
      const root = dirname(file);
      if (!roots.includes(root) || emitted.has(root)) continue;
      emitted.add(root);
      const targets: Record<string, TargetConfiguration> = {
        [targetName]: buildTarget(root, roots, workspaceRoot),
      };
      if (root === hostRoot) {
        targets[workspaceTargetName] = buildTarget('.', roots, workspaceRoot);
      }
      results.push([file, { projects: { [root]: { targets } } }]);
    }
    return results;
  },
];
