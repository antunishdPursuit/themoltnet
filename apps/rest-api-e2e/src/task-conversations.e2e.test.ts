/**
 * E2E: Durable task conversations
 *
 * Writes a pi-durable.v1 store through the runtime store API with Pi's own
 * storage writes, then reads it back through the task conversation API.
 */

import { randomUUID } from 'node:crypto';

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import {
  createSession,
  defineDocFamily,
  type Id,
  MemoryStorage,
  type Seq,
  type StorageWrite,
} from '@earendil-works/pi-durable';
import {
  appendRuntimeStoreCommit,
  type Client,
  createClient,
  getRuntimeStoreForAttempt,
  getTaskConversation,
  listTaskConversations,
  mintRuntimeStoreId,
  openRuntimeStore,
  releaseRuntimeStore,
} from '@moltnet/api-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { claimPinnedAttempt, type PinnedClaim } from './durable-claims.js';
import { createAgent, type TestAgent } from './helpers.js';
import { createTestHarness, type TestHarness } from './setup.js';

const context = BACKGROUND_CONTEXT;
const Attempts = defineDocFamily({
  kind: 'moltnet.attempt',
  version: 1,
  scope: 'session',
  family: true,
  initial: (conversationId: number) => ({ conversationId }),
});

describe('Task conversations API', () => {
  let harness: TestHarness;
  let client: Client;
  let owner: TestAgent;
  let outsider: TestAgent;

  beforeAll(async () => {
    harness = await createTestHarness();
    client = createClient({ baseUrl: harness.baseUrl });
    [owner, outsider] = await Promise.all([
      createAgent({
        baseUrl: harness.baseUrl,
        db: harness.db,
        bootstrapIdentityId: harness.bootstrapIdentityId,
      }),
      createAgent({
        baseUrl: harness.baseUrl,
        db: harness.db,
        bootstrapIdentityId: harness.bootstrapIdentityId,
      }),
    ]);
  });

  afterAll(async () => {
    await harness?.teardown();
  });

  const team = () => ({ 'x-moltnet-team-id': owner.personalTeamId });

  const claimPinned = () =>
    claimPinnedAttempt(client, owner, 'task-conversations');

  /** Pi's MemoryStorage produces the writes; every commit lands through the API. */
  async function writeConversation(authority: PinnedClaim) {
    const opened = await openRuntimeStore({
      client,
      auth: () => owner.accessToken,
      headers: team(),
      body: authority,
    });
    expect(opened.error).toBeUndefined();
    const { storeId, writerToken } = opened.data!;
    let head = opened.data!.headSeq;
    const writer = { ...authority, writerToken };

    class RemoteStorage extends MemoryStorage {
      override async mintId<I extends Id<string>>(): Promise<I> {
        const minted = await mintRuntimeStoreId({
          client,
          auth: () => owner.accessToken,
          headers: team(),
          path: { storeId },
          body: writer,
        });
        expect(minted.error).toBeUndefined();
        return minted.data!.id as I;
      }
      override async commit(
        writes: readonly StorageWrite[],
        ctx: typeof context,
      ): Promise<Seq> {
        const appended = await appendRuntimeStoreCommit({
          client,
          auth: () => owner.accessToken,
          headers: team(),
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
        expect(appended.error).toBeUndefined();
        head = appended.data!.seq;
        return super.commit(writes, ctx);
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
      await tx.doc(Attempts, `${authority.taskId}/${authority.attemptN}`, root);
      await tx.appendEntry(root, {
        kind: 'pi.user',
        model: [
          { role: 'user', content: 'Summarize the brief.', timestamp: 1 },
        ],
      });
      await tx.appendEntry(root, {
        kind: 'pi.assistant',
        model: [
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'The brief is summarized.' }],
            timestamp: 2,
          } as never,
        ],
      });
    }, context);
    return { storeId, writer, head };
  }

  it('reads a persisted Durable conversation for the attempt', async () => {
    const authority = await claimPinned();
    const { storeId, writer, head } = await writeConversation(authority);
    const path = { id: authority.taskId, n: authority.attemptN };

    const store = await getRuntimeStoreForAttempt({
      client,
      auth: () => owner.accessToken,
      headers: team(),
      query: { taskId: authority.taskId, attemptN: authority.attemptN },
    });
    expect(store.error).toBeUndefined();
    expect(store.data).toMatchObject({ storeId, headSeq: head });

    const listed = await listTaskConversations({
      client,
      auth: () => owner.accessToken,
      headers: team(),
      path,
    });
    expect(listed.error).toBeUndefined();
    expect(listed.data!.items).toEqual([
      expect.objectContaining({ parentConversationId: null, kind: 'main' }),
    ]);
    const conversationId = listed.data!.items[0].conversationId;

    const read = await getTaskConversation({
      client,
      auth: () => owner.accessToken,
      headers: team(),
      path: { ...path, conversationId },
    });
    expect(read.error).toBeUndefined();
    expect(read.data!.conversationId).toBe(conversationId);
    expect(read.data!.nextBeforeEntryId).toBeNull();
    expect(
      read.data!.messages.map(({ inherited, message }) => ({
        inherited,
        role: (message as { role?: string }).role,
      })),
    ).toEqual([
      { inherited: false, role: 'user' },
      { inherited: false, role: 'assistant' },
    ]);
    expect(JSON.stringify(read.data!.messages)).toContain(
      'The brief is summarized.',
    );

    // Older history pages through beforeEntryId.
    const newest = read.data!.messages.at(-1)!.entryId!;
    const older = await getTaskConversation({
      client,
      auth: () => owner.accessToken,
      headers: team(),
      path: { ...path, conversationId },
      query: { beforeEntryId: newest },
    });
    expect(older.error).toBeUndefined();
    expect(
      older.data!.messages.map(
        ({ message }) => (message as { role?: string }).role,
      ),
    ).toEqual(['user']);

    // Reading never takes the writer lease: the executor can still release it.
    const released = await releaseRuntimeStore({
      client,
      auth: () => owner.accessToken,
      headers: team(),
      path: { storeId },
      body: writer,
    });
    expect(released.response?.status).toBe(204);
  });

  it('returns not found for an unknown conversation', async () => {
    const authority = await claimPinned();
    await writeConversation(authority);

    const read = await getTaskConversation({
      client,
      auth: () => owner.accessToken,
      headers: team(),
      path: {
        id: authority.taskId,
        n: authority.attemptN,
        conversationId: '999999',
      },
    });
    expect(read.response?.status).toBe(404);
  });

  it('hides conversations from agents outside the task team', async () => {
    const authority = await claimPinned();
    await writeConversation(authority);
    const path = { id: authority.taskId, n: authority.attemptN };

    const ownTeam = await listTaskConversations({
      client,
      auth: () => outsider.accessToken,
      headers: { 'x-moltnet-team-id': outsider.personalTeamId },
      path,
    });
    expect([403, 404]).toContain(ownTeam.response?.status);

    const foreignTeam = await listTaskConversations({
      client,
      auth: () => outsider.accessToken,
      headers: team(),
      path,
    });
    expect([403, 404]).toContain(foreignTeam.response?.status);

    const snapshot = await getTaskConversation({
      client,
      auth: () => outsider.accessToken,
      headers: team(),
      path: { ...path, conversationId: '1' },
    });
    expect([403, 404]).toContain(snapshot.response?.status);
  });

  it('requires team context', async () => {
    const authority = await claimPinned();
    const listed = await listTaskConversations({
      client,
      auth: () => owner.accessToken,
      headers: {} as ReturnType<typeof team>,
      path: { id: authority.taskId, n: authority.attemptN },
    });
    expect(listed.response?.status).toBe(400);
  });
});
