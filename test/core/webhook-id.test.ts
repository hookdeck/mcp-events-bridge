import { describe, expect, it } from 'vitest';
import { chooseWebhookIdFormat, clientName, declaresEventsExtension, deliveryWebhookId, LEGACY_WEBHOOK_ID_CLIENTS, messageId } from '../../src/core/webhook-id.js';

/** A request's `_meta` as a 2026-07-28 client sends it. */
const meta = (options: { events?: boolean; name?: string } = {}) => ({
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientCapabilities': options.events ? { extensions: { 'io.modelcontextprotocol/events': {} } } : {},
  ...(options.name !== undefined && { 'io.modelcontextprotocol/clientInfo': { name: options.name, version: '1.0.0' } }),
});

describe('webhook-id format', () => {
  it('reads the events extension declaration and the client name from _meta', () => {
    expect(declaresEventsExtension(meta({ events: true }))).toBe(true);
    expect(declaresEventsExtension(meta())).toBe(false);
    expect(declaresEventsExtension(undefined)).toBe(false);
    expect(declaresEventsExtension({ 'io.modelcontextprotocol/clientCapabilities': { extensions: { 'io.modelcontextprotocol/events': true } } })).toBe(false);
    expect(clientName(meta({ name: 'openclaw' }))).toBe('openclaw');
    expect(clientName(meta())).toBeUndefined();
  });

  it('under auto, gives a per-message id to a client that declares the extension, and the eventId to one that does not', () => {
    expect(chooseWebhookIdFormat('auto', meta({ events: true, name: 'some-sep-client' }))).toBe('per-message');
    expect(chooseWebhookIdFormat('auto', meta({ events: true }))).toBe('per-message');
    expect(chooseWebhookIdFormat('auto', meta({ name: 'openclaw' }))).toBe('event-id');
    expect(chooseWebhookIdFormat('auto', undefined)).toBe('event-id');
  });

  it('under auto, keeps the eventId for a declaring client on the legacy list (TanStack AI declares it, and rejects a per-message id)', () => {
    expect(LEGACY_WEBHOOK_ID_CLIENTS).toEqual(expect.arrayContaining(['tanstack-ai-mcp', 'ai-sdk-mcp-client', 'openclaw']));
    for (const name of LEGACY_WEBHOOK_ID_CLIENTS) expect(chooseWebhookIdFormat('auto', meta({ events: true, name }))).toBe('event-id');
    expect(chooseWebhookIdFormat('auto', meta({ events: true, name: 'x' }), ['x'])).toBe('event-id');
  });

  it('applies event-id or per-message to every subscription when the operator sets it', () => {
    expect(chooseWebhookIdFormat('event-id', meta({ events: true, name: 'some-sep-client' }))).toBe('event-id');
    expect(chooseWebhookIdFormat('per-message', meta({ name: 'tanstack-ai-mcp' }))).toBe('per-message');
    expect(chooseWebhookIdFormat('per-message', undefined)).toBe('per-message');
  });

  it('generates header-safe per-message ids, never the eventId', () => {
    const ids = new Set(Array.from({ length: 100 }, () => messageId()));
    expect(ids.size).toBe(100);
    for (const id of ids) expect(id).toMatch(/^msg_[A-Za-z0-9_-]{24}$/);
    expect(deliveryWebhookId('event-id', 'evt_1')).toBe('evt_1');
    expect(deliveryWebhookId('per-message', 'evt_1')).toMatch(/^msg_/);
  });
});
