import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { legacyInitialize, MCP_SECRET, startTestBridge } from '../support/trace-bridge.js';

/*
 * BRIDGE_LIST_CHANGED_TEST (docs/list-changed-test.md): the probes, listChanged, the two notification streams the
 * MCP SDK doesn't serve (a 2026-07-28 subscriptions/listen with eventsListChanged, and a 2025-era GET), and the
 * trigger that changes a list while the bridge runs.
 */

const anyResult = z.record(z.string(), z.unknown());
const SUBSCRIPTION_ID = 'io.modelcontextprotocol/subscriptionId';

/** Reads JSON-RPC messages from an SSE response as they arrive. */
function sseReader(response: Response) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const messages: Array<Record<string, any>> = [];
  let buffer = '';
  let done = false;
  const pump = (async () => {
    for (;;) {
      const { value, done: finished } = await reader.read();
      if (finished) {
        done = true;
        return;
      }
      buffer += decoder.decode(value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const data = buffer
          .slice(0, end)
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trim())
          .join('\n');
        buffer = buffer.slice(end + 2);
        if (data) messages.push(JSON.parse(data));
      }
    }
  })().catch(() => {
    done = true;
  });
  return {
    messages,
    get done() {
      return done;
    },
    async waitFor(count: number, timeoutMs = 2_000) {
      const deadline = Date.now() + timeoutMs;
      while (messages.length < count && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
      return messages.slice(0, count);
    },
    async waitForEnd(timeoutMs = 2_000) {
      await Promise.race([pump, new Promise((r) => setTimeout(r, timeoutMs))]);
      return done;
    },
    cancel: () => reader.cancel().catch(() => {}),
  };
}

async function modernClient(url: string) {
  const client = new Client({ name: 'list-changed-test', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  return client;
}

const listen = (url: string, notifications: Record<string, unknown>, id: string | number = 'listen-1') =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'subscriptions/listen' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'subscriptions/listen',
      params: {
        notifications,
        _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': { name: 'listen-test', version: '1.0' }, 'io.modelcontextprotocol/clientCapabilities': {} },
      },
    }),
  });

const bump = async (port: number, lists: string, token = MCP_SECRET) =>
  fetch(`http://127.0.0.1:${port}/debug/list-changed?lists=${lists}`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });

