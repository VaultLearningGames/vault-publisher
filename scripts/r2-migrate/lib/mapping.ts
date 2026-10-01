// Which local files go to the CDN, and under which R2 keys. Pure: no fs, no network.
//
// Keys follow the existing Vault CDN convention, STUDIO/GAME/…/ (see docs/fielddaylab-migration.md):
// the game's r2Prefix from the manifest, then the file's path inside the mirrored build folder.
// Forward slashes, case preserved, exactly as the build folder is laid out.
import { isSafeFilePath } from '../../../src/paths.ts';

// OS junk and dotfiles never make it to the CDN (".git" mirrors, ".DS_Store", "Thumbs.db", …).
const SKIP_NAMES = new Set(['.DS_Store', 'Thumbs.db']);

export function shouldSkip(name: string): boolean {
  return name.startsWith('.') || SKIP_NAMES.has(name);
}

// A mirrored path segment that isSafeFilePath would reject, so the error names the real cause.
function badSegment(path: string): string | null {
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') return segment === '' ? '(empty)' : segment;
  }
  return null;
}

// "fieldday/jowilder/doit" + "Build/x.framework.js.gz" → "fieldday/jowilder/doit/Build/x.framework.js.gz".
// Throws on anything that would not be a safe R2 key or a safe local path.
export function keyFor(prefix: string, relPath: string): string {
  const p = prefix.replace(/\/+$/, '');
  if (p === '' || !isSafeFilePath(p)) throw new Error(`bad R2 key prefix "${prefix}"`);
  if (relPath === '' || relPath.startsWith('/') || relPath.includes('\\') || !isSafeFilePath(relPath)) {
    throw new Error(`bad local path "${relPath}" (expected a relative path with forward slashes)`);
  }
  const bad = badSegment(p) ?? badSegment(relPath);
  if (bad) throw new Error(`bad path segment "${bad}" in "${prefix}/${relPath}"`);
  return `${p}/${relPath}`;
}

// The local paths of `files` (relative to the build folder) that get uploaded, in the given order.
export function uploadablePaths(files: string[]): string[] {
  return files.filter((path) => !path.split('/').some(shouldSkip));
}
