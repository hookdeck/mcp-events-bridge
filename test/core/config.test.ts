import { describe, expect, it } from 'vitest';
import { ConfigError, defineConfig, env, resolveConfig } from '../../src/core/config.js';
import { resend } from '../../src/providers.js';

const base = { HOOKDECK_API_KEY: 'hk', HOOKDECK_SIGNING_SECRET: 'hs', RESEND_API_KEY: 're_1' };
const config = (over: Partial<Parameters<typeof defineConfig>[0]> = {}) =>
  defineConfig({ deployment: 'dev', providers: [resend({ apiKey: env('RESEND_API_KEY') })], ...over });

describe('resolveConfig', () => {
  it('resolves env() references and applies defaults', () => {
    const resolved = resolveConfig(config(), base);
    expect(resolved).toMatchObject({
      deployment: 'dev',
      inbound: 'cli',
      publicUrl: null,
      port: 8080,
      hookdeck: { apiKey: 'hk', signingSecret: 'hs' },
      auth: { mode: 'secret-url', mcpSecret: null },
    });
    expect(resolved.providers[0]).toMatchObject({ id: 'resend', events: ['email.received'], options: { apiKey: 're_1' } });
    expect(resolved.subscriptions.defaultTtlMs).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it('lists every missing variable at once', () => {
    expect(() => resolveConfig(config(), {})).toThrow(/HOOKDECK_API_KEY, HOOKDECK_SIGNING_SECRET, RESEND_API_KEY/);
  });

  it('uses http inbound and the fly.dev URL on Fly.io', () => {
    const resolved = resolveConfig(config(), { ...base, FLY_APP_NAME: 'my-bridge' });
    expect(resolved.inbound).toBe('http');
    expect(resolved.publicUrl).toBe('https://my-bridge.fly.dev');
  });

  it('requires an https URL for http inbound', () => {
    expect(() => resolveConfig(config({ inbound: 'http' }), base)).toThrow(ConfigError);
    expect(resolveConfig(config({ inbound: 'http', publicUrl: 'https://bridge.example.com/' }), base).publicUrl).toBe('https://bridge.example.com');
  });

  it('rejects duplicate instance ids and unknown events', () => {
    expect(() => resolveConfig(config({ providers: [resend({ apiKey: 'a' }), resend({ apiKey: 'b' })] }), base)).toThrow(/give one an explicit id/);
    expect(() => resend({ apiKey: 'a', events: ['email.sent'] })).toThrow(/unknown event/);
  });

  it('rejects provider ids the inbound route can\'t serve, and empty Hookdeck credentials', () => {
    for (const id of ['resend.main', 'hookdeck', '']) {
      expect(() => resolveConfig(config({ providers: [resend({ id, apiKey: 'a' })] }), base)).toThrow(/Provider id/);
    }
    expect(() => resolveConfig(config({ hookdeck: { signingSecret: '' } }), base)).toThrow(/must not be empty/);
  });

  it('reads BRIDGE_MCP_SECRET when set', () => {
    expect(resolveConfig(config(), { ...base, BRIDGE_MCP_SECRET: 's3cret' }).auth.mcpSecret).toBe('s3cret');
  });
});
