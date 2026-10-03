// The services check: asks each service games depend on (SERVICES in src/site-checks.ts) for its answer, with plain
// HTTP, no browser. A service that answers is asked once, whatever it says; one that doesn't gets one more try, 2 s
// later.
import { serviceFindings } from '../site-checks.ts';
import type { RawFinding, Service, ServiceSeen } from '../site-checks.ts';
import { errorOf } from './net.ts';
import type { Getter } from './net.ts';
import { sleep } from './util.ts';

const TIMEOUT_MS = 20_000;
const BODY_BYTES = 4000;

async function ask(get: Getter, url: string, signal?: AbortSignal): Promise<ServiceSeen> {
  const t = Date.now();
  try {
    const res = await get(url, TIMEOUT_MS, signal);
    const body = await res.text(BODY_BYTES).catch(() => '');
    res.close();
    return { status: res.status, error: null, ms: Date.now() - t, body: body.slice(0, BODY_BYTES) };
  } catch (err) {
    return { status: null, error: errorOf(err), ms: null, body: '' };
  }
}

export async function checkServices(get: Getter, services: readonly Service[], signal?: AbortSignal): Promise<{ checked: number; findings: RawFinding[] }> {
  const findings: RawFinding[] = [];
  for (const service of services) {
    let seen = await ask(get, service.url, signal);
    if (seen.error && seen.error.code !== 'BLOCKED' && !signal?.aborted) {
      await sleep(2000);
      seen = await ask(get, service.url, signal);
    }
    findings.push(...serviceFindings(service, seen));
  }
  return { checked: services.length, findings };
}
