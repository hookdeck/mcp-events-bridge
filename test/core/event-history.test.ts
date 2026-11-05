import { describe, expect, it } from 'vitest';
import { Catalog } from '../../src/core/catalog.js';
import { defineConfig, resolveConfig } from '../../src/core/config.js';
import { EventHistory, RECENT_MAX_REQUESTS_PER_SOURCE, RECENT_PAGE_SIZE } from '../../src/core/event-history.js';
import type { HookdeckClient } from '../../src/core/hookdeck.js';
import { source } from '../../src/sources.js';

const broker = (id: string) =>
  source({ type: 'webhook',  id, verification: { type: 'hmac', algorithm: 'sha256', encoding: 'hex', header: 'x-signature', secret: 'a-long-enough-secret' }, events: ['order.filled'], eventId: { header: 'x-delivery-id' } });

describe('EventHistory.get', () => {
  it("finds an event in its name's instance, when two instances have an event with the same id", async () => {
    const config = resolveConfig(defineConfig({ sources: [broker('broker_a'), broker('broker_b')] }), { HOOKDECK_API_KEY: 'k', HOOKDECK_SIGNING_SECRET: 's' });
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
    const history = new EventHistory({ hookdeck, catalog: new Catalog(config.sources), providers: config.sources });

    expect(await history.get('broker_b.order.filled', '1001')).toMatchObject({ eventId: '1001', name: 'broker_b.order.filled', data: { symbol: 'MSFT' } });
    expect(searched).toEqual(['src_bridge-broker_b']);
    expect(await history.get('broker_c.order.filled', '1001')).toBeUndefined();
  });
});

describe('EventHistory.recent', () => {
  it("lists only the name's instance when given a name", async () => {
    const config = resolveConfig(defineConfig({ sources: [broker('broker_a'), broker('broker_b')] }), { HOOKDECK_API_KEY: 'k', HOOKDECK_SIGNING_SECRET: 's' });
    const searched: string[] = [];
    const hookdeck = {
      listSources: async ({ name }: { name: string }) => ({ models: [{ id: `src_${name}` }] }),
      listRequests: async ({ source_id }: { source_id: string }) => {
        searched.push(source_id);
        return { models: [{ id: 'req_1', verified: true, rejection_cause: null, data: { headers: { 'x-delivery-id': '1', 'x-hookdeck-verified': 'true' }, body: { symbol: 'AAPL' } } }] };
      },
    } as unknown as HookdeckClient;
    const history = new EventHistory({ hookdeck, catalog: new Catalog(config.sources), providers: config.sources });

    expect((await history.recent({ name: 'broker_a.order.filled' })).map((e) => e.name)).toEqual(['broker_a.order.filled']);
    expect(searched).toEqual(['src_bridge-broker_a']);
    expect(await history.recent({ name: 'nope.order.filled' })).toEqual([]);
  });

  it('includes requests to a source with no subscriptions (rejected as NO_CONNECTION), but not ones that failed verification', async () => {
    const config = resolveConfig(defineConfig({ sources: [broker('broker_a')] }), { HOOKDECK_API_KEY: 'k', HOOKDECK_SIGNING_SECRET: 's' });
    const request = (id: string, verified: boolean, rejection_cause: string | null) => ({
      id: `req_${id}`,
      verified,
      rejection_cause,
      data: { headers: { 'x-delivery-id': id }, body: { symbol: 'AAPL' } },
    });
    const hookdeck = {
      listSources: async ({ name }: { name: string }) => ({ models: [{ id: `src_${name}` }] }),
      listRequests: async () => ({ models: [request('no-subscriptions', true, 'NO_CONNECTION'), request('bad-signature', false, 'VERIFICATION_FAILED')] }),
    } as unknown as HookdeckClient;
    const history = new EventHistory({ hookdeck, catalog: new Catalog(config.sources), providers: config.sources });

    expect((await history.recent({ name: 'broker_a.order.filled' })).map((e) => e.eventId)).toEqual(['no-subscriptions']);
    expect((await history.get('broker_a.order.filled', 'no-subscriptions'))?.eventId).toBe('no-subscriptions');
  });

  it('times an event without occurredAt by when Event Gateway received it, not when it was read back', async () => {
    const config = resolveConfig(defineConfig({ sources: [broker('broker_a')] }), { HOOKDECK_API_KEY: 'k', HOOKDECK_SIGNING_SECRET: 's' });
    const hookdeck = {
      listSources: async ({ name }: { name: string }) => ({ models: [{ id: `src_${name}` }] }),
      listRequests: async () => ({
        models: [{ id: 'req_1', created_at: '2026-10-08T10:32:08.100Z', verified: true, rejection_cause: null, data: { headers: { 'x-delivery-id': '1' }, body: { symbol: 'AAPL' } } }],
      }),
    } as unknown as HookdeckClient;
    const history = new EventHistory({ hookdeck, catalog: new Catalog(config.sources), providers: config.sources });

    expect((await history.recent({ name: 'broker_a.order.filled' }))[0]?.timestamp).toBe('2026-10-08T10:32:08.100Z');
    expect((await history.get('broker_a.order.filled', '1'))?.timestamp).toBe('2026-10-08T10:32:08.100Z');
  });
});

