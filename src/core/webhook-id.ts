import { randomBytes } from 'node:crypto';

/*
 * The format of a subscription's deliveries' `webhook-id` (#113).
 *
 *   event-id      the event's `eventId`, as the bridge has always sent it. The Vercel AI SDK, TanStack AI and OpenClaw
 *                 reject a delivery whose `webhook-id` isn't its `eventId`, and OpenAI's guide for ChatGPT asks for the
 *                 same.
 *   per-message   `msg_` and 24 random characters, as SEP-3415 requires: unique to one event on one subscription, kept
 *                 across retries, and never derived from `eventId`.
 *
 * The format is chosen at subscribe time and kept in the subscription's connection description, where the
 * transformation reads it. Event Gateway runs the transformation once per event and every attempt (automatic or
 * manual retry) reuses its headers, so a generated id stays the same across retries (verified 13 Nov).
 */

export type WebhookIdFormat = 'event-id' | 'per-message';

/** The operator's choice: `auto` picks per subscription, from what the client declares; the others apply to every subscription. */
export type WebhookIdFormatSetting = 'auto' | WebhookIdFormat;

export const WEBHOOK_ID_FORMATS: readonly WebhookIdFormatSetting[] = ['auto', 'event-id', 'per-message'];

export const EVENTS_EXTENSION = 'io.modelcontextprotocol/events';
const CLIENT_CAPABILITIES_META_KEY = 'io.modelcontextprotocol/clientCapabilities';
const CLIENT_INFO_META_KEY = 'io.modelcontextprotocol/clientInfo';

/**
 * Clients that reject a delivery whose `webhook-id` isn't its `eventId`, by their default name in
 * `_meta["io.modelcontextprotocol/clientInfo"]`. They get `event-id` under `auto` even if they declare the events
 * extension. Checked 13 Nov:
 *
 *   tanstack-ai-mcp     TanStack AI (`@tanstack/ai-mcp` 1.2.0) declares the extension whenever events are enabled
 *                       (`client.ts:311`), and rejects at `events/webhook.ts:297`.
 *   ai-sdk-mcp-client   The Vercel AI SDK (`@ai-sdk/mcp` 2.0.99) declares it only if the application passes it in
 *                       `capabilities`; rejects at `mcp-event-webhook.ts:211`.
 *   openclaw            OpenClaw (v2026.11.3) declares nothing (`clientCapabilities: {}`); listed in case it starts.
 *
 * TanStack AI and the AI SDK let the application rename the client, which this list can't see: such a deployment sets
 * BRIDGE_WEBHOOK_ID_FORMAT=event-id. Remove a client once a release that accepts a per-message id has shipped.
 */
export const LEGACY_WEBHOOK_ID_CLIENTS: readonly string[] = ['tanstack-ai-mcp', 'ai-sdk-mcp-client', 'openclaw'];

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Whether a request's `_meta` declares the events extension (SEP-3415's per-request client capabilities). */
export function declaresEventsExtension(meta: unknown): boolean {
  if (!isObject(meta)) return false;
  const capabilities = meta[CLIENT_CAPABILITIES_META_KEY];
  return isObject(capabilities) && isObject(capabilities.extensions) && isObject(capabilities.extensions[EVENTS_EXTENSION]);
}

/** The client's name from a request's `_meta`, if it sends one. */
export function clientName(meta: unknown): string | undefined {
  if (!isObject(meta)) return undefined;
  const info = meta[CLIENT_INFO_META_KEY];
  return isObject(info) && typeof info.name === 'string' ? info.name : undefined;
}

/**
 * The format for a subscribe request. Under `auto`, a client that declares the events extension in the request's
 * `_meta` gets `per-message`, unless it's on the legacy list; any other client gets `event-id`.
 */
export function chooseWebhookIdFormat(setting: WebhookIdFormatSetting, meta: unknown, legacyClients: readonly string[] = LEGACY_WEBHOOK_ID_CLIENTS): WebhookIdFormat {
  if (setting !== 'auto') return setting;
  if (!declaresEventsExtension(meta)) return 'event-id';
  const name = clientName(meta);
  return name !== undefined && legacyClients.includes(name) ? 'event-id' : 'per-message';
}

/** A per-message `webhook-id`: `msg_` and 24 characters from [A-Za-z0-9_-] (18 random bytes). The transformation builds the same shape. */
export function messageId(): string {
  return `msg_${randomBytes(18).toString('base64url')}`;
}

/** The `webhook-id` for one delivery of an event in a format. */
export function deliveryWebhookId(format: WebhookIdFormat, eventId: string): string {
  return format === 'per-message' ? messageId() : eventId;
}
