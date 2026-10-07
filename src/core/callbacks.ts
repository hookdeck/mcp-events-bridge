import { HookdeckApiError, type HookdeckClient } from './hookdeck.js';
import { generateWebhookSecret } from './secret.js';

/*
 * Callback URLs for local agents. An agent on a laptop has no public URL, so
 * the bridge gives each of its subscriptions one: an Event Gateway MCP Events
 * source (which answers the subscribe challenge and verifies deliveries) with
 * a connection to the agent's CLI destination, and `hookdeck listen` forwards
 * deliveries to the agent's local port.
 *
 *   agent-<agent>            CLI destination, shared by the agent's callbacks
 *   agent-<agent>-<name>     MCP Events source + connection, one per callback
 *
 * The source's secret is generated here and never leaves the bridge. The
 * agent subscribes with its own secret (client-supplied, as the spec says),
 * and the bridge signs the challenge and every delivery to a callback with
 * both: the source verifies one signature, the agent the other. So the source
 * never needs updating (an updated source secret took about a minute to reach
 * Event Gateway's edge when tested), and the agent can rotate its secret
 * without touching Event Gateway.
 *
 * Callback metadata lives in the connection description, like subscriptions.
 */

export const CALLBACK_KIND = 'mcp-events-callback';
const NAME = /^[A-Za-z0-9_]{1,40}$/;
/** `hookdeck listen` takes at most 10 source names. */
export const LISTEN_SOURCES_PER_COMMAND = 10;
const UNSETTLED = new Set(['QUEUED', 'SCHEDULED', 'HOLD']);

export interface CallbackRecord {
  agent: string;
  name: string;
  url: string;
  path: string;
  sourceId: string;
  sourceName: string;
  connectionId: string;
  connectionName: string;
  destinationName: string;
  createdAt: string;
  /** Requests before this time are known to be delivered (see replay). */
  replayedUntil: string | null;
}

interface Metadata {
  v: 1;
  kind: typeof CALLBACK_KIND;
  agent: string;
  name: string;
  path: string;
  createdAt: string;
  replayedUntil: string | null;
}

export interface ReplayReport {
  callbacks: number;
  requestsChecked: number;
  eventsRetried: number;
  requestsRetried: number;
  /** Deliveries still in flight, or retries that found no connected `hookdeck listen`. */
  pending: number;
  /** True when nothing needed replaying, so the next run starts from now. */
  upToDate: boolean;
}

export type CallbacksHookdeck = Pick<
  HookdeckClient,
  | 'upsertSource'
  | 'listSources'
  | 'getSource'
  | 'deleteSource'
  | 'upsertConnection'
  | 'deleteConnection'
  | 'listAllConnections'
  | 'listRequests'
  | 'listEventsForRequest'
  | 'listIgnoredEventsForRequest'
  | 'retryEvent'
  | 'retryRequest'
>;

export class CallbackNameError extends Error {}

export const destinationNameFor = (agent: string) => `agent-${agent}`;
export const callbackResourceName = (agent: string, name: string) => `agent-${agent}-${name}`;

export class CallbackRegistry {
  private readonly byUrl = new Map<string, CallbackRecord>();
  private readonly secrets = new Map<string, string>();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly now: () => Date;
  private readonly log: (message: string) => void;

  constructor(
    private readonly deps: {
      hookdeck: CallbacksHookdeck;
      /** Whether a subscription still uses a callback URL, so release leaves it alone. */
      inUse: (url: string) => boolean;
      now?: () => Date;
      log?: (message: string) => void;
    },
  ) {
    this.now = deps.now ?? (() => new Date());
    this.log = deps.log ?? (() => {});
  }

