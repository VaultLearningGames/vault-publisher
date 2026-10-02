// The spelling check: Hunspell (en_US) plus the site's own accepted words.
import { readFile } from 'node:fs/promises';
import { allowList, spellingFindings } from '../site-checks.ts';
import type { PageText, RawFinding } from '../site-checks.ts';

// The words in words.txt: one per line, '#' starts a comment.
export async function acceptedWords(): Promise<string[]> {
  const text = await readFile(new URL('./words.txt', import.meta.url), 'utf8');
  return text.split('\n').map((l) => l.replace(/#.*/, '').trim()).filter(Boolean);
}

export async function checkSpelling(pages: PageText[], allowWords: string[]): Promise<{ findings: RawFinding[]; words: number }> {
  const [{ default: nspell }, { default: dictionary }, extra] = await Promise.all([import('nspell'), import('dictionary-en'), acceptedWords()]);
  const spell = nspell({ aff: Buffer.from(dictionary.aff), dic: Buffer.from(dictionary.dic) });
  const allow = allowList([...allowWords, ...extra]);
  for (const w of extra) spell.add(w);
  return spellingFindings(pages, spell, allow);
}
