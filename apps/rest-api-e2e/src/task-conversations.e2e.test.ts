/**
 * E2E: Durable task conversations
 *
 * Writes a pi-durable.v1 store through the runtime store API with Pi's own
 * storage writes, then reads it back through the task conversation API.
 */

import {
  type Client,
  createClient,
  getRuntimeStoreForAttempt,
  getTaskConversation,
  listTaskConversations,
  releaseRuntimeStore,
} from '@moltnet/api-client';
// eslint-disable-next-line @nx/enforce-module-boundaries -- Node E2E fixture setup.
import {
  assistantMessage,
  openDurableSeed,
} from '@moltnet/bootstrap/testing/durable';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { claimPinnedAttempt, type PinnedClaim } from './durable-claims.js';
import { createAgent, type TestAgent } from './helpers.js';
import { createTestHarness, type TestHarness } from './setup.js';

function roleOf({ message }: { message: unknown }) {
  return (message as { role?: string }).role;
}

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

  async function writeConversation(authority: PinnedClaim) {
    const seed = await openDurableSeed(
      { client, auth: () => owner.accessToken, headers: team() },
      authority,
      [
        {
          kind: 'pi.user',
          model: [
            { role: 'user', content: 'Summarize the brief.', timestamp: 1 },
          ],
        },
        {
          kind: 'pi.assistant',
          model: [assistantMessage('The brief is summarized.', 2)],
        },
      ],
    );
    await seed.close();
    return { storeId: seed.storeId, writer: seed.writer, head: seed.headSeq };
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
      read.data!.messages.map((entry) => ({
        inherited: entry.inherited,
        role: roleOf(entry),
      })),
    ).toEqual([
      { inherited: false, role: 'user' },
      { inherited: false, role: 'assistant' },
    ]);
    expect(JSON.stringify(read.data!.messages)).toContain(
      'The brief is summarized.',
    );

    // Older history pages through beforeEntryId.
    const newestEntryId = read.data!.messages.at(-1)?.entryId;
    expect(newestEntryId).toEqual(expect.any(String));
    const older = await getTaskConversation({
      client,
      auth: () => owner.accessToken,
      headers: team(),
      path: { ...path, conversationId },
      query: { beforeEntryId: newestEntryId! },
    });
    expect(older.error).toBeUndefined();
    expect(older.data!.messages.map(roleOf)).toEqual(['user']);

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
    const listed = await listTaskConversations({
      client,
      auth: () => owner.accessToken,
      headers: team(),
      path,
    });
    expect(listed.error).toBeUndefined();
    const { conversationId } = listed.data!.items[0];

    // In its own team the outsider cannot see the task at all.
    const ownTeam = await listTaskConversations({
      client,
      auth: () => outsider.accessToken,
      headers: { 'x-moltnet-team-id': outsider.personalTeamId },
      path,
    });
    expect(ownTeam.response?.status).toBe(404);

    // The auth plugin rejects a team header naming a team it is not in.
    const foreignTeam = await listTaskConversations({
      client,
      auth: () => outsider.accessToken,
      headers: team(),
      path,
    });
    expect(foreignTeam.response?.status).toBe(403);

    const snapshot = await getTaskConversation({
      client,
      auth: () => outsider.accessToken,
      headers: team(),
      path: { ...path, conversationId },
    });
    expect(snapshot.response?.status).toBe(403);
  });

  it('requires team context', async () => {
    const authority = await claimPinned();
    const listed = await listTaskConversations({
      client,
      auth: () => owner.accessToken,
      // @ts-expect-error -- deliberately omits the required team header.
      headers: {},
      path: { id: authority.taskId, n: authority.attemptN },
    });
    expect(listed.response?.status).toBe(400);
  });
});
