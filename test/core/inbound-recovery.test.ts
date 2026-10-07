import { describe, expect, it } from 'vitest';
import { InboundRecovery, type RecoveryHookdeck } from '../../src/core/inbound-recovery.js';

interface FakeRequest {
  id: string;
  created_at?: string;
  verified?: boolean;
  ignored_count?: number | null;
  events?: Array<{ id: string; status: string; response_status?: number | null; webhook_id?: string; created_at?: string }>;
  ignored?: Array<{ cause: string; webhook_id?: string }>;
}

const OURS = 'web_dev';
const NOW = new Date('2026-10-07T12:00:00.000Z');

function setup(requests: FakeRequest[], { saved }: { saved?: Record<string, string> } = {}) {
  let now = NOW;
  const calls: string[] = [];
  let stored: Record<string, string> | undefined;
  const models = () =>
    requests.map((r) => ({ source_id: 'src_resend', created_at: '2026-10-07T11:00:00.000Z', verified: true, ignored_count: r.ignored?.length ?? 0, ...r }));
  const hookdeck = {
    listAllConnections: async () => [
      { id: OURS, name: 'bridge-resend-dev', source: { id: 'src_resend', name: 'bridge-resend' }, destination: {} },
      { id: 'web_fly', name: 'bridge-resend-fly', source: { id: 'src_resend', name: 'bridge-resend' }, destination: {} },
    ],
    // As the API does: filtered by connection.
    listEvents: async (query: { webhook_id: string; created_at_gte?: string }) => {
      calls.push(`events for ${query.webhook_id} since ${query.created_at_gte}`);
      return {
        models: requests.flatMap((r) =>
          (r.events ?? []).map((e) => ({ request_id: r.id, webhook_id: OURS, created_at: '2026-10-07T11:00:00.000Z', ...e })).filter((e) => e.webhook_id === query.webhook_id),
        ),
      };
    },
    // As the API does: only requests with ignored events when asked.
    listRequests: async (query: { created_at_gte?: string; withIgnored?: boolean }) => {
      calls.push(`requests${query.withIgnored ? ' with ignored' : ''} since ${query.created_at_gte}`);
      return { models: models().filter((r) => !query.withIgnored || (r.ignored_count ?? 0) > 0) };
    },
    listIgnoredEventsForRequest: async (id: string) => (
      calls.push(`ignored for ${id}`), { models: (requests.find((r) => r.id === id)!.ignored ?? []).map((i) => ({ webhook_id: OURS, ...i })) }
    ),
    retryRequest: async (id: string, connections?: string[]) => (calls.push(`retry request ${id} for ${connections?.join(',')}`), { request: {}, events: [] }),
    retryEvent: async (id: string) => (calls.push(`retry event ${id}`), {}),
  } as unknown as RecoveryHookdeck;
  const retried: string[] = [];
  const recovery = new InboundRecovery({
    hookdeck,
    targets: [{ source: 'bridge-resend', connection: 'bridge-resend-dev' }],
    state: { load: () => saved ?? {}, save: (w) => (stored = { ...w }) },
    onRetried: (id) => retried.push(id),
    now: () => now,
  });
  return { recovery, calls, retried, stored: () => stored, advance: (ms: number) => (now = new Date(now.getTime() + ms)) };
}

