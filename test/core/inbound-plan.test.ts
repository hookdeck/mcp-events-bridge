import { describe, expect, it } from 'vitest';
import { defineConfig, env, resolveConfig, type BridgeConfig } from '../../src/core/config.js';
import { HookdeckClient } from '../../src/core/hookdeck.js';
import { checkInbound, inboundConnections, listenArgs } from '../../src/core/inbound-plan.js';
import { runSetup } from '../../src/core/setup.js';
import { resend } from '../../src/providers.js';
import { FakeEventGateway } from '../support/fake-event-gateway.js';

const environment = { HOOKDECK_API_KEY: 'hk', HOOKDECK_SIGNING_SECRET: 'hs', RESEND_API_KEY: 're_1' };
const resendApi = (async () =>
  new Response(JSON.stringify({ id: 'wh_1', signing_secret: 'whsec_x' }), { status: 201 })) as unknown as typeof fetch;

function setup(over: Partial<BridgeConfig> = {}) {
  const gateway = new FakeEventGateway();
  const hookdeck = new HookdeckClient({ apiKey: 'hk', fetch: gateway.fetch });
  const config = resolveConfig(defineConfig({ deployment: 'dev', providers: [resend({ apiKey: env('RESEND_API_KEY') })], ...over }), environment);
  return { gateway, hookdeck, config, runSetup: () => runSetup({ config, hookdeck, fetch: resendApi }) };
}

describe('inbound plan', () => {
  it('lists one connection per provider instance plus notifications', () => {
    const { config } = setup({ providers: [resend({ apiKey: 'a' }), resend({ id: 'resend-support', apiKey: 'b' })] });
    expect(inboundConnections(config)).toEqual([
      { source: 'bridge-resend', connection: 'bridge-resend-dev', path: '/inbound/resend' },
      { source: 'bridge-resend-support', connection: 'bridge-resend-support-dev', path: '/inbound/resend-support' },
      { source: 'bridge-hookdeck-notifications', connection: 'bridge-notifications-dev', path: '/inbound/hookdeck' },
    ]);
  });

  it('builds one hookdeck listen for every source in the config', () => {
    const { config } = setup({ providers: [resend({ apiKey: 'a' }), resend({ id: 'resend-support', apiKey: 'b' })] });
    expect(listenArgs(config, 8080, '.hookdeck/config.toml')).toEqual([
      'listen', '8080', 'bridge-resend,bridge-resend-support,bridge-hookdeck-notifications',
      '--output', 'compact', '--device-name', 'bridge-dev', '--hookdeck-config', '.hookdeck/config.toml',
    ]);
  });

  it('reports every missing connection before setup has run', async () => {
    const { hookdeck, config } = setup();
    expect(await checkInbound(config, hookdeck)).toEqual(['connection bridge-resend-dev not found', 'connection bridge-notifications-dev not found']);
  });

  it('is ready after setup', async () => {
    const { hookdeck, config, runSetup } = setup();
    await runSetup();
    expect(await checkInbound(config, hookdeck)).toEqual([]);
  });

  it('catches a provider added to the config but not set up', async () => {
    const { hookdeck, runSetup } = setup();
    await runSetup();
    const grown = resolveConfig(defineConfig({ deployment: 'dev', providers: [resend({ apiKey: 'a' }), resend({ id: 'resend-support', apiKey: 'b' })] }), environment);
    expect(await checkInbound(grown, hookdeck)).toEqual(['connection bridge-resend-support-dev not found']);
  });

  it('catches an HTTP-inbound setup run with a CLI-inbound config', async () => {
    const { hookdeck, runSetup } = setup({ inbound: 'http', publicUrl: 'https://bridge.example.com' });
    await runSetup();
    const cli = resolveConfig(defineConfig({ deployment: 'dev', providers: [resend({ apiKey: 'a' })] }), environment);
    expect(await checkInbound(cli, hookdeck)).toEqual([
      'bridge-resend-dev has a HTTP destination, expected CLI',
      'bridge-notifications-dev has a HTTP destination, expected CLI',
    ]);
  });
});
