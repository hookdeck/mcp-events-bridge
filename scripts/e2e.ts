import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Tunnel, bin, install } from 'cloudflared';
import { HookdeckClient } from '../src/core/hookdeck.js';
import { providerConnectionName, providerSourceName } from '../src/core/names.js';
import { loadConfig } from '../src/host/load-config.js';
import { createBridgeServer } from '../src/host/server.js';
import { Subscriber } from '../test/support/subscriber.js';

/*
 * End-to-end check against real services (stage 5):
 *
 *   Resend email -> Event Gateway (RESEND source) -> hookdeck listen -> bridge
 *   -> Publish API -> Event Gateway (subscription connection) -> test subscriber
 *
 * Needs `npm run bridge -- setup` first, and .env with HOOKDECK_*, RESEND_*,
 * and BRIDGE_MCP_SECRET. The subscriber's callback goes through a cloudflared
 * quick tunnel, because the MCP Events challenge needs a synchronous answer.
 *
 *   npm run e2e
 */

process.loadEnvFile();
const env = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
};

const RECEIVER_PORT = 4300;
const CLI_CONFIG = '.hookdeck/config.toml';
const checks: Array<{ check: string; ok: boolean; detail: string }> = [];
const record = (check: string, ok: boolean, detail = '') => {
  checks.push({ check, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${check}${detail ? `: ${detail}` : ''}`);
};
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until<T>(fn: () => T | Promise<T>, timeoutMs: number, everyMs = 1000): Promise<T | undefined> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await wait(everyMs);
  }
  return undefined;
}

async function sendEmail(from: string, subject: string) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env('RESEND_API_KEY')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: [env('RESEND_INBOUND_ADDRESS')], subject, text: `${subject} (MCP Events bridge e2e)` }),
  });
  if (!res.ok) throw new Error(`Resend send failed: ${res.status} ${await res.text()}`);
}

const children: ChildProcess[] = [];
let tunnel: ReturnType<typeof Tunnel.quick> | undefined;
let subscriber: Subscriber | undefined;
let stopBridge: (() => Promise<void>) | undefined;

async function main() {
  const config = await loadConfig();
  const provider = config.providers[0]!;
  const hookdeck = new HookdeckClient({ apiKey: config.hookdeck.apiKey });

  // 1. The bridge, with CLI inbound.
  const bridge = await createBridgeServer(config, { log: (m) => console.log(`[bridge] ${m}`) });
  const { port } = await bridge.listen();
  stopBridge = () => bridge.close();

  spawnSync('hookdeck', ['ci', '--api-key', config.hookdeck.apiKey, '--hookdeck-config', CLI_CONFIG], { stdio: 'ignore' });
  const listen = spawn('hookdeck', [
    'listen', String(port), providerSourceName(provider.id), providerConnectionName(provider.id, config.deployment),
    '--output', 'compact', '--device-name', 'e2e', '--hookdeck-config', CLI_CONFIG,
  ]);
  children.push(listen);
  let listenOutput = '';
  listen.stdout?.on('data', (chunk) => (listenOutput += chunk));
  record('hookdeck listen connected', Boolean(await until(() => listenOutput.includes('Connected'), 30_000)));

  // 2. The subscriber's public callback.
  if (!fs.existsSync(bin)) await install(bin);
  tunnel = Tunnel.quick(`http://localhost:${RECEIVER_PORT}`);
  const tunnelUrl = await new Promise<string>((resolve) => tunnel!.once('url', resolve));

  // 3. Subscribe, filtered to the test sender.
  const from = env('RESEND_TEST_FROM');
  const webhookIds: string[] = [];
  subscriber = new Subscriber({
    serverUrl: `http://127.0.0.1:${port}/mcp/${config.auth.mcpSecret}`,
    token: '',
    eventName: 'email.received',
    arguments: { from },
    receiverPort: RECEIVER_PORT,
    publicCallbackUrl: tunnelUrl,
    onEvent: (_event, headers) => webhookIds.push(String(headers['webhook-id'])),
    log: (m) => console.log(`[subscriber] ${m}`),
  });
  // The quick tunnel's DNS takes a little while to appear: wait for any HTTP answer through it.
  const reachable = await until(() => fetch(tunnelUrl, { signal: AbortSignal.timeout(5000) }).then(() => true, () => false), 120_000, 3000);
  record('tunnel reachable', Boolean(reachable));
  if (!reachable) return;
  const subscribed = await subscriber.start().then(() => true, (error: Error) => (console.log(`[subscriber] ${error.message}`), false));
  record('subscribe (challenge answered through the tunnel)', subscribed, subscriber.subscription?.id ?? 'failed');
  if (!subscribed) return;

  // 4. A matching email.
  const started = Date.now();
  await sendEmail(from, 'Stage 5 e2e: matching sender');
  const received = await until(() => subscriber!.events.length > 0, 240_000);
  record('email delivered to the subscriber', Boolean(received), received ? `${Math.round((Date.now() - started) / 1000)}s` : 'timed out');
  if (received) {
    const webhookId = webhookIds[0]!;
    // Event Gateway's header search can lag a new request by a little; retry for up to a minute.
    const source = (await hookdeck.listSources({ name: providerSourceName(provider.id) })).models[0]!;
    const searchStarted = Date.now();
    const found = await until(
      async () => (await hookdeck.listRequests({ source_id: source.id, headers: { 'svix-id': webhookId }, limit: 1 })).models.length === 1,
      60_000,
      3000,
    );
    record('webhook-id equals the Resend svix-id', Boolean(found), `${webhookId} (found after ${Math.round((Date.now() - searchStarted) / 1000)}s)`);

    // 5. get_event over MCP.
    const client = new Client({ name: 'e2e', version: '0.0.0' }, { versionNegotiation: { mode: 'auto' } });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp/${config.auth.mcpSecret}`)));
    type ToolResult = { structuredContent?: { data?: { subject?: string } } };
    const result = ((await until(async () => {
      const r = (await client.callTool({ name: 'get_event', arguments: { eventId: webhookId } })) as ToolResult;
      return r.structuredContent?.data ? r : undefined;
    }, 60_000, 3000)) ?? {}) as ToolResult;
    record('get_event returns the summary', result.structuredContent?.data?.subject === 'Stage 5 e2e: matching sender', result.structuredContent?.data?.subject ?? 'none');
    await client.close();
  }

  // 6. A non-matching sender is filtered out.
  const other = from.replace(/^[^@]+/, 'bridge-other');
  const before = subscriber.events.length;
  await sendEmail(other, 'Stage 5 e2e: other sender');
  await wait(45_000);
  record('from filter drops other senders', subscriber.events.length === before, `${subscriber.events.length - before} extra event(s) after 45s`);

  // 7. Unsubscribe removes the subscription's Event Gateway resources.
  const id = subscriber.subscription!.id;
  await subscriber.stop({ unsubscribe: true });
  subscriber = undefined;
  const left = (await hookdeck.listConnections({ name: `mcp-sub-${id}` })).models.length;
  record('unsubscribe deletes the subscription connection', left === 0);
}

main()
  .catch((error) => record('e2e run', false, (error as Error).message))
  .finally(async () => {
    await subscriber?.stop({ unsubscribe: true }).catch(() => {});
    for (const child of children) child.kill('SIGINT');
    tunnel?.stop();
    await stopBridge?.();
    const failed = checks.filter((c) => !c.ok).length;
    console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
    process.exit(failed ? 1 : 0);
  });

