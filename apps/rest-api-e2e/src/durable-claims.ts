import { randomUUID } from 'node:crypto';

import {
  claimTask,
  type Client,
  createRuntimeProfile,
  createTask,
  registerExecutorManifest,
} from '@moltnet/api-client';
import {
  buildExecutorRegistrationAttestationPayload,
  computeExecutorManifestCid,
  signExecutorAttestation,
} from '@moltnet/crypto-service';
import { expect } from 'vitest';

import type { TestAgent } from './helpers.js';

function required<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`Missing ${what}`);
  return value;
}

export interface PinnedClaim {
  taskId: string;
  attemptN: number;
  leaseId: string;
  executorFingerprint: string;
}

/**
 * Claims a task under a runtime profile with a registered executor. Only a
 * pinned claim carries the lease that Durable runtime stores authorize.
 */
export async function claimPinnedAttempt(
  client: Client,
  agent: TestAgent,
  label: string,
): Promise<PinnedClaim> {
  const headers = { 'x-moltnet-team-id': agent.personalTeamId };
  const created = await createRuntimeProfile({
    client,
    auth: () => agent.accessToken,
    headers,
    body: {
      name: `${label}-${randomUUID()}`,
      models: {
        generation: { provider: 'anthropic', model: 'claude-sonnet-4-5' },
      },
      sandbox: {
        hostExec: { autoApprove: false },
        resources: { cpus: 2, memory: '2G' },
      },
    },
  });
  expect(created.error).toBeUndefined();
  const profile = required(created.data, 'runtime profile');

  const createdTask = await createTask({
    client,
    auth: () => agent.accessToken,
    headers,
    body: {
      taskType: 'fulfill_brief',
      title: label,
      diaryId: agent.privateDiaryId,
      allowedProfiles: [{ profileId: profile.id }],
      input: { brief: label },
    },
  });
  expect(createdTask.error).toBeUndefined();
  const task = required(createdTask.data, 'task');

  const manifest = {
    schemaVersion: 'moltnet:executor-manifest:v1',
    runtime: {
      kind: profile.runtimeKind,
      engine: 'pi',
      sandbox: 'gondolin',
      id: `${label}-e2e`,
      version: '1',
    },
    profile: { id: profile.id, definitionCid: profile.definitionCid },
    vm: {
      templateId: `${label}-e2e`,
      templateVersion: '1',
      templateFingerprint: 'bafyreie2e-template',
      guestAssetBuildId: `${label}-e2e`,
    },
    tools: [],
    extensions: [],
    executables: [],
  };
  const executorFingerprint = computeExecutorManifestCid(manifest);
  const registration = await registerExecutorManifest({
    client,
    auth: () => agent.accessToken,
    body: {
      executorManifest: manifest,
      executorFingerprint,
      executorSignature: await signExecutorAttestation(
        buildExecutorRegistrationAttestationPayload({ executorFingerprint }),
        agent.keyPair.privateKey,
      ),
    },
  });
  expect(registration.error).toBeUndefined();

  const claim = await claimTask({
    client,
    auth: () => agent.accessToken,
    headers,
    path: { id: task.id },
    body: { leaseTtlSec: 120, profileId: profile.id, executorFingerprint },
  });
  expect(claim.error).toBeUndefined();
  const { attemptN, leaseId } = required(claim.data, 'claim').attempt;
  return {
    taskId: task.id,
    attemptN,
    leaseId: required(leaseId, 'claim lease'),
    executorFingerprint,
  };
}
