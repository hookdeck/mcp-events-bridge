import { z } from 'zod';
import { defineProvider, env, type EnvRef, type ProviderInstance } from '../config.js';
import type { InboundRequest, ProviderDefinition, ProviderEvent } from './types.js';

/*
 * Generic webhooks: any HTTP sender, such as a service you run yourself or a
 * provider without an Event Gateway source type. The source is a WEBHOOK
 * source with verification configured (HMAC, Standard Webhooks, Basic auth or
 * an API key), so Event Gateway rejects unverified requests before they reach
 * the bridge. Everything else is static config: which events the instance
 * offers, how a request maps to one, where its id and time come from, and
 * which top-level fields subscribers can filter on.
 *
 * There's no API to register the webhook with the sender, so setup creates
 * the source and prints its URL (as in GitHub's manual mode). The secret can
 * come later: until it's set, setup holds delivery (no inbound connection)
 * and `serve` refuses to start.
 */

type Credential = string | EnvRef;

/** How Event Gateway verifies each request. All four were verified live (see "Verified facts" in docs/ARCHITECTURE.md). */
export type WebhookVerification =
  | {
      /** An HMAC of the raw body in a header, as most senders sign. */
      type: 'hmac';
      algorithm: 'sha1' | 'sha256' | 'sha512';
      encoding: 'hex' | 'base64' | 'base64url';
      /** The header carrying the signature, e.g. x-signature. */
      header: string;
      secret: Credential;
    }
  | {
      /** Standard Webhooks (webhook-id, webhook-timestamp, webhook-signature); the secret is usually whsec_... */
      type: 'standard-webhooks';
      secret: Credential;
    }
  | { type: 'basic-auth'; username: Credential; password: Credential }
  | {
      /** A shared key in a header. */
      type: 'api-key';
      header: string;
      key: Credential;
    };

/** Where to read a value: a request header, or a dot path into the JSON body (e.g. `data.id`). */
export type ValueSource = { header: string } | { field: string };

export interface WebhookEventOptions {
  /** What the event means, for the agent. */
  description?: string;
  /** The sender's value for this event, read from `eventType`. Default: the event's name (as in `events`). */
  value?: string;
}

export interface WebhookOptions {
  /** Instance id: names the Event Gateway source (`bridge-<id>`) and the inbound route. */
  id: string;
  verification: WebhookVerification;
  /** The instance's event names (offered over MCP as `{id}.{name}`), or names with a description and the sender's value for each. */
  events: string[] | Record<string, WebhookEventOptions>;
  /** Where the sender says which event a request is. Needed with more than one event; without it, every request is the one event. */
  eventType?: ValueSource;
  /** The sender's stable id for a delivery, for `webhook-id` and dedupe. Default: Event Gateway's request id. */
  eventId?: ValueSource;
  /** When it happened: a body field holding an ISO 8601 time or a Unix time (seconds or milliseconds). Default: when the bridge received it. */
  occurredAt?: { field: string };
  /** Pass only these top-level body fields to subscribers. Default: the whole JSON body. */
  fields?: string[];
  /** Top-level body fields subscribers can filter on, by exact match (e.g. symbol, side). */
  filters?: string[];
}

/** What the definition sees at runtime: credentials resolved (null while not set). */
interface ResolvedWebhookOptions extends Record<string, unknown> {
  verification: Record<string, string | null>;
}

const EVENT_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/;
const HEADER = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
const PATH = /^[A-Za-z0-9_$-]+(\.[A-Za-z0-9_$-]+)*$/;
const FIELD = /^[A-Za-z0-9_$-]+$/;
/** Headers Event Gateway adds on delivery: the request's id, and whether the source verified it (it overwrites a sender's value). */
const REQUEST_ID_HEADER = 'x-hookdeck-requestid';
const VERIFIED_HEADER = 'x-hookdeck-verified';

const isEnvRef = (value: unknown): value is EnvRef => typeof value === 'object' && value !== null && (value as EnvRef).kind === 'env';
const credential = z.union([z.string().min(1), z.custom<EnvRef>(isEnvRef, 'expected a string or env()')]);
const header = z.string().regex(HEADER, 'must be a header name').transform((h) => h.toLowerCase());
const valueSource = z.union([z.object({ header }).strict(), z.object({ field: z.string().regex(PATH, 'must be a dot path, e.g. data.id') }).strict()]);

const optionsSchema = z
  .object({
    id: z.string().min(1),
    verification: z.discriminatedUnion('type', [
      z.object({ type: z.literal('hmac'), algorithm: z.enum(['sha1', 'sha256', 'sha512']), encoding: z.enum(['hex', 'base64', 'base64url']), header, secret: credential }).strict(),
      z.object({ type: z.literal('standard-webhooks'), secret: credential }).strict(),
      z.object({ type: z.literal('basic-auth'), username: credential, password: credential }).strict(),
      z.object({ type: z.literal('api-key'), header, key: credential }).strict(),
    ]),
    events: z.union([
      z.array(z.string()).min(1),
      z.record(z.string(), z.object({ description: z.string().min(1).optional(), value: z.string().min(1).optional() }).strict()),
    ]),
    eventType: valueSource.optional(),
    eventId: valueSource.optional(),
    occurredAt: z.object({ field: z.string().regex(PATH) }).strict().optional(),
    fields: z.array(z.string().regex(FIELD, 'must be a top-level field name')).min(1).optional(),
    filters: z.array(z.string().regex(FIELD, 'must be a top-level field name')).optional(),
  })
  .strict();

