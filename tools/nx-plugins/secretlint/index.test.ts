import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { CreateNodesContextV2 } from '@nx/devkit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createNodesV2, externalDependencies, orphanGlobs } from './index';

const ROOT_CONFIG = JSON.stringify({
  rules: [
    { id: '@secretlint/secretlint-rule-preset-recommend' },
    { id: '@secretlint/secretlint-rule-pattern' },
  ],
});

describe('secretlint plugin', () => {
  let workspaceRoot: string;
  let context: CreateNodesContextV2;

  const touch = (path: string, content = '') => {
    mkdirSync(dirname(join(workspaceRoot, path)), { recursive: true });
    writeFileSync(join(workspaceRoot, path), content);
  };

  const run = async (files: string[], options = {}) => {
    const [, createNodes] = createNodesV2;
    const results = await createNodes(files, options, context);
    return Object.fromEntries(
      results.flatMap(([, result]) => Object.entries(result.projects ?? {})),
    );
  };

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'secretlint-plugin-'));
    context = { workspaceRoot, nxJsonConfiguration: {} };
    touch('.secretlintrc.json', ROOT_CONFIG);
    touch('.gitignore', 'node_modules\ndist\n');
    touch('package.json');
    touch('README.md');
    touch('.github/workflows/ci.yml');
    touch('node_modules/x/index.js');
    touch('infra/README.md');
    touch('infra/ory/kratos.yaml');
    touch('infra/absurd/project.json');
    touch('libs/a/package.json');
    touch('libs/a/project.json');
    touch('packages/cli/package.json');
    touch('packages/cli/npm/x64/package.json');
    touch('tools/package.json');
  });

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it('infers one target per project, run from the workspace root', async () => {
    // Act
    const projects = await run([
      'package.json',
      'libs/a/package.json',
      'libs/a/project.json',
      'tools/package.json',
    ]);

    // Assert
    expect(Object.keys(projects).sort()).toEqual(['libs/a', 'tools']);
    const target = projects['libs/a'].targets?.secretlint;
    expect(target?.command).toBe(
      'secretlint "libs/a/**/*" --secretlintrc .secretlintrc.json',
    );
    expect(target?.options).toBeUndefined();
    expect(target?.cache).toBe(true);
    expect(target?.inputs).toEqual([
      '{workspaceRoot}/libs/a/**/*',
      '{workspaceRoot}/.secretlintrc.json',
      {
        externalDependencies: [
          'secretlint',
          '@secretlint/secretlint-rule-preset-recommend',
          '@secretlint/secretlint-rule-pattern',
        ],
      },
    ]);
  });

  it('uses a project config when one exists', async () => {
    // Arrange
    touch('libs/a/.secretlintrc.json', JSON.stringify({ rules: [] }));

    // Act
    const projects = await run(['libs/a/package.json', 'tools/package.json']);

    // Assert
    const target = projects['libs/a'].targets?.secretlint;
    expect(target?.command).toContain(
      '--secretlintrc libs/a/.secretlintrc.json',
    );
    expect(target?.inputs).toContainEqual({
      externalDependencies: ['secretlint'],
    });
  });

  it('adds the workspace target to the host project only', async () => {
    // Act
    const projects = await run(['libs/a/package.json', 'tools/package.json'], {
      workspaceTargetName: 'secretlint:workspace',
    });

    // Assert
    expect(Object.keys(projects['libs/a'].targets ?? {})).toEqual([
      'secretlint',
    ]);
    expect(Object.keys(projects.tools.targets ?? {}).sort()).toEqual([
      'secretlint',
      'secretlint:workspace',
    ]);
  });

  it('fails when the workspace target host is not a project', async () => {
    // Act / Assert
    await expect(run(['libs/a/package.json'])).rejects.toThrow(
      /host "tools" is not a project root/,
    );
  });

  it('covers every file outside projects with positive globs', () => {
    // Act
    const globs = orphanGlobs(
      [
        'infra/absurd',
        'libs/a',
        'packages/cli',
        'packages/cli/npm/x64',
        'tools',
      ],
      workspaceRoot,
    );

    // Assert
    expect(globs.sort()).toEqual(
      ['*', '.github/**/*', 'infra/*', 'infra/ory/**/*'].sort(),
    );
  });

  it('derives external dependencies from the config rules', () => {
    // Act / Assert
    expect(
      externalDependencies(join(workspaceRoot, '.secretlintrc.json')),
    ).toEqual([
      'secretlint',
      '@secretlint/secretlint-rule-preset-recommend',
      '@secretlint/secretlint-rule-pattern',
    ]);
  });
});
