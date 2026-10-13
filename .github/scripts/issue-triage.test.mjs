import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  buildSpec,
  buildClassifierSpec,
  parseClassification,
  parseVerdict,
  renderComment,
  CRITERIA,
} from './issue-triage.mjs';

const issue = {
  number: 42,
  state: 'open',
  title: 'Add task status',
  body: 'Done when: status appears. Context: apps/console/src/. No dependencies.',
  labels: [{ name: 'needs-spec' }],
};

test('builds a bounded task from an eligible issue', () => {
  const spec = buildSpec(issue, 'getlarge/themoltnet', false);
  assert.equal(spec.taskType, 'freeform');
  assert.equal(
    spec.input.outputContract.schema.properties.criteria.minItems,
    5,
  );
  assert.deepEqual(
    spec.input.outputContract.schema.properties.criteria.items.required,
    ['id', 'passed', 'reason', 'evidence'],
  );
  assert.match(spec.input.brief, /apps\/console\/src/);
  assert.equal(
    buildSpec({ ...issue, state: 'closed' }, 'getlarge/themoltnet', false),
    null,
  );
  assert.equal(
    buildSpec({ ...issue, labels: [] }, 'getlarge/themoltnet', true),
    null,
  );
});

test('rejects missing and duplicate criterion results before writing', () => {
  const criteria = CRITERIA.map((id) => ({
    id,
    passed: true,
    reason: 'Present',
    evidence: ['Done when: status appears.'],
  }));
  assert.equal(parseVerdict({ result: { criteria } }, issue).length, 5);
  assert.throws(() =>
    parseVerdict({ result: { criteria: criteria.slice(1) } }, issue),
  );
  assert.throws(() =>
    parseVerdict(
      { result: { criteria: [...criteria.slice(1), criteria[1]] } },
      issue,
    ),
  );
  assert.throws(() =>
    parseVerdict(
      {
        result: {
          criteria: [{ ...criteria[0], passed: 'yes' }, ...criteria.slice(1)],
        },
      },
      issue,
    ),
  );
  assert.throws(() =>
    parseVerdict(
      {
        result: {
          criteria: [
            { ...criteria[0], evidence: ['invented path'] },
            ...criteria.slice(1),
          ],
        },
      },
      issue,
    ),
  );
});

test('chains validated extraction into a standalone classifier task', () => {
  const criteria = CRITERIA.map((id) => ({
    id,
    passed: true,
    reason: 'Present',
    evidence: ['Done when: status appears.'],
  }));
  const spec = buildClassifierSpec(
    issue,
    'getlarge/themoltnet',
    'correlation',
    criteria,
  );
  assert.equal(spec.taskType, 'classify');
  assert.equal(spec.correlationId, 'correlation');
  assert.deepEqual(spec.input.state.evidence['context-files'], [
    'Done when: status appears.',
  ]);
  assert.deepEqual(Object.keys(spec.input.questions), [
    'category',
    ...CRITERIA,
  ]);
  assert.equal(spec.input.questions['scoped-effort'].type, 'bool');
});

test('validates all classifier answers before publishing', () => {
  const answers = {
    category: {
      type: 'choice',
      choice: 'feature',
      probabilities: { bug: 0.1, feature: 0.8, question: 0.05, other: 0.05 },
      confidence: 0.8,
    },
    ...Object.fromEntries(
      CRITERIA.map((id) => [id, { type: 'bool', probability: 0.75 }]),
    ),
  };
  const output = {
    version: 1,
    provider: 'typesafe',
    model: 'jev-latest',
    answers,
  };
  assert.equal(parseClassification(output).category, 'feature');
  assert.throws(() =>
    parseClassification({
      ...output,
      answers: { ...answers, extra: answers['scoped-effort'] },
    }),
  );
  assert.throws(() =>
    parseClassification({
      ...output,
      answers: {
        ...answers,
        category: {
          ...answers.category,
          probabilities: { ...answers.category.probabilities, feature: 0.7 },
        },
      },
    }),
  );
  assert.throws(() =>
    parseClassification({
      ...output,
      answers: { ...answers, dependencies: { type: 'bool', probability: 2 } },
    }),
  );
});

