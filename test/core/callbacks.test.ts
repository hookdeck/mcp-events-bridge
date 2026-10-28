import { describe, expect, it } from 'vitest';
import { CallbackInputError, CallbackRegistry, type CallbacksHookdeck } from '../../src/core/callbacks.js';
import { Catalog } from '../../src/core/catalog.js';
import { DEFAULT_SUBSCRIPTION_SETTINGS, defineConfig, resolveConfig } from '../../src/core/config.js';
import { HookdeckClient } from '../../src/core/hookdeck.js';
import { MemoryStore } from '../../src/core/memory-store.js';
import { generateWebhookSecret } from '../../src/core/secret.js';
import { healthyDelivery, type SubscriptionInput } from '../../src/core/store.js';
import { SubscriptionService } from '../../src/core/subscriptions.js';
import { resend } from '../../src/sources.js';
import { FakeEventGateway } from '../support/fake-event-gateway.js';

const config = resolveConfig(defineConfig({ deployment: 'dev', sources: [resend({ apiKey: 'x' })] }), { HOOKDECK_API_KEY: 'k', HOOKDECK_SIGNING_SECRET: 'hs' });
const SECRET = generateWebhookSecret();

function setup({ graceMs = 60 * 60 * 1000 } = {}) {
  const gateway = new FakeEventGateway();
  const hookdeck = new HookdeckClient({ apiKey: 'k', fetch: gateway.fetch });
  const store = new MemoryStore();
  let now = new Date('2026-10-07T12:00:00.000Z');
  const deletedUrls: string[] = [];
  const logs: string[] = [];
  const callbacks = new CallbackRegistry({
    hookdeck,
    inUse: (url) => store.list().some((s) => s.url === url),
    subscription: (id) => store.get(id),
    onDeleted: (url) => deletedUrls.push(url),
    settings: { graceMs, maxPerAgent: 3 },
    now: () => now,
    log: (m) => logs.push(m),
  });
  return { gateway, hookdeck, store, callbacks, deletedUrls, logs, advance: (ms: number) => (now = new Date(now.getTime() + ms)) };
}

const secretOf = (gateway: FakeEventGateway, sourceId: string) => (gateway.sources.get(sourceId)!.config as { auth?: { webhook_secret_key?: string } } | undefined)?.auth?.webhook_secret_key;

const subscription = (over: Partial<SubscriptionInput> = {}): SubscriptionInput => ({
  id: 'sub_1',
  principal: 'owner',
  name: 'resend.email.received',
  arguments: {},
  url: 'https://receiver.example.com/a',
  secret: SECRET,
  replay: null,
  delivery: healthyDelivery(),
  expiresAt: '2026-11-05T00:00:00.000Z',
  createdAt: '2026-10-05T16:00:00.000Z',
  updatedAt: '2026-10-05T16:00:00.000Z',
  ...over,
});

