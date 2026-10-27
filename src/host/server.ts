import { timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { CallbackRegistry, type CallbackSettings } from '../core/callbacks.js';
import { Catalog, descriptionWarnings } from '../core/catalog.js';
import { assertCredentials, type ResolvedConfig } from '../core/config.js';
import { EventGatewayStore } from '../core/event-gateway-store.js';
import { EventHistory } from '../core/event-history.js';
import { HookdeckApiError, HookdeckClient, isSettled, SUBSCRIPTION_RETRY_RULE, WEBHOOK_ID_DEDUPE_RULE } from '../core/hookdeck.js';
import { buildMcpServer } from '../core/mcp.js';
import { Notifications } from '../core/notifications.js';
import { REPLAY_CONNECTION_PREFIX, REPLAY_SOURCE, replayConnectionName } from '../core/names.js';
import { placeSubscriptions } from '../core/placement.js';
import { PollService, type PollServiceDeps } from '../core/poll.js';
import { WebhookReplay } from '../core/replay.js';
import { ensureTransformations } from '../core/transformation.js';
import type { SubscriptionStore } from '../core/store.js';
import { SubscriptionService, type SubscriptionServiceDeps } from '../core/subscriptions.js';
import { createNodeCallbackTransport } from './callback-transport.js';

/** The largest inbound request body read. Provider webhooks are far smaller; this bounds what an unsigned request can make the bridge buffer. */
const MAX_INBOUND_BYTES = 10 * 1024 * 1024;

function tooLarge(req: http.IncomingMessage, res: http.ServerResponse) {
  res.writeHead(413, { 'Content-Type': 'application/json', Connection: 'close' }).end(JSON.stringify({ error: 'body too large' }));
  req.destroy();
}

/*
 * The bridge's single HTTP listener:
 *
 *   POST /inbound/hookdeck        Event Gateway issue notifications (events go from each source straight to
 *                                 subscribers, so this is all Event Gateway sends the bridge)
 *   /mcp                          the MCP endpoint, with Authorization: Bearer <BRIDGE_MCP_SECRET>
 *   /mcp/<secret>                 the same, with the secret in the URL instead, for clients that can't send a
 *                                 header (ChatGPT); off with auth.secretUrl: false. Either way, one principal: the owner
 *   GET /healthz
 *
 * Bound to 127.0.0.1 for CLI inbound (development), all interfaces for http inbound.
 */

export const OWNER = 'owner';

export interface BridgeServer {
  server: http.Server;
  subscriptions: SubscriptionService;
  store: SubscriptionStore;
  callbacks: CallbackRegistry;
  hookdeck: HookdeckClient;
  listen(): Promise<{ host: string; port: number }>;
  close(): Promise<void>;
}

export interface BridgeServerOptions {
  hookdeck?: HookdeckClient;
  store?: SubscriptionStore;
  subscriptionOverrides?: Partial<Pick<SubscriptionServiceDeps, 'verify' | 'transport' | 'now'>>;
  /** Poll mode overrides, for tests (a shorter look-back, a clock). */
  pollOverrides?: Partial<Pick<PollServiceDeps, 'lookbackMs' | 'now' | 'retentionMs'>>;
  callbackSettings?: Partial<CallbackSettings>;
  /**
   * Offer the callback URL tools for local agents. Only a bridge on the agent's machine can run `hookdeck listen`
   * for them (see host/local-runtime.ts). Default: on with CLI inbound, off with HTTP inbound.
   */
  localAgents?: boolean;
  /** Reported as the MCP server's version (`serverInfo.version`). */
  version?: string;
  log?: (message: string) => void;
}

const secretMatches = (given: string, expected: string) => {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

/** The token from `Authorization: Bearer <token>`, or null. */
export const bearerToken = (header: string | undefined) => /^Bearer\s+(\S+)\s*$/i.exec(header ?? '')?.[1] ?? null;

/** Paths for logs, with the MCP secret replaced. */
export const redactPath = (pathname: string) => pathname.replace(/^\/mcp\/[^/]+/, '/mcp/<secret>');

export async function createBridgeServer(config: ResolvedConfig, options: BridgeServerOptions = {}): Promise<BridgeServer> {
  const log = options.log ?? ((message: string) => console.log(`[bridge] ${message}`));
  assertCredentials(config);
  if (!config.auth.mcpSecret) throw new Error('BRIDGE_MCP_SECRET is not set; run `mcp-events-bridge setup` to generate one');
  const mcpSecret = config.auth.mcpSecret;

  const hookdeck = options.hookdeck ?? new HookdeckClient({ apiKey: config.hookdeck.apiKey });
  const catalog = new Catalog(config.sources);
  for (const warning of descriptionWarnings(catalog)) log(`warning: ${warning}`);
  const history = new EventHistory({ hookdeck, catalog, providers: config.sources });

  // Each subscription is a connection on its source, with the source's transformation (written here for this version
  // and config), a filter for its event and arguments, and the cursor's arguments hash.
  const transformations = options.store ? new Map<string, string>() : await ensureTransformations(hookdeck, config.sources, catalog);
  const place = placeSubscriptions({ catalog, sourceIdFor: (id) => history.sourceIdFor(id), transformations });
  const store = options.store ?? new EventGatewayStore(hookdeck, place);
  const loaded = await store.load();
  log(
    `loaded ${loaded.loaded} subscription(s) from Event Gateway${loaded.unreadable.length ? `; unreadable: ${loaded.unreadable.join(', ')}` : ''}` +
      (loaded.legacy ? `; ${loaded.legacy} from 0.7 or earlier, not served until migrated (run setup)` : ''),
  );

  const callbacks = new CallbackRegistry({
    hookdeck,
    // In use if a subscription's callback is the callback URL or a path under it.
    inUse: (url) => store.list().some((s) => s.url === url || s.url.startsWith(`${url}/`)),
    subscription: (id) => store.get(id),
    onDeleted: (url) => subscriptions.forgetVerification(url),
    settings: options.callbackSettings,
    log,
  });
  const ignoreNotFound = (error: unknown) => {
    if (!(error instanceof HookdeckApiError && error.status === 404)) throw error;
  };
  // A replay a restart interrupted: its connection goes, and so does the marker its deliveries' cursors carry.
  if (!options.store) {
    for (const connection of await hookdeck.listAllConnections()) {
      if (connection.name.startsWith(REPLAY_CONNECTION_PREFIX)) await hookdeck.deleteConnection(connection.id).catch(ignoreNotFound);
    }
  }
  for (const subscription of store.list()) {
    if (subscription.replay) await store.update(subscription.id, (current) => (current?.replay ? { ...current, replay: null } : null));
  }
  const loadedCallbacks = await callbacks.load();
  if (loadedCallbacks.loaded) log(`loaded ${loadedCallbacks.loaded} callback URL(s) for local agents`);
  if (loadedCallbacks.legacy) log(`${loadedCallbacks.legacy} callback URL(s) from 0.7 or earlier, not served until migrated (run setup)`);

  // Subscriptions to an event this bridge doesn't offer (a provider removed, an `id` renamed) get nothing; say so.
  for (const subscription of store.list()) {
    if (!catalog.get(subscription.name)) log(`subscription ${subscription.id} is for "${subscription.name}", which this bridge doesn't offer`);
  }
  const poll = new PollService({ hookdeck, catalog, history, ...options.pollOverrides });
  const notifications = new Notifications({ signingSecret: config.hookdeck.signingSecret, store, hookdeck, log });
  let replaySourceId: string | undefined;
  const replay = new WebhookReplay({
    poll,
    cursor: (subscription) =>
      subscription.replay ? poll.replayCursor(subscription.name, subscription.arguments, subscription.replay) : poll.webhookCursor(subscription.name, subscription.arguments),
    // A connection from the replay source to the subscription's own destination, so Event Gateway signs and retries.
    open: async (subscription) => {
      replaySourceId ??= (await hookdeck.upsertSource({ name: REPLAY_SOURCE, type: 'PUBLISH_API' })).id;
      const connection = await hookdeck.upsertConnection({
        name: replayConnectionName(subscription.id),
        source_id: replaySourceId,
        destination_id: subscription.destinationId,
        rules: [{ type: 'filter', headers: { 'x-mcp-subscription-id': subscription.id } }, WEBHOOK_ID_DEDUPE_RULE, SUBSCRIPTION_RETRY_RULE],
      });
      return connection.id;
    },
    publish: (subscription, envelope) =>
      hookdeck.publish(REPLAY_SOURCE, { 'content-type': 'application/json', 'webhook-id': envelope.eventId, 'x-mcp-subscription-id': subscription.id }, JSON.stringify(envelope)),
    settled: async (connectionId, count, timeoutMs) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5_000));
        const events = (await hookdeck.listEvents({ webhook_id: connectionId, limit: 250 }).catch(() => undefined))?.models;
        if (events && events.length >= count && events.every(isSettled)) return;
      }
    },
    close: (connectionId) => hookdeck.deleteConnection(connectionId).catch(ignoreNotFound),
    current: (id) => store.get(id),
    finish: (id) => store.update(id, (current) => (current?.replay ? { ...current, replay: null } : null)),
    log,
  });
  const subscriptions = new SubscriptionService({
    settings: config.subscriptions,
    store,
    catalog,
    transport: createNodeCallbackTransport(),
    callbacks,
    cursors: {
      watermark: (name, args) => poll.webhookCursor(name, args),
      check: (name, args, cursor) => poll.checkCursor(name, args, cursor),
      replay: (subscription, cursor) => replay.start(subscription, cursor),
    },
    log,
    ...options.subscriptionOverrides,
  });
  const sources = () =>
    config.sources.map((p) => {
      // MCP names, as in events/list and events/subscribe.
      const events = catalog.forProvider(p.id).map((e) => e.name);
      return { id: p.id, type: p.definition.type, events, subscriptions: store.list().filter((s) => events.includes(s.name)).length };
    });

  const localAgents = options.localAgents ?? config.inbound === 'cli';
  const mcp = toNodeHandler(
    createMcpHandler((ctx) =>
      buildMcpServer({ subscriptions, catalog, history, poll, sources, callbacks: localAgents ? callbacks : undefined, principal: ctx.authInfo?.clientId, version: options.version }),
    ),
  );

  const json = (res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(body));
  };
  const serveMcp = (req: http.IncomingMessage, res: http.ServerResponse) => {
    // The secret isn't kept on the request: the owner is the only principal.
    (req as http.IncomingMessage & { auth?: unknown }).auth = { token: '', clientId: OWNER, scopes: [] };
    return mcp(req, res);
  };
  const unauthorized = `Send Authorization: Bearer <BRIDGE_MCP_SECRET>${config.auth.secretUrl ? ', or use /mcp/<BRIDGE_MCP_SECRET>' : ''}`;

  const server = http.createServer(async (req, res) => {
    const { pathname } = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (pathname === '/mcp' || pathname === '/mcp/') {
        const token = bearerToken(req.headers.authorization);
        if (!token || !secretMatches(token, mcpSecret)) {
          return json(res, 401, { error: unauthorized }, { 'WWW-Authenticate': 'Bearer realm="mcp-events-bridge"' });
        }
        return await serveMcp(req, res);
      }
      const mcpMatch = config.auth.secretUrl ? /^\/mcp\/([^/]+)$/.exec(pathname) : null;
      if (mcpMatch) {
        if (!secretMatches(mcpMatch[1]!, mcpSecret)) return json(res, 404, { error: 'not found' });
        return await serveMcp(req, res);
      }

      if (pathname.startsWith('/inbound/') && req.method === 'POST') {
        // Bounded, since the body is read before its signature can be checked.
        if (Number(req.headers['content-length'] ?? 0) > MAX_INBOUND_BYTES) return tooLarge(req, res);
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
          size += (chunk as Buffer).length;
          if (size > MAX_INBOUND_BYTES) return tooLarge(req, res);
          chunks.push(chunk as Buffer);
        }
        const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]));
        const response = await notifications.handle(pathname, headers, Buffer.concat(chunks));
        return json(res, response.status, response.body);
      }

      if (pathname === '/healthz') return json(res, 200, { ok: true, deployment: config.deployment, subscriptions: store.list().length });
      json(res, 404, { error: 'not found' });
    } catch (error) {
      log(`request error on ${redactPath(pathname)}: ${(error as Error).message}`);
      if (!res.headersSent) json(res, 500, { error: 'internal error' });
    }
  });

  const sweeper = setInterval(() => {
    void subscriptions.sweep();
    void callbacks.sweep();
  }, config.subscriptions.sweepIntervalMs);
  sweeper.unref();
  const host = config.inbound === 'cli' ? '127.0.0.1' : '0.0.0.0';

  return {
    server,
    subscriptions,
    store,
    callbacks,
    hookdeck,
    listen: () =>
      new Promise((resolve) => server.listen(config.port, host, () => resolve({ host, port: (server.address() as { port: number }).port }))),
    close: () =>
      new Promise((resolve) => {
        clearInterval(sweeper);
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
