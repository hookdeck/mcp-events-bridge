import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Tunnel, bin, install } from 'cloudflared';
import { HookdeckClient } from '../src/core/hookdeck.js';
import { providerConnectionName, providerSourceName, subscriptionResourceName } from '../src/core/names.js';
import { NOTIFICATIONS_SOURCE } from '../src/core/setup.js';
import { loadConfig } from '../src/host/load-config.js';
import { createBridgeServer } from '../src/host/server.js';
import { Subscriber, type McpEvent } from '../test/support/subscriber.js';

/*
 * End-to-end check against real services:
 *
 *   Resend email -> Event Gateway (RESEND source) -> bridge
 *   -> Publish API -> Event Gateway (subscription connection) -> test subscriber
 *
 * Needs `npm run bridge -- setup` first, and .env with HOOKDECK_*, RESEND_*,
 * and BRIDGE_MCP_SECRET. Test subscribers' callbacks go through cloudflared
 * quick tunnels, because the MCP Events challenge needs a synchronous answer.
 *
 *   npm run e2e                                         local bridge, CLI inbound
 *   E2E_BRIDGE_URL=https://<app>.fly.dev npm run e2e    a deployed bridge
 *   E2E_EXTENDED=1 ...                                  also: a failed publish retried by Event
 *                                                       Gateway (local only), a duplicate provider
 *                                                       delivery, a 410 deleting a subscription, and
 *                                                       deliveryStatus for a failing callback
 */

process.loadEnvFile();
const env = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
};

const CLI_CONFIG = '.hookdeck/config.toml';
const REMOTE = process.env.E2E_BRIDGE_URL?.replace(/\/$/, '');
const EXTENDED = process.env.E2E_EXTENDED === '1';

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

const children: ChildProcess[] = [];
const tunnels: Array<ReturnType<typeof Tunnel.quick>> = [];
const subscribers: Subscriber[] = [];
let stopBridge: (() => Promise<void>) | undefined;

async function sendEmail(from: string, subject: string) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env('RESEND_API_KEY')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: [env('RESEND_INBOUND_ADDRESS')], subject, text: `${subject} (MCP Events bridge e2e)` }),
  });
  if (!res.ok) throw new Error(`Resend send failed: ${res.status} ${await res.text()}`);
}

/** A quick tunnel to a local port, once its DNS answers. */
async function openTunnel(port: number): Promise<string | undefined> {
  if (!fs.existsSync(bin)) await install(bin);
  const tunnel = Tunnel.quick(`http://localhost:${port}`);
  tunnels.push(tunnel);
  const url = await new Promise<string>((resolve) => tunnel.once('url', resolve));
  const reachable = await until(() => fetch(url, { signal: AbortSignal.timeout(5000) }).then(() => true, () => false), 120_000, 3000);
  return reachable ? url : undefined;
}

const subjectOf = (event: McpEvent) => String(event.data.subject ?? '');
const countSubject = (subscriber: Subscriber, subject: string) => subscriber.events.filter((e) => subjectOf(e) === subject).length;
const requestSubject = (r: { data?: { body?: unknown } | null }) => (r.data?.body as { data?: { subject?: string } } | undefined)?.data?.subject;