describe('CallbackRegistry: creating callback URLs', () => {
  it("with the client's secret: an MCP Events source holding it, and a connection to the agent's shared CLI destination", async () => {
    const { gateway, callbacks } = setup();
    const other = generateWebhookSecret();
    const alice = await callbacks.create({ agent: 'laptop', name: 'email_alice', secret: SECRET });
    const bob = await callbacks.create({ agent: 'laptop', name: 'email_bob', secret: other });

    expect(gateway.sources.get(alice.sourceId)).toMatchObject({ name: 'agent-laptop-email_alice', type: 'MCP_EVENTS' });
    expect(secretOf(gateway, alice.sourceId)).toBe(SECRET);
    expect(secretOf(gateway, bob.sourceId)).toBe(other);
    expect([...gateway.destinations.values()]).toEqual([expect.objectContaining({ name: 'agent-laptop', type: 'CLI', config: { path: '/events' } })]);
    expect(alice).toMatchObject({ agent: 'laptop', name: 'email_alice', url: gateway.sources.get(alice.sourceId)!.url, path: '/events', passThrough: false, destinationName: 'agent-laptop' });
    expect(await callbacks.create({ agent: 'laptop', name: 'email_alice', secret: SECRET })).toEqual(alice); // idempotent
  });

  it('refuses the same name with a different secret, or none: one URL holds one secret, so rotating means a new URL', async () => {
    const { callbacks } = setup();
    await callbacks.create({ agent: 'laptop', name: 'email', secret: SECRET });
    await expect(callbacks.create({ agent: 'laptop', name: 'email', secret: generateWebhookSecret() })).rejects.toThrow(/different secret.*new name/);
    await expect(callbacks.create({ agent: 'laptop', name: 'email' })).rejects.toThrow(CallbackInputError);
  });

  it('without a secret: a pass-through WEBHOOK source that verifies nothing, and a log line saying so', async () => {
    const { gateway, callbacks, logs } = setup();
    const record = await callbacks.create({ agent: 'hermes', name: 'base', port: 9901, path: '/' });
    expect(gateway.sources.get(record.sourceId)).toMatchObject({ name: 'agent-hermes-base', type: 'WEBHOOK' });
    expect(secretOf(gateway, record.sourceId)).toBeUndefined();
    expect(record).toMatchObject({ passThrough: true, port: 9901, path: '/' });
    expect(logs).toContain('created callback URL agent-hermes-base (pass-through: its receiver must verify every delivery)');
    expect(await callbacks.create({ agent: 'hermes', name: 'base' })).toEqual(record);
    await expect(callbacks.create({ agent: 'hermes', name: 'base', secret: SECRET })).rejects.toThrow(/without a secret/);
  });

  it('refuses a secret that is not a Standard Webhooks secret', () => {
    const { callbacks } = setup();
    expect(() => callbacks.create({ agent: 'laptop', name: 'a', secret: 'not-a-secret' })).toThrow(/whsec_/);
    expect(() => callbacks.create({ agent: 'laptop', name: 'a', secret: `whsec_${Buffer.alloc(16).toString('base64')}` })).toThrow(/24 to 64 bytes/);
  });

  it('keeps one local port and path per agent: later URLs use them, and different ones are refused', async () => {
    const { gateway, callbacks } = setup();
    expect(await callbacks.create({ agent: 'laptop', name: 'a', path: '/hooks', port: 4100 })).toMatchObject({ path: '/hooks', port: 4100 });
    expect(await callbacks.create({ agent: 'laptop', name: 'b' })).toMatchObject({ path: '/hooks', port: 4100 });
    await expect(callbacks.create({ agent: 'laptop', name: 'c', path: '/other' })).rejects.toThrow(/receives on \/hooks/);
    await expect(callbacks.create({ agent: 'laptop', name: 'c', port: 4200 })).rejects.toThrow(/receives on port 4100/);
    expect([...gateway.destinations.values()].map((d) => d.config)).toEqual([{ path: '/hooks' }]);
    expect((await callbacks.create({ agent: 'desktop', name: 'a' })).port).toBe(3000); // the default
  });

  it('caps callback URLs per agent, and refuses names that would make ambiguous resource names', async () => {
    const { callbacks } = setup();
    for (const name of ['a', 'b', 'c']) await callbacks.create({ agent: 'laptop', name });
    await expect(callbacks.create({ agent: 'laptop', name: 'd' })).rejects.toThrow(CallbackInputError);
    expect(() => callbacks.create({ agent: 'my-laptop', name: 'a' })).toThrow(CallbackInputError);
    expect(() => callbacks.create({ agent: 'laptop', name: 'a.b' })).toThrow(CallbackInputError);
    expect(() => callbacks.create({ agent: 'laptop', name: 'x', path: 'no-slash' })).toThrow(CallbackInputError);
  });

  it('reuses a source left from an earlier run with the same secret, and refuses one with another (an updated secret is slow to reach the edge)', async () => {
    const { hookdeck, callbacks } = setup();
    const leftover = await hookdeck.upsertSource({ name: 'agent-laptop-email', type: 'MCP_EVENTS', config: { auth: { webhook_secret_key: SECRET } } });
    expect((await callbacks.create({ agent: 'laptop', name: 'email', secret: SECRET })).sourceId).toBe(leftover.id);
    await hookdeck.upsertSource({ name: 'agent-laptop-other', type: 'MCP_EVENTS', config: { auth: { webhook_secret_key: generateWebhookSecret() } } });
    await expect(callbacks.create({ agent: 'laptop', name: 'other', secret: SECRET })).rejects.toThrow(/already has a source named agent-laptop-other/);
  });

  it('finds callback URLs again after a restart, ignoring other connections and leaving 0.7 ones for the migration', async () => {
    const { hookdeck, store, callbacks } = setup();
    const record = await callbacks.create({ agent: 'laptop', name: 'email', secret: SECRET });
    const passThrough = await callbacks.create({ agent: 'laptop', name: 'base' });
    await hookdeck.upsertConnection({ name: 'other', description: '{"v":1,"kind":"something-else"}', source: { name: 'other' }, destination: { name: 'other', type: 'CLI', config: { path: '/' } } });
    await hookdeck.upsertConnection({ name: 'plain', source: { name: 'plain' }, destination: { name: 'plain', type: 'CLI', config: { path: '/' } } });
    await hookdeck.upsertConnection({
      name: 'agent-laptop-old',
      description: JSON.stringify({ v: 1, kind: 'mcp-events-callback', agent: 'laptop', name: 'old', path: '/events', createdAt: '2026-10-01T00:00:00.000Z', checkedUntil: null }),
      source: { name: 'agent-laptop-old', type: 'MCP_EVENTS' },
      destination: { name: 'agent-laptop', type: 'CLI', config: { path: '/events' } },
    });

    const restarted = new CallbackRegistry({ hookdeck, inUse: () => false, subscription: (id) => store.get(id) });
    expect(await restarted.load()).toEqual({ loaded: 2, legacy: 1 });
    expect(restarted.find(record.url)).toMatchObject({ agent: 'laptop', name: 'email', sourceId: record.sourceId, path: '/events', port: 3000, passThrough: false });
    expect(restarted.find(passThrough.url)?.passThrough).toBe(true);
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

  it('treats a path under a callback URL as that callback URL (one base URL for every subscription, as Hermes builds them)', async () => {
    const { callbacks } = setup();
    const record = await callbacks.create({ agent: 'hermes', name: 'base', port: 9901, path: '/' });
    expect(callbacks.find(`${record.url}/mcp/events/webhook/abc123`)).toBe(record);
    expect(callbacks.find(`${record.url}x/mcp/events/webhook/abc123`)).toBeUndefined(); // not a path under it
  });
});

describe('CallbackRegistry: deleting unused callback URLs', () => {
  it('deletes a callback URL once no subscription has used it for the grace period, keeping the agent destination', async () => {
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

  it('keeps a callback URL that is subscribed again within the grace period (changing arguments: unsubscribe, then subscribe)', async () => {
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

  it('hides a callback URL whose source delete failed, and finishes deleting it on a later sweep', async () => {
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
    expect(flaky.find(record.url)).toBeUndefined(); // connection gone: hidden from listen and subscribe
    expect(flaky.listenPlan()).toEqual([]);
    failSource = false;
    expect(await flaky.sweep()).toEqual(['agent-laptop-email']);
    expect(gateway.sources.has(record.sourceId)).toBe(false);
  });

  it("doesn't recreate a callback's connection when a retry run finishes after the sweep deleted it", async () => {
    const { gateway, callbacks } = setup({ graceMs: 0 });
    await callbacks.create({ agent: 'laptop', name: 'email' });
    const realFetch = gateway.fetch;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    (gateway as unknown as { fetch: typeof fetch }).fetch = (async (input: URL | string, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      // The retry run's listings: held until the sweep is done, then empty (nothing missed).
      if (/\/(requests|events)$/.test(path)) {
        await gate;
        return new Response(JSON.stringify({ models: [], pagination: {} }), { status: 200 });
      }
      return realFetch(input, init);
    }) as typeof fetch;
    const registry = new CallbackRegistry({
      hookdeck: new HookdeckClient({ apiKey: 'k', fetch: (i, o) => gateway.fetch(i, o) }),
      inUse: () => false,
      subscription: () => undefined,
      settings: { graceMs: 0 },
    });
    await registry.load();
    const retry = registry.retryMissed('laptop');
    expect(await registry.sweep()).toEqual(['agent-laptop-email']);
    release();
    await retry;
    expect([...gateway.connections.values()].map((c) => c.name)).not.toContain('agent-laptop-email');
  });

  it('deletes, on load, a callback connection whose source was deleted (listed with no name), instead of listening for it', async () => {
    const { gateway, hookdeck, callbacks } = setup();
    const record = await callbacks.create({ agent: 'laptop', name: 'email' });
    const source = gateway.sources.get(record.sourceId)!;
    gateway.sources.set(record.sourceId, { ...source, name: null as unknown as string });
    const fresh = new CallbackRegistry({ hookdeck, inUse: () => false, subscription: () => undefined });
    expect(await fresh.load()).toEqual({ loaded: 0, legacy: 0 });
    expect(fresh.listenPlan()).toEqual([]);
    expect(gateway.connections.has(record.connectionId)).toBe(false);
  });
});

describe('Subscribing with a callback URL from the bridge', () => {
  const service = (store: MemoryStore, callbacks: CallbackRegistry, logs: string[] = []) => {
    const seen: string[][] = [];
    const subscriptions = new SubscriptionService({
      settings: DEFAULT_SUBSCRIPTION_SETTINGS,
      store,
      catalog: new Catalog(config.sources),
      transport: { assertPublicHost: async () => {}, post: async () => ({ status: 200, body: '' }) },
      verify: async (_t, options) => (seen.push([options.secret]), { ok: true }),
      callbacks,
      log: (m) => logs.push(m),
    });
    return { subscriptions, seen };
  };

  it("challenges a callback URL with a secret every time (no cache), signed with the subscriber's secret only, and forgets cached verification for a deleted one", async () => {
    const { store, callbacks } = setup();
    const record = await callbacks.create({ agent: 'laptop', name: 'email', secret: SECRET });
    const { subscriptions, seen } = service(store, callbacks);
    const params = (args: Record<string, unknown>) => ({ name: 'resend.email.received', arguments: args, delivery: { url: record.url, secret: SECRET } });
    await subscriptions.subscribe('owner', params({}));
    await subscriptions.unsubscribe('owner', params({}));
    await subscriptions.subscribe('owner', params({ from: 'alice@example.com' }));
    expect(seen).toEqual([[SECRET], [SECRET]]);
    expect(callbacks.find(record.url)).toBeDefined(); // unsubscribing doesn't delete the callback URL

    // A plain URL is cached; forgetting it makes the next subscribe verify again.
    const plain = { name: 'resend.email.received', delivery: { url: 'https://receiver.example.com/hook', secret: SECRET } };
    await subscriptions.subscribe('owner', plain);
    await subscriptions.subscribe('owner', { ...plain, arguments: { from: 'x@example.com' } });
    expect(seen).toHaveLength(3);
    subscriptions.forgetVerification('https://receiver.example.com/hook');
    await subscriptions.subscribe('owner', { ...plain, arguments: { from: 'y@example.com' } });
    expect(seen).toHaveLength(4);
  });

  it("doesn't challenge a pass-through callback URL or a path under it (the bridge created it for this agent), and warns that the receiver verifies", async () => {
    const { store, callbacks } = setup();
    const record = await callbacks.create({ agent: 'hermes', name: 'base', port: 9901, path: '/' });
    const logs: string[] = [];
    const { subscriptions, seen } = service(store, callbacks, logs);
    const result = await subscriptions.subscribe('owner', { name: 'resend.email.received', delivery: { url: `${record.url}/mcp/events/webhook/abc123`, secret: SECRET } });
    expect(result.id).toMatch(/^sub_/);
    expect(seen).toEqual([]);
    expect(logs.some((l) => l.startsWith('warning: base is a pass-through callback URL'))).toBe(true);
  });
});

describe('Retrying missed deliveries', () => {
  type Req = {
    id: string;
    created_at?: string;
    verified?: boolean;
    rejected?: boolean;
    webhookId?: string | null;
    subscription?: string | null;
    events?: Array<{ id: string; status: string; response_status?: number | null; webhook_id?: string }>;
    ignored?: Array<string | { cause: string; webhook_id: string }>;
  };

  function retrySetup(
    requests: Req[],
    { pages = 1, subscriptions = ['sub_1'], url = 'https://hkdk.events/cb', upstream = true }: { pages?: number; subscriptions?: string[]; url?: string; upstream?: boolean } = {},
  ) {
    const listed: string[] = [];
    const retried: string[] = [];
    let description = '';
    const model = (r: Req) => ({
      id: r.id,
      verified: r.verified ?? true,
      rejection_cause: r.rejected ? 'VERIFICATION_FAILED' : null,
      created_at: r.created_at ?? '2026-10-07T11:00:00.000Z',
      ignored_count: (r.ignored ?? []).length,
      data: {
        headers: {
          ...(r.webhookId !== null && { 'Webhook-Id': r.webhookId ?? 'evt_1' }),
          ...(r.subscription !== null && { 'X-MCP-Subscription-Id': r.subscription ?? 'sub_1' }),
        },
        body: {},
      },
    });
    const hookdeck = {
      listAllConnections: async () => [
        {
          id: 'web_cb',
          name: 'agent-laptop-email',
          description: JSON.stringify({ v: 2, kind: 'mcp-events-callback', agent: 'laptop', name: 'email', path: '/events', port: 3000, passThrough: true, createdAt: '2026-10-07T10:00:00.000Z', checkedUntil: null }),
          source: { id: 'src_cb', name: 'agent-laptop-email', url: 'https://hkdk.events/cb' },
          destination: { id: 'des_cb', name: 'agent-laptop' },
        },
      ],
      listRequests: async (query: { created_at_gte?: string; next?: string }) => {
        listed.push(`since ${query.created_at_gte}${query.next ? ` next ${query.next}` : ''}`);
        const page = query.next ? Number(query.next) : 0;
        const perPage = Math.ceil(requests.length / pages);
        const models = requests.slice(page * perPage, (page + 1) * perPage).map(model);
        return { models, pagination: page + 1 < pages ? { next: String(page + 1) } : {} };
      },
      // As the API does: filtered by connection, and by the delivered request's headers.
      listEvents: async (query: { webhook_id: string; headers?: Record<string, string> }) => {
        if (query.headers) {
          listed.push(`events for ${query.webhook_id} with webhook-id ${query.headers['webhook-id']}`);
          return { models: upstream ? [{ id: `evt_${query.webhook_id}_${query.headers['webhook-id']}`, status: 'SUCCESSFUL' }] : [] };
        }
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
      retryEvent: async (id: string) => (retried.push(id), {}),
      upsertConnection: async (input: { description: string }) => ((description = input.description), {}),
    } as unknown as CallbacksHookdeck;
    const store = new MemoryStore();
    for (const id of subscriptions) void store.put(subscription({ id, url }));
    let now = new Date('2026-10-07T12:00:00.000Z');
    const logs: string[] = [];
    const callbacks = new CallbackRegistry({ hookdeck, inUse: () => true, subscription: (id) => store.get(id), now: () => now, log: (m) => logs.push(m) });
    const checkedUntil = () => (description ? (JSON.parse(description) as { checkedUntil: string }).checkedUntil : null);
    return { callbacks, listed, retried, logs, checkedUntil, advance: (ms: number) => (now = new Date(now.getTime() + ms)) };
  }

  it("retries a missed delivery by retrying the subscription's own event, found by webhook-id on its connection, which Event Gateway signs afresh", async () => {
    const { callbacks, retried, listed } = retrySetup([{ id: 'req_offline', ignored: ['CLI_DISCONNECTED'] }]);
    await callbacks.load();
    expect(await callbacks.retryMissed('laptop')).toEqual({ callbacks: 1, deliveriesChecked: 1, retried: 1, pending: 0, rejectedByAgent: 0, upToDate: false });
    expect(listed).toContain('events for web_sub_1 with webhook-id evt_1');
    expect(retried).toEqual(['evt_web_sub_1_evt_1']);
  });

  it("works the same for a subscription on a path under the callback URL", async () => {
    const { callbacks, retried } = retrySetup([{ id: 'req_offline', ignored: ['CLI_DISCONNECTED'] }], { url: 'https://hkdk.events/cb/mcp/events/webhook/abc123' });
    await callbacks.load();
    await callbacks.retryMissed('laptop');
    expect(retried).toEqual(['evt_web_sub_1_evt_1']);
  });

  it("doesn't retry again while the retry may not be listed yet, and does once it has had time to arrive and was missed too", async () => {
    const { callbacks, retried, advance } = retrySetup([{ id: 'req_offline', ignored: ['CLI_DISCONNECTED'] }]);
    await callbacks.load();
    expect(await callbacks.retryMissed('laptop')).toMatchObject({ retried: 1 });
    // The listing still shows only the missed original: the next run waits instead of retrying again.
    expect(await callbacks.retryMissed('laptop')).toMatchObject({ retried: 0, pending: 1, upToDate: false });
    advance(3 * 60 * 1000 + 1);
    expect(await callbacks.retryMissed('laptop')).toMatchObject({ retried: 1 });
    expect(retried).toHaveLength(2);
  });

  it('judges a delivery by all its attempts: once a retry is delivered, it is done', async () => {
    const { callbacks, retried } = retrySetup([
      { id: 'req_original', created_at: '2026-10-07T11:00:00.000Z', ignored: ['CLI_DISCONNECTED'] },
      { id: 'req_retry', created_at: '2026-10-07T11:30:00.000Z', events: [{ id: 'evt_ok', status: 'SUCCESSFUL' }] },
    ]);
    await callbacks.load();
    expect(await callbacks.retryMissed('laptop')).toMatchObject({ deliveriesChecked: 1, retried: 0, upToDate: true });
    expect(retried).toEqual([]);
  });

  it('judges each subscription separately when two get the same event on one base URL', async () => {
    const { callbacks, retried } = retrySetup(
      [
        { id: 'req_a', subscription: 'sub_1', events: [{ id: 'evt_ok', status: 'SUCCESSFUL' }] },
        { id: 'req_b', subscription: 'sub_2', ignored: ['CLI_DISCONNECTED'] },
      ],
      { subscriptions: ['sub_1', 'sub_2'] },
    );
    await callbacks.load();
    expect(await callbacks.retryMissed('laptop')).toMatchObject({ deliveriesChecked: 2, retried: 1 });
    expect(retried).toEqual(['evt_web_sub_2_evt_1']);
  });

  it('retries a delivery the CLI never made, but not one the agent answered with an error, nor one the source rejected', async () => {
    const { callbacks, retried } = retrySetup([
      { id: 'req_dropped', webhookId: 'evt_a', events: [{ id: 'cb_a', status: 'FAILED', response_status: null }] },
      { id: 'req_rejected', webhookId: 'evt_b', events: [{ id: 'cb_b', status: 'FAILED', response_status: 401 }] },
      { id: 'req_done', webhookId: 'evt_c', events: [{ id: 'cb_c', status: 'SUCCESSFUL' }] },
      { id: 'req_bad_signature', webhookId: 'evt_d', verified: false, rejected: true },
    ]);
    await callbacks.load();
    expect(await callbacks.retryMissed('laptop')).toMatchObject({ deliveriesChecked: 3, retried: 1, rejectedByAgent: 1 });
    expect(retried).toEqual(['evt_web_sub_1_evt_a']);
  });

  it("treats a request Event Gateway hasn't processed yet, or an event in flight, as pending: the watermark stays", async () => {
    const { callbacks, checkedUntil } = retrySetup([
      { id: 'req_unprocessed', webhookId: 'evt_a' },
      { id: 'req_queued', webhookId: 'evt_b', events: [{ id: 'cb_q', status: 'QUEUED' }] },
    ]);
    await callbacks.load();
    expect(await callbacks.retryMissed('laptop')).toMatchObject({ pending: 2, upToDate: false });
    expect(checkedUntil()).toBeNull();
  });

  it('skips a missed delivery whose subscription has ended, and a request that is not a delivery (a stray post to a pass-through URL)', async () => {
    const { callbacks, retried } = retrySetup([
      { id: 'req_ended', subscription: 'sub_gone', ignored: ['CLI_DISCONNECTED'] },
      { id: 'req_stray', subscription: null, webhookId: null, ignored: ['CLI_DISCONNECTED'] },
    ]);
    await callbacks.load();
    expect(await callbacks.retryMissed('laptop')).toMatchObject({ deliveriesChecked: 1, retried: 0, upToDate: true });
    expect(retried).toEqual([]);
  });

  it("retries a missed delivery at a pass-through URL, whose requests are all unverified (it verifies nothing)", async () => {
    const { callbacks, retried } = retrySetup([{ id: 'req_offline', verified: false, ignored: ['CLI_DISCONNECTED'] }]);
    await callbacks.load();
    expect(await callbacks.retryMissed('laptop')).toMatchObject({ retried: 1 });
    expect(retried).toEqual(['evt_web_sub_1_evt_1']);
  });

  it("counts a missed delivery whose event isn't found yet as pending (Event Gateway's search can lag a new event)", async () => {
    const { callbacks, retried, checkedUntil } = retrySetup([{ id: 'req_offline', created_at: '2026-10-07T11:58:00.000Z', ignored: ['CLI_DISCONNECTED'] }], { upstream: false });
    await callbacks.load();
    expect(await callbacks.retryMissed('laptop')).toMatchObject({ retried: 0, pending: 1, upToDate: false });
    expect(retried).toEqual([]);
    expect(checkedUntil()).toBeNull();
  });

  it("logs a missed delivery whose event Event Gateway no longer has, and doesn't hold the watermark for it", async () => {
    const { callbacks, retried, logs } = retrySetup([{ id: 'req_offline', ignored: ['CLI_DISCONNECTED'] }], { upstream: false });
    await callbacks.load();
    expect(await callbacks.retryMissed('laptop')).toMatchObject({ retried: 0, upToDate: true });
    expect(retried).toEqual([]);
    expect(logs).toContain("can't retry evt_1 for sub_1: Event Gateway no longer has its event");
  });

  it('reads every page, and moves the watermark (with a margin) only after a clean run', async () => {
    const { callbacks, listed, checkedUntil } = retrySetup(
      [
        { id: 'req_1', webhookId: 'evt_1', events: [{ id: 'e1', status: 'SUCCESSFUL' }] },
        { id: 'req_2', webhookId: 'evt_2', events: [{ id: 'e2', status: 'SUCCESSFUL' }] },
        { id: 'req_3', webhookId: 'evt_3', ignored: ['FILTERED'] },
      ],
      { pages: 3 },
    );
    await callbacks.load();
    expect(await callbacks.retryMissed('laptop')).toMatchObject({ deliveriesChecked: 3, upToDate: true });
    expect(listed).toEqual(['since 2026-10-07T10:00:00.000Z', 'since 2026-10-07T10:00:00.000Z next 1', 'since 2026-10-07T10:00:00.000Z next 2', 'events for web_cb']);
    expect(checkedUntil()).toBe('2026-10-07T11:58:00.000Z');
  });
});
