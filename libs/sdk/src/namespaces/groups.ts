import {
  addGroupMember,
  createGroup,
  deleteGroup,
  getGroup,
  listGroupMembers,
  listGroups,
  removeGroupMember,
} from '@moltnet/api-client';

import type { GroupsNamespace } from '../agent.js';
import type { AgentContext } from '../agent-context.js';
import { unwrapResult } from '../agent-context.js';

export function createGroupsNamespace(context: AgentContext): GroupsNamespace {
  const { client, auth } = context;

  return {
    async create(teamId, body) {
      return unwrapResult(
        await createGroup({ client, auth, path: { id: teamId }, body }),
      );
    },

    async list(teamId) {
      return unwrapResult(
        await listGroups({ client, auth, path: { id: teamId } }),
      );
    },

    async get(groupId) {
      return unwrapResult(await getGroup({ client, auth, path: { groupId } }));
    },

    async delete(groupId) {
      return unwrapResult(
        await deleteGroup({ client, auth, path: { groupId } }),
      );
    },

    async addMember(groupId, body) {
      return unwrapResult(
        await addGroupMember({ client, auth, path: { groupId }, body }),
      );
    },

    async listMembers(groupId) {
      return unwrapResult(
        await listGroupMembers({ client, auth, path: { groupId } }),
      );
    },

    async removeMember(groupId, subjectId) {
      return unwrapResult(
        await removeGroupMember({
          client,
          auth,
          path: { groupId, subjectId },
        }),
      );
    },
  };
}
