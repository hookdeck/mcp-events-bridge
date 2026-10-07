import { describe, expect, it } from 'vitest';
import { Catalog } from '../../src/core/catalog.js';
import { defineConfig, env, resolveConfig } from '../../src/core/config.js';
import { github, resend, webhook } from '../../src/providers.js';

const environment = { HOOKDECK_API_KEY: 'k', HOOKDECK_SIGNING_SECRET: 's', A_SECRET: 'a', B_SECRET: 'b' };
const trading = (id: string, secret: string) =>
  webhook({ id, verification: { type: 'hmac', algorithm: 'sha256', encoding: 'hex', header: 'x-signature', secret: env(secret) }, events: ['order.filled'] });

describe('Catalog', () => {
  it('names each event {instance id}.{provider event name}', () => {
    const config = resolveConfig(
      defineConfig({ providers: [resend({ apiKey: 'x' }), github({ webhookSecret: 'a-long-enough-secret', events: ['issues', 'push'] })] }),
      environment,
    );
    expect(new Catalog(config.providers).list().map((e) => e.name)).toEqual(['resend.email.received', 'github.issues', 'github.push']);
  });

  it('lets two instances offer the same event: the instance id tells them apart', () => {
    const config = resolveConfig(defineConfig({ providers: [trading('broker_a', 'A_SECRET'), trading('broker_b', 'B_SECRET')] }), environment);
    const catalog = new Catalog(config.providers);
    expect(catalog.list().map((e) => e.name)).toEqual(['broker_a.order.filled', 'broker_b.order.filled']);
    expect(catalog.get('broker_b.order.filled')).toMatchObject({ providerId: 'broker_b', event: { name: 'order.filled' } });
    expect(catalog.forProvider('broker_a').map((e) => e.name)).toEqual(['broker_a.order.filled']);
  });
});
