import type { Catalog } from './catalog.js';
import type { PlaceSubscription } from './event-gateway-store.js';
import { connectionFilterRule } from './filter.js';
import { providerSourceName } from './names.js';
import { argumentsHash } from './poll.js';

/**
 * Where a subscription's connection goes: its event's source, with the source's transformation, a filter for the
 * event and its arguments, and the cursor's arguments hash. `sourceIdFor` looks up a source's Event Gateway id by its
 * id in the config; `transformations` are the transformation ids by source id (from `ensureTransformations`).
 */
export function placeSubscriptions(deps: {
  catalog: Catalog;
  sourceIdFor: (sourceId: string) => Promise<string | undefined>;
  transformations: Map<string, string>;
}): PlaceSubscription {
  return async (name, args) => {
    const entry = deps.catalog.get(name);
    if (!entry) throw new Error(`${name} isn't offered`);
    const sourceId = await deps.sourceIdFor(entry.providerId);
    if (!sourceId) throw new Error(`source ${providerSourceName(entry.providerId)} not found: run setup`);
    const transformationId = deps.transformations.get(entry.providerId);
    if (!transformationId) throw new Error(`no transformation for ${entry.providerId}: run setup`);
    return { sourceId, transformationId, filter: connectionFilterRule(name, entry.event.filter(args)), cursorArgs: argumentsHash(args) };
  };
}
