import { Stack, Text, useTheme } from '@themoltnet/design-system';
import {
  type KeyboardEvent,
  type MouseEvent,
  useEffect,
  useId,
  useState,
} from 'react';

import {
  hasConversationView,
  operationalTaskMessages,
  type TaskConversationThread,
} from './conversation.js';
import { humanizeToken } from './format.js';
import { JsonViewer } from './json-viewer.js';
import { TaskConversationView } from './task-conversation-view.js';
import { TaskMessagesTimeline } from './task-messages-timeline.js';
import { TaskStatusBadge } from './task-status-badge.js';
import { TaskTurnStream } from './task-turn-stream.js';
import type { TaskAttemptSummary, TaskMessage, TaskSummary } from './types.js';

type PaneTab = 'turns' | 'events' | 'usage' | 'input';

export interface TaskLivePaneProps {
  task: TaskSummary;
  attempt?: TaskAttemptSummary | null;
  messages: TaskMessage[];
  /**
   * Durable conversation threads for the attempt. When any thread has content
   * it replaces the task-message transcript, and operational task messages move
   * to the Events tab. Attempts without a conversation keep the task-message
   * transcript.
   */
  conversation?: TaskConversationThread[];
  conversationLoading?: boolean;
  conversationError?: string;
  onRetryConversation?: () => void;
  /** Docs URL surfaced in the empty turn-stream state (run an agent daemon). */
  learnMoreHref?: string;
  /** Deselects or hides the pane in the parent view. */
  onClose?: () => void;
  /** Starts header-only; useful when the pane is stacked below content. */
  defaultCollapsed?: boolean;
  /** Adapts the pane to a bounded modal viewport instead of a sticky rail. */
  presentation?: 'panel' | 'dialog';
}

