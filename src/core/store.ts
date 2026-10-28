import type { CallbackFailureReason } from './errors.js';

/*
 * Subscription state. Event Gateway is the store: each subscription is a connection from its service's source to a
 * destination at the callback URL, with the rest of its state in the connection's description (see
 * event-gateway-store.ts). Events are never stored by the bridge.
 */

/** Delivery health, from Event Gateway issue notifications. Reported as `deliveryStatus`. */
export interface SubscriptionDeliveryState {
  active: boolean;
  lastError: CallbackFailureReason | null;
  failedSince: string | null;
}

/** A cursor position, as poll's cursor holds it: the floor (nothing before it) and the watermark. */
export interface CursorPosition {
  f: number;
  w: number;
}

/** What the subscription service decides; the store adds the Event Gateway ids. */
export interface SubscriptionInput {
  id: string;
  principal: string;
  name: string;
  arguments: Record<string, unknown>;
  url: string;
  /** The subscriber's signing secret, on its destination, which signs every delivery with it. */
  secret: string;
  /** While a replay runs, where it started: every delivery's cursor has it until the replay is done. */
  replay: CursorPosition | null;
  delivery: SubscriptionDeliveryState;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface SubscriptionRecord extends SubscriptionInput {
  connectionId: string;
  destinationId: string;
  /** The service's source (`bridge-<source id>`), which the subscription's connection is on. */
  sourceId: string;
}

/** Thrown when a subscription's state doesn't fit Event Gateway's description limits. */
export class SubscriptionTooLargeError extends Error {}

export interface SubscriptionStore {
  /** Builds the in-memory index. Call once at startup. `legacy` counts subscriptions from 0.7 or earlier, left for the migration. */
  load(): Promise<{ loaded: number; unreadable: string[]; legacy: number }>;
  get(id: string): SubscriptionRecord | undefined;
  /** Subscriptions to an event name. */
  list(filter?: { name?: string }): SubscriptionRecord[];
  findByConnection(connectionId: string): SubscriptionRecord | undefined;
  /** Subscriptions whose expiry is at or before `now`, for the sweeper. */
  listExpired(now: Date): SubscriptionRecord[];
  /** Creates or updates the subscription's Event Gateway resources and state. */
  put(input: SubscriptionInput): Promise<SubscriptionRecord>;
  /**
   * Read-modify-write in the store's write queue, so it can't interleave with another write (a refresh and a
   * delivery-failure notification, say). `change` gets the current record and returns the new state, or null to
   * leave it as it is.
   */
  update(id: string, change: (current: SubscriptionRecord | undefined) => SubscriptionInput | null): Promise<SubscriptionRecord | undefined>;
  /**
   * Deletes the subscription's connection and destination. Resources already gone count as deleted. With
   * `ifExpiredAt`, deletes only if the subscription is still expired at that time, checked in the write queue (so a
   * refresh during a sweep wins). Resolves true if it deleted something.
   */
  delete(id: string, options?: { ifExpiredAt?: Date }): Promise<boolean>;
}

export const healthyDelivery = (): SubscriptionDeliveryState => ({ active: true, lastError: null, failedSince: null });
