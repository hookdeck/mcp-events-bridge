import type { ProviderDefinition } from './providers/types.js';

/*
 * The typed config file, bridge.config.ts:
 *
 *   export default defineConfig({
 *     deployment: 'dev',
 *     providers: [resend({ apiKey: env('RESEND_API_KEY'), events: ['email.received'] })],
 *   });
 *
 * Secrets are env() references, resolved when the config is loaded, so the
 * file can be committed. Everything else has a default.
 */

export interface EnvRef {
  readonly kind: 'env';
  readonly name: string;
  readonly optional: boolean;
}

/** A reference to an environment variable, resolved at load time. */
export function env(name: string, { optional = false }: { optional?: boolean } = {}): EnvRef {
  return { kind: 'env', name, optional };
}

const isEnvRef = (value: unknown): value is EnvRef =>
  typeof value === 'object' && value !== null && (value as EnvRef).kind === 'env' && typeof (value as EnvRef).name === 'string';

type MaybeEnv<T> = T | EnvRef;
type WithEnv<T> = { [K in keyof T]: NonNullable<T[K]> extends string ? MaybeEnv<T[K]> : T[K] };

export interface ProviderInstance {
  /** Instance id, unique in the config; names Event Gateway resources. Defaults to the provider type. */
  id: string;
  definition: ProviderDefinition<Record<string, unknown>>;
  /** MCP event names to enable. */
  events: string[];
  options: Record<string, unknown>;
}

/**
 * Turns a provider definition into the factory used in bridge.config.ts.
 * Built-in providers use it, and so can a deployment's own providers.
 */
export function defineProvider<Options extends Record<string, unknown>>(definition: ProviderDefinition<Options>) {
  return (options: WithEnv<Options> & { id?: string; events?: string[] }): ProviderInstance => {
    const { id, events, ...rest } = options as WithEnv<Options> & { id?: string; events?: string[] };
    const known = definition.events.map((e) => e.name);
    // `['*']` enables every event the provider offers.
    const selected = events?.includes('*') ? known : (events ?? definition.defaultEvents ?? known);
    for (const name of selected) {
      if (!known.includes(name)) throw new Error(`${definition.type}: unknown event "${name}" (known: ${known.join(', ')})`);
    }
    return {
      id: id ?? definition.type,
      definition: definition as unknown as ProviderDefinition<Record<string, unknown>>,
      events: selected,
      options: rest,
    };
  };
}

export interface BridgeConfig {
  /** Names Event Gateway resources and the CLI device; for example "prod" or a machine name. */
  deployment: string;
  /** How provider events reach the bridge: `cli` (hookdeck listen) or `http` (public URL). Default: BRIDGE_INBOUND, else http on Fly.io, else cli. */
  inbound?: 'cli' | 'http';
  /** For http inbound. Default: BRIDGE_PUBLIC_URL, else https://$FLY_APP_NAME.fly.dev. */
  publicUrl?: MaybeEnv<string>;
  port?: number;
  hookdeck?: { apiKey?: MaybeEnv<string>; signingSecret?: MaybeEnv<string> };
  providers: ProviderInstance[];
  auth?: { mode?: 'secret-url'; mcpSecret?: MaybeEnv<string> };
  subscriptions?: Partial<SubscriptionSettings>;
}

export interface SubscriptionSettings {
  defaultTtlMs: number;
  minTtlMs: number;
  maxTtlMs: number;
  sweepIntervalMs: number;
  verificationCacheTtlMs: number;
  verificationTimeoutMs: number;
  secretRotationGraceMs: number;
}

export const DEFAULT_SUBSCRIPTION_SETTINGS: SubscriptionSettings = {
  // Long: ChatGPT sent no ttlMs in the 1 Oct test, and the bridge may be offline when a refresh is due.
  defaultTtlMs: 30 * 24 * 60 * 60 * 1000,
  minTtlMs: 60 * 1000,
  maxTtlMs: 90 * 24 * 60 * 60 * 1000,
  sweepIntervalMs: 60 * 1000,
  verificationCacheTtlMs: 24 * 60 * 60 * 1000,
  verificationTimeoutMs: 5000,
  secretRotationGraceMs: 10 * 60 * 1000,
};

export function defineConfig(config: BridgeConfig): BridgeConfig {
  return config;
}

export interface ResolvedProvider extends ProviderInstance {
  options: Record<string, unknown>;
}

export interface ResolvedConfig {
  deployment: string;
  inbound: 'cli' | 'http';
  publicUrl: string | null;
  port: number;
  hookdeck: { apiKey: string; signingSecret: string };
  providers: ResolvedProvider[];
  auth: { mode: 'secret-url'; mcpSecret: string | null };
  subscriptions: SubscriptionSettings;
}

export class ConfigError extends Error {}

/** Resolves env() references and defaults. Missing required variables are collected into one error. */
export function resolveConfig(config: BridgeConfig, environment: Record<string, string | undefined>): ResolvedConfig {
  const missing: string[] = [];
  const read = (value: MaybeEnv<string> | undefined, fallback?: EnvRef): string | null => {
    const ref = value === undefined ? fallback : value;
    if (ref === undefined) return null;
    if (!isEnvRef(ref)) return ref;
    const found = environment[ref.name];
    if (found) return found;
    if (!ref.optional) missing.push(ref.name);
    return null;
  };

  if (!/^[A-Za-z0-9_-]+$/.test(config.deployment)) throw new ConfigError('deployment may contain only letters, digits, - and _');
  const ids = config.providers.map((p) => p.id);
  const duplicate = ids.find((id, i) => ids.indexOf(id) !== i);
  if (duplicate) throw new ConfigError(`Two providers have the id "${duplicate}"; give one an explicit id`);

  const inboundEnv = environment.BRIDGE_INBOUND;
  const inbound = config.inbound ?? (inboundEnv === 'cli' || inboundEnv === 'http' ? inboundEnv : environment.FLY_APP_NAME ? 'http' : 'cli');
  const flyUrl = environment.FLY_APP_NAME ? `https://${environment.FLY_APP_NAME}.fly.dev` : null;
  const publicUrl = (read(config.publicUrl, env('BRIDGE_PUBLIC_URL', { optional: true })) ?? flyUrl)?.replace(/\/$/, '') ?? null;

  const resolved: ResolvedConfig = {
    deployment: config.deployment,
    inbound,
    publicUrl,
    port: config.port ?? Number(environment.BRIDGE_PORT ?? environment.PORT ?? 8080),
    hookdeck: {
      apiKey: read(config.hookdeck?.apiKey, env('HOOKDECK_API_KEY')) ?? '',
      signingSecret: read(config.hookdeck?.signingSecret, env('HOOKDECK_SIGNING_SECRET')) ?? '',
    },
    providers: config.providers.map((provider) => ({
      ...provider,
      options: Object.fromEntries(Object.entries(provider.options).map(([key, value]) => [key, isEnvRef(value) ? read(value) : value])),
    })),
    auth: { mode: 'secret-url', mcpSecret: read(config.auth?.mcpSecret, env('BRIDGE_MCP_SECRET', { optional: true })) },
    subscriptions: { ...DEFAULT_SUBSCRIPTION_SETTINGS, ...config.subscriptions },
  };

  if (missing.length) throw new ConfigError(`Missing environment variables: ${[...new Set(missing)].join(', ')}`);
  if (inbound === 'http' && !publicUrl?.startsWith('https://')) {
    throw new ConfigError('http inbound needs an https public URL: set BRIDGE_PUBLIC_URL, or run on Fly.io');
  }
  return resolved;
}
