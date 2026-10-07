import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CallbackNameError, CallbackRegistry, type CallbacksHookdeck } from '../../src/core/callbacks.js';
import { Catalog } from '../../src/core/catalog.js';
import { DEFAULT_SUBSCRIPTION_SETTINGS, defineConfig, resolveConfig } from '../../src/core/config.js';
import { HookdeckClient } from '../../src/core/hookdeck.js';
import { MemoryStore } from '../../src/core/memory-store.js';
import { Relay } from '../../src/core/relay.js';
import { generateWebhookSecret } from '../../src/core/secret.js';
import { matchSignatures, type SignedHeaders } from '../../src/core/sign.js';
import { SubscriptionService } from '../../src/core/subscriptions.js';
import { resend } from '../../src/providers.js';
import { FakeEventGateway } from '../support/fake-event-gateway.js';

const config = resolveConfig(defineConfig({ deployment: 'dev', providers: [resend({ apiKey: 'x' })] }), { HOOKDECK_API_KEY: 'k', HOOKDECK_SIGNING_SECRET: 'hs' });

function setup() {
  const gateway = new FakeEventGateway();
  const hookdeck = new HookdeckClient({ apiKey: 'k', fetch: gateway.fetch });
  const store = new MemoryStore();
  const callbacks = new CallbackRegistry({ hookdeck, inUse: (url) => store.list().some((s) => s.url === url), now: () => new Date('2026-10-07T12:00:00.000Z') });
  return { gateway, hookdeck, store, callbacks };
}

const secretOf = (gateway: FakeEventGateway, sourceId: string) => (gateway.sources.get(sourceId)!.config as { auth: { webhook_secret_key: string } }).auth.webhook_secret_key;

describe('CallbackRegistry', () => {
  it("creates an MCP Events source and connection per callback on the agent's shared CLI destination", async () => {
    const { gateway, callbacks } = setup();
    const alice = await callbacks.create({ agent: 'laptop', name: 'email_alice' });
    const bob = await callbacks.create({ agent: 'laptop', name: 'email_bob' });

    expect(gateway.sources.get(alice.sourceId)).toMatchObject({ name: 'agent-laptop-email_alice', type: 'MCP_EVENTS' });
    expect(secretOf(gateway, alice.sourceId)).toMatch(/^whsec_/);
    expect(secretOf(gateway, alice.sourceId)).not.toBe(secretOf(gateway, bob.sourceId));
    const destinations = [...gateway.destinations.values()];
    expect(destinations).toEqual([expect.objectContaining({ name: 'agent-laptop', type: 'CLI', config: { path: '/events' } })]);
    expect(alice).toMatchObject({ agent: 'laptop', name: 'email_alice', url: gateway.sources.get(alice.sourceId)!.url, destinationName: 'agent-laptop' });
    expect(await callbacks.create({ agent: 'laptop', name: 'email_alice' })).toEqual(alice); // idempotent
  });

  it('rejects names that would make ambiguous resource names', () => {
    const { callbacks } = setup();
    expect(() => callbacks.create({ agent: 'my-laptop', name: 'a' })).toThrow(CallbackNameError);
    expect(() => callbacks.create({ agent: 'laptop', name: 'a.b' })).toThrow(CallbackNameError);
    expect(() => callbacks.create({ agent: 'laptop', name: 'a', path: 'no-slash' })).toThrow(CallbackNameError);
  });

  it("keeps the source's secret inside the bridge, and finds callbacks again after a restart", async () => {
    const { gateway, hookdeck, store, callbacks } = setup();
    const record = await callbacks.create({ agent: 'laptop', name: 'email' });
    expect(await callbacks.signingSecret(record.url)).toBe(secretOf(gateway, record.sourceId));
    expect(await callbacks.signingSecret('https://example.com/not-a-callback')).toBeUndefined();

    const restarted = new CallbackRegistry({ hookdeck, inUse: (url) => store.list().some((s) => s.url === url) });
    expect(await restarted.load()).toBe(1);
    expect(restarted.find(record.url)).toMatchObject({ agent: 'laptop', name: 'email', sourceId: record.sourceId });
    expect(await restarted.signingSecret(record.url)).toBe(secretOf(gateway, record.sourceId));
  });

  it("releases a callback's source and connection once no subscription uses it, keeping the agent's destination", async () => {
    const { gateway, store, callbacks } = setup();
    const record = await callbacks.create({ agent: 'laptop', name: 'email' });
    await store.put({ ...subscription(), url: record.url });
    expect(await callbacks.release(record.url)).toBe(false);

    await store.delete('sub_1');
    expect(await callbacks.release(record.url)).toBe(true);
    expect(gateway.sources.has(record.sourceId)).toBe(false);
    expect(gateway.connections.has(record.connectionId)).toBe(false);
    expect([...gateway.destinations.values()].map((d) => d.name)).toEqual(['agent-laptop']);
    expect(callbacks.find(record.url)).toBeUndefined();
  });

  it('builds hookdeck listen commands, at most 10 sources each', async () => {
    const { callbacks } = setup();
    for (let i = 0; i < 12; i++) await callbacks.create({ agent: 'laptop', name: `sub_${String(i).padStart(2, '0')}` });
    const commands = callbacks.listenCommands('laptop', 4000);
    expect(commands).toHaveLength(2);
    expect(commands[0]).toMatch(/^hookdeck listen 4000 agent-laptop-sub_00,.*agent-laptop-sub_09$/);
    expect(commands[1]).toBe('hookdeck listen 4000 agent-laptop-sub_10,agent-laptop-sub_11');
  });
});

