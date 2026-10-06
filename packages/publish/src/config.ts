import { readFile } from 'node:fs/promises';
import { DEFAULT_DOWNLOAD_MAX_EDGE, DEFAULT_DOWNLOAD_QUALITY } from '@photobook/shared';
import { defaultSettingsPath } from './paths.js';

/**
 * Publish settings: a `KEY=VALUE` file in the editor's app data dir (written by the Settings
 * screen), overridable by `--env <file>` / `PHOTOBOOK_ENV` and by the process environment.
 * Secrets never go in the project file.
 */
export interface PublishConfig {
  /** Where the values came from, for messages. */
  source: string;
  r2: {
    accountId: string;
    accessKeyId: string;
    secretAccessKey: string;
    bucket: string;
    /** Public base URL of the bucket (custom domain or r2.dev), no trailing slash. */
    publicUrl: string;
    /** `s3` (default, needs the keys) or `wrangler` (logged-in wrangler CLI; slower, no listing). */
    transport: 's3' | 'wrangler';
  };
  /** Origin of the deployed viewer shell (Vercel), for the links the editor shows; optional. */
  viewerUrl: string;
  /** Plain word; empty means "do not touch the password". */
  sitePassword: string;
  /** ISO date after which devices are asked again; null never. */
  sitePasswordExpiresAt: string | null;
  download: { maxEdge: number; quality: number };
  /** Image workers; defaults to cores - 1. */
  concurrency: number | null;
  /** The likes and download-log Worker: its origin (written into `site.json`) and the designer's admin token. */
  social: { apiUrl: string; adminToken: string };
}

export const SETTINGS_KEYS = [
  'R2_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_BUCKET',
  'R2_PUBLIC_URL',
  'R2_TRANSPORT',
  'VIEWER_URL',
  'SITE_PASSWORD',
  'SITE_PASSWORD_EXPIRES_AT',
  'DOWNLOAD_MAX_EDGE',
  'DOWNLOAD_QUALITY',
  'PUBLISH_CONCURRENCY',
  'SOCIAL_API_URL',
  'SOCIAL_ADMIN_TOKEN',
] as const;
export type SettingsKey = (typeof SETTINGS_KEYS)[number];

/** Parse a dotenv-style file: `KEY=VALUE`, `#` comments, optional single or double quotes. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export function serializeEnvFile(values: Partial<Record<SettingsKey, string>>): string {
  const lines = ['# Photobook publish settings. Written by the editor; edit by hand if you like.'];
  for (const key of SETTINGS_KEYS) {
    const v = values[key];
    if (v === undefined || v === '') continue;
    lines.push(`${key}=${/[\s#'"]/.test(v) ? JSON.stringify(v) : v}`);
  }
  return `${lines.join('\n')}\n`;
}

export interface LoadConfigOptions {
  envPath?: string;
  /** Overrides; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

export async function readSettingsFile(path: string): Promise<Record<string, string>> {
  try {
    return parseEnvFile(await readFile(path, 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
}

function num(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number, got "${value}"`);
  return n;
}

/** Load settings; nothing is validated as required here, see `requireR2`. */
export async function loadConfig({ envPath, env = process.env }: LoadConfigOptions = {}): Promise<PublishConfig> {
  const path = envPath ?? env.PHOTOBOOK_ENV ?? defaultSettingsPath();
  const file = await readSettingsFile(path);
  const get = (key: SettingsKey): string => env[key] ?? file[key] ?? '';
  const transport = get('R2_TRANSPORT');
  if (transport && transport !== 's3' && transport !== 'wrangler') {
    throw new Error(`R2_TRANSPORT must be "s3" or "wrangler", got "${transport}"`);
  }
  return {
    source: path,
    r2: {
      accountId: get('R2_ACCOUNT_ID'),
      accessKeyId: get('R2_ACCESS_KEY_ID'),
      secretAccessKey: get('R2_SECRET_ACCESS_KEY'),
      bucket: get('R2_BUCKET'),
      publicUrl: get('R2_PUBLIC_URL').replace(/\/+$/, ''),
      transport: transport === 'wrangler' ? 'wrangler' : 's3',
    },
    viewerUrl: get('VIEWER_URL').replace(/\/+$/, ''),
    sitePassword: get('SITE_PASSWORD'),
    sitePasswordExpiresAt: get('SITE_PASSWORD_EXPIRES_AT') || null,
    download: {
      maxEdge: Math.round(num(get('DOWNLOAD_MAX_EDGE'), DEFAULT_DOWNLOAD_MAX_EDGE, 'DOWNLOAD_MAX_EDGE')),
      quality: Math.round(num(get('DOWNLOAD_QUALITY'), DEFAULT_DOWNLOAD_QUALITY, 'DOWNLOAD_QUALITY')),
    },
    concurrency: get('PUBLISH_CONCURRENCY')
      ? Math.round(num(get('PUBLISH_CONCURRENCY'), 1, 'PUBLISH_CONCURRENCY'))
      : null,
    social: { apiUrl: get('SOCIAL_API_URL').replace(/\/+$/, ''), adminToken: get('SOCIAL_ADMIN_TOKEN') },
  };
}

/**
 * `SOCIAL_API_URL` as it goes into `site.json` (`site.api`), or null when unset. Throws on a value
 * the viewer could not parse: an invalid `site.api` would make every book on the site fail to load.
 */
export function socialApiUrl(config: PublishConfig): string | null {
  const raw = config.social.apiUrl.trim().replace(/\/+$/, '');
  if (!raw) return null;
  let protocol: string;
  try {
    protocol = new URL(raw).protocol;
  } catch {
    protocol = '';
  }
  if (protocol !== 'https:' && protocol !== 'http:') {
    throw new Error(`SOCIAL_API_URL must be a full http(s) URL such as https://api.example.com, got "${raw}"`);
  }
  return raw;
}

/** The settings an upload needs; throws a message listing what is missing. */
export function requireR2(config: PublishConfig): PublishConfig['r2'] {
  const missing: string[] = [];
  const { r2 } = config;
  if (!r2.bucket) missing.push('R2_BUCKET');
  if (!r2.publicUrl) missing.push('R2_PUBLIC_URL');
  if (r2.transport === 's3') {
    if (!r2.accountId) missing.push('R2_ACCOUNT_ID');
    if (!r2.accessKeyId) missing.push('R2_ACCESS_KEY_ID');
    if (!r2.secretAccessKey) missing.push('R2_SECRET_ACCESS_KEY');
  }
  if (missing.length) {
    throw new Error(
      `Missing publish settings: ${missing.join(', ')}. Set them in the editor's Settings screen or in ${config.source} (see docs/PUBLISHING.md).`,
    );
  }
  return r2;
}
