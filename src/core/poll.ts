import { createHash } from 'node:crypto';
import { canonicalJson } from './canonical-json.js';
import type { Catalog } from './catalog.js';
import { internalError, invalidParams, notFound } from './errors.js';
import type { EventHistory, PastEvent } from './event-history.js';
import { HookdeckApiError, type HookdeckClient, type HookdeckRequest, type ResponseMeta } from './hookdeck.js';

/*
 * Poll mode (`events/poll`, and the poll_events and wait_for_event tools): a proxy to Event Gateway's request
 * listing, with no event store in the bridge. See "Poll mode" in docs/ARCHITECTURE.md.
 *
 * Requests appear in the listing about 2 seconds after their created_at (up to 15 measured) and out of order, so a
 * cursor re-reads the last LOOKBACK_MS and carries the ids it has returned. Polls share one listing of the sources
 * polled recently, fetched on demand (the bridge runs no timer), to stay inside the API's 240 requests a minute.
 */

export const LOOKBACK_MS = 60_000;
export const POLL_INTERVAL_MS = 2_000;
export const MAX_POLL_INTERVAL_MS = 30_000;
/** A source no poll has asked for in this long leaves the shared listing. */
const ACTIVE_SOURCE_MS = 60_000;
export const DEFAULT_MAX_EVENTS = 50;
export const MAX_EVENTS = 100;
const WINDOW_MAX_PAGES = 10;
const CATCH_UP_MAX_PAGES = 2;
/** Event Gateway's retention on the Developer plan; Team keeps 7 days and Growth 30. */
export const DEFAULT_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;
/** Margin on the window's start, for the bridge's estimate of Event Gateway's clock. */
const WINDOW_MARGIN_MS = 5_000;
/**
 * How far the shared window reaches back beyond LOOKBACK_MS: a cursor's watermark is its listing's time less the
 * look-back, the listing can be up to one interval old when served, and the client waits another interval
 * (nextPollMs) before polling again. Covering two of the longest intervals keeps a client that waits as told, even
 * while backed off, on the shared listing rather than its own catch-up call.
 */
const WINDOW_EXTRA_MS = 2 * MAX_POLL_INTERVAL_MS + WINDOW_MARGIN_MS;

export interface PollParams {
  name: string;
  arguments?: Record<string, unknown>;
  cursor?: string | null;
  maxAgeMs?: number | null;
  maxEvents?: number;
}

export interface PollResult {
  resultType: 'complete';
  events: PastEvent[];
  cursor: string;
  truncated: boolean;
  hasMore: boolean;
  nextPollMs: number;
}

/** What the cursor carries: everything a poll needs, so the bridge keeps nothing between polls. */
interface CursorState {
  v: 1;
  /** The event name and a hash of the parsed arguments: a cursor answers for one subscription only. */
  n: string;
  a: string;
  /** Floor: nothing created before it is returned (epoch ms, Event Gateway's clock). */
  f: number;
  /** Watermark: the next listing starts here. */
  w: number;
  /** When the listing this cursor came from was taken. */
  t: number;
  /** Requests at or after `w` already returned: [request id, created_at ms]. */
  ids: Array<[string, number]>;
}

interface Listing {
  /** Accepted requests, oldest first. */
  requests: HookdeckRequest[];
  /** Event Gateway's clock when the listing was taken. */
  t: number;
  /** Set when paging stopped early: created_at of the last request listed; nothing after it was read. */
  until?: number;
}

type ListingClient = Pick<HookdeckClient, 'listAcceptedRequests' | 'listIgnoredEventsForRequest'>;

export class RateLimitedError extends Error {}

/** Reads accepted requests from `from` on, up to `maxPages`, with the meta of the last response. */
async function listFrom(hookdeck: ListingClient, sourceIds: string[], from: number, maxPages: number): Promise<{ requests: HookdeckRequest[]; meta: ResponseMeta; until?: number }> {
  const requests: HookdeckRequest[] = [];
  let next: string | undefined;
  let meta: ResponseMeta = {};
  for (let i = 0; i < maxPages; i++) {
    let result;
    try {
      result = await hookdeck.listAcceptedRequests({ source_ids: sourceIds, created_at_gte: new Date(from).toISOString(), next });
    } catch (error) {
      if (error instanceof HookdeckApiError && error.status === 429) throw new RateLimitedError('Event Gateway API rate limit reached');
      throw error;
    }
    requests.push(...result.page.models);
    meta = result.meta;
    const cursor = result.page.pagination?.next;
    next = cursor && result.page.models.length > 0 ? (cursor.startsWith('http') ? (new URL(cursor).searchParams.get('next') ?? undefined) : cursor) : undefined;
    if (!next) return { requests, meta };
  }
  const last = requests.at(-1);
  return { requests, meta, until: last ? Date.parse(last.created_at) : from };
}

