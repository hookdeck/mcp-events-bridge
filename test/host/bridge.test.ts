import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import vm from 'node:vm';
import { Webhook } from 'standardwebhooks';
import { afterEach, describe, expect, it } from 'vitest';
import * as z from 'zod';
import { defineConfig, resolveConfig } from '../../src/core/config.js';
import { matchesFilter } from '../../src/core/filter.js';
import { HookdeckClient } from '../../src/core/hookdeck.js';
import { MemoryStore } from '../../src/core/memory-store.js';
import { generateWebhookSecret } from '../../src/core/secret.js';
import { healthyDelivery } from '../../src/core/store.js';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createNodeCallbackTransport } from '../../src/host/callback-transport.js';
import { createBridgeServer, redactPath } from '../../src/host/server.js';
import { resend } from '../../src/sources.js';
import { FakeEventGateway } from '../support/fake-event-gateway.js';
import { Subscriber } from '../support/subscriber.js';

/*
 * The whole path in one process, with a fake Event Gateway: an MCP client
 * subscribes over the secret URL, which creates a connection on the Resend
 * source; a Resend delivery goes through that connection as Event Gateway
 * would take it (the generated transformation, the filter, signing with the
 * destination's secret), and verifies at the subscriber.
 */

const SIGNING_SECRET = 'hookdeck-signing-secret';
const MCP_SECRET = 'test-mcp-secret-0123456789';
const fixture = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'fixtures', 'resend', 'email-received.json'), 'utf8')) as {
  headers: Record<string, string>;
  body: Record<string, unknown>;
};

const running: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((r) => r.close()));
});

async function startBridge({
  inbound = 'cli' as 'cli' | 'http',
  store,
  pollNow,
  secretUrl,
}: { inbound?: 'cli' | 'http'; store?: MemoryStore; pollNow?: () => number; secretUrl?: 'true' | 'false' } = {}) {
  const gateway = new FakeEventGateway();
  // What setup creates: the service's source, which subscriptions are connections on.
  gateway.sources.set('src_resend', { id: 'src_resend', name: 'bridge-resend', type: 'RESEND', url: 'https://hkdk.events/src_resend' });
  const config = resolveConfig(defineConfig({ deployment: 'test', port: 0, inbound, publicUrl: 'https://bridge.example.com', sources: [resend({ apiKey: 'x' })] }), {
    HOOKDECK_API_KEY: 'k',
    HOOKDECK_SIGNING_SECRET: SIGNING_SECRET,
    BRIDGE_MCP_SECRET: MCP_SECRET,
    ...(secretUrl && { BRIDGE_MCP_SECRET_URL: secretUrl }),
  });
  const logs: string[] = [];
  const bridge = await createBridgeServer(config, {
    hookdeck: new HookdeckClient({ apiKey: 'k', fetch: gateway.fetch }),
    ...(store && { store }),
    // The subscriber's receiver is local; stand in for Event Gateway's challenge answer.
    subscriptionOverrides: { verify: async () => ({ ok: true }), transport: createNodeCallbackTransport({ allowNonPublic: true }) },
    log: (m) => logs.push(m),
    version: '9.9.9',
    ...(pollNow && { pollOverrides: { now: pollNow } }),
  });
  const { port } = await bridge.listen();
  running.push(bridge);
  return { gateway, bridge, port, logs };
}

async function startSubscriber(port: number, args: Record<string, unknown> = {}) {
  const subscriber = new Subscriber({
    serverUrl: `http://127.0.0.1:${port}/mcp/${MCP_SECRET}`,
    token: '',
    eventName: 'resend.email.received',
    arguments: args,
    callbackUrl: 'https://receiver.example.com/hook',
    log: () => {},
  });
  await subscriber.start();
  running.push({ close: () => subscriber.stop({ unsubscribe: false }) });
  return subscriber;
}

type Rules = [{ transformation_id: string }, { headers: Record<string, unknown>; body: Record<string, unknown> }];

/**
 * What Event Gateway does with a request to the service's source: each subscription's connection runs the source's
 * transformation, applies its filter, and its destination signs the result with the subscriber's secret. Delivered to
 * the subscriber's local receiver, standing in for its callback URL.
 */
