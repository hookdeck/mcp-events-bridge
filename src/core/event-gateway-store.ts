import { HookdeckApiError, SUBSCRIPTION_RETRY_RULE, WEBHOOK_ID_DEDUPE_RULE, type Connection, type HookdeckClient } from './hookdeck.js';
import { SUBSCRIPTION_PREFIX, subscriptionResourceName, topicSourceName } from './names.js';
import {
  SubscriptionTooLargeError,
  healthyDelivery,
  type SubscriptionInput,
  type SubscriptionRecord,
  type SubscriptionStore,
} from './store.js';

/*
 * Event Gateway as the subscription store.
 *
 * Each subscription is one connection, `mcp-sub-<id>`, from its topic's
 * PUBLISH_API source to an HTTP destination at the callback URL:
 *
 *   connection description   readable JSON metadata: principal, event name,
 *                            arguments, expiry, timestamps, delivery state
 *                            (omitted while healthy). Versioned: it starts
 *                            with {"v":1, so a sealed format could be added
 *                            later (for example for multi-tenant hosting)
 *                            and told apart when reading.
 *   destination auth         the signing secret, as CUSTOM_SIGNATURE config:
 *                            Event Gateway's credential field, masked in the
 *                            dashboard and in every listing. When Event
 *                            Gateway can sign Standard Webhooks, the secret is
 *                            already where it's needed.
 *
 * Side effect: with CUSTOM_SIGNATURE, Event Gateway adds an HMAC of the body
 * under SECRET_CARRIER_HEADER to each delivery. Subscribers ignore it, and it
 * reveals nothing about the secret.
 *
 * The previous secret during a rotation has no slot, so it's kept in memory
 * for its grace window; a restart inside the window ends dual-signing early.
 *
 * Reads come from an in-memory index built by `load()` (one listing, plus one
 * destination read per subscription for its secret) and kept current by
 * `put()` and `delete()`. One bridge instance per deployment.
 */

const DESCRIPTION_LIMIT = 500;
export const SECRET_CARRIER_HEADER = 'x-mcp-bridge-hmac';

interface Metadata {
  v: 1;
  principal: string;
  event: string;
  arguments: Record<string, unknown>;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
  delivery?: SubscriptionInput['delivery'];
}

const isHealthy = (d: SubscriptionInput['delivery']) => d.active && d.lastError === null && d.failedSince === null;

export class EventGatewayStore implements SubscriptionStore {
  private readonly records = new Map<string, SubscriptionRecord>();
  private readonly previousSecrets = new Map<string, { secret: string; expiresAt: string }>();
  /** Writes run one at a time: concurrent connection upserts creating the same new topic source can fail in Event Gateway. */
  private queue: Promise<unknown> = Promise.resolve();

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  constructor(private readonly hookdeck: HookdeckClient) {}

  async load() {
    this.records.clear();
    const unreadable: string[] = [];
    for (const connection of await this.hookdeck.listAllConnections()) {
      if (!connection.name.startsWith(SUBSCRIPTION_PREFIX)) continue;
      try {
        const destination = await this.hookdeck.getDestination(connection.destination.id, { includeAuth: true });
        const secret = destination.config?.auth?.signing_secret;
        if (!secret) throw new Error('no signing secret');
        const record = this.decode(connection, secret);
        this.records.set(record.id, record);
      } catch {
        unreadable.push(connection.name);
      }
    }
    return { loaded: this.records.size, unreadable };
  }

  get(id: string) {
    return this.withPrevious(this.records.get(id));
  }

  list(filter: { name?: string } = {}) {
    return [...this.records.values()].filter((r) => filter.name === undefined || r.name === filter.name).map((r) => this.withPrevious(r)!);
  }

  findByConnection(connectionId: string) {
    return this.withPrevious([...this.records.values()].find((r) => r.connectionId === connectionId));
  }

  listExpired(now: Date) {
    return [...this.records.values()].filter((r) => Date.parse(r.expiresAt) <= now.getTime()).map((r) => this.withPrevious(r)!);
  }

  put(input: SubscriptionInput): Promise<SubscriptionRecord> {
    return this.serialize(() => this.write(input));
  }

  update(id: string, change: (current: SubscriptionRecord | undefined) => SubscriptionInput | null): Promise<SubscriptionRecord | undefined> {
    return this.serialize(async () => {
      const next = change(this.withPrevious(this.records.get(id)));
      return next ? this.write(next) : this.withPrevious(this.records.get(id));
    });
  }

