import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.ts';
import { Db } from '../src/db.ts';
import { escapeCell, googleSheets, type FormsConfig, type Sheets } from '../src/forms.ts';
import type { Storage } from '../src/storage.ts';

class FakeSheets implements Sheets {
  rows = new Map<string, string[][]>();
  fail = false;
  async firstRow(id: string) {
    return this.rows.get(id)?.[0] ?? [];
  }
  async append(id: string, rows: string[][]) {
    if (this.fail) throw new Error('simulated Sheets failure');
    this.rows.set(id, [...(this.rows.get(id) ?? []), ...rows]);
  }
}

const SITE = 'https://vaultlearninggames.org';
let db: Db;
let sheets: FakeSheets;
let app: ReturnType<typeof createApp>;

function makeApp(forms: Partial<FormsConfig> | null) {
  app = createApp({
    db,
    staging: {} as Storage,
    production: null,
    verifier: { async github() { throw new Error('no'); }, async google() { throw new Error('no'); } },
    stagingPublicUrl: 'https://builds.example.org',
    prodPublicUrl: 'https://cdn.example.org',
    adminRepository: 'VaultLearningGames/vault-publisher',
    adminEnvironment: 'production',
    portal: { baseUrl: 'https://portal.test', vaultAdmins: [] },
    previewRetentionDays: 90,
    taskInvokerEmail: 'scheduler@example.iam.gserviceaccount.com',
    forms: forms === null ? undefined : {
      allowedOrigins: [SITE, 'https://vaultlearninggames-staging.org/'],
      sheets: { newsletter: 'news-sheet', 'submit-game': 'games-sheet' },
      client: sheets,
      ...forms,
    },
  });
}

beforeEach(() => {
  db = new Db(':memory:');
  sheets = new FakeSheets();
  makeApp({});
});

// A fetch from the site by default; pass headers to change it.
function submit(form: string, body: BodyInit | Record<string, unknown>, headers: Record<string, string> = {}) {
  const h: Record<string, string> = { Origin: SITE, Accept: 'application/json', 'X-Forwarded-For': '203.0.113.5, 10.0.0.1', ...headers };
  let init: BodyInit;
  if (body instanceof URLSearchParams || body instanceof FormData || typeof body === 'string') init = body;
  else { init = JSON.stringify(body); h['Content-Type'] ??= 'application/json'; }
  for (const [k, v] of Object.entries(h)) if (v === '') delete h[k];
  return app.request(`/v1/forms/${form}`, { method: 'POST', headers: h, body: init });
}

const game = {
  email: 'dev@studio.org', news: 'on', title: 'Wake', free: 'Yes', browser: 'Yes', maker: 'Field Day',
  url: 'https://example.org/wake', grades: ['6', '7'], subjects: ['Science'], tagline: 'Dive in',
};

describe('parsing', () => {
  test('JSON newsletter with aliases', async () => {
    const res = await submit('newsletter', { fname: 'Ada', lname: 'Lovelace', email: 'ada@example.org' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), SITE);
    assert.equal(res.headers.get('Vary'), 'Origin');
    const [header, row] = sheets.rows.get('news-sheet')!;
    assert.deepEqual(header, ['Submitted', 'Site', 'First name', 'Last name', 'Email']);
    assert.match(row[0], /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    assert.deepEqual(row.slice(1), [SITE, 'Ada', 'Lovelace', 'ada@example.org']);
  });

  test('urlencoded submit-game joins repeated fields', async () => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(game)) for (const x of [v].flat()) p.append(k, x);
    const res = await submit('submit-game', p);
    assert.equal(res.status, 200);
    const [header, row] = sheets.rows.get('games-sheet')!;
    assert.equal(header.length, 16);
    assert.deepEqual(row.slice(1), [SITE, 'dev@studio.org', 'Yes', 'Wake', 'Yes', 'Yes', 'Field Day', 'https://example.org/wake',
      '6; 7', '', '', '', 'Dive in', '', 'Science']);
  });

  test('multipart FormData, news unchecked, grades[] names', async () => {
    const f = new FormData();
    for (const [k, v] of Object.entries(game)) if (k !== 'news' && k !== 'grades') for (const x of [v].flat()) f.append(k, x);
    f.append('grades[]', 'K'); f.append('grades[]', '1');
    f.append('media', new Blob(['x']), 'file.txt'); // files are ignored
    const res = await submit('submit-game', f);
    assert.equal(res.status, 200);
    const row = sheets.rows.get('games-sheet')![1];
    assert.equal(row[3], 'No');
    assert.equal(row[9], 'K; 1');
    assert.equal(row[11], '');
  });

  test('unreadable bodies are 400', async () => {
    assert.equal((await submit('newsletter', 'email=a@b.co', { 'Content-Type': 'text/plain' })).status, 400);
    assert.equal((await submit('newsletter', '[1]', { 'Content-Type': 'application/json' })).status, 400);
    assert.equal(sheets.rows.size, 0);
  });
});