async function deliverFromSource(gateway: FakeEventGateway, subscriber: Subscriber, request: { headers: Record<string, string>; body: unknown }) {
  const receiverPort = ((subscriber as unknown as { receiver: { address(): { port: number } } }).receiver.address()).port;
  for (const connection of gateway.connections.values()) {
    if (!connection.name.startsWith('mcp-sub-')) continue;
    const [transform, filter] = connection.rules as Rules;
    let handler: ((req: unknown, ctx: unknown) => unknown) | undefined;
    vm.runInNewContext(gateway.transformations.get(transform.transformation_id)!.code, { addHandler: (_type: string, fn: typeof handler) => (handler = fn), Buffer, TextEncoder });
    const out = JSON.parse(JSON.stringify(handler!(request, { connection: { name: connection.name, description: connection.description } }))) as {
      headers: Record<string, string>;
      body: Record<string, unknown>;
    };
    if (out.headers['x-mcp-skip'] || !matchesFilter(filter.body, out.body)) continue;
    const secret = (gateway.destinations.get(connection.destinationId)!.config as { auth: { webhook_secret_key: string } }).auth.webhook_secret_key;
    const body = JSON.stringify(out.body);
    const now = new Date();
    const signature = new Webhook(secret).sign(out.headers['webhook-id']!, now, body);
    const headers = { ...out.headers, 'webhook-timestamp': String(Math.floor(now.getTime() / 1000)), 'webhook-signature': signature };
    await fetch(`http://127.0.0.1:${receiverPort}/`, { method: 'POST', headers, body });
  }
}

/** The fixture, as an email that just arrived. */
const freshEmail = () => ({ ...fixture.body, data: { ...(fixture.body.data as object), created_at: new Date(Date.now() + 1000).toISOString() } });
const resendDelivery = () => ({ headers: fixture.headers, body: freshEmail() });

