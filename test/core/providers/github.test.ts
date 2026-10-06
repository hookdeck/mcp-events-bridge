import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_GITHUB_EVENTS, githubProvider } from '../../../src/core/providers/github.js';
import type { InboundRequest } from '../../../src/core/providers/types.js';
import { github } from '../../../src/providers.js';
import { FakeGithub } from '../../support/fake-github.js';

const load = (name: string): InboundRequest => {
  const f = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'fixtures', 'github', name), 'utf8')) as InboundRequest;
  return { headers: f.headers, body: f.body };
};
const event = (name: string) => githubProvider.events.find((e) => e.name === name)!;
const matching = (req: InboundRequest) => githubProvider.events.filter((e) => e.matches(req)).map((e) => e.name);

describe('GitHub provider', () => {
  it('offers one MCP event per GitHub event type, and a default set', () => {
    expect(githubProvider.events.length).toBeGreaterThan(20);
    expect(github({ token: 't', scope: { repos: ['o/r'] } }).events).toEqual(DEFAULT_GITHUB_EVENTS);
    expect(github({ token: 't', scope: { repos: ['o/r'] }, events: ['*'] }).events).toHaveLength(githubProvider.events.length);
    expect(() => github({ token: 't', scope: { repos: ['o/r'] }, events: ['github.nope'] })).toThrow(/unknown event/);
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

  it('registers one webhook per repository with one generated secret, and deletes them by source URL', async () => {
    const gh = new FakeGithub();
    const sourceUrl = 'https://hkdk.events/abc';
    const options = { token: 'ghp_test', scope: { repos: ['example-org/widgets', 'example-org/gadgets'] } };
    const result = await githubProvider.register!({ sourceUrl, providerEvents: ['issues', 'push'], options, fetch: gh.fetch });
    expect(result.signingSecret).toMatch(/^[0-9a-f]{64}$/);
    for (const path of ['/repos/example-org/widgets/hooks', '/repos/example-org/gadgets/hooks']) {
      expect(gh.hooks.get(path)).toEqual([
        { id: expect.any(Number), events: ['issues', 'push'], config: { url: sourceUrl, content_type: 'json', secret: result.signingSecret, insecure_ssl: '0' } },
      ]);
    }
    gh.hooks.get('/repos/example-org/widgets/hooks')!.push({ id: 99, events: ['push'], config: { url: 'https://other.example.com', secret: 'x' } });

    await githubProvider.unregister!({ webhookId: result.webhookId, sourceUrl, options, fetch: gh.fetch });
    expect(gh.hooks.get('/repos/example-org/widgets/hooks')!.map((h) => h.id)).toEqual([99]);
    expect(gh.hooks.get('/repos/example-org/gadgets/hooks')).toEqual([]);
  });

  it('updates an existing webhook in place, reusing a given secret', async () => {
    const gh = new FakeGithub();
    const sourceUrl = 'https://hkdk.events/abc';
    const options = { token: 'ghp_test', scope: { org: 'example-org' } };
    const first = await githubProvider.register!({ sourceUrl, providerEvents: ['issues'], options, fetch: gh.fetch });
    const second = await githubProvider.register!({ sourceUrl, providerEvents: ['issues', 'push'], options, fetch: gh.fetch, signingSecret: first.signingSecret });
    expect(second).toEqual(first);
    expect(gh.hooks.get('/orgs/example-org/hooks')).toEqual([expect.objectContaining({ events: ['issues', 'push'], config: expect.objectContaining({ secret: first.signingSecret }) })]);
    expect(gh.calls.filter((c) => c.startsWith('PATCH'))).toHaveLength(1);
  });

  it('sends the API version and token, and rejects badly formed repositories', async () => {
    const seen: Array<Record<string, string>> = [];
    const fetchFn = (async (_url: string, init: RequestInit) => {
      seen.push(init.headers as Record<string, string>);
      return init.method === 'GET' ? Response.json([]) : Response.json({ id: 1 }, { status: 201 });
    }) as unknown as typeof fetch;
    await githubProvider.register!({ sourceUrl: 'https://hkdk.events/abc', providerEvents: ['issues'], options: { token: 'ghp_test', scope: { repos: ['o/r'] } }, fetch: fetchFn });
    expect(seen[0]).toMatchObject({ Authorization: 'Bearer ghp_test', 'X-GitHub-Api-Version': '2022-11-28' });
    for (const repos of [[], ['widgets'], ['o/r/extra']]) {
      await expect(
        githubProvider.register!({ sourceUrl: 'https://hkdk.events/abc', providerEvents: ['issues'], options: { token: 't', scope: { repos } }, fetch: fetchFn }),
      ).rejects.toThrow(/github: /);
    }
  });

  it('manual mode: uses the configured secret, calls no GitHub API, and says how to add webhooks', async () => {
    const gh = new FakeGithub();
    const options = { webhookSecret: 'a-secret-of-16-chars-plus' };
    const sourceUrl = 'https://hkdk.events/abc';
    await expect(githubProvider.register!({ sourceUrl, providerEvents: ['issues'], options, fetch: gh.fetch })).resolves.toEqual({
      webhookId: 'manual',
      signingSecret: 'a-secret-of-16-chars-plus',
    });
    await githubProvider.unregister!({ webhookId: 'manual', sourceUrl, options, fetch: gh.fetch });
    expect(gh.calls).toEqual([]);
    const hint = githubProvider.setupHint!({ sourceUrl, providerEvents: ['issues', 'push'], options })!;
    expect(hint).toContain(`Payload URL: ${sourceUrl}`);
    expect(hint).toContain('application/json');
    expect(hint).not.toContain('a-secret-of-16-chars-plus');
    expect(githubProvider.setupHint!({ sourceUrl, providerEvents: ['issues'], options: { token: 't', scope: { org: 'o' } } })).toBeUndefined();
  });

  it.each([
    ['neither scope nor secret', {}, /set scope and token/],
    ['both scope and secret', { token: 't', scope: { org: 'o' }, webhookSecret: 'a-secret-of-16-chars-plus' }, /not both/],
    ['a short secret', { webhookSecret: 'short' }, /at least 16/],
    ['a scope without a token', { scope: { org: 'o' } }, /token is needed/],
  ])('rejects %s', async (_label, options, error) => {
    await expect(githubProvider.register!({ sourceUrl: 'https://hkdk.events/abc', providerEvents: ['issues'], options, fetch: new FakeGithub().fetch })).rejects.toThrow(error);
  });
});
