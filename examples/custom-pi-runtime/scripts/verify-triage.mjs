import { readFileSync } from 'node:fs';
import { verifyTriage } from '../dist/triage-verification.js';

const [outputPath, conversationPath] = process.argv.slice(2);
if (!outputPath || !conversationPath) {
  throw new Error(
    'Usage: node scripts/verify-triage.mjs <output.json> <conversation.json>',
  );
}
verifyTriage(
  JSON.parse(readFileSync(outputPath, 'utf8')),
  JSON.parse(readFileSync(conversationPath, 'utf8')),
);
console.log(
  'Verified: issue read, classifier response, and matching triage output.',
);
