import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ProviderRecord, Store, SubscriptionRecord, TopicRecord } from '../core/store.js';

/*
 * The Store on node:sqlite: built into Node, so no native module to compile
 * in Docker or on a laptop. It still prints an ExperimentalWarning; the CLI
 * runs Node with --disable-warning=ExperimentalWarning.
 *
 * The file holds subscription secrets, so it's created user-readable only.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS providers (
  instance_id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  options_hash TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_url TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  events TEXT NOT NULL,
  provider_webhook_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS topics (
  name TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  source_name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  principal TEXT NOT NULL,
  name TEXT NOT NULL,
  arguments TEXT NOT NULL,
  url TEXT NOT NULL,
  secret TEXT NOT NULL,
  previous_secret TEXT,
  previous_secret_expires_at TEXT,
  connection_id TEXT NOT NULL,
  destination_id TEXT NOT NULL,
  delivery_active INTEGER NOT NULL,
  delivery_last_error TEXT,
  delivery_failed_since TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS subscriptions_by_name ON subscriptions (name);
CREATE INDEX IF NOT EXISTS subscriptions_by_connection ON subscriptions (connection_id);
CREATE INDEX IF NOT EXISTS subscriptions_by_expiry ON subscriptions (expires_at);
`;

type Row = Record<string, string | number | null>;

const toProvider = (r: Row): ProviderRecord => ({
  instanceId: r.instance_id as string,
  type: r.type as string,
  optionsHash: r.options_hash as string,
  sourceId: r.source_id as string,
  sourceUrl: r.source_url as string,
  connectionId: r.connection_id as string,
  events: JSON.parse(r.events as string) as string[],
  providerWebhookId: (r.provider_webhook_id as string | null) ?? null,
  createdAt: r.created_at as string,
  updatedAt: r.updated_at as string,
});

const toSubscription = (r: Row): SubscriptionRecord => ({
  id: r.id as string,
  principal: r.principal as string,
  name: r.name as string,
  arguments: JSON.parse(r.arguments as string) as Record<string, unknown>,
  url: r.url as string,
  secret: r.secret as string,
  previousSecret: (r.previous_secret as string | null) ?? null,
  previousSecretExpiresAt: (r.previous_secret_expires_at as string | null) ?? null,
  connectionId: r.connection_id as string,
  destinationId: r.destination_id as string,
  delivery: {
    active: r.delivery_active === 1,
    lastError: (r.delivery_last_error as SubscriptionRecord['delivery']['lastError']) ?? null,
    failedSince: (r.delivery_failed_since as string | null) ?? null,
  },
  expiresAt: r.expires_at as string,
  createdAt: r.created_at as string,
  updatedAt: r.updated_at as string,
});

export class SqliteStore implements Store {
  private readonly db: DatabaseSync;

  /** `file` is a path, or `:memory:` for tests. */
  constructor(file: string) {
    if (file !== ':memory:') {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      if (!fs.existsSync(file)) fs.writeFileSync(file, '', { mode: 0o600 });
      fs.chmodSync(file, 0o600);
    }
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
  }

  async getProvider(instanceId: string) {
    const row = this.db.prepare('SELECT * FROM providers WHERE instance_id = ?').get(instanceId) as Row | undefined;
    return row ? toProvider(row) : undefined;
  }

  async listProviders() {
    return (this.db.prepare('SELECT * FROM providers ORDER BY instance_id').all() as Row[]).map(toProvider);
  }

  async putProvider(p: ProviderRecord) {
    this.db
      .prepare(
        `INSERT INTO providers (instance_id, type, options_hash, source_id, source_url, connection_id, events, provider_webhook_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (instance_id) DO UPDATE SET type = excluded.type, options_hash = excluded.options_hash,
           source_id = excluded.source_id, source_url = excluded.source_url, connection_id = excluded.connection_id,
           events = excluded.events, provider_webhook_id = excluded.provider_webhook_id, updated_at = excluded.updated_at`,
      )
      .run(p.instanceId, p.type, p.optionsHash, p.sourceId, p.sourceUrl, p.connectionId, JSON.stringify(p.events), p.providerWebhookId, p.createdAt, p.updatedAt);
  }

  async deleteProvider(instanceId: string) {
    this.db.prepare('DELETE FROM providers WHERE instance_id = ?').run(instanceId);
  }

  async getTopic(name: string) {
    const row = this.db.prepare('SELECT * FROM topics WHERE name = ?').get(name) as Row | undefined;
    return row ? { name: row.name as string, sourceId: row.source_id as string, sourceName: row.source_name as string } : undefined;
  }

  async putTopic(t: TopicRecord) {
    this.db
      .prepare('INSERT INTO topics (name, source_id, source_name) VALUES (?, ?, ?) ON CONFLICT (name) DO UPDATE SET source_id = excluded.source_id, source_name = excluded.source_name')
      .run(t.name, t.sourceId, t.sourceName);
  }

  async deleteTopic(name: string) {
    this.db.prepare('DELETE FROM topics WHERE name = ?').run(name);
  }

  async getSubscription(id: string) {
    const row = this.db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(id) as Row | undefined;
    return row ? toSubscription(row) : undefined;
  }

  async listSubscriptions(filter: { name?: string } = {}) {
    const rows = filter.name
      ? this.db.prepare('SELECT * FROM subscriptions WHERE name = ? ORDER BY created_at').all(filter.name)
      : this.db.prepare('SELECT * FROM subscriptions ORDER BY created_at').all();
    return (rows as Row[]).map(toSubscription);
  }

  async findSubscriptionByConnection(connectionId: string) {
    const row = this.db.prepare('SELECT * FROM subscriptions WHERE connection_id = ?').get(connectionId) as Row | undefined;
    return row ? toSubscription(row) : undefined;
  }

  async listExpiredSubscriptions(now: Date) {
    return (this.db.prepare('SELECT * FROM subscriptions WHERE expires_at <= ? ORDER BY expires_at').all(now.toISOString()) as Row[]).map(toSubscription);
  }

  async putSubscription(s: SubscriptionRecord) {
    this.db
      .prepare(
        `INSERT INTO subscriptions (id, principal, name, arguments, url, secret, previous_secret, previous_secret_expires_at,
           connection_id, destination_id, delivery_active, delivery_last_error, delivery_failed_since, expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET principal = excluded.principal, name = excluded.name, arguments = excluded.arguments,
           url = excluded.url, secret = excluded.secret, previous_secret = excluded.previous_secret,
           previous_secret_expires_at = excluded.previous_secret_expires_at, connection_id = excluded.connection_id,
           destination_id = excluded.destination_id, delivery_active = excluded.delivery_active,
           delivery_last_error = excluded.delivery_last_error, delivery_failed_since = excluded.delivery_failed_since,
           expires_at = excluded.expires_at, updated_at = excluded.updated_at`,
      )
      .run(
        s.id, s.principal, s.name, JSON.stringify(s.arguments), s.url, s.secret, s.previousSecret, s.previousSecretExpiresAt,
        s.connectionId, s.destinationId, s.delivery.active ? 1 : 0, s.delivery.lastError, s.delivery.failedSince,
        s.expiresAt, s.createdAt, s.updatedAt,
      );
  }

  async deleteSubscription(id: string) {
    this.db.prepare('DELETE FROM subscriptions WHERE id = ?').run(id);
  }

  async close() {
    this.db.close();
  }
}
