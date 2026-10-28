import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { matchesFilter } from '../../../src/core/filter.js';
import { assertCredentials, ConfigError, defineConfig, env, resolveConfig } from '../../../src/core/config.js';
import { readPath, type SourceOptions, type WebhookSourceOptions } from '../../../src/core/sources/source.js';
import type { InboundRequest, SourceDefinition } from '../../../src/core/sources/types.js';
import { source } from '../../../src/sources.js';

type WebhookOptions = WebhookSourceOptions;

const base = { HOOKDECK_API_KEY: 'hk', HOOKDECK_SIGNING_SECRET: 'hs' };
const SECRET = 'fills-secret-0123456789';

const fills: WebhookOptions = {
  id: 'fills',
  type: 'webhook',
  verification: { type: 'hmac', algorithm: 'sha256', encoding: 'hex', header: 'X-Signature', secret: env('FILLS_WEBHOOK_SECRET') },
  events: { 'order.filled': { description: 'An order on my trading server filled.' } },
  eventId: { header: 'X-Delivery-Id' },
  occurredAt: { field: 'filled_at' },
  filters: ['symbol', 'side'],
};

const resolved = (options: WebhookOptions = fills, environment: Record<string, string> = { FILLS_WEBHOOK_SECRET: SECRET }) =>
  resolveConfig(defineConfig({ deployment: 'dev', sources: [source(options)] }), { ...base, ...environment }).sources[0]!;