/**
 * The shared listing: the accepted requests of every source polled in the last minute, from LOOKBACK_MS (plus
 * WINDOW_EXTRA_MS) before Event Gateway's now. Fetched when a poll finds it older than the interval or missing its
 * source; polls that arrive during a fetch share it, and its failure. After a failure, no fetch until `retryAt`. The
 * interval grows as the API's rate limit runs low.
 */
export class RequestWindow {
  private readonly active = new Map<string, number>();
  private cached?: { at: number; from: number; listing: Listing; sources: Set<string> };
  private inflight?: Promise<void>;
  private failure?: { error: unknown; retryAt: number };
  private skewMs = 0;
  /** How long a listing is reused, and the nextPollMs polls are given. */
  interval = POLL_INTERVAL_MS;
  /** API calls made, for tests and logs. */
  fetches = 0;

  constructor(
    private readonly deps: { hookdeck: ListingClient; now?: () => number; lookbackMs?: number },
  ) {}

  private now() {
    return (this.deps.now ?? Date.now)();
  }

  /** Event Gateway's clock, estimated from the last response's Date header. */
  egNow() {
    return this.now() + this.skewMs;
  }

  /** Marks a source as polled, so the next fetch includes it, without fetching. */
  touch(sourceId: string) {
    this.active.set(sourceId, this.now());
  }

  /** Whether a recent failure (a 429, say) means no API calls for now. */
  get backingOff() {
    return this.failure !== undefined && this.now() < this.failure.retryAt;
  }

  async get(sourceId: string): Promise<{ from: number; listing: Listing }> {
    this.touch(sourceId);
    for (;;) {
      const cached = this.cached;
      const covers = cached?.sources.has(sourceId) ?? false;
      if (cached && covers && this.now() - cached.at < this.interval) return cached;
      if (this.failure && this.backingOff) {
        // Rate limited or failing: answer from the last listing if it covers this source.
        if (cached && covers) return cached;
        throw this.failure.error;
      }
      this.inflight ??= this.fetch().finally(() => (this.inflight = undefined));
      try {
        await this.inflight;
      } catch (error) {
        if (cached && covers) return cached;
        throw error;
      }
    }
  }

  /** Takes Event Gateway's clock and the rate limit from a listing response (the shared one or a catch-up). */
  observe(meta: ResponseMeta, requestedAt: number) {
    if (meta.date !== undefined) this.skewMs = meta.date - requestedAt;
    if (meta.rateLimit) this.interval = intervalFor(meta.rateLimit);
  }

  /** Records a failed listing call: a 429 backs off for the longest interval, anything else for one interval. */
  fail(error: unknown) {
    const rateLimited = error instanceof RateLimitedError;
    if (rateLimited) this.interval = MAX_POLL_INTERVAL_MS;
    this.failure = { error, retryAt: this.now() + (rateLimited ? MAX_POLL_INTERVAL_MS : POLL_INTERVAL_MS) };
  }

  private async fetch() {
    const now = this.now();
    for (const [id, at] of this.active) if (now - at > ACTIVE_SOURCE_MS) this.active.delete(id);
    const sources = [...this.active.keys()];
    const from = this.egNow() - (this.deps.lookbackMs ?? LOOKBACK_MS) - WINDOW_EXTRA_MS;
    this.fetches++;
    let result;
    try {
      result = await listFrom(this.deps.hookdeck, sources, from, WINDOW_MAX_PAGES);
    } catch (error) {
      this.fail(error);
      throw error;
    }
    const { requests, meta, until } = result;
    this.failure = undefined;
    this.observe(meta, now);
    if (!meta.rateLimit) this.interval = POLL_INTERVAL_MS;
    this.cached = { at: this.now(), from, sources: new Set(sources), listing: { requests, t: meta.date ?? this.egNow(), until } };
  }
}