describe('bridge server', () => {
  it('serves MCP only to the secret, in the URL or as a bearer token', async () => {
    const { port } = await startBridge();
    expect((await fetch(`http://127.0.0.1:${port}/mcp/wrong`, { method: 'POST' })).status).toBe(404);
    const missing = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST' });
    expect(missing.status).toBe(401);
    expect(missing.headers.get('www-authenticate')).toBe('Bearer realm="mcp-events-bridge"');
    expect(await missing.json()).toEqual({ error: 'Send Authorization: Bearer <BRIDGE_MCP_SECRET>, or use /mcp/<BRIDGE_MCP_SECRET>' });
    for (const authorization of ['Bearer wrong', `Basic ${MCP_SECRET}`, MCP_SECRET, `Bearer ${MCP_SECRET} extra`]) {
      expect((await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: { authorization } })).status).toBe(401);
    }
    expect(redactPath(`/mcp/${MCP_SECRET}`)).toBe('/mcp/<secret>');
  });

  it('takes the secret as Authorization: Bearer at /mcp', async () => {
    const { port } = await startBridge();
    for (const [scheme, path] of [['Bearer', '/mcp'], ['bearer', '/mcp/']] as const) {
      const client = new Client({ name: 'test', version: '0.0.0' }, { versionNegotiation: { mode: 'auto' } });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}${path}`), { requestInit: { headers: { Authorization: `${scheme} ${MCP_SECRET}` } } }),
      );
      try {
        expect(client.getServerVersion()).toMatchObject({ name: 'mcp-events-bridge' });
        const result = (await client.callTool({ name: 'list_sources', arguments: {} })) as { structuredContent?: { sources: unknown[] } };
        expect(result.structuredContent?.sources).toHaveLength(1);
      } finally {
        await client.close();
      }
    }
  });

  it('turns the secret URL off with BRIDGE_MCP_SECRET_URL=false, keeping the bearer token', async () => {
    const { port } = await startBridge({ secretUrl: 'false' });
    expect((await fetch(`http://127.0.0.1:${port}/mcp/${MCP_SECRET}`, { method: 'POST' })).status).toBe(404);
    const missing = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST' });
    expect(await missing.json()).toEqual({ error: 'Send Authorization: Bearer <BRIDGE_MCP_SECRET>' });
    const client = new Client({ name: 'test', version: '0.0.0' }, { versionNegotiation: { mode: 'auto' } });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${MCP_SECRET}` } } }));
    await client.close();
  });

  it("delivers a Resend email end to end through the subscription's connection, with webhook-id equal to the svix-id and a cursor", async () => {
    const { gateway, port, bridge } = await startBridge();
    const subscriber = await startSubscriber(port, { from: 'Sender@Example.com' });
    expect(bridge.store.list()).toHaveLength(1);
    const connection = [...gateway.connections.values()].find((c) => c.name === `mcp-sub-${subscriber.subscription!.id}`)!;
    expect(connection.sourceId).toBe('src_resend');
    expect([...gateway.transformations.values()].map((t) => t.name)).toEqual(['bridge-resend-envelope']);

    await deliverFromSource(gateway, subscriber, resendDelivery());
    expect(subscriber.events).toHaveLength(1);
    expect(subscriber.events[0]).toMatchObject({ eventId: fixture.headers['svix-id'], name: 'resend.email.received', data: { fromAddress: 'sender@example.com' } });
    expect(typeof subscriber.events[0]!.cursor).toBe('string');
  });

  it('lists sources with their MCP event names and how many subscriptions each has', async () => {
    const { port } = await startBridge();
    await startSubscriber(port);
    const client = new Client({ name: 'test', version: '0.0.0' }, { versionNegotiation: { mode: 'auto' } });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp/${MCP_SECRET}`)));
    try {
      expect(client.getServerVersion()).toMatchObject({ name: 'mcp-events-bridge', version: '9.9.9' });
      const expected = [{ id: 'resend', type: 'resend', events: ['resend.email.received'], subscriptions: 1 }];
      const result = (await client.callTool({ name: 'list_sources', arguments: {} })) as { structuredContent?: { sources: unknown[] } };
      expect(result.structuredContent?.sources).toEqual(expected);
      // The old name, removed in 0.8.0.
      expect((await client.listTools()).tools.map((t) => t.name)).not.toContain('list_providers');
    } finally {
      await client.close();
    }
  });

  it('get_event and list_events need a name the bridge offers', async () => {
    const { port } = await startBridge();
    const client = new Client({ name: 'test', version: '0.0.0' }, { versionNegotiation: { mode: 'auto' } });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp/${MCP_SECRET}`)));
    type Result = { isError?: boolean; content?: Array<{ text?: string }> };
    const call = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as Result;
    try {
      // The name is required: an event id is the provider's own, so it doesn't say which instance to search.
      expect((await call('get_event', { eventId: 'msg_1' })).isError).toBe(true);
      const unknown = await call('get_event', { name: 'email.received', eventId: 'msg_1' });
      expect(unknown).toMatchObject({ isError: true });
      expect(unknown.content?.[0]?.text).toContain('Unknown event name email.received');
      const listed = await call('list_events', { name: 'email.received' });
      expect(listed).toMatchObject({ isError: true });
      expect(listed.content?.[0]?.text).toContain('Unknown event name email.received');
    } finally {
      await client.close();
    }
  });

  it("logs a subscription to an event the bridge doesn't offer", async () => {
    const store = new MemoryStore();
    await store.put({
      id: 'sub_old', principal: 'owner', name: 'email.received', arguments: {}, url: 'https://receiver.example.com/hook',
      secret: generateWebhookSecret(), replay: null, delivery: healthyDelivery(),
      expiresAt: '2099-01-01T00:00:00.000Z', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
    });
    const { logs } = await startBridge({ store });
    expect(logs).toContain('subscription sub_old is for "email.received", which this bridge doesn\'t offer');
  });

  it('applies the from filter', async () => {
    const { gateway, port } = await startBridge();
    const subscriber = await startSubscriber(port, { from: 'someone-else@example.com' });
    await deliverFromSource(gateway, subscriber, resendDelivery());
    expect(subscriber.events).toHaveLength(0);
  });

  it('creates callback URLs for local agents over MCP, without echoing the secret', async () => {
    const { port, gateway } = await startBridge();
    const client = new Client({ name: 'test', version: '0.0.0' }, { versionNegotiation: { mode: 'auto' } });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp/${MCP_SECRET}`)));
    try {
      const tools = (await client.listTools()).tools.map((t) => t.name);
      expect(tools).toEqual(expect.arrayContaining(['create_callback_url', 'list_callback_urls']));
      expect(tools).not.toContain('create_tunnel_url');
      const secret = generateWebhookSecret();
      const result = (await client.callTool({ name: 'create_callback_url', arguments: { agent: 'laptop', name: 'email', port: 4000, secret } })) as {
        structuredContent?: Record<string, unknown>;
        content: Array<{ text?: string }>;
      };
      const source = [...gateway.sources.values()].find((s) => s.name === 'agent-laptop-email')!;
      expect(result.structuredContent).toEqual({ name: 'email', url: source.url, port: 4000, path: '/events', passThrough: false });
      expect((source.config as { auth: { webhook_secret_key: string } }).auth.webhook_secret_key).toBe(secret);
      expect(JSON.stringify(result)).not.toContain('whsec_');
      const listed = (await client.callTool({ name: 'list_callback_urls', arguments: { agent: 'laptop' } })) as { structuredContent?: { callbackUrls: unknown[] } };
      expect(listed.structuredContent?.callbackUrls).toEqual([result.structuredContent]);
    } finally {
      await client.close();
    }
  });

  it("doesn't offer callback URLs on a deployed bridge, which can't run hookdeck listen on the agent's machine", async () => {
    const { port } = await startBridge({ inbound: 'http' });
    const client = new Client({ name: 'test', version: '0.0.0' }, { versionNegotiation: { mode: 'auto' } });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp/${MCP_SECRET}`)));
    try {
      expect((await client.listTools()).tools.map((t) => t.name)).not.toContain('create_callback_url');
    } finally {
      await client.close();
    }
  });

  it('refuses an oversized inbound body before reading it all', async () => {
    const { port } = await startBridge();
    // Only the headers are sent: the bridge answers from the declared length and closes the connection.
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/inbound/hookdeck', method: 'POST', headers: { 'Content-Length': String(11 * 1024 * 1024) } });
      req.on('response', (res) => resolve(res.statusCode));
      req.on('error', reject);
      req.flushHeaders();
    });
    expect(status).toBe(413);
  });

  it('rejects inbound requests without a Hookdeck signature', async () => {
    const { port } = await startBridge();
    expect((await fetch(`http://127.0.0.1:${port}/inbound/hookdeck`, { method: 'POST', body: JSON.stringify({ topic: 'issue.opened' }) })).status).toBe(401);
  });

  it("unsubscribes, deleting the subscription's connection and destination, and leaving the service's source", async () => {
    const { gateway, port } = await startBridge();
    const subscriber = await startSubscriber(port);
    await subscriber.stop({ unsubscribe: true });
    expect(gateway.connections.size).toBe(0);
    expect(gateway.destinations.size).toBe(0);
    expect([...gateway.sources.values()].map((source) => source.name)).toEqual(['bridge-resend']);
  });
});

