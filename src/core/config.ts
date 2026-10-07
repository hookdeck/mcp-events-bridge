import type { ProviderDefinition } from './providers/types.js';

/*
 * The typed config file, bridge.config.ts:
 *
 *   export default defineConfig({
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

/** Plain objects only, so class instances and functions in a custom provider's options pass through untouched. */
const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
};

type MaybeEnv<T> = T | EnvRef;
type WithEnv<T> = { [K in keyof T]: NonNullable<T[K]> extends string ? MaybeEnv<T[K]> : T[K] };

export interface ProviderInstance {
  /** Instance id, unique in the config; names Event Gateway resources. Defaults to the provider type. */
  id: string;
  definition: ProviderDefinition<Record<string, unknown>>;
  /** The provider's event names to enable (offered over MCP as `{id}.{name}`). */
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
    // Events are the provider's own names; an MCP name with the type as prefix (`github.issues`, as before
    // `{id}.{event}` naming) is accepted for the same event.
    const unprefix = (name: string) => (!known.includes(name) && name.startsWith(`${definition.type}.`) ? name.slice(definition.type.length + 1) : name);
    // `['*']` enables every event the provider offers.
    const selected = events?.includes('*') ? known : (events?.map(unprefix) ?? definition.defaultEvents ?? known);
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
  /**
   * Names this bridge's Event Gateway resources (its inbound connections, notifications connection and issue
   * triggers) and its CLI devices, so bridges sharing a Hookdeck project stay apart. Default: BRIDGE_DEPLOYMENT,
   * else `local` with CLI inbound (a bridge on your machine) and `public` with HTTP inbound (a public URL).
   */
  deployment?: string;
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
  // Provider options can nest env() references (for example the generic webhook provider's verification secret).
  const resolveOption = (value: unknown): unknown => {
    if (isEnvRef(value)) return read(value);
    if (Array.isArray(value)) return value.map(resolveOption);
    if (isPlainObject(value)) return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, resolveOption(inner)]));
    return value;
  };

  const ids = config.providers.map((p) => p.id);
  // Ids name Event Gateway resources and the inbound route, /inbound/<id>; `hookdeck` is the notifications route.
  const badId = ids.find((id) => !/^[A-Za-z0-9_-]+$/.test(id) || id === 'hookdeck');
  if (badId !== undefined) throw new ConfigError(`Provider id "${badId}" must be letters, digits, - and _, and not "hookdeck"`);
  const duplicate = ids.find((id, i) => ids.indexOf(id) !== i);
  if (duplicate) throw new ConfigError(`Two providers have the id "${duplicate}"; give one an explicit id`);

  const inboundEnv = environment.BRIDGE_INBOUND;
  const inbound = config.inbound ?? (inboundEnv === 'cli' || inboundEnv === 'http' ? inboundEnv : environment.FLY_APP_NAME ? 'http' : 'cli');
  const deployment = config.deployment ?? (environment.BRIDGE_DEPLOYMENT || (inbound === 'cli' ? 'local' : 'public'));
  if (!/^[A-Za-z0-9_-]+$/.test(deployment)) throw new ConfigError('deployment may contain only letters, digits, - and _');
  const flyUrl = environment.FLY_APP_NAME ? `https://${environment.FLY_APP_NAME}.fly.dev` : null;
  const publicUrl = (read(config.publicUrl, env('BRIDGE_PUBLIC_URL', { optional: true })) ?? flyUrl)?.replace(/\/$/, '') ?? null;

  const resolved: ResolvedConfig = {
    deployment,
    inbound,
    publicUrl,
    port: config.port ?? Number(environment.BRIDGE_PORT ?? environment.PORT ?? 8080),
    hookdeck: {
      apiKey: read(config.hookdeck?.apiKey, env('HOOKDECK_API_KEY')) ?? '',
      signingSecret: read(config.hookdeck?.signingSecret, env('HOOKDECK_SIGNING_SECRET')) ?? '',
    },
    providers: config.providers.map((provider) => ({
      ...provider,
      options: resolveOption(provider.options) as Record<string, unknown>,
    })),
    auth: { mode: 'secret-url', mcpSecret: read(config.auth?.mcpSecret, env('BRIDGE_MCP_SECRET', { optional: true })) },
    subscriptions: { ...DEFAULT_SUBSCRIPTION_SETTINGS, ...config.subscriptions },
  };

  if (missing.length) throw new ConfigError(`Missing environment variables: ${[...new Set(missing)].join(', ')}`);
  if (!resolved.hookdeck.apiKey || !resolved.hookdeck.signingSecret) throw new ConfigError('The Hookdeck API key and signing secret must not be empty');
  if (inbound === 'http' && !publicUrl?.startsWith('https://')) {
    throw new ConfigError('http inbound needs an https public URL: set BRIDGE_PUBLIC_URL, or run on Fly.io');
  }
  return resolved;
}

/**
 * Fails closed when a provider instance's credentials aren't set (for example a generic webhook's secret, which
 * usually comes after its URL is registered with the sender). `serve` calls it before starting; `setup` instead
 * holds that instance's delivery until they're set.
 */
export function assertCredentials(config: ResolvedConfig): void {
  const missing = config.providers.flatMap((p) => (p.definition.missingCredentials?.(p.options) ?? []).map((name) => `${name} (provider ${p.id})`));
  if (missing.length) {
    throw new ConfigError(
      `Not set: ${missing.join(', ')}. Set it in .env (or as a secret where the bridge runs), then run \`mcp-events-bridge setup\` to apply it to the Event Gateway source before serving.`,
    );
  }
}
