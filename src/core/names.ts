/*
 * Event Gateway resource names. Names must match ^[A-Za-z0-9_-]+$ (no dots),
 * so MCP event names are slugged.
 */

const NAME = /^[A-Za-z0-9_-]+$/;

/** "email.received" -> "email_received". */
export function slug(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '_');
}

export function assertResourceName(name: string): string {
  if (!NAME.test(name)) throw new Error(`Invalid Event Gateway resource name: ${name}`);
  return name;
}

export const SUBSCRIPTION_PREFIX = 'mcp-sub-';

/** The PUBLISH_API topic source for an MCP event name, in 0.7 and earlier (the migration deletes them). */
export const topicSourceName = (eventName: string) => assertResourceName(`bridge-out-${slug(eventName)}`);

/** The Publish API source a replay's events are published to, and each replay's connection from it (see replay.ts). */
export const REPLAY_SOURCE = 'bridge-replay';
export const REPLAY_CONNECTION_PREFIX = 'bridge-replay-';
export const replayConnectionName = (subscriptionId: string) => assertResourceName(`${REPLAY_CONNECTION_PREFIX}${subscriptionId}`);

/** Connection and destination name for a subscription (ids are sub_ + hex). */
export const subscriptionResourceName = (subscriptionId: string) => assertResourceName(`${SUBSCRIPTION_PREFIX}${subscriptionId}`);

export const providerSourceName = (instanceId: string) => assertResourceName(`bridge-${slug(instanceId)}`);

export const providerConnectionName = (instanceId: string, deployment: string) =>
  assertResourceName(`bridge-${slug(instanceId)}-${slug(deployment)}`);

export const notificationsConnectionName = (deployment: string) => assertResourceName(`bridge-notifications-${slug(deployment)}`);
/** The transformation every subscription to a source's events shares: it builds the MCP event. */
export const transformationName = (instanceId: string) => assertResourceName(`bridge-${slug(instanceId)}-envelope`);
