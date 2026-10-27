import { timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { CallbackRegistry, type CallbackSettings } from '../core/callbacks.js';
import { Catalog, descriptionWarnings } from '../core/catalog.js';
import { assertCredentials, type ResolvedConfig } from '../core/config.js';
import { EventGatewayStore, type PlaceSubscription } from '../core/event-gateway-store.js';
import { EventHistory } from '../core/event-history.js';
import { connectionFilterRule } from '../core/filter.js';
import { HookdeckClient, isSettled } from '../core/hookdeck.js';
import { buildMcpServer } from '../core/mcp.js';
import { providerSourceName } from '../core/names.js';
import { Notifications } from '../core/notifications.js';
import { argumentsHash, PollService, type PollServiceDeps } from '../core/poll.js';
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
   * Offer the tunnel URL tools for local agents. Only a bridge on the agent's machine can run `hookdeck listen`
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
  const place: PlaceSubscription = async (name, args) => {
    const entry = catalog.get(name);
    if (!entry) throw new Error(`${name} isn't offered`);
    const sourceId = await history.sourceIdFor(entry.providerId);
    if (!sourceId) throw new Error(`source ${providerSourceName(entry.providerId)} not found: run setup`);
    const transformationId = transformations.get(entry.providerId);
    if (!transformationId) throw new Error(`no transformation for ${entry.providerId}`);
    return { sourceId, transformationId, filter: connectionFilterRule(name, entry.event.filter(args)), cursorArgs: argumentsHash(args) };
  };
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
  const loadedCallbacks = await callbacks.load();
  if (loadedCallbacks.loaded) log(`loaded ${loadedCallbacks.loaded} callback URL(s) for local agents`);
  if (loadedCallbacks.legacy) log(`${loadedCallbacks.legacy} callback URL(s) from 0.7 or earlier, not served until migrated (run setup)`);

  // Subscriptions to an event this bridge doesn't offer (a provider removed, an `id` renamed) get nothing; say so.
  for (const subscription of store.list()) {
    if (!catalog.get(subscription.name)) log(`subscription ${subscription.id} is for "${subscription.name}", which this bridge doesn't offer`);
  }
  const poll = new PollService({ hookdeck, catalog, history, ...options.pollOverrides });
  const notifications = new Notifications({ signingSecret: config.hookdeck.signingSecret, store, hookdeck, log });
  const replay = new WebhookReplay({
    poll,
    retry: (requestId, connectionId) => hookdeck.retryRequest(requestId, [connectionId]),
    settled: async (eventIds, timeoutMs) => {
      const deadline = Date.now() + timeoutMs;
      let pending = eventIds;
      while (pending.length && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5_000));
        const states = await Promise.all(pending.map((id) => hookdeck.getEvent(id).then(isSettled, () => true)));
        pending = pending.filter((_, i) => !states[i]);
      }
    },
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
