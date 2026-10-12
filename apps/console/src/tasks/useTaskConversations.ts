import { type Client } from '@moltnet/api-client';
import { listTaskConversationsOptions } from '@moltnet/api-client/query';
import {
  compareConversationMessages,
  type TaskConversationMessage,
  type TaskConversationThread,
} from '@moltnet/task-ui';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { abortableDelay } from '../abortable-delay.js';
import {
  type ConversationSnapshot,
  isLiveAttemptStatus,
  isPermanentConversationError,
  readConversation,
  watchConversationSnapshots,
} from './conversation-stream.js';

interface ConversationState {
  snapshot?: ConversationSnapshot;
  older: TaskConversationMessage[];
  /** Undefined until history loading starts; null means history is exhausted. */
  olderCursor?: string | null;
  loadingOlder: boolean;
  error: boolean;
  retrying: boolean;
}
const EMPTY: ConversationState = {
  older: [],
  loadingOlder: false,
  error: false,
  retrying: false,
};
function mergeMessages(
  ...groups: TaskConversationMessage[][]
): TaskConversationMessage[] {
  const byId = new Map<string, TaskConversationMessage>();
  for (const group of groups)
    for (const message of group) byId.set(message.id, message);
  return [...byId.values()].sort(compareConversationMessages);
}
const committed = (messages: TaskConversationMessage[]) =>
  messages.filter((message) => message.entryId !== null);
const statusCode = (error: unknown) =>
  (error as { status?: number } | null)?.status;

export interface UseTaskConversationsOptions {
  client: Client;
  teamId: string | undefined;
  taskId: string | undefined;
  attemptN: number | undefined;
  attemptStatus: string | undefined;
}

function emptyScope(scope: string) {
  return {
    scope,
    conversations: {} as Record<string, ConversationState>,
    expanded: [] as string[],
    terminal: false,
    revision: 0,
  };
}

