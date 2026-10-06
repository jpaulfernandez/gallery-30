import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { ObjectStore, PutOptions } from './store.js';

export interface R2Credentials {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

/** R2 through its S3-compatible endpoint. */
export class S3Store implements ObjectStore {
  readonly name: string;
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(creds: R2Credentials) {
    this.bucket = creds.bucket;
    this.name = `r2:${creds.bucket}`;
    this.client = new S3Client({
      region: 'auto',
      endpoint: `https://${creds.accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey },
      // R2 does not support the SDK's default flexible checksums.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch (err) {
      if (isNotFound(err)) return false;
      throw err;
    }
  }

  async put(key: string, body: Uint8Array, options: PutOptions): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: options.contentType,
        CacheControl: options.cacheControl,
      }),
    );
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      const out = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      return out.Body ? await out.Body.transformToByteArray() : null;
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async list(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const out = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }),
      );
      for (const o of out.Contents ?? []) if (o.Key) keys.push(o.Key);
      token = out.IsTruncated ? out.NextContinuationToken : undefined;
    } while (token);
    return keys;
  }

  async delete(keys: string[]): Promise<void> {
    for (let i = 0; i < keys.length; i += 1000) {
      const batch = keys.slice(i, i + 1000);
      await this.client.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
        }),
      );
    }
  }
}

function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e.name === 'NotFound' || e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404;
}
