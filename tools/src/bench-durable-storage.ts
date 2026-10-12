/** Local E2E benchmark: native Pi streaming through the real Durable HTTP API. */
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from '@earendil-works/pi-ai';
import { createE2EAgentHarness } from '@moltnet/bootstrap';
import {
  buildExecutorRegistrationAttestationPayload,
  computeExecutorManifestCid,
  signExecutorAttestation,
} from '@moltnet/crypto-service';
import {
  ApiTaskSource,
  type ClaimedTask,
  type TaskReporter,
} from '@themoltnet/agent-runtime';
import {
  acquireDurableTransport,
  ApiDurableStorage,
  createDurableTaskExecutor,
  type DurableStoreTransport,
} from '@themoltnet/pi-runtime';
import { connect } from '@themoltnet/sdk';

import { benchmarkDistribution } from './benchmark-stats.js';

const { values } = parseArgs({
  options: {
    concurrency: { type: 'string', default: '1,5,10' },
    characters: { type: 'string', default: '1024' },
    'tokens-per-second': { type: 'string', default: '80' },
    output: { type: 'string', default: '/tmp/durable-storage-benchmark.json' },
  },
});
const positive = (value: string, max: number) => {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1 || n > max)
    throw new Error(`Expected integer 1..${max}, got ${value}`);
  return n;
};
const concurrency = values.concurrency.split(',').map((v) => positive(v, 100));
const characters = positive(values.characters, 100_000);
const tokensPerSecond = positive(values['tokens-per-second'], 10_000);
// This command provisions disposable identities and tasks. Restrict every service
// to loopback so running a benchmark cannot accidentally target a deployed API.
for (const key of [
  'REST_API_URL',
  'DATABASE_URL',
  'ORY_HYDRA_PUBLIC_URL',
  'ORY_HYDRA_ADMIN_URL',
  'ORY_KETO_PUBLIC_URL',
  'ORY_KETO_ADMIN_URL',
  'ORY_KRATOS_ADMIN_URL',
]) {
  const value = process.env[key];
  if (
    value &&
    !['localhost', '127.0.0.1', '[::1]'].includes(new URL(value).hostname)
  )
    throw new Error(`${key} must target a local E2E service`);
}
const harness = await createE2EAgentHarness({
  restApiUrl: process.env.REST_API_URL,
  databaseUrl: process.env.DATABASE_URL,
  hydraPublicUrl: process.env.ORY_HYDRA_PUBLIC_URL,
  hydraAdminUrl: process.env.ORY_HYDRA_ADMIN_URL,
  ketoReadUrl: process.env.ORY_KETO_PUBLIC_URL,
  ketoWriteUrl: process.env.ORY_KETO_ADMIN_URL,
  kratosAdminUrl: process.env.ORY_KRATOS_ADMIN_URL,
});
const results: unknown[] = [];
try {
  const creds = await harness.createAgent('durable-load');
  const agent = await connect({
    apiUrl: harness.restApiUrl,
    clientId: creds.clientId,
    clientSecret: creds.clientSecret,
  });
  const scope = { teamId: creds.personalTeamId };
  const profile = await agent.runtimeProfiles.create(
    {
      name: `durable-load-${randomUUID()}`,
      runtimeKind: 'gondolin_pi',
      models: { generation: { provider: 'faux', model: 'faux-model' } },
      defaultWorkspaceMode: 'none',
      allowedWorkspaceModes: ['none'],
      requiredEnv: [],
      requiredTools: [],
      sandbox: {},
    },
    scope,
  );
  const resolved = profile;
  const executorManifest = {
    schemaVersion: 'moltnet:executor-manifest:v1',
    runtime: {
      kind: resolved.runtimeKind,
      engine: 'pi',
      sandbox: 'gondolin',
      id: 'durable-load',
      version: '1',
    },
    profile: { id: resolved.id, definitionCid: resolved.definitionCid },
    vm: {
      templateId: 'durable-load',
      templateVersion: '1',
      templateFingerprint: 'bafyreidurableload',
      guestAssetBuildId: 'durable-load',
    },
    tools: [],
    extensions: [],
    executables: [],
  };
  const executorFingerprint = computeExecutorManifestCid(executorManifest);
  const executorSignature = await signExecutorAttestation(
    buildExecutorRegistrationAttestationPayload({ executorFingerprint }),
    creds.keyPair.privateKey,
  );
  await agent.tasks.registerExecutorManifest({
    executorManifest,
    executorFingerprint,
    executorSignature,
  });
  try {
    for (const count of concurrency) {
      const tasks: ClaimedTask[] = [];
      const created: string[] = [];
      const samples: Record<string, number[]> = {};
      let payloadBytes = 0;
      let commits = 0;
      let failed = 0;
      let phase = 'execute';
      const record = (name: string, ms: number) =>
        (samples[`${phase}.${name}`] ??= []).push(ms);
      const timed = async <T>(
        name: string,
        fn: () => Promise<T>,
      ): Promise<T> => {
        const start = performance.now();
        try {
          return await fn();
        } finally {
          record(name, performance.now() - start);
        }
      };
      const observe = (
        transport: DurableStoreTransport,
      ): DurableStoreTransport => ({
        ...transport,
        append: (input, ctx) =>
          timed('append', async () => {
            const result = await transport.append(input, ctx);
            commits++;
            payloadBytes += Buffer.byteLength(
              JSON.stringify({ format: 'pi-durable.v1', writes: input.writes }),
            );
            return result;
          }),
        mintId: () => timed('mintId', () => transport.mintId()),
        read: (after, ctx) =>
          timed('readHeaders', async () => {
            const page = await transport.read(after, ctx);
            return {
              headSeq: page.headSeq,
              items: (async function* () {
                const start = performance.now();
                try {
                  for await (const commit of page.items) yield commit;
                } finally {
                  record('readBody', performance.now() - start);
                }
              })(),
            };
          }),
      });
      try {
        for (let i = 0; i < count; i++) {
          const task = await agent.tasks.create(
            {
              taskType: 'freeform',
              title: 'Durable load measurement',
              diaryId: creds.privateDiaryId,
              input: { brief: 'Stream the fixture and submit the result.' },
              allowedProfiles: [{ profileId: profile.id }],
            },
            scope,
          );
          created.push(task.id);
          const claimed = await new ApiTaskSource({
            agent,
            taskId: task.id,
            teamId: scope.teamId,
            profileId: profile.id,
            executorFingerprint,
          }).claim();
          if (!claimed) throw new Error('Benchmark task was not claimed');
          tasks.push(claimed);
        }
        const heapBefore = process.memoryUsage().heapUsed;
        const start = performance.now();
        const outcomes = await Promise.allSettled(
          tasks.map(async (claimed) => {
            const faux = fauxProvider({
              tokensPerSecond,
              tokenSize: { min: 4, max: 4 },
            });
            faux.setResponses([
              fauxAssistantMessage(
                [
                  fauxText('x'.repeat(characters)),
                  fauxToolCall('submit_freeform_output', { summary: 'Done' }),
                ],
                { stopReason: 'toolUse' },
              ),
            ]);
            const models = createModels();
            models.setProvider(faux.provider);
            const execute = createDurableTaskExecutor({
              models,
              model: { provider: faux.provider.id, modelId: faux.models[0].id },
              open: async (task, signal) => {
                const connection = await acquireDurableTransport({
                  stores: agent.runtimeSessions,
                  claimed: task,
                  signal,
                });
                const storage = await timed('openReplay', () =>
                  ApiDurableStorage.open(
                    observe(connection.transport),
                    BACKGROUND_CONTEXT,
                  ),
                );
                return {
                  ...connection,
                  storage,
                  prepare: async () => ({
                    authorizeTool: async () => 'blocked',
                    close: async () => {},
                  }),
                };
              },
            });
            // Deliberately excludes task-message/reporting traffic and VM work.
            const reporter: TaskReporter = {
              open: async () => {},
              record: async () => {},
              finalize: async () => {},
              close: async () => {},
              cancelSignal: AbortSignal.timeout(120_000),
              cancelReason: null,
            };
            const result = await execute(claimed, reporter);
            if (result.status !== 'completed')
              throw new Error(`Execution ${result.status}`);
          }),
        );
        const elapsedMs = performance.now() - start;
        failed = outcomes.filter((r) => r.status === 'rejected').length;
        for (const outcome of outcomes)
          if (outcome.status === 'rejected')
            process.stderr.write(`${String(outcome.reason)}\n`);
        const heapAfterExecution = process.memoryUsage().heapUsed;
        phase = 'replay';
        const replayed = await Promise.allSettled(
          tasks.map(async (claimed) => {
            const connection = await acquireDurableTransport({
              stores: agent.runtimeSessions,
              claimed,
              signal: AbortSignal.timeout(120_000),
            });
            const storage = await timed('openReplay', () =>
              ApiDurableStorage.open(
                observe(connection.transport),
                BACKGROUND_CONTEXT,
              ),
            );
            await storage.close(BACKGROUND_CONTEXT);
          }),
        );
        const replayFailures = replayed.filter(
          (r) => r.status === 'rejected',
        ).length;
        const report = {
          concurrency: count,
          characters,
          tokensPerSecond,
          elapsedMs,
          commits,
          payloadBytes,
          commitsPerSecond: commits / (elapsedMs / 1_000),
          payloadBytesPerSecond: payloadBytes / (elapsedMs / 1_000),
          failed,
          replayFailures,
          heapBefore,
          heapAfterExecution,
          heapAfterReplay: process.memoryUsage().heapUsed,
          latencyMs: Object.fromEntries(
            Object.entries(samples).map(([k, v]) => [
              k,
              benchmarkDistribution(v),
            ]),
          ),
        };
        results.push(report);
        process.stderr.write(`${JSON.stringify(report)}\n`);
        if (failed || replayFailures) process.exitCode = 1;
      } finally {
        await Promise.all(
          created.map((id) =>
            agent.tasks.cancel(
              id,
              { reason: 'Durable benchmark cleanup' },
              scope,
            ),
          ),
        );
      }
    }
  } finally {
    await agent.runtimeProfiles.delete(profile.id);
  }
} finally {
  await harness.teardown();
  await writeFile(
    values.output,
    JSON.stringify(
      {
        version: 1,
        generatedAt: new Date().toISOString(),
        apiUrl: harness.restApiUrl,
        scope:
          'Native Pi generation and remote store; excludes VM and task reporter. Latencies are end-to-end logical operations including retries. Heap is process-wide without forced GC. Not a production capacity estimate.',
        results,
      },
      null,
      2,
    ) + '\n',
  );
}
