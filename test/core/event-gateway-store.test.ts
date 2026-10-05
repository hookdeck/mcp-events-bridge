import { describe, expect, it } from 'vitest';
import { EventGatewayStore, SECRET_CARRIER_HEADER } from '../../src/core/event-gateway-store.js';
import { HookdeckClient } from '../../src/core/hookdeck.js';
import { slug, subscriptionResourceName, topicSourceName } from '../../src/core/names.js';
import { SubscriptionTooLargeError, healthyDelivery, type SubscriptionInput } from '../../src/core/store.js';
import { FakeEventGateway } from '../support/fake-event-gateway.js';

const SECRET = `whsec_${Buffer.alloc(32, 7).toString('base64')}`;

const input = (over: Partial<SubscriptionInput> = {}): SubscriptionInput => ({
  id: 'sub_0123456789abcdef0123456789abcdef',
  principal: 'owner',
  name: 'email.received',
  arguments: { from: 'alice@example.com' },
  url: 'https://receiver.example.com/hook',
  secret: SECRET,
  previousSecret: null,
  previousSecretExpiresAt: null,
  delivery: healthyDelivery(),
  expiresAt: '2026-11-05T12:00:00.000Z',
  createdAt: '2026-10-05T12:00:00.000Z',
  updatedAt: '2026-10-05T12:00:00.000Z',
  ...over,
});

const setup = () => {
  const gateway = new FakeEventGateway();
  const hookdeck = new HookdeckClient({ apiKey: 'test', fetch: gateway.fetch });
  return { gateway, hookdeck, store: new EventGatewayStore(hookdeck) };
};

describe('resource names', () => {
  it('slugs MCP event names, since Event Gateway names allow no dots', () => {
    expect(slug('email.received')).toBe('email_received');
    expect(topicSourceName('email.received')).toBe('bridge-out-email_received');
    expect(subscriptionResourceName('sub_abc')).toBe('mcp-sub-sub_abc');
  });
});

