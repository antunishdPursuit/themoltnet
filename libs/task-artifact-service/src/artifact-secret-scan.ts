import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { brotliDecompress, gunzip, inflate } from 'node:zlib';

import { containsSecretInText } from '@moltnet/secret-scanner';

const decompressBrotli = promisify(brotliDecompress);
const decompressGzip = promisify(gunzip);
const decompressDeflate = promisify(inflate);

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
        decoded = await decompressGzip(bytes, options);
        break;
      case 'br':
        decoded = await decompressBrotli(bytes, options);
        break;
      case 'deflate':
        decoded = await decompressDeflate(bytes, options);
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
