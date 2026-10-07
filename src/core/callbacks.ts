import { randomUUID } from 'node:crypto';
import { allPages, HookdeckApiError, type HookdeckClient, type HookdeckEvent, type HookdeckRequest } from './hookdeck.js';
import { generateWebhookSecret } from './secret.js';
import { signStandardWebhook } from './sign.js';
import type { SubscriptionRecord } from './store.js';

/*
 * Tunnel URLs for local agents (create_tunnel_url). An agent on a laptop has
 * no public URL, so the bridge gives each of its subscriptions one: an Event
 * Gateway MCP Events source (which answers the subscribe challenge and
 * verifies deliveries) with a connection to the agent's CLI destination. The
 * bridge, running on the same machine, runs `hookdeck listen` to forward
 * deliveries to the agent's local port (see host/local-agents.ts).
 *
 *   agent-<agent>            CLI destination, shared by the agent's URLs (one local port and path)
 *   agent-<agent>-<name>     MCP Events source + connection, one per URL
 *
 * The source's secret is generated here and never leaves the bridge. The
 * agent subscribes with its own secret (client-supplied, as the spec says),
 * and the bridge signs the challenge and every delivery to a callback with
 * both: the source verifies one signature, the agent the other. So the source
 * never needs updating (an updated source secret took about a minute to reach
 * Event Gateway's edge when tested), and the agent can rotate its secret
 * without touching Event Gateway.
 *
 * A callback is deleted by the sweeper once no subscription has used it for a
 * grace period, not the moment one ends: an agent changing a subscription's
 * arguments unsubscribes and subscribes again on the same URL.
 *
 * Callback metadata lives in the connection description, like subscriptions.
 */

export const CALLBACK_KIND = 'mcp-events-callback';
const NAME = /^[A-Za-z0-9_]{1,40}$/;
const PATH = /^\/[A-Za-z0-9/_.-]*$/;
/** `hookdeck listen` takes at most 10 source names. */
export const LISTEN_SOURCES_PER_COMMAND = 10;
export const DEFAULT_CALLBACK_PATH = '/events';
export const DEFAULT_AGENT_PORT = 3000;
/** Marks a delivery the bridge re-sent, with the id of the original request, so later runs know it was handled. */
export const RETRY_OF_HEADER = 'x-mcp-bridge-retry-of';
const UNSETTLED = new Set(['QUEUED', 'SCHEDULED', 'HOLD']);
/** The watermark trails the run by this much: requests still being processed are checked again (checking is idempotent). */
const WATERMARK_MARGIN_MS = 2 * 60 * 1000;
/** Identifies each re-send, so a later run knows whether Event Gateway lists it yet. */
export const RESEND_ID_HEADER = 'x-mcp-bridge-resend-id';
/**
 * A re-send takes a few seconds to appear in Event Gateway's request listing, so a run straight after one would still
 * see only the missed original and send it again. Until the re-send is listed (found by its id), its event counts as
 * pending; after this long without it showing up, it's judged again.
 */
const RESEND_SETTLE_MS = 3 * 60 * 1000;

export interface CallbackSettings {
  /** How long a callback with no subscription is kept before the sweeper deletes it. */
  graceMs: number;
  maxPerAgent: number;
}

export const DEFAULT_CALLBACK_SETTINGS: CallbackSettings = { graceMs: 60 * 60 * 1000, maxPerAgent: 50 };

export interface CallbackRecord {
  agent: string;
  name: string;
  url: string;
  path: string;
  /** The agent's local port, where the bridge's `hookdeck listen` forwards deliveries. */
  port: number;
  sourceId: string;
  sourceName: string;
  connectionId: string;
  connectionName: string;
  destinationName: string;
  createdAt: string;
  /** Requests before this time are known to be settled (see retryMissed). */
  checkedUntil: string | null;
}

interface Metadata {
  v: 1;
  kind: typeof CALLBACK_KIND;
  agent: string;
  name: string;
  path: string;
  port?: number;
  createdAt: string;
  checkedUntil: string | null;
}

