import { z } from 'zod';
import { defineSource, env, type EnvRef, type SourceInstance } from '../config.js';
import { SOURCE_TYPES, type SourceTypeCredentials, type SourceTypeName } from './source-types.generated.js';
import type { EventRuntime, InboundRequest, SourceDefinition, SourceEvent } from './types.js';

/*
 * Sources you register with the sender yourself: `source({ type, ... })`.
 *
 * The type is an Event Gateway source type, so Event Gateway verifies each
 * request before it reaches the bridge: `stripe`, `slack`, `shopify` and the
 * other service types verify that service's signatures with the credentials
 * given here, and `webhook` is a generic source for any HTTP sender, verified
 * as `verification` says (HMAC, Standard Webhooks, Basic auth or an API key).
 * Everything else is static config: which events the source offers, how a
 * request maps to one, where its id and time come from, and which top-level
 * fields subscribers can filter on.
 *
 * There's no API call to register the webhook with the sender, so setup
 * creates the source and prints its URL. The credentials can come later:
 * until they're set, setup holds delivery (no inbound connection) and `serve`
 * refuses to start.
 */

type Credential = string | EnvRef;

/** How Event Gateway verifies each request to a `webhook` source. All four were verified live (see "Verified facts" in docs/ARCHITECTURE.md). */
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

export interface SourceEventOptions {
  /** What the event means, for the agent. */
  description?: string;
  /** The sender's value for this event, read from `eventType`. Default: the event's name (as in `events`). */
  value?: string;
}

/** What every source takes, whatever its type. */
export interface SourceCommonOptions {
  /** Instance id: names the Event Gateway source (`bridge-<id>`), the inbound route, and the events (`{id}.{event}`). Default: the type. */
  id?: string;
  /** The source's event names (offered over MCP as `{id}.{name}`), or names with a description and the sender's value for each. */
  events: string[] | Record<string, SourceEventOptions>;
  /** Where the sender says which event a request is. Needed with more than one event; without it, every request is the one event. */
  eventType?: ValueSource;
  /** The sender's stable id for an event, for the eventId and dedupe. Default: Event Gateway's request id. */
  eventId?: ValueSource;
  /** When it happened: a body field holding an ISO 8601 time or a Unix time (seconds or milliseconds). Default: when the bridge received it. */
  occurredAt?: { field: string };
  /** Pass only these top-level body fields to subscribers. Default: the whole JSON body. */
  fields?: string[];
  /** Top-level body fields subscribers can filter on, by exact match (e.g. symbol, side). */
  filters?: string[];
}

/** A generic source for any HTTP sender. */
export type WebhookSourceOptions = SourceCommonOptions & { type: 'webhook'; verification: WebhookVerification };

/** A source of one of Event Gateway's source types, with that type's credentials (for most, `secret`). */
export type TypedSourceOptions = { [T in SourceTypeName]: SourceCommonOptions & { type: T } & SourceTypeCredentials[T] }[SourceTypeName];

export type SourceOptions = WebhookSourceOptions | TypedSourceOptions;

/** @deprecated Renamed to `SourceEventOptions`. */
export type WebhookEventOptions = SourceEventOptions;

/** What the definition sees at runtime: credentials resolved (null while not set). */
interface ResolvedSourceOptions extends Record<string, unknown> {
  credentials: Record<string, string | null>;
}

const EVENT_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/;
const HEADER = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
const PATH = /^[A-Za-z0-9_$-]+(\.[A-Za-z0-9_$-]+)*$/;
const FIELD = /^[A-Za-z0-9_$-]+$/;
/** Headers Event Gateway adds on delivery: the request's id, and whether the source verified it (it overwrites a sender's value). */

const isEnvRef = (value: unknown): value is EnvRef => typeof value === 'object' && value !== null && (value as EnvRef).kind === 'env';
const credential = z.union([z.string().min(1), z.custom<EnvRef>(isEnvRef, 'expected a string or env()')]);
const header = z.string().regex(HEADER, 'must be a header name').transform((h) => h.toLowerCase());
const valueSource = z.union([z.object({ header }).strict(), z.object({ field: z.string().regex(PATH, 'must be a dot path, e.g. data.id') }).strict()]);

