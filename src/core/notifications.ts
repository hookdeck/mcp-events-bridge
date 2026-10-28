import type { CallbackFailureReason } from './errors.js';
import type { HookdeckClient } from './hookdeck.js';
import { verifyHookdeckSignature } from './hookdeck-signature.js';
import type { SubscriptionStore } from './store.js';

/*
 * What Event Gateway still sends the bridge: issue notifications, at /inbound/hookdeck. Events don't pass through the
 * bridge (Event Gateway delivers them from the service's source); a notification says a subscription's callback is
 * failing, and the bridge records it for `deliveryStatus`. Every request must have a valid Hookdeck signature.
 */

export interface InboundResponse {
  status: number;
  body: Record<string, unknown>;
}

export interface NotificationsDeps {
  signingSecret: string;
  store: SubscriptionStore;
  hookdeck: HookdeckClient;
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

export class Notifications {
  private readonly now: () => Date;
  private readonly log: (message: string) => void;

  constructor(private readonly deps: NotificationsDeps) {
    this.now = deps.now ?? (() => new Date());
    this.log = deps.log ?? (() => {});
  }

  async handle(path: string, headers: Record<string, string | undefined>, rawBody: string | Buffer): Promise<InboundResponse> {
    try {
      if (!verifyHookdeckSignature(rawBody, headers, this.deps.signingSecret)) return { status: 401, body: { error: 'invalid signature' } };
      // Event Gateway joins the destination path with the request's path, so it can arrive as `/inbound/hookdeck/`.
      if (!/^\/inbound\/hookdeck\/?$/.test(path)) return { status: 404, body: { error: 'not found' } };
      let body: IssueNotification;
      try {
        body = JSON.parse(rawBody.toString()) as IssueNotification;
      } catch {
        // Answered 200, not 4xx: Event Gateway would retry a request that can never succeed.
        return { status: 200, body: { ignored: 'body is not JSON' } };
      }
      return await this.handleNotification(body);
    } catch (error) {
      this.log(`${path}: ${(error as Error).message}`);
      return { status: 500, body: { error: 'internal error' } };
    }
  }

  /**
   * The payload is only a hint: anyone could post to the notifications source, so the issue is re-read from the
   * Event Gateway API before acting on it.
   *
   * Delivery issue on a subscription connection: a 410 is the receiver rejecting that one delivery, which SEP-3415
   * says MUST NOT affect the subscription (Event Gateway's retry rule already skips it), so it changes nothing;
   * anything else is recorded as failing delivery (reported as deliveryStatus). The issue is then resolved, so the
   * next failure notifies again.
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
      this.log(`${subscription.id}: callback rejected a delivery (410), not retried`);
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
    return { status: 200, body: { handled: status === 410 ? 'rejected' : 'recorded' } };
  }
}
