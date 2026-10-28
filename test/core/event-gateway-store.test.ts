import { describe, expect, it } from 'vitest';
import { EventGatewayStore, type PlaceSubscription } from '../../src/core/event-gateway-store.js';
import { connectionFilterRule } from '../../src/core/filter.js';
import { HookdeckClient } from '../../src/core/hookdeck.js';
import { slug, subscriptionResourceName } from '../../src/core/names.js';
import { SubscriptionTooLargeError, healthyDelivery, type SubscriptionInput } from '../../src/core/store.js';
import { FakeEventGateway } from '../support/fake-event-gateway.js';

const SECRET = `whsec_${Buffer.alloc(32, 7).toString('base64')}`;

const input = (over: Partial<SubscriptionInput> = {}): SubscriptionInput => ({
  id: 'sub_0123456789abcdef0123456789abcdef',
  principal: 'owner',
  name: 'resend.email.received',
  arguments: { from: 'alice@example.com' },
  url: 'https://receiver.example.com/hook',
  secret: SECRET,
  replay: null,
  delivery: healthyDelivery(),
  expiresAt: '2026-11-05T12:00:00.000Z',
  createdAt: '2026-10-05T12:00:00.000Z',
  updatedAt: '2026-10-05T12:00:00.000Z',
  ...over,
});

const setup = async () => {
  const gateway = new FakeEventGateway();
  const hookdeck = new HookdeckClient({ apiKey: 'test', fetch: gateway.fetch });
  const source = await hookdeck.upsertSource({ name: 'bridge-resend', type: 'RESEND' });
  const place: PlaceSubscription = async (name, args) => ({
    sourceId: source.id,
    transformationId: 'trs_resend',
    filter: connectionFilterRule(name, { fromAddress: args.from }),
    cursorArgs: 'hash-of-args',
  });
  return { gateway, hookdeck, source, place, store: new EventGatewayStore(hookdeck, place) };
};

describe('resource names', () => {
  it('slugs MCP event names, since Event Gateway names allow no dots', () => {
    expect(slug('email.received')).toBe('email_received');
    expect(subscriptionResourceName('sub_abc')).toBe('mcp-sub-sub_abc');
  });
});

