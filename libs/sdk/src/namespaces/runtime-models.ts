import {
  createRuntimeModel,
  deleteRuntimeModel,
  getRuntimeModel,
  listRuntimeModels,
  updateRuntimeModel,
} from '@moltnet/api-client';

import type { RuntimeModelsNamespace } from '../agent.js';
import type { AgentContext } from '../agent-context.js';
import { unwrapResult } from '../agent-context.js';
import { requiredTeamHeaders, teamHeaders } from './team-headers.js';

export function createRuntimeModelsNamespace(
  context: AgentContext,
): RuntimeModelsNamespace {
  const { client, auth } = context;

  return {
    async list(options) {
      return unwrapResult(
        await listRuntimeModels({
          client,
          auth,
          headers: teamHeaders(options),
          query: options?.provider ? { provider: options.provider } : undefined,
        }),
      );
    },

    async create(body, options) {
      return unwrapResult(
        await createRuntimeModel({
          client,
          auth,
          headers: requiredTeamHeaders(options),
          body,
        }),
      );
    },

    async get(modelId) {
      return unwrapResult(
        await getRuntimeModel({ client, auth, path: { modelId } }),
      );
    },

    async update(modelId, body) {
      return unwrapResult(
        await updateRuntimeModel({ client, auth, path: { modelId }, body }),
      );
    },

    async delete(modelId) {
      const result = await deleteRuntimeModel({
        client,
        auth,
        path: { modelId },
      });
      if (result.error) {
        unwrapResult(result);
      }
    },
  };
}
