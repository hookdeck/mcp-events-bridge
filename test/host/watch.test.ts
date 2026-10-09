import { describe, expect, it } from 'vitest';
import { internalError, invalidParams, notFound } from '../../src/core/errors.js';
import type { PastEvent } from '../../src/core/event-history.js';
import { isBridgeError, isCursorError, isFatal, parseFilters, redactUrl, runWatch, watch, watchUrl, type PollRequest, type WatchDeps } from '../../src/host/watch.js';

const event = (eventId: string, name = 'github.issue_comment'): PastEvent => ({ eventId, name, timestamp: '2026-10-09T13:00:00.000Z', data: {} });
type Result = Awaited<ReturnType<WatchDeps['poll']>>;
const page = (events: PastEvent[], cursor: string, more: Partial<Result> = {}): Result => ({ events, cursor, hasMore: false, nextPollMs: 2000, ...more });

/** Runs watch over scripted poll results (per name), stopping when they run out. */
async function run(script: Record<string, Array<Result | Error>>, args: Record<string, unknown> = {}) {
  const controller = new AbortController();
  const requests: PollRequest[] = [];
  const printed: PastEvent[] = [];
  const errors: Array<{ name: string; retryMs: number }> = [];
  const sleeps: number[] = [];
  const exhausted = new Set<string>();
  const done = watch({
    names: Object.keys(script),
    arguments: args,
    signal: controller.signal,
    poll: async (request) => {
      requests.push(request);
      const next = script[request.name]!.shift();
      if (!next) {
        // This name is done: stop once every name is, holding this poll open until then.
        exhausted.add(request.name);
        if (exhausted.size === Object.keys(script).length) {
          controller.abort();
          return page([], 'end');
        }
        return new Promise<Result>((resolve) => controller.signal.addEventListener('abort', () => resolve(page([], 'end'))));
      }
      if (next instanceof Error) throw next;
      return next;
    },
    onEvent: (e) => printed.push(e),
    onError: (name, _error, retryMs) => errors.push({ name, retryMs }),
    sleep: async (ms) => void sleeps.push(ms),
  });
  return { done, requests, printed, errors, sleeps };
}

describe('watch', () => {
  it('starts from now, follows the cursor, and waits nextPollMs (or not at all with hasMore)', async () => {
    const r = await run({
      'github.issue_comment': [page([], 'c1'), page([event('e1'), event('e2')], 'c2', { hasMore: true }), page([event('e3')], 'c3', { nextPollMs: 5000 })],
    }, { repository: 'hookdeck/hookdeck-demos' });
    await r.done;
    expect(r.requests.map((q) => q.cursor)).toEqual([null, 'c1', 'c2', 'c3']);
    expect(r.requests[0]!.arguments).toEqual({ repository: 'hookdeck/hookdeck-demos' });
    expect(r.printed.map((e) => e.eventId)).toEqual(['e1', 'e2', 'e3']);
    expect(r.sleeps).toEqual([2000, 5000]);
  });

  it('prints an event once when polls return it again', async () => {
    const r = await run({ 'github.issues': [page([event('e1')], 'c1'), page([event('e1'), event('e2')], 'c2')] });
    await r.done;
    expect(r.printed.map((e) => e.eventId)).toEqual(['e1', 'e2']);
  });

  it('polls each event name with its own cursor', async () => {
    const r = await run({ 'github.issues': [page([event('i1', 'github.issues')], 'ci')], 'github.issue_comment': [page([event('c1')], 'cc')] });
    await r.done;
    expect(r.printed.map((e) => e.eventId).sort()).toEqual(['c1', 'i1']);
    expect(r.requests.filter((q) => q.name === 'github.issues').map((q) => q.cursor)).toEqual([null, 'ci']);
    expect(r.requests.filter((q) => q.name === 'github.issue_comment').map((q) => q.cursor)).toEqual([null, 'cc']);
  });

  it('retries a failed poll with the same cursor, backing off', async () => {
    const r = await run({ 'github.issues': [page([], 'c1'), new Error('fetch failed'), new Error('fetch failed'), page([event('e1')], 'c2')] });
    await r.done;
    expect(r.requests.map((q) => q.cursor)).toEqual([null, 'c1', 'c1', 'c1', 'c2']);
    expect(r.errors).toEqual([{ name: 'github.issues', retryMs: 1000 }, { name: 'github.issues', retryMs: 2000 }]);
    expect(r.printed.map((e) => e.eventId)).toEqual(['e1']);
  });

  it('stops on an unknown event name or bad arguments', async () => {
    await expect((await run({ 'github.nope': [notFound('event', 'Unknown event: github.nope')] })).done).rejects.toThrow('Unknown event');
    await expect((await run({ 'github.issues': [invalidParams('arguments do not match the inputSchema')] })).done).rejects.toThrow('inputSchema');
  });
});

describe('runWatch', () => {
  it('passes its signal to each poll', async () => {
    const controller = new AbortController();
    const signals: Array<AbortSignal | undefined> = [];
    await runWatch({
      name: 'github.issues',
      arguments: {},
      signal: controller.signal,
      poll: async (_request, signal) => {
        signals.push(signal);
        controller.abort();
        return page([], 'c1');
      },
      onEvent: () => {},
      onError: () => {},
      sleep: async () => {},
    });
    expect(signals).toEqual([controller.signal]);
  });
});

describe('watch helpers', () => {
  it('parses --filter values, JSON where it parses', () => {
    expect(parseFilters(['repository=hookdeck/hookdeck-demos', 'actions=["opened"]', 'sender=null', 'note=a=b'])).toEqual({
      repository: 'hookdeck/hookdeck-demos',
      actions: ['opened'],
      sender: 'null',
      note: 'a=b',
    });
    expect(() => parseFilters(['repository'])).toThrow('key=value');
  });

  it('tells cursor errors and bridge errors apart', () => {
    expect(isCursorError(invalidParams('cursor is not a cursor this bridge returned', { field: 'cursor' }))).toBe(true);
    expect(isCursorError(invalidParams('arguments do not match the inputSchema'))).toBe(false);
    expect(isBridgeError(internalError('x'))).toBe(true);
    expect(isBridgeError(new Error('fetch failed'))).toBe(false);
  });

  it('treats only bad requests as fatal', () => {
    expect(isFatal(notFound('event', 'x'))).toBe(true);
    expect(isFatal(invalidParams('x'))).toBe(true);
    expect(isFatal(new Error('fetch failed'))).toBe(false);
  });

  it('finds the MCP URL, and redacts its secret', () => {
    expect(watchUrl('https://b.example/mcp/s', {})).toBe('https://b.example/mcp/s');
    expect(watchUrl(undefined, { BRIDGE_MCP_URL: 'https://b.example/mcp/s' })).toBe('https://b.example/mcp/s');
    expect(watchUrl(undefined, { BRIDGE_MCP_SECRET: 's', BRIDGE_PUBLIC_URL: 'https://b.example/' })).toBe('https://b.example/mcp/s');
    expect(watchUrl(undefined, { BRIDGE_MCP_SECRET: 's', PORT: '9000' })).toBe('http://127.0.0.1:9000/mcp/s');
    expect(() => watchUrl(undefined, {})).toThrow('BRIDGE_MCP_SECRET');
    expect(redactUrl('https://b.example/mcp/abc123?x=1')).toBe('https://b.example/mcp/<secret>?x=1');
    expect(redactUrl('Cannot POST /mcp/abc123 (from https://b.example/mcp/abc123)')).toBe('Cannot POST /mcp/<secret> (from https://b.example/mcp/<secret>)');
  });
});
