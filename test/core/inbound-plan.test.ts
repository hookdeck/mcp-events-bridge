import { describe, expect, it } from 'vitest';
import { defineConfig, env, resolveConfig, type BridgeConfig } from '../../src/core/config.js';
import { HookdeckClient } from '../../src/core/hookdeck.js';
import { checkInbound, inboundConnections, listenArgs } from '../../src/core/inbound-plan.js';
import { runSetup } from '../../src/core/setup.js';
import { resend } from '../../src/sources.js';
import { FakeEventGateway } from '../support/fake-event-gateway.js';

const environment = { HOOKDECK_API_KEY: 'hk', HOOKDECK_SIGNING_SECRET: 'hs', RESEND_API_KEY: 're_1' };
const resendApi = (async () =>
  new Response(JSON.stringify({ id: 'wh_1', signing_secret: 'whsec_x' }), { status: 201 })) as unknown as typeof fetch;

function setup(over: Partial<BridgeConfig> = {}) {
  const gateway = new FakeEventGateway();
  const hookdeck = new HookdeckClient({ apiKey: 'hk', fetch: gateway.fetch });
  const config = resolveConfig(defineConfig({ deployment: 'dev', sources: [resend({ apiKey: env('RESEND_API_KEY') })], ...over }), environment);
  return { gateway, hookdeck, config, runSetup: () => runSetup({ config, hookdeck, fetch: resendApi }) };
}

describe('inbound plan', () => {
  it("lists only the notifications connection: events go from each source straight to subscribers", () => {
    const { config } = setup({ sources: [resend({ apiKey: 'a' }), resend({ id: 'resend-support', apiKey: 'b' })] });
    expect(inboundConnections(config)).toEqual([
      { source: 'bridge-hookdeck-notifications', connection: 'bridge-notifications-dev', path: '/inbound/hookdeck' },
    ]);
  });

  it('builds the hookdeck listen for the notifications source', () => {
    const { config } = setup({ sources: [resend({ apiKey: 'a' }), resend({ id: 'resend-support', apiKey: 'b' })] });
    expect(listenArgs(config, 8080, '.hookdeck/config.toml')).toEqual([
      'listen', '8080', 'bridge-hookdeck-notifications',
      '--output', 'compact', '--device-name', 'bridge-dev', '--hookdeck-config', '.hookdeck/config.toml',
    ]);
  });

  it('reports every missing source and connection before setup has run', async () => {
    const { hookdeck, config } = setup();
    expect(await checkInbound(config, hookdeck)).toEqual(['source bridge-resend not found', 'connection bridge-notifications-dev not found']);
  });

  it('is ready after setup', async () => {
    const { hookdeck, config, runSetup } = setup();
    await runSetup();
    expect(await checkInbound(config, hookdeck)).toEqual([]);
  });

  it('catches a source added to the config but not set up', async () => {
    const { hookdeck, runSetup } = setup();
    await runSetup();
    const grown = resolveConfig(defineConfig({ deployment: 'dev', sources: [resend({ apiKey: 'a' }), resend({ id: 'resend-support', apiKey: 'b' })] }), environment);
    expect(await checkInbound(grown, hookdeck)).toEqual(['source bridge-resend-support not found']);
  });

  it('catches an HTTP-inbound setup run with a CLI-inbound config', async () => {
    const { hookdeck, runSetup } = setup({ inbound: 'http', publicUrl: 'https://bridge.example.com' });
    await runSetup();
    const cli = resolveConfig(defineConfig({ deployment: 'dev', sources: [resend({ apiKey: 'a' })] }), environment);
    expect(await checkInbound(cli, hookdeck)).toEqual(['bridge-notifications-dev has a HTTP destination, expected CLI']);
  });
});
