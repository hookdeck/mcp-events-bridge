import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { healthyDelivery, type ProviderRecord, type SubscriptionRecord } from '../../src/core/store.js';
import { SqliteStore } from '../../src/host/sqlite-store.js';

const at = '2026-10-05T12:00:00.000Z';

const provider = (over: Partial<ProviderRecord> = {}): ProviderRecord => ({
  instanceId: 'resend',
  type: 'resend',
  optionsHash: 'h1',
  sourceId: 'src_1',
  sourceUrl: 'https://hkdk.events/abc',
  connectionId: 'web_1',
  events: ['email.received'],
  providerWebhookId: 'wh_1',
  createdAt: at,
  updatedAt: at,
  ...over,
});

const subscription = (over: Partial<SubscriptionRecord> = {}): SubscriptionRecord => ({
  id: 'sub_1',
  principal: 'owner',
  name: 'email.received',
  arguments: { from: 'alice@example.com' },
  url: 'https://receiver.example.com/hook',
  secret: 'whsec_c2VjcmV0c2VjcmV0c2VjcmV0c2VjcmV0',
  previousSecret: null,
  previousSecretExpiresAt: null,
  connectionId: 'web_sub_1',
  destinationId: 'des_sub_1',
  delivery: healthyDelivery(),
  expiresAt: '2026-11-05T12:00:00.000Z',
  createdAt: at,
  updatedAt: at,
  ...over,
});

const stores: SqliteStore[] = [];
const open = (file = ':memory:') => {
  const store = new SqliteStore(file);
  stores.push(store);
  return store;
};
afterEach(async () => {
  await Promise.all(stores.splice(0).map((s) => s.close()));
});

describe('SqliteStore', () => {
  it('upserts and reads providers', async () => {
    const store = open();
    await store.putProvider(provider());
    await store.putProvider(provider({ optionsHash: 'h2', events: ['email.received', 'email.bounced'], updatedAt: '2026-10-06T00:00:00.000Z' }));
    expect(await store.getProvider('resend')).toMatchObject({ optionsHash: 'h2', events: ['email.received', 'email.bounced'], createdAt: at });
    expect(await store.listProviders()).toHaveLength(1);
    await store.deleteProvider('resend');
    expect(await store.getProvider('resend')).toBeUndefined();
  });

  it('upserts and reads topics', async () => {
    const store = open();
    await store.putTopic({ name: 'email.received', sourceId: 'src_t', sourceName: 'bridge-out-email.received' });
    expect(await store.getTopic('email.received')).toEqual({ name: 'email.received', sourceId: 'src_t', sourceName: 'bridge-out-email.received' });
    await store.deleteTopic('email.received');
    expect(await store.getTopic('email.received')).toBeUndefined();
  });

  it('round-trips subscriptions, including arguments, secrets and delivery state', async () => {
    const store = open();
    const record = subscription({
      previousSecret: 'whsec_b2xkb2xkb2xkb2xkb2xkb2xkb2xkb2xk',
      previousSecretExpiresAt: '2026-10-05T12:10:00.000Z',
      delivery: { active: false, lastError: 'http_5xx', failedSince: at },
    });
    await store.putSubscription(record);
    expect(await store.getSubscription('sub_1')).toEqual(record);
    expect(await store.findSubscriptionByConnection('web_sub_1')).toEqual(record);
  });

  it('filters subscriptions by event name', async () => {
    const store = open();
    await store.putSubscription(subscription({ id: 'sub_a', connectionId: 'web_a' }));
    await store.putSubscription(subscription({ id: 'sub_b', connectionId: 'web_b', name: 'issues.opened' }));
    expect((await store.listSubscriptions({ name: 'email.received' })).map((s) => s.id)).toEqual(['sub_a']);
    expect(await store.listSubscriptions()).toHaveLength(2);
  });

  it('lists expired subscriptions for the sweeper', async () => {
    const store = open();
    await store.putSubscription(subscription({ id: 'sub_old', connectionId: 'web_old', expiresAt: '2026-10-01T00:00:00.000Z' }));
    await store.putSubscription(subscription({ id: 'sub_new', connectionId: 'web_new', expiresAt: '2026-12-01T00:00:00.000Z' }));
    expect((await store.listExpiredSubscriptions(new Date(at))).map((s) => s.id)).toEqual(['sub_old']);
  });

  it('persists to a file that only the owner can read', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-store-'));
    const file = path.join(dir, 'data', 'bridge.db');
    const first = new SqliteStore(file);
    await first.putSubscription(subscription());
    await first.close();
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const second = open(file);
    expect(await second.getSubscription('sub_1')).toMatchObject({ id: 'sub_1', secret: subscription().secret });
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
