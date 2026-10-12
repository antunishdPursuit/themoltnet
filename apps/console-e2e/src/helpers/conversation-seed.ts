import { randomUUID } from 'node:crypto';

import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
// eslint-disable-next-line @nx/enforce-module-boundaries -- This Node-only fixture writes native Durable commits; Pi is never shipped to the browser.
import {
  createSession,
  defineDocFamily,
  defineTask,
  type Id,
  LiveDoc,
  MemoryStorage,
  type StorageWrite,
} from '@earendil-works/pi-durable';
import {
  appendRuntimeStoreCommit,
  type Client,
  createClient,
  createDiary,
  createDiaryGrant,
  createRuntimeProfile,
  createTeam,
  getWhoami,
  mintRuntimeStoreId,
  openRuntimeStore,
  releaseRuntimeStore,
  renewRuntimeStore,
} from '@moltnet/api-client';
import {
  computeExecutorManifestCid,
  computeJsonCid,
} from '@moltnet/crypto-service';
import { expect } from '@playwright/test';

import { provisionAgent } from './agent-seed.js';
import { REST_API_URL } from './env.js';

const Attempts = defineDocFamily({
  kind: 'moltnet.attempt',
  version: 1,
  scope: 'session',
  family: true,
  initial: (conversationId: number) => ({ conversationId }),
});
// Only the persisted ownership is needed: no model or task worker runs here.
const Subagent = defineTask({
  name: 'console-e2e.subagent',
  version: 1,
  initial: () => ({ phase: 'idle' as const }),
  phases: { idle: async () => {} },
  abort: async () => {},
});
const assistant = (text: string) => ({
  role: 'assistant' as const,
  content: [{ type: 'text' as const, text }],
  timestamp: Date.now(),
  api: 'anthropic-messages' as const,
  provider: 'anthropic',
  model: 'fixture',
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: 'stop' as const,
});

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
  const opened = await openRuntimeStore({ ...request, body: authority });
  const { storeId, writerToken } = opened.data;
  const writer = { ...authority, writerToken };
  let head = opened.data.headSeq;
  let stopped = false;
  async function renew() {
    await agent.agent.tasks.heartbeat(task.id, attemptN, { leaseTtlSec: 120 });
    await renewRuntimeStore({ ...request, path: { storeId }, body: writer });
  }
  class RemoteStorage extends MemoryStorage {
    override async mintId<I extends Id<string>>(): Promise<I> {
      const result = await mintRuntimeStoreId({
        ...request,
        path: { storeId },
        body: writer,
      });
      return result.data.id as I;
    }
    override async commit(writes: readonly StorageWrite[]) {
      const result = await appendRuntimeStoreCommit({
        ...request,
        path: { storeId },
        body: {
          ...writer,
          commitId: randomUUID(),
          expectedSeq: head,
          writes: JSON.parse(JSON.stringify(writes)) as Record<
            string,
            unknown
          >[],
        },
      });
      head = result.data.seq;
      return super.commit(writes, context);
    }
  }
  const session = createSession(new RemoteStorage());
  const root = (
    await session.commit(
      (tx) => tx.createConversation({ ownership: { kind: 'ownerless' } }),
      context,
    )
  ).id;
  await session.commit(async (tx) => {
    await tx.doc(Attempts, `${task.id}/${attemptN}`, root);
    for (let i = 1; i <= count; i++)
      await tx.appendEntry(root, {
        kind: 'pi.assistant',
        model: [assistant(`Message ${String(i).padStart(3, '0')}`)],
      });
  }, context);

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
    conversationId: String(root),
    async append(text: string) {
      await renew();
      await session.commit(
        (tx) =>
          tx.appendEntry(root, {
            kind: 'pi.assistant',
            model: [assistant(text)],
          }),
        context,
      );
    },
    async partial(text: string) {
      await renew();
      await session.commit(async (tx) => {
        const live = await tx.doc(LiveDoc, root);
        live.generation = text
          ? { attempt: 1, message: assistant(text) }
          : undefined;
      }, context);
    },
    async subagents(count: number) {
      await renew();
      return session.commit(async (tx) => {
        const ids: string[] = [];
        for (let i = 0; i < count; i++) {
          const taskId = await tx.createTask(
            Subagent,
            {},
            { conversationId: root, ownership: { kind: 'conversation' } },
          );
          const child = await tx.createConversation({
            ownership: { kind: 'task', taskId },
          });
          await tx.appendEntry(child.id, {
            kind: 'pi.assistant',
            model: [assistant(`Subagent result ${i + 1}`)],
          });
          ids.push(String(child.id));
        }
        return ids;
      }, context);
    },
    async complete() {
      await stopRenewal();
      if (renewalError)
        throw new Error('Runtime writer renewal failed', {
          cause: renewalError,
        });
      await this.partial('');
      await releaseRuntimeStore({
        ...request,
        path: { storeId },
        body: writer,
      });
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
      await session.close(context);
      if (!stopped)
        await releaseRuntimeStore({
          ...request,
          throwOnError: false,
          path: { storeId },
          body: writer,
        });
      if (renewalError)
        throw new Error('Runtime writer renewal failed', {
          cause: renewalError,
        });
    },
  };
}
