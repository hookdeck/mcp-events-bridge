import { CallbackUrlError, parseCallbackUrl, verifyEndpoint, type CallbackTransport, type VerificationResult, type VerifyEndpointOptions } from './callback.js';
import type { Catalog } from './catalog.js';
import type { SubscriptionSettings } from './config.js';
import { callbackEndpointError, forbidden, internalError, invalidParams, notFound, resourceExhausted, unsupported, type CallbackFailureReason } from './errors.js';
import { deriveSubscriptionId, verificationKey } from './identity.js';
import { isValidWebhookSecret } from './secret.js';
import type { CallbackRegistry } from './callbacks.js';
import { SubscriptionTooLargeError, healthyDelivery, type CursorPosition, type SubscriptionRecord, type SubscriptionStore } from './store.js';

/*
 * MCP Events webhook subscriptions: subscribe (and refresh), unsubscribe,
 * and the expiry sweeper. Ported from mcp-events-outpost-demo, with Event
 * Gateway resources (through the store) in place of Outpost destinations.
 */

export interface DeliveryStatus {
  active: boolean;
  lastError: CallbackFailureReason | null;
  failedSince?: string;
}

export interface SubscribeResult {
  id: string;
  refreshBefore: string;
  cursor: string | null;
  truncated: boolean;
  deliveryStatus?: DeliveryStatus;
}

/** Webhook cursors and replay (SEP-3415), backed by poll mode's listing of Event Gateway's stored requests. */
export interface SubscriptionCursors {
  /** A safe-to-persist watermark for this event and arguments, as of now. */
  watermark(name: string, args: Record<string, unknown>): string;
  /**
   * Checks a client's cursor, throwing invalid params if it isn't one this bridge returned for this event and
   * arguments. Returns where it points, and whether a replay from it is truncated (older than Event Gateway keeps).
   */
  check(name: string, args: Record<string, unknown>, cursor: string): { truncated: boolean; position: CursorPosition };
  /** Delivers the events since `cursor` to a new subscription, in the background, then clears its replay marker. */
  replay(subscription: SubscriptionRecord, cursor: string): void;
}

export interface SubscriptionServiceDeps {
  settings: SubscriptionSettings;
  store: SubscriptionStore;
  catalog: Catalog;
  transport: CallbackTransport;
  verify?: (transport: CallbackTransport, options: VerifyEndpointOptions) => Promise<VerificationResult>;
  /**
   * Callback URLs the bridge created for local agents. One with a secret is challenged like any URL (its source
   * answers). A pass-through one, whose receiver verifies each delivery itself, is verified out-of-band: the bridge
   * created it, which SEP-3415 allows in place of the challenge.
   */
  callbacks?: Pick<CallbackRegistry, 'find'>;
  /** Without it, subscribe answers `cursor: null` and doesn't replay. */
  cursors?: SubscriptionCursors;
  now?: () => Date;
  log?: (message: string) => void;
}

type Params = Record<string, unknown>;

/** Server-granted lifetime. Never null: the bridge doesn't grant no-expiry subscriptions. */
export function grantTtlMs(requested: unknown, settings: Pick<SubscriptionSettings, 'defaultTtlMs' | 'minTtlMs' | 'maxTtlMs'>): number {
  if (typeof requested !== 'number') return settings.defaultTtlMs; // omitted, or null (a no-expiry request we decline)
  return Math.min(Math.max(requested, settings.minTtlMs), settings.maxTtlMs);
}

/** Request params for the log, with the signing secret replaced by its shape. */
export function describeParams(params: Params): string {
  const delivery = params.delivery as Record<string, unknown> | undefined;
  if (!delivery || typeof delivery !== 'object') return JSON.stringify(params);
  const redacted: Record<string, unknown> = { ...delivery };
  if (typeof delivery.url === 'string') redacted.url = redactUrl(delivery.url);
  if ('secret' in delivery) {
    const secret = delivery.secret;
    redacted.secret = `<${isValidWebhookSecret(secret) ? `whsec_ (${Buffer.from(secret.slice(6), 'base64').length} bytes)` : `invalid (${typeof secret})`}>`;
  }
  return JSON.stringify({ ...params, delivery: redacted });
}

/** A callback URL for logs: the query string can include a token, so it's replaced. */
export function redactUrl(url: string): string {
  const query = url.indexOf('?');
  return query === -1 ? url : `${url.slice(0, query)}?<redacted>`;
}

export class SubscriptionService {
  private readonly verifiedUntil = new Map<string, number>();
  private readonly verify: NonNullable<SubscriptionServiceDeps['verify']>;
  private readonly now: () => Date;
  private readonly log: (message: string) => void;

  constructor(private readonly deps: SubscriptionServiceDeps) {
    this.verify = deps.verify ?? verifyEndpoint;
    this.now = deps.now ?? (() => new Date());
    this.log = deps.log ?? (() => {});
  }

