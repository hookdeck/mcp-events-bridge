import type { Catalog } from './catalog.js';
import type { ResolvedProvider } from './config.js';
import type { HookdeckClient, HookdeckRequest } from './hookdeck.js';
import { providerSourceName } from './names.js';

/*
 * Past events, read from Event Gateway: every provider request is kept there,
 * so the bridge stores none. Used by get_event and list_events.
 */

export interface PastEvent {
  eventId: string;
  name: string;
  timestamp: string;
  data: Record<string, unknown>;
}

export class EventHistory {
  private readonly sourceIds = new Map<string, string>();

  constructor(
    private readonly deps: { hookdeck: HookdeckClient; catalog: Catalog; providers: ResolvedProvider[] },
  ) {}

  private async sourceId(providerId: string): Promise<string | undefined> {
    if (!this.sourceIds.has(providerId)) {
      const source = (await this.deps.hookdeck.listSources({ name: providerSourceName(providerId) })).models[0];
      if (source) this.sourceIds.set(providerId, source.id);
    }
    return this.sourceIds.get(providerId);
  }

  /** Maps a stored request to its MCP event, or undefined if it isn't a verified, enabled event. */
  private toEvent(providerId: string, request: HookdeckRequest): PastEvent | undefined {
    if (!request.verified || request.rejection_cause || !request.data) return undefined;
    const headers: Record<string, string> = {
      ...Object.fromEntries(Object.entries(request.data.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)])),
      // What Event Gateway adds when it delivers a request, so providers map stored requests as they map deliveries.
      'x-hookdeck-requestid': request.id,
      'x-hookdeck-verified': String(request.verified === true),
    };
    const req = { headers, body: request.data.body };
    const entry = this.deps.catalog.forProvider(providerId).find((e) => e.event.matches(req));
    if (!entry) return undefined;
    try {
      return { eventId: entry.event.eventId(req), name: entry.name, timestamp: entry.event.occurredAt(req), data: entry.event.summarize(req) };
    } catch {
      return undefined;
    }
  }

  /**
   * An event by its MCP name and id. The name says which provider instance to search: an event id is the provider's
   * own (a Resend svix-id, a sender's delivery id), so two instances can both have one.
   */
  async get(name: string, eventId: string): Promise<PastEvent | undefined> {
    const entry = this.deps.catalog.get(name);
    const provider = entry && this.deps.providers.find((p) => p.id === entry.providerId);
    const header = provider?.definition.eventIdHeader;
    const sourceId = provider && (await this.sourceId(provider.id));
    if (!provider || !header || !sourceId) return undefined;
    const page = await this.deps.hookdeck.listRequests({ source_id: sourceId, headers: { [header]: eventId }, includeData: true, limit: 5 });
    for (const request of page.models) {
      const event = this.toEvent(provider.id, request);
      if (event?.name === name && event.eventId === eventId) return event;
    }
    return undefined;
  }

  async recent({ name, since, limit = 20 }: { name?: string; since?: string; limit?: number } = {}): Promise<PastEvent[]> {
    const events: PastEvent[] = [];
    // A name is one instance's event: search only that instance's source.
    const instance = name === undefined ? undefined : this.deps.catalog.get(name)?.providerId;
    if (name !== undefined && !instance) return events;
    for (const provider of this.deps.providers.filter((p) => instance === undefined || p.id === instance)) {
      const sourceId = await this.sourceId(provider.id);
      if (!sourceId) continue;
      const page = await this.deps.hookdeck.listRequests({ source_id: sourceId, created_at_gte: since, includeData: true, limit: Math.min(limit * 2, 100) });
      for (const request of page.models) {
        const event = this.toEvent(provider.id, request);
        if (event && (!name || event.name === name)) events.push(event);
      }
    }
    return events.sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, limit);
  }
}