/** POLL_INTERVAL_MS, growing to MAX_POLL_INTERVAL_MS as the remaining rate limit falls below a quarter. */
export function intervalFor(rateLimit: ResponseMeta['rateLimit']): number {
  if (!rateLimit) return POLL_INTERVAL_MS;
  const share = rateLimit.remaining / rateLimit.limit;
  if (share >= 0.25) return POLL_INTERVAL_MS;
  return Math.round(POLL_INTERVAL_MS + (MAX_POLL_INTERVAL_MS - POLL_INTERVAL_MS) * (1 - share / 0.25));
}

export function encodeCursor(state: CursorState): string {
  return Buffer.from(JSON.stringify(state)).toString('base64url');
}

function decodeCursor(cursor: string): CursorState {
  try {
    const state = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as CursorState;
    const ok =
      state.v === 1 &&
      typeof state.n === 'string' &&
      typeof state.a === 'string' &&
      [state.f, state.w, state.t].every(Number.isFinite) &&
      Array.isArray(state.ids) &&
      state.ids.every((e) => Array.isArray(e) && typeof e[0] === 'string' && Number.isFinite(e[1]));
    if (ok) return state;
  } catch {
    // fall through
  }
  throw invalidParams('cursor is not a cursor this bridge returned', { field: 'cursor' });
}

const argumentsHash = (args: unknown) => createHash('sha256').update(canonicalJson(args)).digest('hex').slice(0, 16);

export interface PollServiceDeps {
  hookdeck: ListingClient;
  catalog: Catalog;
  history: Pick<EventHistory, 'toEvent' | 'sourceIdFor'>;
  window?: RequestWindow;
  retentionMs?: number;
  lookbackMs?: number;
  now?: () => number;
}

export class PollService {
  readonly window: RequestWindow;
  /**
   * Whether an accepted request with no events was ignored only for a disconnected CLI (kept, as poll returns it).
   * A promise, so concurrent polls reading the same listing look each request up once.
   */
  private readonly waitingOnCli = new Map<string, Promise<boolean>>();

  constructor(private readonly deps: PollServiceDeps) {
    this.window = deps.window ?? new RequestWindow({ hookdeck: deps.hookdeck, now: deps.now, lookbackMs: deps.lookbackMs });
  }

  private get lookbackMs() {
    return this.deps.lookbackMs ?? LOOKBACK_MS;
  }

  /** Validates params as events/poll receives them (also used by the tools). */
  parse(params: Record<string, unknown>) {
    if (typeof params.name !== 'string') throw invalidParams('name is required');
    const entry = this.deps.catalog.get(params.name);
    if (!entry) throw notFound('event', `Unknown event: ${params.name}`);
    const rawArgs = params.arguments ?? {};
    if (typeof rawArgs !== 'object' || rawArgs === null || Array.isArray(rawArgs)) throw invalidParams('arguments must be an object');
    let args: Record<string, unknown>;
    try {
      args = entry.event.parseArguments(rawArgs);
    } catch (error) {
      throw invalidParams('arguments do not match the inputSchema', { detail: (error as Error).message });
    }
    const { cursor, maxAgeMs, maxEvents } = params;
    if (cursor !== undefined && cursor !== null && typeof cursor !== 'string') throw invalidParams('cursor must be a string or null', { field: 'cursor' });
    if (maxAgeMs !== undefined && maxAgeMs !== null && (typeof maxAgeMs !== 'number' || maxAgeMs < 0)) throw invalidParams('maxAgeMs must be a non-negative number', { field: 'maxAgeMs' });
    if (maxEvents !== undefined && (typeof maxEvents !== 'number' || !Number.isInteger(maxEvents) || maxEvents < 1)) throw invalidParams('maxEvents must be a positive integer', { field: 'maxEvents' });
    return { entry, args, cursor: (cursor as string | null | undefined) ?? null, maxAgeMs: maxAgeMs as number | null | undefined, maxEvents: Math.min((maxEvents as number | undefined) ?? DEFAULT_MAX_EVENTS, MAX_EVENTS) };
  }

