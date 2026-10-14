import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PublishConfig } from './config.js';
import { imageId } from './freeze.js';
import { createReporter } from './log.js';
import { publish } from './publish.js';
import { MemoryStore } from './store.js';

/** Workflow plan 13: outputs (social posts) live in the project file but are never published with the book. */

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'six');

function config(): PublishConfig {
  return {
    source: 'test',
    r2: {
      accountId: 'acc',
      accessKeyId: 'k',
      secretAccessKey: 's',
      bucket: 'test-bucket',
      publicUrl: 'https://cdn.example.test',
      transport: 's3',
    },
    viewerUrl: '',
    download: { maxEdge: 4096, quality: 88 },
    concurrency: 2,
    social: { apiUrl: '', adminToken: '' },
  };
}

let dirs: string[] = [];

async function copyFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pb-outputs-'));
  dirs.push(dir);
  await cp(FIXTURE, dir, { recursive: true, filter: (src) => !src.includes('.photobook-publish') });
  return join(dir, 'book.photobook.json');
}

beforeEach(() => {
  dirs = [];
});
afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

async function run(project: string) {
  const store = new MemoryStore();
  const res = await publish({
    projectPath: project,
    config: config(),
    reporter: createReporter('json', () => {}),
    dryRun: false,
    store,
  });
  const ids = Object.fromEntries([...res.frozen.assets].map(([id, a]) => [id, imageId(a)]));
  const manifestKey = [...store.objects.keys()].find((k) => k.endsWith('/manifest.json'));
  const manifest = manifestKey
    ? JSON.parse(new TextDecoder().decode(store.objects.get(manifestKey)?.body ?? new Uint8Array()))
    : null;
  return { res, ids, keys: [...store.objects.keys()].sort(), manifest };
}

describe('outputs are not published', () => {
  it('publishes a project with a social post exactly like the same project without it', async () => {
    const plain = await copyFixture();
    const withPost = await copyFixture();
    const doc = JSON.parse(await readFile(withPost, 'utf8'));
    const asset = Object.keys(doc.assets)[0] as string;
    const frame = {
      id: '01OUTPUTFRAME000000000000F1',
      layout: 'blank',
      background: { asset },
      elements: [
        {
          type: 'photo',
          id: '01OUTPUTELEM0000000000000E1',
          asset,
          frame: { x: 0, y: 0, w: 1, h: 1 },
          crop: { x: 0, y: 0, scale: 1 },
          rotate: 0,
          filter: 'none',
          ratio: 'free',
        },
      ],
      guides: [],
    };
    doc.outputs = [{ id: '01OUTPUTPOST0000000000000P1', name: 'Post', createdAt: 1, kind: 'social', frames: [frame] }];
    await writeFile(withPost, JSON.stringify(doc));

    const a = await run(plain);
    const b = await run(withPost);
    expect(b.res.fingerprint).toBe(a.res.fingerprint);
    expect(b.ids).toEqual(a.ids);
    expect(b.res.frozen.book.pages).toEqual(a.res.frozen.book.pages);
    expect(b.keys).toEqual(a.keys);
    expect(b.res.uploaded).toBe(a.res.uploaded);
    // The manifest says nothing about the post (its publish time is the only difference).
    expect(a.manifest).not.toBeNull();
    const { publishedAt: _a, ...manifestA } = a.manifest ?? {};
    const { publishedAt: _b, ...manifestB } = b.manifest ?? {};
    expect(manifestB).toEqual(manifestA);
    expect(JSON.stringify(b.manifest)).not.toContain('01OUTPUT');
  });
});