describe('EventGatewayStore', () => {
  it('creates the subscription connection with the topic source, callback destination and rules', async () => {
    const { gateway, store } = setup();
    const record = await store.put(input());
    const connection = gateway.connections.get(record.connectionId)!;
    expect(connection.name).toBe('mcp-sub-sub_0123456789abcdef0123456789abcdef');
    expect(gateway.sources.get(connection.sourceId)).toMatchObject({ name: 'bridge-out-email_received', type: 'PUBLISH_API' });
    expect(gateway.destinations.get(connection.destinationId)).toMatchObject({
      type: 'HTTP',
      config: { url: 'https://receiver.example.com/hook', auth_type: 'CUSTOM_SIGNATURE', auth: { key: SECRET_CARRIER_HEADER, signing_secret: SECRET } },
    });
    expect(connection.rules).toEqual([
      { type: 'filter', headers: { 'x-mcp-subscription-id': record.id } },
      expect.objectContaining({ type: 'deduplicate', include_fields: ['headers.webhook-id'] }),
      expect.objectContaining({ type: 'retry', response_status_codes: ['>=300', '!410', '!413'] }),
    ]);
  });

  it('keeps readable metadata in the connection description and the secret only in destination auth', async () => {
    const { gateway, store } = setup();
    const record = await store.put(input());
    const description = gateway.connections.get(record.connectionId)!.description!;
    expect(JSON.parse(description)).toEqual({
      v: 1,
      principal: 'owner',
      event: 'email.received',
      arguments: { from: 'alice@example.com' },
      expiresAt: '2026-11-05T12:00:00.000Z',
      createdAt: '2026-10-05T12:00:00.000Z',
      updatedAt: '2026-10-05T12:00:00.000Z',
    });
    expect(description).not.toContain('whsec_');
  });

  it('rebuilds the same records on load, reading each secret from destination auth', async () => {
    const { hookdeck, store } = setup();
    const a = await store.put(input({ delivery: { active: false, lastError: 'http_5xx', failedSince: '2026-10-06T00:00:00.000Z' } }));
    const b = await store.put(input({ id: 'sub_ffffffffffffffffffffffffffffffff', name: 'issues.opened', arguments: {} }));
    const fresh = new EventGatewayStore(hookdeck);
    expect(await fresh.load()).toEqual({ loaded: 2, unreadable: [] });
    expect(fresh.get(a.id)).toEqual(a);
    expect(fresh.get(a.id)?.secret).toBe(SECRET);
    expect(fresh.list({ name: 'issues.opened' })).toEqual([b]);
    expect(fresh.findByConnection(a.connectionId)).toEqual(a);
  });

  it('keeps the previous secret in memory for its grace window only', async () => {
    const { hookdeck, store } = setup();
    const previous = `whsec_${Buffer.alloc(32, 9).toString('base64')}`;
    const open = new Date(Date.now() + 60_000).toISOString();
    const record = await store.put(input({ previousSecret: previous, previousSecretExpiresAt: open }));
    expect(record.previousSecret).toBe(previous);
    expect(store.get(record.id)?.previousSecret).toBe(previous);
    await store.put(input({ previousSecret: previous, previousSecretExpiresAt: new Date(Date.now() - 1).toISOString() }));
    expect(store.get(record.id)?.previousSecret).toBeNull();
    const fresh = new EventGatewayStore(hookdeck);
    await fresh.load();
    expect(fresh.get(record.id)?.previousSecret).toBeNull();
  });

  it('skips and reports subscriptions it cannot read, such as an edited description', async () => {
    const { gateway, hookdeck, store } = setup();
    const record = await store.put(input());
    gateway.connections.get(record.connectionId)!.description = 'edited in the dashboard';
    expect(await new EventGatewayStore(hookdeck).load()).toEqual({ loaded: 0, unreadable: ['mcp-sub-sub_0123456789abcdef0123456789abcdef'] });
  });

  it('ignores connections that are not subscriptions', async () => {
    const { hookdeck, store } = setup();
    await hookdeck.upsertConnection({ name: 'bridge-resend-prod', source: { name: 'bridge-resend', type: 'RESEND' }, destination: { name: 'bridge-prod-inbound', type: 'HTTP' } });
    await store.put(input());
    expect((await new EventGatewayStore(hookdeck).load()).loaded).toBe(1);
  });

  it('updates in place on refresh, including a new secret', async () => {
    const { gateway, store } = setup();
    const first = await store.put(input());
    const rotated = `whsec_${Buffer.alloc(32, 3).toString('base64')}`;
    const second = await store.put(input({ secret: rotated, expiresAt: '2026-12-05T12:00:00.000Z' }));
    expect(second.connectionId).toBe(first.connectionId);
    expect(gateway.connections.size).toBe(1);
    expect(gateway.destinations.get(second.destinationId)?.config?.auth).toMatchObject({ signing_secret: rotated });
  });

  it('lists expired subscriptions', async () => {
    const { store } = setup();
    await store.put(input({ expiresAt: '2026-10-01T00:00:00.000Z' }));
    await store.put(input({ id: 'sub_ffffffffffffffffffffffffffffffff', expiresAt: '2026-12-01T00:00:00.000Z' }));
    expect(store.listExpired(new Date('2026-10-05T00:00:00.000Z')).map((r) => r.id)).toEqual(['sub_0123456789abcdef0123456789abcdef']);
  });

  it('fits typical arguments and rejects ones too large for the description limit', async () => {
    const { gateway, store } = setup();
    await expect(
      store.put(input({
        arguments: { from: 'someone.with.a.long.name@subdomain.example.com', to: 'bridge-test@receiving-long.inbound.example.com' },
        delivery: { active: false, lastError: 'connection_refused', failedSince: '2026-10-06T00:00:00.000Z' },
      })),
    ).resolves.toBeDefined();
    await expect(store.put(input({ id: 'sub_ffffffffffffffffffffffffffffffff', arguments: { from: 'x'.repeat(400) } }))).rejects.toBeInstanceOf(SubscriptionTooLargeError);
    expect(gateway.connections.size).toBe(1);
  });

  it('deletes the connection and destination, and the topic source with its last subscriber', async () => {
    const { gateway, store } = setup();
    const a = await store.put(input());
    const b = await store.put(input({ id: 'sub_ffffffffffffffffffffffffffffffff' }));
    await store.delete(a.id);
    expect(gateway.connections.size).toBe(1);
    expect(gateway.sources.size).toBe(1);
    await store.delete(b.id);
    expect(gateway.connections.size).toBe(0);
    expect(gateway.destinations.size).toBe(0);
    expect(gateway.sources.size).toBe(0);
    expect(store.get(a.id)).toBeUndefined();
  });
});