  async poll(params: Record<string, unknown>): Promise<PollResult> {
    const { entry, args, cursor, maxAgeMs, maxEvents } = this.parse(params);
    const hash = argumentsHash(args);
    const sourceId = await this.deps.history.sourceIdFor(entry.providerId);
    if (!sourceId) throw internalError(`No Event Gateway source for ${entry.providerId}: run setup`);

    // A null cursor starts from now; maxAgeMs is ignored with it (SEP-3415: no replay from before the subscription).
    // Now is Event Gateway's clock at this poll, not the time of a listing that may be an interval old. The listing
    // is read (when due) only to add the source and refresh the clock estimate, so a failure doesn't fail the poll.
    if (cursor === null) {
      await this.window.get(sourceId).catch(() => {});
      const t = this.window.egNow();
      return this.result([], { v: 1, n: entry.name, a: hash, f: t, w: t - this.lookbackMs, t, ids: [] }, false, false);
    }

    const state = decodeCursor(cursor);
    if (state.n !== entry.name || state.a !== hash) throw invalidParams('cursor is for another event name or arguments', { field: 'cursor' });

    let window;
    try {
      window = await this.window.get(sourceId);
    } catch (error) {
      if (error instanceof RateLimitedError) return this.unchanged(cursor);
      throw error;
    }

    let floor = state.f;
    let truncated = false;
    const retentionMs = this.deps.retentionMs ?? DEFAULT_RETENTION_MS;
    const egNow = this.window.egNow();
    if (state.w < egNow - retentionMs) {
      truncated = true;
      floor = Math.max(floor, egNow - retentionMs);
    }
    if (maxAgeMs !== undefined && maxAgeMs !== null) {
      const ageFloor = egNow - maxAgeMs;
      if (state.t < ageFloor) truncated = true;
      floor = Math.max(floor, ageFloor);
    }
    const start = Math.max(state.w, floor);

    let listing: Listing;
    // The shared window answers when it covers `start` and was read to the end (at very high volume it may not be).
    if (start >= window.from && window.listing.until === undefined) listing = window.listing;
    else {
      // Catch-up: older than the shared window, so this poll lists its own source from where it is. Not while the
      // window is backing off, and its rate limit feeds the window's interval.
      if (this.window.backingOff) return this.unchanged(cursor);
      try {
        const requestedAt = (this.deps.now ?? Date.now)();
        const { requests, meta, until } = await listFrom(this.deps.hookdeck, [sourceId], start, CATCH_UP_MAX_PAGES);
        this.window.observe(meta, requestedAt);
        listing = { requests, t: meta.date ?? egNow, until };
      } catch (error) {
        if (error instanceof RateLimitedError) {
          this.window.fail(error);
          return this.unchanged(cursor);
        }
        throw error;
      }
    }

    const seen = new Map(state.ids);
    const events: PastEvent[] = [];
    let hold: number | undefined;
    let hasMore = false;
    const holdAt = (at: number) => (hold = hold === undefined ? at : Math.min(hold, at));

    for (const request of listing.requests) {
      if (request.source_id !== sourceId || seen.has(request.id)) continue;
      const created = Date.parse(request.created_at);
      if (created < start) continue;
      let kind;
      try {
        kind = await this.classify(request);
      } catch (error) {
        if (!(error instanceof RateLimitedError)) throw error;
        this.window.fail(error);
        return this.unchanged(cursor);
      }
      // Not routed yet: a request that just arrived, or one being retried (the bridge's inbound recovery retries
      // requests a disconnected local bridge missed, and they show no events and no ignored events meanwhile, however
      // old). Hold the watermark for a new one, so a duplicate can be recognized first; return an older one, since on
      // a provider source it's in flight, and a duplicate returned this way repeats an eventId clients dedupe by.
      if (kind === 'pending') {
        if (created >= listing.t - this.lookbackMs) {
          holdAt(created);
          continue;
        }
        kind = 'event';
      }
      const event = kind === 'event' ? this.deps.history.toEvent(entry.providerId, request) : undefined;
      if (kind === 'event' && !event && !request.data) {
        if (created >= listing.t - this.lookbackMs) holdAt(created);
        continue;
      }
      if (!event || event.name !== entry.name || !entry.event.accepts(args, event.data)) continue;
      if (events.length >= maxEvents) {
        hasMore = true;
        holdAt(created);
        break;
      }
      events.push(event);
      seen.set(request.id, created);
    }
    if (listing.until !== undefined) {
      hasMore = true;
      holdAt(listing.until);
    }

    let w = listing.t - this.lookbackMs;
    if (hold !== undefined) w = Math.min(w, hold);
    w = Math.max(w, state.w, floor);
    // A hold before the floor can't happen (requests before `start` are skipped), so w only moves forward.
    const ids = [...seen].filter(([, at]) => at >= w);
    return this.result(events, { v: 1, n: entry.name, a: hash, f: floor, w, t: listing.t, ids }, truncated, hasMore);
  }

