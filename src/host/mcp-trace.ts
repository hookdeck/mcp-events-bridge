import type http from 'node:http';

/**
 * MCP request tracing, on with BRIDGE_MCP_TRACE=1 (and with BRIDGE_LIST_CHANGED_TEST=1). One line of JSON per
 * inbound request, per response, and per stream close, each prefixed `mcp-trace`, so a test run's logs show what a
 * client sent and when: the JSON-RPC method, protocol version, clientInfo, whether it opened a notification stream
 * (a 2025-era GET, or a 2026-07-28 `subscriptions/listen` and its filter), and which tools and event types it was given.
 *
 * Allowlisted fields only. Never logged: the Authorization header, the secret in the URL (paths are redacted by the
 * caller), `delivery.secret` and `arguments` of events/subscribe, and tool arguments.
 */

const PROTOCOL_VERSION_META_KEY = 'io.modelcontextprotocol/protocolVersion';
const CLIENT_INFO_META_KEY = 'io.modelcontextprotocol/clientInfo';
const CLIENT_CAPABILITIES_META_KEY = 'io.modelcontextprotocol/clientCapabilities';
const SUBSCRIPTION_ID_META_KEY = 'io.modelcontextprotocol/subscriptionId';

/** The largest JSON response body kept for the trace. Lists are far smaller. */
const MAX_CAPTURE_BYTES = 1024 * 1024;

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

/** What the trace records of one JSON-RPC message from a client. */
export function describeRpc(message: unknown): Json {
  if (!isObject(message)) return { invalid: true };
  const params = isObject(message.params) ? message.params : {};
  const meta = isObject(params._meta) ? params._meta : {};
  const out: Json = { method: message.method ?? null };
  if ('id' in message) out.id = message.id;
  // 2026-07-28 puts these in every request's _meta; 2025-era clients send them once, in initialize.
  if (meta[PROTOCOL_VERSION_META_KEY] !== undefined) out.protocolVersion = meta[PROTOCOL_VERSION_META_KEY];
  if (meta[CLIENT_INFO_META_KEY] !== undefined) out.clientInfo = meta[CLIENT_INFO_META_KEY];
  if (meta[CLIENT_CAPABILITIES_META_KEY] !== undefined) out.clientCapabilities = meta[CLIENT_CAPABILITIES_META_KEY];
  switch (message.method) {
    case 'initialize':
      out.protocolVersion = params.protocolVersion;
      out.clientInfo = params.clientInfo;
      out.clientCapabilities = params.capabilities;
      break;
    case 'subscriptions/listen':
      out.notifications = params.notifications;
      break;
    case 'tools/call':
    case 'events/subscribe':
    case 'events/unsubscribe':
    case 'events/poll':
    case 'events/stream':
      // The name only: arguments can hold addresses and other filters, and delivery holds the subscriber's secret.
      out.name = params.name;
      break;
    case 'events/list':
    case 'tools/list':
      if (params.cursor !== undefined) out.cursor = params.cursor;
      break;
  }
  return out;
}

/** What the trace records of a JSON-RPC response: for lists, the names the client was given, and any cache hints. */
export function describeResult(method: unknown, message: unknown): Json {
  if (!isObject(message)) return {};
  if (isObject(message.error)) return { error: { code: message.error.code, message: message.error.message } };
  const result = isObject(message.result) ? message.result : undefined;
  if (!result) return {};
  const out: Json = {};
  const names = (items: unknown) => (Array.isArray(items) ? items.map((item) => (isObject(item) ? item.name : null)) : undefined);
  switch (method) {
    case 'initialize':
      out.protocolVersion = result.protocolVersion;
      out.capabilities = result.capabilities;
      break;
    case 'server/discover':
      out.supportedVersions = result.supportedVersions;
      out.capabilities = result.capabilities;
      break;
    case 'tools/list':
      out.tools = names(result.tools);
      break;
    case 'events/list':
      out.events = names(result.events);
      break;
  }
  if (result.ttlMs !== undefined) out.ttlMs = result.ttlMs;
  if (result.cacheScope !== undefined) out.cacheScope = result.cacheScope;
  if (result.nextCursor !== undefined) out.nextCursor = result.nextCursor;
  return out;
}

const header = (req: http.IncomingMessage, name: string) => {
  const value = req.headers[name];
  return Array.isArray(value) ? value.join(', ') : (value ?? null);
};

export class McpTrace {
  private seq = 0;

  constructor(private readonly log: (message: string) => void) {}

  private write(record: Json) {
    this.log(`mcp-trace ${JSON.stringify({ t: new Date().toISOString(), ...record })}`);
  }

