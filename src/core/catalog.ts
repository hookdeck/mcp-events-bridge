import type { ResolvedProvider } from './config.js';
import type { ProviderEvent } from './providers/types.js';

/** The events the bridge offers: every enabled event of every configured provider instance. */
export interface CatalogEntry {
  providerId: string;
  // Events have varying argument and summary types.
  event: ProviderEvent<any, any>;
}

export class Catalog {
  private readonly byName = new Map<string, CatalogEntry>();

  constructor(providers: ResolvedProvider[]) {
    for (const provider of providers) {
      for (const event of provider.definition.events) {
        if (!provider.events.includes(event.name)) continue;
        if (this.byName.has(event.name)) {
          throw new Error(`Two provider instances offer "${event.name}"; MCP event names must be unique in a deployment`);
        }
        this.byName.set(event.name, { providerId: provider.id, event });
      }
    }
  }

  get(name: string) {
    return this.byName.get(name);
  }

  /** Entries for one provider instance, for mapping its inbound requests. */
  forProvider(providerId: string) {
    return [...this.byName.values()].filter((entry) => entry.providerId === providerId);
  }

  /** The `events/list` response items. */
  list() {
    return [...this.byName.values()].map(({ event }) => ({
      name: event.name,
      description: event.description,
      delivery: ['webhook'],
      inputSchema: event.inputSchema,
      payloadSchema: event.payloadSchema,
    }));
  }
}
