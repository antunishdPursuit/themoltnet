import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';

import {
  containsSecretInStream,
  SecretScanInputTooLargeError,
} from '@moltnet/secret-scanner';

/** The staging layer enforces the encoded byte limit before this scan. */
export async function containsArtifactSecret(
  filePath: string,
  contentEncoding: string | null | undefined,
  maxBytes: number,
): Promise<boolean> {
  if (await containsSecretInStream(createReadStream(filePath), maxBytes)) {
    return true;
  }

  const declaredEncoding = contentEncoding?.trim().toLowerCase();
  const gzipMagic = await hasGzipMagic(filePath);
  const encoding =
    declaredEncoding && declaredEncoding !== 'identity'
      ? declaredEncoding
      : gzipMagic
        ? 'gzip'
        : undefined;
  if (!encoding) return false;

  const decoder =
    encoding === 'gzip'
      ? createGunzip()
      : encoding === 'br'
        ? createBrotliDecompress()
        : encoding === 'deflate'
          ? createInflate()
          : null;
  if (!decoder) throw new InvalidArtifactEncodingError();

  try {
    return await containsSecretInStream(
      createReadStream(filePath),
      maxBytes,
      decoder,
    );
  } catch (error) {
    if (error instanceof SecretScanInputTooLargeError || isZlibError(error)) {
      throw new InvalidArtifactEncodingError();
    }
    throw error;
  }
}

export class InvalidArtifactEncodingError extends Error {}

async function hasGzipMagic(filePath: string): Promise<boolean> {
  const file = await open(filePath, 'r');
  try {
    const magic = Buffer.alloc(2);
    const { bytesRead } = await file.read(magic, 0, 2, 0);
    return bytesRead === 2 && magic[0] === 0x1f && magic[1] === 0x8b;
  } finally {
    await file.close();
  }
}

function isZlibError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string' &&
    (error.code.startsWith('Z_') ||
      error.code.startsWith('ERR_BROTLI_') ||
      error.code.startsWith('ERR__ERROR_'))
  );
}
