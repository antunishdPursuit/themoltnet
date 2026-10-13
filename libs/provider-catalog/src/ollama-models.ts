import { ollamaCloudModelData } from './ollama-cloud-models.generated.js';
import type { RuntimeModelCatalogEntry } from './types.js';

// MoltNet's Pi integration uses Ollama's OpenAI-compatible endpoint. That
// route accepts temperature, top_p, and output caps, but does not expose the
// native Ollama top_k option through Pi's openai-completions request shape.
// https://docs.ollama.com/api/openai-compatibility
const openAiCompatibleRequestCapabilities = {
  supportsTemperature: true,
  supportsTopP: true,
  supportsTopK: false,
  supportsMaxOutputTokens: true,
} as const;

/**
 * Reviewed suggestions from Ollama's public Model Library (2026-09-04).
 * These describe model names that a user may choose; they do not assert that
 * a model is installed in any local Ollama runtime.
 */
export const ollamaModels: readonly RuntimeModelCatalogEntry[] = [
  'deepseek-r1',
  'gemma3',
  'gemma3:12b',
  'llama3.3',
  'llama4',
  'mistral-small3.1',
  'phi4',
  'qwen2.5-coder',
  'qwen3',
  'qwen3-coder',
].map((model) => ({
  provider: 'ollama',
  model,
  displayName: `Ollama · ${model}`,
  description: 'Local Ollama model suggestion; installation is not implied.',
  capabilities: { ...openAiCompatibleRequestCapabilities },
}));

/**
 * Local System One suggestions, reviewed against Ollama's decision guide.
 * https://docs.ollama.com/capabilities/decision
 * Version requirements and vision are model capabilities; context depends on
 * the installed model/server, so no context window is inferred here.
 */
export const ollamaClassifierModels: readonly RuntimeModelCatalogEntry[] = [
  { model: 'nimble', minimumOllamaVersion: '0.35.0', supportsVision: false },
  { model: 'tev1', minimumOllamaVersion: '0.35.0', supportsVision: false },
  { model: 'clef', minimumOllamaVersion: '0.35.1', supportsVision: true },
  { model: 'clef-flash', minimumOllamaVersion: '0.35.1', supportsVision: true },
].map(({ model, minimumOllamaVersion, supportsVision }) => ({
  provider: 'ollama',
  model,
  displayName: `Ollama · ${model}`,
  description: `Local System One decision model; requires Ollama v${minimumOllamaVersion}+. Installation is not implied.`,
  capabilities: {
    generation: false,
    classification: true,
    api: 'typesafe-system-one',
    minimumOllamaVersion,
    supportsVision,
    supportsTemperature: false,
    supportsTopP: false,
    supportsTopK: false,
    supportsMaxOutputTokens: false,
  },
}));

/**
 * Ollama Cloud entries generated from the public model list and per-model
 * `/api/show` metadata at https://ollama.com (see `generate:ollama-cloud`).
 * Ids are the ones the `ollama-cloud` provider accepts, without local-proxy
 * `:cloud` aliases. `thinkingLevels` lists Ollama's accepted thinking values
 * (`off`/`on` for boolean models, otherwise named levels such as `high`).
 */
export const ollamaCloudModels: readonly RuntimeModelCatalogEntry[] =
  ollamaCloudModelData.map((model) => ({
    provider: 'ollama-cloud',
    model: model.id,
    displayName: `Ollama Cloud · ${model.id}`,
    description: 'Generated from the Ollama Cloud model catalog.',
    capabilities: {
      supportsReasoning: model.thinkingLevels !== undefined,
      supportsVision: model.vision,
      supportsTools: model.tools,
      ...openAiCompatibleRequestCapabilities,
      contextWindow: model.contextWindow,
      ...(model.thinkingLevels
        ? {
            thinkingLevels: model.thinkingLevels.join(','),
            defaultThinkingLevel: model.defaultThinkingLevel ?? '',
          }
        : {}),
    },
  }));
