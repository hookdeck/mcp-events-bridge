import { McpServer, type ServerCapabilities } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { CallbackInputError, DEFAULT_AGENT_PORT, DEFAULT_CALLBACK_PATH, type CallbackRecord, type CallbackRegistry } from './callbacks.js';
import type { Catalog } from './catalog.js';
import { invalidParams, notFound, unsupported } from './errors.js';
import type { EventHistory } from './event-history.js';
import { MAX_EVENTS, type PollService } from './poll.js';
import type { SubscriptionService } from './subscriptions.js';

/**
 * Builds the MCP server for one request (the 2026-07-28 revision is stateless,
 * so the SDK asks for a fresh instance per request). The SDK has no MCP Events
 * support, so the capability and the `events/*` methods are registered by
 * hand, as in mcp-events-outpost-demo.
 */

const WAIT_DEFAULT_MS = 45_000;
const WAIT_MAX_MS = 50_000;
export function buildMcpServer(deps: {
  subscriptions: SubscriptionService;
  catalog: Catalog;
  history: EventHistory;
  /** Poll mode: `events/poll` and the poll_events and wait_for_event tools. */
  poll?: PollService;
  sources: () => Array<Record<string, unknown>>;
  /** Set when the bridge runs `hookdeck listen` for local agents: adds the callback URL tools. */
  callbacks?: CallbackRegistry;
  principal?: string;
  version?: string;
}): McpServer {
  const { subscriptions, catalog, history, principal } = deps;
  // Neither is in the SDK's ServerCapabilities type yet, hence the cast. `events` is what ChatGPT and pi-mcp-events
  // read; SEP-3415 moves it under `extensions`.
  const capabilities = { events: {}, extensions: { 'io.modelcontextprotocol/events': {} } } as unknown as ServerCapabilities;
  const server = new McpServer({ name: 'mcp-events-bridge', version: deps.version ?? '0.0.0' }, { capabilities });

  const json = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }], structuredContent: value as Record<string, unknown> });
  const error = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true });

  server.registerTool(
    'get_event',
    {
      description:
        'Get one event that happened, by its name and eventId (both are in every MCP Events delivery and in list_events), read from Hookdeck Event Gateway.',
      inputSchema: z.object({
        name: z.string().describe('The event name, such as resend.email.received'),
        eventId: z.string(),
      }),
    },
    async ({ name, eventId }) => {
      const lookup = history.lookup(name);
      if (lookup === 'unknown') return error(`Unknown event name ${name}; events/list has the names`);
      if (lookup === 'no-id-header') return error(`${name} events can't be looked up by id; use list_events with name ${name}`);
      const event = await history.get(name, eventId);
      return event ? json(event) : { content: [{ type: 'text', text: `No ${name} event ${eventId}` }], isError: true };
    },
  );

  server.registerTool(
    'list_events',
    {
      description:
        'List events that happened, newest first, optionally for one event name and since a time (ISO 8601), read from Hookdeck Event Gateway. For the kinds of events you can subscribe to, see events/list.',
      inputSchema: z.object({
        name: z.string().describe('An event name, such as resend.email.received').optional(),
        since: z.string().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      }),
    },
    async (args) => {
      if (args.name !== undefined && history.lookup(args.name) === 'unknown') return error(`Unknown event name ${args.name}; events/list has the names`);
      return json({ events: await history.recent(args) });
    },
  );

  server.registerTool(
    'list_sources',
    {
      description: 'List the configured event sources (the services events come from), their types, their events, and how many subscriptions each has.',
      inputSchema: z.object({}),
    },
    async () => json({ sources: deps.sources() }),
  );

  const poll = deps.poll;
  if (poll) {
    const pollInput = {
      name: z.string().describe('The event name, from events/list, such as fills.order.filled'),
      arguments: z.record(z.string(), z.unknown()).optional().describe("Filters, as the event's inputSchema in events/list describes, e.g. { \"symbol\": \"AAPL\" }"),
      cursor: z.string().nullable().optional().describe('The cursor from your last call. Omit (or null) to start from now: the first call returns no events, only a cursor.'),
    };
    // A ProtocolError (unknown name, bad arguments or cursor) becomes a tool error the model can read.
    const asTool = async (run: () => Promise<unknown>) => {
      try {
        return json(await run());
      } catch (caught) {
        return error((caught as Error).message);
      }
    };

    server.registerTool(
      'poll_events',
      {
        description:
          'Get events that happened since your cursor, for clients that can\'t subscribe with MCP Events (events/subscribe). Same as events/poll. ' +
          'Call it first without a cursor to start from now, then call it again with the cursor it returned: at once when hasMore is true, otherwise after nextPollMs. ' +
          'Events can repeat: dedupe by eventId. truncated: true means some events were skipped (maxAgeMs, or older than Event Gateway keeps). ' +
          'To wait for the next event in one call instead, use wait_for_event. For past events, use list_events.',
        inputSchema: z.object({
          ...pollInput,
          maxAgeMs: z.number().int().min(0).optional().describe('With a cursor, skip events older than this many milliseconds.'),
          maxEvents: z.number().int().min(1).optional().describe(`At most this many events (default 50, at most ${MAX_EVENTS}).`),
        }),
      },
      async (args) => asTool(() => poll.poll(args)),
    );

    server.registerTool(
      'wait_for_event',
      {
        description:
          `Wait for the next events after your cursor, returning as soon as there are some, or with none after timeoutMs (default ${WAIT_DEFAULT_MS / 1000} s, at most ${WAIT_MAX_MS / 1000} s). ` +
          'Without a cursor, waits for events from now on. Call it again with the cursor it returns to keep waiting; dedupe by eventId. ' +
          'Uses the same cursor as poll_events and events/poll.',
        inputSchema: z.object({
          ...pollInput,
          timeoutMs: z.number().int().min(1000).max(WAIT_MAX_MS).optional().describe(`How long to wait, in milliseconds (default ${WAIT_DEFAULT_MS}).`),
        }),
      },
      async ({ timeoutMs, ...args }, ctx) =>
        asTool(() => {
          const progressToken = ctx.mcpReq._meta?.progressToken;
          const timeout = timeoutMs ?? WAIT_DEFAULT_MS;
          return poll.wait(args, {
            timeoutMs: timeout,
            signal: ctx.mcpReq.signal,
            // Progress keeps the client's idle timer from firing while the bridge waits.
            onProgress: progressToken === undefined ? undefined : (elapsed) => void ctx.mcpReq.notify({ method: 'notifications/progress', params: { progressToken, progress: elapsed, total: timeout, message: 'waiting for events' } }).catch(() => {}),
          });
        }),
    );
  }

  const callbacks = deps.callbacks;
  if (callbacks) {
    const agent = z.string().describe('Your agent or machine name (letters, digits, _), e.g. "laptop". Names the shared Event Gateway destination.');
    const describe = (record: CallbackRecord) => ({ name: record.name, url: record.url, port: record.port, path: record.path, passThrough: record.passThrough });

    server.registerTool(
      'create_callback_url',
      {
        description:
          'For an agent on this machine without a public URL: create a public callback URL for MCP Events webhook delivery, then call events/subscribe with it. ' +
          'Hookdeck Event Gateway receives deliveries at the URL, and the bridge forwards them to http://localhost:<port><path> through the Hookdeck CLI. ' +
          'With secret (the whsec_ secret you subscribe with), Event Gateway answers the subscribe challenge and only accepts deliveries signed with it; one URL holds one secret, so to rotate, create a new URL. ' +
          'Without secret, the URL is pass-through: Event Gateway verifies nothing, so your receiver must check every signature. Use it when you use a different secret per subscription under one base URL. ' +
          'Deliveries arrive signed with your subscription secret, all on one local port and path; route them by X-MCP-Subscription-Id and dedupe by webhook-id. ' +
          'Deliveries missed while your agent or the forwarding was down are retried automatically, freshly signed. ' +
          'A URL no subscription has used for an hour is deleted.',
        inputSchema: z.object({
          agent,
          name: z.string().describe('A name for this URL (letters, digits, _), e.g. "email_from_alice".'),
          port: z.number().int().min(1).max(65535).optional().describe(`Local port your agent receives deliveries on. Set by your first URL (default ${DEFAULT_AGENT_PORT}) and shared by all of them.`),
          path: z.string().optional().describe(`Local path deliveries are forwarded to. Set by your first URL (default ${DEFAULT_CALLBACK_PATH}) and shared by all of them.`),
          secret: z.string().optional().describe('The whsec_ secret you will subscribe with. Omit for a pass-through URL.'),
        }),
      },
      async ({ agent: name, name: urlName, port, path, secret }) => {
        try {
          return json(describe(await callbacks.create({ agent: name, name: urlName, port, path, secret })));
        } catch (error) {
          if (error instanceof CallbackInputError) return { content: [{ type: 'text', text: error.message }], isError: true };
          throw error;
        }
      },
    );

    server.registerTool(
      'list_callback_urls',
      { description: "List an agent's callback URLs.", inputSchema: z.object({ agent }) },
      async ({ agent: name }) => json({ callbackUrls: callbacks.forAgent(name).map(describe) }),
    );
  }

  const anyParams = z.record(z.string(), z.unknown());
  server.server.setRequestHandler('events/list', { params: anyParams.optional() }, async () => ({ events: catalog.list() }));
  server.server.setRequestHandler('events/subscribe', { params: anyParams }, async (params) => ({
    ...(await subscriptions.subscribe(principal, params)),
  }));
  if (poll) server.server.setRequestHandler('events/poll', { params: anyParams }, async (params) => ({ ...(await poll.poll(params)) }));
  server.server.setRequestHandler('events/unsubscribe', { params: anyParams }, async (params) => subscriptions.unsubscribe(principal, params));
  // No event type offers push, so a well-formed events/stream is Unsupported (SEP-3415's error table), not method-not-found.
  server.server.setRequestHandler('events/stream', { params: anyParams }, async (params) => {
    if (typeof params.name !== 'string') throw invalidParams('name is required');
    if (!catalog.get(params.name)) throw notFound('event', `Unknown event: ${params.name}`);
    throw unsupported('deliveryMode', 'push');
  });

  return server;
}
