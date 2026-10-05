import { describe, expect, it } from 'vitest';
import { Webhook } from 'standardwebhooks';
import { CallbackUrlError, parseCallbackUrl, verifyEndpoint, type CallbackTransport, type PostResult } from '../../src/core/callback.js';
import { generateWebhookSecret } from '../../src/core/secret.js';

describe('parseCallbackUrl', () => {
  it('accepts https URLs', () => {
    expect(parseCallbackUrl('https://example.com/hook').href).toBe('https://example.com/hook');
  });

  it.each(['http://example.com/hook', 'http://localhost:4000/hook', 'not a url', 'ftp://example.com/x', 'https://user:pass@example.com/x', 42])(
    'rejects %s',
    (value) => {
      expect(() => parseCallbackUrl(value)).toThrow(CallbackUrlError);
    },
  );
});

/** A transport that answers with a canned result and records what it was sent. */
function fakeTransport(respond: (body: string) => PostResult | Error) {
  const sent: Array<{ url: URL; body: string; headers: Record<string, string> }> = [];
  const transport: CallbackTransport = {
    assertPublicHost: async () => {},
    post: async (url, body, headers) => {
      sent.push({ url, body, headers });
      const result = respond(body);
      if (result instanceof Error) throw result;
      return result;
    },
  };
  return { transport, sent };
}

const verify = (transport: CallbackTransport, secret = generateWebhookSecret()) =>
  verifyEndpoint(transport, { url: new URL('https://receiver.example.com/hook'), secret, subscriptionId: 'sub_test', timeoutMs: 500 });

describe('verifyEndpoint', () => {
  it('sends a signed verification envelope and succeeds when the challenge is echoed', async () => {
    const secret = generateWebhookSecret();
    const { transport, sent } = fakeTransport((body) => ({ status: 200, body: JSON.stringify({ challenge: JSON.parse(body).challenge }) }));
    await expect(verify(transport, secret)).resolves.toEqual({ ok: true });
    const [request] = sent;
    expect(new Webhook(secret).verify(request!.body, request!.headers)).toMatchObject({ type: 'verification' });
    expect(request!.headers['webhook-id']).toMatch(/^msg_verification_[0-9a-f]+$/);
    expect(request!.headers['X-MCP-Subscription-Id']).toBe('sub_test');
    expect(request!.headers['content-type']).toBe('application/json');
  });

  it('uses a fresh challenge each time', async () => {
    const { transport, sent } = fakeTransport((body) => ({ status: 200, body: JSON.stringify({ challenge: JSON.parse(body).challenge }) }));
    await verify(transport);
    await verify(transport);
    expect(JSON.parse(sent[0]!.body).challenge).not.toBe(JSON.parse(sent[1]!.body).challenge);
  });

  it.each([
    ['a wrong challenge', { status: 200, body: '{"challenge":"nope"}' }, 'challenge_failed'],
    ['a non-JSON body', { status: 200, body: 'OK' }, 'challenge_failed'],
    ['an empty 204', { status: 204, body: '' }, 'challenge_failed'],
    ['a redirect', { status: 307, body: '' }, 'challenge_failed'],
    ['a 404', { status: 404, body: '' }, 'http_4xx'],
    ['a 500', { status: 500, body: '' }, 'http_5xx'],
  ])('fails on %s', async (_label, result, reason) => {
    await expect(verify(fakeTransport(() => result).transport)).resolves.toEqual({ ok: false, reason });
  });

  it.each([
    ['ETIMEDOUT', 'timeout'],
    ['ERR_TLS_CERT_ALTNAME_INVALID', 'tls_error'],
    ['ECONNREFUSED', 'connection_refused'],
    ['EADDRBLOCKED', 'connection_refused'],
  ])('classifies %s as %s', async (code, reason) => {
    const error = Object.assign(new Error(code), { code });
    await expect(verify(fakeTransport(() => error).transport)).resolves.toEqual({ ok: false, reason });
  });
});
