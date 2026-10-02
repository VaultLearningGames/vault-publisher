// Entry point of the site's 404 Worker: see handler.ts. Nothing but the default export may be exported from here
// (the Workers runtime refuses an entry module with other exports).
import { handle } from './handler.ts';

export default {
  async fetch(request: Request, _env: unknown, ctx: { passThroughOnException(): void }): Promise<Response> {
    ctx.passThroughOnException();
    return handle(request);
  },
};