const commonShape = {
  id: z.string().min(1).optional(),
  events: z.union([
    z.array(z.string()).min(1),
    z.record(z.string(), z.object({ description: z.string().min(1).optional(), value: z.string().min(1).optional() }).strict()),
  ]),
  eventType: valueSource.optional(),
  eventId: valueSource.optional(),
  occurredAt: z.object({ field: z.string().regex(PATH) }).strict().optional(),
  fields: z.array(z.string().regex(FIELD, 'must be a top-level field name')).min(1).optional(),
  filters: z.array(z.string().regex(FIELD, 'must be a top-level field name')).optional(),
};

const verificationSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hmac'), algorithm: z.enum(['sha1', 'sha256', 'sha512']), encoding: z.enum(['hex', 'base64', 'base64url']), header, secret: credential }).strict(),
  z.object({ type: z.literal('standard-webhooks'), secret: credential }).strict(),
  z.object({ type: z.literal('basic-auth'), username: credential, password: credential }).strict(),
  z.object({ type: z.literal('api-key'), header, key: credential }).strict(),
]);

const webhookSchema = z.object({ type: z.literal('webhook'), verification: verificationSchema, ...commonShape }).strict();

/** The schema for one Event Gateway source type: the common options plus that type's credential options. */
const typedSchema = (type: SourceTypeName) =>
  z
    .object({
      type: z.literal(type),
      ...commonShape,
      ...Object.fromEntries(Object.entries(SOURCE_TYPES[type].auth).map(([option, { required }]) => [option, required ? credential : credential.optional()])),
    })
    .strict();

type ParsedCommon = z.infer<z.ZodObject<typeof commonShape>> & { id: string };

/** How a source verifies requests: its Event Gateway type and config, and its credentials. */
interface Verification {
  sourceType: string;
  /** Credential option names, and whether each is required. */
  credentials: Record<string, boolean>;
  /** The Event Gateway source config, from resolved credentials. */
  sourceConfig(credentials: Record<string, string | null>): Record<string, unknown>;
  /** How the sender has to sign, for the setup hint. */
  describe(credentials: Record<string, string | null>, envNames: (option: string) => string): string;
}

/** The credential fields of each verification type, and what they map to in Event Gateway's source config. */
function webhookVerification(v: z.infer<typeof verificationSchema>): Verification {
  const fields: Record<WebhookVerification['type'], string[]> = {
    hmac: ['secret'],
    'standard-webhooks': ['secret'],
    'basic-auth': ['username', 'password'],
    'api-key': ['key'],
  };
  return {
    sourceType: 'WEBHOOK',
    credentials: Object.fromEntries(fields[v.type].map((f) => [f, true])),
    sourceConfig: (c) => {
      switch (v.type) {
        case 'hmac':
          return { auth_type: 'HMAC', auth: { algorithm: v.algorithm, encoding: v.encoding, header_key: v.header, webhook_secret_key: c.secret } };
        case 'standard-webhooks':
          return { auth_type: 'STANDARD_WEBHOOKS', auth: { webhook_secret_key: c.secret } };
        case 'basic-auth':
          return { auth_type: 'BASIC_AUTH', auth: { username: c.username, password: c.password } };
        case 'api-key':
          return { auth_type: 'API_KEY', auth: { header_key: v.header, api_key: c.key } };
      }
    },
    describe: (_, name) => {
      const credentials = fields[v.type].map(name).join(' and ');
      switch (v.type) {
        case 'hmac':
          return `an HMAC-${v.algorithm.toUpperCase()} of the raw body, ${v.encoding}-encoded, in the ${v.header} header, keyed with ${credentials}`;
        case 'standard-webhooks':
          return `Standard Webhooks signatures with ${credentials}`;
        case 'basic-auth':
          return `Basic auth with ${credentials}`;
        case 'api-key':
          return `the key in ${credentials}, in the ${v.header} header`;
      }
    },
  };
}

/** An Event Gateway source type: the service's own signatures, checked with the credentials given. */
function typedVerification(type: SourceTypeName): Verification {
  const { sourceType, auth } = SOURCE_TYPES[type];
  return {
    sourceType,
    credentials: Object.fromEntries(Object.entries(auth).map(([option, { required }]) => [option, required])),
    sourceConfig: (c) => ({
      auth: Object.fromEntries(Object.entries(auth).flatMap(([option, { field }]) => (c[option] ? [[field, c[option]]] : []))),
    }),
    describe: (_, name) => `Event Gateway verifies ${type}'s requests (its signature or credentials) with ${Object.keys(auth).map(name).join(' and ')}`,
  };
}

