import { HookdeckApiError, SUBSCRIPTION_RETRY_RULE, WEBHOOK_ID_DEDUPE_RULE, type Connection, type HookdeckClient, type Rule } from './hookdeck.js';
import { SUBSCRIPTION_PREFIX, subscriptionResourceName } from './names.js';
import {
  SubscriptionTooLargeError,
  healthyDelivery,
  type SubscriptionInput,
  type SubscriptionRecord,
  type SubscriptionStore,
} from './store.js';

/*
 * Event Gateway as the subscription store, and as the delivery. Each subscription is one connection, `mcp-sub-<id>`,
 * on its service's source (`bridge-<source id>`), to an HTTP destination at the callback URL:
 *
 *   rules                    the source's transformation (it builds the MCP event), a filter for the event name and
 *                            the subscription's arguments, dedupe on webhook-id, and retry.
 *   destination              the callback URL; STANDARD_WEBHOOKS auth with the subscriber's secret, so Event Gateway
 *                            signs every attempt. The sender's path isn't forwarded.
 *   connection description   JSON metadata: principal, event name, arguments, expiry, timestamps, delivery state
 *                            (omitted while healthy), and what the transformation needs for cursors: `ca`, the
 *                            arguments hash, and `rp` while a replay runs. Versioned: {"v":2. Version 1 is a
 *                            subscription from 0.7 or earlier, on a topic source, left for the migration.
 *
 * Reads come from an in-memory index built by `load()` (one listing, plus one destination read per subscription for
 * its secret) and kept current by `put()` and `delete()`. One bridge instance per deployment.
 */

/** Event Gateway's limit on a connection's description. */
const DESCRIPTION_LIMIT = 500;

interface Metadata {
  v: 2;
  principal: string;
  event: string;
  arguments: Record<string, unknown>;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
  delivery?: SubscriptionInput['delivery'];
  /** The cursor's hash of the arguments (poll's format), for the transformation. */
  ca: string;
  /** While a replay runs, where it started (the cursor's floor and watermark). */
  rp?: { f: number; w: number };
}

/** Where a subscription's connection goes, and what its rules hold: from the catalog and the source's transformation. */
export interface SubscriptionPlacement {
  /** The service source's id. */
  sourceId: string;
  /** The source's transformation id. */
  transformationId: string;
  /** The filter rule for the event and the subscription's arguments. */
  filter: Rule;
  /** The cursor's hash of the arguments. */
  cursorArgs: string;
}

export type PlaceSubscription = (name: string, args: Record<string, unknown>) => Promise<SubscriptionPlacement>;

const isHealthy = (d: SubscriptionInput['delivery']) => d.active && d.lastError === null && d.failedSince === null;

/** Whether a connection is a subscription from 0.7 or earlier (version 1 metadata, on a topic source). */
export function isLegacySubscription(connection: Connection): boolean {
  return connection.name.startsWith(SUBSCRIPTION_PREFIX) && (connection.description ?? '').startsWith('{"v":1');
}

export class EventGatewayStore implements SubscriptionStore {
  private readonly records = new Map<string, SubscriptionRecord>();
  /** Writes run one at a time, so a refresh and a delivery-failure notification can't interleave. */
  private queue: Promise<unknown> = Promise.resolve();

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  constructor(
    private readonly hookdeck: HookdeckClient,
    private readonly place: PlaceSubscription,
  ) {}

  async load() {
    this.records.clear();
    const unreadable: string[] = [];
    let legacy = 0;
    for (const connection of await this.hookdeck.listAllConnections()) {
      if (!connection.name.startsWith(SUBSCRIPTION_PREFIX)) continue;
      if (isLegacySubscription(connection)) {
        legacy++;
        continue;
      }
      try {
        const destination = await this.hookdeck.getDestination(connection.destination.id, { includeAuth: true });
        const secret = destination.config?.auth?.webhook_secret_key;
        if (!secret) throw new Error('no signing secret');
        const record = this.decode(connection, secret);
        this.records.set(record.id, record);
      } catch {
        unreadable.push(connection.name);
      }
    }
    return { loaded: this.records.size, unreadable, legacy };
  }

  get(id: string) {
    return this.records.get(id);
  }

  list(filter: { name?: string } = {}) {
    return [...this.records.values()].filter((r) => filter.name === undefined || r.name === filter.name);
  }

