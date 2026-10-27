import { describe, expect, it } from 'vitest';
import type { PastEvent } from '../../src/core/event-history.js';
import { MAX_POLL_INTERVAL_MS, type PollResult } from '../../src/core/poll.js';
import { WebhookReplay } from '../../src/core/replay.js';
import type { SubscriptionRecord } from '../../src/core/store.js';

const record = { id: 'sub_1', name: 'fills.order.filled', arguments: { symbol: 'AAPL' }, connectionId: 'web_1' } as unknown as SubscriptionRecord;
const event = (id: string): PastEvent => ({ eventId: id, name: 'fills.order.filled', timestamp: '2026-10-27T12:00:00.000Z', data: { symbol: 'AAPL' } });
const page = (ids: string[], cursor: string, over: Partial<PollResult> = {}) => ({
  resultType: 'complete' as const,
  events: ids.map(event),
  requestIds: ids.map((id) => `req_${id}`),
  cursor,
  truncated: false,
  hasMore: false,
  nextPollMs: 2000,
  ...over,
});

function setup(pages: ReturnType<typeof page>[], { gone = false } = {}) {
  const polls: unknown[] = [];
  const retried: Array<[string, string]> = [];
  const settled: string[][] = [];
  const finished: string[] = [];
  const sleeps: number[] = [];
  let next = 0;
  const replay = new WebhookReplay({
    poll: {
      pollRequests: async (params) => {
        polls.push(params.cursor);
        return pages[next++]!;
      },
    },
    retry: async (requestId, connectionId) => {
      retried.push([requestId, connectionId]);
      return { events: [{ id: `evt_${requestId}` }] };
    },
    settled: async (ids) => void settled.push(ids),
    current: () => (gone ? undefined : record),
    finish: async (id) => void finished.push(id),
    sleep: async (ms) => void sleeps.push(ms),
  });
  return { replay, polls, retried, settled, finished, sleeps };
}

describe('webhook replay (Event Gateway retries stored requests for the subscription)', () => {
  it("retries the matching requests since the cursor for the subscription's connection, page by page, then waits for them to settle", async () => {
    const { replay, polls, retried, settled } = setup([page(['a', 'b'], 'c1', { hasMore: true, nextPollMs: 0 }), page(['c'], 'c2')]);
    expect(await replay.run('sub_1', 'c0')).toBe(3);
    expect(polls).toEqual(['c0', 'c1']);
    expect(retried).toEqual([
      ['req_a', 'web_1'],
      ['req_b', 'web_1'],
      ['req_c', 'web_1'],
    ]);
    expect(settled).toEqual([['evt_req_a', 'evt_req_b', 'evt_req_c']]);
  });

  it('waits out a rate limit (no events, the same cursor, the longest interval), then carries on', async () => {
    const { replay, retried, sleeps } = setup([page([], 'c0', { nextPollMs: MAX_POLL_INTERVAL_MS }), page(['a'], 'c1')]);
    expect(await replay.run('sub_1', 'c0')).toBe(1);
    expect(sleeps).toEqual([MAX_POLL_INTERVAL_MS]);
    expect(retried).toEqual([['req_a', 'web_1']]);
  });

  it('stops when the subscription is gone, and always clears the replay marker', async () => {
    const { replay, polls, retried, finished } = setup([page(['a'], 'c1')], { gone: true });
    replay.start(record, 'c0');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(polls).toEqual([]);
    expect(retried).toEqual([]);
    expect(finished).toEqual(['sub_1']);
  });
});
