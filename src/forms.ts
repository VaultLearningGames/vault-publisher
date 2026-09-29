import type { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Db } from './db.ts';

// Public forms on the Vault websites (newsletter sign-up, "submit your game"), appended as rows to Google Sheets.
// The sites post here from the browser: with fetch (JSON replies, CORS) or as a plain HTML form (303 back to the page).

export interface Sheets {
  // The first row of the spreadsheet's first sheet ([] when the sheet is empty).
  firstRow(spreadsheetId: string): Promise<string[]>;
  // Append rows to the spreadsheet's first sheet, as typed (RAW), inserting new rows.
  append(spreadsheetId: string, rows: string[][]): Promise<void>;
}

export interface FormsConfig {
  // Site origins allowed to post, e.g. "https://vaultlearninggames.org".
  allowedOrigins: string[];
  // Spreadsheet IDs; a form without one answers 503.
  sheets: { newsletter?: string; 'submit-game'?: string };
  client: Sheets;
  rateLimit?: { max: number; windowMs: number };
}

type FormName = 'newsletter' | 'submit-game';
type Fields = Map<string, string[]>;

interface FormSpec {
  header: string[];
  // Field name → aliases the sites may use instead.
  aliases?: Record<string, string>;
  required: string[];
  labels: Record<string, string>;
  // The row's cells after Submitted and Site.
  row(get: (name: string) => string, has: (name: string) => boolean): string[];
}

const FORMS: Record<FormName, FormSpec> = {
  newsletter: {
    header: ['Submitted', 'Site', 'First name', 'Last name', 'Email'],
    aliases: { fname: 'first_name', lname: 'last_name' },
    required: ['email'],
    labels: { email: 'Email' },
    row: (get) => [get('first_name'), get('last_name'), get('email')],
  },
  'submit-game': {
    header: ['Submitted', 'Site', 'Email', 'Sign up for news', 'Title', 'Free to play', 'Playable in browser', 'Made by',
      'Game link', 'Grades', 'Trailer/video', 'Media folder', 'Curriculum', 'Tagline', 'Description', 'Subjects'],
    required: ['email', 'title', 'free', 'browser', 'maker', 'url'],
    labels: { email: 'Email', title: 'Title', free: 'Free to play', browser: 'Playable in browser', maker: 'Made by', url: 'Game link' },
    row: (get, has) => [get('email'), has('news') ? 'Yes' : 'No', get('title'), get('free'), get('browser'), get('maker'), get('url'),
      get('grades'), get('video'), get('media'), get('curriculum'), get('tagline'), get('description'), get('subjects')],
  },
};

const HONEYPOT = 'company_website';
const MAX_FIELD_CHARS = 5000;
const MAX_BODY_BYTES = 64 * 1024;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// A cell a spreadsheet would read as a formula gets a leading apostrophe (also written RAW, which never evaluates).
export function escapeCell(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const o = new URL(url).origin;
    return o === 'null' ? null : o;
  } catch {
    return null;
  }
}

