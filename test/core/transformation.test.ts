import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { Catalog } from '../../src/core/catalog.js';
import { defineConfig, resolveConfig, type ResolvedSource } from '../../src/core/config.js';
import { buildTransformation, functionSource } from '../../src/core/transformation.js';
import type { InboundRequest } from '../../src/core/sources/types.js';
import { github, resend, source } from '../../src/sources.js';

const base = { HOOKDECK_API_KEY: 'hk', HOOKDECK_SIGNING_SECRET: 'hs', FILLS_SECRET: 'fills-secret-0123456789' };
const fixture = (dir: string, name: string) =>
  JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'fixtures', dir, name), 'utf8')) as InboundRequest;

const resolved = () =>
  resolveConfig(
    defineConfig({
      deployment: 'dev',
      sources: [
        resend({ apiKey: 'x' }),
        github({ token: 't', scope: { repos: ['o/r'] }, events: ['issues', 'push'] }),
        source({
          type: 'webhook',
          id: 'fills',
          verification: { type: 'hmac', algorithm: 'sha256', encoding: 'hex', header: 'x-signature', secret: process.env.NEVER ?? 'fills-secret-0123456789' },
          events: { 'order.filled': {}, 'order.canceled': {} },
          eventType: { field: 'type' },
          eventId: { field: 'id' },
          fields: ['id', 'symbol', 'notes'],
          filters: ['symbol'],
        }),
        source({ type: 'webhook', id: 'nofields', verification: { type: 'standard-webhooks', secret: 'whsec_abc' }, events: ['ping'] }),
      ],
    }),
    base,
  );

const config = resolved();
const catalog = new Catalog(config.sources);
const sourceOf = (id: string) => config.sources.find((s) => s.id === id) as ResolvedSource;

/** Runs a transformation as Event Gateway would: a fresh context with only built-ins, no imports. */
function run(code: string, request: object, connection: Record<string, unknown> = { name: 'mcp-sub-sub_1', description: '{}' }) {
  let handler: ((req: unknown, ctx: unknown) => unknown) | undefined;
  vm.runInNewContext(code, { addHandler: (_type: string, fn: typeof handler) => (handler = fn), Buffer, TextEncoder });
  // Through JSON, as Event Gateway returns it, so the comparison isn't across realms.
  return JSON.parse(JSON.stringify(handler!(request, { connection }))) as {
    headers: Record<string, string>;
    body: { eventId?: string; name?: string; timestamp?: string; data?: unknown; cursor?: string | null };
    query: string;
  };
}

const decode = (cursor: string) => JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<string, unknown>;

