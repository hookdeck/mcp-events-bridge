import { MAX_EVENTS, MAX_POLL_INTERVAL_MS, type PollService } from './poll.js';
import type { SubscriptionRecord } from './store.js';

/*
 * Webhook replay (SEP-3415): a new subscription made with a cursor gets the events since it. They're found with poll
 * mode's listing of Event Gateway's stored requests (so the cursor is poll's), and each request is retried for the
 * subscription's connection, so Event Gateway builds, filters, dedupes, signs and delivers it as it does a live one.
 * While it runs, the subscription carries a replay marker, and every delivery's cursor points where the replay
 * started (see transformation.ts); the marker is cleared once the retried events have settled. An event can arrive
 * twice (a live one during the replay, or one from the minute before the cursor), so receivers dedupe by eventId.
 */

/** How many times a replay waits out a rate limit before giving up. */
const MAX_RATE_LIMITED_WAITS = 10;
/** How long a replay waits for its retried events to settle before clearing the marker anyway. */
const SETTLE_TIMEOUT_MS = 10 * 60_000;

export interface WebhookReplayDeps {
  poll: Pick<PollService, 'pollRequests'>;
  /** Retries a stored request for one connection; resolves with the events it created. */
  retry: (requestId: string, connectionId: string) => Promise<{ events?: Array<{ id: string }> }>;
  /** Resolves once these events have settled (delivered, failed or cancelled), or after `timeoutMs`. */
  settled: (eventIds: string[], timeoutMs: number) => Promise<void>;
  /** The subscription as it is now. Replay stops when it's gone (unsubscribed, or expired and swept). */
  current: (id: string) => SubscriptionRecord | undefined;
  /** Clears the subscription's replay marker. */
  finish: (id: string) => Promise<unknown>;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
}

export class WebhookReplay {
  private readonly log: (message: string) => void;

  constructor(private readonly deps: WebhookReplayDeps) {
    this.log = deps.log ?? (() => {});
  }

  /** Replays in the background; a failure is logged, and the subscription carries on with live events. */
  start(subscription: SubscriptionRecord, cursor: string): void {
    this.run(subscription.id, cursor)
      .catch((error: unknown) => this.log(`replay to ${subscription.id} stopped: ${(error as Error).message}`))
      .finally(() => this.deps.finish(subscription.id).catch(() => {}));
  }

  /** Retries the requests since `cursor`, oldest first, waits for their events to settle, and returns how many. */
  async run(id: string, cursor: string): Promise<number> {
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    let position = cursor;
    let retried = 0;
    let waits = 0;
    const eventIds: string[] = [];
    for (;;) {
      const subscription = this.deps.current(id);
      if (!subscription) {
        this.log(`replay to ${id} stopped: the subscription is gone`);
        return retried;
      }
      const result = await this.deps.poll.pollRequests({ name: subscription.name, arguments: subscription.arguments, cursor: position, maxEvents: MAX_EVENTS });
      // Rate limited: poll answers with no events, the same cursor and the longest interval. Wait it out.
      if (result.events.length === 0 && result.cursor === position && result.nextPollMs >= MAX_POLL_INTERVAL_MS) {
        if (++waits > MAX_RATE_LIMITED_WAITS) throw new Error('the Event Gateway API stayed rate limited');
        await sleep(result.nextPollMs);
        continue;
      }
      for (const requestId of result.requestIds) {
        const { events = [] } = await this.deps.retry(requestId, subscription.connectionId);
        eventIds.push(...events.map((e) => e.id));
        retried++;
      }
      position = result.cursor;
      if (!result.hasMore) break;
      if (result.nextPollMs > 0) await sleep(result.nextPollMs);
    }
    if (eventIds.length) await this.deps.settled(eventIds, SETTLE_TIMEOUT_MS);
    this.log(`replayed ${retried} event(s) to ${id}`);
    return retried;
  }
}