async function readFields(req: Request): Promise<Fields | string> {
  const type = (req.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  const fields: Fields = new Map();
  // "grades[]" is accepted as "grades"; repeated fields (checkbox groups) keep every value.
  const add = (name: string, value: string) => {
    const key = name.replace(/\[\]$/, '');
    fields.set(key, [...(fields.get(key) ?? []), value]);
  };
  if (type === 'application/json') {
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return 'The form could not be read.';
    for (const [name, v] of Object.entries(body)) {
      for (const item of Array.isArray(v) ? v : [v]) {
        if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') add(name, String(item));
      }
    }
  } else if (type === 'application/x-www-form-urlencoded' || type === 'multipart/form-data') {
    const form = await req.formData().catch(() => null);
    if (!form) return 'The form could not be read.';
    for (const [name, v] of form) if (typeof v === 'string') add(name, v); // files are ignored
  } else {
    return 'The form could not be read.';
  }
  return fields;
}

export function registerForms(app: Hono, db: Db, cfg: FormsConfig | undefined) {
  const allowed = new Set((cfg?.allowedOrigins ?? []).map((o) => o.replace(/\/+$/, '').toLowerCase()));
  const { max, windowMs } = cfg?.rateLimit ?? { max: 10, windowMs: 60 * 60 * 1000 };
  // Accepted submissions per form and client IP, in memory: the service runs as one instance.
  const recent = new Map<string, number[]>();
  // Sheets that already have their header row, and one write at a time per sheet so two first submissions
  // can't both write the header.
  const hasHeader = new Set<string>();
  const queues = new Map<string, Promise<unknown>>();

  const isAllowed = (origin: string | null) => origin !== null && allowed.has(origin.toLowerCase());

  function limited(key: string, now: number): boolean {
    const times = (recent.get(key) ?? []).filter((t) => t > now - windowMs);
    recent.set(key, times);
    if (recent.size > 10_000) for (const [k, t] of recent) if (!t.some((x) => x > now - windowMs)) recent.delete(k);
    return times.length >= max;
  }

  // fetch gets JSON; a plain HTML form post (a browser navigation) is sent back to its page.
  function wantsJson(c: Context): boolean {
    const accept = c.req.header('Accept') ?? '';
    if (accept.includes('application/json')) return true;
    if (c.req.header('Sec-Fetch-Mode') === 'navigate') return false;
    return !accept.includes('text/html');
  }

  function reply(c: Context, status: 200 | 400 | 403 | 413 | 429 | 502 | 503, error?: string): Response {
    const origin = c.req.header('Origin') ?? null;
    const headers: Record<string, string> = { Vary: 'Origin', 'Cache-Control': 'no-store' };
    if (origin && isAllowed(origin)) headers['Access-Control-Allow-Origin'] = origin;
    if (wantsJson(c)) return Response.json(error ? { ok: false, error } : { ok: true }, { status, headers });
    const referer = c.req.header('Referer');
    if (referer && isAllowed(originOf(referer))) {
      const back = new URL(referer);
      back.hash = error ? 'form-error' : 'form-submitted';
      return new Response(null, { status: 303, headers: { ...headers, Location: back.href } });
    }
    const text = error ? `Sorry, that didn't work. ${error}` : 'Thank you! Your form was sent.';
    const page = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${error ? 'Form not sent' : 'Thank you'}</title>` +
      `<p style="font:18px system-ui;max-width:32em;margin:15vh auto;padding:0 16px">${text.replace(/[&<>"]/g, (ch) => `&#${ch.charCodeAt(0)};`)}</p>`;
    return new Response(page, { status, headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' } });
  }

  async function write(spreadsheetId: string, row: string[], header: string[]) {
    const client = cfg!.client;
    const previous = queues.get(spreadsheetId) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(async () => {
      const rows = [row];
      if (!hasHeader.has(spreadsheetId)) {
        if ((await client.firstRow(spreadsheetId)).every((cell) => cell === '')) rows.unshift(header);
      }
      await client.append(spreadsheetId, rows);
      hasHeader.add(spreadsheetId);
    });
    queues.set(spreadsheetId, run);
    try {
      await run;
    } finally {
      if (queues.get(spreadsheetId) === run) queues.delete(spreadsheetId);
    }
  }

  for (const form of Object.keys(FORMS) as FormName[]) {
    const spec = FORMS[form];
    const path = `/v1/forms/${form}`;

    app.options(path, (c) => {
      const origin = c.req.header('Origin') ?? null;
      if (!isAllowed(origin)) return c.body(null, 403, { Vary: 'Origin' });
      return c.body(null, 204, {
        'Access-Control-Allow-Origin': origin!,
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Accept',
        'Access-Control-Max-Age': '86400',
        Vary: 'Origin',
      });
    });

    app.post(path, bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => reply(c, 413, 'The form is too large.') }), async (c) => {
      const origin = c.req.header('Origin');
      if (origin !== undefined && !isAllowed(origin)) return reply(c, 403, 'This site may not send this form.');
      const spreadsheetId = cfg?.sheets[form];
      if (!spreadsheetId) return reply(c, 503, 'This form is not connected yet. Please try again later.');

      const fields = await readFields(c.req.raw);
      if (typeof fields === 'string') return reply(c, 400, fields);
      if ((fields.get(HONEYPOT) ?? []).some((v) => v.trim() !== '')) return reply(c, 200); // a bot: pretend it worked

      const ip = (c.req.header('X-Forwarded-For') ?? '').split(',')[0].trim() || 'unknown';
      const now = Date.now();
      if (limited(`${form}:${ip}`, now)) return reply(c, 429, 'Too many submissions. Please try again later.');

      const get = (name: string) => {
        const alias = Object.entries(spec.aliases ?? {}).find(([, to]) => to === name)?.[0];
        const values = [...(fields.get(name) ?? []), ...(alias ? fields.get(alias) ?? [] : [])].map((v) => v.trim()).filter(Boolean);
        return values.join('; ');
      };
      const tooLong = [...fields.values()].flat().some((v) => v.length > MAX_FIELD_CHARS);
      if (tooLong) return reply(c, 400, `Each answer can be at most ${MAX_FIELD_CHARS} characters.`);
      const missing = spec.required.filter((name) => !get(name));
      if (missing.length > 0) return reply(c, 400, `Please fill in: ${missing.map((n) => spec.labels[n]).join(', ')}.`);
      if (!EMAIL.test(get('email')) || get('email').length > 254) return reply(c, 400, 'Please enter a valid email address.');

      recent.set(`${form}:${ip}`, [...(recent.get(`${form}:${ip}`) ?? []), now]);
      const site = originOf(origin) ?? originOf(c.req.header('Referer')) ?? '';
      const row = [new Date(now).toISOString(), site, ...spec.row(get, (name) => fields.has(name))].map(escapeCell);
      try {
        await write(spreadsheetId, row, spec.header);
      } catch (err) {
        // The error only, never the submitted values: they're personal data.
        console.error(`forms: ${form} submission from ${site || 'unknown site'} was not saved: ${(err as Error).message}`);
        return reply(c, 502, 'Your form could not be saved. Please try again later.');
      }
      db.audit('public', 'form.submit', form, { site });
      return reply(c, 200);
    });
  }
}

// Sheets API v4 as the Cloud Run service account (token from the metadata server). Each spreadsheet must be
// shared with that account as an Editor.
export function googleSheets(fetchImpl: typeof fetch = fetch): Sheets {
  const TOKEN_URL = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token?scopes=https://www.googleapis.com/auth/spreadsheets';
  const API = 'https://sheets.googleapis.com/v4/spreadsheets';
  let token: { value: string; expires: number } | null = null;
  let pending: Promise<string> | null = null;
  const titles = new Map<string, string>();

  async function accessToken(): Promise<string> {
    // Reused until a minute before it expires.
    if (token && token.expires > Date.now() + 60_000) return token.value;
    pending ??= (async () => {
      const res = await fetchImpl(TOKEN_URL, { headers: { 'Metadata-Flavor': 'Google' } });
      if (!res.ok) throw new Error(`metadata server token: HTTP ${res.status}`);
      const body = (await res.json()) as { access_token: string; expires_in: number };
      token = { value: body.access_token, expires: Date.now() + body.expires_in * 1000 };
      return body.access_token;
    })().finally(() => { pending = null; });
    return pending;
  }

  async function call(url: string, init: RequestInit = {}): Promise<any> {
    const res = await fetchImpl(url, { ...init, headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${await accessToken()}` } });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
      throw new Error(`Sheets API HTTP ${res.status}: ${body?.error?.message ?? res.statusText}`);
    }
    return res.json();
  }

  // The first sheet's name, quoted for A1 notation.
  async function sheet(id: string): Promise<string> {
    let title = titles.get(id);
    if (!title) {
      const meta = await call(`${API}/${encodeURIComponent(id)}?fields=sheets.properties.title`);
      title = String(meta.sheets?.[0]?.properties?.title ?? 'Sheet1');
      titles.set(id, title);
    }
    return `'${title.replace(/'/g, "''")}'`;
  }

  return {
    async firstRow(id) {
      const range = `${await sheet(id)}!1:1`;
      const body = await call(`${API}/${encodeURIComponent(id)}/values/${encodeURIComponent(range)}`);
      return (body.values?.[0] ?? []).map(String);
    },
    async append(id, rows) {
      const range = await sheet(id);
      await call(`${API}/${encodeURIComponent(id)}/values/${encodeURIComponent(range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: rows }),
      });
    },
  };
}