/** One main stream; expanded subagents share a serial read loop. */
export function useTaskConversations({
  client,
  teamId,
  taskId,
  attemptN,
  attemptStatus,
}: UseTaskConversationsOptions) {
  const scope = `${teamId}/${taskId}/${attemptN}`;
  const [state, setState] = useState(() => emptyScope(scope));
  // Release the previous attempt, and reject callbacks from its in-flight reads.
  if (state.scope !== scope) setState(emptyScope(scope));
  const current = state.scope === scope ? state : emptyScope(scope);
  const live = isLiveAttemptStatus(attemptStatus) && !current.terminal;
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
    retry: (count, error) =>
      ![401, 403, 404].includes(statusCode(error) ?? 0) && count < 2,
    refetchInterval: (query) => {
      if (!live || [401, 403, 404].includes(statusCode(query.state.error) ?? 0))
        return false;
      // Empty discovery can acquire its first store later. Transient failures
      // back off instead of competing with the transcript reader.
      return query.state.error
        ? Math.min(
            5_000 * 2 ** Math.min(query.state.errorUpdateCount, 3),
            30_000,
          )
        : 5_000;
    },
  });
  const { refetch } = listQuery;
  useEffect(() => {
    // Polling stops at completion only after one final discovery. Also handles
    // fast attempts whose main conversation did not exist at the first read.
    if (enabled && !live) void refetch({ cancelRefetch: true });
  }, [enabled, live, refetch, scope]);
  const summaries = listQuery.data?.items ?? [];
  const mainId = summaries.find(
    (summary) => summary.kind === 'main',
  )?.conversationId;
  const expandedKey = summaries
    .filter(
      (summary) =>
        summary.kind === 'subagent' &&
        current.expanded.includes(summary.conversationId),
    )
    .map((summary) => summary.conversationId)
    .join(',');
  const update = useCallback(
    (id: string, change: (value: ConversationState) => ConversationState) => {
      setState((previous) =>
        previous.scope === scope
          ? {
              ...previous,
              conversations: {
                ...previous.conversations,
                [id]: change(previous.conversations[id] ?? EMPTY),
              },
            }
          : previous,
      );
    },
    [scope],
  );
  const apply = useCallback(
    (id: string, snapshot: ConversationSnapshot) => {
      update(id, (value) => {
        const retained = value.olderCursor !== undefined && value.snapshot;
        const lastEntry = Math.max(
          0,
          ...(value.snapshot?.messages ?? []).map((message) =>
            Number(message.entryId ?? 0),
          ),
        );
        // A reconnect (or reopening a child) can skip an entire live window.
        // Reopen pagination at that boundary, even after history was exhausted.
        // IDs may also skip because another conversation wrote entries; an
        // extra history read is preferable to hiding a possible gap.
        const gap =
          retained &&
          snapshot.nextBeforeEntryId !== null &&
          Number(snapshot.nextBeforeEntryId) > lastEntry + 1;
        return {
          ...value,
          snapshot,
          error: false,
          retrying: false,
          olderCursor: gap ? snapshot.nextBeforeEntryId : value.olderCursor,
          older: retained
            ? mergeMessages(value.older, committed(value.snapshot!.messages))
            : value.older,
        };
      });
      if (!isLiveAttemptStatus(snapshot.attemptStatus))
        setState((previous) =>
          previous.scope === scope ? { ...previous, terminal: true } : previous,
        );
    },
    [scope, update],
  );
  const retry = useCallback(() => {
    void refetch();
    setState((previous) =>
      previous.scope === scope
        ? { ...previous, revision: previous.revision + 1 }
        : previous,
    );
  }, [refetch, scope]);

  useEffect(() => {
    if (!teamId || !taskId || !attemptN || !mainId) return;
    const controller = new AbortController();
    const onSnapshot = (snapshot: ConversationSnapshot) => {
      if (!controller.signal.aborted) apply(mainId, snapshot);
    };
    const request = {
      client,
      headers,
      path: { id: taskId, n: attemptN, conversationId: mainId },
      signal: controller.signal,
    };
    const pending = live
      ? watchConversationSnapshots({
          client,
          teamId,
          taskId,
          attemptN,
          conversationId: mainId,
          signal: controller.signal,
          onSnapshot,
          onConnection: (connection) => {
            if (!controller.signal.aborted)
              update(mainId, (value) => ({
                ...value,
                retrying: connection === 'retrying',
                error: false,
              }));
          },
        })
      : readConversation(request).then(onSnapshot);
    void pending.catch(() => {
      if (!controller.signal.aborted)
        update(mainId, (value) => ({ ...value, error: true, retrying: false }));
    });
    return () => controller.abort();
  }, [
    apply,
    attemptN,
    client,
    current.revision,
    enabled,
    headers,
    live,
    mainId,
    taskId,
    teamId,
    update,
  ]);

  useEffect(() => {
    if (!taskId || !attemptN || !expandedKey) return;
    const controller = new AbortController();
    const unavailable = new Set<string>();
    const path = { id: taskId, n: attemptN };
    async function followExpanded() {
      let failures = 0;
      do {
        let failed = false;
        for (const conversationId of expandedKey.split(',')) {
          if (controller.signal.aborted) return;
          if (unavailable.has(conversationId)) continue;
          try {
            const snapshot = await readConversation({
              client,
              headers,
              path: { ...path, conversationId },
              signal: controller.signal,
            });
            if (!controller.signal.aborted) apply(conversationId, snapshot);
          } catch (error) {
            if (controller.signal.aborted) return;
            failed = true;
            if (isPermanentConversationError(error))
              unavailable.add(conversationId);
            update(conversationId, (value) => ({ ...value, error: true }));
          }
        }
        if (!live || unavailable.size === expandedKey.split(',').length) return;
        failures = failed ? failures + 1 : 0;
        await abortableDelay(
          Math.min(2_000 * 2 ** Math.min(failures, 4), 30_000),
          controller.signal,
        );
      } while (!controller.signal.aborted);
    }
    void followExpanded().catch(() => {
      /* Cancellation ends the read loop. */
    });
    return () => controller.abort();
  }, [
    apply,
    attemptN,
    client,
    current.revision,
    enabled,
    expandedKey,
    headers,
    live,
    taskId,
    update,
  ]);

  // History requests share the scope lifetime too, so switching tasks cannot
  // resurrect their old state or leave an unnecessary object read running.
  const historyRequests = useMemo(() => new Set<AbortController>(), [scope]);
  useEffect(
    () => () => {
      for (const controller of historyRequests) controller.abort();
      historyRequests.clear();
    },
    [historyRequests],
  );
  const loadOlder = useCallback(
    async (conversationId: string, cursor: string) => {
      if (!taskId || !attemptN) return;
      const historyController = new AbortController();
      historyRequests.add(historyController);
      update(conversationId, (value) => ({
        ...value,
        loadingOlder: true,
        olderCursor: cursor,
        older: mergeMessages(
          value.older,
          committed(value.snapshot?.messages ?? []),
        ),
      }));
      try {
        const data = await readConversation({
          client,
          headers,
          path: { id: taskId, n: attemptN, conversationId },
          query: { beforeEntryId: cursor },
          signal: historyController.signal,
        });
        if (!historyController.signal.aborted)
          update(conversationId, (value) => ({
            ...value,
            older: mergeMessages(committed(data.messages), value.older),
            // A newer snapshot may have opened a gap while this read ran.
            olderCursor:
              value.olderCursor === cursor
                ? data.nextBeforeEntryId
                : value.olderCursor,
            loadingOlder: false,
            error: false,
          }));
      } catch {
        if (!historyController.signal.aborted)
          update(conversationId, (value) => ({
            ...value,
            loadingOlder: false,
            error: true,
          }));
      } finally {
        historyRequests.delete(historyController);
      }
    },
    [attemptN, client, headers, historyRequests, taskId, update],
  );

  const threads = listQuery.data
    ? summaries.map((summary): TaskConversationThread => {
        const value = current.conversations[summary.conversationId] ?? EMPTY;
        const cursor =
          value.olderCursor === undefined
            ? value.snapshot?.nextBeforeEntryId
            : value.olderCursor;
        return {
          summary,
          live:
            live &&
            isLiveAttemptStatus(value.snapshot?.attemptStatus ?? attemptStatus),
          messages: mergeMessages(value.older, value.snapshot?.messages ?? []),
          loading: !value.snapshot && !value.error,
          error: value.error,
          retrying: value.retrying,
          onRetry: retry,
          onExpandedChange: (expanded) =>
            setState((previous) =>
              previous.scope === scope
                ? {
                    ...previous,
                    expanded: expanded
                      ? [
                          ...new Set([
                            ...previous.expanded,
                            summary.conversationId,
                          ]),
                        ]
                      : previous.expanded.filter(
                          (id) => id !== summary.conversationId,
                        ),
                  }
                : previous,
            ),
          onLoadOlder: cursor
            ? () => void loadOlder(summary.conversationId, cursor)
            : undefined,
          loadingOlder: value.loadingOlder,
        };
      })
    : undefined;
  return {
    threads,
    loading: enabled && listQuery.isPending,
    error: listQuery.error ? 'Conversations could not be loaded.' : undefined,
    retry,
  };
}
