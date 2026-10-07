import type { ResolvedProvider } from './config.js';
import type { ProviderEvent } from './providers/types.js';

/**
 * The events the bridge offers: every enabled event of every configured provider instance, named
 * `{instance id}.{provider's event name}` (e.g. `resend.email.received`, `github.issues`, `fills.order.filled`), so
 * instances can't clash and the catalog says which provider each event comes from.
 */
export const mcpEventName = (providerId: string, eventName: string) => `${providerId}.${eventName}`;

export interface CatalogEntry {
  /** The MCP event name: `{instance id}.{event.name}`. */
  name: string;
  providerId: string;
  /** The provider type (`resend`, `github`, `webhook`), for mapping names from before `{id}.{event}` naming. */
  providerType: string;
  // Events have varying argument and summary types.
  event: ProviderEvent<any, any>;
}

export class Catalog {
  private readonly byName = new Map<string, CatalogEntry>();

  constructor(providers: ResolvedProvider[]) {
    for (const provider of providers) {
      for (const event of provider.definition.events) {
        if (!provider.events.includes(event.name)) continue;
        const name = mcpEventName(provider.id, event.name);
        // Ids are unique and have no dots, so a name splits at its first dot and can't repeat: an assertion.
        if (this.byName.has(name)) throw new Error(`Two provider instances offer "${name}"`);
        this.byName.set(name, { name, providerId: provider.id, providerType: provider.definition.type, event });
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
    return [...this.byName.values()].map(({ name, event }) => ({
      name,
      description: event.description,
      delivery: ['webhook'],
      inputSchema: event.inputSchema,
      payloadSchema: event.payloadSchema,
    }));
  }
}
