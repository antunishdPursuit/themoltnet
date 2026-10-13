import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { CreateNodesContextV2, ProjectConfiguration } from '@nx/devkit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createNodesV2, externalDependencies, orphanGlobs } from './index';

const ROOT_CONFIG = `{
  // Comments are valid: Secretlint parses its config as JSON5.
  "rules": [
    { "id": "@secretlint/secretlint-rule-preset-recommend" },
    { "id": "@secretlint/secretlint-rule-pattern" },
  ],
}`;
const ROOT_DEPENDENCIES = [
  'secretlint',
  '@secretlint/secretlint-rule-preset-recommend',
  '@secretlint/secretlint-rule-pattern',
];

describe('secretlint plugin', () => {
  let workspaceRoot: string;
  let context: CreateNodesContextV2;

  const touch = (path: string, content = '') => {
    mkdirSync(dirname(join(workspaceRoot, path)), { recursive: true });
    writeFileSync(join(workspaceRoot, path), content);
  };

  /** Every project entry the plugin emits, keeping duplicates visible. */
  const run = async (files: string[], options = {}) => {
    const [, createNodes] = createNodesV2;
    const results = await createNodes(files, options, context);
    return results.flatMap(([, result]) =>
      Object.entries(result.projects ?? {}),
    ) as Array<[string, Partial<ProjectConfiguration>]>;
  };

  const byRoot = (entries: Array<[string, Partial<ProjectConfiguration>]>) =>
    Object.fromEntries(entries);

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'secretlint-plugin-'));
    context = { workspaceRoot, nxJsonConfiguration: {} };
    touch('.secretlintrc.json', ROOT_CONFIG);
    touch('.gitignore', 'node_modules\ndist\n*.local\n');
    touch('package.json');
    touch('README.md');
    touch('.github/workflows/ci.yml');
    touch('node_modules/x/index.js');
    touch('infra/README.md');
    touch('infra/ory/kratos.yaml');
    touch('infra/absurd/project.json');
    touch('libs/a/package.json');
    touch('libs/a/project.json');
    touch('libs/settings.local');
    touch('packages/cli/package.json');
    touch('packages/cli/npm/x64/package.json');
    touch('tools/package.json');
  });

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it('infers one target per project, run from the workspace root', async () => {
    // Act
    const entries = await run([
      'package.json',
      'libs/a/package.json',
      'libs/a/project.json',
      'tools/package.json',
    ]);

    // Assert
    expect(entries.map(([root]) => root).sort()).toEqual(['libs/a', 'tools']);
    const target = byRoot(entries)['libs/a'].targets?.secretlint;
    expect(target?.command).toBe(
      "secretlint 'libs/a/**/*' --secretlintrc '.secretlintrc.json'",
    );
    expect(target?.options).toBeUndefined();
    expect(target?.cache).toBe(true);
    expect(target?.inputs).toEqual([
      '{workspaceRoot}/libs/a/**/*',
      '{workspaceRoot}/.secretlintrc.json',
      { externalDependencies: ROOT_DEPENDENCIES },
    ]);
  });

  it('uses a project config when one exists', async () => {
    // Arrange
    touch('libs/a/.secretlintrc.json', '{ "rules": [] }');

    // Act
    const entries = await run(['libs/a/package.json', 'tools/package.json']);

    // Assert
    const target = byRoot(entries)['libs/a'].targets?.secretlint;
    expect(target?.command).toContain(
      "--secretlintrc 'libs/a/.secretlintrc.json'",
    );
    expect(target?.inputs).toContainEqual({
      externalDependencies: ['secretlint'],
    });
  });

  it('wires the workspace target to the orphan globs and the root config', async () => {
    // Arrange: the host's own config must not leak into the workspace scan.
    touch('tools/.secretlintrc.json', '{ "rules": [] }');

    // Act
    const entries = await run(
      [
        'infra/absurd/project.json',
        'libs/a/package.json',
        'packages/cli/package.json',
        'packages/cli/npm/x64/package.json',
        'tools/package.json',
      ],
      { targetName: 'scan' },
    );

    // Assert
    const projects = byRoot(entries);
    expect(Object.keys(projects['libs/a'].targets ?? {})).toEqual(['scan']);
    expect(Object.keys(projects.tools.targets ?? {}).sort()).toEqual([
      'scan',
      'scan:workspace',
    ]);
    const target = projects.tools.targets?.['scan:workspace'];
    expect(target?.command).toBe(
      "secretlint '*' '.github/**/*' 'infra/*' 'infra/ory/**/*' --secretlintrc '.secretlintrc.json'",
    );
    expect(target?.inputs).toEqual([
      '{workspaceRoot}/*',
      '{workspaceRoot}/.github/**/*',
      '{workspaceRoot}/infra/*',
      '{workspaceRoot}/infra/ory/**/*',
      '{workspaceRoot}/.secretlintrc.json',
      { externalDependencies: ROOT_DEPENDENCIES },
    ]);
  });

  it('emits a directory with two manifests once', async () => {
    // Act
    const entries = await run([
      'libs/a/package.json',
      'libs/a/project.json',
      'tools/package.json',
    ]);

    // Assert
    expect(entries.filter(([root]) => root === 'libs/a')).toHaveLength(1);
  });

  it('fails when the workspace target host is not a project', async () => {
    // Act / Assert
    await expect(run(['libs/a/package.json'])).rejects.toThrow(
      /host "tools" is not a project root; set workspaceTargetProjectRoot/,
    );
  });

  it('skips gitignored files and directories when computing orphan globs', () => {
    // Act: libs/ holds only a gitignored file besides its project.
    const globs = orphanGlobs(['libs/a', 'tools'], workspaceRoot);

    // Assert
    expect(globs).not.toContain('libs/*');
    expect(globs).not.toContain('node_modules/**/*');
  });

  it('computes orphan globs without a .gitignore', () => {
    // Arrange
    rmSync(join(workspaceRoot, '.gitignore'));

    // Act
    const globs = orphanGlobs(['libs/a', 'tools'], workspaceRoot);

    // Assert
    expect(globs).toContain('libs/*');
    expect(globs).toContain('node_modules/**/*');
  });

  describe('externalDependencies', () => {
    it('keeps only string rule ids', () => {
      // Arrange
      touch('rc.json', '{ "rules": [{ "id": "a" }, { "id": 1 }, {}] }');

      // Act / Assert
      expect(externalDependencies(join(workspaceRoot, 'rc.json'))).toEqual([
        'secretlint',
        'a',
      ]);
    });

    it('accepts a config without rules', () => {
      // Arrange
      touch('rc.json', '{}');

      // Act / Assert
      expect(externalDependencies(join(workspaceRoot, 'rc.json'))).toEqual([
        'secretlint',
      ]);
    });

    it('names the config file when it cannot be parsed', () => {
      // Arrange
      touch('rc.json', '{ "rules": [');

      // Act / Assert
      expect(() =>
        externalDependencies(join(workspaceRoot, 'rc.json')),
      ).toThrow(/secretlint plugin: cannot read .*rc\.json/);
    });
  });
});
