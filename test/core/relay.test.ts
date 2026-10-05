import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Webhook } from 'standardwebhooks';
import { describe, expect, it } from 'vitest';
import { Catalog } from '../../src/core/catalog.js';
import { defineConfig, resolveConfig } from '../../src/core/config.js';
import { HookdeckClient } from '../../src/core/hookdeck.js';
import { MemoryStore } from '../../src/core/memory-store.js';
import { Relay, failureReason } from '../../src/core/relay.js';
import { generateWebhookSecret } from '../../src/core/secret.js';
import { healthyDelivery, type SubscriptionInput } from '../../src/core/store.js';
import { resend } from '../../src/providers.js';
import { FakeEventGateway } from '../support/fake-event-gateway.js';

const SIGNING_SECRET = 'hookdeck-signing-secret';
const fixture = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'fixtures', 'resend', 'email-received.json'), 'utf8')) as {
  headers: Record<string, string>;
  body: { data: Record<string, unknown> };
};
// The fixture's email arrived at 2026-10-05T16:22:42.897Z.
const OCCURRED = '2026-10-05T16:22:42.897Z';

const config = resolveConfig(defineConfig({ deployment: 'dev', providers: [resend({ apiKey: 'x' })] }), { HOOKDECK_API_KEY: 'k', HOOKDECK_SIGNING_SECRET: SIGNING_SECRET });

function setup(now = new Date('2026-10-05T16:30:00.000Z')) {
  const gateway = new FakeEventGateway();
  const store = new MemoryStore();
  const logs: string[] = [];
  const relay = new Relay({
    signingSecret: SIGNING_SECRET,
    providerIds: ['resend'],
    catalog: new Catalog(config.providers),
    store,
    hookdeck: new HookdeckClient({ apiKey: 'k', fetch: gateway.fetch }),
    now: () => now,
    log: (m) => logs.push(m),
  });
  return { gateway, store, relay, logs };
}

const signed = (rawBody: string, extra: Record<string, string> = {}) => ({
  ...extra,
  'x-hookdeck-signature': createHmac('sha256', SIGNING_SECRET).update(rawBody).digest('base64'),
});

const subscription = (over: Partial<SubscriptionInput> = {}): SubscriptionInput => ({
  id: 'sub_a',
  principal: 'owner',
  name: 'email.received',
  arguments: {},
  url: 'https://receiver.example.com/a',
  secret: generateWebhookSecret(),
  previousSecret: null,
  previousSecretExpiresAt: null,
  delivery: healthyDelivery(),
  expiresAt: '2026-11-05T00:00:00.000Z',
  createdAt: '2026-10-05T16:00:00.000Z',
  updatedAt: '2026-10-05T16:00:00.000Z',
  ...over,
});

const inbound = (relay: Relay, body: unknown = fixture.body) => {
  const raw = JSON.stringify(body);
  return relay.handle('/inbound/resend', signed(raw, fixture.headers), raw);
};

describe('Relay: provider events', () => {
  it('rejects requests without a valid Hookdeck signature', async () => {
    const { relay } = setup();
    const raw = JSON.stringify(fixture.body);
    expect((await relay.handle('/inbound/resend', { ...fixture.headers, 'x-hookdeck-signature': 'bad' }, raw)).status).toBe(401);
    expect((await relay.handle('/inbound/resend', fixture.headers, raw)).status).toBe(401);
  });

  it('accepts the rotation signature header too', async () => {
    const { relay } = setup();
    const raw = JSON.stringify(fixture.body);
    const headers = { ...fixture.headers, 'x-hookdeck-signature': 'old', 'x-hookdeck-signature-2': signed(raw)['x-hookdeck-signature'] };
    expect((await relay.handle('/inbound/resend', headers, raw)).status).toBe(200);
  });

  it('publishes one Standard Webhooks request per matching subscriber, to the topic source', async () => {
    const { relay, store, gateway } = setup();
    const a = await store.put(subscription());
    await store.put(subscription({ id: 'sub_b', arguments: { from: 'someone-else@example.com' } }));
    const response = await inbound(relay);
    expect(response).toEqual({ status: 200, body: { published: 1 } });
    expect(gateway.published).toHaveLength(1);
    const [published] = gateway.published;
    expect(published!.sourceName).toBe('bridge-out-email_received');
    expect(published!.headers).toMatchObject({ 'webhook-id': fixture.headers['svix-id'], 'X-MCP-Subscription-Id': 'sub_a' });
    const envelope = new Webhook(a.secret).verify(published!.body, published!.headers) as Record<string, unknown>;
    expect(envelope).toMatchObject({ eventId: fixture.headers['svix-id'], name: 'email.received', timestamp: OCCURRED, cursor: null });
    expect(envelope.data).toMatchObject({ fromAddress: 'sender@example.com', subject: 'Spike 3: inbound test' });
  });

  it('dual-signs during a rotation grace window', async () => {
    const { relay, store, gateway } = setup();
    const previous = generateWebhookSecret();
    await store.put(subscription({ previousSecret: previous, previousSecretExpiresAt: '2026-10-05T16:40:00.000Z' }));
    await inbound(relay);
    const [published] = gateway.published;
    expect(published!.headers['webhook-signature']!.split(' ')).toHaveLength(2);
    expect(() => new Webhook(previous).verify(published!.body, published!.headers)).not.toThrow();
  });

  it('skips subscriptions created after the event happened, and expired ones', async () => {
    const { relay, store, gateway } = setup();
    await store.put(subscription({ id: 'sub_late', createdAt: '2026-10-05T16:25:00.000Z' }));
    await store.put(subscription({ id: 'sub_expired', expiresAt: '2026-10-05T16:29:00.000Z' }));
    expect(await inbound(relay)).toEqual({ status: 200, body: { published: 0 } });
    expect(gateway.published).toHaveLength(0);
  });

  it('returns 502 if any publish fails, so Event Gateway retries the inbound event', async () => {
    const { relay, store, gateway } = setup();
    await store.put(subscription());
    await store.put(subscription({ id: 'sub_b' }));
    gateway.failPublishFor.add('sub_b');
    expect(await inbound(relay)).toEqual({ status: 502, body: { error: 'publish failed', failed: 1 } });
    expect(gateway.published.map((p) => p.headers['X-MCP-Subscription-Id'])).toEqual(['sub_a']);
  });

  it('ignores event types that are not enabled, and unknown provider instances', async () => {
    const { relay } = setup();
    expect((await inbound(relay, { type: 'email.sent' })).body).toEqual({ ignored: 'event type not enabled' });
    const raw = JSON.stringify(fixture.body);
    expect((await relay.handle('/inbound/github', signed(raw), raw)).status).toBe(404);
  });
});

