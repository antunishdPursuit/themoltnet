// Regenerate with: pnpm exec nx run @moltnet/bootstrap:generate:durable-fixture
import { writeFile } from 'node:fs/promises';

import type { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { MemoryStorage, type StorageWrite } from '@earendil-works/pi-durable';

import { assistantMessage, createDurableSeed } from './durable.js';

const commits: StorageWrite[][] = [];
class Capture extends MemoryStorage {
  override async commit(writes: readonly StorageWrite[], ctx: typeof context) {
    commits.push(JSON.parse(JSON.stringify(writes)) as StorageWrite[]);
    return super.commit(writes, ctx);
  }
}
const seed = await createDurableSeed(
  new Capture(),
  { taskId: '__TASK_ID__', attemptN: 1 },
  [
    {
      kind: 'pi.user',
      model: [{ role: 'user', content: 'List the workspace.', timestamp: 1 }],
    },
  ],
);
await seed.append([
  {
    kind: 'pi.assistant',
    model: [
      {
        ...assistantMessage('Listing files.', 2),
        stopReason: 'toolUse',
        content: [
          { type: 'text', text: 'Listing files.' },
          {
            type: 'toolCall',
            id: 'call-1',
            name: 'bash',
            arguments: { command: 'ls' },
          },
        ],
      },
    ],
  },
  {
    kind: 'pi.tool',
    model: [
      {
        role: 'toolResult',
        toolCallId: 'call-1',
        toolName: 'bash',
        content: [{ type: 'text', text: 'README.md' }],
        isError: false,
        timestamp: 3,
      },
    ],
  },
]);
await seed.append([
  {
    kind: 'pi.assistant',
    model: [assistantMessage('The workspace holds README.md.', 4)],
  },
]);
await seed.close();
await writeFile(
  new URL(
    '../../../../apps/moltnet-cli/testdata/durable-conversation-commits.json',
    import.meta.url,
  ),
  JSON.stringify(commits, null, 2) + '\n',
);
