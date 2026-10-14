import type {
  AgentKeysNamespace,
  CryptoNamespace,
  DiariesNamespace,
  DiaryGrantsNamespace,
  EntriesNamespace,
  GroupsNamespace,
  LegreffierNamespace,
  PacksNamespace,
  ProblemsNamespace,
  PublicNamespace,
  RelationsNamespace,
  RuntimeModelsNamespace,
  RuntimeProfilesNamespace,
  TasksNamespace,
  TeamsNamespace,
} from './agent.js';
import type { AgentContext } from './agent-context.js';
import { createAgentKeysNamespace } from './namespaces/agent-keys.js';
import { createCryptoNamespace } from './namespaces/crypto.js';
import { createDiariesNamespace } from './namespaces/diaries.js';
import { createDiaryGrantsNamespace } from './namespaces/diary-grants.js';
import { createEntriesNamespace } from './namespaces/entries.js';
import { createGroupsNamespace } from './namespaces/groups.js';
import { createLegreffierNamespace } from './namespaces/legreffier.js';
import { createPacksNamespace } from './namespaces/packs.js';
import { createProblemsNamespace } from './namespaces/problems.js';
import {
  createProjectsNamespace,
  type ProjectsNamespace,
} from './namespaces/projects.js';
import { createPublicNamespace } from './namespaces/public.js';
import { createRelationsNamespace } from './namespaces/relations.js';
import { createRuntimeModelsNamespace } from './namespaces/runtime-models.js';
import { createRuntimeProfilesNamespace } from './namespaces/runtime-profiles.js';
import { createSigningCredentialsNamespace } from './namespaces/signing-credentials.js';
import { createSigningRequestsNamespace } from './namespaces/signing-requests.js';
import { createTasksNamespace } from './namespaces/tasks.js';
import { createTeamsNamespace } from './namespaces/teams.js';

/** Namespaces available to both agent and human SDK clients. */
export interface SharedNamespaces {
  agentKeys: AgentKeysNamespace;
  diaries: DiariesNamespace;
  diaryGrants: DiaryGrantsNamespace;
  runtimeProfiles: RuntimeProfilesNamespace;
  runtimeModels: RuntimeModelsNamespace;
  packs: PacksNamespace;
  entries: EntriesNamespace;
  relations: RelationsNamespace;
  public: PublicNamespace;
  legreffier: LegreffierNamespace;
  problems: ProblemsNamespace;
  teams: TeamsNamespace;
  groups: GroupsNamespace;
  projects: ProjectsNamespace;
  tasks: TasksNamespace;
  crypto: CryptoNamespace;
}

export function createSharedNamespaces(
  context: AgentContext,
): SharedNamespaces {
  const signingRequests = createSigningRequestsNamespace(context);
  const signingCredentials = createSigningCredentialsNamespace(context);

  return {
    agentKeys: createAgentKeysNamespace(context),
    diaries: createDiariesNamespace(context),
    diaryGrants: createDiaryGrantsNamespace(context),
    runtimeProfiles: createRuntimeProfilesNamespace(context),
    runtimeModels: createRuntimeModelsNamespace(context),
    packs: createPacksNamespace(context),
    entries: createEntriesNamespace(context),
    relations: createRelationsNamespace(context),
    public: createPublicNamespace(context),
    legreffier: createLegreffierNamespace(context),
    problems: createProblemsNamespace(context),
    teams: createTeamsNamespace(context),
    groups: createGroupsNamespace(context),
    projects: createProjectsNamespace(context),
    tasks: createTasksNamespace(context),
    crypto: createCryptoNamespace(context, signingRequests, signingCredentials),
  };
}