  delete(id: string, options: { ifExpiredAt?: Date } = {}): Promise<boolean> {
    return this.serialize(async () => {
      const record = this.records.get(id);
      if (!record) return false;
      if (options.ifExpiredAt && Date.parse(record.expiresAt) > options.ifExpiredAt.getTime()) return false;
      await this.remove(record);
      return true;
    });
  }

  private async write(input: SubscriptionInput): Promise<SubscriptionRecord> {
    const name = subscriptionResourceName(input.id);
    const metadata: Metadata = {
      v: 1,
      principal: input.principal,
      event: input.name,
      arguments: input.arguments,
      expiresAt: input.expiresAt,
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
      ...(!isHealthy(input.delivery) && { delivery: input.delivery }),
    };
    const description = JSON.stringify(metadata);
    // Checked with the largest delivery block a failure notification can add later, so recording one can't overflow.
    const worstCase = JSON.stringify({ ...metadata, delivery: { active: false, lastError: 'connection_refused', failedSince: input.updatedAt } });
    if (worstCase.length > DESCRIPTION_LIMIT) throw new SubscriptionTooLargeError('Subscription arguments are too large to store');

    const connection = await this.hookdeck.upsertConnection({
      name,
      description,
      source: { name: topicSourceName(input.name), type: 'PUBLISH_API' },
      destination: {
        name,
        type: 'HTTP',
        config: { url: input.url, auth_type: 'CUSTOM_SIGNATURE', auth: { key: SECRET_CARRIER_HEADER, signing_secret: input.secret } },
      },
      rules: [{ type: 'filter', headers: { 'x-mcp-subscription-id': input.id } }, WEBHOOK_ID_DEDUPE_RULE, SUBSCRIPTION_RETRY_RULE],
    });

    if (input.previousSecret && input.previousSecretExpiresAt) {
      this.previousSecrets.set(input.id, { secret: input.previousSecret, expiresAt: input.previousSecretExpiresAt });
    } else {
      this.previousSecrets.delete(input.id);
    }
    const record: SubscriptionRecord = {
      ...input,
      previousSecret: null,
      previousSecretExpiresAt: null,
      connectionId: connection.id,
      destinationId: connection.destination.id,
      topicSourceId: connection.source.id,
    };
    this.records.set(record.id, record);
    return this.withPrevious(record)!;
  }

  private async remove(record: SubscriptionRecord) {
    // Already gone (deleted in the dashboard, or by an earlier attempt that failed part way) counts as deleted.
    await this.hookdeck.deleteConnection(record.connectionId).catch(ignoreNotFound);
    await this.hookdeck.deleteDestination(record.destinationId).catch(ignoreNotFound);
    this.records.delete(record.id);
    this.previousSecrets.delete(record.id);
    const topicStillUsed = [...this.records.values()].some((r) => r.topicSourceId === record.topicSourceId);
    // A leftover topic source is harmless (the next subscription to the event reuses it), so this doesn't fail the delete.
    if (!topicStillUsed) await this.hookdeck.deleteSource(record.topicSourceId).catch(() => {});
  }

  /** Adds the in-memory previous secret while its grace window is open. */
  private withPrevious(record: SubscriptionRecord | undefined): SubscriptionRecord | undefined {
    if (!record) return undefined;
    const previous = this.previousSecrets.get(record.id);
    if (!previous || Date.parse(previous.expiresAt) <= Date.now()) return record;
    return { ...record, previousSecret: previous.secret, previousSecretExpiresAt: previous.expiresAt };
  }

  private decode(connection: Connection, secret: string): SubscriptionRecord {
    const id = connection.name.slice(SUBSCRIPTION_PREFIX.length);
    const raw = connection.description ?? '';
    if (!raw.startsWith('{')) throw new Error('unsupported description format');
    const metadata = JSON.parse(raw) as Metadata;
    if (metadata.v !== 1 || typeof metadata.principal !== 'string' || typeof metadata.event !== 'string') {
      throw new Error('invalid metadata');
    }
    const url = connection.destination.config?.url;
    if (!url) throw new Error('destination has no URL');
    return {
      id,
      principal: metadata.principal,
      name: metadata.event,
      arguments: metadata.arguments ?? {},
      url,
      secret,
      previousSecret: null,
      previousSecretExpiresAt: null,
      delivery: metadata.delivery ?? healthyDelivery(),
      expiresAt: metadata.expiresAt,
      createdAt: metadata.createdAt,
      updatedAt: metadata.updatedAt,
      connectionId: connection.id,
      destinationId: connection.destination.id,
      topicSourceId: connection.source.id,
    };
  }
}

function ignoreNotFound(error: unknown): void {
  if (error instanceof HookdeckApiError && error.status === 404) return;
  throw error;
}
