import type { TaskMessage } from './types.js';

/** One assembled Pi message from `GET …/conversations/:conversationId`. */
export interface TaskConversationMessage {
  id: string;
  /** Null for the committed partial response. */
  entryId: string | null;
  entryKind: string;
  /** Carried over from an earlier attempt; not this attempt's work. */
  inherited: boolean;
  status: 'completed' | 'streaming' | 'interrupted' | 'failed';
  message: Record<string, unknown>;
}

export interface TaskConversationSummary {
  conversationId: string;
  parentConversationId: string | null;
  kind: 'main' | 'subagent';
}

/** A conversation and the messages the console currently holds for it. */
export interface TaskConversationThread {
  summary: TaskConversationSummary;
  messages: TaskConversationMessage[];
  /** Observed attempt state; a terminal snapshot overrides stale page data. */
  live?: boolean;
  /** True until the first snapshot for this conversation arrives. */
  loading?: boolean;
  error?: boolean;
  retrying?: boolean;
  onRetry?: () => void;
  onExpandedChange?: (expanded: boolean) => void;
  /** Present when older entries exist beyond the loaded window. */
  onLoadOlder?: () => void;
  loadingOlder?: boolean;
}

export type ConversationBlock =
  | { type: 'text'; role: 'user' | 'assistant'; text: string }
  | { type: 'thinking'; text: string }
  | {
      type: 'tool';
      id: string;
      name: string;
      arguments: unknown;
      result?: { text: string; isError: boolean };
    }
  | { type: 'toolResult'; name: string; text: string; isError: boolean };

export interface ConversationItem {
  message: TaskConversationMessage;
  role: string;
  blocks: ConversationBlock[];
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function contentParts(message: Record<string, unknown>) {
  const content = message.content;
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content) ? content.map(record) : [];
}

function partsText(parts: Record<string, unknown>[]): string {
  return parts
    .map((part) =>
      part.type === 'text' && typeof part.text === 'string'
        ? part.text
        : part.type === 'image'
          ? '[image]'
          : '',
    )
    .filter(Boolean)
    .join('\n');
}

/**
 * Turns assembled Pi messages into display items. Tool results are folded into
 * the assistant tool call with the same `toolCallId`, so each call renders once
 * with its outcome; a result without a visible call (for example, the call fell
 * outside the loaded window) renders on its own.
 */
export function toConversationItems(
  messages: TaskConversationMessage[],
): ConversationItem[] {
  const calls = new Map<string, Extract<ConversationBlock, { type: 'tool' }>>();
  const items: ConversationItem[] = [];
  for (const entry of messages) {
    const message = record(entry.message);
    const role = typeof message.role === 'string' ? message.role : 'unknown';
    const parts = contentParts(message);
    if (role === 'toolResult') {
      const result = {
        text: partsText(parts),
        isError: message.isError === true,
      };
      const call =
        typeof message.toolCallId === 'string'
          ? calls.get(message.toolCallId)
          : undefined;
      if (call) {
        call.result = result;
        continue;
      }
      items.push({
        message: entry,
        role,
        blocks: [
          {
            type: 'toolResult',
            name:
              typeof message.toolName === 'string' ? message.toolName : 'tool',
            ...result,
          },
        ],
      });
      continue;
    }
    const blocks: ConversationBlock[] = [];
    for (const part of parts) {
      if (part.type === 'text' && typeof part.text === 'string' && part.text) {
        blocks.push({
          type: 'text',
          role: role === 'user' ? 'user' : 'assistant',
          text: part.text,
        });
      } else if (
        part.type === 'thinking' &&
        typeof part.thinking === 'string' &&
        part.thinking &&
        part.redacted !== true
      ) {
        blocks.push({ type: 'thinking', text: part.thinking });
      } else if (part.type === 'toolCall' && typeof part.id === 'string') {
        const call = {
          type: 'tool' as const,
          id: part.id,
          name: typeof part.name === 'string' ? part.name : 'tool',
          arguments: part.arguments,
        };
        calls.set(part.id, call);
        blocks.push(call);
      }
    }
    if (blocks.length > 0 || entry.status !== 'completed') {
      items.push({ message: entry, role, blocks });
    }
  }
  return items;
}

/** Task-message kinds the conversation does not already describe. */
const OPERATIONAL_KINDS = new Set<TaskMessage['kind']>([
  'error',
  'info',
  'tool_policy_decision',
]);

/**
 * Operational events to show beside a Durable conversation. Tool markers, turn
 * ends and text deltas are dropped because the conversation already holds the
 * same tool calls and the assistant text.
 */
export function operationalTaskMessages(
  messages: TaskMessage[],
): TaskMessage[] {
  return messages.filter((message) => OPERATIONAL_KINDS.has(message.kind));
}

/**
 * Whether the Durable conversation should replace the task-message transcript.
 * Loading and failed reads stay visible instead of looking like legacy data.
 * Attempts with no Durable content keep their recorded `text_delta` messages.
 */
export function hasConversationView(
  threads: TaskConversationThread[] | undefined,
): threads is TaskConversationThread[] {
  return Boolean(
    threads?.some(
      (thread) => thread.messages.length > 0 || thread.loading || thread.error,
    ),
  );
}

/** Orders committed messages by entry, keeping the partial response last. */
export function compareConversationMessages(
  a: TaskConversationMessage,
  b: TaskConversationMessage,
): number {
  if (a.entryId === null || b.entryId === null) {
    return a.entryId === null ? (b.entryId === null ? 0 : 1) : -1;
  }
  const byEntry = Number(a.entryId) - Number(b.entryId);
  if (byEntry !== 0) return byEntry;
  const index = (id: string) => Number(id.split('/')[1] ?? 0);
  return index(a.id) - index(b.id);
}
