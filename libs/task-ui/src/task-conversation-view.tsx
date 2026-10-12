import {
  Badge,
  Button,
  Disclosure,
  Stack,
  Text,
  useTheme,
  VisuallyHidden,
} from '@themoltnet/design-system';
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';

import {
  type ConversationBlock,
  type ConversationItem,
  type TaskConversationMessage,
  type TaskConversationThread,
  toConversationItems,
} from './conversation.js';
import { JsonViewer } from './json-viewer.js';

type Theme = ReturnType<typeof useTheme>;

/** Tool results longer than this start collapsed. */
const LONG_RESULT_CHARS = 600;

export interface TaskConversationViewProps {
  /** Main conversation first; subagent threads render as collapsible blocks. */
  threads: TaskConversationThread[];
  /** When true, follows the latest line (live attempts). */
  live?: boolean;
  loading?: boolean;
  error?: string;
  onRetry?: () => void;
}

function roleLabel(role: string): string {
  switch (role) {
    case 'user':
      return 'User';
    case 'assistant':
      return 'Assistant';
    case 'toolResult':
      return 'Tool result';
    default:
      return role;
  }
}

function StatusBadge({ message }: { message: TaskConversationMessage }) {
  switch (message.status) {
    case 'streaming':
      return <Badge variant="info">Streaming</Badge>;
    case 'interrupted':
      return <Badge variant="warning">Interrupted</Badge>;
    case 'failed':
      return <Badge variant="error">Failed</Badge>;
    default:
      return null;
  }
}

function ToolBlock({
  block,
  pending,
  theme,
}: {
  block: Extract<ConversationBlock, { type: 'tool' }>;
  pending: boolean;
  theme: Theme;
}) {
  const result = block.result;
  const tone = result?.isError
    ? theme.color.error.DEFAULT
    : theme.color.border.DEFAULT;
  return (
    <div
      style={{
        border: `1px solid ${tone}`,
        borderRadius: theme.radius.md,
        padding: theme.spacing[2],
      }}
    >
      <Stack gap={1}>
        <Stack direction="row" align="center" gap={2} wrap>
          <Text
            variant="caption"
            style={{
              color: theme.color.accent.DEFAULT,
              fontFamily: theme.font.family.mono,
            }}
          >
            {block.name}
          </Text>
          {result ? (
            result.isError ? (
              <Badge variant="error">Error</Badge>
            ) : (
              <Badge variant="success">Done</Badge>
            )
          ) : pending ? (
            <Badge variant="info">Running</Badge>
          ) : (
            <Badge>No result</Badge>
          )}
        </Stack>
        <JsonViewer value={block.arguments ?? {}} label="Arguments" />
        {result ? <ResultText text={result.text} theme={theme} /> : null}
      </Stack>
    </div>
  );
}

function ResultText({ text, theme }: { text: string; theme: Theme }) {
  if (!text) return null;
  const body = (
    <pre
      style={{
        margin: 0,
        whiteSpace: 'pre-wrap',
        overflowWrap: 'anywhere',
        fontFamily: theme.font.family.mono,
        fontSize: theme.font.size.xs,
        color: theme.color.text.secondary,
      }}
    >
      {text}
    </pre>
  );
  return text.length > LONG_RESULT_CHARS ? (
    <Disclosure summary="Result" hint={`${text.length} characters`}>
      {body}
    </Disclosure>
  ) : (
    body
  );
}