describe('EventGatewayStore', () => {
  it("creates the subscription's connection on the service source: transformation, filter, dedupe and retry, to the callback URL signed with the secret", async () => {
    const { gateway, source, store } = await setup();
    const record = await store.put(input());
    const connection = gateway.connections.get(record.connectionId)!;
    expect(connection.name).toBe('mcp-sub-sub_0123456789abcdef0123456789abcdef');
    expect(connection.sourceId).toBe(source.id);
    expect(record.sourceId).toBe(source.id);
    expect(gateway.destinations.get(connection.destinationId)).toMatchObject({
      type: 'HTTP',
      config: { url: 'https://receiver.example.com/hook', path_forwarding_disabled: true, auth_type: 'STANDARD_WEBHOOKS', auth: { webhook_secret_key: SECRET } },
    });
    expect(connection.rules).toEqual([
      { type: 'transform', transformation_id: 'trs_resend' },
      { type: 'filter', headers: { 'x-mcp-skip': { $exist: false } }, body: { name: 'resend.email.received', data: { fromAddress: 'alice@example.com' } } },
      expect.objectContaining({ type: 'deduplicate', include_fields: ['headers.webhook-id'] }),
      expect.objectContaining({ type: 'retry', response_status_codes: ['>=300', '!410', '!413'] }),
    ]);
  });

  it('keeps readable metadata, with the cursor fields the transformation reads, in the description, and the secret only in destination auth', async () => {
    const { gateway, store } = await setup();
    const record = await store.put(input());
    const description = gateway.connections.get(record.connectionId)!.description!;
    expect(JSON.parse(description)).toEqual({
      v: 2,
      principal: 'owner',
      event: 'resend.email.received',
      arguments: { from: 'alice@example.com' },
      expiresAt: '2026-11-05T12:00:00.000Z',
      createdAt: '2026-10-05T12:00:00.000Z',
      updatedAt: '2026-10-05T12:00:00.000Z',
      ca: 'hash-of-args',
    });
    expect(description).not.toContain('whsec_');
  });

  it('writes the replay marker while a replay runs, and drops it after', async () => {
    const { gateway, store } = await setup();
    const record = await store.put(input({ replay: { f: 1000, w: 2000 } }));
    expect(JSON.parse(gateway.connections.get(record.connectionId)!.description!).rp).toEqual({ f: 1000, w: 2000 });
    await store.update(record.id, (current) => ({ ...current!, replay: null }));
    expect(JSON.parse(gateway.connections.get(record.connectionId)!.description!).rp).toBeUndefined();
  });

  it('rebuilds the same records on load, reading each secret from destination auth', async () => {
    const { hookdeck, place, store } = await setup();
    const a = await store.put(input({ delivery: { active: false, lastError: 'http_5xx', failedSince: '2026-10-06T00:00:00.000Z' }, replay: { f: 1, w: 2 } }));
    const b = await store.put(input({ id: 'sub_ffffffffffffffffffffffffffffffff', name: 'resend.email.sent', arguments: {} }));
    const fresh = new EventGatewayStore(hookdeck, place);
    expect(await fresh.load()).toEqual({ loaded: 2, unreadable: [], legacy: 0 });
    expect(fresh.get(a.id)).toEqual(a);
    expect(fresh.get(a.id)?.secret).toBe(SECRET);
    expect(fresh.list({ name: 'resend.email.sent' })).toEqual([b]);
    expect(fresh.findByConnection(a.connectionId)).toEqual(a);
  });

  it('counts subscriptions from 0.7 or earlier as legacy and leaves them for the migration', async () => {
    const { gateway, hookdeck, place, store } = await setup();
    const record = await store.put(input());
    gateway.connections.get(record.connectionId)!.description = '{"v":1,"principal":"owner","event":"resend.email.received","arguments":{}}';
    const fresh = new EventGatewayStore(hookdeck, place);
    expect(await fresh.load()).toEqual({ loaded: 0, unreadable: [], legacy: 1 });
    expect(fresh.get(record.id)).toBeUndefined();
  });

  it('skips and reports subscriptions it cannot read, such as an edited description', async () => {
    const { gateway, hookdeck, place, store } = await setup();
    const record = await store.put(input());
    gateway.connections.get(record.connectionId)!.description = 'edited in the dashboard';
    expect(await new EventGatewayStore(hookdeck, place).load()).toEqual({ loaded: 0, unreadable: ['mcp-sub-sub_0123456789abcdef0123456789abcdef'], legacy: 0 });
  });

  it('ignores connections that are not subscriptions', async () => {
    const { hookdeck, place, store } = await setup();
    await hookdeck.upsertConnection({ name: 'bridge-notifications-prod', source: { name: 'bridge-notifications', type: 'WEBHOOK' }, destination: { name: 'bridge-prod-inbound', type: 'HTTP' } });
    await store.put(input());
    expect((await new EventGatewayStore(hookdeck, place).load()).loaded).toBe(1);
  });

  it('updates in place on refresh, including a new secret', async () => {
    const { gateway, store } = await setup();
    const first = await store.put(input());
    const rotated = `whsec_${Buffer.alloc(32, 3).toString('base64')}`;
    const second = await store.put(input({ secret: rotated, expiresAt: '2026-12-05T12:00:00.000Z' }));
    expect(second.connectionId).toBe(first.connectionId);
    expect(gateway.connections.size).toBe(1);
    expect(gateway.destinations.get(second.destinationId)?.config?.auth).toEqual({ webhook_secret_key: rotated });
  });

  it('serializes concurrent writes', async () => {
    const { gateway, place } = await setup();
    let inFlight = 0;
    let maxInFlight = 0;
    const original = gateway.fetch;
    const tracking = (async (request: URL | string, init?: RequestInit) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      try {
        return await original(request, init);
      } finally {
        inFlight--;
      }
    }) as typeof fetch;
    const concurrent = new EventGatewayStore(new HookdeckClient({ apiKey: 'test', fetch: tracking }), place);
    await Promise.all(['a', 'b', 'c', 'd'].map((x) => concurrent.put(input({ id: `sub_${x.repeat(32)}` }))));
    expect(maxInFlight).toBe(1);
    expect(gateway.connections.size).toBe(4);
  });

  it('lists expired subscriptions', async () => {
    const { store } = await setup();
    await store.put(input({ expiresAt: '2026-10-01T00:00:00.000Z' }));
    await store.put(input({ id: 'sub_ffffffffffffffffffffffffffffffff', expiresAt: '2026-12-01T00:00:00.000Z' }));
    expect(store.listExpired(new Date('2026-10-05T00:00:00.000Z')).map((r) => r.id)).toEqual(['sub_0123456789abcdef0123456789abcdef']);
  });

  it('fits typical arguments and rejects ones too large for the description limit, leaving room for a failure and a replay marker', async () => {
    const { gateway, store } = await setup();
    await expect(
      store.put(input({
        arguments: { from: 'someone.with.a.long.name@subdomain.example.com', to: 'bridge-test@receiving-long.inbound.example.com' },
        delivery: { active: false, lastError: 'connection_refused', failedSince: '2026-10-06T00:00:00.000Z' },
        replay: { f: 1_761_600_000_000, w: 1_761_600_000_000 },
      })),
    ).resolves.toBeDefined();
    await expect(store.put(input({ id: 'sub_ffffffffffffffffffffffffffffffff', arguments: { from: 'x'.repeat(320) } }))).rejects.toBeInstanceOf(SubscriptionTooLargeError);
    expect(gateway.connections.size).toBe(1);
  });

  it('deletes the connection and destination, and leaves the service source', async () => {
    const { gateway, source, store } = await setup();
    const a = await store.put(input());
    const b = await store.put(input({ id: 'sub_ffffffffffffffffffffffffffffffff' }));
    await store.delete(a.id);
    expect(gateway.connections.size).toBe(1);
    await store.delete(b.id);
    expect(gateway.connections.size).toBe(0);
    expect(gateway.destinations.size).toBe(0);
    expect(gateway.sources.has(source.id)).toBe(true);
    expect(store.get(a.id)).toBeUndefined();
  });
});
