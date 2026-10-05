import { SUBSCRIPTION_RETRY_RULE, WEBHOOK_ID_DEDUPE_RULE, type Connection, type HookdeckClient } from './hookdeck.js';
import { SUBSCRIPTION_PREFIX, subscriptionResourceName, topicSourceName } from './names.js';
import { open, seal } from './sealed.js';
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
 * PUBLISH_API source to an HTTP destination at the callback URL. State that
 * Event Gateway has no field for is sealed (AES-256-GCM, BRIDGE_ENCRYPTION_KEY)
 * into the 500-character descriptions:
 *
 *   connection description   secrets: current, previous, previous expiry
 *   destination description  metadata: principal, event name, arguments,
 *                            expiry, timestamps, delivery state (omitted
 *                            while healthy)
 *
 * The callback URL is the destination's own config.url. Keys are short and
 * times are epoch milliseconds to leave room for arguments within the limit.
 *
 * The associated data binds each blob to its subscription id, so a description
 * edited in the dashboard, or copied to another connection, fails to open and
 * that subscription is skipped (and reported) at load.
 *
 * Reads come from an in-memory index built by `load()` and kept current by
 * `put()` and `delete()`. One bridge instance per deployment.
 */

const DESCRIPTION_LIMIT = 500;

interface SealedSecrets {
  s: string;
  ps?: string;
  pe?: number;
}

interface SealedMeta {
  v: 1;
  p: string; // principal
  n: string; // MCP event name (topic source names are slugged, so not recoverable from them)
  a: Record<string, unknown>; // arguments
  e: number; // expiresAt
  c: number; // createdAt
  m: number; // updatedAt
  d?: SubscriptionInput['delivery']; // only when not healthy
}

const ms = (iso: string) => Date.parse(iso);
const iso = (epochMs: number) => new Date(epochMs).toISOString();
const isHealthy = (d: SubscriptionInput['delivery']) => d.active && d.lastError === null && d.failedSince === null;

const secretsAad = (id: string) => `${id}:secrets`;
const metaAad = (id: string) => `${id}:meta`;

export class EventGatewayStore implements SubscriptionStore {
  private readonly records = new Map<string, SubscriptionRecord>();

  constructor(
    private readonly hookdeck: HookdeckClient,
    private readonly key: Buffer,
  ) {}

  async load() {
    this.records.clear();
    const unreadable: string[] = [];
    for (const connection of await this.hookdeck.listAllConnections()) {
      if (!connection.name.startsWith(SUBSCRIPTION_PREFIX)) continue;
      try {
        const record = this.decode(connection);
        this.records.set(record.id, record);
      } catch {
        unreadable.push(connection.name);
      }
    }
    return { loaded: this.records.size, unreadable };
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

  async put(input: SubscriptionInput): Promise<SubscriptionRecord> {
    const name = subscriptionResourceName(input.id);
    const secrets: SealedSecrets = {
      s: input.secret,
      ...(input.previousSecret && { ps: input.previousSecret }),
      ...(input.previousSecretExpiresAt && { pe: ms(input.previousSecretExpiresAt) }),
    };
    const meta: SealedMeta = {
      v: 1,
      p: input.principal,
      n: input.name,
      a: input.arguments,
      e: ms(input.expiresAt),
      c: ms(input.createdAt),
      m: ms(input.updatedAt),
      ...(!isHealthy(input.delivery) && { d: input.delivery }),
    };
    const connectionDescription = seal(this.key, JSON.stringify(secrets), secretsAad(input.id));
    const destinationDescription = seal(this.key, JSON.stringify(meta), metaAad(input.id));
    if (connectionDescription.length > DESCRIPTION_LIMIT || destinationDescription.length > DESCRIPTION_LIMIT) {
      throw new SubscriptionTooLargeError('Subscription arguments are too large to store');
    }

    const connection = await this.hookdeck.upsertConnection({
      name,
      description: connectionDescription,
      source: { name: topicSourceName(input.name), type: 'PUBLISH_API' },
      destination: { name, type: 'HTTP', description: destinationDescription, config: { url: input.url } },
      rules: [{ type: 'filter', headers: { 'x-mcp-subscription-id': input.id } }, WEBHOOK_ID_DEDUPE_RULE, SUBSCRIPTION_RETRY_RULE],
    });
    const record: SubscriptionRecord = {
      ...input,
      expiresAt: iso(meta.e),
      createdAt: iso(meta.c),
      updatedAt: iso(meta.m),
      previousSecretExpiresAt: secrets.pe === undefined ? null : iso(secrets.pe),
      connectionId: connection.id,
      destinationId: connection.destination.id,
      topicSourceId: connection.source.id,
    };
    this.records.set(record.id, record);
    return record;
  }

  async delete(id: string) {
    const record = this.records.get(id);
    if (!record) return;
    await this.hookdeck.deleteConnection(record.connectionId);
    await this.hookdeck.deleteDestination(record.destinationId);
    this.records.delete(id);
    const topicStillUsed = [...this.records.values()].some((r) => r.topicSourceId === record.topicSourceId);
    if (!topicStillUsed) await this.hookdeck.deleteSource(record.topicSourceId);
  }

  private decode(connection: Connection): SubscriptionRecord {
    const id = connection.name.slice(SUBSCRIPTION_PREFIX.length);
    const secrets = JSON.parse(open(this.key, connection.description ?? '', secretsAad(id))) as SealedSecrets;
    const meta = JSON.parse(open(this.key, connection.destination.description ?? '', metaAad(id))) as SealedMeta;
    const url = connection.destination.config?.url;
    if (!url) throw new Error(`${connection.name}: destination has no URL`);
    return {
      id,
      principal: meta.p,
      name: meta.n,
      arguments: meta.a,
      url,
      secret: secrets.s,
      previousSecret: secrets.ps ?? null,
      previousSecretExpiresAt: secrets.pe === undefined ? null : iso(secrets.pe),
      delivery: meta.d ?? healthyDelivery(),
      expiresAt: iso(meta.e),
      createdAt: iso(meta.c),
      updatedAt: iso(meta.m),
      connectionId: connection.id,
      destinationId: connection.destination.id,
      topicSourceId: connection.source.id,
    };
  }
}