describe('validation and spam', () => {
  test('missing and invalid fields', async () => {
    let res = await submit('newsletter', { first_name: 'Ada' });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { ok: false, error: 'Please fill in: Email.' });
    res = await submit('newsletter', { email: 'not an email' });
    assert.equal(res.status, 400);
    res = await submit('submit-game', { email: 'a@b.co', title: 'X' });
    assert.equal(((await res.json()) as any).error, 'Please fill in: Free to play, Playable in browser, Made by, Game link.');
    res = await submit('newsletter', { email: 'a@b.co', first_name: 'x'.repeat(5001) });
    assert.equal(res.status, 400);
    assert.equal(sheets.rows.size, 0);
  });

  test('oversized bodies are refused', async () => {
    const res = await submit('newsletter', { email: 'a@b.co', description: 'x'.repeat(70_000) });
    assert.equal(res.status, 413);
    assert.equal(sheets.rows.size, 0);
  });

  test('a filled honeypot succeeds without writing', async () => {
    const res = await submit('newsletter', { email: 'a@b.co', company_website: 'http://spam' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal(sheets.rows.size, 0);
  });

  test('rate limit per form and first X-Forwarded-For address', async () => {
    makeApp({ rateLimit: { max: 2, windowMs: 60_000 } });
    assert.equal((await submit('newsletter', { email: 'a@b.co' })).status, 200);
    assert.equal((await submit('newsletter', { email: 'a@b.co' }, { 'X-Forwarded-For': '203.0.113.5' })).status, 200);
    const res = await submit('newsletter', { email: 'a@b.co' });
    assert.equal(res.status, 429);
    assert.equal(sheets.rows.get('news-sheet')!.length, 3); // header + 2
    assert.equal((await submit('newsletter', { email: 'a@b.co' }, { 'X-Forwarded-For': '198.51.100.7' })).status, 200);
    assert.equal((await submit('submit-game', game)).status, 200);
  });

  test('formula-like values get an apostrophe', async () => {
    assert.equal(escapeCell('=HYPERLINK("x")'), `'=HYPERLINK("x")`);
    for (const v of ['+1', '-1', '@a', '\tx', '\rx']) assert.equal(escapeCell(v), `'${v}`);
    assert.equal(escapeCell('Ada'), 'Ada');
    await submit('newsletter', { first_name: '=1+1', last_name: '@SUM(A1)', email: 'a@b.co' });
    assert.deepEqual(sheets.rows.get('news-sheet')![1].slice(2, 4), [`'=1+1`, `'@SUM(A1)`]);
  });
});

describe('sheets', () => {
  test('the header row is written only when the sheet is empty', async () => {
    sheets.rows.set('games-sheet', [['My own header']]);
    await submit('newsletter', { email: 'a@b.co' });
    await submit('newsletter', { email: 'c@d.co' });
    await submit('submit-game', game);
    assert.deepEqual(sheets.rows.get('news-sheet')!.map((r) => r.at(-1)), ['Email', 'a@b.co', 'c@d.co']);
    assert.deepEqual(sheets.rows.get('games-sheet')!.map((r) => r[0] === 'My own header' ? r[0] : r[2]), ['My own header', 'dev@studio.org']);
  });

  test('a form without a spreadsheet answers 503', async () => {
    makeApp({ sheets: { newsletter: 'news-sheet' } });
    const res = await submit('submit-game', game);
    assert.equal(res.status, 503);
    assert.equal(((await res.json()) as any).ok, false);
    makeApp(null);
    assert.equal((await submit('newsletter', { email: 'a@b.co' }, { Origin: '' })).status, 503);
  });

  test('a Sheets failure is 502 and logs no personal data', async () => {
    sheets.fail = true;
    const logged: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => { logged.push(a.join(' ')); };
    try {
      const res = await submit('newsletter', { first_name: 'Ada', email: 'ada@example.org' });
      assert.equal(res.status, 502);
    } finally {
      console.error = orig;
    }
    assert.equal(logged.length, 1);
    assert.doesNotMatch(logged[0], /Ada|ada@example/);
  });

  test('a saved submission is audited without its values', async () => {
    await submit('newsletter', { email: 'ada@example.org' });
    const [entry] = db.auditFor(['form.submit']);
    assert.equal(entry.target, 'newsletter');
    assert.deepEqual(JSON.parse(entry.detail_json!), { site: SITE });
  });
});

describe('CORS and HTML forms', () => {
  test('preflight for allowed origins only', async () => {
    let res = await app.request('/v1/forms/newsletter', { method: 'OPTIONS', headers: { Origin: 'https://vaultlearninggames-staging.org', 'Access-Control-Request-Method': 'POST' } });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'https://vaultlearninggames-staging.org');
    assert.match(res.headers.get('Access-Control-Allow-Methods')!, /POST/);
    res = await app.request('/v1/forms/newsletter', { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } });
    assert.equal(res.status, 403);
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), null);
  });

  test('a disallowed Origin is 403 and nothing is written', async () => {
    const res = await submit('newsletter', { email: 'a@b.co' }, { Origin: 'https://evil.example' });
    assert.equal(res.status, 403);
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), null);
    assert.equal(sheets.rows.size, 0);
  });

  test('a plain form post is sent back to its page', async () => {
    const html = { Accept: 'text/html,application/xhtml+xml', 'Sec-Fetch-Mode': 'navigate', Referer: `${SITE}/newsletter/?x=1#top` };
    let res = await submit('newsletter', new URLSearchParams({ email: 'a@b.co' }), html);
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('Location'), `${SITE}/newsletter/?x=1#form-submitted`);
    res = await submit('newsletter', new URLSearchParams({ email: 'nope' }), html);
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('Location'), `${SITE}/newsletter/?x=1#form-error`);
    // No usable Referer: a small page instead.
    res = await submit('newsletter', new URLSearchParams({ email: 'a@b.co' }), { ...html, Referer: 'https://elsewhere.example/', Origin: '' });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('Content-Type')!, /text\/html/);
    assert.match(await res.text(), /Thank you/);
    const row = sheets.rows.get('news-sheet')!.at(-1)!;
    assert.equal(row[1], 'https://elsewhere.example');
  });
});

