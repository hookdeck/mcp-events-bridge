import type { CallbackFailureReason } from './errors.js';

/*
 * What the bridge keeps. Events are not stored: Event Gateway is the record of
 * every event. Async so a serverless store can implement the same interface.
 */

/** A configured provider instance and the Event Gateway resources `bridge setup` created for it. */
export interface ProviderRecord {
  instanceId: string;
  type: string;
  /** Hash of the instance's non-secret options, to detect config drift. */
  optionsHash: string;
  sourceId: string;
  sourceUrl: string;
  connectionId: string;
  events: string[];
  providerWebhookId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One PUBLISH_API source per MCP event name. */
export interface TopicRecord {
  name: string;
  sourceId: string;
  sourceName: string;
}

/** Delivery health, from Event Gateway issue notifications. Reported as `deliveryStatus`. */
export interface SubscriptionDeliveryState {
  active: boolean;
  lastError: CallbackFailureReason | null;
  failedSince: string | null;
}

/**
 * An MCP Events webhook subscription. The relay signs each publish, so the
 * secret is kept (and the previous one during a rotation grace window).
 */
export interface SubscriptionRecord {
  id: string;
  principal: string;
  name: string;
  arguments: Record<string, unknown>;
  url: string;
  secret: string;
  previousSecret: string | null;
  previousSecretExpiresAt: string | null;
  connectionId: string;
  destinationId: string;
  delivery: SubscriptionDeliveryState;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface Store {
  getProvider(instanceId: string): Promise<ProviderRecord | undefined>;
  listProviders(): Promise<ProviderRecord[]>;
  putProvider(record: ProviderRecord): Promise<void>;
  deleteProvider(instanceId: string): Promise<void>;

  getTopic(name: string): Promise<TopicRecord | undefined>;
  putTopic(record: TopicRecord): Promise<void>;
  deleteTopic(name: string): Promise<void>;

  getSubscription(id: string): Promise<SubscriptionRecord | undefined>;
  /** Subscriptions to an event name, for matching an inbound event. */
  listSubscriptions(filter?: { name?: string }): Promise<SubscriptionRecord[]>;
  findSubscriptionByConnection(connectionId: string): Promise<SubscriptionRecord | undefined>;
  /** Subscriptions whose expiry is at or before `now`, for the sweeper. */
  listExpiredSubscriptions(now: Date): Promise<SubscriptionRecord[]>;
  putSubscription(record: SubscriptionRecord): Promise<void>;
  deleteSubscription(id: string): Promise<void>;

  close(): Promise<void>;
}

export const healthyDelivery = (): SubscriptionDeliveryState => ({ active: true, lastError: null, failedSince: null });