function Item({
  item,
  live,
  theme,
}: {
  item: ConversationItem;
  live: boolean;
  theme: Theme;
}) {
  const { message } = item;
  const pending =
    live && message.status !== 'interrupted' && message.status !== 'failed';
  return (
    <div
      data-conversation-message={message.id}
      style={{
        borderLeft: `2px solid ${
          item.role === 'user'
            ? theme.color.primary.DEFAULT
            : theme.color.border.DEFAULT
        }`,
        paddingLeft: theme.spacing[3],
      }}
    >
      <Stack gap={2}>
        <Stack direction="row" align="center" gap={2} wrap>
          <Text
            variant="caption"
            color="muted"
            style={{ fontFamily: theme.font.family.mono }}
          >
            {roleLabel(item.role)}
          </Text>
          <StatusBadge message={message} />
        </Stack>
        {item.blocks.map((block, index) => {
          const key = `${message.id}-${index}`;
          switch (block.type) {
            case 'text':
              return (
                <Text key={key} style={{ whiteSpace: 'pre-wrap' }}>
                  {block.text}
                </Text>
              );
            case 'thinking':
              return (
                <Disclosure key={key} summary="Thinking">
                  <Text color="muted" style={{ whiteSpace: 'pre-wrap' }}>
                    {block.text}
                  </Text>
                </Disclosure>
              );
            case 'tool':
              return (
                <ToolBlock
                  key={key}
                  block={block}
                  pending={pending && !block.result}
                  theme={theme}
                />
              );
            case 'toolResult':
              return (
                <Stack key={key} gap={1}>
                  <Stack direction="row" align="center" gap={2}>
                    <Text
                      variant="caption"
                      style={{
                        color: theme.color.accent.DEFAULT,
                        fontFamily: theme.font.family.mono,
                      }}
                    >
                      {block.name}
                    </Text>
                    {block.isError ? (
                      <Badge variant="error">Error</Badge>
                    ) : null}
                  </Stack>
                  <ResultText text={block.text} theme={theme} />
                </Stack>
              );
          }
        })}
        {message.status === 'interrupted' && message.entryId === null ? (
          <Text variant="caption" color="muted">
            The runtime stopped before this response was committed.
          </Text>
        ) : null}
      </Stack>
    </div>
  );
}

function Thread({
  thread,
  live,
  theme,
  onBeforeLoadOlder,
}: {
  onBeforeLoadOlder?: () => void;
  thread: TaskConversationThread;
  live: boolean;
  theme: Theme;
}) {
  const items = useMemo(
    () => toConversationItems(thread.messages),
    [thread.messages],
  );
  const inherited = items.filter((item) => item.message.inherited);
  const own = items.filter((item) => !item.message.inherited);

  if (thread.loading && !thread.retrying && items.length === 0) {
    return (
      <Text variant="caption" color="muted">
        Loading conversation…
      </Text>
    );
  }

  return (
    <Stack gap={3}>
      {thread.error || thread.retrying ? (
        <div role="status">
          <Text variant="caption" color="muted">
            {thread.error
              ? 'This conversation could not be loaded.'
              : 'Live updates unavailable. Retrying…'}
          </Text>
          {thread.onRetry ? (
            <Button variant="ghost" size="sm" onClick={thread.onRetry}>
              Retry conversation
            </Button>
          ) : null}
        </div>
      ) : null}
      {thread.onLoadOlder ? (
        <div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              onBeforeLoadOlder?.();
              thread.onLoadOlder?.();
            }}
            disabled={thread.loadingOlder}
          >
            {thread.loadingOlder ? 'Loading older messages…' : 'Load older'}
          </Button>
        </div>
      ) : null}
      {inherited.length > 0 ? (
        <Disclosure
          summary="Context from earlier attempts"
          hint={`${inherited.length} ${
            inherited.length === 1 ? 'message' : 'messages'
          }, not part of this attempt`}
        >
          <Stack gap={3}>
            {inherited.map((item) => (
              <Item
                key={item.message.id}
                item={item}
                live={false}
                theme={theme}
              />
            ))}
          </Stack>
        </Disclosure>
      ) : null}
      {own.map((item) => (
        <Item key={item.message.id} item={item} live={live} theme={theme} />
      ))}
    </Stack>
  );
}

function SubagentThread({
  thread,
  live,
  theme,
}: {
  thread: TaskConversationThread;
  live: boolean;
  theme: Theme;
}) {
  const onExpandedChange = useRef(thread.onExpandedChange);
  onExpandedChange.current = thread.onExpandedChange;
  // Tabs and pane collapse unmount disclosures without firing a toggle event.
  useEffect(() => () => onExpandedChange.current?.(false), []);
  return (
    <Disclosure
      onOpenChange={thread.onExpandedChange}
      summary={`Subagent conversation ${thread.summary.conversationId}`}
      hint={`${thread.messages.length} ${thread.messages.length === 1 ? 'message' : 'messages'}`}
    >
      <Thread
        thread={thread}
        live={live && thread.live !== false}
        theme={theme}
      />
    </Disclosure>
  );
}

