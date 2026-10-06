import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Tunnel, bin, install } from 'cloudflared';
import { HookdeckClient } from '../src/core/hookdeck.js';
import { providerConnectionName, providerSourceName, subscriptionResourceName } from '../src/core/names.js';
import { generateWebhookSecret } from '../src/core/secret.js';
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
 * and BRIDGE_MCP_SECRET. Each test subscriber's callback is its own Event
 * Gateway MCP Events source, which answers the subscribe challenge and verifies
 * deliveries, and `hookdeck listen` forwards them to the subscriber. Subscribers
 * that test status codes (410, 500) use a cloudflared quick tunnel instead: an
 * MCP Events source acknowledges deliveries itself, so the agent's status code
 * never reaches the bridge's delivery. E2E_CALLBACK=tunnel uses tunnels for all.
 *
 *   npm run e2e                                         local bridge, CLI inbound
 *   E2E_BRIDGE_URL=https://<app>.fly.dev npm run e2e    a deployed bridge
 *   E2E_GITHUB=1 ...                                    also: a push to the first repository in GITHUB_REPOS
 *                                                       (or E2E_GITHUB_REPO in manual mode), delivered to a
 *                                                       github.push subscriber. The push creates a temporary
 *                                                       branch e2e/bridge-<run> at the default branch's head
 *                                                       and deletes it after. Uses GITHUB_TOKEN (contents and
 *                                                       webhooks access)
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
const GITHUB = process.env.E2E_GITHUB === '1';
const CALLBACK: 'hookdeck' | 'tunnel' = process.env.E2E_CALLBACK === 'tunnel' ? 'tunnel' : 'hookdeck';

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
/** Event Gateway resources the run creates for subscriber callbacks, deleted at the end. */
const callbackResources: Array<{ connectionId: string; sourceId: string; destinationId: string }> = [];
let cleanupHookdeck: HookdeckClient | undefined;
let stopBridge: (() => Promise<void>) | undefined;

async function sendEmail(from: string, subject: string) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env('RESEND_API_KEY')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: [env('RESEND_INBOUND_ADDRESS')], subject, text: `${subject} (MCP Events bridge e2e)` }),
  });
  if (!res.ok) throw new Error(`Resend send failed: ${res.status} ${await res.text()}`);
}

/**
 * A subscriber callback through Event Gateway: an MCP Events source with the subscriber's secret (it answers
 * the challenge and verifies deliveries), a CLI connection, and `hookdeck listen` to the subscriber's port.
 */
