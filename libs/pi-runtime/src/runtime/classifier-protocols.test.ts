import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it, vi } from 'vitest';

import { PI_CLASSIFIER_APIS, writePiConfig } from '../pi-config.js';
import { createRuntimeModels } from './model-runtime.js';

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

it.each(PI_CLASSIFIER_APIS)(
  'executes %s through its actual Pi transport',
  async (api) => {
    const piDir = mkdtempSync(join(tmpdir(), 'classifier-transport-'));
    dirs.push(piDir);
    vi.stubEnv('PROTOCOL_TEST_KEY', 'test-transport-key');
    writePiConfig({
      piDir,
      providers: {
        team: {
          api: 'openai-completions',
          baseUrl: 'https://protocol.example/v1',
          apiKeyEnvRef: '$PROTOCOL_TEST_KEY',
          models: [{ id: 'chat' }, { id: 'labels', type: 'classifier', api }],
        },
      },
    });
    const fetch = vi.fn<typeof globalThis.fetch>((url, init) => {
      expect(new Headers(init?.headers).get('authorization')).toBe(
        'Bearer test-transport-key',
      );
      if (
        !(typeof url === 'string' || url instanceof URL) ||
        typeof init?.body !== 'string'
      )
        throw new Error('Expected a JSON request URL and body');
      const respond = (body: unknown) => Promise.resolve(Response.json(body));
      const payload = JSON.parse(init.body) as {
        content?: string;
        model: string;
      };
      expect(payload.model).toBe('labels');
      const path = new URL(url).pathname;
      if (path === '/tokenize') {
        const content = payload.content ?? '';
        return respond({
          tokens: content === '\n' ? [0] : [0, content.endsWith('Yes') ? 1 : 2],
        });
      }
      if (path === '/apply-template') return respond({ prompt: 'question\n' });
      if (path === '/completion')
        return respond({
          completion_probabilities: [
            {
              top_logprobs: [
                { id: 1, logprob: Math.log(0.8) },
                { id: 2, logprob: Math.log(0.2) },
              ],
            },
          ],
        });
      const result = { answers: { actionable: { type: 'noul', noul: 0.8 } } };
      if (api === 'cloudflare-workers-ai-system-one') {
        expect(path).toBe('/v1/run');
        expect(payload).toHaveProperty(
          'input.questions.actionable.type',
          'noul',
        );
        return respond({
          success: true,
          result: { state: 'Completed', result },
        });
      }
      expect(path).toBe('/v1/systemone');
      expect(payload).toHaveProperty('questions.actionable.type', 'noul');
      return respond(result);
    });
    const models = await createRuntimeModels(piDir);
    const model = models.getModelOfType('classifier', 'team', 'labels');
    if (!model) throw new Error('Missing classifier');
    const result = await models.classify(
      model,
      {
        state: { issue: 'reproducible' },
        questions: {
          actionable: {
            type: 'bool',
            instructions: 'Is it actionable?',
            criteria: { true: 'reproducible', false: 'unclear' },
          },
        },
      },
      { fetch, maxRetries: 0 },
    );
    expect(result.errorMessage).toBeUndefined();
    expect(result.stopReason).toBe('stop');
    expect(result.answers.actionable).toMatchObject({
      type: 'bool',
      probability: 0.8,
    });
    expect(fetch).toHaveBeenCalled();
    expect(models.getModel('team', 'chat')).toBeDefined();
  },
);
