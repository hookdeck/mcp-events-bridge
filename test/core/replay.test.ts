import { describe, expect, it } from 'vitest';
import type { PastEvent } from '../../src/core/event-history.js';
import { MAX_POLL_INTERVAL_MS, type PollResult } from '../../src/core/poll.js';
import { WebhookReplay, type ReplayEnvelope } from '../../src/core/replay.js';
import type { SubscriptionRecord } from '../../src/core/store.js';

const record = { id: 'sub_1', name: 'fills.order.filled', arguments: { symbol: 'AAPL' }, connectionId: 'web_1', destinationId: 'des_1', replay: { f: 1, w: 1 } } as unknown as SubscriptionRecord;
const event = (id: string): PastEvent => ({ eventId: id, name: 'fills.order.filled', timestamp: '2026-10-27T12:00:00.000Z', data: { symbol: 'AAPL' } });
const page = (ids: string[], cursor: string, over: Partial<PollResult> = {}): PollResult => ({
  resultType: 'complete' as const,
  events: ids.map(event),
  cursor,
  truncated: false,
  hasMore: false,
  nextPollMs: 2000,
  ...over,
});

function setup(pages: PollResult[], { gone = false, failPublish = false } = {}) {
  const polls: unknown[] = [];
  const published: ReplayEnvelope[] = [];
  const calls: string[] = [];
  const finished: string[] = [];
  const sleeps: number[] = [];
  let next = 0;
  const replay = new WebhookReplay({
    poll: {
      poll: async (params) => {
        polls.push(params.cursor);
        return pages[next++]!;
      },
    },
    cursor: (subscription) => `replay-start:${subscription.id}`,
    open: async (subscription) => (calls.push(`open ${subscription.destinationId}`), 'web_replay'),
    publish: async (_subscription, envelope) => {
      if (failPublish) throw new Error('publish failed');
      published.push(envelope);
    },
    settled: async (connectionId, count) => void calls.push(`settled ${connectionId} ${count}`),
    close: async (connectionId) => void calls.push(`close ${connectionId}`),
    current: () => (gone ? undefined : record),
    finish: async (id) => void finished.push(id),
    sleep: async (ms) => void sleeps.push(ms),
  });
  return { replay, polls, published, calls, finished, sleeps };
}

describe("webhook replay (Event Gateway delivers through a connection to the subscription's destination)", () => {
  it("publishes each event since the cursor, page by page, with the replay's start as its cursor, then waits for them to settle and closes the connection", async () => {
    const { replay, polls, published, calls } = setup([page(['a', 'b'], 'c1', { hasMore: true, nextPollMs: 0 }), page(['c'], 'c2')]);
    expect(await replay.run('sub_1', 'c0')).toBe(3);
    expect(polls).toEqual(['c0', 'c1']);
    expect(published).toEqual(['a', 'b', 'c'].map((id) => ({ ...event(id), cursor: 'replay-start:sub_1' })));
    expect(calls).toEqual(['open des_1', 'settled web_replay 3', 'close web_replay']);
  });

  it('waits out a rate limit (no events, the same cursor, the longest interval), then continues', async () => {
    const { replay, published, sleeps } = setup([page([], 'c0', { nextPollMs: MAX_POLL_INTERVAL_MS }), page(['a'], 'c1')]);
    expect(await replay.run('sub_1', 'c0')).toBe(1);
    expect(sleeps).toEqual([MAX_POLL_INTERVAL_MS]);
    expect(published.map((e) => e.eventId)).toEqual(['a']);
  });

  it("closes the replay connection when publishing fails, and doesn't wait for events that weren't sent", async () => {
    const { replay, calls } = setup([page(['a'], 'c1')], { failPublish: true });
    await expect(replay.run('sub_1', 'c0')).rejects.toThrow('publish failed');
    expect(calls).toEqual(['open des_1', 'close web_replay']);
  });

  it('does nothing when the subscription is gone, and always clears the replay marker', async () => {
    const { replay, polls, calls, finished } = setup([page(['a'], 'c1')], { gone: true });
    replay.start(record, 'c0');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(polls).toEqual([]);
    expect(calls).toEqual([]);
    expect(finished).toEqual(['sub_1']);
  });
});
