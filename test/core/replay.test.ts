import { describe, expect, it } from 'vitest';
import type { PastEvent } from '../../src/core/event-history.js';
import { MAX_POLL_INTERVAL_MS, type PollResult } from '../../src/core/poll.js';
import { WebhookReplay } from '../../src/core/replay.js';
import type { SubscriptionRecord } from '../../src/core/store.js';

const record = { id: 'sub_1', name: 'fills.order.filled', arguments: { symbol: 'AAPL' } } as unknown as SubscriptionRecord;
const event = (id: string): PastEvent => ({ eventId: id, name: 'fills.order.filled', timestamp: '2026-10-27T12:00:00.000Z', data: { symbol: 'AAPL' } });
const page = (events: PastEvent[], cursor: string, over: Partial<PollResult> = {}): PollResult => ({
  resultType: 'complete',
  events,
  cursor,
  truncated: false,
  hasMore: false,
  nextPollMs: 2000,
  ...over,
});

function setup(pages: PollResult[], { gone = false } = {}) {
  const polls: unknown[] = [];
  const delivered: Array<[string, string]> = [];
  const sleeps: number[] = [];
  let next = 0;
  const replay = new WebhookReplay({
    poll: {
      poll: async (params) => {
        polls.push(params.cursor);
        return pages[next++]!;
      },
    },
    deliver: async (_subscription, e, cursor) => void delivered.push([e.eventId, cursor]),
    current: () => (gone ? undefined : record),
    sleep: async (ms) => void sleeps.push(ms),
  });
  return { replay, polls, delivered, sleeps };
}

describe('webhook replay', () => {
  it("delivers the events since the cursor, page by page, each with a cursor that doesn't skip one still in flight", async () => {
    const { replay, polls, delivered } = setup([page([event('a'), event('b')], 'c1', { hasMore: true, nextPollMs: 0 }), page([event('c')], 'c2')]);
    expect(await replay.run('sub_1', 'c0')).toBe(3);
    expect(polls).toEqual(['c0', 'c1']);
    // The last event of a page carries the page's cursor; earlier ones the cursor from before it.
    expect(delivered).toEqual([
      ['a', 'c0'],
      ['b', 'c1'],
      ['c', 'c2'],
    ]);
  });

  it('waits out a rate limit (no events, the same cursor, the longest interval), then carries on', async () => {
    const { replay, delivered, sleeps } = setup([page([], 'c0', { nextPollMs: MAX_POLL_INTERVAL_MS }), page([event('a')], 'c1')]);
    expect(await replay.run('sub_1', 'c0')).toBe(1);
    expect(sleeps).toEqual([MAX_POLL_INTERVAL_MS]);
    expect(delivered).toEqual([['a', 'c1']]);
  });

  it('stops when the subscription is gone', async () => {
    const { replay, polls, delivered } = setup([page([event('a')], 'c1')], { gone: true });
    expect(await replay.run('sub_1', 'c0')).toBe(0);
    expect(polls).toEqual([]);
    expect(delivered).toEqual([]);
  });
});
