import assert from 'node:assert/strict';

interface TriageResult {
  issueUrl: string;
  category: string;
  confidence: number;
  probabilities: Record<string, number>;
  classifierProvider: string;
  classifierModel: string;
  summary: string;
  nextStep: string;
}
interface ToolResult {
  url?: string;
  provider?: string;
  model?: string;
  answers?: Record<
    string,
    {
      type: string;
      choice: string;
      confidence: number;
      probabilities: Record<string, number>;
    }
  >;
}
interface Conversation {
  nextBeforeEntryId?: string | null;
  messages: Array<{
    message: {
      role: string;
      toolName?: string;
      isError?: boolean;
      content?: Array<{ type: string; text?: string }>;
    };
  }>;
}

/** Verify persisted tool results, not the chat model's claims about its work. */
export function verifyTriage(
  output: { result: TriageResult },
  conversation: Conversation,
): void {
  assert(
    !conversation.nextBeforeEntryId,
    'Collect all conversation pages first',
  );
  const results = (name: string): ToolResult[] =>
    conversation.messages
      .map((item) => item.message)
      .filter(
        (message) =>
          message.role === 'toolResult' &&
          message.toolName === name &&
          !message.isError,
      )
      .flatMap((message) =>
        (message.content ?? [])
          .filter((block) => block.type === 'text' && block.text)
          .map((block) => JSON.parse(block.text!) as ToolResult),
      );
  const readers = results('github_issue_read');
  const classifiers = results('classify');
  assert(readers.length > 0, 'Missing successful github_issue_read result');
  assert(classifiers.length > 0, 'Missing successful classify result');
  const result = output.result;
  assert(
    readers.some((issue) => issue.url === result.issueUrl),
    'Issue URL differs from reader result',
  );
  assert(
    classifiers.some((classified) => {
      const answer = classified.answers?.category;
      return (
        classified.provider === result.classifierProvider &&
        classified.model === result.classifierModel &&
        answer?.type === 'choice' &&
        answer.choice === result.category &&
        answer.confidence === result.confidence &&
        Object.keys(answer.probabilities).length ===
          Object.keys(result.probabilities).length &&
        Object.entries(answer.probabilities).every(
          ([key, value]) => result.probabilities[key] === value,
        )
      );
    }),
    'Submitted classification differs from classifier result',
  );
  assert(result.summary.trim().length > 0, 'Missing chat summary');
  assert(result.nextStep.trim().length > 0, 'Missing suggested next step');
}
