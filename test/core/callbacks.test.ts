import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Webhook } from 'standardwebhooks';
import { describe, expect, it } from 'vitest';
import { verifyEndpoint } from '../../src/core/callback.js';
import { CallbackInputError, CallbackRegistry, RESEND_ID_HEADER, RETRY_OF_HEADER, type CallbacksHookdeck } from '../../src/core/callbacks.js';
import { Catalog } from '../../src/core/catalog.js';
import { DEFAULT_SUBSCRIPTION_SETTINGS, defineConfig, resolveConfig } from '../../src/core/config.js';
import { HookdeckClient } from '../../src/core/hookdeck.js';
import { MemoryStore } from '../../src/core/memory-store.js';
import { Relay } from '../../src/core/relay.js';
import { generateWebhookSecret } from '../../src/core/secret.js';
import { matchSignatures, type SignedHeaders } from '../../src/core/sign.js';
import { healthyDelivery, type SubscriptionInput } from '../../src/core/store.js';
import { SubscriptionService } from '../../src/core/subscriptions.js';
import { resend } from '../../src/providers.js';
import { FakeEventGateway } from '../support/fake-event-gateway.js';

const config = resolveConfig(defineConfig({ deployment: 'dev', providers: [resend({ apiKey: 'x' })] }), { HOOKDECK_API_KEY: 'k', HOOKDECK_SIGNING_SECRET: 'hs' });

function setup({ graceMs = 60 * 60 * 1000 } = {}) {
  const gateway = new FakeEventGateway();
  const hookdeck = new HookdeckClient({ apiKey: 'k', fetch: gateway.fetch });
  const store = new MemoryStore();
  let now = new Date('2026-10-07T12:00:00.000Z');
  const deletedUrls: string[] = [];
  const callbacks = new CallbackRegistry({
    hookdeck,
    inUse: (url) => store.list().some((s) => s.url === url),
    subscription: (id) => store.get(id),
    onDeleted: (url) => deletedUrls.push(url),
    settings: { graceMs, maxPerAgent: 3 },
    now: () => now,
  });
  return { gateway, hookdeck, store, callbacks, deletedUrls, advance: (ms: number) => (now = new Date(now.getTime() + ms)) };
}

const secretOf = (gateway: FakeEventGateway, sourceId: string) => (gateway.sources.get(sourceId)!.config as { auth: { webhook_secret_key: string } }).auth.webhook_secret_key;

const subscription = (over: Partial<SubscriptionInput> = {}): SubscriptionInput => ({
  id: 'sub_1',
  principal: 'owner',
  name: 'resend.email.received',
  providerId: 'resend',
  arguments: {},
  url: 'https://receiver.example.com/a',
  secret: generateWebhookSecret(),
  previousSecret: null,
  previousSecretExpiresAt: null,
  delivery: healthyDelivery(),
  expiresAt: '2026-11-05T00:00:00.000Z',
  createdAt: '2026-10-05T16:00:00.000Z',
  updatedAt: '2026-10-05T16:00:00.000Z',
  ...over,
});