describe('poll mode over MCP', () => {
  const anyResult = z.record(z.string(), z.unknown());

  it('advertises poll, and answers events/poll and the poll tools from Event Gateway requests', async () => {
    // The bridge's clock, moved on by hand so the shared listing (reused for 2 s) is fetched again.
    let offset = 0;
    const { gateway, port } = await startBridge({ pollNow: () => Date.now() + offset });
    const client = new Client({ name: 'test', version: '0.0.0' }, { versionNegotiation: { mode: 'auto' } });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp/${MCP_SECRET}`)));
    try {
      const discover = await client.request({ method: 'server/discover', params: {} }, anyResult);
      expect(discover.capabilities).toMatchObject({ events: {}, extensions: { 'io.modelcontextprotocol/events': {} } });
      const list = await client.request({ method: 'events/list', params: {} } as never, anyResult);
      expect((list.events as Array<{ delivery: string[] }>)[0]!.delivery).toEqual(['webhook', 'poll']);

      const poll = (params: Record<string, unknown>) => client.request({ method: 'events/poll', params } as never, anyResult);
      const first = await poll({ name: 'resend.email.received', arguments: {}, cursor: null });
      // (The SDK client consumes resultType when it decodes a result; the poll tests check it's 'complete'.)
      expect(first).toMatchObject({ events: [], truncated: false, hasMore: false });

      gateway.requests.push({
        id: 'req_1',
        source_id: 'src_resend',
        created_at: new Date(Date.now() + 1000).toISOString(),
        verified: true,
        rejection_cause: null,
        events_count: 1,
        ignored_count: 0,
        data: { headers: fixture.headers, body: freshEmail() },
      });
      offset += 3000;
      const next = await poll({ name: 'resend.email.received', arguments: {}, cursor: first.cursor });
      expect(next.events).toMatchObject([{ eventId: fixture.headers['svix-id'], name: 'resend.email.received' }]);

      // The tools, for hosts without MCP Events: the same cursor and result.
      const tool = (await client.callTool({ name: 'poll_events', arguments: { name: 'resend.email.received', cursor: first.cursor } })) as { structuredContent?: { events: unknown[] } };
      expect(tool.structuredContent?.events).toHaveLength(1);
      const waited = (await client.callTool({ name: 'wait_for_event', arguments: { name: 'resend.email.received', cursor: next.cursor, timeoutMs: 1000 } })) as { structuredContent?: { events: unknown[]; cursor: string } };
      expect(waited.structuredContent).toMatchObject({ events: [] });
      expect(typeof waited.structuredContent?.cursor).toBe('string');

      // Errors: NotFound over the protocol; a readable tool error for the model.
      await expect(poll({ name: 'email.received', arguments: {}, cursor: null })).rejects.toMatchObject({ code: -32023 });
      expect((await client.callTool({ name: 'poll_events', arguments: { name: 'email.received' } })).isError).toBe(true);

      // Push isn't offered: events/stream is Unsupported for a known event, NotFound for an unknown one.
      const stream = (name: string) => client.request({ method: 'events/stream', params: { name, arguments: {} } } as never, anyResult);
      await expect(stream('resend.email.received')).rejects.toMatchObject({ code: -32026, data: { feature: 'deliveryMode', value: 'push' } });
      await expect(stream('email.received')).rejects.toMatchObject({ code: -32023 });
    } finally {
      await client.close();
    }
  });
});
