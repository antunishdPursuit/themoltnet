import { createHash, randomUUID } from 'node:crypto';
import { addAbortSignal, Readable } from 'node:stream';

import type { PermissionChecker } from '@moltnet/auth';
import type {
  RuntimeStore,
  RuntimeStoreAuthority,
  RuntimeStoreRepository,
  TransactionRunner,
} from '@moltnet/database';
import type {
  AppendRuntimeStoreCommit,
  RuntimeStoreCommit,
  RuntimeStoreHandle,
  RuntimeStoreWriter,
} from '@moltnet/runtime-profiles';

import { createProblem } from './problems.js';
import {
  prefetchInOrder,
  READ_EXPANSION,
  ReadAheadBudget,
} from './read-ahead.js';
import type { RuntimeSessionStorage } from './runtime-session-storage.js';
import type { RuntimeSessionSubject } from './runtime-sessions.js';

const FORMAT = 'pi-durable.v1' as const;
const WRITER_TTL_MS = 30_000;
type Subject = RuntimeSessionSubject & { teamId: string };
type Authority = Subject & Omit<RuntimeStoreAuthority, 'agentId'>;
type Writer = Authority & RuntimeStoreWriter & { storeId: string };

/** Deployment tuning for Durable commit reads (rest-api configuration). */
export interface RuntimeStoreReadOptions {
  /** Read concurrency for conversation routes; 1 disables read-ahead. */
  conversationReadConcurrency?: number;
  readAheadBytes?: number;
  readAheadRequests?: number;
  objectReadTimeoutMs?: number;
}

