import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildTarget,
  createNodesV2,
  findProjectRoots,
  nestedRoots,
} from './index';
import { ownedFiles } from './run';

const WORKSPACE_GLOBS = [
  'apps/*',
  'libs/*',
  'packages/*',
  'packages/cli/npm/*',
];

describe('findProjectRoots', () => {
  it('accepts project.json anywhere and package.json only for workspace members', () => {
    // Arrange
    const files = [
      'package.json',
      'apps/api/package.json',
      'packages/cli/package.json',
      'packages/cli/npm/darwin-arm64/package.json',
      'infra/absurd/project.json',
      'examples/demo/package.json',
      'apps/api/test-fixtures/pkg/package.json',
    ];

    // Act
    const roots = findProjectRoots(files, WORKSPACE_GLOBS);

    // Assert
    expect(roots).toEqual([
      'apps/api',
      'infra/absurd',
      'packages/cli',
      'packages/cli/npm/darwin-arm64',
    ]);
  });
});

describe('nestedRoots', () => {
  it('returns only roots strictly below the given root', () => {
    // Arrange
    const roots = ['packages/cli', 'packages/cli/npm/x64', 'packages/client'];

    // Act / Assert
    expect(nestedRoots('packages/cli', roots)).toEqual([
      'packages/cli/npm/x64',
    ]);
    expect(nestedRoots('.', roots)).toEqual(roots);
  });
});

describe('ownedFiles', () => {
  it('drops files of nested projects and siblings sharing a prefix', () => {
    // Arrange
    const files = [
      'packages/cli/index.js',
      'packages/cli/npm/x64/bin',
      'packages/client/index.js',
    ];

    // Act
    const owned = ownedFiles(files, 'packages/cli', ['packages/cli/npm/x64']);

    // Assert
    expect(owned).toEqual(['packages/cli/index.js']);
  });

  it('keeps only files outside every project for the workspace root', () => {
    // Arrange
    const files = ['.github/workflows/ci.yml', 'apps/api/src/main.ts'];

    // Act
    const owned = ownedFiles(files, '.', ['apps/api']);

    // Assert
    expect(owned).toEqual(['.github/workflows/ci.yml']);
  });
});

describe('buildTarget', () => {
  let workspaceRoot: string;

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'secretlint-plugin-'));
  });

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it('uses the root config and excludes nested project roots', () => {
    // Act
    const target = buildTarget(
      'packages/cli',
      ['packages/cli', 'packages/cli/npm/x64'],
      workspaceRoot,
    );

    // Assert
    expect(target.options.command).toBe(
      'node --import tsx tools/nx-plugins/secretlint/run.ts --config .secretlintrc.json --root packages/cli --exclude packages/cli/npm/x64',
    );
    expect(target.inputs).toContain('default');
    expect(target.inputs).toContain('{workspaceRoot}/.secretlintrc.json');
    expect(target.cache).toBe(true);
  });

  it('prefers a project config when one exists', () => {
    // Arrange
    mkdirSync(join(workspaceRoot, 'libs/a'), { recursive: true });
    writeFileSync(join(workspaceRoot, 'libs/a/.secretlintrc.json'), '{}');

    // Act
    const target = buildTarget('libs/a', ['libs/a'], workspaceRoot);

    // Assert
    expect(target.options.command).toContain(
      '--config libs/a/.secretlintrc.json',
    );
    expect(target.inputs).toContain(
      '{workspaceRoot}/libs/a/.secretlintrc.json',
    );
  });

  it('hashes only files outside projects for the workspace target', () => {
    // Act
    const target = buildTarget('.', ['apps/api', 'libs/a'], workspaceRoot);

    // Assert
    expect(target.inputs).toEqual(
      expect.arrayContaining([
        '{workspaceRoot}/**/*',
        '!{workspaceRoot}/apps/api/**/*',
        '!{workspaceRoot}/libs/a/**/*',
      ]),
    );
    expect(target.inputs).not.toContain('default');
  });
});

describe('createNodesV2', () => {
  let workspaceRoot: string;

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'secretlint-plugin-'));
    writeFileSync(
      join(workspaceRoot, 'pnpm-workspace.yaml'),
      "packages:\n  - 'libs/*'\n  - 'tools'\n",
    );
  });

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it('emits one node per project and the workspace target on the host', async () => {
    // Arrange
    const [, createNodes] = createNodesV2;
    const files = [
      'libs/a/package.json',
      'libs/a/project.json',
      'tools/package.json',
      'examples/x/package.json',
    ];

    // Act
    const results = await createNodes(
      files,
      { workspaceTargetName: 'secretlint:workspace' },
      { workspaceRoot, nxJsonConfiguration: {} },
    );

    // Assert
    const projects = Object.fromEntries(
      results.flatMap(([, result]) => Object.entries(result.projects ?? {})),
    );
    expect(Object.keys(projects).sort()).toEqual(['libs/a', 'tools']);
    expect(Object.keys(projects['libs/a'].targets ?? {})).toEqual([
      'secretlint',
    ]);
    expect(Object.keys(projects.tools.targets ?? {}).sort()).toEqual([
      'secretlint',
      'secretlint:workspace',
    ]);
  });
});
