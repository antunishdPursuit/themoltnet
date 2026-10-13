import { lintSource } from '@secretlint/core';
import { rules as recommendedRules } from '@secretlint/secretlint-rule-preset-recommend';

// Submitted text is untrusted: a suppression comment must not bypass the gate.
const rules = recommendedRules
  .filter(
    (rule) => rule.meta.id !== '@secretlint/secretlint-rule-filter-comments',
  )
  .map((rule) =>
    rule.meta.id === '@secretlint/secretlint-rule-aws'
      ? {
          id: rule.meta.id,
          rule,
          options: { enableIDScanRule: true },
          allowMessageIds: ['AWSAccountID'],
        }
      : { id: rule.meta.id, rule },
  );

/** Scan untrusted text before persistence. The caller must bound input size. */
export async function containsSecretInText(content: string): Promise<boolean> {
  const result = await lintSource({
    source: {
      content,
      contentType: 'text',
      ext: '.txt',
      filePath: 'submitted-text.txt',
    },
    options: {
      config: { rules },
      maskSecrets: true,
      noPhysicFilePath: true,
    },
  });
  return result.messages.some((message) => message.type === 'message');
}