export function TaskLivePane({
  task,
  attempt,
  messages,
  conversation,
  conversationLoading,
  conversationError,
  onRetryConversation,
  learnMoreHref,
  onClose,
  defaultCollapsed = false,
  presentation = 'panel',
}: TaskLivePaneProps) {
  const theme = useTheme();
  const [tab, setTab] = useState<PaneTab>('turns');
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const live = task.status === 'running' || task.status === 'dispatched';
  const taskTitle = task.title || humanizeToken(task.taskType);
  const isDialog = presentation === 'dialog';
  const idPrefix = useId();
  const durable =
    hasConversationView(conversation) ||
    conversationLoading ||
    !!conversationError;
  const events = durable ? operationalTaskMessages(messages) : [];
  const errorCount = events.filter((m) => m.kind === 'error').length;
  const tabs: { id: PaneTab; label: string }[] = [
    { id: 'turns', label: 'Turns' },
    ...(durable
      ? [
          {
            id: 'events' as const,
            label: errorCount
              ? `Events (${events.length}, ${errorCount} ${errorCount === 1 ? 'error' : 'errors'})`
              : `Events (${events.length})`,
          },
        ]
      : []),
    { id: 'usage', label: 'Usage' },
    { id: 'input', label: 'Input' },
  ];
  const activeTab = tabs.some((entry) => entry.id === tab) ? tab : 'turns';

  useEffect(() => {
    setCollapsed(defaultCollapsed);
  }, [defaultCollapsed, task.id]);

  function toggleCollapsed() {
    setCollapsed((value) => !value);
  }

  function handleHeaderKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      toggleCollapsed();
    }
  }

  function handleClose(event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    onClose?.();
  }

  return (
    <div
      data-presentation={presentation}
      style={{
        background: theme.color.bg.void,
        border: `1px solid ${theme.color.border.DEFAULT}`,
        borderRadius: theme.radius.lg,
        display: 'flex',
        flexDirection: 'column',
        height: collapsed || !isDialog ? undefined : 'min(68dvh, 44rem)',
        minHeight: collapsed || isDialog ? undefined : 480,
        maxHeight: isDialog ? '68dvh' : undefined,
        minWidth: 0,
        position: isDialog ? 'relative' : 'sticky',
        top: isDialog ? undefined : theme.spacing[6],
        overflow: 'hidden',
      }}
    >
      <div
        role="button"
        tabIndex={0}
        aria-expanded={!collapsed}
        onClick={toggleCollapsed}
        onKeyDown={handleHeaderKeyDown}
        style={{
          alignItems: 'center',
          padding: theme.spacing[3],
          borderBottom: `1px solid ${theme.color.border.DEFAULT}`,
          background: theme.color.bg.surface,
          cursor: 'pointer',
          display: 'flex',
          gap: theme.spacing[2],
          justifyContent: 'space-between',
        }}
      >
        <Stack direction="row" align="center" gap={2} shrink>
          <Text style={{ fontWeight: theme.font.weight.semibold }}>
            {taskTitle}
          </Text>
          <Text
            variant="caption"
            color="muted"
            style={{ fontFamily: theme.font.family.mono }}
          >
            {humanizeToken(task.taskType)} · {task.id.slice(0, 8)}
            {attempt ? ` · attempt ${attempt.attemptN}` : ''}
          </Text>
        </Stack>
        <Stack direction="row" align="center" gap={2}>
          <TaskStatusBadge status={task.status} />
          <Text
            aria-hidden="true"
            color="muted"
            style={{
              fontFamily: theme.font.family.mono,
              fontSize: theme.font.size.sm,
              lineHeight: 1,
              width: '1rem',
              textAlign: 'center',
            }}
          >
            {collapsed ? '+' : '-'}
          </Text>
          {onClose ? (
            <button
              type="button"
              aria-label="Close task live pane"
              onClick={handleClose}
              style={{
                alignItems: 'center',
                background: 'transparent',
                border: `1px solid ${theme.color.border.DEFAULT}`,
                borderRadius: theme.radius.sm,
                color: theme.color.text.secondary,
                cursor: 'pointer',
                display: 'inline-flex',
                font: 'inherit',
                fontFamily: theme.font.family.mono,
                height: '1.75rem',
                justifyContent: 'center',
                padding: 0,
                width: '1.75rem',
              }}
            >
              X
            </button>
          ) : null}
        </Stack>
      </div>

      {collapsed ? null : (
        <>
          <div
            role="tablist"
            style={{
              display: 'flex',
              borderBottom: `1px solid ${theme.color.border.DEFAULT}`,
              background: theme.color.bg.surface,
            }}
          >
            {tabs.map((entry) => (
              <button
                key={entry.id}
                id={`${idPrefix}-tab-${entry.id}`}
                role="tab"
                aria-selected={activeTab === entry.id}
                aria-controls={`${idPrefix}-panel`}
                type="button"
                onClick={() => setTab(entry.id)}
                style={{
                  font: 'inherit',
                  fontFamily: theme.font.family.mono,
                  fontSize: theme.font.size.xs,
                  padding: `${theme.spacing[2]} ${theme.spacing[4]}`,
                  cursor: 'pointer',
                  background: 'transparent',
                  color:
                    activeTab === entry.id
                      ? theme.color.primary.DEFAULT
                      : theme.color.text.secondary,
                  border: 'none',
                  borderBottom: `2px solid ${
                    activeTab === entry.id
                      ? theme.color.primary.DEFAULT
                      : 'transparent'
                  }`,
                }}
              >
                {entry.label}
              </button>
            ))}
          </div>

          <div
            id={`${idPrefix}-panel`}
            role="tabpanel"
            aria-labelledby={`${idPrefix}-tab-${activeTab}`}
            style={{ flex: 1, minHeight: 0, overflow: 'auto' }}
          >
            {activeTab === 'turns' ? (
              durable ? (
                <TaskConversationView
                  key={`${task.id}/${attempt?.attemptN ?? 0}`}
                  threads={conversation ?? []}
                  live={live}
                  loading={conversationLoading}
                  error={conversationError}
                  onRetry={onRetryConversation}
                />
              ) : (
                <TaskTurnStream
                  messages={messages}
                  live={live}
                  learnMoreHref={learnMoreHref}
                  attemptStatus={attempt?.status}
                />
              )
            ) : null}
            {activeTab === 'events' ? (
              <div style={{ padding: theme.spacing[4] }}>
                {events.length ? (
                  <TaskMessagesTimeline messages={events} joinText={false} />
                ) : (
                  <Text color="muted">
                    No errors, policy decisions or notices for this attempt.
                  </Text>
                )}
              </div>
            ) : null}
            {activeTab === 'usage' ? (
              <div style={{ padding: theme.spacing[4] }}>
                <JsonViewer value={attempt?.usage ?? {}} defaultExpanded />
              </div>
            ) : null}
            {activeTab === 'input' ? (
              <div style={{ padding: theme.spacing[4] }}>
                <JsonViewer value={task.input} defaultExpanded />
              </div>
            ) : null}
          </div>

          {attempt?.usage ? (
            <Stack
              direction="row"
              gap={4}
              style={{
                padding: theme.spacing[3],
                borderTop: `1px solid ${theme.color.border.DEFAULT}`,
                background: theme.color.bg.surface,
                fontFamily: theme.font.family.mono,
              }}
            >
              <Text variant="caption" color="muted">
                {attempt.usage.inputTokens + attempt.usage.outputTokens} tok
              </Text>
              {typeof attempt.usage.toolCalls === 'number' ? (
                <Text variant="caption" color="muted">
                  tools {attempt.usage.toolCalls}
                </Text>
              ) : null}
              {attempt.usage.model ? (
                <Text variant="caption" color="muted">
                  {attempt.usage.model}
                </Text>
              ) : null}
            </Stack>
          ) : null}
        </>
      )}
    </div>
  );
}
