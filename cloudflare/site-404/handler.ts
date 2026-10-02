// The website's "page not found" page, for a site served from an R2 bucket's custom domain (docs/setup.md, "The 404
// page"). R2 answers a missing object with status 404 and Cloudflare's own page; no rule on the Free plan can swap
// in ours. This Worker, on a route for the site's hostname only, passes every request to the bucket unchanged and
// changes one thing: when the bucket says 404 for a page address, the answer is the site's /404.html, still with
// status 404.
//
// It holds no state and needs no binding: both requests go to the hostname it is routed on (a Worker's fetch to its
// own zone goes to the origin, here the bucket, not back through the Worker). If anything in it throws, the
// bucket's answer is what the visitor gets. NOT DEPLOYED: docs/setup.md, "The 404 page".
//
// This file is the logic (tested by test/site-404-worker.test.ts); worker.ts is the entry point. They are two files
// because the Workers runtime refuses an entry module that exports anything but handlers.

export const NOT_FOUND_PAGE = '/404.html';
// As pages are published (src/site-sync.ts, PAGE_CACHE): a game published a minute from now isn't hidden by this.
export const NOT_FOUND_CACHE = 'public, max-age=60';

// A page address: GET or HEAD for a path whose last part has no extension, or .html. A missing image, script or
// font keeps the bucket's short answer (nobody reads it, and an image request shouldn't be answered with a page).
export function wantsPage(method: string, pathname: string): boolean {
  if (method !== 'GET' && method !== 'HEAD') return false;
  const last = pathname.slice(pathname.lastIndexOf('/') + 1);
  return !last.includes('.') || /\.html?$/i.test(last);
}

export async function handle(request: Request, fetcher: typeof fetch = fetch): Promise<Response> {
  const response = await fetcher(request);
  const url = new URL(request.url);
  if (response.status !== 404 || url.pathname === NOT_FOUND_PAGE || !wantsPage(request.method, url.pathname)) return response;
  try {
    const page = await fetcher(new Request(new URL(NOT_FOUND_PAGE, url), { method: request.method, headers: { accept: 'text/html' } }));
    if (page.status !== 200) return response;
    const headers = new Headers({
      'content-type': page.headers.get('content-type') ?? 'text/html; charset=utf-8',
      'cache-control': NOT_FOUND_CACHE,
    });
    return new Response(request.method === 'HEAD' ? null : page.body, { status: 404, headers });
  } catch {
    return response;
  }
}
