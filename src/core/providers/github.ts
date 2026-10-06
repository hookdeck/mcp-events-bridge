import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { InboundRequest, ProviderDefinition, ProviderEvent } from './types.js';

/*
 * GitHub. One MCP event per GitHub webhook event type (`github.issues`,
 * `github.pull_request`, ...), with the action as a subscribe filter. Every
 * type gets a generic summary from the fields all GitHub payloads share
 * (action, repository, sender, and the main object's title, number and URL);
 * the most-used types add a few specific fields. Payloads themselves can be
 * hundreds of KB, so they're never passed through.
 *
 * Event Gateway's GITHUB source verifies X-Hub-Signature-256 with the secret
 * the bridge generates when it registers the webhook.
 */

export type GithubOptions = {
  token: string;
  /** Where the webhook is registered: one repository (`owner/name`) or a whole organization. */
  scope: { repo: string } | { org: string };
};

const GITHUB_API = 'https://api.github.com';
const TEXT_LIMIT = 500;

/** GitHub event types offered, with what they cover. */
const EVENT_TYPES: Record<string, string> = {
  issues: 'An issue was opened, edited, closed, reopened, assigned, labeled, or similar.',
  issue_comment: 'A comment on an issue or pull request was created, edited or deleted.',
  pull_request: 'A pull request was opened, closed, merged (closed with merged: true), reopened, synchronized, review-requested, or similar.',
  pull_request_review: 'A pull request review was submitted, edited or dismissed.',
  pull_request_review_comment: 'A comment on a pull request diff was created, edited or deleted.',
  push: 'Commits were pushed to a branch or a tag was pushed.',
  release: 'A release was published, created, edited, or similar.',
  workflow_run: 'A GitHub Actions workflow run was requested, in progress, or completed (with its conclusion).',
  workflow_job: 'A GitHub Actions job was queued, in progress, or completed.',
  check_run: 'A check run was created, completed, rerequested, or similar.',
  check_suite: 'A check suite was completed, requested, or rerequested.',
  create: 'A branch or tag was created.',
  delete: 'A branch or tag was deleted.',
  deployment: 'A deployment was created.',
  deployment_status: 'A deployment status was created.',
  discussion: 'A discussion was created, edited, answered, or similar.',
  discussion_comment: 'A discussion comment was created, edited or deleted.',
  fork: 'The repository was forked.',
  label: 'A label was created, edited or deleted.',
  member: 'A collaborator was added, removed, or had their permissions changed.',
  milestone: 'A milestone was created, closed, opened, edited or deleted.',
  public: 'The repository was made public.',
  repository: 'The repository was created, renamed, archived, transferred, or similar.',
  star: 'The repository was starred or unstarred.',
  status: 'A commit status changed.',
  watch: 'Someone started watching the repository.',
};

export const DEFAULT_GITHUB_EVENTS = ['issues', 'issue_comment', 'pull_request', 'pull_request_review', 'push', 'release', 'workflow_run'].map(
  (type) => `github.${type}`,
);

/** The payload key holding each type's main object, where it isn't the type name itself. */
const OBJECT_KEY: Record<string, string> = {
  issues: 'issue',
  issue_comment: 'comment',
  pull_request_review: 'review',
  pull_request_review_comment: 'comment',
  discussion_comment: 'comment',
  deployment_status: 'deployment_status',
  fork: 'forkee',
};

type Payload = Record<string, any>;

const clip = (value: unknown) => {
  if (typeof value !== 'string') return null;
  return value.length > TEXT_LIMIT ? `${value.slice(0, TEXT_LIMIT)}…` : value;
};
const lower = (value: unknown) => (typeof value === 'string' ? value.toLowerCase() : null);

export interface GithubSummary extends Record<string, unknown> {
  event: string;
  action: string | null;
  repository: string | null;
  sender: string | null;
  title: string | null;
  number: number | null;
  url: string | null;
}

/** Fields every GitHub event has, normalized for matching (repository and sender lower-cased). */
function genericSummary(type: string, body: Payload): GithubSummary {
  const object = body[OBJECT_KEY[type] ?? type] as Payload | undefined;
  const parent = (body.issue ?? body.pull_request ?? body.discussion) as Payload | undefined;
  return {
    event: type,
    action: typeof body.action === 'string' ? body.action : null,
    repository: lower(body.repository?.full_name),
    sender: lower(body.sender?.login),
    title: clip(object?.title ?? object?.name ?? parent?.title ?? null),
    number: typeof object?.number === 'number' ? object.number : typeof parent?.number === 'number' ? parent.number : null,
    url: typeof object?.html_url === 'string' ? object.html_url : typeof body.compare === 'string' ? body.compare : null,
  };
}

/** A few more fields for the most-used types. */
function extras(type: string, body: Payload): Record<string, unknown> {
  switch (type) {
    case 'issues':
      return { state: body.issue?.state ?? null, labels: (body.issue?.labels ?? []).map((l: Payload) => l.name).slice(0, 20) };
    case 'issue_comment':
    case 'pull_request_review_comment':
    case 'discussion_comment':
      return { comment: clip(body.comment?.body), onPullRequest: Boolean(body.issue?.pull_request ?? body.pull_request) };
    case 'pull_request':
      return {
        state: body.pull_request?.state ?? null,
        merged: Boolean(body.pull_request?.merged),
        draft: Boolean(body.pull_request?.draft),
        head: body.pull_request?.head?.ref ?? null,
        base: body.pull_request?.base?.ref ?? null,
      };
    case 'pull_request_review':
      return { state: body.review?.state ?? null, review: clip(body.review?.body) };
    case 'push':
      return {
        ref: body.ref ?? null,
        commits: Array.isArray(body.commits) ? body.commits.length : 0,
        headCommit: clip(body.head_commit?.message),
        forced: Boolean(body.forced),
      };
    case 'release':
      return { tag: body.release?.tag_name ?? null, prerelease: Boolean(body.release?.prerelease) };
    case 'workflow_run':
      return {
        workflow: body.workflow_run?.name ?? null,
        status: body.workflow_run?.status ?? null,
        conclusion: body.workflow_run?.conclusion ?? null,
        branch: body.workflow_run?.head_branch ?? null,
      };
    default:
      return {};
  }
}