type ParsedOptions = z.infer<typeof optionsSchema>;

/** The credential fields of each verification type, and what they map to in Event Gateway's source config. */
function toSourceConfig(v: Record<string, string | null>): Record<string, unknown> {
  switch (v.type) {
    case 'hmac':
      return { auth_type: 'HMAC', auth: { algorithm: v.algorithm, encoding: v.encoding, header_key: v.header, webhook_secret_key: v.secret } };
    case 'standard-webhooks':
      return { auth_type: 'STANDARD_WEBHOOKS', auth: { webhook_secret_key: v.secret } };
    case 'basic-auth':
      return { auth_type: 'BASIC_AUTH', auth: { username: v.username, password: v.password } };
    case 'api-key':
      return { auth_type: 'API_KEY', auth: { header_key: v.header, api_key: v.key } };
    default:
      throw new Error(`webhook: unknown verification type ${String(v.type)}`);
  }
}

const CREDENTIAL_FIELDS: Record<WebhookVerification['type'], string[]> = {
  hmac: ['secret'],
  'standard-webhooks': ['secret'],
  'basic-auth': ['username', 'password'],
  'api-key': ['key'],
};

/** A value at a dot path in a JSON body. */
export function readPath(body: unknown, path: string): unknown {
  let value = body;
  for (const key of path.split('.')) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

const read = (req: InboundRequest, source: ValueSource) => ('header' in source ? req.headers[source.header] : readPath(req.body, source.field));
const isScalar = (value: unknown): value is string | number | boolean => ['string', 'number', 'boolean'].includes(typeof value);
const describe = (source: ValueSource) => ('header' in source ? `the ${source.header} header` : `the body field ${source.field}`);

/** ISO 8601, or a Unix time in seconds or milliseconds. Undefined if it isn't one. */
function toIso(value: unknown): string | undefined {
  const ms = typeof value === 'number' ? (value < 1e11 ? value * 1000 : value) : typeof value === 'string' && value.trim() ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

function buildDefinition(o: ParsedOptions, envNames: Record<string, string>): ProviderDefinition<ResolvedWebhookOptions> {
  const entries: Array<[string, WebhookEventOptions]> = Array.isArray(o.events) ? o.events.map((name) => [name, {}]) : Object.entries(o.events);
  const filters = o.filters ?? [];
  const fieldList = o.fields?.length ? `the body fields ${o.fields.join(', ')}` : 'the JSON body as sent';
  const filterNote = filters.length ? ` Filter by ${filters.join(', ')} (exact match).` : '';

  const argumentsSchema = z
    .object(Object.fromEntries(filters.map((f) => [f, z.union([z.string(), z.number(), z.boolean()]).describe(`Only events whose ${f} equals this value.`).optional()])))
    .strict();
  const payloadSchema = {
    type: 'object',
    description: `Data is ${fieldList}.`,
    ...(o.fields?.length && { properties: Object.fromEntries(o.fields.map((f) => [f, {}])) }),
  };

  const summarize = (req: InboundRequest): Record<string, unknown> => {
    const body = req.body;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return { body };
    if (!o.fields?.length) return body as Record<string, unknown>;
    return Object.fromEntries(o.fields.filter((f) => f in body).map((f) => [f, (body as Record<string, unknown>)[f]]));
  };

  const events: ProviderEvent<Record<string, string | number | boolean>, Record<string, unknown>>[] = entries.map(([name, event]) => {
    const value = event.value ?? name;
    return {
      name,
      description: `${event.description ?? `"${name}" from the ${o.id} webhook.`} Data is ${fieldList}.${filterNote}`,
      providerEvent: value,
      // Only requests Event Gateway verified. It sets this header on delivery and overwrites any value the sender
      // sent (verified live), so a request that got past an unverified source (before the secret was set, or while
      // a new secret reaches the edge) or was retried by hand from that time is never relayed.
      matches: (req) => req.headers[VERIFIED_HEADER] === 'true' && (!o.eventType || String(read(req, o.eventType) ?? '') === value),
      eventId: (req) => {
        const id = o.eventId ? read(req, o.eventId) : req.headers[REQUEST_ID_HEADER];
        if (!isScalar(id) || String(id) === '') {
          throw new Error(`${o.id}: no event id in ${o.eventId ? describe(o.eventId) : `the ${REQUEST_ID_HEADER} header`}`);
        }
        return String(id);
      },
      occurredAt: (req) => (o.occurredAt && toIso(readPath(req.body, o.occurredAt.field))) || req.receivedAt || new Date().toISOString(),
      summarize,
      inputSchema: z.toJSONSchema(argumentsSchema) as Record<string, unknown>,
      parseArguments: (args) => {
        const parsed = argumentsSchema.parse(args ?? {}) as Record<string, string | number | boolean | undefined>;
        return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined));
      },
      // String comparison, so an agent's "100" matches a sender's 100.
      accepts: (args, summary) => Object.entries(args).every(([key, want]) => isScalar(summary[key]) && String(summary[key]) === String(want)),
      payloadSchema,
    };
  });

  const missing = (options: ResolvedWebhookOptions) =>
    CREDENTIAL_FIELDS[options.verification.type as WebhookVerification['type']]
      .filter((field) => !options.verification[field])
      .map((field) => envNames[field] ?? `verification.${field}`);

  return {
    type: 'webhook',
    displayName: `webhook ${o.id}`,
    sourceType: 'WEBHOOK',
    ...(o.eventId && { inboundDedupeFields: ['header' in o.eventId ? `headers.${o.eventId.header}` : `body.${o.eventId.field}`] }),
    ...(o.eventId && 'header' in o.eventId && { eventIdHeader: o.eventId.header }),
    events,
    missingCredentials: missing,
    sourceConfig: (options) => {
      const absent = missing(options);
      if (absent.length) throw new Error(`${o.id}: set ${absent.join(', ')} first`);
      return toSourceConfig(options.verification);
    },
    setupHint: ({ sourceUrl, options }) => {
      const absent = missing(options);
      const v = options.verification;
      const credentials = CREDENTIAL_FIELDS[v.type as WebhookVerification['type']].map((field) => envNames[field] ?? `verification.${field}`).join(' and ');
      const how: Record<string, string> = {
        hmac: `an HMAC-${String(v.algorithm).toUpperCase()} of the raw body, ${v.encoding}-encoded, in the ${v.header} header, keyed with ${credentials}`,
        'standard-webhooks': `Standard Webhooks signatures with ${credentials}`,
        'basic-auth': `Basic auth with ${credentials}`,
        'api-key': `the key in ${credentials}, in the ${v.header} header`,
      };
      return [
        absent.length
          ? `Waiting for ${absent.join(', ')}: delivery is held (no inbound connection) until it's set. Register this URL with the sender, put the secret in the environment, and run setup again:`
          : 'Configure the sender to POST JSON to:',
        `  ${sourceUrl}`,
        `  Verification: ${how[String(v.type)]}`,
        ...(o.eventType ? [`  Event type in ${describe(o.eventType)}: ${entries.map(([name, e]) => `${e.value ?? name} -> ${name}`).join(', ')}`] : []),
        ...(o.eventId ? [`  Event id in ${describe(o.eventId)}`] : []),
      ].join('\n');
    },
  };
}

