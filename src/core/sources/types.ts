/*
 * Source definitions describe a source's events. They don't wrap services' APIs, apart from registering the webhook
 * at setup. Built-in and custom sources both use these types (`defineSource` comes with the config file).
 *
 * A source's events are mapped by its `runtime`, which runs in two places: inside Event Gateway, bundled into the
 * transformation on every subscription's connection (src/core/transformation.ts), and in the bridge, for poll mode,
 * `get_event` and `list_events`. So the mapping has one copy, and the runtime must be self-contained (see
 * `SourceRuntime`).
 */

/** A request as the runtime sees it: in Event Gateway's transformation, and read back from Event Gateway's API. */
export interface InboundRequest {
  /** Lower-cased header names. */
  headers: Record<string, string>;
  /** The parsed JSON body. */
  body: unknown;
  /** When Event Gateway received the request (ISO 8601). Set for requests read back from Event Gateway; unset in a transformation. */
  receivedAt?: string;
}

export type JsonSchema = Record<string, unknown>;

/** How one event is built from a request. Runs inside Event Gateway, so it must throw rather than return bad data. */
export interface EventRuntime<Summary = Record<string, unknown>> {
  matches(req: InboundRequest): boolean;
  /** The service's stable event id: the MCP envelope's eventId and webhook-id. */
  eventId(req: InboundRequest): string;
  /** ISO 8601 time the event happened. */
  occurredAt(req: InboundRequest): string;
  /** The envelope's `data`: triage fields only, well under 256 KiB, plus normalized fields for filtering. */
  summarize(req: InboundRequest): Summary;
}

/**
 * The code that maps a source's requests to events, keyed by event `name`. It runs inside Event Gateway's
 * transformation as `(${runtime.toString()})(config)`, so it must be self-contained: no imports, nothing from outside
 * its own body but its one argument, `config`, which must be JSON, and no `async`. Put shared helpers inside it.
 */
export type SourceRuntime<Config = unknown> = (config: Config) => Record<string, EventRuntime>;

/**
 * An Event Gateway filter on an event's `data`: a JSON object whose keys are `data` fields, matching equal values,
 * arrays that contain every listed item, and `$or` (a list of such objects) at the top level. The bridge applies the
 * same filter itself for poll mode (src/core/filter.ts).
 */
export type DataFilter = Record<string, unknown>;

export interface SourceEvent<Args = Record<string, unknown>> {
  /** The service's own event name, e.g. "email.received" (offered over MCP as `{source id}.{name}`). The runtime's key. */
  name: string;
  description: string;
  /** The service's own event type. */
  providerEvent: string;
  /** JSON Schema for subscribe arguments. */
  inputSchema: JsonSchema;
  /** Validates and normalizes subscribe arguments; throws on invalid input. */
  parseArguments(args: unknown): Args;
  /** The filter for a subscription's (parsed) arguments; `{}` for none. Runs in the bridge, not in Event Gateway. */
  filter(args: Args): DataFilter;
  /** JSON Schema for `data`. */
  payloadSchema: JsonSchema;
}

export interface RegisterContext<Options> {
  sourceUrl: string;
  providerEvents: string[];
  options: Options;
  fetch: typeof fetch;
  /**
   * The secret already on the source, when an existing registration is being updated. Sources that let the caller
   * choose the secret reuse it, so deliveries in flight still verify.
   */
  signingSecret?: string;
}

export interface SourceDefinition<Options = Record<string, unknown>, Config = any> {
  /** Source type, e.g. "resend". */
  type: string;
  displayName: string;
  /** Event Gateway source type, e.g. "RESEND". */
  sourceType: string;
  /** The header carrying the service's event id, to find an event's request in Event Gateway (e.g. svix-id). */
  eventIdHeader?: string;
  // Each event has its own argument type.
  events: SourceEvent<any>[];
  /** Maps requests to events, in Event Gateway and in the bridge. See `SourceRuntime`. */
  runtime: SourceRuntime<Config>;
  /** The runtime's `config` (JSON). Default: undefined. */
  runtimeConfig?: Config;
  /** MCP event names enabled when the config doesn't list any. Default: all of them. */
  defaultEvents?: string[];
  /**
   * What the webhook is registered on, from the options (for example GitHub repositories). Setup registers again
   * when this or the event list changes.
   */
  registrationTarget?(options: Options): unknown;
  /** A signing secret the config supplies (for example GitHub's manual mode). Setup keeps the source's secret equal to it. */
  configuredSecret?(options: Options): string | undefined;
  /**
   * The Event Gateway source `config` (`auth_type` and `auth`) for a source that verifies requests itself, such as
   * a generic `WEBHOOK` source with HMAC. Setup keeps the source's config equal to it, writing only when it differs.
   * A source with `sourceConfig` doesn't use `register`.
   */
  sourceConfig?(options: Options): Record<string, unknown>;
  /**
   * Credentials that aren't set yet, named as the user sets them (for example an environment variable). While any
   * are missing, setup creates the source (so its URL can be registered with the sender) and `serve` refuses to start:
   * without them, Event Gateway would accept unverified requests.
   */
  missingCredentials?(options: Options): string[];
  /** What the user still has to do after setup (for example add webhooks by hand), printed by `setup`. */
  setupHint?(ctx: { sourceUrl: string; providerEvents: string[]; options: Options }): string | undefined;
  /**
   * Creates the service-side webhook at the source URL, or updates it. The returned secret goes straight onto the
   * source. When updating, setup unregisters the previous webhook id if the returned one differs.
   */
  register?(ctx: RegisterContext<Options>): Promise<{ webhookId: string; signingSecret: string }>;
  unregister?(ctx: { webhookId: string; sourceUrl: string; options: Options; fetch: typeof fetch }): Promise<void>;
}

/** `Name <addr@example.com>` or `addr@example.com` to `addr@example.com`, lower-cased. For parsing arguments. */
export function normalizeAddress(value: string): string {
  const angle = /<([^<>]+)>\s*$/.exec(value);
  return (angle ? angle[1]! : value).trim().toLowerCase();
}
