import type { Catalog } from './catalog.js';
import type { ResolvedSource } from './config.js';
import { nextCursor, type HookdeckClient, type HookdeckRequest } from './hookdeck.js';
import { providerSourceName } from './names.js';

/*
 * Past events, read from Event Gateway: every provider request is kept there,
 * so the bridge stores none. Used by get_event and list_events.
 */

/** How many requests `recent` reads per page, and at most per source: 5 API calls per source, at most. */
export const RECENT_PAGE_SIZE = 100;
export const RECENT_MAX_REQUESTS_PER_SOURCE = 500;

/**
 * Whether Event Gateway kept a request as a provider's event: verified, and either accepted or rejected only because
 * its source had no connection. A source has a connection per webhook subscription, so with none every request is
 * rejected as `NO_CONNECTION` (the sender still gets `200`, and the request is kept, verified, with its data); poll and
 * the history must still see them. Any other rejection, such as `VERIFICATION_FAILED`, isn't an event.
 */
export function isEventRequest(request: Pick<HookdeckRequest, 'verified' | 'rejection_cause'>): boolean {
  return !!request.verified && (!request.rejection_cause || request.rejection_cause === 'NO_CONNECTION');
}

export interface PastEvent {
  eventId: string;
  name: string;
  timestamp: string;
  data: Record<string, unknown>;
}

export class EventHistory {
  private readonly sourceIds = new Map<string, string>();

  constructor(
    private readonly deps: { hookdeck: HookdeckClient; catalog: Catalog; providers: ResolvedSource[] },
  ) {}

  /** The provider instance's Event Gateway source id (`bridge-<id>`), looked up once. */
  async sourceIdFor(providerId: string): Promise<string | undefined> {
    if (!this.sourceIds.has(providerId)) {
      const source = (await this.deps.hookdeck.listSources({ name: providerSourceName(providerId) })).models[0];
      if (source) this.sourceIds.set(providerId, source.id);
    }
    return this.sourceIds.get(providerId);
  }

  /** Maps a stored request to its MCP event, or undefined if it isn't a verified, enabled event. */
  toEvent(providerId: string, request: HookdeckRequest): PastEvent | undefined {
    if (!isEventRequest(request) || !request.data) return undefined;
    const headers = Object.fromEntries(Object.entries(request.data.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
    const req = { headers, body: request.data.body, receivedAt: request.created_at };
    const entry = this.deps.catalog.forProvider(providerId).find((e) => e.runtime.matches(req));
    if (!entry) return undefined;
    try {
      return { eventId: entry.runtime.eventId(req), name: entry.name, timestamp: entry.runtime.occurredAt(req), data: entry.runtime.summarize(req) };
    } catch {
      return undefined;
    }
  }

  /**
   * Whether `get` can look up this event: the name is offered, and its provider has an event-id header to search
   * Event Gateway's requests by (a generic webhook with `eventId: { field }` or the default request id has none).
   */
  lookup(name: string): 'ok' | 'unknown' | 'no-id-header' {
    const entry = this.deps.catalog.get(name);
    if (!entry) return 'unknown';
    const provider = this.deps.providers.find((p) => p.id === entry.providerId);
    return provider?.definition.eventIdHeader ? 'ok' : 'no-id-header';
  }

  /**
   * An event by its MCP name and id. The name says which provider instance to search: an event id is the provider's
   * own (a Resend svix-id, a sender's delivery id), so two instances can both have one.
   */
  async get(name: string, eventId: string): Promise<PastEvent | undefined> {
    const entry = this.deps.catalog.get(name);
    const provider = entry && this.deps.providers.find((p) => p.id === entry.providerId);
    const header = provider?.definition.eventIdHeader;
    const sourceId = provider && (await this.sourceIdFor(provider.id));
    if (!provider || !header || !sourceId) return undefined;
    const page = await this.deps.hookdeck.listRequests({ source_id: sourceId, headers: { [header]: eventId }, includeData: true, limit: 5 });
    for (const request of page.models) {
      const event = this.toEvent(provider.id, request);
      if (event?.name === name && event.eventId === eventId) return event;
    }
    return undefined;
  }

  /**
   * The newest events, by the time Event Gateway received them, then sorted by the event's own timestamp. Each source
   * is read a page at a time, newest first, until it has `limit` matching events, its requests run out, or
   * RECENT_MAX_REQUESTS_PER_SOURCE have been read (a busy source with few matching events can return fewer than exist).
   */
  async recent({ name, since, limit = 20 }: { name?: string; since?: string; limit?: number } = {}): Promise<PastEvent[]> {
    const events: PastEvent[] = [];
    // A name is one instance's event: search only that instance's source.
    const instance = name === undefined ? undefined : this.deps.catalog.get(name)?.providerId;
    if (name !== undefined && !instance) return events;
    for (const provider of this.deps.providers.filter((p) => instance === undefined || p.id === instance)) {
      const sourceId = await this.sourceIdFor(provider.id);
      if (!sourceId) continue;
      let found = 0;
      let read = 0;
      let next: string | undefined;
      do {
        const page = await this.deps.hookdeck.listRequests({ source_id: sourceId, created_at_gte: since, includeData: true, limit: RECENT_PAGE_SIZE, next });
        read += page.models.length;
        for (const request of page.models) {
          const event = this.toEvent(provider.id, request);
          // Every match on a page is kept, so the sort by timestamp below sees them all.
          if (event && (!name || event.name === name)) {
            events.push(event);
            found++;
          }
        }
        next = nextCursor(page);
      } while (next && found < limit && read < RECENT_MAX_REQUESTS_PER_SOURCE);
    }
    return events.sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, limit);
  }
}
