import { describe, expect, it } from 'vitest';
import { Catalog } from '../../src/core/catalog.js';
import { defineConfig, resolveConfig } from '../../src/core/config.js';
import { EventsErrorCode } from '../../src/core/errors.js';
import { EventHistory } from '../../src/core/event-history.js';
import { HookdeckApiError, type HookdeckClient, type HookdeckRequest } from '../../src/core/hookdeck.js';
import { intervalFor, LOOKBACK_MS, MAX_POLL_INTERVAL_MS, POLL_INTERVAL_MS, PollService } from '../../src/core/poll.js';
import { webhook } from '../../src/providers.js';

const fills = (id: string) =>
  webhook({
    id,
    verification: { type: 'hmac', algorithm: 'sha256', encoding: 'hex', header: 'x-signature', secret: 'a-long-enough-secret' },
    events: ['order.filled'],
    eventId: { header: 'x-delivery-id' },
    filters: ['symbol'],
  });

const T0 = Date.parse('2026-10-08T12:00:00Z');

interface FakeRequest {
  id: string;
  source_id: string;
  createdAt: number;
  /** When it first appears in the listing. */
  visibleAt: number;
  /** When Event Gateway has routed it (counts are 0 before). */
  processedAt: number;
  kind: 'event' | 'duplicate' | 'filtered' | 'cli-disconnected';
  symbol: string;
  deliveryId: string;
}

/** Event Gateway's request listing, with requests that appear late and out of order. */
class FakeListing {
  now = T0;
  requests: FakeRequest[] = [];
  calls: Array<{ sources: string[]; from: number }> = [];
  ignoredLookups = 0;
  rateLimit: { limit: number; remaining: number } | undefined = undefined;
  rateLimited = false;
  private n = 0;

  add(r: Partial<FakeRequest> & { createdAt: number }) {
    const id = r.id ?? `req_${++this.n}`;
    const request: FakeRequest = { id, source_id: 'src_bridge-fills', visibleAt: r.createdAt + 2000, processedAt: r.createdAt, kind: 'event', symbol: 'AAPL', deliveryId: id, ...r };
    this.requests.push(request);
    return request;
  }

  private view(r: FakeRequest): HookdeckRequest {
    const processed = this.now >= r.processedAt;
    const events = processed && r.kind === 'event' ? 1 : 0;
    return {
      id: r.id,
      source_id: r.source_id,
      created_at: new Date(r.createdAt).toISOString(),
      verified: true,
      rejection_cause: null,
      events_count: events,
      cli_events_count: 0,
      ignored_count: processed && r.kind !== 'event' ? 1 : 0,
      data: { headers: { 'x-delivery-id': r.deliveryId }, body: { symbol: r.symbol, qty: 1 } },
    };
  }

  readonly client = {
    listAcceptedRequests: async ({ source_ids, created_at_gte, limit = 255, next }: { source_ids: string[]; created_at_gte: string; limit?: number; next?: string }) => {
      if (this.rateLimited) throw new HookdeckApiError('GET', '/requests', 429, '{}');
      const from = Date.parse(created_at_gte);
      if (!next) this.calls.push({ sources: [...source_ids], from });
      const visible = this.requests
        .filter((r) => r.visibleAt <= this.now && source_ids.includes(r.source_id) && r.createdAt >= from)
        .sort((a, b) => a.createdAt - b.createdAt);
      const offset = next ? Number(next) : 0;
      const models = visible.slice(offset, offset + limit).map((r) => this.view(r));
      return {
        page: { models, pagination: { order_by: 'created_at', dir: 'asc', ...(offset + limit < visible.length && { next: String(offset + limit) }) } },
        // A Date header has 1-second precision.
        meta: { date: Math.floor(this.now / 1000) * 1000, ...(this.rateLimit && { rateLimit: this.rateLimit }) },
      };
    },
    listIgnoredEventsForRequest: async (id: string) => {
      this.ignoredLookups++;
      const r = this.requests.find((x) => x.id === id)!;
      const cause = { duplicate: 'DUPLICATE', filtered: 'FILTERED', 'cli-disconnected': 'CLI_DISCONNECTED', event: 'NONE' }[r.kind];
      return { models: [{ id: `ign_${id}`, request_id: id, webhook_id: 'web_1', cause, created_at: '' }] };
    },
  };
}

