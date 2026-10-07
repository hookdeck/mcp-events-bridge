import type { Catalog } from './catalog.js';
import type { CallbackFailureReason } from './errors.js';
import type { HookdeckClient } from './hookdeck.js';
import { verifyHookdeckSignature } from './hookdeck-signature.js';
import { topicSourceName } from './names.js';
import type { InboundRequest } from './providers/types.js';
import type { CallbackRegistry } from './callbacks.js';
import { signStandardWebhook } from './sign.js';
import type { SubscriptionRecord, SubscriptionStore } from './store.js';

/*
 * The inbound side: everything Event Gateway delivers to the bridge.
 *
 *   /inbound/<instance id>   a provider event: map it, match subscriptions,
 *                            sign per subscriber, publish to the topic source.
 *                            200 only once every publish succeeded; otherwise
 *                            5xx, and Event Gateway retries the inbound event.
 *   /inbound/hookdeck        an issue notification (see handleNotification).
 *
 * Every request must carry a valid Hookdeck signature.
 */

const MAX_BODY_BYTES = 256 * 1024;

export interface InboundResponse {
  status: number;
  body: Record<string, unknown>;
}

export interface RelayDeps {
  signingSecret: string;
  providerIds: string[];
  catalog: Catalog;
  store: SubscriptionStore;
  hookdeck: HookdeckClient;
  /** Deliveries to a bridge-created callback URL are also signed with the callback's own secret. */
  callbacks?: Pick<CallbackRegistry, 'signingSecret'>;
  /**
   * Whether the bridge itself retried this inbound request (recovering it after its `listen` was down). Event Gateway
   * delivers such a retry as attempt 1 of a new event, with trigger INITIAL, so only the request id tells it apart.
   */
  recovered?: (requestId: string) => boolean;
  now?: () => Date;
  log?: (message: string) => void;
}

/** Maps a failing delivery's response to a category MCP Events allows in deliveryStatus.lastError. */
export function failureReason(status: number | null | undefined, errorCode?: string | null): CallbackFailureReason {
  if (status && status >= 500) return 'http_5xx';
  if (status && status >= 300) return 'http_4xx';
  const code = String(errorCode ?? '');
  if (/TIMEOUT/i.test(code)) return 'timeout';
  if (/TLS|SSL|CERT/i.test(code)) return 'tls_error';
  return 'connection_refused';
}

interface IssueNotification {
  topic?: string;
  issue?: { id?: string; type?: string };
}

export class Relay {
  private readonly now: () => Date;
  private readonly log: (message: string) => void;

  constructor(private readonly deps: RelayDeps) {
    this.now = deps.now ?? (() => new Date());
    this.log = deps.log ?? (() => {});
  }

  async handle(path: string, headers: Record<string, string | undefined>, rawBody: string | Buffer): Promise<InboundResponse> {
    try {
      return await this.route(path, headers, rawBody);
    } catch (error) {
      this.log(`${path}: ${(error as Error).message}`);
      return { status: 500, body: { error: 'internal error' } };
    }
  }

  private async route(path: string, headers: Record<string, string | undefined>, rawBody: string | Buffer): Promise<InboundResponse> {
    if (!verifyHookdeckSignature(rawBody, headers, this.deps.signingSecret)) return { status: 401, body: { error: 'invalid signature' } };
    // Event Gateway joins the destination path with the request's path, so `/inbound/hookdeck` can arrive as `/inbound/hookdeck/`.
    const match = /^\/inbound\/([A-Za-z0-9_-]+)\/?$/.exec(path);
    if (!match) return { status: 404, body: { error: 'not found' } };

    let body: unknown;
    try {
      body = JSON.parse(rawBody.toString());
    } catch {
      // Answered 200, not 4xx: Event Gateway would retry a request that can never succeed. It stays in Event Gateway.
      this.log(`${path}: body is not JSON, ignored`);
      return { status: 200, body: { ignored: 'body is not JSON' } };
    }
    if (match[1] === 'hookdeck') return this.handleNotification(body as IssueNotification);
    if (!this.deps.providerIds.includes(match[1]!)) return { status: 404, body: { error: 'unknown provider instance' } };
    return this.relay(match[1]!, { headers: lowerCase(headers), body });
  }

