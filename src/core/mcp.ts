import { McpServer, type ServerCapabilities } from '@modelcontextprotocol/server';
import * as z from 'zod';
import type { Catalog } from './catalog.js';
import type { EventHistory } from './event-history.js';
import type { SubscriptionService } from './subscriptions.js';

/**
 * Builds the MCP server for one request (the 2026-07-28 revision is stateless,
 * so the SDK asks for a fresh instance per request). The SDK has no MCP Events
 * support, so the `events` capability and the three `events/*` methods are
 * registered by hand, as in mcp-events-outpost-demo.
 */
export function buildMcpServer(deps: {
  subscriptions: SubscriptionService;
  catalog: Catalog;
  history: EventHistory;
  providers: () => Array<Record<string, unknown>>;
  principal?: string;
  version?: string;
}): McpServer {
  const { subscriptions, catalog, history, principal } = deps;
  // `events` is not in the SDK's ServerCapabilities type yet, hence the cast.
  const capabilities = { events: {} } as ServerCapabilities;
  const server = new McpServer({ name: 'mcp-events-bridge', version: deps.version ?? '0.0.0' }, { capabilities });

  const json = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }], structuredContent: value as Record<string, unknown> });

  server.registerTool(
    'get_event',
    {
      description: 'Get a past event by its eventId (for example from an MCP Events delivery), read from Hookdeck Event Gateway.',
      inputSchema: z.object({ eventId: z.string() }),
    },
    async ({ eventId }) => {
      const event = await history.get(eventId);
      return event ? json(event) : { content: [{ type: 'text', text: `No event ${eventId}` }], isError: true };
    },
  );

  server.registerTool(
    'list_recent_events',
    {
      description: 'List recent events, newest first, optionally for one event name and since a time (ISO 8601).',
      inputSchema: z.object({ name: z.string().optional(), since: z.string().optional(), limit: z.number().int().min(1).max(100).optional() }),
    },
    async (args) => json({ events: await history.recent(args) }),
  );

  server.registerTool(
    'list_providers',
    { description: 'List the configured providers, their events, and their health.', inputSchema: z.object({}) },
    async () => json({ providers: deps.providers() }),
  );

  const anyParams = z.record(z.string(), z.unknown());
  server.server.setRequestHandler('events/list', { params: anyParams.optional() }, async () => ({ events: catalog.list() }));
  server.server.setRequestHandler('events/subscribe', { params: anyParams }, async (params) => ({
    ...(await subscriptions.subscribe(principal, params)),
  }));
  server.server.setRequestHandler('events/unsubscribe', { params: anyParams }, async (params) => subscriptions.unsubscribe(principal, params));

  return server;
}
