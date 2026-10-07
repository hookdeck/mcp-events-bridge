import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defineConfig, resolveConfig } from '../../src/core/config.js';
import { HookdeckClient } from '../../src/core/hookdeck.js';
import { MemoryStore } from '../../src/core/memory-store.js';
import { generateWebhookSecret } from '../../src/core/secret.js';
import { healthyDelivery } from '../../src/core/store.js';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createNodeCallbackTransport } from '../../src/host/callback-transport.js';
import { createBridgeServer, redactPath } from '../../src/host/server.js';
import { resend } from '../../src/providers.js';
import { FakeEventGateway } from '../support/fake-event-gateway.js';
import { Subscriber } from '../support/subscriber.js';

/*
 * The whole path in one process, with a fake Event Gateway: an MCP client
 * subscribes over the secret URL, a signed Resend delivery arrives at the
 * inbound route, the relay publishes, and the published request (as Event
 * Gateway would deliver it) verifies at the subscriber.
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

async function startBridge({ inbound = 'cli' as 'cli' | 'http', store }: { inbound?: 'cli' | 'http'; store?: MemoryStore } = {}) {
  const gateway = new FakeEventGateway();
  const config = resolveConfig(defineConfig({ deployment: 'test', port: 0, inbound, publicUrl: 'https://bridge.example.com', providers: [resend({ apiKey: 'x' })] }), {
    HOOKDECK_API_KEY: 'k',
    HOOKDECK_SIGNING_SECRET: SIGNING_SECRET,
    BRIDGE_MCP_SECRET: MCP_SECRET,
  });
  const logs: string[] = [];
  const bridge = await createBridgeServer(config, {
    hookdeck: new HookdeckClient({ apiKey: 'k', fetch: gateway.fetch }),
    ...(store && { store }),
    // The subscriber's receiver is local; stand in for Event Gateway's challenge answer.
    subscriptionOverrides: { verify: async () => ({ ok: true }), transport: createNodeCallbackTransport({ allowNonPublic: true }) },
    log: (m) => logs.push(m),
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

/** What Event Gateway does with a published request: deliver its headers and body to the callback. */
async function deliverPublished(gateway: FakeEventGateway, subscriber: Subscriber) {
  const receiverPort = ((subscriber as unknown as { receiver: { address(): { port: number } } }).receiver.address()).port;
  for (const published of gateway.published.splice(0)) {
    await fetch(`http://127.0.0.1:${receiverPort}/`, { method: 'POST', headers: published.headers, body: published.body });
  }
}

/** The fixture, as an email that just arrived (subscriptions made after an event don't receive it). */
const freshEmail = () => ({ ...fixture.body, data: { ...(fixture.body.data as object), created_at: new Date(Date.now() + 1000).toISOString() } });

async function postInbound(port: number, body: unknown = freshEmail()) {
  const raw = JSON.stringify(body);
  const signature = createHmac('sha256', SIGNING_SECRET).update(raw).digest('base64');
  return fetch(`http://127.0.0.1:${port}/inbound/resend`, { method: 'POST', headers: { ...fixture.headers, 'x-hookdeck-signature': signature }, body: raw });
}

