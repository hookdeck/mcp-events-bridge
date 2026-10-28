import { describe, expect, it } from 'vitest';
import { CallbackRegistry } from '../../src/core/callbacks.js';
import { defineConfig, resolveConfig } from '../../src/core/config.js';
import { EventGatewayStore } from '../../src/core/event-gateway-store.js';
import { HookdeckClient } from '../../src/core/hookdeck.js';
import { Catalog } from '../../src/core/catalog.js';
import { compareVersions, describeMigration, migrate, migrationNeeded, migrationNotice, planMigration } from '../../src/core/migrate.js';
import { ensureTransformations, transformationVersion } from '../../src/core/transformation.js';
import { generateWebhookSecret } from '../../src/core/secret.js';
import { resend } from '../../src/sources.js';
import { FakeEventGateway } from '../support/fake-event-gateway.js';

const NOW = new Date('2026-10-28T09:00:00.000Z');
const config = resolveConfig(defineConfig({ deployment: 'local', sources: [resend({ apiKey: 'x' })] }), { HOOKDECK_API_KEY: 'k', HOOKDECK_SIGNING_SECRET: 's' });

/** A project as 0.7 left it: a topic source with subscriptions, inbound connections for two deployments, and a callback URL. */
async function project07() {
  const gateway = new FakeEventGateway();
  const hookdeck = new HookdeckClient({ apiKey: 'k', fetch: gateway.fetch });
  await hookdeck.upsertSource({ name: 'bridge-resend', type: 'RESEND', config: { auth: { webhook_secret_key: 'whsec_resend' } } });
  for (const deployment of ['local', 'fly']) {
    await hookdeck.upsertConnection({ name: `bridge-resend-${deployment}`, source: { name: 'bridge-resend', type: 'RESEND' }, destination: { name: `bridge-resend-${deployment}`, type: 'CLI', config: { path: '/inbound/resend' } } });
  }
  const subscriber = generateWebhookSecret();
  const subscription = (id: string, over: Record<string, unknown> = {}) =>
    hookdeck.upsertConnection({
      name: `mcp-sub-${id}`,
      description: JSON.stringify({ v: 1, principal: 'owner', event: 'resend.email.received', arguments: { from: 'alice@example.com' }, expiresAt: '2026-11-05T00:00:00.000Z', createdAt: '2026-10-20T00:00:00.000Z', updatedAt: '2026-10-27T00:00:00.000Z', ...over }),
      source: { name: 'bridge-out-resend_email_received', type: 'PUBLISH_API' },
      destination: { name: `mcp-sub-${id}`, type: 'HTTP', config: { url: `https://receiver.example.com/${id}`, auth_type: 'CUSTOM_SIGNATURE', auth: { key: 'x-mcp-bridge-hmac', signing_secret: subscriber } } },
    });
  await subscription('sub_live');
  await subscription('sub_expired', { expiresAt: '2026-10-01T00:00:00.000Z' });
  await subscription('sub_gone', { event: 'github.issues' });
  await hookdeck.upsertConnection({
    name: 'agent-laptop-base',
    description: JSON.stringify({ v: 1, kind: 'mcp-events-callback', agent: 'laptop', name: 'base', path: '/', port: 9901, createdAt: '2026-10-20T00:00:00.000Z', checkedUntil: '2026-10-27T00:00:00.000Z' }),
    source: { name: 'agent-laptop-base', type: 'MCP_EVENTS', config: { auth: { webhook_secret_key: 'whsec_bridge_generated' } } },
    destination: { name: 'agent-laptop', type: 'CLI', config: { path: '/' } },
  });
  return { gateway, hookdeck, subscriber };
}