/** A value at a dot path in a JSON body. */
export function readPath(body: unknown, path: string): unknown {
  let value = body;
  for (const key of path.split('.')) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

const describe = (source: ValueSource) => ('header' in source ? `the ${source.header} header` : `the body field ${source.field}`);

/** The runtime's config: everything it needs from a `source()` call, as JSON. */
export interface SourceRuntimeConfig {
  id: string;
  /** Each event's name and the value of `eventType` that selects it. */
  events: Array<{ name: string; value: string }>;
  eventType?: ValueSource;
  eventId?: ValueSource;
  occurredAt?: { field: string };
  fields?: string[];
}

/**
 * The runtime for `source()`: self-contained, since it also runs inside Event Gateway (see SourceRuntime). Without an
 * `eventId`, an event's id is a SHA-256 of its body (canonical JSON), so a sender resending the same body is deduped.
 */
export function sourceRuntime(config: SourceRuntimeConfig): Record<string, EventRuntime> {
  const readPath = (body: unknown, path: string): unknown => {
    let value = body;
    for (const key of path.split('.')) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
      value = (value as Record<string, unknown>)[key];
    }
    return value;
  };
  const read = (req: InboundRequest, source: ValueSource) => ('header' in source ? req.headers[source.header] : readPath(req.body, source.field));
  const isScalar = (value: unknown): value is string | number | boolean => ['string', 'number', 'boolean'].includes(typeof value);
  const describe = (source: ValueSource) => ('header' in source ? `the ${source.header} header` : `the body field ${source.field}`);
  // ISO 8601, or a Unix time in seconds or milliseconds. Undefined if it isn't one.
  const toIso = (value: unknown): string | undefined => {
    const ms = typeof value === 'number' ? (value < 1e11 ? value * 1000 : value) : typeof value === 'string' && value.trim() ? Date.parse(value) : NaN;
    return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
  };
  const canonical = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (typeof value === 'object' && value !== null) {
      const entries = Object.keys(value as Record<string, unknown>).sort().map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`);
      return `{${entries.join(',')}}`;
    }
    return JSON.stringify(value) ?? 'null';
  };
  // SHA-256, hex, synchronous (Event Gateway's transformations have no synchronous hash).
  const sha256 = (text: string): string => {
    const K = [
      0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be,
      0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa,
      0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85,
      0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
      0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f,
      0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    ];
    const H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    const bytes = new TextEncoder().encode(text);
    const padded = new Uint8Array(((bytes.length + 9 + 63) >> 6) << 6);
    padded.set(bytes);
    padded[bytes.length] = 0x80;
    const view = new DataView(padded.buffer);
    view.setUint32(padded.length - 8, Math.floor((bytes.length * 8) / 0x100000000));
    view.setUint32(padded.length - 4, (bytes.length * 8) >>> 0);
    const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
    const w = new Uint32Array(64);
    for (let i = 0; i < padded.length; i += 64) {
      for (let t = 0; t < 16; t++) w[t] = view.getUint32(i + t * 4);
      for (let t = 16; t < 64; t++) {
        const s0 = rotr(w[t - 15]!, 7) ^ rotr(w[t - 15]!, 18) ^ (w[t - 15]! >>> 3);
        const s1 = rotr(w[t - 2]!, 17) ^ rotr(w[t - 2]!, 19) ^ (w[t - 2]! >>> 10);
        w[t] = (w[t - 16]! + s0 + w[t - 7]! + s1) >>> 0;
      }
      let [a, b, c, d, e, f, g, h] = H as [number, number, number, number, number, number, number, number];
      for (let t = 0; t < 64; t++) {
        const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[t]! + w[t]!) >>> 0;
        const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
        h = g;
        g = f;
        f = e;
        e = (d + t1) >>> 0;
        d = c;
        c = b;
        b = a;
        a = (t1 + t2) >>> 0;
      }
      H[0] = (H[0]! + a) >>> 0;
      H[1] = (H[1]! + b) >>> 0;
      H[2] = (H[2]! + c) >>> 0;
      H[3] = (H[3]! + d) >>> 0;
      H[4] = (H[4]! + e) >>> 0;
      H[5] = (H[5]! + f) >>> 0;
      H[6] = (H[6]! + g) >>> 0;
      H[7] = (H[7]! + h) >>> 0;
    }
    return H.map((x) => x.toString(16).padStart(8, '0')).join('');
  };
  const summarize = (req: InboundRequest): Record<string, unknown> => {
    const body = req.body;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return { body };
    if (!config.fields?.length) return body as Record<string, unknown>;
    return Object.fromEntries(config.fields.filter((f) => f in body).map((f) => [f, (body as Record<string, unknown>)[f]]));
  };

  const runtimes: Record<string, EventRuntime> = {};
  for (const event of config.events) {
    runtimes[event.name] = {
      matches: (req) => !config.eventType || String(read(req, config.eventType) ?? '') === event.value,
      eventId: (req) => {
        if (!config.eventId) return sha256(canonical(req.body)).slice(0, 32);
        const id = read(req, config.eventId);
        if (!isScalar(id) || String(id) === '') throw new Error(`${config.id}: no event id in ${describe(config.eventId)}`);
        return String(id);
      },
      occurredAt: (req) => (config.occurredAt && toIso(readPath(req.body, config.occurredAt.field))) || req.receivedAt || new Date().toISOString(),
      summarize,
    };
  }
  return runtimes;
}

function buildDefinition(type: string, o: ParsedCommon, verification: Verification, envNames: Record<string, string>): SourceDefinition<ResolvedSourceOptions, SourceRuntimeConfig> {
  const entries: Array<[string, SourceEventOptions]> = Array.isArray(o.events) ? o.events.map((name) => [name, {}]) : Object.entries(o.events);
  const filters = o.filters ?? [];
  const fieldList = o.fields?.length ? `the body fields ${o.fields.join(', ')}` : 'the JSON body as sent';
  const filterNote = filters.length ? ` Filter by ${filters.join(', ')} (exact match).` : '';
  const envName = (option: string) => envNames[option] ?? option;

  const argumentsSchema = z
    .object(Object.fromEntries(filters.map((f) => [f, z.union([z.string(), z.number(), z.boolean()]).describe(`Only events whose ${f} equals this value.`).optional()])))
    .strict();
  const payloadSchema = {
    type: 'object',
    description: `Data is ${fieldList}.`,
    ...(o.fields?.length && { properties: Object.fromEntries(o.fields.map((f) => [f, {}])) }),
  };

  const events: SourceEvent<Record<string, string | number | boolean>>[] = entries.map(([name, event]) => ({
    name,
    description: `${event.description ?? `"${name}" from the ${o.id} source.`} Data is ${fieldList}.${filterNote}`,
    providerEvent: event.value ?? name,
    inputSchema: z.toJSONSchema(argumentsSchema) as Record<string, unknown>,
    parseArguments: (args) => {
      const parsed = argumentsSchema.parse(args ?? {}) as Record<string, string | number | boolean | undefined>;
      return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined));
    },
    // Exact match, type included: Event Gateway's filters compare strings to strings and numbers to numbers.
    filter: (args) => ({ ...args }),
    payloadSchema,
  }));
  const runtimeConfig: SourceRuntimeConfig = {
    id: o.id,
    events: entries.map(([name, event]) => ({ name, value: event.value ?? name })),
    ...(o.eventType && { eventType: o.eventType }),
    ...(o.eventId && { eventId: o.eventId }),
    ...(o.occurredAt && { occurredAt: o.occurredAt }),
    ...(o.fields?.length && { fields: o.fields }),
  };

  const missing = (options: ResolvedSourceOptions) =>
    Object.entries(verification.credentials)
      .filter(([option, required]) => required && !options.credentials[option])
      .map(([option]) => envName(option));

  return {
    type,
    displayName: `${type} source ${o.id}`,
    sourceType: verification.sourceType,
    ...(o.eventId && 'header' in o.eventId && { eventIdHeader: o.eventId.header }),
    events,
    runtime: sourceRuntime,
    runtimeConfig,
    missingCredentials: missing,
    sourceConfig: (options) => {
      const absent = missing(options);
      if (absent.length) throw new Error(`${o.id}: set ${absent.join(', ')} first`);
      return verification.sourceConfig(options.credentials);
    },
    setupHint: ({ sourceUrl, options }) => {
      const absent = missing(options);
      return [
        absent.length
          ? `Waiting for ${absent.join(', ')}: delivery is held (no inbound connection) until it's set. Register this URL with the sender, put the secret in the environment, and run setup again:`
          : 'Configure the sender to POST JSON to:',
        `  ${sourceUrl}`,
        `  Verification: ${verification.describe(options.credentials, envName)}`,
        ...(o.eventType ? [`  Event type in ${describe(o.eventType)}: ${entries.map(([name, e]) => `${e.value ?? name} -> ${name}`).join(', ')}`] : []),
        ...(o.eventId ? [`  Event id in ${describe(o.eventId)}`] : []),
      ].join('\n');
    },
  };
}

