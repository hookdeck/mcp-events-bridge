import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { emailReceived, resendProvider as resend } from '../../../src/core/providers/resend.js';
import { normalizeAddress, type InboundRequest } from '../../../src/core/providers/types.js';

const fixture = JSON.parse(
  fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'fixtures', 'resend', 'email-received.json'), 'utf8'),
) as { headers: Record<string, string>; body: Record<string, unknown> };

const request: InboundRequest = { headers: fixture.headers, body: fixture.body };
const withData = (data: Record<string, unknown>): InboundRequest => ({
  headers: fixture.headers,
  body: { ...fixture.body, data: { ...(fixture.body.data as object), ...data } },
});

describe('normalizeAddress', () => {
  it.each([
    ['Alice@Example.com', 'alice@example.com'],
    ['Alice Smith <Alice@Example.com>', 'alice@example.com'],
    ['"Smith, Alice" <alice@example.com> ', 'alice@example.com'],
    ['  bob@example.com  ', 'bob@example.com'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeAddress(input)).toBe(expected);
  });
});

describe('Resend email.received (stage 2 fixture)', () => {
  it('matches the email.received type only', () => {
    expect(emailReceived.matches(request)).toBe(true);
    expect(emailReceived.matches({ headers: {}, body: { type: 'email.sent' } })).toBe(false);
    expect(emailReceived.matches({ headers: {}, body: null })).toBe(false);
  });

  it('uses svix-id as the event id', () => {
    expect(emailReceived.eventId(request)).toBe('msg_3KHbIt3gcFjtCyW4hdA6Ug4T61H');
    expect(() => emailReceived.eventId({ headers: {}, body: fixture.body })).toThrow(/svix-id/);
  });

  it('uses data.created_at as the occurred-at time', () => {
    expect(emailReceived.occurredAt(request)).toBe('2026-10-05T16:22:42.897Z');
  });

  it('summarizes metadata with normalized addresses', () => {
    expect(emailReceived.summarize(request)).toEqual({
      emailId: '8bb0cabf-ebb8-4f85-9a67-37c52a6646cc',
      from: 'sender@example.com',
      fromAddress: 'sender@example.com',
      to: ['bridge-test@inbound.example.com'],
      toAddresses: ['bridge-test@inbound.example.com'],
      cc: [],
      subject: 'Spike 3: inbound test',
      messageId: '<message-id@mail.example.com>',
      attachmentCount: 0,
    });
  });

  it('normalizes display-name senders and trims long subjects', () => {
    const summary = emailReceived.summarize(withData({ from: 'Alice <Alice@Example.com>', subject: 'x'.repeat(600) }));
    expect(summary.fromAddress).toBe('alice@example.com');
    expect(summary.subject).toHaveLength(501);
  });

  it('keeps the summary well under 256 KiB', () => {
    const summary = emailReceived.summarize(withData({ to: Array.from({ length: 50 }, (_, i) => `user${i}@example.com`) }));
    expect(Buffer.byteLength(JSON.stringify(summary))).toBeLessThan(16 * 1024);
  });

  it('parses and normalizes subscribe arguments, rejecting unknown ones', () => {
    expect(emailReceived.parseArguments({ from: 'Alice <Alice@Example.com>' })).toEqual({ from: 'alice@example.com' });
    expect(emailReceived.parseArguments(undefined)).toEqual({});
    expect(() => emailReceived.parseArguments({ subject: 'x' })).toThrow();
    expect(() => emailReceived.parseArguments({ from: 42 })).toThrow();
  });

  it('accepts by sender and recipient', () => {
    const summary = emailReceived.summarize(request);
    expect(emailReceived.accepts({}, summary)).toBe(true);
    expect(emailReceived.accepts(emailReceived.parseArguments({ from: 'Sender@Example.com' }), summary)).toBe(true);
    expect(emailReceived.accepts(emailReceived.parseArguments({ from: 'someone@example.com' }), summary)).toBe(false);
    expect(emailReceived.accepts(emailReceived.parseArguments({ to: 'bridge-test@inbound.example.com' }), summary)).toBe(true);
    expect(emailReceived.accepts(emailReceived.parseArguments({ to: 'other@inbound.example.com' }), summary)).toBe(false);
  });

  it('publishes JSON Schemas for arguments and payload', () => {
    expect(emailReceived.inputSchema).toMatchObject({ type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } } });
    expect(emailReceived.payloadSchema).toMatchObject({ type: 'object', required: expect.arrayContaining(['emailId', 'fromAddress']) });
  });
});

describe('Resend register and unregister', () => {
  it('creates the webhook at the source URL and returns its secret', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ object: 'webhook', id: 'wh_1', signing_secret: 'whsec_abc' }), { status: 201 });
    }) as unknown as typeof fetch;
    const result = await resend.register!({ sourceUrl: 'https://hkdk.events/abc', providerEvents: ['email.received'], options: { apiKey: 're_test' }, fetch: fetchFn });
    expect(result).toEqual({ webhookId: 'wh_1', signingSecret: 'whsec_abc' });
    expect(calls[0]!.url).toBe('https://api.resend.com/webhooks');
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ endpoint: 'https://hkdk.events/abc', events: ['email.received'] });
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer re_test');
  });

  it('fails clearly when Resend rejects the key', async () => {
    const fetchFn = (async () => new Response('{"message":"API key is invalid"}', { status: 401 })) as unknown as typeof fetch;
    await expect(
      resend.register!({ sourceUrl: 'https://hkdk.events/abc', providerEvents: ['email.received'], options: { apiKey: 'bad' }, fetch: fetchFn }),
    ).rejects.toThrow(/401/);
  });

  it('deletes the webhook', async () => {
    const calls: string[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      calls.push(`${init.method} ${url}`);
      return new Response('{"deleted":true}', { status: 200 });
    }) as unknown as typeof fetch;
    await resend.unregister!({ webhookId: 'wh_1', sourceUrl: 'https://hkdk.events/abc', options: { apiKey: 're_test' }, fetch: fetchFn });
    expect(calls).toEqual(['DELETE https://api.resend.com/webhooks/wh_1']);
  });
});