export function createRuntimeStoreService(deps: {
  repository: RuntimeStoreRepository;
  transactionRunner: TransactionRunner;
  storage: RuntimeSessionStorage;
  permissionChecker: PermissionChecker;
  maxBytes: number;
  /**
   * Object fetches in flight per read page; a positive integer (default 1:
   * sequential, no read-ahead). Fetches beyond each read's next commit are
   * also limited by `readAheadBytes`.
   */
  readConcurrency?: number;
  /**
   * Bytes all reads of this service instance may hold in read-ahead at once
   * (default 16 MiB). Only fetches beyond each read's next commit count
   * against it; that next commit is outside the budget, so the floor is one
   * commit (up to maxBytes, expanded) per concurrent read. Each instance has
   * its own budget: the process bound is the sum over instances that opt in
   * to concurrency (today only the conversation routes).
   */
  readAheadBytes?: number;
  /**
   * Read-ahead object requests all reads of this service may have in flight
   * (default 16). With each read's next commit outside the budget, the
   * service's GETs stay below concurrent reads + this, so cold reads cannot
   * exhaust the object-store client's shared socket pool.
   */
  readAheadRequests?: number;
  /** Abort one object read that takes longer than this (default 30 s). */
  objectReadTimeoutMs?: number;
  now?: () => number;
}) {
  const repo = deps.repository;
  const readConcurrency = deps.readConcurrency ?? 1;
  if (!Number.isSafeInteger(readConcurrency) || readConcurrency < 1)
    throw new RangeError('readConcurrency must be a positive integer');
  const readAhead = new ReadAheadBudget(
    deps.readAheadBytes ?? 16 * 1024 * 1024,
    deps.readAheadRequests ?? 16,
  );
  const objectReadTimeoutMs = deps.objectReadTimeoutMs ?? 30_000;
  if (!Number.isSafeInteger(objectReadTimeoutMs) || objectReadTimeoutMs < 1)
    throw new RangeError('objectReadTimeoutMs must be a positive integer');
  // Memory a read-ahead commit is expected to occupy, from its recorded size.
  const readCost = (row: CommitRow) =>
    Math.min(row.sizeBytes, deps.maxBytes) * READ_EXPANSION;
  const now = deps.now ?? Date.now;
  // Cache provenance, never authorization. Commit history is append-only, so a
  // captured head identifies its contributors even if another writer advances.
  const contributors = new Map<
    string,
    { headSeq: number; taskIds: string[] }
  >();
  async function commitTaskIds(store: RuntimeStore) {
    const cached = contributors.get(store.id);
    if (cached?.headSeq === store.headSeq) return cached.taskIds;
    const taskIds = await repo.listCommitTaskIds(store.id);
    // The query can include newer commits: this is a conservative superset for
    // the captured head. Never label it with a head observed after the query.
    contributors.delete(store.id);
    // Bound both entry count and retained IDs; large histories remain readable.
    if (taskIds.length <= 1024) {
      contributors.set(store.id, { headSeq: store.headSeq, taskIds });
      const oldest = contributors.keys().next().value;
      if (contributors.size > 128 && oldest !== undefined)
        contributors.delete(oldest);
    }
    return taskIds;
  }
  async function team(input: Subject) {
    if (
      !(await deps.permissionChecker.canAccessTeam(
        input.teamId,
        input.subjectId,
        input.subjectNs,
      ))
    )
      throw createProblem('not-found');
  }
  async function authority(input: Authority) {
    const binding = await repo.lockAuthority({
      ...input,
      agentId: input.subjectId,
    });
    if (!binding)
      throw createProblem('conflict', 'Attempt authority is no longer active');
    return binding;
  }
  async function reader(
    input: Subject,
    storeId: string,
    commitTaskIds: string[],
  ) {
    const bindings = await repo.listAttempts(input.teamId, storeId);
    if (bindings.length === 0) throw createProblem('not-found');
    // Forks copy commits, not attempt bindings. Retain authorization for every
    // task whose content can be present in a replayed reader, even on empty pages.
    const taskIds = [
      ...new Set([
        ...bindings.map((binding) => binding.taskId),
        ...commitTaskIds,
      ]),
    ];
    const permissions = await deps.permissionChecker.canViewTasks(
      taskIds,
      input.subjectId,
      input.subjectNs,
    );
    if (taskIds.some((taskId) => permissions.get(taskId) !== true))
      throw createProblem('not-found');
  }
  async function writer(input: Writer) {
    await authority(input);
    const store = await repo.lock(input.teamId, input.storeId);
    if (
      !store ||
      store.format !== FORMAT ||
      store.writerToken !== input.writerToken ||
      store.writerAgentId !== input.subjectId ||
      store.writerTaskId !== input.taskId ||
      store.writerAttemptN !== input.attemptN ||
      !store.writerExpiresAt ||
      store.writerExpiresAt.getTime() <= now()
    ) {
      throw createProblem('conflict', 'Runtime store writer is stale');
    }
    return store;
  }
  function handle(store: RuntimeStore): RuntimeStoreHandle {
    return {
      storeId: store.id,
      format: FORMAT,
      headSeq: store.headSeq,
      writerToken: store.writerToken!,
      writerExpiresAt: store.writerExpiresAt!.toISOString(),
    };
  }
  return {
    async findAttempt(input: Subject & { taskId: string; attemptN: number }) {
      await team(input);
      if (
        !(await deps.permissionChecker.canViewTask(
          input.taskId,
          input.subjectId,
          input.subjectNs,
        ))
      )
        throw createProblem('not-found');
      const binding = await repo.findAttempt(
        input.teamId,
        input.taskId,
        input.attemptN,
      );
      if (!binding) return null;
      const store = await repo.get(input.teamId, binding.storeId);
      if (!store || store.format !== FORMAT) throw createProblem('not-found');
      return { storeId: store.id, format: FORMAT, headSeq: store.headSeq };
    },
    async open(input: Authority): Promise<RuntimeStoreHandle> {
      await team(input);
      return deps.transactionRunner.runInTransaction(
        async () => {
          const binding = await authority(input);
          let attached = await repo.findAttempt(
            input.teamId,
            input.taskId,
            input.attemptN,
          );
          let store: RuntimeStore | null = null;
          if (attached) store = await repo.lock(input.teamId, attached.storeId);
          else {
            const parent = (
              binding.task.input as {
                continueFrom?: {
                  taskId: string;
                  attemptN: number;
                  mode?: 'extend' | 'fork';
                };
              }
            ).continueFrom;
            if (parent) {
              if (
                !(await deps.permissionChecker.canViewTask(
                  parent.taskId,
                  input.subjectId,
                  input.subjectNs,
                ))
              )
                throw createProblem('not-found');
              const source = await repo.findAttempt(
                input.teamId,
                parent.taskId,
                parent.attemptN,
              );
              if (!source)
                throw createProblem(
                  'conflict',
                  'Parent attempt has no Durable store',
                );
              const sourceStore = await repo.lock(input.teamId, source.storeId);
              if (!sourceStore) throw createProblem('not-found');
              await reader(
                input,
                sourceStore.id,
                await repo.listCommitTaskIds(sourceStore.id),
              );
              store =
                parent.mode === 'fork'
                  ? await repo.fork(sourceStore)
                  : sourceStore;
            } else store = await repo.create(input.teamId);
            if (!store) throw createProblem('not-found');
            attached = {
              teamId: input.teamId,
              taskId: input.taskId,
              attemptN: input.attemptN,
              storeId: store.id,
            };
            await repo.bindAttempt(attached);
          }
          if (!store || store.format !== FORMAT)
            throw createProblem('conflict', 'Unsupported runtime store format');
          if (
            store.writerToken &&
            store.writerExpiresAt &&
            store.writerExpiresAt.getTime() > now()
          )
            throw createProblem(
              'conflict',
              'Runtime store already has an active writer',
            );
          const patch = {
            writerToken: randomUUID(),
            writerAgentId: input.subjectId,
            writerTaskId: input.taskId,
            writerAttemptN: input.attemptN,
            writerExpiresAt: new Date(
              Math.min(
                now() + WRITER_TTL_MS,
                binding.task.claimExpiresAt!.getTime(),
              ),
            ),
          };
          await repo.update(store.id, patch);
          return handle({ ...store, ...patch });
        },
        { name: 'runtime.store.open' },
      );
    },
    async renew(input: Writer): Promise<RuntimeStoreHandle> {
      await team(input);
      return deps.transactionRunner.runInTransaction(
        async () => {
          const store = await writer(input);
          const binding = await authority(input);
          const writerExpiresAt = new Date(
            Math.min(
              now() + WRITER_TTL_MS,
              binding.task.claimExpiresAt!.getTime(),
            ),
          );
          await repo.update(store.id, { writerExpiresAt });
          return handle({ ...store, writerExpiresAt });
        },
        { name: 'runtime.store.renew' },
      );
    },
    async release(input: Writer): Promise<void> {
      await team(input);
      await deps.transactionRunner.runInTransaction(
        async () => {
          const store = await writer(input);
          await repo.update(store.id, {
            writerToken: null,
            writerExpiresAt: null,
          });
        },
        { name: 'runtime.store.release' },
      );
    },
    async mintId(input: Writer): Promise<number> {
      await team(input);
      return deps.transactionRunner.runInTransaction(
        async () => {
          const store = await writer(input);
          if (store.nextId >= Number.MAX_SAFE_INTEGER)
            throw createProblem('conflict', 'ID space is exhausted');
          await repo.update(store.id, { nextId: store.nextId + 1 });
          return store.nextId;
        },
        { name: 'runtime.store.mint_id' },
      );
    },
    async append(
      input: Writer & AppendRuntimeStoreCommit,
    ): Promise<{ seq: number }> {
      await team(input);
      const bytes = Buffer.from(
        JSON.stringify({ format: FORMAT, writes: input.writes }),
      );
      if (bytes.length > deps.maxBytes)
        throw createProblem(
          'validation-failed',
          'Runtime commit exceeds size limit',
        );
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const admit = async () => {
        const store = await writer(input);
        const previous = await repo.findCommit(store.id, input.commitId);
        if (previous) {
          if (
            previous.sha256 !== sha256 ||
            previous.seq !== input.expectedSeq + 1 ||
            previous.taskId !== input.taskId ||
            previous.attemptN !== input.attemptN
          )
            throw createProblem(
              'conflict',
              'Commit ID was already used for another payload',
            );
          return { store, receipt: { seq: previous.seq } };
        }
        if (store.headSeq !== input.expectedSeq)
          throw createProblem('conflict', 'Runtime store head changed');
        if (store.headSeq >= 2147483647)
          throw createProblem('conflict', 'Commit sequence exhausted');
        return { store, receipt: undefined };
      };
      // A lost acknowledgment must not require uploading an already published blob.
      const admitted = await deps.transactionRunner.runInTransaction(admit, {
        name: 'runtime.store.admit',
      });
      if (admitted.receipt) return admitted.receipt;
      const objectKey = `runtime-stores/${input.teamId}/${input.storeId}/${input.commitId}/${sha256}.json`;
      // Never delete on an ambiguous publication error: it may already be referenced.
      await deps.storage.putObject({
        key: objectKey,
        body: Readable.from([bytes]),
        contentType: 'application/json',
        contentLength: bytes.length,
      });
      return deps.transactionRunner.runInTransaction(
        async () => {
          // Uploads run outside the transaction; recheck authority and racing retries.
          const { store, receipt } = await admit();
          if (receipt) return receipt;
          const seq = store.headSeq + 1;
          await repo.append({
            storeId: store.id,
            seq,
            commitId: input.commitId,
            sha256,
            objectKey,
            sizeBytes: bytes.length,
            taskId: input.taskId,
            attemptN: input.attemptN,
          });
          let nextId = store.nextId;
          for (const write of input.writes) {
            const record = (write.value ?? write.record) as
              | { id?: unknown }
              | undefined;
            if (
              record &&
              typeof record.id === 'number' &&
              Number.isSafeInteger(record.id)
            ) {
              nextId = Math.max(
                nextId,
                Math.min(record.id + 1, Number.MAX_SAFE_INTEGER),
              );
            }
          }
          if (nextId !== store.nextId) await repo.update(store.id, { nextId });
          return { seq };
        },
        { name: 'runtime.store.append' },
      );
    },
    async read(
      input: Subject & {
        storeId: string;
        afterSeq?: number;
        limit?: number;
        throughSeq?: number;
        signal?: AbortSignal;
      },
    ) {
      input.signal?.throwIfAborted();
      await team(input);
      const store = await repo.get(input.teamId, input.storeId);
      if (!store) throw createProblem('not-found');
      const headSeq = Math.min(
        store.headSeq,
        input.throughSeq ?? store.headSeq,
      );
      const rows = await repo.listCommits(
        store.id,
        input.afterSeq ?? 0,
        Math.min(input.limit ?? 50, 100),
        headSeq,
      );
      await reader(input, input.storeId, [
        ...(await commitTaskIds(store)),
        ...rows.map((row) => row.taskId),
      ]);
      return {
        headSeq,
        count: rows.length,
        // Lazy: no object is fetched until the caller iterates, which can only
        // happen after the authorization above has passed.
        items: prefetchInOrder(
          rows,
          {
            concurrency: readConcurrency,
            budget: readAhead,
            cost: readCost,
          },
          (row, signal) =>
            readCommit(
              deps.storage,
              { maxBytes: deps.maxBytes, timeoutMs: objectReadTimeoutMs },
              row,
              signal,
            ),
          input.signal,
        ),
      };
    },
  };
}

