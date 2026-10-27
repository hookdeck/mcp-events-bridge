import type { Catalog } from './catalog.js';
import type { ResolvedSource } from './config.js';
import { SUBSCRIPTION_PREFIX } from './names.js';
import { LOOKBACK_MS } from './poll.js';
import type { EventRuntime, SourceDefinition } from './sources/types.js';

/*
 * The Event Gateway transformation each source's subscriptions share (one per source, on every subscription's
 * connection, before its filter). It builds the MCP event from the service's request with the source's runtime, and
 * sets the headers the destination and the filter use. The bridge generates it from the source's runtime, so the
 * mapping that runs in Event Gateway is the one the bridge runs for poll mode and get_event.
 */

export const MAX_BODY_BYTES = 256 * 1024;

/** What a subscription's connection description gives the transformation, beyond the subscription itself. */
export interface CursorMetadata {
  /** The cursor's hash of the subscription's arguments (poll's format). */
  cursorArgs?: string;
  /** While a replay runs: the cursor it started from, which every delivery carries until it's done. */
  replayFrom?: string;
}

/** A source's runtime in the bridge: the function the transformation runs, called with the same config. */
export function instantiateRuntime(definition: Pick<SourceDefinition<any, any>, 'runtime' | 'runtimeConfig'>): Record<string, EventRuntime> {
  return definition.runtime(definition.runtimeConfig);
}

/** A function's source as an expression. Method shorthand (`summarize(req) {...}`) gets the `function` keyword. */
export function functionSource(fn: (...args: never[]) => unknown): string {
  const text = fn.toString();
  if (/^(async\s+)?(function\b|\(|[A-Za-z_$][\w$]*\s*=>)/.test(text)) return text;
  return `function ${text}`;
}

/**
 * The transformation's handler. Self-contained: it's serialized into the transformation, and called directly in
 * tests. Anything it can't deliver gets an `x-mcp-skip` header, which every subscription's filter excludes, rather
 * than an error, which would open an issue on every subscription for every request.
 */
export function envelopeHandler(
  runtime: Record<string, EventRuntime>,
  events: Array<{ key: string; name: string }>,
  constants: { subscriptionPrefix: string; maxBodyBytes: number; lookbackMs: number },
) {
  type Meta = { cursorArgs?: unknown; replayFrom?: unknown } | null;
  // Poll's cursor format, from now less the look-back, so a client persisting it never skips an event still in flight.
  const cursorFor = (meta: Meta, name: string, now: number) => {
    if (!meta) return null;
    if (typeof meta.replayFrom === 'string') return meta.replayFrom;
    const w = now - constants.lookbackMs;
    const state = { v: 1, n: name, a: typeof meta.cursorArgs === 'string' ? meta.cursorArgs : '', f: w, w, t: now, ids: [] };
    return Buffer.from(JSON.stringify(state)).toString('base64url');
  };
  return (request: Record<string, unknown> & { headers?: Record<string, unknown>; body?: unknown }, context?: { connection?: Record<string, unknown> }) => {
    const connection = context?.connection ?? {};
    const connectionName = typeof connection.name === 'string' ? connection.name : '';
    const subscriptionId = connectionName.startsWith(constants.subscriptionPrefix) ? connectionName.slice(constants.subscriptionPrefix.length) : '';
    let meta: Meta = null;
    try {
      meta = typeof connection.description === 'string' ? (JSON.parse(connection.description) as Meta) : null;
    } catch {
      meta = null;
    }
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(request.headers ?? {})) headers[key.toLowerCase()] = String(value);
    const req = { headers, body: request.body };

    let envelope: { eventId: string; name: string; timestamp: string; data: unknown; cursor: string | null } | null = null;
    let skip: string | null = 'event type not enabled';
    for (const event of events) {
      const rt = runtime[event.key];
      try {
        if (!rt || !rt.matches(req)) continue;
        const eventId = String(rt.eventId(req));
        envelope = { eventId, name: event.name, timestamp: rt.occurredAt(req), data: rt.summarize(req), cursor: cursorFor(meta, event.name, Date.now()) };
        skip = eventId.includes('.') ? 'event id contains a period, which Standard Webhooks ids cannot' : null;
      } catch (error) {
        envelope = null;
        skip = `could not build the event: ${error instanceof Error ? error.message : String(error)}`;
      }
      break;
    }
    if (envelope && !skip && Buffer.byteLength(JSON.stringify(envelope)) > constants.maxBodyBytes) skip = 'envelope over 256 KiB';

    const out: Record<string, string> = { 'content-type': 'application/json', 'x-mcp-subscription-id': subscriptionId };
    if (envelope) out['webhook-id'] = envelope.eventId;
    if (skip) out['x-mcp-skip'] = skip.slice(0, 200);
    // The sender's query string isn't the subscriber's (the destination also ignores the sender's path).
    return { ...request, headers: out, body: envelope ?? {}, query: '', parsed_query: {} };
  };
}

/** The code of a source's transformation. */
export function buildTransformation(source: Pick<ResolvedSource, 'id' | 'definition'>, catalog: Catalog): string {
  const events = catalog.forProvider(source.id).map((entry) => ({ key: entry.event.name, name: entry.name }));
  const constants = { subscriptionPrefix: SUBSCRIPTION_PREFIX, maxBodyBytes: MAX_BODY_BYTES, lookbackMs: LOOKBACK_MS };
  return [
    `// Generated by mcp-events-bridge for the source "${source.id}": builds the MCP event on every subscription's`,
    "// connection. Don't edit it: setup and serve rewrite it.",
    // esbuild's keepNames helper, in case the code was compiled with it.
    'const __name = (fn) => fn;',
    `const runtime = (${functionSource(source.definition.runtime as never)})(${JSON.stringify(source.definition.runtimeConfig ?? null)});`,
    `addHandler('transform', (${functionSource(envelopeHandler as never)})(runtime, ${JSON.stringify(events)}, ${JSON.stringify(constants)}));`,
    '',
  ].join('\n');
}
