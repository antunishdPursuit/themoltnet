import type {
  ClassifierContext,
  ClassifierFunction,
  ClassifierResult,
  Usage,
} from '@earendil-works/pi-ai';
import { classify as classifyWithKey } from '@earendil-works/pi-ai/api/typesafe-system-one';
import { calculateCost } from '@earendil-works/pi-ai/models';
import {
  formatProviderError,
  normalizeProviderError,
} from '@earendil-works/pi-ai/utils/error-body';
import {
  headersToRecord,
  providerHeadersToRecord,
} from '@earendil-works/pi-ai/utils/headers';
import { retryProviderRequest } from '@earendil-works/pi-ai/utils/provider-retry';

const LABEL = 'System One API';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new Error(`${LABEL} returned an invalid ${field}`);
  return value;
}

function parseAnswers(
  value: unknown,
  context: ClassifierContext,
): ClassifierResult['answers'] {
  if (!isRecord(value))
    throw new Error(`${LABEL} returned an unexpected response`);
  return Object.fromEntries(
    Object.entries(context.questions).map<
      [string, ClassifierResult['answers'][string]]
    >(([id, question]) => {
      const answer = value[id];
      if (!isRecord(answer))
        throw new Error(`${LABEL} did not return an answer for ${id}`);
      if (question.type === 'choice') {
        if (answer.type !== 'choice' || typeof answer.choice !== 'string')
          throw new Error(`${LABEL} did not return a choice answer for ${id}`);
        if (!isRecord(answer.probabilities))
          throw new Error(`${LABEL} returned invalid probabilities for ${id}`);
        return [
          id,
          {
            type: 'choice',
            choice: answer.choice,
            probabilities: Object.fromEntries(
              Object.entries(answer.probabilities).map(([key, probability]) => [
                key,
                requiredNumber(probability, `probability for ${id}.${key}`),
              ]),
            ),
            confidence: requiredNumber(
              answer.confidence,
              `confidence for ${id}`,
            ),
          },
        ];
      }
      if (question.type === 'score') {
        if (answer.type !== 'score')
          throw new Error(`${LABEL} did not return a score answer for ${id}`);
        return [
          id,
          {
            type: 'score',
            score: requiredNumber(answer.score, `score for ${id}`),
            confidence: requiredNumber(
              answer.confidence,
              `confidence for ${id}`,
            ),
          },
        ];
      }
      if (answer.type !== 'noul')
        throw new Error(`${LABEL} did not return a bool answer for ${id}`);
      return [
        id,
        {
          type: 'bool',
          probability: requiredNumber(answer.noul, `probability for ${id}`),
        },
      ];
    }),
  );
}

function tokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

/**
 * Pi 1.0 requires a nonempty key for System One, although compatible local
 * servers support anonymous requests. Only an explicitly resolved empty key
 * enables this path; configured and unresolved credentials stay with Pi.
 * Keep its wire parsing and request lifecycle aligned with system-one-shared.
 */
export const classify: ClassifierFunction = async (model, context, options) => {
  if (options?.apiKey !== '') return classifyWithKey(model, context, options);
  const output: ClassifierResult = {
    api: model.api,
    provider: model.provider,
    model: model.id,
    answers: {},
    stopReason: 'stop',
    timestamp: Date.now(),
  };
  try {
    if (model.api !== 'typesafe-system-one')
      throw new Error(`Unsupported classifier API: ${model.api}`);
    let payload: unknown = {
      model: model.id,
      state: context.state,
      questions: Object.fromEntries(
        Object.entries(context.questions).map(([id, question]) => [
          id,
          question.type === 'bool' ? { ...question, type: 'noul' } : question,
        ]),
      ),
    };
    const transformed = await options.onPayload?.(payload, model);
    if (transformed !== undefined) payload = transformed;
    const requestFetch = options.fetch ?? globalThis.fetch;
    const { response, body } = await retryProviderRequest(
      async () => {
        const timeoutSignal =
          options.timeoutMs !== undefined
            ? AbortSignal.timeout(options.timeoutMs)
            : undefined;
        const signal =
          options.signal && timeoutSignal
            ? AbortSignal.any([options.signal, timeoutSignal])
            : (options.signal ?? timeoutSignal);
        try {
          const response = await requestFetch(
            new URL('systemone', `${model.baseUrl.replace(/\/+$/u, '')}/`),
            {
              method: 'POST',
              headers: providerHeadersToRecord(
                { 'content-type': 'application/json' },
                model.headers,
                options.headers,
              ),
              body: JSON.stringify(payload),
              signal,
            },
          );
          if (!response.ok)
            throw Object.assign(
              new Error(`${LABEL} returned ${response.status}`),
              {
                status: response.status,
                headers: response.headers,
                body: await response.text(),
              },
            );
          return { response, body: await response.json() };
        } catch (error) {
          if (timeoutSignal?.aborted && !options.signal?.aborted)
            throw Object.assign(
              new Error(`Request timed out after ${options.timeoutMs}ms`),
              {
                name: 'TimeoutError',
                status: undefined,
                headers: undefined,
                body: '',
              },
            );
          throw error;
        }
      },
      {
        maxRetries: options.maxRetries ?? 2,
        maxRetryDelayMs: options.maxRetryDelayMs,
        signal: options.signal,
      },
    );
    await options.onResponse?.(
      { status: response.status, headers: headersToRecord(response.headers) },
      model,
    );
    if (!isRecord(body))
      throw new Error(`${LABEL} returned an unexpected response`);
    // Malformed answers do not erase token usage from a billed request.
    if (
      isRecord(body.usage) &&
      (body.usage.input_tokens !== undefined ||
        body.usage.output_tokens !== undefined)
    ) {
      const input = tokenCount(body.usage.input_tokens);
      const out = tokenCount(body.usage.output_tokens);
      const usage: Usage = {
        input,
        output: out,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: input + out,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      };
      calculateCost(model, usage);
      output.usage = usage;
    }
    output.answers = parseAnswers(body.answers, context);
  } catch (error) {
    output.stopReason = options.signal?.aborted ? 'aborted' : 'error';
    output.errorMessage = formatProviderError(
      normalizeProviderError(error),
      `${LABEL} error`,
    );
  }
  return output;
};
