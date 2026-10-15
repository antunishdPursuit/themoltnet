import { resolve } from 'node:path';

import type { ReviewEvidence } from '@moltnet/complexity-review/evidence';
import type { ClassifyOutput } from '@moltnet/tasks';
import type { TaskClient } from '@themoltnet/tasks-orchestrator';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LANES, type ReviewIdentity } from './core.js';
import {
  prepareAdaptiveReview,
  runAdaptiveReview,
  runRoutedAdaptiveReview,
} from './workflow.js';

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
  options: {
    classifierFails?: boolean;
    selected?: string;
    securityFindingStatus?: 'confirmed' | 'unclear' | 'refuted';
  } = {},
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
            ? {
                result: {
                  summary: 'Security hunt complete',
                  findings: options.securityFindingStatus
                    ? [
                        {
                          id: 'changed-route',
                          path: sourcePath,
                          side: 'new',
                          line: 1,
                          title: 'Changed route behavior',
                          hypothesis: 'The new route might skip a guard.',
                        },
                      ]
                    : [],
                },
              }
            : task.title?.includes('security verify')
              ? {
                  result: {
                    summary: 'Security verification complete',
                    findings: [
                      {
                        id: 'changed-route',
                        status: options.securityFindingStatus,
                        severity: 'medium',
                        path: sourcePath,
                        side: 'new',
                        line: 1,
                        title: 'Changed route behavior',
                        evidence: 'The changed route was inspected.',
                        reachability: 'The route has a caller.',
                        remediation: 'Restore the guard if needed.',
                      },
                    ],
                  },
                }
              : {
                  result: { summary: 'No concern', findings: [], unclear: [] },
                };
      return Promise.resolve({
        kind: 'accepted',
        result: { state: parse(raw) },
      });
    },
  );
  const tasks = { createTask } as unknown as TaskClient;
  return { tasks, createTask, created };
}

function reviewOptions(tasks: TaskClient) {
  return {
    identity,
    mode: 'active' as const,
    tasks,
    cwd,
    profiles: {
      docs: 'docs-profile',
      complexity: 'complexity-profile',
      security: 'security-profile',
      focused: 'focused-profile',
    },
  };
}

async function review(tasks: TaskClient) {
  return runAdaptiveReview(reviewOptions(tasks));
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

  it('reuses prepared routing and classifier task IDs without reclassifying', async () => {
    const { tasks, createTask } = harness({ selected: 'tests' });
    const options = reviewOptions(tasks);
    const preparation = await prepareAdaptiveReview(options);

    expect(preparation.classifierTaskIds).toEqual(['task-1']);
    expect(
      preparation.routing.routes.find((route) => route.lane === 'tests'),
    ).toMatchObject({ run: true });
    expect(createTask).toHaveBeenCalledTimes(1);

    const report = await runRoutedAdaptiveReview(options, preparation);

    expect(report.routing).toEqual(preparation.routing);
    expect(report.taskIds).toEqual(['task-1', 'task-2']);
    expect(createTask).toHaveBeenCalledTimes(2);
    expect(
      createTask.mock.calls.filter(([task]) => task.taskType === 'classify'),
    ).toHaveLength(1);
  });

  it('rejects prepared routing for another pinned head or mode', async () => {
    const { tasks, createTask } = harness({ selected: 'tests' });
    const options = reviewOptions(tasks);
    const preparation = await prepareAdaptiveReview(options);

    await expect(
      runRoutedAdaptiveReview(
        { ...options, identity: { ...identity, head: 'c'.repeat(40) } },
        preparation,
      ),
    ).rejects.toThrow('routing does not match the pinned review');
    await expect(
      runRoutedAdaptiveReview({ ...options, mode: 'shadow' }, preparation),
    ).rejects.toThrow('routing does not match the pinned review');
    expect(createTask).toHaveBeenCalledTimes(1);
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

  it.each([
    ['confirmed', 'concern'],
    ['unclear', 'unclear'],
    ['refuted', 'clear'],
  ] as const)(
    'verifies a security candidate and maps %s to %s',
    async (securityFindingStatus, status) => {
      const { tasks, created, createTask } = harness({
        selected: 'security',
        securityFindingStatus,
      });
      const report = await review(tasks);

      expect(createTask).toHaveBeenCalledTimes(3);
      expect(created.get('task-2')?.title).toContain('security hunt');
      expect(created.get('task-2')?.input.brief).toContain(patch);
      expect(created.get('task-3')?.title).toContain('security verify');
      expect(created.get('task-3')?.input.brief).toContain(
        '"id":"changed-route"',
      );
      expect(
        report.results.find((result) => result.lane === 'security'),
      ).toMatchObject({
        status,
        taskIds: ['task-2', 'task-3'],
        findings: [],
      });
      expect(report.taskIds).toEqual(['task-1', 'task-2', 'task-3']);
    },
  );

  it('marks summarized source as unassessed after a candidate-free security hunt', async () => {
    mocks.buildEvidence.mockReturnValue({
      ...evidence,
      files: [{ ...evidence.files[0], summarized: true }],
    });
    const { tasks, created } = harness({ selected: 'security' });
    const report = await review(tasks);

    expect(report.gaps).toEqual([expect.stringContaining(sourcePath)]);
    expect(
      report.results.find((result) => result.lane === 'security'),
    ).toMatchObject({ status: 'unclear', taskIds: [expect.any(String)] });
    expect(
      [...created.values()].some((task) =>
        task.title?.includes('security verify'),
      ),
    ).toBe(false);
  });
});
