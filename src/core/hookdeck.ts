/*
 * Event Gateway API and Publish API client: only the endpoints the bridge
 * needs. Ported from hookdeck-demos/cli-fleet-fanout (shared/src/hookdeck.ts),
 * keeping its notes on API gotchas. The key and fetch are injected, so this
 * stays runtime-agnostic.
 */

export const DEFAULT_API_BASE = 'https://api.hookdeck.com/2026-09-01';
export const DEFAULT_PUBLISH_URL = 'https://hkdk.events/v1/publish';

export interface Page<T> {
  models: T[];
  pagination?: { order_by: string; dir: string; next?: string; prev?: string };
  count?: number;
}

/** Reads every page of a listing (up to maxPages). `complete` is false if it stopped early. */
export async function allPages<T>(page: (next: string | undefined) => Promise<Page<T>>, maxPages = 100): Promise<{ models: T[]; complete: boolean }> {
  const models: T[] = [];
  let next: string | undefined;
  for (let i = 0; i < maxPages; i++) {
    const result = await page(next);
    models.push(...result.models);
    const cursor = result.pagination?.next;
    next = cursor && result.models.length > 0 ? (cursor.startsWith('http') ? (new URL(cursor).searchParams.get('next') ?? undefined) : cursor) : undefined;
    if (!next) return { models, complete: true };
  }
  return { models, complete: false };
}

export interface HookdeckRequest {
  id: string;
  source_id: string;
  created_at: string;
  events_count?: number | null;
  ignored_count?: number | null;
  rejection_cause?: string | null;
  verified?: boolean;
  data?: { headers?: Record<string, string>; body?: unknown } | null;
}

export interface HookdeckEvent {
  id: string;
  request_id: string;
  webhook_id: string; // connection id
  destination_id: string;
  status: string;
  attempts?: number;
  response_status?: number | null;
  created_at: string;
}

export interface IgnoredEvent {
  id: string;
  request_id: string;
  webhook_id: string; // connection id
  cause: string;
  created_at: string;
}

export interface Source {
  id: string;
  name: string;
  url: string;
  type?: string;
  description?: string | null;
}

export interface Destination {
  id: string;
  name: string;
  type?: string;
  description?: string | null;
  config?: {
    url?: string;
    path?: string;
    auth_type?: string | null;
    /** Masked (`{}`) unless fetched with `getDestination(id, { includeAuth: true })`. Lists never return it. */
    auth?: { key?: string; signing_secret?: string } | null;
  } | null;
}

export interface Connection {
  id: string;
  name: string;
  description?: string | null;
  source: Source;
  destination: Destination;
  rules?: Rule[];
  disabled_at?: string | null;
}

export type Rule =
  | { type: 'filter'; headers?: unknown; body?: unknown; query?: unknown; path?: unknown }
  | { type: 'deduplicate'; include_fields?: string[]; exclude_fields?: string[]; window: number }
  | { type: 'retry'; strategy: 'linear' | 'exponential'; count: number; interval: number; response_status_codes?: string[] }
  | { type: 'transform'; transformation_id: string };

export interface UpsertConnectionInput {
  name: string;
  description?: string;
  /**
   * An inline source is created or updated by name, and its type defaults to
   * WEBHOOK with config replaced: naming an existing typed source here resets
   * it (found in stage 5). Bind an existing source with `source_id` instead.
   */
  source?: { name: string; type?: string; config?: Record<string, unknown> };
  source_id?: string;
  destination: { name: string; type?: 'HTTP' | 'CLI' | 'MOCK_API'; description?: string; config?: Record<string, unknown> };
  rules?: Rule[];
}

export type IssueStatus = 'OPENED' | 'IGNORED' | 'ACKNOWLEDGED' | 'RESOLVED';

export interface Issue {
  id: string;
  type: 'delivery' | 'transformation' | 'backpressure' | 'request';
  status: IssueStatus;
  aggregation_keys?: Record<string, unknown[]>;
}