describe('googleSheets', () => {
  test('caches the token, finds the first sheet and appends RAW rows', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fake = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.startsWith('http://metadata.google.internal/')) return Response.json({ access_token: 'tok', expires_in: 3600 });
      if (url.includes('?fields=')) return Response.json({ sheets: [{ properties: { title: "Sign-ups '26" } }] });
      if (url.includes(':append')) return Response.json({});
      return Response.json({ values: [] });
    }) as typeof fetch;
    const client = googleSheets(fake);
    assert.deepEqual(await client.firstRow('abc'), []);
    await client.append('abc', [['a', 'b']]);
    assert.equal(calls.filter((c) => c.url.startsWith('http://metadata')).length, 1);
    assert.equal((calls[0].init!.headers as Record<string, string>)['Metadata-Flavor'], 'Google');
    const append = calls.find((c) => c.url.includes(':append'))!;
    assert.equal(append.url, `https://sheets.googleapis.com/v4/spreadsheets/abc/values/${encodeURIComponent("'Sign-ups ''26'")}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`);
    assert.equal((append.init!.headers as Record<string, string>).Authorization, 'Bearer tok');
    assert.deepEqual(JSON.parse(append.init!.body as string), { values: [['a', 'b']] });
    assert.equal(calls.filter((c) => c.url.includes('?fields=')).length, 1);
  });
});
