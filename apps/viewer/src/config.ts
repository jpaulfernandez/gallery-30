/**
 * The only build-time setting: where `site.json` and `books/<slug>/manifest.json` live.
 * `.env.development` points it at the dev server's /dev-r2 fixtures; production reads the Vercel env var.
 */
const raw = import.meta.env.VITE_R2_PUBLIC_URL?.trim() ?? '';

// `.invalid` is the sentinel vite.config.ts bakes in when the variable is unset at build time
// (a method call, so the bundler cannot fold the check away and drop the app).
export const R2_BASE: string | null = raw && !raw.endsWith('.invalid') ? raw.replace(/\/+$/, '') : null;

export const CONFIG_ERROR =
  'VITE_R2_PUBLIC_URL is not set. Copy apps/viewer/.env.example to .env.production.local (or set the variable on Vercel) ' +
  'and point it at the public URL of the R2 bucket.';