  private async relay(providerId: string, req: InboundRequest): Promise<InboundResponse> {
    const entry = this.deps.catalog.forProvider(providerId).find((e) => e.event.matches(req));
    if (!entry) return { status: 200, body: { ignored: 'event type not enabled' } };
    const { event, name } = entry;

    const eventId = event.eventId(req);
    const occurredAt = event.occurredAt(req);
    const summary = event.summarize(req);
    const now = this.now();
    // A retry is any delivery but the first: Event Gateway's own retries (attempt count above 1, trigger AUTOMATIC),
    // manual ones (MANUAL), and the bridge's recovery of requests it missed while its `listen` was down (a new event,
    // attempt 1 and INITIAL, so recognized by request id).
    const trigger = req.headers['x-hookdeck-attempt-trigger'];
    const requestId = req.headers['x-hookdeck-requestid'];
    const retry =
      Number(req.headers['x-hookdeck-attempt-count'] ?? '1') > 1 ||
      (trigger !== undefined && trigger !== 'INITIAL') ||
      (requestId !== undefined && (this.deps.recovered?.(requestId) ?? false));
    const subscribers = this.deps.store
      .list({ name })
      .filter((s) => Date.parse(s.expiresAt) > now.getTime())
      // On an inbound retry, a subscription made after the event happened doesn't get it: the retry would otherwise
      // hand it an old event (for example a day-old one recovered after the laptop slept). Not applied on a first
      // attempt, since provider timestamps can predate the action (editing an old GitHub release keeps its
      // published_at), which would drop the event for good.
      .filter((s) => !retry || Date.parse(s.createdAt) <= Date.parse(occurredAt))
      .filter((s) => event.accepts(s.arguments, summary));

    const body = JSON.stringify({ eventId, name, timestamp: occurredAt, data: summary, cursor: null });
    if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
      this.log(`${eventId}: envelope over 256 KiB, not delivered`);
      return { status: 200, body: { ignored: 'too large' } };
    }

    const results = await Promise.allSettled(subscribers.map((s) => this.publish(s, eventId, body, now)));
    const failed = results.filter((r) => r.status === 'rejected');
    for (const r of failed) this.log(`${eventId}: publish failed: ${(r as PromiseRejectedResult).reason}`);
    this.log(`${name} ${eventId}: ${subscribers.length - failed.length}/${subscribers.length} published`);
    if (failed.length) return { status: 502, body: { error: 'publish failed', failed: failed.length } };
    return { status: 200, body: { published: subscribers.length } };
  }

  private async publish(subscription: SubscriptionRecord, eventId: string, body: string, now: Date) {
    const secrets = [subscription.secret];
    if (subscription.previousSecret && subscription.previousSecretExpiresAt && Date.parse(subscription.previousSecretExpiresAt) > now.getTime()) {
      secrets.push(subscription.previousSecret);
    }
    // A callback the bridge created for a local agent: its MCP Events source verifies this signature, the agent its own.
    const callbackSecret = await this.deps.callbacks?.signingSecret(subscription.url);
    if (callbackSecret) secrets.push(callbackSecret);
    const headers = {
      'content-type': 'application/json',
      // Signed at the real time of publishing; `now` (injectable) only drives expiry and grace windows.
      ...signStandardWebhook(secrets, eventId, body),
      'X-MCP-Subscription-Id': subscription.id,
    };
    return this.deps.hookdeck.publish(topicSourceName(subscription.name), headers, body);
  }

  /**
   * Issue notifications. The payload is only a hint: anyone could post to the
   * notifications source, so the issue is re-read from the Event Gateway API
   * before acting on it.
   *
   * Delivery issue on a subscription connection: a 410 means the subscriber
   * has gone, so the subscription is deleted; anything else is recorded as
   * failing delivery (reported as deliveryStatus). The issue is then resolved,
   * so the next failure notifies again.
   */
  private async handleNotification(notification: IssueNotification): Promise<InboundResponse> {
    const issueId = notification.issue?.id;
    if (notification.topic !== 'issue.opened' || !issueId) return { status: 200, body: { ignored: 'not an opened issue' } };

    const issue = await this.deps.hookdeck.getIssue(issueId);
    if (issue.status !== 'OPENED') return { status: 200, body: { ignored: `issue is ${issue.status}` } };
    if (issue.type !== 'delivery') {
      this.log(`Event Gateway ${issue.type} issue ${issue.id}: ${JSON.stringify(issue.aggregation_keys ?? {})}`);
      return { status: 200, body: { logged: issue.type } };
    }

    const connectionId = issue.aggregation_keys?.webhook_id?.[0] as string | undefined;
    const subscription = connectionId ? this.deps.store.findByConnection(connectionId) : undefined;
    if (!subscription) return { status: 200, body: { ignored: 'not a subscription connection' } };

    const status = issue.aggregation_keys?.response_status?.[0] as number | undefined;
    const errorCode = issue.aggregation_keys?.error_code?.[0] as string | undefined;
    if (status === 410) {
      await this.deps.store.delete(subscription.id);
      this.log(`${subscription.id}: callback returned 410, subscription deleted`);
    } else {
      const now = this.now().toISOString();
      // Read and written in the store's queue, so a refresh in flight (a rotated secret, a new expiry) isn't undone.
      await this.deps.store.update(subscription.id, (current) =>
        current
          ? {
              ...current,
              delivery: { active: false, lastError: failureReason(status, errorCode), failedSince: current.delivery.failedSince ?? now },
              updatedAt: now,
            }
          : null,
      );
      this.log(`${subscription.id}: delivery failing (${status ?? errorCode ?? 'unknown'})`);
    }
    await this.deps.hookdeck.updateIssueStatus(issue.id, 'RESOLVED');
    return { status: 200, body: { handled: status === 410 ? 'deleted' : 'recorded' } };
  }
}

function lowerCase(headers: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) if (value !== undefined) out[key.toLowerCase()] = value;
  return out;
}