describe('CallbackRegistry: creating callbacks', () => {
  it("creates an MCP Events source and connection per callback on the agent's shared CLI destination", async () => {
    const { gateway, callbacks } = setup();
    const alice = await callbacks.create({ agent: 'laptop', name: 'email_alice' });
    const bob = await callbacks.create({ agent: 'laptop', name: 'email_bob' });

    expect(gateway.sources.get(alice.sourceId)).toMatchObject({ name: 'agent-laptop-email_alice', type: 'MCP_EVENTS' });
    expect(secretOf(gateway, alice.sourceId)).toMatch(/^whsec_/);
    expect(secretOf(gateway, alice.sourceId)).not.toBe(secretOf(gateway, bob.sourceId));
    expect([...gateway.destinations.values()]).toEqual([expect.objectContaining({ name: 'agent-laptop', type: 'CLI', config: { path: '/events' } })]);
    expect(alice).toMatchObject({ agent: 'laptop', name: 'email_alice', url: gateway.sources.get(alice.sourceId)!.url, path: '/events', destinationName: 'agent-laptop' });
    expect(await callbacks.create({ agent: 'laptop', name: 'email_alice' })).toEqual(alice); // idempotent
  });

  it("keeps one local port and path per agent: later URLs use them, and different ones are refused", async () => {
    const { gateway, callbacks } = setup();
    expect(await callbacks.create({ agent: 'laptop', name: 'a', path: '/hooks', port: 4100 })).toMatchObject({ path: '/hooks', port: 4100 });
    expect(await callbacks.create({ agent: 'laptop', name: 'b' })).toMatchObject({ path: '/hooks', port: 4100 });
    await expect(callbacks.create({ agent: 'laptop', name: 'c', path: '/other' })).rejects.toThrow(/receives on \/hooks/);
    await expect(callbacks.create({ agent: 'laptop', name: 'c', port: 4200 })).rejects.toThrow(/receives on port 4100/);
    expect([...gateway.destinations.values()].map((d) => d.config)).toEqual([{ path: '/hooks' }]);
    expect((await callbacks.create({ agent: 'desktop', name: 'a' })).port).toBe(3000); // the default
  });

  it('caps callbacks per agent, and refuses names that would make ambiguous resource names', async () => {
    const { callbacks } = setup();
    for (const name of ['a', 'b', 'c']) await callbacks.create({ agent: 'laptop', name });
    await expect(callbacks.create({ agent: 'laptop', name: 'd' })).rejects.toThrow(CallbackInputError);
    expect(() => callbacks.create({ agent: 'my-laptop', name: 'a' })).toThrow(CallbackInputError);
    expect(() => callbacks.create({ agent: 'laptop', name: 'a.b' })).toThrow(CallbackInputError);
    expect(() => callbacks.create({ agent: 'laptop', name: 'x', path: 'no-slash' })).toThrow(CallbackInputError);
  });

  it('reuses a source left from an earlier run, keeping its secret (an updated secret is slow to reach the edge)', async () => {
    const { gateway, hookdeck, callbacks } = setup();
    const leftover = await hookdeck.upsertSource({ name: 'agent-laptop-email', type: 'MCP_EVENTS', config: { auth: { webhook_secret_key: 'whsec_left' } } });
    const record = await callbacks.create({ agent: 'laptop', name: 'email' });
    expect(record.sourceId).toBe(leftover.id);
    expect(secretOf(gateway, leftover.id)).toBe('whsec_left');
    expect(await callbacks.signingSecret(record.url)).toBe('whsec_left');
  });

  it('finds callbacks again after a restart, ignoring other connections', async () => {
    const { gateway, hookdeck, store, callbacks } = setup();
    const record = await callbacks.create({ agent: 'laptop', name: 'email' });
    await hookdeck.upsertConnection({ name: 'other', description: '{"v":1,"kind":"something-else"}', source: { name: 'other' }, destination: { name: 'other', type: 'CLI', config: { path: '/' } } });
    await hookdeck.upsertConnection({ name: 'plain', source: { name: 'plain' }, destination: { name: 'plain', type: 'CLI', config: { path: '/' } } });

    const restarted = new CallbackRegistry({ hookdeck, inUse: () => false, subscription: (id) => store.get(id) });
    expect(await restarted.load()).toBe(1);
    expect(restarted.find(record.url)).toMatchObject({ agent: 'laptop', name: 'email', sourceId: record.sourceId, path: '/events', port: 3000 });
    expect(await restarted.signingSecret(record.url)).toBe(secretOf(gateway, record.sourceId));
  });

  it('plans the hookdeck listen processes: per agent and port, at most 10 sources each, and reports changes', async () => {
    const gateway = new FakeEventGateway();
    const callbacks = new CallbackRegistry({ hookdeck: new HookdeckClient({ apiKey: 'k', fetch: gateway.fetch }), inUse: () => true, subscription: () => undefined });
    let changes = 0;
    callbacks.onChange(() => changes++);
    for (let i = 0; i < 12; i++) await callbacks.create({ agent: 'laptop', name: `sub_${String(i).padStart(2, '0')}`, port: 4000 });
    await callbacks.create({ agent: 'desktop', name: 'email' });
    await callbacks.create({ agent: 'desktop', name: 'email' }); // existing: no change
    expect(changes).toBe(13);
    const plan = callbacks.listenPlan();
    expect(plan.map((p) => [p.agent, p.port, p.sources.length])).toEqual([['desktop', 3000, 1], ['laptop', 4000, 10], ['laptop', 4000, 2]]);
    expect(plan[1]!.sources[0]).toBe('agent-laptop-sub_00');
    expect(plan[2]!.sources).toEqual(['agent-laptop-sub_10', 'agent-laptop-sub_11']);
    expect(callbacks.agents()).toEqual(['desktop', 'laptop']);
  });

  it('drops a callback whose source was deleted outside the bridge, instead of failing every delivery', async () => {
    const { gateway, hookdeck, store, callbacks } = setup();
    const record = await callbacks.create({ agent: 'laptop', name: 'email' });
    const restarted = new CallbackRegistry({ hookdeck, inUse: () => false, subscription: (id) => store.get(id) });
    await restarted.load();
    gateway.sources.delete(record.sourceId);
    expect(await restarted.signingSecret(record.url)).toBeUndefined();
    expect(restarted.find(record.url)).toBeUndefined();
  });
});

