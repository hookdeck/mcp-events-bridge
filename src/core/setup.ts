import { createHash, randomBytes } from 'node:crypto';
import type { ResolvedConfig, ResolvedProvider } from './config.js';
import type { HookdeckClient, Rule, UpsertConnectionInput } from './hookdeck.js';
import { providerConnectionName, providerSourceName } from './names.js';

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
  providers: Array<{ id: string; sourceUrl: string; connection: string; webhook: 'registered' | 'updated' | 'existing' | 'none' }>;
  notifications: { source: string; connection: string };
  triggers: string[];
  mcp: { secret: string; generated: boolean; url: string };
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

async function setupProvider(deps: SetupDeps, provider: ResolvedProvider) {
  const { config, hookdeck } = deps;
  const log = deps.log ?? (() => {});
  const { definition } = provider;
  const sourceName = providerSourceName(provider.id);
  const connectionName = providerConnectionName(provider.id, config.deployment);
  const providerEvents = definition.events.filter((e) => provider.events.includes(e.name)).map((e) => e.providerEvent);
  const target = definition.registrationTarget ? fingerprint(definition.registrationTarget(provider.options)) : undefined;

  // The source first, by name, so the connection upsert below never touches its auth config.
  let source = (await hookdeck.listSources({ name: sourceName })).models[0];
  let existing = parseSourceDescription(source?.description);
  if (!source) {
    const description: SourceDescription = { provider: definition.type, events: provider.events, webhookId: null };
    source = await hookdeck.upsertSource({ name: sourceName, type: definition.sourceType, description: JSON.stringify(description) });
    existing = description;
    log(`created source ${sourceName}`);
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

  if (!definition.register) return { id: provider.id, sourceUrl: source.url, connection: connectionName, webhook: 'none' as const };
  let currentSecret: string | undefined;
  let previousId: string | null = null;
  if (existing?.webhookId) {
    const secret = (await hookdeck.getSource(source.id, { includeAuth: true })).config?.auth?.webhook_secret_key;
    const changed = !sameList(existing.events, provider.events) || existing.target !== target;
    if (typeof secret === 'string' && secret) {
      if (!changed) return { id: provider.id, sourceUrl: source.url, connection: connectionName, webhook: 'existing' as const };
      log(`the ${definition.displayName} events or registration target changed; updating the webhook`);
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
  log(`${previousId !== null ? 'updated' : 'registered'} the ${definition.displayName} webhook and set its secret on ${sourceName}`);
  return { id: provider.id, sourceUrl: source.url, connection: connectionName, webhook: previousId !== null ? ('updated' as const) : ('registered' as const) };
}

async function setupNotifications(deps: SetupDeps) {
  const { config, hookdeck } = deps;
  const connectionName = `bridge-notifications-${config.deployment}`;
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
