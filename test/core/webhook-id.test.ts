import { describe, expect, it } from 'vitest';
import { chooseWebhookIdMode, clientName, declaresEventsExtension, deliveryWebhookId, LEGACY_WEBHOOK_ID_CLIENTS, messageId } from '../../src/core/webhook-id.js';

/** A request's `_meta` as a 2026-07-28 client sends it. */
const meta = (options: { events?: boolean; name?: string } = {}) => ({
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientCapabilities': options.events ? { extensions: { 'io.modelcontextprotocol/events': {} } } : {},
  ...(options.name !== undefined && { 'io.modelcontextprotocol/clientInfo': { name: options.name, version: '1.0.0' } }),
});

describe('webhook-id mode', () => {
  it('reads the events extension declaration and the client name from _meta', () => {
    expect(declaresEventsExtension(meta({ events: true }))).toBe(true);
    expect(declaresEventsExtension(meta())).toBe(false);
    expect(declaresEventsExtension(undefined)).toBe(false);
    expect(declaresEventsExtension({ 'io.modelcontextprotocol/clientCapabilities': { extensions: { 'io.modelcontextprotocol/events': true } } })).toBe(false);
    expect(clientName(meta({ name: 'openclaw' }))).toBe('openclaw');
    expect(clientName(meta())).toBeUndefined();
  });

  it('under auto, gives a per-message id to a client that declares the extension, and the eventId to one that does not', () => {
    expect(chooseWebhookIdMode('auto', meta({ events: true, name: 'some-sep-client' }))).toBe('message');
    expect(chooseWebhookIdMode('auto', meta({ events: true }))).toBe('message');
    expect(chooseWebhookIdMode('auto', meta({ name: 'openclaw' }))).toBe('event');
    expect(chooseWebhookIdMode('auto', undefined)).toBe('event');
  });

  it('under auto, keeps the eventId for a declaring client on the legacy list (TanStack AI declares it, and rejects a per-message id)', () => {
    expect(LEGACY_WEBHOOK_ID_CLIENTS).toEqual(expect.arrayContaining(['tanstack-ai-mcp', 'ai-sdk-mcp-client', 'openclaw']));
    for (const name of LEGACY_WEBHOOK_ID_CLIENTS) expect(chooseWebhookIdMode('auto', meta({ events: true, name }))).toBe('event');
    expect(chooseWebhookIdMode('auto', meta({ events: true, name: 'x' }), ['x'])).toBe('event');
  });

  it('applies event or message to every subscription when the operator sets it', () => {
    expect(chooseWebhookIdMode('event', meta({ events: true, name: 'some-sep-client' }))).toBe('event');
    expect(chooseWebhookIdMode('message', meta({ name: 'tanstack-ai-mcp' }))).toBe('message');
    expect(chooseWebhookIdMode('message', undefined)).toBe('message');
  });

  it('generates header-safe per-message ids, never the eventId', () => {
    const ids = new Set(Array.from({ length: 100 }, () => messageId()));
    expect(ids.size).toBe(100);
    for (const id of ids) expect(id).toMatch(/^msg_[A-Za-z0-9_-]{24}$/);
    expect(deliveryWebhookId('event', 'evt_1')).toBe('evt_1');
    expect(deliveryWebhookId('message', 'evt_1')).toMatch(/^msg_/);
  });
});
