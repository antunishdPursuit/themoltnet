import { FakeTasks } from '@themoltnet/tasks-orchestrator/testing';
import { describe, expect, it } from 'vitest';

import { createClassifyDecisionClient, parseYesNo } from './decision.js';

const options = {
  teamId: 'team',
  diaryId: 'diary',
  correlationId: 'corr',
  profileId: 'classifier-profile',
  pollIntervalSec: 0,
};

const question = {
  instructions: 'Is this step required?',
  criteria: { true: 'required', false: 'optional' },
};

const answer = (probability: number) => ({
  version: 1,
  provider: 'ollama',
  model: 'nimble',
  answers: { answer: { type: 'bool', probability } },
});

describe('createClassifyDecisionClient', () => {
  it('asks one bool question through a classify task', async () => {
    // Arrange
    const tasks = new FakeTasks([answer(0.93)]);
    const client = createClassifyDecisionClient(tasks, options);

    // Act
    const p = await client.yesNo({ step: 'pick-up' }, question);

    // Assert
    expect(p).toBe(0.93);
    const [body] = tasks.created;
    expect(body.taskType).toBe('classify');
    expect(body.allowedProfiles).toEqual([{ profileId: 'classifier-profile' }]);
    expect(body.correlationId).toBe('corr');
    expect(body.input).toEqual({
      version: 1,
      state: { step: 'pick-up' },
      questions: { answer: { type: 'bool', ...question } },
    });
  });

  it('reuses the idempotency key for the same question about the same state', async () => {
    // Arrange
    const tasks = new FakeTasks([answer(0.1), answer(0.1), answer(0.1)]);
    const client = createClassifyDecisionClient(tasks, options);

    // Act
    await client.yesNo({ step: 'a' }, question);
    await client.yesNo({ step: 'a' }, question);
    await client.yesNo({ step: 'b' }, question);

    // Assert
    const keys = tasks.creationOptions.map((o) => o?.idempotencyKey);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it('fails instead of guessing when the classify task fails', async () => {
    // Arrange
    const tasks = new FakeTasks([{ __taskStatus: 'failed' }]);
    const client = createClassifyDecisionClient(tasks, options);

    // Act
    const asking = client.yesNo({ step: 'a' }, question);

    // Assert
    await expect(asking).rejects.toThrow(/review question failed/);
  });
});

describe('parseYesNo', () => {
  it('rejects an output without the bool answer', () => {
    // Arrange
    const output = {
      ...answer(0.5),
      answers: { other: { type: 'bool', probability: 0.5 } },
    };

    // Act
    const parsing = () => parseYesNo(output);

    // Assert
    expect(parsing).toThrow(/no bool answer/);
  });
});
