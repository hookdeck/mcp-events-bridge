import { allPages, type HookdeckClient, type HookdeckEvent } from './hookdeck.js';

/*
 * Recovers provider events a bridge on a laptop missed while its `hookdeck
 * listen` was down (the laptop slept, or the bridge was stopped). Ported from
 * the fleet demo's recover.ts. Event Gateway keeps every request, so nothing
 * is lost, only undelivered, in one of two ways:
 *
 *   Within about 2 minutes of the session dropping, an event is created for
 *   the bridge's inbound connection and fails without a response: retry the
 *   event, once it has settled as FAILED.
 *
 *   After that, no event is created: the request records an ignored event
 *   with cause CLI_DISCONNECTED. Retry the request, scoped to this
 *   deployment's inbound connection only (a deployed bridge on the same
 *   provider source has its own connection and already got it).
 *
 * Only settled events are retried: an event still queued or scheduled is
 * Event Gateway's to finish, and retrying it would deliver it twice. The
 * relay signs fresh deliveries for each retried event, as for any inbound
 * request.
 *
 * Each run makes two listings, both narrowed to what matters: the
 * connection's own events (`GET /events?webhook_id=`), and the source's
 * requests that have ignored events (`ignored_count[gt]=0`, since Event
 * Gateway has no listing of ignored events across requests). Only those
 * requests are looked at one by one. Requests too new to have been processed
 * are covered by the watermark's margin: the next run checks them again.
 * Run it while the bridge's `listen` is connected: a retry while it's down
 * is only ignored again.
 *
 * The watermark (requests before it are settled) is kept in memory, and in a
 * small state file when the host gives one, so a bridge started again after a
 * weekend checks from where it stopped. Without one it looks back
 * `lookbackMs` on its first run.
 */

const CAUSE = 'CLI_DISCONNECTED';
const UNSETTLED = new Set(['QUEUED', 'SCHEDULED', 'HOLD']);
const WATERMARK_MARGIN_MS = 2 * 60 * 1000;
/** A request or event retried less than this long ago isn't retried again: its retry may not be listed yet. */
const RETRY_SETTLE_MS = 3 * 60 * 1000;

export interface InboundTarget {
  /** Source name, e.g. bridge-resend. */
  source: string;
  /** This deployment's inbound connection name, e.g. bridge-resend-dev. */
  connection: string;
}

export interface RecoveryReport {
  /** This connection's events checked. */
  eventsChecked: number;
  /** Requests with ignored events checked. */
  requestsChecked: number;
  /** Requests retried for this connection (no event had been created). */
  retriedRequests: number;
  /** Events retried (created, then failed without a response). */
  retriedEvents: number;
  /** In flight, or not yet processed: checked again next run. */
  pending: number;
  upToDate: boolean;
}

export interface RecoveryState {
  load(): Record<string, string>;
  save(watermarks: Record<string, string>): void;
}

export type RecoveryHookdeck = Pick<
  HookdeckClient,
  'listAllConnections' | 'listRequests' | 'listEvents' | 'listIgnoredEventsForRequest' | 'retryRequest' | 'retryEvent'
>;

export class InboundRecovery {
  private readonly watermarks: Record<string, string>;
  /** When this process last retried each request or event id: see RETRY_SETTLE_MS. */
  private readonly retried = new Map<string, number>();
  private running: Promise<RecoveryReport> | undefined;
  private readonly now: () => Date;
  private readonly log: (message: string) => void;

  constructor(
    private readonly deps: {
      hookdeck: RecoveryHookdeck;
      targets: InboundTarget[];
      state?: RecoveryState;
      /** Called with each request id it retries, so the relay treats that delivery as a retry (see RelayDeps.recovered). */
      onRetried?: (requestId: string) => void;
      /** How far back the first run looks when there's no saved watermark. Default 24 hours. */
      lookbackMs?: number;
      now?: () => Date;
      log?: (message: string) => void;
    },
  ) {
    this.now = deps.now ?? (() => new Date());
    this.log = deps.log ?? (() => {});
    this.watermarks = safeLoad(deps.state);
  }

  /** One run at a time; a call during a run gets that run's report. */
  run(): Promise<RecoveryReport> {
    this.running ??= this.recover().finally(() => (this.running = undefined));
    return this.running;
  }

