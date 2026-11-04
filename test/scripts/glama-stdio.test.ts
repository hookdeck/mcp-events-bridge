import { spawn } from 'node:child_process';
import path from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterEach, describe, expect, it } from 'vitest';
import { defineConfig, resolveConfig } from '../../src/core/config.js';
import { HookdeckClient } from '../../src/core/hookdeck.js';
import { generateWebhookSecret } from '../../src/core/secret.js';
import { createBridgeServer, type BridgeServer } from '../../src/host/server.js';
import { resend } from '../../src/sources.js';
import { FakeEventGateway } from '../support/fake-event-gateway.js';

const root = path.join(import.meta.dirname, '..', '..');
// Run as Glama's CMD does (tsx), with every outbound socket, DNS lookup and fetch blocked and reported on stderr.
const preload = path.join(root, 'test', 'support', 'no-network.mjs');
const args = ['--import', 'tsx', '--import', preload, path.join(root, 'scripts', 'glama', 'stdio.ts')];
const TOOLS = ['get_event', 'list_events', 'list_sources', 'poll_events', 'wait_for_event', 'create_callback_url', 'list_callback_urls'];

const running: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((r) => r.close()));
});

/** Resolves when a stream ends, or after timeoutMs: stderr is read only once the child has finished writing it. */
const ended = (stream: { once(event: 'end', listener: () => void): unknown } | null | undefined, timeoutMs = 3000) =>
  new Promise<void>((resolve) => {
    if (!stream) return resolve();
    stream.once('end', () => resolve());
    setTimeout(resolve, timeoutMs).unref();
  });

async function stdioClient() {
  const transport = new StdioClientTransport({ command: process.execPath, args, cwd: root, stderr: 'pipe' });
  let stderr = '';
  transport.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  const client = new Client({ name: 'glama-test', version: '0' });
  await client.connect(transport);
  running.push(client);
  /** Closes the client (which stops the child) and returns everything the child wrote to stderr. */
  const finish = async () => {
    const done = ended(transport.stderr);
    await client.close();
    await done;
    return stderr;
  };
  return { client, finish };
}

type RpcMessage = { id?: number; result?: Record<string, any>; error?: unknown };

/** A raw JSON-RPC session over the child's stdio, as mcp-proxy drives it. Only complete lines are parsed. */
function rawSession() {
  const child = spawn(process.execPath, args, { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
  running.push({ close: async () => void child.kill() });
  let buffer = '';
  let stderr = '';
  const messages: RpcMessage[] = [];
  const waiters: Array<() => void> = [];
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) if (line.trim()) messages.push(JSON.parse(line) as RpcMessage);
    for (const wake of waiters.splice(0)) wake();
  });
  const reply = async (id: number) => {
    for (;;) {
      const found = messages.find((m) => m.id === id);
      if (found) return found;
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
  };
  const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const open = async () => {
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mcp-proxy', version: '0' } } });
    const init = await reply(1);
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    return init;
  };
  /** Ends stdin, waits for the child to exit, and returns its stderr. */
  const finish = async () => {
    const exited = new Promise<void>((resolve) => child.once('close', () => resolve()));
    child.stdin.end();
    await exited;
    return stderr;
  };
  return { send, reply, open, finish };
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
    const { client, finish } = await stdioClient();
    const tools = (await client.listTools()).tools;
    expect(tools.map((t) => t.name)).toEqual(TOOLS);
    expect(tools).toEqual(await httpTools());
    expect(await finish()).not.toContain('NETWORK');
  });

  it('answers a tool call that needs Event Gateway with an error, still without the network', async () => {
    const { client, finish } = await stdioClient();
    const result = await client.callTool({ name: 'list_events', arguments: {} });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('no Hookdeck Event Gateway project');
    expect(await finish()).not.toContain('NETWORK');
  });

  it('serves a 2025-era initialize and tools/list, as mcp-proxy sends them', async () => {
    const session = rawSession();
    const init = await session.open();
    expect(init.result?.protocolVersion).toBe('2025-06-18');
    expect(init.result?.serverInfo.name).toBe('mcp-events-bridge');
    session.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect((await session.reply(2)).result?.tools.map((t: { name: string }) => t.name)).toEqual(TOOLS);
    expect(await session.finish()).not.toContain('NETWORK');
  });

  it("refuses events/subscribe without checking or challenging the caller's callback URL", async () => {
    const session = rawSession();
    await session.open();
    const delivery = { mode: 'webhook', url: 'https://receiver.example.com/hook', secret: generateWebhookSecret() };
    session.send({ jsonrpc: '2.0', id: 2, method: 'events/subscribe', params: { name: 'resend.email.received', arguments: {}, delivery } });
    expect((await session.reply(2)).error).toBeDefined();
    expect(await session.finish()).not.toContain('NETWORK');
  });
});

describe('the no-network preload (test/support/no-network.mjs)', () => {
  it('reports fetch, sockets and DNS, so the checks above can fail', async () => {
    const probe = [
      "fetch('https://example.com').catch(() => {});",
      "try { require('node:https').get('https://example.com'); } catch {}",
      "try { require('node:dns').resolve4('example.com', () => {}); } catch {}",
      "require('node:dns').promises.resolve('example.com').catch(() => {});",
    ].join(' ');
    const child = spawn(process.execPath, ['--import', preload, '-e', probe], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    await new Promise<void>((resolve) => child.once('close', () => resolve()));
    expect(stderr).toContain('NETWORK fetch https://example.com');
    expect(stderr).toContain('NETWORK socket');
    expect(stderr).toContain('NETWORK dns resolve4 example.com');
    expect(stderr).toContain('NETWORK dns resolve example.com');
  });
});
