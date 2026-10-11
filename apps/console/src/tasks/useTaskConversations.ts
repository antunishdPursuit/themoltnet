import { type Client, getTaskConversation } from '@moltnet/api-client';
import { listTaskConversationsOptions } from '@moltnet/api-client/query';
import {
  compareConversationMessages,
  type TaskConversationMessage,
  type TaskConversationThread,
} from '@moltnet/task-ui';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  type ConversationSnapshot,
  isLiveAttemptStatus,
  watchConversationSnapshots,
} from './conversation-stream.js';

interface ConversationState {
  snapshot?: ConversationSnapshot;
  /** Committed messages older than the snapshot window, loaded on demand. */
  older: TaskConversationMessage[];
  /** Cursor for the next older page once `older` is non-empty. */
  olderCursor: string | null;
  loadingOlder: boolean;
  error: boolean;
}

const EMPTY: ConversationState = {
  older: [],
  olderCursor: null,
  loadingOlder: false,
  error: false,
};

function mergeMessages(
  ...groups: TaskConversationMessage[][]
): TaskConversationMessage[] {
  const byId = new Map<string, TaskConversationMessage>();
  for (const group of groups) {
    for (const message of group) byId.set(message.id, message);
  }
  return [...byId.values()].sort(compareConversationMessages);
}

const committed = (messages: TaskConversationMessage[]) =>
  messages.filter((message) => message.entryId !== null);

export interface UseTaskConversationsOptions {
  client: Client;
  teamId: string | undefined;
  taskId: string | undefined;
  attemptN: number | undefined;
  attemptStatus: string | undefined;
}

/**
 * Durable conversations for one attempt. Live attempts follow each
 * conversation's SSE stream (polling if the stream fails); terminal attempts
 * read each conversation once. Returns `undefined` threads when the attempt
 * has no conversation, such as pre-Durable attempts.
 */
export function useTaskConversations({
  client,
  teamId,
  taskId,
  attemptN,
  attemptStatus,
}: UseTaskConversationsOptions): {
  threads: TaskConversationThread[] | undefined;
} {
  const live = isLiveAttemptStatus(attemptStatus);
  const enabled = Boolean(teamId && taskId && attemptN);
  const headers = useMemo(
    () => ({ 'x-moltnet-team-id': teamId ?? '' }),
    [teamId],
  );
  const listQuery = useQuery({
    ...listTaskConversationsOptions({
      client,
      headers,
      path: { id: taskId ?? '', n: attemptN ?? 0 },
    }),
    enabled,
    // Pre-Durable attempts answer 404; that is an answer, not a failure.
    retry: false,
    // Subagent conversations appear while the attempt runs.
    refetchInterval: live ? 5_000 : false,
  });
  const summaries = useMemo(
    () => listQuery.data?.items ?? [],
    [listQuery.data],
  );
  const idsKey = summaries.map((s) => s.conversationId).join(',');
  // Keyed by attempt and conversation: conversation ids are small integers
  // shared across tasks, so a late result for a previous selection lands in
  // its own key instead of the current attempt's.
  const scope = `${teamId}/${taskId}/${attemptN}`;
  const [states, setStates] = useState<Record<string, ConversationState>>({});

  const update = useCallback(
    (id: string, change: (state: ConversationState) => ConversationState) =>
      setStates((prev) => ({ ...prev, [id]: change(prev[id] ?? EMPTY) })),
    [],
  );

  const applySnapshot = useCallback(
    (id: string, snapshot: ConversationSnapshot) =>
      update(id, (state) => ({
        ...state,
        // Once history is loaded, keep the entries the sliding 100-entry
        // window drops so older pages stay contiguous with the snapshot.
        older:
          state.older.length && state.snapshot
            ? mergeMessages(state.older, committed(state.snapshot.messages))
            : state.older,
        snapshot,
        error: false,
      })),
    [update],
  );

  useEffect(() => {
    if (!teamId || !taskId || !attemptN || !idsKey) return;
    const controller = new AbortController();
    for (const conversationId of idsKey.split(',')) {
      const base = {
        client,
        teamId,
        taskId,
        attemptN,
        conversationId,
      };
      const key = `${scope}#${conversationId}`;
      const apply = (snapshot: ConversationSnapshot) => {
        if (!controller.signal.aborted) applySnapshot(key, snapshot);
      };
      const failed = () => {
        if (!controller.signal.aborted)
          update(key, (state) => ({ ...state, error: true }));
      };
      if (live) {
        void watchConversationSnapshots({
          ...base,
          signal: controller.signal,
          onSnapshot: apply,
        }).catch(failed);
      } else {
        void getTaskConversation({
          client,
          headers,
          path: { id: taskId, n: attemptN, conversationId },
          signal: controller.signal,
        }).then(({ data }) => {
          if (data) apply(data);
          else failed();
        }, failed);
      }
    }
    return () => controller.abort();
  }, [
    applySnapshot,
    attemptN,
    client,
    headers,
    idsKey,
    live,
    scope,
    taskId,
    teamId,
    update,
  ]);

  const loadOlder = useCallback(
    async (conversationId: string, cursor: string) => {
      if (!taskId || !attemptN) return;
      const key = `${scope}#${conversationId}`;
      update(key, (state) => ({ ...state, loadingOlder: true }));
      const { data } = await getTaskConversation({
        client,
        headers,
        path: { id: taskId, n: attemptN, conversationId },
        query: { beforeEntryId: cursor },
      }).catch(() => ({ data: undefined }));
      update(key, (state) =>
        data
          ? {
              ...state,
              older: mergeMessages(committed(data.messages), state.older),
              olderCursor: data.nextBeforeEntryId,
              loadingOlder: false,
            }
          : { ...state, loadingOlder: false },
      );
    },
    [attemptN, client, headers, scope, taskId, update],
  );

  const threads = useMemo(() => {
    if (!listQuery.data) return undefined;
    return summaries.map((summary): TaskConversationThread => {
      const state = states[`${scope}#${summary.conversationId}`] ?? EMPTY;
      const cursor = state.older.length
        ? state.olderCursor
        : (state.snapshot?.nextBeforeEntryId ?? null);
      return {
        summary,
        messages: mergeMessages(state.older, state.snapshot?.messages ?? []),
        loading: !state.snapshot && !state.error,
        error: state.error,
        onLoadOlder: cursor
          ? () => void loadOlder(summary.conversationId, cursor)
          : undefined,
        loadingOlder: state.loadingOlder,
      };
    });
  }, [listQuery.data, loadOlder, scope, states, summaries]);

  return { threads };
}