export interface IssueTriggerInput {
  name: string;
  type: 'delivery' | 'transformation' | 'backpressure' | 'request';
  /** Delivery: `{ strategy: 'first_attempt' | 'final_attempt', connections }`. The `*_failure` names in the docs are rejected (stage 4). */
  configs: Record<string, unknown>;
  channels?: Record<string, unknown>;
}

/**
 * Retry rule for subscription connections. A list of negations alone
 * (["!410", "!413"]) matches every other status, 2xx included, so successful
 * attempts get retried; entries are evaluated last match wins (stage 3).
 *
 * Retries carry the first signature, so they must finish inside the
 * receiver's 5-minute timestamp window. Three exponential retries from a
 * 20-second interval stay well inside it even if the factor is larger than
 * doubling (20 + 40 + 80 seconds if it doubles). The end-to-end run measures
 * the actual spacing.
 */
export const SUBSCRIPTION_RETRY_RULE: Rule = {
  type: 'retry',
  strategy: 'exponential',
  count: 3,
  interval: 20_000,
  response_status_codes: ['>=300', '!410', '!413'],
};

/** Dedupe on the MCP event id. Best-effort, window of at most 1 hour. */
export const WEBHOOK_ID_DEDUPE_RULE: Rule = { type: 'deduplicate', include_fields: ['headers.webhook-id'], window: 3_600_000 };

/**
 * Event statuses, and which of them are settled.
 *
 * SUCCESSFUL, FAILED and CANCELLED are terminal: nothing further will happen
 * on its own. QUEUED, SCHEDULED and HOLD all mean Hookdeck still intends to
 * deliver: queued for an attempt now, waiting on a scheduled retry, or held
 * because the connection is paused.
 *
 * The distinction matters because `POST /events/{id}/retry` has no guard on
 * status. A manual retry publishes the event for delivery immediately and
 * leaves `next_attempt_at` alone, so a scheduled retry stays armed and fires
 * as well. Retrying an unsettled event is how you get two deliveries of it.
 */
export const TERMINAL_EVENT_STATUSES = ['SUCCESSFUL', 'FAILED', 'CANCELLED'] as const;

export const isSettled = (event: Pick<HookdeckEvent, 'status'>): boolean =>
  (TERMINAL_EVENT_STATUSES as readonly string[]).includes(event.status);

export class HookdeckApiError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
    readonly responseBody: string,
  ) {
    super(`${method} ${path} -> ${status} ${responseBody.slice(0, 500)}`);
  }
}

export interface HookdeckClientOptions {
  apiKey: string;
  apiBase?: string;
  publishUrl?: string;
  fetch?: typeof fetch;
  /** Back-off delays for 429s, in milliseconds. */
  retryDelaysMs?: number[];
}

type Query = Record<string, string | number | undefined>;

export class HookdeckClient {
  private readonly apiBase: string;
  private readonly publishUrl: string;
  private readonly fetch: typeof fetch;
  private readonly retryDelaysMs: number[];

  constructor(private readonly options: HookdeckClientOptions) {
    this.apiBase = options.apiBase ?? DEFAULT_API_BASE;
    this.publishUrl = options.publishUrl ?? DEFAULT_PUBLISH_URL;
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.retryDelaysMs = options.retryDelaysMs ?? [500, 1000, 2000, 4000];
  }