/** Screen-reader status for the main thread: changes only on state changes. */
function liveStatus(thread: TaskConversationThread | undefined): string {
  const last = thread?.messages.at(-1);
  if (!last || last.entryId !== null) return '';
  return last.status === 'streaming'
    ? 'Agent is responding.'
    : 'Agent response was interrupted.';
}

export function TaskConversationView({
  threads,
  live: requestedLive = false,
  loading,
  error,
  onRetry,
}: TaskConversationViewProps) {
  const theme = useTheme();
  const endRef = useRef<HTMLDivElement>(null);
  const main = threads.find((thread) => thread.summary.kind === 'main');
  const live = requestedLive && main?.live !== false;
  const subagents = threads.filter((thread) => thread !== main);
  const rootRef = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const anchor = useRef<{ element: HTMLElement; top: number } | null>(null);

  // The view lives either in the page or in a bounded task pane.
  function scrollContainer(): HTMLElement | null {
    let element = rootRef.current?.parentElement ?? null;
    while (element) {
      if (/(auto|scroll)/.test(getComputedStyle(element).overflowY))
        return element;
      element = element.parentElement;
    }
    return null;
  }
  useEffect(() => {
    const container = scrollContainer();
    const target = container ?? window;
    const onScroll = () => {
      const bottom =
        container?.getBoundingClientRect().bottom ?? window.innerHeight;
      const end = endRef.current?.getBoundingClientRect();
      following.current = !!end && end.bottom <= bottom + 40 && end.bottom >= 0;
    };
    target.addEventListener('scroll', onScroll, { passive: true });
    return () => target.removeEventListener('scroll', onScroll);
  }, []);

  function beforeLoadOlder() {
    following.current = false;
    const top = scrollContainer()?.getBoundingClientRect().top ?? 0;
    const element = Array.from(
      rootRef.current?.querySelectorAll<HTMLElement>(
        '[data-conversation-message]',
      ) ?? [],
    ).find((element) => element.getBoundingClientRect().bottom > top);
    if (element)
      anchor.current = { element, top: element.getBoundingClientRect().top };
  }
  useLayoutEffect(() => {
    if (anchor.current) {
      const { element, top } = anchor.current;
      const delta = element.getBoundingClientRect().top - top;
      const container = scrollContainer();
      if (delta) {
        if (container) container.scrollTop += delta;
        else window.scrollBy(0, delta);
      }
      if (!main?.loadingOlder) anchor.current = null;
    } else if (live && following.current) {
      endRef.current?.scrollIntoView?.({ block: 'end' });
    }
  }, [live, main?.messages, main?.loadingOlder]);

  return (
    <div ref={rootRef} style={{ padding: theme.spacing[3] }}>
      {/* Snapshots replace the transcript about once a second; announcing
          them would flood assistive tech, so only the stream state is live. */}
      <VisuallyHidden role="status">{liveStatus(main)}</VisuallyHidden>
      <Stack gap={4}>
        {error ? (
          <div role="status">
            <Text color="muted">{error}</Text>
            {onRetry ? (
              <Button variant="ghost" size="sm" onClick={onRetry}>
                Retry conversations
              </Button>
            ) : null}
          </div>
        ) : null}
        {loading ? <Text color="muted">Loading conversations…</Text> : null}
        {main ? (
          <Thread
            thread={main}
            live={live}
            theme={theme}
            onBeforeLoadOlder={beforeLoadOlder}
          />
        ) : null}
        <div ref={endRef} />
        {subagents.map((thread) => (
          <SubagentThread
            key={thread.summary.conversationId}
            thread={thread}
            live={live}
            theme={theme}
          />
        ))}
      </Stack>
    </div>
  );
}