function setup(options: { providers?: string[]; clockSkewMs?: number } = {}) {
  const config = resolveConfig(defineConfig({ providers: (options.providers ?? ['fills']).map(fills) }), { HOOKDECK_API_KEY: 'k', HOOKDECK_SIGNING_SECRET: 's' });
  const catalog = new Catalog(config.providers);
  const listing = new FakeListing();
  const sources = { listSources: async ({ name }: { name: string }) => ({ models: [{ id: `src_${name}` }] }) } as unknown as HookdeckClient;
  const history = new EventHistory({ hookdeck: sources, catalog, providers: config.providers });
  // The bridge's clock, which may be off from Event Gateway's.
  const now = () => listing.now + (options.clockSkewMs ?? 0);
  const service = new PollService({ hookdeck: listing.client as unknown as HookdeckClient, catalog, history, now });
  return { listing, service };
}

const NAME = 'fills.order.filled';

describe('poll mode: cursor', () => {
  it('returns every event once, however late and out of order requests appear (property test)', async () => {
    // Seeded pseudo-random, so a failure reproduces.
    let seed = 42;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const { listing, service } = setup();
    const expected = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const createdAt = T0 + 1000 + Math.floor(rand() * 600_000);
      // Most appear within 4 s; some up to 15 s (the spike's worst); a few up to just under the look-back.
      const r = rand();
      const delay = r < 0.85 ? 500 + rand() * 3500 : r < 0.97 ? rand() * 15_000 : rand() * (LOOKBACK_MS - 5000);
      const k = rand();
      const kind = k < 0.05 ? 'duplicate' : k < 0.08 ? 'filtered' : k < 0.11 ? 'cli-disconnected' : 'event';
      // Some are listed before Event Gateway has routed them.
      const processedAt = rand() < 0.1 ? createdAt + delay + rand() * 20_000 : createdAt;
      const request = listing.add({ createdAt, visibleAt: createdAt + delay, processedAt, kind });
      if (kind === 'event' || kind === 'cli-disconnected') expected.add(request.deliveryId);
    }

    const returned: string[] = [];
    let cursor: string | null = null;
    while (listing.now < T0 + 600_000 + 120_000) {
      const result = await service.poll({ name: NAME, cursor, maxEvents: 1 + Math.floor(rand() * 100) });
      returned.push(...result.events.map((e) => e.eventId));
      cursor = result.cursor;
      if (!result.hasMore) listing.now += 500 + Math.floor(rand() * 4500);
    }

    expect(new Set(returned)).toEqual(expected);
    expect(returned.length).toBe(expected.size); // no repeats
    // Shared listing: about one call per 2-second interval, not one per poll.
    expect(listing.calls.length).toBeLessThan((720_000 / POLL_INTERVAL_MS) * 1.2);
  });

  it('starts from now with a null cursor, and ignores maxAgeMs then (SEP-3415: no replay)', async () => {
    const { listing, service } = setup();
    listing.add({ createdAt: T0 - 30_000, visibleAt: T0 - 29_000 });
    const first = await service.poll({ name: NAME, cursor: null, maxAgeMs: 3_600_000 });
    expect(first).toMatchObject({ resultType: 'complete', events: [], truncated: false, hasMore: false, nextPollMs: POLL_INTERVAL_MS });

    // A request created before the first poll, appearing after it, predates the subscription: not returned.
    listing.add({ createdAt: T0 - 1000, visibleAt: T0 + 3000, deliveryId: 'before' });
    listing.add({ createdAt: T0 + 1000, visibleAt: T0 + 3000, deliveryId: 'after' });
    listing.now += 5000;
    const next = await service.poll({ name: NAME, cursor: first.cursor });
    expect(next.events.map((e) => e.eventId)).toEqual(['after']);
    expect(next.events[0]).toMatchObject({ name: NAME, data: { symbol: 'AAPL' } });
  });

  it('filters by arguments, and returns only requests the relay would have delivered', async () => {
    const { listing, service } = setup();
    const start = await service.poll({ name: NAME, arguments: { symbol: 'AAPL' } });
    for (const [deliveryId, symbol, kind] of [
      ['aapl', 'AAPL', 'event'],
      ['msft', 'MSFT', 'event'],
      ['dupe', 'AAPL', 'duplicate'],
      ['filtered', 'AAPL', 'filtered'],
      ['laptop-asleep', 'AAPL', 'cli-disconnected'],
    ] as const) listing.add({ createdAt: T0 + 1000, deliveryId, symbol, kind });
    listing.now += 5000;
    const result = await service.poll({ name: NAME, arguments: { symbol: 'AAPL' }, cursor: start.cursor });
    expect(result.events.map((e) => e.eventId).sort()).toEqual(['aapl', 'laptop-asleep']);
  });

  it('holds the watermark for a request listed before Event Gateway has routed it, for up to the look-back', async () => {
    const { listing, service } = setup();
    const start = await service.poll({ name: NAME });
    listing.add({ createdAt: T0 + 1000, visibleAt: T0 + 2000, processedAt: T0 + 50_000, deliveryId: 'slow' });
    // Still unprocessed after the look-back: passed over, as documented.
    listing.add({ createdAt: T0 + 1000, visibleAt: T0 + 2000, processedAt: T0 + 70_000, deliveryId: 'too-slow' });
    let cursor = start.cursor;
    const seen: string[] = [];
    for (let t = 5000; t <= 80_000; t += 5000) {
      listing.now = T0 + t;
      const result = await service.poll({ name: NAME, cursor });
      seen.push(...result.events.map((e) => e.eventId));
      cursor = result.cursor;
    }
    expect(seen).toEqual(['slow']);
  });

  it('drains a backlog with maxEvents and hasMore, after a long gap (catch-up listing)', async () => {
    const { listing, service } = setup();
    const start = await service.poll({ name: NAME });
    for (let i = 0; i < 300; i++) listing.add({ createdAt: T0 + 1000 + i * 100 });
    listing.now += 10 * 60_000;
    let cursor = start.cursor;
    const got: string[] = [];
    let polls = 0;
    for (;;) {
      const result = await service.poll({ name: NAME, cursor, maxEvents: 40 });
      polls++;
      got.push(...result.events.map((e) => e.eventId));
      cursor = result.cursor;
      if (!result.hasMore) break;
      expect(result.nextPollMs).toBe(0);
    }
    expect(new Set(got).size).toBe(300);
    expect(got.length).toBe(300);
    expect(polls).toBe(Math.ceil(300 / 40));
  });

  it('keeps only returned ids in the cursor, so it grows with the subscription, not the source', async () => {
    const { listing, service } = setup();
    const start = await service.poll({ name: NAME, arguments: { symbol: 'AAPL' } });
    for (let i = 0; i < 200; i++) listing.add({ createdAt: T0 + 1000 + i * 100, symbol: i === 0 ? 'AAPL' : 'MSFT' });
    listing.now += 25_000;
    const result = await service.poll({ name: NAME, arguments: { symbol: 'AAPL' }, cursor: start.cursor });
    expect(result.events).toHaveLength(1);
    expect(result.cursor.length).toBeLessThan(250);
  });

  it('sets truncated when maxAgeMs skips past the last listing, and not on every poll with a short maxAgeMs', async () => {
    const { listing, service } = setup();
    const start = await service.poll({ name: NAME });
    listing.now += 2000;
    const recent = await service.poll({ name: NAME, cursor: start.cursor, maxAgeMs: 30_000 });
    expect(recent.truncated).toBe(false);
    listing.add({ createdAt: listing.now + 1000, deliveryId: 'old' });
    listing.add({ createdAt: listing.now + 4 * 60_000, deliveryId: 'new' });
    listing.now += 5 * 60_000;
    const late = await service.poll({ name: NAME, cursor: recent.cursor, maxAgeMs: 120_000 });
    expect(late.truncated).toBe(true);
    expect(late.events.map((e) => e.eventId)).toEqual(['new']);
  });

  it("doesn't lose events when the bridge's clock is ahead of Event Gateway's", async () => {
    const { listing, service } = setup({ clockSkewMs: 20_000 });
    const start = await service.poll({ name: NAME });
    listing.add({ createdAt: T0 + 1000, deliveryId: 'a' });
    listing.now += 5000;
    expect((await service.poll({ name: NAME, cursor: start.cursor })).events.map((e) => e.eventId)).toEqual(['a']);
  });

  it('refuses a cursor for other arguments, an unreadable cursor, and an unknown name', async () => {
    const { service } = setup();
    const start = await service.poll({ name: NAME, arguments: { symbol: 'AAPL' } });
    await expect(service.poll({ name: NAME, arguments: { symbol: 'MSFT' }, cursor: start.cursor })).rejects.toMatchObject({ code: EventsErrorCode.InvalidParams });
    await expect(service.poll({ name: NAME, cursor: 'not-a-cursor' })).rejects.toMatchObject({ code: EventsErrorCode.InvalidParams });
    await expect(service.poll({ name: 'nope.order.filled' })).rejects.toMatchObject({ code: EventsErrorCode.NotFound });
    await expect(service.poll({ name: NAME, arguments: { side: 'buy' } })).rejects.toMatchObject({ code: EventsErrorCode.InvalidParams });
    // maxEvents above the limit is lowered, not refused.
    await expect(service.poll({ name: NAME, maxEvents: 1000 })).resolves.toMatchObject({ resultType: 'complete' });
  });
});

