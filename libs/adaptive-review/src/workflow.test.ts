import { resolve } from 'node:path';

import type { ReviewEvidence } from '@moltnet/complexity-review/evidence';
import type { ClassifyOutput } from '@moltnet/tasks';
import type { TaskClient } from '@themoltnet/tasks-orchestrator';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LANES, type ReviewIdentity } from './core.js';
import { runAdaptiveReview } from './workflow.js';

const mocks = vi.hoisted(() => ({
  buildEvidence: vi.fn(),
  createGit: vi.fn(() => vi.fn()),
  loadReviewConfig: vi.fn(() => ({ config: {}, source: 'base' })),
  runDocsImpactReview: vi.fn(),
  runComplexityReview: vi.fn(),
  waitForTaskOutcome: vi.fn(),
}));

vi.mock('@moltnet/complexity-review/evidence', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  buildEvidence: mocks.buildEvidence,
}));
vi.mock('@moltnet/docs-impact-review', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createGit: mocks.createGit,
  loadReviewConfig: mocks.loadReviewConfig,
  runDocsImpactReview: mocks.runDocsImpactReview,
}));
vi.mock('@moltnet/complexity-review/workflow', () => ({
  runComplexityReview: mocks.runComplexityReview,
}));
vi.mock('@themoltnet/tasks-orchestrator', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  waitForTaskOutcome: mocks.waitForTaskOutcome,
}));

const cwd = resolve(import.meta.dirname, '../../..');
const identity: ReviewIdentity = {
  repo: 'getlarge/themoltnet',
  pr: 42,
  title: 'Change API behavior',
  body: 'Adds a route',
  base: 'a'.repeat(40),
  head: 'b'.repeat(40),
  teamId: 'team',
  diaryId: 'diary',
  correlationId: 'correlation',
  classifierProfileId: 'classifier-profile',
};
const sourcePath = 'apps/rest-api/src/routes/foo.ts';
const patch = [
  `diff --git a/${sourcePath} b/${sourcePath}`,
  `--- a/${sourcePath}`,
  `+++ b/${sourcePath}`,
  '@@ -1 +1 @@',
  '-old',
  '+new',
].join('\n');
const evidence: ReviewEvidence = {
  manifest: sourcePath,
  files: [{ path: sourcePath, patch, bytes: Buffer.byteLength(patch) }],
  bytes: Buffer.byteLength(patch),
  generatedPaths: [],
};

function answers(selected?: string): ClassifyOutput['answers'] {
  const result: ClassifyOutput['answers'] = {};
  for (const lane of LANES) {
    result[lane] = {
      type: 'bool',
      probability: lane === selected ? 0.9 : 0.01,
    };
  }
  result['code-complexity'] = { type: 'score', score: 1, confidence: 1 };
  result['review-effort'] = { type: 'score', score: 2, confidence: 1 };
  return result;
}

function harness(
  options: { classifierFails?: boolean; selected?: string } = {},
) {
  let nextId = 0;
  const created = new Map<
    string,
    { taskType: string; title?: string; input: { brief?: string } }
  >();
  const createTask = vi.fn((body: Parameters<TaskClient['createTask']>[0]) => {
    const id = `task-${++nextId}`;
    created.set(id, body);
    return Promise.resolve({ id });
  });
  mocks.waitForTaskOutcome.mockImplementation(
    (id: string, { parse }: { parse: (output: unknown) => unknown }) => {
      const task = created.get(id);
      if (!task) throw new Error(`unknown task ${id}`);
      if (task.taskType === 'classify' && options.classifierFails) {
        throw new Error('classifier unavailable');
      }
      const raw =
        task.taskType === 'classify'
          ? { answers: answers(options.selected) }
          : task.title?.includes('security hunt')
            ? { result: { summary: 'No candidate', findings: [] } }
            : { result: { summary: 'No concern', findings: [], unclear: [] } };
      return Promise.resolve({
        kind: 'accepted',
        result: { state: parse(raw) },
      });
    },
  );
  const tasks = { createTask } as unknown as TaskClient;
  return { tasks, createTask, created };
}

async function review(tasks: TaskClient) {
  return runAdaptiveReview({
    identity,
    mode: 'active',
    tasks,
    cwd,
    profiles: {
      docs: 'docs-profile',
      complexity: 'complexity-profile',
      security: 'security-profile',
      focused: 'focused-profile',
    },
  });
}

