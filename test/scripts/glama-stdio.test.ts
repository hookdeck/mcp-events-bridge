import { spawn } from 'node:child_process';
import path from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterEach, describe, expect, it } from 'vitest';
import { defineConfig, resolveConfig } from '../../src/core/config.js';
import { HookdeckClient } from '../../src/core/hookdeck.js';
import { createBridgeServer, type BridgeServer } from '../../src/host/server.js';
import { resend } from '../../src/sources.js';
import { FakeEventGateway } from '../support/fake-event-gateway.js';

const root = path.join(import.meta.dirname, '..', '..');
// Run as Glama's CMD does (tsx), with every outbound socket, DNS lookup and fetch blocked and reported on stderr.
const args = ['--import', 'tsx', '--import', path.join(root, 'test', 'support', 'no-network.mjs'), path.join(root, 'scripts', 'glama', 'stdio.ts')];
const TOOLS = ['get_event', 'list_events', 'list_sources', 'poll_events', 'wait_for_event', 'create_callback_url', 'list_callback_urls'];

const running: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((r) => r.close()));
});

async function stdioClient() {
  const transport = new StdioClientTransport({ command: process.execPath, args, cwd: root, stderr: 'pipe' });
  let stderr = '';
  transport.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  const client = new Client({ name: 'glama-test', version: '0' });
  await client.connect(transport);
  running.push(client);
  return { client, stderr: () => stderr };
}

/** The tools a bridge with CLI inbound serves over HTTP, with a fake Event Gateway. */
async function httpTools() {
  const gateway = new FakeEventGateway();
  const config = resolveConfig(defineConfig({ port: 0, inbound: 'cli', sources: [resend({ apiKey: 'x' })] }), {
    HOOKDECK_API_KEY: 'k',
    HOOKDECK_SIGNING_SECRET: 's',
    BRIDGE_MCP_SECRET: 'secret',
  });
  const bridge: BridgeServer = await createBridgeServer(config, { hookdeck: new HookdeckClient({ apiKey: 'k', fetch: gateway.fetch }), log: () => {}, version: '9.9.9' });
  const { port } = await bridge.listen();
  running.push(bridge);
  const client = new Client({ name: 'glama-test', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp/secret`)));
  running.push(client);
  return (await client.listTools()).tools;
}

describe('the Glama stdio entry (scripts/glama/stdio.ts)', () => {
  it('lists the same tool definitions as the bridge serves over HTTP, with no network calls', async () => {
    const { client, stderr } = await stdioClient();
    const tools = (await client.listTools()).tools;
    expect(tools.map((t) => t.name)).toEqual(TOOLS);
    expect(tools).toEqual(await httpTools());
    expect(stderr()).not.toContain('NETWORK');
  });

  it('answers a tool call that needs Event Gateway with an error, still without the network', async () => {
    const { client, stderr } = await stdioClient();
    const result = await client.callTool({ name: 'list_events', arguments: {} });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('no Hookdeck Event Gateway project');
    expect(stderr()).not.toContain('NETWORK');
  });

  it('serves a 2025-era initialize, as mcp-proxy sends it', async () => {
    const child = spawn(process.execPath, args, { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
    running.push({ close: async () => void child.kill() });
    let stdout = '';
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const listed = new Promise<{ result: { tools: Array<{ name: string }> } }>((resolve) => {
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
        const reply = stdout.split('\n').filter(Boolean).map((line) => JSON.parse(line)).find((m) => m.id === 2);
        if (reply) resolve(reply);
      });
    });
    const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mcp-proxy', version: '0' } } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const reply = await listed;
    expect(reply.result.tools.map((t) => t.name)).toEqual(TOOLS);
    const init = stdout.split('\n').filter(Boolean).map((line) => JSON.parse(line)).find((m) => m.id === 1);
    expect(init.result.protocolVersion).toBe('2025-06-18');
    expect(init.result.serverInfo.name).toBe('mcp-events-bridge');
    expect(stderr).not.toContain('NETWORK');
  });
});
