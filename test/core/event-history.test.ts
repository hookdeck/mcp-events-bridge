import { describe, expect, it } from 'vitest';
import { Catalog } from '../../src/core/catalog.js';
import { defineConfig, resolveConfig } from '../../src/core/config.js';
import { EventHistory } from '../../src/core/event-history.js';
import type { HookdeckClient } from '../../src/core/hookdeck.js';
import { webhook } from '../../src/providers.js';

const broker = (id: string) =>
  webhook({ id, verification: { type: 'hmac', algorithm: 'sha256', encoding: 'hex', header: 'x-signature', secret: 'a-long-enough-secret' }, events: ['order.filled'], eventId: { header: 'x-delivery-id' } });

describe('EventHistory.get', () => {
  it("finds an event in its name's instance, when two instances have an event with the same id", async () => {
    const config = resolveConfig(defineConfig({ providers: [broker('broker_a'), broker('broker_b')] }), { HOOKDECK_API_KEY: 'k', HOOKDECK_SIGNING_SECRET: 's' });
    // Each instance's source has a request with delivery id 1001.
    const request = (symbol: string) => ({
      id: `req_${symbol}`,
      verified: true,
      rejection_cause: null,
      data: { headers: { 'x-delivery-id': '1001', 'x-hookdeck-verified': 'true' }, body: { symbol } },
    });
    const searched: string[] = [];
    const hookdeck = {
      listSources: async ({ name }: { name: string }) => ({ models: [{ id: `src_${name}` }] }),
      listRequests: async ({ source_id }: { source_id: string }) => {
        searched.push(source_id);
        return { models: [request(source_id === 'src_bridge-broker_a' ? 'AAPL' : 'MSFT')] };
      },
    } as unknown as HookdeckClient;
    const history = new EventHistory({ hookdeck, catalog: new Catalog(config.providers), providers: config.providers });

    expect(await history.get('broker_b.order.filled', '1001')).toMatchObject({ eventId: '1001', name: 'broker_b.order.filled', data: { symbol: 'MSFT' } });
    expect(searched).toEqual(['src_bridge-broker_b']);
    expect(await history.get('broker_c.order.filled', '1001')).toBeUndefined();
  });
});

describe('EventHistory.recent', () => {
  it("lists only the name's instance when given a name", async () => {
    const config = resolveConfig(defineConfig({ providers: [broker('broker_a'), broker('broker_b')] }), { HOOKDECK_API_KEY: 'k', HOOKDECK_SIGNING_SECRET: 's' });
    const searched: string[] = [];
    const hookdeck = {
      listSources: async ({ name }: { name: string }) => ({ models: [{ id: `src_${name}` }] }),
      listRequests: async ({ source_id }: { source_id: string }) => {
        searched.push(source_id);
        return { models: [{ id: 'req_1', verified: true, rejection_cause: null, data: { headers: { 'x-delivery-id': '1', 'x-hookdeck-verified': 'true' }, body: { symbol: 'AAPL' } } }] };
      },
    } as unknown as HookdeckClient;
    const history = new EventHistory({ hookdeck, catalog: new Catalog(config.providers), providers: config.providers });

    expect((await history.recent({ name: 'broker_a.order.filled' })).map((e) => e.name)).toEqual(['broker_a.order.filled']);
    expect(searched).toEqual(['src_bridge-broker_a']);
    expect(await history.recent({ name: 'nope.order.filled' })).toEqual([]);
  });

  it('times an event without occurredAt by when Event Gateway received it, not when it was read back', async () => {
    const config = resolveConfig(defineConfig({ providers: [broker('broker_a')] }), { HOOKDECK_API_KEY: 'k', HOOKDECK_SIGNING_SECRET: 's' });
    const hookdeck = {
      listSources: async ({ name }: { name: string }) => ({ models: [{ id: `src_${name}` }] }),
      listRequests: async () => ({
        models: [{ id: 'req_1', created_at: '2026-10-08T10:32:08.100Z', verified: true, rejection_cause: null, data: { headers: { 'x-delivery-id': '1' }, body: { symbol: 'AAPL' } } }],
      }),
    } as unknown as HookdeckClient;
    const history = new EventHistory({ hookdeck, catalog: new Catalog(config.providers), providers: config.providers });

    expect((await history.recent({ name: 'broker_a.order.filled' }))[0]?.timestamp).toBe('2026-10-08T10:32:08.100Z');
    expect((await history.get('broker_a.order.filled', '1'))?.timestamp).toBe('2026-10-08T10:32:08.100Z');
  });
});

describe('EventHistory.lookup', () => {
  it('says whether get can find an event: an offered name, from a provider with an event-id header', () => {
    const noHeader = webhook({ id: 'plain', verification: { type: 'hmac', algorithm: 'sha256', encoding: 'hex', header: 'x-signature', secret: 'a-long-enough-secret' }, events: ['ping'], eventId: { field: 'id' } });
    const config = resolveConfig(defineConfig({ providers: [broker('broker_a'), noHeader] }), { HOOKDECK_API_KEY: 'k', HOOKDECK_SIGNING_SECRET: 's' });
    const history = new EventHistory({ hookdeck: {} as HookdeckClient, catalog: new Catalog(config.providers), providers: config.providers });
    expect(history.lookup('broker_a.order.filled')).toBe('ok');
    expect(history.lookup('plain.ping')).toBe('no-id-header');
    expect(history.lookup('order.filled')).toBe('unknown');
  });
});
