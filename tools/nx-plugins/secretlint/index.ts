/**
 * Local Nx plugin: infers a cached `secretlint` target for every project, and
 * a workspace target that scans files outside every project.
 *
 * Both run the Secretlint CLI from the workspace root and select files with
 * a glob. Secretlint applies `.gitignore` files from its cwd downwards, so
 * running from a project directory would skip the root `.gitignore`.
 *
 * Config: `{projectRoot}/.secretlintrc.json` when present (it replaces the
 * root config), otherwise the workspace-root `.secretlintrc.json`.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';

import {
  type CreateNodesContextV2,
  createNodesFromFiles,
  type CreateNodesV2,
  type TargetConfiguration,
} from '@nx/devkit';
import ignore from 'ignore';

export interface SecretlintPluginOptions {
  targetName?: string;
  /** Target scanning files that belong to no project. */
  workspaceTargetName?: string;
  /** Root of the project that hosts the workspace target. */
  workspaceTargetProjectRoot?: string;
}

const CONFIG_FILE = '.secretlintrc.json';
const WORKSPACE_ROOT = '.';

/**
 * Packages whose version changes what a scan finds: the CLI plus every
 * top-level rule package in the config.
 */
export function externalDependencies(configPath: string): string[] {
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
    rules?: Array<{ id?: unknown }>;
  };
  const rules = (config.rules ?? [])
    .map((rule) => rule.id)
    .filter((id): id is string => typeof id === 'string');
  return ['secretlint', ...rules];
}

/**
 * Globs covering every file outside the given project roots: the files
 * directly inside each ancestor of a project root, and every sibling
 * directory that contains no project. Positive globs only, because the
 * Secretlint CLI cannot exclude a subdirectory from a glob.
 */
export function orphanGlobs(
  projectRoots: readonly string[],
  workspaceRoot: string,
): string[] {
  const roots = new Set(projectRoots);
  const insideProject = (dir: string) =>
    projectRoots.some((root) => dir === root || dir.startsWith(`${root}/`));
  // Directories that hold project roots but belong to no project themselves.
  const ancestors = new Set([WORKSPACE_ROOT]);
  for (const root of projectRoots) {
    for (let dir = posix.dirname(root); dir !== WORKSPACE_ROOT; ) {
      if (!insideProject(dir)) ancestors.add(dir);
      dir = posix.dirname(dir);
    }
  }
  const gitignore = join(workspaceRoot, '.gitignore');
  const ignored = ignore()
    .add('.git')
    .add(existsSync(gitignore) ? readFileSync(gitignore, 'utf8') : '');

  const globs: string[] = [];
  for (const dir of [...ancestors].sort()) {
    let hasFiles = false;
    for (const entry of readdirSync(join(workspaceRoot, dir), {
      withFileTypes: true,
    })) {
      const path = posix.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (roots.has(path) || ancestors.has(path)) continue;
        if (ignored.ignores(`${path}/`)) continue;
        globs.push(`${path}/**/*`);
      } else if (!ignored.ignores(path)) {
        hasFiles = true;
      }
    }
    if (hasFiles) globs.push(dir === WORKSPACE_ROOT ? '*' : `${dir}/*`);
  }
  return globs;
}

function buildTarget(
  globs: readonly string[],
  config: string,
  context: CreateNodesContextV2,
  description: string,
): TargetConfiguration {
  return {
    command: `secretlint ${globs.map((glob) => JSON.stringify(glob)).join(' ')} --secretlintrc ${config}`,
    cache: true,
    inputs: [
      ...globs.map((glob) => `{workspaceRoot}/${glob}`),
      `{workspaceRoot}/${config}`,
      {
        externalDependencies: externalDependencies(
          join(context.workspaceRoot, config),
        ),
      },
    ],
    outputs: [],
    metadata: { description, technologies: ['secretlint'] },
  };
}

export const createNodesV2: CreateNodesV2<SecretlintPluginOptions> = [
  '**/{project.json,package.json}',
  async (configFiles, options, context) => {
    const targetName = options?.targetName ?? 'secretlint';
    const workspaceTargetName =
      options?.workspaceTargetName ?? `${targetName}:workspace`;
    const hostRoot = options?.workspaceTargetProjectRoot ?? 'tools';

    const projectRoots = [
      ...new Set(
        configFiles
          .map((file) => dirname(file))
          .filter((root) => root !== WORKSPACE_ROOT),
      ),
    ];
    if (!projectRoots.includes(hostRoot)) {
      // Without a host, the workspace target would disappear silently.
      throw new Error(
        `secretlint plugin: workspace target host "${hostRoot}" is not a project root`,
      );
    }

    // A directory with both project.json and package.json matches twice;
    // attach targets through the first file only.
    const firstFileByRoot = new Map<string, string>();
    for (const file of configFiles) {
      const root = dirname(file);
      if (!firstFileByRoot.has(root)) firstFileByRoot.set(root, file);
    }

    return createNodesFromFiles(
      (file, _options, context) => {
        const root = dirname(file);
        if (root === WORKSPACE_ROOT || firstFileByRoot.get(root) !== file) {
          return {};
        }
        const ownConfig = `${root}/${CONFIG_FILE}`;
        const config = existsSync(join(context.workspaceRoot, ownConfig))
          ? ownConfig
          : CONFIG_FILE;
        const targets: Record<string, TargetConfiguration> = {
          [targetName]: buildTarget(
            [`${root}/**/*`],
            config,
            context,
            'Scan project files for committed secrets',
          ),
        };
        if (root === hostRoot) {
          targets[workspaceTargetName] = buildTarget(
            orphanGlobs(projectRoots, context.workspaceRoot),
            CONFIG_FILE,
            context,
            'Scan files outside every project for committed secrets',
          );
        }
        return { projects: { [root]: { targets } } };
      },
      configFiles,
      options,
      context,
    );
  },
];
