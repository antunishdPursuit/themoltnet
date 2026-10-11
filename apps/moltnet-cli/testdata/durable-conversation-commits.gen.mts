// Regenerates durable-conversation-commits.json from pi-durable's own storage
// writes. Imports resolve from the script's directory, so run a copy placed in
// a package that depends on pi-durable (from the repository root):
//   cp apps/moltnet-cli/testdata/durable-conversation-commits.gen.mts \
//     libs/runtime-session-service/gen.tmp.mts
//   (cd libs/runtime-session-service && npx tsx gen.tmp.mts) \
//     > apps/moltnet-cli/testdata/durable-conversation-commits.json
//   rm libs/runtime-session-service/gen.tmp.mts
// The e2e test replaces __TASK_ID__ with the claimed task ID.

import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { createSession, defineDocFamily, MemoryStorage, type StorageWrite } from '@earendil-works/pi-durable';

const Attempts = defineDocFamily({
  kind: 'moltnet.attempt', version: 1, scope: 'session', family: true,
  initial: (conversationId: number) => ({ conversationId }),
});
const commits: StorageWrite[][] = [];
class Capture extends MemoryStorage {
  override async commit(writes: readonly StorageWrite[], ctx: typeof context) {
    commits.push(JSON.parse(JSON.stringify(writes)));
    return super.commit(writes, ctx);
  }
}
const session = createSession(new Capture());
const root = (await session.commit((tx) => tx.createConversation({ ownership: { kind: 'ownerless' } }), context)).id;
await session.commit(async (tx) => {
  await tx.doc(Attempts, '__TASK_ID__/1', root);
  await tx.appendEntry(root, { kind: 'pi.user', model: [{ role: 'user', content: 'List the workspace.', timestamp: 1 }] });
}, context);
await session.commit(async (tx) => {
  await tx.appendEntry(root, { kind: 'pi.assistant', model: [{ role: 'assistant', content: [
    { type: 'text', text: 'Listing files.' },
    { type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'ls' } },
  ], timestamp: 2 } as never] });
  await tx.appendEntry(root, { kind: 'pi.tool', model: [{ role: 'toolResult', toolCallId: 'call-1', toolName: 'bash', content: [{ type: 'text', text: 'README.md' }], isError: false, timestamp: 3 } as never] });
}, context);
await session.commit(async (tx) => {
  await tx.appendEntry(root, { kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'text', text: 'The workspace holds README.md.' }], timestamp: 4 } as never] });
}, context);
process.stdout.write(JSON.stringify(commits, null, 2) + '\n');
