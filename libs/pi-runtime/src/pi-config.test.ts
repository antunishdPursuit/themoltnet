import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import { writePiConfig } from './pi-config.js';

it('declares strict tool support for an opted-in single-provider model', () => {
  const piDir = mkdtempSync(join(tmpdir(), 'pi-strict-config-'));
  try {
    writePiConfig({
      piDir,
      provider: 'ollama-cloud',
      model: 'glm-5.2:cloud',
      supportsStrictMode: true,
    });

    const config = JSON.parse(readFileSync(join(piDir, 'models.json'), 'utf8'));
    expect(config.providers['ollama-cloud'].compat).toEqual({
      supportsDeveloperRole: false,
    });
    expect(config.providers['ollama-cloud'].models[0].compat).toEqual({
      supportsStrictMode: true,
    });
  } finally {
    rmSync(piDir, { recursive: true, force: true });
  }
});

it('only disables the developer role for Ollama chat providers', () => {
  const piDir = mkdtempSync(join(tmpdir(), 'pi-provider-compat-'));
  try {
    writePiConfig({
      piDir,
      providers: {
        cloud: {
          api: 'openai-completions',
          baseUrl: 'https://ollama.com/v1',
          models: [{ id: 'mistral-large-4', reasoning: true }],
        },
        local: {
          api: 'openai-completions',
          baseUrl: 'http://127.0.0.1:11434/v1',
          models: [{ id: 'gpt-oss:20b', reasoning: true }],
        },
        other: {
          api: 'openai-completions',
          baseUrl: 'https://provider.example/v1',
          models: [{ id: 'reasoning-model', reasoning: true }],
        },
      },
    });

    const config = JSON.parse(readFileSync(join(piDir, 'models.json'), 'utf8'));
    expect(config.providers.cloud.compat).toEqual({
      supportsDeveloperRole: false,
    });
    expect(config.providers.local.compat).toEqual({
      supportsDeveloperRole: false,
    });
    expect(config.providers.other.compat).toBeUndefined();
  } finally {
    rmSync(piDir, { recursive: true, force: true });
  }
});