  private async recover(): Promise<RecoveryReport> {
    const report: RecoveryReport = { eventsChecked: 0, requestsChecked: 0, retriedRequests: 0, retriedEvents: 0, pending: 0, upToDate: true };
    const connections = await this.deps.hookdeck.listAllConnections();
    for (const target of this.deps.targets) {
      const connection = connections.find((c) => c.name === target.connection);
      if (!connection) {
        this.log(`inbound recovery: connection ${target.connection} not found`);
        report.upToDate = false;
        continue;
      }
      const runStart = this.now().getTime();
      const since = this.watermarks[target.connection] ?? new Date(runStart - (this.deps.lookbackMs ?? 24 * 60 * 60 * 1000)).toISOString();
      const clean = await this.recoverConnection(connection.source.id, connection.id, since, report);
      if (clean) this.watermarks[target.connection] = new Date(runStart - WATERMARK_MARGIN_MS).toISOString();
      else report.upToDate = false;
    }
    try {
      this.deps.state?.save(this.watermarks);
    } catch (error) {
      this.log(`inbound recovery: could not save the watermark: ${(error as Error).message}`);
    }
    if (report.retriedRequests || report.retriedEvents) {
      this.log(`inbound recovery: retried ${report.retriedRequests} request(s) and ${report.retriedEvents} event(s) missed while listen was down`);
    }
    return report;
  }

  /** Returns true when everything since `since` is settled and nothing needed retrying. */
  private async recoverConnection(sourceId: string, connectionId: string, since: string, report: RecoveryReport): Promise<boolean> {
    const { hookdeck } = this.deps;
    let clean = true;

    // 1. This connection's events: delivered, in flight, or failed without a response (dropped inside the grace window).
    const events = await allPages((next) => hookdeck.listEvents({ webhook_id: connectionId, created_at_gte: since, next }));
    if (!events.complete) clean = false;
    const byRequest = new Map<string, HookdeckEvent[]>();
    for (const event of events.models) byRequest.set(event.request_id, [...(byRequest.get(event.request_id) ?? []), event]);
    for (const requestEvents of byRequest.values()) {
      report.eventsChecked += requestEvents.length;
      if (requestEvents.some((e) => e.status === 'SUCCESSFUL')) continue;
      if (requestEvents.some((e) => UNSETTLED.has(e.status))) {
        report.pending++;
        clean = false;
        continue;
      }
      // Settled as FAILED. With a response, the bridge itself answered (a 5xx after Event Gateway's retries): leave it.
      if (requestEvents.some((e) => typeof e.response_status === 'number')) continue;
      const latest = requestEvents.reduce((a, b) => (Date.parse(b.created_at) > Date.parse(a.created_at) ? b : a));
      if (this.recentlyRetried(latest.id, report)) {
        clean = false;
        continue;
      }
      this.deps.onRetried?.(latest.request_id);
      await hookdeck.retryEvent(latest.id);
      report.retriedEvents++;
      clean = false;
    }

    // 2. Requests with ignored events and no event for this connection: missed if ignored here as CLI_DISCONNECTED.
    const requests = await allPages((next) => hookdeck.listRequests({ source_id: sourceId, created_at_gte: since, withIgnored: true, order_by: 'created_at', dir: 'asc', next }));
    if (!requests.complete) clean = false;
    for (const request of requests.models) {
      if (byRequest.has(request.id) || request.verified === false || request.rejection_cause) continue;
      report.requestsChecked++;
      const ignored = (await hookdeck.listIgnoredEventsForRequest(request.id)).models.filter((i) => i.webhook_id === connectionId);
      if (!ignored.some((i) => i.cause === CAUSE)) continue; // filtered, a duplicate, or another connection's: rightly not delivered here
      if (this.recentlyRetried(request.id, report)) {
        clean = false;
        continue;
      }
      this.deps.onRetried?.(request.id);
      await hookdeck.retryRequest(request.id, [connectionId]);
      report.retriedRequests++;
      clean = false;
    }
    return clean;
  }

  /** True (and counted as pending) if `id` was retried moments ago; otherwise records the retry about to happen. */
  private recentlyRetried(id: string, report: RecoveryReport): boolean {
    const now = this.now().getTime();
    const at = this.retried.get(id);
    if (at !== undefined && now - at < RETRY_SETTLE_MS) {
      report.pending++;
      return true;
    }
    this.retried.set(id, now);
    return false;
  }
}

function safeLoad(state: RecoveryState | undefined): Record<string, string> {
  try {
    return { ...(state?.load() ?? {}) };
  } catch {
    return {};
  }
}
