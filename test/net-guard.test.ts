// Fetching addresses people type into the portal: only public http(s) hosts, checked again on every redirect.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { blockedAddress, BlockedUrlError, checkUrl, guardedFetcher, publicLookup, type Lookup } from '../src/net-guard.ts';

describe('which addresses may be fetched', () => {
  test('private, loopback, link-local and other non-public IPv4 addresses are blocked', () => {
    for (const ip of ['127.0.0.1', '127.8.9.1', '10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '0.0.0.0', '100.64.0.1',
      '192.0.0.8', '192.0.2.1', '198.18.0.1', '198.51.100.7', '203.0.113.9', '224.0.0.1', '255.255.255.255']) {
      assert.ok(blockedAddress(ip), ip);
    }
    for (const ip of ['8.8.8.8', '93.184.216.34', '172.15.0.1', '172.32.0.1', '192.167.1.1', '100.63.0.1', '169.253.1.1']) assert.equal(blockedAddress(ip), null, ip);
  });

  test('IPv6: loopback, private, link-local, and IPv4 addresses wrapped in IPv6', () => {
    for (const ip of ['::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'fe80::1%eth0', 'ff02::1', '::ffff:127.0.0.1', '::ffff:10.1.2.3', '::ffff:a9fe:a9fe',
      '64:ff9b::10.0.0.1', '::127.0.0.1', '2002:7f00:1::', '2001:db8::1', '2001:0:1::']) {
      assert.ok(blockedAddress(ip), ip);
    }
    for (const ip of ['2606:4700:4700::1111', '2001:4860:4860::8888', '::ffff:8.8.8.8', '64:ff9b::8.8.8.8']) assert.equal(blockedAddress(ip), null, ip);
    assert.ok(blockedAddress('not-an-ip'));
  });

  test('only http(s), no credentials, no private names or address literals (however they’re written)', () => {
    for (const bad of ['ftp://example.org/', 'file:///etc/passwd', 'gopher://example.org/', 'https://user:pw@example.org/', 'http://localhost/', 'http://printer/',
      'http://app.internal/', 'http://thing.local/', 'http://127.0.0.1/', 'http://2130706433/', 'http://0x7f.0.0.1/', 'http://017700000001/', 'http://[::1]/',
      'http://[::ffff:169.254.169.254]/', 'http://169.254.169.254/latest/meta-data/', 'http://10.1.2.3:8080/']) {
      assert.throws(() => checkUrl(new URL(bad)), BlockedUrlError, bad);
    }
    for (const ok of ['https://games.example.org/x/', 'http://example.org:8080/', 'https://8.8.8.8/']) checkUrl(new URL(ok));
  });

  test('a name that resolves to a private address is refused when connecting', async () => {
    await assert.rejects(new Promise((resolve, reject) => publicLookup('localhost', {}, (err, a) => (err ? reject(err) : resolve(a)))), /only public web addresses/);
  });
});

describe('following redirects', () => {
  let server: Server, port: number;
  // Resolves the made-up public names to the local test server; everything else gets the real, checking lookup.
  const lookup: Lookup = (host, opts, cb) => {
    if (host === 'games.test' || host === 'other.test') return opts.all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4);
    return publicLookup(host, opts, cb);
  };
  before(async () => {
    server = createServer((req, res) => {
      const to = new URL(req.url!, 'http://x').searchParams.get('to');
      if (req.url!.startsWith('/redirect') && to) { res.writeHead(302, { Location: to }); res.end(); return; }
      if (req.url === '/loop') { res.writeHead(302, { Location: '/loop' }); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'text/plain', ETag: '"v1"' }); res.end(`hello from ${req.headers.host}${req.url}`);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });
  after(() => server.close());
  const text = async (body: AsyncIterable<Buffer>) => { let s = ''; for await (const c of body) s += c; return s; };

  test('a public address is fetched, and same-site redirects are followed', async () => {
    const fetcher = guardedFetcher(lookup);
    const res = await fetcher(`http://games.test:${port}/redirect?to=/game/index.html`, { origin: `http://games.test:${port}` });
    assert.equal(res.status, 200);
    assert.equal(res.headers.etag, '"v1"');
    assert.equal(await text(res.body), `hello from games.test:${port}/game/index.html`);
  });

  test('a redirect to a private address is refused, whatever form it takes', async () => {
    const fetcher = guardedFetcher(lookup);
    for (const to of [`http://127.0.0.1:${port}/secret`, 'http://169.254.169.254/latest/meta-data/', `http://localhost:${port}/secret`, 'http://[::1]/', 'file:///etc/passwd', 'http://10.0.0.1/']) {
      await assert.rejects(fetcher(`http://games.test:${port}/redirect?to=${encodeURIComponent(to)}`), (err: Error) => err instanceof BlockedUrlError || /only public web addresses/.test(err.message), to);
    }
  });

  test('with an origin, a redirect to another site is refused', async () => {
    const fetcher = guardedFetcher(lookup);
    await assert.rejects(fetcher(`http://games.test:${port}/redirect?to=${encodeURIComponent(`http://other.test:${port}/x`)}`, { origin: `http://games.test:${port}` }), /redirects to another site/);
    assert.equal((await fetcher(`http://games.test:${port}/redirect?to=${encodeURIComponent(`http://other.test:${port}/x`)}`)).status, 200); // allowed without one
  });

  test('redirect loops end', async () => {
    await assert.rejects(guardedFetcher(lookup)(`http://games.test:${port}/loop`), /too many times/);
  });

  test('the default fetcher won’t connect to this machine at all', async () => {
    await assert.rejects(guardedFetcher()(`http://127.0.0.1:${port}/`), BlockedUrlError);
    await assert.rejects(guardedFetcher()(`http://localhost:${port}/`), BlockedUrlError);
  });
});