  /**
   * Logs an inbound request (`body` is its parsed JSON, for a POST) and watches its response. Returns the request's
   * trace number, for lines other code adds about it (such as notifications sent on a stream it opened).
   */
  request(req: http.IncomingMessage, res: http.ServerResponse, path: string, body?: unknown): number {
    const n = ++this.seq;
    const started = Date.now();
    const messages = body === undefined ? [] : Array.isArray(body) ? body : [body];
    const rpc = messages.map(describeRpc);
    this.write({
      dir: 'in',
      n,
      http: req.method,
      path,
      // A 2025-era client's notification stream is a GET that accepts text/event-stream.
      stream: req.method === 'GET' ? 'get' : rpc.some((m) => m.method === 'subscriptions/listen') ? 'subscriptions/listen' : undefined,
      userAgent: header(req, 'user-agent'),
      accept: header(req, 'accept'),
      mcpProtocolVersion: header(req, 'mcp-protocol-version'),
      sessionId: header(req, 'mcp-session-id'),
      lastEventId: header(req, 'last-event-id') ?? undefined,
      rpc: rpc.length ? rpc : undefined,
    });

    const isStream = req.method === 'GET' || rpc.some((m) => m.method === 'subscriptions/listen');
    const replies: unknown[] = [];
    // A JSON body is kept whole (bounded); an SSE body (2025-era responses, and notification streams) is read frame by
    // frame: replies are kept for the `out` line, and each notification is logged as it's written.
    const chunks: Buffer[] = [];
    let size = 0;
    let sse = false;
    let pending = '';
    const readFrames = (text: string) => {
      pending += text;
      let end: number;
      while ((end = pending.indexOf('\n\n')) >= 0) {
        const frame = pending.slice(0, end);
        pending = pending.slice(end + 2);
        const data = frame
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (!data) continue;
        let message: unknown;
        try {
          message = JSON.parse(data);
        } catch {
          continue;
        }
        if (isObject(message) && typeof message.method === 'string') {
          const params = isObject(message.params) ? message.params : {};
          const meta = isObject(params._meta) ? params._meta : {};
          this.write({ dir: 'notify', n, method: message.method, subscriptionId: meta[SUBSCRIPTION_ID_META_KEY], notifications: params.notifications });
        } else replies.push(message);
      }
    };
    const capture = (chunk: unknown, encoding?: unknown) => {
      if (chunk === undefined || chunk === null || typeof chunk === 'function') return;
      const buffer = Buffer.isBuffer(chunk)
        ? chunk
        : chunk instanceof Uint8Array
          ? Buffer.from(chunk)
          : Buffer.from(String(chunk), typeof encoding === 'string' ? (encoding as BufferEncoding) : 'utf8');
      if (sse) return readFrames(buffer.toString('utf8'));
      size += buffer.length;
      if (size <= MAX_CAPTURE_BYTES) chunks.push(buffer);
    };
    const originalWrite = res.write.bind(res) as (...args: unknown[]) => boolean;
    const originalEnd = res.end.bind(res) as (...args: unknown[]) => http.ServerResponse;
    let headed = false;
    let contentType: string | null = null;
    const onHead = () => {
      if (headed) return;
      headed = true;
      contentType ??= (res.getHeader('content-type') as string | undefined) ?? null;
      sse = (contentType ?? '').startsWith('text/event-stream');
      if (sse && isStream) this.write({ dir: 'stream-open', n, status: res.statusCode, ms: Date.now() - started });
    };
    // Headers given to writeHead directly aren't visible to getHeader, so read the content type from its arguments.
    const originalWriteHead = res.writeHead.bind(res) as (...args: unknown[]) => http.ServerResponse;
    res.writeHead = ((...args: unknown[]) => {
      const headers = args.find((arg) => typeof arg === 'object' && arg !== null);
      if (Array.isArray(headers)) {
        const index = headers.findIndex((h, i) => i % 2 === 0 && String(h).toLowerCase() === 'content-type');
        if (index >= 0) contentType = String(headers[index + 1]);
      } else if (isObject(headers)) {
        const key = Object.keys(headers).find((k) => k.toLowerCase() === 'content-type');
        if (key) contentType = String(headers[key]);
      }
      const result = originalWriteHead(...args);
      onHead();
      return result;
    }) as typeof res.writeHead;
    res.write = ((chunk: unknown, ...rest: unknown[]) => {
      onHead();
      capture(chunk, rest[0]);
      return originalWrite(chunk, ...rest);
    }) as typeof res.write;
    res.end = ((chunk?: unknown, ...rest: unknown[]) => {
      onHead();
      capture(chunk, rest[0]);
      return originalEnd(chunk, ...rest);
    }) as typeof res.end;

    res.on('close', () => {
      onHead();
      const ms = Date.now() - started;
      if (!sse && size > 0 && size <= MAX_CAPTURE_BYTES) {
        try {
          const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          replies.push(...(Array.isArray(parsed) ? parsed : [parsed]));
        } catch {
          // Not JSON (a plain-text error): the status says enough.
        }
      }
      const results = replies.length
        ? replies.map((reply) => {
            const id = isObject(reply) ? reply.id : undefined;
            return { id, ...describeResult(rpc.find((m) => m.id === id)?.method, reply) };
          })
        : undefined;
      const streamed = sse && isStream;
      // A stream's close says whether the bridge ended it (finished) or the client went away.
      this.write({ dir: streamed ? 'stream-close' : 'out', n, status: res.statusCode, type: contentType, ms, results, ...(streamed && { finished: res.writableFinished }) });
    });
    return n;
  }

  /** A line about a request already traced, such as a notification sent on the stream it opened. */
  note(n: number, record: Json) {
    this.write({ n, ...record });
  }
}