async function main() {
  const config = await loadConfig();
  const provider = config.providers[0]!;
  const hookdeck = new HookdeckClient({ apiKey: config.hookdeck.apiKey });
  const from = env('RESEND_TEST_FROM');
  const run = Date.now().toString(36);

  // 1. The bridge: a deployed one, or a local one with CLI inbound (and notifications through the CLI too).
  let bridgeUrl: string;
  let deployment = config.deployment;
  /** Local only: make the next publish to this subscription fail once. */
  let failNextPublishFor: string | undefined;
  if (REMOTE) {
    bridgeUrl = REMOTE;
    const health = (await fetch(`${REMOTE}/healthz`).then((r) => (r.ok ? r.json() : undefined), () => undefined)) as { deployment?: string } | undefined;
    record('deployed bridge healthy', Boolean(health), `${REMOTE}, deployment ${health?.deployment}`);
    if (!health) return;
    deployment = health.deployment ?? deployment;
  } else {
    const failing = new (class extends HookdeckClient {
      override async publish(sourceName: string, headers: Record<string, string>, body: string) {
        if (failNextPublishFor && headers['X-MCP-Subscription-Id'] === failNextPublishFor) {
          failNextPublishFor = undefined;
          throw new Error('e2e: forced publish failure');
        }
        return super.publish(sourceName, headers, body);
      }
    })({ apiKey: config.hookdeck.apiKey });
    const bridge = await createBridgeServer(config, { hookdeck: failing, log: (m) => console.log(`[bridge] ${m}`) });
    const { port } = await bridge.listen();
    stopBridge = () => bridge.close();
    bridgeUrl = `http://127.0.0.1:${port}`;

    spawnSync('hookdeck', ['ci', '--api-key', config.hookdeck.apiKey, '--hookdeck-config', CLI_CONFIG], { stdio: 'ignore' });
    const listens = [
      [providerSourceName(provider.id), providerConnectionName(provider.id, config.deployment)],
      [NOTIFICATIONS_SOURCE, `bridge-notifications-${config.deployment}`],
    ].map(([source, connection]) => {
      const listen = spawn('hookdeck', ['listen', String(port), source!, connection!, '--output', 'compact', '--device-name', 'e2e', '--hookdeck-config', CLI_CONFIG]);
      children.push(listen);
      let output = '';
      listen.stdout?.on('data', (chunk) => (output += chunk));
      return () => output.includes('Connected');
    });
    record('hookdeck listen connected (provider events and notifications)', Boolean(await until(() => listens.every((connected) => connected()), 30_000)));
  }
  const mcpUrl = `${bridgeUrl}/mcp/${config.auth.mcpSecret}`;

  // 2. Test subscribers, each with its own receiver and tunnel.
  const plan: Array<{ name: string; respondWith?: (e: McpEvent) => number }> = [
    { name: 'main' },
    ...(EXTENDED && !REMOTE ? [{ name: 'second' }] : []),
    ...(EXTENDED ? [{ name: 'gone', respondWith: () => 410 }, { name: 'failing', respondWith: () => 500 }] : []),
  ];
  const attempts = new Map<string, number[]>();
  const started = await Promise.all(
    plan.map(async ({ name, respondWith }, i) => {
      const port = 4300 + i;
      const tunnelUrl = await openTunnel(port);
      if (!tunnelUrl) return undefined;
      const subscriber = new Subscriber({
        serverUrl: mcpUrl,
        token: '',
        eventName: 'email.received',
        arguments: { from },
        receiverPort: port,
        publicCallbackUrl: tunnelUrl,
        respondWith,
        onAttempt: () => attempts.set(name, [...(attempts.get(name) ?? []), Date.now()]),
        log: (m) => console.log(`[subscriber:${name}] ${m}`),
      });
      const ok = await subscriber.start().then(
        () => true,
        (error: Error) => (console.log(`[subscriber:${name}] ${error.message}`), false),
      );
      if (!ok) return undefined;
      subscribers.push(subscriber);
      return [name, subscriber] as const;
    }),
  );
  const subs = new Map(started.filter((s): s is readonly [string, Subscriber] => Boolean(s)));
  record('subscribe, with the challenge answered through the tunnel', subs.size === plan.length, `${subs.size}/${plan.length} subscribers`);
  const main = subs.get('main');
  if (!main) return;

  // 3. A matching email.
  const subject = `e2e ${run}: matching sender`;
  const sentAt = Date.now();
  await sendEmail(from, subject);
  const received = await until(() => countSubject(main, subject) > 0, 240_000);
  record('email delivered to the subscriber', Boolean(received), received ? `${Math.round((Date.now() - sentAt) / 1000)}s` : 'timed out');
  if (!received) return;

  // Event Gateway's header search can lag a new request by a few seconds; retry for up to a minute.
  const webhookId = main.events.find((e) => subjectOf(e) === subject)!.eventId;
  const source = (await hookdeck.listSources({ name: providerSourceName(provider.id) })).models[0]!;
  const request = await until(
    async () => (await hookdeck.listRequests({ source_id: source.id, headers: { 'svix-id': webhookId }, limit: 1 })).models[0],
    60_000,
    3000,
  );
  record('webhook-id equals the Resend svix-id', Boolean(request), webhookId);

  const client = new Client({ name: 'e2e', version: '0.0.0' }, { versionNegotiation: { mode: 'auto' } });
  await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl)));
  type ToolResult = { structuredContent?: { data?: { subject?: string } } };
  const result = (await until(async () => {
    const r = (await client.callTool({ name: 'get_event', arguments: { eventId: webhookId } })) as ToolResult;
    return r.structuredContent?.data ? r : undefined;
  }, 60_000, 3000)) as ToolResult | undefined;
  record('get_event returns the summary', result?.structuredContent?.data?.subject === subject, result?.structuredContent?.data?.subject ?? 'none');
  await client.close();

  // 4. A non-matching sender is filtered out.
  const before = main.events.length;
  await sendEmail(from.replace(/^[^@]+/, 'bridge-other'), `e2e ${run}: other sender`);
  await wait(45_000);
  record('from filter drops other senders', main.events.length === before, `${main.events.length - before} extra event(s) after 45s`);

  if (EXTENDED) {
    await extended({
      hookdeck, subs, attempts, from, run, sourceId: source.id,
      inboundConnectionName: providerConnectionName(provider.id, deployment),
      failNextPublish: (id) => (failNextPublishFor = id),
    });
  }

  // 5. Unsubscribe removes the subscription's Event Gateway resources.
  const id = main.subscription!.id;
  await main.stop({ unsubscribe: true });
  subscribers.splice(subscribers.indexOf(main), 1);
  const left = (await hookdeck.listConnections({ name: subscriptionResourceName(id) })).models.length;
  record('unsubscribe deletes the subscription connection', left === 0);
}

