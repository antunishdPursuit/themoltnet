import {
  type Api,
  type SimpleStreamOptions,
  type StreamFunction,
} from '@earendil-works/pi-ai';
import { streamSimple as streamOpenAI } from '@earendil-works/pi-ai/api/openai-completions';
import { providerHeadersToRecord } from '@earendil-works/pi-ai/utils/headers';

/**
 * Pi 1.0's OpenAI SDK requires a nonempty constructor key even for anonymous
 * servers. Satisfy that SDK invariant locally, then remove its generated header
 * at the fetch boundary. No placeholder is stored or sent to a provider.
 * Configured credentials and caller-supplied Authorization keep Pi's path.
 */
export const streamAnonymousOpenAI: StreamFunction<Api, SimpleStreamOptions> = (
  model,
  context,
  options,
) => {
  if (model.api !== 'openai-completions')
    throw new Error(`Unsupported anonymous chat API: ${model.api}`);
  const openAIModel = { ...model, api: 'openai-completions' as const };
  if (options?.apiKey !== '')
    return streamOpenAI(openAIModel, context, options);
  const suppliedHeaders = new Headers(
    providerHeadersToRecord(model.headers, options.headers),
  );
  if (
    suppliedHeaders.has('authorization') ||
    suppliedHeaders.has('cf-aig-authorization')
  )
    return streamOpenAI(openAIModel, context, options);
  const requestFetch = options.fetch ?? globalThis.fetch;
  return streamOpenAI(openAIModel, context, {
    ...options,
    apiKey: 'pi-anonymous-sdk-only',
    fetch: (input, init) => {
      const headers = new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined),
      );
      headers.delete('authorization');
      return requestFetch(input, { ...init, headers });
    },
  });
};
