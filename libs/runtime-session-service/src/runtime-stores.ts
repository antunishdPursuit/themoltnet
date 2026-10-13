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
import type { RuntimeSessionStorage } from './runtime-session-storage.js';
import type { RuntimeSessionSubject } from './runtime-sessions.js';

const FORMAT = 'pi-durable.v1' as const;
const WRITER_TTL_MS = 30_000;
type Subject = RuntimeSessionSubject & { teamId: string };
type Authority = Subject & Omit<RuntimeStoreAuthority, 'agentId'>;
type Writer = Authority & RuntimeStoreWriter & { storeId: string };

export function createRuntimeStoreService(deps: {
  repository: RuntimeStoreRepository;
  transactionRunner: TransactionRunner;
  storage: RuntimeSessionStorage;
  permissionChecker: PermissionChecker;
  maxBytes: number;
  /** Object fetches in flight per read page. Buffered commit bytes stay below (readConcurrency + 1) × maxBytes. */
  readConcurrency?: number;
  now?: () => number;
}) {
  const repo = deps.repository;
  const readConcurrency = Math.max(1, deps.readConcurrency ?? 8);
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
      const rows = await repo.listCommits(
        store.id,
        input.afterSeq ?? 0,
        Math.min(input.limit ?? 50, 100),
        Math.min(store.headSeq, input.throughSeq ?? store.headSeq),
      );
      await reader(input, input.storeId, [
        ...(await commitTaskIds(store)),
        ...rows.map((row) => row.taskId),
      ]);
      async function fetchCommit(
        row: (typeof rows)[number],
        signal: AbortSignal,
      ): Promise<RuntimeStoreCommit> {
        const object = await deps.storage.getObject(row.objectKey, signal);
        addAbortSignal(signal, object.body);
        const chunks: Buffer[] = [];
        let size = 0;
        // Leaving the loop early (limit, abort) destroys the body stream.
        for await (const chunk of object.body) {
          const bytes = Buffer.from(chunk as Uint8Array);
          size += bytes.length;
          if (size > deps.maxBytes)
            throw createProblem(
              'service-unavailable',
              'Stored runtime commit exceeds size limit',
            );
          chunks.push(bytes);
        }
        const bytes = Buffer.concat(chunks);
        if (createHash('sha256').update(bytes).digest('hex') !== row.sha256)
          throw createProblem(
            'service-unavailable',
            'Runtime commit checksum mismatch',
          );
        const payload = JSON.parse(bytes.toString()) as {
          format: string;
          writes: RuntimeStoreCommit['writes'];
        };
        if (payload.format !== FORMAT)
          throw createProblem('conflict', 'Unsupported runtime store format');
        return {
          seq: row.seq,
          commitId: row.commitId,
          sha256: row.sha256,
          writes: payload.writes,
        };
      }
      // Fetches start only once the caller iterates, i.e. after authorization.
      // At most `readConcurrency` verified commits are buffered ahead of the
      // consumer; they are yielded strictly in sequence order.
      async function* items(): AsyncGenerator<RuntimeStoreCommit> {
        const stop = new AbortController();
        const signal = input.signal
          ? AbortSignal.any([input.signal, stop.signal])
          : stop.signal;
        const pending: Promise<RuntimeStoreCommit>[] = [];
        let failure: { error: unknown } | undefined;
        let next = 0;
        const fill = () => {
          while (next < rows.length && pending.length < readConcurrency) {
            const fetched = fetchCommit(rows[next++], signal);
            // The first real failure cancels siblings and is reported instead
            // of the abort errors it causes; the consumer surfaces it.
            fetched.catch((error: unknown) => {
              if (signal.aborted) return;
              failure = { error };
              stop.abort(error);
            });
            pending.push(fetched);
          }
        };
        try {
          fill();
          while (pending.length) {
            input.signal?.throwIfAborted();
            let commit: RuntimeStoreCommit;
            try {
              commit = await pending.shift()!;
            } catch (error) {
              input.signal?.throwIfAborted();
              throw failure ? failure.error : error;
            }
            fill();
            yield commit;
          }
        } finally {
          // Early return, failure or cancellation: release every open body.
          stop.abort();
          await Promise.allSettled(pending);
        }
      }
      return {
        headSeq: Math.min(store.headSeq, input.throughSeq ?? store.headSeq),
        count: rows.length,
        items: items(),
      };
    },
  };
}