async function mcpEventsCallback(hookdeck: HookdeckClient, run: string, name: string, port: number) {
  const secret = generateWebhookSecret();
  const resourceName = `e2e-sub-${run}-${name}`;
  const source = await hookdeck.upsertSource({ name: resourceName, type: 'MCP_EVENTS', config: { auth: { webhook_secret_key: secret } } });
  const connection = await hookdeck.upsertConnection({
    name: resourceName,
    source_id: source.id,
    destination: { name: resourceName, type: 'CLI', config: { path: `/mcp-events/${name}` } },
  });
  callbackResources.push({ connectionId: connection.id, sourceId: source.id, destinationId: connection.destination.id });
  const listen = spawn('hookdeck', ['listen', String(port), resourceName, resourceName, '--output', 'compact', '--device-name', `e2e-${name}`, '--hookdeck-config', CLI_CONFIG]);
  children.push(listen);
  let output = '';
  listen.stdout?.on('data', (chunk) => (output += chunk));
  const connected = await until(() => output.includes('Connected'), 30_000);
  return connected ? { url: source.url, secret } : undefined;
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
  const provider = config.providers.find((p) => p.definition.type === 'resend')!;
  const github = config.providers.find((p) => p.definition.type === 'github');
  if (GITHUB && !github) throw new Error('E2E_GITHUB=1 needs GitHub enabled in bridge.config.ts (GITHUB_REPOS or GITHUB_WEBHOOK_SECRET)');
  const hookdeck = new HookdeckClient({ apiKey: config.hookdeck.apiKey });
  const from = env('RESEND_TEST_FROM');
  const run = Date.now().toString(36);
  cleanupHookdeck = hookdeck;
  spawnSync('hookdeck', ['ci', '--api-key', config.hookdeck.apiKey, '--hookdeck-config', CLI_CONFIG], { stdio: 'ignore' });

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

    const listens = [
      [providerSourceName(provider.id), providerConnectionName(provider.id, config.deployment)],
      [NOTIFICATIONS_SOURCE, `bridge-notifications-${config.deployment}`],
      ...(GITHUB ? [[providerSourceName(github!.id), providerConnectionName(github!.id, config.deployment)]] : []),
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
  const githubRepo = GITHUB ? (process.env.E2E_GITHUB_REPO ?? (github!.options.scope as { repos?: string[] } | undefined)?.repos?.[0] ?? '') : '';
  if (GITHUB && !githubRepo) throw new Error('E2E_GITHUB=1 in manual mode needs E2E_GITHUB_REPO=owner/name');
  const plan: Array<{ name: string; eventName?: string; arguments?: Record<string, unknown>; respondWith?: (e: McpEvent) => number }> = [
    { name: 'main' },
    ...(GITHUB ? [{ name: 'github', eventName: 'github.push', arguments: { repository: githubRepo } }] : []),
    ...(EXTENDED && !REMOTE ? [{ name: 'second' }] : []),
    ...(EXTENDED ? [{ name: 'gone', respondWith: () => 410 }, { name: 'failing', respondWith: () => 500 }] : []),
  ];
  const attempts = new Map<string, number[]>();
  const started = await Promise.all(
    plan.map(async ({ name, eventName, arguments: args, respondWith }, i) => {
      const port = 4300 + i;
      // Status-code tests need the subscriber's own response, so they always use a tunnel.
      const via = respondWith || CALLBACK === 'tunnel' ? 'tunnel' : 'hookdeck';
      const callback =
        via === 'hookdeck'
          ? await mcpEventsCallback(hookdeck, run, name, port)
          : await openTunnel(port).then((url) => (url ? { publicCallbackUrl: url } : undefined));
      if (!callback) return undefined;
      console.log(`[subscriber:${name}] callback via ${via === 'hookdeck' ? 'an Event Gateway MCP Events source' : 'a cloudflared tunnel'}`);
      const subscriber = new Subscriber({
        serverUrl: mcpUrl,
        token: '',
        eventName: eventName ?? 'email.received',
        arguments: args ?? { from },
        receiverPort: port,
        ...('url' in callback ? { callbackUrl: callback.url, secret: callback.secret } : callback),
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
  const viaTunnel = plan.filter((p) => p.respondWith || CALLBACK === 'tunnel').length;
  record(
    'subscribe, with the challenge answered',
    subs.size === plan.length,
    `${subs.size}/${plan.length} subscribers (${plan.length - viaTunnel} by Event Gateway MCP Events sources, ${viaTunnel} through tunnels)`,
  );
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

  if (GITHUB) await githubPush({ hookdeck, subscriber: subs.get('github')!, repo: githubRepo, token: env('GITHUB_TOKEN'), sourceName: providerSourceName(github!.id), run });

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

/**
 * A fresh push: creates a temporary branch at the default branch's head, then deletes it. (GitHub's "test push"
 * redelivers the last real push, which predates the subscription, so the bridge rightly doesn't deliver it.)
 */
async function githubPush(ctx: { hookdeck: HookdeckClient; subscriber: Subscriber; repo: string; token: string; sourceName: string; run: string }) {
  const api = (path: string, method = 'GET', body?: unknown) =>
    fetch(`https://api.github.com/repos/${ctx.repo}${path}`, {
      method,
      headers: { Authorization: `Bearer ${ctx.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'mcp-events-bridge-e2e' },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
  const source = (await ctx.hookdeck.listSources({ name: ctx.sourceName })).models[0];
  const hooks = (await (await api('/hooks')).json()) as Array<{ id: number; config?: { url?: string } }>;
  const hook = Array.isArray(hooks) ? hooks.find((h) => h.config?.url === source?.url) : undefined;
  record('GitHub webhook registered at the Event Gateway source', Boolean(source && hook), ctx.repo);
  if (!source || !hook) return;

  const repo = (await (await api('')).json()) as { default_branch: string };
  const head = (await (await api(`/git/ref/heads/${repo.default_branch}`)).json()) as { object: { sha: string } };
  const branch = `e2e/bridge-${ctx.run}`;
  const sentAt = Date.now();
  const created = await api('/git/refs', 'POST', { ref: `refs/heads/${branch}`, sha: head.object.sha });
  let event: McpEvent | undefined;
  try {
    event = await until(() => ctx.subscriber.events.find((e) => e.data.ref === `refs/heads/${branch}`), 180_000);
  } finally {
    if (created.ok) await api(`/git/refs/heads/${branch}`, 'DELETE');
  }
  record('GitHub push delivered to the github.push subscriber', created.ok && Boolean(event), event ? `${Math.round((Date.now() - sentAt) / 1000)}s` : `create branch ${created.status}, timed out`);
  if (!event) return;
  const data = event.data as Record<string, unknown>;
  record(
    'summary from a real GitHub payload',
    data.repository === ctx.repo.toLowerCase() && typeof data.ref === 'string' && typeof data.url === 'string' && typeof data.sender === 'string',
    JSON.stringify({ repository: data.repository, ref: data.ref, commits: data.commits, sender: data.sender, url: data.url }),
  );
  const request = await until(
    async () => (await ctx.hookdeck.listRequests({ source_id: source.id, headers: { 'x-github-delivery': event.eventId }, limit: 1 })).models[0],
    60_000,
    3000,
  );
  record('Event Gateway verified the GitHub signature', (request as { verified?: boolean } | undefined)?.verified === true, `verified: ${String((request as { verified?: boolean } | undefined)?.verified)}`);
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
    for (const r of callbackResources) {
      await cleanupHookdeck?.deleteConnection(r.connectionId).catch(() => {});
      await cleanupHookdeck?.deleteDestination(r.destinationId).catch(() => {});
      await cleanupHookdeck?.deleteSource(r.sourceId).catch(() => {});
    }
    await stopBridge?.();
    const failed = checks.filter((c) => !c.ok).length;
    console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
    process.exit(failed ? 1 : 0);
  });
