import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { type ObjectStore, type PutOptions, UnsupportedError } from './store.js';

const execFileAsync = promisify(execFile);

/**
 * Fallback transport: one `wrangler r2 object ...` process per object through the logged-in
 * wrangler CLI (no API keys needed). Slow, cannot HEAD or list, so it relies on the state file to
 * skip uploads and cannot prune or unpublish. Enabled with `R2_TRANSPORT=wrangler`.
 */
export class WranglerStore implements ObjectStore {
  readonly name: string;
  constructor(private readonly bucket: string) {
    this.name = `wrangler:${bucket}`;
  }

  private run(args: string[]): Promise<{ stdout: string; stderr: string }> {
    return execFileAsync('wrangler', ['r2', 'object', ...args, '--remote'], { maxBuffer: 64 * 1024 * 1024 });
  }

  async exists(): Promise<boolean> {
    return false; // no HEAD; the state file is the only skip
  }

  async put(key: string, body: Uint8Array, options: PutOptions): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), 'pb-wrangler-'));
    const file = join(dir, 'body');
    try {
      await writeFile(file, body);
      await this.run([
        'put',
        `${this.bucket}/${key}`,
        '--file',
        file,
        '--content-type',
        options.contentType,
        '--cache-control',
        options.cacheControl,
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async get(key: string): Promise<Uint8Array | null> {
    const dir = await mkdtemp(join(tmpdir(), 'pb-wrangler-'));
    const file = join(dir, 'body');
    try {
      await this.run(['get', `${this.bucket}/${key}`, '--file', file]);
      return new Uint8Array(await readFile(file));
    } catch (err) {
      const msg = String((err as { stderr?: string }).stderr ?? err);
      if (/not found|does not exist|404/i.test(msg)) return null;
      throw err;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async list(): Promise<string[]> {
    throw new UnsupportedError('Listing objects needs the S3 transport (R2 API keys); see docs/PUBLISHING.md');
  }

  async delete(keys: string[]): Promise<void> {
    for (const key of keys) await this.run(['delete', `${this.bucket}/${key}`]);
  }
}