  private async api<T>(path: string, init: { method?: string; query?: Query; body?: unknown } = {}): Promise<T> {
    const method = init.method ?? 'GET';
    const url = new URL(this.apiBase + path);
    for (const [key, value] of Object.entries(init.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    // Recovery walks every request in a window, two calls each, so rate
    // limits are reachable. Back off here rather than in each caller.
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetch(url, {
        method,
        headers: { Authorization: `Bearer ${this.options.apiKey}`, 'Content-Type': 'application/json' },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      });
      const text = await res.text();
      if (res.ok) return (text ? JSON.parse(text) : {}) as T;
      const delay = this.retryDelaysMs[attempt];
      // 429s always back off. Server errors are retried only for idempotent methods: concurrent upserts that
      // create the same new source can fail with 500 FATAL_ERROR (stage 5).
      const retryable = res.status === 429 || (method !== 'POST' && [500, 502, 503, 504].includes(res.status));
      if (retryable && delay !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      throw new HookdeckApiError(method, url.pathname, res.status, text);
    }
  }

  // --- requests and events (recovery, get_event, poll) ---

  /** `headers` filters on request headers (Hookdeck filter syntax); `includeData` adds headers and body to each request. */
  listRequests(query: {
    source_id?: string;
    created_at_gte?: string;
    limit?: number;
    order_by?: string;
    dir?: 'asc' | 'desc';
    next?: string;
    headers?: Record<string, unknown>;
    includeData?: boolean;
    /** Only requests with at least one ignored event (verified live: the count filters work). */
    withIgnored?: boolean;
  }) {
    return this.api<Page<HookdeckRequest>>('/requests', {
      query: {
        source_id: query.source_id,
        'ignored_count[gt]': query.withIgnored ? '0' : undefined,
        headers: query.headers ? JSON.stringify(query.headers) : undefined,
        include: query.includeData ? 'data' : undefined,
        // The API takes bracketed comparison operators for date filters.
        'created_at[gte]': query.created_at_gte,
        limit: query.limit ?? 100,
        order_by: query.order_by ?? 'created_at',
        dir: query.dir ?? 'desc',
        next: query.next,
      },
    });
  }

  /** Events, filtered by connection (`webhook_id`, verified live to filter) and creation time. */
  listEvents(query: { webhook_id: string; created_at_gte?: string; status?: string; limit?: number; next?: string }) {
    return this.api<Page<HookdeckEvent>>('/events', {
      query: {
        webhook_id: query.webhook_id,
        status: query.status,
        'created_at[gte]': query.created_at_gte,
        limit: query.limit ?? 100,
        order_by: 'created_at',
        dir: 'asc',
        next: query.next,
      },
    });
  }

  getRequest(id: string) {
    return this.api<HookdeckRequest>(`/requests/${encodeURIComponent(id)}`);
  }

  getEvent(id: string) {
    return this.api<HookdeckEvent>(`/events/${encodeURIComponent(id)}`);
  }

  /**
   * Events for one request. Use the nested path, not `GET /events?request_id=...`:
   * that query parameter is accepted and silently ignored, and returns
   * unrelated events.
   */
  listEventsForRequest(requestId: string) {
    return this.api<Page<HookdeckEvent>>(`/requests/${encodeURIComponent(requestId)}/events`, { query: { limit: 100 } });
  }

  listIgnoredEventsForRequest(requestId: string) {
    return this.api<Page<IgnoredEvent>>(`/requests/${encodeURIComponent(requestId)}/ignored_events`, { query: { limit: 100 } });
  }

  /**
   * Retry a request, optionally limited to some connections. `webhook_ids` is
   * what `hookdeck gateway request retry --connection-ids` sends; it isn't in
   * the public API reference. A request retry creates new event ids.
   */
  retryRequest(requestId: string, connectionIds?: string[]) {
    return this.api<{ request: HookdeckRequest; events: HookdeckEvent[] }>(`/requests/${encodeURIComponent(requestId)}/retry`, {
      method: 'POST',
      body: connectionIds?.length ? { webhook_ids: connectionIds } : {},
    });
  }

  /** Retry one event. Only for events settled as FAILED (see TERMINAL_EVENT_STATUSES). */
  retryEvent(eventId: string) {
    return this.api<HookdeckEvent>(`/events/${encodeURIComponent(eventId)}/retry`, { method: 'POST' });
  }

  // --- connections, sources, destinations ---

  /**
   * Create a connection or update the one with this name. Source and
   * destination are matched by name and created inline if missing. Rules are
   * replaced. Use this (not the CLI) for retry rules with negated status
   * codes: the CLI flag accepts integers only (stage 3).
   */
  upsertConnection(input: UpsertConnectionInput) {
    return this.api<Connection>('/connections', { method: 'PUT', body: input });
  }

  deleteConnection(id: string) {
    return this.api<unknown>(`/connections/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  listConnections(query: { name?: string; limit?: number; next?: string } = {}) {
    return this.api<Page<Connection>>('/connections', { query: { name: query.name, limit: query.limit ?? 100, next: query.next } });
  }

  /** Every connection in the project, following pagination. */
  async listAllConnections(): Promise<Connection[]> {
    const found: Connection[] = [];
    let next: string | undefined;
    for (let page = 0; page < 100; page++) {
      const result = await this.listConnections({ limit: 250, next });
      found.push(...result.models);
      const cursor = result.pagination?.next;
      if (!cursor || result.models.length === 0) return found;
      next = cursor.startsWith('http') ? (new URL(cursor).searchParams.get('next') ?? undefined) : cursor;
      if (!next) return found;
    }
    return found;
  }

  /** Create or update a source by name. `config.auth.webhook_secret_key` sets a provider's signing secret. */
  upsertSource(input: { name: string; type: string; description?: string; config?: Record<string, unknown> }) {
    return this.api<Source & { description?: string | null }>('/sources', { method: 'PUT', body: input });
  }

  listSources(query: { name?: string; limit?: number } = {}) {
    return this.api<Page<Source>>('/sources', { query: { name: query.name, limit: query.limit ?? 100 } });
  }

  /** One source; with `includeAuth`, its auth config (a provider's signing secret) is returned. */
  getSource(id: string, { includeAuth = false }: { includeAuth?: boolean } = {}) {
    return this.api<Source & { config?: { auth?: Record<string, unknown> | null } | null }>(`/sources/${encodeURIComponent(id)}`, {
      query: { include: includeAuth ? 'config.auth' : undefined },
    });
  }

  deleteSource(id: string) {
    return this.api<unknown>(`/sources/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  /**
   * One destination. With `includeAuth`, its auth config (credentials) is
   * returned; otherwise auth comes back masked. Listings never include it.
   */
  getDestination(id: string, { includeAuth = false }: { includeAuth?: boolean } = {}) {
    return this.api<Destination>(`/destinations/${encodeURIComponent(id)}`, { query: { include: includeAuth ? 'config.auth' : undefined } });
  }

  deleteDestination(id: string) {
    return this.api<unknown>(`/destinations/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  // --- issues and notifications ---

  getIssue(id: string) {
    return this.api<Issue>(`/issues/${encodeURIComponent(id)}`);
  }

  /** Resolve an issue after acting on it, so the next failure with the same key notifies again (stage 4). */
  updateIssueStatus(id: string, status: IssueStatus) {
    return this.api<Issue>(`/issues/${encodeURIComponent(id)}`, { method: 'PUT', body: { status } });
  }

  /** Create or update an issue trigger by name. */
  upsertIssueTrigger(input: IssueTriggerInput) {
    return this.api<{ id: string; name: string }>('/issue-triggers', {
      method: 'PUT',
      body: { name: input.name, type: input.type, configs: input.configs, channels: input.channels ?? {} },
    });
  }

  /** Project-wide: where issue notifications are sent. */
  setWebhookNotifications(input: { enabled: boolean; topics: string[]; sourceId: string }) {
    return this.api<unknown>('/notifications/webhooks', {
      method: 'PUT',
      body: { enabled: input.enabled, topics: input.topics, source_id: input.sourceId },
    });
  }

  // --- Publish API ---

  /**
   * Publish a request to a source by name. Headers and body pass through to
   * destinations unchanged, on every attempt (stage 3). A PUBLISH_API source
   * accepts only Publish API requests.
   */
  async publish(sourceName: string, headers: Record<string, string>, body: string): Promise<{ requestId?: string }> {
    const res = await this.fetch(this.publishUrl, {
      method: 'POST',
      headers: { ...headers, Authorization: `Bearer ${this.options.apiKey}`, 'X-Hookdeck-Source-Name': sourceName },
      body,
    });
    const text = await res.text();
    if (!res.ok) throw new HookdeckApiError('POST', new URL(this.publishUrl).pathname, res.status, text);
    try {
      return { requestId: (JSON.parse(text) as { request_id?: string }).request_id };
    } catch {
      return {};
    }
  }
}
