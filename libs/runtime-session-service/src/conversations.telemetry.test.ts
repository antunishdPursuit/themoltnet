import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import {
  createSession,
  MemoryStorage,
  type StorageWrite,
} from '@earendil-works/pi-durable';
import { KetoNamespace } from '@moltnet/auth';
import type * as OtelApi from '@opentelemetry/api';
import { describe, expect, it, vi } from 'vitest';

import { createConversationService } from './conversations.js';

const spans = vi.hoisted(
  () => [] as { attributes: Record<string, unknown>; ended: boolean }[],
);
vi.mock('@opentelemetry/api', async (importOriginal) => ({
  ...(await importOriginal<typeof OtelApi>()),
  trace: {
    getTracer: () => ({
      startActiveSpan: (_name: string, fn: (span: unknown) => unknown) => {
        const recorded = {
          attributes: {} as Record<string, unknown>,
          ended: false,
        };
        spans.push(recorded);
        return fn({
          setAttribute: (key: string, value: unknown) => {
            recorded.attributes[key] = value;
          },
          setAttributes: (values: Record<string, unknown>) => {
            Object.assign(recorded.attributes, values);
          },
          setStatus: () => {},
          end: () => {
            recorded.ended = true;
          },
        });
      },
    }),
  },
}));

const context = BACKGROUND_CONTEXT;
const input = {
  subjectId: 'agent',
  subjectType: 'agent' as const,
  subjectNs: KetoNamespace.Agent,
  teamId: 'team',
  taskId: 'task',
  attemptN: 1,
};

describe('conversation refresh telemetry', () => {
  it('records cold and incremental replay sizes on the refresh span', async () => {
    const commits: { seq: number; writes: StorageWrite[] }[] = [];
    class Writer extends MemoryStorage {
      override async commit(writes: readonly StorageWrite[]) {
        const seq = await super.commit(writes, context);
        commits.push({ seq, writes: [...writes] });
        return seq;
      }
    }
    const session = createSession(new Writer());
    await session.commit(
      (tx) => tx.createConversation({ ownership: { kind: 'ownerless' } }),
      context,
    );
    await session.commit(
      (tx) => tx.createConversation({ ownership: { kind: 'ownerless' } }),
      context,
    );
    const service = createConversationService({
      stores: {
        findAttempt: async () => ({ storeId: 'store' }),
        read: async ({ afterSeq }: { afterSeq: number }) => ({
          items: (async function* () {
            for (const commit of commits)
              if (commit.seq > afterSeq) yield commit;
          })(),
        }),
      },
      repository: {
        attemptBounds: async () => ({ firstSeq: 1, lastSeq: commits.length }),
        get: async () => null,
      },
      tasks: { findAttempt: async () => ({ status: 'completed' }) },
    } as unknown as Parameters<typeof createConversationService>[0]);

    const reader = await service.open(input);
    await session.commit(
      (tx) => tx.createConversation({ ownership: { kind: 'ownerless' } }),
      context,
    );
    await reader.refresh();
    await reader.close();
    await service.close();
    await session.close(context);

    expect(spans).toHaveLength(2);
    expect(spans[0]).toMatchObject({
      ended: true,
      attributes: {
        'moltnet.conversation.cold': true,
        'moltnet.conversation.commits_replayed': 2,
        'moltnet.conversation.pages': 1,
      },
    });
    expect(spans[1].attributes).toMatchObject({
      'moltnet.conversation.cold': false,
      'moltnet.conversation.commits_replayed': 1,
    });
    expect(
      spans[0].attributes['moltnet.conversation.replay_bytes'],
    ).toBeGreaterThan(0);
  });
});
