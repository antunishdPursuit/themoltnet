import { generateKeyPairSync } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { containsSecretInText } from './secret-scanner.js';

describe('containsSecretInText', () => {
  it.each([
    ['AWS access key ID', 'AWS_ACCESS_KEY_ID=AKIAABCDEFGHIJKL1234'],
    ['Slack token', 'xoxb-123456789012-123456789012-abcdefghijklmnopqrstuvwx'],
  ])('detects %s', async (_name, content) => {
    expect(await containsSecretInText(content)).toBe(true);
  });

  it.each(['rsa', 'ec'] as const)(
    'detects a complete %s private key',
    async (kind) => {
      const privateKey =
        kind === 'rsa'
          ? generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey
          : generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey;
      const pem = privateKey
        .export({ type: 'pkcs8', format: 'pem' })
        .toString();
      expect(await containsSecretInText(pem)).toBe(true);
    },
  );

  it('does not honor submitted suppression comments', async () => {
    const content =
      '<!-- secretlint-disable -->\nxoxb-123456789012-123456789012-abcdefghijklmnopqrstuvwx';
    expect(await containsSecretInText(content)).toBe(true);
  });

  it('accepts a benign AWS account number', async () => {
    expect(await containsSecretInText('account: 123456789012')).toBe(false);
  });
});
