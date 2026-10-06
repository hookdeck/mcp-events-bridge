import type { SubscriptionInput, SubscriptionRecord, SubscriptionStore } from './store.js';

/** In-memory SubscriptionStore for tests. Assigns made-up Event Gateway ids. */
export class MemoryStore implements SubscriptionStore {
  private readonly records = new Map<string, SubscriptionRecord>();

  async load() {
    return { loaded: this.records.size, unreadable: [] };
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

  async put(input: SubscriptionInput) {
    const record: SubscriptionRecord = {
      ...input,
      connectionId: `web_${input.id}`,
      destinationId: `des_${input.id}`,
      topicSourceId: `src_${input.name}`,
    };
    this.records.set(record.id, record);
    return record;
  }

  async update(id: string, change: (current: SubscriptionRecord | undefined) => SubscriptionInput | null) {
    const next = change(this.records.get(id));
    return next ? this.put(next) : this.records.get(id);
  }

  async delete(id: string, options: { ifExpiredAt?: Date } = {}) {
    const record = this.records.get(id);
    if (!record) return false;
    if (options.ifExpiredAt && Date.parse(record.expiresAt) > options.ifExpiredAt.getTime()) return false;
    return this.records.delete(id);
  }
}
