import { MAX_EVENTS, MAX_POLL_INTERVAL_MS, type PollService } from './poll.js';
import type { SubscriptionRecord } from './store.js';

/*
 * Webhook replay (SEP-3415): a new subscription made with a cursor gets the events since it. They're found with poll
 * mode's listing of Event Gateway's stored requests (so the cursor is poll's), and Event Gateway delivers them: while
 * the replay runs, a connection from the bridge's Publish API source (`bridge-replay`) to the subscription's own
 * destination carries the envelopes the bridge builds with the source's runtime, and the destination signs every
 * attempt with the subscriber's secret. Retrying the stored requests instead can't work: Event Gateway only retries a
 * request for the connections it was routed to when it arrived, and a new subscription's connection wasn't one
 * (verified 27 Oct). While it runs, the subscription carries a replay marker, and every delivery's cursor (replayed or
 * live, see transformation.ts) points where the replay started; once the replayed events have settled, the replay
 * connection is deleted and the marker cleared. An event can arrive twice (a live one during the replay, or one from
 * the minute before the cursor), so receivers dedupe by eventId.
 */

/** How many times a replay waits out a rate limit before giving up. */
const MAX_RATE_LIMITED_WAITS = 10;
/** How long a replay waits for its events to settle before deleting the replay connection anyway. */
const SETTLE_TIMEOUT_MS = 10 * 60_000;

export interface ReplayEnvelope {
  eventId: string;
  name: string;
  timestamp: string;
  data: unknown;
  cursor: string;
}

export interface WebhookReplayDeps {
  poll: Pick<PollService, 'poll'>;
  /** The cursor replayed deliveries carry: where the replay started (the subscription's replay marker). */
  cursor: (subscription: SubscriptionRecord) => string;
  /** Creates the replay connection to the subscription's destination; resolves with its id. */
  open: (subscription: SubscriptionRecord) => Promise<string>;
  /** Publishes one event's envelope to the replay connection. */
  publish: (subscription: SubscriptionRecord, envelope: ReplayEnvelope) => Promise<unknown>;
  /** Resolves once the replay connection has `count` events, all settled (delivered, failed or cancelled), or after `timeoutMs`. */
  settled: (connectionId: string, count: number, timeoutMs: number) => Promise<void>;
  /** Deletes the replay connection. */
  close: (connectionId: string) => Promise<unknown>;
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

  /** Publishes the events since `cursor`, oldest first, waits for them to settle, and returns how many. */
  async run(id: string, cursor: string): Promise<number> {
    const first = this.deps.current(id);
    if (!first) return 0;
    const connectionId = await this.deps.open(first);
    try {
      const published = await this.publishSince(id, cursor);
      if (published) await this.deps.settled(connectionId, published, SETTLE_TIMEOUT_MS);
      this.log(`replayed ${published} event(s) to ${id}`);
      return published;
    } finally {
      await this.deps.close(connectionId).catch((error: unknown) => this.log(`could not delete the replay connection for ${id}: ${(error as Error).message}`));
    }
  }

  private async publishSince(id: string, cursor: string): Promise<number> {
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    let position = cursor;
    let published = 0;
    let waits = 0;
    for (;;) {
      const subscription = this.deps.current(id);
      if (!subscription) {
        this.log(`replay to ${id} stopped: the subscription is gone`);
        return published;
      }
      const result = await this.deps.poll.poll({ name: subscription.name, arguments: subscription.arguments, cursor: position, maxEvents: MAX_EVENTS });
      // Rate limited: poll answers with no events, the same cursor and the longest interval. Wait it out.
      if (result.events.length === 0 && result.cursor === position && result.nextPollMs >= MAX_POLL_INTERVAL_MS) {
        if (++waits > MAX_RATE_LIMITED_WAITS) throw new Error('the Event Gateway API stayed rate limited');
        await sleep(result.nextPollMs);
        continue;
      }
      const replayCursor = this.deps.cursor(subscription);
      for (const event of result.events) {
        await this.deps.publish(subscription, { eventId: event.eventId, name: event.name, timestamp: event.timestamp, data: event.data, cursor: replayCursor });
        published++;
      }
      position = result.cursor;
      if (!result.hasMore) return published;
      if (result.nextPollMs > 0) await sleep(result.nextPollMs);
    }
  }
}