// An event as the bridge and its transformation use it: the metadata, the runtime's mapping and the filter.
const eventOf = (definition: SourceDefinition, name: string) => {
  const meta = definition.events.find((e) => e.name === name)!;
  const runtime = definition.runtime(definition.runtimeConfig)[name]!;
  return { ...meta, ...runtime, accepts: (args: Record<string, unknown>, summary: unknown) => matchesFilter(meta.filter(args), summary) };
};
const canonical = (value: unknown): string =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(',')}]`
    : typeof value === 'object' && value !== null
      ? `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`
      : JSON.stringify(value);

const fill = { id: 'fill_1', symbol: 'AAPL', side: 'buy', quantity: 100, price: 187.5, filled_at: '2026-10-07T14:30:00.123Z' };
const request = (body: unknown = fill, headers: Record<string, string> = {}): InboundRequest => ({
  headers: { 'x-hookdeck-verified': 'true', 'x-hookdeck-requestid': 'req_123', 'x-delivery-id': 'dlv_1', ...headers },
  body,
});

describe('webhook source: config', () => {
  it('creates an instance with the given id and events, and a WEBHOOK source with HMAC verification', () => {
    const provider = resolved();
    expect(provider).toMatchObject({ id: 'fills', events: ['order.filled'] });
    expect(provider.definition).toMatchObject({ type: 'webhook', sourceType: 'WEBHOOK', eventIdHeader: 'x-delivery-id' });
    expect(provider.definition.sourceConfig!(provider.options)).toEqual({
      auth_type: 'HMAC',
      auth: { algorithm: 'sha256', encoding: 'hex', header_key: 'x-signature', webhook_secret_key: SECRET },
    });
  });

  it('maps each verification type to Event Gateway source config', () => {
    const config = (verification: WebhookOptions['verification'], environment: Record<string, string>) => {
      const p = resolved({ ...fills, verification }, environment);
      return p.definition.sourceConfig!(p.options);
    };
    expect(config({ type: 'standard-webhooks', secret: env('SW') }, { SW: 'whsec_abc' })).toEqual({ auth_type: 'STANDARD_WEBHOOKS', auth: { webhook_secret_key: 'whsec_abc' } });
    expect(config({ type: 'basic-auth', username: 'bridge', password: env('PW') }, { PW: 'pw' })).toEqual({ auth_type: 'BASIC_AUTH', auth: { username: 'bridge', password: 'pw' } });
    expect(config({ type: 'api-key', header: 'X-Api-Key', key: env('KEY') }, { KEY: 'k' })).toEqual({ auth_type: 'API_KEY', auth: { header_key: 'x-api-key', api_key: 'k' } });
  });

  it('rejects invalid verification and mapping config', () => {
    const bad = (over: Partial<WebhookOptions>) => () => source({ ...fills, ...over } as WebhookOptions);
    expect(bad({ verification: { type: 'hmac', algorithm: 'md5', encoding: 'hex', header: 'x-sig', secret: 's' } as never })).toThrow(/algorithm/);
    expect(bad({ verification: { type: 'hmac', algorithm: 'sha256', encoding: 'hex', secret: 's' } as never })).toThrow(/header/);
    expect(bad({ verification: { type: 'none' } as never })).toThrow(/source fills/);
    expect(bad({ verification: undefined as never })).toThrow(/verification/);
    expect(bad({ events: [] })).toThrow(/events/);
    expect(bad({ events: ['bad name'] })).toThrow(/event name/);
    expect(bad({ events: ['order.filled', 'order.canceled'] })).toThrow(/eventType/);
    expect(bad({ eventType: { field: 'type' }, events: { a: { value: 'x' }, b: { value: 'x' } } })).toThrow(/same value/);
    expect(bad({ fields: ['symbol'], filters: ['symbol', 'side'] })).toThrow(/filters must be among fields: side/);
    expect(bad({ eventId: { field: 'a..b' } })).toThrow(/dot path/);
  });

  it('holds while a credential is missing: setup leaves the source unconnected and serve fails closed, naming the variable', () => {
    const provider = resolved(fills, {});
    expect(provider.options.credentials).toMatchObject({ secret: null });
    expect(provider.definition.missingCredentials!(provider.options)).toEqual(['FILLS_WEBHOOK_SECRET']);
    expect(() => provider.definition.sourceConfig!(provider.options)).toThrow(/FILLS_WEBHOOK_SECRET/);
    const config = resolveConfig(defineConfig({ deployment: 'dev', sources: [source(fills)] }), base);
    expect(() => assertCredentials(config)).toThrow(ConfigError);
    expect(() => assertCredentials(config)).toThrow(/FILLS_WEBHOOK_SECRET \(source fills\)/);
    expect(() => assertCredentials(resolveConfig(defineConfig({ deployment: 'dev', sources: [source(fills)] }), { ...base, FILLS_WEBHOOK_SECRET: SECRET }))).not.toThrow();
  });
});

describe('webhook source: mapping', () => {
  const event = (options: WebhookOptions = fills, name = 'order.filled') => eventOf(resolved(options).definition, name);

  it("doesn't depend on Event Gateway's delivery headers: a request that fails verification never reaches the runtime", () => {
    expect(event().matches(request())).toBe(true);
    const { 'x-hookdeck-verified': _, 'x-hookdeck-requestid': __, ...plain } = request().headers;
    expect(event().matches({ headers: plain, body: fill })).toBe(true);
  });

  it('picks the event by a body field or header, with a value-to-name map', () => {
    const byField: WebhookOptions = { ...fills, eventType: { field: 'type' }, events: { 'order.filled': { value: 'fill' }, 'order.canceled': { value: 'cancel' } } };
    expect(event(byField).matches(request({ ...fill, type: 'fill' }))).toBe(true);
    expect(event(byField, 'order.canceled').matches(request({ ...fill, type: 'fill' }))).toBe(false);
    expect(event(byField, 'order.canceled').matches(request({ type: 'cancel' }))).toBe(true);
    const byHeader: WebhookOptions = { ...fills, eventType: { header: 'X-Event' }, events: ['order.filled', 'order.canceled'] };
    expect(event(byHeader).matches(request(fill, { 'x-event': 'order.filled' }))).toBe(true);
    expect(event(byHeader).matches(request(fill, { 'x-event': 'other' }))).toBe(false);
  });

  it('takes the event id from a header or body path, else a SHA-256 of the body', () => {
    expect(event().eventId(request())).toBe('dlv_1');
    expect(() => event().eventId(request(fill, { 'x-delivery-id': '' }))).toThrow(/x-delivery-id header/);
    const byField = resolved({ ...fills, eventId: { field: 'id' } });
    expect(byField.definition.eventIdHeader).toBeUndefined();
    expect(eventOf(byField.definition, 'order.filled').eventId(request())).toBe('fill_1');
    // No eventId: the body's hash (canonical JSON, so key order doesn't matter), the same in Event Gateway.
    const fallback = eventOf(resolved({ ...fills, eventId: undefined }).definition, 'order.filled');
    const expected = createHash('sha256').update(canonical(fill)).digest('hex').slice(0, 32);
    expect(fallback.eventId(request())).toBe(expected);
    expect(fallback.eventId(request({ ...Object.fromEntries(Object.entries(fill).reverse()) }))).toBe(expected);
    expect(fallback.eventId(request({ ...fill, quantity: 101 }))).not.toBe(expected);
    const unicode = { note: 'caf\u00e9 \u{1F680}', long: 'x'.repeat(10_000) };
    expect(fallback.eventId(request(unicode))).toBe(createHash('sha256').update(canonical(unicode)).digest('hex').slice(0, 32));
  });

  it('takes occurred-at from a body field (ISO 8601 or Unix time), else the time received', () => {
    expect(event().occurredAt(request())).toBe('2026-10-07T14:30:00.123Z');
    expect(event().occurredAt(request({ filled_at: 1791383400 }))).toBe('2026-10-07T14:30:00.000Z');
    expect(event().occurredAt(request({ filled_at: 1791383400123 }))).toBe('2026-10-07T14:30:00.123Z');
    const before = Date.now();
    expect(Date.parse(event().occurredAt(request({ filled_at: 'not a time' })))).toBeGreaterThanOrEqual(before);
    expect(Date.parse(event({ ...fills, occurredAt: undefined }).occurredAt(request()))).toBeGreaterThanOrEqual(before);
  });

  it('passes the JSON body through, or only the listed fields, and wraps a non-object body', () => {
    expect(event().summarize(request())).toEqual(fill);
    expect(event({ ...fills, fields: ['symbol', 'side', 'price', 'missing'] }).summarize(request())).toEqual({ symbol: 'AAPL', side: 'buy', price: 187.5 });
    expect(event().summarize(request(['a', 'b']))).toEqual({ body: ['a', 'b'] });
    expect(event().description).toBe('An order on my trading server filled. Data is the JSON body as sent. Filter by symbol, side (exact match).');
  });

  it('reads dot paths', () => {
    expect(readPath({ data: { order: { id: 7 } } }, 'data.order.id')).toBe(7);
    expect(readPath({ data: [1] }, 'data.0')).toBeUndefined();
    expect(readPath('text', 'a')).toBeUndefined();
  });
});

describe('webhook source: subscribe arguments', () => {
  const event = eventOf(resolved().definition, 'order.filled');

  it('offers equality filters on the declared fields', () => {
    expect(event.inputSchema).toMatchObject({ type: 'object', additionalProperties: false, properties: { symbol: expect.any(Object), side: expect.any(Object) } });
    expect(event.parseArguments({ symbol: 'AAPL' })).toEqual({ symbol: 'AAPL' });
    expect(event.parseArguments(undefined)).toEqual({});
    expect(() => event.parseArguments({ account: 'x' })).toThrow();
    expect(() => event.parseArguments({ symbol: { $ne: 'AAPL' } })).toThrow();
  });

  it('accepts events whose fields equal every filter', () => {
    const summary = event.summarize(request());
    expect(event.accepts({}, summary)).toBe(true);
    expect(event.accepts({ symbol: 'AAPL', side: 'buy' }, summary)).toBe(true);
    expect(event.accepts({ symbol: 'MSFT' }, summary)).toBe(false);
    expect(event.accepts({ side: 'sell' }, summary)).toBe(false);
    expect(event.accepts({ symbol: 'AAPL' }, { symbol: { nested: true } })).toBe(false);
    expect(event.accepts({ symbol: 'AAPL' }, {})).toBe(false);
    // Type included, as Event Gateway's filters compare.
    expect(event.accepts({ quantity: 100 }, summary)).toBe(true);
    expect(event.accepts({ quantity: '100' }, summary)).toBe(false);
  });
});

describe('typed sources: an Event Gateway source type verifies the service\'s signatures', () => {
  const stripe: SourceOptions = {
    type: 'stripe',
    secret: env('STRIPE_WEBHOOK_SECRET'),
    events: { 'invoice.paid': { description: 'An invoice was paid.' }, 'customer.created': {} },
    eventType: { field: 'type' },
    eventId: { field: 'id' },
    occurredAt: { field: 'created' },
  };
  const resolvedStripe = (environment: Record<string, string> = { STRIPE_WEBHOOK_SECRET: 'whsec_stripe' }) =>
    resolveConfig(defineConfig({ deployment: 'dev', sources: [source(stripe)] }), { ...base, ...environment }).sources[0]!;

  it('creates a STRIPE source whose auth holds the secret, with the type as the default id', () => {
    const s = resolvedStripe();
    expect(s).toMatchObject({ id: 'stripe', events: ['invoice.paid', 'customer.created'] });
    expect(s.definition).toMatchObject({ type: 'stripe', sourceType: 'STRIPE' });
    expect(s.definition.sourceConfig!(s.options)).toEqual({ auth: { webhook_secret_key: 'whsec_stripe' } });
    expect(s.definition.setupHint!({ sourceUrl: 'https://hkdk.events/x', providerEvents: [], options: s.options })).toContain("Event Gateway verifies stripe's requests (its signature or credentials) with STRIPE_WEBHOOK_SECRET");
  });

  it('maps events as a webhook source does', () => {
    const paid = eventOf(resolvedStripe().definition, 'invoice.paid');
    const body = { id: 'evt_1', type: 'invoice.paid', created: 1791383400, data: { object: { id: 'in_1' } } };
    expect(paid.matches(request(body))).toBe(true);
    expect(paid.matches(request({ ...body, type: 'customer.created' }))).toBe(false);
    expect(paid.eventId(request(body))).toBe('evt_1');
    expect(paid.occurredAt(request(body))).toBe('2026-10-07T14:30:00.000Z');
  });

  it("takes each type's own credentials: several fields, mapped to Event Gateway's names", () => {
    const postmark = resolveConfig(
      defineConfig({ deployment: 'dev', sources: [source({ type: 'postmark', username: 'bridge', password: env('PM_PASSWORD'), events: ['bounce'] })] }),
      { ...base, PM_PASSWORD: 'pw' },
    ).sources[0]!;
    expect(postmark.definition.sourceType).toBe('POSTMARK');
    expect(postmark.definition.sourceConfig!(postmark.options)).toEqual({ auth: { username: 'bridge', password: 'pw' } });
  });

  it('holds while a credential is missing, and rejects unknown types and missing or unknown credentials', () => {
    const waiting = resolvedStripe({});
    expect(waiting.definition.missingCredentials!(waiting.options)).toEqual(['STRIPE_WEBHOOK_SECRET']);
    expect(() => source({ type: 'nope', events: ['x'] } as never)).toThrow(/Event Gateway source type/);
    expect(() => source({ type: 'stripe', events: ['x'] } as never)).toThrow(/secret/);
    expect(() => source({ type: 'stripe', secret: 's', apiKey: 'k', events: ['x'] } as never)).toThrow(/apiKey/);
  });

  it('is typed per source type', () => {
    // Compile-time checks, run by `npm run typecheck`.
    source({ type: 'slack', secret: 's', events: ['message'] });
    // @ts-expect-error postmark takes username and password, not secret
    void (() => source({ type: 'postmark', secret: 's', events: ['bounce'] }));
    // @ts-expect-error not an Event Gateway source type
    void (() => source({ type: 'not-a-type', events: ['x'] }));
    // @ts-expect-error a webhook source needs verification
    void (() => source({ type: 'webhook', id: 'x', events: ['x'] }));
  });
});

describe('the names removed in 0.8.0', () => {
  it('refuses `providers` in the config, saying it is now `sources`', () => {
    const old = { deployment: 'dev', providers: [source(fills)] } as unknown as Parameters<typeof defineConfig>[0];
    expect(() => resolveConfig(defineConfig(old), { ...base, FILLS_WEBHOOK_SECRET: SECRET })).toThrow(/`providers` in the config is now `sources`/);
  });
});
