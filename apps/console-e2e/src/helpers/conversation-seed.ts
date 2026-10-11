import { randomUUID } from 'node:crypto';

import {
  type Client,
  createClient,
  createDiary,
  createDiaryGrant,
  createRuntimeProfile,
  createTeam,
  getWhoami,
} from '@moltnet/api-client';
// eslint-disable-next-line @nx/enforce-module-boundaries -- Node-only browser E2E setup.
import {
  assistantMessage,
  openDurableSeed,
} from '@moltnet/bootstrap/testing/durable';
import {
  computeExecutorManifestCid,
  computeJsonCid,
} from '@moltnet/crypto-service';
import { expect } from '@playwright/test';

import { provisionAgent } from './agent-seed.js';
import { REST_API_URL } from './env.js';

/** Real cross-principal team: human reads in the console, agent writes Durable. */
export async function provisionConversationTeam(human: Client) {
  const agent = await provisionAgent('console-conversations');
  try {
    const subject = await getWhoami({ client: human, throwOnError: true });
    const team = await createTeam({
      client: human,
      throwOnError: true,
      body: {
        name: `conversation-e2e-${randomUUID()}`,
        foundingMembers: [
          {
            subjectId: subject.data.subjectId,
            subjectNs: 'Human',
            role: 'owner',
          },
          {
            subjectId: agent.genesis.agentId,
            subjectNs: 'Agent',
            role: 'manager',
          },
        ],
      },
    });
    const teamId = team.data.id;
    const headers = { 'x-moltnet-team-id': teamId };
    let profile!: NonNullable<
      Awaited<ReturnType<typeof createRuntimeProfile>>['data']
    >;
    await expect(async () => {
      profile = (
        await createRuntimeProfile({
          client: human,
          headers,
          throwOnError: true,
          body: {
            name: `conversation-e2e-${randomUUID()}`,
            runtimeKind: 'gondolin_pi',
            models: {
              generation: { provider: 'anthropic', model: 'claude-sonnet-4-5' },
            },
            sandbox: {},
          },
        })
      ).data;
    }).toPass({ timeout: 20_000 });
    const diary = await createDiary({
      client: human,
      headers,
      throwOnError: true,
      body: { name: `conversation-${randomUUID()}`, visibility: 'private' },
    });
    await createDiaryGrant({
      client: human,
      throwOnError: true,
      path: { id: diary.data.id },
      body: {
        subjectId: agent.genesis.agentId,
        subjectNs: 'Agent',
        role: 'writer',
      },
    });
    return { agent, teamId, diaryId: diary.data.id, profile };
  } catch (error) {
    await agent.teardown();
    throw error;
  }
}

export async function seedConversation(
  env: Awaited<ReturnType<typeof provisionConversationTeam>>,
  count = 1,
) {
  const { agent, teamId, diaryId, profile } = env;
  const manifest = {
    schemaVersion: 'moltnet:executor-manifest:v1',
    runtime: {
      kind: profile.runtimeKind,
      engine: 'pi',
      sandbox: 'gondolin',
      id: 'console-conversations-e2e',
      version: '1',
    },
    profile: { id: profile.id, definitionCid: profile.definitionCid },
    vm: {
      templateId: 'console-e2e',
      templateVersion: '1',
      templateFingerprint: 'bafyreie2e-template',
      guestAssetBuildId: 'console-e2e',
    },
    tools: [],
    extensions: [],
    executables: [],
  };
  const executorFingerprint = computeExecutorManifestCid(manifest);
  const task = await agent.agent.tasks.create(
    {
      taskType: 'freeform',
      title: `Conversation ${randomUUID()}`,
      diaryId,
      input: { brief: 'Exercise console conversation integration.' },
      allowedProfiles: [{ profileId: profile.id }],
    },
    { teamId },
  );
  const claim = await agent.agent.tasks.claim(task.id, {
    leaseTtlSec: 120,
    profileId: profile.id,
    executorFingerprint,
    executorManifest: manifest,
  });
  const attemptN = claim.attempt.attemptN;
  await agent.agent.tasks.heartbeat(task.id, attemptN, { leaseTtlSec: 120 });
  const authority = {
    taskId: task.id,
    attemptN,
    leaseId: claim.attempt.leaseId!,
    executorFingerprint,
  };
  const request = {
    client: createClient({ baseUrl: REST_API_URL }),
    auth: () => agent.genesis.accessToken,
    headers: { 'x-moltnet-team-id': teamId },
    throwOnError: true as const,
  };
  const seed = await openDurableSeed(
    request,
    authority,
    Array.from({ length: count }, (_, i) => ({
      kind: 'pi.assistant',
      model: [assistantMessage(`Message ${String(i + 1).padStart(3, '0')}`)],
    })),
  );
  let stopped = false;
  async function renew() {
    await agent.agent.tasks.heartbeat(task.id, attemptN, { leaseTtlSec: 120 });
    await seed.renew();
  }

  let renewal = Promise.resolve();
  let renewalError: unknown;
  const timer = setInterval(() => {
    renewal = renewal.then(renew).catch((error) => {
      renewalError = error;
    });
  }, 10_000);
  function stopRenewal() {
    clearInterval(timer);
    return renewal;
  }

  return {
    taskId: task.id,
    attemptN,
    conversationId: seed.conversationId,
    async append(text: string) {
      await renew();
      await seed.append([
        { kind: 'pi.assistant', model: [assistantMessage(text)] },
      ]);
    },
    async partial(text: string) {
      await renew();
      await seed.partial(text ? assistantMessage(text) : undefined);
    },
    async subagents(count: number) {
      await renew();
      return seed.subagents(
        Array.from({ length: count }, (_, i) => [
          {
            kind: 'pi.assistant',
            model: [assistantMessage(`Subagent result ${i + 1}`)],
          },
        ]),
      );
    },
    async complete() {
      await stopRenewal();
      if (renewalError)
        throw new Error('Runtime writer renewal failed', {
          cause: renewalError,
        });
      await this.partial('');
      await seed.release();
      const output = {
        summary:
          'The console conversation integration fixture completed successfully.',
        verification: {
          inputCid: claim.task.inputCid,
          results: [
            {
              id: 'submit-output',
              kind: 'gate' as const,
              status: 'pass' as const,
              detail: 'Conversation fixture completed.',
            },
          ],
          passed: true,
        },
      };
      await agent.agent.tasks.complete(task.id, attemptN, {
        executorManifest: manifest,
        executorFingerprint,
        output,
        outputCid: await computeJsonCid(output),
        usage: { inputTokens: 0, outputTokens: 0 },
      });
      stopped = true;
    },
    async close() {
      await stopRenewal();
      await seed.close();
      if (!stopped) await seed.release();
      if (renewalError)
        throw new Error('Runtime writer renewal failed', {
          cause: renewalError,
        });
    },
  };
}