describe('transformation: built from the source runtime, self-contained', () => {
  it('builds the Resend envelope exactly as the bridge maps it, with the headers the destination and filter use', () => {
    const req = fixture('resend', 'email-received.json');
    const out = run(buildTransformation(sourceOf('resend'), catalog), { ...req, path: '/', query: 'x=1', parsed_query: { x: '1' } }, {
      name: 'mcp-sub-sub_1',
      description: JSON.stringify({ v: 2, ca: 'abc123' }),
    });
    const runtime = catalog.get('resend.email.received')!.runtime;
    expect(out.headers).toEqual({ 'content-type': 'application/json', 'x-mcp-subscription-id': 'sub_1', 'webhook-id': 'msg_3KHbIt3gcFjtCyW4hdA6Ug4T61H' });
    expect(out.body).toMatchObject({ eventId: 'msg_3KHbIt3gcFjtCyW4hdA6Ug4T61H', name: 'resend.email.received', timestamp: runtime.occurredAt(req), data: runtime.summarize(req) });
    expect(out.query).toBe('');
    // Poll's cursor format: this event and the subscription's arguments hash, a minute back.
    const cursor = decode(out.body.cursor!);
    expect(cursor).toMatchObject({ v: 1, n: 'resend.email.received', a: 'abc123', ids: [] });
    expect(cursor.w).toBe(cursor.f);
    expect(Number(cursor.t) - Number(cursor.w)).toBe(60_000);
  });

  it('carries the replay\'s start while a replay runs, and no cursor without subscription metadata', () => {
    const req = fixture('resend', 'email-received.json');
    const code = buildTransformation(sourceOf('resend'), catalog);
    const during = run(code, req, { name: 'mcp-sub-sub_1', description: JSON.stringify({ v: 2, ca: 'a', rp: { f: 1000, w: 2000 } }) });
    expect(decode(during.body.cursor!)).toMatchObject({ v: 1, n: 'resend.email.received', a: 'a', f: 1000, w: 2000, ids: [] });
    expect(run(code, req, { name: 'mcp-sub-sub_1', description: 'not json' }).body.cursor).toBeNull();
    expect(run(code, req, { name: 'other-connection' }).headers['x-mcp-subscription-id']).toBe('');
  });

  it("marks what it can't deliver with x-mcp-skip, rather than throwing", () => {
    const resendCode = buildTransformation(sourceOf('resend'), catalog);
    const req = fixture('resend', 'email-received.json');
    expect(run(resendCode, { ...req, body: { type: 'email.sent' } })).toMatchObject({ headers: { 'x-mcp-skip': 'event type not enabled' }, body: {} });
    const { 'svix-id': _, ...noId } = req.headers;
    expect(run(resendCode, { ...req, headers: noId }).headers['x-mcp-skip']).toBe('could not build the event: Resend delivery has no svix-id header');

    const fills = buildTransformation(sourceOf('fills'), catalog);
    const fill = { type: 'order.filled', id: 'f_1', symbol: 'AAPL', notes: 'ok', extra: 1 };
    expect(run(fills, { headers: {}, body: fill })).toMatchObject({ headers: { 'webhook-id': 'f_1' }, body: { name: 'fills.order.filled', data: { id: 'f_1', symbol: 'AAPL', notes: 'ok' } } });
    expect(run(fills, { headers: {}, body: { ...fill, type: 'order.canceled' } }).body.name).toBe('fills.order.canceled');
    expect(run(fills, { headers: {}, body: { ...fill, id: 'f.1' } }).headers['x-mcp-skip']).toMatch(/period/);
    expect(run(fills, { headers: {}, body: { ...fill, notes: 'x'.repeat(300_000) } }).headers['x-mcp-skip']).toBe('envelope over 256 KiB');
  });

  it('maps GitHub events, offering only the enabled ones', () => {
    const code = buildTransformation(sourceOf('github'), catalog);
    const issues = fixture('github', 'issues-opened.json');
    expect(run(code, issues).body).toMatchObject({ name: 'github.issues', data: catalog.get('github.issues')!.runtime.summarize(issues) });
    expect(run(code, fixture('github', 'push.json')).body.name).toBe('github.push');
    expect(run(code, fixture('github', 'ping.json')).headers['x-mcp-skip']).toBe('event type not enabled');
    expect(run(code, fixture('github', 'workflow-run-completed.json')).headers['x-mcp-skip']).toBe('event type not enabled');
  });

  it("hashes a body for a webhook source's default event id the same way the bridge does", () => {
    const body = { b: 2, a: [1, { z: 'é' }] };
    const out = run(buildTransformation(sourceOf('nofields'), catalog), { headers: {}, body });
    expect(out.body.eventId).toBe(catalog.get('nofields.ping')!.runtime.eventId({ headers: {}, body }));
    expect(out.body.eventId).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('functionSource', () => {
  it('turns method shorthand into a function expression', () => {
    const obj = {
      summarize(x: number) {
        return x + 1;
      },
    };
    const fn = vm.runInNewContext(`(${functionSource(obj.summarize as never)})`) as (x: number) => number;
    expect(fn(1)).toBe(2);
    expect(functionSource(((x: number) => x) as never)).toMatch(/^\(x\) =>/);
  });
});