  /** With `requireEvent: false` (unsubscribe), an event no longer in the config is accepted, so its subscriptions can still be removed. */
  private parseKey(params: Params, { requireEvent = true } = {}) {
    if (typeof params.name !== 'string') throw invalidParams('name is required');
    const entry = this.deps.catalog.get(params.name);
    if (!entry && requireEvent) throw notFound('event', `Unknown event: ${params.name}`);

    const delivery = params.delivery as Params | undefined;
    if (!delivery || typeof delivery !== 'object') throw invalidParams('delivery is required');
    if (delivery.mode !== undefined && delivery.mode !== 'webhook') throw unsupported('deliveryMode', delivery.mode);

    let url: URL;
    try {
      url = parseCallbackUrl(delivery.url);
    } catch (error) {
      if (error instanceof CallbackUrlError) throw invalidParams(error.message, { field: 'delivery.url', reason: error.reason });
      throw error;
    }

    const rawArgs = params.arguments ?? {};
    if (typeof rawArgs !== 'object' || rawArgs === null || Array.isArray(rawArgs)) throw invalidParams('arguments must be an object');
    return { name: params.name, event: entry?.event, url, rawArgs: rawArgs as Record<string, unknown>, delivery };
  }

  async subscribe(principal: string | undefined, params: Params): Promise<SubscribeResult> {
    this.log(`events/subscribe from ${principal ?? '(none)'}: ${describeParams(params)}`);
    if (!principal) throw forbidden();
    const { settings, store, transport } = this.deps;
    const key = this.parseKey(params);
    const event = key.event!; // required above
    const { url, rawArgs, delivery } = key;

    let args: Record<string, unknown>;
    try {
      args = event.parseArguments(rawArgs);
    } catch (error) {
      throw invalidParams('arguments do not match the inputSchema', { detail: (error as Error).message });
    }
    if (!isValidWebhookSecret(delivery.secret)) {
      throw invalidParams('delivery.secret must be whsec_ followed by base64 of 24 to 64 bytes', { field: 'delivery.secret' });
    }
    const secret = delivery.secret;
    if (params.ttlMs !== undefined && params.ttlMs !== null && (typeof params.ttlMs !== 'number' || params.ttlMs < 0)) {
      throw invalidParams('ttlMs must be a non-negative number or null', { field: 'ttlMs' });
    }
    const clientCursor = params.cursor ?? null;
    if (clientCursor !== null && typeof clientCursor !== 'string') throw invalidParams('cursor must be a string or null', { field: 'cursor' });
    // Checked before anything is created, so a cursor from another event or arguments fails the subscribe.
    const cursorCheck = clientCursor !== null ? this.deps.cursors?.check(key.name, args, clientCursor) : undefined;

    try {
      await transport.assertPublicHost(url);
    } catch (error) {
      if (error instanceof CallbackUrlError) throw invalidParams(error.message, { field: 'delivery.url', reason: error.reason });
      throw callbackEndpointError('connection_refused'); // DNS failure
    }

    const href = url.href;
    // The key uses the caller's exact arguments, so unsubscribe with the same arguments finds it.
    const id = deriveSubscriptionId(principal, href, key.name, rawArgs);
    const now = this.now();

    // Endpoint verification, cached per (principal, url). A bridge callback URL with a secret is always challenged: its
    // source answers cheaply, and one deleted and recreated must not be skipped on the strength of an old result. A
    // pass-through one is verified out-of-band (see `callbacks`).
    const vKey = verificationKey(principal, href);
    const callback = this.deps.callbacks?.find(href);
    if (callback?.passThrough) {
      this.log(`warning: ${callback.name} is a pass-through callback URL: Event Gateway doesn't verify deliveries to it, so its receiver must check each signature`);
    } else if (callback || (this.verifiedUntil.get(vKey) ?? 0) <= now.getTime()) {
      const result = await this.verify(transport, { url, secret, subscriptionId: id, timeoutMs: settings.verificationTimeoutMs });
      if (!result.ok) {
        this.log(`verification failed for ${id}: ${result.reason}`);
        throw callbackEndpointError(result.reason);
      }
      this.verifiedUntil.set(vKey, now.getTime() + settings.verificationCacheTtlMs);
      this.log(`verified callback for ${principal} -> ${redactUrl(href)}`);
    }

    const expiresAt = new Date(now.getTime() + grantTtlMs(params.ttlMs, settings));
    const live = (record: SubscriptionRecord | undefined) => record !== undefined && Date.parse(record.expiresAt) > now.getTime();
    // Read and written in the store's queue, so a concurrent write (a delivery-failure notification) can't be lost or undo this.
    const prior: { record?: SubscriptionRecord } = {};
    try {
      await store.update(id, (existing) => {
        prior.record = existing;
        return {
          id,
          principal,
          name: key.name,
          arguments: args,
          url: href,
          // A new secret replaces the old at once: the destination signs with one key (SEP-3415's dual-signing grace
          // window needs Event Gateway to take a second, expiring key).
          secret,
          // A new subscription made with a cursor replays from it, and every delivery has where the replay started
          // until it's done; a live one keeps whatever replay it has.
          replay: cursorCheck && this.deps.cursors && !live(existing) ? cursorCheck.position : live(existing) ? existing!.replay : null,
          // A refresh is the subscriber's liveness signal: delivery is active again.
          delivery: healthyDelivery(),
          expiresAt: expiresAt.toISOString(),
          createdAt: existing?.createdAt ?? now.toISOString(),
          updatedAt: now.toISOString(),
        };
      });
    } catch (error) {
      if (error instanceof SubscriptionTooLargeError) throw resourceExhausted('argumentsSize', 'arguments are too large to store');
      this.log(`Event Gateway error for ${id}: ${(error as Error).message}`);
      throw internalError('Failed to configure delivery');
    }
    const existing = prior.record;
    if (existing && existing.secret !== secret) this.log(`rotated secret for ${id}`);
    this.log(`${existing ? 'refreshed' : 'subscribed'} ${id} until ${expiresAt.toISOString()}`);

    return {
      id,
      refreshBefore: expiresAt.toISOString(),
      ...this.position(id, key.name, args, clientCursor, cursorCheck, existing, now),
      ...(existing && {
        deliveryStatus: {
          active: true,
          lastError: existing.delivery.lastError,
          ...(existing.delivery.failedSince && { failedSince: existing.delivery.failedSince }),
        },
      }),
    };
  }

