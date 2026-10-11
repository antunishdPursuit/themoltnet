/**
 * E2E: Durable runtime stores
 *
 * Exercises the pi-durable.v1 store contract against the Docker stack and its
 * object store: writer leases, ID minting, ordered idempotent commits, NDJSON
 * reads, and attempt/team authorization.
 */

import { randomUUID } from 'node:crypto';

import {
  appendRuntimeStoreCommit,
  type Client,
  createClient,
  getRuntimeStoreForAttempt,
  listRuntimeStoreCommits,
  mintRuntimeStoreId,
  openRuntimeStore,
  releaseRuntimeStore,
  renewRuntimeStore,
} from '@moltnet/api-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { claimPinnedAttempt, type PinnedClaim } from './durable-claims.js';
import { createAgent, type TestAgent } from './helpers.js';
import { createTestHarness, type TestHarness } from './setup.js';

describe('Durable runtime stores API', () => {
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
  const claim = () => claimPinnedAttempt(client, owner, 'runtime-stores');

  async function open(authority: PinnedClaim) {
    const opened = await openRuntimeStore({
      client,
      auth: () => owner.accessToken,
      headers: team(),
      body: authority,
    });
    expect(opened.error).toBeUndefined();
    return opened.data!;
  }

  function append(
    storeId: string,
    writer: PinnedClaim & { writerToken: string },
    body: {
      commitId: string;
      expectedSeq: number;
      writes: Record<string, unknown>[];
    },
  ) {
    return appendRuntimeStoreCommit({
      client,
      auth: () => owner.accessToken,
      headers: team(),
      path: { storeId },
      body: { ...writer, ...body },
    });
  }

  async function readCommits(
    storeId: string,
    query: { afterSeq?: number; limit?: number },
    accessToken = owner.accessToken,
  ) {
    const response = await listRuntimeStoreCommits({
      client,
      auth: () => accessToken,
      headers: team(),
      path: { storeId },
      query,
      parseAs: 'text',
    });
    if (response.error !== undefined)
      return { status: response.response?.status };
    const [header, ...lines] = (response.data as unknown as string)
      .split('\n')
      .filter(Boolean)
      .map(
        (line) => JSON.parse(line) as Record<string, unknown> & { seq: number },
      );
    return { status: response.response?.status, header, commits: lines };
  }

  it('binds a store to the attempt and appends ordered, idempotent commits', async () => {
    const authority = await claim();
    const attemptQuery = {
      taskId: authority.taskId,
      attemptN: authority.attemptN,
    };

    const before = await getRuntimeStoreForAttempt({
      client,
      auth: () => owner.accessToken,
      headers: team(),
      query: attemptQuery,
    });
    expect(before.error).toBeUndefined();
    expect(before.data).toBeNull();

    const handle = await open(authority);
    expect(handle).toMatchObject({ format: 'pi-durable.v1', headSeq: 0 });
    const writer = { ...authority, writerToken: handle.writerToken };

    const ids: number[] = [];
    for (let i = 0; i < 2; i++) {
      const minted = await mintRuntimeStoreId({
        client,
        auth: () => owner.accessToken,
        headers: team(),
        path: { storeId: handle.storeId },
        body: writer,
      });
      expect(minted.error).toBeUndefined();
      ids.push(minted.data!.id);
    }
    expect(ids[1]).toBeGreaterThan(ids[0]);

    const first = {
      commitId: randomUUID(),
      expectedSeq: 0,
      writes: [{ type: 'conversation', value: { id: ids[0] } }],
    };
    const second = {
      commitId: randomUUID(),
      expectedSeq: 1,
      writes: [{ type: 'conversation', value: { id: ids[1] } }],
    };
    expect((await append(handle.storeId, writer, first)).data).toEqual({
      seq: 1,
    });
    expect((await append(handle.storeId, writer, second)).data).toEqual({
      seq: 2,
    });

    // A lost acknowledgment is retried with the same commit ID and payload.
    const replay = await append(handle.storeId, writer, first);
    expect(replay.error).toBeUndefined();
    expect(replay.data).toEqual({ seq: 1 });

    const reusedId = await append(handle.storeId, writer, {
      ...first,
      writes: [{ type: 'conversation', value: { id: 999 } }],
    });
    expect(reusedId.response?.status).toBe(409);

    const staleHead = await append(handle.storeId, writer, {
      commitId: randomUUID(),
      expectedSeq: 1,
      writes: [],
    });
    expect(staleHead.response?.status).toBe(409);

    // Appended IDs advance the allocator past every written record.
    const next = await mintRuntimeStoreId({
      client,
      auth: () => owner.accessToken,
      headers: team(),
      path: { storeId: handle.storeId },
      body: writer,
    });
    expect(next.data!.id).toBeGreaterThan(ids[1]);

    const all = await readCommits(handle.storeId, {});
    expect(all.status).toBe(200);
    expect(all.header).toEqual({ headSeq: 2, count: 2 });
    expect(all.commits).toEqual([
      expect.objectContaining({
        seq: 1,
        commitId: first.commitId,
        writes: first.writes,
      }),
      expect.objectContaining({
        seq: 2,
        commitId: second.commitId,
        writes: second.writes,
      }),
    ]);

    expect(all.commits![0].sha256).toMatch(/^[0-9a-f]{64}$/);

    const page = await readCommits(handle.storeId, { afterSeq: 1, limit: 1 });
    expect(page.header).toEqual({ headSeq: 2, count: 1 });
    expect(page.commits!.map((commit) => commit.seq)).toEqual([2]);

    const after = await getRuntimeStoreForAttempt({
      client,
      auth: () => owner.accessToken,
      headers: team(),
      query: attemptQuery,
    });
    expect(after.data).toEqual({
      storeId: handle.storeId,
      format: 'pi-durable.v1',
      headSeq: 2,
    });
  });

  it('holds one writer lease until it is released', async () => {
    const authority = await claim();
    const handle = await open(authority);
    const writer = { ...authority, writerToken: handle.writerToken };

    const contended = await openRuntimeStore({
      client,
      auth: () => owner.accessToken,
      headers: team(),
      body: authority,
    });
    expect(contended.response?.status).toBe(409);

    const renewed = await renewRuntimeStore({
      client,
      auth: () => owner.accessToken,
      headers: team(),
      path: { storeId: handle.storeId },
      body: writer,
    });
    expect(renewed.error).toBeUndefined();
    expect(renewed.data!.writerToken).toBe(handle.writerToken);
    expect(Date.parse(renewed.data!.writerExpiresAt)).toBeGreaterThanOrEqual(
      Date.parse(handle.writerExpiresAt),
    );

    const released = await releaseRuntimeStore({
      client,
      auth: () => owner.accessToken,
      headers: team(),
      path: { storeId: handle.storeId },
      body: writer,
    });
    expect(released.response?.status).toBe(204);

    const staleWriter = await append(handle.storeId, writer, {
      commitId: randomUUID(),
      expectedSeq: 0,
      writes: [],
    });
    expect(staleWriter.response?.status).toBe(409);

    // Reopening the same attempt reattaches its store under a new token.
    const reopened = await open(authority);
    expect(reopened.storeId).toBe(handle.storeId);
    expect(reopened.writerToken).not.toBe(handle.writerToken);
  });

  it('rejects writers without the attempt lease and executor', async () => {
    const authority = await claim();
    for (const forged of [
      { ...authority, leaseId: randomUUID() },
      { ...authority, executorFingerprint: 'bafyreiforged-executor' },
    ]) {
      const opened = await openRuntimeStore({
        client,
        auth: () => owner.accessToken,
        headers: team(),
        body: forged,
      });
      expect(opened.response?.status).toBe(409);
    }
  });

  it('hides stores from agents outside the team', async () => {
    const authority = await claim();
    const handle = await open(authority);

    const read = await readCommits(handle.storeId, {}, outsider.accessToken);
    expect([403, 404]).toContain(read.status);

    const lookup = await getRuntimeStoreForAttempt({
      client,
      auth: () => outsider.accessToken,
      headers: team(),
      query: { taskId: authority.taskId, attemptN: authority.attemptN },
    });
    expect([403, 404]).toContain(lookup.response?.status);

    const opened = await openRuntimeStore({
      client,
      auth: () => outsider.accessToken,
      headers: team(),
      body: authority,
    });
    expect([403, 404]).toContain(opened.response?.status);
  });
});
