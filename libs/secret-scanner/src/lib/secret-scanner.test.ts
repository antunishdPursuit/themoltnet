import { generateKeyPairSync } from 'node:crypto';
import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import {
  containsSecretInStream,
  containsSecretInText,
  SecretScanInputTooLargeError,
} from './secret-scanner.js';

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

describe('containsSecretInStream', () => {
  it('detects an access key split across byte chunks', async () => {
    const source = Readable.from([
      Buffer.from('AWS_ACCESS_KEY_ID=AKIAABCDE'),
      Buffer.from('FGHIJKL1234'),
    ]);
    expect(await containsSecretInStream(source, 1024)).toBe(true);
  });

  it('detects a PEM block crossing scan windows', async () => {
    const pem = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
      .privateKey.export({ type: 'pkcs8', format: 'pem' })
      .toString();
    const source = Readable.from([
      Buffer.from('a'.repeat(256 * 1024 - 40)),
      Buffer.from(pem),
    ]);
    expect(await containsSecretInStream(source, 300 * 1024)).toBe(true);
  });

  it('accepts ordinary text split across chunks', async () => {
    const source = Readable.from([
      Buffer.from('molt-api deployed in '),
      Buffer.from('eu-west-1'),
    ]);
    expect(await containsSecretInStream(source, 1024)).toBe(false);
  });

  it('rejects a stream larger than its byte limit', async () => {
    const source = Readable.from([Buffer.alloc(1025, 'a')]);
    await expect(containsSecretInStream(source, 1024)).rejects.toBeInstanceOf(
      SecretScanInputTooLargeError,
    );
  });
});