describe('EventHistory.recent paging', () => {
  const twoEvents = source({
    type: 'webhook',
    id: 'broker_a',
    verification: { type: 'hmac', algorithm: 'sha256', encoding: 'hex', header: 'x-signature', secret: 'a-long-enough-secret' },
    events: ['order.filled', 'order.placed'],
    eventType: { field: 'type' },
    eventId: { header: 'x-delivery-id' },
  });

  /**
   * A source with `total` requests, newest first, served a page per call with a cursor. Every `every`th request is an
   * order.filled and the rest are order.placed. Records each call's cursor.
   */
  function pagedHistory(total: number, every: number) {
    const config = resolveConfig(defineConfig({ sources: [twoEvents] }), { HOOKDECK_API_KEY: 'k', HOOKDECK_SIGNING_SECRET: 's' });
    const calls: (string | undefined)[] = [];
    const request = (i: number) => ({
      id: `req_${i}`,
      created_at: new Date(Date.UTC(2026, 10, 4) - i * 1000).toISOString(),
      verified: true,
      rejection_cause: null,
      data: { headers: { 'x-delivery-id': String(i) }, body: { type: i % every === 0 ? 'order.filled' : 'order.placed' } },
    });
    const hookdeck = {
      listSources: async ({ name }: { name: string }) => ({ models: [{ id: `src_${name}` }] }),
      listRequests: async ({ limit, next }: { limit: number; next?: string }) => {
        calls.push(next);
        const start = next ? Number(next) : 0;
        const end = Math.min(start + limit, total);
        const models = Array.from({ length: end - start }, (_, k) => request(start + k));
        return { models, pagination: { order_by: 'created_at', dir: 'desc', next: end < total ? String(end) : undefined } };
      },
    } as unknown as HookdeckClient;
    return { history: new EventHistory({ hookdeck, catalog: new Catalog(config.sources), providers: config.sources }), calls };
  }

  it('reads further pages until it has limit events of the name', async () => {
    // One request in 50 is an order.filled, 2 a page, so 5 of them take 3 pages.
    const { history, calls } = pagedHistory(1000, 50);
    const events = await history.recent({ name: 'broker_a.order.filled', limit: 5 });
    expect(events.map((e) => e.eventId)).toEqual(['0', '50', '100', '150', '200']);
    expect(calls).toEqual([undefined, '100', '200']);
  });

  it('stops after RECENT_MAX_REQUESTS_PER_SOURCE requests, and returns what it found', async () => {
    const { history, calls } = pagedHistory(5000, 200);
    const events = await history.recent({ name: 'broker_a.order.filled', limit: 20 });
    expect(calls).toHaveLength(RECENT_MAX_REQUESTS_PER_SOURCE / RECENT_PAGE_SIZE);
    expect(events.map((e) => e.eventId)).toEqual(['0', '200', '400']);
  });

  it("stops when the source's requests run out", async () => {
    const { history, calls } = pagedHistory(150, 50);
    expect((await history.recent({ name: 'broker_a.order.filled', limit: 10 })).map((e) => e.eventId)).toEqual(['0', '50', '100']);
    expect(calls).toEqual([undefined, '100']);
  });

  it('reads one page when the first has limit events', async () => {
    const { history, calls } = pagedHistory(1000, 50);
    expect(await history.recent({ limit: 20 })).toHaveLength(20);
    expect(calls).toEqual([undefined]);
  });
});

describe('EventHistory.lookup', () => {
  it('says whether get can find an event: an offered name, from a provider with an event-id header', () => {
    const noHeader = source({ type: 'webhook',  id: 'plain', verification: { type: 'hmac', algorithm: 'sha256', encoding: 'hex', header: 'x-signature', secret: 'a-long-enough-secret' }, events: ['ping'], eventId: { field: 'id' } });
    const config = resolveConfig(defineConfig({ sources: [broker('broker_a'), noHeader] }), { HOOKDECK_API_KEY: 'k', HOOKDECK_SIGNING_SECRET: 's' });
    const history = new EventHistory({ hookdeck: {} as HookdeckClient, catalog: new Catalog(config.sources), providers: config.sources });
    expect(history.lookup('broker_a.order.filled')).toBe('ok');
    expect(history.lookup('plain.ping')).toBe('no-id-header');
    expect(history.lookup('order.filled')).toBe('unknown');
  });
});
