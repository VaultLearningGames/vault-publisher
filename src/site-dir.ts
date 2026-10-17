// Where the website's source (the vault-site repository: hugo.toml, content/, layouts/, themes/) is, for the portal's
// Hugo previews (portal/site-preview.ts). In order:
//   1. SITE_DIR, when set: it must be a Hugo site, or this throws (a wrong setting is never silently skipped);
//   2. the folder above this repository, when it is a Hugo site: the portal checked out as vault-site's portal/
//      submodule (vault-site/portal), the development layout;
//   3. /app/vault-site, where the image puts the pinned vault-site (Dockerfile, vault-site.ref).
// Otherwise it throws. The answer is kept for the rest of the process.
import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const IMAGE_SITE_DIR = '/app/vault-site';
// This repository's root: src/..
export const PORTAL_ROOT = fileURLToPath(new URL('..', import.meta.url));

const CONFIG_FILES = ['hugo.toml', 'hugo.yaml', 'hugo.yml', 'hugo.json', 'config.toml', 'config.yaml', 'config.yml', 'config.json'];

export class SiteDirError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SiteDirError';
  }
}

// A folder with a Hugo configuration file in it.
export function isHugoSite(dir: string): boolean {
  try {
    if (!statSync(dir).isDirectory()) return false;
  } catch {
    return false;
  }
  return CONFIG_FILES.some((f) => existsSync(join(dir, f)));
}

export interface ResolveSiteDirOptions {
  env?: Record<string, string | undefined>;
  portalRoot?: string;
  imageDir?: string;
}

// The lookup itself, uncached (resolveSiteDir caches it).
export function findSiteDir(o: ResolveSiteDirOptions = {}): string {
  const env = o.env ?? process.env;
  const fromEnv = env.SITE_DIR?.trim();
  if (fromEnv) {
    const dir = resolve(fromEnv);
    if (!isHugoSite(dir)) throw new SiteDirError(`SITE_DIR is ${dir}, which is not a Hugo site (no ${CONFIG_FILES.slice(0, 4).join(', ')} or config.*).`);
    return dir;
  }
  const parent = resolve(o.portalRoot ?? PORTAL_ROOT, '..');
  if (isHugoSite(parent)) return parent;
  const image = o.imageDir ?? IMAGE_SITE_DIR;
  if (isHugoSite(image)) return image;
  throw new SiteDirError('vault-site not found; set SITE_DIR');
}

let cached: string | undefined;

export function resolveSiteDir(): string {
  return (cached ??= findSiteDir());
}

// Forgets the cached answer (tests).
export function resetSiteDirCache(): void {
  cached = undefined;
}