type CommitRow = Awaited<
  ReturnType<RuntimeStoreRepository['listCommits']>
>[number];

const isProblem = (error: unknown) =>
  error instanceof Error &&
  typeof (error as { statusCode?: unknown }).statusCode === 'number';

/**
 * Read, verify and decode one commit object. Caller and sibling aborts keep
 * their identity (the prefetch relies on it); every other failure becomes a
 * 503 problem naming the commit, with the original error as `cause`.
 */
async function readCommit(
  storage: RuntimeSessionStorage,
  limits: { maxBytes: number; timeoutMs: number },
  row: CommitRow,
  signal: AbortSignal,
): Promise<RuntimeStoreCommit> {
  const deadline = AbortSignal.timeout(limits.timeoutMs);
  const readSignal = AbortSignal.any([signal, deadline]);
  try {
    const object = await storage.getObject(row.objectKey, readSignal);
    addAbortSignal(readSignal, object.body);
    // Hash while streaming; the chunks are the only copy until the decode.
    const hash = createHash('sha256');
    const chunks: Buffer[] = [];
    let size = 0;
    // Leaving the loop early (limit, abort) destroys the body stream.
    for await (const chunk of object.body) {
      const bytes = Buffer.from(chunk as Uint8Array);
      size += bytes.length;
      if (size > limits.maxBytes)
        throw createProblem(
          'service-unavailable',
          `Stored runtime commit ${row.seq} exceeds size limit`,
        );
      hash.update(bytes);
      chunks.push(bytes);
    }
    // Nothing is decoded, let alone applied, before the checksum matches.
    if (hash.digest('hex') !== row.sha256)
      throw createProblem(
        'service-unavailable',
        `Runtime commit ${row.seq} checksum mismatch`,
      );
    const payload = JSON.parse(Buffer.concat(chunks, size).toString()) as {
      format: string;
      writes: RuntimeStoreCommit['writes'];
    };
    if (payload.format !== FORMAT)
      throw createProblem(
        'conflict',
        `Unsupported runtime store format in commit ${row.seq}`,
      );
    return {
      seq: row.seq,
      commitId: row.commitId,
      sha256: row.sha256,
      writes: payload.writes,
    };
  } catch (error) {
    if (signal.aborted || isProblem(error)) throw error;
    const problem = createProblem(
      'service-unavailable',
      deadline.aborted
        ? `Reading runtime commit ${row.seq} timed out after ${limits.timeoutMs} ms`
        : `Reading runtime commit ${row.seq} failed`,
    );
    problem.cause = error;
    throw problem;
  }
}
