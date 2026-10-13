import { readFile } from 'node:fs/promises';
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';

import { lintSource } from '@secretlint/core';
import { rules as recommendedRules } from '@secretlint/secretlint-rule-preset-recommend';

// Uploaded content is untrusted. A user-authored suppression comment must not
// switch off the storage gate.
const rules = recommendedRules
  .filter(
    (rule) => rule.meta.id !== '@secretlint/secretlint-rule-filter-comments',
  )
  .map((rule) => ({ id: rule.meta.id, rule }));

// Secretlint leaves AWS ID scanning off by default because it also flags bare
// account numbers; detect only the strongly shaped access key IDs here.
const AWS_ACCESS_KEY_ID =
  /\b(?:A3T[A-Z0-9]|AKIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASIA)[A-Z0-9]{16}\b/;
// Secretlint validates some PEM types but can miss EC and Ed25519 keys.
const PRIVATE_KEY_HEADER =
  /-----BEGIN (?:ENCRYPTED )?(?:EC |RSA |OPENSSH )?PRIVATE KEY-----/i;

/** The staging layer enforces the byte limit before this bounded read. */
export async function containsArtifactSecret(
  filePath: string,
  contentEncoding: string | null | undefined,
  maxBytes: number,
): Promise<boolean> {
  const bytes = await readFile(filePath);
  if (await containsSecretInText(bytes.toString('utf8'))) return true;

  const declaredEncoding = contentEncoding?.trim().toLowerCase();
  const gzipMagic = bytes[0] === 0x1f && bytes[1] === 0x8b;
  const encoding =
    declaredEncoding && declaredEncoding !== 'identity'
      ? declaredEncoding
      : gzipMagic
        ? 'gzip'
        : undefined;
  if (!encoding) return false;
  let decoded: Buffer;
  try {
    const options = { maxOutputLength: maxBytes };
    switch (encoding) {
      case 'gzip':
        decoded = gunzipSync(bytes, options);
        break;
      case 'br':
        decoded = brotliDecompressSync(bytes, options);
        break;
      case 'deflate':
        decoded = inflateSync(bytes, options);
        break;
      default:
        throw new InvalidArtifactEncodingError();
    }
  } catch {
    throw new InvalidArtifactEncodingError();
  }
  return containsSecretInText(decoded.toString('utf8'));
}

export class InvalidArtifactEncodingError extends Error {}

async function containsSecretInText(content: string): Promise<boolean> {
  if (AWS_ACCESS_KEY_ID.test(content) || PRIVATE_KEY_HEADER.test(content)) {
    return true;
  }

  const result = await lintSource({
    source: {
      content,
      contentType: 'text',
      ext: '.txt',
      filePath: 'artifact.txt',
    },
    options: {
      config: { rules },
      maskSecrets: true,
      noPhysicFilePath: true,
    },
  });
  return result.messages.some((message) => message.type === 'message');
}