describe('list-changed test (BRIDGE_LIST_CHANGED_TEST)', () => {
  it('is off by default: no probes, no listChanged for events, no trigger', async () => {
    const { url, port } = await startTestBridge();
    const client = await modernClient(url);
    const discover = await client.request({ method: 'server/discover', params: {} }, anyResult);
    expect((discover.capabilities as any).events).toEqual({});
    const events = (await client.request({ method: 'events/list', params: {} } as never, anyResult)).events as Array<{ name: string }>;
    expect(events.map((e) => e.name)).not.toContain('debug.probe_1');
    expect((await client.listTools()).tools.map((t) => t.name)).not.toContain('debug_probe_1');
    expect((await bump(port, 'both')).status).toBe(404);
    await client.close();
  });

  it('declares listChanged for events, in the extension settings and the top-level capability', async () => {
    const { url } = await startTestBridge({ listChangedTest: true });
    const client = await modernClient(url);
    const { capabilities } = (await client.request({ method: 'server/discover', params: {} }, anyResult)) as { capabilities: any };
    expect(capabilities.extensions['io.modelcontextprotocol/events']).toEqual({ listChanged: true });
    expect(capabilities.events).toEqual({ listChanged: true });
    expect(capabilities.tools).toEqual({ listChanged: true });
    await client.close();

    const legacy = await legacyInitialize(url);
    expect(await legacy.text()).toContain('"events":{"listChanged":true}');
  });

  it('acknowledges eventsListChanged and toolsListChanged on subscriptions/listen, and sends each list change to it', async () => {
    const { url, port, traces } = await startTestBridge({ listChangedTest: true });
    const stream = sseReader(await listen(url, { toolsListChanged: true, eventsListChanged: true, promptsListChanged: true }));
    const [ack] = await stream.waitFor(1);
    // Prompts aren't offered, so not honored.
    expect(ack).toEqual({
      jsonrpc: '2.0',
      method: 'notifications/subscriptions/acknowledged',
      params: { notifications: { toolsListChanged: true, eventsListChanged: true }, _meta: { [SUBSCRIPTION_ID]: 'listen-1' } },
    });

    const state = await (await fetch(`http://127.0.0.1:${port}/debug/list-changed`, { headers: { authorization: `Bearer ${MCP_SECRET}` } })).json();
    expect(state).toMatchObject({ event: 'debug.probe_1', tool: 'debug_probe_1', streams: [{ kind: 'subscriptions/listen', tools: true, events: true, subscriptionId: 'listen-1', clientInfo: { name: 'listen-test' } }] });

    expect(await (await bump(port, 'events')).json()).toMatchObject({ event: 'debug.probe_2', tool: 'debug_probe_1', notified: 1 });
    expect((await stream.waitFor(2))[1]).toEqual({ jsonrpc: '2.0', method: 'notifications/events/list_changed', params: { _meta: { [SUBSCRIPTION_ID]: 'listen-1' } } });
    await bump(port, 'tools');
    expect((await stream.waitFor(3))[2]).toMatchObject({ method: 'notifications/tools/list_changed' });

    // The lists follow: a client that re-fetches sees the new probes.
    const client = await modernClient(url);
    const events = (await client.request({ method: 'events/list', params: {} } as never, anyResult)).events as Array<{ name: string }>;
    expect(events.map((e) => e.name)).toContain('debug.probe_2');
    expect(events.map((e) => e.name)).not.toContain('debug.probe_1');
    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools).toContain('debug_probe_2');
    expect(tools).not.toContain('debug_probe_1');
    await client.close();
    stream.cancel();

    // The trace has the stream's request, the notifications sent on it, and what the client was given after.
    const lines = traces();
    const opened = lines.find((l) => l.dir === 'in' && l.stream === 'subscriptions/listen')!;
    expect(opened.rpc[0]).toMatchObject({ method: 'subscriptions/listen', notifications: { toolsListChanged: true, eventsListChanged: true, promptsListChanged: true } });
    expect(lines.filter((l) => l.dir === 'notify' && l.n === opened.n).map((l) => l.method)).toEqual([
      'notifications/subscriptions/acknowledged',
      'notifications/events/list_changed',
      'notifications/tools/list_changed',
    ]);
  });

  it('only sends what a listen opted in to, and closes one with nothing to honor at once', async () => {
    const { url, port } = await startTestBridge({ listChangedTest: true });
    const toolsOnly = sseReader(await listen(url, { toolsListChanged: true }, 7));
    await toolsOnly.waitFor(1);
    await bump(port, 'events');
    await bump(port, 'tools');
    const messages = await toolsOnly.waitFor(2);
    expect(messages.map((m) => m.method)).toEqual(['notifications/subscriptions/acknowledged', 'notifications/tools/list_changed']);
    toolsOnly.cancel();

    const nothing = sseReader(await listen(url, { resourcesListChanged: true }, 8));
    expect(await nothing.waitForEnd()).toBe(true);
    expect(nothing.messages).toEqual([
      { jsonrpc: '2.0', method: 'notifications/subscriptions/acknowledged', params: { notifications: {}, _meta: { [SUBSCRIPTION_ID]: 8 } } },
      { jsonrpc: '2.0', id: 8, result: { resultType: 'complete', _meta: { [SUBSCRIPTION_ID]: 8, 'io.modelcontextprotocol/serverInfo': { name: 'mcp-events-bridge', version: '9.9.9' } } } },
    ]);
  });

  it('serves a 2025-era GET stream, which gets both notifications', async () => {
    const { url, port, traces } = await startTestBridge({ listChangedTest: true });
    const response = await fetch(url, { headers: { accept: 'text/event-stream', 'mcp-protocol-version': '2025-06-18' } });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    const stream = sseReader(response);
    await new Promise((r) => setTimeout(r, 20));
    expect(await (await bump(port, 'both')).json()).toMatchObject({ notified: 1, streams: [{ kind: 'get', protocolVersion: '2025-06-18' }] });
    const messages = await stream.waitFor(2);
    expect(messages).toEqual([
      { jsonrpc: '2.0', method: 'notifications/events/list_changed', params: {} },
      { jsonrpc: '2.0', method: 'notifications/tools/list_changed', params: {} },
    ]);
    stream.cancel();
    await new Promise((r) => setTimeout(r, 20));
    const lines = traces();
    const opened = lines.find((l) => l.dir === 'in' && l.stream === 'get')!;
    expect(lines.find((l) => l.dir === 'stream-open' && l.n === opened.n)).toBeDefined();
    expect(lines.find((l) => l.dir === 'stream-close' && l.n === opened.n)).toMatchObject({ finished: false });
  });

  it('needs the bearer token to read or change the lists', async () => {
    const { port } = await startTestBridge({ listChangedTest: true });
    expect((await bump(port, 'both', 'wrong')).status).toBe(401);
    expect((await fetch(`http://127.0.0.1:${port}/debug/list-changed`)).status).toBe(401);
    expect((await bump(port, 'nonsense')).status).toBe(400);
  });

  it("can't subscribe to the probe event, and the attempt is traced", async () => {
    const { url, traces } = await startTestBridge({ listChangedTest: true });
    const client = await modernClient(url);
    await expect(
      client.request(
        {
          method: 'events/subscribe',
          params: { name: 'debug.probe_1', arguments: {}, delivery: { mode: 'webhook', url: 'https://receiver.example.com/hook', secret: 'whsec_dGVzdC1zZWNyZXQtdGVzdC1zZWNyZXQtMDE=' } },
        } as never,
        anyResult,
      ),
    ).rejects.toThrow();
    await client.close();
    const attempt = traces().find((l) => l.dir === 'in' && l.rpc?.[0]?.method === 'events/subscribe')!;
    expect(attempt.rpc[0]).toEqual(expect.objectContaining({ method: 'events/subscribe', name: 'debug.probe_1' }));
    expect(JSON.stringify(traces())).not.toContain('whsec_');
  });
});