describe('migrating from 0.7', () => {
  it('finds subscriptions, callback URLs, topic sources and this deployment\'s inbound connections, described in a user\'s terms', async () => {
    const { hookdeck } = await project07();
    const plan = await planMigration(hookdeck, config);
    expect(plan.subscriptions.map((c) => c.name).sort()).toEqual(['mcp-sub-sub_expired', 'mcp-sub-sub_gone', 'mcp-sub-sub_live']);
    expect(plan.callbacks.map((c) => c.name)).toEqual(['agent-laptop-base']);
    expect(plan.topicSources.map((s) => s.name)).toEqual(['bridge-out-resend_email_received']);
    expect(plan.inboundConnections.map((c) => c.name)).toEqual(['bridge-resend-local']);
    expect(migrationNeeded(plan)).toBe(true);
    expect(describeMigration(plan)).toBe('3 subscriptions and 1 callback URL from an earlier version');
  });

  it('re-creates each subscription on its source with the same id, URL, secret and arguments, and removes expired or no longer offered ones', async () => {
    const { gateway, hookdeck, subscriber } = await project07();
    const logs: string[] = [];
    const report = await migrate({ hookdeck, config, plan: await planMigration(hookdeck, config), now: () => NOW, log: (m) => logs.push(m) });
    expect(report).toEqual({ subscriptions: 1, removed: 2, failed: 0, callbacks: 1, topicSources: 1, inboundConnections: 1, transformations: 0 });

    const store = new EventGatewayStore(hookdeck, async () => {
      throw new Error('not used');
    });
    expect(await store.load()).toEqual({ loaded: 1, unreadable: [], legacy: 0 });
    expect(store.get('sub_live')).toMatchObject({
      principal: 'owner',
      name: 'resend.email.received',
      arguments: { from: 'alice@example.com' },
      url: 'https://receiver.example.com/sub_live',
      secret: subscriber,
      expiresAt: '2026-11-05T00:00:00.000Z',
      createdAt: '2026-10-20T00:00:00.000Z',
    });
    const resendSource = [...gateway.sources.values()].find((s) => s.name === 'bridge-resend')!;
    expect(store.get('sub_live')!.sourceId).toBe(resendSource.id);
    expect(logs).toContain('removed subscription sub_expired: it had expired');
    expect(logs).toContain("removed subscription sub_gone: this bridge doesn't offer github.issues");
  });

  it('makes each callback URL pass-through, keeping its URL, and leaves another deployment\'s inbound connection', async () => {
    const { gateway, hookdeck } = await project07();
    const callbackSource = [...gateway.sources.values()].find((s) => s.name === 'agent-laptop-base')!;
    await migrate({ hookdeck, config, plan: await planMigration(hookdeck, config), now: () => NOW });
    expect(gateway.sources.get(callbackSource.id)).toMatchObject({ type: 'WEBHOOK', url: callbackSource.url, config: {} });
    const callbacks = new CallbackRegistry({ hookdeck, inUse: () => true, subscription: () => undefined });
    expect(await callbacks.load()).toEqual({ loaded: 1, legacy: 0 });
    expect(callbacks.find(callbackSource.url!)).toMatchObject({ agent: 'laptop', name: 'base', port: 9901, path: '/', passThrough: true, checkedUntil: '2026-10-27T00:00:00.000Z' });

    const names = [...gateway.connections.values()].map((c) => c.name).sort();
    expect(names).toEqual(['agent-laptop-base', 'bridge-resend-fly', 'mcp-sub-sub_live']);
    expect([...gateway.sources.values()].map((s) => s.name)).not.toContain('bridge-out-resend_email_received');
    expect(migrationNeeded(await planMigration(hookdeck, config))).toBe(false);
  });

  it("leaves a subscription it can't re-create as it was, and continues", async () => {
    const { gateway, hookdeck } = await project07();
    const live = [...gateway.connections.values()].find((c) => c.name === 'mcp-sub-sub_live')!;
    gateway.destinations.get(live.destinationId)!.config = { url: 'https://receiver.example.com/sub_live', auth_type: 'CUSTOM_SIGNATURE', auth: {} };
    const logs: string[] = [];
    const report = await migrate({ hookdeck, config, plan: await planMigration(hookdeck, config), now: () => NOW, log: (m) => logs.push(m) });
    expect(report).toMatchObject({ subscriptions: 0, failed: 1, callbacks: 1 });
    expect(gateway.connections.has(live.id)).toBe(true);
    expect(logs.some((l) => l.startsWith('could not migrate subscription sub_live: its destination has no secret or URL'))).toBe(true);
    // Its topic source stays while it's still on it.
    expect([...gateway.sources.values()].map((s) => s.name)).toContain('bridge-out-resend_email_received');
  });

  it('finds event mappings a newer version wrote, says so in plain terms, and replaces them when migrating', async () => {
    const gateway = new FakeEventGateway();
    const hookdeck = new HookdeckClient({ apiKey: 'k', fetch: gateway.fetch });
    await ensureTransformations(hookdeck, config.sources, new Catalog(config.sources), { version: '0.8.1' });
    expect(migrationNeeded(await planMigration(hookdeck, config, '0.8.1'))).toBe(false); // the same version
    expect(migrationNeeded(await planMigration(hookdeck, config, '0.9.0'))).toBe(false); // an older one: an upgrade
    const plan = await planMigration(hookdeck, config, '0.8.0');
    expect(plan.transformations).toEqual([{ source: 'resend', version: '0.8.1' }]);
    expect(migrationNeeded(plan)).toBe(true);
    expect(migrationNotice(plan, '0.8.0')).toBe(
      "This project's event mappings in Event Gateway were written by a newer version of the bridge (source resend, 0.8.1); this is 0.8.0. Another bridge on the newer version may share this project, and migrating replaces them with this version's.",
    );
    expect(await migrate({ hookdeck, config, plan, version: '0.8.0', now: () => NOW })).toMatchObject({ transformations: 1 });
    expect(transformationVersion([...gateway.transformations.values()][0]!.code)).toBe('0.8.0');
    expect(migrationNeeded(await planMigration(hookdeck, config, '0.8.0'))).toBe(false);
  });

  it('orders versions, with a pre-release before its release', () => {
    expect(compareVersions('0.8.1', '0.8.0')).toBeGreaterThan(0);
    expect(compareVersions('0.10.0', '0.9.9')).toBeGreaterThan(0);
    expect(compareVersions('0.8.0-beta.1', '0.8.0')).toBeLessThan(0);
    expect(compareVersions('0.8.0', '0.8.0')).toBe(0);
    expect(compareVersions('unknown', '0.8.0')).toBe(0);
  });

  it('finds nothing to migrate in a new project', async () => {
    const gateway = new FakeEventGateway();
    const hookdeck = new HookdeckClient({ apiKey: 'k', fetch: gateway.fetch });
    expect(migrationNeeded(await planMigration(hookdeck, config))).toBe(false);
  });
});