test('renders the verdict and per-criterion reasons', () => {
  const criteria = CRITERIA.map((id) => ({
    id,
    passed: true,
    reason: 'Present',
    evidence: [],
  }));
  assert.match(renderComment(criteria), /Ready for agent pickup/);
  assert.match(
    renderComment([{ ...criteria[0], passed: false }, ...criteria.slice(1)]),
    /needs more detail/,
  );
  assert.match(
    renderComment([
      { ...criteria[0], reason: '<b>@user</b>' },
      ...criteria.slice(1),
    ]),
    /&lt;b>&#64;user&lt;\/b>/,
  );
  assert.match(
    renderComment(criteria, {
      category: 'feature',
      probabilities: { feature: 0.8 },
      readiness: Object.fromEntries(CRITERIA.map((id) => [id, 0.7])),
    }),
    /does not set labels/,
  );
});

test('prepares the next task from the accepted attempt and preserves labels if classification is unavailable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'issue-triage-chain-'));
  const snapshot = {
    ...issue,
    updatedAt: '2026-10-13T10:00:00Z',
    correlationId: 'same-correlation',
  };
  const criteria = CRITERIA.map((id) => ({
    id,
    passed: true,
    reason: 'Present',
    evidence: ['Done when: status appears.'],
  }));
  const snapshotPath = join(dir, 'snapshot.json');
  const extractionPath = join(dir, 'extraction.json');
  const outputPath = join(dir, 'output');
  const callsPath = join(dir, 'gh-calls');
  writeFileSync(snapshotPath, JSON.stringify(snapshot));
  writeFileSync(extractionPath, JSON.stringify({ result: { criteria } }));
  writeFileSync(outputPath, '');
  writeFileSync(callsPath, '');
  writeFileSync(join(dir, 'npx'), '#!/bin/sh\ncat "$EXTRACTION_FIXTURE"\n', {
    mode: 0o755,
  });
  writeFileSync(
    join(dir, 'gh'),
    '#!/bin/sh\nprintf "%s\\n" "$*" >> "$GH_CALLS"\nif [ "$3" = GET ]; then printf "%s" "$ISSUE_FIXTURE"; fi\n',
    { mode: 0o755 },
  );
  const env = {
    ...process.env,
    PATH: `${dir}:${process.env.PATH}`,
    SNAPSHOT: snapshotPath,
    EXTRACTION_TASK_ID: 'extract-task',
    CLASSIFIER_TASK_ID: 'classifier-task',
    EXTRACTION_FIXTURE: extractionPath,
    GH_CALLS: callsPath,
    ISSUE_FIXTURE: JSON.stringify({
      ...issue,
      updated_at: snapshot.updatedAt,
    }),
    GITHUB_REPOSITORY: 'getlarge/themoltnet',
    GITHUB_OUTPUT: outputPath,
    RUNNER_TEMP: dir,
    MOLTNET_TEAM_ID: 'team-id',
  };
  const run = (mode) =>
    spawnSync('node', ['.github/scripts/issue-triage.mjs', mode], {
      env,
      encoding: 'utf8',
    });
  const prepared = run('prepare-classifier');
  assert.equal(prepared.status, 0, prepared.stderr);
  const spec = JSON.parse(
    readFileSync(join(dir, 'issue-triage-classifier-spec.json'), 'utf8'),
  );
  assert.equal(spec.correlationId, snapshot.correlationId);
  assert.equal(spec.taskType, 'classify');

  // The fake classifier returns the extraction shape, which must be rejected.
  const published = run('publish');
  assert.equal(published.status, 0, published.stderr);
  assert.match(published.stderr, /Classifier pilot result unavailable/);
  const calls = readFileSync(callsPath, 'utf8');
  assert.match(calls, /POST repos\/getlarge\/themoltnet\/issues\/42\/labels/);
  assert.match(calls, /POST repos\/getlarge\/themoltnet\/issues\/42\/comments/);
});
