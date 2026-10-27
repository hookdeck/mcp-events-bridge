import { CALLBACK_KIND, isLegacyCallback } from './callbacks.js';
import { Catalog } from './catalog.js';
import type { ResolvedConfig } from './config.js';
import { EventGatewayStore, isLegacySubscription } from './event-gateway-store.js';
import { HookdeckApiError, type Connection, type HookdeckClient } from './hookdeck.js';
import { providerConnectionName, providerSourceName, SUBSCRIPTION_PREFIX } from './names.js';
import { placeSubscriptions } from './placement.js';
import { healthyDelivery, type SubscriptionInput } from './store.js';
import { ensureTransformations } from './transformation.js';

/*
 * Migrating a project from 0.7 or earlier, where the bridge relayed every event: a subscription was a connection on a
 * PUBLISH_API topic source (`bridge-out-<event>`) with a CUSTOM_SIGNATURE destination holding the secret, the service
 * sources had an inbound connection to each deployment (`bridge-<source>-<deployment>`), and a callback URL from the
 * bridge was an MCP_EVENTS source holding a secret the bridge generated and signed with.
 *
 * - Each subscription is re-created on its service's source with the same id, callback URL, secret, arguments and
 *   expiry, so subscribers keep it and refresh it as before. One that has expired, or is for an event the config no
 *   longer offers, is deleted.
 * - Each callback URL becomes pass-through, keeping its URL: deliveries are now signed with the subscriber's secret
 *   only, which the bridge's own secret on the source would reject. The change takes about a minute to reach Event
 *   Gateway's edge; deliveries refused until then are retried.
 * - The topic sources go once nothing is on them, and so do this deployment's inbound connections (another
 *   deployment's are left for it to migrate).
 *
 * Detected by `planMigration`; `setup` asks before migrating, and `serve` migrates only with --migrate.
 */

export const UPGRADING_URL = 'https://github.com/hookdeck/mcp-events-bridge/blob/main/docs/UPGRADING.md';
const TOPIC_SOURCE_PREFIX = 'bridge-out-';

export interface MigrationPlan {
  subscriptions: Connection[];
  callbacks: Connection[];
  topicSources: Array<{ id: string; name: string }>;
  inboundConnections: Connection[];
}

export interface MigrationReport {
  subscriptions: number;
  /** Expired, or for an event the config no longer offers. */
  removed: number;
  /** Couldn't be read or re-created: logged, and left for the subscriber's next refresh. */
  failed: number;
  callbacks: number;
  topicSources: number;
  inboundConnections: number;
}

type MigrationHookdeck = Pick<
  HookdeckClient,
  'listAllConnections' | 'listSources' | 'getDestination' | 'deleteConnection' | 'deleteDestination' | 'deleteSource' | 'upsertSource' | 'upsertConnection' | 'upsertTransformation'
>;

export async function planMigration(hookdeck: Pick<HookdeckClient, 'listAllConnections' | 'listSources'>, config: ResolvedConfig): Promise<MigrationPlan> {
  const connections = await hookdeck.listAllConnections();
  const sources = (await hookdeck.listSources({ limit: 255 })).models;
  return {
    subscriptions: connections.filter(isLegacySubscription),
    callbacks: connections.filter((c) => isLegacyCallback(c.description)),
    topicSources: sources.filter((s) => s.name.startsWith(TOPIC_SOURCE_PREFIX)).map((s) => ({ id: s.id, name: s.name })),
    // This deployment's, on a service source in this config: another deployment's are left for it to migrate.
    inboundConnections: connections.filter((c) =>
      config.sources.some((s) => c.name === providerConnectionName(s.id, config.deployment) && c.source?.name === providerSourceName(s.id)),
    ),
  };
}

export const migrationNeeded = (plan: MigrationPlan) =>
  plan.subscriptions.length + plan.callbacks.length + plan.topicSources.length + plan.inboundConnections.length > 0;

/** What was found, in a user's terms: subscriptions and callback URLs, not Event Gateway resources. */
export function describeMigration(plan: MigrationPlan): string {
  const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const parts = [
    plan.subscriptions.length > 0 && count(plan.subscriptions.length, 'subscription', 'subscriptions'),
    plan.callbacks.length > 0 && count(plan.callbacks.length, 'callback URL', 'callback URLs'),
  ].filter(Boolean);
  return parts.length ? `${parts.join(' and ')} from an earlier version` : 'Event Gateway resources from an earlier version';
}

