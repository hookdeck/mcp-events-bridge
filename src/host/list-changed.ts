import type http from 'node:http';
import { probeEventName, probeToolName, type ListChangedProbes } from '../core/mcp.js';

/**
 * The list-changed test (BRIDGE_LIST_CHANGED_TEST=1; docs/list-changed-test.md): finds out how MCP clients pick up a
 * changed tools/list and events/list. Off by default; a normal bridge has none of this.
 *
 * - The probes: `debug.probe_<n>` in events/list and a `debug_probe_<n>` tool (core/mcp.ts). `bump()` raises n for
 *   either list and tells every open notification stream.
 * - 2026-07-28 clients: the bridge answers `subscriptions/listen` itself, since the MCP SDK's own listen handling
 *   (2.3.1 and 2.4.0) strips the SEP-3415 `eventsListChanged` filter and can't send notifications/events/list_changed.
 * - 2025-era clients: a GET that accepts text/event-stream opens a stream, which the SDK's stateless serving refuses
 *   (405). No session: the bridge serves 2025-era POSTs statelessly, as without the flag.
 *
 * Every notification is written to the response, so the trace (host/mcp-trace.ts) logs it as a `notify` line.
 */

export type Lists = 'events' | 'tools' | 'both';

const SUBSCRIPTION_ID_META_KEY = 'io.modelcontextprotocol/subscriptionId';
const SERVER_INFO_META_KEY = 'io.modelcontextprotocol/serverInfo';
const KEEPALIVE_MS = 15_000;

interface Stream {
  /** The trace number of the request that opened it. */
  n: number;
  kind: 'get' | 'subscriptions/listen';
  /** What the client opted in to: both, for a 2025-era GET stream, which has no filter. */
  tools: boolean;
  events: boolean;
  /** The listen request's id, stamped on every notification. */
  subscriptionId?: string | number;
  clientInfo?: unknown;
  protocolVersion?: unknown;
  openedAt: string;
  send(method: string): void;
  end(): void;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export class ListChangedTest {
  readonly probes: ListChangedProbes = { eventsGeneration: 1, toolsGeneration: 1 };
  private readonly streams = new Set<Stream>();

  constructor(
    private readonly options: { log: (message: string) => void; serverInfo: { name: string; version: string }; keepAliveMs?: number },
  ) {}

  /** A snapshot for building one request's MCP server, so a bump can't change it mid-request. */
  snapshot(): ListChangedProbes {
    return { ...this.probes };
  }

  /** Raises the generation of one or both lists and notifies the streams that opted in. */
  bump(lists: Lists) {
    const events = lists !== 'tools';
    const tools = lists !== 'events';
    if (events) this.probes.eventsGeneration++;
    if (tools) this.probes.toolsGeneration++;
    let notified = 0;
    for (const stream of this.streams) {
      if (events && stream.events) stream.send('notifications/events/list_changed');
      if (tools && stream.tools) stream.send('notifications/tools/list_changed');
      if ((events && stream.events) || (tools && stream.tools)) notified++;
    }
    this.options.log(
      `list-changed test: ${lists} bumped to ${probeEventName(this.probes.eventsGeneration)} and ${probeToolName(this.probes.toolsGeneration)}; notified ${notified} of ${this.streams.size} stream(s)`,
    );
    return { ...this.state(), notified };
  }

  state() {
    return {
      event: probeEventName(this.probes.eventsGeneration),
      tool: probeToolName(this.probes.toolsGeneration),
      ...this.probes,
      streams: [...this.streams].map(({ n, kind, tools, events, subscriptionId, clientInfo, protocolVersion, openedAt }) => ({
        n,
        kind,
        tools,
        events,
        subscriptionId,
        clientInfo,
        protocolVersion,
        openedAt,
      })),
    };
  }

  /** Ends every stream (on shutdown): a listen stream with its graceful-close result. */
  close() {
    for (const stream of [...this.streams]) stream.end();
  }

  /** A 2025-era client's notification stream: a GET accepting text/event-stream. It gets both notifications. */
  serveGet(req: http.IncomingMessage, res: http.ServerResponse, n: number) {
    this.open(req, res, {
      n,
      kind: 'get',
      tools: true,
      events: true,
      protocolVersion: req.headers['mcp-protocol-version'],
    });
  }

  /** A 2026-07-28 `subscriptions/listen` request, with the SEP-3415 `eventsListChanged` filter. */
  serveListen(req: http.IncomingMessage, res: http.ServerResponse, n: number, message: Record<string, unknown>) {
    const id = message.id as string | number;
    const params = isObject(message.params) ? message.params : {};
    const filter = params.notifications;
    if (!isObject(filter)) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32602, message: "Invalid params: 'notifications' is required and must be a valid SubscriptionFilter" } }),
      );
      return;
    }
    // Honored: what the client asked for that the bridge sends. Prompts and resources it doesn't offer.
    const honored: Record<string, boolean> = {};
    if (filter.toolsListChanged === true) honored.toolsListChanged = true;
    if (filter.eventsListChanged === true) honored.eventsListChanged = true;
    const meta = isObject(params._meta) ? params._meta : {};
    const stream = this.open(req, res, {
      n,
      kind: 'subscriptions/listen',
      tools: honored.toolsListChanged === true,
      events: honored.eventsListChanged === true,
      subscriptionId: id,
      clientInfo: meta['io.modelcontextprotocol/clientInfo'],
      protocolVersion: meta['io.modelcontextprotocol/protocolVersion'] ?? req.headers['mcp-protocol-version'],
    });
    stream.write({ jsonrpc: '2.0', method: 'notifications/subscriptions/acknowledged', params: { notifications: honored, _meta: { [SUBSCRIPTION_ID_META_KEY]: id } } });
    // Nothing honored: close at once, gracefully, as the MCP SDK does.
    if (Object.keys(honored).length === 0) stream.end();
  }

  private open(req: http.IncomingMessage, res: http.ServerResponse, init: Omit<Stream, 'send' | 'end' | 'openedAt'>) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.flushHeaders();
    let closed = false;
    const write = (message: unknown) => {
      if (!closed) res.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
    };
    const keepAlive = setInterval(() => !closed && res.write(': keepalive\n\n'), this.options.keepAliveMs ?? KEEPALIVE_MS);
    keepAlive.unref();
    const stream: Stream & { write: typeof write } = {
      ...init,
      openedAt: new Date().toISOString(),
      write,
      send: (method) =>
        write({ jsonrpc: '2.0', method, params: init.subscriptionId === undefined ? {} : { _meta: { [SUBSCRIPTION_ID_META_KEY]: init.subscriptionId } } }),
      end: () => {
        if (closed) return;
        // A listen stream ends with its result; a GET stream just ends.
        if (init.subscriptionId !== undefined) {
          write({
            jsonrpc: '2.0',
            id: init.subscriptionId,
            result: { resultType: 'complete', _meta: { [SUBSCRIPTION_ID_META_KEY]: init.subscriptionId, [SERVER_INFO_META_KEY]: this.options.serverInfo } },
          });
        }
        cleanup();
        res.end();
      },
    };
    const cleanup = () => {
      closed = true;
      clearInterval(keepAlive);
      this.streams.delete(stream);
    };
    // The response's close, not the request's: a POST's request closes once its body is read.
    res.on('close', cleanup);
    this.streams.add(stream);
    return stream;
  }
}
