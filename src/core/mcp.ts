import { McpServer, type ServerCapabilities } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { CallbackInputError, DEFAULT_CALLBACK_PATH, type CallbackRecord, type CallbackRegistry } from './callbacks.js';
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
    { description: 'List the configured providers, their events, and how many subscriptions each has.', inputSchema: z.object({}) },
    async () => json({ providers: deps.providers() }),
  );

  const callbacks = deps.callbacks;
  if (callbacks) {
    const agent = z.string().describe('Your agent or machine name (letters, digits, _), e.g. "laptop". Names the shared Event Gateway destination.');
    const port = z.number().int().min(1).max(65535).default(3000).describe('Local port your agent receives deliveries on.');
    const describe = (record: CallbackRecord) => ({ name: record.name, url: record.url, path: record.path, source: record.sourceName });
    const listen = (name: string, p: number) => ({
      commands: callbacks.listenCommands(name, p),
      note: 'hookdeck listen only receives sources that exist when it starts: restart it after creating a callback URL, then call retry_missed_deliveries.',
    });

    server.registerTool(
      'create_callback_url',
      {
        description:
          'For an agent without a public URL (for example on a laptop): create a callback URL for one MCP Events webhook subscription. ' +
          'Hookdeck Event Gateway receives deliveries at the URL and `hookdeck listen` forwards them to your local port and path. ' +
          'Then call events/subscribe with this URL and a whsec_ secret you generate; deliveries arrive signed with your secret, all on one local path; route them by X-MCP-Subscription-Id. ' +
          'Create one per subscription. A callback URL no subscription has used for an hour is deleted.',
        inputSchema: z.object({
          agent,
          name: z.string().describe('A name for this subscription (letters, digits, _), e.g. "email_from_alice".'),
          path: z.string().optional().describe(`Local path deliveries are forwarded to. Set by your first callback (default ${DEFAULT_CALLBACK_PATH}) and shared by all of them.`),
          port,
        }),
      },
      async ({ agent: name, name: callbackName, path, port: p }) => {
        try {
          const record = await callbacks.create({ agent: name, name: callbackName, path });
          return json({ ...describe(record), listen: listen(name, p) });
        } catch (error) {
          if (error instanceof CallbackInputError) return { content: [{ type: 'text', text: error.message }], isError: true };
          throw error;
        }
      },
    );

    server.registerTool(
      'list_callback_urls',
      {
        description: "List an agent's callback URLs and the `hookdeck listen` commands that cover them.",
        inputSchema: z.object({ agent, port }),
      },
      async ({ agent: name, port: p }) => json({ callbacks: callbacks.forAgent(name).map(describe), listen: listen(name, p) }),
    );

    server.registerTool(
      'retry_missed_deliveries',
      {
        description:
          "Retry deliveries to an agent's callback URLs that it missed while `hookdeck listen` wasn't running, freshly signed (same webhook-id). " +
          'Call it once `listen` is connected again, and again until upToDate is true. Delivery is at least once: dedupe by webhook-id.',
        inputSchema: z.object({ agent }),
      },
      async ({ agent: name }) => json(await callbacks.retryMissed(name)),
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
