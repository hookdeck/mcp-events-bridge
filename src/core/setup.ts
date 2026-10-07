import { createHash, randomBytes } from 'node:crypto';
import type { ResolvedConfig, ResolvedProvider } from './config.js';
import type { HookdeckClient, Rule, UpsertConnectionInput } from './hookdeck.js';
import { notificationsConnectionName, providerConnectionName, providerSourceName } from './names.js';

/*
 * `bridge setup`: creates or updates everything the config describes in Event
 * Gateway and at providers. Idempotent: a provider webhook is registered once
 * and its id is kept in the source description, so re-running doesn't create
 * another. If the enabled events or the provider's registration target (for
 * example GitHub repositories) change, the webhook is updated.
 */

export const NOTIFICATIONS_SOURCE = 'bridge-hookdeck-notifications';
const NOTIFICATION_TOPICS = ['issue.opened', 'issue.updated'];

/** Provider deliveries retry inside the 1-hour dedupe window (5 x 10 minutes). */
const INBOUND_RETRY_RULE: Rule = { type: 'retry', strategy: 'linear', count: 5, interval: 600_000, response_status_codes: ['>=300'] };

interface SourceDescription {
  provider: string;
  events: string[];
  webhookId: string | null;
  /** Fingerprint of the provider's registration target, when it has one. */
  target?: string;
}

export interface SetupReport {
  providers: Array<{
    id: string;
    sourceUrl: string;
    connection: string;
    webhook: 'registered' | 'updated' | 'configured' | 'existing' | 'pending' | 'none';
    /** Credentials still to set (pending): the inbound connection isn't created until they are. */
    waitingFor?: string[];
    hint?: string;
  }>;
  notifications: { source: string; connection: string };
  triggers: string[];
  mcp: { secret: string; generated: boolean; url: string };
}

/**
 * The error setup ends with when a provider's credentials aren't set yet, or undefined when none are missing.
 * Setup still does everything it can first (including creating the waiting provider's source, so its URL can be
 * registered), but a missing secret is a failure, not a quiet success: delivery for that provider is held.
 */
export function missingCredentialsError(report: Pick<SetupReport, 'providers'>): string | undefined {
  const waiting = report.providers.filter((p) => p.waitingFor?.length);
  if (!waiting.length) return undefined;
  const lines = waiting.map((p) => `  ${p.id}: set ${p.waitingFor!.join(', ')}; delivery is held until then`);
  return `Setup isn't complete:\n${lines.join('\n')}\nSet the variable (for example in .env) and run setup again.`;
}

export interface SetupDeps {
  config: ResolvedConfig;
  hookdeck: HookdeckClient;
  fetch: typeof fetch;
  log?: (message: string) => void;
}

/** Where Event Gateway delivers to the bridge, by inbound mode. */
function inboundDestination(config: ResolvedConfig, name: string, path: string): UpsertConnectionInput['destination'] {
  if (config.inbound === 'cli') return { name, type: 'CLI', config: { path } };
  return { name, type: 'HTTP', config: { url: `${config.publicUrl}${path}`, auth_type: 'HOOKDECK_SIGNATURE', auth: {} } };
}

const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
const sameList = (a: string[] | undefined, b: string[]) => JSON.stringify([...(a ?? [])].sort()) === JSON.stringify([...b].sort());