describe('poll mode: shared listing and back-off', () => {
  it('answers concurrent polls with one listing, and lists only sources polled recently', async () => {
    const { listing, service } = setup({ providers: ['fills', 'orders'] });
    await Promise.all(Array.from({ length: 5 }, () => service.poll({ name: NAME })));
    expect(listing.calls).toHaveLength(1);
    expect(listing.calls[0]!.sources).toEqual(['src_bridge-fills']);

    // A poll for another source adds it at once.
    await service.poll({ name: 'orders.order.filled' });
    expect(listing.calls).toHaveLength(2);
    expect(listing.calls[1]!.sources.sort()).toEqual(['src_bridge-fills', 'src_bridge-orders']);

    // Within the interval, no new listing.
    await service.poll({ name: NAME });
    expect(listing.calls).toHaveLength(2);

    // After a minute with only fills polled, orders is dropped.
    listing.now += 61_000;
    await service.poll({ name: NAME });
    expect(listing.calls.at(-1)!.sources).toEqual(['src_bridge-fills']);
  });

  it('makes no calls when nobody polls', async () => {
    const { listing, service } = setup();
    await service.poll({ name: NAME });
    listing.now += 10 * 60_000;
    expect(listing.calls).toHaveLength(1);
  });

  it('slows down as the rate limit runs low, and answers from the last listing when rate limited', async () => {
    expect(intervalFor({ limit: 240, remaining: 200 })).toBe(POLL_INTERVAL_MS);
    expect(intervalFor({ limit: 240, remaining: 30 })).toBeGreaterThan(POLL_INTERVAL_MS);
    expect(intervalFor({ limit: 240, remaining: 0 })).toBe(MAX_POLL_INTERVAL_MS);

    const { listing, service } = setup();
    listing.rateLimit = { limit: 240, remaining: 20 };
    const first = await service.poll({ name: NAME });
    expect(first.nextPollMs).toBeGreaterThan(POLL_INTERVAL_MS);

    listing.rateLimited = true;
    listing.now += 60_000;
    const limited = await service.poll({ name: NAME, cursor: first.cursor });
    expect(limited).toMatchObject({ events: [], hasMore: false });
    expect(limited.nextPollMs).toBe(MAX_POLL_INTERVAL_MS);
  });
});

