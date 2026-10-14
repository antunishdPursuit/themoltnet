import { describe, expect, it } from 'vitest';
import { verifyTriage } from './triage-verification.js';

function fixture() {
  const result = {
    issueUrl: 'https://github.com/getlarge/themoltnet/issues/1886',
    category: 'feature',
    confidence: 0.9,
    probabilities: { bug: 0.05, feature: 0.9, question: 0.05 },
    summary: 'Add an issue reader.',
    nextStep: 'Review the read-only tool boundary.',
  };
  const tool = (toolName: string, value: unknown) => ({
    message: {
      role: 'toolResult',
      toolName,
      isError: false,
      content: [{ type: 'text', text: JSON.stringify(value) }],
    },
  });
  return {
    output: { result },
    conversation: {
      messages: [
        tool('github_issue_read', { url: result.issueUrl }),
        tool('classify', {
          version: 1,
          answers: {
            category: {
              type: 'choice',
              choice: result.category,
              confidence: result.confidence,
              probabilities: result.probabilities,
            },
          },
        }),
      ],
    },
  };
}

describe('triage evidence', () => {
  it('accepts the released classifier result without provider/model fields', () => {
    const { output, conversation } = fixture();
    expect(() => verifyTriage(output, conversation)).not.toThrow();
  });
  it('rejects valid-looking output without successful classification', () => {
    const { output, conversation } = fixture();
    conversation.messages[1].message.isError = true;
    expect(() => verifyTriage(output, conversation)).toThrow(
      'Missing successful classify',
    );
  });
  it('rejects a decision changed by the chat model', () => {
    const { output, conversation } = fixture();
    output.result.category = 'bug';
    expect(() => verifyTriage(output, conversation)).toThrow(
      'differs from classifier',
    );
  });
  it.each(['confidence', 'probabilities'] as const)(
    'rejects changed %s even when the category matches',
    (field) => {
      const { output, conversation } = fixture();
      if (field === 'confidence') output.result.confidence = 1;
      else output.result.probabilities.feature = 1;
      expect(() => verifyTriage(output, conversation)).toThrow(
        'differs from classifier',
      );
    },
  );
  it('requires complete history', () => {
    const { output, conversation } = fixture();
    expect(() =>
      verifyTriage(output, { ...conversation, nextBeforeEntryId: '20' }),
    ).toThrow('Collect all');
  });
});
