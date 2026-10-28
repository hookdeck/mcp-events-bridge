import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { HookdeckClient } from '../../src/core/hookdeck.js';
import { MemoryStore } from '../../src/core/memory-store.js';
import { Notifications, failureReason } from '../../src/core/notifications.js';
import { generateWebhookSecret } from '../../src/core/secret.js';
import { healthyDelivery, type SubscriptionInput } from '../../src/core/store.js';
import { FakeEventGateway } from '../support/fake-event-gateway.js';

const SIGNING_SECRET = 'hookdeck-signing-secret';

function setup(now = new Date('2026-10-05T16:30:00.000Z')) {
  const gateway = new FakeEventGateway();
  const store = new MemoryStore();
  const logs: string[] = [];
  const notifications = new Notifications({
    signingSecret: SIGNING_SECRET,
    store,
    hookdeck: new HookdeckClient({ apiKey: 'k', fetch: gateway.fetch }),
    now: () => now,
    log: (m) => logs.push(m),
  });
  return { gateway, store, notifications, logs };
}

const signed = (rawBody: string, extra: Record<string, string> = {}) => ({
  ...extra,
  'x-hookdeck-signature': createHmac('sha256', SIGNING_SECRET).update(rawBody).digest('base64'),
});

const subscription = (over: Partial<SubscriptionInput> = {}): SubscriptionInput => ({
  id: 'sub_a',
  principal: 'owner',
  name: 'resend.email.received',
  arguments: {},
  url: 'https://receiver.example.com/a',
  secret: generateWebhookSecret(),
  replay: null,
  delivery: healthyDelivery(),
  expiresAt: '2026-11-05T00:00:00.000Z',
  createdAt: '2026-10-05T16:00:00.000Z',
  updatedAt: '2026-10-05T16:00:00.000Z',
  ...over,
});

const notify = (notifications: Notifications, issueId: string, topic = 'issue.opened', path = '/inbound/hookdeck') => {
  // The payload is only a hint; the bridge reads the issue from the API.
  const raw = JSON.stringify({ topic, issue: { id: issueId, type: 'delivery' } });
  return notifications.handle(path, signed(raw), raw);
};

describe('Notifications: requests', () => {
  it('rejects requests without a valid Hookdeck signature', async () => {
    const { notifications } = setup();
    const raw = JSON.stringify({ topic: 'issue.opened', issue: { id: 'iss_1' } });
    expect((await notifications.handle('/inbound/hookdeck', { 'x-hookdeck-signature': 'bad' }, raw)).status).toBe(401);
    expect((await notifications.handle('/inbound/hookdeck', {}, raw)).status).toBe(401);
  });

  it('accepts a trailing slash, as Event Gateway sends when it joins paths, and the rotation signature header', async () => {
    const { notifications } = setup();
    expect((await notify(notifications, 'iss_x', 'issue.updated', '/inbound/hookdeck/')).status).toBe(200);
    const raw = JSON.stringify({ topic: 'issue.updated' });
    const headers = { 'x-hookdeck-signature': 'old', 'x-hookdeck-signature-2': signed(raw)['x-hookdeck-signature'] };
    expect((await notifications.handle('/inbound/hookdeck', headers, raw)).status).toBe(200);
  });

  it("answers 404 for any other path: events don't pass through the bridge", async () => {
    const { notifications } = setup();
    const raw = JSON.stringify({ type: 'email.received' });
    expect((await notifications.handle('/inbound/resend', signed(raw), raw)).status).toBe(404);
  });

  it('ignores a body that is not JSON with 200, so Event Gateway does not retry it', async () => {
    const { notifications } = setup();
    expect((await notifications.handle('/inbound/hookdeck', signed('not json'), 'not json')).body).toEqual({ ignored: 'body is not JSON' });
  });
});

describe('Notifications: issues', () => {
  it('keeps a subscription whose callback returned 410, with its delivery state unchanged, and resolves the issue', async () => {
    const { notifications, store, gateway } = setup();
    const record = await store.put(subscription());
    gateway.issues.set('iss_1', { id: 'iss_1', type: 'delivery', status: 'OPENED', aggregation_keys: { webhook_id: [record.connectionId], response_status: [410], error_code: [] } });
    expect((await notify(notifications, 'iss_1')).body).toEqual({ handled: 'rejected' });
    expect(store.get(record.id)).toEqual(record);
    expect(gateway.issues.get('iss_1')!.status).toBe('RESOLVED');
  });

  it('records other failures as delivery state', async () => {
    const { notifications, store, gateway } = setup();
    const record = await store.put(subscription());
    gateway.issues.set('iss_2', { id: 'iss_2', type: 'delivery', status: 'OPENED', aggregation_keys: { webhook_id: [record.connectionId], response_status: [503], error_code: [] } });
    expect((await notify(notifications, 'iss_2')).body).toEqual({ handled: 'recorded' });
    expect(store.get(record.id)!.delivery).toEqual({ active: false, lastError: 'http_5xx', failedSince: '2026-10-05T16:30:00.000Z' });
  });

  it('trusts the API over the payload: a forged or already-resolved issue changes nothing', async () => {
    const { notifications, store, gateway } = setup();
    const record = await store.put(subscription());
    expect((await notify(notifications, 'iss_unknown')).status).toBe(500);
    gateway.issues.set('iss_3', { id: 'iss_3', type: 'delivery', status: 'RESOLVED', aggregation_keys: { webhook_id: [record.connectionId], response_status: [410] } });
    expect((await notify(notifications, 'iss_3')).body).toEqual({ ignored: 'issue is RESOLVED' });
    expect(store.get(record.id)).toBeDefined();
  });

  it('ignores updates and non-subscription connections, and logs other issue types, such as a failing transformation', async () => {
    const { notifications, gateway, logs } = setup();
    expect((await notify(notifications, 'iss_x', 'issue.updated')).body).toEqual({ ignored: 'not an opened issue' });
    gateway.issues.set('iss_4', { id: 'iss_4', type: 'delivery', status: 'OPENED', aggregation_keys: { webhook_id: ['web_other'], response_status: [500] } });
    expect((await notify(notifications, 'iss_4')).body).toEqual({ ignored: 'not a subscription connection' });
    gateway.issues.set('iss_5', { id: 'iss_5', type: 'transformation', status: 'OPENED', aggregation_keys: { transformation_id: ['trs_1'], log_level: ['fatal'] } });
    expect((await notify(notifications, 'iss_5')).body).toEqual({ logged: 'transformation' });
    expect(logs.some((l) => l.includes('trs_1'))).toBe(true);
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