describe('Signing for callback URLs', () => {
  it("signs the subscribe challenge with the agent's secret and the callback's own", async () => {
    const { store, callbacks } = setup();
    const record = await callbacks.create({ agent: 'laptop', name: 'email' });
    const seen: string[][] = [];
    const service = new SubscriptionService({
      settings: DEFAULT_SUBSCRIPTION_SETTINGS,
      store,
      catalog: new Catalog(config.providers),
      transport: { assertPublicHost: async () => {}, post: async () => ({ status: 200, body: '' }) },
      verify: async (_t, options) => (seen.push([options.secret, ...(options.extraSecrets ?? [])]), { ok: true }),
      callbacks,
    });
    const agentSecret = generateWebhookSecret();
    await service.subscribe('owner', { name: 'email.received', delivery: { url: record.url, secret: agentSecret } });
    expect(seen).toEqual([[agentSecret, await callbacks.signingSecret(record.url)]]);

    await service.unsubscribe('owner', { name: 'email.received', delivery: { url: record.url } });
    expect(callbacks.find(record.url)).toBeUndefined(); // released with its last subscription
  });

  it('signs deliveries to a callback URL with both secrets, so the source and the agent can each verify', async () => {
    const { gateway, hookdeck, store, callbacks } = setup();
    const record = await callbacks.create({ agent: 'laptop', name: 'email' });
    const agentSecret = generateWebhookSecret();
    await store.put({ ...subscription(), url: record.url, secret: agentSecret });
    const relay = new Relay({ signingSecret: 'hs', providerIds: ['resend'], catalog: new Catalog(config.providers), store, hookdeck, callbacks, now: () => new Date('2026-10-05T16:30:00.000Z') });

    const fixture = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'fixtures', 'resend', 'email-received.json'), 'utf8')) as { headers: Record<string, string>; body: unknown };
    const raw = JSON.stringify(fixture.body);
    const signature = createHmac('sha256', 'hs').update(raw).digest('base64');
    expect(await relay.handle('/inbound/resend', { ...fixture.headers, 'x-hookdeck-signature': signature }, raw)).toEqual({ status: 200, body: { published: 1 } });

    const published = gateway.published[0]!;
    const matches = matchSignatures([agentSecret, (await callbacks.signingSecret(record.url))!], published.headers as unknown as SignedHeaders, published.body);
    expect(matches.map((m) => m.secretIndex).sort()).toEqual([0, 1]);
  });
});