export async function migrate(deps: { hookdeck: MigrationHookdeck; config: ResolvedConfig; plan: MigrationPlan; now?: () => Date; log?: (message: string) => void }): Promise<MigrationReport> {
  const { hookdeck, config, plan } = deps;
  const log = deps.log ?? (() => {});
  const now = (deps.now ?? (() => new Date()))();
  const report: MigrationReport = { subscriptions: 0, removed: 0, failed: 0, callbacks: 0, topicSources: 0, inboundConnections: 0 };

  // 1. Callback URLs first, so they accept deliveries signed with the subscriber's secret alone.
  for (const connection of plan.callbacks) {
    const metadata = JSON.parse(connection.description ?? '{}') as { agent?: string; name?: string; path?: string; port?: number; createdAt?: string; checkedUntil?: string | null };
    await hookdeck.upsertSource({ name: connection.source.name, type: 'WEBHOOK', config: {} });
    const path = metadata.path ?? '/events';
    await hookdeck.upsertConnection({
      name: connection.name,
      description: JSON.stringify({
        v: 2,
        kind: CALLBACK_KIND,
        agent: metadata.agent,
        name: metadata.name,
        path,
        port: metadata.port ?? 3000,
        passThrough: true,
        createdAt: metadata.createdAt ?? now.toISOString(),
        checkedUntil: metadata.checkedUntil ?? null,
      }),
      source_id: connection.source.id,
      destination: { name: connection.destination.name, type: 'CLI', config: { path } },
    });
    report.callbacks++;
    log(`callback URL ${connection.name} now passes deliveries through; its receiver verifies them (it takes about a minute to accept them, and Event Gateway retries until then)`);
  }

  // 2. Subscriptions, on their service's source.
  const catalog = new Catalog(config.sources);
  if (plan.subscriptions.length) {
    const transformations = await ensureTransformations(hookdeck, config.sources, catalog);
    const sourceIds = new Map<string, string>();
    const sourceIdFor = async (id: string) => {
      if (!sourceIds.has(id)) {
        const found = (await hookdeck.listSources({ name: providerSourceName(id) })).models[0];
        if (found) sourceIds.set(id, found.id);
      }
      return sourceIds.get(id);
    };
    const store = new EventGatewayStore(hookdeck as HookdeckClient, placeSubscriptions({ catalog, sourceIdFor, transformations }));
    for (const connection of plan.subscriptions) {
      const id = connection.name.slice(SUBSCRIPTION_PREFIX.length);
      try {
        const metadata = JSON.parse(connection.description ?? '') as {
          principal: string;
          event: string;
          arguments?: Record<string, unknown>;
          expiresAt: string;
          createdAt: string;
          updatedAt: string;
          delivery?: SubscriptionInput['delivery'];
        };
        const destination = await hookdeck.getDestination(connection.destination.id, { includeAuth: true });
        const secret = destination.config?.auth?.signing_secret;
        const url = destination.config?.url;
        const expired = Date.parse(metadata.expiresAt) <= now.getTime();
        const offered = Boolean(catalog.get(metadata.event));
        // Checked before anything is deleted, so one that can't be re-created is left as it was.
        if (!expired && offered && (!secret || !url)) throw new Error('its destination has no secret or URL');
        await hookdeck.deleteConnection(connection.id).catch(ignoreNotFound);
        await hookdeck.deleteDestination(connection.destination.id).catch(ignoreNotFound);
        if (expired || !offered) {
          report.removed++;
          log(`removed subscription ${id}: ${expired ? 'it had expired' : `this bridge doesn't offer ${metadata.event}`}`);
          continue;
        }
        await store.put({
          id,
          principal: metadata.principal,
          name: metadata.event,
          arguments: metadata.arguments ?? {},
          url: url!,
          secret: secret!,
          replay: null,
          delivery: metadata.delivery ?? healthyDelivery(),
          expiresAt: metadata.expiresAt,
          createdAt: metadata.createdAt,
          updatedAt: now.toISOString(),
        });
        report.subscriptions++;
      } catch (error) {
        report.failed++;
        log(`could not migrate subscription ${id}: ${(error as Error).message}; its subscriber's next refresh creates it again`);
      }
    }
  }

  // 3. Topic sources nothing is on any more (another deployment still on 0.7 may have some).
  const remaining = await hookdeck.listAllConnections();
  for (const source of plan.topicSources) {
    if (remaining.some((c) => c.source?.id === source.id)) continue;
    await hookdeck.deleteSource(source.id).catch(ignoreNotFound);
    report.topicSources++;
  }

  // 4. This deployment's inbound connections for service events, and their destinations.
  for (const connection of plan.inboundConnections) {
    await hookdeck.deleteConnection(connection.id).catch(ignoreNotFound);
    await hookdeck.deleteDestination(connection.destination.id).catch(ignoreNotFound);
    report.inboundConnections++;
  }

  log(
    `migrated ${report.subscriptions} subscription(s) and ${report.callbacks} callback URL(s)` +
      (report.removed ? `; removed ${report.removed} expired or no longer offered` : '') +
      (report.failed ? `; ${report.failed} failed (see above)` : ''),
  );
  return report;
}

function ignoreNotFound(error: unknown): void {
  if (error instanceof HookdeckApiError && error.status === 404) return;
  throw error;
}