function parseSourceDescription(value: string | null | undefined): SourceDescription | null {
  try {
    const parsed = JSON.parse(value ?? '') as SourceDescription;
    return typeof parsed === 'object' && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

/** A changed source secret took about 61 seconds to apply at Event Gateway's edge in one test, and about a second in another. */
export const SECRET_PROPAGATION_NOTE = 'a new or changed secret can take up to about a minute to take effect at Event Gateway';

/** Same verification config: the type and every auth field the provider sets. */
function sameSourceConfig(current: { auth_type?: string | null; auth?: Record<string, unknown> | null } | null | undefined, wanted: Record<string, unknown>) {
  const auth = (wanted.auth ?? {}) as Record<string, unknown>;
  return current?.auth_type === wanted.auth_type && Object.entries(auth).every(([key, value]) => current?.auth?.[key] === value);
}

/**
 * Finds or creates a provider instance's source, by name, so connection upserts never touch its auth config.
 * For a provider with `sourceConfig` (verification it configures itself), the config is set when the source is
 * created and rewritten only when it differs, so re-running doesn't churn the secret. While credentials are
 * missing, the source is created without verification, and the caller must not connect it.
 */
export async function ensureSource(hookdeck: HookdeckClient, provider: ResolvedProvider, log: (message: string) => void = () => {}) {
  const { definition } = provider;
  const sourceName = providerSourceName(provider.id);
  const missing = definition.missingCredentials?.(provider.options) ?? [];
  const sourceConfig = definition.sourceConfig && !missing.length ? definition.sourceConfig(provider.options) : undefined;
  const description: SourceDescription = { provider: definition.type, events: provider.events, webhookId: null };

  let source = (await hookdeck.listSources({ name: sourceName })).models[0];
  let existing = parseSourceDescription(source?.description);
  let configured = false;
  if (!source) {
    source = await hookdeck.upsertSource({
      name: sourceName,
      type: definition.sourceType,
      description: JSON.stringify(description),
      ...(sourceConfig && { config: sourceConfig }),
    });
    existing = description;
    configured = Boolean(sourceConfig);
    log(`created source ${sourceName}${sourceConfig ? ' with verification' : ''}`);
  } else if (sourceConfig) {
    const current = (await hookdeck.getSource(source.id, { includeAuth: true })).config;
    if (!sameSourceConfig(current, sourceConfig) || source.type !== definition.sourceType || !sameList(existing?.events, provider.events)) {
      source = await hookdeck.upsertSource({ name: sourceName, type: definition.sourceType, description: JSON.stringify(description), config: sourceConfig });
      existing = description;
      configured = true;
      log(`set verification on ${sourceName}`);
    }
  }
  if (configured) log(`note: ${SECRET_PROPAGATION_NOTE}; until then the bridge ignores requests Event Gateway didn't verify`);
  return { source, existing, configured, missing };
}

async function setupProvider(deps: SetupDeps, provider: ResolvedProvider) {
  const { config, hookdeck } = deps;
  const log = deps.log ?? (() => {});
  const { definition } = provider;
  const sourceName = providerSourceName(provider.id);
  const connectionName = providerConnectionName(provider.id, config.deployment);
  const providerEvents = definition.events.filter((e) => provider.events.includes(e.name)).map((e) => e.providerEvent);
  const target = definition.registrationTarget ? fingerprint(definition.registrationTarget(provider.options)) : undefined;

  const { source, existing, configured, missing } = await ensureSource(hookdeck, provider, log);
  const hint = definition.setupHint?.({ sourceUrl: source.url, providerEvents, options: provider.options });
  const report = (webhook: SetupReport['providers'][number]['webhook']) => ({
    id: provider.id,
    sourceUrl: source.url,
    connection: connectionName,
    webhook,
    ...(missing.length > 0 && { waitingFor: missing }),
    ...(hint !== undefined && { hint }),
  });
  // Without its credentials the source can't verify anything, so nothing may reach the bridge: no inbound
  // connection yet. Requests that arrive meanwhile are kept by Event Gateway, rejected as NO_CONNECTION (verified live).
  if (missing.length) {
    log(`${sourceName}: waiting for ${missing.join(', ')}; delivery is held (no inbound connection) until it's set`);
    return report('pending');
  }

  const rules: Rule[] = [
    ...(definition.inboundDedupeFields?.length
      ? [{ type: 'deduplicate' as const, include_fields: definition.inboundDedupeFields, window: 3_600_000 }]
      : []),
    INBOUND_RETRY_RULE,
  ];
  await hookdeck.upsertConnection({
    name: connectionName,
    source_id: source.id,
    destination: inboundDestination(config, connectionName, `/inbound/${provider.id}`),
    rules,
  });
  log(`upserted connection ${connectionName} (${config.inbound} inbound)`);

  if (definition.sourceConfig) return report(configured ? 'configured' : 'existing');
  if (!definition.register) return report('none');
  let currentSecret: string | undefined;
  let previousId: string | null = null;
  if (existing?.webhookId) {
    const secret = (await hookdeck.getSource(source.id, { includeAuth: true })).config?.auth?.webhook_secret_key;
    const configured = definition.configuredSecret?.(provider.options);
    const changed =
      !sameList(existing.events, provider.events) || existing.target !== target || (configured !== undefined && configured !== secret);
    if (typeof secret === 'string' && secret) {
      if (!changed) return report('existing');
      log(`the ${definition.displayName} events, registration target or secret changed; updating the webhook`);
      currentSecret = secret;
      previousId = existing.webhookId;
    } else {
      // The source lost its signing secret: replace the provider webhook, since its secret can't be read back.
      log(`${sourceName} has no signing secret; replacing the ${definition.displayName} webhook`);
      const staleId = existing.webhookId;
      await definition.unregister?.({ webhookId: staleId, sourceUrl: source.url, options: provider.options, fetch: deps.fetch }).catch((error: Error) =>
        log(`could not remove the old webhook ${staleId}: ${error.message}`),
      );
    }
  }

  const { webhookId, signingSecret } = await definition.register({
    sourceUrl: source.url,
    providerEvents,
    options: provider.options,
    fetch: deps.fetch,
    ...(currentSecret !== undefined && { signingSecret: currentSecret }),
  });
  const description: SourceDescription = { provider: definition.type, events: provider.events, webhookId, ...(target !== undefined && { target }) };
  await hookdeck.upsertSource({
    name: sourceName,
    type: definition.sourceType,
    description: JSON.stringify(description),
    config: { auth: { webhook_secret_key: signingSecret } },
  });
  if (previousId !== null && previousId !== webhookId) {
    const oldId = previousId;
    await definition.unregister?.({ webhookId: oldId, sourceUrl: source.url, options: provider.options, fetch: deps.fetch }).catch((error: Error) =>
      log(`could not remove the old webhook ${oldId}: ${error.message}`),
    );
  }
  if (definition.configuredSecret?.(provider.options) !== undefined) {
    // The config supplies the secret and webhooks are added by hand (for example GitHub's manual mode).
    log(`set the configured ${definition.displayName} secret on ${sourceName}`);
    return report('configured');
  }
  log(`${previousId !== null ? 'updated' : 'registered'} the ${definition.displayName} webhook and set its secret on ${sourceName}`);
  return report(previousId !== null ? 'updated' : 'registered');
}

async function setupNotifications(deps: SetupDeps) {
  const { config, hookdeck } = deps;
  const connectionName = notificationsConnectionName(config.deployment);
  const connection = await hookdeck.upsertConnection({
    name: connectionName,
    source: { name: NOTIFICATIONS_SOURCE, type: 'WEBHOOK' },
    destination: inboundDestination(config, connectionName, '/inbound/hookdeck'),
  });
  await hookdeck.setWebhookNotifications({ enabled: true, topics: NOTIFICATION_TOPICS, sourceId: connection.source.id });

  const triggers = [
    { name: `bridge-delivery-${config.deployment}`, type: 'delivery' as const, configs: { strategy: 'final_attempt', connections: 'mcp-sub-*' } },
    { name: `bridge-request-${config.deployment}`, type: 'request' as const, configs: { rejection_causes: ['VERIFICATION_FAILED'], sources: 'bridge-*' } },
    { name: `bridge-backpressure-${config.deployment}`, type: 'backpressure' as const, configs: { delay: 600_000, destinations: 'bridge-*' } },
  ];
  for (const trigger of triggers) await hookdeck.upsertIssueTrigger(trigger);
  return { notifications: { source: NOTIFICATIONS_SOURCE, connection: connectionName }, triggers: triggers.map((t) => t.name) };
}

export function mcpUrl(config: ResolvedConfig, secret: string): string {
  const base = config.inbound === 'http' && config.publicUrl ? config.publicUrl : `http://127.0.0.1:${config.port}`;
  return `${base}/mcp/${secret}`;
}

export async function runSetup(deps: SetupDeps): Promise<SetupReport> {
  const providers = [];
  for (const provider of deps.config.providers) providers.push(await setupProvider(deps, provider));
  const { notifications, triggers } = await setupNotifications(deps);
  const generated = !deps.config.auth.mcpSecret;
  const secret = deps.config.auth.mcpSecret ?? randomBytes(32).toString('base64url');
  return { providers, notifications, triggers, mcp: { secret, generated, url: mcpUrl(deps.config, secret) } };
}
