# @photobook/worker

Cloudflare Worker + D1 behind the viewer's likes and the editor's Downloads tab. Plain `fetch` handler, no framework.
Routes and payloads live in `packages/shared/src/publish/social.ts` (imported as `@photobook/shared/social`).
It is optional: without it the viewer hides likes and logs nothing.

## Routes

- `GET /v1/health`
- `POST /v1/likes`, `GET /v1/books/:bookId/likes?device=<id>`
- `POST /v1/events`
- `GET /v1/admin/books/:bookId/activity` with `Authorization: Bearer <ADMIN_TOKEN>`

CORS is open (`*`): the viewer can run on any origin and only the admin route needs the token.

## Run locally

```sh
cd worker
pnpm exec wrangler d1 migrations apply photobook-social --local
printf 'ADMIN_TOKEN=dev-token\n' > .dev.vars   # git-ignored
pnpm dev                                        # http://localhost:8787
```

`pnpm test` starts the worker with `unstable_dev` against a throwaway local D1; no setup needed.

## Deploy your own

`wrangler.toml` is a template with a placeholder database id. Keep your deployment's values in
`wrangler.local.toml` (git-ignored); `pnpm run deploy` and `pnpm run db:migrate` use it when it exists.

```sh
cd worker
pnpm exec wrangler login
cp wrangler.toml wrangler.local.toml
pnpm exec wrangler d1 create photobook-social   # put the printed database_id in wrangler.local.toml
pnpm run db:migrate                             # also rerun whenever migrations/ changes
pnpm run deploy                                 # predeploy builds @photobook/shared (wrangler bundles its dist/)
openssl rand -hex 32 | tr -d '\n' | tee ~/.photobook-admin-token \
  | pnpm exec wrangler secret put ADMIN_TOKEN --config wrangler.local.toml
```

Then set the Worker URL and the admin token in the editor's Settings (see `docs/PUBLISHING.md`, section 8).
