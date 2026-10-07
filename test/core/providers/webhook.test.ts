import { describe, expect, it } from 'vitest';
import { assertCredentials, ConfigError, defineConfig, env, resolveConfig } from '../../../src/core/config.js';
import { readPath, type WebhookOptions } from '../../../src/core/providers/webhook.js';
import type { InboundRequest } from '../../../src/core/providers/types.js';
import { webhook } from '../../../src/providers.js';

const base = { HOOKDECK_API_KEY: 'hk', HOOKDECK_SIGNING_SECRET: 'hs' };
const SECRET = 'fills-secret-0123456789';

const fills: WebhookOptions = {
  id: 'fills',
  verification: { type: 'hmac', algorithm: 'sha256', encoding: 'hex', header: 'X-Signature', secret: env('FILLS_WEBHOOK_SECRET') },
  events: { 'order.filled': { description: 'An order on my trading server filled.' } },
  eventId: { header: 'X-Delivery-Id' },
  occurredAt: { field: 'filled_at' },
  filters: ['symbol', 'side'],
};

const resolved = (options: WebhookOptions = fills, environment: Record<string, string> = { FILLS_WEBHOOK_SECRET: SECRET }) =>
  resolveConfig(defineConfig({ deployment: 'dev', providers: [webhook(options)] }), { ...base, ...environment }).providers[0]!;

const fill = { id: 'fill_1', symbol: 'AAPL', side: 'buy', quantity: 100, price: 187.5, filled_at: '2026-10-07T14:30:00.123Z' };
const request = (body: unknown = fill, headers: Record<string, string> = {}): InboundRequest => ({
  headers: { 'x-hookdeck-verified': 'true', 'x-hookdeck-requestid': 'req_123', 'x-delivery-id': 'dlv_1', ...headers },
  body,
});

describe('webhook provider: config', () => {
  it('creates an instance with the given id and events, and a WEBHOOK source with HMAC verification', () => {
    const provider = resolved();
    expect(provider).toMatchObject({ id: 'fills', events: ['order.filled'] });
    expect(provider.definition).toMatchObject({ type: 'webhook', sourceType: 'WEBHOOK', inboundDedupeFields: ['headers.x-delivery-id'], eventIdHeader: 'x-delivery-id' });
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
    const bad = (over: Partial<WebhookOptions>) => () => webhook({ ...fills, ...over } as WebhookOptions);
    expect(bad({ verification: { type: 'hmac', algorithm: 'md5', encoding: 'hex', header: 'x-sig', secret: 's' } as never })).toThrow(/algorithm/);
    expect(bad({ verification: { type: 'hmac', algorithm: 'sha256', encoding: 'hex', secret: 's' } as never })).toThrow(/header/);
    expect(bad({ verification: { type: 'none' } as never })).toThrow(/webhook fills/);
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
    expect(provider.options.verification).toMatchObject({ secret: null });
    expect(provider.definition.missingCredentials!(provider.options)).toEqual(['FILLS_WEBHOOK_SECRET']);
    expect(() => provider.definition.sourceConfig!(provider.options)).toThrow(/FILLS_WEBHOOK_SECRET/);
    const config = resolveConfig(defineConfig({ deployment: 'dev', providers: [webhook(fills)] }), base);
    expect(() => assertCredentials(config)).toThrow(ConfigError);
    expect(() => assertCredentials(config)).toThrow(/FILLS_WEBHOOK_SECRET \(provider fills\)/);
    expect(() => assertCredentials(resolveConfig(defineConfig({ deployment: 'dev', providers: [webhook(fills)] }), { ...base, FILLS_WEBHOOK_SECRET: SECRET }))).not.toThrow();
  });
});

describe('webhook provider: mapping', () => {
  const event = (options: WebhookOptions = fills, name = 'order.filled') => resolved(options).definition.events.find((e) => e.name === name)!;

  it('matches only requests Event Gateway verified', () => {
    expect(event().matches(request())).toBe(true);
    expect(event().matches(request(fill, { 'x-hookdeck-verified': 'false' }))).toBe(false);
    const { 'x-hookdeck-verified': _, ...unmarked } = request().headers;
    expect(event().matches({ headers: unmarked, body: fill })).toBe(false);
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

  it('takes the event id from a header or body path, else Event Gateway\'s request id', () => {
    expect(event().eventId(request())).toBe('dlv_1');
    expect(() => event().eventId(request(fill, { 'x-delivery-id': '' }))).toThrow(/x-delivery-id header/);
    const byField = resolved({ ...fills, eventId: { field: 'id' } });
    expect(byField.definition.inboundDedupeFields).toEqual(['body.id']);
    expect(byField.definition.eventIdHeader).toBeUndefined();
    expect(byField.definition.events[0]!.eventId(request())).toBe('fill_1');
    const fallback = resolved({ ...fills, eventId: undefined });
    expect(fallback.definition.inboundDedupeFields).toBeUndefined();
    expect(fallback.definition.events[0]!.eventId(request())).toBe('req_123');
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

describe('webhook provider: subscribe arguments', () => {
  const event = resolved().definition.events[0]!;

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
  });
});
