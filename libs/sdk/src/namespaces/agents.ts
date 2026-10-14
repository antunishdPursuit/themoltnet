import {
  deleteWhoamiAlias,
  getAgentProfile,
  updateWhoami,
  verifyAgentSignature,
} from '@moltnet/api-client';

import type { AgentsNamespace } from '../agent.js';
import type { AgentContext } from '../agent-context.js';
import { unwrapResult } from '../agent-context.js';
import { createWhoami } from './whoami.js';

export function createAgentsNamespace(context: AgentContext): AgentsNamespace {
  const { client, auth } = context;

  return {
    whoami: createWhoami(context),

    async updateWhoami(body, options) {
      return unwrapResult(
        await updateWhoami({
          client,
          auth,
          body,
          ...(options?.signal ? { signal: options.signal } : {}),
        }),
      );
    },

    async deleteAlias(options) {
      const result = await deleteWhoamiAlias({
        client,
        auth,
        ...(options?.signal ? { signal: options.signal } : {}),
      });
      if (result.error) {
        unwrapResult(result);
      }
    },

    async lookup(fingerprint) {
      return unwrapResult(
        await getAgentProfile({
          client,
          path: { fingerprint },
        }),
      );
    },

    async verifySignature(fingerprint, body) {
      return unwrapResult(
        await verifyAgentSignature({
          client,
          path: { fingerprint },
          body,
        }),
      );
    },
  };
}
