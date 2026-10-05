import { describe, expect, it } from 'vitest';
import { EventGatewayStore } from '../../src/core/event-gateway-store.js';
import { HookdeckClient } from '../../src/core/hookdeck.js';
import { slug, subscriptionResourceName, topicSourceName } from '../../src/core/names.js';
import { SealedValueError, generateEncryptionKey, open, parseEncryptionKey, seal } from '../../src/core/sealed.js';
import { SubscriptionTooLargeError, healthyDelivery, type SubscriptionInput } from '../../src/core/store.js';
import { FakeEventGateway } from '../support/fake-event-gateway.js';

const key = parseEncryptionKey(generateEncryptionKey());

const input = (over: Partial<SubscriptionInput> = {}): SubscriptionInput => ({
  id: 'sub_0123456789abcdef0123456789abcdef',
  principal: 'owner',
  name: 'email.received',
  arguments: { from: 'alice@example.com' },
  url: 'https://receiver.example.com/hook',
  secret: `whsec_${Buffer.alloc(32, 7).toString('base64')}`,
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
  return { gateway, hookdeck, store: new EventGatewayStore(hookdeck, key) };
};

describe('sealed values', () => {
  it('round-trips and is bound to its associated data', () => {
    const sealed = seal(key, 'hello', 'sub_1:meta');
    expect(sealed.startsWith('v1.')).toBe(true);
    expect(open(key, sealed, 'sub_1:meta')).toBe('hello');
    expect(() => open(key, sealed, 'sub_2:meta')).toThrow(SealedValueError);
    expect(() => open(parseEncryptionKey(generateEncryptionKey()), sealed, 'sub_1:meta')).toThrow(SealedValueError);
    expect(() => open(key, `${sealed.slice(0, -2)}AA`, 'sub_1:meta')).toThrow(SealedValueError);
  });

  it('requires a 32-byte key', () => {
    expect(() => parseEncryptionKey(undefined)).toThrow(/not set/);
    expect(() => parseEncryptionKey(Buffer.alloc(16).toString('base64url'))).toThrow(/32/);
  });
});

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
    expect(gateway.destinations.get(connection.destinationId)).toMatchObject({ type: 'HTTP', config: { url: 'https://receiver.example.com/hook' } });
    expect(connection.rules).toEqual([
      { type: 'filter', headers: { 'x-mcp-subscription-id': record.id } },
      expect.objectContaining({ type: 'deduplicate', include_fields: ['headers.webhook-id'] }),
      expect.objectContaining({ type: 'retry', response_status_codes: ['>=300', '!410', '!413'] }),
    ]);
  });

  it('seals state so neither description shows the secret or arguments', async () => {
    const { gateway, store } = setup();
    const record = await store.put(input());
    const connection = gateway.connections.get(record.connectionId)!;
    const destination = gateway.destinations.get(connection.destinationId)!;
    for (const description of [connection.description, destination.description]) {
      expect(description).toMatch(/^v1\./);
      expect(description).not.toContain('whsec_');
      expect(description).not.toContain('alice');
      expect(description!.length).toBeLessThanOrEqual(500);
    }
  });

  it('rebuilds the same records from Event Gateway on load', async () => {
    const { hookdeck, store } = setup();
    const a = await store.put(input({ previousSecret: `whsec_${Buffer.alloc(32, 9).toString('base64')}`, previousSecretExpiresAt: '2026-10-05T12:10:00.000Z' }));
    const b = await store.put(input({ id: 'sub_ffffffffffffffffffffffffffffffff', name: 'issues.opened', arguments: {} }));
    const fresh = new EventGatewayStore(hookdeck, key);
    expect(await fresh.load()).toEqual({ loaded: 2, unreadable: [] });
    expect(fresh.get(a.id)).toEqual(a);
    expect(fresh.list({ name: 'issues.opened' })).toEqual([b]);
    expect(fresh.findByConnection(a.connectionId)).toEqual(a);
  });

  it('skips and reports subscriptions it cannot open, such as an edited description', async () => {
    const { gateway, hookdeck, store } = setup();
    const record = await store.put(input());
    gateway.connections.get(record.connectionId)!.description = 'edited in the dashboard';
    const fresh = new EventGatewayStore(hookdeck, key);
    expect(await fresh.load()).toEqual({ loaded: 0, unreadable: ['mcp-sub-sub_0123456789abcdef0123456789abcdef'] });
  });

  it('ignores connections that are not subscriptions', async () => {
    const { hookdeck, store } = setup();
    await hookdeck.upsertConnection({ name: 'bridge-resend-prod', source: { name: 'bridge-resend', type: 'RESEND' }, destination: { name: 'bridge-prod-inbound', type: 'HTTP' } });
    await store.put(input());
    expect((await new EventGatewayStore(hookdeck, key).load()).loaded).toBe(1);
  });

  it('updates in place on refresh', async () => {
    const { gateway, store } = setup();
    const first = await store.put(input());
    const second = await store.put(input({ expiresAt: '2026-12-05T12:00:00.000Z', delivery: { active: false, lastError: 'http_5xx', failedSince: '2026-10-06T00:00:00.000Z' } }));
    expect(second.connectionId).toBe(first.connectionId);
    expect(gateway.connections.size).toBe(1);
    expect(store.get(first.id)?.delivery.lastError).toBe('http_5xx');
  });

  it('lists expired subscriptions', async () => {
    const { store } = setup();
    await store.put(input({ expiresAt: '2026-10-01T00:00:00.000Z' }));
    await store.put(input({ id: 'sub_ffffffffffffffffffffffffffffffff', expiresAt: '2026-12-01T00:00:00.000Z' }));
    expect(store.listExpired(new Date('2026-10-05T00:00:00.000Z')).map((r) => r.id)).toEqual(['sub_0123456789abcdef0123456789abcdef']);
  });

  it('fits the worst case: two 64-byte secrets during rotation, both arguments, failing delivery', async () => {
    const { store } = setup();
    await expect(
      store.put(
        input({
          secret: `whsec_${Buffer.alloc(64, 1).toString('base64')}`,
          previousSecret: `whsec_${Buffer.alloc(64, 2).toString('base64')}`,
          previousSecretExpiresAt: '2026-10-05T12:10:00.000Z',
          arguments: { from: 'someone.with.a.long.name@subdomain.example.com', to: 'bridge-test@receiving-long.inbound.example.com' },
          delivery: { active: false, lastError: 'connection_refused', failedSince: '2026-10-06T00:00:00.000Z' },
        }),
      ),
    ).resolves.toMatchObject({ id: 'sub_0123456789abcdef0123456789abcdef' });
  });

  it('rejects state too large for the description limit', async () => {
    const { gateway, store } = setup();
    await expect(store.put(input({ arguments: { from: 'x'.repeat(400) } }))).rejects.toBeInstanceOf(SubscriptionTooLargeError);
    expect(gateway.connections.size).toBe(0);
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
