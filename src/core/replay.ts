import type { PastEvent } from './event-history.js';
import { MAX_EVENTS, MAX_POLL_INTERVAL_MS, type PollService } from './poll.js';
import type { SubscriptionRecord } from './store.js';

/*
 * Webhook replay (SEP-3415): a new subscription made with a cursor gets the events since it, delivered as live ones
 * are. They're read from Event Gateway's stored requests through poll mode's listing, so the cursor is poll's. Replay
 * runs after events/subscribe answers. An event can arrive twice (a live one during the replay, or one from the minute
 * before a cursor's position), so receivers dedupe by eventId.
 */

/** How many times a replay waits out a rate limit before giving up. */
const MAX_RATE_LIMITED_WAITS = 10;

export interface WebhookReplayDeps {
  poll: Pick<PollService, 'poll'>;
  /** Publishes one event to one subscriber, as the relay does live (`Relay.deliver`). */
  deliver: (subscription: SubscriptionRecord, event: PastEvent, cursor: string) => Promise<unknown>;
  /** The subscription as it is now. Replay stops when it's gone (unsubscribed, or expired and swept). */
  current: (id: string) => SubscriptionRecord | undefined;
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
    this.run(subscription.id, cursor).catch((error: unknown) => this.log(`replay to ${subscription.id} stopped: ${(error as Error).message}`));
  }

  /** Delivers the events since `cursor`, oldest first, and returns how many. */
  async run(id: string, cursor: string): Promise<number> {
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    let position = cursor;
    let delivered = 0;
    let waits = 0;
    for (;;) {
      const subscription = this.deps.current(id);
      if (!subscription) {
        this.log(`replay to ${id} stopped: the subscription is gone`);
        return delivered;
      }
      const result = await this.deps.poll.poll({ name: subscription.name, arguments: subscription.arguments, cursor: position, maxEvents: MAX_EVENTS });
      // Rate limited: poll answers with no events, the same cursor and the longest interval. Wait it out.
      if (result.events.length === 0 && result.cursor === position && result.nextPollMs >= MAX_POLL_INTERVAL_MS) {
        if (++waits > MAX_RATE_LIMITED_WAITS) throw new Error('the Event Gateway API stayed rate limited');
        await sleep(result.nextPollMs);
        continue;
      }
      // Each event carries the cursor from before its batch, and the batch's last one the cursor after it, so a
      // client that persists the cursor of the event it just got never skips one still in flight.
      for (const [i, event] of result.events.entries()) {
        await this.deps.deliver(subscription, event, i === result.events.length - 1 ? result.cursor : position);
        delivered++;
      }
      position = result.cursor;
      if (!result.hasMore) break;
      if (result.nextPollMs > 0) await sleep(result.nextPollMs);
    }
    this.log(`replayed ${delivered} event(s) to ${id}`);
    return delivered;
  }
}