describe('CallbackRegistry: deleting unused callbacks', () => {
  it('deletes a callback once no subscription has used it for the grace period, keeping the agent destination', async () => {
    const { gateway, store, callbacks, deletedUrls, advance } = setup();
    const record = await callbacks.create({ agent: 'laptop', name: 'email' });
    await store.put(subscription({ url: record.url }));
    expect(await callbacks.sweep()).toEqual([]);

    await store.delete('sub_1');
    expect(await callbacks.sweep()).toEqual([]); // grace starts
    advance(59 * 60 * 1000);
    expect(await callbacks.sweep()).toEqual([]);
    advance(60 * 1000);
    expect(await callbacks.sweep()).toEqual(['agent-laptop-email']);
    expect(gateway.sources.has(record.sourceId)).toBe(false);
    expect(gateway.connections.has(record.connectionId)).toBe(false);
    expect([...gateway.destinations.values()].map((d) => d.name)).toEqual(['agent-laptop']);
    expect(callbacks.find(record.url)).toBeUndefined();
    expect(deletedUrls).toEqual([record.url]);
  });

  it('keeps a callback that is subscribed again within the grace period (changing arguments: unsubscribe, then subscribe)', async () => {
    const { store, callbacks, advance } = setup();
    const record = await callbacks.create({ agent: 'laptop', name: 'email' });
    await callbacks.sweep(); // never subscribed yet: grace starts
    advance(30 * 60 * 1000);
    await store.put(subscription({ url: record.url }));
    await callbacks.sweep(); // in use: grace reset
    await store.delete('sub_1');
    await callbacks.sweep();
    advance(30 * 60 * 1000);
    await store.put(subscription({ id: 'sub_2', url: record.url }));
    expect(await callbacks.sweep()).toEqual([]);
    expect(callbacks.find(record.url)).toBeDefined();
  });

  it('hides a callback whose source delete failed, and finishes deleting it on a later sweep', async () => {
    const { gateway, callbacks } = setup({ graceMs: 0 });
    const record = await callbacks.create({ agent: 'laptop', name: 'email' });
    const realFetch = gateway.fetch;
    let failSource = true;
    (gateway as unknown as { fetch: typeof fetch }).fetch = (async (input: URL | string, init?: RequestInit) => {
      if (failSource && init?.method === 'DELETE' && String(input).includes('/sources/')) return new Response('{"message":"boom"}', { status: 400 });
      return realFetch(input, init);
    }) as typeof fetch;
    const flaky = new CallbackRegistry({
      hookdeck: new HookdeckClient({ apiKey: 'k', fetch: (i, o) => gateway.fetch(i, o) }),
      inUse: () => false,
      subscription: () => undefined,
      settings: { graceMs: 0 },
    });
    await flaky.load();
    expect(await flaky.sweep()).toEqual([]);
    expect(flaky.find(record.url)).toBeUndefined(); // connection gone: hidden from listen and signing
    expect(flaky.listenPlan()).toEqual([]);
    failSource = false;
    expect(await flaky.sweep()).toEqual(['agent-laptop-email']);
    expect(gateway.sources.has(record.sourceId)).toBe(false);
  });
});

