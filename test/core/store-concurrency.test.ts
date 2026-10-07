import { describe, expect, it } from 'vitest';
import { Catalog } from '../../src/core/catalog.js';
import { DEFAULT_SUBSCRIPTION_SETTINGS, defineConfig, resolveConfig } from '../../src/core/config.js';
import { EventGatewayStore } from '../../src/core/event-gateway-store.js';
import { HookdeckApiError, type HookdeckClient } from '../../src/core/hookdeck.js';
import { generateWebhookSecret } from '../../src/core/secret.js';
import { SubscriptionService } from '../../src/core/subscriptions.js';
import { healthyDelivery, type SubscriptionInput } from '../../src/core/store.js';
import { resend } from '../../src/providers.js';

/*
 * Found in review: writes that read state outside the store's queue could
 * interleave with other writes. These use a slow fake Event Gateway so the
 * interleavings actually happen.
 */

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function slowGateway({ missing = new Set<string>() } = {}) {
  const deleted: string[] = [];
  const hookdeck = {
    async upsertConnection(input: { name: string; source: { name: string } }) {
      await sleep(20);
      return { id: `web_${input.name}`, source: { id: `src_${input.source.name}` }, destination: { id: `des_${input.name}` } };
    },
    async deleteConnection(id: string) {
      await sleep(20);
      if (missing.has(id)) throw new HookdeckApiError('DELETE', `/connections/${id}`, 404, '{}');
      deleted.push(id);
    },
    async deleteDestination(id: string) {
      await sleep(5);
      deleted.push(id);
    },
    async deleteSource(id: string) {
      deleted.push(id);
    },
  };
  return { hookdeck: hookdeck as unknown as HookdeckClient, deleted };
}

const catalog = new Catalog(
  resolveConfig(defineConfig({ deployment: 'dev', providers: [resend({ apiKey: 'x' })] }), { HOOKDECK_API_KEY: 'k', HOOKDECK_SIGNING_SECRET: 's' }).providers,
);

function service(store: EventGatewayStore) {
  let now = new Date('2026-10-05T12:00:00.000Z');
  const subscriptions = new SubscriptionService({
    settings: { ...DEFAULT_SUBSCRIPTION_SETTINGS, minTtlMs: 1000 },
    store,
    catalog,
    transport: { assertPublicHost: async () => {}, post: async () => ({ status: 200, body: '' }) },
    verify: async () => ({ ok: true }),
    now: () => now,
  });
  return { subscriptions, advance: (ms: number) => (now = new Date(now.getTime() + ms)) };
}

const params = (secret: string, over: Record<string, unknown> = {}) => ({
  name: 'resend.email.received',
  delivery: { url: 'https://receiver.example.com/hook', secret },
  ...over,
});

describe('EventGatewayStore under concurrent writes', () => {
  it("doesn't let a sweep delete a subscription refreshed while the sweep runs", async () => {
    const store = new EventGatewayStore(slowGateway().hookdeck);
    const { subscriptions, advance } = service(store);
    const secret = generateWebhookSecret();
    await subscriptions.subscribe('owner', params(secret, { ttlMs: 1000 }));
    const { id } = await subscriptions.subscribe('owner', params(secret, { ttlMs: 1000, arguments: { from: 'a@example.com' } }));
    advance(5000); // both expired

    const sweeping = subscriptions.sweep();
    await sleep(5); // the sweep is deleting the first one
    await subscriptions.subscribe('owner', params(secret, { arguments: { from: 'a@example.com' } })); // refresh the second
    const removed = await sweeping;

    expect(removed).not.toContain(id);
    expect(store.get(id)).toBeDefined();
  });

  it("doesn't let a delivery-failure update undo a refresh that rotates the secret", async () => {
    const store = new EventGatewayStore(slowGateway().hookdeck);
    const { subscriptions, advance } = service(store);
    const first = generateWebhookSecret();
    const second = generateWebhookSecret();
    const { id } = await subscriptions.subscribe('owner', params(first));
    advance(60_000);

    const refreshing = subscriptions.subscribe('owner', params(second));
    await sleep(1);
    // What the relay does for a delivery issue: mark it failing, from the current state.
    const failing = store.update(id, (current) =>
      current ? { ...current, delivery: { active: false, lastError: 'http_5xx', failedSince: '2026-10-05T12:01:00.000Z' } } : null,
    );
    await Promise.all([refreshing, failing]);

    expect(store.get(id)).toMatchObject({ secret: second, delivery: { active: false, lastError: 'http_5xx' } });
  });

  it('treats resources already deleted as deleted, so unsubscribe and sweeps can finish', async () => {
    const missing = new Set<string>();
    const { hookdeck } = slowGateway({ missing });
    const store = new EventGatewayStore(hookdeck);
    const record = await store.put(input('sub_gone'));
    missing.add(record.connectionId); // deleted in the dashboard, say
    await expect(store.delete('sub_gone')).resolves.toBe(true);
    expect(store.get('sub_gone')).toBeUndefined();
  });

  it('always leaves room to record a delivery failure', async () => {
    const store = new EventGatewayStore(slowGateway().hookdeck);
    // The largest arguments the store accepts...
    let length = 0;
    for (; length < 600; length += 5) {
      const ok = await store.put(input(`sub_${length}`, 'x'.repeat(length))).then(() => true, () => false);
      if (!ok) break;
    }
    const largest = input('sub_largest', 'x'.repeat(length - 5));
    await store.put(largest);
    // ...still fit once a failure is recorded.
    await expect(store.put({ ...largest, delivery: { active: false, lastError: 'connection_refused', failedSince: largest.updatedAt } })).resolves.toBeDefined();
  });
});

function input(id: string, from = ''): SubscriptionInput {
  return {
    id,
    principal: 'owner',
    name: 'resend.email.received',
    arguments: from ? { from } : {},
    url: 'https://receiver.example.com/hook',
    secret: generateWebhookSecret(),
    previousSecret: null,
    previousSecretExpiresAt: null,
    delivery: healthyDelivery(),
    expiresAt: '2026-11-04T12:00:00.000Z',
    createdAt: '2026-10-05T12:00:00.000Z',
    updatedAt: '2026-10-05T12:00:00.000Z',
  };
}