/** One `hookdeck listen` process: an agent's port and up to 10 of its sources. */
export interface AgentListen {
  agent: string;
  port: number;
  sources: string[];
}

export interface RetryReport {
  callbacks: number;
  requestsChecked: number;
  /** Missed deliveries the bridge sent again, freshly signed. */
  resent: number;
  /** Deliveries still in flight, or not yet processed by Event Gateway: checked again next time. */
  pending: number;
  /** Deliveries the agent itself answered with an error: not retried. */
  rejectedByAgent: number;
  /** True when nothing needed sending, so the next run starts from about now. */
  upToDate: boolean;
}

export type CallbacksHookdeck = Pick<
  HookdeckClient,
  'upsertSource' | 'listSources' | 'getSource' | 'deleteSource' | 'upsertConnection' | 'deleteConnection' | 'listAllConnections' | 'listRequests' | 'listEvents' | 'listIgnoredEventsForRequest'
>;

/** Bad input to create_tunnel_url: reported to the caller as is. */
export class CallbackInputError extends Error {}

export const destinationNameFor = (agent: string) => `agent-${agent}`;
export const callbackResourceName = (agent: string, name: string) => `agent-${agent}-${name}`;

export class CallbackRegistry {
  private readonly byUrl = new Map<string, CallbackRecord>();
  private readonly secrets = new Map<string, string>();
  /** When the sweeper first saw a callback with no subscription. */
  private readonly unusedSince = new Map<string, number>();
  /** Callbacks whose connection is gone but whose source delete failed: hidden, and retried by the sweeper. */
  private readonly deleting = new Set<string>();
  private readonly listeners = new Set<() => void>();
  /** The latest re-send of each event (by its original request id) not yet seen in a listing: see RESEND_SETTLE_MS. */
  private readonly unlisted = new Map<string, { id: string; at: number }>();
  private writes: Promise<unknown> = Promise.resolve();
  private retries: Promise<unknown> = Promise.resolve();
  private readonly settings: CallbackSettings;
  private readonly now: () => Date;
  private readonly log: (message: string) => void;
  private readonly fetch: typeof fetch;

  constructor(
    private readonly deps: {
      hookdeck: CallbacksHookdeck;
      /** Whether a subscription uses a callback URL. */
      inUse: (url: string) => boolean;
      /** A subscription by id, with its current (and previous, in a rotation) secret, for re-sending. */
      subscription: (id: string) => SubscriptionRecord | undefined;
      /** Called when a callback is deleted, so cached endpoint verification for its URL is dropped. */
      onDeleted?: (url: string) => void;
      settings?: Partial<CallbackSettings>;
      fetch?: typeof fetch;
      now?: () => Date;
      log?: (message: string) => void;
    },
  ) {
    this.settings = { ...DEFAULT_CALLBACK_SETTINGS, ...deps.settings };
    this.now = deps.now ?? (() => new Date());
    this.log = deps.log ?? (() => {});
    this.fetch = deps.fetch ?? fetch;
  }

