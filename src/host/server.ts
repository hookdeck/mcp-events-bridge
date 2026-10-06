import { timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { Catalog } from '../core/catalog.js';
import type { ResolvedConfig } from '../core/config.js';
import { EventGatewayStore } from '../core/event-gateway-store.js';
import { EventHistory } from '../core/event-history.js';
import { HookdeckClient } from '../core/hookdeck.js';
import { buildMcpServer } from '../core/mcp.js';
import { Relay } from '../core/relay.js';
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
 *   POST /inbound/<instance id>   provider events from Event Gateway
 *   POST /inbound/hookdeck        Event Gateway issue notifications
 *   /mcp/<secret>                 the MCP endpoint (secret-URL auth; one principal, the owner)
 *   GET /healthz
 *
 * Bound to 127.0.0.1 for CLI inbound (development), all interfaces for http inbound.
 */

export const OWNER = 'owner';

export interface BridgeServer {
  server: http.Server;
  subscriptions: SubscriptionService;
  store: SubscriptionStore;
  listen(): Promise<{ host: string; port: number }>;
  close(): Promise<void>;
}

export interface BridgeServerOptions {
  hookdeck?: HookdeckClient;
  store?: SubscriptionStore;
  subscriptionOverrides?: Partial<Pick<SubscriptionServiceDeps, 'verify' | 'transport' | 'now'>>;
  log?: (message: string) => void;
}

const secretMatches = (given: string, expected: string) => {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

/** Paths for logs, with the MCP secret replaced. */
export const redactPath = (pathname: string) => pathname.replace(/^\/mcp\/[^/]+/, '/mcp/<secret>');

export async function createBridgeServer(config: ResolvedConfig, options: BridgeServerOptions = {}): Promise<BridgeServer> {
  const log = options.log ?? ((message: string) => console.log(`[bridge] ${message}`));
  if (!config.auth.mcpSecret) throw new Error('BRIDGE_MCP_SECRET is not set; run `mcp-events-bridge setup` to generate one');
  const mcpSecret = config.auth.mcpSecret;

  const hookdeck = options.hookdeck ?? new HookdeckClient({ apiKey: config.hookdeck.apiKey });
  const store = options.store ?? new EventGatewayStore(hookdeck);
  const loaded = await store.load();
  log(`loaded ${loaded.loaded} subscription(s) from Event Gateway${loaded.unreadable.length ? `; unreadable: ${loaded.unreadable.join(', ')}` : ''}`);

  const catalog = new Catalog(config.providers);
  const subscriptions = new SubscriptionService({
    settings: config.subscriptions,
    store,
    catalog,
    transport: createNodeCallbackTransport(),
    log,
    ...options.subscriptionOverrides,
  });
  const relay = new Relay({ signingSecret: config.hookdeck.signingSecret, providerIds: config.providers.map((p) => p.id), catalog, store, hookdeck, log });
  const history = new EventHistory({ hookdeck, catalog, providers: config.providers });
  const providers = () =>
    config.providers.map((p) => ({
      id: p.id,
      type: p.definition.type,
      events: p.events,
      subscriptions: store.list().filter((s) => p.events.includes(s.name)).length,
    }));

  const mcp = toNodeHandler(
    createMcpHandler((ctx) => buildMcpServer({ subscriptions, catalog, history, providers, principal: ctx.authInfo?.clientId })),
  );

  const json = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  };

  const server = http.createServer(async (req, res) => {
    const { pathname } = new URL(req.url ?? '/', 'http://localhost');
    try {
      const mcpMatch = /^\/mcp\/([^/]+)$/.exec(pathname);
      if (mcpMatch) {
        if (!secretMatches(mcpMatch[1]!, mcpSecret)) return json(res, 404, { error: 'not found' });
        (req as http.IncomingMessage & { auth?: unknown }).auth = { token: '', clientId: OWNER, scopes: [] };
        return await mcp(req, res);
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
        const response = await relay.handle(pathname, headers, Buffer.concat(chunks));
        return json(res, response.status, response.body);
      }

      if (pathname === '/healthz') return json(res, 200, { ok: true, deployment: config.deployment, subscriptions: store.list().length });
      json(res, 404, { error: 'not found' });
    } catch (error) {
      log(`request error on ${redactPath(pathname)}: ${(error as Error).message}`);
      if (!res.headersSent) json(res, 500, { error: 'internal error' });
    }
  });

  const sweeper = setInterval(() => void subscriptions.sweep(), config.subscriptions.sweepIntervalMs);
  sweeper.unref();
  const host = config.inbound === 'cli' ? '127.0.0.1' : '0.0.0.0';

  return {
    server,
    subscriptions,
    store,
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