describe('poll mode: wait_for_event', () => {
  it('returns as soon as an event arrives, reading the shared listing', async () => {
    const { listing, service } = setup();
    listing.add({ createdAt: T0 + 7000, visibleAt: T0 + 9000, deliveryId: 'fill' });
    const progress: number[] = [];
    const sleep = async (ms: number) => void (listing.now += ms);
    const result = await service.wait({ name: NAME }, { timeoutMs: 45_000, sleep, onProgress: (ms) => progress.push(ms) });
    expect(result.events.map((e) => e.eventId)).toEqual(['fill']);
    expect(listing.now - T0).toBeLessThan(15_000);
    expect(progress.length).toBeGreaterThan(0);
    expect(listing.calls.length).toBeLessThanOrEqual(8);
  });

  it('returns no events and a cursor to wait from when the time is up', async () => {
    const { listing, service } = setup();
    const sleep = async (ms: number) => void (listing.now += ms);
    const result = await service.wait({ name: NAME }, { timeoutMs: 10_000, sleep });
    expect(result.events).toEqual([]);
    expect(listing.now - T0).toBeLessThanOrEqual(10_000);
    listing.add({ createdAt: listing.now + 1000, deliveryId: 'next' });
    const again = await service.wait({ name: NAME, cursor: result.cursor }, { timeoutMs: 10_000, sleep });
    expect(again.events.map((e) => e.eventId)).toEqual(['next']);
  });
});