  /** Writes one at a time: concurrent upserts creating resources can fail (see the store). */
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
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
    return this.byUrl.get(url);
  }

  forAgent(agent: string): CallbackRecord[] {
    return [...this.byUrl.values()].filter((r) => r.agent === agent).sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Creates a callback URL, or returns the existing one with that name. */
  create(input: { agent: string; name: string; path?: string }): Promise<CallbackRecord> {
    const { agent, name } = input;
    if (!NAME.test(agent)) throw new CallbackNameError('agent must be 1-40 letters, digits or _');
    if (!NAME.test(name)) throw new CallbackNameError('name must be 1-40 letters, digits or _');
    const path = input.path ?? '/events';
    if (!/^\/[A-Za-z0-9/_.-]*$/.test(path)) throw new CallbackNameError('path must start with / and use letters, digits, /, _, . or -');

    return this.serialize(async () => {
      const existing = this.forAgent(agent).find((r) => r.name === name);
      if (existing) return existing;

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

      const metadata: Metadata = { v: 1, kind: CALLBACK_KIND, agent, name, path, createdAt: this.now().toISOString(), replayedUntil: null };
      const connection = await this.deps.hookdeck.upsertConnection({
        name: resourceName,
        description: JSON.stringify(metadata),
        source_id: source.id,
        destination: { name: destinationNameFor(agent), type: 'CLI', config: { path } },
      });
      const record = recordFrom(metadata, { ...connection, source: { ...connection.source, url: source.url } });
      this.byUrl.set(record.url, record);
      this.secrets.set(record.url, secret);
      this.log(`created callback ${resourceName}`);
      return record;
    });
  }

  /** The callback source's own secret, which the bridge adds to the challenge and deliveries for this URL. */
  async signingSecret(url: string): Promise<string | undefined> {
    const record = this.byUrl.get(url);
    if (!record) return undefined;
    const cached = this.secrets.get(url);
    if (cached) return cached;
    const auth = (await this.deps.hookdeck.getSource(record.sourceId, { includeAuth: true })).config?.auth;
    const secret = typeof auth?.webhook_secret_key === 'string' ? auth.webhook_secret_key : undefined;
    if (secret) this.secrets.set(url, secret);
    return secret;
  }

  /** After a subscription ends: deletes the callback's source and connection if no subscription uses it. The agent's destination stays. */
  release(url: string): Promise<boolean> {
    return this.serialize(async () => {
      const record = this.byUrl.get(url);
      if (!record || this.deps.inUse(url)) return false;
      await this.deps.hookdeck.deleteConnection(record.connectionId).catch(ignoreNotFound);
      await this.deps.hookdeck.deleteSource(record.sourceId).catch(ignoreNotFound);
      this.byUrl.delete(url);
      this.secrets.delete(url);
      this.log(`deleted callback ${record.connectionName}`);
      return true;
    });
  }

  /** `hookdeck listen` commands covering all of an agent's callbacks (10 sources each). */
  listenCommands(agent: string, port: number): string[] {
    const names = this.forAgent(agent).map((r) => r.sourceName);
    const commands: string[] = [];
    for (let i = 0; i < names.length; i += LISTEN_SOURCES_PER_COMMAND) {
      commands.push(`hookdeck listen ${port} ${names.slice(i, i + LISTEN_SOURCES_PER_COMMAND).join(',')}`);
    }
    return commands;
  }

  /**
   * Replays deliveries an agent missed while `hookdeck listen` wasn't running:
   * requests ignored as CLI_DISCONNECTED (the CLI was offline) are retried for
   * the callback's connection, and FAILED events (the CLI dropped mid-delivery)
   * are retried. Run it once `listen` is connected again. Each callback's
   * watermark only advances after a run with nothing to replay and nothing in
   * flight, so a run while `listen` is still offline loses nothing.
   */
  replay(agent: string): Promise<ReplayReport> {
    return this.serialize(async () => {
      const report: ReplayReport = { callbacks: 0, requestsChecked: 0, eventsRetried: 0, requestsRetried: 0, pending: 0, upToDate: true };
      for (const record of this.forAgent(agent)) {
        report.callbacks++;
        const runStart = this.now().toISOString();
        const before = report.eventsRetried + report.requestsRetried + report.pending;
        await this.replayCallback(record, report);
        if (report.eventsRetried + report.requestsRetried + report.pending === before) {
          await this.setReplayedUntil(record, runStart);
        } else {
          report.upToDate = false;
        }
      }
      return report;
    });
  }

  private async replayCallback(record: CallbackRecord, report: ReplayReport) {
    const { hookdeck } = this.deps;
    let next: string | undefined;
    for (let page = 0; page < 100; page++) {
      const result = await hookdeck.listRequests({
        source_id: record.sourceId,
        created_at_gte: record.replayedUntil ?? record.createdAt,
        order_by: 'created_at',
        dir: 'asc',
        limit: 100,
        next,
      });
      for (const request of result.models) {
        if (!request.verified) continue; // rejected at the source: never meant for the agent
        report.requestsChecked++;
        const events = (await hookdeck.listEventsForRequest(request.id)).models.filter((e) => e.webhook_id === record.connectionId);
        if (events.length > 0) {
          for (const event of events) {
            if (event.status === 'FAILED') {
              await hookdeck.retryEvent(event.id);
              report.eventsRetried++;
            } else if (UNSETTLED.has(event.status)) {
              report.pending++;
            }
          }
          continue;
        }
        const ignored = (await hookdeck.listIgnoredEventsForRequest(request.id)).models;
        if (ignored.some((i) => i.webhook_id === record.connectionId && i.cause === 'CLI_DISCONNECTED')) {
          const retried = await hookdeck.retryRequest(request.id, [record.connectionId]);
          if (retried.events?.length) report.requestsRetried++;
          else report.pending++; // still no CLI session: try again later
        }
      }
      const cursor = (result as { pagination?: { next?: string } }).pagination?.next;
      if (!cursor || result.models.length === 0) return;
      next = cursor.startsWith('http') ? (new URL(cursor).searchParams.get('next') ?? undefined) : cursor;
      if (!next) return;
    }
  }

  private async setReplayedUntil(record: CallbackRecord, replayedUntil: string) {
    const metadata: Metadata = {
      v: 1,
      kind: CALLBACK_KIND,
      agent: record.agent,
      name: record.name,
      path: record.path,
      createdAt: record.createdAt,
      replayedUntil,
    };
    await this.deps.hookdeck.upsertConnection({
      name: record.connectionName,
      description: JSON.stringify(metadata),
      source_id: record.sourceId,
      destination: { name: record.destinationName, type: 'CLI', config: { path: record.path } },
    });
    record.replayedUntil = replayedUntil;
  }
}

function parseMetadata(description: string | null | undefined): Metadata | null {
  try {
    const parsed = JSON.parse(description ?? '') as Metadata;
    return parsed?.kind === CALLBACK_KIND && parsed.v === 1 && typeof parsed.agent === 'string' && typeof parsed.name === 'string' ? parsed : null;
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
    path: metadata.path ?? '/events',
    sourceId: connection.source.id,
    sourceName: connection.source.name,
    connectionId: connection.id,
    connectionName: connection.name,
    destinationName: connection.destination.name,
    createdAt: metadata.createdAt,
    replayedUntil: metadata.replayedUntil ?? null,
  };
}

function ignoreNotFound(error: unknown): void {
  if (error instanceof HookdeckApiError && error.status === 404) return;
  throw error;
}
