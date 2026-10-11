import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useTaskConversations } from '../src/tasks/useTaskConversations.js';

const mocks = vi.hoisted(() => ({
  getTaskConversation: vi.fn(),
  useQuery: vi.fn(),
  watch: vi.fn(),
}));

vi.mock('@moltnet/api-client', () => ({
  getTaskConversation: mocks.getTaskConversation,
}));

vi.mock('@moltnet/api-client/query', () => ({
  listTaskConversationsOptions: () => ({ queryKey: ['conversations'] }),
}));

vi.mock('@tanstack/react-query', () => ({ useQuery: mocks.useQuery }));

vi.mock('../src/tasks/conversation-stream.js', () => ({
  isLiveAttemptStatus: (status?: string) =>
    status === 'claimed' || status === 'running',
  watchConversationSnapshots: mocks.watch,
}));

const client = { kind: 'console-client' } as never;
const base = {
  client,
  teamId: 'team',
  taskId: 'task',
  attemptN: 1,
};

function snapshot(text: string, nextBeforeEntryId: string | null = null) {
  return {
    conversationId: '1',
    cursor: text,
    attemptStatus: 'running',
    live: {},
    nextBeforeEntryId,
    messages: [
      {
        id: '5/0',
        entryId: '5',
        entryKind: 'pi.message',
        inherited: false,
        status: 'completed',
        message: { role: 'assistant', content: [{ type: 'text', text }] },
      },
    ],
  };
}

describe('useTaskConversations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useQuery.mockReturnValue({
      data: {
        items: [
          { conversationId: '1', parentConversationId: null, kind: 'main' },
        ],
      },
    });
    mocks.watch.mockImplementation(() => new Promise(() => {}));
    mocks.getTaskConversation.mockResolvedValue({ data: snapshot('final') });
  });

  it('follows live attempts and aborts the stream on unmount', () => {
    const { unmount } = renderHook(() =>
      useTaskConversations({ ...base, attemptStatus: 'running' }),
    );

    expect(mocks.watch).toHaveBeenCalledTimes(1);
    const { signal, conversationId, teamId } = mocks.watch.mock.calls[0][0];
    expect({ conversationId, teamId }).toEqual({
      conversationId: '1',
      teamId: 'team',
    });
    expect(signal.aborted).toBe(false);

    unmount();

    expect(signal.aborted).toBe(true);
  });

  it('stops streaming and reads once when the attempt turns terminal', async () => {
    const { rerender, result } = renderHook(
      (status: string) =>
        useTaskConversations({ ...base, attemptStatus: status }),
      { initialProps: 'running' },
    );
    const { signal } = mocks.watch.mock.calls[0][0];

    rerender('completed');

    expect(signal.aborted).toBe(true);
    expect(mocks.watch).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(result.current.threads?.[0]?.messages).toHaveLength(1),
    );
    expect(mocks.getTaskConversation).toHaveBeenCalledTimes(1);
  });

  it('replaces messages with each snapshot', async () => {
    const { result } = renderHook(() =>
      useTaskConversations({ ...base, attemptStatus: 'running' }),
    );
    const { onSnapshot } = mocks.watch.mock.calls[0][0];

    onSnapshot(snapshot('first'));
    onSnapshot(snapshot('second'));

    await waitFor(() =>
      expect(result.current.threads?.[0]?.messages[0]?.message).toMatchObject({
        content: [{ text: 'second' }],
      }),
    );
    expect(result.current.threads?.[0]?.messages).toHaveLength(1);
  });

  it('loads older entries on demand with the snapshot cursor', async () => {
    mocks.getTaskConversation.mockResolvedValue({
      data: {
        ...snapshot('older'),
        nextBeforeEntryId: null,
        messages: [
          {
            ...snapshot('older').messages[0],
            id: '2/0',
            entryId: '2',
          },
        ],
      },
    });
    const { result } = renderHook(() =>
      useTaskConversations({ ...base, attemptStatus: 'running' }),
    );
    mocks.watch.mock.calls[0][0].onSnapshot(snapshot('latest', '5'));
    await waitFor(() =>
      expect(result.current.threads?.[0]?.onLoadOlder).toBeDefined(),
    );

    result.current.threads?.[0]?.onLoadOlder?.();

    await waitFor(() =>
      expect(result.current.threads?.[0]?.messages.map((m) => m.id)).toEqual([
        '2/0',
        '5/0',
      ]),
    );
    expect(mocks.getTaskConversation).toHaveBeenCalledWith(
      expect.objectContaining({ query: { beforeEntryId: '5' } }),
    );
    expect(result.current.threads?.[0]?.onLoadOlder).toBeUndefined();
  });

  it('reports no conversation for attempts without one', () => {
    mocks.useQuery.mockReturnValue({ data: undefined, error: { status: 404 } });

    const { result } = renderHook(() =>
      useTaskConversations({ ...base, attemptStatus: 'completed' }),
    );

    expect(result.current.threads).toBeUndefined();
    expect(mocks.watch).not.toHaveBeenCalled();
    expect(mocks.getTaskConversation).not.toHaveBeenCalled();
  });
});