describe('InboundRecovery', () => {
  it("retries a request missed while listen was down, for this deployment's connection only", async () => {
    const { recovery, calls } = setup([
      { id: 'req_missed', ignored: [{ cause: 'CLI_DISCONNECTED' }] },
      // Another deployment missed this one; ours got it.
      { id: 'req_theirs', events: [{ id: 'evt_ok', status: 'SUCCESSFUL' }], ignored: [{ cause: 'CLI_DISCONNECTED', webhook_id: 'web_fly' }] },
    ]);
    expect(await recovery.run()).toEqual({ eventsChecked: 1, requestsChecked: 1, retriedRequests: 1, retriedEvents: 0, pending: 0, upToDate: false });
    expect(calls).toContain('retry request req_missed for web_dev');
    expect(calls.filter((c) => c.startsWith('retry'))).toHaveLength(1);
  });

  it("filters on the connection: one listing of its events, and only requests with ignored events looked at one by one", async () => {
    const { recovery, calls } = setup([
      { id: 'req_1', events: [{ id: 'e1', status: 'SUCCESSFUL' }] },
      { id: 'req_2', events: [{ id: 'e2', status: 'SUCCESSFUL' }] },
      { id: 'req_missed', ignored: [{ cause: 'CLI_DISCONNECTED' }] },
    ]);
    await recovery.run();
    expect(calls.filter((c) => !c.startsWith('retry'))).toEqual([
      'events for web_dev since 2026-10-06T12:00:00.000Z',
      'requests with ignored since 2026-10-06T12:00:00.000Z',
      'ignored for req_missed',
    ]);
  });

  it('tells the relay which requests it retried, so their delivery counts as a retry', async () => {
    const { recovery, retried } = setup([
      { id: 'req_missed', ignored: [{ cause: 'CLI_DISCONNECTED' }] },
      { id: 'req_dropped', events: [{ id: 'evt_dropped', status: 'FAILED', response_status: null }] },
    ]);
    await recovery.run();
    expect(retried.sort()).toEqual(['req_dropped', 'req_missed']);
  });

  it('retries an event the CLI never delivered, but not one the bridge answered, one delivered, or one in flight', async () => {
    const { recovery, calls } = setup([
      { id: 'req_dropped', events: [{ id: 'evt_dropped', status: 'FAILED', response_status: null }] },
      { id: 'req_bridge_502', events: [{ id: 'evt_502', status: 'FAILED', response_status: 502 }] },
      { id: 'req_done', events: [{ id: 'evt_done', status: 'SUCCESSFUL' }] },
      { id: 'req_queued', events: [{ id: 'evt_q', status: 'QUEUED' }] },
    ]);
    expect(await recovery.run()).toMatchObject({ retriedEvents: 1, pending: 1, upToDate: false });
    expect(calls.filter((c) => c.startsWith('retry'))).toEqual(['retry event evt_dropped']);
  });

  it('leaves filtered, duplicate and rejected requests alone', async () => {
    const { recovery, calls } = setup([
      { id: 'req_filtered', ignored: [{ cause: 'FILTERED' }] },
      { id: 'req_duplicate', ignored: [{ cause: 'DUPLICATE' }] },
      { id: 'req_bad_signature', verified: false, ignored: [{ cause: 'CLI_DISCONNECTED' }] },
      { id: 'req_other_connection', ignored: [{ cause: 'CLI_DISCONNECTED', webhook_id: 'web_fly' }] },
    ]);
    expect(await recovery.run()).toMatchObject({ requestsChecked: 3, retriedRequests: 0, pending: 0, upToDate: true });
    expect(calls.filter((c) => c.startsWith('retry'))).toEqual([]);
  });

  it("doesn't retry a request again while its retry may not be listed yet, but does after a few minutes", async () => {
    const { recovery, calls, advance } = setup([{ id: 'req_missed', ignored: [{ cause: 'CLI_DISCONNECTED' }] }]);
    await recovery.run();
    expect(await recovery.run()).toMatchObject({ pending: 1, retriedRequests: 0, upToDate: false });
    advance(3 * 60 * 1000);
    await recovery.run(); // still missed (listen dropped again): retried again
    expect(calls.filter((c) => c.startsWith('retry'))).toEqual(['retry request req_missed for web_dev', 'retry request req_missed for web_dev']);
  });

  it('looks back a day the first time, then saves a watermark (with a margin) after a clean run', async () => {
    const { recovery, calls, stored } = setup([{ id: 'req_done', events: [{ id: 'e', status: 'SUCCESSFUL' }] }]);
    expect(await recovery.run()).toMatchObject({ upToDate: true });
    expect(calls[0]).toBe('events for web_dev since 2026-10-06T12:00:00.000Z');
    expect(stored()).toEqual({ 'bridge-resend-dev': '2026-10-07T11:58:00.000Z' });
  });

  it('starts from a saved watermark, so a bridge started again after a weekend checks from where it stopped', async () => {
    const { recovery, calls } = setup([], { saved: { 'bridge-resend-dev': '2026-10-03T18:00:00.000Z' } });
    await recovery.run();
    expect(calls[0]).toBe('events for web_dev since 2026-10-03T18:00:00.000Z');
  });
});