/**
 * A generic webhook instance for bridge.config.ts:
 *
 *   webhook({
 *     id: 'fills',
 *     verification: { type: 'hmac', algorithm: 'sha256', encoding: 'hex', header: 'x-signature', secret: env('FILLS_WEBHOOK_SECRET') },
 *     events: { 'order.filled': { description: 'An order on my trading server filled.' } },
 *     eventId: { header: 'x-delivery-id' },
 *     filters: ['symbol', 'side'],
 *   })
 */
export function webhook(options: WebhookOptions): ProviderInstance {
  const result = optionsSchema.safeParse(options);
  if (!result.success) throw new Error(`webhook${options?.id ? ` ${options.id}` : ''}: ${z.prettifyError(result.error)}`);
  const o = result.data;
  const names = Array.isArray(o.events) ? o.events : Object.keys(o.events);
  const bad = names.find((name) => !EVENT_NAME.test(name));
  if (bad !== undefined) throw new Error(`webhook ${o.id}: event name "${bad}" must be letters, digits, ., _, : and - (at most 100)`);
  if (new Set(names).size !== names.length) throw new Error(`webhook ${o.id}: duplicate event names`);
  if (names.length > 1 && !o.eventType) throw new Error(`webhook ${o.id}: with more than one event, set eventType (a header or body field naming the event)`);
  if (!Array.isArray(o.events)) {
    const values = Object.entries(o.events).map(([name, e]) => e.value ?? name);
    if (new Set(values).size !== values.length) throw new Error(`webhook ${o.id}: two events have the same value`);
  }
  const unlisted = (o.filters ?? []).filter((f) => o.fields && !o.fields.includes(f));
  if (unlisted.length) throw new Error(`webhook ${o.id}: filters must be among fields: ${unlisted.join(', ')}`);

  // Credentials may come later (the URL usually has to be registered with the sender first), so their env()
  // references are made optional here: setup holds delivery and serve refuses to start until they're set.
  const envNames: Record<string, string> = {};
  const verification = Object.fromEntries(
    Object.entries(o.verification).map(([key, value]) => {
      if (!isEnvRef(value)) return [key, value];
      envNames[key] = value.name;
      return [key, env(value.name, { optional: true })];
    }),
  );
  return defineProvider(buildDefinition(o, envNames))({ id: o.id, events: names, verification } as never);
}