/**
 * A source for bridge.config.ts, typed per source type:
 *
 *   source({
 *     type: 'stripe',
 *     secret: env('STRIPE_WEBHOOK_SECRET'),
 *     events: { 'invoice.paid': { description: 'An invoice was paid.' } },
 *     eventType: { field: 'type' },
 *     eventId: { field: 'id' },
 *     occurredAt: { field: 'created' },
 *   })
 *
 *   source({
 *     id: 'fills',
 *     type: 'webhook',
 *     verification: { type: 'hmac', algorithm: 'sha256', encoding: 'hex', header: 'x-signature', secret: env('FILLS_WEBHOOK_SECRET') },
 *     events: { 'order.filled': { description: 'An order on my trading server filled.' } },
 *     eventId: { header: 'x-delivery-id' },
 *     filters: ['symbol', 'side'],
 *   })
 */
export function source(options: SourceOptions): SourceInstance {
  const label = `source${options?.id ? ` ${options.id}` : options?.type ? ` ${options.type}` : ''}`;
  const type = options?.type;
  if (type !== 'webhook' && !(typeof type === 'string' && Object.hasOwn(SOURCE_TYPES, type))) {
    throw new Error(`${label}: type must be 'webhook' or an Event Gateway source type, such as 'stripe' or 'slack' (got ${JSON.stringify(type)})`);
  }
  const result = (type === 'webhook' ? webhookSchema : typedSchema(type as SourceTypeName)).safeParse(options);
  if (!result.success) throw new Error(`${label}: ${z.prettifyError(result.error)}`);
  const parsed = result.data as ParsedCommon & Record<string, unknown>;
  const o: ParsedCommon = { ...parsed, id: parsed.id ?? type };
  const names = Array.isArray(o.events) ? o.events : Object.keys(o.events);
  const bad = names.find((name) => !EVENT_NAME.test(name));
  if (bad !== undefined) throw new Error(`source ${o.id}: event name "${bad}" must be letters, digits, ., _, : and - (at most 100)`);
  if (new Set(names).size !== names.length) throw new Error(`source ${o.id}: duplicate event names`);
  if (names.length > 1 && !o.eventType) throw new Error(`source ${o.id}: with more than one event, set eventType (a header or body field naming the event)`);
  if (!Array.isArray(o.events)) {
    const values = Object.entries(o.events).map(([name, e]) => e.value ?? name);
    if (new Set(values).size !== values.length) throw new Error(`source ${o.id}: two events have the same value`);
  }
  const unlisted = (o.filters ?? []).filter((f) => o.fields && !o.fields.includes(f));
  if (unlisted.length) throw new Error(`source ${o.id}: filters must be among fields: ${unlisted.join(', ')}`);

  const verification = type === 'webhook' ? webhookVerification(parsed.verification as z.infer<typeof verificationSchema>) : typedVerification(type as SourceTypeName);
  const given: Record<string, unknown> = type === 'webhook' ? (parsed.verification as Record<string, unknown>) : parsed;
  // Credentials may come later (the URL usually has to be registered with the sender first), so their env()
  // references are made optional here: setup holds delivery and serve refuses to start until they're set.
  const envNames: Record<string, string> = {};
  const credentials = Object.fromEntries(
    Object.keys(verification.credentials).flatMap((option) => {
      const value = given[option];
      if (value === undefined) return [];
      if (!isEnvRef(value)) return [[option, value]];
      envNames[option] = value.name;
      return [[option, env(value.name, { optional: true })]];
    }),
  );
  return defineSource(buildDefinition(type, o, verification, envNames))({ id: o.id, events: names, credentials } as never);
}

