import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { describeRpc } from '../../src/host/mcp-trace.js';
import { legacyInitialize, MCP_SECRET, startTestBridge } from '../support/trace-bridge.js';

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