  /** Creates and deletes run one at a time: concurrent upserts creating resources can fail (see the store). */
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.writes.then(work, work);
    this.writes = next.catch(() => undefined);
    return next;
  }

  /** Retry runs have their own queue, so a long one doesn't hold up creating callbacks. */
  private serializeRetry<T>(work: () => Promise<T>): Promise<T> {
    const next = this.retries.then(work, work);
    this.retries = next.catch(() => undefined);
    return next;
  }

  /** Calls `listener` whenever URLs are created or deleted, so the `hookdeck listen` processes can follow. Returns an unsubscribe function. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed() {
    for (const listener of this.listeners) listener();
  }

  /** Builds the index from Event Gateway. Call once at startup. */
  async load(): Promise<number> {
    for (const connection of await this.deps.hookdeck.listAllConnections()) {
      const metadata = parseMetadata(connection.description);
      if (!metadata || !connection.source?.url) continue;
      this.byUrl.set(connection.source.url, recordFrom(metadata, connection));
    }
    return this.byUrl.size;
  }

  find(url: string): CallbackRecord | undefined {
    return this.deleting.has(url) ? undefined : this.byUrl.get(url);
  }

  forAgent(agent: string): CallbackRecord[] {
    return [...this.byUrl.values()].filter((r) => r.agent === agent && !this.deleting.has(r.url)).sort((a, b) => a.name.localeCompare(b.name));
  }

  /** The agent's local path: set by its first URL, shared by all of them (one CLI destination). */
  agentPath(agent: string): string | undefined {
    return this.forAgent(agent)[0]?.path;
  }

  /** The agent's local port: set by its first URL, shared by all of them. */
  agentPort(agent: string): number | undefined {
    return this.forAgent(agent)[0]?.port;
  }

  /** Agents with at least one URL. */
  agents(): string[] {
    const live = [...this.byUrl.values()].filter((r) => !this.deleting.has(r.url));
    return [...new Set(live.map((r) => r.agent))].sort();
  }

  /** The `hookdeck listen` processes that cover every agent's URLs: one per agent and port, at most 10 sources each. */
  listenPlan(): AgentListen[] {
    const plan: AgentListen[] = [];
    for (const agent of this.agents()) {
      const records = this.forAgent(agent);
      const port = records[0]!.port;
      const names = records.map((r) => r.sourceName);
      for (let i = 0; i < names.length; i += LISTEN_SOURCES_PER_COMMAND) {
        plan.push({ agent, port, sources: names.slice(i, i + LISTEN_SOURCES_PER_COMMAND) });
      }
    }
    return plan;
  }

  /** Creates a tunnel URL, or returns the existing one with that name. */
  create(input: { agent: string; name: string; path?: string; port?: number }): Promise<CallbackRecord> {
    const { agent, name } = input;
    if (!NAME.test(agent)) throw new CallbackInputError('agent must be 1-40 letters, digits or _');
    if (!NAME.test(name)) throw new CallbackInputError('name must be 1-40 letters, digits or _');
    if (input.path !== undefined && !PATH.test(input.path)) throw new CallbackInputError('path must start with / and use letters, digits, /, _, . or -');
    if (input.port !== undefined && (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535)) throw new CallbackInputError('port must be 1-65535');

    return this.serialize(async () => {
      const existing = this.forAgent(agent).find((r) => r.name === name);
      if (existing) return existing;
      const agentPath = this.agentPath(agent);
      if (agentPath && input.path !== undefined && input.path !== agentPath) {
        throw new CallbackInputError(`agent ${agent} receives on ${agentPath}: all of an agent's tunnel URLs share one local path`);
      }
      const agentPort = this.agentPort(agent);
      if (agentPort && input.port !== undefined && input.port !== agentPort) {
        throw new CallbackInputError(`agent ${agent} receives on port ${agentPort}: all of an agent's tunnel URLs share one local port`);
      }
      if (this.forAgent(agent).length >= this.settings.maxPerAgent) {
        throw new CallbackInputError(`agent ${agent} has ${this.settings.maxPerAgent} tunnel URLs, the maximum; unsubscribe from some first`);
      }
      const path = agentPath ?? input.path ?? DEFAULT_CALLBACK_PATH;
      const port = agentPort ?? input.port ?? DEFAULT_AGENT_PORT;

      const resourceName = callbackResourceName(agent, name);
      // Reuse a source left from an earlier run rather than changing its secret (an update takes ~1 minute to reach the edge).
      let source = (await this.deps.hookdeck.listSources({ name: resourceName })).models[0];
      let secret: string;
      if (source) {
        const auth = (await this.deps.hookdeck.getSource(source.id, { includeAuth: true })).config?.auth;
        secret = typeof auth?.webhook_secret_key === 'string' ? auth.webhook_secret_key : '';
        if (!secret) throw new Error(`source ${resourceName} exists without a signing secret`);
      } else {
        secret = generateWebhookSecret();
        source = await this.deps.hookdeck.upsertSource({ name: resourceName, type: 'MCP_EVENTS', config: { auth: { webhook_secret_key: secret } } });
      }

      const metadata: Metadata = { v: 1, kind: CALLBACK_KIND, agent, name, path, port, createdAt: this.now().toISOString(), checkedUntil: null };
      const connection = await this.deps.hookdeck.upsertConnection({
        name: resourceName,
        description: JSON.stringify(metadata),
        source_id: source.id,
        destination: { name: destinationNameFor(agent), type: 'CLI', config: { path } },
      });
      const record = recordFrom(metadata, { ...connection, source: { ...connection.source, url: source.url } });
      this.byUrl.set(record.url, record);
      this.secrets.set(record.url, secret);
      this.log(`created tunnel URL ${resourceName}`);
      this.changed();
      return record;
    });
  }

  /**
   * The callback source's own secret, which the bridge adds to the challenge
   * and deliveries for this URL. A source deleted outside the bridge drops its
   * callback; other errors are thrown, so the inbound event is retried rather
   * than delivered with a signature the source would reject.
   */
  async signingSecret(url: string): Promise<string | undefined> {
    const record = this.find(url);
    if (!record) return undefined;
    const cached = this.secrets.get(url);
    if (cached) return cached;
    try {
      const auth = (await this.deps.hookdeck.getSource(record.sourceId, { includeAuth: true })).config?.auth;
      const secret = typeof auth?.webhook_secret_key === 'string' ? auth.webhook_secret_key : undefined;
      if (secret) this.secrets.set(url, secret);
      return secret;
    } catch (error) {
      if (error instanceof HookdeckApiError && error.status === 404) {
        this.forget(record);
        this.log(`callback source ${record.sourceName} is gone; dropped the callback`);
        return undefined;
      }
      throw error;
    }
  }

  /** Deletes tunnel URLs no subscription has used for the grace period. Run from the sweeper. */
  sweep(): Promise<string[]> {
    return this.serialize(async () => {
      const now = this.now().getTime();
      const deleted: string[] = [];
      for (const record of [...this.byUrl.values()]) {
        if (this.deps.inUse(record.url)) {
          this.unusedSince.delete(record.url);
          continue;
        }
        const since = this.unusedSince.get(record.url);
        if (since === undefined) {
          this.unusedSince.set(record.url, now);
          if (this.settings.graceMs > 0) continue;
        } else if (now - since < this.settings.graceMs) {
          continue;
        }
        try {
          if (!this.deleting.has(record.url)) {
            await this.deps.hookdeck.deleteConnection(record.connectionId).catch(ignoreNotFound);
            this.deleting.add(record.url);
            this.deps.onDeleted?.(record.url);
          }
          await this.deps.hookdeck.deleteSource(record.sourceId).catch(ignoreNotFound);
          this.forget(record);
          deleted.push(record.connectionName);
          this.log(`deleted unused tunnel URL ${record.connectionName}`);
        } catch (error) {
          this.log(`could not delete callback ${record.connectionName}, will retry: ${(error as Error).message}`);
        }
      }
      if (deleted.length) this.changed();
      return deleted;
    });
  }

  private forget(record: CallbackRecord) {
    this.byUrl.delete(record.url);
    this.secrets.delete(record.url);
    this.unusedSince.delete(record.url);
    this.deleting.delete(record.url);
  }

  /**
   * Retries deliveries an agent missed while `hookdeck listen` wasn't running:
   * a request ignored as CLI_DISCONNECTED (the CLI was offline) or an event
   * that FAILED without a response (the CLI dropped mid-delivery). A retry is
   * the same event (same webhook-id) in a new request with a fresh timestamp
   * and signature, as the spec requires of every attempt: Event Gateway's own
   * retry would resend the original timestamp, which a receiver rejects once
   * it's over five minutes old. Each re-sent request carries the original's
   * id, so later runs judge an event by its latest attempt. Events the agent
   * answered with an error aren't retried. Delivery is at least once: agents
   * dedupe by webhook-id. Run it while the agent's `listen` is connected: a
   * re-send while it's down is only ignored again.
   */
  retryMissed(agent: string): Promise<RetryReport> {
    return this.serializeRetry(async () => {
      const cutoff = this.now().getTime() - RESEND_SETTLE_MS;
      for (const [root, resend] of this.unlisted) if (resend.at < cutoff) this.unlisted.delete(root);
      const report: RetryReport = { callbacks: 0, requestsChecked: 0, resent: 0, pending: 0, rejectedByAgent: 0, upToDate: true };
      for (const record of this.forAgent(agent)) {
        report.callbacks++;
        const runStart = this.now().getTime();
        const clean = await this.retryCallback(record, report);
        if (clean) await this.setCheckedUntil(record, new Date(runStart - WATERMARK_MARGIN_MS).toISOString());
        else report.upToDate = false;
      }
      return report;
    });
  }

  /**
   * Returns true when everything up to now is settled. Two listings: the source's requests (with headers and body,
   * for re-sending; a tunnel source feeds only this connection) and this connection's events. Ignored events are
   * only looked up for a request with no event that has some.
   */
  private async retryCallback(record: CallbackRecord, report: RetryReport): Promise<boolean> {
    const { hookdeck } = this.deps;
    const since = record.checkedUntil ?? record.createdAt;
    const requests = await allPages((next) =>
      hookdeck.listRequests({ source_id: record.sourceId, created_at_gte: since, order_by: 'created_at', dir: 'asc', limit: 100, includeData: true, next }),
    );
    const events = await allPages((next) => hookdeck.listEvents({ webhook_id: record.connectionId, created_at_gte: since, next }));
    const eventsByRequest = new Map<string, HookdeckEvent[]>();
    for (const event of events.models) eventsByRequest.set(event.request_id, [...(eventsByRequest.get(event.request_id) ?? []), event]);

    // One decision per event: its latest attempt (the original request, or the bridge's latest re-send of it).
    const latest = new Map<string, HookdeckRequest>();
    for (const request of requests.models) {
      if (!request.verified) continue; // rejected at the source: never meant for the agent
      const root = header(request, RETRY_OF_HEADER) ?? request.id;
      if (this.unlisted.get(root)?.id === header(request, RESEND_ID_HEADER)) this.unlisted.delete(root); // the re-send is listed now
      const seen = latest.get(root);
      if (!seen || Date.parse(request.created_at) >= Date.parse(seen.created_at)) latest.set(root, request);
    }

    let clean = requests.complete && events.complete;
    for (const [root, request] of latest) {
      report.requestsChecked++;
      const state = await this.attemptState(record, request, eventsByRequest.get(request.id) ?? []);
      if (state === 'pending') {
        report.pending++;
        clean = false;
      } else if (state === 'rejected') {
        report.rejectedByAgent++;
      } else if (state === 'missed') {
        const subscription = this.deps.subscription(header(request, 'x-mcp-subscription-id') ?? '');
        if (!subscription) continue; // the subscription has ended: nothing to deliver to
        if (this.unlisted.has(root)) {
          // Re-sent, and the re-send isn't listed yet: wait for it rather than send again.
          report.pending++;
          clean = false;
          continue;
        }
        const id = randomUUID();
        await this.resend(record, subscription, request, root, id);
        this.unlisted.set(root, { id, at: this.now().getTime() });
        report.resent++;
        clean = false;
      }
    }
    return clean;
  }

  private async attemptState(record: CallbackRecord, request: HookdeckRequest, events: HookdeckEvent[]): Promise<'delivered' | 'pending' | 'rejected' | 'missed' | 'settled'> {
    if (events.length > 0) {
      if (events.some((e) => e.status === 'SUCCESSFUL')) return 'delivered';
      if (events.some((e) => UNSETTLED.has(e.status))) return 'pending';
      // FAILED: with a response, the agent answered with an error; without one, the CLI never delivered it.
      return events.some((e) => typeof e.response_status === 'number') ? 'rejected' : 'missed';
    }
    // No event and no ignored event: Event Gateway hasn't processed the request yet.
    if (!request.ignored_count) return 'pending';
    const ignored = (await this.deps.hookdeck.listIgnoredEventsForRequest(request.id)).models.filter((i) => i.webhook_id === record.connectionId);
    if (ignored.some((i) => i.cause === 'CLI_DISCONNECTED')) return 'missed';
    // Ignored for another reason is final.
    return ignored.length > 0 ? 'settled' : 'pending';
  }

  /** Sends a missed delivery again: same webhook-id and body, fresh timestamp, signed with the agent's secret(s) and the source's. */
  private async resend(record: CallbackRecord, subscription: SubscriptionRecord, request: HookdeckRequest, root: string, resendId: string) {
    const webhookId = header(request, 'webhook-id');
    const body = request.data?.body;
    if (!webhookId || body === undefined) throw new Error(`request ${request.id} has no webhook-id or body to resend`);
    const raw = typeof body === 'string' ? body : JSON.stringify(body);
    const secrets = [subscription.secret];
    if (subscription.previousSecret && subscription.previousSecretExpiresAt && Date.parse(subscription.previousSecretExpiresAt) > this.now().getTime()) {
      secrets.push(subscription.previousSecret);
    }
    const sourceSecret = await this.signingSecret(record.url);
    if (sourceSecret) secrets.push(sourceSecret);
    const res = await this.fetch(record.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...signStandardWebhook(secrets, webhookId, raw),
        'X-MCP-Subscription-Id': subscription.id,
        [RETRY_OF_HEADER]: root,
        [RESEND_ID_HEADER]: resendId,
      },
      body: raw,
    });
    if (!res.ok) throw new Error(`resending ${webhookId} to ${record.sourceName} failed: HTTP ${res.status}`);
  }

  private async setCheckedUntil(record: CallbackRecord, checkedUntil: string) {
    if (record.checkedUntil && Date.parse(record.checkedUntil) >= Date.parse(checkedUntil)) return;
    const metadata: Metadata = { v: 1, kind: CALLBACK_KIND, agent: record.agent, name: record.name, path: record.path, port: record.port, createdAt: record.createdAt, checkedUntil };
    await this.deps.hookdeck.upsertConnection({
      name: record.connectionName,
      description: JSON.stringify(metadata),
      source_id: record.sourceId,
      destination: { name: record.destinationName, type: 'CLI', config: { path: record.path } },
    });
    record.checkedUntil = checkedUntil;
  }
}

