import { McpServer, type ServerCapabilities } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { CallbackInputError, DEFAULT_AGENT_PORT, DEFAULT_CALLBACK_PATH, type CallbackRecord, type CallbackRegistry } from './callbacks.js';
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
  /** Set when the bridge runs `hookdeck listen` for local agents: adds the tunnel URL tools. */
  callbacks?: CallbackRegistry;
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
      description:
        'Get a past event by its name and eventId (both are in every MCP Events delivery and in list_recent_events), read from Hookdeck Event Gateway.',
      inputSchema: z.object({
        name: z.string().describe('The event name, such as resend.email.received'),
        eventId: z.string(),
      }),
    },
    async ({ name, eventId }) => {
      const event = await history.get(name, eventId);
      return event ? json(event) : { content: [{ type: 'text', text: `No ${name} event ${eventId}` }], isError: true };
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
    { description: 'List the configured providers, their events, and how many subscriptions each has.', inputSchema: z.object({}) },
    async () => json({ providers: deps.providers() }),
  );

  const callbacks = deps.callbacks;
  if (callbacks) {
    const agent = z.string().describe('Your agent or machine name (letters, digits, _), e.g. "laptop". Names the shared Event Gateway destination.');
    const describe = (record: CallbackRecord) => ({ name: record.name, url: record.url, port: record.port, path: record.path });

    server.registerTool(
      'create_tunnel_url',
      {
        description:
          'For an agent on this machine without a public URL: create a public URL for one MCP Events webhook subscription, then call events/subscribe with it and a whsec_ secret you generate. ' +
          'Hookdeck Event Gateway receives deliveries at the URL (it answers the subscribe challenge and only accepts deliveries signed by this bridge), and the bridge forwards them to http://localhost:<port><path> through the Hookdeck CLI. ' +
          'Deliveries arrive signed with your secret, all on one local port and path; route them by X-MCP-Subscription-Id and dedupe by webhook-id. ' +
          'Deliveries missed while your agent or the forwarding was down are sent again automatically, freshly signed. ' +
          'Create one per subscription. A URL no subscription has used for an hour is deleted.',
        inputSchema: z.object({
          agent,
          name: z.string().describe('A name for this subscription (letters, digits, _), e.g. "email_from_alice".'),
          port: z.number().int().min(1).max(65535).optional().describe(`Local port your agent receives deliveries on. Set by your first URL (default ${DEFAULT_AGENT_PORT}) and shared by all of them.`),
          path: z.string().optional().describe(`Local path deliveries are forwarded to. Set by your first URL (default ${DEFAULT_CALLBACK_PATH}) and shared by all of them.`),
        }),
      },
      async ({ agent: name, name: urlName, port, path }) => {
        try {
          return json(describe(await callbacks.create({ agent: name, name: urlName, port, path })));
        } catch (error) {
          if (error instanceof CallbackInputError) return { content: [{ type: 'text', text: error.message }], isError: true };
          throw error;
        }
      },
    );

    server.registerTool(
      'list_tunnel_urls',
      { description: "List an agent's tunnel URLs.", inputSchema: z.object({ agent }) },
      async ({ agent: name }) => json({ tunnelUrls: callbacks.forAgent(name).map(describe) }),
    );
  }

  const anyParams = z.record(z.string(), z.unknown());
  server.server.setRequestHandler('events/list', { params: anyParams.optional() }, async () => ({ events: catalog.list() }));
  server.server.setRequestHandler('events/subscribe', { params: anyParams }, async (params) => ({
    ...(await subscriptions.subscribe(principal, params)),
  }));
  server.server.setRequestHandler('events/unsubscribe', { params: anyParams }, async (params) => subscriptions.unsubscribe(principal, params));

  return server;
}