  findByConnection(connectionId: string) {
    return [...this.records.values()].find((r) => r.connectionId === connectionId);
  }

  listExpired(now: Date) {
    return [...this.records.values()].filter((r) => Date.parse(r.expiresAt) <= now.getTime());
  }

  put(input: SubscriptionInput): Promise<SubscriptionRecord> {
    return this.serialize(() => this.write(input));
  }

  update(id: string, change: (current: SubscriptionRecord | undefined) => SubscriptionInput | null): Promise<SubscriptionRecord | undefined> {
    return this.serialize(async () => {
      const next = change(this.records.get(id));
      return next ? this.write(next) : this.records.get(id);
    });
  }

  delete(id: string, options: { ifExpiredAt?: Date } = {}): Promise<boolean> {
    return this.serialize(async () => {
      const record = this.records.get(id);
      if (!record) return false;
      if (options.ifExpiredAt && Date.parse(record.expiresAt) > options.ifExpiredAt.getTime()) return false;
      // Already gone (deleted in the dashboard, or by an earlier attempt that failed part way) counts as deleted.
      await this.hookdeck.deleteConnection(record.connectionId).catch(ignoreNotFound);
      await this.hookdeck.deleteDestination(record.destinationId).catch(ignoreNotFound);
      this.records.delete(record.id);
      return true;
    });
  }

  private async write(input: SubscriptionInput): Promise<SubscriptionRecord> {
    const name = subscriptionResourceName(input.id);
    const placement = await this.place(input.name, input.arguments);
    const metadata: Metadata = {
      v: 2,
      principal: input.principal,
      event: input.name,
      arguments: input.arguments,
      expiresAt: input.expiresAt,
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
      ...(!isHealthy(input.delivery) && { delivery: input.delivery }),
      ca: placement.cursorArgs,
      ...(input.replay && { rp: input.replay }),
    };
    const description = JSON.stringify(metadata);
    // Checked with the largest delivery block a failure notification can add later and a replay marker, so neither
    // can overflow it.
    const worstCase = JSON.stringify({
      ...metadata,
      delivery: { active: false, lastError: 'connection_refused', failedSince: input.updatedAt },
      rp: { f: 9_999_999_999_999, w: 9_999_999_999_999 },
    });
    if (worstCase.length > DESCRIPTION_LIMIT) throw new SubscriptionTooLargeError('Subscription arguments are too large to store');

    const connection = await this.hookdeck.upsertConnection({
      name,
      description,
      source_id: placement.sourceId,
      destination: {
        name,
        type: 'HTTP',
        config: { url: input.url, path_forwarding_disabled: true, auth_type: 'STANDARD_WEBHOOKS', auth: { webhook_secret_key: input.secret } },
      },
      rules: [{ type: 'transform', transformation_id: placement.transformationId }, placement.filter, WEBHOOK_ID_DEDUPE_RULE, SUBSCRIPTION_RETRY_RULE],
    });
    const record: SubscriptionRecord = { ...input, connectionId: connection.id, destinationId: connection.destination.id, sourceId: connection.source.id };
    this.records.set(record.id, record);
    return record;
  }

  private decode(connection: Connection, secret: string): SubscriptionRecord {
    const id = connection.name.slice(SUBSCRIPTION_PREFIX.length);
    const raw = connection.description ?? '';
    if (!raw.startsWith('{')) throw new Error('unsupported description format');
    const metadata = JSON.parse(raw) as Metadata;
    if (metadata.v !== 2 || typeof metadata.principal !== 'string' || typeof metadata.event !== 'string') throw new Error('invalid metadata');
    const url = connection.destination.config?.url;
    if (!url) throw new Error('destination has no URL');
    return {
      id,
      principal: metadata.principal,
      name: metadata.event,
      arguments: metadata.arguments ?? {},
      url,
      secret,
      replay: metadata.rp ?? null,
      delivery: metadata.delivery ?? healthyDelivery(),
      expiresAt: metadata.expiresAt,
      createdAt: metadata.createdAt,
      updatedAt: metadata.updatedAt,
      connectionId: connection.id,
      destinationId: connection.destination.id,
      sourceId: connection.source.id,
    };
  }
}

function ignoreNotFound(error: unknown): void {
  if (error instanceof HookdeckApiError && error.status === 404) return;
  throw error;
}