  /** Idempotent: unknown subscriptions return an empty result (OpenAI's guidance) rather than NotFound. */
  /**
   * The subscribe response's `cursor` and `truncated` (SEP-3415), and replay. A new subscription (or one that had
   * expired) made with a cursor replays from it, and answers with that cursor until its deliveries have later ones.
   * A live subscription's cursor is a no-op. Otherwise the answer is a fresh watermark, except while a live
   * subscription's deliveries are failing: then the client's own cursor stands, so persisting the answer never skips
   * an event Event Gateway is still retrying.
   */
  private position(
    id: string,
    name: string,
    args: Record<string, unknown>,
    clientCursor: string | null,
    check: { truncated: boolean } | undefined,
    existing: SubscriptionRecord | undefined,
    now: Date,
  ): { cursor: string | null; truncated: boolean } {
    const cursors = this.deps.cursors;
    if (!cursors) return { cursor: null, truncated: clientCursor !== null }; // no replay: a client's cursor can't be resumed
    const isLive = existing !== undefined && Date.parse(existing.expiresAt) > now.getTime();
    if (clientCursor !== null && !isLive) {
      const record = this.deps.store.get(id);
      if (record) {
        this.log(`replaying to ${id} from the client's cursor${check?.truncated ? ', truncated (older than Event Gateway keeps)' : ''}`);
        cursors.replay(record, clientCursor);
      }
      return { cursor: clientCursor, truncated: check?.truncated ?? false };
    }
    if (clientCursor !== null && existing && !existing.delivery.active) return { cursor: clientCursor, truncated: false };
    try {
      return { cursor: cursors.watermark(name, args), truncated: false };
    } catch (error) {
      this.log(`${id}: no cursor: ${(error as Error).message}`);
      return { cursor: null, truncated: false };
    }
  }

  async unsubscribe(principal: string | undefined, params: Params): Promise<Record<string, never>> {
    this.log(`events/unsubscribe from ${principal ?? '(none)'}: ${describeParams(params)}`);
    if (!principal) throw forbidden();
    const { url, rawArgs, name } = this.parseKey(params, { requireEvent: false });
    const id = deriveSubscriptionId(principal, url.href, name, rawArgs);
    try {
      await this.deps.store.delete(id);
    } catch (error) {
      this.log(`Event Gateway error deleting ${id}: ${(error as Error).message}`);
      throw internalError('Failed to remove delivery');
    }
    this.log(`unsubscribed ${id}`);
    return {};
  }

  /** Drops cached verification for a URL and the paths under it, from every principal, e.g. when a bridge callback URL is deleted. */
  forgetVerification(url: string) {
    for (const key of [...this.verifiedUntil.keys()]) {
      const verified = (JSON.parse(key) as [string, string])[1];
      if (verified === url || verified.startsWith(`${url}/`)) this.verifiedUntil.delete(key);
    }
  }

  /** Deletes subscriptions whose grant has lapsed. */
  async sweep(): Promise<string[]> {
    const removed: string[] = [];
    const now = this.now();
    for (const record of this.deps.store.listExpired(now)) {
      try {
        // Re-checked in the store's queue: a refresh that lands during the sweep keeps the subscription.
        if (!(await this.deps.store.delete(record.id, { ifExpiredAt: now }))) continue;
        removed.push(record.id);
        this.log(`expired ${record.id}`);
      } catch (error) {
        this.log(`sweep failed for ${record.id}, will retry: ${(error as Error).message}`);
      }
    }
    return removed;
  }
}
