import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { Webhook } from 'standardwebhooks';
import { CallbackUrlError, verifyEndpoint } from '../../src/core/callback.js';
import { generateWebhookSecret } from '../../src/core/secret.js';
import { createNodeCallbackTransport, isPublicAddress } from '../../src/host/callback-transport.js';

const strict = createNodeCallbackTransport();
const local = createNodeCallbackTransport({ allowNonPublic: true });

describe('isPublicAddress', () => {
  it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '::ffff:8.8.8.8'])('allows public %s', (ip) => {
    expect(isPublicAddress(ip)).toBe(true);
  });

  it.each([
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1',
    '0.0.0.0', '192.0.2.10', '198.18.0.1', '224.0.0.1', '255.255.255.255',
    '::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1',
    '2001:db8::1', '2002:c0a8:0101::1', 'not-an-ip',
  ])('blocks %s', (ip) => {
    expect(isPublicAddress(ip)).toBe(false);
  });
});

describe('assertPublicHost', () => {
  it.each(['https://127.0.0.1/x', 'https://[::1]/x', 'https://10.0.0.5/x', 'https://169.254.169.254/latest', 'https://localhost/x'])(
    'blocks %s by default',
    async (url) => {
      await expect(strict.assertPublicHost(new URL(url))).rejects.toThrow(CallbackUrlError);
    },
  );

  it('allows them on the test-only transport', async () => {
    await expect(local.assertPublicHost(new URL('https://127.0.0.1/x'))).resolves.toBeUndefined();
  });

  it('allows public IP literals', async () => {
    await expect(strict.assertPublicHost(new URL('https://8.8.8.8/x'))).resolves.toBeUndefined();
  });
});

describe('post connect-time checks', () => {
  it('refuses to connect to a loopback hostname even if the subscribe-time check was skipped', async () => {
    const target = await listen((_req, res) => res.end('should not be reached'));
    await expect(
      strict.post(new URL(`http://localhost:${target.port}/x`), '{}', {}, { timeoutMs: 1000 }),
    ).rejects.toMatchObject({ code: 'EADDRBLOCKED' });
    await expect(
      strict.post(new URL(`http://127.0.0.1:${target.port}/x`), '{}', {}, { timeoutMs: 1000 }),
    ).rejects.toMatchObject({ code: 'EADDRBLOCKED' });
    expect(target.hits).toBe(0);
  });
});

// --- endpoint verification -------------------------------------------------

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => { s.closeAllConnections(); s.close(r); })));
});

async function listen(handler: (req: http.IncomingMessage, res: http.ServerResponse, raw: string) => void) {
  const state = { port: 0, hits: 0 };
  const server = http.createServer(async (req, res) => {
    state.hits++;
    let raw = '';
    for await (const chunk of req) raw += chunk;
    handler(req, res, raw);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  state.port = (server.address() as { port: number }).port;
  return state;
}

const verifyAt = (port: number, secret = generateWebhookSecret(), path = '/hook') =>
  verifyEndpoint(local, { url: new URL(`http://127.0.0.1:${port}${path}`), secret, subscriptionId: 'sub_test', timeoutMs: 500 });

describe('verifyEndpoint over the Node transport', () => {
  it('sends a signed verification envelope and succeeds when the challenge is echoed', async () => {
    const secret = generateWebhookSecret();
    let seen: { headers: http.IncomingHttpHeaders; body: { type: string; challenge: string } } | undefined;
    const target = await listen((req, res, raw) => {
      const body = new Webhook(secret).verify(raw, req.headers as Record<string, string>) as { type: string; challenge: string };
      seen = { headers: req.headers, body };
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ challenge: body.challenge }));
    });
    await expect(verifyAt(target.port, secret)).resolves.toEqual({ ok: true });
    expect(seen?.body.type).toBe('verification');
    expect(seen?.headers['webhook-id']).toMatch(/^msg_verification_[0-9a-f]+$/);
    expect(seen?.headers['x-mcp-subscription-id']).toBe('sub_test');
    expect(seen?.headers['content-type']).toBe('application/json');
  });

  it('uses a fresh challenge each time', async () => {
    const challenges: string[] = [];
    const target = await listen((_req, res, raw) => {
      const { challenge } = JSON.parse(raw);
      challenges.push(challenge);
      res.end(JSON.stringify({ challenge }));
    });
    await verifyAt(target.port);
    await verifyAt(target.port);
    expect(challenges[0]).not.toBe(challenges[1]);
  });

  it.each([
    ['a wrong challenge', 200, '{"challenge":"nope"}', 'challenge_failed'],
    ['a non-JSON body', 200, 'OK', 'challenge_failed'],
    ['an empty 204', 204, '', 'challenge_failed'],
    ['a 404', 404, '', 'http_4xx'],
    ['a 500', 500, '', 'http_5xx'],
  ])('fails on %s', async (_label, status, body, reason) => {
    const target = await listen((_req, res) => res.writeHead(status).end(body));
    await expect(verifyAt(target.port)).resolves.toEqual({ ok: false, reason });
  });

  it('does not follow redirects', async () => {
    const elsewhere = await listen((_req, res, raw) => res.end(JSON.stringify({ challenge: JSON.parse(raw).challenge })));
    const redirector = await listen((_req, res) => res.writeHead(307, { location: `http://127.0.0.1:${elsewhere.port}/hook` }).end());
    await expect(verifyAt(redirector.port)).resolves.toEqual({ ok: false, reason: 'challenge_failed' });
    expect(elsewhere.hits).toBe(0);
  });

  it('reports timeouts', async () => {
    const target = await listen(() => {
      /* never respond */
    });
    await expect(verifyAt(target.port)).resolves.toEqual({ ok: false, reason: 'timeout' });
  });

  it('reports refused connections', async () => {
    const target = await listen(() => {});
    const port = target.port;
    await new Promise((r) => { servers[0]!.closeAllConnections(); servers.shift()!.close(r); });
    await expect(verifyAt(port)).resolves.toEqual({ ok: false, reason: 'connection_refused' });
  });
});
