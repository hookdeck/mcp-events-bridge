import { EventsErrorCode } from '../core/errors.js';
import type { PastEvent } from '../core/event-history.js';
import type { PollResult } from '../core/poll.js';

/*
 * `mcp-events-bridge watch`: an events/poll client that prints one line per event, for agents
 * that run a command in the background and wake on its output (Claude Code's Monitor tool), and
 * for scripts. One poll loop per event name, each with its own cursor, starting from now.
 */

export interface PollRequest {
  name: string;
  arguments: Record<string, unknown>;
  cursor: string | null;
  /** With a cursor: skip events older than this (a resumed watch shouldn't replay days of events). */
  maxAgeMs?: number;
}

export type Poll = (request: PollRequest) => Promise<Pick<PollResult, 'events' | 'cursor' | 'hasMore' | 'nextPollMs'>>;

export interface WatchDeps {
  names: string[];
  arguments: Record<string, unknown>;
  poll: Poll;
  onEvent: (event: PastEvent) => void;
  /** A poll failed and will be retried after `retryMs`; `failures` counts consecutive failures. */
  onError: (name: string, error: unknown, retryMs: number, failures: number) => void;
  signal: AbortSignal;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** Errors a retry can't fix: an unknown event name, arguments that don't match its inputSchema, a bad cursor. */
export function isFatal(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === EventsErrorCode.InvalidParams || code === EventsErrorCode.NotFound;
}

const MAX_BACKOFF_MS = 30_000;
/** Polls overlap, so the same event can come back: remember this many ids per name. */
const SEEN_LIMIT = 1000;

export const abortableSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });

export interface RunWatchDeps {
  name: string;
  arguments: Record<string, unknown>;
  /** Where to start: a saved cursor, or null for now. */
  cursor?: string | null;
  maxAgeMs?: number;
  poll: Poll;
  onEvent: (event: PastEvent) => void;
  onError: WatchDeps['onError'];
  /** Called after each successful poll with the cursor to continue from. */
  onCursor?: (cursor: string) => void;
  signal: AbortSignal;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** One watch: polls one event name with its arguments until `signal` aborts; rejects on a fatal error. */
export async function runWatch(deps: RunWatchDeps): Promise<void> {
  const sleep = deps.sleep ?? abortableSleep;
  let cursor = deps.cursor ?? null;
  let failures = 0;
  const seen = new Set<string>();
  while (!deps.signal.aborted) {
    let delay: number;
    try {
      const request: PollRequest = { name: deps.name, arguments: deps.arguments, cursor };
      if (cursor !== null && deps.maxAgeMs !== undefined) request.maxAgeMs = deps.maxAgeMs;
      const result = await deps.poll(request);
      if (deps.signal.aborted) return;
      for (const event of result.events) {
        if (seen.has(event.eventId)) continue;
        seen.add(event.eventId);
        if (seen.size > SEEN_LIMIT) seen.delete(seen.values().next().value!);
        deps.onEvent(event);
      }
      cursor = result.cursor;
      deps.onCursor?.(cursor);
      failures = 0;
      delay = result.hasMore ? 0 : result.nextPollMs;
    } catch (error) {
      if (deps.signal.aborted) return;
      if (isFatal(error)) throw error;
      delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** failures++);
      deps.onError(deps.name, error, delay, failures);
    }
    if (delay > 0) await sleep(delay, deps.signal);
  }
}

/** Runs until `signal` aborts; rejects on the first fatal error. */
export async function watch(deps: WatchDeps): Promise<void> {
  await Promise.all(deps.names.map((name) => runWatch({ ...deps, name })));
}

/**
 * `--filter key=value` flags as an arguments object. A value that parses as JSON (an array, number
 * or boolean) is used as such: `--filter 'actions=["opened"]'`; anything else is a string.
 */
export function parseFilters(filters: string[]): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const filter of filters) {
    const at = filter.indexOf('=');
    if (at < 1) throw new Error(`--filter takes key=value, got "${filter}"`);
    const raw = filter.slice(at + 1);
    let value: unknown = raw;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'string' && parsed !== null) value = parsed;
    } catch {
      // not JSON: a string
    }
    args[filter.slice(0, at)] = value;
  }
  return args;
}

/**
 * The bridge's MCP URL: `--url`, else BRIDGE_MCP_URL, else built like `setup` prints it, from
 * BRIDGE_PUBLIC_URL (or the local port) and BRIDGE_MCP_SECRET.
 */
export function watchUrl(flag: string | undefined, environment: NodeJS.ProcessEnv): string {
  if (flag) return flag;
  if (environment.BRIDGE_MCP_URL) return environment.BRIDGE_MCP_URL;
  const secret = environment.BRIDGE_MCP_SECRET;
  if (!secret) throw new Error('set --url, BRIDGE_MCP_URL, or BRIDGE_MCP_SECRET (with BRIDGE_PUBLIC_URL for a deployed bridge)');
  const base = environment.BRIDGE_PUBLIC_URL?.replace(/\/$/, '') ?? `http://127.0.0.1:${environment.BRIDGE_PORT ?? environment.PORT ?? 8080}`;
  return `${base}/mcp/${secret}`;
}

/** The URL without its secret path segment, for messages. */
export function redactUrl(url: string): string {
  return url.replace(/\/mcp\/[^/?#]+/, '/mcp/<secret>');
}
