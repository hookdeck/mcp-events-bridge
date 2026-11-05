import { describe, expect, it } from 'vitest';
import { argumentsError, Catalog, describeFilters, descriptionWarnings } from '../../src/core/catalog.js';
import { defineConfig, env, resolveConfig } from '../../src/core/config.js';
import { github, resend, source } from '../../src/sources.js';

const environment = { HOOKDECK_API_KEY: 'k', HOOKDECK_SIGNING_SECRET: 's', A_SECRET: 'a', B_SECRET: 'b' };
const trading = (id: string, secret: string) =>
  source({ type: 'webhook',  id, verification: { type: 'hmac', algorithm: 'sha256', encoding: 'hex', header: 'x-signature', secret: env(secret) }, events: ['order.filled'] });

describe('Catalog', () => {
  it('names each event {instance id}.{provider event name}', () => {
    const config = resolveConfig(
      defineConfig({ sources: [resend({ apiKey: 'x' }), github({ webhookSecret: 'a-long-enough-secret', events: ['issues', 'push'] })] }),
      environment,
    );
    expect(new Catalog(config.sources).list().map((e) => e.name)).toEqual(['resend.email.received', 'github.issues', 'github.push']);
  });

  it('lets two instances offer the same event: the instance id tells them apart', () => {
    const config = resolveConfig(defineConfig({ sources: [trading('broker_a', 'A_SECRET'), trading('broker_b', 'B_SECRET')] }), environment);
    const catalog = new Catalog(config.sources);
    expect(catalog.list().map((e) => e.name)).toEqual(['broker_a.order.filled', 'broker_b.order.filled']);
    expect(catalog.get('broker_b.order.filled')).toMatchObject({ providerId: 'broker_b', event: { name: 'order.filled' } });
    expect(catalog.forProvider('broker_a').map((e) => e.name)).toEqual(['broker_a.order.filled']);
  });

  it('warns about descriptions over 400 characters, which ChatGPT has been reported to leave out', () => {
    const verification = { type: 'hmac', algorithm: 'sha256', encoding: 'hex', header: 'x-signature', secret: env('A_SECRET') } as const;
    const config = resolveConfig(
      defineConfig({
        sources: [
          resend({ apiKey: 'x' }),
          github({ webhookSecret: 'a-long-enough-secret' }),
          source({ type: 'webhook',  id: 'fills', verification, eventType: { header: 'x-event' }, events: { 'order.filled': { description: 'An order filled. '.repeat(25) }, 'order.placed': {} } }),
        ],
      }),
      environment,
    );
    const warnings = descriptionWarnings(new Catalog(config.sources));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^fills\.order\.filled's description is \d+ characters\. ChatGPT has been reported/);
  });
});

describe("an event's filters, for clients with tools only", () => {
  const config = resolveConfig(
    defineConfig({
      sources: [
        github({ webhookSecret: 'a-long-enough-secret', events: ['issues'] }),
        source({ type: 'webhook', id: 'fills', verification: { type: 'hmac', algorithm: 'sha256', encoding: 'hex', header: 'x-signature', secret: env('A_SECRET') }, events: ['order.filled'], filters: ['symbol'] }),
      ],
    }),
    environment,
  );
  const catalog = new Catalog(config.sources);
  const issues = catalog.get('github.issues')!;
  const refusal = (args: unknown) => {
    try {
      issues.event.parseArguments(args);
    } catch (error) {
      return error;
    }
    throw new Error('parseArguments accepted the arguments');
  };

  it("describes each argument in the event's inputSchema: its type, in TypeScript's notation, and description", () => {
    expect(describeFilters(issues.event.inputSchema)).toEqual({
      repository: { type: 'string', description: 'Only events for this repository (owner/name).' },
      actions: { type: 'string[]', description: 'Only these actions, for example ["opened", "reopened"].' },
      sender: { type: 'string', description: 'Only events caused by this GitHub user (login).' },
    });
    expect(describeFilters(catalog.get('fills.order.filled')!.event.inputSchema)).toEqual({
      symbol: { type: 'string | number | boolean', description: 'Only events whose symbol equals this value.' },
    });
    expect(describeFilters({ type: 'object', properties: { n: { type: 'integer' } }, required: ['n'] })).toEqual({ n: { type: 'integer', required: true } });
  });

  // Seen on 5 Nov: Claude Code guessed `action` for github.issues, and the error didn't say which field was wrong.
  it('names an unknown argument, which parseArguments refuses, and lists the arguments the event takes', () => {
    expect(argumentsError('github.issues', issues.event, refusal({ action: 'opened', repository: 'hookdeck/mcp-events-bridge' }))).toMatchObject({
      code: -32602,
      message: 'arguments do not match the inputSchema',
      data: { detail: 'unknown argument "action". github.issues takes repository (string), actions (string[]), sender (string)' },
    });
  });

  it('names an argument of the wrong type, and passes on any other error', () => {
    expect((argumentsError('github.issues', issues.event, refusal({ actions: 'opened' })).data as { detail: string }).detail).toBe(
      'actions: Invalid input: expected array, received string. github.issues takes repository (string), actions (string[]), sender (string)',
    );
    expect((argumentsError('x.y', { inputSchema: { type: 'object', properties: {} } }, new Error('no good')).data as { detail: string }).detail).toBe('no good. x.y takes no arguments');
  });
});