/** When it happened: the main object's latest timestamp, else the push's head commit, else now. */
function occurredAt(type: string, body: Payload): string {
  const object = body[OBJECT_KEY[type] ?? type] as Payload | undefined;
  const candidates = [object?.submitted_at, object?.updated_at, object?.published_at, object?.created_at, body.head_commit?.timestamp];
  const found = candidates.find((value) => typeof value === 'string' && !Number.isNaN(Date.parse(value)));
  return new Date(found ?? Date.now()).toISOString();
}

const githubArguments = z
  .object({
    repository: z.string().min(3).describe('Only events for this repository (owner/name).').optional(),
    actions: z.array(z.string().min(1)).min(1).describe('Only these actions, for example ["opened", "reopened"].').optional(),
    sender: z.string().min(1).describe('Only events caused by this GitHub user (login).').optional(),
  })
  .strict();

const githubPayload = z.object({
  event: z.string().describe('GitHub event type, for example issues.'),
  action: z.string().nullable(),
  repository: z.string().nullable().describe('owner/name, lower-cased.'),
  sender: z.string().nullable().describe('GitHub login, lower-cased.'),
  title: z.string().nullable(),
  number: z.number().int().nullable(),
  url: z.string().nullable(),
});

type GithubArguments = z.infer<typeof githubArguments>;

function githubEvent(type: string, description: string): ProviderEvent<GithubArguments, GithubSummary> {
  return {
    name: `github.${type}`,
    description: `GitHub ${type}: ${description} Carries a summary (repository, action, sender, title, number, URL); read the full object with GitHub's own tools. Filter by repository, actions or sender.`,
    providerEvent: type,
    matches: (req: InboundRequest) => req.headers['x-github-event'] === type,
    eventId: (req) => {
      const id = req.headers['x-github-delivery'];
      if (!id) throw new Error('GitHub delivery has no X-GitHub-Delivery header');
      return id;
    },
    occurredAt: (req) => occurredAt(type, req.body as Payload),
    summarize: (req) => ({ ...genericSummary(type, req.body as Payload), ...extras(type, req.body as Payload) }),
    inputSchema: z.toJSONSchema(githubArguments) as Record<string, unknown>,
    parseArguments: (args) => {
      const parsed = githubArguments.parse(args ?? {});
      return {
        ...(parsed.repository !== undefined && { repository: parsed.repository.toLowerCase() }),
        ...(parsed.actions !== undefined && { actions: parsed.actions }),
        ...(parsed.sender !== undefined && { sender: parsed.sender.toLowerCase() }),
      };
    },
    accepts: (args, summary) =>
      (args.repository === undefined || summary.repository === args.repository) &&
      (args.sender === undefined || summary.sender === args.sender) &&
      (args.actions === undefined || (summary.action !== null && args.actions.includes(summary.action))),
    payloadSchema: z.toJSONSchema(githubPayload) as Record<string, unknown>,
  };
}

const hooksPath = (scope: GithubOptions['scope']) =>
  'repo' in scope ? `/repos/${scope.repo.split('/').map(encodeURIComponent).join('/')}/hooks` : `/orgs/${encodeURIComponent(scope.org)}/hooks`;

async function githubApi(fetchFn: typeof fetch, token: string, path: string, init: { method: string; body?: unknown }) {
  const res = await fetchFn(`${GITHUB_API}${path}`, {
    method: init.method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'mcp-events-bridge',
      ...(init.body !== undefined && { 'Content-Type': 'application/json' }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`GitHub ${init.method} ${path} -> ${res.status} ${text.slice(0, 300)}`);
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

export const githubProvider: ProviderDefinition<GithubOptions> = {
  type: 'github',
  displayName: 'GitHub',
  sourceType: 'GITHUB',
  inboundDedupeFields: ['headers.x-github-delivery'],
  eventIdHeader: 'x-github-delivery',
  events: Object.entries(EVENT_TYPES).map(([type, description]) => githubEvent(type, description)),
  defaultEvents: DEFAULT_GITHUB_EVENTS,

  /** GitHub lets the caller choose the secret, so the bridge generates one. */
  async register({ sourceUrl, providerEvents, options, fetch: fetchFn }) {
    const signingSecret = randomBytes(32).toString('hex');
    const hook = await githubApi(fetchFn, options.token, hooksPath(options.scope), {
      method: 'POST',
      body: { name: 'web', active: true, events: providerEvents, config: { url: sourceUrl, content_type: 'json', secret: signingSecret, insecure_ssl: '0' } },
    });
    if (hook.id === undefined) throw new Error('GitHub did not return a webhook id');
    return { webhookId: String(hook.id), signingSecret };
  },

  async unregister({ webhookId, options, fetch: fetchFn }) {
    await githubApi(fetchFn, options.token, `${hooksPath(options.scope)}/${encodeURIComponent(webhookId)}`, { method: 'DELETE' });
  },
};
