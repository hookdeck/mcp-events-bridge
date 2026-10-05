import type { CallbackFailureReason } from './errors.js';

/*
 * Subscription state. Event Gateway is the store: each subscription is a
 * connection from its topic source to a destination at the callback URL, with
 * the rest of its state sealed in the resource descriptions (see
 * event-gateway-store.ts). Events are never stored by the bridge.
 */

/** Delivery health, from Event Gateway issue notifications. Reported as `deliveryStatus`. */
export interface SubscriptionDeliveryState {
  active: boolean;
  lastError: CallbackFailureReason | null;
  failedSince: string | null;
}

/** What the subscription service decides; the store adds the Event Gateway ids. */
export interface SubscriptionInput {
  id: string;
  principal: string;
  name: string;
  arguments: Record<string, unknown>;
  url: string;
  /** The relay signs each publish, so the secret is kept (and the previous one during a rotation grace window). */
  secret: string;
  previousSecret: string | null;
  previousSecretExpiresAt: string | null;
  delivery: SubscriptionDeliveryState;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface SubscriptionRecord extends SubscriptionInput {
  connectionId: string;
  destinationId: string;
  topicSourceId: string;
}

/** Thrown when a subscription's state doesn't fit Event Gateway's description limits. */
export class SubscriptionTooLargeError extends Error {}

export interface SubscriptionStore {
  /** Builds the in-memory index. Call once at startup. */
  load(): Promise<{ loaded: number; unreadable: string[] }>;
  get(id: string): SubscriptionRecord | undefined;
  /** Subscriptions to an event name, for matching an inbound event. */
  list(filter?: { name?: string }): SubscriptionRecord[];
  findByConnection(connectionId: string): SubscriptionRecord | undefined;
  /** Subscriptions whose expiry is at or before `now`, for the sweeper. */
  listExpired(now: Date): SubscriptionRecord[];
  /** Creates or updates the subscription's Event Gateway resources and state. */
  put(input: SubscriptionInput): Promise<SubscriptionRecord>;
  /** Deletes the subscription's resources, and its topic source when it was the last subscriber. */
  delete(id: string): Promise<void>;
}

export const healthyDelivery = (): SubscriptionDeliveryState => ({ active: true, lastError: null, failedSince: null });

/** A configured provider instance, discovered from Event Gateway by name. */
export interface ProviderRecord {
  instanceId: string;
  type: string;
  sourceId: string;
  sourceUrl: string;
  connectionId: string;
  events: string[];
  providerWebhookId: string | null;
}
