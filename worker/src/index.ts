import { type Env, handle } from './app.js';

export type { Env } from './app.js';

export default {
  fetch: (request: Request, env: Env): Promise<Response> => handle(request, env),
} satisfies ExportedHandler<Env>;
