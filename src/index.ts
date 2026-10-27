/** Public API for bridge.config.ts. */
export { defineConfig, defineSource, env, type BridgeConfig, type SourceInstance } from './core/config.js';
export type { SourceDefinition, SourceEvent, InboundRequest } from './core/sources/types.js';

import { defineSource } from './core/config.js';
import type { SourceDefinition, SourceEvent } from './core/sources/types.js';
/** @deprecated Renamed to `defineSource`; still works in 0.6.0. */
export const defineProvider = defineSource;
/** @deprecated Renamed to `SourceDefinition`. */
export type ProviderDefinition<Options = Record<string, unknown>> = SourceDefinition<Options>;
/** @deprecated Renamed to `SourceEvent`. */
export type ProviderEvent<Args = Record<string, unknown>> = SourceEvent<Args>;