describe('Relay: issue notifications', () => {
  const notify = (relay: Relay, issueId: string, topic = 'issue.opened') => {
    // The payload is only a hint; the relay reads the issue from the API.
    const raw = JSON.stringify({ topic, issue: { id: issueId, type: 'delivery' } });
    return relay.handle('/inbound/hookdeck', signed(raw), raw);
  };

  it('deletes a subscription whose callback returned 410, then resolves the issue', async () => {
    const { relay, store, gateway } = setup();
    const record = await store.put(subscription());
    gateway.issues.set('iss_1', { id: 'iss_1', type: 'delivery', status: 'OPENED', aggregation_keys: { webhook_id: [record.connectionId], response_status: [410], error_code: [] } });
    expect((await notify(relay, 'iss_1')).body).toEqual({ handled: 'deleted' });
    expect(store.get(record.id)).toBeUndefined();
    expect(gateway.issues.get('iss_1')!.status).toBe('RESOLVED');
  });

  it('records other failures as delivery state', async () => {
    const { relay, store, gateway } = setup();
    const record = await store.put(subscription());
    gateway.issues.set('iss_2', { id: 'iss_2', type: 'delivery', status: 'OPENED', aggregation_keys: { webhook_id: [record.connectionId], response_status: [503], error_code: [] } });
    expect((await notify(relay, 'iss_2')).body).toEqual({ handled: 'recorded' });
    expect(store.get(record.id)!.delivery).toEqual({ active: false, lastError: 'http_5xx', failedSince: '2026-10-05T16:30:00.000Z' });
  });

  it('trusts the API over the payload: a forged or already-resolved issue changes nothing', async () => {
    const { relay, store, gateway } = setup();
    const record = await store.put(subscription());
    expect((await notify(relay, 'iss_unknown')).status).toBe(500);
    gateway.issues.set('iss_3', { id: 'iss_3', type: 'delivery', status: 'RESOLVED', aggregation_keys: { webhook_id: [record.connectionId], response_status: [410] } });
    expect((await notify(relay, 'iss_3')).body).toEqual({ ignored: 'issue is RESOLVED' });
    expect(store.get(record.id)).toBeDefined();
  });

  it('ignores updates and non-subscription connections, and logs other issue types', async () => {
    const { relay, gateway, logs } = setup();
    expect((await notify(relay, 'iss_x', 'issue.updated')).body).toEqual({ ignored: 'not an opened issue' });
    gateway.issues.set('iss_4', { id: 'iss_4', type: 'delivery', status: 'OPENED', aggregation_keys: { webhook_id: ['web_other'], response_status: [500] } });
    expect((await notify(relay, 'iss_4')).body).toEqual({ ignored: 'not a subscription connection' });
    gateway.issues.set('iss_5', { id: 'iss_5', type: 'request', status: 'OPENED', aggregation_keys: { rejection_cause: ['VERIFICATION_FAILED'] } });
    expect((await notify(relay, 'iss_5')).body).toEqual({ logged: 'request' });
    expect(logs.some((l) => l.includes('VERIFICATION_FAILED'))).toBe(true);
  });
});

describe('failureReason', () => {
  it.each([
    [503, null, 'http_5xx'],
    [404, null, 'http_4xx'],
    [null, 'TIMEOUT', 'timeout'],
    [null, 'TLS_ERROR', 'tls_error'],
    [null, 'ECONNREFUSED', 'connection_refused'],
  ] as const)('%s %s -> %s', (status, code, reason) => {
    expect(failureReason(status, code)).toBe(reason);
  });
});
