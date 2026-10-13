import { type Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { StringDecoder } from 'node:string_decoder';

import { lintSource } from '@secretlint/core';
import { rules as recommendedRules } from '@secretlint/secretlint-rule-preset-recommend';

const WINDOW_CHARS = 256 * 1024;
const OVERLAP_CHARS = 64 * 1024;

export class SecretScanInputTooLargeError extends Error {}

class SecretFoundError extends Error {}

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
      if (await containsSecretInText(this.pending.slice(0, WINDOW_CHARS))) {
        this.found = true;
        throw new SecretFoundError();
      }
      this.pending = this.pending.slice(WINDOW_CHARS - OVERLAP_CHARS);
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
