import { afterEach } from 'vitest';
import { defineConfig, resolveConfig } from '../../src/core/config.js';
import { HookdeckClient } from '../../src/core/hookdeck.js';
import { MemoryStore } from '../../src/core/memory-store.js';
import { createBridgeServer, type BridgeServerOptions } from '../../src/host/server.js';
import { resend } from '../../src/sources.js';
import { FakeEventGateway } from './fake-event-gateway.js';

/** A bridge with a fake Event Gateway and its log lines, for the trace and list-changed tests. */

export const MCP_SECRET = 'test-mcp-secret-0123456789';
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

