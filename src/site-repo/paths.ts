// The paths the portal may touch in vault-site. A path is normalized (backslashes and repeated or trailing slashes
// are refused, not repaired) and must sit under one of the content roots: the portal edits the site's content and data,
// never its templates, configuration or workflows (.github/, hugo.toml, layouts/, themes/ are vault-site's own work).
import { SitePathError } from './types.ts';

export const SITE_CONTENT_ROOTS: readonly string[] = ['content/', 'data/', 'static/', 'assets/'];
const MAX_PATH = 400;

// The path, normalized; throws SitePathError when it is absolute, leaves the repository or isn't under `roots`.
export function checkSitePath(path: unknown, roots: readonly string[] = SITE_CONTENT_ROOTS, o: { dir?: boolean } = {}): string {
  if (typeof path !== 'string' || !path) throw new SitePathError('A website path is required.');
  if (path.length > MAX_PATH) throw new SitePathError('That website path is too long.');
  const shown = JSON.stringify(path.slice(0, 80));
  if (/[\u0000-\u001f\u007f\\]/.test(path)) throw new SitePathError(`${shown} is not a website path.`);
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) throw new SitePathError(`${shown} is an absolute path.`);
  const trimmed = o.dir ? path.replace(/\/+$/, '') : path;
  const segs = trimmed.split('/');
  if (segs.some((s) => s === '' || s === '.' || s === '..')) throw new SitePathError(`${shown} is not a website path.`);
  const norm = segs.join('/');
  const under = roots.some((r) => (norm + (o.dir ? '/' : '')).startsWith(r) && (o.dir || norm.length > r.length));
  if (!under) throw new SitePathError(`${shown} is outside the folders the portal edits (${roots.join(', ')}).`);
  return norm;
}
