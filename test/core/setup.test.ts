import { describe, expect, it } from 'vitest';
import { defineConfig, env, resolveConfig } from '../../src/core/config.js';
import { HookdeckClient } from '../../src/core/hookdeck.js';
import { runSetup } from '../../src/core/setup.js';
import { github, resend } from '../../src/providers.js';
import { FakeGithub } from '../support/fake-github.js';
import { FakeEventGateway } from '../support/fake-event-gateway.js';

const environment = { HOOKDECK_API_KEY: 'hk', HOOKDECK_SIGNING_SECRET: 'hs', RESEND_API_KEY: 're_1' };

function resendApi() {
  const calls: Array<{ url: string; body: unknown }> = [];
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: init.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify({ object: 'webhook', id: `wh_${calls.length}`, signing_secret: 'whsec_from_resend' }), { status: 201 });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

function setup(over: Record<string, unknown> = {}, env_: Record<string, string> = environment) {
  const gateway = new FakeEventGateway();
  const hookdeck = new HookdeckClient({ apiKey: 'hk', fetch: gateway.fetch });
  const config = resolveConfig(defineConfig({ deployment: 'dev', providers: [resend({ apiKey: env('RESEND_API_KEY') })], ...over }), env_);
  const resendFake = resendApi();
  return { gateway, run: () => runSetup({ config, hookdeck, fetch: resendFake.fetch }), resendFake };
}

describe('bridge setup', () => {
  it('creates the provider source, a CLI inbound connection, and registers the provider webhook', async () => {
    const { gateway, run, resendFake } = setup();
    const report = await run();
    const source = [...gateway.sources.values()].find((s) => s.name === 'bridge-resend')!;
    expect(source).toMatchObject({ type: 'RESEND', config: { auth: { webhook_secret_key: 'whsec_from_resend' } } });
    expect(JSON.parse(source.description!)).toEqual({ provider: 'resend', events: ['email.received'], webhookId: 'wh_1' });
    expect(resendFake.calls[0]).toEqual({ url: 'https://api.resend.com/webhooks', body: { endpoint: source.url, events: ['email.received'] } });

    const connection = [...gateway.connections.values()].find((c) => c.name === 'bridge-resend-dev')!;
    expect(gateway.destinations.get(connection.destinationId)).toMatchObject({ type: 'CLI', config: { path: '/inbound/resend' } });
    expect(connection.rules).toEqual([
      { type: 'deduplicate', include_fields: ['headers.svix-id'], window: 3_600_000 },
      expect.objectContaining({ type: 'retry', strategy: 'linear' }),
    ]);
    expect(report.providers).toEqual([{ id: 'resend', sourceUrl: source.url, connection: 'bridge-resend-dev', webhook: 'registered' }]);
  });

  it('is idempotent: a second run reuses the registered webhook and keeps the source secret', async () => {
    const { gateway, run, resendFake } = setup();
    await run();
    const second = await run();
    expect(resendFake.calls).toHaveLength(1);
    expect(second.providers[0]!.webhook).toBe('existing');
    expect([...gateway.sources.values()].find((s) => s.name === 'bridge-resend')!.config).toMatchObject({ auth: { webhook_secret_key: 'whsec_from_resend' } });
    expect([...gateway.connections.values()].filter((c) => c.name === 'bridge-resend-dev')).toHaveLength(1);
  });

  it('replaces the provider webhook if the source lost its signing secret', async () => {
    const { gateway, run, resendFake } = setup();
    await run();
    const source = [...gateway.sources.values()].find((s) => s.name === 'bridge-resend')!;
    source.config = {};
    const report = await run();
    expect(report.providers[0]!.webhook).toBe('registered');
    expect(resendFake.calls.map((c) => c.url)).toEqual(['https://api.resend.com/webhooks', 'https://api.resend.com/webhooks/wh_1', 'https://api.resend.com/webhooks']);
    expect(source.config).toMatchObject({ auth: { webhook_secret_key: 'whsec_from_resend' } });
    expect(source.type).toBe('RESEND');
  });

  it('updates GitHub webhooks in place when the repository list changes, keeping the source secret', async () => {
    const gateway = new FakeEventGateway();
    const hookdeck = new HookdeckClient({ apiKey: 'hk', fetch: gateway.fetch });
    const gh = new FakeGithub();
    const run = (repos: string[]) =>
      runSetup({
        config: resolveConfig(defineConfig({ deployment: 'dev', providers: [github({ token: 't', scope: { repos } })] }), environment),
        hookdeck,
        fetch: gh.fetch,
      });

    expect((await run(['o/one'])).providers[0]!.webhook).toBe('registered');
    const source = [...gateway.sources.values()].find((s) => s.name === 'bridge-github')!;
    const secret = (source.config as { auth: { webhook_secret_key: string } }).auth.webhook_secret_key;
    expect((await run(['O/One'])).providers[0]!.webhook).toBe('existing');

    expect((await run(['o/one', 'o/two'])).providers[0]!.webhook).toBe('updated');
    for (const path of ['/repos/o/one/hooks', '/repos/o/two/hooks']) {
      expect(gh.hooks.get(path)).toEqual([expect.objectContaining({ config: expect.objectContaining({ url: source.url, secret }) })]);
    }
    expect(source.config).toMatchObject({ auth: { webhook_secret_key: secret } });
    expect(gh.calls.filter((c) => c.startsWith('DELETE'))).toEqual([]);
  });

  it('uses an HTTP destination with Hookdeck signatures for http inbound', async () => {
    const { gateway, run } = setup({ inbound: 'http', publicUrl: 'https://bridge.example.com' });
    await run();
    const connection = [...gateway.connections.values()].find((c) => c.name === 'bridge-resend-dev')!;
    expect(gateway.destinations.get(connection.destinationId)).toMatchObject({
      type: 'HTTP',
      config: { url: 'https://bridge.example.com/inbound/resend', auth_type: 'HOOKDECK_SIGNATURE' },
    });
  });

  it('sets up issue notifications to the bridge and the three issue triggers', async () => {
    const { gateway, run } = setup();
    const report = await run();
    const notifications = [...gateway.connections.values()].find((c) => c.name === 'bridge-notifications-dev')!;
    expect(gateway.sources.get(notifications.sourceId)).toMatchObject({ name: 'bridge-hookdeck-notifications', type: 'WEBHOOK' });
    expect(gateway.destinations.get(notifications.destinationId)).toMatchObject({ config: { path: '/inbound/hookdeck' } });
    expect(gateway.webhookNotifications).toEqual({ enabled: true, topics: ['issue.opened', 'issue.updated'], source_id: notifications.sourceId });
    expect(report.triggers).toEqual(['bridge-delivery-dev', 'bridge-request-dev', 'bridge-backpressure-dev']);
    expect(gateway.issueTriggers.get('bridge-delivery-dev')).toMatchObject({ type: 'delivery', configs: { strategy: 'final_attempt', connections: 'mcp-sub-*' } });
  });

  it('generates an MCP secret when none is set, and uses the configured one otherwise', async () => {
    const generated = await setup().run();
    expect(generated.mcp.generated).toBe(true);
    expect(generated.mcp.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generated.mcp.url).toBe(`http://127.0.0.1:8080/mcp/${generated.mcp.secret}`);
    const configured = await setup({ inbound: 'http', publicUrl: 'https://bridge.example.com' }, { ...environment, BRIDGE_MCP_SECRET: 'abc' }).run();
    expect(configured.mcp).toEqual({ secret: 'abc', generated: false, url: 'https://bridge.example.com/mcp/abc' });
  });
});
