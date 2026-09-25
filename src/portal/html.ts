// Minimal HTML templating: every interpolated value is escaped unless it's already Html
// (the result of another html`` call) or an array of those.
export class Html {
  readonly value: string;
  constructor(value: string) { this.value = value; }
  toString() { return this.value; }
}

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escape = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

function render(v: unknown): string {
  if (v instanceof Html) return v.value;
  if (Array.isArray(v)) return v.map(render).join('');
  if (v === null || v === undefined || v === false) return '';
  return escape(v);
}

export function html(strings: TemplateStringsArray, ...values: unknown[]): Html {
  let out = strings[0];
  values.forEach((v, i) => { out += render(v) + strings[i + 1]; });
  return new Html(out);
}

export const raw = (s: string) => new Html(s);