  /**
   * Polls until there are events or `timeoutMs` passes, every nextPollMs (at least POLL_INTERVAL_MS), so it reads the
   * shared listing. With `hasMore` and nothing matching, polls again at once. Returns the last result: with events, or
   * none and the cursor to wait from next time.
   */
  async wait(
    params: Record<string, unknown>,
    options: { timeoutMs: number; signal?: AbortSignal; onProgress?: (elapsedMs: number) => void; sleep?: (ms: number, signal?: AbortSignal) => Promise<void> },
  ): Promise<PollResult> {
    const now = this.deps.now ?? Date.now;
    const sleep = options.sleep ?? defaultSleep;
    const started = now();
    let cursor = (params.cursor as string | null | undefined) ?? null;
    for (;;) {
      const result = await this.poll({ ...params, cursor });
      if (result.events.length > 0) return result;
      // More to read past requests that didn't match: go on at once (unless the cursor didn't move).
      const draining = result.hasMore && result.cursor !== cursor;
      cursor = result.cursor;
      const elapsed = now() - started;
      const delay = draining ? result.nextPollMs : Math.max(result.nextPollMs, POLL_INTERVAL_MS);
      if (elapsed + delay > options.timeoutMs || options.signal?.aborted) return result;
      if (delay > 0) await sleep(delay, options.signal);
      if (options.signal?.aborted) return result;
      options.onProgress?.(now() - started);
    }
  }

  /** Which accepted requests are events, as the relay would have delivered them. */
  private async classify(request: HookdeckRequest): Promise<'event' | 'skip' | 'pending'> {
    if ((request.events_count ?? 0) > 0 || (request.cli_events_count ?? 0) > 0) return 'event';
    if (!(request.ignored_count ?? 0)) return 'pending'; // not processed yet
    let waiting = this.waitingOnCli.get(request.id);
    if (waiting === undefined) {
      if (this.window.backingOff) throw new RateLimitedError('Event Gateway API rate limit reached');
      if (this.waitingOnCli.size > 5000) this.waitingOnCli.clear();
      waiting = this.deps.hookdeck.listIgnoredEventsForRequest(request.id, { retry: false }).then(
        (ignored) => ignored.models.some((i) => i.cause === 'CLI_DISCONNECTED'),
        (error: unknown) => {
          this.waitingOnCli.delete(request.id);
          if (error instanceof HookdeckApiError && error.status === 429) throw new RateLimitedError('Event Gateway API rate limit reached');
          throw error;
        },
      );
      this.waitingOnCli.set(request.id, waiting);
    }
    // DUPLICATE, FILTERED, TRANSFORMATION_FAILED and other causes were never delivered.
    return (await waiting) ? 'event' : 'skip';
  }

  private result(events: PastEvent[], state: CursorState, truncated: boolean, hasMore: boolean): PollResult {
    // hasMore: poll again at once, unless the rate limit is running low (a backlog drains at the backed-off pace).
    const interval = this.window.interval;
    return { resultType: 'complete', events, cursor: encodeCursor(state), truncated, hasMore, nextPollMs: hasMore && interval <= POLL_INTERVAL_MS ? 0 : interval };
  }

  /** Rate limited with nothing to answer from: no events, the same (checked) cursor, and wait the longest interval. */
  private unchanged(cursor: string): PollResult {
    return { resultType: 'complete', events: [], cursor, truncated: false, hasMore: false, nextPollMs: MAX_POLL_INTERVAL_MS };
  }
}

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    });
  });
