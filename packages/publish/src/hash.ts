import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

/** Streamed SHA-256 hex of a file. */
export function hashFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

export function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
