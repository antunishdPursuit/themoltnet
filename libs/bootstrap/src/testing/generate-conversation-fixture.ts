// Regenerate with: pnpm exec nx run @moltnet/bootstrap:generate:durable-fixture
import { writeFile } from 'node:fs/promises';

import {
  buildConversationFixtureCommits,
  CONVERSATION_FIXTURE_URL,
} from './conversation-fixture.js';

await writeFile(
  CONVERSATION_FIXTURE_URL,
  JSON.stringify(await buildConversationFixtureCommits(), null, 2) + '\n',
);