/** A request header by name, whatever its stored case. */
function header(request: HookdeckRequest, name: string): string | undefined {
  const headers = request.data?.headers ?? {};
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
  return key ? headers[key] : undefined;
}

function parseMetadata(description: string | null | undefined): Metadata | null {
  try {
    const parsed = JSON.parse(description ?? '') as Metadata;
    if (parsed?.kind !== CALLBACK_KIND || parsed.v !== 1 || typeof parsed.agent !== 'string' || typeof parsed.name !== 'string') return null;
    return { ...parsed, checkedUntil: parsed.checkedUntil ?? null };
  } catch {
    return null;
  }
}

function recordFrom(
  metadata: Metadata,
  connection: { id: string; name: string; source: { id: string; name: string; url: string }; destination: { name: string } },
): CallbackRecord {
  return {
    agent: metadata.agent,
    name: metadata.name,
    url: connection.source.url,
    path: metadata.path ?? DEFAULT_CALLBACK_PATH,
    port: metadata.port ?? DEFAULT_AGENT_PORT,
    sourceId: connection.source.id,
    sourceName: connection.source.name,
    connectionId: connection.id,
    connectionName: connection.name,
    destinationName: connection.destination.name,
    createdAt: metadata.createdAt,
    checkedUntil: metadata.checkedUntil,
  };
}

function ignoreNotFound(error: unknown): void {
  if (error instanceof HookdeckApiError && error.status === 404) return;
  throw error;
}