describe('Replaying missed deliveries', () => {
  function replaySetup(requests: Array<{ id: string; verified?: boolean; events?: Array<{ id: string; status: string; webhook_id?: string }>; ignored?: string[]; retryCreates?: boolean }>) {
    const calls: string[] = [];
    let description = '';
    const hookdeck = {
      listAllConnections: async () => [
        {
          id: 'web_cb',
          name: 'agent-laptop-email',
          description: JSON.stringify({ v: 1, kind: 'mcp-events-callback', agent: 'laptop', name: 'email', path: '/events', createdAt: '2026-10-07T10:00:00.000Z', replayedUntil: null }),
          source: { id: 'src_cb', name: 'agent-laptop-email', url: 'https://hkdk.events/cb' },
          destination: { id: 'des_cb', name: 'agent-laptop' },
        },
      ],
      listRequests: async (query: { created_at_gte?: string }) => {
        calls.push(`list since ${query.created_at_gte}`);
        return { models: requests.map((r) => ({ id: r.id, verified: r.verified ?? true, created_at: '2026-10-07T11:00:00.000Z' })) };
      },
      listEventsForRequest: async (id: string) => ({ models: (requests.find((r) => r.id === id)!.events ?? []).map((e) => ({ webhook_id: 'web_cb', ...e })) }),
      listIgnoredEventsForRequest: async (id: string) => ({ models: (requests.find((r) => r.id === id)!.ignored ?? []).map((cause) => ({ webhook_id: 'web_cb', cause })) }),
      retryEvent: async (id: string) => (calls.push(`retry event ${id}`), {}),
      retryRequest: async (id: string, ids?: string[]) => {
        calls.push(`retry request ${id} for ${ids?.join(',')}`);
        return { request: {}, events: requests.find((r) => r.id === id)!.retryCreates === false ? [] : [{ id: 'evt_new' }] };
      },
      upsertConnection: async (input: { description: string }) => ((description = input.description), {}),
    } as unknown as CallbacksHookdeck;
    const callbacks = new CallbackRegistry({ hookdeck, inUse: () => true, now: () => new Date('2026-10-07T12:00:00.000Z') });
    return { callbacks, calls, replayedUntil: () => (description ? (JSON.parse(description) as { replayedUntil: string }).replayedUntil : null) };
  }

  it('retries requests ignored while the CLI was offline, and events that failed when it dropped', async () => {
    const { callbacks, calls, replayedUntil } = replaySetup([
      { id: 'req_offline', ignored: ['CLI_DISCONNECTED'] },
      { id: 'req_dropped', events: [{ id: 'evt_failed', status: 'FAILED' }] },
      { id: 'req_done', events: [{ id: 'evt_ok', status: 'SUCCESSFUL' }] },
      { id: 'req_bad_signature', verified: false },
    ]);
    await callbacks.load();
    expect(await callbacks.replay('laptop')).toEqual({ callbacks: 1, requestsChecked: 3, eventsRetried: 1, requestsRetried: 1, pending: 0, upToDate: false });
    expect(calls).toEqual(['list since 2026-10-07T10:00:00.000Z', 'retry request req_offline for web_cb', 'retry event evt_failed']);
    expect(replayedUntil()).toBeNull(); // re-checked next run, once the retries have landed
  });

  it("doesn't move on while deliveries are in flight or the CLI is still offline", async () => {
    const { callbacks, replayedUntil } = replaySetup([
      { id: 'req_queued', events: [{ id: 'evt_q', status: 'QUEUED' }] },
      { id: 'req_still_offline', ignored: ['CLI_DISCONNECTED'], retryCreates: false },
    ]);
    await callbacks.load();
    expect(await callbacks.replay('laptop')).toMatchObject({ requestsRetried: 0, pending: 2, upToDate: false });
    expect(replayedUntil()).toBeNull();
  });

  it('moves the watermark on after a clean run, so the next run starts there', async () => {
    const { callbacks, calls, replayedUntil } = replaySetup([{ id: 'req_done', events: [{ id: 'evt_ok', status: 'SUCCESSFUL' }] }]);
    await callbacks.load();
    expect(await callbacks.replay('laptop')).toMatchObject({ upToDate: true });
    expect(replayedUntil()).toBe('2026-10-07T12:00:00.000Z');
    await callbacks.replay('laptop');
    expect(calls.at(-1)).toBe('list since 2026-10-07T12:00:00.000Z');
  });
});

function subscription() {
  return {
    id: 'sub_1',
    principal: 'owner',
    name: 'email.received',
    arguments: {},
    url: 'https://receiver.example.com/a',
    secret: generateWebhookSecret(),
    previousSecret: null,
    previousSecretExpiresAt: null,
    delivery: { active: true, lastError: null, failedSince: null },
    expiresAt: '2026-11-05T00:00:00.000Z',
    createdAt: '2026-10-05T16:00:00.000Z',
    updatedAt: '2026-10-05T16:00:00.000Z',
  };
}
