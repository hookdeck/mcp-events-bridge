import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_GITHUB_EVENTS, githubProvider } from '../../../src/core/providers/github.js';
import type { InboundRequest } from '../../../src/core/providers/types.js';
import { github } from '../../../src/providers.js';

const load = (name: string): InboundRequest => {
  const f = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'fixtures', 'github', name), 'utf8')) as InboundRequest;
  return { headers: f.headers, body: f.body };
};
const event = (name: string) => githubProvider.events.find((e) => e.name === name)!;
const matching = (req: InboundRequest) => githubProvider.events.filter((e) => e.matches(req)).map((e) => e.name);

describe('GitHub provider', () => {
  it('offers one MCP event per GitHub event type, and a default set', () => {
    expect(githubProvider.events.length).toBeGreaterThan(20);
    expect(github({ token: 't', scope: { repo: 'o/r' } }).events).toEqual(DEFAULT_GITHUB_EVENTS);
    expect(github({ token: 't', scope: { repo: 'o/r' }, events: ['*'] }).events).toHaveLength(githubProvider.events.length);
    expect(() => github({ token: 't', scope: { repo: 'o/r' }, events: ['github.nope'] })).toThrow(/unknown event/);
  });

  it('matches on X-GitHub-Event and ignores ping', () => {
    expect(matching(load('issues-opened.json'))).toEqual(['github.issues']);
    expect(matching(load('push.json'))).toEqual(['github.push']);
    expect(matching(load('ping.json'))).toEqual([]);
  });

  it('uses X-GitHub-Delivery as the event id', () => {
    expect(event('github.issues').eventId(load('issues-opened.json'))).toBe('11111111-1111-1111-1111-111111111111');
  });

  it('summarizes an issue with the generic fields plus issue extras', () => {
    expect(event('github.issues').summarize(load('issues-opened.json'))).toEqual({
      event: 'issues',
      action: 'opened',
      repository: 'example-org/widgets',
      sender: 'octo-dev',
      title: 'Widgets fail to load',
      number: 42,
      url: 'https://github.com/Example-Org/Widgets/issues/42',
      state: 'open',
      labels: ['bug'],
    });
  });

  it('summarizes a comment on a pull request, with the parent title and number', () => {
    expect(event('github.issue_comment').summarize(load('issue-comment-on-pr.json'))).toMatchObject({
      action: 'created',
      title: 'Add retries',
      number: 7,
      comment: 'Looks good to me',
      onPullRequest: true,
    });
  });

  it('summarizes a push and a workflow run', () => {
    expect(event('github.push').summarize(load('push.json'))).toMatchObject({
      action: null,
      ref: 'refs/heads/main',
      commits: 2,
      headCommit: 'Fix widget loading',
      url: 'https://github.com/Example-Org/Widgets/compare/aaa...bbb',
    });
    expect(event('github.workflow_run').summarize(load('workflow-run-completed.json'))).toMatchObject({
      action: 'completed',
      title: 'CI',
      conclusion: 'failure',
      branch: 'main',
    });
  });

  it('takes occurred-at from the main object, or the head commit', () => {
    expect(event('github.issues').occurredAt(load('issues-opened.json'))).toBe('2026-10-06T10:00:00.000Z');
    expect(event('github.issue_comment').occurredAt(load('issue-comment-on-pr.json'))).toBe('2026-10-06T11:05:00.000Z');
    expect(event('github.push').occurredAt(load('push.json'))).toBe('2026-10-06T11:00:00.000Z');
  });

  it('filters by repository, actions and sender, case-insensitively for names', () => {
    const issues = event('github.issues');
    const summary = issues.summarize(load('issues-opened.json'));
    expect(issues.accepts(issues.parseArguments({ repository: 'Example-Org/Widgets' }), summary)).toBe(true);
    expect(issues.accepts(issues.parseArguments({ repository: 'example-org/other' }), summary)).toBe(false);
    expect(issues.accepts(issues.parseArguments({ actions: ['opened', 'reopened'] }), summary)).toBe(true);
    expect(issues.accepts(issues.parseArguments({ actions: ['closed'] }), summary)).toBe(false);
    expect(issues.accepts(issues.parseArguments({ sender: 'OCTO-DEV' }), summary)).toBe(true);
    const push = event('github.push');
    expect(push.accepts(push.parseArguments({ actions: ['opened'] }), push.summarize(load('push.json')))).toBe(false);
    expect(() => issues.parseArguments({ label: 'bug' })).toThrow();
  });

  it('registers a repository webhook with a generated secret, and deletes it', async () => {
    const calls: Array<{ url: string; method: string; body?: Record<string, any>; headers: Record<string, string> }> = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      calls.push({ url, method: init.method!, body: init.body ? JSON.parse(String(init.body)) : undefined, headers: init.headers as Record<string, string> });
      return init.method === 'POST' ? new Response(JSON.stringify({ id: 987 }), { status: 201 }) : new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    const options = { token: 'ghp_test', scope: { repo: 'example-org/widgets' } };
    const result = await githubProvider.register!({ sourceUrl: 'https://hkdk.events/abc', providerEvents: ['issues', 'push'], options, fetch: fetchFn });
    expect(result.webhookId).toBe('987');
    expect(result.signingSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(calls[0]).toMatchObject({
      url: 'https://api.github.com/repos/example-org/widgets/hooks',
      method: 'POST',
      body: { name: 'web', active: true, events: ['issues', 'push'], config: { url: 'https://hkdk.events/abc', content_type: 'json', secret: result.signingSecret } },
      headers: { Authorization: 'Bearer ghp_test', 'X-GitHub-Api-Version': '2022-11-28' },
    });
    await githubProvider.unregister!({ webhookId: '987', options: { token: 'ghp_test', scope: { org: 'example-org' } }, fetch: fetchFn });
    expect(calls[1]).toMatchObject({ url: 'https://api.github.com/orgs/example-org/hooks/987', method: 'DELETE' });
  });
});
