import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

import { connect } from '@themoltnet/sdk/node';
import { createSdkTaskClient } from '@themoltnet/tasks-orchestrator';

import { env, required } from './config.js';
import { runAdaptiveReview, type RunOptions } from './workflow.js';

interface Prepared {
  repo: string;
  pr: number;
  title: string;
  body: string;
  base: string;
  head: string;
  correlationId: string;
}

async function main() {
  const prepared = JSON.parse(
    readFileSync(required('ADAPTIVE_PREPARED'), 'utf8'),
  ) as Prepared;
  const mode = required('ADAPTIVE_MODE');
  if (mode !== 'shadow' && mode !== 'active')
    throw new Error('ADAPTIVE_MODE must be shadow or active');
  const current = JSON.parse(
    execFileSync(
      'gh',
      [
        'pr',
        'view',
        String(prepared.pr),
        '--repo',
        prepared.repo,
        '--json',
        'headRefOid,baseRefOid',
      ],
      { encoding: 'utf8' },
    ),
  ) as { headRefOid: string; baseRefOid: string };
  if (
    current.headRefOid !== prepared.head ||
    current.baseRefOid !== prepared.base
  ) {
    throw new Error('PR revisions changed after preparation');
  }
  const agent = await connect();
  const teamId = required('MOLTNET_TEAM_ID');
  const { items } = await agent.runtimeProfiles.list({ teamId });
  const resolve = (name: string): string => {
    const profile = items.find(
      (item) => item.id === name || item.name === name,
    );
    if (!profile) throw new Error(`runtime profile ${name} not found`);
    return profile.id;
  };
  const options: RunOptions = {
    identity: {
      ...prepared,
      teamId,
      diaryId: required('MOLTNET_DIARY_ID'),
      classifierProfileId: resolve(required('ADAPTIVE_CLASSIFIER_PROFILE')),
    },
    mode,
    tasks: createSdkTaskClient(agent),
    cwd: process.cwd(),
    profiles: {
      docs: resolve(required('ADAPTIVE_DOCS_PROFILE')),
      complexity: resolve(required('ADAPTIVE_COMPLEXITY_PROFILE')),
      security: resolve(required('ADAPTIVE_SECURITY_PROFILE')),
      focused: resolve(required('ADAPTIVE_FOCUSED_PROFILE')),
    },
    projectId: env().MOLTNET_PROJECT_ID || undefined,
  };
  const report = await runAdaptiveReview(options);
  writeFileSync(
    required('ADAPTIVE_REPORT'),
    `${JSON.stringify(report, null, 2)}\n`,
    { mode: 0o600 },
  );
  process.stdout.write(
    `Adaptive review finished: ${report.results.map((result) => `${result.lane}=${result.status}`).join(', ')}\n`,
  );
  if (report.results.some((result) => result.status === 'failed'))
    process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
