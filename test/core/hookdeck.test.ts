import { describe, expect, it } from 'vitest';
import { HookdeckApiError, HookdeckClient, SUBSCRIPTION_RETRY_RULE, isSettled } from '../../src/core/hookdeck.js';

interface Call {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

/** A fetch that records calls and answers from a queue of [status, body] pairs. */
function fakeFetch(responses: Array<[number, unknown]>) {
  const calls: Call[] = [];
  const fetch = (async (input: URL | string, init?: RequestInit) => {
    calls.push({
      url: new URL(String(input)),
      method: init?.method ?? 'GET',
      headers: init?.headers as Record<string, string>,
      body: init?.body as string | undefined,
    });
    const [status, body] = responses.shift() ?? [200, {}];
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const client = (responses: Array<[number, unknown]>) => {
  const fake = fakeFetch(responses);
  return { ...fake, hookdeck: new HookdeckClient({ apiKey: 'test-key', fetch: fake.fetch, retryDelaysMs: [1, 1] }) };
};

describe('HookdeckClient', () => {
  it('sends the API key and uses the versioned API base', async () => {
    const { hookdeck, calls } = client([[200, { id: 'evt_1', status: 'SUCCESSFUL' }]]);
    await hookdeck.getEvent('evt_1');
    expect(calls[0]!.url.href).toBe('https://api.hookdeck.com/2026-09-01/events/evt_1');
    expect(calls[0]!.headers.Authorization).toBe('Bearer test-key');
  });

  it('encodes the bracketed date filter when listing requests', async () => {
    const { hookdeck, calls } = client([[200, { models: [] }]]);
    await hookdeck.listRequests({ source_id: 'src_1', created_at_gte: '2026-10-05T00:00:00Z' });
    const params = calls[0]!.url.searchParams;
    expect(params.get('source_id')).toBe('src_1');
    expect(params.get('created_at[gte]')).toBe('2026-10-05T00:00:00Z');
    expect(params.get('order_by')).toBe('created_at');
  });

  it('lists a request\'s events through the nested path, not /events?request_id=', async () => {
    const { hookdeck, calls } = client([[200, { models: [] }], [200, { models: [] }]]);
    await hookdeck.listEventsForRequest('req_1');
    await hookdeck.listIgnoredEventsForRequest('req_1');
    expect(calls.map((c) => c.url.pathname)).toEqual(['/2026-09-01/requests/req_1/events', '/2026-09-01/requests/req_1/ignored_events']);
  });

  it('limits a request retry to connections with webhook_ids', async () => {
    const { hookdeck, calls } = client([[200, {}], [200, {}]]);
    await hookdeck.retryRequest('req_1', ['web_1']);
    await hookdeck.retryRequest('req_2');
    expect(JSON.parse(calls[0]!.body!)).toEqual({ webhook_ids: ['web_1'] });
    expect(JSON.parse(calls[1]!.body!)).toEqual({});
  });

  it('backs off on 429 and then succeeds', async () => {
    const { hookdeck, calls } = client([[429, 'slow down'], [200, { id: 'evt_1', status: 'QUEUED' }]]);
    await expect(hookdeck.getEvent('evt_1')).resolves.toMatchObject({ id: 'evt_1' });
    expect(calls).toHaveLength(2);
  });

  it('retries idempotent calls on server errors, but not publishes', async () => {
    const upsert = client([[500, '{"code":"FATAL_ERROR"}'], [200, { id: 'web_1' }]]);
    await expect(upsert.hookdeck.upsertConnection({ name: 'c', source: { name: 's' }, destination: { name: 'd' } })).resolves.toMatchObject({ id: 'web_1' });
    expect(upsert.calls).toHaveLength(2);
    const publish = client([[503, 'unavailable'], [200, {}]]);
    await expect(publish.hookdeck.publish('src', {}, '{}')).rejects.toMatchObject({ status: 503 });
    expect(publish.calls).toHaveLength(1);
  });

  it('throws HookdeckApiError with the status once retries run out or on other errors', async () => {
    const limited = client([[429, ''], [429, ''], [429, 'still limited']]);
    await expect(limited.hookdeck.getEvent('evt_1')).rejects.toMatchObject({ status: 429 });
    const missing = client([[404, '{"message":"not found"}']]);
    await expect(missing.hookdeck.getEvent('evt_x')).rejects.toBeInstanceOf(HookdeckApiError);
  });

  it('upserts connections with PUT and the given rules', async () => {
    const { hookdeck, calls } = client([[200, { id: 'web_1', name: 'mcp-sub-email.received-sub_1' }]]);
    await hookdeck.upsertConnection({
      name: 'mcp-sub-email.received-sub_1',
      source: { name: 'bridge-out-email.received', type: 'PUBLISH_API' },
      destination: { name: 'mcp-sub-email.received-sub_1', type: 'HTTP', config: { url: 'https://receiver.example.com/hook' } },
      rules: [{ type: 'filter', headers: { 'x-mcp-subscription-id': 'sub_1' } }, SUBSCRIPTION_RETRY_RULE],
    });
    expect(calls[0]!.method).toBe('PUT');
    expect(calls[0]!.url.pathname).toBe('/2026-09-01/connections');
    expect(JSON.parse(calls[0]!.body!).rules[1].response_status_codes).toEqual(['>=300', '!410', '!413']);
  });

  it('publishes through the Publish API with the source name, passing headers and body through', async () => {
    const { hookdeck, calls } = client([[200, { status: 'SUCCESS', request_id: 'req_9' }]]);
    const result = await hookdeck.publish('bridge-out-email.received', { 'webhook-id': 'msg_1', 'content-type': 'application/json' }, '{"a":1}');
    expect(result).toEqual({ requestId: 'req_9' });
    expect(calls[0]!.url.href).toBe('https://hkdk.events/v1/publish');
    expect(calls[0]!.headers).toMatchObject({
      'webhook-id': 'msg_1',
      'X-Hookdeck-Source-Name': 'bridge-out-email.received',
      Authorization: 'Bearer test-key',
    });
    expect(calls[0]!.body).toBe('{"a":1}');
  });

  it('throws when a publish fails, so the relay can return 5xx', async () => {
    const { hookdeck } = client([[503, 'unavailable']]);
    await expect(hookdeck.publish('bridge-out-email.received', {}, '{}')).rejects.toMatchObject({ status: 503 });
  });

  it('resolves issues and upserts issue triggers by name', async () => {
    const { hookdeck, calls } = client([[200, { id: 'iss_1', status: 'RESOLVED' }], [200, { id: 'it_1', name: 'bridge-delivery' }]]);
    await hookdeck.updateIssueStatus('iss_1', 'RESOLVED');
    await hookdeck.upsertIssueTrigger({ name: 'bridge-delivery', type: 'delivery', configs: { strategy: 'final_attempt', connections: 'mcp-sub-*' } });
    expect(JSON.parse(calls[0]!.body!)).toEqual({ status: 'RESOLVED' });
    expect(calls[1]!.method).toBe('PUT');
    expect(JSON.parse(calls[1]!.body!)).toEqual({ name: 'bridge-delivery', type: 'delivery', configs: { strategy: 'final_attempt', connections: 'mcp-sub-*' }, channels: {} });
  });

  it('treats only SUCCESSFUL, FAILED and CANCELLED as settled', () => {
    expect(['SUCCESSFUL', 'FAILED', 'CANCELLED', 'QUEUED', 'SCHEDULED', 'HOLD'].map((status) => isSettled({ status }))).toEqual([
      true, true, true, false, false, false,
    ]);
  });
});