describe('bridge server', () => {
  it('serves MCP only at the secret path', async () => {
    const { port } = await startBridge();
    expect((await fetch(`http://127.0.0.1:${port}/mcp/wrong`, { method: 'POST' })).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST' })).status).toBe(404);
    expect(redactPath(`/mcp/${MCP_SECRET}`)).toBe('/mcp/<secret>');
  });

  it('delivers a Resend email end to end, with webhook-id equal to the svix-id', async () => {
    const { gateway, port, bridge } = await startBridge();
    const subscriber = await startSubscriber(port, { from: 'Sender@Example.com' });
    expect(bridge.store.list()).toHaveLength(1);
    expect([...gateway.connections.values()].map((c) => c.name)).toEqual([`mcp-sub-${subscriber.subscription!.id}`]);

    expect((await postInbound(port)).status).toBe(200);
    await deliverPublished(gateway, subscriber);
    expect(subscriber.events).toHaveLength(1);
    expect(subscriber.events[0]).toMatchObject({ eventId: fixture.headers['svix-id'], name: 'resend.email.received', data: { fromAddress: 'sender@example.com' } });
  });

  it('lists providers with their MCP event names and how many subscriptions each has', async () => {
    const { port } = await startBridge();
    await startSubscriber(port);
    const client = new Client({ name: 'test', version: '0.0.0' }, { versionNegotiation: { mode: 'auto' } });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp/${MCP_SECRET}`)));
    try {
      const result = (await client.callTool({ name: 'list_providers', arguments: {} })) as { structuredContent?: { providers: unknown[] } };
      expect(result.structuredContent?.providers).toEqual([{ id: 'resend', type: 'resend', events: ['resend.email.received'], subscriptions: 1 }]);
    } finally {
      await client.close();
    }
  });

  it('logs a subscription to an event from before {id}.{event} naming, with the name to use now', async () => {
    const store = new MemoryStore();
    await store.put({
      id: 'sub_old', principal: 'owner', name: 'email.received', providerId: null, arguments: {}, url: 'https://receiver.example.com/hook',
      secret: generateWebhookSecret(), previousSecret: null, previousSecretExpiresAt: null, delivery: healthyDelivery(),
      expiresAt: '2099-01-01T00:00:00.000Z', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
    });
    const { logs } = await startBridge({ store });
    expect(logs).toContain('subscription sub_old ("email.received") is from before 0.2.0 and gets nothing; the client needs to subscribe to "resend.email.received"');
  });

  it('applies the from filter', async () => {
    const { gateway, port } = await startBridge();
    const subscriber = await startSubscriber(port, { from: 'someone-else@example.com' });
    await postInbound(port);
    await deliverPublished(gateway, subscriber);
    expect(subscriber.events).toHaveLength(0);
  });

  it('creates tunnel URLs for local agents over MCP, without exposing any secret', async () => {
    const { port, gateway } = await startBridge();
    const client = new Client({ name: 'test', version: '0.0.0' }, { versionNegotiation: { mode: 'auto' } });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp/${MCP_SECRET}`)));
    try {
      const tools = (await client.listTools()).tools.map((t) => t.name);
      expect(tools).toEqual(expect.arrayContaining(['create_tunnel_url', 'list_tunnel_urls']));
      expect(tools).not.toContain('retry_missed_deliveries');
      const result = (await client.callTool({ name: 'create_tunnel_url', arguments: { agent: 'laptop', name: 'email', port: 4000 } })) as {
        structuredContent?: Record<string, unknown>;
        content: Array<{ text?: string }>;
      };
      const source = [...gateway.sources.values()].find((s) => s.name === 'agent-laptop-email')!;
      expect(result.structuredContent).toEqual({ name: 'email', url: source.url, port: 4000, path: '/events' });
      const sourceSecret = (source.config as { auth: { webhook_secret_key: string } }).auth.webhook_secret_key;
      expect(JSON.stringify(result)).not.toContain(sourceSecret);
      expect(JSON.stringify(result)).not.toContain('whsec_');
    } finally {
      await client.close();
    }
  });

  it("doesn't offer tunnel URLs on a deployed bridge, which can't run hookdeck listen on the agent's machine", async () => {
    const { port } = await startBridge({ inbound: 'http' });
    const client = new Client({ name: 'test', version: '0.0.0' }, { versionNegotiation: { mode: 'auto' } });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp/${MCP_SECRET}`)));
    try {
      expect((await client.listTools()).tools.map((t) => t.name)).not.toContain('create_tunnel_url');
    } finally {
      await client.close();
    }
  });

  it('refuses an oversized inbound body before reading it all', async () => {
    const { port } = await startBridge();
    // Only the headers are sent: the bridge answers from the declared length and closes the connection.
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/inbound/resend', method: 'POST', headers: { 'Content-Length': String(11 * 1024 * 1024) } });
      req.on('response', (res) => resolve(res.statusCode));
      req.on('error', reject);
      req.flushHeaders();
    });
    expect(status).toBe(413);
  });

  it('rejects inbound requests without a Hookdeck signature', async () => {
    const { port } = await startBridge();
    expect((await fetch(`http://127.0.0.1:${port}/inbound/resend`, { method: 'POST', body: JSON.stringify(fixture.body) })).status).toBe(401);
  });

  it('unsubscribes, deleting the Event Gateway resources', async () => {
    const { gateway, port } = await startBridge();
    const subscriber = await startSubscriber(port);
    await subscriber.stop({ unsubscribe: true });
    expect(gateway.connections.size).toBe(0);
    expect(gateway.sources.size).toBe(0);
  });
});
