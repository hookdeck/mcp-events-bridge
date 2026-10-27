import { allPages, HookdeckApiError, type HookdeckClient, type HookdeckEvent, type HookdeckRequest } from './hookdeck.js';
import { isValidWebhookSecret } from './secret.js';
import type { SubscriptionRecord } from './store.js';

/*
 * Callback URLs for local agents (create_callback_url). An agent on a laptop has no public URL, so the bridge gives it
 * one: an Event Gateway source whose URL is the callback URL, with a connection to the agent's CLI destination. The
 * bridge, running on the same machine, runs `hookdeck listen` to forward deliveries to the agent's local port (see
 * host/local-runtime.ts).
 *
 *   agent-<agent>            CLI destination, shared by the agent's URLs (one local port and path)
 *   agent-<agent>-<name>     source + connection, one per URL
 *
 * Each subscription's own destination delivers to the URL, signed with the subscriber's secret. Two kinds:
 *
 * - With the client's secret (the one it subscribes with): an MCP_EVENTS source holding that secret, which answers the
 *   subscribe challenge and rejects anything not signed with it. One URL holds one secret, so rotating means a new URL
 *   (an updated source secret takes about a minute to reach Event Gateway's edge).
 * - Without one (pass-through): a WEBHOOK source with no verification, for clients that use a secret per subscription
 *   under one base URL (Hermes Agent). Event Gateway can't hold several secrets on a source, so it can't answer the
 *   challenge or verify deliveries: the bridge verifies the URL out-of-band (it created it, for this agent) and the
 *   receiver must check every signature itself.
 *
 * A callback URL also covers the paths under it: a client that builds every callback from one base URL plus a path
 * (Hermes: `<base>/mcp/events/webhook/<id>`) can use one as that base. The source receives at a sub-path and `listen`
 * forwards the sub-path (probed 7 Oct).
 *
 * A callback is deleted by the sweeper once no subscription has used it for a grace period, not the moment one ends:
 * an agent changing a subscription's arguments unsubscribes and subscribes again on the same URL.
 *
 * Callback metadata lives in the connection description, like subscriptions. Version 1 is a 0.7 callback, whose source
 * held a secret the bridge generated: setup migrates it.
 */

export const CALLBACK_KIND = 'mcp-events-callback';
const NAME = /^[A-Za-z0-9_]{1,40}$/;
const PATH = /^\/[A-Za-z0-9/_.-]*$/;
/** `hookdeck listen` takes at most 10 source names. */
export const LISTEN_SOURCES_PER_COMMAND = 10;
export const DEFAULT_CALLBACK_PATH = '/events';
export const DEFAULT_AGENT_PORT = 3000;
const UNSETTLED = new Set(['QUEUED', 'SCHEDULED', 'HOLD']);
/** The watermark trails the run by this much: requests still being processed are checked again (checking is idempotent). */
const WATERMARK_MARGIN_MS = 2 * 60 * 1000;
/**
 * A retried event takes a few seconds to reach the callback source and appear in its request listing, so a run straight
 * after a retry would still see only the missed delivery and retry it again. For this long after a retry, it counts as
 * pending; after that, it's judged again.
 */
const RETRY_SETTLE_MS = 3 * 60 * 1000;
/**
 * Event Gateway's header search can lag a new event (seen live: a delivery missed seconds earlier wasn't found yet), so
 * a missed delivery whose event isn't found counts as pending for this long; after that, its event is judged gone.
 */
const EVENT_SEARCH_LAG_MS = 10 * 60 * 1000;

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
  /** No secret: Event Gateway neither answers the challenge nor verifies deliveries; the receiver checks each one. */
  passThrough: boolean;
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
  v: 2;
  kind: typeof CALLBACK_KIND;
  agent: string;
  name: string;
  path: string;
  port: number;
  passThrough: boolean;
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
  /** Deliveries checked (one per subscription and event, however many attempts it took). */
  deliveriesChecked: number;
  /** Missed deliveries retried: the subscription's event, which Event Gateway signs afresh. */
  retried: number;
  /** Deliveries still in flight, or not yet processed by Event Gateway: checked again next time. */
  pending: number;
  /** Deliveries the agent itself answered with an error: not retried. */
  rejectedByAgent: number;
  /** True when nothing needed retrying, so the next run starts from about now. */
  upToDate: boolean;
}

export type CallbacksHookdeck = Pick<
  HookdeckClient,
  'upsertSource' | 'listSources' | 'getSource' | 'deleteSource' | 'upsertConnection' | 'deleteConnection' | 'listAllConnections' | 'listRequests' | 'listEvents' | 'listIgnoredEventsForRequest' | 'retryEvent'
>;

