import { type Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { StringDecoder } from 'node:string_decoder';

import { lintSource } from '@secretlint/core';
import { creator as azureRule } from '@secretlint/secretlint-rule-azure';
import { creator as patternRule } from '@secretlint/secretlint-rule-pattern';
import { rules as recommendedRules } from '@secretlint/secretlint-rule-preset-recommend';

const WINDOW_CHARS = 256 * 1024;
const OVERLAP_CHARS = 64 * 1024;
const LINE_LOOKAHEAD_CHARS = WINDOW_CHARS;
const MAX_REDACTION_CHARS = WINDOW_CHARS;

export class SecretScanInputTooLargeError extends Error {}

class SecretFoundError extends Error {}

// Submitted text is untrusted: a suppression comment must not bypass the gate.
const rules = [
  ...recommendedRules
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
    ),
  {
    id: azureRule.meta.id,
    rule: azureRule,
    allowMessageIds: ['AzureTenantId', 'AzureClientId'],
  },
  {
    id: patternRule.meta.id,
    rule: patternRule,
    options: {
      patterns: [
        {
          name: 'short PKCS8 private key',
          patterns: [
            '/-----BEGIN PRIVATE KEY-----\\s+[A-Za-z0-9+/=\\r\\n]{40,200}-----END PRIVATE KEY-----/',
          ],
        },
        {
          name: 'HTTP authorization value',
          patterns: ['/(?<=\\b(?:Bearer|Basic)\\s)[A-Za-z0-9._~+\\/=-]{16,}/i'],
        },
        {
          name: 'JWT',
          patterns: [
            '/\\beyJ[A-Za-z0-9_-]{20,}\\.[A-Za-z0-9_-]{20,}\\.[A-Za-z0-9_-]{20,}\\b/',
          ],
        },
        {
          name: 'provider and GitHub tokens',
          patterns: [
            '/\\bsk-[A-Za-z0-9]{20,}\\b/',
            '/\\bgh[pousr]_[A-Za-z0-9]{20,}\\b/',
          ],
        },
      ],
    },
  },
];

async function secretRanges(content: string): Promise<[number, number][]> {
  const result = await lintSource({
    source: {
      content,
      contentType: 'text',
      ext: '.txt',
      filePath: 'submitted-text.txt',
    },
    options: {
      config: { rules },
      // Findings stay in memory; unmasked data lets us correct rules that
      // report a span beginning at the field name instead of the secret.
      maskSecrets: false,
      noPhysicFilePath: true,
    },
  });
  return result.messages
    .filter((message) => message.type === 'message')
    .map((message): [number, number] => {
      if (
        message.ruleId === azureRule.meta.id &&
        message.messageId === 'AzureClientSecret'
      ) {
        const secret = (message.data as Record<string, unknown> | undefined)
          ?.SECRET;
        if (typeof secret === 'string') {
          const start = content.indexOf(secret, message.range[0]);
          if (start >= 0 && start <= message.range[1] + 256) {
            return [start, start + secret.length];
          }
        }
        return [0, content.length];
      }
      return message.range as [number, number];
    });
}

/** Scan untrusted text before persistence. The caller must bound input size. */
export async function containsSecretInText(content: string): Promise<boolean> {
  return (await secretRanges(content)).length > 0;
}

/** Replace only ranges reported by Secretlint, preserving surrounding context. */
export async function redactSecretsInText(content: string): Promise<string> {
  if (content.length > MAX_REDACTION_CHARS) return '[redacted]';
  const ranges = (await secretRanges(content)).sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const [start, end] of ranges) {
    const last = merged.at(-1);
    if (last && start <= last[1]) {
      last[1] = Math.max(last[1], end);
    } else {
      merged.push([start, end]);
    }
  }
  let end = 0;
  let redacted = '';
  for (const [start, nextEnd] of merged) {
    redacted += content.slice(end, start) + '[redacted]';
    end = nextEnd;
  }
  return redacted + content.slice(end);
}

/** Scan a bounded byte stream. The optional transform can decode compression. */
export async function containsSecretInStream(
  source: Readable,
  maxBytes: number,
  decoder?: Transform,
): Promise<boolean> {
  const scanner = new SecretScanTransform(maxBytes);
  try {
    if (decoder) {
      await pipeline(source, decoder, scanner);
    } else {
      await pipeline(source, scanner);
    }
  } catch (error) {
    if (scanner.found || error instanceof SecretFoundError) return true;
    throw error;
  }
  return false;
}

class SecretScanTransform extends Transform {
  found = false;
  private readonly textDecoder = new StringDecoder('utf8');
  private pending = '';
  private bytesSeen = 0;

  constructor(private readonly maxBytes: number) {
    super();
  }

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    void this.scanChunk(chunk).then(() => callback(), callback);
  }

  override _flush(callback: (error?: Error | null) => void): void {
    void this.scanRemaining().then(() => callback(), callback);
  }

  private async scanChunk(chunk: Buffer): Promise<void> {
    this.bytesSeen += chunk.byteLength;
    if (this.bytesSeen > this.maxBytes) {
      throw new SecretScanInputTooLargeError();
    }
    this.pending += this.textDecoder.write(chunk);
    while (this.pending.length >= WINDOW_CHARS) {
      // Prefer a complete line near the target window boundary. A long line
      // eventually falls back to fixed windows so buffering stays bounded.
      const newline = this.pending.indexOf('\n', WINDOW_CHARS - OVERLAP_CHARS);
      const lookaheadLimit = WINDOW_CHARS + LINE_LOOKAHEAD_CHARS;
      if (newline < 0 && this.pending.length < lookaheadLimit) return;
      const scanEnd =
        newline >= 0 && newline < lookaheadLimit ? newline + 1 : WINDOW_CHARS;
      if (await containsSecretInText(this.pending.slice(0, scanEnd))) {
        this.found = true;
        throw new SecretFoundError();
      }
      let overlapStart = scanEnd - OVERLAP_CHARS;
      const lineStart = this.pending.lastIndexOf('\n', overlapStart - 1) + 1;
      if (lineStart > 0 && scanEnd - lineStart <= WINDOW_CHARS) {
        overlapStart = lineStart;
      }
      this.pending = this.pending.slice(overlapStart);
    }
  }

  private async scanRemaining(): Promise<void> {
    this.pending += this.textDecoder.end();
    if (this.pending && (await containsSecretInText(this.pending))) {
      this.found = true;
      throw new SecretFoundError();
    }
  }
}
