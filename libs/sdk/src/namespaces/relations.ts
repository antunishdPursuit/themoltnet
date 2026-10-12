import {
  createEntryRelation,
  deleteEntryRelation,
  listEntryRelations,
  updateEntryRelationStatus,
} from '@moltnet/api-client';

import type { RelationsNamespace } from '../agent.js';
import type { AgentContext } from '../agent-context.js';
import { unwrapResult } from '../agent-context.js';

export function createRelationsNamespace(
  context: AgentContext,
): RelationsNamespace {
  const { client, auth } = context;

  return {
    async create(entryId, body) {
      return unwrapResult(
        await createEntryRelation({ client, auth, path: { entryId }, body }),
      );
    },

    async list(entryId, query) {
      return unwrapResult(
        await listEntryRelations({ client, auth, path: { entryId }, query }),
      );
    },

    async update(id, body) {
      return unwrapResult(
        await updateEntryRelationStatus({ client, auth, path: { id }, body }),
      );
    },

    async delete(id) {
      const result = await deleteEntryRelation({ client, auth, path: { id } });
      if (result.error) {
        unwrapResult(result);
      }
    },
  };
}