/** Bad input to create_callback_url: reported to the caller as is. */
export class CallbackInputError extends Error {}

export const destinationNameFor = (agent: string) => `agent-${agent}`;
export const callbackResourceName = (agent: string, name: string) => `agent-${agent}-${name}`;

export class CallbackRegistry {
  private readonly byUrl = new Map<string, CallbackRecord>();
  /** When the sweeper first saw a callback with no subscription. */
  private readonly unusedSince = new Map<string, number>();
  /** Callbacks whose connection is gone but whose source delete failed: hidden, and retried by the sweeper. */
  private readonly deleting = new Set<string>();
  private readonly listeners = new Set<() => void>();
  /** When each missed delivery (by subscription and webhook-id) was last retried: see RETRY_SETTLE_MS. */
  private readonly retried = new Map<string, number>();
  private writes: Promise<unknown> = Promise.resolve();
  private retries: Promise<unknown> = Promise.resolve();
  private readonly settings: CallbackSettings;
  private readonly now: () => Date;
  private readonly log: (message: string) => void;

  constructor(
    private readonly deps: {
      hookdeck: CallbacksHookdeck;
      /** Whether a subscription uses a callback URL. */
      inUse: (url: string) => boolean;
      /** A subscription by id: its connection is where a missed delivery is retried. */
      subscription: (id: string) => SubscriptionRecord | undefined;
      /** Called when a callback is deleted, so cached endpoint verification for its URL is dropped. */
      onDeleted?: (url: string) => void;
      settings?: Partial<CallbackSettings>;
      now?: () => Date;
      log?: (message: string) => void;
    },
  ) {
    this.settings = { ...DEFAULT_CALLBACK_SETTINGS, ...deps.settings };
    this.now = deps.now ?? (() => new Date());
    this.log = deps.log ?? (() => {});
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

  /** Builds the index from Event Gateway. Call once at startup. `legacy` counts 0.7 callbacks, which setup migrates. */
  async load(): Promise<{ loaded: number; legacy: number }> {
    let legacy = 0;
    for (const connection of await this.deps.hookdeck.listAllConnections()) {
      if (isLegacyCallback(connection.description)) {
        legacy++;
        continue;
      }
      const metadata = parseMetadata(connection.description);
      if (!metadata || !connection.source?.url) continue;
      // A deleted source is still listed on its connection, without a name. That callback can't receive again.
      if (!connection.source.name) {
        await this.deps.hookdeck.deleteConnection(connection.id).catch(ignoreNotFound);
        this.log(`deleted callback URL ${connection.name}: its source was deleted`);
        continue;
      }
      this.byUrl.set(connection.source.url, recordFrom(metadata, connection));
    }
    return { loaded: this.byUrl.size, legacy };
  }

  /** The bridge callback URL a callback URL belongs to: the URL itself, or one it's a sub-path of. */
  find(url: string): CallbackRecord | undefined {
    const exact = this.byUrl.get(url);
    if (exact) return this.deleting.has(url) ? undefined : exact;
    for (const [base, record] of this.byUrl) {
      if (url.startsWith(`${base}/`) && !this.deleting.has(base)) return record;
    }
    return undefined;
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

  /**
   * Creates a callback URL, or returns the existing one with that name. With `secret` (the one the client subscribes
   * with), Event Gateway answers the challenge and verifies every delivery; without one, the URL is pass-through.
   */
  create(input: { agent: string; name: string; path?: string; port?: number; secret?: string }): Promise<CallbackRecord> {
    const { agent, name, secret } = input;
    if (!NAME.test(agent)) throw new CallbackInputError('agent must be 1-40 letters, digits or _');
    if (!NAME.test(name)) throw new CallbackInputError('name must be 1-40 letters, digits or _');
    if (input.path !== undefined && !PATH.test(input.path)) throw new CallbackInputError('path must start with / and use letters, digits, /, _, . or -');
    if (input.port !== undefined && (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535)) throw new CallbackInputError('port must be 1-65535');
    if (secret !== undefined && !isValidWebhookSecret(secret)) throw new CallbackInputError('secret must be whsec_ followed by base64 of 24 to 64 bytes');
    const passThrough = secret === undefined;

    return this.serialize(async () => {
      const existing = this.forAgent(agent).find((r) => r.name === name);
      if (existing) {
        if (existing.passThrough !== passThrough || (secret && (await this.sourceSecret(existing.sourceId)) !== secret)) {
          throw new CallbackInputError(
            `callback URL ${name} was created ${existing.passThrough ? 'without a secret' : 'with a different secret'}. One URL holds one secret: to rotate, create a callback URL with a new name and subscribe with it.`,
          );
        }
        return existing;
      }
      const agentPath = this.agentPath(agent);
      if (agentPath && input.path !== undefined && input.path !== agentPath) {
        throw new CallbackInputError(`agent ${agent} receives on ${agentPath}: all of an agent's callback URLs share one local path`);
      }
      const agentPort = this.agentPort(agent);
      if (agentPort && input.port !== undefined && input.port !== agentPort) {
        throw new CallbackInputError(`agent ${agent} receives on port ${agentPort}: all of an agent's callback URLs share one local port`);
      }
      if (this.forAgent(agent).length >= this.settings.maxPerAgent) {
        throw new CallbackInputError(`agent ${agent} has ${this.settings.maxPerAgent} callback URLs, the maximum; unsubscribe from some first`);
      }
      const path = agentPath ?? input.path ?? DEFAULT_CALLBACK_PATH;
      const port = agentPort ?? input.port ?? DEFAULT_AGENT_PORT;

      const resourceName = callbackResourceName(agent, name);
      // A source left from an earlier run (its delete failed) is reused if it's the same kind with the same secret, rather
      // than changed: an updated secret takes about a minute to reach the edge.
      let source = (await this.deps.hookdeck.listSources({ name: resourceName })).models[0];
      if (source) {
        const reusable = passThrough ? source.type === 'WEBHOOK' : source.type === 'MCP_EVENTS' && (await this.sourceSecret(source.id)) === secret;
        if (!reusable) throw new CallbackInputError(`Event Gateway already has a source named ${resourceName} with a different secret; use another name`);
      } else {
        source = await this.deps.hookdeck.upsertSource(
          passThrough ? { name: resourceName, type: 'WEBHOOK', config: {} } : { name: resourceName, type: 'MCP_EVENTS', config: { auth: { webhook_secret_key: secret } } },
        );
      }

      const metadata: Metadata = { v: 2, kind: CALLBACK_KIND, agent, name, path, port, passThrough, createdAt: this.now().toISOString(), checkedUntil: null };
      const connection = await this.deps.hookdeck.upsertConnection({
        name: resourceName,
        description: JSON.stringify(metadata),
        source_id: source.id,
        destination: { name: destinationNameFor(agent), type: 'CLI', config: { path } },
      });
      const record = recordFrom(metadata, { ...connection, source: { ...connection.source, url: source.url } });
      this.byUrl.set(record.url, record);
      this.log(`created callback URL ${resourceName}${passThrough ? ' (pass-through: its receiver must verify every delivery)' : ''}`);
      this.changed();
      return record;
    });
  }

  private async sourceSecret(sourceId: string): Promise<string | undefined> {
    const auth = (await this.deps.hookdeck.getSource(sourceId, { includeAuth: true })).config?.auth;
    return typeof auth?.webhook_secret_key === 'string' ? auth.webhook_secret_key : undefined;
  }

  /** Deletes callback URLs no subscription has used for the grace period. Run from the sweeper. */
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
          this.log(`deleted unused callback URL ${record.connectionName}`);
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
    this.unusedSince.delete(record.url);
    this.deleting.delete(record.url);
  }

  /**
   * Retries deliveries an agent missed while `hookdeck listen` wasn't running: a request ignored as CLI_DISCONNECTED
   * (the CLI was offline) or an event that FAILED without a response (the CLI dropped mid-delivery). The retry is of
   * the subscription's own event, on its connection: Event Gateway signs every attempt afresh (same webhook-id, a new
   * timestamp), so the agent's timestamp check passes however late it is, and a pass-through URL needs no secret here.
   * Retrying the callback's request instead would replay the original timestamp, which a receiver rejects once it's
   * over five minutes old. Each delivery is judged by all its attempts at the callback source (grouped by subscription
   * and webhook-id). Ones the agent answered with an error aren't retried. Delivery is at least once: agents dedupe by
   * webhook-id. Run it while the agent's `listen` is connected: a retry while it's down is only ignored again.
   */
  retryMissed(agent: string): Promise<RetryReport> {
    return this.serializeRetry(async () => {
      const cutoff = this.now().getTime() - RETRY_SETTLE_MS;
      for (const [key, at] of this.retried) if (at < cutoff) this.retried.delete(key);
      const report: RetryReport = { callbacks: 0, deliveriesChecked: 0, retried: 0, pending: 0, rejectedByAgent: 0, upToDate: true };
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
   * Returns true when everything up to now is settled. Two listings: the callback source's requests (with headers, to
   * group attempts by subscription and webhook-id; the source feeds only this connection) and this connection's events.
   * Ignored events are only looked up for a request with no event that has some.
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

    // Every attempt at each delivery: the original, and the requests retrying the subscription's event created.
    const deliveries = new Map<string, { subscriptionId: string; webhookId: string; requests: HookdeckRequest[] }>();
    for (const request of requests.models) {
      // Rejected at the source (a bad signature at a URL with a secret): never meant for the agent. A pass-through source
      // verifies nothing, so its requests are all `verified: false` (verified live): that isn't a rejection.
      if (request.rejection_cause) continue;
      const subscriptionId = header(request, 'x-mcp-subscription-id');
      const webhookId = header(request, 'webhook-id');
      if (!subscriptionId || !webhookId) continue; // not a subscription's delivery (a stray request to a pass-through URL)
      const key = `${subscriptionId} ${webhookId}`;
      const delivery = deliveries.get(key) ?? { subscriptionId, webhookId, requests: [] };
      delivery.requests.push(request);
      deliveries.set(key, delivery);
    }

    let clean = requests.complete && events.complete;
    for (const [key, delivery] of deliveries) {
      report.deliveriesChecked++;
      const states = await Promise.all(delivery.requests.map((r) => this.attemptState(record, r, eventsByRequest.get(r.id) ?? [])));
      if (states.includes('delivered') || states.includes('settled')) continue;
      if (states.includes('pending')) {
        report.pending++;
        clean = false;
        continue;
      }
      if (states.includes('rejected')) {
        report.rejectedByAgent++;
        continue;
      }
      // Missed. The subscription has ended (nothing to deliver to), or isn't on this callback URL.
      const subscription = this.deps.subscription(delivery.subscriptionId);
      if (!subscription || this.find(subscription.url) !== record) continue;
      if (this.retried.has(key)) {
        // Retried, and the retry isn't listed yet: wait for it rather than retry again.
        report.pending++;
        clean = false;
        continue;
      }
      const upstream = (await hookdeck.listEvents({ webhook_id: subscription.connectionId, headers: { 'webhook-id': delivery.webhookId }, limit: 5 })).models;
      const event = upstream.at(-1);
      if (!event) {
        const newest = Math.max(...delivery.requests.map((r) => Date.parse(r.created_at)));
        if (this.now().getTime() - newest < EVENT_SEARCH_LAG_MS) {
          // Probably not searchable yet: try again next run, and hold the watermark.
          report.pending++;
          clean = false;
          continue;
        }
        this.log(`can't retry ${delivery.webhookId} for ${delivery.subscriptionId}: Event Gateway no longer has its event`);
        continue;
      }
      await hookdeck.retryEvent(event.id);
      this.retried.set(key, this.now().getTime());
      report.retried++;
      clean = false;
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

  private setCheckedUntil(record: CallbackRecord, checkedUntil: string) {
    // In the write queue, and only for a callback still here: an upsert after the sweeper deleted the connection
    // would create it again, on a source the sweeper then deletes (seen in the e2e run on 26 Oct).
    return this.serialize(async () => {
      if (this.byUrl.get(record.url) !== record || this.deleting.has(record.url)) return;
      if (record.checkedUntil && Date.parse(record.checkedUntil) >= Date.parse(checkedUntil)) return;
      const metadata: Metadata = {
        v: 2,
        kind: CALLBACK_KIND,
        agent: record.agent,
        name: record.name,
        path: record.path,
        port: record.port,
        passThrough: record.passThrough,
        createdAt: record.createdAt,
        checkedUntil,
      };
      await this.deps.hookdeck.upsertConnection({
        name: record.connectionName,
        description: JSON.stringify(metadata),
        source_id: record.sourceId,
        destination: { name: record.destinationName, type: 'CLI', config: { path: record.path } },
      });
      record.checkedUntil = checkedUntil;
    });
  }
}

/** A request header by name, whatever its stored case. */
function header(request: HookdeckRequest, name: string): string | undefined {
  const headers = request.data?.headers ?? {};
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
  return key ? headers[key] : undefined;
}

/** A 0.7 callback (`create_tunnel_url`): its source holds a secret the bridge generated and signed with. */
export function isLegacyCallback(description: string | null | undefined): boolean {
  try {
    const parsed = JSON.parse(description ?? '') as { kind?: unknown; v?: unknown };
    return parsed?.kind === CALLBACK_KIND && parsed.v === 1;
  } catch {
    return false;
  }
}

function parseMetadata(description: string | null | undefined): Metadata | null {
  try {
    const parsed = JSON.parse(description ?? '') as Metadata;
    if (parsed?.kind !== CALLBACK_KIND || parsed.v !== 2 || typeof parsed.agent !== 'string' || typeof parsed.name !== 'string') return null;
    return { ...parsed, passThrough: parsed.passThrough === true, checkedUntil: parsed.checkedUntil ?? null };
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
    passThrough: metadata.passThrough,
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