describe('Signing for callback URLs', () => {
  it('produces two signatures on the challenge: the agent verifies one, the callback source the other', async () => {
    const agentSecret = generateWebhookSecret();
    const sourceSecret = generateWebhookSecret();
    let sent: { headers: Record<string, string>; body: string } | undefined;
    await verifyEndpoint(
      {
        assertPublicHost: async () => {},
        post: async (_url, body, headers) => {
          sent = { headers, body };
          return { status: 200, body: JSON.stringify({ challenge: (JSON.parse(body) as { challenge: string }).challenge }) };
        },
      },
      { url: new URL('https://hkdk.events/cb'), secret: agentSecret, extraSecrets: [sourceSecret], subscriptionId: 'sub_1', timeoutMs: 1000 },
    );
    const matches = matchSignatures([agentSecret, sourceSecret], sent!.headers as unknown as SignedHeaders, sent!.body);
    expect(matches.map((m) => m.secretIndex).sort()).toEqual([0, 1]);
  });

  it('always verifies a callback URL (no cache), and forgets cached verification for a deleted one', async () => {
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
    const params = (args: Record<string, unknown>) => ({ name: 'resend.email.received', arguments: args, delivery: { url: record.url, secret: agentSecret } });
    await service.subscribe('owner', params({}));
    await service.unsubscribe('owner', params({}));
    await service.unsubscribe('owner', params({ from: 'nobody@example.com' })); // matches nothing: harmless
    await service.subscribe('owner', params({ from: 'alice@example.com' }));
    expect(seen).toEqual([
      [agentSecret, await callbacks.signingSecret(record.url)],
      [agentSecret, await callbacks.signingSecret(record.url)],
    ]);
    expect(callbacks.find(record.url)).toBeDefined(); // unsubscribing doesn't delete the callback

    // A plain URL is cached; forgetting it makes the next subscribe verify again.
    const plain = { name: 'resend.email.received', delivery: { url: 'https://receiver.example.com/hook', secret: agentSecret } };
    await service.subscribe('owner', plain);
    await service.subscribe('owner', { ...plain, arguments: { from: 'x@example.com' } });
    expect(seen).toHaveLength(3);
    service.forgetVerification('https://receiver.example.com/hook');
    await service.subscribe('owner', { ...plain, arguments: { from: 'y@example.com' } });
    expect(seen).toHaveLength(4);
  });

  it('signs deliveries to a callback URL with both secrets, so the source and the agent can each verify', async () => {
    const { gateway, hookdeck, store, callbacks } = setup();
    const record = await callbacks.create({ agent: 'laptop', name: 'email' });
    const agentSecret = generateWebhookSecret();
    await store.put(subscription({ url: record.url, secret: agentSecret }));
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

describe('Paths under a tunnel URL (one base URL for every subscription, as Hermes builds them)', () => {
  it('treats a path under a tunnel URL as that tunnel: the challenge and deliveries carry the source secret', async () => {
    const { gateway, hookdeck, store, callbacks } = setup();
    const record = await callbacks.create({ agent: 'hermes', name: 'base', port: 9901, path: '/' });
    const subPath = `${record.url}/mcp/events/webhook/abc123`;
    expect(callbacks.find(subPath)).toBe(record);
    expect(callbacks.find(`${record.url}x/mcp/events/webhook/abc123`)).toBeUndefined(); // not a path under it
    const sourceSecret = await callbacks.signingSecret(record.url);
    expect(await callbacks.signingSecret(subPath)).toBe(sourceSecret);

    // Subscribe: the challenge is signed with the agent's secret and the source's.
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
    await service.subscribe('owner', { name: 'resend.email.received', delivery: { url: subPath, secret: agentSecret } });
    expect(seen).toEqual([[agentSecret, sourceSecret]]);

    // Deliveries too.
    const relay = new Relay({ signingSecret: 'hs', providerIds: ['resend'], catalog: new Catalog(config.providers), store, hookdeck, callbacks, now: () => new Date() });
    const fixture = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'fixtures', 'resend', 'email-received.json'), 'utf8')) as { headers: Record<string, string>; body: unknown };
    const raw = JSON.stringify(fixture.body);
    await relay.handle('/inbound/resend', { ...fixture.headers, 'x-hookdeck-signature': createHmac('sha256', 'hs').update(raw).digest('base64') }, raw);
    const published = gateway.published.at(-1)!;
    expect(matchSignatures([agentSecret, sourceSecret!], published.headers as unknown as SignedHeaders, published.body).map((m) => m.secretIndex).sort()).toEqual([0, 1]);
  });
});

describe('Retrying missed deliveries', () => {
  const AGENT_SECRET = generateWebhookSecret();
  const SOURCE_SECRET = generateWebhookSecret();
  const BODY = '{"eventId":"evt_1","name":"resend.email.received","data":{"subject":"hi"}}';

  type Req = {
    id: string;
    created_at?: string;
    verified?: boolean;
    retryOf?: string;
    resendId?: string;
    subscription?: string;
    events?: Array<{ id: string; status: string; response_status?: number | null; webhook_id?: string }>;
    ignored?: Array<string | { cause: string; webhook_id: string }>;
  };

  function retrySetup(requests: Req[], { pages = 1, subscriptions = ['sub_1'], url = 'https://hkdk.events/cb' }: { pages?: number; subscriptions?: string[]; url?: string } = {}) {
    const listed: string[] = [];
    const sent: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
    let description = '';
    const model = (r: Req) => ({
      id: r.id,
      verified: r.verified ?? true,
      created_at: r.created_at ?? '2026-10-07T11:00:00.000Z',
      ignored_count: (r.ignored ?? []).length,
      data: {
        headers: {
          'Webhook-Id': 'evt_1',
          'X-MCP-Subscription-Id': r.subscription ?? 'sub_1',
          ...(r.retryOf && { [RETRY_OF_HEADER]: r.retryOf }),
          ...(r.resendId && { [RESEND_ID_HEADER]: r.resendId }),
        },
        body: JSON.parse(BODY),
      },
    });
    const hookdeck = {
      listAllConnections: async () => [
        {
          id: 'web_cb',
          name: 'agent-laptop-email',
          description: JSON.stringify({ v: 1, kind: 'mcp-events-callback', agent: 'laptop', name: 'email', path: '/events', createdAt: '2026-10-07T10:00:00.000Z', checkedUntil: null }),
          source: { id: 'src_cb', name: 'agent-laptop-email', url: 'https://hkdk.events/cb' },
          destination: { id: 'des_cb', name: 'agent-laptop' },
        },
      ],
      listRequests: async (query: { created_at_gte?: string; next?: string; includeData?: boolean }) => {
        listed.push(`since ${query.created_at_gte}${query.next ? ` next ${query.next}` : ''}`);
        const page = query.next ? Number(query.next) : 0;
        const perPage = Math.ceil(requests.length / pages);
        const models = requests.slice(page * perPage, (page + 1) * perPage).map(model);
        return { models, pagination: page + 1 < pages ? { next: String(page + 1) } : {} };
      },
      // As the API does: filtered by connection.
      listEvents: async (query: { webhook_id: string }) => {
        listed.push(`events for ${query.webhook_id}`);
        return {
          models: requests
            .flatMap((r) => (r.events ?? []).map((e) => ({ request_id: r.id, webhook_id: 'web_cb', created_at: r.created_at ?? '2026-10-07T11:00:00.000Z', ...e })))
            .filter((e) => e.webhook_id === query.webhook_id),
        };
      },
      listIgnoredEventsForRequest: async (id: string) => ({
        models: (requests.find((r) => r.id === id)!.ignored ?? []).map((i) => (typeof i === 'string' ? { webhook_id: 'web_cb', cause: i } : i)),
      }),
      getSource: async () => ({ config: { auth: { webhook_secret_key: SOURCE_SECRET } } }),
      upsertConnection: async (input: { description: string }) => ((description = input.description), {}),
    } as unknown as CallbacksHookdeck;
    const store = new MemoryStore();
    for (const id of subscriptions) void store.put(subscription({ id, url, secret: AGENT_SECRET }));
    const callbacks = new CallbackRegistry({
      hookdeck,
      inUse: () => true,
      subscription: (id) => store.get(id),
      fetch: (async (url: string, init: RequestInit) => (sent.push({ url, headers: init.headers as Record<string, string>, body: String(init.body) }), new Response('', { status: 200 }))) as unknown as typeof fetch,
      now: () => new Date('2026-10-07T12:00:00.000Z'),
    });
    const checkedUntil = () => (description ? (JSON.parse(description) as { checkedUntil: string }).checkedUntil : null);
    return { callbacks, listed, sent, checkedUntil };
  }

  it('re-sends a missed delivery with the same webhook-id and a fresh signature both the agent and the source accept', async () => {
    const { callbacks, sent } = retrySetup([{ id: 'req_offline', ignored: ['CLI_DISCONNECTED'] }]);
    await callbacks.load();
    expect(await callbacks.retryMissed('laptop')).toEqual({ callbacks: 1, requestsChecked: 1, resent: 1, pending: 0, rejectedByAgent: 0, upToDate: false });
    const { url, headers, body } = sent[0]!;
    expect(url).toBe('https://hkdk.events/cb');
    expect(headers).toMatchObject({ 'webhook-id': 'evt_1', 'X-MCP-Subscription-Id': 'sub_1', [RETRY_OF_HEADER]: 'req_offline' });
    // A standard verifier, with its 5-minute timestamp tolerance, accepts the re-send for the agent's and the source's secret.
    expect(() => new Webhook(AGENT_SECRET).verify(body, headers)).not.toThrow();
    expect(() => new Webhook(SOURCE_SECRET).verify(body, headers)).not.toThrow();
  });

  it("re-sends to the subscription's own callback URL when it's a path under the tunnel URL", async () => {
    const { callbacks, sent } = retrySetup([{ id: 'req_offline', ignored: ['CLI_DISCONNECTED'] }], { url: 'https://hkdk.events/cb/mcp/events/webhook/abc123' });
    await callbacks.load();
    await callbacks.retryMissed('laptop');
    expect(sent.map((s) => s.url)).toEqual(['https://hkdk.events/cb/mcp/events/webhook/abc123']);
  });

  it("doesn't send an event again while its re-send may not be listed yet (two runs moments apart)", async () => {
    const { callbacks, sent } = retrySetup([{ id: 'req_offline', ignored: ['CLI_DISCONNECTED'] }]);
    await callbacks.load();
    expect(await callbacks.retryMissed('laptop')).toMatchObject({ resent: 1 });
    // The listing still shows only the missed original: the second run waits instead of sending it again.
    expect(await callbacks.retryMissed('laptop')).toMatchObject({ resent: 0, pending: 1, upToDate: false });
    expect(sent).toHaveLength(1);
  });

  it('sends again once the re-send is listed and was missed too (listen dropped again)', async () => {
    const requests: Req[] = [{ id: 'req_offline', ignored: ['CLI_DISCONNECTED'] }];
    const { callbacks, sent } = retrySetup(requests);
    await callbacks.load();
    await callbacks.retryMissed('laptop');
    const resendId = sent[0]!.headers[RESEND_ID_HEADER];
    expect(resendId).toBeTruthy();
    requests.push({ id: 'req_resend_1', created_at: '2026-10-07T11:30:00.000Z', retryOf: 'req_offline', resendId, ignored: ['CLI_DISCONNECTED'] });
    expect(await callbacks.retryMissed('laptop')).toMatchObject({ resent: 1 });
    expect(sent.map((s) => s.headers[RETRY_OF_HEADER])).toEqual(['req_offline', 'req_offline']);
  });

  it('retries an event the CLI never delivered, but not one the agent answered with an error', async () => {
    const { callbacks, sent } = retrySetup([
      { id: 'req_dropped', events: [{ id: 'evt_a', status: 'FAILED', response_status: null }] },
      { id: 'req_rejected', events: [{ id: 'evt_b', status: 'FAILED', response_status: 401 }] },
      { id: 'req_done', events: [{ id: 'evt_c', status: 'SUCCESSFUL' }] },
      { id: 'req_bad_signature', verified: false },
    ]);
    await callbacks.load();
    expect(await callbacks.retryMissed('laptop')).toMatchObject({ requestsChecked: 3, resent: 1, rejectedByAgent: 1 });
    expect(sent.map((s) => s.headers[RETRY_OF_HEADER])).toEqual(['req_dropped']);
  });

  it('judges an event by its latest attempt, so a delivered re-send is not sent again', async () => {
    const { callbacks, sent } = retrySetup([
      { id: 'req_original', created_at: '2026-10-07T11:00:00.000Z', ignored: ['CLI_DISCONNECTED'] },
      { id: 'req_resent', created_at: '2026-10-07T11:30:00.000Z', retryOf: 'req_original', events: [{ id: 'evt_ok', status: 'SUCCESSFUL' }] },
    ]);
    await callbacks.load();
    expect(await callbacks.retryMissed('laptop')).toMatchObject({ requestsChecked: 1, resent: 0, upToDate: true });
    expect(sent).toEqual([]);
  });

  it("treats a request Event Gateway hasn't processed yet, or an event in flight, as pending: the watermark stays", async () => {
    const { callbacks, checkedUntil } = retrySetup([
      { id: 'req_unprocessed' },
      { id: 'req_queued', events: [{ id: 'evt_q', status: 'QUEUED' }] },
    ]);
    await callbacks.load();
    expect(await callbacks.retryMissed('laptop')).toMatchObject({ pending: 2, upToDate: false });
    expect(checkedUntil()).toBeNull();
  });

  it("skips a missed delivery whose subscription has ended, and other connections' events", async () => {
    const { callbacks, sent } = retrySetup(
      [
        { id: 'req_ended', subscription: 'sub_gone', ignored: ['CLI_DISCONNECTED'] },
        { id: 'req_other', events: [{ id: 'evt_x', status: 'FAILED', webhook_id: 'web_other' }], ignored: [{ cause: 'CLI_DISCONNECTED', webhook_id: 'web_other' }] },
      ],
      { subscriptions: ['sub_1'] },
    );
    await callbacks.load();
    const report = await callbacks.retryMissed('laptop');
    expect(sent).toEqual([]);
    expect(report).toMatchObject({ resent: 0, pending: 1 }); // req_other: nothing for this connection yet
  });

  it('reads every page, and moves the watermark (with a margin) only after a clean run', async () => {
    const { callbacks, listed, checkedUntil } = retrySetup(
      [
        { id: 'req_1', events: [{ id: 'e1', status: 'SUCCESSFUL' }] },
        { id: 'req_2', events: [{ id: 'e2', status: 'SUCCESSFUL' }] },
        { id: 'req_3', ignored: ['FILTERED'] },
      ],
      { pages: 3 },
    );
    await callbacks.load();
    expect(await callbacks.retryMissed('laptop')).toMatchObject({ requestsChecked: 3, upToDate: true });
    expect(listed).toEqual(['since 2026-10-07T10:00:00.000Z', 'since 2026-10-07T10:00:00.000Z next 1', 'since 2026-10-07T10:00:00.000Z next 2', 'events for web_cb']);
    expect(checkedUntil()).toBe('2026-10-07T11:58:00.000Z');
  });
});
