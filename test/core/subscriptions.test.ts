import { describe, expect, it } from 'vitest';
import { CallbackUrlError, type CallbackTransport, type VerificationResult } from '../../src/core/callback.js';
import { Catalog } from '../../src/core/catalog.js';
import { DEFAULT_SUBSCRIPTION_SETTINGS, defineConfig, resolveConfig } from '../../src/core/config.js';
import { MemoryStore } from '../../src/core/memory-store.js';
import { generateWebhookSecret } from '../../src/core/secret.js';
import { SubscriptionService, describeParams } from '../../src/core/subscriptions.js';
import { resend } from '../../src/providers.js';

const catalog = new Catalog(
  resolveConfig(defineConfig({ deployment: 'dev', providers: [resend({ apiKey: 'x' })] }), { HOOKDECK_API_KEY: 'k', HOOKDECK_SIGNING_SECRET: 's' }).providers,
);

function setup({ verifyResult = { ok: true } as VerificationResult, publicHost = true } = {}) {
  const store = new MemoryStore();
  const verifications: string[] = [];
  let now = new Date('2026-10-05T12:00:00.000Z');
  const transport: CallbackTransport = {
    assertPublicHost: async (url) => {
      if (!publicHost) throw new CallbackUrlError(`${url.host} is not public`, 'callback_address_not_allowed');
    },
    post: async () => ({ status: 200, body: '' }),
  };
  const service = new SubscriptionService({
    settings: DEFAULT_SUBSCRIPTION_SETTINGS,
    store,
    catalog,
    transport,
    verify: async (_t, options) => {
      verifications.push(options.url.href);
      return verifyResult;
    },
    now: () => now,
  });
  return { service, store, verifications, advance: (ms: number) => (now = new Date(now.getTime() + ms)) };
}

const params = (over: Record<string, unknown> = {}) => ({
  name: 'email.received',
  arguments: { from: 'Alice <Alice@Example.com>' },
  delivery: { mode: 'webhook', url: 'https://receiver.example.com/hook', secret: generateWebhookSecret() },
  ...over,
});

describe('SubscriptionService.subscribe', () => {
  it('verifies the callback, stores the subscription with normalized arguments, and grants the default lifetime', async () => {
    const { service, store, verifications } = setup();
    const result = await service.subscribe('owner', params());
    expect(result).toEqual({ id: expect.stringMatching(/^sub_[0-9a-f]{32}$/), refreshBefore: '2026-11-04T12:00:00.000Z', cursor: null, truncated: false });
    expect(verifications).toEqual(['https://receiver.example.com/hook']);
    expect(store.get(result.id)).toMatchObject({ principal: 'owner', name: 'email.received', arguments: { from: 'alice@example.com' } });
  });

  it('clamps a requested ttlMs to the allowed range', async () => {
    const { service } = setup();
    const short = await service.subscribe('owner', params({ ttlMs: 1000 }));
    expect(short.refreshBefore).toBe('2026-10-05T12:01:00.000Z');
  });

  it.each([
    ['no principal', undefined, params(), -32012],
    ['an unknown event', 'owner', params({ name: 'email.sent' }), -32011],
    ['an http callback', 'owner', params({ delivery: { url: 'http://receiver.example.com/hook', secret: generateWebhookSecret() } }), -32602],
    ['a bad secret', 'owner', params({ delivery: { url: 'https://receiver.example.com/hook', secret: 'nope' } }), -32602],
    ['unknown arguments', 'owner', params({ arguments: { subject: 'x' } }), -32602],
    ['a push delivery mode', 'owner', params({ delivery: { mode: 'push', url: 'https://receiver.example.com/hook', secret: generateWebhookSecret() } }), -32014],
  ])('rejects %s', async (_label, principal, request, code) => {
    await expect(setup().service.subscribe(principal, request)).rejects.toMatchObject({ code });
  });

  it('rejects callbacks that resolve to non-public addresses', async () => {
    await expect(setup({ publicHost: false }).service.subscribe('owner', params())).rejects.toMatchObject({ code: -32602 });
  });

  it('returns -32015 with the reason when verification fails, and stores nothing', async () => {
    const { service, store } = setup({ verifyResult: { ok: false, reason: 'challenge_failed' } });
    await expect(service.subscribe('owner', params())).rejects.toMatchObject({ code: -32015, data: { reason: 'challenge_failed' } });
    expect(store.list()).toEqual([]);
  });

  it('caches verification per principal and URL', async () => {
    const { service, verifications } = setup();
    await service.subscribe('owner', params());
    await service.subscribe('owner', params({ arguments: { to: 'x@example.com' } }));
    expect(verifications).toHaveLength(1);
  });

  it('refreshes in place, rotates the secret with a grace window, and reports delivery status', async () => {
    const { service, store, advance } = setup();
    const first = params();
    const { id } = await service.subscribe('owner', first);
    await store.put({ ...store.get(id)!, delivery: { active: false, lastError: 'http_5xx', failedSince: '2026-10-05T12:30:00.000Z' } });
    advance(60 * 60 * 1000);
    const newSecret = generateWebhookSecret();
    const refreshed = await service.subscribe('owner', { ...first, delivery: { ...first.delivery, secret: newSecret } });
    expect(refreshed.id).toBe(id);
    expect(refreshed.deliveryStatus).toEqual({ active: true, lastError: 'http_5xx', failedSince: '2026-10-05T12:30:00.000Z' });
    expect(store.get(id)).toMatchObject({
      secret: newSecret,
      previousSecret: first.delivery.secret,
      previousSecretExpiresAt: '2026-10-05T13:10:00.000Z',
      delivery: { active: true, lastError: null },
      createdAt: '2026-10-05T12:00:00.000Z',
    });
  });
});

describe('SubscriptionService.unsubscribe and sweep', () => {
  it('unsubscribes by name, arguments and URL, idempotently', async () => {
    const { service, store } = setup();
    const request = params();
    await service.subscribe('owner', request);
    await expect(service.unsubscribe('owner', request)).resolves.toEqual({});
    await expect(service.unsubscribe('owner', request)).resolves.toEqual({});
    expect(store.list()).toEqual([]);
  });

  it('unsubscribes from an event that is no longer configured', async () => {
    const { service } = setup();
    await expect(service.unsubscribe('owner', params({ name: 'email.removed' }))).resolves.toEqual({});
  });

  it('keeps the callback query string and the secret out of logs', () => {
    const secret = generateWebhookSecret();
    const logged = describeParams(params({ delivery: { url: 'https://receiver.example.com/hook?token=abc', secret } }));
    expect(logged).toContain('https://receiver.example.com/hook?<redacted>');
    expect(logged).not.toContain('token=abc');
    expect(logged).not.toContain(secret);
  });

  it('sweeps subscriptions whose grant has lapsed', async () => {
    const { service, store, advance } = setup();
    const { id } = await service.subscribe('owner', params({ ttlMs: 60_000 }));
    await service.subscribe('owner', params({ arguments: {} }));
    advance(2 * 60_000);
    expect(await service.sweep()).toEqual([id]);
    expect(store.list()).toHaveLength(1);
  });
});
