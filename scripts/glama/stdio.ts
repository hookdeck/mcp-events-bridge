/**
 * A stdio entry point for Glama's build, so Glama can introspect the bridge (tools/list) and compute its quality score.
 *
 * Glama runs servers over stdio, through mcp-proxy, in a sandbox with no credentials. The bridge itself serves MCP over
 * HTTP and needs a Hookdeck project, so this entry builds the bridge's real MCP server (the same `createBridgeServer`
 * wiring `serve` uses) from a placeholder config, with a stub Event Gateway client that makes no network calls, and
 * serves it over stdio. Tool definitions are the real ones; a tool call that needs Event Gateway returns an error
 * saying so. It is not a way to run the bridge: use `mcp-events-bridge serve` for that.
 *
 *   npx tsx scripts/glama/stdio.ts
 *
 * Logs go to stderr: stdout carries only MCP messages.
 */
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { defineConfig, env, resolveConfig } from '../../src/core/config.js';
import type { CallbackTransport } from '../../src/core/callback.js';
import { HookdeckClient } from '../../src/core/hookdeck.js';
import { MemoryStore } from '../../src/core/memory-store.js';
import { github, resend, source } from '../../src/sources.js';
import { createBridgeServer, OWNER } from '../../src/host/server.js';

const log = (message: string) => process.stderr.write(`[glama] ${message}\n`);

/** A source of each kind (a built-in provider, an Event Gateway source type and a generic webhook), so events/list and list_sources have content. */
export const introspectionConfig = defineConfig({
  inbound: 'cli',
  sources: [
    resend({ apiKey: env('RESEND_API_KEY'), events: ['email.received'] }),
    github({ webhookSecret: env('GITHUB_WEBHOOK_SECRET') }),
    source({
      id: 'fills',
      type: 'webhook',
      verification: { type: 'hmac', algorithm: 'sha256', encoding: 'hex', header: 'x-signature', secret: env('FILLS_WEBHOOK_SECRET') },
      events: { 'order.filled': { description: 'An order on my trading server filled.' } },
      eventId: { header: 'x-delivery-id' },
      occurredAt: { field: 'filled_at' },
      filters: ['symbol', 'side'],
    }),
  ],
});

/** Placeholder values only: the process environment is never read, so no real key reaches this server. */
export const PLACEHOLDER_ENV: Record<string, string> = {
  HOOKDECK_API_KEY: 'placeholder',
  HOOKDECK_SIGNING_SECRET: 'placeholder',
  BRIDGE_MCP_SECRET: 'placeholder',
  RESEND_API_KEY: 'placeholder',
  GITHUB_WEBHOOK_SECRET: 'placeholder',
  FILLS_WEBHOOK_SECRET: 'placeholder',
};

export class OfflineError extends Error {
  constructor() {
    super("This is the bridge's introspection build (scripts/glama), with no Hookdeck Event Gateway project, so this request can't run. Run mcp-events-bridge serve to use the bridge.");
  }
}

/**
 * A HookdeckClient with every method replaced: listing connections returns none (startup lists callback URLs), and
 * anything else rejects with OfflineError. Nothing reaches the network.
 */
export function offlineHookdeck(): HookdeckClient {
  const stub: Record<string, unknown> = {};
  for (const method of Object.getOwnPropertyNames(HookdeckClient.prototype)) {
    if (method !== 'constructor') stub[method] = () => Promise.reject(new OfflineError());
  }
  stub.listAllConnections = async () => [];
  return Object.setPrototypeOf(stub, HookdeckClient.prototype) as HookdeckClient;
}

/** events/subscribe checks and challenges the caller's callback URL; here both reject, so it fails without the network. */
const offlineCallbacks: CallbackTransport = {
  assertPublicHost: () => Promise.reject(new OfflineError()),
  post: () => Promise.reject(new OfflineError()),
};

export async function introspectionServer() {
  const version = (JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version;
  return createBridgeServer(resolveConfig(introspectionConfig, PLACEHOLDER_ENV), {
    hookdeck: offlineHookdeck(),
    // An in-memory store, so startup doesn't load subscriptions or write transformations.
    store: new MemoryStore(),
    // The callback URL tools are offered by a bridge on the agent's machine (CLI inbound), so list them too.
    localAgents: true,
    subscriptionOverrides: { transport: offlineCallbacks, verify: () => Promise.reject(new OfflineError()) },
    version,
    // The bridge's startup line says it loaded subscriptions "from Event Gateway"; here they come from an empty store.
    log: (message) => log(message.replace(/ from Event Gateway/, ' (introspection build: an empty in-memory store)')),
  });
}

const isMain = () => {
  try {
    return !!process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
  } catch {
    return false; // argv[1] isn't a file (for example a path without its extension): not run directly.
  }
};

if (isMain()) {
  const bridge = await introspectionServer();
  // The HTTP listener is never started, and the sweeper timer is unref'd, so stdin alone keeps the process alive.
  serveStdio(() => bridge.mcpServer(OWNER), { onerror: (error) => log(`stdio error: ${error.message}`) });
  log('serving the bridge MCP server over stdio for introspection (no Event Gateway project)');
}
