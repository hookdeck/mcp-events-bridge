import { afterEach, describe, expect, it } from 'vitest';
import * as z from 'zod';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { defineConfig, resolveConfig } from '../../src/core/config.js';
import { HookdeckClient } from '../../src/core/hookdeck.js';
import { MemoryStore } from '../../src/core/memory-store.js';
import { createBridgeServer, type BridgeServerOptions } from '../../src/host/server.js';
import { describeRpc } from '../../src/host/mcp-trace.js';
import { resend } from '../../src/sources.js';
import { FakeEventGateway } from '../support/fake-event-gateway.js';

const MCP_SECRET = 'test-mcp-secret-0123456789';
const running: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((r) => r.close()));
});

export async function startTestBridge(options: Partial<BridgeServerOptions> = {}) {
  const gateway = new FakeEventGateway();
  gateway.sources.set('src_resend', { id: 'src_resend', name: 'bridge-resend', type: 'RESEND', url: 'https://hkdk.events/src_resend' });
  const config = resolveConfig(defineConfig({ deployment: 'test', port: 0, inbound: 'http', publicUrl: 'https://bridge.example.com', sources: [resend({ apiKey: 'x' })] }), {
    HOOKDECK_API_KEY: 'k',
    HOOKDECK_SIGNING_SECRET: 'hookdeck-signing-secret',
    BRIDGE_MCP_SECRET: MCP_SECRET,
  });
  const logs: string[] = [];
  const bridge = await createBridgeServer(config, {
    hookdeck: new HookdeckClient({ apiKey: 'k', fetch: gateway.fetch }),
    store: new MemoryStore(),
    log: (m) => logs.push(m),
    version: '9.9.9',
    ...options,
  });
  const { port } = await bridge.listen();
  running.push(bridge);
  const traces = () => logs.filter((l) => l.startsWith('mcp-trace ')).map((l) => JSON.parse(l.slice('mcp-trace '.length)) as Record<string, any>);
  return { port, logs, traces, url: `http://127.0.0.1:${port}/mcp/${MCP_SECRET}` };
}

/** A 2025-era initialize, as ChatGPT and other pre-2026-07-28 clients send it. */
export const legacyInitialize = (url: string, protocolVersion = '2025-06-18') =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'user-agent': 'trace-test/1.0' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion, capabilities: {}, clientInfo: { name: 'legacy-test', version: '1.0' } } }),
  });

describe('MCP trace (BRIDGE_MCP_TRACE)', () => {
  it('is off by default', async () => {
    const { url, traces } = await startTestBridge();
    await (await legacyInitialize(url)).text();
    expect(traces()).toEqual([]);
  });

  it('logs a 2026-07-28 client: method, protocol version, clientInfo, and the tools and event types it was given', async () => {
    const { url, traces, logs } = await startTestBridge({ trace: true });
    const client = new Client({ name: 'trace-test-client', version: '1.2.3' }, { versionNegotiation: { mode: 'auto' } });
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    await client.listTools();
    await client.request({ method: 'events/list', params: {} } as never, z.record(z.string(), z.unknown()));
    await client.close();

    const lines = traces();
    const toolsList = lines.find((l) => l.dir === 'in' && l.rpc?.[0]?.method === 'tools/list')!;
    expect(toolsList.rpc[0]).toMatchObject({ protocolVersion: '2026-07-28', clientInfo: { name: 'trace-test-client', version: '1.2.3' } });
    expect(toolsList.path).toBe('/mcp/<BRIDGE_MCP_SECRET>');
    const toolsOut = lines.find((l) => l.dir === 'out' && l.n === toolsList.n)!;
    expect(toolsOut.results[0].tools).toContain('list_events');
    const eventsList = lines.find((l) => l.dir === 'in' && l.rpc?.[0]?.method === 'events/list')!;
    expect(lines.find((l) => l.dir === 'out' && l.n === eventsList.n)!.results[0].events).toContain('resend.email.received');
    expect(logs.join('\n')).not.toContain(MCP_SECRET);
  });

  it('logs a 2025-era initialize and the capabilities it was answered with, and a GET stream attempt', async () => {
    const { url, traces } = await startTestBridge({ trace: true });
    await (await legacyInitialize(url)).text();
    const get = await fetch(url, { headers: { accept: 'text/event-stream', 'mcp-protocol-version': '2025-06-18' } });
    await get.text();

    const lines = traces();
    const init = lines.find((l) => l.dir === 'in' && l.rpc?.[0]?.method === 'initialize')!;
    expect(init).toMatchObject({ http: 'POST', userAgent: 'trace-test/1.0', rpc: [{ protocolVersion: '2025-06-18', clientInfo: { name: 'legacy-test', version: '1.0' } }] });
    const initOut = lines.find((l) => l.dir === 'out' && l.n === init.n)!;
    // The SDK's registerTool declares tools.listChanged: true by default, so the bridge already claims it.
    expect(initOut.results[0].capabilities).toMatchObject({ events: {}, tools: { listChanged: true } });

    const stream = lines.find((l) => l.dir === 'in' && l.http === 'GET')!;
    expect(stream).toMatchObject({ stream: 'get', accept: 'text/event-stream', mcpProtocolVersion: '2025-06-18' });
    // Without BRIDGE_LIST_CHANGED_TEST the SDK's stateless legacy serving refuses the GET stream.
    expect(lines.find((l) => l.dir === 'out' && l.n === stream.n)).toMatchObject({ status: 405 });
  });

  it("never records a subscriber's secret or event arguments", () => {
    const traced = describeRpc({
      jsonrpc: '2.0',
      id: 3,
      method: 'events/subscribe',
      params: { name: 'resend.email.received', arguments: { from: 'alice@example.com' }, delivery: { mode: 'webhook', url: 'https://x', secret: 'whsec_c2VjcmV0' } },
    });
    expect(traced).toEqual({ method: 'events/subscribe', id: 3, name: 'resend.email.received' });
  });
});
