import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { workDir } from './paths.js';

/**
 * `.photobook-publish/state.json`: which keys this machine knows exist on R2, so a rerun skips the
 * HEAD for them, and when they were confirmed. Losing the file only costs HEAD requests.
 */
export interface PublishState {
  version: 1;
  bucket: string;
  /** key -> ISO time it was confirmed on R2. */
  keys: Record<string, string>;
}

export class StateFile {
  private dirty = false;
  /** Saves are serialized: the upload phase asks for one every few objects. */
  private saving: Promise<void> = Promise.resolve();
  private seq = 0;
  constructor(
    readonly path: string,
    readonly state: PublishState,
  ) {}

  static async load(projectPath: string, bucket: string): Promise<StateFile> {
    const path = join(workDir(projectPath), 'state.json');
    let state: PublishState = { version: 1, bucket, keys: {} };
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<PublishState>;
      if (parsed.version === 1 && parsed.bucket === bucket && parsed.keys && typeof parsed.keys === 'object') {
        state = { version: 1, bucket, keys: parsed.keys };
      }
    } catch {
      // Missing or unreadable: start empty.
    }
    return new StateFile(path, state);
  }

  has(key: string): boolean {
    return key in this.state.keys;
  }

  mark(key: string): void {
    if (!this.has(key)) this.dirty = true;
    this.state.keys[key] = new Date().toISOString();
  }

  forget(key: string): void {
    if (this.has(key)) {
      delete this.state.keys[key];
      this.dirty = true;
    }
  }

  /** Drop every key under `prefix`. */
  forgetPrefix(prefix: string): void {
    for (const key of Object.keys(this.state.keys)) if (key.startsWith(prefix)) this.forget(key);
  }

  save(force = false): Promise<void> {
    this.saving = this.saving.then(async () => {
      if (!this.dirty && !force) return;
      // Cleared before the write: a mark that lands while writing makes the file dirty again.
      this.dirty = false;
      const text = `${JSON.stringify(this.state, null, 2)}\n`;
      await mkdir(join(this.path, '..'), { recursive: true });
      const tmp = `${this.path}.${process.pid}.${this.seq++}.tmp`;
      await writeFile(tmp, text);
      await rename(tmp, this.path);
    });
    return this.saving;
  }
}