describe('adaptive review orchestration', () => {
  beforeEach(() => {
    mocks.buildEvidence.mockReturnValue(evidence);
    mocks.runDocsImpactReview.mockResolvedValue({
      status: 'completed',
      outcome: 'no-updates-needed',
      findings: [],
      timings: { stages: {} },
    });
    mocks.runComplexityReview.mockResolvedValue({
      taskIds: ['complexity-task'],
      output: { verdict: 'Low complexity', scores: [] },
    });
    vi.spyOn(process, 'cwd').mockReturnValue(cwd);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('classifies once, runs a selected focused lane, and screens the others', async () => {
    const { tasks, createTask, created } = harness({ selected: 'tests' });
    const report = await review(tasks);

    expect(report.packetCount).toBe(1);
    expect(report.routing.classifierFailed).toBe(false);
    expect(report.routing.scores).toEqual({
      'code-complexity': 1,
      'review-effort': 2,
    });
    expect(
      report.results.find((result) => result.lane === 'tests'),
    ).toMatchObject({
      status: 'clear',
      taskIds: ['task-2'],
    });
    expect(
      report.results.filter((result) => result.status === 'screened'),
    ).toHaveLength(5);
    expect(createTask).toHaveBeenCalledTimes(2);
    expect(created.get('task-2')?.input.brief).toContain(sourcePath);
    expect(report.taskIds).toEqual(['task-1', 'task-2']);
  });

  it('waits for one classifier outcome before creating the next packet task', async () => {
    const largePatch = `${patch}\n+${'x'.repeat(25_000)}`;
    mocks.buildEvidence.mockReturnValue({
      ...evidence,
      files: [
        {
          path: sourcePath,
          patch: largePatch,
          bytes: Buffer.byteLength(largePatch),
        },
      ],
      bytes: Buffer.byteLength(largePatch),
    });
    const { tasks, createTask } = harness();
    let releaseFirst: () => void = () => {
      throw new Error('first classifier was not awaited');
    };
    const firstOutcome = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    mocks.waitForTaskOutcome.mockImplementation(
      async (
        id: string,
        { parse }: { parse: (output: unknown) => unknown },
      ) => {
        if (id === 'task-1') await firstOutcome;
        return {
          kind: 'accepted',
          result: { state: parse({ answers: answers() }) },
        };
      },
    );

    const pending = review(tasks);
    await vi.waitFor(() => expect(createTask).toHaveBeenCalledTimes(1));
    expect(mocks.waitForTaskOutcome).toHaveBeenCalledTimes(1);
    releaseFirst();

    const report = await pending;
    expect(report.packetCount).toBe(2);
    expect(createTask).toHaveBeenCalledTimes(2);
    expect(report.taskIds).toEqual(['task-1', 'task-2']);
  });

  it('runs every deep lane and records a gap when classification fails', async () => {
    const { tasks, createTask, created } = harness({ classifierFails: true });
    const report = await review(tasks);

    expect(report.routing.classifierFailed).toBe(true);
    expect(report.routing.routes.every((route) => route.run)).toBe(true);
    expect(report.gaps).toEqual([
      expect.stringContaining('classifier unavailable'),
    ]);
    expect(report.results.every((result) => result.status === 'clear')).toBe(
      true,
    );
    expect(mocks.runDocsImpactReview).toHaveBeenCalledOnce();
    expect(mocks.runComplexityReview).toHaveBeenCalledOnce();
    expect(
      [...created.values()].some((task) =>
        task.title?.includes('security hunt'),
      ),
    ).toBe(true);
    expect(createTask).toHaveBeenCalledTimes(5);
  });

  it('reviews retained source and marks generated paths as unassessed', async () => {
    const generatedPath = 'libs/sdk/src/generated.ts';
    mocks.buildEvidence.mockReturnValue({
      ...evidence,
      manifest: `${sourcePath}\n${generatedPath}`,
      generatedPaths: [generatedPath],
    });
    const { tasks, created } = harness();
    const report = await review(tasks);

    expect(report.routing.routes.every((route) => route.run)).toBe(true);
    expect(report.gaps).toContain(
      `Generated path not classified: ${generatedPath}`,
    );
    expect(
      report.results.find((result) => result.lane === 'security'),
    ).toMatchObject({
      status: 'unclear',
      taskIds: [expect.any(String)],
    });
    const securityHunt = [...created.values()].find((task) =>
      task.title?.includes('security hunt'),
    );
    expect(securityHunt?.input.brief).toContain(patch);
    expect(securityHunt?.input.brief).not.toContain(`Path ${generatedPath}:`);
  });
});
