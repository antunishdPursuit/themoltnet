/**
 * Decision models answer typed questions with probabilities instead of
 * generating text. The review asks them through MoltNet `classify` tasks, so
 * every answer is a durable task record naming the provider and model that
 * produced it. The runtime profile's `models.classification` picks the model
 * (for example a local Ollama `nimble`, or Typesafe `jev-latest`).
 */
import { createHash } from 'node:crypto';

import { type ClassifyInput, ClassifyOutput } from '@moltnet/tasks';
import {
  createInlineContext,
  type TaskClient,
  waitForTaskOutcome,
} from '@themoltnet/tasks-orchestrator';
import { Value } from 'typebox/value';

export interface YesNoQuestion {
  instructions: string;
  criteria: { false: string; true: string };
}

export interface DecisionClient {
  /** Probability that the answer is "true", from 0 to 1. */
  yesNo(
    state: Record<string, unknown>,
    question: YesNoQuestion,
  ): Promise<number>;
}

export interface ClassifyDecisionOptions {
  teamId: string;
  diaryId: string;
  projectId?: string;
  correlationId: string;
  /** Runtime profile with `models.classification`. */
  profileId: string;
  pollIntervalSec?: number;
  /** Fail when no worker claims a question within this many seconds. */
  claimTimeoutSec?: number;
}

const QUESTION = 'answer';

export function createClassifyDecisionClient(
  tasks: TaskClient,
  options: ClassifyDecisionOptions,
): DecisionClient {
  const pollIntervalSec = options.pollIntervalSec ?? 2;
  const claimTimeoutSec = options.claimTimeoutSec ?? 600;
  const ctx = {
    ...createInlineContext(),
    sleepFor: (_name: string, seconds: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, seconds * 1000);
      }),
  };

  async function awaitClaim(taskId: string) {
    const deadline = Date.now() + claimTimeoutSec * 1000;
    for (;;) {
      const task = await tasks.getTask(taskId);
      if (task.status !== 'queued') return;
      if (Date.now() >= deadline)
        throw new Error(
          `no worker claimed classify task ${taskId} within ${claimTimeoutSec}s; check that a poller serves the classification profile`,
        );
      await ctx.sleepFor(`claim.${taskId}`, pollIntervalSec);
    }
  }

  return {
    async yesNo(state, question) {
      const input: ClassifyInput = {
        version: 1,
        state,
        questions: { [QUESTION]: { type: 'bool', ...question } },
      };
      // The same question about the same state in one run is one task.
      const digest = createHash('sha256')
        .update(`${options.correlationId}\0${JSON.stringify(input)}`)
        .digest('base64url');
      const task = await tasks.createTask(
        {
          taskType: 'classify',
          title: 'PDDL review question',
          teamId: options.teamId,
          diaryId: options.diaryId,
          ...(options.projectId ? { projectId: options.projectId } : {}),
          correlationId: options.correlationId,
          allowedProfiles: [{ profileId: options.profileId }],
          runningTimeoutSec: 120,
          dispatchTimeoutSec: 300,
          expiresInSec: 3600,
          maxAttempts: 2,
          tags: ['pddl:designer', 'stage:review'],
          input,
        },
        { idempotencyKey: 'pddl-review:' + digest },
      );
      await awaitClaim(task.id);
      const outcome = await waitForTaskOutcome(task.id, {
        tasks,
        ctx,
        pollIntervalSec,
        parse: parseYesNo,
      });
      if (outcome.kind !== 'accepted')
        throw new Error(`review question failed: ${outcome.reason}`);
      return outcome.result.state;
    },
  };
}

/** Probability of "true" from an accepted classify output. */
export function parseYesNo(output: unknown): number {
  if (!Value.Check(ClassifyOutput, output))
    throw new Error('classify output does not match ClassifyOutput');
  const answer = output.answers[QUESTION];
  if (answer?.type !== 'bool')
    throw new Error(`classify output has no bool answer for ${QUESTION}`);
  return answer.probability;
}