async function extended(ctx: {
  hookdeck: HookdeckClient;
  subs: Map<string, Subscriber>;
  attempts: Map<string, number[]>;
  from: string;
  run: string;
  sourceId: string;
  inboundConnectionName: string;
  failNextPublish: (subscriptionId: string) => void;
}) {
  const { hookdeck, subs, attempts, from, run } = ctx;
  const main = subs.get('main')!;
  const second = subs.get('second');
  const gone = subs.get('gone');
  const failing = subs.get('failing');
  const findRequest = (subject: string) =>
    until(async () => (await hookdeck.listRequests({ source_id: ctx.sourceId, limit: 10, includeData: true })).models.find((r) => requestSubject(r) === subject), 60_000, 3000);
  const inboundConnection = (await hookdeck.listConnections({ name: ctx.inboundConnectionName })).models[0];
  /** This deployment's inbound event for a request (other deployments in the project get their own). */
  const inboundEventFor = (requestId: string, accept: (status: string) => boolean = () => true) =>
    until(async () => (await hookdeck.listEventsForRequest(requestId)).models.find((e) => e.webhook_id === inboundConnection?.id && accept(e.status)), 60_000, 3000);

  // A. A forced publish failure for one of two subscribers: the bridge answers 5xx, the inbound event is retried,
  //    and each subscriber gets the email once. Local only (the failure is injected). The retry is triggered by hand;
  //    Event Gateway's own, 10 minutes later, is deduped.
  const subject = `e2e ${run}: publish retry`;
  if (second) ctx.failNextPublish(second.subscription!.id);
  await sendEmail(from, subject);
  await until(() => countSubject(main, subject) > 0, 240_000);
  const request = await findRequest(subject);
  if (second && request) {
    const inboundEvent = await inboundEventFor(request.id, (status) => status !== 'SUCCESSFUL' && status !== 'QUEUED');
    record('a failed publish returns 5xx, so Event Gateway schedules a retry', Boolean(inboundEvent), inboundEvent ? `inbound event ${inboundEvent.status}` : 'none found');
    if (inboundEvent) await hookdeck.retryEvent(inboundEvent.id);
    await until(() => countSubject(second, subject) > 0, 120_000);
    await wait(15_000);
    record(
      'after the inbound retry, each subscriber has the email once',
      countSubject(main, subject) === 1 && countSubject(second, subject) === 1,
      `main ${countSubject(main, subject)}, second ${countSubject(second, subject)}`,
    );
  }

  // B. A duplicate provider delivery (the same svix-id delivered to the bridge again) doesn't reach a subscriber twice.
  //    Simulated by retrying this deployment's inbound event (Event Gateway only retries whole requests that were rejected or ignored).
  const inboundEvent = request && (await inboundEventFor(request.id));
  if (inboundEvent) {
    await until(async () => (await hookdeck.getEvent(inboundEvent.id)).status === 'SUCCESSFUL', 60_000, 3000);
    await hookdeck.retryEvent(inboundEvent.id);
    await wait(30_000);
    record('a duplicate provider delivery reaches the subscriber once', countSubject(main, subject) === 1, `${countSubject(main, subject)} copy(ies)`);
  } else {
    record('a duplicate provider delivery reaches the subscriber once', false, 'inbound event not found');
  }

  // C. A callback answering 410: the delivery issue makes the bridge delete the subscription.
  if (gone) {
    const id = gone.subscription!.id;
    const deleted = await until(async () => (await hookdeck.listConnections({ name: subscriptionResourceName(id) })).models.length === 0, 300_000, 5000);
    record('a 410 from the callback deletes the subscription', Boolean(deleted), `${(attempts.get('gone') ?? []).length} attempt(s)`);
    await gone.stop({ unsubscribe: false });
    subscribers.splice(subscribers.indexOf(gone), 1);
  }

  // D. A callback that keeps failing shows in deliveryStatus on the next refresh. Also measures Event Gateway's retry spacing.
  if (failing) {
    await until(() => (attempts.get('failing') ?? []).length >= 4, 600_000, 5000);
    const times = attempts.get('failing') ?? [];
    const gaps = times.slice(1).map((t, i) => Math.round((t - times[i]!) / 1000));
    console.log(`[e2e] failing callback: ${times.length} attempts, gaps ${gaps.join('s, ')}s`);
    const status = await until(async () => {
      const r = await failing.refresh();
      return r.deliveryStatus?.lastError ? r.deliveryStatus : undefined;
    }, 300_000, 15_000);
    record('a failing callback shows in deliveryStatus', status?.lastError === 'http_5xx', JSON.stringify(status ?? null));
    const span = times.length >= 2 ? times.at(-1)! - times[0]! : 0;
    record('retries stay inside the 5-minute signature window', times.length >= 2 && span < 5 * 60_000, `${times.length} attempts over ${Math.round(span / 1000)}s`);
  }
}

main()
  .catch((error) => record('e2e run', false, (error as Error).message))
  .finally(async () => {
    for (const subscriber of subscribers) await subscriber.stop({ unsubscribe: true }).catch(() => {});
    for (const child of children) child.kill('SIGINT');
    for (const tunnel of tunnels) tunnel.stop();
    await stopBridge?.();
    const failed = checks.filter((c) => !c.ok).length;
    console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
    process.exit(failed ? 1 : 0);
  });
