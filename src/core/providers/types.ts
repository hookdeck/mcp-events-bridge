/*
 * Provider definitions describe a provider's events. They don't wrap provider
 * APIs, apart from registering the webhook at setup. Built-in and custom
 * providers both use these types (`defineProvider` comes with the config file).
 */

/** An inbound request as Event Gateway delivers it to the bridge. */
export interface InboundRequest {
  /** Lower-cased header names. */
  headers: Record<string, string>;
  /** The parsed JSON body. */
  body: unknown;
}

export type JsonSchema = Record<string, unknown>;

export interface ProviderEvent<Args = Record<string, unknown>, Summary extends Record<string, unknown> = Record<string, unknown>> {
  /** MCP event name, e.g. "email.received". */
  name: string;
  description: string;
  /** The provider's own event type. */
  providerEvent: string;
  matches(req: InboundRequest): boolean;
  /** The provider's stable event id: the MCP envelope's eventId and webhook-id. */
  eventId(req: InboundRequest): string;
  /** ISO 8601 time the event happened. */
  occurredAt(req: InboundRequest): string;
  /** The envelope's `data`: triage fields only, well under 256 KiB, plus normalized fields for matching. */
  summarize(req: InboundRequest): Summary;
  /** JSON Schema for subscribe arguments. */
  inputSchema: JsonSchema;
  /** Validates and normalizes subscribe arguments; throws on invalid input. */
  parseArguments(args: unknown): Args;
  /** Whether an event matches a subscription's (parsed) arguments. */
  accepts(args: Args, summary: Summary): boolean;
  /** JSON Schema for `data`. */
  payloadSchema: JsonSchema;
}

export interface RegisterContext<Options> {
  sourceUrl: string;
  providerEvents: string[];
  options: Options;
  fetch: typeof fetch;
}

export interface ProviderDefinition<Options = Record<string, unknown>> {
  /** Provider type, e.g. "resend". */
  type: string;
  displayName: string;
  /** Event Gateway source type, e.g. "RESEND". */
  sourceType: string;
  /** Request fields that identify a provider delivery, for a dedupe rule on the inbound connection (e.g. headers.svix-id). */
  inboundDedupeFields?: string[];
  /** The header carrying the provider's event id, to find an event's request in Event Gateway (e.g. svix-id). */
  eventIdHeader?: string;
  // Each event has its own argument and summary types.
  events: ProviderEvent<any, any>[];
  /** MCP event names enabled when the config doesn't list any. Default: all of them. */
  defaultEvents?: string[];
  /** Creates the provider-side webhook at the source URL. The returned secret goes straight onto the source. */
  register?(ctx: RegisterContext<Options>): Promise<{ webhookId: string; signingSecret: string }>;
  unregister?(ctx: { webhookId: string; options: Options; fetch: typeof fetch }): Promise<void>;
}

/** `Name <addr@example.com>` or `addr@example.com` to `addr@example.com`, lower-cased. */
export function normalizeAddress(value: string): string {
  const angle = /<([^<>]+)>\s*$/.exec(value);
  return (angle ? angle[1]! : value).trim().toLowerCase();
}
